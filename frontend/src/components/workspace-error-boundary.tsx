import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Props = { children: ReactNode };
type State = { failed: boolean };

// A render failure must not strand signed-in staff on an empty dashboard.
// Deliberately do not display internal error messages or student data.
export class WorkspaceErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Do not log sensitive dashboard records or exception details.
    console.error('StudentHub dashboard rendering failed.');
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="app-connection"><section className="app-connection-card" role="alert">
      <AlertTriangle size={24} aria-hidden="true" />
      <h1>Unable to display your dashboard</h1>
      <p>We couldn't open this workspace. Your saved records have not been changed.</p>
      <Button onClick={() => window.location.reload()}><RefreshCw size={16} /> Reload dashboard</Button>
    </section></main>;
  }
}
