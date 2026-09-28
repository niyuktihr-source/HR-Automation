# Alethea HR Automation Engine

Standalone Node.js engine that automates the full employee onboarding lifecycle — from pre-joining document collection through 5-month probation verification — without any manual HR intervention.

## What it does

- Watches a Google Drive folder for new employee documents
- Verifies documents (Aadhaar, PAN, offer letter, marksheets, degree certificate, meeting screenshots) using Gemini AI
- Extracts structured data from verified documents (Aadhaar number, PAN number, DOB, address, board, marks, college name etc.) and auto-fills the AL_DI_HR_018 Employee Information Sheet
- Sends automated emails to the employee, HR, manager, IT, and recruiter at every step
- 3-strike reminder chain (24h / 48h / 72h) to employee for missing or rejected docs; recruiter escalated after 3rd reminder
- Tracks progress in a live Google Sheet dashboard per employee
- Creates AL_DI_HR_018 Employee Information Sheet (Personal Details + Education & Professional Detail tabs) auto-filled from extracted document data
- Creates AL_DI_HR_019 Project Introduction Sheet with 5 tracking tabs; links the correct month tab in 30/60/90-day project review reminder emails
- Schedules 30/60/90-day project review reminders and 5-month pre-probation alerts via cron
- On day 23, creates a per-joinee copy of "Employee Feedback Form: Onboarding Experience", shares it with the recruiter (editor), emails it to the joinee, reminds daily, and emails the recruiter the completed response as .xlsx
- Shares project intro catchup sheet with new joiner
- Creates calendar invites for HR induction, project intro, 25-day catchup, 30/60/90-day review calls
- Treats India's three national holidays (Republic Day, Independence Day, Gandhi Jayanti) like weekends — meetings, emails and reminders move to the next working day
- Books the smallest free meeting room that fits everyone on the HR induction, 25-day catchup and 30/60/90-day review invites (`MEETING_ROOMS`); alerts HR + recruiter if none is free
- Sends 25-day catchup notification email to HR + recruiter (not new joinee) with full employee details table
- Parses email replies via Gmail Watch + Pub/Sub to advance the checklist automatically — with fallback matching by employee name, pending task state, and sender email
- Persists all state locally (encrypted AES-256-GCM) so restarts never repeat completed steps
- New employees added via recruiter Google Form are persisted to `employees.json` immediately and survive engine restarts

## 7 Phases — 71 Tasks

| Phase | Description |
|-------|-------------|
| Phase 1 | Before DOJ — Recruiter checklist |
| Phase 2 | Before DOJ — Automation (docs, email creation, BGV, assets) |
| Phase 3 | Day of Joining |
| Phase 4 | 30 days after DOJ |
| Phase 5 | 60 days after DOJ |
| Phase 6 | 90 days after DOJ |
| Phase 7 | 5 months after DOJ (pre-probation) |

## Tech Stack

- **Node.js** — runtime
- **Google Drive API** — folder watching, file download, checklist upload
- **Google Sheets API** — live status dashboard per employee
- **Gmail API + Pub/Sub** — reply parsing
- **Google Calendar API** — induction, project intro, 30/60/90-day review events
- **Gemini AI** (`@google/generative-ai`) — document verification + reply classification
- **nodemailer** — email templates via Gmail App Password, 3-retry backoff
- **node-cron** — milestone scheduling (survey, 30/60/90-day, 5-month)
- **Express.js** — webhook server, status dashboard, JSON debug endpoints

## Setup

### 1. Google Cloud Console
1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable: Drive API, Gmail API, Sheets API, Calendar API
3. Create OAuth 2.0 credentials (Desktop app) → download as `credentials.json`
4. Place `credentials.json` in the `automation/` folder
5. Add your Gmail as a test user under OAuth → Audience

### 2. Install dependencies
```bash
cd automation
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
# Fill in all values in .env
```

### 4. One-time Google auth
```bash
npm run auth
# Opens browser → sign in → paste code back in terminal
# Creates token.json
```

### 5. Run
```bash
npm start
```

## Adding Employees

**Option A — Single employee via `.env`** (for testing):
Set `EMPLOYEE_*` variables in `.env`.

**Option B — Interactive CLI**:
```bash
npm run add-employee
# Prompts for all fields with validation
```

**Option C — Multiple employees via `employees.json`**:
```json
[
  {
    "employeeId": "EMP001",
    "name": "Full Name",
    "personalEmail": "personal@email.com",
    "officialEmail": "official@company.com",
    "doj": "2026-07-01",
    "driveFolderId": "google-drive-folder-id",
    "contacts": {
      "recruiterEmail": "recruiter@company.com",
      "managerEmail": "manager@company.com",
      "itEmail": "it@company.com"
    }
  }
]
```

