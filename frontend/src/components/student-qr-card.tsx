import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { EyeOff, QrCode, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';
import type { Member, StudentQr } from '../lib/hub-types';
import { displayTime } from '../lib/hub-types';

type StudentQRCardProps = {
  student: Member;
  qr: StudentQr | null;
  serverTime: string;
  onRefresh: () => Promise<void>;
};

/**
 * Browser-level deterrents, NOT guaranteed screenshot protection.
 * Device screenshots, screen recordings, photos, and DevTools cannot be
 * reliably blocked by React or JavaScript. Enforce QR validity on the server.
 */
export function StudentQRCard({ student, qr, serverTime, onRefresh }: StudentQRCardProps) {
  const [image, setImage] = useState('');
  const [problem, setProblem] = useState('');
  const [remaining, setRemaining] = useState(0);
  const [pageActive, setPageActive] = useState(true);
  const refreshRequested = useRef('');

  // QR is not rendered while the tab/window is inactive. Screenshots of a
  // visible, active window are still possible at the operating-system level.
  useEffect(() => {
    // Best-effort deterrents only: screenshots are not preventable on the web.
    const blockMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('contextmenu', blockMenu);
    const blockCapture = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === 'printscreen' || ((event.ctrlKey || event.metaKey) && ['p', 's'].includes(key)) ||
          (event.metaKey && event.shiftKey && ['3','4','5'].includes(key))) {
        event.preventDefault();
      }
    };
    document.addEventListener('keydown', blockCapture, true);
    return () => { document.removeEventListener('keydown', blockCapture, true); document.removeEventListener('contextmenu', blockMenu); };
  }, []);

  useEffect(() => {
    const syncVisibility = () => {
      setPageActive(!document.hidden && document.hasFocus());
    };
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    window.addEventListener('focus', syncVisibility);
    window.addEventListener('blur', syncVisibility);
    window.addEventListener('pagehide', syncVisibility);
    return () => {
      document.removeEventListener('visibilitychange', syncVisibility);
      window.removeEventListener('focus', syncVisibility);
      window.removeEventListener('blur', syncVisibility);
      window.removeEventListener('pagehide', syncVisibility);
    };
  }, []);

  useEffect(() => {
    let current = true;
    setImage('');
    setProblem('');

    if (qr) {
      void QRCode.toDataURL(qr.payload, {
        width: 480,
        margin: 4,
        errorCorrectionLevel: 'M',
        color: { dark: '#0f172a', light: '#ffffff' },
      }).then((value) => {
        if (current) setImage(value);
      }).catch(() => {
        if (current) setProblem('Unable to draw your QR. Refresh and try again.');
      });
    }

    return () => { current = false; };
  }, [qr?.payload]);

  useEffect(() => {
    if (!qr) return;
    const offset = Date.parse(serverTime) - Date.now();
    const tick = () => {
      const seconds = Math.max(0, Math.ceil(
        (Date.parse(qr.expiresAt) - Date.now() - offset) / 1000,
      ));
      setRemaining(seconds);
      if (!seconds && refreshRequested.current !== qr.payload) {
        refreshRequested.current = qr.payload;
        void onRefresh();
      }
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    const resume = () => {
      if (!document.hidden) {
        tick();
        void onRefresh();
      }
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [qr?.payload, qr?.expiresAt, serverTime, onRefresh]);

  const expired = !qr || remaining === 0;
  const visibleQr = pageActive && !expired && Boolean(image);
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const studentId = student.data.studentId || student.email;

  return (
    <section className="student-qr-card" aria-label="Your personal daily QR">
      <div className="student-qr-copy">
        <span className="qr-kicker"><ShieldCheck size={15} /> YOUR DAILY ATTENDANCE QR</span>
        <h2>Show your QR to your trainer</h2>
        <p>Open this page at class time and let your trainer scan the code directly from your screen. Do not share copies or photos.</p>
        <div className="qr-student-name">
          <strong>{student.name}</strong>
          <span>{studentId}</span>
        </div>
        <div className="qr-validity">
          <span className="blue-pill">{qr?.day || 'Loading today’s code'}</span>
          <span>Expires in 5 minutes · {qr?.timeZone || 'Asia/Kolkata'}</span>
        </div>
        <small>
          {qr
            ? `Valid until ${displayTime(qr.expiresAt, qr.timeZone)} · ${hours}h ${minutes}m remaining`
            : 'Your institute is preparing your code.'}
        </small>
        <div className="qr-card-actions">
          <Button variant="ghost" onClick={() => void onRefresh()}>
            <RefreshCw size={16} /> Refresh QR
          </Button>
        </div>
        <p className="qr-privacy-advice">
          Downloading and printing are disabled. Screenshot blocking cannot be guaranteed in a web browser.
        </p>
      </div>

      <div
        className="personal-qr-frame personal-qr-protected"
        onContextMenu={(event) => event.preventDefault()}
        onCopy={(event) => event.preventDefault()}
        onDragStart={(event) => event.preventDefault()}
      >
        {!pageActive ? (
          <div className="qr-placeholder" role="status">
            <EyeOff size={44} aria-hidden="true" />
            <p>QR hidden while this page is inactive. Return to this tab to show it.</p>
          </div>
        ) : visibleQr ? (
          <img
            src={image}
            alt="Your personal attendance QR — show it directly to your trainer"
            draggable={false}
            onContextMenu={(event) => event.preventDefault()}
          />
        ) : (
          <div className="qr-placeholder" role="status">
            <QrCode size={52} aria-hidden="true" />
            <p>{problem || (qr && expired ? 'Refreshing today’s QR…' : 'Preparing your QR…')}</p>
          </div>
        )}
        <span>LIVE QR · {student.name} · {studentId}</span>
        <small className="qr-privacy-watermark">For direct trainer scanning only</small>
      </div>
    </section>
  );
}
