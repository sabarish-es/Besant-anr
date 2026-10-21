import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createWorker } from '../server/index';
import type { AuthUser, Env } from '../server/types';
import { safeGoogleReviewUrl } from '../lib/google-review';

// Provider responses are mocked; database, API routing, cookies, origin checks,
// membership authorization, QR scans, and password gates execute real code.
// This database is in memory and never touches local or production records.
const sqlite = new DatabaseSync(':memory:');
for (const name of readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync('drizzle/' + name, 'utf8').replaceAll('--> statement-breakpoint', ''));
class Statement {
  constructor(public sql: string, public args: any[] = []) {}
  bind(...args: any[]) { return new Statement(this.sql, args); }
  async first() { return sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async run() { const result = sqlite.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(result.changes) } }; }
}
let batchQueue: Promise<unknown> = Promise.resolve();
const db = { prepare: (sql: string) => new Statement(sql), batch(statements: Statement[]) {
  // SQLite in-memory mock runs on one connection. Serialize batch transactions
  // just like D1 does at the database server under simultaneous QR scans.
  const next=batchQueue.then(() => { sqlite.exec('BEGIN'); try {
    const results=statements.map(stmt => {const r=sqlite.prepare(stmt.sql).run(...stmt.args);return {success:true,meta:{changes:Number(r.changes)}};});
    sqlite.exec('COMMIT');return results;
  } catch (error) {sqlite.exec('ROLLBACK');throw error;} });
  batchQueue=next.catch(()=>undefined);return next;
} } as unknown as D1Database;
const origin = 'https://besant-test.workers.dev';
const env: Env = { DB: db, SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only', SUPABASE_SECRET_KEY: 'sb_secret_test_only', ADMIN_EMAIL: 'owner@example.test' };
type ProviderUser = AuthUser & { password: string };
const users = new Map<string, ProviderUser>();
const access = new Map<string, string>(), refresh = new Map<string, string>();
const providerCalls: { path: string; method: string; admin: boolean }[] = [];
let counter = 0, unavailable = false;
function addUser(id: string, email: string, confirmed = true) {
  const user = { id, email, password: 'Initial-password-123', email_confirmed_at: confirmed ? new Date().toISOString() : undefined, user_metadata: { full_name: email.split('@')[0] } };
  users.set(id, user); return user;
}
const owner = addUser('auth-owner', env.ADMIN_EMAIL), trainer = addUser('auth-trainer', 'trainer@example.test'), student = addUser('auth-student', 'student@example.test'), otherStudent = addUser('auth-student2', 'student2@example.test'), outsider = addUser('auth-outsider', 'outsider@example.test'), unconfirmed = addUser('auth-unconfirmed', 'unconfirmed@example.test', false);
function safeUser(user: ProviderUser) { const { password, ...result } = user; return result; }
function tokens(user: ProviderUser) { const token = 'access_' + user.id + '_' + ++counter, renewal = 'refresh_' + user.id + '_' + counter; access.set(token, user.id); refresh.set(renewal, user.id); return { user: safeUser(user), access_token: token, refresh_token: renewal, expires_in: 1800 }; }
const send: typeof fetch = async (input, init) => {
  const url = new URL(String(input)), headers = new Headers(init?.headers), method = init?.method || 'GET';
  assert.equal(url.origin, env.SUPABASE_URL);
  const admin = url.pathname.includes('/admin/');
  assert.equal(headers.get('apikey'), admin ? env.SUPABASE_SECRET_KEY : env.SUPABASE_PUBLISHABLE_KEY);
  if (admin) assert.equal(headers.get('authorization'), null, 'New secret keys belong in apikey, not Bearer');
  providerCalls.push({ path: url.pathname, method, admin });
  if (unavailable) return Response.json({ error: 'unavailable' }, { status: 503 });
  const value = init?.body ? JSON.parse(String(init.body)) : {};
  const token = headers.get('authorization')?.replace('Bearer ', ''), authenticated = token ? users.get(access.get(token) || '') : null;
  if (url.pathname.endsWith('/token')) {
    let user: ProviderUser | undefined;
    if (url.searchParams.get('grant_type') === 'refresh_token') user = users.get(refresh.get(value.refresh_token) || '');
    else user = [...users.values()].find(user => user.email === value.email && user.password === value.password);
    return user ? Response.json(tokens(user)) : Response.json({ error: 'invalid_credentials' }, { status: 400 });
  }
  if (url.pathname.endsWith('/user')) {
    if (!authenticated) return Response.json({ error: 'invalid_token' }, { status: 401 });
    if (method === 'PUT') {
      assert.equal(value.current_password, authenticated.password);
      authenticated.password = value.password;
    }
    return Response.json(safeUser(authenticated));
  }
  if (url.pathname.endsWith('/logout')) {
    if (authenticated) for (const [key, id] of refresh) if (id === authenticated.id) refresh.delete(key);
    return new Response(null, { status: 204 });
  }
  if (admin && method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
    if (!users.has(id)) return Response.json({}, { status: 404 });
    users.delete(id);
    for (const [key, uid] of access) if (uid === id) access.delete(key);
    for (const [key, uid] of refresh) if (uid === id) refresh.delete(key);
    return new Response(null, { status: 204 });
  }
  if (admin) {
    let user: ProviderUser;
    if (method === 'POST') {
      if ([...users.values()].some(user => user.email === value.email)) return Response.json({ code: 'email_exists' }, { status: 422 });
      user = addUser('created-' + ++counter, value.email); user.password = value.password;
    } else {
      user = users.get(decodeURIComponent(url.pathname.split('/').at(-1)!))!;
      if (!user) return Response.json({}, { status: 404 });
      user.password = value.password;
    }
    user.user_metadata = value.user_metadata;
    return Response.json(safeUser(user));
  }
  throw new Error('Unexpected provider path ' + url.pathname);
};
const worker = createWorker(send);
const request = (path: string, options: RequestInit = {}, settings = env) => worker.fetch(new Request(origin + path, options), settings);
const post = (path: string, value: unknown, cookie = '', extra: HeadersInit = {}) => request(path, { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie, ...extra }, body: JSON.stringify(value) });
const cookieHeader = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function login(user: ProviderUser) { const response = await post('/api/auth/login', { email: user.email, password: user.password }); assert.equal(response.status, 200, await response.clone().text()); return cookieHeader(response); }
let passed = 0;
async function check(name: string, action: () => any) { await action(); passed++; console.log('PASS ' + name); }