**Option D — Runtime via API**:
```bash
POST http://localhost:3000/employee
Content-Type: application/json
{ "employeeId": "EMP002", "name": "...", ... }
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `npm run add-employee` | Interactive wizard to register a new employee |
| `npm run list-employees` | Table of all employees with DOJ and progress % |
| `npm run remove-employee` | Remove an employee from employees.json and clean up their files |
| `npm run reset-employee` | Wipe one employee's state so they re-onboard from scratch |
| `npm run view-state -- EMP001` | Pretty-print an employee's persisted state file |
| `npm run mark-task -- EMP001 t15` | Manually mark a checklist task done (bypasses automation) |

## Web Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | JSON health check — uptime, employee list, task counts |
| `GET /employees` | Full employee list with checklists |
| `GET /status` | HTML dashboard — all employees, progress bars |
| `GET /status/:employeeId` | HTML per-employee status page — checklist, verification results, activity log, stuck-task badges |
| `GET /state/:employeeId` | Raw JSON checklist state (for debugging) |
| `POST /employee` | Register a new employee and start onboarding |
| `POST /drive-push` | Google Drive push notification receiver |
| `POST /gmail-push` | Gmail Pub/Sub push notification receiver |
| `POST /preonboarding-details` | Receives personal details from pre-onboarding form submit trigger |

## Real-time Push (optional)

For instant Drive notifications instead of polling:
1. Install ngrok: `npm install -g ngrok`
2. Run: `ngrok http 3000`
3. Paste the HTTPS URL into `WEBHOOK_BASE_URL` in `.env`

For Gmail reply parsing:
1. Create a Pub/Sub topic in Google Cloud Console
2. Add `gmail-api-push@system.gserviceaccount.com` as Publisher
3. Add a Push subscription pointing to `WEBHOOK_BASE_URL/gmail-push`
4. Set `GMAIL_PUBSUB_TOPIC` in `.env`

## Google Forms

Five forms are used in the onboarding flow. Apps Script to create each is in `automation/scripts/`:

| Form | Script | When sent | `.env` variable |
|------|--------|-----------|-----------------|
| Pre-Onboarding Form (Fresher) | `createFresherPreonboardingForm.gs` | Before DOJ — welcome email | `PREONBOARDING_FORM_FRESHER_LINK` |
| Pre-Onboarding Form (Experienced) | `createExperiencedPreonboardingForm.gs` | Before DOJ — welcome email | `PREONBOARDING_FORM_EXPERIENCED_LINK` |
| Recruiter Form | `createRecruiterForm.gs` | HR/recruiter fills to register a new joinee | `RECRUITER_FORM_LINK` |
| Employee Feedback Form: Onboarding Experience | `createEmployeeFeedbackForm.gs` | Day 23 after DOJ — a copy per joinee, shared with the recruiter as editor | `ONBOARDING_SURVEY_TEMPLATE_FORM_ID` |

To create a form: open [script.google.com](https://script.google.com) → New Project → paste the script → Run → copy the Published URL into `.env`.

The pre-onboarding forms route uploaded files automatically into the correct Drive subfolders (`Marksheet_10th`, `Aadhaar`, `PAN` etc.) using an Apps Script submit trigger. The Employee ID field is filled by the new joinee — the trigger finds the correct Drive folder by searching for the Employee ID in the folder name.

On submit, the trigger also POSTs personal details (Mother's Name, Marital Status, Spouse, Children, Emergency Contact, Nominee etc.) to the engine via `/preonboarding-details` webhook so they are auto-filled in the AL_DI_HR_018 sheet.

**Apps Script setup (required once per form):**
1. Open the form in Google Forms → Responses → Script Editor (or open [script.google.com](https://script.google.com) and find the bound script)
2. Paste the latest code from the corresponding `.gs` file
3. Project Settings → Script Properties → Add `ENGINE_WEBHOOK_URL` = your ngrok/engine HTTPS URL
4. Triggers → Add Trigger → `onExperiencedFormSubmit` / `onFresherFormSubmit` → From form → On form submit
5. Click Run once (on any function) to trigger the OAuth permission dialog for `UrlFetchApp`

## Project Intro Sheet (AL_DI_HR_019)

Each employee gets an `AL_DI_HR_019 Project Introduction` Google Sheet created automatically on their joining day with 5 tabs:

- **Document Version history** — HR fills version history
- **Details of New Joinee & Task** — pre-filled with employee name, DOJ, manager; manager fills Key Areas, Objectives, Task Schedule
- **Tracking - Month -1** — filled after 30-day review call
- **Tracking - Month -2** — filled after 60-day review call
- **Tracking - Month -3** — filled after 90-day review call

The same sheet is re-shared at the 30-day catchup email — no duplicate is created.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.js` | Main orchestrator — boots engine, loads employees, wires everything together |
| `src/config.js` | Single source of truth for all hardcoded values (timezone, milestone days, calendar times) |
| `src/emailSender.js` | 19 email templates, 3-retry backoff |
| `src/cronJobs.js` | Milestone scheduling (survey, 30/60/90-day, 5-month) |
| `src/driveWatcher.js` | Drive folder polling and push-channel management |
| `src/gmailWatcher.js` | Gmail Watch subscription and reply parsing |
| `src/calendarService.js` | Creates Google Calendar events for induction, 25-day catchup, 30/60/90-day reviews |
| `src/statusTracker.js` | Writes/updates per-employee Google Sheet dashboard; creates AL_DI_HR_018 and AL_DI_HR_019 sheets |
| `src/webhookServer.js` | Express server — push handlers, status pages, debug endpoints |
| `src/activityLog.js` | Append-only per-employee event log in `logs/<employeeId>.log` |
| `src/fireMilestones.js` | Dev script — fire all pending milestone callbacks immediately for a given employee (`node src/fireMilestones.js EMP001`) |
| `src/reExtractDocs.js` | Dev script — re-run Gemini extraction on already-uploaded education documents (`node src/reExtractDocs.js EMP001`) |
| `src/testInfoSheet.js` | Dev script — recreate the AL_DI_HR_018 info sheet for testing (`node src/testInfoSheet.js EMP001`) |
| `src/addEmployee.js` | Interactive CLI to register new employees |
| `src/listEmployees.js` | CLI employee list with progress |
| `src/removeEmployee.js` | CLI to remove an employee and clean up files |
| `src/resetEmployee.js` | CLI to wipe an employee's state for re-onboarding |
| `src/markTask.js` | CLI to manually mark a task done |
| `src/viewState.js` | CLI to pretty-print a state file |

