import { safeGoogleReviewUrl, studentBranchReview } from './google-review';
import { dailyQrWindow, newStudentQrToken, studentQrPayload } from './student-qr';
import { definitions, instituteDate, localInputToISO, type Member, type Row, type Role, type HubData } from './hub-types';
export class HubError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}
export type Identity = {
    userId: string;
    email: string;
    displayName: string;
};
const parseMember = (r: any): Member => ({ id: r.id, userId: r.user_id, email: r.email, name: r.name, role: r.role, status: r.status, data: JSON.parse(r.data), createdAt: r.created_at });
const parseRecord = (r: any): Row => ({ id: r.id, kind: r.kind, data: JSON.parse(r.data), createdAt: r.created_at });
export function createHub(db: D1Database, options: { now?: () => number; bootstrapAdminEmail?: string } = {}) {
    const clock = options.now || (() => Date.now());
    const canInitialize = (user: Identity) => { if (options.bootstrapAdminEmail !== undefined && user.email.toLowerCase() !== options.bootstrapAdminEmail.toLowerCase()) throw new HubError('The institute must be initialized by its configured administrator.', 403); };
    const first = async (sql: string, ...args: any[]) => db.prepare(sql).bind(...args).first<any>();
    const all = async (sql: string, ...args: any[]) => (await db.prepare(sql).bind(...args).all<any>()).results;
    const run = async (sql: string, ...args: any[]) => db.prepare(sql).bind(...args).run();
    const settings = async () => { const r = await first('SELECT data FROM settings WHERE id = ?', 'institute'); return r ? JSON.parse(r.data) : null; };
    const record = async (id: string, kind?: string) => { const r = await first('SELECT * FROM records WHERE id = ?', id); if (!r || kind && r.kind !== kind)
        throw new HubError('This record is no longer available.', 404); return parseRecord(r); };
    const audit = async (me: Member, action: string, detail: string) => run('INSERT INTO audits (id,actor,action,detail,created_at) VALUES (?,?,?,?,?)', crypto.randomUUID(), me.name, action, detail, new Date(clock()).toISOString());
    async function membership(user: Identity) { let row = await first('SELECT * FROM members WHERE user_id = ?', user.userId); if (!row) {
        const invited = await first('SELECT * FROM members WHERE email = ?', user.email.toLowerCase());
        if (invited && !invited.user_id && invited.status === 'Active') {
            await run('UPDATE members SET user_id = ? WHERE id = ? AND user_id IS NULL', user.userId, invited.id);
            row = await first('SELECT * FROM members WHERE user_id = ?', user.userId);
        }
    } if (!row)
        throw new HubError('Your account has not been added to this institute. Ask an administrator to add your institute account email.', 403); if (row.status !== 'Active')
        throw new HubError('Your institute account is inactive. Contact an administrator.', 403); return parseMember(row); }
    const admin = (me: Member) => { if (me.role !== 'admin')
        throw new HubError('Only administrators can make this change.', 403); };
    // A permanent account deletion is intentionally stricter than deactivation.
    // Keep attendance, past class rosters and referenced institute records intact.
    async function checkPermanentMemberDeletion(user: Identity, id: string): Promise<Member> {
        const operator = await membership(user);
        admin(operator);
        const row = await first("SELECT * FROM members WHERE id=? AND role IN ('student','trainer')", id);
        if (!row) throw new HubError('Student or trainer not found.', 404);
        const member = parseMember(row);
        if (await first('SELECT id FROM attendance WHERE member_id=? LIMIT 1', id))
            throw new HubError('This account has attendance history. Deactivate it instead of deleting.', 409);
        const linked = await first("SELECT id FROM records WHERE kind != 'student-qr' AND (json_extract(data,'$.studentId')=? OR json_extract(data,'$.trainerId')=? OR json_extract(data,'$.memberId')=?) LIMIT 1", id, id, id);
        if (linked) throw new HubError('This account is linked to enrollments, batches, leave, bookings or placements. Remove those links first, or deactivate the account.', 409);
        // Older classes must keep their historical enrollment snapshots.
        const previousClass = await first("SELECT r.id FROM records r, json_each(r.data,'$.roster') entry WHERE r.kind='schedules' AND entry.value=? AND json_extract(r.data,'$.startAt')<=? LIMIT 1", id, new Date(clock()).toISOString());
        if (previousClass) throw new HubError('This account belongs to a past or current class roster. Deactivate it to preserve reports.', 409);
        return member;
    }

    async function permanentlyDeleteMember(user: Identity, id: string) {
        const member = await checkPermanentMemberDeletion(user, id);
        const operator = await membership(user);
        const now = new Date(clock()).toISOString();
        const future = (await all("SELECT * FROM records WHERE kind='schedules' AND json_extract(data,'$.startAt')>?", now)).map(parseRecord);
        const updates = future.filter(r => Array.isArray(r.data.roster) && r.data.roster.includes(id)).map(r =>
            db.prepare('UPDATE records SET data=?,updated_at=? WHERE id=?').bind(JSON.stringify({ ...r.data, roster: r.data.roster.filter((memberId: string) => memberId !== id) }), now, r.id));
        await db.batch([
            ...updates,
            db.prepare("DELETE FROM records WHERE id=? AND kind='student-qr'").bind(`student-qr:${id}`),
            db.prepare("DELETE FROM members WHERE id=? AND role IN ('student','trainer')").bind(id),
            db.prepare('INSERT INTO audits (id,actor,action,detail,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), operator.name, 'Account permanently deleted', `${member.role} account removed`, now),
        ]);
        return { data: await load(operator) };
    }
    // Explicit destructive Admin action; normal deletion still protects linked history.
    // All D1 deletes, roster edits and audit entry are committed in one transaction.
    async function cascadeDelete(user: Identity, kind: string, id: string, confirmation: string) {
        const operator=await membership(user); admin(operator);
        if(confirmation!=='DELETE ALL RELATED DATA') throw new HubError('Type DELETE ALL RELATED DATA to confirm the irreversible deletion.',400);
        const rootIsMember=['students','trainers'].includes(kind);
        const member=rootIsMember ? await first('SELECT * FROM members WHERE id=? AND role=?',id,kind==='students'?'student':'trainer') : null;
        if(rootIsMember && !member) throw new HubError('The account no longer exists.',404);
        if(!rootIsMember) await record(id,kind);
        // The configured source records may be larger than the dashboard's result cap.
        const records=(await all('SELECT * FROM records')).map(parseRecord);
        const members=(await all('SELECT * FROM members')).map(parseMember);
        const toDelete=new Set<string>(rootIsMember?[]:[id]);
        const memberId=rootIsMember?id:null;
        const directKeys=['courseId','batchId','trainerId','studentId','memberId','branchId','roomId','scheduleId'];
        const isLinked=(r:Row)=>directKeys.some(key=>typeof r.data[key]==='string' && (toDelete.has(r.data[key]) || memberId===r.data[key]));
        let changed=true;
        while(changed){
            changed=false;
            for(const r of records){
                if(toDelete.has(r.id)) continue;
                // Removing a teaching subcourse should unassign it, not delete the whole batch.
                if(isLinked(r)){toDelete.add(r.id);changed=true;}
            }
        }
        if(memberId) for(const r of records){
            if(r.kind==='student-qr' && r.data.memberId===memberId) toDelete.add(r.id);
        }
        // A cascading course/batch delete never silently deletes unrelated user identities.
        // Students whose primary enrollment is removed are deactivated until reassigned.
        const detached=members.filter(m=>m.role==='student' && (toDelete.has(m.data.courseId) || toDelete.has(m.data.batchId)) && m.id!==memberId);
        const now=new Date(clock()).toISOString();
        const statements:any[]=[];
        const deletedSchedules=records.filter(r=>toDelete.has(r.id) && r.kind==='schedules');
        for(const r of deletedSchedules) statements.push(db.prepare('DELETE FROM attendance WHERE schedule_id=?').bind(r.id));
        if(memberId) statements.push(db.prepare('DELETE FROM attendance WHERE member_id=?').bind(memberId));
        for(const m of detached){
            const profile={...m.data,batchId:'',courseId:''};
            statements.push(db.prepare("UPDATE members SET status='Inactive',data=? WHERE id=?").bind(JSON.stringify(profile),m.id));
        }
        // Clean remaining rosters when a student is permanently deleted.
        if(memberId){
            for(const r of records){
                if(toDelete.has(r.id) || r.kind!=='schedules' || !Array.isArray(r.data.roster) || !r.data.roster.includes(memberId)) continue;
                statements.push(db.prepare('UPDATE records SET data=?,updated_at=? WHERE id=?').bind(JSON.stringify({...r.data,roster:r.data.roster.filter((m:string)=>m!==memberId)}),now,r.id));
            }
        }
        // Removing a course shared by other batches must update their linked list
        // without deleting batches whose primary course is different.
        if(kind==='courses') for(const r of records){
            if(r.kind==='batches' && !toDelete.has(r.id) && batchCourses(r.data).includes(id)) {
                const next: Record<string, any> = {...r.data,courseIds:batchCourses(r.data).filter((cid:string)=>cid!==id)};
                if (next.subcourseId && toDelete.has(next.subcourseId)) delete next.subcourseId;
                statements.push(db.prepare('UPDATE records SET data=?,updated_at=? WHERE id=?').bind(JSON.stringify(next),now,r.id));
            }
        }
        // Preserve batch membership when a subcourse is deleted: clear teaching assignment.
        if(kind==='subcourses') for(const r of records){
            if(r.kind==='batches' && r.data.subcourseId===id && !toDelete.has(r.id))
                statements.push(db.prepare("UPDATE records SET data=json_remove(data,'$.subcourseId'),updated_at=? WHERE id=?").bind(now,r.id));
        }
        for(const rid of toDelete) statements.push(db.prepare('DELETE FROM records WHERE id=?').bind(rid));
        if(memberId) statements.push(db.prepare('DELETE FROM members WHERE id=?').bind(memberId));
        statements.push(db.prepare('INSERT INTO audits (id,actor,action,detail,created_at) VALUES (?,?,?,?,?)').bind(
            crypto.randomUUID(),operator.name,'Admin cascade delete',`${kind} ${id}: ${toDelete.size} records and ${deletedSchedules.length} sessions; ${detached.length} students deactivated`,now));
        if(statements.length>800) throw new HubError('This delete affects too many records for one safe transaction. Archive or delete smaller batches first.',409);
        await db.batch(statements);
        return {deletedRecords:toDelete.size,deletedSessions:deletedSchedules.length,detachedStudents:detached.length,data:await load(operator)};
    }
    async function canManageBatch(me: Member, id: string) {
        if (me.role === 'admin') return;
        const batch = await record(id, 'batches');
        if (me.role !== 'trainer' || batch.data.trainerId !== me.id)
            throw new HubError('You can manage only your assigned batches.', 403);
    }
    async function studentBatchIds(student: Member): Promise<Set<string>> {
        const ids = new Set<string>();
        if (student.data.batchId) ids.add(student.data.batchId);
        const added = await all("SELECT data FROM records WHERE kind='enrollments' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.status')='Active'", student.id);
        for (const row of added) ids.add(JSON.parse(row.data).batchId);
        return ids;
    }
    async function canAttend(me: Member, session: Row) {
        if (me.role !== 'student') throw new HubError('Only enrolled students can access this class.', 403);
        const batches = await studentBatchIds(me);
        if (Array.isArray(session.data.roster) ? !session.data.roster.includes(me.id) : !batches.has(session.data.batchId))
            throw new HubError('This class is not assigned to your batch.', 403);
    }
    // Legacy batches have one courseId; new batches may share one teaching
    // session with several parent courses while retaining that primary ID.
    function batchCourses(data: any): string[] {
        return Array.isArray(data.courseIds) && data.courseIds.length
            ? data.courseIds : data.courseId ? [data.courseId] : [];
    }
    function registeredCourseForBatch(student: Member, batch: Row, extras: any[]): string | null {
        const permitted = new Set(batchCourses(batch.data));
        if (permitted.has(student.data.courseId)) return student.data.courseId;
        return extras.find(e => permitted.has(e.courseId) && !e.batchId)?.courseId || null;
    }
    // Records created before multi-recipient leave support contain only recipientId.
    // Never trust the recipient list supplied by the browser without validating it.
    function leaveRecipients(data: any): string[] {
        return Array.isArray(data.recipientIds) && data.recipientIds.length
            ? data.recipientIds.filter((id: unknown): id is string => typeof id === 'string')
            : data.recipientId ? [data.recipientId] : [];
    }
    function clean(kind: string, data: any) { if (!definitions[kind])
        throw new HubError('Unknown record type.'); const out: Record<string, any> = {}; for (const f of definitions[kind].fields) {
        let v = data?.[f.key];
        if (v === null || v === undefined)
            v = '';
        if (typeof v === 'object')
            throw new HubError('Invalid field value.');
        v = String(v).trim();
        if (v.length > 4000)
            throw new HubError(`${f.label} is too long.`);
        if (f.required && !v)
            throw new HubError(`${f.label} is required.`);
        if (f.options && !f.options.includes(v))
            v = f.options[0];
        if (f.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
            throw new HubError('Enter a valid email address.');
        if (f.type === 'time' && v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new HubError('Use a valid 24-hour time.');
        if (f.type === 'number' && v) {
            if (!Number.isFinite(Number(v)))
                throw new HubError(`${f.label} must be a number.`);
            v = Number(v);
        }
        if (f.type === 'date' && v && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v))))
            throw new HubError('Choose a valid date.');
        if (f.type === 'datetime-local' && v) {
            if (!Number.isFinite(Date.parse(v)))
                throw new HubError('Choose a valid class time.');
            v = new Date(v).toISOString();
        }
        out[f.key] = v;
        }
        if (kind === 'batches') {
            if (data?.courseIds !== undefined && (!Array.isArray(data.courseIds) || data.courseIds.some((id: unknown) => typeof id !== 'string' || !id.trim())))
                throw new HubError('Select valid courses for the batch.');
            const selected = data?.courseIds === undefined ? [out.courseId] : data.courseIds.map((id: string) => id.trim());
            if (!selected.length || selected.length > 30 || new Set(selected).size !== selected.length || !selected.includes(out.courseId))
                throw new HubError('Choose one or more unique courses, including the primary course.');
            out.courseIds = selected;
        }
        return out; }
    // Each scheduled class doubles as its persistent daily session record.
    // Deadlines are enforced here and by the Worker cron, never by the browser.
    const effectiveEnd = (data: any) => Date.parse(data.effectiveDeadline || data.endAt);
    async function closeExpiredSessions() {
        const now = new Date(clock()).toISOString();
        const zone=(await settings())?.timeZone || 'Asia/Kolkata';
        const today=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(clock()));
        // End-date completion is persisted independently of each daily class.
        await run(`UPDATE records SET data=json_set(data,'$.status','Completed'),updated_at=?
          WHERE kind='batches' AND coalesce(json_extract(data,'$.endDate'),'')!='' AND json_extract(data,'$.endDate')<?
          AND json_extract(data,'$.status') IN ('Active','Upcoming','Ongoing')`,now,today);
        // Single conditional UPDATE serializes against concurrent extensions/manual closes.
        const result = await run(`UPDATE records SET
          data=json_set(data, '$.sessionStatus','Auto-Closed', '$.closureReason','Deadline reached',
            '$.sessionOpen',json('false'), '$.actualEndAt',coalesce(json_extract(data,'$.effectiveDeadline'),json_extract(data,'$.endAt'))),
          updated_at=? WHERE kind='schedules'
          AND (json_extract(data,'$.sessionStatus')='In Progress' OR
             (json_extract(data,'$.sessionStatus') IS NULL AND json_extract(data,'$.sessionOpen')=1))
          AND coalesce(json_extract(data,'$.effectiveDeadline'),json_extract(data,'$.endAt'))<=?`, now, now);
        await run(`UPDATE attendance SET checked_out=(SELECT coalesce(json_extract(data,'$.actualEndAt'),json_extract(data,'$.endAt')) FROM records WHERE records.id=attendance.schedule_id)
          WHERE checked_in IS NOT NULL AND checked_out IS NULL AND schedule_id IN
          (SELECT id FROM records WHERE kind='schedules' AND json_extract(data,'$.sessionStatus')='Auto-Closed')`);
        return Number(result.meta?.changes || 0);
    }
    function batchTime(date: string, hour: string, zone: string) {
        // This release uses institute-local times (Asia/Kolkata by default).
        // Convert local wall time by iterative Intl-based offset, including DST zones.
        const requested = Date.parse(date + 'T' + hour + ':00Z');
        let attempt = requested;
        for (let i=0; i<3; i++) {
            const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(attempt));
            attempt += requested - Date.parse(parts.replace(' ','T')+':00Z');
        }
        return new Date(attempt).toISOString();
    }
    async function generateDailySessions(batchId: string, batch: any, me: Member) {
        if (!batch.endDate || !batch.dailyStartTime || !batch.dailyEndTime) return 0;
        const zone = (await settings()).timeZone || 'Asia/Kolkata';
        const firstDay = Date.parse(batch.startDate + 'T00:00:00Z'), lastDay = Date.parse(batch.endDate + 'T00:00:00Z');
        const now = new Date(clock()).toISOString();
        const holidays = (await all("SELECT data FROM records WHERE kind='holidays'")).map(r=>JSON.parse(r.data));
        const roster = (await all("SELECT id FROM members WHERE role='student' AND status='Active' AND json_extract(data,'$.batchId')=?",batchId)).map(r=>r.id);
        const enrolled = (await all("SELECT json_extract(data,'$.studentId') AS id FROM records WHERE kind='enrollments' AND json_extract(data,'$.batchId')=? AND json_extract(data,'$.status')='Active'",batchId)).map(r=>r.id);
        const existing=(await all("SELECT id,data FROM records WHERE kind='schedules' AND json_extract(data,'$.batchId')=?",batchId)).map(r=>({id:r.id,...JSON.parse(r.data)}));
        const dates=new Set<string>();
        for(let t=firstDay;t<=lastDay;t+=86400000){
            const date=new Date(t).toISOString().slice(0,10);
            const weekday=new Date(t).getUTCDay();
            if ((batch.batchType==='Weekend' ? weekday!==0 && weekday!==6 : weekday===0 || weekday===6) || holidays.some(h=>h.date===date && (!h.batchId || h.batchId===batchId))) continue;
            const startAt=batchTime(date,batch.dailyStartTime,zone);
            const endAt=batchTime(date,batch.dailyEndTime,zone);
            const isPast=Date.parse(endAt)<=clock();
            if(dates.has(date)) continue;
            dates.add(date);
            const entry={name:`${batch.name} - ${date}`,batchDay:date,batchId,courseId:batch.courseId,startAt,endAt,
                originalDeadline:endAt,effectiveDeadline:endAt,sessionStatus:isPast?'Cancelled':'Upcoming',closureReason:isPast?'Date passed before the schedule was recorded':'',sessionOpen:false,
                extensionMinutes:0,extensions:[],roster:[...new Set([...roster,...enrolled])],notes:'',mode:'In person'};
            const onDate=existing.find(e=>e.batchDay===date || (e.startAt && new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(e.startAt))===date));
            if(onDate){
                // Never rewrite a manually scheduled class, a started session, or attendance history.
                if(onDate.batchDay===date && onDate.sessionStatus==='Upcoming' && !onDate.actualStartAt
                    && !await first('SELECT id FROM attendance WHERE schedule_id=? LIMIT 1',onDate.id)) {
                    await run("UPDATE records SET data=json_set(data,'$.name',?,'$.startAt',?,'$.endAt',?,'$.originalDeadline',?,'$.effectiveDeadline',?,'$.courseId',?),updated_at=? WHERE id=? AND kind='schedules' AND json_extract(data,'$.sessionStatus')='Upcoming'",
                        entry.name,startAt,endAt,endAt,endAt,batch.courseId,now,onDate.id);
                }
                continue;
            }
            await run("INSERT INTO records (id,kind,data,created_at,updated_at) VALUES (?,'schedules',?,?,?)",crypto.randomUUID(),JSON.stringify(entry),now,now);
        }
        for(const existingSession of existing){
            if(!existingSession.batchDay || dates.has(existingSession.batchDay) || existingSession.sessionStatus!=='Upcoming' || Date.parse(existingSession.startAt)<=clock()) continue;
            if(await first('SELECT id FROM attendance WHERE schedule_id=? LIMIT 1',existingSession.id)) continue;
            await run("UPDATE records SET data=json_set(data,'$.sessionStatus','Cancelled','$.closureReason','Batch schedule updated','$.sessionOpen',json('false')),updated_at=? WHERE id=?",now,existingSession.id);
        }
        return dates.size;
    }
    // Count actual seats without trusting a client-supplied count. Legacy primary
    // batch memberships are preserved; attendance-created memberships use enrollments.
    async function batchSeatCount(batchId: string) {
        const result = await first(`WITH assigned AS (
          SELECT id AS studentId FROM members WHERE role='student' AND status='Active' AND json_extract(data,'$.batchId')=?
          UNION SELECT json_extract(e.data,'$.studentId') FROM records e JOIN members m
            ON m.id=json_extract(e.data,'$.studentId') AND m.role='student' AND m.status='Active'
          WHERE e.kind='enrollments' AND json_extract(e.data,'$.batchId')=? AND json_extract(e.data,'$.status')='Active'
        ) SELECT count(*) AS total FROM assigned`, batchId, batchId);
        return Number(result?.total || 0);
    }
    async function canJoinFirstClass(pupil: Member, batch: Row) {
        if(pupil.role!=='student' || pupil.status!=='Active') throw new HubError('Only active students can join classes.',403);
        const assigned=await studentBatchIds(pupil);
        if(assigned.has(batch.id)) return false;
        const extra=(await all("SELECT data FROM records WHERE kind='enrollments' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.status')='Active'",pupil.id)).map(r=>JSON.parse(r.data));
        if (!registeredCourseForBatch(pupil,batch,extra))
            throw new HubError('This student is not registered for any course offered in this batch.',403);
        const newTopic=batch.data.subcourseId || batch.data.courseId;
        for(const existingId of assigned){
            const existing=await record(existingId,'batches');
            if (existing.data.endDate && batch.data.endDate && existing.data.startDate<=batch.data.endDate && batch.data.startDate<=existing.data.endDate
                && (existing.data.batchType||'Weekday')===(batch.data.batchType||'Weekday')
                && existing.data.dailyStartTime && existing.data.dailyEndTime && batch.data.dailyStartTime && batch.data.dailyEndTime
                && existing.data.dailyStartTime<batch.data.dailyEndTime && existing.data.dailyEndTime>batch.data.dailyStartTime)
                throw new HubError('This student already has another class during the same time window.',409);
            if((existing.data.subcourseId || existing.data.courseId)===newTopic)
                throw new HubError('Already assigned to another batch teaching this subject.',409);
        }
        if(!['Active','Ongoing','Upcoming'].includes(batch.data.status)) throw new HubError('This batch is not open for enrollment.',409);
        return true;
    }
    async function admitAtFirstScan(me: Member, pupil: Member, session: Row, status: string, now: string) {
        const batch=await record(session.data.batchId,'batches');
        const firstClass=await canJoinFirstClass(pupil,batch);
        const attendanceId=crypto.randomUUID();
        const attendanceSQL=`INSERT INTO attendance(id,member_id,schedule_id,status,checked_in,checked_out,method,note,gps_verified)
          SELECT ?,?,?,?, ?,NULL,'Trainer QR scan',?,0
          WHERE EXISTS(SELECT 1 FROM records WHERE id=? AND kind='schedules'
            AND json_extract(data,'$.sessionStatus')='In Progress'
            AND json_extract(data,'$.effectiveDeadline')>?)
          AND EXISTS(SELECT 1 FROM (
            SELECT id AS studentId FROM members WHERE id=? AND json_extract(data,'$.batchId')=?
            UNION SELECT json_extract(data,'$.studentId') FROM records
              WHERE kind='enrollments' AND json_extract(data,'$.batchId')=?
              AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.status')='Active'))
          ON CONFLICT(schedule_id,member_id) DO UPDATE SET status=excluded.status,checked_in=excluded.checked_in,
            checked_out=NULL,method=excluded.method,note=excluded.note,gps_verified=0 WHERE attendance.checked_in IS NULL`;
        const att=db.prepare(attendanceSQL).bind(attendanceId,pupil.id,session.id,status,now,`Scanned by ${me.name}`,session.id,now,pupil.id,batch.id,batch.id,pupil.id);
        if(firstClass){
            const enrollmentId=crypto.randomUUID();
            const topic=batch.data.subcourseId || batch.data.courseId;
            const registered = (await all("SELECT data FROM records WHERE kind='enrollments' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.status')='Active'",pupil.id)).map(r=>JSON.parse(r.data));
            const enrolledCourseId = registeredCourseForBatch(pupil,batch,registered);
            if (!enrolledCourseId) throw new HubError('Student course registration not found.',403);
            const enrollment={studentId:pupil.id,courseId:enrolledCourseId,batchId:batch.id,subcourseId:batch.data.subcourseId||'',targetKey:topic,status:'Active',assignedBy:'First attendance',assignedAt:now};
            // Seat reservation, attendance, and today's roster update are one D1 transaction.
            // INSERT...SELECT reads the latest committed count on the database server.
            const seat=db.prepare(`INSERT INTO records(id,kind,data,created_at,updated_at)
              SELECT ?,'enrollments',?,?,? WHERE
                (SELECT count(*) FROM (
                  SELECT id FROM members WHERE role='student' AND status='Active' AND json_extract(data,'$.batchId')=?
                  UNION SELECT json_extract(e.data,'$.studentId') FROM records e JOIN members m
                    ON m.id=json_extract(e.data,'$.studentId') AND m.status='Active' AND m.role='student'
                    WHERE e.kind='enrollments' AND json_extract(e.data,'$.batchId')=? AND json_extract(e.data,'$.status')='Active'
                )) < coalesce((SELECT CAST(json_extract(data,'$.capacity') AS INTEGER) FROM records WHERE id=?),45)
                AND NOT EXISTS(SELECT 1 FROM records WHERE kind='enrollments' AND json_extract(data,'$.studentId')=?
                  AND json_extract(data,'$.targetKey')=? AND json_extract(data,'$.status')='Active')
                AND EXISTS(SELECT 1 FROM records WHERE id=? AND kind='schedules'
                  AND json_extract(data,'$.sessionStatus')='In Progress'
                  AND json_extract(data,'$.effectiveDeadline')>?)`)
                .bind(enrollmentId,JSON.stringify(enrollment),now,now,batch.id,batch.id,batch.id,pupil.id,topic,session.id,now);
            const [reserved,saved]=await db.batch([seat,att]);
            if(!saved.meta?.changes){
                if(!reserved.meta?.changes) {
                    // A simultaneous duplicate QR scan can observe the first
                    // scan's successful enrollment/attendance. Treat it as idempotent.
                    const duplicate = await first('SELECT id FROM attendance WHERE schedule_id=? AND member_id=?',session.id,pupil.id);
                    if(duplicate && (await studentBatchIds(pupil)).has(batch.id)) return false;
                    // Best-effort FCFS waiting list uses first verified scan attempt time.
                    const registeredAt=pupil.data.courseId===enrolledCourseId ? pupil.createdAt :
                        (await first("SELECT created_at FROM records WHERE kind='enrollments' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.courseId')=? ORDER BY created_at LIMIT 1",pupil.id,enrolledCourseId))?.created_at||pupil.createdAt;
                    await run(`INSERT OR IGNORE INTO records(id,kind,data,created_at,updated_at)
                        VALUES (?,'batch-waitlist',?,?,?)`, `waitlist:${batch.id}:${pupil.id}`,
                        JSON.stringify({studentId:pupil.id,courseId:enrolledCourseId,batchId:batch.id,targetKey:topic,status:'Waiting',requestedAt:now,registeredAt}),now,now);
                    throw new HubError('Batch is full or you are assigned to another batch. Added to waiting list; ask Admin about a seat.',409);
                }
                throw new HubError('This class was closed before attendance could be saved. Refresh and retry.',409);
            }
            if(reserved.meta?.changes){
                await run(`UPDATE records SET data=json_set(data,'$.roster',
                  CASE WHEN json_type(data,'$.roster')='array' THEN json_insert(json_extract(data,'$.roster'),'$[#]',?) ELSE json_array(?) END),updated_at=?
                  WHERE kind='schedules' AND json_extract(data,'$.batchId')=?
                  AND coalesce(json_extract(data,'$.sessionStatus'),'Upcoming') IN ('Upcoming','In Progress')
                  AND NOT EXISTS(SELECT 1 FROM json_each(coalesce(json_extract(data,'$.roster'),'[]')) WHERE value=?)`,
                  pupil.id,pupil.id,now,batch.id,pupil.id);
                await run("DELETE FROM records WHERE kind='batch-waitlist' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.targetKey')=?",pupil.id,topic);
                await audit(me,'First attendance enrollment',`${pupil.name} joined ${batch.data.name}`);
            }
            return Number(saved.meta?.changes)>0;
        }
        const saved=await att.run();
        return Number(saved.meta?.changes)>0;
    }
    // Learning progress is individual to a student AND a teaching subcourse.
    // Actual attendance (Present/Late) starts a module, but can never finish it.
    async function hasModuleAttendance(studentId: string, subcourseId: string) {
        const module = await record(subcourseId,'subcourses');
        const found = await first(`SELECT a.id FROM attendance a
            JOIN records session ON session.id=a.schedule_id AND session.kind='schedules'
            JOIN records batch ON batch.id=json_extract(session.data,'$.batchId') AND batch.kind='batches'
            JOIN records teaching ON teaching.id=json_extract(batch.data,'$.subcourseId') AND teaching.kind='subcourses'
            WHERE a.member_id=? AND a.status IN ('Present','Late')
              AND lower(json_extract(teaching.data,'$.name'))=lower(?)
              AND (EXISTS(SELECT 1 FROM members m WHERE m.id=a.member_id
                 AND json_extract(m.data,'$.courseId')=?)
              OR EXISTS(SELECT 1 FROM records e WHERE e.kind='enrollments'
                 AND json_extract(e.data,'$.studentId')=a.member_id
                 AND json_extract(e.data,'$.batchId')=batch.id
                 AND json_extract(e.data,'$.courseId')=? AND json_extract(e.data,'$.status')='Active'))
            LIMIT 1`,studentId,module.data.name,module.data.courseId,module.data.courseId);
        return !!found;
    }
    async function syncModuleOngoing(studentId: string, session: Row) {
        const batch = await record(String(session.data.batchId),'batches');
        const sourceId = String(batch.data.subcourseId || '');
        if (!sourceId) return; // Legacy batches without a teaching module.
        const source = await record(sourceId,'subcourses');
        const studentRow = await first("SELECT * FROM members WHERE id=? AND role='student'",studentId);
        if (!studentRow) return;
        const pupil = parseMember(studentRow);
        const extras = (await all("SELECT data FROM records WHERE kind='enrollments' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.batchId')=? AND json_extract(data,'$.status')='Active'",studentId,batch.id)).map(r=>JSON.parse(r.data));
        const courseId = extras[0]?.courseId || (pupil.data.batchId===batch.id ? pupil.data.courseId : registeredCourseForBatch(pupil,batch,extras));
        if (!courseId) return;
        // The two parent courses can share a teaching session. Progress remains
        // separate and uses each course's own catalogued subcourse ID.
        const target = courseId===source.data.courseId ? source : await first(
            "SELECT * FROM records WHERE kind='subcourses' AND json_extract(data,'$.courseId')=? AND lower(json_extract(data,'$.name'))=lower(?) LIMIT 1",
            courseId,source.data.name
        );
        if (!target) return; // The second parent program has no such subcourse.
        const subcourseId = courseId===source.data.courseId ? source.id : target.id;
        const id = `module-progress:${studentId}:${subcourseId}`;
        const now = new Date(clock()).toISOString();
        const progress = { studentId, courseId, subcourseId,
            status: 'Ongoing', startedAt: now, source: 'Attendance' };
        await run(`INSERT INTO records(id,kind,data,created_at,updated_at)
            VALUES (?,'module-progress',?,?,?)
            ON CONFLICT(id) DO UPDATE SET data=json_set(records.data,'$.status','Ongoing',
              '$.startedAt',coalesce(json_extract(records.data,'$.startedAt'),excluded.created_at)),
              updated_at=excluded.updated_at
            WHERE json_extract(records.data,'$.status') NOT IN ('Completed','Ongoing')`,
            id, JSON.stringify(progress), now, now);
    }
    async function validateReferences(kind: string, data: any) {
        if (kind === 'batches') {
            data.courseIds = batchCourses(data);
            if (data.courseIds.length < 1 || data.courseIds.length > 30 || new Set(data.courseIds).size !== data.courseIds.length || !data.courseIds.includes(data.courseId))
                throw new HubError('Select valid courses for this batch.');
            for (const courseId of data.courseIds) {
                const selectedCourse = await record(courseId, 'courses');
                if (selectedCourse.data.status === 'Inactive' || selectedCourse.data.status === 'Archived')
                    throw new HubError('All batch courses must be active.');
            }
            data.batchType = data.batchType || 'Weekday';
            data.capacity = data.capacity === '' ? 45 : Number(data.capacity);
            if (!['Weekday','Weekend'].includes(data.batchType)) throw new HubError('Choose a weekday or weekend batch.');
            if (!Number.isInteger(data.capacity) || data.capacity < 1 || data.capacity > 1000) throw new HubError('Batch capacity must be between 1 and 1000 students.');
            if (data._id && data.capacity < await batchSeatCount(data._id)) throw new HubError('Cannot reduce capacity below the currently enrolled student count.',409);
            const allTiming=[data.endDate,data.dailyStartTime,data.dailyEndTime].filter(Boolean);
            if(data.trainerId && allTiming.length===3) {
                const others=(await all("SELECT id,data FROM records WHERE kind='batches' AND json_extract(data,'$.trainerId')=? AND id!=?", data.trainerId,data._id||'')).map(r=>JSON.parse(r.data));
                for(const b of others){
                    if(b.endDate && b.startDate<=data.endDate && data.startDate<=b.endDate
                        && (b.batchType||'Weekday')===data.batchType
                        && b.dailyStartTime && b.dailyEndTime && b.dailyStartTime<data.dailyEndTime && b.dailyEndTime>data.dailyStartTime)
                        throw new HubError('The trainer already teaches another batch at this time.',409);
                }
            }
            if (allTiming.length && allTiming.length!==3)
                throw new HubError('Provide the batch end date and both daily class times.');
            if (allTiming.length) {
                if (data.endDate < data.startDate) throw new HubError('Batch end date cannot precede start date.');
                const durationDays=Math.round((Date.parse(data.endDate)-Date.parse(data.startDate))/86400000)+1;
                if (durationDays>366) throw new HubError('Daily class generation supports batches of at most one year.');
                if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.dailyStartTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.dailyEndTime) || data.dailyEndTime<=data.dailyStartTime)
                    throw new HubError('Choose valid same-day class times with the end after the start.');
                data.courseDurationDays=durationDays;
                const [sh,sm]=data.dailyStartTime.split(':').map(Number),[eh,em]=data.dailyEndTime.split(':').map(Number);
                data.classDurationMinutes=(eh*60+em)-(sh*60+sm);
            }
        }
        if (kind === 'batches' && data.subcourseId) {
            const topic = await record(data.subcourseId, 'subcourses');
            if (!data.courseIds.includes(topic.data.courseId) || topic.data.status === 'Inactive')
                throw new HubError('The teaching subcourse must be active and belong to one of the selected courses.');
        }
        if (kind === 'batches' && data._id) {
            const old = await record(data._id, 'batches');
            const removedCourses = batchCourses(old.data).filter((id: string) => !data.courseIds.includes(id));
            for (const removedId of removedCourses) {
                const primary = await first("SELECT id FROM members WHERE role='student' AND json_extract(data,'$.batchId')=? AND json_extract(data,'$.courseId')=? LIMIT 1",data._id,removedId);
                const additional = await first("SELECT id FROM records WHERE kind='enrollments' AND json_extract(data,'$.batchId')=? AND json_extract(data,'$.courseId')=? AND json_extract(data,'$.status')='Active' LIMIT 1",data._id,removedId);
                if (primary || additional) throw new HubError('Cannot remove a course while its students are assigned to this batch.',409);
            }
            if (old.data.courseId !== data.courseId) {
                const used = await first("SELECT id FROM records WHERE kind='schedules' AND json_extract(data,'$.batchId')=? LIMIT 1",data._id);
                if (used) throw new HubError('Keep the primary course after classes have been scheduled. You can add other courses.',409);
            }
            if (old.data.courseId !== data.courseId || old.data.trainerId !== data.trainerId || old.data.subcourseId && old.data.subcourseId !== data.subcourseId) {
                const used = await first("SELECT id FROM records WHERE kind = 'schedules' AND json_extract(data,'$.batchId') = ? LIMIT 1", data._id);
                if (used)
                    throw new HubError('Create a new batch to change a course or trainer after classes are scheduled.');
            }
        }
        for (const f of definitions[kind].fields) {
            if (!f.relation || !data[f.key])
                continue;
            if (f.relation === 'students' || f.relation === 'trainers') {
                const m = await first('SELECT role,status FROM members WHERE id = ?', data[f.key]);
                if (!m || m.role !== (f.relation === 'students' ? 'student' : 'trainer') || m.status !== 'Active')
                    throw new HubError(`Choose an active ${f.label.toLowerCase()}.`);
            }
            else
                await record(data[f.key], f.relation);
        }
        if (kind === 'courses' || kind === 'subcourses') {
            const name = String(data.name || '').trim();
            if (name.length < 2 || name.length > 120) throw new HubError('Course names must be between 2 and 120 characters.');
            const weeks = Number(data.duration);
            if (!Number.isInteger(weeks) || weeks < 1 || weeks > 260) throw new HubError('Duration must be between 1 and 260 weeks.');
            // Do not permit duplicate names within the same parent course.
            const same = kind === 'courses'
                ? await first("SELECT id FROM records WHERE kind='courses' AND id != ? AND lower(json_extract(data,'$.name'))=lower(?) LIMIT 1", data._id || '', name)
                : await first("SELECT id FROM records WHERE kind='subcourses' AND id != ? AND json_extract(data,'$.courseId')=? AND lower(json_extract(data,'$.name'))=lower(?) LIMIT 1", data._id || '', data.courseId, name);
            if (same) throw new HubError('A course or subcourse with this name already exists.');
        }
        if (kind === 'enrollments') {
            if (data._id) {
                const old = await record(data._id, 'enrollments');
                if (old.data.studentId !== data.studentId || old.data.batchId !== data.batchId || old.data.courseId !== data.courseId)
                    throw new HubError('To change a student or batch, create a new enrollment. Existing enrollment links cannot be reassigned.');
            }
            if(data.batchId){
                const batch = await record(data.batchId, 'batches');
                if (!batchCourses(batch.data).includes(data.courseId)) throw new HubError('The batch must belong to the selected course (one of this batch’s courses).');
                if((!data._id || (await record(data._id,'enrollments')).data.status!=='Active') && await batchSeatCount(data.batchId)>=Number(batch.data.capacity || 45)) throw new HubError('Batch capacity reached. Leave the batch blank for first-attendance allocation.',409);
            }
            const student = await first("SELECT * FROM members WHERE id=? AND role='student' AND status='Active'", data.studentId);
            if (!student) throw new HubError('Choose an active student.');
            if(data.batchId && JSON.parse(student.data).batchId === data.batchId) throw new HubError('The student is already in this batch through the primary enrollment.');
            const same = data.batchId
                ? await first("SELECT id FROM records WHERE kind='enrollments' AND id != ? AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.batchId')=? LIMIT 1", data._id || '', data.studentId, data.batchId)
                : await first("SELECT id FROM records WHERE kind='enrollments' AND id != ? AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.courseId')=? AND coalesce(json_extract(data,'$.batchId'),'')='' AND json_extract(data,'$.status')='Active' LIMIT 1",data._id || '',data.studentId,data.courseId);
            if (same) throw new HubError('This student already has this course/batch enrollment.');
        }
        if (kind === 'students') {
            // A new student can enroll in a parent course before Admin allocates a batch.
            // If a batch is supplied later, it must belong to the selected course.
            if (data.batchId) {
                const b = await record(data.batchId, 'batches');
                if (!batchCourses(b.data).includes(data.courseId))
                    throw new HubError('The batch must belong to the selected course (one of this batch’s courses).');
                const previous = data._id ? await first("SELECT data FROM members WHERE id=? AND role='student'",data._id) : null;
                if((!previous || JSON.parse(previous.data).batchId!==data.batchId) && await batchSeatCount(data.batchId)>=Number(b.data.capacity||45))
                    throw new HubError('The selected batch is full; leave the batch empty and assign at first attendance.',409);
            }
            const duplicate = await first("SELECT id FROM members WHERE role = 'student' AND id != ? AND lower(json_extract(data,'$.studentId')) = lower(?) LIMIT 1", data._id || '', data.studentId);
            if (duplicate)
                throw new HubError('This student ID is already in use.');
            const trainerCollision = await first("SELECT id FROM members WHERE role='trainer' AND lower(json_extract(data,'$.trainerId'))=lower(?) LIMIT 1", data.studentId);
            if (trainerCollision) throw new HubError('Student ID conflicts with an existing trainer login ID.');
            if (!/^[a-z0-9][a-z0-9_-]{1,39}$/i.test(String(data.studentId))) throw new HubError('Student ID must be 2–40 letters, numbers, hyphens or underscores.');
        }
        if (kind === 'trainers') {
            const id = String(data.trainerId || '').trim();
            if (!/^[a-z0-9][a-z0-9_-]{1,39}$/i.test(id)) throw new HubError('Trainer ID must be 2–40 letters, numbers, hyphens or underscores.');
            const duplicate = await first("SELECT id FROM members WHERE role = 'trainer' AND id != ? AND lower(json_extract(data,'$.trainerId')) = lower(?) LIMIT 1", data._id || '', id);
            if (duplicate) throw new HubError('Trainer ID is already in use.');
            const studentCollision = await first("SELECT id FROM members WHERE role='student' AND lower(json_extract(data,'$.studentId'))=lower(?) LIMIT 1", id);
            if (studentCollision) throw new HubError('Trainer ID conflicts with an existing student login ID.');
        }
        if (kind === 'schedules') {
            if (Date.parse(data.endAt) <= Date.parse(data.startAt))
                throw new HubError('The class must end after it starts.');
            if (Date.parse(data.endAt) - Date.parse(data.startAt) > 86400000)
                throw new HubError('A class cannot be longer than 24 hours.');
            const batch = await record(data.batchId, 'batches');
            if (data.roomId) {
                const room = await record(data.roomId, 'rooms');
                if (room.data.branchId !== batch.data.branchId)
                    throw new HubError('Choose a room at the batch’s branch.');
                const conflicts = await all("SELECT id FROM records WHERE kind = 'schedules' AND json_extract(data,'$.roomId') = ? AND json_extract(data,'$.startAt') < ? AND json_extract(data,'$.endAt') > ?", data.roomId, data.endAt, data.startAt);
                if (conflicts.some(r => r.id !== data._id))
                    throw new HubError('This room is already booked during that time.');
            }
        }
        if (kind === 'branches' && data.googleReviewUrl && !safeGoogleReviewUrl(data.googleReviewUrl)) throw new HubError('Use a valid public HTTPS review link (not localhost or a private address).');
        if (kind === 'rooms' && (!Number.isInteger(data.capacity) || data.capacity < 1 || data.capacity > 10000))
            throw new HubError('Capacity must be a whole number between 1 and 10,000.');
        if (kind === 'courses' && (!Number.isInteger(data.duration) || data.duration < 1 || data.duration > 260))
            throw new HubError('Duration must be between 1 and 260 weeks.');
        if (kind === 'holidays' && data.batchId) {
            await record(data.batchId, 'batches');
        }
        if (kind === 'leaves' && data.toDate < data.fromDate)
            throw new HubError('The end date must be on or after the start date.');
    }
    async function ownStudentQr(me: Member, timeZone: string) {
        const window = dailyQrWindow(clock(), timeZone), id = `student-qr:${me.id}`;
        const data = { memberId: me.id, ...window, token: newStudentQrToken() };
        const time = new Date(clock()).toISOString();
        // Same-day reloads keep the committed token. A delayed pre-midnight
        // request cannot replace a token already issued for the next day.
        await run("INSERT INTO records (id,kind,data,created_at,updated_at) VALUES (?,'student-qr',?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at WHERE json_extract(records.data,'$.day') < ? OR json_extract(records.data,'$.timeZone') != ? OR json_extract(records.data,'$.expiresAt') <= ?", id, JSON.stringify(data), time, time, window.day, timeZone, time);
        const row = await first("SELECT data FROM records WHERE id = ? AND kind = 'student-qr'", id);
        const saved = JSON.parse(row.data);
        return { day: saved.day, timeZone: saved.timeZone, expiresAt: saved.expiresAt, payload: studentQrPayload(saved.day, saved.token) };
    }
    async function scanContext(me: Member, scheduleId: string, requireOpen = true) {
        if (!['admin', 'trainer'].includes(me.role)) throw new HubError('Only a trainer or administrator can scan student QR codes.', 403);
        const session = await record(scheduleId, 'schedules');
        await canManageBatch(me, session.data.batchId);
        const batch = await record(session.data.batchId, 'batches');
        if (!['Active','Ongoing','Upcoming'].includes(batch.data.status)) throw new HubError('This batch is no longer active.');
        const day = new Intl.DateTimeFormat('en-CA',{timeZone:(await settings()).timeZone||'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(session.data.startAt));
        if(batch.data.startDate > day || batch.data.endDate && batch.data.endDate < day) throw new HubError('This class is outside the batch dates.',409);
        if(await first("SELECT id FROM records WHERE kind='holidays' AND json_extract(data,'$.date')=? AND (coalesce(json_extract(data,'$.batchId'),'')='' OR json_extract(data,'$.batchId')=?) LIMIT 1",day,session.data.batchId)) throw new HubError('This class falls on a declared holiday.',409);
        if (clock() < Date.parse(session.data.startAt) - 15 * 60000 || clock() >= effectiveEnd(session.data)) throw new HubError('Attendance scanning is available from 15 minutes before class until class ends.');
        if (session.data.sessionStatus && !['Upcoming', 'In Progress'].includes(session.data.sessionStatus)) throw new HubError('This class session is closed.', 409);
        if (requireOpen && !session.data.sessionOpen) throw new HubError('Start attendance for this class before scanning.');
        return { session };
    }
    async function bootstrap(user: Identity) { if (!await settings()) { canInitialize(user); return { needsSetup: true, user }; } return { needsSetup: false, data: await load(await membership(user)), user }; }
    async function load(me: Member): Promise<HubData> {
        await closeExpiredSessions();
        const s = await settings();
        // Non-session records retain the existing dashboard cap. Fetch all saved
        // sessions separately so Full Schedule can include older and future
        // sessions even when the institute has over 3,000 other records.
        const rows = (await all("SELECT * FROM records WHERE kind NOT IN ('checkin-rate','scan-rate','student-qr','schedules') ORDER BY created_at DESC LIMIT 3000")).map(parseRecord);
        rows.push(...(await all("SELECT * FROM records WHERE kind='schedules' ORDER BY json_extract(data,'$.startAt') DESC")).map(parseRecord));
        let people = (await all('SELECT * FROM members ORDER BY created_at DESC LIMIT 2000')).map(parseMember);
        // Backend allowlist: never send the whole records table to non-admins.
        // Assignments come from the current batch or additional active enrollments.
        const today = new Intl.DateTimeFormat('en-CA',{timeZone:s.timeZone||'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(clock()));
        for(const b of rows.filter(r=>r.kind==='batches')) {
            b.data.batchStatus = b.data.endDate && b.data.endDate<today ? 'Completed' : b.data.startDate>today ? 'Upcoming' : 'Ongoing';
        }
        const allBatches = rows.filter(r => r.kind === 'batches');
        const enrolledRows = rows.filter(r => r.kind === 'enrollments' && r.data.status === 'Active');
        const batchIds = new Set<string>(allBatches.filter(r => me.role === 'admin' ||
            me.role === 'trainer' && r.data.trainerId === me.id ||
            me.role === 'student' && (r.id === me.data.batchId || enrolledRows.some(e => e.data.studentId === me.id && e.data.batchId === r.id))).map(r => r.id));
        const courses = new Set<string>(me.role === 'student' ? [] :
            allBatches.filter(r => batchIds.has(r.id)).flatMap(r => batchCourses(r.data)));
        // Enrolled students may have a course but no batch until Admin assigns one.
        // They still see their own parent course and its subcourses, never other courses.
        if (me.role === 'student') {
            if(me.data.courseId) courses.add(me.data.courseId);
            for(const e of enrolledRows.filter(e=>e.data.studentId===me.id)) courses.add(e.data.courseId);
        }
        const branchIds = new Set(allBatches.filter(r => batchIds.has(r.id)).map(r => r.data.branchId));
        const managedStudents = new Set(people.filter(m => m.role === 'student' &&
            (batchIds.has(m.data.batchId) || enrolledRows.some(e => e.data.studentId === m.id && batchIds.has(e.data.batchId)))).map(m => m.id));
        if (me.role === 'trainer')
            people = people.filter(m => m.id === me.id || m.role === 'student' && managedStudents.has(m.id)).map(m =>
                m.role === 'student' ? { ...m, email: '', data: { studentId: m.data.studentId, batchId: m.data.batchId, courseId: m.data.courseId } } : m);
        else if (me.role === 'student')
            people = people.filter(m => m.id === me.id || m.role === 'trainer' && allBatches.some(b => batchIds.has(b.id) && b.data.trainerId === m.id) || m.role === 'student' && (batchIds.has(m.data.batchId) || enrolledRows.some(e=>e.data.studentId===m.id && batchIds.has(e.data.batchId))))
                .map(m => {
                    if(m.role!=='student' || m.id===me.id) return m;
                    const shared=allBatches.find(b=>batchIds.has(b.id) && (m.data.batchId===b.id || enrolledRows.some(e=>e.data.studentId===m.id && e.data.batchId===b.id)));
                    return {...m,email:'',userId:null,data:{courseId:shared?.data.courseId||'',batchId:shared?.id||''}};
                });
        let visible = rows.filter(r => {
            if (me.role === 'admin') return r.kind !== 'leaves' || !r.data.recipientId || leaveRecipients(r.data).includes('admin');
            switch (r.kind) {
                case 'courses': return courses.has(r.id);
                case 'subcourses': return r.data.status !== 'Inactive' && (me.role === 'trainer' ? allBatches.some(b => batchIds.has(b.id) && b.data.subcourseId === r.id) : courses.has(r.data.courseId));
                case 'batches': return batchIds.has(r.id);
                case 'enrollments': return me.role === 'student' ? r.data.studentId === me.id && r.data.status === 'Active'
                    : batchIds.has(r.data.batchId) && managedStudents.has(r.data.studentId);
                case 'branches': return branchIds.has(r.id);
                case 'rooms': return branchIds.has(r.data.branchId);
                case 'schedules': return me.role === 'student' ? batchIds.has(r.data.batchId) ||
                    (r.data.sessionStatus === 'Upcoming' && allBatches.some(b=>b.id===r.data.batchId && batchCourses(b.data).some(id=>courses.has(id)))) : batchIds.has(r.data.batchId);
                case 'leaves': return r.data.memberId === me.id || (me.role === 'trainer' && (r.data.recipientId ? leaveRecipients(r.data).includes(me.id) : managedStudents.has(r.data.memberId)));
                case 'bookings': return r.data.memberId === me.id;
                case 'placements': return me.role === 'student' ? r.data.studentId === me.id : managedStudents.has(r.data.studentId);
                case 'notifications': return (!r.data.batchId || batchIds.has(r.data.batchId)) &&
                    (r.data.audience === 'All' || r.data.audience === (me.role === 'student' ? 'Students' : 'Trainers'));
                case 'holidays': return !r.data.batchId || batchIds.has(r.data.batchId);
                case 'batch-waitlist': return me.role==='student' && r.data.studentId===me.id;
                case 'module-progress': {
                    if (me.role === 'student') return r.data.studentId === me.id;
                    if (!managedStudents.has(r.data.studentId)) return false;
                    const module = rows.find(m=>m.kind==='subcourses' && m.id===r.data.subcourseId);
                    return allBatches.some(b=>batchIds.has(b.id) && batchCourses(b.data).includes(r.data.courseId) &&
                        (b.data.subcourseId===r.data.subcourseId ||
                         module && rows.some(teaching=>teaching.id===b.data.subcourseId && teaching.kind==='subcourses' &&
                            String(teaching.data.name).toLowerCase()===String(module.data.name).toLowerCase())));
                }
                // Any future record kind is private until explicitly authorized here.
                default: return false;
            }
        });
        if (['admin','trainer'].includes(me.role)) {
            // One grouped query over active primary + additional enrollments; count
            // distinct students even when they have both relationships to a batch.
            const totals = await all(`WITH student_batches AS (
                SELECT id AS student_id, json_extract(data,'$.batchId') AS batch_id
                  FROM members WHERE role='student' AND status='Active'
                UNION
                SELECT json_extract(e.data,'$.studentId') AS student_id,
                       json_extract(e.data,'$.batchId') AS batch_id
                  FROM records e JOIN members m
                    ON m.id=json_extract(e.data,'$.studentId') AND m.role='student' AND m.status='Active'
                 WHERE e.kind='enrollments' AND json_extract(e.data,'$.status')='Active'
            ) SELECT batch_id, count(*) AS total FROM student_batches GROUP BY batch_id`);
            const countByBatch = new Map(totals.map(x => [x.batch_id, Number(x.total)]));
            visible = visible.map(r => r.kind === 'batches'
                ? { ...r, data: { ...r.data, studentCount: countByBatch.get(r.id) || 0 } } : r);
        }
        if (me.role === 'student')
            visible = visible.map(r => r.kind === 'schedules' ? {
                ...r, data: { ...r.data, roster: Array.isArray(r.data.roster) && r.data.roster.includes(me.id) ? [me.id] : undefined,
                    token: undefined, code: undefined }
            } : r);
        if(['admin','trainer'].includes(me.role)) {
            const waiting=await all("SELECT json_extract(data,'$.batchId') AS batch_id,count(*) AS total FROM records WHERE kind='batch-waitlist' GROUP BY json_extract(data,'$.batchId')");
            const waitingCounts=new Map(waiting.map(r=>[r.batch_id,Number(r.total)]));
            visible=visible.map(r=>r.kind==='batches'?{...r,data:{...r.data,waitingCount:waitingCounts.get(r.id)||0}}:r);
        }
        const now = new Date(clock()).toISOString();

        // Keep students' historical attendance visible even after a batch transfer.
        // Trainers still see attendance only for authorized sessions and students.
        const visibleSessions = new Set(
            visible.filter(r => r.kind === 'schedules').map(r => r.id)
        );
        const visibleMembers = new Set(people.map(p => p.id));
        const attendanceRows = me.role === 'student'
            ? await all(
                'SELECT * FROM attendance WHERE member_id = ? ORDER BY checked_in DESC LIMIT 10000',
                me.id
            )
            : await all('SELECT * FROM attendance ORDER BY checked_in DESC LIMIT 10000');
        const present = attendanceRows
            .filter(a => {
                if (me.role === 'student') return a.member_id === me.id;
                if (me.role === 'admin') return visibleSessions.has(a.schedule_id);
                if (me.role === 'trainer') {
                    return visibleSessions.has(a.schedule_id) && visibleMembers.has(a.member_id);
                }
                return false;
            })
            .map(a => ({
                id: a.id,
                memberId: a.member_id,
                scheduleId: a.schedule_id,
                status: a.status,
                checkedIn: a.checked_in,
                checkedOut: a.checked_out,
                method: a.method,
                note: a.note
            }));
        // Report calculations need approved date ranges even when the leave
        // reason is private to a different recipient. Never disclose its reason,
        // reviewer, or recipient to unauthorized dashboard roles.
        const studentVisibility = new Set(people.filter(m => m.role === 'student' && (me.role !== 'student' || m.id === me.id)).map(m => m.id));
        const approvedLeaveDates = rows.filter(r => r.kind === 'leaves' && r.data.status === 'Approved' &&
            studentVisibility.has(r.data.memberId)).map(r => ({ studentId:r.data.memberId,
                fromDate:r.data.fromDate, toDate:r.data.toDate }));
        return { me, settings: { name: s.name, timeZone: s.timeZone, lateMinutes: s.lateMinutes, threshold: s.threshold }, members: people, records: visible, attendance: present, approvedLeaveDates, studentQr: me.role === 'student' ? await ownStudentQr(me, s.timeZone) : null, googleReview: studentBranchReview(me, rows), audits: me.role === 'admin' ? await all('SELECT * FROM audits ORDER BY created_at DESC LIMIT 200') : [], serverTime: now };
    }
    // Date-scoped live attendance endpoint. Permissions are applied by load(),
    // then both sessions and entries are narrowed to the requested institute date.
    async function attendanceForDate(user: Identity, date: string) {
        const me = await membership(user);
        if (!['admin', 'trainer'].includes(me.role)) throw new HubError('Only staff can view class attendance.', 403);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) ||
            new Date(date + 'T00:00:00Z').toISOString().slice(0,10) !== date)
            throw new HubError('Choose a valid attendance date.');
        const current = await load(me);
        const zone = current.settings.timeZone;
        const relevant = current.records.filter(r => r.kind === 'schedules' && instituteDate(r.data.startAt, zone) === date);
        const permitted = new Set(relevant.map(r => r.id));
        const visibleStudents = new Set(current.members.filter(m => m.role === 'student').map(m => m.id));
        const nextDate = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
        const start = localInputToISO(date + 'T00:00', zone);
        const end = localInputToISO(nextDate + 'T00:00', zone);
        // Fetch only this date from D1; unlike the general dashboard feed this
        // never truncates historical attendance at the global 10,000-row cap.
        const daily = await all(`SELECT a.* FROM attendance a
            JOIN records s ON s.id=a.schedule_id AND s.kind='schedules'
            WHERE json_extract(s.data,'$.startAt') >= ? AND json_extract(s.data,'$.startAt') < ?
            ORDER BY a.checked_in DESC`, start, end);
        const attendance = daily.filter(a => permitted.has(a.schedule_id) &&
            (me.role === 'admin' || visibleStudents.has(a.member_id)))
            .map(a => ({ id:a.id,memberId:a.member_id,scheduleId:a.schedule_id,
                status:a.status,checkedIn:a.checked_in,checkedOut:a.checked_out,
                method:a.method,note:a.note }));
        return { date, timeZone: zone, sessions: relevant, attendance, serverTime: current.serverTime };
    }
    async function act(user: Identity, input: any) {
        await closeExpiredSessions();
        const op = String(input.op || '');
        if (op === 'setup') {
            canInitialize(user);
            const name = String(input.name || 'Besant StudentHub').trim().slice(0, 100);
            if (!name)
                throw new HubError('Enter your institute name.');
            const time = new Date(clock()).toISOString(), owner = { name, timeZone: 'Asia/Kolkata', lateMinutes: 10, threshold: 75, ownerUserId: user.userId };
            await db.batch([db.prepare('INSERT OR IGNORE INTO settings (id,data) VALUES (?,?)').bind('institute', JSON.stringify(owner)), db.prepare("INSERT OR IGNORE INTO members (id,user_id,email,name,role,status,data,created_at) SELECT ?,?,?,?,'admin','Active','{}',? WHERE json_extract((SELECT data FROM settings WHERE id = 'institute'),'$.ownerUserId') = ?").bind(crypto.randomUUID(), user.userId, user.email.toLowerCase(), user.displayName, time, user.userId)]);
            const me = await membership(user);
            admin(me);
            return { data: await load(me) };
        }
        const me = await membership(user), s = await settings();
        let result: any = {};
        // The institute's student-details workbook is a per-student completion
        // snapshot: each comma-separated SUB COURSE item is Completed; all other
        // catalog modules for that student/course are Pending or attendance-Ongoing.
        // Single upload for the institute's seven-column Student Details workbook.
        // Creates missing accounts or matches an existing student, registers the
        // parent course, and saves the entire per-subcourse progress snapshot.
        // All D1 writes for each chunk are atomic. No batch enrollment occurs here.
        if (op === 'importStudentsAndProgress') {
            admin(me);
            if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 10)
                throw new HubError('Import 1–10 combined student rows per request.', 400);
            const key = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
            const members = (await all('SELECT * FROM members')).map(parseMember);
            const catalog = (await all("SELECT * FROM records WHERE kind IN ('courses','subcourses','enrollments')")).map(parseRecord);
            const seen = new Set<string>();
            const newMembers: {id:string;name:string;studentId:string;email:string}[] = [];
            const statements: D1PreparedStatement[] = [];
            let existing = 0, matchedByEmail = 0, completed = 0, ongoing = 0, pending = 0, resetCompletions = 0;
            const now = new Date(clock()).toISOString();
            for (const [index, raw] of input.rows.entries()) {
                const name = String(raw?.name ?? '').trim();
                const email = String(raw?.email ?? '').trim().toLowerCase();
                const phone = String(raw?.phone ?? '').trim();
                const studentId = String(raw?.studentId ?? '').trim();
                const courseRef = String(raw?.course ?? '').trim();
                const listed = raw?.completedSubcourses;
                const line = Number(raw?.sourceLine) || index + 2;
                if (!name || !email || !studentId || !courseRef || !Array.isArray(listed) || listed.length > 80 ||
                    listed.some((v:unknown) => typeof v !== 'string' || !v.trim() || v.length > 150))
                    throw new HubError(`Row ${line}: Name, Email, Student ID, Course and completed SUB COURSE list are required.`, 400);
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
                    throw new HubError(`Row ${line}: Invalid email address.`, 400);
                if (!/^[a-z0-9][a-z0-9_-]{1,39}$/i.test(studentId))
                    throw new HubError(`Row ${line}: Student ID must have 2–40 letters, numbers, hyphens or underscores.`, 400);
                const courses = catalog.filter(r => r.kind === 'courses' && (key(r.id) === key(courseRef) || key(r.data.name) === key(courseRef)));
                if (courses.length !== 1) throw new HubError(`Row ${line}: Course not found uniquely in Admin: ${courseRef}. Create the course first.`, 400);
                const course = courses[0];
                const modules = catalog.filter(r => r.kind === 'subcourses' && r.data.courseId === course.id);
                if (!modules.length) throw new HubError(`Row ${line}: No subcourses exist under ${courseRef}. Create them in Admin first.`, 400);
                // Student IDs must not collide with Trainer login IDs, even
                // when a valid student can otherwise be matched by email.
                if (members.some(p => p.role === 'trainer' && key(p.data.trainerId) === key(studentId)))
                    throw new HubError(`Row ${line}: Student ID conflicts with an existing Trainer ID.`, 409);
                const matchingId = members.filter(p => p.role === 'student' && key(p.data.studentId) === key(studentId));
                const matchingEmail = members.filter(p => key(p.email) === key(email));
                if (matchingId.length > 1 || matchingEmail.length > 1 ||
                    (matchingId.length && matchingEmail.length && matchingId[0].id !== matchingEmail[0].id))
                    throw new HubError(`Row ${line}: Student ID and email identify different accounts; correct the spreadsheet before importing.`, 409);
                const pupil = matchingId[0] || matchingEmail[0];
                if (pupil) {
                    if (pupil.role !== 'student' || pupil.status !== 'Active')
                        throw new HubError(`Row ${line}: The email belongs to a non-student or inactive account. Ask Admin to correct it.`, 409);
                    if (key(pupil.email) !== key(email))
                        throw new HubError(`Row ${line}: Student ID ${studentId} already belongs to another email.`, 409);
                    if (!matchingId.length && key(pupil.name) !== key(name))
                        throw new HubError(`Row ${line}: Email matches an existing student but name differs; confirm the identity in Admin.`, 409);
                    existing++;
                    if (key(pupil.data.studentId) !== key(studentId)) matchedByEmail++;
                } else {
                    // Prevent duplicates among new rows in the same request.
                    if (members.some(m => key(m.data?.studentId) === key(studentId)))
                        throw new HubError(`Row ${line}: Student ID conflicts with an existing institute account.`, 409);
                }
                const id = pupil?.id || crypto.randomUUID();
                const uniqueRow = `${id}:${course.id}`;
                if (seen.has(uniqueRow) || seen.has(`email:${email}`))
                    throw new HubError(`Row ${line}: Duplicate student/course or email in this upload chunk.`, 409);
                seen.add(uniqueRow);seen.add(`email:${email}`);
                const completedIds = new Set<string>();
                for (const label of listed as string[]) {
                    const candidate = modules.filter(m => key(m.data.name) === key(label) || key(m.id) === key(label));
                    if (candidate.length !== 1) throw new HubError(`Row ${line}: Subcourse not found uniquely under ${courseRef}: ${label}`, 400);
                    if (completedIds.has(candidate[0].id)) throw new HubError(`Row ${line}: Duplicate completed subcourse: ${label}`, 409);
                    completedIds.add(candidate[0].id);
                }
                // Validate the whole row before adding it to the transaction.
                const preparedProgress: {id:string;data:Record<string,unknown>}[] = [];
                for (const module of modules) {
                    const progressId = `module-progress:${id}:${module.id}`;
                    const done = completedIds.has(module.id);
                    const attended = !done && !!pupil && await hasModuleAttendance(id, module.id);
                    const status = done ? 'Completed' : attended ? 'Ongoing' : 'Pending';
                    const previous = pupil ? await first("SELECT data FROM records WHERE id=? AND kind='module-progress'", progressId) : null;
                    const previousData = previous ? JSON.parse(previous.data) : null;
                    if (previousData?.status === 'Completed' && status !== 'Completed') resetCompletions++;
                    if (status === 'Completed') completed++;
                    else if (status === 'Ongoing') ongoing++;
                    else pending++;
                    preparedProgress.push({id: progressId, data: {
                        studentId: id, courseId: course.id, subcourseId: module.id, status,
                        source: done ? 'Admin combined Excel import' : attended ? 'Attendance' : 'Admin combined Excel import',
                        importedBy: me.id, importedAt: now,
                        ...(done ? {completedAt: now, approvedBy: me.id, approvedByName: me.name,
                            criteriaNote: 'Listed as completed in Admin-verified Student Details workbook'} : {}),
                        ...(previousData?.status === 'Completed' && !done ? {priorApproval: {
                            completedAt: previousData.completedAt || '', approvedBy: previousData.approvedBy || '',
                            criteriaNote: previousData.criteriaNote || '' }} : {})
                    }});
                }
                if (!pupil) {
                    // Overall Excel STATUS (Ongoing/Completed) is academic, not account status.
                    const profile = {name, email, phone, studentId, courseId: course.id, batchId: '', status: 'Active'};
                    statements.push(db.prepare("INSERT INTO members(id,user_id,email,name,role,status,data,created_at) VALUES (?,NULL,?,?,'student','Active',?,?)")
                        .bind(id, email, name, JSON.stringify(profile), now));
                    newMembers.push({id, name, studentId, email});
                    members.push({id, name, email, userId: null, role: 'student', status: 'Active', data: profile, createdAt: now});
                } else if (pupil.data.courseId !== course.id && !catalog.some(r => r.kind === 'enrollments' &&
                    r.data.studentId === id && r.data.courseId === course.id && r.data.status === 'Active')) {
                    const enrollmentId = crypto.randomUUID();
                    const enrollment = {studentId: id, courseId: course.id, batchId: '', status: 'Active', enrolledBy: me.id};
                    statements.push(db.prepare("INSERT INTO records(id,kind,data,created_at,updated_at) VALUES (?,'enrollments',?,?,?)")
                        .bind(enrollmentId, JSON.stringify(enrollment), now, now));
                    catalog.push({id: enrollmentId, kind: 'enrollments', data: enrollment, createdAt: now});
                }
                for (const item of preparedProgress) {
                    statements.push(db.prepare(`INSERT INTO records(id,kind,data,created_at,updated_at)
                        VALUES (?,'module-progress',?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
                        .bind(item.id, JSON.stringify(item.data), now, now));
                }
            }
            statements.push(db.prepare('INSERT INTO audits(id,actor,action,detail,created_at) VALUES (?,?,?,?,?)')
                .bind(crypto.randomUUID(), me.name, 'Combined student/progress import',
                    `${input.rows.length} rows, ${newMembers.length} created, ${existing} matched, ${completed} completed modules`, now));
            if (statements.length > 600) throw new HubError('Too many modules in this import chunk. Use smaller chunks.', 400);
            await db.batch(statements);
            return {imported: input.rows.length, created: newMembers, existing, matchedByEmail,
                completed, ongoing, pending, resetCompletions, data: await load(me)};
        }
        if (op === 'importStudentDetailsCompleted') {
            admin(me);
            if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 10)
                throw new HubError('Import 1–10 student details rows at a time.');
            const normalize = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
            const students = (await all("SELECT * FROM members WHERE role='student' AND status='Active'")).map(parseMember);
            const catalog = (await all("SELECT * FROM records WHERE kind IN ('courses','subcourses','enrollments')")).map(parseRecord);
            const seenStudents = new Set<string>();
            const snapshots: {id: string; data: any}[] = [];
            let completedCount = 0;
            let ongoingCount = 0;
            let pendingCount = 0;
            let resetCount = 0;
            for (const [index, raw] of input.rows.entries()) {
                const studentRef = String(raw?.studentId ?? '').trim();
                const courseRef = String(raw?.course ?? '').trim();
                const listed: unknown = raw?.completedSubcourses;
                if (!studentRef || !courseRef || !Array.isArray(listed) || listed.length > 80 ||
                    listed.some(name => typeof name !== 'string' || !name.trim() || name.length > 150))
                    throw new HubError(`Row ${index + 1}: Supply Student ID, Course and a list of completed subcourse names.`, 400);
                const matchingStudents = students.filter(p => normalize(p.data.studentId) === normalize(studentRef) || normalize(p.id) === normalize(studentRef));
                if (matchingStudents.length !== 1) throw new HubError(`Row ${index + 1}: Student ID not uniquely found: ${studentRef}`, 400);
                const pupil = matchingStudents[0];
                const matchingCourses = catalog.filter(r => r.kind === 'courses' &&
                    (normalize(r.data.name) === normalize(courseRef) || normalize(r.id) === normalize(courseRef)));
                if (matchingCourses.length !== 1) throw new HubError(`Row ${index + 1}: Course not uniquely found: ${courseRef}`, 400);
                const course = matchingCourses[0];
                const studentCourseKey = `${pupil.id}:${course.id}`;
                if (seenStudents.has(studentCourseKey)) throw new HubError(`Row ${index + 1}: Duplicate student/course in the uploaded details.`, 409);
                seenStudents.add(studentCourseKey);
                if (pupil.data.courseId !== course.id && !catalog.some(r =>
                    r.kind === 'enrollments' && r.data.studentId === pupil.id && r.data.courseId === course.id && r.data.status === 'Active'))
                    throw new HubError(`Row ${index + 1}: ${studentRef} is not enrolled in ${courseRef}.`, 403);
                const modules = catalog.filter(r => r.kind === 'subcourses' && r.data.courseId === course.id);
                if (!modules.length) throw new HubError(`Row ${index + 1}: Create the subcourses for ${courseRef} in Admin first.`, 400);
                const completedIds = new Set<string>();
                for (const item of listed as string[]) {
                    const found = modules.filter(m => normalize(m.data.name) === normalize(item) || normalize(m.id) === normalize(item));
                    if (found.length !== 1) throw new HubError(`Row ${index + 1}: Subcourse not uniquely found in ${courseRef}: ${item}`, 400);
                    if (completedIds.has(found[0].id)) throw new HubError(`Row ${index + 1}: Duplicate completed subcourse: ${item}`, 409);
                    completedIds.add(found[0].id);
                }
                const now = new Date(clock()).toISOString();
                for (const module of modules) {
                    const id = `module-progress:${pupil.id}:${module.id}`;
                    const completed = completedIds.has(module.id);
                    const attended = !completed && await hasModuleAttendance(pupil.id, module.id);
                    const status = completed ? 'Completed' : attended ? 'Ongoing' : 'Pending';
                    const previous = await first('SELECT data FROM records WHERE id=? AND kind=?', id, 'module-progress');
                    const previousData = previous ? JSON.parse(previous.data) : null;
                    const previousStatus = previousData?.status || '';
                    if (previousStatus === 'Completed' && status !== 'Completed') resetCount++;
                    if (status === 'Completed') completedCount++;
                    else if (status === 'Ongoing') ongoingCount++;
                    else pendingCount++;
                    const data = {studentId: pupil.id, courseId: course.id, subcourseId: module.id, status,
                        source: completed ? 'Admin student details Excel' : attended ? 'Attendance' : 'Admin student details Excel',
                        importedAt: now, importedBy: me.id,
                        ...(completed ? {completedAt: now, approvedBy: me.id, approvedByName: me.name,
                            criteriaNote: 'Listed as completed in verified student details workbook'} : {}),
                        ...(previousStatus && previousStatus !== status ? {
                            previousStatus,
                            ...(previousStatus === 'Completed' ? {priorApproval: {
                                completedAt: previousData.completedAt || '', approvedBy: previousData.approvedBy || '',
                                criteriaNote: previousData.criteriaNote || ''}} : {})
                        } : {})};
                    snapshots.push({id, data});
                }
            }
            const now = new Date(clock()).toISOString();
            const statements = snapshots.map(row => db.prepare(`INSERT INTO records(id,kind,data,created_at,updated_at)
                VALUES (?,'module-progress',?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
                .bind(row.id, JSON.stringify(row.data), now, now));
            statements.push(db.prepare('INSERT INTO audits(id,actor,action,detail,created_at) VALUES (?,?,?,?,?)')
                .bind(crypto.randomUUID(), me.name, 'Student details completion snapshot imported',
                    `${seenStudents.size} student/course rows, ${completedCount} Completed, ${ongoingCount} Ongoing, ${pendingCount} Pending, ${resetCount} prior completions reset`, now));
            await db.batch(statements);
            return {imported: seenStudents.size, completed: completedCount, ongoing: ongoingCount,
                pending: pendingCount, resetCompletions: resetCount, data: await load(me)};
        }
        if (op === 'importModuleProgress') {
            admin(me);
            if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 50)
                throw new HubError('Import 1–50 subcourse status rows at a time.');
            const students = (await all("SELECT * FROM members WHERE role='student' AND status='Active'")).map(parseMember);
            const catalog = (await all("SELECT * FROM records WHERE kind IN ('courses','subcourses','enrollments')")).map(parseRecord);
            const key = (v: unknown) => String(v ?? '').trim().toLowerCase();
            const seen = new Set<string>();
            const prepared: { id:string; data:any; status:string; studentName:string; moduleName:string }[] = [];
            for (const [index,raw] of input.rows.entries()) {
                const field = (k:string) => String(raw?.[k] ?? '').trim();
                const studentRef = field('studentId'), courseRef=field('course'), moduleRef=field('subcourse');
                const state = field('status').toLowerCase();
                if (!studentRef || !courseRef || !moduleRef || !['','pending','completed','not completed'].includes(state))
                    throw new HubError(`Row ${index+1}: Provide Student ID, Course, Subcourse and a Pending/Completed status.`);
                const matched = students.filter(x => key(x.data.studentId)===key(studentRef) || key(x.id)===key(studentRef));
                if(matched.length!==1) throw new HubError(`Row ${index+1}: Student ID not uniquely found: ${studentRef}`,400);
                const pupil=matched[0];
                const parent = catalog.filter(r=>r.kind==='courses' && (key(r.id)===key(courseRef)||key(r.data.name)===key(courseRef)));
                if(parent.length!==1) throw new HubError(`Row ${index+1}: Course not uniquely found: ${courseRef}`,400);
                const course=parent[0];
                if(pupil.data.courseId!==course.id && !catalog.some(r=>r.kind==='enrollments'&&r.data.studentId===pupil.id&&r.data.courseId===course.id&&r.data.status==='Active'))
                    throw new HubError(`Row ${index+1}: ${studentRef} is not enrolled in ${courseRef}.`,403);
                const modules=catalog.filter(r=>r.kind==='subcourses'&&r.data.courseId===course.id && (key(r.id)===key(moduleRef)||key(r.data.name)===key(moduleRef)));
                if(modules.length!==1) throw new HubError(`Row ${index+1}: Subcourse not uniquely found under ${courseRef}: ${moduleRef}`,400);
                const module=modules[0];
                const id=`module-progress:${pupil.id}:${module.id}`;
                if(seen.has(id)) throw new HubError(`Row ${index+1}: Duplicate student/course/subcourse in this upload.`,409);
                seen.add(id);
                const status=state==='completed'?'Completed':'Pending';
                const attended=await hasModuleAttendance(pupil.id,module.id);
                const now=new Date(clock()).toISOString();
                const effective=status==='Completed'?'Completed':attended?'Ongoing':'Pending';
                const detail={studentId:pupil.id,courseId:course.id,subcourseId:module.id,status:effective,
                    source:status==='Completed'?'Admin Excel import':attended?'Attendance':'Admin Excel import',
                    importedAt:now,importedBy:me.id,
                    ...(status==='Completed'?{completedAt:now,approvedBy:me.id,approvedByName:me.name,
                       criteriaNote:field('evidence')||'Admin-verified Excel completion'}:{})};
                prepared.push({id,data:detail,status:effective,studentName:pupil.name,moduleName:module.data.name});
            }
            const now=new Date(clock()).toISOString();
            const queries = prepared.map(r=>db.prepare(`INSERT INTO records(id,kind,data,created_at,updated_at)
                VALUES (?,'module-progress',?,?,?) ON CONFLICT(id) DO UPDATE SET
                data=excluded.data,updated_at=excluded.updated_at
                WHERE json_extract(records.data,'$.status')!='Completed' OR json_extract(excluded.data,'$.status')='Completed'`).bind(r.id,JSON.stringify(r.data),now,now));
            // Existing approved completions are never downgraded by Pending/attendance rows.
            // One transaction: validation failure never imports a partial chunk.
            queries.push(db.prepare('INSERT INTO audits(id,actor,action,detail,created_at) VALUES (?,?,?,?,?)')
                .bind(crypto.randomUUID(),me.name,'Subcourse statuses imported',`${prepared.length} student-module rows`,now));
            await db.batch(queries);
            return {imported:prepared.length, data:await load(me)};
        }
        if (op === 'importStudents') {
            admin(me);
            const incoming = input.rows;
            if (!Array.isArray(incoming) || !incoming.length || incoming.length > 100)
                throw new HubError('Import 1–100 students per batch.');
            const prepared: { id: string; value: Record<string, any> }[] = [];
            const seenEmail = new Set<string>(), seenId = new Set<string>();
            const stagedCounts = new Map<string,number>();
            for (const [index, raw] of incoming.entries()) {
                try {
                    const value = clean('students', raw);
                    value.status = value.status || 'Active';
                    await validateReferences('students', value);
                    if(value.batchId){const added=(stagedCounts.get(value.batchId)||0)+1;
                        const b=await record(value.batchId,'batches');
                        if(await batchSeatCount(value.batchId)+added>Number(b.data.capacity||45)) throw new HubError('Batch capacity reached. Import without Batch and assign at first attendance.');
                        stagedCounts.set(value.batchId,added);}

                    const sid = String(value.studentId).toLowerCase(), email = String(value.email).toLowerCase();
                    if (seenEmail.has(email) || seenId.has(sid)) throw new HubError('Duplicate student email or ID in this spreadsheet.');
                    seenEmail.add(email); seenId.add(sid);
                    if (await first('SELECT id FROM members WHERE email = ?', email)) throw new HubError('Email already belongs to an institute account.');
                    prepared.push({ id: crypto.randomUUID(), value });
                } catch (error) {
                    throw new HubError(`Excel row ${index + 2}: ${error instanceof Error ? error.message : 'Invalid student'}`);
                }
            }
            const now = new Date(clock()).toISOString();
            await db.batch(prepared.map(({id,value}) => db.prepare("INSERT INTO members (id,user_id,email,name,role,status,data,created_at) VALUES (?,NULL,?,?,'student',?,?,?)")
                .bind(id, value.email.toLowerCase(), value.name, value.status, JSON.stringify(value), now)));
            const future = (await all("SELECT * FROM records WHERE kind='schedules' AND json_extract(data,'$.endAt') > ?", now)).map(parseRecord);
            const rosterUpdates = future.flatMap(session => {
                const newIds = prepared.filter(row => row.value.batchId === session.data.batchId && row.value.status === 'Active').map(row => row.id);
                if (!newIds.length) return [];
                session.data.roster = Array.from(new Set([...(session.data.roster || []), ...newIds]));
                return [db.prepare('UPDATE records SET data=?, updated_at=? WHERE id=?').bind(JSON.stringify(session.data), now, session.id)];
            });
            if (rosterUpdates.length) await db.batch(rosterUpdates);
            await audit(me, 'Students imported', `${prepared.length} students from spreadsheet`);
            return { imported: prepared.map(({id,value}) => ({id, name: value.name, studentId: value.studentId, email: value.email})), data: await load(me) };
        }
        if (op === 'create' || op === 'update') {
            const kind = String(input.kind), value = clean(kind, input.data), old = op === 'update' && !['students', 'trainers'].includes(kind) ? await record(String(input.id), kind) : null;
            if (kind === 'leaves' || kind === 'bookings') {
                if (kind === 'bookings' ? me.role !== 'student' : !['student', 'trainer'].includes(me.role))
                    throw new HubError(kind === 'leaves' ? 'Only trainers and students can request leave.' : 'Only students can book slots.', 403);
                if (op === 'update')
                    throw new HubError('Submit a new request instead.');
                value.memberId = me.id;
                value.requesterRole = me.role;
                value.status = 'Pending';
                if (kind === 'leaves') {
                    // A single leave request may address Admin plus any combination
                    // of trainers currently assigned to the student's batches.
                    // Keep recipientId for older clients and existing reports.
                    const requestedRecipient = String(value.recipientId || '').trim();
                    const rawRecipients = input.data?.recipientIds;
                    if (rawRecipients !== undefined && (
                        !Array.isArray(rawRecipients) || rawRecipients.length < 1 || rawRecipients.length > 15 ||
                        rawRecipients.some((id: unknown) => typeof id !== 'string' || !id.trim() || id.trim().length > 150)
                    )) throw new HubError('Select between 1 and 15 valid leave recipients.');
                    const recipients: string[] = rawRecipients === undefined
                        ? [requestedRecipient || 'admin'] : rawRecipients.map((id: string) => id.trim());
                    if (new Set(recipients).size !== recipients.length)
                        throw new HubError('Each leave recipient can be selected only once.');
                    if (rawRecipients !== undefined && requestedRecipient && !recipients.includes(requestedRecipient))
                        throw new HubError('Leave recipient fields do not match.');
                    if (me.role === 'trainer' && (recipients.length !== 1 || recipients[0] !== 'admin'))
                        throw new HubError('Trainer leave goes to the administrator only.', 403);
                    if (me.role === 'student') {
                        const assignedBatches = await studentBatchIds(me);
                        const trainerBatches = (await all("SELECT id,data FROM records WHERE kind='batches'"))
                            .filter(batch => assignedBatches.has(batch.id));
                        const eligibleTrainers = new Set(trainerBatches.map(batch => JSON.parse(batch.data).trainerId));
                        const selectedTrainerIds = recipients.filter(id => id !== 'admin');
                        if (selectedTrainerIds.length) {
                            const active = await all("SELECT id FROM members WHERE role='trainer' AND status='Active'");
                            const activeIds = new Set(active.map(row => row.id));
                            if (selectedTrainerIds.some(id => !eligibleTrainers.has(id) || !activeIds.has(id)))
                                throw new HubError('Leave requests can be sent only to your assigned active trainers or Admin.', 403);
                        }
                    }
                    value.recipientId = recipients[0];
                    value.recipientIds = recipients;
                }
                if (kind === 'bookings') {
                    const session = await record(value.scheduleId, 'schedules');
                    await canAttend(me, session);
                    if (Date.parse(session.data.endAt) < clock())
                        throw new HubError('This class has already ended.');
                    const duplicate = await first("SELECT id FROM records WHERE kind = 'bookings' AND json_extract(data,'$.memberId') = ? AND json_extract(data,'$.scheduleId') = ? AND json_extract(data,'$.status') != 'Rejected' LIMIT 1", me.id, value.scheduleId);
                    if (duplicate)
                        throw new HubError('You already have a booking for this class.');
                }
            }
            else if (kind === 'holidays' && me.role === 'trainer') {
                if (!value.batchId) throw new HubError('Choose one of your assigned batches for a holiday.');
                await canManageBatch(me, value.batchId);
                if (op === 'update') {
                    if (!old || old.data.createdByMemberId !== me.id)
                        throw new HubError('You can edit only the batch holidays you created.', 403);
                    await canManageBatch(me, old.data.batchId);
                }
                value.createdByMemberId = me.id;
            }
            else if(kind==='batches' && me.role==='trainer') {
                if(op!=='create' || value.trainerId!==me.id) throw new HubError('Trainers can create only their own authorized batches.',403);
                // Sharing a batch with additional parent programs is Admin-only.
                // Otherwise a trainer could expose unrelated students to a new batch.
                if (batchCourses(value).length !== 1) throw new HubError('Only Admin can assign multiple courses to a batch.',403);
                const own=(await all("SELECT data FROM records WHERE kind='batches' AND json_extract(data,'$.trainerId')=?",me.id)).map(r=>JSON.parse(r.data));
                if(!own.some(b=>b.courseId===value.courseId && b.branchId===value.branchId)) throw new HubError('Trainer can create batches only within their already assigned course and branch.',403);
            }
            else if (kind === 'schedules' && me.role === 'trainer') { throw new HubError('Only Admin can create or edit class schedules.', 403); }
            else
                admin(me);
            await validateReferences(kind, { ...value, _id: input.id });
            const now = new Date(clock()).toISOString(), id = op === 'update' ? String(input.id) : crypto.randomUUID();
            if (kind === 'students' || kind === 'trainers') {
                const role: Role = kind === 'students' ? 'student' : 'trainer';
                if (op === 'update') {
                    const existing = await first('SELECT * FROM members WHERE id = ? AND role = ?', id, role);
                    if (!existing)
                        throw new HubError('Account not found.', 404);
                    if (existing.user_id && existing.email !== value.email.toLowerCase())
                        throw new HubError('An account email cannot change after the first sign-in.');
                    await run('UPDATE members SET name = ?,email = ?,status = ?,data = ? WHERE id = ? AND role = ?', value.name, value.email.toLowerCase(), value.status, JSON.stringify({ ...JSON.parse(existing.data), ...value }), id, role);
                }
                else
                    await run('INSERT INTO members (id,user_id,email,name,role,status,data,created_at) VALUES (?,NULL,?,?,?,?,?,?)', id, value.email.toLowerCase(), value.name, role, value.status, JSON.stringify(value), now);
            }
            else {
                const merged = old ? { ...old.data, ...value } : value;
                if (kind === 'holidays' && me.role === 'trainer') merged.createdByMemberId = me.id;
                if (kind === 'schedules') {
                    if (old?.data.sessionStatus && old.data.sessionStatus !== 'Upcoming') throw new HubError('Started or completed sessions cannot be rescheduled.');
                    if (!old) Object.assign(merged, { sessionStatus: 'Upcoming', sessionOpen:false, originalDeadline: merged.endAt, effectiveDeadline: merged.endAt, extensionMinutes:0, extensions:[] });
                    const batch = await record(merged.batchId, 'batches');
                    merged.courseId = batch.data.courseId;
                    const primaries = (await all("SELECT id FROM members WHERE role = 'student' AND status = 'Active' AND json_extract(data,'$.batchId') = ?", merged.batchId)).map(m => m.id);
                    const extra = (await all("SELECT json_extract(data,'$.studentId') AS id FROM records WHERE kind='enrollments' AND json_extract(data,'$.batchId')=? AND json_extract(data,'$.status')='Active'", merged.batchId)).map(m => m.id);
                    merged.roster = [...new Set([...primaries, ...extra])];
                }
                if (old?.kind === 'schedules' && await first('SELECT id FROM attendance WHERE schedule_id = ? LIMIT 1', id))
                    throw new HubError('Classes with attendance cannot be edited. Create a new class instead.');
                if (kind === 'batches') Object.assign(merged, { courseDurationDays: value.courseDurationDays, classDurationMinutes: value.classDurationMinutes });
                if (op === 'update')
                    await run('UPDATE records SET data = ?,updated_at = ? WHERE id = ?', JSON.stringify(merged), now, id);
                else
                    await run('INSERT INTO records (id,kind,data,created_at,updated_at) VALUES (?,?,?,?,?)', id, kind, JSON.stringify(merged), now, now);
            }
            if (kind === 'batches') await generateDailySessions(id, value, me);
            if (kind === 'holidays') {
                // Newly declared holidays cancel only untouched auto-generated classes.
                const sql=`UPDATE records SET data=json_set(data,'$.sessionStatus','Cancelled',
                    '$.closureReason','Institute or batch holiday','$.sessionOpen',json('false')),updated_at=?
                    WHERE kind='schedules' AND json_extract(data,'$.batchDay')=?
                    AND json_extract(data,'$.sessionStatus')='Upcoming'
                    AND json_extract(data,'$.startAt')>?
                    AND (?='' OR json_extract(data,'$.batchId')=?)`;
                await run(sql,now,value.date,now,value.batchId||'',value.batchId||'');
            }

            if (kind === 'enrollments') {
                const future = (await all("SELECT * FROM records WHERE kind='schedules' AND json_extract(data,'$.endAt') > ?", now)).map(parseRecord);
                const attended = new Set((await all('SELECT schedule_id FROM attendance WHERE member_id = ?', value.studentId)).map(r => r.schedule_id));
                // On creation or update, recompute future rosters for this student.
                // Old enrollment's student is also recalculated if reassigned.
                const affected = new Set([value.studentId]);
                const batchesByStudent = new Map<string, Set<string>>();
                for (const studentId of affected) {
                    const person = await first('SELECT * FROM members WHERE id = ?', studentId);
                    if (person) batchesByStudent.set(studentId, await studentBatchIds(parseMember(person)));
                }
                const updates = future.map(r => {
                    const roster = new Set<string>(r.data.roster || []);
                    for (const studentId of affected) {
                        if (!attended.has(r.id)) roster.delete(studentId);
                        if (batchesByStudent.get(studentId)?.has(r.data.batchId)) roster.add(studentId);
                    }
                    r.data.roster = [...roster];
                    return db.prepare('UPDATE records SET data=?,updated_at=? WHERE id=?').bind(JSON.stringify(r.data), now, r.id);
                });
                if (updates.length) await db.batch(updates);
            }
            if (kind === 'students') {
                const future = (await all("SELECT * FROM records WHERE kind = 'schedules' AND json_extract(data,'$.endAt') > ?", now)).map(parseRecord);
                const attended = new Set((await all('SELECT schedule_id FROM attendance WHERE member_id = ?', id)).map(a => a.schedule_id));
                const updates = future.map(r => { const roster = new Set<string>(r.data.roster || []); if (!attended.has(r.id))
                    roster.delete(id); if (r.data.batchId === value.batchId && value.status === 'Active')
                    roster.add(id); r.data.roster = [...roster]; return db.prepare('UPDATE records SET data = ?,updated_at = ? WHERE id = ?').bind(JSON.stringify(r.data), now, r.id); });
                if (updates.length)
                    await db.batch(updates);
            }
            await audit(me, op === 'create' ? 'Created' : 'Updated', `${definitions[kind].singular}: ${value.name || value.title || value.company || value.reason || id}`);
            result = { id };
        }
        else if (op === 'forceDelete') {
            admin(me);
            const kind=String(input.kind), id=String(input.id);
            if(['students','trainers'].includes(kind)) throw new HubError('Use the protected account deletion API.',403);
            if(!definitions[kind]) throw new HubError('Unknown record type.');
            return await cascadeDelete(user,kind,id,String(input.confirmation||''));
        }
        else if (op === 'delete') {
            const id = String(input.id), kind = String(input.kind);
            if (me.role === 'trainer' && kind === 'holidays') {
                const holiday = await record(id, 'holidays');
                if (!holiday.data.batchId || holiday.data.createdByMemberId !== me.id)
                    throw new HubError('You can delete only holidays you created for an assigned batch.', 403);
                await canManageBatch(me, holiday.data.batchId);
            } else admin(me);
            if (kind === 'students' || kind === 'trainers') {
                const m = await first('SELECT * FROM members WHERE id = ? AND role = ?', id, kind === 'students' ? 'student' : 'trainer');
                if (!m)
                    throw new HubError('Account not found.', 404);
                await run("UPDATE members SET status = 'Inactive' WHERE id = ?", id);
                await audit(me, 'Deactivated', m.name);
            }
            else {
                const r = await record(id, kind);
                if (r.kind === 'enrollments') {
                    const used = await first("SELECT a.id FROM attendance a JOIN records s ON s.id=a.schedule_id AND s.kind='schedules' WHERE a.member_id=? AND json_extract(s.data,'$.batchId')=? LIMIT 1", r.data.studentId, r.data.batchId);
                    if (used) throw new HubError('This enrollment has attendance history; set it Inactive instead of deleting.');
                }
                if (r.kind === 'schedules' && await first('SELECT id FROM attendance WHERE schedule_id = ? LIMIT 1', id))
                    throw new HubError('Classes with attendance must be kept for reporting.');
                const refs = await first("SELECT id FROM records WHERE id != ? AND (json_extract(data,'$.courseId') = ? OR json_extract(data,'$.batchId') = ? OR json_extract(data,'$.branchId') = ? OR json_extract(data,'$.roomId') = ? OR json_extract(data,'$.scheduleId') = ?) LIMIT 1", id, id, id, id, id, id), mr = await first("SELECT id FROM members WHERE json_extract(data,'$.batchId') = ? OR json_extract(data,'$.courseId') = ? LIMIT 1", id, id);
                const secondaryBatch = r.kind === 'courses' ? await first("SELECT id FROM records WHERE kind='batches' AND EXISTS(SELECT 1 FROM json_each(coalesce(json_extract(data,'$.courseIds'),'[]')) WHERE value=?) LIMIT 1",id) : null;
                if (refs || mr || secondaryBatch)
                    throw new HubError('This record is still in use. Remove or reassign its linked course, subcourse, batch, schedule, room or member records first.');
                await run('DELETE FROM records WHERE id = ?', id);
                if (r.kind === 'enrollments') {
                    const student = await first('SELECT * FROM members WHERE id=?', r.data.studentId);
                    if (student) {
                        const allowed = await studentBatchIds(parseMember(student));
                        const future = (await all("SELECT * FROM records WHERE kind='schedules' AND json_extract(data,'$.endAt') > ?", new Date(clock()).toISOString())).map(parseRecord);
                        const changes = future.map(session => {
                            const roster = new Set<string>(session.data.roster || []);
                            roster.delete(r.data.studentId);
                            if (allowed.has(session.data.batchId)) roster.add(r.data.studentId);
                            session.data.roster = [...roster];
                            return db.prepare('UPDATE records SET data=?,updated_at=? WHERE id=?').bind(JSON.stringify(session.data), new Date(clock()).toISOString(), session.id);
                        });
                        if (changes.length) await db.batch(changes);
                    }
                }
                await audit(me, 'Deleted', `${definitions[kind]?.singular}: ${r.data.name || r.data.title || id}`);
            }
        }
        else if (op === 'review') {
            const r = await record(String(input.id));
            if (!['leaves', 'bookings'].includes(r.kind))
                throw new HubError('This record cannot be reviewed.');
            if (me.role === 'student' || r.data.memberId === me.id || r.kind === 'bookings' && me.role === 'trainer')
                throw new HubError('Only an administrator or an assigned trainer can review another person’s request.', 403);
            const requester = await first('SELECT * FROM members WHERE id = ?', r.data.memberId);
            if (!requester) throw new HubError('The requester no longer exists.', 404);
            // Explicit recipient controls review access. Legacy requests without a
            // recipient retain their earlier assigned-trainer/Admin behavior.
            if (r.kind === 'leaves' && r.data.recipientId) {
                const recipients = leaveRecipients(r.data);
                if ((me.role === 'admin' && !recipients.includes('admin')) ||
                    (me.role === 'trainer' && !recipients.includes(me.id)))
                    throw new HubError('This leave request was addressed to another reviewer.', 403);
            }
            if (me.role !== 'admin' && (r.kind !== 'leaves' || !r.data.recipientId)) {
                if (me.role !== 'trainer' || requester.role !== 'student')
                    throw new HubError('Only an administrator can review trainer leave.', 403);
                const allowed = await studentBatchIds(parseMember(requester));
                const assigned = await all("SELECT id FROM records WHERE kind='batches' AND json_extract(data,'$.trainerId')=?", me.id);
                if (!assigned.some(batch => allowed.has(batch.id)))
                    throw new HubError('You can review only requests from your assigned students.', 403);
            }
            if (!['Approved', 'Rejected'].includes(input.status))
                throw new HubError('Choose an approval outcome.');
            // Atomic conditional update: the second reviewer gets 409 instead of overwriting.
            r.data.status = input.status;
            r.data.reviewedBy = me.name;
            r.data.reviewedByMemberId = me.id;
            r.data.reviewedAt = new Date(clock()).toISOString();
            const change = await run("UPDATE records SET data=?,updated_at=? WHERE id=? AND kind=? AND json_extract(data,'$.status')='Pending'", JSON.stringify(r.data), r.data.reviewedAt, r.id, r.kind);
            if (!change.meta?.changes) throw new HubError('This request has already been reviewed. Refresh to see its current status.', 409);
            await audit(me, input.status, definitions[r.kind].singular);
        }
        else if (op === 'openSession' || op === 'closeSession' || op === 'extendSession' || op === 'cancelSession') {
            const r = await record(String(input.id), 'schedules');
            await canManageBatch(me, r.data.batchId);
            const now = new Date(clock()).toISOString();
            let change: any;
            if (op === 'openSession') {
                const zone=(await settings()).timeZone||'Asia/Kolkata';
                const day=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.data.startAt));
                if(await first("SELECT id FROM records WHERE kind='holidays' AND json_extract(data,'$.date')=? AND (coalesce(json_extract(data,'$.batchId'),'')='' OR json_extract(data,'$.batchId')=?) LIMIT 1",day,r.data.batchId))
                    throw new HubError('The class cannot start on a declared holiday.',409);
                if (clock() < Date.parse(r.data.startAt)-15*60000 || clock()>=Date.parse(r.data.endAt))
                    throw new HubError('Start is available 15 minutes before the class until its scheduled deadline.');
                change=await run(`UPDATE records SET data=json_set(data,
                    '$.sessionStatus','In Progress', '$.sessionOpen',json('true'), '$.actualStartAt',?,
                    '$.originalDeadline',json_extract(data,'$.endAt'),
                    '$.effectiveDeadline',json_extract(data,'$.endAt'), '$.extensionMinutes',0,
                    '$.extensions',json('[]')),updated_at=?
                    WHERE id=? AND kind='schedules' AND coalesce(json_extract(data,'$.sessionStatus'),'Upcoming')='Upcoming'
                    AND json_extract(data,'$.endAt')>?`,now,now,r.id,now);
            } else if (op === 'extendSession') {
                const minutes=Number(input.minutes);
                if (![15,30].includes(minutes)) throw new HubError('Choose a 15 or 30 minute extension.');
                const requestId=String(input.requestId||'');
                if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new HubError('Send a unique request ID for each extension.');
                change=await run(`UPDATE records SET data=json_set(data,
                    '$.effectiveDeadline',strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(data,'$.effectiveDeadline'), '+'||?||' minutes'),
                    '$.extensionMinutes',coalesce(json_extract(data,'$.extensionMinutes'),0)+?,
                    '$.extensions',json_insert(json(coalesce(json_extract(data,'$.extensions'),'[]')),'$[#]',
                    json_object('id',?,'minutes',?,'requestedBy',?,'requestedAt',?,
                    'previousDeadline',json_extract(data,'$.effectiveDeadline'),'approved',1))),updated_at=?
                    WHERE id=? AND kind='schedules' AND json_extract(data,'$.sessionStatus')='In Progress'
                    AND json_extract(data,'$.effectiveDeadline')>?
                    AND NOT EXISTS (SELECT 1 FROM json_each(coalesce(json_extract(data,'$.extensions'),'[]')) WHERE json_extract(value,'$.id')=?)`,minutes,minutes,requestId,minutes,me.id,now,now,r.id,now,requestId);
            } else if (op === 'closeSession') {
                change=await run(`UPDATE records SET data=json_set(data,
                  '$.sessionStatus','Completed','$.sessionOpen',json('false'),
                  '$.actualEndAt',?, '$.closureReason','Manual end'),updated_at=?
                  WHERE id=? AND kind='schedules' AND json_extract(data,'$.sessionStatus')='In Progress'
                  AND json_extract(data,'$.effectiveDeadline')>?`,now,now,r.id,now);
            } else {
                admin(me);
                change=await run(`UPDATE records SET data=json_set(data,
                  '$.sessionStatus','Cancelled','$.sessionOpen',json('false'),
                  '$.actualEndAt',?,'$.closureReason','Cancelled by administrator'),updated_at=?
                  WHERE id=? AND kind='schedules' AND coalesce(json_extract(data,'$.sessionStatus'),'Upcoming') IN ('Upcoming','In Progress')
                  AND coalesce(json_extract(data,'$.effectiveDeadline'),json_extract(data,'$.endAt'))>?`,now,now,r.id,now);
            }
            if (!change.meta?.changes) throw new HubError('This session has changed or its deadline passed. Refresh and try again.',409);
            if (op==='closeSession'||op==='cancelSession') {
                await run('UPDATE attendance SET checked_out=? WHERE schedule_id=? AND checked_in IS NOT NULL AND checked_out IS NULL',now,r.id);
            }
            await audit(me,op,r.data.name);
            result={ schedule: await record(r.id,'schedules') };
        }
        else if(op === 'completeModule') {
            if(!['admin','trainer'].includes(me.role)) throw new HubError('Only Admin or the assigned trainer may sign off a module.',403);
            const studentRow=await first("SELECT * FROM members WHERE id=? AND role='student' AND status='Active'",String(input.studentId));
            if(!studentRow) throw new HubError('Active student not found.',404);
            const pupil=parseMember(studentRow);
            const teachingModule=await record(String(input.subcourseId),'subcourses');
            const batches=(await all("SELECT * FROM records WHERE kind='batches' AND json_extract(data,'$.subcourseId')=?",teachingModule.id)).map(parseRecord);
            const assigned=await studentBatchIds(pupil);
            const permitted=batches.filter(b=>assigned.has(b.id) && (me.role==='admin'||b.data.trainerId===me.id));
            if(!permitted.length && me.role==='trainer') throw new HubError('This student is not enrolled with you in this teaching module.',403);
            let module = teachingModule;
            if(me.role==='trainer') {
                const batch=permitted[0];
                const enrollment = await first("SELECT data FROM records WHERE kind='enrollments' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.batchId')=? AND json_extract(data,'$.status')='Active' LIMIT 1",pupil.id,batch.id);
                const studentCourseId = enrollment ? JSON.parse(enrollment.data).courseId : pupil.data.courseId;
                if (studentCourseId!==teachingModule.data.courseId) {
                    const actual = await first("SELECT * FROM records WHERE kind='subcourses' AND json_extract(data,'$.courseId')=? AND lower(json_extract(data,'$.name'))=lower(?) LIMIT 1",studentCourseId,teachingModule.data.name);
                    if (!actual) throw new HubError('Add this subcourse to the student’s parent course before recording module completion.',409);
                    module = parseRecord(actual);
                }
            }
            if(me.role==='admin' && pupil.data.courseId!==module.data.courseId && !await first("SELECT id FROM records WHERE kind='enrollments' AND json_extract(data,'$.studentId')=? AND json_extract(data,'$.courseId')=? AND json_extract(data,'$.status')='Active' LIMIT 1",pupil.id,module.data.courseId))
                throw new HubError('Student is not enrolled in this course.',403);
            const ids=permitted.map(b=>b.id);
            const attended=await first(`SELECT count(*) AS total FROM attendance a JOIN records r ON r.id=a.schedule_id
              WHERE a.member_id=? AND a.status IN ('Present','Late') AND json_extract(r.data,'$.batchId') IN (${ids.map(()=>'?').join(',')})`,pupil.id,...ids);
            if(me.role==='trainer' && !Number(attended?.total)) throw new HubError('Cannot complete a module without recorded attendance.',409);
            const evidence=String(input.criteriaNote||'').trim();
            if(evidence.length<12||evidence.length>1200) throw new HubError('Describe the demonstrated learning/assessment criteria (12–1200 characters).',400);
            const id=`module-progress:${pupil.id}:${module.id}`;
            const now=new Date(clock()).toISOString();
            const progress={studentId:pupil.id,courseId:module.data.courseId,subcourseId:module.id,status:'Completed',completedAt:now,approvedBy:me.id,approvedByName:me.name,criteriaNote:evidence};
            await run("INSERT INTO records(id,kind,data,created_at,updated_at) VALUES (?,'module-progress',?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",id,JSON.stringify(progress),now,now);
            await audit(me,'Module completed',`${pupil.name}: ${module.data.name}`);
        }
        else if(op === 'updateBatchSchedule') {
            if(me.role!=='trainer') throw new HubError('Only assigned trainers can change their teaching schedule here.',403);
            const old=await record(String(input.batchId),'batches');
            await canManageBatch(me,old.id);
            const data={...old.data,startDate:String(old.data.startDate||''),endDate:String(input.endDate||old.data.endDate),dailyStartTime:String(input.dailyStartTime||old.data.dailyStartTime||''),dailyEndTime:String(input.dailyEndTime||old.data.dailyEndTime||''),batchType:String(input.batchType||old.data.batchType||'Weekday'),capacity:Number(old.data.capacity||45)};
            await validateReferences('batches',{...data,_id:old.id});
            if(data.startDate > data.endDate) throw new HubError('End date must be on or after start date.');
            await run('UPDATE records SET data=?,updated_at=? WHERE id=?',JSON.stringify(data),new Date(clock()).toISOString(),old.id);
            await generateDailySessions(old.id,data,me);
            await audit(me,'Trainer batch schedule updated',old.data.name);
        }
        else if (op === 'setBatchCapacity') {
            if(!['admin','trainer'].includes(me.role)) throw new HubError('Only Admin or the assigned trainer can set batch capacity.',403);
            const batch=await record(String(input.batchId),'batches');
            await canManageBatch(me,batch.id);
            const capacity=Number(input.capacity), count=await batchSeatCount(batch.id);
            if(!Number.isInteger(capacity) || capacity<Math.max(1,count) || capacity>1000)
                throw new HubError(`Capacity must be between ${Math.max(1,count)} and 1000.`,400);
            await run("UPDATE records SET data=json_set(data,'$.capacity',?),updated_at=? WHERE id=? AND kind='batches'",capacity,new Date(clock()).toISOString(),batch.id);
            await audit(me,'Batch capacity updated',`${batch.data.name}: ${capacity}`);
        }
        else if (op === 'scanStudentQr') {
            const { session } = await scanContext(me, String(input.scheduleId));
            const now = new Date(clock()).toISOString(), rateId = `scan-rate:${me.id}:${Math.floor(clock() / 300000)}`;
            await run("INSERT INTO records (id,kind,data,created_at,updated_at) VALUES (?,'scan-rate','1',?,?) ON CONFLICT(id) DO UPDATE SET data=CAST(CAST(data AS INTEGER) + 1 AS TEXT)", rateId, now, now);
            const rate = await first('SELECT data FROM records WHERE id = ?', rateId);
            if (Number(rate.data) > 500) throw new HubError('Too many scan attempts. Wait five minutes before trying again.', 429);
            await run("DELETE FROM records WHERE kind = 'scan-rate' AND created_at < ?", new Date(clock() - 3600000).toISOString());
            const match = String(input.payload || '').trim().match(/^BSQ1:(\d{4}-\d{2}-\d{2}):([a-f0-9]{64})$/);
            if (!match) throw new HubError('This is not a valid StudentHub daily QR code.');
            const window = dailyQrWindow(clock(), s.timeZone);
            if (match[1] !== window.day) throw new HubError('This student QR has expired. Ask the student to open today’s QR.', 410);
            const raw = await first("SELECT data FROM records WHERE kind = 'student-qr' AND json_extract(data,'$.token') = ? LIMIT 1", match[2]);
            if (!raw) throw new HubError('This QR is invalid or has been replaced. Ask the student to refresh it.', 404);
            const qr = JSON.parse(raw.data);
            if (qr.day !== window.day || qr.timeZone !== s.timeZone || !qr.expiresAt || Date.parse(qr.expiresAt) <= clock()) throw new HubError('This student QR has expired. Ask the student to refresh it.', 410);
            const person = await first("SELECT * FROM members WHERE id = ? AND role = 'student' AND status = 'Active'", qr.memberId);
            if (!person) throw new HubError('This student account is inactive or unavailable.', 403);
            const pupil = parseMember(person);
            const status = clock() > Date.parse(session.data.startAt) + Number(s.lateMinutes) * 60000 ? 'Late' : 'Present';
            // The UNIQUE(schedule_id, member_id) constraint plus conditional UPSERT
            // makes simultaneous scans idempotent, even from two trainer devices.
            const saved = await admitAtFirstScan(me,pupil,session,status,now);
            const alreadyRecorded = !saved;
            const stored = await first('SELECT * FROM attendance WHERE member_id = ? AND schedule_id = ?', pupil.id, session.id);
            if (stored && ['Present','Late'].includes(stored.status)) await syncModuleOngoing(pupil.id,session);
            if (!alreadyRecorded) await audit(me, 'Student QR scanned', `${pupil.name}: ${session.data.name}.`);
            result = { alreadyRecorded, status: stored.status, checkedIn: stored.checked_in, student: { id: pupil.id, name: pupil.name, studentId: pupil.data.studentId } };
        }
        else if (op === 'checkin') {
            throw new HubError('Student self check-in is disabled. Show your daily QR to your trainer.', 403);
        }
        else if (op === 'checkout') {
            if (me.role !== 'student')
                throw new HubError('Only students can check out.', 403);
            const row = await first('SELECT * FROM attendance WHERE member_id = ? AND schedule_id = ?', me.id, String(input.id));
            if (!row || !row.checked_in)
                throw new HubError('Check in before checking out.');
            await run('UPDATE attendance SET checked_out = ? WHERE member_id = ? AND schedule_id = ? AND checked_out IS NULL', new Date(clock()).toISOString(), me.id, String(input.id));
            await audit(me, 'Checked out', 'Class attendance');
        }
        else if (op === 'mark') {
            const session = await record(String(input.scheduleId), 'schedules');
            await canManageBatch(me, session.data.batchId);
            if (clock() < Date.parse(session.data.startAt) - 15 * 60000)
                throw new HubError('Attendance cannot be marked before class.');
            if (me.role !== 'admin' && (session.data.sessionStatus === 'Completed' || session.data.sessionStatus === 'Auto-Closed' || session.data.sessionStatus === 'Cancelled' || clock()>=effectiveEnd(session.data))) throw new HubError('The session is closed. Ask Admin for an audited correction.',409);
            const person = await first("SELECT * FROM members WHERE id = ? AND role = 'student' AND status = 'Active'", String(input.memberId));
            if (!person || (Array.isArray(session.data.roster) ? !session.data.roster.includes(person.id) : JSON.parse(person.data).batchId !== session.data.batchId))
                throw new HubError('This student is not enrolled in the class.');
            if (!['Present', 'Late', 'Absent', 'Excused'].includes(input.status))
                throw new HubError('Choose a valid attendance status.');
            const note = String(input.note || '').trim().slice(0, 1000);
            if (!note)
                throw new HubError('Add a reason for the manual attendance change.');
            if (me.role === 'trainer' && ['Present', 'Late'].includes(input.status)) throw new HubError('Scan the student QR to record Present or Late attendance.', 403);
            const checkedIn = ['Present', 'Late'].includes(input.status) ? new Date(clock()).toISOString() : null;
            await run('INSERT INTO attendance (id,member_id,schedule_id,status,checked_in,checked_out,method,note,gps_verified) VALUES (?,?,?,?,?,NULL,?,?,0) ON CONFLICT(schedule_id,member_id) DO UPDATE SET status=excluded.status,checked_in=excluded.checked_in,checked_out=NULL,method=excluded.method,note=excluded.note,gps_verified=0', crypto.randomUUID(), person.id, session.id, input.status, checkedIn, 'Manual', note);
            if (['Present','Late'].includes(input.status)) await syncModuleOngoing(person.id,session);
            await audit(me, 'Attendance corrected', `${person.name}: ${input.status}. ${note}`);
        }
        else if (op === 'settings') {
            admin(me);
            const name = String(input.name || '').trim().slice(0, 100), timeZone = String(input.timeZone || '');
            try {
                new Intl.DateTimeFormat('en', { timeZone }).format();
            }
            catch {
                throw new HubError('Choose a valid timezone.');
            }
            const lateMinutes = Number(input.lateMinutes), threshold = Number(input.threshold);
            if (!name || !Number.isInteger(lateMinutes) || lateMinutes < 0 || lateMinutes > 120 || !Number.isFinite(threshold) || threshold < 0 || threshold > 100)
                throw new HubError('Check your name and attendance settings.');
            await run('UPDATE settings SET data = ? WHERE id = ?', JSON.stringify({ ...s, name, timeZone, lateMinutes, threshold }), 'institute');
            await audit(me, 'Settings updated', name);
        }
        else
            throw new HubError('Unknown action.');
        return { ...result, data: await load(me) };
    }
    return { bootstrap, act, attendanceForDate, membership, load, closeExpiredSessions, checkPermanentMemberDeletion, permanentlyDeleteMember, cascadeDelete };
}
