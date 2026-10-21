# Besant StudentHub

**Institute management, attendance, and student progress portal**  
**Current project:** React + TypeScript + Vite · Cloudflare Workers · Cloudflare D1 · Supabase Authentication  
**Roles:** Administrator · Trainer · Student

Besant StudentHub is a web-based institute portal for managing students, courses and subcourses, shared batches, trainers, class sessions, QR attendance, attendance reporting, leave approvals, and other day-to-day institute activities. It is designed as a single-origin application: Cloudflare serves the frontend and `/api/*` routes, D1 stores institute records, and Supabase manages user authentication.

> **About this README:** This document describes the source in the `Besant_StudentHub_Multi_Recipient_Leave_Full_Project` release. It supersedes older README instructions that mention downloadable daily QR codes, single-recipient student leave, or one-course-only batches. This project is **not** a Django/DRF app. The exact production configuration and feature behavior should be validated against your deployed revision.

## Contents

1. [Technology and architecture](#1-technology-and-architecture)
2. [Features](#2-features)
3. [Role-based permissions](#3-role-based-permissions)
4. [Prerequisites](#4-prerequisites)
5. [Local installation (Windows PowerShell)](#5-local-installation-windows-powershell)
6. [Cloudflare and Supabase production setup](#6-cloudflare-and-supabase-production-setup)
7. [First-time institute configuration](#7-first-time-institute-configuration)
8. [Course, batch, and enrollment behavior](#8-course-batch-and-enrollment-behavior)
9. [Class schedules and attendance](#9-class-schedules-and-attendance)
10. [Student QR security](#10-student-qr-security)
11. [Leave requests: multiple recipients](#11-leave-requests-multiple-recipients)
12. [Student Excel imports and module progress](#12-student-excel-imports-and-module-progress)
13. [API overview](#13-api-overview)
14. [Project structure](#14-project-structure)
15. [Commands and automated tests](#15-commands-and-automated-tests)
16. [Safe updates and production deployment](#16-safe-updates-and-production-deployment)
17. [Backups, monitoring, and security](#17-backups-monitoring-and-security)
18. [Troubleshooting](#18-troubleshooting)
19. [Production acceptance checklist](#19-production-acceptance-checklist)
20. [Other project guides](#20-other-project-guides)

---

## 1. Technology and architecture

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Web interface | React, TypeScript, Vite | Administrator, Trainer and Student dashboards |
| UI components | React component library, Lucide icons, CSS | Responsive forms, tables, dialogs, notifications, minimal motion |
| API | Cloudflare Worker (`server/index.ts`) | Authentication-aware JSON endpoints and request routing |
| Business rules | `lib/hub-service.ts` | Roles, validation, batch assignment, QR scans, leave, reporting |
| Institute database | Cloudflare D1 | Students, courses, batches, schedules, attendance, JSON records, audits |
| Authentication | Supabase Auth | Email/password sign-in, identity and account management |
| Schema/migrations | Drizzle SQL migrations | D1 schema creation and database updates |
| Hosting | Cloudflare Worker Static Assets | Frontend and API on one HTTPS domain |

```text
Browser (Admin / Trainer / Student)
  |  HTTPS, secure session cookies
  v
Cloudflare Worker + Static Assets
  |-- /                 React application
  |-- /api/auth/*      Sign-in, sign-out, refresh, password change
  |-- /api/session     Session and account status
  |-- /api/hub         Role-filtered institute data and actions
  |-- /api/attendance Date-filtered staff attendance data
  |
  |-- Cloudflare D1   Institute records and attendance
  `-- Supabase Auth   Accounts and password verification
```

**Important:** Supabase is used for authentication; institute and attendance records live in D1. Do not migrate this application to Django, MySQL, or Supabase PostgreSQL when applying these instructions.

## 2. Features

### Administrator

- Institute overview, preferences, branch and course management.
- Students, trainers, account logins and password resets.
- Courses, subcourses, enrollment, shared multi-course batches and waiting list.
- Weekday/weekend class schedules, current-day schedule by default, and full-history toggle.
- Live attendance for the selected date; attendance and performance reports.
- QR scan status, audited manual attendance corrections and session controls.
- Leave requests addressed to Admin, with approval/rejection where authorized.
- Rooms, slot bookings, holidays, announcements, placements, audit logs and safe record deletion.
- Branch-specific public Google review links.

### Trainer

- Assigned batches, relevant students and assigned class schedules only.
- Today's schedule by default; **View Full Schedule** for their past and future sessions.
- Select a class, start/open it when permitted and scan eligible students' QR codes.
- Green **Attendance added** notification after successful scans; duplicates show **Already recorded**.
- Record absences/excused status according to permissions, manage assigned session controls and view scoped reports.
- Review and decide leave requests specifically addressed to that trainer.
- Update allowed student subcourse completions and view appropriate learner progress.

### Student

- View personal courses, subcourse progress, class schedules and attendance.
- Display a short-lived personal QR code for trainer scanning.
- Attend more than one course, including eligible shared teaching batches.
- Review own attendance history and check out where allowed.
- Submit one leave request to Admin and/or multiple assigned trainers.
- Track **Pending**, **Approved** or **Rejected** leave status.
- View authorized same-batch peers without access to private contact data.
- View announcements, placement information and the current branch's Google review link.

The exact available navigation items depend on the signed-in role and backend authorization.

## 3. Role-based permissions

| Action | Admin | Trainer | Student |
| --- | :---: | :---: | :---: |
| Manage institute and course catalog | Yes | Limited | No |
| View all trainers' schedules | Yes | No | No |
| View assigned schedules | Yes | Yes | Own relevant classes |
| View date-wise staff attendance | Yes | Assigned classes | No |
| Scan a student QR | Authorized staff | Assigned class | No |
| Mark attendance manually | Audited corrections | Limited absence/excused | No |
| Create/modify shared multi-course batches | Yes | Restricted | No |
| Submit leave request | Per business rules | To Admin | To Admin / assigned trainers |
| Review leave request | If selected/authorized | If selected/authorized | No |
| View student data | Institute-wide | Assigned scope | Own / permitted peers |
| Manage login credentials | Yes | No | Own password |

**Security rule:** The server validates member role, active status, batch association and recipient authorization. A hidden UI control is **not** an authorization mechanism.

## 4. Prerequisites

For development:

- **Node.js 24 or later** (`node --version`).
- **pnpm 11.25.0**, via `npx pnpm@11.25.0` (the project includes a lockfile).
- Windows PowerShell, Terminal or another command shell.
- A code editor such as VS Code.
- A Cloudflare account for deployed Worker/D1 access.
- A Supabase project with email/password authentication.
- HTTPS for smartphone camera use (localhost is allowed during development).

Keep a copy of the existing working project, `wrangler.jsonc`, secret settings, and a database backup before changing a production installation.

## 5. Local installation (Windows PowerShell)

### 5.1 Extract and install

Extract the project ZIP, open PowerShell in the directory containing the root `package.json`, and run:

```powershell
node --version
npx pnpm@11.25.0 install --frozen-lockfile
npx pnpm@11.25.0 setup:local
```

The example project directory is `besant-studenthub-local`. All commands below must be run in that directory unless noted otherwise.

If PowerShell blocks `npx.ps1`, use `npx.cmd` instead of `npx`.

### 5.2 Configure local secrets

```powershell
Copy-Item .dev.vars.example .dev.vars
notepad .dev.vars
```

Set the real values:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_VALUE
SUPABASE_SECRET_KEY=sb_secret_YOUR_VALUE
ADMIN_EMAIL=your-admin@example.com
```

`.dev.vars` contains privileged credentials: never commit it, attach it to support messages, or expose its contents in the frontend. **Prefer a separate Supabase development project** so testing local login/reset flows cannot affect your live users.

> `setup:local` prepares the local schema and examples; it does not create demo students or a real administrator account. The initial Admin email must exist as a confirmed Supabase Auth user.

### 5.3 Start development servers

```powershell
npx pnpm@11.25.0 dev
```

- React frontend: <http://127.0.0.1:5173>
- Local Worker API: <http://127.0.0.1:5174>
- Stop both with `Ctrl+C`.

The Vite frontend proxies `/api` to the local Worker. Local D1 state is kept separately from the remote production database. For local API-only or UI-only work, use `dev:api` or `dev:frontend` respectively.

### 5.4 Local checks

```powershell
npx pnpm@11.25.0 typecheck
npx pnpm@11.25.0 test
npx pnpm@11.25.0 build
```

Resolve errors before using production deployment commands.

## 6. Cloudflare and Supabase production setup

### 6.1 Configure Supabase Auth

1. Create a Supabase project and enable email/password sign-in.
2. **Disable public self-signup**; StudentHub uses administrator-created accounts.
3. In Supabase Authentication, create and confirm the first administrator's email/password.
4. Copy the **Project URL**, **publishable key** and **secret key**. Do not use old `anon`/`service_role` values in this project's new-key configuration.
5. Protect the Supabase account with MFA and use a strong administrator password.

Detailed initial setup is documented in [DEPLOY_FREE.md](./DEPLOY_FREE.md).

### 6.2 Create a production D1 database (new installations only)

```powershell
npx pnpm@11.25.0 exec wrangler login
npx pnpm@11.25.0 exec wrangler d1 create besant-studenthub-production
```

Copy the D1 database UUID returned by Cloudflare into `wrangler.jsonc`:

```json
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "besant-studenthub-production",
    "database_id": "PASTE_EXISTING_OR_NEW_D1_UUID_HERE",
    "migrations_dir": "drizzle"
  }
]
```

**Existing deployments: do not create a new database or replace the real UUID.** Keep your working `wrangler.jsonc` and its Worker name, binding and scheduled trigger. The full-project ZIP contains a placeholder UUID intended for initial setup.

### 6.3 Configure production secrets

```powershell
Copy-Item .secrets.production.example.json .secrets.production.json
notepad .secrets.production.json
```

Fill in the real values:

```json
{
  "SUPABASE_URL": "https://YOUR_PROJECT_REF.supabase.co",
  "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_YOUR_VALUE",
  "SUPABASE_SECRET_KEY": "sb_secret_YOUR_VALUE",
  "ADMIN_EMAIL": "your-admin@example.com"
}
```

Never commit, email or bundle `.secrets.production.json`. Production uses Worker secrets, not browser `VITE_*` variables. On subsequent deployments, the project deployment script can reuse already configured secrets if this file is absent.

### 6.4 Apply migrations and deploy (new installation)

```powershell
npx pnpm@11.25.0 db:migrate:production
npx pnpm@11.25.0 test
npx pnpm@11.25.0 build
npx pnpm@11.25.0 run deploy
```

`run deploy` performs the build and uses the production secrets file when present. Follow [DEPLOY_FREE.md](./DEPLOY_FREE.md) for the exact one-time Cloudflare/Supabase sequence.

For a **working existing deployment**, use the controlled update procedure in [Section 16](#16-safe-updates-and-production-deployment) instead.

## 7. First-time institute configuration

Log in with the email matching `ADMIN_EMAIL`; only the authorized first administrator can initialize the empty institute.

A practical setup order:

1. Set institute name, timezone (default `Asia/Kolkata`), late-attendance threshold and attendance target in **Settings**.
2. Create **Branches**, with addresses and optional Google review URLs.
3. Create **Courses** and their **Subcourses**, matching the names that Excel imports will use.
4. Create **Trainers** and their login accounts.
5. Create **Batches** with course(s), teaching subcourse, branch, trainer, capacity, date range, schedule times and Weekday/Weekend type.
6. Create or import **Students**, and register their additional courses where applicable.
7. In **Account Logins**, create or reset member credentials; distribute temporary credentials privately.
8. Review the generated or entered **Class Schedules** and test an authorized live QR attendance scan.
9. Verify Admin, Trainer and Student views using separate real accounts.

Members may be required to change a temporary password during first login. IDs with at least 12 characters can be used by the configured temporary-password workflow; shorter IDs use a secure random password. Do not publish passwords in spreadsheets or screenshots.

## 8. Course, batch, and enrollment behavior

### Courses and subcourses

A **Course** is the parent program (for example, *Full Stack Python* or *Data Analytics*). A **Subcourse** is an individual learning module (for example, *MySQL* or *Python*). The catalog is managed in **Admin → Course Management**.

### Shared multi-course batches

One batch may allow students from multiple parent courses:

```text
Batch: Shared MySQL Class A
Courses: Full Stack Python + Data Analytics
Teaching subcourse: MySQL
Trainer: Assigned trainer
Capacity: One shared seat pool for the batch
```

- Admin can select multiple allowed courses when creating/editing a batch.
- Legacy one-course batches still work.
- Trainers remain restricted to permitted batches and classes.
- Students must be registered in an allowed parent course to join.
- The student's **first valid Trainer QR scan** can associate that course enrollment with the batch, subject to capacity and scheduling rules.
- A full class may place an eligible student on the waiting list; waiting-list registration does not itself record attendance.
- A student's enrollment remains associated with **their own** course, not silently reassigned to the batch's primary course.
- Module progress for a shared teaching topic appears under another parent course only when that course contains the corresponding subcourse in its catalog.

Class sessions, capacity, Trainer permissions, and per-subject enrollment guards are enforced in the backend. See [SHARED_MULTI_COURSE_BATCH_UPDATE.md](./SHARED_MULTI_COURSE_BATCH_UPDATE.md).

## 9. Class schedules and attendance

### Schedules: Admin and Trainer

- **Schedules** opens on **today's classes** in the configured institute timezone.
- **View Full Schedule** displays historical, current and upcoming schedules returned by the backend.
- **Back to Today's Schedule** returns to the filtered current-day view.
- Admin can see all trainers' schedules; Trainers can see only assigned classes.
- Weekday/weekend recurring schedule generation and permitted session extensions remain available.

### Live Attendance by date

- **Live Attendance** opens on the institute's current date.
- Use its **date picker** to select another day; use **Today** to reset.
- Class choices and saved attendance rows are restricted to the selected date.
- Admin sees authorized institution-wide data; Trainers see assigned data only.
- The view refreshes periodically while visible (currently every 45 seconds).
- The server endpoint `GET /api/attendance?date=YYYY-MM-DD` enforces staff access and applies date filtering.

### QR attendance lifecycle

1. A student opens their own QR page using an authenticated account.
2. An authorized Trainer selects a scheduled class in **Live Attendance** and starts/opens it as permitted.
3. The Trainer scans the student's on-screen QR with the device camera.
4. The backend checks token validity, student status, class authorization, time window and duplicate attendance.
5. A successful scan records **Present** or **Late** and shows a green confirmation popup.
6. Repeating the scan does **not** create duplicate attendance or overwrite an existing checkout.
7. Allowed checkouts and scheduled session closure update attendance lifecycle records.

Students cannot self-mark Present/Late. Trainers cannot bypass QR using a manual Present mark. Admin corrections require a reason and are audited. Sessions containing attendance have deletion/edit safeguards.

## 10. Student QR security

The current QR flow is **short-lived**, not an indefinitely usable daily screenshot:

- QR tokens are opaque random values generated for authenticated students.
- Validity is **up to five minutes**, or until institute-local midnight, whichever occurs first.
- Tokens are checked against D1 on the server; expired tokens are rejected.
- The Student QR card automatically refreshes after expiration and hides when the tab/window is inactive.
- The QR interface has no download or print button. Right-click, dragging, print and common save/screenshot shortcuts are discouraged where a browser permits it.

**Limit:** Browser code cannot reliably block OS screenshots, screen recording, another phone's camera, or advanced capture tools. These are deterrents, not screenshot-proof security. The main protections are server-side expiry, authenticated access and Trainer/session authorization. A captured QR may still be misused during its short valid window; supervise live scanning and monitor anomalies.

Camera access typically requires HTTPS or localhost and browser permission. **GPS is not required.**

## 11. Leave requests: multiple recipients

A Student enrolled in multiple courses or batches can create **one leave request** addressed to several eligible reviewers at once.

### Student submission

Open **Student → Leave Requests → Request leave** and enter:

1. **From** date.
2. **To** date.
3. **Reason**.
4. **Send to** — select one or more checkboxes for **Administrator** and/or the student's assigned, active Trainers.

For example, a student attending Full Stack Python and Data Analytics may choose Administrator, Python Trainer and Analytics Trainer together. The recipient list is derived from that student's active batch enrollments, **not** from every Trainer in the institute.

### Authorization and decisions

- One leave request is stored with a **recipient list** and one overall status.
- Up to **15 recipients** may be selected.
- Each selected, authorized reviewer can view and approve/reject the request.
- **The first successful approval or rejection is final** for the whole request; another reviewer cannot overwrite it (conflicting later decision returns HTTP 409).
- Students see the result as **Pending**, **Approved** or **Rejected**.
- Unselected Trainers do not receive access to the request.
- Trainer-originated leave requests are routed to **Administrator**.
- Older single-recipient records remain supported for compatibility.

**Important workflow distinction:** This is **first-decision-wins**, not a unanimous approval process. If every Trainer must approve independently, separate per-recipient approval statuses must be implemented before relying on that policy.

Approved leave contributes to relevant excused-absence reporting without revealing private leave reasons to unrelated reviewers.

## 12. Student Excel imports and module progress

### Combined Student + Completed Subcourses upload

Admin's combined import accepts a **seven-column** Student Details spreadsheet:

| Column | Meaning |
| --- | --- |
| `STUDENT NAME` | Student's name |
| `STUDENT ID` | Student identifier |
| `COURSE` | Existing parent course name |
| `SUB COURSE` | Comma-separated list of **completed** subcourses |
| `EMAIL` | Student email |
| `PHONE NUMBER` | Contact number |
| `STATUS` | Overall student status, **not** individual module progress |

Example:

```csv
STUDENT NAME,STUDENT ID,COURSE,SUB COURSE,EMAIL,PHONE NUMBER,STATUS
Demo Student,BSTDEMO20260352,Full Stack Python,"Python, MySQL, Django",demo.student@example.com,9000000000,Active
```

The importer also supports the legacy **six-column student import**:

```csv
Name,Email,Phone,Student ID,Course,Status
Demo Student,demo.student@example.com,9000000000,BSTDEMO20260352,Full Stack Python,Active
```

The seven-column flow can create missing students and apply completed-module information in the same Admin upload. It first tries an exact Student ID match, then a safe email-and-name match for an existing student; identity conflicts are rejected. Course and subcourse names must already exist in Admin and match the catalog (case-insensitive trimmed matching). Do not invent IDs or assume spreadsheet updates will rename existing users.

The combined importer commits **in chunks of 10 rows**. If a later chunk fails, an earlier chunk may already be saved. Review the import summary and current records before retrying; do not repeatedly upload an invalid workbook without checking for partial writes.

### Student module progress rules

| Condition | Student progress |
| --- | --- |
| Subcourse listed as completed in the Student Details workbook | **Completed** |
| Subcourse not listed and no qualifying attendance | **Pending** |
| First Present/Late attendance in that subcourse | **Ongoing** |
| Further attendance after a subcourse is Completed | **Remains Completed** |

Qualified Admin/Trainer completion actions and the dedicated module-progress import can also update status according to their respective permissions. The workbook's overall `STATUS` field does not decide each subcourse's completion.

**Warning:** Treat an authoritative completed-module workbook as potentially changing previously stored progress. Preview/check a small test import first, especially when re-importing historical students.

See [SINGLE_UPLOAD_GUIDE.md](./SINGLE_UPLOAD_GUIDE.md), [STUDENT_DETAILS_SUBCOURSE_IMPORT_UPDATE.md](./STUDENT_DETAILS_SUBCOURSE_IMPORT_UPDATE.md) and [SUBCOURSE_PROGRESS_UPDATE.md](./SUBCOURSE_PROGRESS_UPDATE.md).

## 13. API overview

All routes below are on the **same origin** as the React application.

| Endpoint | Method | Purpose | Access |
| --- | --- | --- | --- |
| `/api/health` | GET | Basic Worker availability | Public diagnostic |
| `/api/session` | GET | Login/configuration/session state | Session aware |
| `/api/auth/login` | POST | Sign in | Public with protections |
| `/api/auth/logout` | POST | Sign out | Session aware |
| `/api/auth/refresh` | POST | Refresh session | Session aware |
| `/api/auth/password` | POST | Change account password | Authenticated |
| `/api/accounts` | POST | Account creation/reset operations | Admin-authorized |
| `/api/hub` | GET | Role-filtered workspace snapshot | Authenticated |
| `/api/hub` | POST | Validated institute action (`op`) | Role/action-dependent |
| `/api/attendance?date=YYYY-MM-DD` | GET | Date-filtered schedule and attendance data | Admin/Trainer only |

`/api/hub` POST includes operation-specific actions defined in `lib/hub-service.ts`, such as record management, QR scans, checkouts, session controls, importing and leave decisions. Do not assume the endpoint accepts arbitrary updates; the Worker and service validate permissions and input.

`/api/health` shows that the Worker is running. It is **not** a guarantee that database and authentication providers are healthy. Do not expose real session cookies, QR tokens or API secrets when collecting diagnostics.

## 14. Project structure

```text
besant-studenthub-local/
├── frontend/
│   ├── src/
│   │   ├── App.tsx                        # Auth/session, loading, routing
│   │   ├── pages/hub.tsx                  # Admin, Trainer and Student dashboards
│   │   ├── components/
│   │   │   ├── trainer-qr-scanner.tsx
│   │   │   ├── student-qr-card.tsx
│   │   │   ├── import-students.tsx
│   │   │   └── ...
│   │   ├── lib/                            # Browser API, models and Excel parsing
│   │   └── styles.css                      # Existing palette and responsive styles
│   └── public/                             # Logo, favicon, 404 and HTTP headers
├── server/
│   ├── index.ts                            # API routing, auth and attendance route
│   ├── auth.ts                             # Supabase session/auth integration
│   └── types.ts
├── lib/
│   ├── hub-service.ts                      # Business logic and authorization
│   ├── hub-types.ts                        # Shared record and field types
│   ├── student-qr.ts                       # QR token/window helpers
│   └── google-review.ts
├── db/schema.ts
├── drizzle/                               # SQL schema migrations
├── scripts/                               # Local dev, checks, deploy and backups
├── tests/                                 # Isolated API/workflow/regression tests
├── examples/student-import-template.csv
├── wrangler.jsonc                         # Production Worker and D1 config
├── wrangler.local.jsonc                   # Separate local D1 config
├── .dev.vars.example                      # Local secrets example
├── .secrets.production.example.json       # Production secrets example
├── package.json
├── pnpm-lock.yaml
└── README.md
```

Project guides in the repository cover individual features and migrations; see [Section 20](#20-other-project-guides).

## 15. Commands and automated tests

All commands should be run from the **repository root**:

| Command | Purpose |
| --- | --- |
| `npx pnpm@11.25.0 setup:local` | Prepare local schema and config template |
| `npx pnpm@11.25.0 dev` | Run frontend + local API |
| `npx pnpm@11.25.0 dev:frontend` | Vite only |
| `npx pnpm@11.25.0 dev:api` | Local Worker only |
| `npx pnpm@11.25.0 typecheck` | TypeScript checks |
| `npx pnpm@11.25.0 test` | Smoke, API, timing, loading and recipient checks |
| `npx pnpm@11.25.0 build` | Typecheck, Vite build and Worker dry-run |
| `npx pnpm@11.25.0 start` | Serve built frontend/API locally |
| `npx pnpm@11.25.0 db:migrate:local` | Apply local migrations |
| `npx pnpm@11.25.0 db:migrate:production` | Apply pending remote D1 migrations |
| `npx pnpm@11.25.0 db:backup:production` | Export remote D1 SQL backup |
| `npx pnpm@11.25.0 run deploy` | Validate, build and deploy with configured secrets |

**Test coverage included in this release:** `tests/hub-smoke.ts`, `tests/production-api.ts`, `tests/session-timing.ts`, `tests/loading-reliability.mjs` and `tests/leave-recipient-contract.mjs`; the QR decoding workflow needs its `qrcode` and `jsqr` dependencies. Tests run in an isolated database/provider harness rather than changing production records.

> Previous release notes reported **89 passing production API checks** and **53 workflow checks with the QR pixel-decoder test excluded**. These are historical package verification results, **not** a claim that the full suite or live production deployment was run while authoring this README. Run the commands above in your own installed environment and record the results.

## 16. Safe updates and production deployment

### Updating an existing working StudentHub installation

**Prefer patching the current working directory**, not replacing it with an older full ZIP. Keep your live settings and local deployment state.

1. Make a copy of the currently deployed project directory (excluding secrets from anything publicly shared).
2. Review the modified source files and copy the changed files with their original relative paths.
3. Retain your correct `wrangler.jsonc` Worker name, **real D1 `database_id`**, `DB` binding, `/api/*` routing and cron.
4. Retain Worker secrets; never publish them or overwrite with placeholder examples.
5. Install, test, build and back up:

```powershell
npx pnpm@11.25.0 install --frozen-lockfile
npx pnpm@11.25.0 test
npx pnpm@11.25.0 build
npx pnpm@11.25.0 db:backup:production
```

6. Check whether the update includes a new migration. If it does, inspect it and apply it **after the backup**:

```powershell
npx pnpm@11.25.0 db:migrate:production
```

7. When all checks and any required migrations succeed, deploy using your established workflow:

```powershell
npx pnpm@11.25.0 exec wrangler deploy --config wrangler.jsonc
```

For new installs or when intentionally refreshing Worker secrets from `.secrets.production.json`, the package's `npx pnpm@11.25.0 run deploy` is the configured alternative (it runs build and deployment). A direct Wrangler deployment assumes the Worker already has correct secrets.

8. Refresh your browser with `Ctrl+Shift+R` and complete the [acceptance checklist](#19-production-acceptance-checklist) using test accounts.

**Migration distinction:** The repository includes D1 migrations `0000` through `0003`. The multi-course-batch, date-wise-attendance, five-minute QR, and multi-recipient leave feature updates store their additions in existing records and did **not** add a separate schema migration. However, an installation that has not yet applied `0003_batch_attendance_seats.sql` must review/apply pending migrations before relying on all batch behavior. Never blindly apply or roll back database migrations without a backup.

## 17. Backups, monitoring, and security

### Backups and rollback

```powershell
npx pnpm@11.25.0 db:backup:production
```

The exported SQL file is written under `production-backups/`. Keep it **private and off the public repository**; it can contain personal student data and QR token records. D1 exports do not include Supabase Auth users or password credentials. Test restoration to a separate environment before treating a backup as a proven recovery plan.

A Worker rollback does **not** automatically roll back a D1 schema or data change. Record the deployed version and migration state before releases.

### Security and operations checklist

- Restrict Cloudflare and Supabase administrator access; enable MFA.
- Protect and rotate privileged API keys; never share `.dev.vars` or `.secrets.production.json`.
- Keep public signup disabled and deactivate inactive institute members.
- Confirm staff-only API access and cross-trainer separation with negative tests.
- Check QR validity on the server; do not claim screenshot prevention.
- Retain audit trails for attendance corrections, reviewer decisions and sensitive Admin actions.
- Monitor Cloudflare Worker failures, D1 quota/capacity and Supabase Auth outages.
- Set backup frequency, retention policy and recovery drills appropriate to the institute.
- Test mobile QR camera permissions, low-connectivity loading, daylight/timezone edge cases and long session histories.
- Confirm local accessibility and reduced-motion preferences if changing the UI.
- Review applicable personal-data handling rules for students, phone numbers and attendance records.

Cloudflare/Supabase Free limits and product terms can change. Check provider dashboards and official pricing/limits pages before depending on specific quotas or uptime guarantees. **A working app and passing tests are not substitutes for security, accessibility, load and disaster-recovery reviews.**

## 18. Troubleshooting

| Symptom | Likely cause / recommended check |
| --- | --- |
| `Loading your account` never completes | Check `/api/session`, Auth availability, browser network/console errors and session cookies; retry or reload after error. |
| `Loading your institute workspace` fails | Check authenticated `/api/hub`, Worker logs, D1 binding/migrations and network timeout. |
| `Send to is required` on student leave | Ensure the latest `frontend/src/lib/hub-types.ts` **and** `frontend/src/pages/hub.tsx` are deployed together; the form must display recipient checkboxes. |
| Trainer not offered in leave recipients | Student must be enrolled in an **active batch** assigned to that **active trainer**; otherwise select Administrator. |
| Trainer cannot see/approve a leave request | Verify Trainer was selected as a recipient; unrelated Trainers have no access. Another reviewer may have finalized it already. |
| `Student ID not uniquely found` during progress import | Confirm the actual Student ID exists; or use the combined import for new students. Do not invent Excel IDs. |
| Excel import fails on course/subcourse | Names must match an existing Admin catalog entry. Inspect partial imports before retrying. |
| Student sees `Pending` after attendance | Check the attended session's teaching subcourse, registered parent course, and actual Present/Late record. |
| Schedule or attendance shows wrong day | Verify Settings timezone, browser date selection, and `YYYY-MM-DD` supplied to `/api/attendance`. |
| QR scan says expired | Refresh the Student QR and scan the newly generated token within five minutes. |
| QR camera will not open | Use HTTPS/localhost; allow browser camera permissions and ensure another app is not holding the camera. |
| Class not available to Trainer | Trainer must be assigned to the batch/session; date picker and session-open state also matter. |
| First attendance cannot enroll a student | Verify enrolled parent course, shared-batch association, seat capacity, conflicting batch and waitlist status. |
| `Property 'approvedLeaveDates' does not exist on type HubData` | Use the matching shared/frontend `hub-types.ts` declarations, not mixed files from different releases. |
| `HubError: Send to is required` during tests | Use the latest smoke tests containing leave recipient payloads. |
| `npx pnpm ... build` fails | Run `install --frozen-lockfile`, then `typecheck` and `build` separately; address exact file/line TypeScript errors. |
| `database_id` placeholder error | Restore the real production D1 UUID in `wrangler.jsonc`. Do **not** create a replacement database by accident. |
| Login denied even with correct password | Confirm email is verified in Supabase, matching active member exists in D1, and the configured Supabase project is correct. |
| Unknown URL / 404 | Verify custom 404 Static Assets setup and correct `/api/*` Worker routing in `wrangler.jsonc`. |
| Deployment works but old UI remains | Hard-refresh and confirm deployment version, browser cache and Worker asset publishing. |

If an error continues, capture the **exact error text, reproduction steps, relevant failed Network response status and sanitized logs**. Never send cookies, JWTs, passwords, privileged keys or real student PII publicly.

## 19. Production acceptance checklist

Before inviting real users, verify the deployed revision with a small set of test accounts and a disposable class:

- [ ] Admin, Trainer and Student logins work, with correct roles and required password changes.
- [ ] Student/Trainer cannot access unauthorized Admin actions or another Trainer's private records.
- [ ] Admin and Trainer schedules show **Today** by default and **View Full Schedule** works.
- [ ] Live Attendance shows only the selected date; Admin sees all authorized classes, Trainer assigned classes only.
- [ ] Student QR refreshes/invalidates after five minutes and at institute-local midnight.
- [ ] Successful QR scan saves exactly one Present/Late entry; duplicate scan does not alter checkout.
- [ ] Trainer scanner displays success; invalid, expired and unauthorized scans are rejected.
- [ ] Shared batch accepts eligible students from each selected course, respects capacity and waitlist.
- [ ] Student multi-course module progress maps to the correct parent course.
- [ ] Student can select Admin plus two or more eligible Trainers in one leave request.
- [ ] Only selected reviewers can view/decide leave, and first decision cannot be overridden.
- [ ] Student sees the correct final leave status; excused leave is reflected in reporting.
- [ ] Seven-column combined Excel import works on a small **non-production test set** without duplicates.
- [ ] Custom 404 page appears for unknown routes; app still loads on recognized navigation paths.
- [ ] Mobile layout, camera, forms, keyboard navigation and reduced-motion preference have been reviewed.
- [ ] Tests and production build pass; D1 backup is saved and a recovery procedure is documented.
- [ ] Cloudflare Worker/D1 and Supabase health, errors and quotas can be monitored by operators.

## 20. Other project guides

The repository includes additional documents describing the design and feature changes:

- [DEPLOY_FREE.md](./DEPLOY_FREE.md) — New production deployment, Supabase/Cloudflare configuration and initial launch.
- [SETUP_WINDOWS.md](./SETUP_WINDOWS.md) — Windows installation and local setup.
- [RELEASE_GUIDE.md](./RELEASE_GUIDE.md) — Release and operations guidance.
- [MULTI_RECIPIENT_LEAVE_UPDATE.md](./MULTI_RECIPIENT_LEAVE_UPDATE.md) — Multi-recipient leave authorization and first-decision behavior.
- [ATTENDANCE_LEAVE_SECURITY_UPDATE.md](./ATTENDANCE_LEAVE_SECURITY_UPDATE.md) — Date-wise attendance, five-minute QR, leave routing.
- [SCHEDULE_TODAY_FULL_UPDATE.md](./SCHEDULE_TODAY_FULL_UPDATE.md) — Today/full schedule toggle.
- [SHARED_MULTI_COURSE_BATCH_UPDATE.md](./SHARED_MULTI_COURSE_BATCH_UPDATE.md) — Shared teaching batches across parent courses.
- [SINGLE_UPLOAD_GUIDE.md](./SINGLE_UPLOAD_GUIDE.md) — Combined student and completed-subcourse import.
- [STUDENT_DETAILS_SUBCOURSE_IMPORT_UPDATE.md](./STUDENT_DETAILS_SUBCOURSE_IMPORT_UPDATE.md) — Seven-column spreadsheet import.
- [SUBCOURSE_PROGRESS_UPDATE.md](./SUBCOURSE_PROGRESS_UPDATE.md) — Module progress and status rules.
- [BATCH_MANAGEMENT_UPDATE.md](./BATCH_MANAGEMENT_UPDATE.md) — Batch rules, waitlists and migration requirements.
- [UI_PRODUCTION_POLISH_GUIDE.md](./UI_PRODUCTION_POLISH_GUIDE.md) — QR popup, custom 404 and UI polish.
- [LOADING_FIX_GUIDE.md](./LOADING_FIX_GUIDE.md) — Loading/error recovery.

### Useful external documentation

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- [Supabase Auth](https://supabase.com/docs/guides/auth)
- [Vite](https://vite.dev/guide/)

---

**Maintainer note:** Preserve the existing application color palette and working role/attendance logic when refining the interface. Update this README whenever the permissions, source-of-truth schema, deployment steps, or user-facing workflow changes.
