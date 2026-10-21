import { useState } from 'react';
import { ShieldCheck, LockKeyhole, QrCode, Clock, Radio, Loader2, UsersRound, BookOpen } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { apiPost } from '@/lib/api';

type LoginRole = 'admin' | 'trainer' | 'student';

const roleDescriptions: Record<LoginRole, string> = {
  admin: 'Manage your institute, branches, batches, staff and student accounts.',
  trainer: 'Open your assigned classes, scan student QR codes and review attendance.',
  student: 'See your class schedule, daily QR code and attendance record.',
};

function roleFromUrl(): LoginRole {
  const value = new URLSearchParams(window.location.search).get('role');
  return value === 'trainer' || value === 'student' ? value : 'admin';
}

export function SignIn({ configured, notice, onSuccess }: { configured: boolean; notice: string; onSuccess: () => void }) {
  const [role, setRole] = useState<LoginRole>(roleFromUrl);
  const [identifier, setIdentifier] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');

  function selectRole(value: string) {
    if (value !== 'admin' && value !== 'trainer' && value !== 'student') return;
    setRole(value);
    setPassword('');
    setError('');
    // This URL allows institutes to share a direct link to each sign-in tab.
    const address = new URL(window.location.href);
    address.searchParams.set('role', value);
    window.history.replaceState(null, '', address.pathname + address.search + address.hash);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      // The server checks the selected role against the verified D1 membership.
      // A tab selection does NOT confer additional access rights.
      await apiPost('/api/auth/login', { identifier: identifier.trim(), password, role });
      setPassword('');
      onSuccess();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-page">
    <div className="login-copy">
      <div className="brand on-dark"><div className="brand-mark brand-mark-full"><img src="/besant-technologies-logo.png" alt="Besant Technologies" /></div><div><strong><em>StudentHub</em></strong><small>LEARN. TRACK. GROW.</small></div></div>
      <div className="login-story"><span className="eyebrow"><ShieldCheck size={15} /> Attendance & class management</span>
        <h1>Empowering skills.<br /><span>Building careers.</span></h1>
        <p>Keep every class connected. Personal daily QR codes, trainer scanning, schedules, and attendance reports in one institute portal.</p>
        <div className="feature-chips"><span><QrCode size={15} />Daily student QR</span><span><Radio size={15} />Live attendance</span><span><ShieldCheck size={15} />Secure accounts</span><span><Clock size={15} />Auto checkout</span></div>
        <div className="login-rule" /><div className="login-trust"><LockKeyhole size={19} /><div><strong>Your role. Your workspace.</strong><p>Access is assigned by your institute administrator.</p></div></div>
      </div><footer>StudentHub · Institute management</footer>
    </div>
    <div className="login-right"><section className="login-card"><div className="card-icon"><img src="/besant-mark.png" alt="Besant Technologies" /></div>
      <h2>Welcome back</h2><p className="muted">Choose your login and enter your institute credentials.</p>
      <Tabs className="login-roles" value={role} onValueChange={selectRole}>
        <TabsList aria-label="Choose your account type">
          <TabsTrigger value="admin" disabled={busy}><ShieldCheck size={16} />Admin</TabsTrigger>
          <TabsTrigger value="trainer" disabled={busy}><UsersRound size={16} />Trainer</TabsTrigger>
          <TabsTrigger value="student" disabled={busy}><BookOpen size={16} />Student</TabsTrigger>
        </TabsList>
        <TabsContent value="admin">{roleDescriptions.admin}</TabsContent>
        <TabsContent value="trainer">{roleDescriptions.trainer}</TabsContent>
        <TabsContent value="student">{roleDescriptions.student}</TabsContent>
      </Tabs>
      {notice && <div className="signin-notice" role="status">{notice}</div>}
      {!configured && <div className="error-box" role="alert">Sign-in is currently unavailable. Contact your administrator.</div>}
      {error && <div className="error-box" role="alert">{error}</div>}
      <form className="sign-in-form" onSubmit={submit}>
        <label htmlFor="account-email">{role === 'admin' ? 'Email address' : 'Email address or Student/Trainer ID'}<Input id="account-email" type="text" autoComplete="username" value={identifier} onChange={event => setIdentifier(event.target.value)} maxLength={254} required disabled={busy} /></label>
        <label htmlFor="account-password">Password<Input id="account-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} maxLength={128} required disabled={busy} /></label>
        <Button type="submit" className="setup-button" disabled={busy || !configured}>{busy ? <Loader2 size={17} className="animate-spin" /> : <LockKeyhole size={17} />}Sign in as {role[0].toUpperCase() + role.slice(1)}</Button>
      </form>
      <p className="auth-note">New trainers and students must first be added by the Admin, and receive an automatically generated temporary password. Admins can reset logins in <strong>Account Logins</strong>. For password resets, contact your institute administrator.</p>
      <div className="login-footer"><ShieldCheck size={15} />Protected accounts · Role-verified access</div>
    </section><span className="login-caption">A clearer day starts with a connected classroom.</span></div>
  </main>;
}
