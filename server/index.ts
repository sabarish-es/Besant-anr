import { createHub, HubError, type Identity } from '../lib/hub-service';
import { createAuth, authConfigured, clearCookies } from './auth';
import type { AuthUser, Env } from './types';

function json(value: unknown, status = 200, cookies: string[] = []) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Frame-Options': 'DENY' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(JSON.stringify(value), { status, headers });
}

function identity(user: AuthUser): Identity {
  return { userId: user.id, email: user.email.toLowerCase(), displayName: typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name.slice(0, 100) : typeof user.user_metadata?.name === 'string' ? user.user_metadata.name.slice(0, 100) : user.email };
}

function writeOrigin(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HubError('This request must come from the institute portal.', 403);
  }
}

async function body(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HubError('Send a JSON request.', 415);
  if (Number(request.headers.get('content-length')) > 32000) throw new HubError('The request is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new HubError('Send a JSON request.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 32000) { await reader.cancel(); throw new HubError('The request is too large.', 413); }
    chunks.push(chunk.value);
  }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder().decode(joined));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, any>;
  } catch { throw new HubError('Invalid JSON request.'); }
}

function password(value: unknown, strong = false) {
  if (typeof value !== 'string' || value.length < (strong ? 12 : 1) || value.length > (strong ? 72 : 128) || strong && new TextEncoder().encode(value).byteLength > 72) {
    throw new HubError(strong ? 'Use a password or passphrase with at least 12 characters and at most 72 UTF-8 bytes.' : 'Enter your password.');
  }
  return value;
}

async function rate(db: D1Database, scope: string, value: string, limit: number, minutes: number) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope + ':' + value));
  const id = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const start = Math.floor(Date.now() / (minutes * 60000)) * minutes * 60000;
  const row = await db.prepare('INSERT INTO auth_rate_limits (id,window_start,attempts) VALUES (?,?,1) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN window_start=? THEN attempts+1 ELSE 1 END,window_start=? RETURNING attempts').bind(id, start, start, start).first<{ attempts: number }>();
  if (!row || row.attempts > limit) throw new HubError('Too many sign-in attempts. Try again later.', 429);
  await db.prepare('DELETE FROM auth_rate_limits WHERE window_start < ?').bind(Date.now() - 86400000).run();
}

async function mustChange(db: D1Database, userId: string) {
  const member = await db.prepare('SELECT data FROM members WHERE user_id = ?').bind(userId).first<{ data: string }>();
  return !!member && JSON.parse(member.data).mustChangePassword === true;
}

