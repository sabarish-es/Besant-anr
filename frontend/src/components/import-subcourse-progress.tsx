import { useState } from 'react';
import { Download, FileSpreadsheet, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { readSpreadsheet } from '../lib/excel-reader';
import { apiPost } from '../lib/api';
import { downloadCsv } from './import-students';

import { parseImportGrid, statusHeader, detailsHeader, type StatusRow, type StudentDetailsRow, type ImportMode } from '../lib/subcourse-progress-import';

export function ImportSubcourseProgress({ onImported }: { onImported: () => Promise<void> | void }) {
  const [statusRows, setStatusRows] = useState<StatusRow[]>([]);
  const [detailsRows, setDetailsRows] = useState<StudentDetailsRow[]>([]);
  const [mode, setMode] = useState<ImportMode>('student-details');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const total = mode === 'student-details' ? detailsRows.length : statusRows.length;

  async function prepare(file?: File) {
    if (!file) return;
    setError(''); setNotice(''); setStatusRows([]); setDetailsRows([]);
    try {
      const result = parseImportGrid(await readSpreadsheet(file));
      setMode(result.mode);
      if (result.mode === 'student-details') setDetailsRows(result.rows as StudentDetailsRow[]);
      else setStatusRows(result.rows as StatusRow[]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to read spreadsheet.'); }
  }

  async function upload() {
    if (busy || !total) return;
    setBusy(true); setError(''); let processed = 0;
    let completed = 0, ongoing = 0, pending = 0, resetCompletions = 0;
    const studentDetails = mode === 'student-details';
    const chunkSize = studentDetails ? 10 : 50;
    const rows = studentDetails ? detailsRows : statusRows;
    try {
      for (let i = 0; i < rows.length; i += chunkSize) {
        setNotice(`Importing ${i + 1}–${Math.min(i + chunkSize, rows.length)} of ${rows.length}…`);
        const result = await apiPost<{ imported: number; completed?: number; ongoing?: number; pending?: number; resetCompletions?: number }>(
          '/api/hub', { op: studentDetails ? 'importStudentDetailsCompleted' : 'importModuleProgress', rows: rows.slice(i, i + chunkSize) });
        processed += result.imported;
        completed += result.completed || 0;
        ongoing += result.ongoing || 0;
        pending += result.pending || 0;
        resetCompletions += result.resetCompletions || 0;
      }
      setStatusRows([]); setDetailsRows([]);
      setNotice(studentDetails
        ? `${processed} student/course rows imported. Modules: ${completed} Completed, ${ongoing} Ongoing, ${pending} Pending.${resetCompletions ? ` ${resetCompletions} old completion statuses were replaced by this workbook.` : ''}`
        : `${processed} individual subcourse statuses imported.`);
      await onImported();
    } catch (e) {
      setError(`Imported ${processed} rows before an error: ${e instanceof Error ? e.message : 'Unknown error'}. Check student/course/subcourse names in Admin before retrying.`);
      await onImported();
    } finally { setBusy(false); }
  }

  return <section className="panel" style={{ padding: 20, marginBottom: 16 }} aria-label="Import student subcourse statuses">
    <div className="panel-heading"><div>
      <h2>Import student subcourse progress</h2>
      <p>Supports the 7-column Student Details Excel and the existing one-subcourse-per-row format.</p>
    </div><FileSpreadsheet size={22}/></div>
    <p><strong>Student Details format:</strong> Each comma-separated name in <code>SUB COURSE</code> is Completed. Unlisted modules are Pending until Present/Late attendance makes them Ongoing. The sheet's overall <code>STATUS</code> is ignored for module progress.</p>
    <p><strong>Important:</strong> The Student Details upload is a complete progress snapshot for each student/course. Any previously Completed subcourse missing from its list will be changed to Pending (or Ongoing if attendance exists). Admin approval and import actions are audited.</p>
    <div className="row-actions" style={{ marginTop: 12, flexWrap: 'wrap' }}>
      <Button variant="outline" onClick={() => downloadCsv('student-details-completed-template.csv', [
        detailsHeader,
        ['Example Student', 'STUDENT-ID-001', 'FULL STACK PYTHON', 'Python, MySQL, Aptitude and Communication', 'demo@example.com', '', 'Ongoing']
      ])}><Download size={16}/>Download Student Details template</Button>
      <Button variant="outline" onClick={() => downloadCsv('student-subcourse-status-template.csv', [statusHeader,
        ['STUDENT-ID-001', 'FULL STACK PYTHON', 'Python', 'Completed', 'Admin verified']
      ])}><Download size={16}/>Download individual-status template</Button>
      <Input type="file" accept=".xlsx,.csv" aria-label="Import subcourse status spreadsheet" disabled={busy}
        onChange={e => { void prepare(e.target.files?.[0]); e.target.value = ''; }} style={{ maxWidth: 310 }}/>
      {total > 0 && <Button onClick={() => void upload()} disabled={busy}>{busy && <Loader2 className="animate-spin"/>}
        Apply {total} {mode === 'student-details' ? 'student records' : 'module statuses'}</Button>}
    </div>
    {total > 0 && <p style={{ marginTop: 10 }}>{mode === 'student-details'
      ? `${total} student/course rows previewed; ${detailsRows.reduce((sum, r) => sum + r.completedSubcourses.length, 0)} listed completions. Unlisted subcourses follow attendance.`
      : `${total} subcourse entries previewed; ${statusRows.filter(r => r.status === 'Completed').length} completed.`}</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <div className="error-box" role="alert">{error}</div>}
    <small>Student IDs, parent courses and listed subcourses must already exist in Admin. Upload .xlsx or .csv; save old .xls files as .xlsx. Admin only.</small>
  </section>;
}
