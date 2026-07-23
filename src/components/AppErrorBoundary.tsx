import { Component, ErrorInfo, ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { failed: boolean }

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[KickLive] App resume error:', error, info);
    const lastRecovery = Number(sessionStorage.getItem('kicklive-recovery-at') || 0);
    const canRecover = Date.now() - lastRecovery > 15000;
    if (canRecover) {
      sessionStorage.setItem('kicklive-recovery-at', String(Date.now()));
      window.setTimeout(() => window.location.reload(), 250);
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0B0E13] text-center px-6">
        <p className="text-brand-green font-black uppercase tracking-widest animate-pulse">Recovering KickLive…</p>
      </div>
    );
  }
}