## Drive Folder Structure (per employee)

Each new employee gets a folder `Name_EMPID` created automatically inside the Alethea Onboarding root with these subfolders:

```
Aadhaar / PAN / Offer_Letter / Passport_Photo / Passport / UAN /
Payslip / Relieving_Letter / Marksheet_10th / Marksheet_12th /
Degree_Certificate / Postgrad_Certificate / BGV /
Meeting_Screenshots / Reports
```

The Drive folder is shared with the recruiter only — the new joinee does not have direct Drive access. Documents are collected via the pre-onboarding Google Form which routes files to the correct subfolders automatically.

## Required Documents

**Mandatory (all employees):**
- Aadhaar Card
- PAN Card
- Signed Offer Letter
- Passport Size Photo
- 10th Marksheet
- 12th Marksheet / Diploma
- Graduation Degree Certificate
- Relieving Letter *(experienced candidates — mandatory for BGV)*

**Previous Employment (conditional — upload into `Relieving_Letter` or `Payslip` folder):**
- Employer 1 (most recent) — mandatory if previously employed, submit within 30–60 days
- Employer 2 — required if worked with 2 or more employers
- Employer 3 — required if worked with 3 or more employers
- For each employer: Relieving-cum-Experience Letter OR Full & Final Settlement Letter OR Last Month's Payslip
- Freshers skip this section entirely

**Optional:**
- Post Graduation Certificate
- Passport *(upload only if available)*
- UAN *(via UMANG app — experienced candidates, case by case)*

## Document Reminder Logic

When a document fails verification or is not uploaded:

1. Immediate rejection email sent to employee with the reason
2. **24h** — Reminder 1 sent to employee
3. **48h** — Reminder 2 sent to employee
4. **72h** — Final Reminder sent to employee + recruiter escalation alert

Successful re-upload at any point cancels all pending reminders automatically.

## Giving Someone Access

**View only (no engine setup needed):**
1. Share the Alethea Onboarding Google Drive folder with their Gmail
2. Share the Status Google Sheet with their Gmail
3. Add them as collaborator on this GitHub repo (Read access)

**Run the engine:**
1. All of the above
2. Share `credentials.json`, `token.json`, and `.env` securely (not via email or GitHub)
3. Add their Google account to the Google Cloud project (IAM → Editor)
4. They run `node src/auth.js` once to generate their own `token.json`

> Share sensitive files only via secure channels — encrypted messaging or a password manager. Never commit them to Git.

## Runtime Files (not committed)

| File | Description |
|------|-------------|
| `state-<ID>.json` | Per-employee checklist state — one file per employee |
| `seen-files.json` | Drive file IDs already processed — prevents re-processing on restart |
| `seen-files-meta.json` | Timestamps for `seen-files.json` entries — used to prune IDs older than 30 days |
| `logs/<ID>.log` | Append-only activity log per employee (JSON lines) |
| `employees.json` | Registered employees (contains personal data — never commit) |
| `.env` | API keys, passwords, URLs |
| `credentials.json` | Google OAuth client secret |
| `token.json` | Google OAuth access token |
| `push-channels.json` | Drive push channel IDs |
| `gmail-state.json` | Gmail history state |
