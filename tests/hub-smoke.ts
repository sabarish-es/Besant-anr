import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { createHub, HubError } from '../lib/hub-service';
import { localInputToISO } from '../lib/hub-types';
import { dailyQrWindow } from '../lib/student-qr';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync('drizzle/0000_heavy_mathemanic.sql', 'utf8').replaceAll('--> statement-breakpoint', ''));
class Prepared {
  constructor(public sql: string, public args: any[] = []) {}
  bind(...args: any[]) { return new Prepared(this.sql, args); }
  async first() { return sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async run() { return { success: true, meta: sqlite.prepare(this.sql).run(...this.args) }; }
}
const db = { prepare: (s: string) => new Prepared(s), batch: async (statements: Prepared[]) => { sqlite.exec('BEGIN'); try { const out = []; for (const s of statements) out.push(await s.run()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } } as unknown as D1Database;
let time = Date.parse('2026-10-06T04:30:00Z'); // 10:00 IST; deterministic day rollover tests.
const hub = createHub(db, { now: () => time });
const owner = { userId: 'test-owner', email: 'owner@example.test', displayName: 'Institute Owner' }, trainer = { userId: 'test-trainer', email: 'trainer@example.test', displayName: 'Test Trainer' }, otherTrainer = { userId: 'test-trainer-2', email: 'trainer2@example.test', displayName: 'Other Trainer' }, student = { userId: 'test-student', email: 'student@example.test', displayName: 'Test Student' }, otherStudent = { userId: 'test-student-2', email: 'student2@example.test', displayName: 'Other Student' }, outsider = { userId: 'test-outsider', email: 'outsider@example.test', displayName: 'Unknown User' };
let passed = 0;
async function check(name: string, fn: () => any) { await fn(); passed++; console.log('PASS ' + name); }
async function rejects(fn: () => any, pattern: RegExp, status?: number) { await assert.rejects(fn, (e: any) => e instanceof HubError && pattern.test(e.message) && (!status || e.status === status)); }
async function create(kind: string, data: any, user = owner) { return (await hub.act(user, { op: 'create', kind, data })).id as string; }
const scan = (payload: string, scheduleId: string, user = trainer) => hub.act(user, { op: 'scanStudentQr', scheduleId, payload });

await check('Empty institute requires setup', async () => assert.equal((await hub.bootstrap(owner)).needsSetup, true));
await check('Owner initializes exactly one administrator', async () => assert.equal((await hub.act(owner, { op: 'setup', name: 'Test Institute' })).data.me.role, 'admin'));
await check('Another identity cannot make itself administrator', () => rejects(() => hub.act(outsider, { op: 'setup' }), /not been added/, 403));
await check('Branches need no GPS configuration', async () => assert.ok(await create('branches', { name: 'No GPS Branch', address: 'Center' })));
const branch = await create('branches', { name: 'Chennai', address: 'Teaching center', latitude: 13.0827, longitude: 80.2707, radius: 150 });
const course = await create('courses', { name: 'Python Full Stack', duration: 16, status: 'Active' });
const topicA = await create('subcourses', { courseId: course, name: 'Python', duration: 4, syllabus: 'Modules and exercises', status: 'Active' });
const teacher = await create('trainers', { name: 'Test Trainer', email: trainer.email, trainerId: 'TR-001', specialty: 'Python', status: 'Active' });
const teacher2 = await create('trainers', { name: 'Other Trainer', email: otherTrainer.email, trainerId: 'TR-002', specialty: 'Web', status: 'Active' });
const batch = await create('batches', { name: 'PY-01', courseId: course, subcourseId: topicA, trainerId: teacher, branchId: branch, startDate: '2026-10-01', status: 'Active' });
const batch2 = await create('batches', { name: 'PY-02', courseId: course, subcourseId: topicA, trainerId: teacher2, branchId: branch, startDate: '2026-10-01', status: 'Active' });
const pupil = await create('students', { name: 'Test Student', email: student.email, studentId: 'BST-PY-001', courseId: course, batchId: batch, status: 'Active' });
const pupil2 = await create('students', { name: 'Other Student', email: otherStudent.email, studentId: 'BST-PY-002', courseId: course, batchId: batch2, status: 'Active' });
const startAt = new Date(time - 60000).toISOString(), endAt = new Date(time + 3600000).toISOString();
const session = await create('schedules', { name: 'Django APIs', batchId: batch, startAt, endAt, mode: 'In person' });
const second = await create('schedules', { name: 'Python practice', batchId: batch, startAt, endAt, mode: 'In person' });
let payload = (await hub.bootstrap(student)).data!.studentQr!.payload;
const otherPayload = (await hub.bootstrap(otherStudent)).data!.studentQr!.payload;
await check('First sign-in binds the invited email to a stable identity', async () => assert.equal((await hub.bootstrap(student)).data!.me.userId, student.userId));
await check('Every student gets a different personal QR', () => { assert.match(payload, /^BSQ1:2026-10-06:[a-f0-9]{64}$/); assert.notEqual(payload, otherPayload); });
await check('Reloading on the same day keeps the QR stable', async () => assert.equal((await hub.bootstrap(student)).data!.studentQr!.payload, payload));
await check('Trainer reads never expose student QR tokens', async () => { const value = (await hub.bootstrap(trainer)).data!; assert.equal(value.studentQr, null); assert.ok(!JSON.stringify(value).includes(payload.split(':')[2])); assert.ok(value.records.every(r => r.kind !== 'student-qr')); });
await check('Student reads reveal no other student QR or attendance', async () => { const value = (await hub.bootstrap(student)).data!; assert.deepEqual(value.members.filter(m => m.role === 'student').map(m => m.id), [pupil]); assert.ok(!JSON.stringify(value).includes(otherPayload.split(':')[2])); });
await check('QR contains no student email or ID', () => { assert.ok(!payload.includes(student.email)); assert.ok(!payload.includes(pupil)); });
await check('Generated QR pixels decode using the camera decoder', () => {
  const code = QRCode.create(payload, { errorCorrectionLevel: 'M' }), scale = 8, margin = 4, size = (code.modules.size + margin * 2) * scale, pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const row = Math.floor(y / scale) - margin, col = Math.floor(x / scale) - margin, dark = row >= 0 && col >= 0 && row < code.modules.size && col < code.modules.size && code.modules.get(row, col); const index = (y * size + x) * 4, value = dark ? 0 : 255; pixels[index] = pixels[index + 1] = pixels[index + 2] = value; pixels[index + 3] = 255; }
  assert.equal(jsQR(pixels, size, size)!.data, payload);
});
await check('Student cannot scan QR attendance', () => rejects(() => scan(payload, session, student), /Only a trainer/, 403));
await check('Legacy student self check-in is disabled', () => rejects(() => hub.act(student, { op: 'checkin', code: 'OLDCLASS' }), /self check-in is disabled/, 403));
await check('Unassigned trainers cannot scan the class', () => rejects(() => scan(payload, session, otherTrainer), /assigned batches/, 403));
await check('Closed class cannot accept QR attendance', () => rejects(() => scan(payload, session), /Start attendance/));
await hub.act(trainer, { op: 'openSession', id: session });
await hub.act(trainer, { op: 'openSession', id: second });
await check('Class no longer generates shared QR secrets', async () => { const value = (await hub.bootstrap(trainer)).data!.records.find(r => r.id === session)!; assert.equal(value.data.code, undefined); assert.equal(value.data.token, undefined); });
await check('Retired GPS action is no longer supported', () => rejects(() => hub.act(trainer, { op: 'verifyTrainerLocation', scheduleId: session }), /Unknown action/, 400));
await check('Malformed QR is rejected', () => rejects(() => scan('untrusted', session), /not a valid/));
await check('Unknown QR token is rejected', () => rejects(() => scan('BSQ1:2026-10-06:' + '0'.repeat(64), session), /invalid or has been replaced/, 404));
await check('Student cannot join another batch teaching the same subject', () => rejects(() => scan(otherPayload, session), /Already assigned to another batch teaching this subject/, 409));
await check('Valid scan automatically saves Present without GPS', async () => { const value = await scan(payload, session); assert.equal(value.alreadyRecorded, false); assert.equal(value.status, 'Present'); assert.equal(value.student.id, pupil); assert.equal(value.data.attendance[0].method, 'Trainer QR scan'); });
const firstCheckIn = sqlite.prepare('SELECT checked_in FROM attendance WHERE schedule_id = ?').get(session)!.checked_in;
await check('Repeat scan keeps one entry and original check-in time', async () => { time += 1000; const value = await scan(payload, session); assert.equal(value.alreadyRecorded, true); assert.equal(value.checkedIn, firstCheckIn); assert.equal(sqlite.prepare('SELECT count(*) AS n FROM attendance WHERE schedule_id = ?').get(session)!.n, 1); });
await check('Concurrent scans from separate requests save exactly one entry', async () => { const values = await Promise.all(Array.from({ length: 12 }, () => scan(payload, second))); assert.equal(values.filter(v => !v.alreadyRecorded).length, 1); assert.equal(sqlite.prepare('SELECT count(*) AS n FROM attendance WHERE schedule_id = ?').get(second)!.n, 1); });
await check('Same daily QR can attend a different class', async () => { const rows = (await hub.bootstrap(student)).data!.attendance; assert.equal(rows.length, 2); });
await check('Duplicate scans add no duplicate audit events', () => assert.equal(sqlite.prepare("SELECT count(*) AS n FROM audits WHERE action = 'Student QR scanned'").get()!.n, 2));
await check('Late arrivals are marked Late automatically', async () => { const lateClass = await create('schedules', { name: 'Late arrival test', batchId: batch, startAt: new Date(time - 16 * 60000).toISOString(), endAt: new Date(time + 3600000).toISOString(), mode: 'In person' }); await hub.act(trainer, { op: 'openSession', id: lateClass }); assert.equal((await scan(payload, lateClass)).status, 'Late'); });
await check('Trainer cannot bypass QR with a manual Present mark', () => rejects(() => hub.act(trainer, { op: 'mark', scheduleId: session, memberId: pupil, status: 'Present', note: 'attempt' }), /Scan the student QR/, 403));
await check('Manual administrator corrections still require an audit reason', () => rejects(() => hub.act(owner, { op: 'mark', scheduleId: session, memberId: pupil, status: 'Late' }), /reason/));
await check('Class with attendance cannot be deleted', () => rejects(() => hub.act(owner, { op: 'delete', id: session, kind: 'schedules' }), /kept for reporting/));
await check('Student can check out after trainer scan', async () => { await hub.act(student, { op: 'checkout', id: session }); assert.ok((await hub.bootstrap(student)).data!.attendance.find(a => a.scheduleId === session)!.checkedOut); });
await check('Rescan does not erase a saved check-out', async () => { const value = await scan(payload, session); assert.equal(value.alreadyRecorded, true); assert.ok(value.data.attendance.find((a: any) => a.scheduleId === session).checkedOut); });
await check('Students submit leave and their selected trainer reviews it', async () => { const id = await create('leaves', { fromDate: '2026-10-10', toDate: '2026-10-11', reason: 'Appointment', recipientId: teacher }, student); const value = await hub.act(trainer, { op: 'review', id, status: 'Approved' }); assert.equal(value.data.records.find((r: any) => r.id === id)!.data.status, 'Approved'); });
await check('A student cannot approve their own leave', async () => { const id = await create('leaves', { fromDate: '2026-10-12', toDate: '2026-10-12', reason: 'Appointment', recipientId: 'admin' }, student); await rejects(() => hub.act(student, { op: 'review', id, status: 'Approved' }), /administrator/, 403); });
await check('Midnight expiry follows IST rather than UTC', () => { const before = dailyQrWindow(Date.parse('2026-10-06T18:29:59Z'), 'Asia/Kolkata'); const after = dailyQrWindow(Date.parse('2026-10-06T18:30:00Z'), 'Asia/Kolkata'); assert.equal(before.day, '2026-10-06'); assert.equal(before.expiresAt, '2026-10-06T18:30:00.000Z'); assert.equal(after.day, '2026-10-07'); });
time = Date.parse('2026-10-06T18:29:59Z');
const beforeMidnight = (await hub.bootstrap(student)).data!.studentQr!.payload;
let releaseOldQr!: () => void, oldQrEntered!: () => void;
const oldQrBarrier = new Promise<void>(resolve => { releaseOldQr = resolve; });
const oldQrReady = new Promise<void>(resolve => { oldQrEntered = resolve; });
const delayedDb = { ...db, prepare(sql: string) {
  const initial = db.prepare(sql) as unknown as Prepared;
  function wrapped(statement: Prepared): any { return { bind: (...args: any[]) => wrapped(statement.bind(...args)), first: () => statement.first(), all: () => statement.all(), run: async () => { if (sql.startsWith('INSERT INTO records') && sql.includes("'student-qr'")) { oldQrEntered(); await oldQrBarrier; } return statement.run(); } }; }
  return wrapped(initial);
} } as unknown as D1Database;
const delayedReload = createHub(delayedDb, { now: () => time }).bootstrap(student);
await oldQrReady;
time = Date.parse('2026-10-06T18:30:00Z');
const nextSession = await create('schedules', { name: 'Next day class', batchId: batch, startAt: new Date(time).toISOString(), endAt: new Date(time + 3600000).toISOString(), mode: 'In person' });
await hub.act(trainer, { op: 'openSession', id: nextSession });
await check('Yesterday’s QR is invalid immediately at midnight without student reload', () => rejects(() => scan(beforeMidnight, nextSession), /expired/, 410));
payload = (await hub.bootstrap(student)).data!.studentQr!.payload;
releaseOldQr();
const delayedResult = await delayedReload;
await check('Delayed pre-midnight reload cannot overwrite the new day QR', () => { assert.equal(delayedResult.data!.studentQr!.payload, payload); assert.equal(delayedResult.data!.studentQr!.day, '2026-10-07'); assert.equal(delayedResult.data!.studentQr!.expiresAt, '2026-10-06T18:35:00.000Z'); });
await check('Student QR rotates automatically on a new institute day', () => { assert.notEqual(payload, beforeMidnight); assert.match(payload, /^BSQ1:2026-10-07:/); });
await check('Changing yesterday’s QR date cannot forge today’s QR', () => rejects(() => scan(beforeMidnight.replace('2026-10-06', '2026-10-07'), nextSession), /invalid or has been replaced/, 404));
await check('Today’s refreshed QR works for the new class', async () => assert.equal((await scan(payload, nextSession)).alreadyRecorded, false));
const closed = await create('schedules', { name: 'Outside class time', batchId: batch, startAt: new Date(time - 7200000).toISOString(), endAt: new Date(time - 3600000).toISOString(), mode: 'In person' });
await check('Scan outside class time is rejected', () => rejects(() => scan(payload, closed), /until class ends/));
await check('Changing batches preserves historic class attendance', async () => { await hub.act(owner, { op: 'update', kind: 'students', id: pupil, data: { name: 'Test Student', email: student.email, studentId: 'BST-PY-001', courseId: course, batchId: batch2, status: 'Active' } }); assert.ok((await hub.bootstrap(student)).data!.attendance.find(a => a.scheduleId === session)); });
await check('Inactive student QR cannot mark attendance', async () => { await hub.act(owner, { op: 'delete', kind: 'students', id: pupil }); await rejects(() => scan(payload, nextSession), /inactive/, 403); await rejects(() => hub.bootstrap(student), /inactive/, 403); });
await check('Deactivation keeps attendance history', () => assert.equal(sqlite.prepare('SELECT count(*) AS n FROM attendance WHERE member_id = ?').get(pupil)!.n, 4));
await check('IST form conversion is correct', () => assert.equal(localInputToISO('2026-10-06T10:00', 'Asia/Kolkata'), '2026-10-06T04:30:00.000Z'));


// Regression: role-restricted course catalog, nested modules, and multi-course enrollment.
const otherCourse = await create('courses', { name: 'Cloud Foundations', duration: 10, status: 'Active' });
const topicB = await create('subcourses', { courseId: otherCourse, name: 'Cloud Basics', duration: 2, status: 'Active' });
const thirdBatch = await create('batches', { name: 'CLOUD-01', courseId: otherCourse, subcourseId: topicB, trainerId: teacher2, branchId: branch, startDate: '2026-10-01', status: 'Active' });
const extraUser = { userId: 'course-only-student', email: 'course-only@example.test', displayName: 'Cloud Student' };
const extraStudent = await create('students', { name: 'Cloud Student', email: extraUser.email, studentId: 'CLOUD001', courseId: otherCourse, batchId: thirdBatch, status: 'Active' });
const unbatchedUser = { userId: 'not-yet-batched', email: 'not-yet-batched@example.test', displayName: 'New Student' };
const unbatchedId = await create('students', { name: 'New Student', email: unbatchedUser.email, studentId: 'NEWBATCHLESS1', courseId: otherCourse, status: 'Active' });
await check('A course-only student sees their course and modules without any batch access', async () => {
  const workspace = (await hub.bootstrap(unbatchedUser)).data!;
  assert.deepEqual(workspace.records.filter(r => r.kind === 'courses').map(r => r.id), [otherCourse]);
  assert.ok(workspace.records.some(r => r.id === topicB));
  assert.equal(workspace.records.filter(r => r.kind === 'batches').length, 0);
  assert.equal(workspace.records.filter(r => r.kind === 'schedules').length, 0);
  assert.equal((await hub.bootstrap(trainer)).data!.members.some(m => m.id === unbatchedId), false);
});
await check('Admin can assign a course-only student to a matching batch', async () => {
  await hub.act(owner, { op: 'update', kind: 'students', id: unbatchedId, data: {
    name: 'New Student', email: unbatchedUser.email, studentId: 'NEWBATCHLESS1', courseId: otherCourse, batchId: thirdBatch, status: 'Active'
  }});
  const workspace=(await hub.bootstrap(unbatchedUser)).data!;
  assert.ok(workspace.records.some(r => r.id === thirdBatch));
});
await check('A course-only student cannot be assigned to a batch from another course', async () => {
  await rejects(() => hub.act(owner, {op:'update',kind:'students',id:unbatchedId,data:{
    name:'New Student',email:unbatchedUser.email,studentId:'NEWBATCHLESS1',courseId:otherCourse,batchId:batch,status:'Active'
  }}),/batch must belong to the selected course/);
});
await check('Course and subcourse names are unique in their respective scopes', async () => {
  await rejects(() => create('courses', { name: 'cloud foundations', duration: 8 }), /already exists/);
  await rejects(() => create('subcourses', { courseId: course, name: 'python', duration: 3 }), /already exists/);
  assert.ok(await create('subcourses', { courseId: otherCourse, name: 'Python', duration: 3 }));
});
await check('Non-admins cannot create, update or delete subcourses', async () => {
  await rejects(() => create('subcourses', { courseId: course, name: 'Hacked', duration: 1 }, trainer), /administrators/, 403);
  await rejects(() => hub.act(extraUser, { op: 'update', kind: 'subcourses', id: topicB, data: { courseId: otherCourse, name: 'Hacked', duration: 2 } }), /administrators/, 403);
  await rejects(() => hub.act(otherTrainer, { op: 'delete', kind: 'subcourses', id: topicB }), /administrators/, 403);
});
await check('Trainer sees only assigned courses, batches, subcourses and student data', async () => {
  const result = (await hub.bootstrap(trainer)).data!;
  assert.deepEqual(result.records.filter(r => r.kind === 'courses').map(r => r.id), [course]);
  assert.ok(result.records.some(r => r.id === topicA));
  assert.ok(!result.records.some(r => r.id === topicB || r.id === otherCourse || r.id === thirdBatch));
  assert.ok(!result.members.some(m => m.id === extraStudent));
});
await check('Student sees enrolled modules and safe same-batch classmates', async () => {
  const result = (await hub.bootstrap(extraUser)).data!;
  assert.deepEqual(result.records.filter(r => r.kind === 'courses').map(r => r.id), [otherCourse]);
  assert.ok(result.records.some(r => r.id === topicB));
  assert.ok(!result.records.some(r => r.id === topicA || r.id === course));
  // Students can see academic batchmates, but never their private contacts or tokens.
  assert.deepEqual(new Set(result.members.filter(m => m.role === 'student').map(m => m.id)), new Set([extraStudent, unbatchedId]));
  const batchmate = result.members.find(m => m.id === unbatchedId)!;
  assert.equal(batchmate.email, '');
  assert.equal(batchmate.userId, null);
  assert.equal(batchmate.data.phone, undefined);
  assert.ok(!result.members.some(m => m.id === pupil2));
});
const additionalEnrollment = await create('enrollments', { studentId: extraStudent, courseId: course, batchId: batch, status: 'Active' });
await check('Additional enrollment grants student and trainer access only to its batch', async () => {
  const studentWorkspace = (await hub.bootstrap(extraUser)).data!;
  assert.ok(studentWorkspace.records.some(r => r.id === course && r.kind === 'courses'));
  assert.ok(studentWorkspace.records.some(r => r.id === topicA));
  assert.ok(studentWorkspace.records.some(r => r.id === additionalEnrollment));
  assert.ok((await hub.bootstrap(trainer)).data!.members.some(m => m.id === extraStudent));
});
await check('Course deletion is denied while referenced by batch and module', async () => {
  await rejects(() => hub.act(owner, { op: 'delete', kind: 'courses', id: otherCourse }), /still in use/);
  await rejects(() => create('enrollments', { studentId: extraStudent, courseId: course, batchId: batch, status: 'Active' }), /already has this course\/batch enrollment/);
  await rejects(() => hub.act(owner, { op: 'update', kind: 'enrollments', id: additionalEnrollment, data: { studentId: extraStudent, courseId: otherCourse, batchId: batch, status: 'Active' } }), /Existing enrollment links cannot be reassigned/);
});
await check('Enrollment status controls course visibility on every read', async () => {
  await hub.act(owner, { op: 'update', kind: 'enrollments', id: additionalEnrollment, data: { studentId: extraStudent, courseId: course, batchId: batch, status: 'Inactive' } });
  const result = (await hub.bootstrap(extraUser)).data!;
  assert.ok(!result.records.some(r => r.id === topicA || r.id === course));
});

console.log(`${passed} institute workflow checks passed.`);
sqlite.close();