await check('Production migrations start with zero institute and member records', () => {
  for (const table of ['settings', 'members', 'records', 'attendance', 'audits']) assert.equal(sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
});
await check('Anonymous API reads require sign-in', async () => assert.equal((await request('/api/hub')).status, 401));
await check('Unknown API paths do not fall through to the React application', async () => assert.equal((await request('/api/unknown')).status, 404));
await check('Unsupported API methods return the allowed methods', async () => {
  const response = await request('/api/hub', { method: 'DELETE' });
  assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, POST');
});
await check('Forged development headers cannot authenticate', async () => assert.equal((await request('/api/hub', { headers: { 'oai-authenticated-user-id': owner.id, 'oai-authenticated-user-email': owner.email, 'x-hub-local-auth': '1', cookie: 'besant_local_profile=admin' } })).status, 401));
await check('Production rejects cross-origin sign-in before contacting Auth', async () => { const count = providerCalls.length; assert.equal((await post('/api/auth/login', {}, '', { origin: 'https://foreign.example' })).status, 403); assert.equal(providerCalls.length, count); });
await check('Production rejects writes without an Origin', async () => assert.equal((await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403));
await check('Cross-site Fetch Metadata is rejected', async () => assert.equal((await post('/api/auth/login', {}, '', { 'sec-fetch-site': 'cross-site' })).status, 403));
await check('Missing configuration fails closed', async () => { const response = await request('/api/session', {}, { ...env, SUPABASE_PUBLISHABLE_KEY: '' }); assert.equal((await response.json() as any).authConfigured, false); });
await check('Example placeholders do not enable sign-in', async () => { const response = await request('/api/session', {}, { ...env, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_REPLACE' }); assert.equal((await response.json() as any).authConfigured, false); });
await check('Wrong passwords do not create session cookies', async () => { const response = await post('/api/auth/login', { email: owner.email, password: 'incorrect' }); assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null); });
await check('Unconfirmed provider accounts cannot sign in', async () => assert.equal((await post('/api/auth/login', { email: unconfirmed.email, password: unconfirmed.password })).status, 503));
await check('An outsider cannot claim the first administrator', async () => { const response = await post('/api/auth/login', { email: outsider.email, password: outsider.password }); assert.equal(response.status, 403); assert.equal(sqlite.prepare('SELECT count(*) n FROM members').get()!.n, 0); });
await check('Only the Admin tab can initialize an empty institute', async () => {
  const response = await post('/api/auth/login', { email: owner.email, password: owner.password, role: 'trainer' });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('set-cookie'), null);
});
await check('Invalid login roles are rejected', async () => {
  const response = await post('/api/auth/login', { email: owner.email, password: owner.password, role: 'superadmin' });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('set-cookie'), null);
});
const ownerCookies = await login(owner);
await check('Live cookies use Secure, HttpOnly, SameSite and __Host prefixes', async () => {
  const response = await post('/api/auth/login', { email: owner.email, password: owner.password });
  for (const value of response.headers.getSetCookie()) { assert.ok(value.startsWith('__Host-besant_')); assert.ok(value.includes('; Secure')); assert.ok(value.includes('; HttpOnly')); assert.ok(value.includes('; SameSite=Lax')); assert.ok(!value.includes('Domain=')); }
  assert.ok(!(await response.text()).includes('access_'));
});

await check('Only the configured administrator can initialize the institute', async () => {
  const response = await post('/api/hub', { op: 'setup', name: 'API Institute' }, ownerCookies);
  assert.equal(response.status, 200); assert.equal((await response.json() as any).data.me.role, 'admin');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM members WHERE role='admin'").get()!.n, 1);
});
const create = async (kind: string, data: any) => {
  const response = await post('/api/hub', { op: 'create', kind, data }, ownerCookies);
  const value = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(value)); return value.id as string;
};
const review1 = 'https://g.page/r/BESANT_BRANCH_ONE/review', review2 = 'https://search.google.com/local/writereview?placeid=BESANT_BRANCH_TWO';
const branch1 = await create('branches', { name: 'Branch One', address: 'Institute One', latitude: 13.0827, longitude: 80.2707, radius: 150, googleReviewUrl: review1 });
const branch2 = await create('branches', { name: 'Branch Two', address: 'Institute Two', latitude: 13.0827, longitude: 80.2707, radius: 150, googleReviewUrl: review2 });
const course = await create('courses', { name: 'Python', duration: 16, status: 'Active' });
const publicSubcourse = await create('subcourses', { courseId: course, name: 'SQL', duration: 3, status: 'Active' });
const teacherId = await create('trainers', { name: 'Trainer', email: trainer.email, trainerId: 'TR-API1', specialty: 'Python', status: 'Active' });
const batch1 = await create('batches', { name: 'Batch One', courseId: course, subcourseId: publicSubcourse, trainerId: teacherId, branchId: branch1, startDate: new Date().toISOString().slice(0, 10), status: 'Active' });
const batch2 = await create('batches', { name: 'Batch Two', courseId: course, subcourseId: publicSubcourse, trainerId: teacherId, branchId: branch2, startDate: new Date().toISOString().slice(0, 10), status: 'Active' });
const pupilId = await create('students', { name: 'Student', email: student.email, studentId: 'API-ONE', courseId: course, batchId: batch1, status: 'Active' });
await create('students', { name: 'Second Student', email: otherStudent.email, studentId: 'API-TWO', courseId: course, batchId: batch2, status: 'Active' });
const trainerCookies = await login(trainer), studentCookies = await login(student), otherCookies = await login(otherStudent);

const protectedCourse = await create('courses', { name: 'Restricted Cloud Course', duration: 10, status: 'Active' });
const privateSubcourse = await create('subcourses', { courseId: protectedCourse, name: 'Private Cloud Module', duration: 2, status: 'Active' });
const privateTrainer = addUser('auth-private-trainer', 'private-trainer@example.test');
const privateTeacherId = await create('trainers', { name: 'Private Trainer', email: privateTrainer.email, trainerId: 'TR-PRIVATE', specialty: 'Cloud', status: 'Active' });
const protectedBatch = await create('batches', { name: 'Cloud Private', courseId: protectedCourse, subcourseId: privateSubcourse, trainerId: privateTeacherId, branchId: branch2, startDate: new Date().toISOString().slice(0,10), status: 'Active' });
const privateTrainerCookies = await login(privateTrainer);
await check('Admin, Trainer and Student login tabs accept only their real D1 role', async () => {
  for (const [user, role] of [[owner, 'admin'], [trainer, 'trainer'], [student, 'student']] as const) {
    const allowed = await post('/api/auth/login', { email: user.email, password: user.password, role });
    assert.equal(allowed.status, 200, await allowed.clone().text());
    assert.ok(allowed.headers.getSetCookie().length > 0);
    for (const other of ['admin', 'trainer', 'student'].filter(value => value !== role)) {
      const denied = await post('/api/auth/login', { email: user.email, password: user.password, role: other });
      assert.equal(denied.status, 403, await denied.clone().text());
      assert.equal(denied.headers.get('set-cookie'), null);
    }
  }
});

const bootstrap = async (cookie: string) => { const response = await request('/api/hub', { headers: { cookie } }); assert.equal(response.status, 200); return (await response.json() as any).data; };

await check('GET hub rejects hidden course and subcourse records for trainer/student', async () => {
  for (const cookie of [trainerCookies, studentCookies]) {
    const value = await bootstrap(cookie);
    assert.ok(value.records.some((r:any) => r.id === publicSubcourse));
    assert.ok(!value.records.some((r:any) => r.id === protectedCourse || r.id === privateSubcourse || r.id === protectedBatch));
  }
  const trainerView = await bootstrap(privateTrainerCookies);
  assert.ok(trainerView.records.some((r:any) => r.id === protectedCourse && r.kind === 'courses'));
  assert.ok(!trainerView.records.some((r:any) => r.id === course || r.id === publicSubcourse));
});
await check('POST ID tampering does not allow non-admin course operations', async () => {
  for (const cookie of [trainerCookies, studentCookies]) {
    for (const op of [
      {op:'create', kind:'subcourses', data:{courseId:protectedCourse,name:'Injected',duration:1}},
      {op:'update', kind:'subcourses', id:privateSubcourse, data:{courseId:protectedCourse,name:'Hacked',duration:1}},
      {op:'delete', kind:'subcourses', id:privateSubcourse}
    ]) assert.equal((await post('/api/hub', op, cookie)).status, 403);
  }
});
await check('Referenced courses cannot be deleted through the API', async () => {
  assert.equal((await post('/api/hub', {op:'delete', kind:'courses', id: protectedCourse}, ownerCookies)).status, 400);
});

await check('Student dashboard receives its own branch Google review', async () => { const value = await bootstrap(studentCookies); assert.equal(value.googleReview.branchId, branch1); assert.equal(value.googleReview.url, review1); });
await check('Students from different branches receive different review links', async () => { const value = await bootstrap(otherCookies); assert.equal(value.googleReview.branchId, branch2); assert.equal(value.googleReview.url, review2); });
await check('Trainer dashboard has no student review card data', async () => assert.equal((await bootstrap(trainerCookies)).googleReview, null));
await check('Review URL validation blocks unsafe schemes, hosts and redirects', () => {
  for (const url of ['javascript:alert(1)', 'http://g.page/review', 'https://google.com@evil.example/maps']) assert.equal(safeGoogleReviewUrl(url), '');
  assert.equal(safeGoogleReviewUrl(review1), review1); assert.equal(safeGoogleReviewUrl(review2), review2);
});
await check('Branch accepts public HTTPS review URL but rejects unsafe URL', async () => {
  assert.equal((await post('/api/hub', { op: 'update', kind: 'branches', id: branch1, data: { name: 'Branch One', address: 'Institute One', googleReviewUrl: 'https://reviews.example.org/company' } }, ownerCookies)).status, 200);
  assert.equal((await post('/api/hub', { op: 'update', kind: 'branches', id: branch1, data: { name: 'Branch One', address: 'Institute One', googleReviewUrl: 'http://localhost/review' } }, ownerCookies)).status, 400);
});
await check('A student cannot create or reset other logins', async () => assert.equal((await post('/api/accounts', { memberId: teacherId, password: 'Temporary-password-456' }, studentCookies)).status, 403));
await check('Provider metadata cannot grant a student administrator rights', async () => {
  student.user_metadata = { full_name: 'Student', role: 'admin' } as any;
  assert.equal((await post('/api/hub', { op: 'create', kind: 'courses', data: { name: 'Unauthorized', duration: 16, status: 'Active' } }, studentCookies)).status, 403);
});
await check('API reads exclude Auth secrets and password values', async () => {
  const response = await request('/api/hub', { headers: { cookie: ownerCookies } }), text = await response.text();
  assert.ok(!text.includes(env.SUPABASE_SECRET_KEY!)); assert.ok(!text.includes(owner.password)); assert.ok(!text.includes('refresh_token')); assert.ok(!text.includes('access_token'));
});

const schedule = async (name: string) => create('schedules', { name, batchId: batch1, startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString(), mode: 'In person' });
const class1 = await schedule('First API Class'), class2 = await schedule('Second API Class');
for (const id of [class1, class2]) assert.equal((await post('/api/hub', { op: 'openSession', id }, trainerCookies)).status, 200);
const payload = (await bootstrap(studentCookies)).studentQr.payload;
const scan = (id = class1) => post('/api/hub', { op: 'scanStudentQr', scheduleId: id, payload }, trainerCookies);
await check('Staff attendance API returns only the requested date and enforces roles', async () => {
  const nowDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const admin = await request(`/api/attendance?date=${nowDate}`, {headers:{cookie:ownerCookies}});
  assert.equal(admin.status,200,await admin.clone().text());
  const day = await admin.json() as any;
  assert.ok(day.sessions.some((r:any)=>r.id===class1));
  assert.ok(day.sessions.every((r:any)=>new Intl.DateTimeFormat('en-CA',{timeZone:day.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.data.startAt))===nowDate));
  const otherDay=await request('/api/attendance?date=2020-01-01',{headers:{cookie:trainerCookies}});
  assert.equal(otherDay.status,200);
  assert.equal(((await otherDay.json()) as any).sessions.length,0);
  assert.equal((await request(`/api/attendance?date=${nowDate}`,{headers:{cookie:studentCookies}})).status,403);
  assert.equal((await request('/api/attendance?date=invalid',{headers:{cookie:ownerCookies}})).status,400);
});
await check('Student QR validity is five minutes or less', async () => {
  const qr=(await bootstrap(studentCookies)).studentQr;
  assert.ok(Date.parse(qr.expiresAt)>Date.now());
  assert.ok(Date.parse(qr.expiresAt)-Date.now()<=300_000);
});
await check('Production scanning needs no GPS', async () => assert.equal((await post('/api/hub', {op:'verifyTrainerLocation',scheduleId:class1}, trainerCookies)).status, 400));
await check('Eight simultaneous production API scans save one attendance', async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, () => scan()));
  const values = await Promise.all(responses.map(async response => { assert.equal(response.status, 200,await response.clone().text()); return response.json() as Promise<any>; }));
  assert.equal(values.filter(value => !value.alreadyRecorded).length, 1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM attendance WHERE schedule_id=?').get(class1)!.n, 1);
});
await check('The same daily QR can attend another class in production', async () => { const response = await scan(class2); assert.equal(response.status, 200); assert.equal((await response.json() as any).alreadyRecorded, false); });

