import { useState } from 'react';
import { LockKeyhole, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { apiPost } from '@/lib/api';
export function PasswordForm({ required, onSuccess, onCancel }: { required: boolean; onSuccess: () => void; onCancel: () => void }) {
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <main className="app-connection"><section className="app-connection-card password-card"><div className="app-connection-logo"><LockKeyhole size={28} /></div>
    <h1>{required ? 'Choose your own password' : 'Change your password'}</h1><p>{required ? 'Replace the temporary password from your administrator before opening your workspace.' : 'Choose a strong password or passphrase. You will sign in again after saving.'}</p>
    {error && <div className="error-box" role="alert">{error}</div>}
    <form className="sign-in-form" onSubmit={async event => {
      event.preventDefault(); setError(''); if (next !== confirm) { setError('The new passwords do not match.'); return; } setBusy(true);
      try { await apiPost('/api/auth/password', { currentPassword: current, newPassword: next }); setCurrent(''); setNext(''); setConfirm(''); onSuccess(); }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to change your password.'); }
      finally { setBusy(false); }
    }}>
      <label>Current password<Input type="password" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} maxLength={128} required disabled={busy} /></label>
      <label>New password<Input type="password" autoComplete="new-password" value={next} onChange={event => setNext(event.target.value)} minLength={12} maxLength={72} required disabled={busy} /></label>
      <label>Confirm new password<Input type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} minLength={12} maxLength={72} required disabled={busy} /></label>
      <small>Use 12–72 characters. A long, unique passphrase works well.</small><Button type="submit" disabled={busy}>{busy && <Loader2 size={16} className="animate-spin" />}Save password</Button>
      <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>{required ? 'Sign out' : 'Cancel'}</Button>
    </form></section></main>;
}
