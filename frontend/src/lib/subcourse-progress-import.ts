/* Workbook parsing for the two StudentHub progress import formats. */
export type StatusRow = { studentId: string; course: string; subcourse: string; status: 'Completed' | 'Pending'; evidence: string };
export type StudentDetailsRow = { studentId: string; course: string; completedSubcourses: string[]; name: string; email: string; phone: string; overallStatus: string };
export type ImportMode = 'status-rows' | 'student-details';
export const statusHeader = ['Student ID', 'Course', 'Subcourse', 'Status', 'Evidence'];
export const detailsHeader = ['STUDENT NAME', 'STUDENT ID', 'COURSE', 'SUB COURSE', 'EMAIL', 'PHONE NUMBER', 'STATUS'];
const canonical = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]/g, '');

/**
 * Student-details workbook: SUB COURSE is a comma-separated list of modules
 * ALREADY COMPLETED by the student. Its STATUS is an overall student field,
 * NOT a per-module status and must never be used as one.
 */
export function parseImportGrid(grid: string[][]): { mode: ImportMode; rows: StatusRow[] | StudentDetailsRow[] } {
  if (grid.length < 2) throw new Error('Include a header and at least one student row.');
  const columns = grid[0].map(v => canonical(String(v || '')));
  const index = (key: string) => columns.indexOf(key);
  for (const key of ['studentid', 'course', 'subcourse']) {
    if (index(key) < 0) throw new Error(`Missing column: ${key}`);
  }
  const hasStudentDetailsHeader = index('studentname') >= 0 || index('phonenumber') >= 0;
  if (!hasStudentDetailsHeader && index('status') < 0) throw new Error('Missing Status column for the per-subcourse format.');
  const seen = new Set<string>();
  const entries = grid.slice(1).map((values, i) => ({ values, line: i + 2 }))
    .filter(({ values }) => values.some(v => String(v ?? '').trim()));
  if (entries.length > 1000) throw new Error('Upload up to 1,000 student rows at once.');
  if (hasStudentDetailsHeader) {
    const rows: StudentDetailsRow[] = entries.map(({ values, line }) => {
      const get = (key: string) => String(values[index(key)] ?? '').trim();
      const studentId = get('studentid'), course = get('course');
      if (!studentId || !course) throw new Error(`Row ${line}: STUDENT ID and COURSE are required.`);
      // Split on COMMA only. "Aptitude and Communication" must stay one module.
      const completedSubcourses = get('subcourse').split(',').map(s => s.trim()).filter(Boolean);
      const within = new Set<string>();
      for (const name of completedSubcourses) {
        if (name.length > 150) throw new Error(`Row ${line}: Subcourse name is too long.`);
        if (within.has(canonical(name))) throw new Error(`Row ${line}: Duplicate completed subcourse: ${name}`);
        within.add(canonical(name));
      }
      const key = `${canonical(studentId)}|${canonical(course)}`;
      if (seen.has(key)) throw new Error(`Row ${line}: Duplicate student/course in the workbook.`);
      seen.add(key);
      return { studentId, course, completedSubcourses, name: get('studentname'), email: get('email'), phone: get('phonenumber'), overallStatus: get('status') };
    });
    return { mode: 'student-details', rows };
  }
  const rows: StatusRow[] = entries.map(({ values, line }) => {
    const get = (key: string) => String(values[index(key)] ?? '').trim();
    const state = get('status').toLowerCase();
    if (!['', 'pending', 'completed', 'not completed'].includes(state))
      throw new Error(`Row ${line}: Status must be Completed, Pending or blank.`);
    if (!get('studentid') || !get('course') || !get('subcourse'))
      throw new Error(`Row ${line}: Student ID, Course and Subcourse are required.`);
    const key = [get('studentid'), get('course'), get('subcourse')].map(canonical).join('|');
    if (seen.has(key)) throw new Error(`Row ${line}: Duplicate student/course/subcourse.`);
    seen.add(key);
    return { studentId: get('studentid'), course: get('course'), subcourse: get('subcourse'),
      status: state === 'completed' ? 'Completed' : 'Pending', evidence: get('evidence') };
  });
  return { mode: 'status-rows', rows };
}