await check('Expired access does not erase refresh cookies prematurely', async () => {
  const expired = studentCookies.replace(/__Host-besant_access=[^;]+/, '__Host-besant_access=expired_token');
  const response = await request('/api/hub', { headers: { cookie: expired } }); assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null);
  const renewed = await post('/api/auth/refresh', {}, expired); assert.equal(renewed.status, 200); assert.notEqual(cookieHeader(renewed), expired);
});
await check('Session load can safely refresh a returning browser', async () => {
  const expired = studentCookies.replace(/__Host-besant_access=[^;]+/, '__Host-besant_access=expired_token');
  const response = await request('/api/session', { headers: { cookie: expired } }); assert.equal(response.status, 200); assert.equal((await response.json() as any).signedIn, true); assert.ok(response.headers.getSetCookie().length === 2);
});
await check('Auth outages return a retryable error without deleting cookies', async () => {
  unavailable = true; try { const response = await request('/api/session', { headers: { cookie: studentCookies } }); assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null); } finally { unavailable = false; }
});
await check('Large JSON requests are rejected', async () => assert.equal((await post('/api/hub', { op: 'setup', name: 'x'.repeat(33000) }, ownerCookies)).status, 413));

await check('Student and Trainer can sign in using their assigned ID', async () => {
  for (const [identifier, user, role] of [['API-ONE', student, 'student'],['TR-API1', trainer, 'trainer']] as const) {
    const response=await post('/api/auth/login', {identifier,password:user.password,role});
    assert.equal(response.status,200,await response.clone().text());
  }
  assert.equal((await post('/api/auth/login',{identifier:'UNKNOWN-ID',password:'invalid',role:'student'})).status,401);
});
await check('Admin imports multiple students with valid batches', async () => {
  const response=await post('/api/hub',{op:'importStudents',rows:[
    {name:'Imported One',email:'importedone@example.test',studentId:'STU-IMP1',courseId:course,batchId:batch1,status:'Active'},
    {name:'Imported Two',email:'importedtwo@example.test',studentId:'STU-IMP2',courseId:course,batchId:batch2,status:'Active'}]},ownerCookies);
  assert.equal(response.status,200,await response.clone().text());
  assert.equal((await response.json() as any).imported.length,2);
});
await check('Admin imports six-column students without a batch', async () => {
  const response=await post('/api/hub',{op:'importStudents',rows:[
    {name:'Unassigned Course Student',email:'unassigned-course@example.test',phone:'9000012345',studentId:'STU-UNASSIGNED1',courseId:course,status:'Active'}
  ]},ownerCookies);
  assert.equal(response.status,200,await response.clone().text());
  const imported=(await response.json() as any).imported[0];
  const profile=JSON.parse(sqlite.prepare('SELECT data FROM members WHERE id=?').get(imported.id)!.data as string);
  assert.equal(profile.courseId,course);
  assert.equal(profile.batchId,'');
  const adminData=await bootstrap(ownerCookies);
  assert.ok(adminData.members.find((m:any)=>m.id===imported.id));
});
await check('Admin can assign a batch later to a course-only student', async () => {
  const rec=sqlite.prepare("SELECT id FROM members WHERE email='unassigned-course@example.test'").get() as any;
  const response=await post('/api/hub',{op:'update',kind:'students',id:rec.id,data:{
    name:'Unassigned Course Student',email:'unassigned-course@example.test',phone:'9000012345',studentId:'STU-UNASSIGNED1',courseId:course,batchId:batch1,status:'Active'
  }},ownerCookies);
  assert.equal(response.status,200,await response.clone().text());
  const profile=JSON.parse(sqlite.prepare('SELECT data FROM members WHERE id=?').get(rec.id)!.data as string);
  assert.equal(profile.batchId,batch1);
});
await check('Import still rejects a non-existent course', async () => {
  const response=await post('/api/hub',{op:'importStudents',rows:[
    {name:'Invalid Course Student',email:'invalid-course@example.test',studentId:'STU-NOCOURSE1',courseId:'missing-course-id',status:'Active'}
  ]},ownerCookies);
  assert.equal(response.status,400);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM members WHERE email='invalid-course@example.test'").get()!.n,0);
});
await check('Spreadsheet duplicate student IDs fail without partial insert', async () => {
  const response=await post('/api/hub',{op:'importStudents',rows:[
    {name:'Duplicate',email:'duplicate@example.test',studentId:'STU-IMP1',courseId:course,batchId:batch1,status:'Active'}]},ownerCookies);
  assert.equal(response.status,400);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM members WHERE email='duplicate@example.test'").get()!.n,0);
});
await check('Placement notices reach students', async () => {
  const id=await create('notifications',{category:'Placement',title:'Interview opportunity',body:'Apply through the placement team.',audience:'Students'});
  const value=await bootstrap(studentCookies);
  assert.equal(value.records.find((r:any)=>r.id===id)?.data.category,'Placement');
});
await check('Admin password resets mark the account for a forced change', async () => {
  const response = await post('/api/accounts', { memberId: pupilId }, ownerCookies); assert.equal(response.status, 200);
  const credential = (await response.json() as any).credential; assert.match(credential.temporaryPassword,/^[0-9a-f]{36}$/); assert.notEqual(credential.temporaryPassword,'Temporary-password-456');
  assert.equal(JSON.parse(sqlite.prepare('SELECT data FROM members WHERE id=?').get(pupilId)!.data as string).mustChangePassword, true);
});
await check('Editing a student cannot accidentally clear the password gate', async () => {
  const response = await post('/api/hub', { op: 'update', kind: 'students', id: pupilId, data: { name: 'Student Updated', email: student.email, studentId: 'API-ONE', courseId: course, batchId: batch1, status: 'Active' } }, ownerCookies);
  assert.equal(response.status, 200); assert.equal(JSON.parse(sqlite.prepare('SELECT data FROM members WHERE id=?').get(pupilId)!.data as string).mustChangePassword, true);
});
await check('Temporary-password accounts cannot bypass the portal gate', async () => {
  assert.equal((await request('/api/hub', { headers: { cookie: studentCookies } })).status, 403);
  const response = await request('/api/session', { headers: { cookie: studentCookies } }); assert.equal((await response.json() as any).passwordChangeRequired, true);
});
await check('Password changes require the correct current password', async () => assert.equal((await post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'Personal-password-789' }, studentCookies)).status, 401));
await check('Verified password change clears the gate and browser session', async () => {
  const response = await post('/api/auth/password', { currentPassword: student.password, newPassword: 'Personal-password-789' }, studentCookies); assert.equal(response.status, 200);
  assert.ok(response.headers.getSetCookie().every(value => value.includes('Max-Age=0')));
  assert.equal(JSON.parse(sqlite.prepare('SELECT data FROM members WHERE id=?').get(pupilId)!.data as string).mustChangePassword, false);
  assert.equal((await request('/api/hub', { headers: { cookie: await login(student) } })).status, 200);
});
await check('Admin can create a login for an existing institute member', async () => {
  const memberId = await create('trainers', { name: 'New Trainer', email: 'newtrainer@example.test', trainerId: 'TR-NEW', specialty: 'Python', status: 'Active' });
  assert.equal((await post('/api/accounts', { memberId }, ownerCookies)).status, 200);
  const row = sqlite.prepare('SELECT user_id,data FROM members WHERE id=?').get(memberId)!; assert.ok(String(row.user_id).startsWith('created-')); assert.equal(JSON.parse(row.data as string).mustChangePassword, true);
});
await check('Long student IDs become temporary passwords and require password changes', async () => {
  const memberId = await create('students', {
    name: 'Long ID Student', email: 'long-id-student@example.test',
    studentId: 'STUDENT20260042', courseId: course, batchId: batch1, status: 'Active'
  });
  const response = await post('/api/accounts', { memberId }, ownerCookies);
  assert.equal(response.status, 200, await response.clone().text());
  const credential = (await response.json() as any).credential;
  assert.equal(credential.loginId, 'STUDENT20260042');
  assert.equal(credential.temporaryPassword, 'STUDENT20260042');
  const member = sqlite.prepare('SELECT data FROM members WHERE id=?').get(memberId)!;
  assert.equal(JSON.parse(member.data as string).mustChangePassword, true);
});
await check('Long trainer IDs become temporary passwords and require password changes', async () => {
  const memberId = await create('trainers', {
    name: 'Long ID Trainer', email: 'long-id-trainer@example.test',
    trainerId: 'TRAINER20260042', specialty: 'Analytics', status: 'Active'
  });
  const response = await post('/api/accounts', { memberId }, ownerCookies);
  assert.equal(response.status, 200, await response.clone().text());
  const credential = (await response.json() as any).credential;
  assert.equal(credential.loginId, 'TRAINER20260042');
  assert.equal(credential.temporaryPassword, 'TRAINER20260042');
  const member = sqlite.prepare('SELECT data FROM members WHERE id=?').get(memberId)!;
  assert.equal(JSON.parse(member.data as string).mustChangePassword, true);
});
await check('Short ID account creation falls back to a secure temporary password', async () => {
  const memberId = await create('students', {
    name: 'Short ID Student', email: 'short-id-student@example.test',
    studentId: 'ST123', courseId: course, batchId: batch1, status: 'Active'
  });
  const response = await post('/api/accounts', { memberId }, ownerCookies);
  assert.equal(response.status, 200, await response.clone().text());
  const credential = (await response.json() as any).credential;
  assert.equal(credential.loginId, 'ST123');
  assert.match(credential.temporaryPassword, /^[0-9a-f]{36}$/);
  assert.notEqual(credential.temporaryPassword, credential.loginId);
});
await check('The API rate limits repeated password guessing', async () => {
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await post('/api/auth/login', { email: 'guessing@example.test', password: 'wrong' })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401)); assert.equal(statuses[10], 429);
});
await check('Logout clears both protected cookies', async () => { const response = await post('/api/auth/logout', {}, trainerCookies); assert.equal(response.status, 200); assert.equal(response.headers.getSetCookie().length, 2); assert.ok(response.headers.getSetCookie().every(value => value.includes('Max-Age=0'))); });

