import { lazy, Suspense, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SignIn } from '@/components/sign-in';
import { PasswordForm } from '@/components/password-form';
import { NotFoundPage } from '@/pages/not-found';
import { apiErrorMessage, apiFetch, apiPost, readApiJson } from '@/lib/api';
import { WorkspaceErrorBoundary } from '@/components/workspace-error-boundary';
type Session = { signedIn: boolean; displayName: string; authConfigured: boolean; passwordChangeRequired: boolean };
const Hub = lazy(() => import('@/pages/hub').then(module => ({ default: module.Hub })));
function AuthenticatedApp() {
  const [session, setSession] = useState<Session | null>(null), [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0), [notice, setNotice] = useState(''), [changingPassword, setChangingPassword] = useState(false);
  const signOut = async () => {
    try { await apiPost('/api/auth/logout', {}); setSession(value => value ? { ...value, signedIn: false, passwordChangeRequired: false } : null); setChangingPassword(false); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to sign out.'); }
  };
  useEffect(() => {
    const expired = () => { setSession(value => value ? { ...value, signedIn: false, passwordChangeRequired: false } : null); setChangingPassword(false); setNotice('Your session expired. Sign in again.'); };
    window.addEventListener('hub:unauthorized', expired);
    return () => window.removeEventListener('hub:unauthorized', expired);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    async function loadSession() {
      try {
        const response = await apiFetch('/api/session', { signal: controller.signal });
        const value = await readApiJson(response);
        if (!response.ok) {
          if ([401, 403].includes(response.status)) {
            // Session rejection must still show the sign-in screen if logout fails.
            try { await apiPost('/api/auth/logout', {}); } catch { /* already signed out or offline */ }
            if (!controller.signal.aborted) { setSession({ signedIn: false, displayName: '', authConfigured: true, passwordChangeRequired: false }); setNotice(apiErrorMessage(value, 'Please sign in again.')); }
            return;
          }
          throw new Error(apiErrorMessage(value, 'The portal is unavailable.'));
        }
        if (typeof value.signedIn !== 'boolean' || typeof value.authConfigured !== 'boolean' || typeof value.displayName !== 'string') throw new Error('The portal returned an invalid response.');
        if (!controller.signal.aborted) setSession(value);
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to connect.'); }
    }
    void loadSession(); return () => controller.abort();
  }, [attempt]);
  if (!session) return <main className="app-connection" aria-busy={!error}><section className="app-connection-card"><div className="app-connection-logo"><img src="/besant-mark.png" alt="Besant Technologies" /></div><span className="eyebrow">BESANT STUDENTHUB</span><h1>{error ? 'Unable to connect' : 'Opening your workspace'}</h1>{error ? <><p role="alert">{error}</p><Button onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} />Retry connection</Button></> : <p role="status"><Loader2 size={18} className="animate-spin" />Loading your account…</p>}</section></main>;
  if (!session.signedIn) return <SignIn configured={session.authConfigured} notice={notice || error} onSuccess={() => { setNotice(''); setSession(null); setAttempt(value => value + 1); }} />;
  if (session.passwordChangeRequired || changingPassword) return <PasswordForm required={session.passwordChangeRequired} onSuccess={() => { setNotice('Password updated. Sign in with your new password.'); setChangingPassword(false); setSession({ ...session, signedIn: false, passwordChangeRequired: false }); }} onCancel={() => { if (session.passwordChangeRequired) void signOut(); else setChangingPassword(false); }} />;
  return <><WorkspaceErrorBoundary><Suspense fallback={<main className="app-connection" role="status"><Loader2 className="animate-spin" size={24} />Opening your dashboard…</main>}><Hub signedIn displayName={session.displayName} onSignOut={() => void signOut()} onPasswordChange={() => setChangingPassword(true)} /></Suspense></WorkspaceErrorBoundary>{error && <div className="global-auth-error" role="alert">{error}</div>}</>;
}

// The deployed Worker serves /404.html with HTTP 404. Vite dev falls back
// to index.html, so client-side navigation must enforce the same route rule.
export function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onLocationChange = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onLocationChange);
    return () => window.removeEventListener('popstate', onLocationChange);
  }, []);
  return path === '/' || path === '/index.html' ? <AuthenticatedApp/> : <NotFoundPage/>;
}
