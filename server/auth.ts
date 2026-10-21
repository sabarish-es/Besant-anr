import { HubError } from '../lib/hub-service';
import type { AuthUser, Env, Session } from './types';

type Fetch = typeof fetch;
type Tokens = { access_token: string; refresh_token: string; expires_in: number; user: AuthUser };

export function authConfigured(env: Env) {
  try {
    const url = new URL(env.SUPABASE_URL);
    return url.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) &&
      !url.username && !url.password && !!env.SUPABASE_PUBLISHABLE_KEY &&
      env.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_') && !env.SUPABASE_PUBLISHABLE_KEY.includes('REPLACE') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ADMIN_EMAIL || '');
  } catch { return false; }
}

const names = (request: Request) => new URL(request.url).protocol === 'https:'
  ? ['__Host-besant_access', '__Host-besant_refresh']
  : ['besant_access', 'besant_refresh'];

function cookie(request: Request, name: string) {
  const value = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1);
  if (!value || value.length > 16000 || !/^[A-Za-z0-9_.~-]+$/.test(value)) return null;
  return value;
}

function cookieValue(request: Request, name: string, value: string, age: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

export function clearCookies(request: Request) {
  return names(request).map(name => cookieValue(request, name, '', 0));
}

function validUser(value: unknown): value is AuthUser {
  const user = value as AuthUser;
  return !!user && typeof user.id === 'string' && user.id.length > 0 && typeof user.email === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) && typeof user.email_confirmed_at === 'string' && !!user.email_confirmed_at;
}

function tokens(request: Request, value: Tokens): Session {
  if (!validUser(value.user) || typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string' ||
      !/^[A-Za-z0-9_.~-]+$/.test(value.access_token) || !/^[A-Za-z0-9_.~-]+$/.test(value.refresh_token)) {
    throw new HubError('The sign-in service returned an invalid session.', 503);
  }
  const age = Math.max(60, Math.min(3600, Number(value.expires_in) || 3600));
  return { user: value.user, cookies: [
    cookieValue(request, names(request)[0], value.access_token, age),
    cookieValue(request, names(request)[1], value.refresh_token, 7 * 86400),
  ] };
}