await check('Admin can delete an unlinked notice, while trainer deletion is denied', async () => {
  const id = await create('notifications', { title: 'Temporary Notice', body: 'For delete test', audience: 'Students', category: 'General' });
  const denied = await post('/api/hub', { op: 'delete', kind: 'notifications', id }, trainerCookies);
  assert.equal(denied.status, 403);
  const deleted = await post('/api/hub', { op: 'delete', kind: 'notifications', id }, ownerCookies);
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM records WHERE id=?').get(id)!.n, 0);
});
await check('Only administrators can permanently delete accounts', async () => {
  const blocked = await post('/api/accounts', { action: 'delete', memberId: pupilId }, trainerCookies);
  assert.equal(blocked.status, 403);
});
await check('Historical attendance prevents permanent student deletion', async () => {
  const resp = await post('/api/accounts', { action: 'delete', memberId: pupilId }, ownerCookies);
  assert.equal(resp.status, 409, await resp.clone().text());
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM members WHERE id=?').get(pupilId)!.n, 1);
});
await check('Assigned trainers cannot be permanently deleted', async () => {
  const resp = await post('/api/accounts', { action: 'delete', memberId: privateTeacherId }, ownerCookies);
  assert.equal(resp.status, 409);
});
await check('Admin can permanently remove an unused student and their Supabase login', async () => {
  const removableCourse = await create('courses', { name: 'Disposable Course', duration: 4, status: 'Active' });
  const removableBatch = await create('batches', { name: 'Disposable Batch', courseId: removableCourse, trainerId: teacherId, branchId: branch1, startDate: '2026-12-01', status: 'Active' });
  const memberId = await create('students', { name: 'Disposable Demo', email: 'disposable@example.test', studentId: 'DELETE-TEST-001', batchId: removableBatch, courseId: removableCourse, status: 'Active' });
  const created = await post('/api/accounts', { memberId }, ownerCookies);
  assert.equal(created.status, 200, await created.clone().text());
  const linked = sqlite.prepare('SELECT user_id AS id FROM members WHERE id=?').get(memberId) as any;
  assert.ok(linked?.id); assert.ok(users.has(linked.id));
  const resp = await post('/api/accounts', { action: 'delete', memberId }, ownerCookies);
  assert.equal(resp.status, 200, await resp.clone().text());
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM members WHERE id=?').get(memberId)!.n, 0);
  assert.ok(!users.has(linked.id));
  assert.ok(providerCalls.some(call => call.method === 'DELETE' && call.path.endsWith('/' + linked.id)));
});

