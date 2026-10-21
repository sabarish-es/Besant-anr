import { ArrowLeft, Compass, Home, ShieldCheck } from 'lucide-react';

/** Dev-server fallback. In production, Cloudflare serves public/404.html with HTTP 404. */
export function NotFoundPage() {
  return <main className="not-found-page">
    <div className="not-found-shell">
      <header className="not-found-brand"><img src="/besant-mark.png" alt="" width={43} height={43}/><span>Besant <strong>StudentHub</strong></span></header>
      <section className="not-found-card" aria-labelledby="not-found-title">
        <span className="not-found-eyebrow"><Compass size={16}/> YOU'RE OFF THE MAP</span>
        <p className="not-found-code" aria-hidden="true">404</p>
        <h1 id="not-found-title">This page doesn't exist.</h1>
        <p>The address may be incorrect, or the page might have moved. Your account and attendance records are safe.</p>
        <div className="not-found-actions"><a className="not-found-primary" href="/"><Home size={17}/> Return to StudentHub</a><button className="not-found-back" type="button" onClick={() => window.history.length > 1 ? window.history.back() : window.location.assign('/')}><ArrowLeft size={17}/> Go back</button></div>
      </section>
      <footer className="not-found-foot"><ShieldCheck size={15}/> Besant Technologies · Secure learning workspace</footer>
    </div>
  </main>;
}
