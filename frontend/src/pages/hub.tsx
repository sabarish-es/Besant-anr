import { apiErrorMessage, apiFetch, readApiJson } from '@/lib/api';
import { CourseHierarchy } from '@/components/course-hierarchy';
import { StudentProgressDetails } from '@/components/student-progress';
import { StudentReviewCard } from '@/components/student-review-card';
import { ManageAccounts } from '@/components/manage-accounts';
import { ImportStudents, downloadCsv, type Credential } from '@/components/import-students';
import { apiPost } from '@/lib/api';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { LayoutDashboard, Users, BookOpen, Boxes, UserRound, Building2, Briefcase, CalendarDays, Radio, ChartNoAxesCombined, HandHelping, Ticket, DoorOpen, Palmtree, Bell, ScrollText, Settings, LogOut, Plus, Search, CheckCircle2, Clock, ShieldCheck, QrCode, Download, RefreshCw, ChevronRight, MoreHorizontal, Pencil, Trash2, X, Check, LockKeyhole, Activity, Loader2, BookOpenCheck, Layers3, CalendarClock, ScanLine, ClipboardList, ListOrdered, UserRoundCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarInset, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from '@/components/ui/empty';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { StudentQRCard } from '../components/student-qr-card';
import { TrainerQRScanner } from '../components/trainer-qr-scanner';
import { definitions, instituteDate, displayTime, localInputToISO, isoToLocalInput, type HubData, type Row, type Member, type Field } from '@/lib/hub-types';
const nav = [['dashboard', 'Dashboard', LayoutDashboard], ['accounts', 'Account Logins', LockKeyhole], ['students', 'Students', Users], ['courses', 'Course Management', BookOpenCheck], ['enrollments', 'Enrollments', ClipboardList], ['batches', 'Batches', Layers3], ['waitlist', 'Waiting List', ListOrdered], ['trainers', 'Trainers', UserRoundCheck], ['branches', 'Branches', Building2], ['placements', 'Placements', Briefcase], ['schedules', 'Schedules', CalendarClock], ['live', 'Live Attendance', ScanLine], ['reports', 'Attendance / Reports', ChartNoAxesCombined], ['leaves', 'Leave Requests', HandHelping], ['bookings', 'Slot Bookings', Ticket], ['rooms', 'Rooms', DoorOpen], ['holidays', 'Holidays', Palmtree], ['notifications', 'Notifications', Bell], ['audit', 'Audit Logs', ScrollText], ['settings', 'Settings', Settings]] as const;
const roleNames = { admin: 'Administrator', trainer: 'Trainer', student: 'Student' };
// Older batches use courseId only; new ones also store selected courseIds.
const batchCourseIds = (batch: Row): string[] => Array.isArray(batch.data.courseIds) && batch.data.courseIds.length
    ? batch.data.courseIds : batch.data.courseId ? [batch.data.courseId] : [];
const batchCourseNames = (data: HubData, batch: Row): string =>
    batchCourseIds(batch).map(id => data.records.find(r => r.id===id)?.data.name || 'Unknown course').join(', ');
function Brand({ name = 'Besant StudentHub', dark = false }: {
    name?: string;
    dark?: boolean;
}) { const parts = name === 'Besant StudentHub' ? <><span>Besant</span> <em>StudentHub</em></> : <span>{name}</span>; return <div className={`brand ${dark ? 'on-dark' : ''}`}><div className="brand-mark"><img src="/besant-mark.png" alt="Besant Technologies" /></div><div><strong>{parts}</strong><small>LEARN. TRACK. GROW.</small></div></div>; }
function Pick({ value, onChange, options, label, disabled = false }: {
    value: string;
    onChange: (v: string) => void;
    options: {
        value: string;
        label: string;
    }[];
    label: string;
    disabled?: boolean;
}) { return <Select value={value || '__none'} onValueChange={v => onChange(v === '__none' ? '' : v)} disabled={disabled}><SelectTrigger aria-label={label}><SelectValue placeholder={label}/></SelectTrigger><SelectContent><SelectItem value="__none">{label}</SelectItem>{options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>; }
function Badge({ value }: {
    value: string;
}) { return <span className={`badge ${['Active', 'Approved', 'Present', 'Joined', 'Inside', 'Open'].includes(value) ? 'green' : ['Late', 'Pending', 'Interview'].includes(value) ? 'amber' : ['Absent', 'Rejected', 'Inactive', 'Closed'].includes(value) ? 'red' : 'blue-tone'}`}>{value}</span>; }
function NoData({ title = 'Nothing here yet', detail = 'Your saved records will appear here.', icon: Icon = BookOpen }: {
    title?: string;
    detail?: string;
    icon?: any;
}) { return <Empty className="empty-state"><EmptyHeader><EmptyMedia variant="icon"><Icon /></EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{detail}</EmptyDescription></EmptyHeader></Empty>; }
function initials(name: string) { return name.split(/[\s@]+/).slice(0, 2).map(n => n[0]?.toUpperCase()).join('') || 'SH'; }
function items(data: HubData, kind: string): Row[] { return kind === 'students' || kind === 'trainers' ? data.members.filter(m => m.role === (kind === 'students' ? 'student' : 'trainer')).map(m => ({ id: m.id, kind, data: { ...m.data, name: m.name, email: m.email, status: m.status }, createdAt: m.createdAt })) : data.records.filter(r => r.kind === kind); }
function labelOf(data: HubData, id: string) { const m = data.members.find(m => m.id === id); if (m)
    return m.name; const r = data.records.find(r => r.id === id); return r?.data.name || r?.data.title || '—'; }
function relations(data: HubData, field: Field) { let rows = items(data, field.relation!); if (field.relation === 'schedules' && data.me.role === 'student')
    rows = rows.filter(r => Date.parse(r.data.endAt) >= Date.now()); if (field.relation === 'students' || field.relation === 'trainers')
    rows = rows.filter(r => r.data.status === 'Active'); return rows.map(r => ({ value: r.id, label: r.data.name || r.data.title || r.id })); }
function cellValue(data: HubData, row: Row, f: Field) { const v = row.data[f.key]; if (f.key === 'recipientId') return (Array.isArray(row.data.recipientIds) && row.data.recipientIds.length ? row.data.recipientIds : v ? [v] : []).map((id: string) => id === 'admin' ? 'Administrator' : labelOf(data, id)).join(', ') || '—'; if (f.relation)
    return labelOf(data, v); if (f.type === 'datetime-local')
    return displayTime(v, data.settings.timeZone); if (f.key === 'status')
    return <Badge value={String(v || '—')}/>; const text = String(v ?? '') || '—'; return f.type === 'textarea' && text.length > 90 ? text.slice(0, 90) + '…' : text; }
function reportRows(data: HubData) { const out: any[] = [], now = Date.parse(data.serverTime), tz = data.settings.timeZone; const holidays = items(data, 'holidays'); for (const session of items(data, 'schedules').filter(s => s.data.sessionStatus !== 'Cancelled')) {
    const day = instituteDate(session.data.startAt, tz);
    if (holidays.some(h => h.data.date === day && (!h.data.batchId || h.data.batchId === session.data.batchId)))
        continue;
    const batch = data.records.find(r => r.id === session.data.batchId);
    for (const student of data.members.filter(m => m.role === 'student' && (Array.isArray(session.data.roster) ? session.data.roster.includes(m.id) : m.data.batchId === session.data.batchId))) {
        if (!session.data.roster && Date.parse(student.createdAt) > Date.parse(session.data.endAt))
            continue;
        const a = data.attendance.find(a => a.memberId === student.id && a.scheduleId === session.id);
        const leave = (data.approvedLeaveDates || []).some(r => r.studentId === student.id && r.fromDate <= day && r.toDate >= day);
        const status = a?.status || (leave ? 'Excused' : now >= Date.parse(session.data.effectiveDeadline || session.data.endAt) ? 'Absent' : now >= Date.parse(session.data.startAt) ? 'Awaiting check-in' : 'Scheduled');
        out.push({ student, session, day, batch, attendance: a, status, courseId: session.data.courseId || batch?.data.courseId });
    }
} return out.sort((a, b) => b.session.data.startAt.localeCompare(a.session.data.startAt)); }
function Navigation({ data, active, setActive, onSignOut, onPasswordChange }: {
    data: HubData;
    active: string;
    setActive: (s: string) => void;
    onSignOut: () => void;
    onPasswordChange: () => void;
}) { const { setOpenMobile } = useSidebar(); const allowed = data.me.role === 'admin' ? nav : nav.filter(([id]) => data.me.role === 'trainer' ? ['dashboard', 'students', 'batches', 'schedules', 'live', 'reports', 'leaves', 'notifications', 'holidays'].includes(id) : ['dashboard', 'students', 'courses', 'enrollments', 'batches', 'schedules', 'live', 'reports', 'leaves', 'bookings', 'placements', 'notifications', 'holidays'].includes(id)); return <Sidebar className="hub-sidebar"><SidebarHeader><Brand name={data.settings.name}/></SidebarHeader><SidebarContent><SidebarGroup><SidebarGroupLabel>WORKSPACE</SidebarGroupLabel><SidebarMenu>{allowed.map(([id, label, Icon]) => <SidebarMenuItem key={id}><SidebarMenuButton isActive={active === id} onClick={() => { setActive(id); setOpenMobile(false); }} className="nav-item"><Icon /><span>{label}</span>{id === 'leaves' && items(data, 'leaves').filter(r => r.data.status === 'Pending').length > 0 && <span className="nav-count">{items(data, 'leaves').filter(r => r.data.status === 'Pending').length}</span>}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup></SidebarContent><SidebarFooter><div className="sidebar-account"><span className="avatar">{initials(data.me.name)}</span><div><strong>{data.me.name}</strong><small>{roleNames[data.me.role]}</small></div></div><button type="button" className="signout" onClick={onPasswordChange}><LockKeyhole size={17}/>Change password</button><button type="button" className="signout" onClick={onSignOut}><LogOut size={17}/>Sign out</button></SidebarFooter></Sidebar>; }
function Login({ displayName, needsSetup, error, onSetup, onRetry, onSignOut, busy }: { displayName: string; needsSetup: boolean; error: string; onSetup: (name: string) => void; onRetry: () => void; onSignOut: () => void; busy: boolean }) {
    const [name, setName] = useState('Besant StudentHub');
    return <main className="app-connection"><section className="app-connection-card"><div className="app-connection-logo"><img src="/besant-mark.png" alt="Besant Technologies" /></div><h1>{needsSetup ? 'Set up your institute' : 'Your institute account'}</h1><p>Signed in as {displayName}.</p>{error && <div className="error-box" role="alert">{error}</div>}{needsSetup ? <form className="sign-in-form" onSubmit={e => { e.preventDefault(); onSetup(name); }}><label htmlFor="institute-name">Institute name<Input id="institute-name" value={name} onChange={e => setName(e.target.value)} required maxLength={100}/></label><Button type="submit" disabled={busy}>Create institute workspace</Button></form> : <Button onClick={onRetry} disabled={busy}>Try again</Button>}<Button variant="outline" className="setup-signout" onClick={onSignOut} disabled={busy}>Sign out</Button></section></main>;
}
export function Hub({ signedIn, displayName, onSignOut, onPasswordChange }: {
    signedIn: boolean;
    displayName: string;
    onSignOut: () => void;
    onPasswordChange: () => void;
}) {
    const [data, setData] = useState<HubData | null>(null), [needsSetup, setNeedsSetup] = useState(false), [loading, setLoading] = useState(signedIn), [error, setError] = useState(''), [saving, setSaving] = useState(false), [active, setActive] = useState('dashboard'), [search, setSearch] = useState(''), [filter, setFilter] = useState(''), [batchFilter, setBatchFilter] = useState(''), [editor, setEditor] = useState<{
        kind: string;
        row?: Row;
        category?: 'Placement';
        courseId?: string;
    } | null>(null), [deleting, setDeleting] = useState<Row | null>(null), [deleteConfirmation, setDeleteConfirmation] = useState(''), [viewing, setViewing] = useState<Row | null>(null), [selectedSession, setSelectedSession] = useState(''), [marking, setMarking] = useState<{
        sessionId: string;
        memberId: string;
    } | null>(null), [markStatus, setMarkStatus] = useState('Present'), [markNote, setMarkNote] = useState(''), [reportFrom, setReportFrom] = useState(''), [reportTo, setReportTo] = useState('');
    const [credentials, setCredentials] = useState<Credential[]>([]);
    const [editingBatch, setEditingBatch] = useState<Row | null>(null);
    const [batchDraft, setBatchDraft] = useState({ endDate:'',dailyStartTime:'',dailyEndTime:'',batchType:'Weekday',capacity:45 });
    const [moduleStudent, setModuleStudent] = useState('');
    const [moduleId, setModuleId] = useState('');
    const [moduleEvidence, setModuleEvidence] = useState('');
    // Both Admin and Trainer start on today's sessions whenever Schedules is opened.
    const [showFullSchedule, setShowFullSchedule] = useState(false);
    const [chosenLiveDate, setChosenLiveDate] = useState('');
    const [liveDayData, setLiveDayData] = useState<{ date: string; sessions: Row[]; attendance: HubData['attendance'] } | null>(null);
    const [liveLoading, setLiveLoading] = useState(false);
    const sequence = useRef(0), busy = useRef(false);
    const refresh = useCallback(async (quiet = false) => { if (busy.current)
        return; const seq = ++sequence.current; try {
        const response = await apiFetch('/api/hub', { cache: 'no-store' }), value = await readApiJson(response);
        if (!response.ok)
            throw new Error(apiErrorMessage(value, 'Unable to load your institute.'));
        if (seq !== sequence.current)
            return;
        if (!value.needsSetup && (!value.data || !value.data.me || !Array.isArray(value.data.records)))
            throw new Error('The institute returned incomplete records. Please retry.');
        setData(value.data || null);
        setNeedsSetup(!!value.needsSetup);
        setError('');
    }
    catch (e) {
        if (!quiet)
            setError(e instanceof Error ? e.message : 'Unable to load your institute.');
    }
    finally {
        if (!quiet)
            setLoading(false);
    } }, []);
    useEffect(() => { if (signedIn) {
        void refresh();
        const visibleRefresh = () => { if (!document.hidden) void refresh(true); };
        const timer = setInterval(visibleRefresh, 45000);
        document.addEventListener('visibilitychange', visibleRefresh);
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibleRefresh); };
    } }, [signedIn, refresh]);
    useEffect(() => { setSearch(''); setFilter(''); setBatchFilter(''); }, [active]);
    useEffect(() => { setShowFullSchedule(false); }, [active]);
    const mutate = useCallback(async (input: any, message?: string, throwOnError = false) => { busy.current = true; setSaving(true); const seq = ++sequence.current; try {
        const response = await apiFetch('/api/hub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), value = await readApiJson(response);
        if (!response.ok)
            throw new Error(apiErrorMessage(value, 'Unable to load your institute.'));
        if (seq === sequence.current) {
            setData(value.data);
            setNeedsSetup(false);
            setError('');
        }
        if (message)
            toast.success(message);
        return value;
    }
    catch (e) {
        const message = e instanceof Error ? e.message : 'Unable to save. Try again.';
        if (!throwOnError) toast.error(message);
        if (throwOnError) throw e;
        if (input.op === 'setup')
            setError(message);
        return null;
    }
    finally {
        busy.current = false;
        setSaving(false);
    } }, []);
    const toolState = useRef({ data, mutate, setActive });
    toolState.current = { data, mutate, setActive };
    useEffect(() => { const context = (document as any).modelContext; if (!context?.registerTool)
        return; const controller = new AbortController(); const register = (tool: any) => Promise.resolve(context.registerTool(tool, { signal: controller.signal })).catch(() => { }); void register({ name: 'read_institute_overview', description: 'Read totals from the currently authorized institute workspace.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute() { const d = toolState.current.data; if (!d)
            throw new Error('Sign in and open your institute first.'); return { role: d.me.role, students: d.members.filter(m => m.role === 'student').length, batches: items(d, 'batches').length, classes: items(d, 'schedules').length }; } }); void register({ name: 'navigate_institute_section', description: 'Open an authorized institute section without changing any records.', inputSchema: { type: 'object', properties: { section: { type: 'string', enum: ['dashboard', 'schedules', 'live', 'reports', 'leaves', 'notifications'] } }, required: ['section'], additionalProperties: false }, annotations: { readOnlyHint: true }, execute(input: any) { if (!toolState.current.data)
            throw new Error('Sign in first.'); if (!['dashboard', 'schedules', 'live', 'reports', 'leaves', 'notifications'].includes(input?.section))
            throw new Error('Unknown section.'); toolState.current.setActive(input.section); return { section: input.section }; } }); return () => controller.abort(); }, []);
    const derived = useMemo(() => data ? reportRows(data) : [], [data]);
    const liveDate = chosenLiveDate || (data ? instituteDate(data.serverTime, data.settings.timeZone) : '');
    useEffect(() => {
        if (active !== 'live' || !data || !['admin', 'trainer'].includes(data.me.role)) return;
        const controller = new AbortController();
        setLiveLoading(true);
        void apiFetch(`/api/attendance?date=${encodeURIComponent(liveDate)}`, { cache: 'no-store', signal: controller.signal })
            .then(async response => {
                const value = await readApiJson(response);
                if (!response.ok) throw new Error(apiErrorMessage(value, 'Unable to load attendance.'));
                if (!controller.signal.aborted) setLiveDayData(value);
            }).catch(error => {
                if (!controller.signal.aborted) { setLiveDayData(null); toast.error(error instanceof Error ? error.message : 'Could not load attendance for that date.'); }
            }).finally(() => { if (!controller.signal.aborted) setLiveLoading(false); });
        return () => controller.abort();
    }, [active, liveDate, data?.serverTime, data?.me.role]);
    if (loading)
        return <main className="initial-loading"><Brand /><div className="loading-panel"><Skeleton className="h-9 w-64"/><Skeleton className="h-5 w-80"/><div className="loading-stats">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 w-full"/>)}</div><p>Loading your institute workspace…</p></div><Toaster /></main>;
    if (!data)
        return <><Login displayName={displayName} onSignOut={onSignOut} needsSetup={needsSetup} error={error} busy={saving} onSetup={name => void mutate({ op: 'setup', name }, 'Your institute is ready.')} onRetry={() => void refresh()}/><Toaster /></>;
    const role = data.me.role, tz = data.settings.timeZone, today = instituteDate(data.serverTime, tz), students = data.members.filter(m => m.role === 'student'), sessions = items(data, 'schedules').sort((a, b) => a.data.startAt.localeCompare(b.data.startAt)), todays = sessions.filter(r => instituteDate(r.data.startAt, tz) === today), presentToday = derived.filter(r => r.day === today && r.status === 'Present'), lateToday = derived.filter(r => r.day === today && r.status === 'Late'), absentToday = derived.filter(r => r.day === today && r.status === 'Absent'), inside = data.attendance.filter(a => a.checkedIn && !a.checkedOut), upcoming = sessions.filter(r => Date.parse(r.data.effectiveDeadline || r.data.endAt) > Date.parse(data.serverTime) && !['Completed','Auto-Closed','Cancelled'].includes(r.data.sessionStatus));
    // The backend supplies only schedules authorized for this role.
    // Use the institute timezone, not the browser's timezone, for 'today'.
    const displayedSessions = showFullSchedule ? sessions : todays;
    const canEdit = role === 'admin' && !['leaves', 'bookings'].includes(active) || role === 'trainer' && ['holidays'].includes(active);
    const canCreate = canEdit || role === 'trainer' && active === 'batches' || active === 'leaves' && ['student', 'trainer'].includes(role) || active === 'bookings' && role === 'student';
    const recordDef = definitions[active], allItems = recordDef ? items(data, active) : [];
    const filteredItems = allItems.filter(r =>
        // Only the Admin's generic Schedules table needs this filter.
        // Other record lists and the Student's schedule remain unchanged.
        (active !== 'schedules' || role !== 'admin' || showFullSchedule ||
            (r.data.startAt && instituteDate(r.data.startAt, tz) === today)) &&
        (!search || Object.values(r.data).some(v => String(v).toLowerCase().includes(search.toLowerCase()))) &&
        (!filter || (r.kind === 'batches' ? batchCourseIds(r).includes(filter) : r.data.courseId === filter || r.data.status === filter)));
    const trainerBatches = role === 'trainer' ? items(data, 'batches') : [];
    const trainerEnrollmentRows = (() => {
        if (data.me.role !== 'trainer') return [] as { student: Member; batch: Row; course: Row | undefined }[];
        const activeExtra = items(data, 'enrollments').filter(e => e.data.status === 'Active');
        const courses = items(data, 'courses');
        return items(data, 'batches').flatMap(batch => students.filter(student => student.status === 'Active' &&
            (student.data.batchId === batch.id || activeExtra.some(e => e.data.studentId === student.id && e.data.batchId === batch.id)))
            .map(student => {
                // Display this student's own registered course in a shared batch.
                const linked = activeExtra.find(e=>e.data.studentId===student.id && e.data.batchId===batch.id);
                const courseId = linked?.data.courseId || student.data.courseId;
                return {student,batch,course:courses.find(c=>c.id===courseId)};
            }));
    })();
    const trainerVisibleStudents = trainerEnrollmentRows.filter(entry =>
        (!filter || entry.course?.id === filter) &&
        (!batchFilter || entry.batch.id === batchFilter) &&
        (!search || `${entry.student.data.studentId} ${entry.student.name} ${entry.course?.data.name || ''} ${entry.batch.data.name}`.toLowerCase().includes(search.toLowerCase())));
    const liveSessions = role === 'student' ? sessions : liveDayData?.date === liveDate ? liveDayData.sessions : [];
    const liveAttendance = role === 'student' ? data.attendance : liveDayData?.date === liveDate ? liveDayData.attendance : [];
    const effectiveSession = liveSessions.find(r => r.id === selectedSession) || liveSessions.find(r => r.data.sessionOpen) || liveSessions[0];
    const reportFiltered = derived.filter(r => (!reportFrom || r.day >= reportFrom) && (!reportTo || r.day <= reportTo) && (!filter || r.courseId === filter || r.status === filter) && (!search || `${r.student.name} ${r.student.data.studentId} ${r.session.data.name}`.toLowerCase().includes(search.toLowerCase())));
    const title = nav.find(n => n[0] === active)?.[1] || 'Dashboard';
    const doDelete = async () => { if (deleting && await mutate({ op: 'delete', id: deleting.id, kind: deleting.kind }, ['students', 'trainers'].includes(deleting.kind) ? 'Account deactivated.' : 'Record deleted.'))
        setDeleting(null); };
    const doPermanentDelete = async () => {
        if (!deleting || !['students', 'trainers'].includes(deleting.kind) || deleteConfirmation !== 'DELETE') return;
        setSaving(true);
        try {
            await apiPost('/api/accounts', { action: 'delete', memberId: deleting.id });
            setDeleting(null);
            setDeleteConfirmation('');
            toast.success('Account and associated login permanently deleted.');
            await refresh();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Unable to delete account.');
        } finally { setSaving(false); }
    };
    const doForceDelete = async () => {
        if(!deleting || deleteConfirmation!=='DELETE ALL RELATED DATA') return;
        setSaving(true);
        try {
            const isMember=['students','trainers'].includes(deleting.kind);
            const response=await apiPost(isMember?'/api/accounts':'/api/hub',isMember
                ? {action:'forceDelete',memberId:deleting.id,confirmation:deleteConfirmation}
                : {op:'forceDelete',kind:deleting.kind,id:deleting.id,confirmation:deleteConfirmation});
            setDeleting(null);setDeleteConfirmation('');
            toast.success('Selected records and linked data deleted. See Audit Logs.');
            if(response?.data) setData(response.data); else await refresh();
        } catch(e) {toast.error(e instanceof Error?e.message:'Unable to delete linked data.');}
        finally {setSaving(false);}
    };
    const startSession = async (row: Row) => {
        setSelectedSession(row.id);
        setActive('live');
    };
    const exportCsv = () => { const rows = [['Student', 'Student ID', 'Class', 'Date', 'Batch', 'Status', 'Checked in', 'Checked out', 'Method'], ...reportFiltered.map(r => [r.student.name, r.student.data.studentId || '', r.session.data.name, r.day, r.batch?.data.name || '', r.status, r.attendance?.checkedIn || '', r.attendance?.checkedOut || '', r.attendance?.method || ''])]; const csv = rows.map(row => row.map(v => { let s = String(v ?? ''); if (/^\s*[=+\-@]/.test(s))
        s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; }).join(',')).join('\r\n'); const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `attendance-${today}.csv`; a.click(); URL.revokeObjectURL(url); };
    return <SidebarProvider style={{ '--sidebar-width': '258px' } as React.CSSProperties}><a className="skip-to-content" href="#main-content">Skip to main content</a><Navigation data={data} active={active} setActive={setActive} onSignOut={onSignOut} onPasswordChange={onPasswordChange}/><SidebarInset className="hub-main"><header className="topbar"><div className="topbar-title"><SidebarTrigger /><span>{title}</span></div><div className="topbar-right"><span className="header-date">{new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(data.serverTime))}</span><button className="icon-button" aria-label="Open notifications" onClick={() => setActive('notifications')}><Bell size={19}/>{items(data, 'notifications').length > 0 && <span className="notification-dot"/>}</button><div className="topbar-user"><span className="avatar">{initials(data.me.name)}</span><div><strong>{data.me.name}</strong><small>{roleNames[role]}</small></div></div></div></header><main className="workspace" id="main-content"><div className="page-heading"><div><div className="overline">{data.settings.name} / {roleNames[role]}</div><h1>{active === 'dashboard' ? `Welcome back, ${data.me.name.split(/[ @]/)[0]}` : title}</h1><p>{active === 'dashboard' ? 'A clear view of your institute, one class at a time.' : active === 'live' ? role === 'student' ? 'Show your daily QR to your trainer and follow your attendance.' : 'Select a class and scan student QR codes.' : active === 'reports' ? 'Review attendance and export the records you need.' : active === 'settings' ? 'Manage your institute name, time, and attendance rules.' : active === 'audit' ? 'A record of account, class, and attendance changes.' : recordDef?.description}</p></div><div className="heading-actions"><Button variant="outline" size="icon" aria-label="Refresh records" onClick={() => void refresh()} disabled={saving}><RefreshCw size={17}/></Button>{active === 'dashboard' && role === 'admin' && <><Button onClick={() => setEditor({ kind: 'students' })}><Plus size={17}/>Add student</Button><Button variant="outline" onClick={()=>{setActive('notifications');setEditor({kind:'notifications',category:'Placement'});}}><Briefcase size={17}/>Placement notice</Button></>}{active === 'courses' && role === 'admin' && <Button variant="outline" onClick={() => setEditor({ kind: 'subcourses' })}><Plus size={17}/>Add subcourse</Button>}{canCreate && recordDef && <Button onClick={() => setEditor({ kind: active })}><Plus size={17}/>{active === 'leaves' ? 'Request leave' : active === 'bookings' ? 'Book a slot' : `Add ${recordDef.singular.toLowerCase()}`}</Button>}{active === 'reports' && <Button onClick={exportCsv} disabled={!reportFiltered.length}><Download size={17}/>Export CSV</Button>}</div></div>
 {role === 'student' && (active === 'dashboard' || active === 'live') && <StudentQRCard student={data.me} qr={data.studentQr} serverTime={data.serverTime} onRefresh={() => refresh(true)}/>}
 {role === 'student' && active === 'dashboard' && items(data,'holidays').length > 0 && <section className="panel" style={{padding:20,marginBottom:18}}><div className="panel-heading"><div><h2>Upcoming holidays</h2><p>Institute-wide and your enrolled batches</p></div><Palmtree size={20}/></div>{items(data,'holidays').filter(h=>h.data.date>=today).sort((a,b)=>a.data.date.localeCompare(b.data.date)).slice(0,4).map(h=><article key={h.id} className="announcement"><strong>{h.data.name}</strong><p>{h.data.date} · {h.data.batchId?labelOf(data,h.data.batchId):'Institute-wide'}</p>{h.data.description&&<p>{h.data.description}</p>}</article>)}</section>}
 {role === 'student' && active === 'dashboard' && <section className="panel" style={{padding:20,marginBottom:18}}><div className="panel-heading"><div><h2>My course learning progress</h2><p>Recorded attendance and trainer-verified module completion are tracked separately.</p></div></div>{items(data,'courses').map(course=>{const modules=items(data,'subcourses').filter(m=>m.data.courseId===course.id);const completed=modules.filter(m=>items(data,'module-progress').some(r=>r.data.studentId===data.me.id&&r.data.subcourseId===m.id&&r.data.status==='Completed')).length;const pct=modules.length?Math.round(completed/modules.length*100):0;return <article key={course.id} className="module-progress-summary"><strong>{course.data.name}</strong><p>{completed}/{modules.length} modules completed · {pct}% learning progress</p><Progress value={pct}/></article>;})}</section>}
 {role === 'student' && active === 'dashboard' && <StudentReviewCard review={data.googleReview}/>}
 {role === 'student' && active === 'dashboard' && items(data, 'notifications').filter(r => r.data.category === 'Placement').length>0 && <section className="panel" style={{padding:20,marginBottom:18}}><div className="panel-heading"><div><h2>Placement opportunities</h2><p>New placement announcements from your administrator</p></div><Briefcase size={22}/></div>{items(data,'notifications').filter(r=>r.data.category==='Placement').slice(0,5).map(r=><article className="announcement" key={r.id}><strong>{r.data.title}</strong><p>{r.data.body}</p></article>)}</section>}
 {role === 'student' && active === 'students' && <section className="panel" style={{padding:20}}>
   <div className="panel-heading"><div><h2>My batchmates</h2><p>Names and shared course/batch information only. Contact details and private attendance are hidden.</p></div></div>
   {!data.members.some(m=>m.role==='student'&&m.id!==data.me.id) ? <NoData title="No batchmates yet" detail="Batchmates appear after you join your first class."/> :
   <div className="batchmates-grid">{data.members.filter(m=>m.role==='student' && m.id!==data.me.id).map(m=><article key={m.id} className="batchmate-card"><strong>{m.name}</strong><p>{labelOf(data,m.data.courseId)} · {labelOf(data,m.data.batchId)}</p><p>Personal progress not shared</p></article>)}</div>}
 </section>}
 {role === 'student' && active === 'dashboard' && items(data,'batch-waitlist').length>0 && <section className="panel" style={{padding:20,marginBottom:16}}><h2>Batch waiting list</h2><p>These batches have reached capacity. Your verified attendance attempt was queued for Admin review.</p>{items(data,'batch-waitlist').map(r=><p key={r.id}>{labelOf(data,r.data.batchId)} · Waiting since {displayTime(r.data.requestedAt,tz)}</p>)}</section>}
 {active === 'waitlist' && role === 'admin' && <section className="panel table-panel"><div className="panel-heading"><div><h2>Pending batch admission requests</h2><p>Students are assigned only when their first verified QR attendance is marked and a seat is available. Earlier registrations can be prioritized by Admin for the next batch.</p></div></div>{!items(data,'batch-waitlist').length ? <NoData title="No waiting students" detail="Students queued from a full first class will appear here."/> : <Table><TableHeader><TableRow><TableHead>Student</TableHead><TableHead>Course</TableHead><TableHead>Requested batch</TableHead><TableHead>First scan request</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{items(data,'batch-waitlist').sort((a,b)=>(a.data.registeredAt||a.createdAt).localeCompare(b.data.registeredAt||b.createdAt)||(a.data.requestedAt||'').localeCompare(b.data.requestedAt||'')).map(r=><TableRow key={r.id}><TableCell>{labelOf(data,r.data.studentId)}</TableCell><TableCell>{labelOf(data,r.data.courseId)}</TableCell><TableCell>{labelOf(data,r.data.batchId)}</TableCell><TableCell>{displayTime(r.data.requestedAt,tz)}</TableCell><TableCell><Badge value="Waiting"/></TableCell><TableCell><Button size="sm" variant="outline" onClick={()=>setDeleting(r)}>Remove</Button></TableCell></TableRow>)}</TableBody></Table>}</section>}
 {active === 'accounts' && role === 'admin' && <ManageAccounts data={data} onRefresh={() => void refresh()} onCredentials={setCredentials}/>}
 {active === 'students' && role === 'admin' && <ImportStudents data={data} onImported={() => refresh()} onCredentials={setCredentials}/>}
{active === 'dashboard' && <><div className="stat-grid">{[{ title: role === 'student' ? 'Your classes' : 'Total students', value: role === 'student' ? sessions.length : students.length, icon: Users, color: 'primary', note: role === 'student' ? 'In your assigned batch' : 'Enrolled in your institute' }, { title: role === 'student' ? 'Attendance rate' : 'Active students', value: role === 'student' ? (() => { const counted = derived.filter(r => ['Present', 'Late', 'Absent'].includes(r.status)); return counted.length ? Math.round(counted.filter(r => r.status !== 'Absent').length / counted.length * 100) + '%' : '—'; })() : students.filter(s => s.status === 'Active').length, icon: ShieldCheck, color: 'teal', note: role === 'student' ? 'Completed classes' : 'Accounts ready for class' }, { title: "Today’s classes", value: todays.length, icon: CalendarDays, color: 'blue', note: `${today} · ${tz}` }, { title: 'Present today', value: presentToday.length + lateToday.length, icon: CheckCircle2, color: 'teal', note: 'Includes late arrivals' }, { title: 'Absent today', value: absentToday.length, icon: X, color: 'rose', note: 'After a class has ended' }, { title: 'Late arrivals', value: lateToday.length, icon: Clock, color: 'orange', note: `After ${data.settings.lateMinutes} minutes` }, { title: 'Currently inside', value: inside.length, icon: DoorOpen, color: 'primary', note: 'Checked in, not checked out' }, { title: 'Upcoming classes', value: upcoming.length, icon: BookOpen, color: 'slate', note: 'Scheduled and in progress' }].map(s => <section className={`stat-card ${s.color}`} key={s.title}><div className="stat-top"><span className={`stat-icon ${s.color}`}><s.icon size={21}/></span><span className="stat-title">{s.title}</span></div><strong>{s.value}</strong><small>{s.note}</small></section>)}</div>
 {role === 'admin' && (!students.length || !sessions.length) && <section className="setup-banner"><div className="setup-copy"><span className="setup-kicker">GET READY FOR YOUR FIRST CLASS</span><h2>Build your institute’s foundation.</h2><p>Add your teaching structure, then enroll students and schedule a class.</p></div><div className="setup-steps">{[['branches', 'Branch'], ['courses', 'Course'], ['trainers', 'Trainer'], ['batches', 'Batch'], ['students', 'Students']].map(([kind, label], i) => { const done = items(data, kind).length > 0; return <button key={kind} className={done ? 'done' : ''} onClick={() => setActive(kind)}><span>{done ? <Check size={15}/> : i + 1}</span>{label}<ChevronRight size={14}/></button>; })}</div></section>}
 <div className="dashboard-panels"><section className="panel"><div className="panel-heading"><div><h2>Weekly attendance</h2><p>Last 7 days · actual class records</p></div><span className="small-label">{tz}</span></div><div className="weekly-chart" role="img" aria-label="Weekly present, late, and absent counts">{Array.from({ length: 7 }, (_, i) => { const dt = new Date(Date.parse(data.serverTime) - (6 - i) * 86400000), day = instituteDate(dt.toISOString(), tz), rows = derived.filter(r => r.day === day), counts = ['Present', 'Late', 'Absent'].map(s => rows.filter(r => r.status === s).length), max = Math.max(1, ...Array.from({ length: 7 }, (_, j) => { const d = instituteDate(new Date(Date.parse(data.serverTime) - j * 86400000).toISOString(), tz); return derived.filter(r => r.day === d && ['Present', 'Late', 'Absent'].includes(r.status)).length; })); return <div className="chart-day" key={day}><div className="bar-stack" title={`${day}: ${counts[0]} present, ${counts[1]} late, ${counts[2]} absent`}>{counts.map((n, j) => <span key={j} className={['present', 'late', 'absent'][j]} style={{ height: `${n / max * 125}px` }}/>)}{!counts.some(Boolean) && <span className="zero-bar"/>}</div><span>{new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'short' }).format(dt)}</span></div>; })}</div><div className="chart-legend"><span><i className="present"/>Present</span><span><i className="late"/>Late</span><span><i className="absent"/>Absent</span></div></section><section className="panel"><div className="panel-heading"><div><h2>Course attendance</h2><p>Present and late / completed classes</p></div><ChartNoAxesCombined size={20}/></div>{!items(data, 'courses').length ? <NoData title="No courses yet" detail="Add a course such as Full Stack, Data Analytics or Cloud Computing."/> : <div className="course-progress">{items(data, 'courses').map(c => { const rows = derived.filter(r => r.courseId === c.id && ['Present', 'Late', 'Absent'].includes(r.status)), value = rows.length ? Math.round(rows.filter(r => r.status !== 'Absent').length / rows.length * 100) : 0; return <div key={c.id}><div><strong>{c.data.name}</strong><span>{rows.length ? value + '%' : 'No attendance yet'}</span></div><Progress value={value}/></div>; })}</div>}</section></div><div className="dashboard-panels lower"><section className="panel"><div className="panel-heading"><div><h2>Coming up next</h2><p>Your next scheduled classes</p></div><button className="text-button" onClick={() => setActive('schedules')}>View schedule</button></div>{!upcoming.length ? <NoData title="Your schedule is clear" detail="Scheduled classes will appear here." icon={CalendarDays}/> : upcoming.slice(0, 4).map(r => <div className="class-row" key={r.id}><span className="class-icon"><BookOpen size={19}/></span><div><strong>{r.data.name}</strong><p>{labelOf(data, r.data.batchId)} · {displayTime(r.data.startAt, tz)}</p></div><Badge value={Date.parse(r.data.startAt) <= Date.parse(data.serverTime) ? 'In progress' : r.data.mode}/></div>)}</section><section className="panel"><div className="panel-heading"><div><h2>Institute updates</h2><p>Latest announcements</p></div><Bell size={19}/></div>{!items(data, 'notifications').length ? <NoData title="All caught up" detail="New institute announcements will appear here." icon={Bell}/> : items(data, 'notifications').slice(0, 3).map(r => <article className="announcement" key={r.id}><span className="announcement-date">{displayTime(r.createdAt, tz)}</span><h3>{r.data.title}</h3><p>{r.data.body}</p></article>)}</section></div></>}
 {active === 'courses' && role !== 'trainer' && <CourseHierarchy data={data} admin={role === 'admin'}
  onAddSubcourse={courseId => setEditor({kind: 'subcourses', courseId})}
  onEdit={row => setEditor({kind: row.kind, row})}
  onDelete={row => setDeleting(row)}/>}
 {active === 'students' && role === 'trainer' && <section className="panel table-panel">
   <div className="record-toolbar trainer-student-filters">
     <div className="search-field"><Search size={17}/><Input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search student ID or name" aria-label="Search students"/></div>
     <Pick value={filter} onChange={v=>{setFilter(v);setBatchFilter('');}} label="All courses" options={items(data,'courses').filter(c=>trainerBatches.some(b=>batchCourseIds(b).includes(c.id))).map(c=>({value:c.id,label:c.data.name}))}/>
     <Pick value={batchFilter} onChange={setBatchFilter} label="All batches" options={trainerBatches.filter(b=>!filter||batchCourseIds(b).includes(filter)).map(b=>({value:b.id,label:b.data.name}))}/>
     <Button variant="outline" size="sm" onClick={()=>{setFilter('');setBatchFilter('');setSearch('');}}>Clear filters</Button>
     <span className="record-count">{trainerVisibleStudents.length} enrolled students</span>
   </div>
   {!trainerVisibleStudents.length ? <NoData title="No students match the selected filters" detail="Only enrolled students in your assigned batches are shown." icon={Users}/> :
   <Table><TableHeader><TableRow><TableHead>Student ID</TableHead><TableHead>Student Name</TableHead><TableHead>Course</TableHead><TableHead>Batch</TableHead></TableRow></TableHeader>
   <TableBody>{trainerVisibleStudents.map(({student,batch,course})=><TableRow key={`${batch.id}:${student.id}`}><TableCell>{student.data.studentId||'—'}</TableCell><TableCell><strong>{student.name}</strong></TableCell><TableCell>{course?.data.name||'—'}</TableCell><TableCell>{batch.data.name}</TableCell></TableRow>)}</TableBody></Table>}
 </section>}
 {active === 'students' && role === 'trainer' && <section className="panel" style={{padding:20,marginTop:14}}>
   <div className="panel-heading"><div><h2>Module completion sign-off</h2><p>Complete a module only after recorded class attendance and learning criteria have been reviewed. This is separate from daily attendance.</p></div></div>
   <div className="record-toolbar" style={{display:'flex',gap:10,flexWrap:'wrap'}}>
     <Pick label="Choose student" value={moduleStudent} onChange={setModuleStudent} options={[...new Map(trainerEnrollmentRows.map(e=>[e.student.id,{value:e.student.id,label:`${e.student.name} (${e.student.data.studentId})`}])).values()]}/>
     <Pick label="Choose taught module" value={moduleId} onChange={setModuleId} options={items(data,'subcourses').filter(m=>trainerBatches.some(b=>b.data.subcourseId===m.id)).map(m=>({value:m.id,label:m.data.name}))}/>
     <Input style={{maxWidth:350}} aria-label="Learning assessment evidence" value={moduleEvidence} onChange={e=>setModuleEvidence(e.target.value)} placeholder="Learning evidence / assessment passed"/>
     <Button disabled={saving||!moduleStudent||!moduleId||moduleEvidence.trim().length<12} onClick={async()=>{const result=await mutate({op:'completeModule',studentId:moduleStudent,subcourseId:moduleId,criteriaNote:moduleEvidence},'Module marked completed with audit trail.');if(result)setModuleEvidence('');}}>Approve module completion</Button>
   </div>
 </section>}
 {active === 'batches' && role === 'admin' && <section className="panel table-panel">
   <div className="panel-heading"><div><h2>Full batch schedule and capacity</h2><p>Each batch is one continuous course schedule. Weekday = Monday–Friday, Weekend = Saturday–Sunday. Enrollment is confirmed by first verified attendance.</p></div></div>
   {!items(data,'batches').length ? <NoData title="No batches yet" detail="Create a batch and set its capacity, trainer, teaching module, dates and daily times."/> :
   <Table><TableHeader><TableRow><TableHead>Batch / Course</TableHead><TableHead>Teaching module</TableHead><TableHead>Days</TableHead><TableHead>Date range</TableHead><TableHead>Class time</TableHead><TableHead>Enrollment</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>
   {items(data,'batches').filter(r=>!filter||batchCourseIds(r).includes(filter)).map(r=><TableRow key={r.id}>
     <TableCell><strong>{r.data.name}</strong><small className="cell-small">{batchCourseNames(data,r)} · {labelOf(data,r.data.trainerId)}</small></TableCell>
     <TableCell>{labelOf(data,r.data.subcourseId)}</TableCell><TableCell>{r.data.batchType||'Weekday'}</TableCell>
     <TableCell>{r.data.startDate} – {r.data.endDate||'Not set'}</TableCell>
     <TableCell>{r.data.dailyStartTime||'—'} – {r.data.dailyEndTime||'—'}<small className="cell-small">{r.data.classDurationMinutes||0} min</small></TableCell>
     <TableCell><strong>{r.data.studentCount||0} / {r.data.capacity||45}</strong><small className="cell-small">Waiting: {r.data.waitingCount||0}</small></TableCell>
     <TableCell><Badge value={r.data.batchStatus||r.data.status}/></TableCell>
     <TableCell><div className="row-actions"><Button variant="outline" size="sm" onClick={()=>setViewing(r)}>View</Button><Button variant="ghost" size="icon" aria-label="Edit batch" onClick={()=>setEditor({kind:'batches',row:r})}><Pencil size={16}/></Button><Button variant="ghost" size="icon" aria-label="Delete batch" onClick={()=>setDeleting(r)}><Trash2 size={16}/></Button></div></TableCell>
   </TableRow>)}</TableBody></Table>}
 </section>}
 {active === 'batches' && role === 'trainer' && <section className="panel table-panel">
   {!trainerBatches.length ? <NoData title="No assigned batches" detail="Ask Admin to assign a batch and its teaching subcourse." icon={Boxes}/> :
   <Table><TableHeader><TableRow><TableHead>Batch Name</TableHead><TableHead>Course (Subcourse)</TableHead><TableHead>Start Date</TableHead><TableHead>Total Students Enrolled</TableHead></TableRow></TableHeader><TableBody>
     {trainerBatches.map(batch=>{const n=Number(batch.data.studentCount)||0;const topic=items(data,'subcourses').find(s=>s.id===batch.data.subcourseId);return <TableRow key={batch.id}><TableCell><strong>{batch.data.name} ({n} Students)</strong><div className="caption">{batch.data.batchStatus||batch.data.status} · {batch.data.courseDurationDays||'—'} days · {batch.data.dailyStartTime||'—'}–{batch.data.dailyEndTime||'—'} ({batch.data.classDurationMinutes||'—'} min)</div><small>{sessions.filter(s=>s.data.batchId===batch.id&&['Completed','Auto-Closed'].includes(s.data.sessionStatus)).length} completed · {sessions.filter(s=>s.data.batchId===batch.id&&s.data.sessionStatus==='Upcoming').length} upcoming</small></TableCell><TableCell>{topic?.data.name||'Subcourse not assigned'}</TableCell><TableCell>{batch.data.startDate ? String(batch.data.startDate).split('-').reverse().join('-') : '—'}</TableCell><TableCell><div><strong>{n} / {batch.data.capacity || 45}</strong></div><small>Waiting: {batch.data.waitingCount||0}</small><div><Button size="sm" variant="outline" onClick={()=>{setEditingBatch(batch);setBatchDraft({endDate:batch.data.endDate||'',dailyStartTime:batch.data.dailyStartTime||'',dailyEndTime:batch.data.dailyEndTime||'',batchType:batch.data.batchType||'Weekday',capacity:Number(batch.data.capacity||45)});}}>Edit batch settings</Button></div></TableCell></TableRow>;})}
   </TableBody></Table>}
 </section>}
 {active === 'schedules' && role === 'trainer' && <section className="panel table-panel trainer-sessions">
   <div className="panel-heading schedule-view-heading">
     <div><h2>{showFullSchedule ? 'My full class schedule' : "Today's class sessions"}</h2>
       <p>{showFullSchedule ? `All ${sessions.length} assigned sessions · ${tz}` : `${today} · ${displayedSessions.length} sessions · ${tz}`} · Refreshes automatically.</p>
     </div>
     <Button variant="outline" onClick={() => setShowFullSchedule(v => !v)}>
       <CalendarDays size={16}/>{showFullSchedule ? "Back to Today's Schedule" : 'View Full Schedule'}
     </Button>
   </div>
   {!displayedSessions.length ? <NoData title={showFullSchedule ? 'No assigned class sessions' : 'No classes scheduled today'} detail={showFullSchedule ? 'Ask Admin to schedule your batch and daily class times.' : 'You have no classes today. Select View Full Schedule to see previous and upcoming sessions.'} icon={CalendarDays}/> :
   <div className="session-card-grid">{displayedSessions.map(session=>{
     const x=session.data;
     const deadline=x.effectiveDeadline||x.endAt;
     const status=x.sessionStatus || (Date.parse(data.serverTime)>=Date.parse(x.endAt) ? 'Completed' : x.sessionOpen ? 'In Progress':'Upcoming');
     const remaining=Math.max(0,Math.ceil((Date.parse(deadline)-Date.parse(data.serverTime))/60000));
     const started=status==='In Progress';
     const canStart=status==='Upcoming' && Date.parse(data.serverTime)>=Date.parse(x.startAt)-900000 && Date.parse(data.serverTime)<Date.parse(x.endAt);
     const matches=data.attendance.filter(a=>a.scheduleId===session.id);
     const present=matches.filter(a=>['Present','Late'].includes(a.status)).length;
     return <article className="session-card" key={session.id}>
       <div className="row-actions"><strong>{x.name}</strong><Badge value={status}/>{instituteDate(x.startAt,tz)===today && <Badge value="Today"/>}</div>
       <p><strong>Batch:</strong> {labelOf(data,x.batchId)}</p>
       <p><strong>Teaching:</strong> {labelOf(data,items(data,'batches').find(b=>b.id===x.batchId)?.data.subcourseId || x.courseId)}</p>
       <p><strong>Planned:</strong> {displayTime(x.startAt,tz)} – {displayTime(x.endAt,tz)}</p>
       <p><strong>Deadline:</strong> {displayTime(deadline,tz)} {Number(x.extensionMinutes)>0 ? `(+${x.extensionMinutes} min)` : ''}</p>
       <p><strong>Actual:</strong> {x.actualStartAt ? displayTime(x.actualStartAt,tz) : 'Not started'} – {x.actualEndAt ? displayTime(x.actualEndAt,tz) : '—'}</p>
       <p><strong>Remaining:</strong> {started ? `${remaining} minutes` : '—'} · <strong>Present/Late:</strong> {present} · <strong>Recorded:</strong> {matches.length}</p><p><strong>Extension history:</strong> {Array.isArray(x.extensions)&&x.extensions.length ? x.extensions.map((e:any)=>`+${e.minutes} min`).join(', ') : 'None'}{x.closureReason ? ` · ${x.closureReason}` : ''}</p>
       <div className="row-actions">
         {canStart && <Button size="sm" onClick={()=>void mutate({op:'openSession',id:session.id},'Session started.')} disabled={saving}>Start class</Button>}
         {started && <><Button size="sm" variant="outline" onClick={()=>void mutate({op:'extendSession',id:session.id,minutes:15,requestId:crypto.randomUUID()},'Extended by 15 minutes.')} disabled={saving}>+15 min</Button>
           <Button size="sm" variant="outline" onClick={()=>void mutate({op:'extendSession',id:session.id,minutes:30,requestId:crypto.randomUUID()},'Extended by 30 minutes.')} disabled={saving}>+30 min</Button>
           <Button size="sm" variant="destructive" onClick={()=>void mutate({op:'closeSession',id:session.id},'Session completed.')} disabled={saving}>End class</Button></>}
         <Button size="sm" variant="outline" onClick={()=>{setSelectedSession(session.id);setActive('live');}}>Daily attendance</Button>
       </div>
     </article>;
   })}</div>}
 </section>}
 {active === 'schedules' && role === 'admin' &&
   <section className="panel schedule-view-bar">
     <div>
       <h2>{showFullSchedule ? 'Full schedule · All trainers' : "Today's schedule · All trainers"}</h2>
       <p>{showFullSchedule ? `Previous, current and upcoming sessions · ${sessions.length} total` : `${today} · ${todays.length} classes today`} · {tz}</p>
     </div>
     <Button variant="outline" onClick={() => setShowFullSchedule(v => !v)}>
       <CalendarDays size={16}/>{showFullSchedule ? "Back to Today's Schedule" : 'View Full Schedule'}
     </Button>
   </section>}
 {recordDef && active !== 'courses' && !(role === 'admin' && active === 'batches') && !(role === 'student' && active === 'students') && !(role === 'trainer' && ['students', 'batches', 'bookings', 'schedules'].includes(active)) && <><div className="record-toolbar"><div className="search-field"><Search size={17}/><Input value={search} onChange={e => setSearch(e.target.value)} placeholder={`Search ${recordDef.label.toLowerCase()}…`} aria-label={`Search ${recordDef.label.toLowerCase()}`}/></div>{['students', 'batches'].includes(active) && <Pick value={filter} onChange={setFilter} label="All courses" options={items(data, 'courses').map(r => ({ value: r.id, label: r.data.name }))}/>}<span className="record-count">{filteredItems.length} {filteredItems.length === 1 ? 'record' : 'records'}</span></div><section className="panel table-panel">{!filteredItems.length ? <NoData title={active === 'schedules' && !showFullSchedule ? 'No classes scheduled today' : search ? 'No matching records' : `No ${recordDef.label.toLowerCase()} yet`} detail={active === 'schedules' && !showFullSchedule ? 'Select View Full Schedule to browse previous and upcoming classes.' : canCreate ? 'Add your first record using the button above.' : 'Your institute will add records here.'}/> : active === 'notifications' && role !== 'admin' ? filteredItems.map(r => <article className="announcement" key={r.id}><span className="announcement-date">{displayTime(r.createdAt, tz)}</span><h3>{r.data.title}</h3><p>{r.data.body}</p></article>) : <Table><TableHeader><TableRow>{['leaves', 'bookings'].includes(active) && <TableHead>Requested by</TableHead>}{recordDef.fields.filter(f => f.key === 'reason' || !['textarea', 'tel'].includes(f.type || '')).slice(0, 5).map(f => <TableHead key={f.key}>{f.label.replace(' (institute time)', '')}</TableHead>)}{['leaves', 'bookings'].includes(active) && <TableHead>Status</TableHead>}<TableHead className="action-cell">Actions</TableHead></TableRow></TableHeader><TableBody>{filteredItems.map(row => <TableRow key={row.id}>{['leaves', 'bookings'].includes(active) && <TableCell><strong>{labelOf(data, row.data.memberId)}</strong></TableCell>}{recordDef.fields.filter(f => f.key === 'reason' || !['textarea', 'tel'].includes(f.type || '')).slice(0, 5).map((f, i) => <TableCell key={f.key}>{i === 0 && ['students', 'trainers'].includes(active) ? <div className="person-cell"><span className="avatar mini">{initials(row.data.name)}</span><div><strong>{row.data.name}</strong><small>{row.data.studentId || row.data.specialty}</small></div></div> : cellValue(data, row, f)}</TableCell>)}{['leaves', 'bookings'].includes(active) && <TableCell><Badge value={row.data.status}/></TableCell>}<TableCell className="action-cell"><div className="row-actions"><Button variant="ghost" size="sm" onClick={() => setViewing(row)}>View</Button>{active === 'schedules' && role !== 'student' && <Button variant="outline" size="sm" onClick={() => void startSession(row)} disabled={saving || Date.parse(data.serverTime) < Date.parse(row.data.startAt) - 900000 || Date.parse(data.serverTime) >= Date.parse(row.data.endAt)}><QrCode size={15}/>Scan students</Button>}{active === 'schedules' && role === 'admin' && !['Completed','Auto-Closed','Cancelled'].includes(row.data.sessionStatus) && <Button size="sm" variant="outline" disabled={saving} onClick={() => void mutate({op:'cancelSession',id:row.id},'Class cancelled.')}>Cancel class</Button>}{['leaves', 'bookings'].includes(active) && role !== 'student' && row.data.memberId !== data.me.id && (role === 'admin' || data.members.some(m => m.id === row.data.memberId && m.role === 'student')) && (active !== 'leaves' || !row.data.recipientId || (Array.isArray(row.data.recipientIds) && row.data.recipientIds.length ? row.data.recipientIds : [row.data.recipientId]).includes(role === 'admin' ? 'admin' : data.me.id)) && row.data.status === 'Pending' && <><Button variant="outline" size="sm" onClick={() => void mutate({ op: 'review', id: row.id, status: 'Approved' }, 'Request approved.')} disabled={saving}><Check size={15}/>Approve</Button><Button variant="ghost" size="icon" aria-label="Reject request" onClick={() => void mutate({ op: 'review', id: row.id, status: 'Rejected' }, 'Request rejected.')} disabled={saving}><X size={16}/></Button></>}{canEdit && (role !== 'trainer' || active !== 'holidays' || row.data.createdByMemberId === data.me.id) && <Button variant="ghost" size="icon" aria-label={`Edit ${row.data.name || recordDef.singular}`} onClick={() => setEditor({ kind: active, row })}><Pencil size={16}/></Button>}{(role === 'admin' || role === 'trainer' && active === 'holidays' && row.data.createdByMemberId === data.me.id) && <Button variant="ghost" size="icon" aria-label={`Delete ${recordDef.singular}`} onClick={() => setDeleting(row)}><Trash2 size={16}/></Button>}</div></TableCell></TableRow>)}</TableBody></Table>}</section></>}
 {active === 'live' && <><section className="panel live-panel"><div className="panel-heading"><div><h2>Class attendance</h2><p>Showing classes for {liveDate} · {tz} · refreshes every 45 seconds</p></div><div className="live-date-controls">{role !== 'student' && <><label htmlFor="class-attendance-date">Attendance date</label><Input id="class-attendance-date" type="date" value={liveDate} onChange={e => { setChosenLiveDate(e.target.value); setSelectedSession(''); }} aria-label="Attendance date"/><Button type="button" variant="outline" onClick={() => { setChosenLiveDate(''); setSelectedSession(''); }}>Today</Button></>}<Pick label="Select class" value={effectiveSession?.id || ''} onChange={setSelectedSession} options={liveSessions.map(r => ({ value: r.id, label: `${r.data.name} · ${displayTime(r.data.startAt, tz)}` }))}/></div></div>{!effectiveSession ? <NoData title={liveLoading ? 'Loading selected date' : 'No classes scheduled for this date'} detail={liveLoading ? 'Fetching attendance from the server…' : 'Choose another date or return to today.'} icon={Radio}/> : <><div className="session-summary"><div><strong>{effectiveSession.data.name}</strong><p>{labelOf(data, effectiveSession.data.batchId)} · {displayTime(effectiveSession.data.startAt, tz)} – {displayTime(effectiveSession.data.endAt, tz)}</p></div><div className="row-actions"><Badge value={effectiveSession.data.sessionOpen && Date.parse(effectiveSession.data.effectiveDeadline || effectiveSession.data.endAt) > Date.parse(data.serverTime) ? 'Open' : 'Closed'}/>{role !== 'student' && effectiveSession.data.sessionStatus === 'Upcoming' && <Button variant="outline" disabled={saving} onClick={() => void mutate({ op: 'openSession', id: effectiveSession.id }, 'Session started.')}>Start class</Button>}{role !== 'student' && effectiveSession.data.sessionOpen && <Button variant="outline" disabled={saving} onClick={() => void mutate({ op: 'closeSession', id: effectiveSession.id }, 'Session completed and students checked out.')}>Close attendance</Button>}</div></div>{role !== 'student' && <TrainerQRScanner key={effectiveSession.id} session={effectiveSession} serverTime={data.serverTime} onAction={input => mutate(input, undefined, true)}/>}<Table><TableHeader><TableRow><TableHead>Student</TableHead><TableHead>Status</TableHead><TableHead>Check-in</TableHead><TableHead>Check-out</TableHead><TableHead>Method</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{students.filter(m => (Array.isArray(effectiveSession.data.roster) ? effectiveSession.data.roster.includes(m.id) : m.data.batchId === effectiveSession.data.batchId) && m.status === 'Active').map(m => { const a = liveAttendance.find(a => a.memberId === m.id && a.scheduleId === effectiveSession.id), r = derived.find(r => r.student.id === m.id && r.session.id === effectiveSession.id); return <TableRow key={m.id}><TableCell><div className="person-cell"><span className="avatar mini">{initials(m.name)}</span><div><strong>{m.name}</strong><small>{m.data.studentId}</small></div></div></TableCell><TableCell><Badge value={a?.status || r?.status || 'Awaiting check-in'}/></TableCell><TableCell>{a?.checkedIn ? displayTime(a.checkedIn, tz) : '—'}</TableCell><TableCell>{a?.checkedOut ? displayTime(a.checkedOut, tz) : a?.checkedIn ? <Badge value="Inside"/> : '—'}</TableCell><TableCell>{a?.method || '—'}</TableCell><TableCell>{role === 'student' && a?.checkedIn && !a.checkedOut ? <Button size="sm" variant="outline" disabled={saving} onClick={() => void mutate({ op: 'checkout', id: effectiveSession.id }, 'You have checked out.')}>Check out</Button> : role !== 'student' ? <Button size="sm" variant="outline" onClick={() => { setMarking({ memberId: m.id, sessionId: effectiveSession.id }); setMarkStatus(role === 'trainer' ? 'Absent' : a?.status || 'Present'); setMarkNote(''); }}>{role === 'trainer' ? 'Record absence' : 'Correct attendance'}</Button> : '—'}</TableCell></TableRow>; })}</TableBody></Table><div className="table-footnote">Check-in opens up to 15 minutes before class. The Worker closes active sessions at the effective deadline, including approved extensions.</div></>}</section></>}
 {active === 'reports' && <><div className="report-summary">{['Present', 'Late', 'Absent', 'Excused'].map(s => <div key={s}><Badge value={s}/><strong>{reportFiltered.filter(r => r.status === s).length}</strong></div>)}</div><div className="record-toolbar report-filters"><div className="search-field"><Search size={17}/><Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search student or class…" aria-label="Search attendance"/></div><label>From<Input type="date" value={reportFrom} onChange={e => setReportFrom(e.target.value)} aria-label="Report from date"/></label><label>To<Input type="date" value={reportTo} onChange={e => setReportTo(e.target.value)} aria-label="Report to date"/></label><Pick value={filter} onChange={setFilter} label="All courses" options={items(data, 'courses').map(c => ({ value: c.id, label: c.data.name }))}/></div><section className="panel table-panel">{!reportFiltered.length ? <NoData title="No attendance to show" detail="Records will appear when students are enrolled in scheduled classes." icon={ChartNoAxesCombined}/> : <Table><TableHeader><TableRow><TableHead>Student</TableHead><TableHead>Class</TableHead><TableHead>Date</TableHead><TableHead>Batch</TableHead><TableHead>Status</TableHead><TableHead>Check-in</TableHead><TableHead>Check-out</TableHead></TableRow></TableHeader><TableBody>{reportFiltered.map(r => <TableRow key={r.student.id + r.session.id}><TableCell><strong>{r.student.name}</strong><small className="cell-small">{r.student.data.studentId}</small></TableCell><TableCell>{r.session.data.name}</TableCell><TableCell>{r.day}</TableCell><TableCell>{r.batch?.data.name || '—'}</TableCell><TableCell><Badge value={r.status}/></TableCell><TableCell>{r.attendance?.checkedIn ? displayTime(r.attendance.checkedIn, tz) : '—'}</TableCell><TableCell>{r.attendance?.checkedOut ? displayTime(r.attendance.checkedOut, tz) : '—'}</TableCell></TableRow>)}</TableBody></Table>}<div className="table-footnote">Approved leave is excused. Holidays and classes before enrollment are excluded. Future classes are marked scheduled.</div></section></>}
 {active === 'audit' && role === 'admin' && <section className="panel table-panel">{!data.audits.length ? <NoData title="No changes yet" detail="Changes will be recorded with their time and author." icon={ScrollText}/> : <Table><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Author</TableHead><TableHead>Action</TableHead><TableHead>Details</TableHead></TableRow></TableHeader><TableBody>{data.audits.map(a => <TableRow key={a.id}><TableCell>{displayTime(a.created_at, tz)}</TableCell><TableCell>{a.actor}</TableCell><TableCell><Badge value={a.action}/></TableCell><TableCell>{a.detail}</TableCell></TableRow>)}</TableBody></Table>}</section>}
 {active === 'settings' && role === 'admin' && <SettingsPanel data={data} mutate={mutate} saving={saving}/>}
 <footer className="workspace-footer"><span>{data.settings.name}</span><span><ShieldCheck size={13}/>Protected institute workspace</span></footer></main></SidebarInset>
 <Dialog open={credentials.length>0} onOpenChange={open=>{if(!open)setCredentials([]);}}><DialogContent className="record-dialog"><DialogHeader><DialogTitle>Generated temporary login credentials</DialogTitle><DialogDescription>Copy or download now. Passwords are not stored in the app and cannot be displayed again. Send privately to each user.</DialogDescription></DialogHeader><div style={{maxHeight:340,overflow:'auto'}}>{credentials.slice(0,15).map((entry,i)=><div key={i} style={{padding:10,borderBottom:'1px solid #ddd',overflowWrap:'anywhere'}}><strong>{entry.name} ({entry.role})</strong><p>Login ID: {entry.loginId||entry.email}</p><p>Email: {entry.email}</p><p>Temporary password: <code>{entry.temporaryPassword}</code></p></div>)}{credentials.length>15&&<p>{credentials.length-15} more credentials are available in the download.</p>}</div><DialogFooter><Button variant="outline" onClick={()=>setCredentials([])}>I saved these — close</Button><Button onClick={()=>downloadCsv('studenthub-credentials.csv',[['Name','Role','Login ID','Email','Temporary Password'],...credentials.map(c=>[c.name,c.role,c.loginId||'',c.email,c.temporaryPassword])])}><Download size={16}/>Download credentials CSV</Button></DialogFooter></DialogContent></Dialog>
 <RecordEditor editor={editor} data={data} saving={saving} onClose={() => setEditor(null)} onSave={async (input) => { const saved=await mutate(input, 'Record saved.');
        if(saved){setEditor(null);
          if(input.op==='create'&&['students','trainers'].includes(input.kind)){
            try{const account=await apiPost<{credential:Credential}>('/api/accounts',{memberId:saved.id});setCredentials([account.credential]);void refresh();}
            catch(e){toast.error('Record saved, but login generation failed: '+(e instanceof Error?e.message:'Unknown error')+'. Retry in Account Logins.');}
          }
        } }}/>
 <Dialog open={!!editingBatch} onOpenChange={open=>{if(!open)setEditingBatch(null);}}>
 <DialogContent className="record-dialog"><DialogHeader><DialogTitle>Teaching batch settings</DialogTitle><DialogDescription>Change the schedule and capacity for your assigned batch. Started classes and attendance history remain unchanged.</DialogDescription></DialogHeader>
 {editingBatch && <form className="batch-settings-form" onSubmit={async(e)=>{e.preventDefault();const result=await mutate({op:'updateBatchSchedule',batchId:editingBatch.id,...batchDraft},'Batch schedule saved.');if(result)setEditingBatch(null);}}>
 <label>Batch ending date<Input required type="date" value={batchDraft.endDate} onChange={e=>setBatchDraft(v=>({...v,endDate:e.target.value}))}/></label>
 <label>Class days<Pick value={batchDraft.batchType} label="Weekday or Weekend" onChange={v=>setBatchDraft(o=>({...o,batchType:v}))} options={[{value:'Weekday',label:'Weekday (Mon–Fri)'},{value:'Weekend',label:'Weekend (Sat–Sun)'}]}/></label>
 <label>Class starts<Input type="time" required value={batchDraft.dailyStartTime} onChange={e=>setBatchDraft(v=>({...v,dailyStartTime:e.target.value}))}/></label>
 <label>Class ends<Input type="time" required value={batchDraft.dailyEndTime} onChange={e=>setBatchDraft(v=>({...v,dailyEndTime:e.target.value}))}/></label>
 <label>Maximum capacity (at least current enrollment)<Input type="number" min={1} max={1000} required value={batchDraft.capacity} onChange={e=>setBatchDraft(v=>({...v,capacity:Number(e.target.value)}))}/></label>
 <DialogFooter><Button type="button" variant="outline" onClick={()=>setEditingBatch(null)}>Cancel</Button><Button type="submit" disabled={saving}>Save batch settings</Button></DialogFooter></form>}
 </DialogContent></Dialog>
 <Dialog open={!!viewing} onOpenChange={open => { if (!open)
        setViewing(null); }}><DialogContent className="record-dialog"><DialogHeader><DialogTitle>{viewing?.data.name || viewing?.data.title || definitions[viewing?.kind || '']?.singular}</DialogTitle><DialogDescription>Saved institute record · {viewing ? displayTime(viewing.createdAt, tz) : ''}</DialogDescription></DialogHeader>{viewing && <dl className="record-details">{definitions[viewing.kind].fields.map(f => <div key={f.key}><dt>{f.label}</dt><dd>{viewing.kind==='batches' && f.key==='courseId' ? batchCourseNames(data,viewing) : f.key==='recipientId' ? (Array.isArray(viewing.data.recipientIds) && viewing.data.recipientIds.length ? viewing.data.recipientIds : viewing.data.recipientId ? [viewing.data.recipientId] : []).map((id: string) => id === 'admin' ? 'Administrator' : labelOf(data,id)).join(', ') || '—' : f.relation ? labelOf(data, viewing.data[f.key]) : f.type === 'datetime-local' ? displayTime(viewing.data[f.key], tz) : String(viewing.data[f.key] ?? '') || '—'}</dd></div>)}{viewing.data.status && ['leaves', 'bookings'].includes(viewing.kind) && <div><dt>Review status</dt><dd><Badge value={viewing.data.status}/>{viewing.data.reviewedBy && <span> · {viewing.data.reviewedBy}</span>}</dd></div>}</dl>}{viewing?.kind==='students' && role==='admin' && <StudentProgressDetails data={data} studentId={viewing.id} saving={saving} onComplete={async(subcourseId,note)=>!!await mutate({op:'completeModule',studentId:viewing.id,subcourseId,criteriaNote:note},'Student module marked Completed.')}/>}<DialogFooter><Button variant="outline" onClick={() => setViewing(null)}>Close</Button></DialogFooter></DialogContent></Dialog>
 <AlertDialog open={!!deleting} onOpenChange={open => { if (!open) { setDeleting(null); setDeleteConfirmation(''); } }}><AlertDialogContent className="admin-delete-dialog"><AlertDialogHeader><AlertDialogTitle>{deleting && ['students', 'trainers'].includes(deleting.kind) ? 'Manage this account' : 'Delete this record?'}</AlertDialogTitle><AlertDialogDescription>{deleting && ['students', 'trainers'].includes(deleting.kind) ? 'Deactivate to disable sign-in while preserving attendance history. Permanently delete only accounts without historical attendance, past class rosters, batches, enrollments, placements or other linked records. Permanent deletion also removes their Supabase login.' : 'Permanently delete this record? Courses, classes, rooms and other records still in use cannot be deleted. Reassign or remove dependent records first.'}</AlertDialogDescription></AlertDialogHeader>{deleting && <label className="delete-confirm-label">To delete an unlinked account, type DELETE. To delete the selected record and ALL linked classes, attendance and other records, type DELETE ALL RELATED DATA. This cannot be undone.<Input aria-label="Type DELETE to confirm permanent account deletion" value={deleteConfirmation} onChange={e => setDeleteConfirmation(e.target.value)} placeholder="DELETE" autoComplete="off"/></label>}<AlertDialogFooter><AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>{deleting && ['students', 'trainers'].includes(deleting.kind) && <Button type="button" variant="destructive" disabled={saving || deleteConfirmation !== 'DELETE'} onClick={() => void doPermanentDelete()}>Delete permanently</Button>}{deleting && <Button type="button" variant="destructive" disabled={saving || deleteConfirmation !== 'DELETE ALL RELATED DATA'} onClick={() => void doForceDelete()}>Delete with linked data</Button>}<AlertDialogAction onClick={e => { e.preventDefault(); void doDelete(); }} disabled={saving}>{deleting && ['students', 'trainers'].includes(deleting.kind) ? 'Deactivate account' : 'Delete record'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
 <Dialog open={!!marking} onOpenChange={o => { if (!o)
        setMarking(null); }}><DialogContent><DialogHeader><DialogTitle>Mark attendance</DialogTitle><DialogDescription>{marking ? labelOf(data, marking.memberId) : ''} · A reason is required for manual changes.</DialogDescription></DialogHeader><form onSubmit={async (e) => { e.preventDefault(); if (marking && await mutate({ op: 'mark', scheduleId: marking.sessionId, memberId: marking.memberId, status: markStatus, note: markNote }, 'Attendance updated.'))
        setMarking(null); }} className="form-grid"><label>Status<Pick value={markStatus} onChange={setMarkStatus} label="Choose status" options={(role === 'trainer' ? ['Absent', 'Excused'] : ['Present', 'Late', 'Absent', 'Excused']).map(s => ({ value: s, label: s }))}/></label><label>Reason<Textarea value={markNote} onChange={e => setMarkNote(e.target.value)} required maxLength={1000}/></label><Button type="submit" disabled={saving}>Save attendance</Button></form></DialogContent></Dialog><Toaster position="top-right" theme="light"/></SidebarProvider>;
}
function RecordEditor({ editor, data, saving, onClose, onSave }: {
    editor: {
        kind: string;
        category?: 'Placement';
        courseId?: string;
        row?: Row;
    } | null;
    data: HubData;
    saving: boolean;
    onClose: () => void;
    onSave: (input: any) => Promise<void>;
}) { const [draft, setDraft] = useState<Record<string, any>>({}), [error, setError] = useState(''); useEffect(() => { if (!editor)
    return; const def = definitions[editor.kind]; const next: Record<string, any> = {}; for (const f of def.fields) {
    let v = editor.row?.data[f.key] ?? (f.key === 'category' && editor.category ? editor.category : f.key === 'courseId' && editor.courseId ? editor.courseId : (f.options?.[0] || ''));
    if (!editor.row && editor.kind==='batches') {
        const now=new Date();
        const date=now.toLocaleDateString('en-CA',{timeZone:data.settings.timeZone});
        if (f.key==='startDate') v=date;
        if (f.key==='endDate') { const end=new Date(date+'T00:00:00Z'); end.setUTCDate(end.getUTCDate()+30); v=end.toISOString().slice(0,10); }
        if (f.key==='batchType') v='Weekday';
        if (f.key==='capacity') v=45;
        if (f.key==='dailyStartTime') v='14:00';
        if (f.key==='dailyEndTime') v='16:00';
    }
    if (f.type === 'datetime-local' && v)
        v = isoToLocalInput(v, data.settings.timeZone);
    next[f.key] = v;
}
// Existing single-recipient leave requests stay compatible. New requests
// start with Administrator selected and support multiple assigned trainers.
if (editor.kind === 'leaves') {
    next.recipientIds = data.me.role === 'trainer' ? ['admin']
        : Array.isArray(editor.row?.data.recipientIds) && editor.row.data.recipientIds.length
            ? [...editor.row.data.recipientIds] : [next.recipientId || 'admin'];
    next.recipientId = next.recipientIds[0];
}
if (editor.kind === 'batches') next.courseIds = editor.row ? batchCourseIds(editor.row) : next.courseId ? [next.courseId] : [];
setDraft(next); setError(''); }, [editor, data.settings.timeZone]); const def = editor ? definitions[editor.kind] : null; const save = async (e: React.FormEvent) => { e.preventDefault(); if (!editor || !def)
    return; const next = { ...draft }; try {
    for (const f of def.fields) {
        if (f.required && !next[f.key])
            throw new Error(`${f.label} is required.`);
        if (f.type === 'datetime-local' && next[f.key])
            next[f.key] = localInputToISO(next[f.key], data.settings.timeZone);
    }
    if (editor.kind === 'leaves') {
        const selected: string[] = Array.isArray(next.recipientIds) ? next.recipientIds : [];
        if (!selected.length) throw new Error('Select at least one recipient (Administrator or an assigned Trainer).');
        next.recipientId = selected[0]; // Backward-compatible single-recipient field
        next.recipientIds = selected;
    }
    if (editor.kind === 'batches') {
        const selected: string[] = Array.isArray(next.courseIds) ? next.courseIds : [];
        if (!selected.length) throw new Error('Select at least one course for this batch.');
        next.courseIds = selected;
        next.courseId = selected.includes(next.courseId) ? next.courseId : selected[0];
    }
    if (editor.kind === 'holidays' && data.me.role === 'trainer' && !next.batchId) throw new Error('Select your assigned batch.');
    setError('');
    await onSave({ op: editor.row ? 'update' : 'create', kind: editor.kind, id: editor.row?.id, data: next });
}
catch (e) {
    setError(e instanceof Error ? e.message : 'Check your form.');
} }; return <Dialog open={!!editor} onOpenChange={o => { if (!o && !saving)
    onClose(); }}><DialogContent className="record-dialog"><DialogHeader><DialogTitle>{editor?.row ? 'Edit' : 'Add'} {def?.singular.toLowerCase()}</DialogTitle><DialogDescription>{def?.description}{editor?.kind === 'courses' && ' Examples: Full Stack, Data Analytics, Cloud Computing.'}{editor?.kind === 'schedules' && ` Times are in ${data.settings.timeZone}.`}</DialogDescription></DialogHeader>{def && <form onSubmit={save} className="form-grid">{def.fields.map(f => { let options = f.relation ? relations(data, f) : f.options?.map(s => ({ value: s, label: s })); if (['students', 'enrollments'].includes(editor?.kind || '') && f.key === 'batchId' && draft.courseId)
    options = options?.filter(o => {
        const row = data.records.find(r => r.id === o.value);
        return row?.kind === 'batches' && batchCourseIds(row).includes(draft.courseId);
    }); if (['schedules', 'holidays'].includes(editor?.kind || '') && f.key === 'batchId' && data.me.role === 'trainer')
    options = options?.filter(o => data.records.find(r => r.id === o.value)?.data.trainerId === data.me.id);
    if (editor?.kind === 'batches' && f.key === 'subcourseId')
        options = options?.filter(o => (draft.courseIds || []).includes(data.records.find(r => r.id === o.value)?.data.courseId));
    if (editor?.kind === 'leaves' && f.key === 'recipientId') {
        const ownBatches = data.records.filter(r=>r.kind==='batches' &&
            (data.me.data.batchId===r.id || data.records.some(e=>e.kind==='enrollments' && e.data.studentId===data.me.id && e.data.batchId===r.id && e.data.status==='Active')));
        const trainerIds = new Set(ownBatches.map(b=>b.data.trainerId));
        const recipients = [{value:'admin',label:'Administrator'}, ...data.members.filter(m=>m.role==='trainer' && m.status==='Active' && trainerIds.has(m.id)).map(m=>({value:m.id,label:m.name}))];
        const selected: string[] = Array.isArray(draft.recipientIds) ? draft.recipientIds : [draft.recipientId || 'admin'];
        return <fieldset className="batch-courses-multi" key={f.key}>
            <legend>Send to <span className="required">*</span></legend>
            <p>Select one or more recipients. Any selected recipient can approve or reject; the first decision finalizes this request.</p>
            <div className="batch-course-options">{recipients.map(recipient => <label key={recipient.value}>
                <input type="checkbox" checked={selected.includes(recipient.value)} disabled={saving || (data.me.role==='trainer' && recipient.value==='admin')}
                    onChange={event => setDraft(old => {
                        const current: string[] = Array.isArray(old.recipientIds) ? old.recipientIds : [old.recipientId || 'admin'];
                        const updated = event.target.checked ? [...current, recipient.value] : current.filter(id => id !== recipient.value);
                        return {...old, recipientIds: updated, recipientId: updated[0] || ''};
                    })}/><span>{recipient.label}</span>
            </label>)}</div>
            {data.me.role === 'student' && recipients.length === 1 && <p>No assigned trainer is available yet. You can send the request to Administrator.</p>}
        </fieldset>;
    }
    if (editor?.kind === 'batches' && f.key === 'courseId') {
        const selected: string[] = Array.isArray(draft.courseIds) ? draft.courseIds : [];
        return <fieldset className="batch-courses-multi" key={f.key}><legend>Courses <span className="required">*</span></legend>
            <p>{data.me.role==='admin' ? 'Choose all programs whose students may attend this same teaching batch.' : 'Only Admin can create shared multi-course batches.'}</p>
            <div className="batch-course-options">{data.records.filter(r=>r.kind==='courses' && r.data.status!=='Inactive' && r.data.status!=='Archived').map(c=><label key={c.id}>
                <input type="checkbox" checked={selected.includes(c.id)} disabled={saving || (data.me.role==='trainer' && selected.length>0 && !selected.includes(c.id))} onChange={event=>setDraft(old=>{
                    const current: string[] = Array.isArray(old.courseIds) ? old.courseIds : [];
                    const updated = event.target.checked ? [...current,c.id] : current.filter(id=>id!==c.id);
                    const oldTopic = data.records.find(r=>r.id===old.subcourseId);
                    return {...old,courseIds:updated,courseId:updated.includes(old.courseId)?old.courseId:updated[0]||'',
                        subcourseId:oldTopic && !updated.includes(oldTopic.data.courseId)?'':old.subcourseId};
                })}/><span>{c.data.name}</span></label>)}</div>
        </fieldset>;
    }
    return <label key={f.key}>{f.label}{f.required && <span className="required"> *</span>}{options ? <Pick value={String(draft[f.key] ?? '')} onChange={v => setDraft(d => ({ ...d, [f.key]: v, ...f.key === 'courseId' ? { batchId: '' } : {} }))} label={f.required ? `Choose ${f.label.toLowerCase()}` : 'None'} options={options} disabled={saving}/> : f.type === 'textarea' ? <Textarea value={draft[f.key] ?? ''} onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))} required={f.required} maxLength={4000} disabled={saving}/> : <Input type={f.type || 'text'} value={draft[f.key] ?? ''} onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))} required={f.required} step={f.type === 'number' ? 'any' : undefined} maxLength={4000} disabled={saving}/>}</label>; })}{error && <div className="error-box" role="alert">{error}</div>}<DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? <Loader2 className="animate-spin"/> : <Check size={17}/>}Save {def.singular.toLowerCase()}</Button></DialogFooter></form>}</DialogContent></Dialog>; }