await check('Weekday/weekend batch schedules use configured teaching days and respect capacity', async () => {
  const today=new Date(Date.now()+5*86400000);
  const monday=new Date(today);
  monday.setUTCDate(monday.getUTCDate()+((1-monday.getUTCDay()+7)%7));
  const sunday=new Date(monday);sunday.setUTCDate(sunday.getUTCDate()+13);
  const start=monday.toISOString().slice(0,10),end=sunday.toISOString().slice(0,10);
  const made=await create('batches',{name:'Weekend Test',courseId:course,subcourseId:publicSubcourse,trainerId:teacherId,branchId:branch1,startDate:start,endDate:end,dailyStartTime:'09:00',dailyEndTime:'10:00',batchType:'Weekend',capacity:2,status:'Active'});
  const days=sqlite.prepare("SELECT data FROM records WHERE kind='schedules' AND json_extract(data,'$.batchId')=?").all(made);
  assert.ok(days.length>=3);
  for(const entry of days){const day=new Date(JSON.parse(entry.data as string).batchDay+'T00:00:00Z').getUTCDay();assert.ok(day===0||day===6);}
  const trainerResponse=await post('/api/hub',{op:'setBatchCapacity',batchId:made,capacity:3},trainerCookies);
  assert.equal(trainerResponse.status,200,await trainerResponse.clone().text());
  assert.equal((await post('/api/hub',{op:'setBatchCapacity',batchId:made,capacity:10},studentCookies)).status,403);
});
await check('Course-only first attendance claims one atomic seat, waitlists the next student, and shows safe peers', async () => {
  const b=await create('batches',{name:'First QR Seat',courseId:course,subcourseId:publicSubcourse,trainerId:teacherId,branchId:branch1,startDate:new Date().toISOString().slice(0,10),capacity:1,batchType:'Weekday',status:'Active'});
  const studentA=addUser('auth-seat-a','seat-a@example.test');
  const studentB=addUser('auth-seat-b','seat-b@example.test');
  const idA=await create('students',{name:'First Seat',email:studentA.email,studentId:'SEAT-TEST-A',courseId:course,status:'Active'});
  const idB=await create('students',{name:'Waitlisted Seat',email:studentB.email,studentId:'SEAT-TEST-B',courseId:course,status:'Active'});
  const cookieA=await login(studentA),cookieB=await login(studentB);
  const one=await create('schedules',{name:'First-join test session',batchId:b,startAt:new Date(Date.now()-60000).toISOString(),endAt:new Date(Date.now()+3600000).toISOString(),mode:'In person'});
  assert.equal((await post('/api/hub',{op:'openSession',id:one},trainerCookies)).status,200);
  const payloadA=(await bootstrap(cookieA)).studentQr.payload,payloadB=(await bootstrap(cookieB)).studentQr.payload;
  const scans=await Promise.all(Array.from({length:3},()=>post('/api/hub',{op:'scanStudentQr',scheduleId:one,payload:payloadA},trainerCookies)));
  assert.ok(scans.every(r=>r.status===200),scans.map(r=>r.status).join(','));
  assert.equal(sqlite.prepare("SELECT count(*) n FROM records WHERE kind='enrollments' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.batchId')=?").get(idA,b)!.n,1);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM attendance WHERE member_id=? AND schedule_id=?").get(idA,one)!.n,1);
  const denied=await post('/api/hub',{op:'scanStudentQr',scheduleId:one,payload:payloadB},trainerCookies);
  assert.equal(denied.status,409,await denied.clone().text());
  assert.equal(sqlite.prepare("SELECT count(*) n FROM attendance WHERE member_id=? AND schedule_id=?").get(idB,one)!.n,0);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM records WHERE kind='batch-waitlist' AND json_extract(data,'$.studentId')=?").get(idB)!.n,1);
  const own=await bootstrap(cookieA);
  const peer=own.members.find((m:any)=>m.id===idB);
  assert.equal(peer,undefined,'an unassigned course mate must not appear as a batchmate');
  const trainerData=await bootstrap(trainerCookies);
  assert.equal(trainerData.records.find((r:any)=>r.id===b).data.studentCount,1);
  assert.equal(trainerData.records.find((r:any)=>r.id===b).data.waitingCount,1);
  assert.ok(!(await bootstrap(cookieA)).records.some((r:any)=>r.kind==='batch-waitlist' && r.data.studentId===idB));
  assert.equal((await post('/api/hub',{op:'setBatchCapacity',batchId:b,capacity:0},trainerCookies)).status,400);
  assert.equal(sqlite.prepare("SELECT json_extract(data,'$.status') status FROM records WHERE id=?").get(`module-progress:${idA}:${publicSubcourse}`)!.status,'Ongoing');
  const complete=await post('/api/hub',{op:'completeModule',studentId:idA,subcourseId:publicSubcourse,criteriaNote:'Passed reviewed teaching exercises and assessment.'},trainerCookies);
  assert.equal(complete.status,200,await complete.clone().text());
  assert.equal((await post('/api/hub',{op:'scanStudentQr',scheduleId:one,payload:payloadA},trainerCookies)).status,200);
  assert.equal(sqlite.prepare("SELECT json_extract(data,'$.status') status FROM records WHERE id=?").get(`module-progress:${idA}:${publicSubcourse}`)!.status,'Completed');
  assert.ok((await bootstrap(cookieA)).records.some((r:any)=>r.kind==='module-progress' && r.data.subcourseId===publicSubcourse));
  assert.ok(!(await bootstrap(cookieB)).records.some((r:any)=>r.kind==='module-progress' && r.data.studentId===idA));
});
await check('Admin imports completed and pending subcourses for correctly enrolled students', async () => {
  const studentId=await create('students',{name:'Progress Test Student',email:'progress-testing@example.test',studentId:'PROGRESS-TEST-01',courseId:course,status:'Active'});
  const extra=await create('subcourses',{courseId:course,name:'Progress CSV Module',duration:2,status:'Active'});
  const payload=[
    {studentId:'PROGRESS-TEST-01',course:'Full Stack',subcourse:'Progress CSV Module',status:'Completed',evidence:'Passed the evaluation workbook'},
    {studentId:'PROGRESS-TEST-01',course:'Full Stack',subcourse:'Python',status:''}
  ];
  // Use actual course/subcourse names from database rather than assumptions.
  const parent=(sqlite.prepare("SELECT json_extract(data,'$.name') name FROM records WHERE id=?").get(course) as any).name;
  const module=(sqlite.prepare("SELECT json_extract(data,'$.name') name FROM records WHERE id=?").get(publicSubcourse) as any).name;
  payload[0].course=parent;payload[1].course=parent;payload[1].subcourse=module;
  const resp=await post('/api/hub',{op:'importModuleProgress',rows:payload},ownerCookies);
  assert.equal(resp.status,200,await resp.clone().text());
  const row=sqlite.prepare('SELECT data FROM records WHERE id=?').get(`module-progress:${studentId}:${extra}`) as any;
  assert.equal(JSON.parse(row.data).status,'Completed');
  assert.equal(JSON.parse(row.data).approvedBy,(await bootstrap(ownerCookies)).me.id);
  assert.equal((sqlite.prepare("SELECT json_extract(data,'$.status') status FROM records WHERE id=?").get(`module-progress:${studentId}:${publicSubcourse}`) as any).status,'Pending');
  // Pending upload cannot downgrade Completed.
  const again=await post('/api/hub',{op:'importModuleProgress',rows:[{...payload[0],status:'Pending'}]},ownerCookies);
  assert.equal(again.status,200,await again.clone().text());
  assert.equal((sqlite.prepare("SELECT json_extract(data,'$.status') status FROM records WHERE id=?").get(`module-progress:${studentId}:${extra}`) as any).status,'Completed');
  // Manual Admin approval doesn't require attendance; trainee may never have attended yet.
  const approved=await post('/api/hub',{op:'completeModule',studentId,subcourseId:publicSubcourse,criteriaNote:'Assessment reviewed and passed by Admin.'},ownerCookies);
  assert.equal(approved.status,200,await approved.clone().text());
});
await check('Students and trainers cannot bulk-import completion statuses', async () => {
  const rows=[{studentId:'PROGRESS-TEST-01',course:'Does not matter',subcourse:'Python',status:'Completed'}];
  assert.equal((await post('/api/hub',{op:'importModuleProgress',rows},studentCookies)).status,403);
  assert.equal((await post('/api/hub',{op:'importModuleProgress',rows},trainerCookies)).status,403);
  assert.equal((await post('/api/hub',{op:'completeModule',studentId:pupilId,subcourseId:publicSubcourse,criteriaNote:'Attempt to escalate completion'},studentCookies)).status,403);
});
await check('Invalid or duplicated Excel subcourse status rows roll back without changes', async () => {
  const parent=(sqlite.prepare("SELECT json_extract(data,'$.name') name FROM records WHERE id=?").get(course) as any).name;
  const valid={studentId:'PROGRESS-TEST-01',course:parent,subcourse:'Progress CSV Module',status:'Completed'};
  const invalid={...valid,studentId:'Unknown-Student-ID'};
  const r=await post('/api/hub',{op:'importModuleProgress',rows:[valid,invalid]},ownerCookies);
  assert.equal(r.status,400,await r.clone().text());
  const duplicate=await post('/api/hub',{op:'importModuleProgress',rows:[valid,valid]},ownerCookies);
  assert.equal(duplicate.status,409,await duplicate.clone().text());
});
await check('Student Details Excel completed list sets remaining modules Pending or attendance-Ongoing', async () => {
  const student=(sqlite.prepare("SELECT id FROM members WHERE role='student' AND json_extract(data,'$.studentId')='PROGRESS-TEST-01'").get() as any).id;
  const parent=(sqlite.prepare("SELECT json_extract(data,'$.name') name FROM records WHERE id=?").get(course) as any).name;
  const python=(sqlite.prepare("SELECT json_extract(data,'$.name') name FROM records WHERE id=?").get(publicSubcourse) as any).name;
  const ongoingSubcourse=await create('subcourses',{courseId:course,name:'Attendance Ongoing Detail',duration:2,status:'Active'});
  const resetSubcourse=await create('subcourses',{courseId:course,name:'Missing From Spreadsheet',duration:2,status:'Active'});
  // Simulate confirmed prior module attendance linked to a class and a module.
  const batch=await create('batches',{name:'Student Details Status Test',courseId:course,subcourseId:ongoingSubcourse,trainerId:teacherId,branchId:branch1,startDate:'2026-01-05',status:'Active'});
  const session=await create('schedules',{name:'Attendance Evidence for Details Test',batchId:batch,startAt:'2026-01-06T12:00:00Z',endAt:'2026-01-06T13:00:00Z',mode:'In person'});
  sqlite.prepare("INSERT INTO attendance(id,member_id,schedule_id,status,checked_in,method,note,gps_verified) VALUES (?,?,?,'Present',?,'Trainer QR scan','Prior attendance',0)")
    .run(crypto.randomUUID(),student,session,'2026-01-06T12:05:00.000Z');
  // A prior approval omitted by a replacement snapshot should become Pending.
  const approved=await post('/api/hub',{op:'completeModule',studentId:student,subcourseId:resetSubcourse,criteriaNote:'Earlier assessment signed off manually'},ownerCookies);
  assert.equal(approved.status,200,await approved.clone().text());
  const request={studentId:'PROGRESS-TEST-01',course:parent,completedSubcourses:[python]};
  const res=await post('/api/hub',{op:'importStudentDetailsCompleted',rows:[request]},ownerCookies);
  assert.equal(res.status,200,await res.clone().text());
  const body=await res.json() as any;
  assert.equal(body.imported,1);
  const status=(id:string)=> (sqlite.prepare("SELECT json_extract(data,'$.status') status FROM records WHERE id=?").get(`module-progress:${student}:${id}`) as any)?.status;
  assert.equal(status(publicSubcourse),'Completed');
  assert.equal(status(ongoingSubcourse),'Ongoing');
  assert.equal(status(resetSubcourse),'Pending');
  assert.ok(body.resetCompletions>=1);
  const current=await bootstrap(ownerCookies);
  assert.ok(current.records.some((r:any)=>r.kind==='module-progress' && r.data.studentId===student && r.data.status==='Pending'));
});
await check('Student Details snapshot rejects non-admin imports and mismatched subcourse names atomically', async () => {
  const courseName=(sqlite.prepare("SELECT json_extract(data,'$.name') name FROM records WHERE id=?").get(course) as any).name;
  const good={studentId:'PROGRESS-TEST-01',course:courseName,completedSubcourses:[]};
  assert.equal((await post('/api/hub',{op:'importStudentDetailsCompleted',rows:[good]},studentCookies)).status,403);
  assert.equal((await post('/api/hub',{op:'importStudentDetailsCompleted',rows:[good]},trainerCookies)).status,403);
  const student=(sqlite.prepare("SELECT id FROM members WHERE role='student' AND json_extract(data,'$.studentId')='PROGRESS-TEST-01'").get() as any).id;
  const before=(sqlite.prepare("SELECT json_extract(data,'$.status') status FROM records WHERE id=?").get(`module-progress:${student}:${publicSubcourse}`) as any).status;
  await create('students',{name:'Student Details Invalid Test',email:'detail-invalid@example.test',studentId:'DETAIL-INVALID-01',courseId:course,status:'Active'});
  const invalid={...good,studentId:'DETAIL-INVALID-01',completedSubcourses:['Definitely Not A Known Module']};
  assert.equal((await post('/api/hub',{op:'importStudentDetailsCompleted',rows:[good,invalid]},ownerCookies)).status,400);
  assert.equal((sqlite.prepare("SELECT json_extract(data,'$.status') status FROM records WHERE id=?").get(`module-progress:${student}:${publicSubcourse}`) as any).status,before);
  assert.equal((await post('/api/hub',{op:'importStudentDetailsCompleted',rows:[good,good]},ownerCookies)).status,409);
});
await check('Unrelated trainers cannot complete another course module', async () => {
  const id=(sqlite.prepare("SELECT id FROM members WHERE role='student' AND json_extract(data,'$.studentId')='PROGRESS-TEST-01'").get() as any).id;
  const result=await post('/api/hub',{op:'completeModule',studentId:id,subcourseId:privateSubcourse,criteriaNote:'Fraudulent sign off for another course'},trainerCookies);
  assert.equal(result.status,403,await result.clone().text());
});
await check('Two different students racing for the last seat never over-enroll',async()=>{
  const b=await create('batches',{name:'Last Seat Race',courseId:course,subcourseId:publicSubcourse,trainerId:teacherId,branchId:branch1,startDate:new Date().toISOString().slice(0,10),capacity:1,status:'Active'});
  const one=await create('schedules',{name:'Parallel enrollment test',batchId:b,startAt:new Date(Date.now()-60000).toISOString(),endAt:new Date(Date.now()+3600000).toISOString(),mode:'In person'});
  assert.equal((await post('/api/hub',{op:'openSession',id:one},trainerCookies)).status,200);
  const u=addUser('auth-race-seat','race-seat@example.test');
  const id=await create('students',{name:'Racing Learner',email:u.email,studentId:'RACE-LEARNER',courseId:course,status:'Active'});
  const cookie=await login(u);
  const payload1=(await bootstrap(cookie)).studentQr.payload;
  const otherUser=users.get('auth-seat-b')!;
  const otherCookie=await login(otherUser);
  const payload2=(await bootstrap(otherCookie)).studentQr.payload;
  const responses=await Promise.all([payload1,payload2].map(payload=>post('/api/hub',{op:'scanStudentQr',scheduleId:one,payload},trainerCookies)));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409],await Promise.all(responses.map(r=>r.clone().text())).then(x=>x.join(',')));
  const seats=sqlite.prepare("SELECT count(*) n FROM records WHERE kind='enrollments' AND json_extract(data,'$.batchId')=? AND json_extract(data,'$.status')='Active'").get(b) as {n:number};
  assert.equal(seats.n,1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM attendance WHERE schedule_id=?').get(one)!.n,1);
  assert.ok(id);
});
await check('A student may register for multiple independent courses without a batch', async () => {
  const person=sqlite.prepare("SELECT id FROM members WHERE email='seat-b@example.test'").get() as {id:string};
  const alpha=await create('courses',{name:'Second Course for Multiple Enrollment',duration:3,status:'Active'});
  const beta=await create('courses',{name:'Third Course for Multiple Enrollment',duration:3,status:'Active'});
  const first=await post('/api/hub',{op:'create',kind:'enrollments',data:{studentId:person.id,courseId:alpha,status:'Active'}},ownerCookies);
  assert.equal(first.status,200,await first.clone().text());
  const second=await post('/api/hub',{op:'create',kind:'enrollments',data:{studentId:person.id,courseId:beta,status:'Active'}},ownerCookies);
  assert.equal(second.status,200,await second.clone().text());
  const cookie=await login(users.get('auth-seat-b')!);
  const hub=await bootstrap(cookie);
  assert.ok(hub.records.some((r:any)=>r.id===alpha));assert.ok(hub.records.some((r:any)=>r.id===beta));
});
await check('Trainer GET response hides students’ email and phone', async () => {
  const value = await bootstrap(trainerCookies);
  const pupils = value.members.filter((m:any) => m.role === 'student');
  assert.ok(pupils.length >= 2);
  for (const m of pupils) { assert.equal(m.email, ''); assert.equal(m.data.email, undefined); assert.equal(m.data.phone, undefined); }
  assert.ok(!value.records.some((r:any) => r.id === privateSubcourse));
});
await check('Admin can assign teaching subcourse only from the parent course', async () => {
  const resp = await post('/api/hub', { op:'create',kind:'batches',data:{name:'Mismatched topic',courseId:course,subcourseId:privateSubcourse,trainerId:teacherId,branchId:branch1,startDate:'2026-11-01',status:'Active'} }, ownerCookies);
  assert.equal(resp.status, 400);
});
await check('Trainer may request leave visible to Admin but not to students or unrelated trainers', async () => {
  const created = await post('/api/hub', {op:'create',kind:'leaves',data:{fromDate:'2026-11-02',toDate:'2026-11-03',reason:'Trainer training day',recipientId:'admin'}}, trainerCookies);
  assert.equal(created.status,200,await created.clone().text());
  const leaveId=(await created.json() as any).id;
  assert.ok((await bootstrap(ownerCookies)).records.some((r:any)=>r.id===leaveId));
  assert.ok((await bootstrap(trainerCookies)).records.some((r:any)=>r.id===leaveId));
  assert.ok(!(await bootstrap(studentCookies)).records.some((r:any)=>r.id===leaveId));
  assert.ok(!(await bootstrap(privateTrainerCookies)).records.some((r:any)=>r.id===leaveId));
  assert.equal((await post('/api/hub',{op:'review',id:leaveId,status:'Approved'},trainerCookies)).status,403);
  assert.equal((await post('/api/hub',{op:'review',id:leaveId,status:'Approved'},privateTrainerCookies)).status,403);
  const approved=await post('/api/hub',{op:'review',id:leaveId,status:'Approved'},ownerCookies);
  assert.equal(approved.status,200,await approved.clone().text());
  const approvedLeave=(await bootstrap(trainerCookies)).records.find((r:any)=>r.id===leaveId);
  assert.equal(approvedLeave.data.reviewedByMemberId,(await bootstrap(ownerCookies)).me.id);
  assert.equal(approvedLeave.data.status,'Approved');
  assert.equal((await post('/api/hub',{op:'review',id:leaveId,status:'Rejected'},ownerCookies)).status,409);
});
await check('Student leave goes only to the selected trainer and only one review may succeed', async () => {
  const made=await post('/api/hub',{op:'create',kind:'leaves',data:{fromDate:'2026-11-09',toDate:'2026-11-10',reason:'Student exam',recipientId:teacherId}},studentCookies);
  assert.equal(made.status,200,await made.clone().text());
  const id=(await made.json() as any).id;
  assert.ok((await bootstrap(trainerCookies)).records.some((r:any)=>r.id===id));
  assert.ok(!(await bootstrap(privateTrainerCookies)).records.some((r:any)=>r.id===id));
  assert.ok(!(await bootstrap(ownerCookies)).records.some((r:any)=>r.id===id));
  assert.equal((await post('/api/hub',{op:'review',id,status:'Approved'},privateTrainerCookies)).status,403);
  assert.equal((await post('/api/hub',{op:'review',id,status:'Approved'},trainerCookies)).status,200);
  assert.equal((await post('/api/hub',{op:'review',id,status:'Rejected'},ownerCookies)).status,403);
  assert.equal((await bootstrap(studentCookies)).records.find((r:any)=>r.id===id).data.status,'Approved');
  assert.ok((await bootstrap(ownerCookies)).approvedLeaveDates.some((r:any)=>r.studentId===pupilId && r.fromDate==='2026-11-09'));
});
await check('Student Admin-addressed leave is invisible to trainers and rejects unauthorized recipients', async () => {
  const made=await post('/api/hub',{op:'create',kind:'leaves',data:{fromDate:'2026-11-16',toDate:'2026-11-17',reason:'Family event',recipientId:'admin'}},studentCookies);
  assert.equal(made.status,200,await made.clone().text());
  const id=(await made.json() as any).id;
  assert.ok((await bootstrap(ownerCookies)).records.some((r:any)=>r.id===id));
  assert.ok(!(await bootstrap(trainerCookies)).records.some((r:any)=>r.id===id));
  assert.equal((await post('/api/hub',{op:'review',id,status:'Approved'},trainerCookies)).status,403);
  assert.equal((await post('/api/hub',{op:'review',id,status:'Approved'},ownerCookies)).status,200);
  assert.equal((await bootstrap(studentCookies)).records.find((r:any)=>r.id===id).data.status,'Approved');
  const illegal=await post('/api/hub',{op:'create',kind:'leaves',data:{fromDate:'2026-11-16',toDate:'2026-11-17',reason:'Not assigned',recipientId:privateTeacherId}},studentCookies);
  assert.equal(illegal.status,403);
});
await check('Trainer can declare only own batch holidays and students see only their batch', async () => {
  const missing=await post('/api/hub',{op:'create',kind:'holidays',data:{name:'Wrong trainer',date:'2026-11-20',batchId:protectedBatch}},trainerCookies);
  assert.equal(missing.status,403);
  const created=await post('/api/hub',{op:'create',kind:'holidays',data:{name:'SQL lab holiday',date:'2026-11-20',batchId:batch1,description:'Lab maintenance'}},trainerCookies);
  assert.equal(created.status,200,await created.clone().text());
  const id=(await created.json() as any).id;
  assert.ok((await bootstrap(studentCookies)).records.some((r:any)=>r.id===id));
  assert.ok(!(await bootstrap(otherCookies)).records.some((r:any)=>r.id===id));
  assert.ok(!(await bootstrap(privateTrainerCookies)).records.some((r:any)=>r.id===id));
  assert.equal((await post('/api/hub',{op:'update',kind:'holidays',id,data:{name:'Hacked',date:'2026-11-20',batchId:batch1}},privateTrainerCookies)).status,403);
  assert.equal((await post('/api/hub',{op:'delete',kind:'holidays',id},privateTrainerCookies)).status,403);
  assert.equal((await post('/api/hub',{op:'delete',kind:'holidays',id},trainerCookies)).status,200);
});


