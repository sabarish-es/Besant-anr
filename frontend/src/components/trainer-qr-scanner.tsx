import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, CheckCircle2, Loader2, ScanLine, Square, ShieldCheck, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import type { Row } from '../lib/hub-types';

type ScanResult = { name: string; studentId: string; status: string; duplicate: boolean; time: string };
export function TrainerQRScanner({ session, serverTime, onAction }: { session: Row; serverTime: string; onAction: (input: any) => Promise<any> }) {
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null), stream = useRef<MediaStream | null>(null), frame = useRef(0), generation = useRef(0), processing = useRef(false), lastPayload = useRef(''), lastSeen = useRef(0), lastFrame = useRef(0);
  const [cameraOn, setCameraOn] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [recent, setRecent] = useState<ScanResult[]>([]);
  const actionRef = useRef(onAction), sessionRef = useRef(session);
  actionRef.current = onAction; sessionRef.current = session;
  const closedByTime = Date.parse(serverTime) >= Date.parse(session.data.effectiveDeadline || session.data.endAt) || Date.parse(serverTime) < Date.parse(session.data.startAt) - 900000;
  function stopCamera(update = true) { generation.current++; cancelAnimationFrame(frame.current); stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; if (video.current) video.current.srcObject = null; if (update) setCameraOn(false); }
  useEffect(() => () => { stopCamera(false); }, []);
  useEffect(() => { if (!session.data.sessionOpen || closedByTime) stopCamera(); }, [session.data.sessionOpen, closedByTime]);

  async function scanPayload(payload: string) {
    if (processing.current) return;
    const run = generation.current, selected = sessionRef.current;
    if (!/^BSQ1:\d{4}-\d{2}-\d{2}:[a-f0-9]{64}$/.test(payload)) { setError('This is not a StudentHub daily student QR.'); return; }
    processing.current = true; setWorking(true); setError(''); setNotice('Checking student QR…');
    try {
      if (!selected.data.sessionOpen) {
        await actionRef.current({ op: 'openSession', id: selected.id });
      }
      if (generation.current !== run) return;
      const result = await actionRef.current({ op: 'scanStudentQr', scheduleId: selected.id, payload });
      if (generation.current !== run) return;
      const value = { name: result.student.name, studentId: result.student.studentId || '', status: result.status, duplicate: !!result.alreadyRecorded, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
      setRecent(previous => [value, ...previous].slice(0, 8));
      if (result.alreadyRecorded) {
        setNotice(`Already recorded: ${value.name}. No new entry was added.`);
        toast.info('Attendance already recorded', {
          description: `${value.name} · ${value.studentId || 'Student'} · Existing record preserved.`,
          duration: 3200,
        });
      } else {
        setNotice(`${value.name} · ${value.status}. Attendance saved.`);
        // Non-blocking green popup: keep the camera active for the next student.
        toast.custom(id => (
          <div className="attendance-added-toast" role="status" aria-live="polite" aria-atomic="true">
            <div className="attendance-added-icon"><CheckCircle2 size={23} aria-hidden="true" /></div>
            <div className="attendance-added-copy">
              <strong>Attendance added</strong>
              <span>{value.name} · {value.status}{value.studentId ? ` · ${value.studentId}` : ''}</span>
              <small>Saved successfully for this class.</small>
            </div>
            <button type="button" className="attendance-toast-close" aria-label="Dismiss attendance notification" onClick={() => toast.dismiss(id)}><X size={17}/></button>
          </div>
        ), { duration: 4500, position: 'top-right' });
      }
    } catch (e) { if (generation.current === run) { setError(e instanceof Error ? e.message : 'Unable to record this scan.'); setNotice(''); } }
    finally { processing.current = false; if (generation.current === run) setWorking(false); }
  }
  const scanRef = useRef(scanPayload); scanRef.current = scanPayload;
  function readFrame(time: number) {
    if (!stream.current) return;
    if (time - lastFrame.current > 180 && video.current?.readyState === 4 && canvas.current) {
      lastFrame.current = time;
      const source = video.current, target = canvas.current, width = Math.min(source.videoWidth, 800), height = Math.round(source.videoHeight * width / source.videoWidth);
      if (width && height) {
        target.width = width; target.height = height;
        const context = target.getContext('2d', { willReadFrequently: true });
        if (context) {
          context.drawImage(source, 0, 0, width, height);
          const pixels = context.getImageData(0, 0, width, height), code = jsQR(pixels.data, width, height, { inversionAttempts: 'dontInvert' });
          if (code?.data) {
            lastSeen.current = Date.now();
            if (!processing.current && code.data !== lastPayload.current) { lastPayload.current = code.data; void scanRef.current(code.data); }
          } else if (Date.now() - lastSeen.current > 1000) lastPayload.current = '';
        }
      }
    }
    frame.current = requestAnimationFrame(readFrame);
  }
  async function startCamera() {
    if (processing.current || stream.current) return;
    const run = generation.current; processing.current = true; setWorking(true); setError(''); setNotice('Starting camera…');
    try {
      if (!sessionRef.current.data.sessionOpen) await actionRef.current({ op: 'openSession', id: sessionRef.current.id });
      if (generation.current !== run) return;
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs localhost or HTTPS and a supported browser.');
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
      if (generation.current !== run) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media;
      if (!video.current) { media.getTracks().forEach(track => track.stop()); stream.current = null; return; }
      video.current.srcObject = media; await video.current.play();
      if (generation.current !== run) return;
      setCameraOn(true); lastPayload.current = ''; setNotice('Ready. Hold a student’s QR inside the camera frame.'); frame.current = requestAnimationFrame(readFrame);
    } catch (e) { if (generation.current === run) { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; setError(e instanceof Error ? e.message : 'Allow camera access.'); setNotice(''); } }
    finally { processing.current = false; if (generation.current === run) setWorking(false); }
  }
  return <div className="trainer-scanner">
    <div className="scanner-heading"><div><span className="qr-kicker"><ScanLine size={15}/> TRAINER QR SCANNER</span><h3>Scan a student. Attendance saved.</h3><p>Each scan records attendance for the selected class only.</p></div><span className="blue-pill"><ShieldCheck size={14}/>One entry per class</span></div>
    <div className="scanner-layout"><div className="scanner-camera"><video ref={video} playsInline muted aria-label="Student QR camera preview"/>{!cameraOn && <div className="scanner-placeholder"><Camera size={44}/><strong>Student QR camera</strong><span>Camera requires permission on HTTPS or localhost.</span></div>}{cameraOn && <div className="scan-reticle" aria-hidden="true"/>}<canvas ref={canvas} hidden/></div>
      <div className="scanner-controls"><p className="scanner-help">Students open their personal daily QR. You scan it; Present or Late is saved automatically. Repeat scans keep the original record.</p><div className="scanner-buttons">{cameraOn ? <Button variant="outline" onClick={() => { stopCamera(); setWorking(false); setNotice('Camera stopped.'); }}><Square size={16}/>Stop camera</Button> : <Button onClick={() => void startCamera()} disabled={working || closedByTime}>{working ? <Loader2 className="animate-spin" size={17}/> : <Camera size={17}/>}Start camera</Button>}</div><small>Only live camera scanning is supported. Saved QR images cannot be uploaded. Only an authorized trainer can record attendance.</small>{closedByTime && <div className="scanner-message">Choose a class within 15 minutes before its start and before its end.</div>}<div aria-live="polite" aria-atomic="true">{error ? <div className="error-box">{error}</div> : notice && <div className={`scanner-message ${!working && notice.includes('Attendance saved.') ? 'scanner-success-message' : ''}`}>{working && <Loader2 size={15} className="animate-spin"/>}{notice}</div>}</div></div></div>
    {!!recent.length && <div className="scan-recent"><strong>Recent scans</strong>{recent.map((result, i) => <div className="scan-result" key={`${result.name}-${i}`}><CheckCircle2 size={17}/><div><strong>{result.name}</strong><small>{result.studentId} · {result.time}</small></div><span className={result.duplicate ? 'duplicate-pill' : 'blue-pill'}>{result.duplicate ? 'Already recorded' : result.status}</span></div>)}</div>}
  </div>;
}
