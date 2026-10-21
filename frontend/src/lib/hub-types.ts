export type Role = 'admin' | 'trainer' | 'student';
export type Row = {
    id: string;
    kind: string;
    data: Record<string, any>;
    createdAt: string;
};
export type Member = {
    id: string;
    userId: string | null;
    name: string;
    email: string;
    role: Role;
    status: string;
    data: Record<string, any>;
    createdAt: string;
};
export type Attendance = {
    id: string;
    memberId: string;
    scheduleId: string;
    status: string;
    checkedIn: string | null;
    checkedOut: string | null;
    method: string;
    note: string;
};
export type StudentQr = { payload: string; day: string; timeZone: string; expiresAt: string };
export type HubData = {
    me: Member;
    settings: Record<string, any>;
    members: Member[];
    records: Row[];
    attendance: Attendance[];
    approvedLeaveDates?: { studentId: string; fromDate: string; toDate: string }[];
    audits: any[];
    serverTime: string;
    studentQr: StudentQr | null;
    googleReview: { branchId: string; branchName: string; url: string } | null;
};
export type Field = {
    key: string;
    label: string;
    type?: string;
    required?: boolean;
    options?: string[];
    relation?: string;
};
export const definitions: Record<string, {
    label: string;
    singular: string;
    description: string;
    fields: Field[];
}> = {
    students: { label: 'Students', singular: 'Student', description: 'Enrollment, batches, and account access.', fields: [{ key: 'name', label: 'Full name', required: true }, { key: 'email', label: 'Account email', type: 'email', required: true }, { key: 'phone', label: 'Phone', type: 'tel' }, { key: 'studentId', label: 'Student ID', required: true }, { key: 'courseId', label: 'Course', relation: 'courses', required: true }, { key: 'batchId', label: 'Batch (optional; assign later)', relation: 'batches' }, { key: 'status', label: 'Account status', options: ['Active', 'Inactive'] }] },
    trainers: { label: 'Trainers', singular: 'Trainer', description: 'Manage teaching staff and their account access.', fields: [{ key: 'name', label: 'Full name', required: true }, { key: 'email', label: 'Account email', type: 'email', required: true }, { key: 'phone', label: 'Phone', type: 'tel' }, { key: 'trainerId', label: 'Trainer ID (login ID)', required: true }, { key: 'specialty', label: 'Specialization', required: true }, { key: 'status', label: 'Account status', options: ['Active', 'Inactive'] }] },
    courses: { label: 'Courses', singular: 'Course', description: 'Organize your institute’s learning programs.', fields: [{ key: 'name', label: 'Course name', required: true }, { key: 'description', label: 'Description', type: 'textarea' }, { key: 'duration', label: 'Duration (weeks)', type: 'number', required: true }, { key: 'status', label: 'Status', options: ['Active', 'Inactive', 'Archived'] }] },
    subcourses: { label: 'Subcourses', singular: 'Subcourse', description: 'Modules and learning materials under a parent course.', fields: [{ key: 'courseId', label: 'Parent course', relation: 'courses', required: true }, { key: 'name', label: 'Subcourse name', required: true }, { key: 'description', label: 'Description', type: 'textarea' }, { key: 'duration', label: 'Duration (weeks)', type: 'number', required: true }, { key: 'syllabus', label: 'Syllabus / learning materials', type: 'textarea' }, { key: 'status', label: 'Status', options: ['Active', 'Inactive'] }] },
    enrollments: { label: 'Enrollments', singular: 'Enrollment', description: 'Additional course and batch enrollments for students. A student’s primary enrollment is set on the student profile.', fields: [{ key: 'studentId', label: 'Student', relation: 'students', required: true }, { key: 'courseId', label: 'Course', relation: 'courses', required: true }, { key: 'batchId', label: 'Batch (assigned after first attendance)', relation: 'batches' }, { key: 'status', label: 'Status', options: ['Active', 'Inactive'] }] },
    batches: { label: 'Batches', singular: 'Batch', description: 'Bring students, courses, and trainers together.', fields: [{ key: 'name', label: 'Batch name', required: true }, { key: 'courseId', label: 'Course', relation: 'courses', required: true }, { key: 'trainerId', label: 'Trainer', relation: 'trainers', required: true }, { key: 'subcourseId', label: 'Teaching subcourse', relation: 'subcourses' }, { key: 'branchId', label: 'Branch', relation: 'branches', required: true }, { key: 'startDate', label: 'Start date', type: 'date', required: true }, { key: 'endDate', label: 'End date', type: 'date' }, { key: 'batchType', label: 'Batch type', options: ['Weekday', 'Weekend'] }, { key: 'capacity', label: 'Maximum students', type: 'number' }, { key: 'dailyStartTime', label: 'Daily class start (24h)', type: 'time' }, { key: 'dailyEndTime', label: 'Daily class end (24h)', type: 'time' }, { key: 'status', label: 'Status', options: ['Active', 'Upcoming', 'Ongoing', 'Completed'] }] },
    branches: { label: 'Branches', singular: 'Branch', description: 'Manage institute branches and public review links.', fields: [{ key: 'name', label: 'Branch name', required: true }, { key: 'address', label: 'Address', type: 'textarea', required: true }, { key: 'googleReviewUrl', label: 'Google review link', type: 'url' }] },
    schedules: { label: 'Schedules', singular: 'Class', description: 'Plan sessions and open attendance at class time.', fields: [{ key: 'name', label: 'Class topic', required: true }, { key: 'batchId', label: 'Batch', relation: 'batches', required: true }, { key: 'startAt', label: 'Starts at (institute time)', type: 'datetime-local', required: true }, { key: 'endAt', label: 'Ends at (institute time)', type: 'datetime-local', required: true }, { key: 'roomId', label: 'Room', relation: 'rooms' }, { key: 'mode', label: 'Format', options: ['In person', 'Online'] }, { key: 'notes', label: 'Class notes', type: 'textarea' }] },
    placements: { label: 'Placements', singular: 'Placement', description: 'Track interviews, offers, and student outcomes.', fields: [{ key: 'studentId', label: 'Student', relation: 'students', required: true }, { key: 'company', label: 'Company', required: true }, { key: 'jobTitle', label: 'Job title', required: true }, { key: 'date', label: 'Date', type: 'date', required: true }, { key: 'status', label: 'Status', options: ['Interview', 'Offered', 'Joined'] }, { key: 'notes', label: 'Notes', type: 'textarea' }] },
    leaves: { label: 'Leave Requests', singular: 'Leave request', description: 'Request time off and review pending applications.', fields: [{ key: 'fromDate', label: 'From', type: 'date', required: true }, { key: 'toDate', label: 'To', type: 'date', required: true }, { key: 'reason', label: 'Reason', type: 'textarea', required: true }, { key: 'recipientId', label: 'Send to', required: true }] },
    bookings: { label: 'Slot Bookings', singular: 'Slot booking', description: 'Request a place in one of your scheduled classes.', fields: [{ key: 'scheduleId', label: 'Class', relation: 'schedules', required: true }, { key: 'notes', label: 'Notes', type: 'textarea' }] },
    rooms: { label: 'Rooms', singular: 'Room', description: 'Manage teaching spaces across your branches.', fields: [{ key: 'name', label: 'Room name', required: true }, { key: 'branchId', label: 'Branch', relation: 'branches', required: true }, { key: 'capacity', label: 'Capacity', type: 'number', required: true }] },
    holidays: { label: 'Holidays', singular: 'Holiday', description: 'Non-teaching days are excluded from absence calculations.', fields: [{ key: 'name', label: 'Holiday name', required: true }, { key: 'date', label: 'Date', type: 'date', required: true }, { key: 'description', label: 'Description', type: 'textarea' }, { key: 'batchId', label: 'Batch (blank = institute-wide, Admin only)', relation: 'batches' }] },
    notifications: { label: 'Notifications', singular: 'Announcement', description: 'Publish general or placement announcements for students and trainers.', fields: [{ key: 'category', label: 'Category', options: ['General', 'Placement'] }, { key: 'title', label: 'Title', required: true }, { key: 'body', label: 'Message', type: 'textarea', required: true }, { key: 'audience', label: 'Audience', options: ['All', 'Students', 'Trainers'] }, { key: 'batchId', label: 'Batch (optional)', relation: 'batches' }] }
};
export function instituteDate(iso: string, tz = 'Asia/Kolkata') { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
export function displayTime(iso: string, tz = 'Asia/Kolkata') { return iso ? new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—'; }
export function localInputToISO(value: string, tz: string) { const parts = value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/); if (!parts)
    throw new Error('Choose a valid class date and time.'); const target = Date.UTC(+parts[1], +parts[2] - 1, +parts[3], +parts[4], +parts[5]); let guess = target; for (let n = 0; n < 3; n++) {
    const formatted = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(guess));
    guess += target - Date.parse(formatted.replace(' ', 'T') + ':00Z');
} return new Date(guess).toISOString(); }
export function isoToLocalInput(iso: string, tz: string) { return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(' ', 'T'); }