export function createAuth(env: Env, send: Fetch = fetch) {
  function configured() {
    if (!authConfigured(env)) throw new HubError('Sign-in is not configured. Contact your administrator.', 503);
  }

  async function call(path: string, init: RequestInit = {}, admin = false) {
    configured();
    const key = admin ? env.SUPABASE_SECRET_KEY : env.SUPABASE_PUBLISHABLE_KEY;
    if (!key || key.includes('REPLACE')) throw new HubError('Login management is not configured. Contact your administrator.', 503);
    const headers = new Headers(init.headers);
    headers.set('apikey', key);
    if (admin) {
      // New sb_secret keys are API keys, not JWTs. Supabase's gateway
      // authorizes the server-side admin request from the apikey header.
      if (!key.startsWith('sb_secret_')) throw new HubError('Set a Supabase secret key for login management.', 503);
      headers.delete('Authorization');
    }
    if (init.body) headers.set('Content-Type', 'application/json');
    try {
      const response = await send(new URL('/auth/v1/' + path, env.SUPABASE_URL).href, {
        ...init, headers, signal: AbortSignal.timeout(15000), redirect: 'manual',
      });
      // Do not follow redirects that could transmit API headers to another origin.
      if (response.status >= 300 && response.status < 400) {
        console.warn('SUPABASE_AUTH_UNEXPECTED_REDIRECT', { operation: admin ? 'admin' : 'user', status: response.status });
        throw new HubError('Authentication endpoint returned an unexpected redirect.', 503);
      }
      if (response.status >= 500) console.warn('SUPABASE_AUTH_UPSTREAM_ERROR', { status: response.status, operation: admin ? 'admin' : 'user' });
      return response;
    } catch (error) {
      if (error instanceof HubError) throw error;
      console.warn('SUPABASE_AUTH_CONNECTION_ERROR', {
        category: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network-or-tls',
        operation: admin ? 'admin' : 'user',
      });
      throw new HubError('The sign-in service is unavailable. Try again shortly.', 503);
    }
  }

  async function exchange(request: Request, type: 'password' | 'refresh_token', body: unknown) {
    const response = await call(`token?grant_type=${type}`, { method: 'POST', body: JSON.stringify(body) });
    if (response.status === 429) throw new HubError('Too many sign-in attempts. Try again later.', 429);
    if (!response.ok) {
      if (response.status >= 500) throw new HubError('The sign-in service is unavailable. Try again shortly.', 503);
      throw new HubError(type === 'password' ? 'The email or password is incorrect.' : 'Your session expired. Sign in again.', 401);
    }
    return tokens(request, await response.json() as Tokens);
  }

  async function session(request: Request, allowRefresh = false): Promise<Session> {
    configured();
    const access = cookie(request, names(request)[0]);
    if (access) {
      const response = await call('user', { headers: { Authorization: `Bearer ${access}` } });
      if (response.status === 429 || response.status >= 500) throw new HubError('The sign-in service is unavailable. Try again shortly.', 503);
      if (response.ok) {
        const user = await response.json();
        if (validUser(user)) return { user, cookies: [] };
      }
    }
    if (allowRefresh && cookie(request, names(request)[1])) {
      try { return await refresh(request); }
      catch (error) {
        if (error instanceof HubError && error.status === 401) return { user: null, cookies: clearCookies(request) };
        throw error;
      }
    }
    return { user: null, cookies: [] };
  }

  async function refresh(request: Request) {
    const refreshToken = cookie(request, names(request)[1]);
    if (!refreshToken) throw new HubError('Sign in to your institute account.', 401);
    return exchange(request, 'refresh_token', { refresh_token: refreshToken });
  }

  async function logout(request: Request) {
    const access = cookie(request, names(request)[0]);
    if (access) {
      try { await call('logout?scope=local', { method: 'POST', headers: { Authorization: `Bearer ${access}` } }); }
      catch { /* Local cookies must still be cleared during an upstream outage. */ }
    }
    return clearCookies(request);
  }

  async function setMemberLogin(member: { email: string; name: string; user_id: string | null }, password: string) {
    const path = member.user_id ? `admin/users/${encodeURIComponent(member.user_id)}` : 'admin/users';
    const response = await call(path, {
      method: member.user_id ? 'PUT' : 'POST',
      body: JSON.stringify({ email: member.email, password, email_confirm: true, user_metadata: { full_name: member.name } }),
    }, true);
    if (!response.ok) {
      if ([409, 422].includes(response.status)) throw new HubError('A login may already exist for this email. Sign in with its existing password, or manage it in Supabase Authentication.', 409);
      throw new HubError('Unable to save the login. Check the authentication configuration.', 503);
    }
    const value = await response.json() as AuthUser | { user: AuthUser };
    const user = 'user' in value ? value.user : value;
    if (!validUser(user) || user.email.toLowerCase() !== member.email.toLowerCase()) throw new HubError('The login service returned an invalid account.', 503);
    return user;
  }

  // Privileged, server-side action: never expose the secret key to the browser.
  async function deleteMemberLogin(userId: string) {
    const response = await call(`admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }, true);
    if (response.status === 404) return; // Already deleted on the provider.
    if (!response.ok) throw new HubError('Unable to remove the Supabase login. The StudentHub account was not deleted.', 503);
  }

  async function changePassword(request: Request, current: string, next: string, userId: string) {
    const currentSession = await session(request);
    if (!currentSession.user) throw new HubError('Sign in again before changing your password.', 401);
    const verified = await exchange(request, 'password', { email: currentSession.user.email, password: current });
    if (verified.user?.id !== userId) throw new HubError('Unable to verify this account.', 403);
    const access = verified.cookies[0].split(';')[0].split('=').slice(1).join('=');
    const response = await call('user', { method: 'PUT', headers: { Authorization: `Bearer ${access}` }, body: JSON.stringify({ password: next, current_password: current }) });
    if (!response.ok) throw new HubError('Unable to change the password. Try a different strong password.', response.status >= 500 ? 503 : 400);
    // End the newly verified session as well as the browser's old session.
    try { await call('logout?scope=global', { method: 'POST', headers: { Authorization: `Bearer ${access}` } }); }
    catch { /* Updating the password already invalidates refresh sessions. */ }
  }

  return { session, refresh, logout, setMemberLogin, deleteMemberLogin, changePassword,
    login: (request: Request, email: string, password: string) => exchange(request, 'password', { email, password }),
  };
}