function SettingsPanel({ data, mutate, saving }: {
    data: HubData;
    mutate: (input: any, message?: string) => Promise<any>;
    saving: boolean;
}) { const [draft, setDraft] = useState(data.settings); return <div className="settings-grid"><section className="panel settings-panel"><div className="panel-heading"><div><h2>Institute preferences</h2><p>Applied to schedules, daily QR refresh, and attendance.</p></div></div><form className="form-grid" onSubmit={e => { e.preventDefault(); void mutate({ op: 'settings', ...draft }, 'Institute settings saved.'); }}><label>Institute name<Input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} required maxLength={100}/></label><label>Timezone<Input value={draft.timeZone} onChange={e => setDraft(d => ({ ...d, timeZone: e.target.value }))} required placeholder="Asia/Kolkata"/></label><label>Late after (minutes)<Input type="number" min={0} max={120} value={draft.lateMinutes} onChange={e => setDraft(d => ({ ...d, lateMinutes: e.target.value }))} required/></label><label>Attendance target (%)<Input type="number" min={0} max={100} value={draft.threshold} onChange={e => setDraft(d => ({ ...d, threshold: e.target.value }))} required/></label><Button type="submit" disabled={saving}>Save preferences</Button></form></section><section className="panel settings-panel"><div className="panel-heading"><div><h2>Bring your team in</h2><p>Each person gets the right workspace.</p></div><ShieldCheck size={22}/></div><ol className="access-steps"><li><strong>Add a trainer or student.</strong><p>Use their real email address and assign their course or batch. Their institute role is assigned here.</p></li><li><strong>Automatic login.</strong><p>New students and trainers receive an ID-based temporary password when their ID is at least 12 characters long; shorter IDs receive a secure random temporary password. Share credentials privately and use Account Logins to reset them.</p></li><li><strong>Ask them to sign in.</strong><p>Students display a personal daily QR. Trainers select an assigned class, and scan student QR codes for attendance.</p></li></ol><Button variant="outline" onClick={() => void navigator.clipboard.writeText(window.location.origin).then(() => toast.success('Portal link copied.')).catch(() => toast.error('Copy the portal address from your browser.'))}>Copy portal link</Button><div className="settings-note"><LockKeyhole size={17}/><p>Deactivate a student or trainer to stop their institute access while keeping their attendance history.</p></div></section></div>; }