export function createWorker(send: typeof fetch = fetch) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'Not found.' }, 404);
      let cookies: string[] = [];
      try {
        if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new HubError('Use HTTPS to access this portal.', 400);
        const methods: Record<string, string[]> = {
          '/api/health': ['GET'], '/api/session': ['GET'], '/api/hub': ['GET', 'POST'], '/api/attendance': ['GET'],
          '/api/auth/login': ['POST'], '/api/auth/logout': ['POST'], '/api/auth/refresh': ['POST'],
          '/api/auth/password': ['POST'], '/api/accounts': ['POST'],
        };
        if (!methods[url.pathname]) return json({ error: 'Not found.' }, 404);
        if (!methods[url.pathname].includes(request.method)) {
          const response = json({ error: 'Method not allowed.' }, 405);
          response.headers.set('Allow', methods[url.pathname].join(', ')); return response;
        }
        if (url.pathname === '/api/health') return json({ ok: true, application: 'Besant StudentHub' });
        if (request.method === 'POST') writeOrigin(request);
        const auth = createAuth(env, send);
        if (url.pathname === '/api/auth/logout' && request.method === 'POST') return json({ ok: true }, 200, await auth.logout(request));
        if (!authConfigured(env)) {
          if (url.pathname === '/api/session' && request.method === 'GET') return json({ signedIn: false, displayName: '', authConfigured: false, passwordChangeRequired: false });
          throw new HubError('Sign-in is not configured. Contact your administrator.', 503);
        }
        if (!env.DB) throw new HubError('The institute database is unavailable.', 503);
        const hub = createHub(env.DB, { bootstrapAdminEmail: env.ADMIN_EMAIL });
        if (url.pathname === '/api/auth/login' && request.method === 'POST') {
          const input = await body(request);
          const identifier = String(input.identifier || input.email || '').trim().toLowerCase();
          if (!identifier || identifier.length > 254 || !/^[a-z0-9@._+-]+$/.test(identifier))
            throw new HubError('Enter a valid email or assigned student/trainer ID.');

          // Keep the role optional so existing API clients can continue to sign in.
          // Never trust a client-provided role as an authorization decision.
          const requestedRole = input.role;
          if (requestedRole !== undefined && !['admin', 'trainer', 'student'].includes(requestedRole)) {
            throw new HubError('Choose a valid account type (Admin, Trainer or Student).');
          }
          const ip = request.headers.get('cf-connecting-ip') || 'local';
          await rate(env.DB, 'ip', ip, 100, 1);
          await rate(env.DB, 'identifier', identifier, 10, 15);
          let email = identifier;
          if (!identifier.includes('@')) {
            const matched = await env.DB.prepare("SELECT email FROM members WHERE status='Active' AND role IN ('student','trainer') AND (lower(json_extract(data,'$.studentId'))=? OR lower(json_extract(data,'$.trainerId'))=?) LIMIT 2")
              .bind(identifier, identifier).all<{email:string}>();
            if (matched.results.length !== 1) throw new HubError('The email, ID or password is incorrect.', 401);
            email = matched.results[0].email;
          }
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HubError('The email, ID or password is incorrect.', 401);
          await rate(env.DB, 'email', email, 10, 15);
          const result = await auth.login(request, email, password(input.password));
          // Supabase verifies the password. D1 is the source of truth for roles.
          const workspace = await hub.bootstrap(identity(result.user!));
          const actualRole = workspace.needsSetup ? 'admin' : workspace.data?.me.role;
          if (requestedRole && actualRole !== requestedRole) {
            // No session cookies are issued when a user picks the wrong role.
            throw new HubError('This account is not registered as the selected role. Choose the correct login tab.', 403);
          }
          return json({ signedIn: true }, 200, result.cookies);
        }
        if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
          const result = await auth.refresh(request);
          await hub.bootstrap(identity(result.user!));
          return json({ ok: true }, 200, result.cookies);
        }
        const session = await auth.session(request, url.pathname === '/api/session');
        cookies = session.cookies;
        if (url.pathname === '/api/session' && request.method === 'GET') {
          if (session.user) await hub.bootstrap(identity(session.user));
          return json({ signedIn: !!session.user, displayName: session.user ? identity(session.user).displayName : '',
            authConfigured: true, passwordChangeRequired: session.user ? await mustChange(env.DB, session.user.id) : false }, 200, cookies);
        }
        if (!session.user) throw new HubError('Sign in to your institute account.', 401);
        const user = identity(session.user);
        if (url.pathname === '/api/auth/password' && request.method === 'POST') {
          await hub.bootstrap(user);
          const input = await body(request), current = password(input.currentPassword), next = password(input.newPassword, true);
          if (current === next) throw new HubError('Choose a different new password.');
          await rate(env.DB, 'password', user.userId, 10, 15);
          await auth.changePassword(request, current, next, user.userId);
          await env.DB.batch([
            env.DB.prepare("UPDATE members SET data=json_set(data,'$.mustChangePassword',json('false')) WHERE user_id=?").bind(user.userId),
            env.DB.prepare('INSERT INTO audits (id,actor,action,detail,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), user.displayName, 'Password changed', user.email, new Date().toISOString()),
          ]);
          return json({ ok: true }, 200, clearCookies(request));
        }
        if (await mustChange(env.DB, user.userId)) throw new HubError('Change your temporary password before using the portal.', 403);
        if (url.pathname === '/api/accounts' && request.method === 'POST') {
          const workspace = await hub.bootstrap(user);
          if (!workspace.data || workspace.data.me.role !== 'admin') throw new HubError('Only administrators can manage logins.', 403);
          const input = await body(request);
          if (input.action === 'forceDelete') {
            const id=String(input.memberId||'');
            const member=await env.DB.prepare("SELECT id,user_id,role FROM members WHERE id=? AND role IN ('student','trainer')").bind(id).first<{id:string;user_id:string|null;role:'student'|'trainer'}>();
            if (!member) throw new HubError('Student or trainer not found.',404);
            if (input.confirmation!=='DELETE ALL RELATED DATA') throw new HubError('Confirm the full cascade deletion.',400);
            // Revocation is privileged and server-side. In a rare provider/DB failure
            // reconcile Auth accounts against institute memberships before retrying.
            if(member.user_id) await auth.deleteMemberLogin(member.user_id);
            const result=await hub.cascadeDelete(user,member.role==='student'?'students':'trainers',id,input.confirmation);
            return json({ok:true,...result},200,cookies);
          }
          if (input.action === 'delete') {
            const member = await hub.checkPermanentMemberDeletion(user, String(input.memberId || ''));
            // Delete the provider login before removing the institute membership.
            // On an upstream error the institute record remains untouched.
            if (member.userId) await auth.deleteMemberLogin(member.userId);
            return json({ ok: true, ...await hub.permanentlyDeleteMember(user, member.id) }, 200, cookies);
          }
          const member = await env.DB.prepare("SELECT id,user_id,email,name,status,data,role FROM members WHERE id=? AND role IN ('trainer','student')").bind(String(input.memberId || '')).first<{ id: string; user_id: string | null; email: string; name: string; status: string; data: string; role: string }>();
          if (!member || member.status !== 'Active') throw new HubError('Choose an active trainer or student account.');
          // One-time credentials for the selected student's or trainer's assigned ID.
          // An ID can be used as the temporary password only if it meets the
          // Supabase password length rules. Otherwise, use a secure random fallback
          // so automatic account creation still works for short IDs.
          const memberData = JSON.parse(member.data) as Record<string, unknown>;
          const assignedId = member.role === 'student' ? memberData.studentId : memberData.trainerId;
          const loginId = typeof assignedId === 'string' ? assignedId.trim() : '';
          if (!loginId) throw new HubError('Assign a Student ID or Trainer ID before creating a login.', 400);

          const idBytes = new TextEncoder().encode(loginId).byteLength;
          const idMeetsPasswordLength = loginId.length >= 12 && loginId.length <= 72 && idBytes <= 72;
          const randomBytes = crypto.getRandomValues(new Uint8Array(18));
          const randomPassword = Array.from(randomBytes, b => b.toString(16).padStart(2, '0')).join('');
          const generated = idMeetsPasswordLength ? loginId : randomPassword;

          // Supabase stores the password. D1 stores only a change-required flag.
          const login = await auth.setMemberLogin(member, generated);
          await env.DB.batch([
            env.DB.prepare("UPDATE members SET user_id=?,data=json_set(data,'$.mustChangePassword',json('true')) WHERE id=?").bind(login.id, member.id),
            env.DB.prepare('INSERT INTO audits (id,actor,action,detail,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), workspace.data.me.name, 'Login managed', member.email, new Date().toISOString()),
          ]);
          return json({ ok: true, credential: { name: member.name, role: member.role,
            loginId, email: member.email, temporaryPassword: generated } }, 200, cookies);
        }
        if (url.pathname === '/api/attendance' && request.method === 'GET') return json(await hub.attendanceForDate(user, url.searchParams.get('date') || ''), 200, cookies);
        if (url.pathname === '/api/hub') {
          if (request.method === 'GET') return json(await hub.bootstrap(user), 200, cookies);
          return json(await hub.act(user, await body(request)), 200, cookies);
        }
        return json({ error: 'Not found.' }, 404, cookies);
      } catch (error) {
        if (error instanceof HubError) return json({ error: error.message }, error.status,
          error.status === 401 && url.pathname === '/api/auth/refresh' ? [...cookies, ...clearCookies(request)] : cookies);
        // Never log request bodies, passwords, cookies, Auth tokens, or service keys.
        const description = error instanceof Error ? error.message : 'Unknown database error';
        console.error('StudentHub API operation failed.');
        if (description.includes('UNIQUE constraint')) return json({ error: 'That account or attendance record already exists.' }, 409, cookies);
        return json({ error: 'Unable to load or save records. Check the database migrations and try again.' }, 503, cookies);
      }
    },
  };
}

export default {
  ...createWorker(),
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    if (env.DB) await createHub(env.DB).closeExpiredSessions();
  },
};