await check('Trainer batch counts follow active primary and secondary enrollments', async () => {
  const before = (await bootstrap(trainerCookies)).records.find((r:any) => r.id === batch1).data.studentCount;
  const enrollment = await create('enrollments', {studentId:(sqlite.prepare("SELECT id FROM members WHERE email=?").get(otherStudent.email) as any).id,courseId:course,batchId:batch1,status:'Active'});
  const after = (await bootstrap(trainerCookies)).records.find((r:any) => r.id === batch1).data.studentCount;
  assert.equal(after,before+1);
  assert.ok((await bootstrap(trainerCookies)).records.some((r:any) => r.id === enrollment));
  const updated = await post('/api/hub',{op:'update',kind:'enrollments',id:enrollment,data:{studentId:(sqlite.prepare("SELECT id FROM members WHERE email=?").get(otherStudent.email) as any).id,courseId:course,batchId:batch1,status:'Inactive'}},ownerCookies);
  assert.equal(updated.status,200,await updated.clone().text());
  assert.equal((await bootstrap(trainerCookies)).records.find((r:any) => r.id === batch1).data.studentCount,before);
});
await check('Trainer cannot see or approve slot booking requests', async () => {
  const created=await post('/api/hub',{op:'create',kind:'bookings',data:{scheduleId:class1,notes:'Student slot'}},studentCookies);
  assert.equal(created.status,200,await created.clone().text());
  const id=(await created.json() as any).id;
  assert.ok(!(await bootstrap(trainerCookies)).records.some((r:any)=>r.id===id));
  assert.equal((await post('/api/hub',{op:'review',id,status:'Approved'},trainerCookies)).status,403);
  assert.equal((await post('/api/hub',{op:'review',id,status:'Approved'},ownerCookies)).status,200);
});
await check('Only Admin can force-delete records after exact confirmation', async () => {
  const id=await create('notifications',{title:'Force delete test',body:'Temporary',category:'General',audience:'All'});
  assert.equal((await post('/api/hub',{op:'forceDelete',kind:'notifications',id,confirmation:'DELETE ALL RELATED DATA'},trainerCookies)).status,403);
  assert.equal((await post('/api/hub',{op:'forceDelete',kind:'notifications',id,confirmation:'DELETE'},ownerCookies)).status,400);
  const deleted=await post('/api/hub',{op:'forceDelete',kind:'notifications',id,confirmation:'DELETE ALL RELATED DATA'},ownerCookies);
  assert.equal(deleted.status,200,await deleted.clone().text());
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM records WHERE id=?').get(id) as any).n,0);
});
await check('Merged Excel upload creates student and modules in one Admin request', async () => {
  const input={name:'Excel Unified Learner',email:'excel-merged@example.test',phone:'9000002222',studentId:'UNIFIED-0001',course:'Python',completedSubcourses:['SQL'],overallStatus:'Ongoing'};
  assert.equal((await post('/api/hub',{op:'importStudentsAndProgress',rows:[input]},studentCookies)).status,403);
  assert.equal((await post('/api/hub',{op:'importStudentsAndProgress',rows:[input]},trainerCookies)).status,403);
  const resp=await post('/api/hub',{op:'importStudentsAndProgress',rows:[input]},ownerCookies);
  assert.equal(resp.status,200,await resp.clone().text());
  const result=await resp.json() as any;
  assert.equal(result.created.length,1);
  assert.equal(result.completed,1);
  const studentId=result.created[0].id;
  assert.equal((sqlite.prepare("SELECT json_extract(data,'$.batchId') AS batch FROM members WHERE id=?").get(studentId) as any).batch,'');
  const module=(sqlite.prepare("SELECT json_extract(data,'$.status') AS status FROM records WHERE id=?").get(`module-progress:${studentId}:${publicSubcourse}`) as any);
  assert.equal(module.status,'Completed');
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM members WHERE email=?").get(input.email) as any).n,1);
  const again=await post('/api/hub',{op:'importStudentsAndProgress',rows:[input]},ownerCookies);
  assert.equal(again.status,200,await again.clone().text());
  assert.equal((await again.json() as any).existing,1);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM members WHERE email=?").get(input.email) as any).n,1);
});
await check('Merged upload matches email and name without rewriting existing Student ID', async () => {
  const row={name:'Excel Unified Learner',email:'excel-merged@example.test',phone:'9000002222',studentId:'ALT-WORKBOOK-900',course:'Python',completedSubcourses:[],overallStatus:'Completed'};
  const resp=await post('/api/hub',{op:'importStudentsAndProgress',rows:[row]},ownerCookies);
  assert.equal(resp.status,200,await resp.clone().text());
  const result=await resp.json() as any;
  assert.equal(result.matchedByEmail,1);
  assert.equal(result.created.length,0);
  const p=sqlite.prepare("SELECT id,json_extract(data,'$.studentId') as studentId FROM members WHERE email=?").get(row.email) as any;
  assert.equal(p.studentId,'UNIFIED-0001');
  assert.equal((sqlite.prepare("SELECT json_extract(data,'$.status') AS status FROM records WHERE id=?").get(`module-progress:${p.id}:${publicSubcourse}`) as any).status,'Pending');
});
await check('Merged upload rejects identity conflicts and unknown subcourses without adding students', async () => {
  const conflicting={name:'Student',email:'excel-merged@example.test',studentId:'API-ONE',course:'Python',completedSubcourses:['SQL']};
  assert.equal((await post('/api/hub',{op:'importStudentsAndProgress',rows:[conflicting]},ownerCookies)).status,409);
  const invalid={name:'New Person',email:'invalid-module@example.test',studentId:'INVALID-MOD-001',course:'Python',completedSubcourses:['Unknown module']};
  assert.equal((await post('/api/hub',{op:'importStudentsAndProgress',rows:[invalid]},ownerCookies)).status,400);
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM members WHERE email=?').get(invalid.email) as any).n,0);
});
await check('Merged upload adds second course to existing student without batch assignment', async () => {
  const secondary=await create('courses',{name:'Unified Extra Course',duration:8,status:'Active'});
  const subject=await create('subcourses',{name:'Secondary Topic',courseId:secondary,duration:3,status:'Active'});
  const row={name:'Excel Unified Learner',email:'excel-merged@example.test',studentId:'UNIFIED-0001',course:'Unified Extra Course',completedSubcourses:['Secondary Topic']};
  const response=await post('/api/hub',{op:'importStudentsAndProgress',rows:[row]},ownerCookies);
  assert.equal(response.status,200,await response.clone().text());
  const studentId=(sqlite.prepare('SELECT id FROM members WHERE email=?').get(row.email) as any).id;
  const enrollment=sqlite.prepare("SELECT json_extract(data,'$.batchId') AS batch FROM records WHERE kind='enrollments' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.courseId')=?").get(studentId,secondary) as any;
  assert.equal(enrollment.batch,'');
  assert.equal((sqlite.prepare("SELECT json_extract(data,'$.status') AS status FROM records WHERE id=?").get(`module-progress:${studentId}:${subject}`) as any).status,'Completed');
});
await check('Admin force deletion removes an attended student and prevents old login', async () => {
  const personId=pupilId;
  const response=await post('/api/accounts',{action:'forceDelete',memberId:personId,confirmation:'DELETE ALL RELATED DATA'},ownerCookies);
  assert.equal(response.status,200,await response.clone().text());
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM members WHERE id=?').get(personId) as any).n,0);
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM attendance WHERE member_id=?').get(personId) as any).n,0);
  assert.ok(!users.has(student.id));
  assert.equal((await request('/api/hub',{headers:{cookie:studentCookies}})).status,401);
});
await check('Admin full schedule includes previous/upcoming classes; trainer only assigned batches', async () => {
  const pastStart = new Date(Date.now() - 14 * 86400000).toISOString();
  const pastEnd = new Date(Date.now() - 14 * 86400000 + 3600000).toISOString();
  const futureStart = new Date(Date.now() + 14 * 86400000).toISOString();
  const futureEnd = new Date(Date.now() + 14 * 86400000 + 3600000).toISOString();
  const oldId = await create('schedules', { name: 'Schedule history check', batchId: batch1, startAt: pastStart, endAt: pastEnd, mode: 'In person' });
  const futureId = await create('schedules', { name: 'Schedule future check', batchId: batch1, startAt: futureStart, endAt: futureEnd, mode: 'In person' });
  const privateId = await create('schedules', { name: 'Other trainer private check', batchId: protectedBatch, startAt: futureStart, endAt: futureEnd, mode: 'In person' });
  const adminScheduleIds = new Set((await bootstrap(ownerCookies)).records.filter((r:any) => r.kind === 'schedules').map((r:any) => r.id));
  const trainerScheduleIds = new Set((await bootstrap(trainerCookies)).records.filter((r:any) => r.kind === 'schedules').map((r:any) => r.id));
  assert.ok([oldId, futureId, privateId].every(id => adminScheduleIds.has(id)));
  assert.ok(trainerScheduleIds.has(oldId) && trainerScheduleIds.has(futureId));
  assert.ok(!trainerScheduleIds.has(privateId));
});
await check('Admin creates shared batch with multiple parent courses; trainer cannot grant extra courses', async () => {
  const analytics = await create('courses', {name:'Shared Analytics Program',duration:20,status:'Active'});
  const analyticsSql = await create('subcourses',{courseId:analytics,name:'SQL',duration:3,status:'Active'});
  const sharedId = await create('batches',{name:'SQL Shared Python and Analytics',courseId:course,courseIds:[course,analytics],subcourseId:publicSubcourse,trainerId:teacherId,branchId:branch1,startDate:'2026-01-01',capacity:3,status:'Active'});
  const adminBatch=(await bootstrap(ownerCookies)).records.find((r:any)=>r.id===sharedId);
  assert.deepEqual(adminBatch.data.courseIds,[course,analytics]);
  const trainerView=await bootstrap(trainerCookies);
  assert.ok(trainerView.records.some((r:any)=>r.id===analytics && r.kind==='courses'));
  const forbidden = await post('/api/hub',{op:'create',kind:'batches',data:{name:'Forged shared batch',courseId:course,courseIds:[course,protectedCourse],trainerId:teacherId,branchId:branch1,startDate:'2026-01-01',status:'Active'}},trainerCookies);
  assert.equal(forbidden.status,403);
  const thirdCourse=await create('courses',{name:'Unrelated Course Alpha',duration:4,status:'Active'});
  const unrelated = addUser('auth-shared-unrelated','shared-unrelated@example.test');
  await create('students',{name:'Unrelated Student',email:unrelated.email,studentId:'UNRELATEDSHARED',courseId:thirdCourse,status:'Active'});
  const unrelatedCookies=await login(unrelated);
  const eligible = addUser('auth-shared-analytics','shared-analytics@example.test');
  const studentId = await create('students',{name:'Analytics Shared Student',email:eligible.email,studentId:'ANALYTICSSHARED',courseId:analytics,status:'Active'});
  const eligibleCookies=await login(eligible);
  const before=(await bootstrap(eligibleCookies)).records;
  assert.ok(before.some((r:any)=>r.id===analytics));
  assert.ok(!before.some((r:any)=>r.id===course));
  assert.ok(!before.some((r:any)=>r.id===protectedCourse));
  const sessionId=await create('schedules',{name:'Shared SQL today',batchId:sharedId,startAt:new Date(Date.now()-60000).toISOString(),endAt:new Date(Date.now()+3600000).toISOString(),mode:'In person'});
  const started=await post('/api/hub',{op:'openSession',id:sessionId},trainerCookies);
  assert.equal(started.status,200,await started.clone().text());
  const otherScan=await post('/api/hub',{op:'scanStudentQr',scheduleId:sessionId,payload:(await bootstrap(unrelatedCookies)).studentQr.payload},trainerCookies);
  assert.equal(otherScan.status,403);
  const wrongTrainer=await post('/api/hub',{op:'scanStudentQr',scheduleId:sessionId,payload:(await bootstrap(eligibleCookies)).studentQr.payload},privateTrainerCookies);
  assert.equal(wrongTrainer.status,403);
  const admitted=await post('/api/hub',{op:'scanStudentQr',scheduleId:sessionId,payload:(await bootstrap(eligibleCookies)).studentQr.payload},trainerCookies);
  assert.equal(admitted.status,200,await admitted.clone().text());
  const saved=sqlite.prepare("SELECT data FROM records WHERE kind='enrollments' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.batchId')=? AND json_extract(data,'$.status')='Active'").get(studentId,sharedId) as any;
  assert.ok(saved,'student seat must be assigned after scan');
  assert.equal(JSON.parse(saved.data).courseId,analytics,'shared batch enrollment must use the student parent course');
  const ongoing=sqlite.prepare("SELECT data FROM records WHERE id=?").get(`module-progress:${studentId}:${analyticsSql}`) as any;
  assert.equal(JSON.parse(ongoing.data).status,'Ongoing');
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM records WHERE id=?").get(`module-progress:${studentId}:${publicSubcourse}`)!.n,0);
  const trainerProgress = (await bootstrap(trainerCookies)).records.find((r:any)=>r.id===`module-progress:${studentId}:${analyticsSql}`);
  assert.equal(trainerProgress.data.status,'Ongoing');
  const studentView=await bootstrap(eligibleCookies);
  assert.ok(studentView.records.some((r:any)=>r.id===analytics && r.kind==='courses'));
  assert.ok(!studentView.records.some((r:any)=>r.id===course && r.kind==='courses'));
  const done=await post('/api/hub',{op:'completeModule',studentId,subcourseId:publicSubcourse,criteriaNote:'Successfully passed the shared SQL course examination.'},trainerCookies);
  assert.equal(done.status,200,await done.clone().text());
  assert.equal(JSON.parse((sqlite.prepare('SELECT data FROM records WHERE id=?').get(`module-progress:${studentId}:${analyticsSql}`) as any).data).status,'Completed');
  const remove=await post('/api/hub',{op:'update',kind:'batches',id:sharedId,data:{name:'SQL Shared Python and Analytics',courseId:course,courseIds:[course],subcourseId:publicSubcourse,trainerId:teacherId,branchId:branch1,startDate:'2026-01-01',capacity:3,status:'Active'}},ownerCookies);
  assert.equal(remove.status,409,'cannot remove a parent course with enrolled students');
});
await check('Server refuses expired QR payload and rotates it at next student refresh', async () => {
  const expiring = addUser('auth-expiry-student','expiry-student@example.test');
  await create('students',{name:'Expiry Student',email:expiring.email,studentId:'QREXPIRYONE',courseId:course,batchId:batch1,status:'Active'});
  const expiringCookies=await login(expiring);
  const opened = await schedule('Short QR expiry regression');
  assert.equal((await post('/api/hub',{op:'openSession',id:opened},trainerCookies)).status,200);
  const before=(await bootstrap(expiringCookies)).studentQr;
  const id=(await bootstrap(expiringCookies)).me.id;
  const row=sqlite.prepare("SELECT data FROM records WHERE id=? AND kind='student-qr'").get('student-qr:'+id) as any;
  const expired={...JSON.parse(row.data),expiresAt:new Date(Date.now()-1000).toISOString()};
  sqlite.prepare("UPDATE records SET data=? WHERE id=?").run(JSON.stringify(expired),'student-qr:'+id);
  const denied=await post('/api/hub',{op:'scanStudentQr',scheduleId:opened,payload:before.payload},trainerCookies);
  assert.equal(denied.status,410,await denied.clone().text());
  const after=(await bootstrap(expiringCookies)).studentQr;
  assert.notEqual(after.payload,before.payload);
  assert.ok(Date.parse(after.expiresAt)>Date.now());
});
await check('Multi-course students may send one leave request to Admin and multiple assigned trainers', async () => {
  // A Python student attends an additional Cloud course with a different trainer.
  // Earlier test cases intentionally deleted the original student account.
  const multiUser=addUser('auth-multi-leave-student','multi-leave-student@example.test');
  const multiStudentId=await create('students',{name:'Multi Course Learner',email:multiUser.email,studentId:'MULTI-LEAVE-ONE',courseId:course,batchId:batch1,status:'Active'});
  const multiStudentCookies=await login(multiUser);
  const invalid = await post('/api/hub',{op:'create',kind:'leaves',data:{
    fromDate:'2026-12-07',toDate:'2026-12-08',reason:'Medical leave',
    recipientId:teacherId,recipientIds:[teacherId,privateTeacherId,'admin']
  }},multiStudentCookies);
  assert.equal(invalid.status,403,'Cannot address a trainer of a course the student has not joined');
  await create('enrollments',{studentId:multiStudentId,courseId:protectedCourse,batchId:protectedBatch,status:'Active'});
  const requestData={fromDate:'2026-12-07',toDate:'2026-12-08',reason:'Medical leave',
    recipientId:teacherId,recipientIds:[teacherId,privateTeacherId,'admin']};
  const made=await post('/api/hub',{op:'create',kind:'leaves',data:requestData},multiStudentCookies);
  assert.equal(made.status,200,await made.clone().text());
  const id=(await made.json() as any).id;
  for(const cookie of [multiStudentCookies,trainerCookies,privateTrainerCookies,ownerCookies]){
    const record=(await bootstrap(cookie)).records.find((r:any)=>r.id===id);
    assert.ok(record,'Each selected party can view the request');
    assert.deepEqual(record.data.recipientIds,[teacherId,privateTeacherId,'admin']);
    assert.equal(record.data.status,'Pending');
  }
  const approved=await post('/api/hub',{op:'review',id,status:'Approved'},privateTrainerCookies);
  assert.equal(approved.status,200,await approved.clone().text());
  assert.equal((await bootstrap(multiStudentCookies)).records.find((r:any)=>r.id===id).data.reviewedByMemberId,privateTeacherId);
  assert.equal((await post('/api/hub',{op:'review',id,status:'Rejected'},trainerCookies)).status,409);
  assert.equal((await post('/api/hub',{op:'review',id,status:'Rejected'},ownerCookies)).status,409);
  const duplicated=await post('/api/hub',{op:'create',kind:'leaves',data:{...requestData,recipientIds:[teacherId,teacherId]}},multiStudentCookies);
  assert.equal(duplicated.status,400,'Duplicate recipients should be rejected');
  const mismatched=await post('/api/hub',{op:'create',kind:'leaves',data:{...requestData,recipientIds:['admin']}},multiStudentCookies);
  assert.equal(mismatched.status,400,'The legacy first recipient must belong to the selected list');
  const invalidList=await post('/api/hub',{op:'create',kind:'leaves',data:{...requestData,recipientIds:'admin'}},multiStudentCookies);
  assert.equal(invalidList.status,400,'Only arrays are accepted as multiple recipients');
});
console.log(passed + ' production API checks passed.');
sqlite.close();
