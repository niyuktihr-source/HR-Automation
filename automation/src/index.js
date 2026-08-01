require('dotenv').config();
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const config = require('./config');
const { encrypt, decrypt, isEncryptionEnabled } = require('./encryption');
const { getAuthClient, watchFolder, watchFolderPolling, scaffoldEmployeeFolder, lockEmployeeFolder, uploadChecklist, uploadInstructions, listFolderFiles } = require('./driveWatcher');
const { verifyDocument, detectDocType, extractDocumentData, crossCheckDocuments } = require('./documentVerifier');
const {
  sendEmail,
  sendPreOnboardingForm,
  sendDocumentRejection,
  sendNoResponseAlert,
  sendOfficialEmailCreationRequest,
  sendOfficialEmailAccessTest,
  sendAssetAllocationRequest,
  sendITAssetRequest,
  sendHRInductionConfirmation,
  sendPhaseCompletionSummary,
  sendVerificationReport,
  sendInductionCalendarInvite,
  sendProjectIntroInvite,
  sendCatchupXLSEmail,
  sendReviewSummaryRequest,
  sendAdminSeatAllocationRequest,
  send25DayCatchupEmail,
  sendDOJScreenshotRequest,
  sendDocumentCrossCheckAlert,
} = require('./emailSender');
const {
  scheduleAllMilestones,
  scheduleBGVInitiate,
  scheduleBGVRequest,
  scheduleManagerSheetReminder,
  schedulePreOnboardingReminders,
  scheduleNoResponseAlert,
  scheduleDocumentReminders,
  scheduleReplyDeadline,
  restoreMilestonesAfterRestart,
  startDailyHealthCheck,
  startDataRetentionCron,
  cancelAllJobs,
} = require('./cronJobs');
const { createHRInductionEvent, createProjectIntroEvent, create30DayCatchupEvent, createReviewEvent } = require('./calendarService');
const webhookServer = require('./webhookServer');
const { registerGmailWatch, downloadAttachment } = require('./gmailWatcher');
const activityLog = require('./activityLog');
const {
  getOrCreateStatusSheet,
  markPreonboardingInitiated,
  markDocumentsReceived,
  markDocumentIssue,
  markDocumentsVerifiedOk,
  markOfficialEmailConfirmed,
  markManagerConfirmed,
  markITConfirmed,
  markBGVDone,
  markHRInductionScheduled,
  markHRInductionDone,
  markProjectIntroScheduled,
  markProjectIntroDone,
  markOnboardingComplete,
  mark25DayCatchupDone,
  mark30DayDone,
  mark60DayDone,
  mark90DayDone,
  markPreprobationDone,
  renameStatusSheet,
  createProjectIntroSheet,
  createEmployeeInfoSheet,
} = require('./statusTracker');
const { updateMasterDashboard } = require('./masterDashboard');

// Resolve the HR email for a specific employee — uses the per-employee hrEmail captured
// from the recruiter form, falling back to the global HR_EMAIL env var.
function hrEmail(employee) {
  return (employee && employee.contacts && employee.contacts.hrEmail) || process.env.HR_EMAIL;
}

// ─── Employee registry ────────────────────────────────────────────────────────
// In production this would come from a database or a Google Sheet.
// For now it reads from employees.json in the project root if present,
// and falls back to the single employee defined in .env for quick testing.
const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..');

function statePathFor(employeeId) {
  return path.join(STATE_DIR, `state-${employeeId}.json`);
}

function loadState(employeeId) {
  // Per-employee file takes priority
  const perFile = statePathFor(employeeId);
  if (fs.existsSync(perFile)) {
    try {
      const raw = fs.readFileSync(perFile, 'utf8');
      // Detect encrypted payload (starts with '{' and has 'ciphertext' key)
      if (isEncryptionEnabled() && raw.includes('"ciphertext"')) {
        try {
          return JSON.parse(decrypt(raw));
        } catch (decryptErr) {
          console.error(`[State] CRITICAL: Could not decrypt state-${employeeId}.json — MASTER_ENCRYPTION_KEY may have changed. Error: ${decryptErr.message}`);
          console.error(`[State] Employee ${employeeId} will start fresh. Rename or delete state-${employeeId}.json to suppress this.`);
          return null;
        }
      }
      return JSON.parse(raw);
    } catch { return null; }
  }
  // One-time migration: check legacy shared state.json
  const legacyPath = path.join(STATE_DIR, 'state.json');
  if (fs.existsSync(legacyPath)) {
    try {
      const all = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      if (all[employeeId]) {
        // Migrate this employee out of the legacy file
        fs.writeFileSync(perFile, JSON.stringify(all[employeeId], null, 2));
        console.log(`[State] Migrated ${employeeId} from state.json → state-${employeeId}.json`);
        return all[employeeId];
      }
    } catch { /* ignore */ }
  }
  return null;
}

function saveState(employeeId, data) {
  const plaintext = JSON.stringify(data, null, 2);
  const payload = isEncryptionEnabled() ? encrypt(plaintext) : plaintext;
  fs.writeFileSync(statePathFor(employeeId), payload);
  // Debounce dashboard refresh: wait 5s so rapid saves don't fire multiple API calls
  clearTimeout(saveState._dashTimer);
  saveState._dashTimer = setTimeout(() => {
    if (saveState._auth) {
      const emps = Object.values(employeeRegistry);
      updateMasterDashboard(saveState._auth, emps).catch(err =>
        console.warn('[Dashboard] Background refresh failed:', err.message)
      );
    }
  }, 5000);
}

// Serialize all persistable fields from a live employee object into a plain object
function snapshotEmployee(employee) {
  // Serialise reply timer expiry timestamps AND recipient emails so they can be
  // correctly rescheduled after restart with the right escalation target.
  const replyTimerExpiry = {};
  if (employee.replyTimers) {
    for (const [key, task] of Object.entries(employee.replyTimers)) {
      if (task && task._expiresAt) {
        replyTimerExpiry[key] = {
          expiresAt: task._expiresAt,
          recipientEmail: task._recipientEmail || process.env.HR_EMAIL,
        };
      }
    }
  }
  return {
    // Identity fields — needed to reconstruct the employee on restart
    employeeId: employee.employeeId,
    name: employee.name,
    personalEmail: employee.personalEmail || '',
    phoneNumber: employee.phoneNumber || '',
    doj: employee.doj || '',
    driveFolderId: employee.driveFolderId || '',
    isFresher: employee.isFresher || false,
    role: employee.role || '',
    department: employee.department || '',
    contacts: employee.contacts || {},
    personalDetails: employee.personalDetails || {},
    // Runtime state
    checklist: employee.checklist,
    milestonesScheduled: employee.milestonesScheduled || false,
    statusSheetId: employee.statusSheetId || null,
    projectIntroSheetId: employee.projectIntroSheetId || null,
    employeeInfoSheetId: employee.employeeInfoSheetId || null,
    verificationResults: employee.verificationResults || {},
    extractedData: employee.extractedData || {},
    processedFileIds: Array.from(employee.processedFileIds || []),
    replyTimerExpiry,
    officialEmail: employee.officialEmail || '',
    assetDetails: employee.assetDetails || {},
  };
}

const EMPLOYEES_FILE = path.join(__dirname, '..', 'employees.json');

// Add or update an employee entry in employees.json so it survives engine restarts
function persistEmployeeToFile(data) {
  try {
    let list = [];
    if (fs.existsSync(EMPLOYEES_FILE)) {
      list = JSON.parse(fs.readFileSync(EMPLOYEES_FILE, 'utf8'));
    }
    const idx = list.findIndex(e => e.employeeId === data.employeeId);
    // Only store the fields employees.json needs (not runtime state)
    const entry = {
      employeeId: data.employeeId,
      name: data.name,
      personalEmail: data.personalEmail,
      phoneNumber: data.phoneNumber || '',
      officialEmail: data.officialEmail || '',
      doj: data.doj,
      driveFolderId: data.driveFolderId,
      isFresher: data.isFresher,
      role: data.role || '',
      department: data.department || '',
      contacts: data.contacts || {},
    };
    if (idx >= 0) list[idx] = entry; else list.push(entry);
    fs.writeFileSync(EMPLOYEES_FILE, JSON.stringify(list, null, 2));
    console.log(`[Index] Persisted ${data.employeeId} to employees.json`);
  } catch (err) {
    console.error(`[Index] Failed to persist ${data.employeeId} to employees.json:`, err.message);
  }
}

function loadEmployees() {
  const registryPath = EMPLOYEES_FILE;
  if (fs.existsSync(registryPath)) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (err) {
      console.error('[FATAL] employees.json is missing or contains invalid JSON:', err.message);
      process.exit(1);
    }
    if (!Array.isArray(raw)) {
      console.error('[FATAL] employees.json must be a JSON array. Got:', typeof raw);
      process.exit(1);
    }
    return raw;
  }

  // Single-employee fallback from .env — useful for initial testing
  if (process.env.EMPLOYEE_DRIVE_FOLDER_ID) {
    const employeeId = process.env.EMPLOYEE_ID || 'EMP001';
    const saved = loadState(employeeId);

    return [
      {
        employeeId,
        name: process.env.EMPLOYEE_NAME || 'New Employee',
        personalEmail: process.env.EMPLOYEE_PERSONAL_EMAIL || '',
        officialEmail: process.env.EMPLOYEE_OFFICIAL_EMAIL || '',
        doj: process.env.EMPLOYEE_DOJ || new Date().toISOString().split('T')[0],
        driveFolderId: process.env.EMPLOYEE_DRIVE_FOLDER_ID,
        contacts: {
          recruiterEmail: process.env.RECRUITER_EMAIL || process.env.HR_EMAIL,
          managerEmail: process.env.MANAGER_EMAIL || process.env.HR_EMAIL,
          itEmail: process.env.IT_EMAIL || process.env.HR_EMAIL,
        },
        // Restore checklist from state.json if it exists, otherwise start fresh
        checklist: (() => { const cl = saved ? saved.checklist : buildDefaultChecklist(); migrateChecklist(cl); return cl; })(),
        milestonesScheduled: saved ? saved.milestonesScheduled : false,
        statusSheetId: saved ? (saved.statusSheetId || null) : null,
        projectIntroSheetId: saved ? (saved.projectIntroSheetId || null) : null,
        employeeInfoSheetId: saved ? (saved.employeeInfoSheetId || null) : null,
        verificationResults: saved ? (saved.verificationResults || {}) : {},
        extractedData: saved ? (saved.extractedData || {}) : {},
        processedFileIds: new Set(saved && saved.processedFileIds ? saved.processedFileIds : []),
        replyTimerExpiry: saved ? (saved.replyTimerExpiry || {}) : {},
        phase: 'Phase2_BeforeDOJ',
        noResponseTimers: {},
        replyTimers: {},
      },
    ];
  }

  return [];
}

// ─── Default checklist (55 tasks, 7 phases) ───────────────────────────────────
// Matches the full workflow exactly:
//   Phase 1 — Recruiter manual checklist (Before DOJ)
//   Phase 2 — Automation checklist (Before DOJ)
//   Phase 3 — Day of Joining
//   Phase 4 — 30 Days After DOJ
//   Phase 5 — 60 Days After DOJ
//   Phase 6 — 90 Days After DOJ
//   Phase 7 — 5 Months After DOJ
function buildDefaultChecklist() {
  return {
    // ── Phase 1: Recruiter manual tasks (Before DOJ) ──────────────────────────
    // From recruiter checklist image
    phase1: {
      label: 'Phase 1 — Before DOJ (Recruiter)',
      tasks: {
        t1:  { label: 'Candidate accepts offer', done: false },
        t2:  { label: 'Recruiter creates Drive folder with joinee name (as per Aadhaar)', done: false },
        t3:  { label: 'Recruiter triggers automation via form/sheet with joinee details', done: false },
        t13: { label: 'Recruiter uploads signed offer letter into the created folder', done: false },
        t53: { label: 'Recruiter checks documents are saved in the folder', done: false },
      },
    },
    // ── Phase 2: Automation tasks (Before DOJ) ────────────────────────────────
    // From automation checklist image (steps 2–9)
    phase2: {
      label: 'Phase 2 — Before DOJ (Automation)',
      tasks: {
        t4:  { label: 'Pre-onboarding form sent to new joinee', done: false },
        t5:  { label: 'Employee uploads documents to Drive folder', done: false },
        t6:  { label: 'Employee folder created with joinee name and employee ID', done: false },
        t7:  { label: 'Checklist1 created in folder', done: false },
        t8:  { label: 'Sub-folders created and documents organised', done: false },
        t9:  { label: 'Document verification report generated for recruiter', done: false },
        t10: { label: 'Reminder sent to joinee if document incorrect/illegible', done: false },
        t11: { label: 'Alert sent to recruiter — no response from joinee > 24h', done: false },
        t56: { label: 'Passport size photo verified', done: false },
        t57: { label: 'Last payslip verified (or marked N/A — not applicable)', done: false },
        t58: { label: 'Relieving letter verified (or marked N/A — not applicable)', done: false },
        t59: { label: '10th marksheet verified', done: false },
        t60: { label: '12th/Diploma marksheet verified', done: false },
        t61: { label: 'Graduation degree certificate verified', done: false },
        t62: { label: 'Post graduation certificate verified (or marked N/A — not applicable)', done: false },
        t67: { label: 'Current address proof verified (PG rent slip / wifi bill / electricity bill / rent agreement)', done: false },
        t68: { label: 'Permanent address proof verified (Aadhaar / utility bill / rental agreement)', done: false },
        t69: { label: 'UAN verified (Universal Account Number — uploaded within 3 days of DOJ)', done: false },
        t12: { label: 'Document verification marked complete in Checklist1', done: false },
        t14: { label: 'Mail sent to HR to create official email ID and greythr login', done: false },
        t15: { label: 'HR responds with official email ID and greythr confirmation', done: false },
        t16: { label: 'Official email and greythr login marked complete in Checklist1', done: false },
        t17: { label: 'Mail sent to manager for asset/office location/supervisor allocation', done: false },
        t18: { label: 'Manager responds with allocation details', done: false },
        t19: { label: 'Manager allocation marked complete in Checklist1', done: false },
        t20: { label: 'Mail sent to IT team for asset allocation/office location', done: false },
        t21: { label: 'IT team responds with asset and access details', done: false },
        t22: { label: 'IT allocation marked complete in Checklist1', done: false },
        t23: { label: 'Mail sent to recruiter to initiate BGV', done: false },
        t24: { label: 'Recruiter triggers BGV', done: false },
        t25: { label: 'Recruiter responds with BGV report', done: false },
        t26: { label: 'BGV marked complete in Checklist1', done: false },
        t27: { label: 'HR induction scheduled on employee and recruiter calendars', done: false },
        t28: { label: 'HR induction scheduling marked complete in Checklist1', done: false },
        t29: { label: 'Project intro meeting scheduled with manager (post-lunch on DOJ)', done: false },
        t30: { label: 'Meeting reschedule option sent to participants', done: false },
        t31: { label: 'Project intro sheets created and populated', done: false },
        t32: { label: 'Project intro scheduling marked complete in Checklist1', done: false },
      },
    },
    // ── Phase 3: Day of Joining ───────────────────────────────────────────────
    // From DOJ image (steps 1–10)
    phase3: {
      label: 'Phase 3 — Day of Joining',
      tasks: {
        t66: { label: 'DOJ screenshot upload request sent to recruiter', done: false },
        t33: { label: 'Recruiter conducts HR induction', done: false },
        t34: { label: 'Automation confirms HR induction attendance', done: false },
        t35: { label: 'IT team confirms asset and access card allocation', done: false },
        t36: { label: 'General Admin confirms seat allocation', done: false },
        t37: { label: 'Project intro meeting attendance confirmed', done: false },
        t54: { label: 'Recruiter checks asset and seat allocation physically', done: false },
        t38: { label: 'Employee feedback form sent on day 25', done: false },
        t39: { label: '30-day catchup call scheduled', done: false },
        t40: { label: 'Catchup XLS created, shared with recruiter, saved in joinee folder', done: false },
        t41: { label: '30/60/90-day project reviews scheduled with manager and recruiter', done: false },
        t42: { label: 'Checklist1 updated — DOJ phase complete', done: false },
      },
    },
    // ── Phase 3b: 25 Days After DOJ — Catchup Call ───────────────────────────
    phase3b: {
      label: 'Phase 3b — 25th Day Catchup Call',
      tasks: {
        t63: { label: 'Day 25 catchup call email sent to HR and new joiner', done: false },
        t64: { label: 'Recruiter confirms catchup call happened', done: false },
        t65: { label: '25-day milestone marked complete in Checklist1', done: false },
      },
    },
    // ── Phase 4: 30 Days After DOJ ────────────────────────────────────────────
    // From 30-day image (steps 1–3)
    phase4: {
      label: 'Phase 4 — 30 Days After DOJ',
      tasks: {
        t43: { label: 'Catchup call transcribed and mailed to HR and manager', done: false },
        t44: { label: 'Recruiter catchup XLS verified as filled', done: false },
        t45: { label: '30-day milestone marked complete in Checklist1', done: false },
      },
    },
    // ── Phase 5: 60 Days After DOJ ────────────────────────────────────────────
    // From 60-day image — transcribe call; if didn't happen, mark pending + remind
    phase5: {
      label: 'Phase 5 — 60 Days After DOJ',
      tasks: {
        t46: { label: 'Call between recruiter and manager transcribed and project intro sheet updated', done: false },
        t47: { label: 'Call did not happen — reminder sent to reschedule; marked pending', done: false },
        t48: { label: '60-day milestone marked complete in Checklist1', done: false },
      },
    },
    // ── Phase 6: 90 Days After DOJ ────────────────────────────────────────────
    // Same pattern as 60-day
    phase6: {
      label: 'Phase 6 — 90 Days After DOJ',
      tasks: {
        t49: { label: 'Call between recruiter and manager transcribed and project intro sheet updated', done: false },
        t50: { label: 'Call did not happen — reminder sent to reschedule; marked pending', done: false },
        t51: { label: '90-day milestone marked complete in Checklist1', done: false },
      },
    },
    // ── Phase 7: 5 Months After DOJ ───────────────────────────────────────────
    phase7: {
      label: 'Phase 7 — 5 Months After DOJ (Pre-Probation)',
      tasks: {
        t52: { label: 'Pre-probation verification completed', done: false },
        t55: { label: 'Pre-probation result communicated to manager and HR', done: false },
      },
    },
  };
}

// ─── Checklist helpers ────────────────────────────────────────────────────────
function markTask(checklist, taskId) {
  for (const phase of Object.values(checklist)) {
    if (phase.tasks && phase.tasks[taskId]) {
      if (phase.tasks[taskId].done) return; // already done — no-op
      phase.tasks[taskId].done = true;
      console.log(`[Checklist] ✓ ${phase.tasks[taskId].label}`);
      return;
    }
  }
  console.warn(`[Checklist] Task "${taskId}" not found`);
}

// Mark task done AND write an activity log entry
function markAndLog(employee, taskId) {
  const checklist = employee.checklist;
  for (const phase of Object.values(checklist)) {
    if (phase.tasks && phase.tasks[taskId]) {
      if (phase.tasks[taskId].done) return;
      phase.tasks[taskId].done = true;
      console.log(`[Checklist] ✓ ${phase.tasks[taskId].label}`);
      activityLog.log(employee, `task_done:${taskId}`, phase.tasks[taskId].label);
      return;
    }
  }
  console.warn(`[Checklist] Task "${taskId}" not found`);
}

function isPhaseComplete(checklist, phaseKey) {
  const phase = checklist[phaseKey];
  if (!phase) return false;
  return Object.values(phase.tasks).every(t => t.done);
}

// Patch any tasks present in the default checklist but missing from a saved one.
// This handles employees whose state was saved before new tasks were added to the schema.
function migrateChecklist(checklist) {
  const defaults = buildDefaultChecklist();
  for (const [phaseKey, phase] of Object.entries(defaults)) {
    if (!checklist[phaseKey]) continue;
    for (const [taskId, task] of Object.entries(phase.tasks)) {
      if (!checklist[phaseKey].tasks[taskId]) {
        checklist[phaseKey].tasks[taskId] = { ...task };
        console.log(`[Checklist] Migrated missing task ${taskId}: "${task.label}"`);
      }
    }
  }
}

// ─── Document → required field mapping ────────────────────────────────────────
const DOC_TASK_MAP = {
  aadhaar:               't12',
  pan:                   't12',
  offerLetter:           't13',
  inductionScreenshot:   't34',
  projectIntroScreenshot:'t37',
  passportPhoto:         't56',
  payslip:               't57',
  relievingLetter:       't58',
  marksheet10th:         't59',
  marksheet12th:         't60',
  degreeCertificate:     't61',
  postgradCertificate:   't62',
  currentAddressProof:   't67',
  permanentAddressProof: 't68',
  uan:                   't69',
};

// Optional documents — auto-marked N/A if not uploaded within grace period
const OPTIONAL_DOCS = new Set(['payslip', 'postgradCertificate']);

// ─── Handler: new file detected in Drive folder ────────────────────────────────
// Internal files the engine creates — never treat as employee documents
const INTERNAL_FILE_PREFIXES = [
  'UPLOAD_INSTRUCTIONS',
  'AL_DI_HR_018',
  'Checklist1',
  'CatchupTracker',
  'ProjectIntro',
];

// Fire HR induction confirmation + calendar invite + project intro.
// Called both when the offer letter is verified AND on DOJ morning.
// Lock keys ensure each block runs only once regardless of which path fires first.
async function fireInductionAndProjectIntro(auth, employee) {
  const checklist = employee.checklist;
  const contacts  = employee.contacts || {};

  // t33: Send HR induction confirmation request to recruiter
  const inductionLockKey = `${employee.employeeId}:t33`;
  if (!isTaskDone(checklist, 't33') && !_triggerLocks.has(inductionLockKey)) {
    _triggerLocks.add(inductionLockKey);
    markAndLog(employee, 't33');
    saveState(employee.employeeId, snapshotEmployee(employee));
    await sendHRInductionConfirmation(employee, contacts.recruiterEmail);
    employee.replyTimers = employee.replyTimers || {};
    employee.replyTimers.induction = scheduleReplyDeadline(
      employee, 'Recruiter (HR Induction)', contacts.recruiterEmail, 48,
      `The system sent the recruiter an HR Induction confirmation email for ${employee.name}. The recruiter needs to conduct the HR induction session and then upload a screenshot of the meeting to the HR_Induction_Screenshot folder in the employee's Drive folder. No response has been received.`
    );
  }

  // t27/t28: Send HR induction calendar invite to employee + recruiter
  // t27/t28 stay pending (yellow on dashboard) until recruiter uploads induction screenshot
  const calLockKey = `${employee.employeeId}:t27`;
  if (!isTaskDone(checklist, 't27') && !_triggerLocks.has(calLockKey)) {
    _triggerLocks.add(calLockKey);
    saveState(employee.employeeId, snapshotEmployee(employee));
    await sendInductionCalendarInvite(employee);
    await createHRInductionEvent(auth, employee).catch(err => {
      console.warn(`[Index] HR induction calendar event failed for ${employee.name} — email invite still sent. (${err.message})`);
      activityLog.log(employee, 'calendar_event_failed', `HR induction: ${err.message}`);
    });
    await markHRInductionScheduled(auth, employee).catch(() => {});
    console.log(`[Index] HR induction invite sent for ${employee.name} — awaiting screenshot upload to mark done`);
  }

  // t29/t30/t31/t32: Create project intro sheet, send invite + sheet link to manager + employee
  // t29/t32 stay pending (yellow on dashboard) until recruiter uploads project intro screenshot
  const introLockKey = `${employee.employeeId}:t29`;
  if (!isTaskDone(checklist, 't29') && !_triggerLocks.has(introLockKey)) {
    _triggerLocks.add(introLockKey);
    const sheetUrl = await createProjectIntroSheet(auth, employee).catch(err => {
      console.warn(`[Index] Project intro sheet creation failed for ${employee.name}: ${err.message}`);
      return null;
    });
    markAndLog(employee, 't30');
    markAndLog(employee, 't31');
    saveState(employee.employeeId, snapshotEmployee(employee));

    await sendProjectIntroInvite(employee, sheetUrl);
    await createProjectIntroEvent(auth, employee).catch(err => {
      console.warn(`[Index] Project intro calendar event failed for ${employee.name} — email invite still sent. (${err.message})`);
      activityLog.log(employee, 'calendar_event_failed', `Project intro: ${err.message}`);
    });
    await markProjectIntroScheduled(auth, employee).catch(() => {});

    // Daily reminder to manager until they fill the project intro sheet
    if (sheetUrl && contacts.managerEmail) {
      scheduleManagerSheetReminder(
        employee, contacts.managerEmail, sheetUrl,
        'Project Intro', 't32', null
      );
    }

    if (sheetUrl && employee.projectIntroSheetId) {
      const empEmail = employee.officialEmail || employee.personalEmail;
      if (empEmail) {
        setTimeout(async () => {
          try {
            const { google } = require('googleapis');
            const drive = google.drive({ version: 'v3', auth });
            const perms = await drive.permissions.list({
              fileId: employee.projectIntroSheetId,
              fields: 'permissions(id,emailAddress)',
            });
            const empPerm = perms.data.permissions.find(p => p.emailAddress === empEmail);
            if (empPerm) {
              await drive.permissions.delete({ fileId: employee.projectIntroSheetId, permissionId: empPerm.id });
              console.log(`[Index] Project intro sheet access revoked for ${employee.name} (${empEmail}) after 48h`);
              activityLog.log(employee, 'project_intro_sheet_access_revoked', empEmail);
            }
          } catch (err) {
            console.warn(`[Index] Could not revoke project intro sheet access for ${employee.name}: ${err.message}`);
          }
        }, 48 * 60 * 60 * 1000);
      }
    }
  }

  // Send screenshot upload request to recruiter immediately after meetings are scheduled
  if (!isTaskDone(checklist, 't66')) {
    await sendDOJScreenshotRequest(employee).catch(err =>
      console.warn(`[Index] DOJ screenshot request failed for ${employee.name}: ${err.message}`)
    );
    markAndLog(employee, 't66');
    saveState(employee.employeeId, snapshotEmployee(employee));
    console.log(`[Index] DOJ screenshot request sent to recruiter for ${employee.name}`);
  }

  await uploadChecklist(auth, employee.driveFolderId, checklist).catch(() => {});
  saveState(employee.employeeId, snapshotEmployee(employee));
}

async function handleNewFile(auth, employee, file, subfolderHint) {
  // Skip folders — only process actual files
  if (file.mimeType === 'application/vnd.google-apps.folder') {
    return true;
  }

  // Skip internal engine-generated files silently
  if (INTERNAL_FILE_PREFIXES.some(p => file.name.startsWith(p))) {
    return true;
  }

  // Skip Google Sheets/Docs — these are engine-created files, not employee documents
  if (file.mimeType === 'application/vnd.google-apps.spreadsheet' ||
      file.mimeType === 'application/vnd.google-apps.document') {
    return true;
  }

  // Classify document type — subfolder is authoritative, then content, then filename
  const docType = await detectDocType(auth, file.id, file.name, file.mimeType, subfolderHint);
  if (!docType) {
    console.log(`[Index] Could not classify file: ${file.name} — sending re-upload request`);
    activityLog.log(employee, 'document_rejected', `${file.name} — Could not identify document type from content or filename. Please re-upload a valid HR document.`);
    await sendDocumentRejection(employee, file.name, 'We could not identify what type of document this is. Please re-upload the correct document (Aadhaar, PAN, offer letter, marksheet, etc.).').catch(() => {});
    if (!employee.processedFileIds) employee.processedFileIds = new Set();
    employee.processedFileIds.add(file.id);
    saveState(employee.employeeId, snapshotEmployee(employee));
    return true;
  }

  // Skip files already processed in a previous run (pass or fail) — prevents
  // duplicate verification emails on every restart. A new upload gets a new file ID
  // so it will be processed fresh even for the same doc type.
  if (!employee.processedFileIds) employee.processedFileIds = new Set();
  if (employee.processedFileIds.has(file.id)) {
    console.log(`[Index] Skipping ${file.name} — already processed in a previous run`);
    return true;
  }

  // Also skip if this doc type already passed — belt-and-suspenders guard
  const existingResult = employee.verificationResults && employee.verificationResults[docType];
  if (existingResult && existingResult.valid) {
    console.log(`[Index] Skipping ${file.name} — ${docType} already verified`);
    employee.processedFileIds.add(file.id);
    return true;
  }

  // t5: employee has uploaded at least one document to the Drive folder
  if (!isTaskDone(employee.checklist, 't5')) {
    markAndLog(employee, 't5');
    // Cancel pre-onboarding reminders — joinee has started uploading docs
    if (employee.noResponseTimers && employee.noResponseTimers['preOnboarding']) {
      employee.noResponseTimers['preOnboarding'].stop();
      delete employee.noResponseTimers['preOnboarding'];
    }
  }

  console.log(`[Index] Verifying ${file.name} for ${employee.name}`);
  let result;
  try {
    result = await verifyDocument(auth, file.id, file.name, file.mimeType, subfolderHint);
  } catch (err) {
    console.error(`[Index] verifyDocument failed for ${file.name}:`, err.message);
    activityLog.log(employee, 'verification_error', `${file.name} — ${err.message}`);
    return false; // signal caller to remove from seen-files so it can be retried
  }

  // Always accumulate verification results for the report (pass or fail)
  employee.verificationResults = employee.verificationResults || {};
  employee.verificationResults[docType] = {
    valid: result.valid,
    summary: result.valid
      ? (result.summary || 'Verification successful')
      : (result.failureReasons ? result.failureReasons.join('; ') : 'Verification failed'),
  };

  // Sheet: mark documents received
  await markDocumentsReceived(auth, employee, docType).catch(() => {});

  if (result.valid) {
    console.log(`[Index] ✓ ${file.name} passed verification`);
    activityLog.log(employee, 'document_verified', `${docType} — ${file.name}`);

    // Mark corresponding checklist task
    const taskId = DOC_TASK_MAP[docType];
    if (taskId) markAndLog(employee, taskId);

    // Aadhaar auto-satisfies permanent address proof
    if (docType === 'aadhaar' && !isTaskDone(employee.checklist, 't68')) {
      markAndLog(employee, 't68');
    }

    // Cancel any pending no-response timer for this doc type
    if (employee.noResponseTimers[docType]) {
      employee.noResponseTimers[docType].stop();
      delete employee.noResponseTimers[docType];
    }

    // If a rejection was previously issued for any doc, clear the "Documents not ok" sheet row
    await markDocumentsVerifiedOk(auth, employee).catch(() => {});

    // Extract structured data from the verified doc — await so data is ready before t9 sheet creation
    try {
      const extracted = await extractDocumentData(auth, file.id, file.name, file.mimeType, subfolderHint);
      if (extracted && extracted.docType && extracted.fields) {
        employee.extractedData = employee.extractedData || {};
        employee.extractedData[extracted.docType] = extracted.fields;
        console.log(`[Index] Extracted data stored for ${extracted.docType} — ${employee.name}`);
        // Rename status sheet using Aadhaar name — recruiter may have entered wrong name
        if (extracted.docType === 'aadhaar' && extracted.fields.name) {
          renameStatusSheet(auth, employee, extracted.fields.name).catch(() => {});
        }
        // Update info sheet immediately if it already exists
        if (employee.employeeInfoSheetId) {
          createEmployeeInfoSheet(auth, employee).catch(err =>
            console.warn(`[Index] Info sheet update failed after extraction for ${employee.name}: ${err.message}`)
          );
        }
      }
    } catch (err) {
      console.warn(`[Index] Extraction failed for ${file.name}: ${err.message}`);
    }
  } else {
    const reason = result.failureReasons ? result.failureReasons.join('; ') : 'Verification failed';
    console.log(`[Index] ✗ ${file.name} failed: ${reason}`);
    activityLog.log(employee, 'document_rejected', `${docType} — ${file.name} — ${reason}`);

    await sendDocumentRejection(employee, result.docType || docType, reason).catch(err =>
      console.warn(`[Index] Document rejection email failed for ${employee.name}: ${err.message}`)
    );
    await markDocumentIssue(auth, employee, result.docType || docType, reason).catch(() => {});

    // t10: reminder sent for incorrect document
    if (!isTaskDone(employee.checklist, 't10')) {
      markAndLog(employee, 't10');
    }

    // Cancel any existing reminder chain for this doc, then start a fresh 3-reminder sequence
    // Reminders fire at 24h, 48h, 72h to the employee; recruiter escalated after the 3rd
    if (employee.noResponseTimers[docType]) employee.noResponseTimers[docType].stop();
    const alertRecipient = (employee.contacts && employee.contacts.recruiterEmail) || process.env.HR_EMAIL;
    employee.noResponseTimers[docType] = scheduleDocumentReminders(employee, result.docType || docType, reason, alertRecipient);
  }

  // Verification report is sent once — as a consolidated email when all docs are done.
  // See the BGV auto-complete block in triggerNextStep which fires sendVerificationReport.

  // Record file as processed so restarts don't re-verify and re-send emails
  employee.processedFileIds.add(file.id);

  // Save updated checklist to Drive and locally
  await uploadChecklist(auth, employee.driveFolderId, employee.checklist);
  saveState(employee.employeeId, snapshotEmployee(employee));

  // Trigger next steps based on which document just passed (only if valid)
  if (result.valid) {
    await triggerNextStep(auth, employee, docType);
  }
  return true;
}

// ─── Trigger next automation step after a document passes ─────────────────────
// Per-employee in-memory lock set — prevents duplicate emails when multiple docs
// arrive simultaneously and both pass before state is persisted to disk.
const _triggerLocks = new Set();

async function triggerNextStep(auth, employee, docType) {
  const { checklist, contacts } = employee;
  if (!contacts) {
    console.error(`[Index] triggerNextStep: missing contacts for ${employee.name} — cannot proceed`);
    return;
  }

  // After all identity docs verified → request official email creation (t14)
  // Both aadhaar AND pan must pass before firing — check verificationResults, not just t12,
  // because t12 is shared and gets marked on whichever arrives first.
  if (docType === 'aadhaar' || docType === 'pan') {
    const vr = employee.verificationResults || {};
    const bothVerified = vr.aadhaar && vr.aadhaar.valid && vr.pan && vr.pan.valid;
    const lockKey = `${employee.employeeId}:docsVerified`;
    if (bothVerified && !_triggerLocks.has(lockKey)) {
      _triggerLocks.add(lockKey);
      // Both identity docs verified — update Drive/status sheet.
      // t14 (official email request) is intentionally NOT marked here.
      // fireDOJEmails() marks t14 and sends the email on DOJ morning.
      await markDocumentsVerifiedOk(auth, employee).catch(() => {});
      await uploadChecklist(auth, employee.driveFolderId, checklist);
      saveState(employee.employeeId, snapshotEmployee(employee));
    }
  }

  // Send ONE consolidated doc verification report when all expected docs are verified.
  // BGV is always handled separately — HR forwards the SmartScreen PDF to the engine.
  const ALL_DOCS = employee.isFresher
    ? ['aadhaar', 'pan', 'marksheet10th', 'marksheet12th', 'degreeCertificate']
    : ['aadhaar', 'pan', 'marksheet10th', 'marksheet12th', 'degreeCertificate', 'relievingLetter'];
  const reportLockKey = `${employee.employeeId}:t9`;
  if (!isTaskDone(checklist, 't9') && !_triggerLocks.has(reportLockKey)) {
    const vr = employee.verificationResults || {};
    const allCoreDone = ALL_DOCS.every(d => vr[d] && (vr[d].valid || vr[d].valid === false));
    if (allCoreDone) {
      _triggerLocks.add(reportLockKey);
      markAndLog(employee, 't9');
      saveState(employee.employeeId, snapshotEmployee(employee));
      try {
        await sendVerificationReport(employee, vr);
        console.log(`[Index] Consolidated doc verification report sent for ${employee.name}`);
      } catch (err) {
        console.warn(`[Index] Could not send consolidated verification report: ${err.message}`);
        _triggerLocks.delete(reportLockKey);
      }

      // Cross-check extracted data across documents for mismatches
      const mismatches = crossCheckDocuments(employee.extractedData);
      if (mismatches.length > 0) {
        console.log(`[Index] ${mismatches.length} document mismatch(es) found for ${employee.name} — alerting HR`);
        sendDocumentCrossCheckAlert(employee, mismatches).catch(err =>
          console.warn(`[Index] Cross-check alert email failed for ${employee.name}: ${err.message}`)
        );
      } else {
        console.log(`[Index] Document cross-check passed for ${employee.name} — no mismatches`);
      }

      // Create or update AL/DI/HR/018 Employee Info Sheet with AI-extracted data pre-filled
      createEmployeeInfoSheet(auth, employee).then(url => {
        if (url) {
          console.log(`[Index] Employee info sheet created/updated for ${employee.name}: ${url}`);
          saveState(employee.employeeId, snapshotEmployee(employee));
        }
      }).catch(err => {
        console.warn(`[Index] Employee info sheet creation failed for ${employee.name}: ${err.message}`);
      });

      await uploadChecklist(auth, employee.driveFolderId, checklist);
      saveState(employee.employeeId, snapshotEmployee(employee));
    }
  }

  // Fire HR induction + project intro — triggered by offer letter OR on DOJ (whichever comes first).
  // Lock keys ensure each block fires only once regardless of which path triggers it.
  await fireInductionAndProjectIntro(auth, employee);

  if (docType === 'offerLetter') {
    await uploadChecklist(auth, employee.driveFolderId, checklist);
    saveState(employee.employeeId, snapshotEmployee(employee));
  }

  // HR induction screenshot uploaded → mark t27/t28/t34 done
  if (docType === 'inductionScreenshot') {
    markAndLog(employee, 't27');
    markAndLog(employee, 't28');
    markAndLog(employee, 't34');
    await uploadChecklist(auth, employee.driveFolderId, checklist);
    await markHRInductionDone(auth, employee).catch(() => {});
    console.log(`[Index] HR induction screenshot verified for ${employee.name} — t27/t28/t34 marked done`);
  }

  // Project intro screenshot uploaded → mark t29/t32/t37 done
  if (docType === 'projectIntroScreenshot') {
    markAndLog(employee, 't29');
    markAndLog(employee, 't32');
    markAndLog(employee, 't37');
    await uploadChecklist(auth, employee.driveFolderId, checklist);
    await markProjectIntroDone(auth, employee).catch(() => {});
    console.log(`[Index] Project intro screenshot verified for ${employee.name} — t29/t32/t37 marked done`);
  }

  // Once BOTH screenshots are in → complete DOJ phase and fire post-DOJ tasks
  if (
    (docType === 'inductionScreenshot' || docType === 'projectIntroScreenshot') &&
    isTaskDone(checklist, 't34') && isTaskDone(checklist, 't37')
  ) {
    markAndLog(employee, 't42');
    await uploadChecklist(auth, employee.driveFolderId, checklist);

    // Schedule all timed milestones if not already done
    if (!employee.milestonesScheduled) {
      const markTaskForEmployee = (taskId) => markAndLog(employee, taskId);
      scheduleAllMilestones(employee, contacts, markTaskForEmployee);
      employee.milestonesScheduled = true;
      markAndLog(employee, 't39');
      markAndLog(employee, 't41');
      await uploadChecklist(auth, employee.driveFolderId, checklist);
      await markOnboardingComplete(auth, employee).catch(() => {});
      saveState(employee.employeeId, snapshotEmployee(employee));
    }

    // t40: Send catchup XLS tracker email to recruiter + manager
    if (!isTaskDone(checklist, 't40')) {
      markAndLog(employee, 't40');
      saveState(employee.employeeId, snapshotEmployee(employee));
      await sendCatchupXLSEmail(employee);
      await uploadChecklist(auth, employee.driveFolderId, checklist);
    }

    // t36: Send seat allocation confirmation request to Admin
    employee.replyTimers = employee.replyTimers || {};
    if (!isTaskDone(checklist, 't36')) {
      markAndLog(employee, 't36');
      saveState(employee.employeeId, snapshotEmployee(employee));
      await sendAdminSeatAllocationRequest(employee).catch(err =>
        console.warn(`[Index] Admin seat allocation email failed for ${employee.name}: ${err.message}`)
      );
      employee.replyTimers.admin = scheduleReplyDeadline(
        employee, 'Admin (Seat Allocation)', hrEmail(employee), null,
        `The system sent the admin a seat allocation request for ${employee.name} (DOJ: ${employee.doj}). Admin needs to confirm the seat number/location assigned to this employee and reply. No response has been received.`
      );
    }
    saveState(employee.employeeId, snapshotEmployee(employee));

    if (isPhaseComplete(checklist, 'phase3')) {
      const done = Object.values(checklist.phase3.tasks).map(t => t.label);
      await sendPhaseCompletionSummary(employee, 'Phase 3 — Day of Joining', done);
    }
  }
}

function isTaskDone(checklist, taskId) {
  for (const phase of Object.values(checklist)) {
    if (phase.tasks && phase.tasks[taskId]) return phase.tasks[taskId].done;
  }
  return false;
}

// ─── Process BGV PDF report forwarded by HR/recruiter ────────────────────────
// Downloads the PDF, sends to Gemini to classify overall status (Green/Orange/Red),
// updates checklist tasks, and alerts HR if Orange or Red.
async function processBGVReport(auth, employee, rawMsg) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');

  const attachment = rawMsg.attachments && rawMsg.attachments[0];
  if (!attachment) {
    console.warn(`[BGV] No PDF attachment found in email for ${employee.name}`);
    return;
  }

  console.log(`[BGV] Processing BGV report for ${employee.name}: ${attachment.filename}`);

  // Download PDF bytes
  let pdfBuffer;
  try {
    if (attachment.data) {
      pdfBuffer = Buffer.from(attachment.data, 'base64');
    } else if (attachment.attachmentId) {
      pdfBuffer = await downloadAttachment(auth, rawMsg.id, attachment.attachmentId);
    } else {
      console.warn(`[BGV] Attachment has no data or attachmentId — skipping`);
      return;
    }
  } catch (err) {
    console.error(`[BGV] Failed to download attachment: ${err.message}`);
    return;
  }

  // ── Gemini: classify the Smartscreen BGV report ──────────────────────────
  let bgvResult = null;
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: config.geminiModel });

    const pdfBase64 = pdfBuffer.toString('base64');
    const prompt = `You are an HR automation assistant. Analyse this Smartscreen BGV (Background Verification) report PDF produced by Supersoft Consultants Pvt Ltd.

The report has an overall result badge in the top-right corner of page 1. Read it carefully:
- "Verified" badge (white/grey background) → overall_status = "Verified"   (Green — all checks passed)
- "Unable to Verify" badge (orange background) → overall_status = "Unable to Verify"   (Orange — one or more checks could not be confirmed)
- "Discrepancy" badge (red background) → overall_status = "Discrepancy"   (Red — a document or claim was found to be forged or false)

Also extract:
- ssid: the SSID reference number (format like ACT-2026-XXX-XXXXXX or TMP-2026-XXX-XXXXXX)
- candidate_name: full name of the candidate as shown in the report
- failing_checks: ONLY checks that are NOT "Verified" — include their name, status, and reason/remark

Individual check statuses you may see: "Verified", "UTV - Others", "Not Provided", "Discrepancy"
"UTV - Others" and "Not Provided" both count as unable-to-verify. "Discrepancy" means forged/false.

Respond ONLY with this exact JSON (no extra text):
{
  "overall_status": "Verified" or "Unable to Verify" or "Discrepancy",
  "ssid": "SSID from report or null",
  "candidate_name": "name from report or null",
  "failing_checks": [
    { "check_name": "Employment Check", "status": "UTV - Others", "reason": "Company not found at physical address" }
  ],
  "all_checks": [
    { "check_name": "PAN Card", "status": "Verified" }
  ],
  "summary": "one sentence summary of the BGV outcome"
}`;

    const response = await model.generateContent([
      prompt,
      { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
    ]);

    const raw = response.response.text().trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) bgvResult = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`[BGV] Gemini analysis failed: ${err.message}`);
  }

  if (!bgvResult) {
    await sendEmail({
      to: hrEmail(employee),
      subject: `BGV Report Received — Manual Review Required (${employee.name})`,
      html: `<p>Hi HR,</p><p>A BGV report was received for <strong>${employee.name} (${employee.employeeId})</strong> but the automation could not parse it. Please review it manually.</p><p>Regards,<br/>${process.env.COMPANY_NAME} HR Automation</p>`,
    }).catch(() => {});
    return;
  }

  const overallStatus = bgvResult.overall_status || 'Unable to Verify';
  const ssid = bgvResult.ssid || attachment.filename;
  const failingChecks = bgvResult.failing_checks || [];
  const allChecks = bgvResult.all_checks || [];

  // Map overall_status → traffic-light colour
  const isGreen  = overallStatus === 'Verified';
  const isOrange = overallStatus === 'Unable to Verify';
  const isRed    = overallStatus === 'Discrepancy';

  console.log(`[BGV] ${employee.name}: ${overallStatus} (SSID: ${ssid}, ${failingChecks.length} failing check(s))`);
  activityLog.log(employee, 'bgv_report_received', overallStatus);

  // ── Upload PDF to BGV subfolder in Drive ─────────────────────────────────
  try {
    const { google } = require('googleapis');
    const drive = google.drive({ version: 'v3', auth });
    const folderRes = await drive.files.list({
      q: `name='BGV' and '${employee.driveFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    });
    if (folderRes.data.files.length > 0) {
      const bgvFolderId = folderRes.data.files[0].id;
      const { Readable } = require('stream');
      const stream = new Readable();
      stream.push(pdfBuffer);
      stream.push(null);
      await drive.files.create({
        requestBody: { name: attachment.filename, parents: [bgvFolderId] },
        media: { mimeType: 'application/pdf', body: stream },
        fields: 'id',
      });
      console.log(`[BGV] PDF uploaded to BGV folder for ${employee.name}`);
    } else {
      console.warn(`[BGV] BGV subfolder not found for ${employee.name}`);
    }
  } catch (err) {
    console.warn(`[BGV] Could not upload PDF to Drive: ${err.message}`);
  }

  // ── Build check rows for the HR alert email ───────────────────────────────
  const checksToShow = allChecks.length > 0 ? allChecks : failingChecks;
  const hasReasons = checksToShow.some(c => c.reason);
  const checkRows = checksToShow.map(c => {
    const isOk = c.status === 'Verified';
    const color = isOk ? '#2e7d32' : (c.status === 'Discrepancy' ? '#c62828' : '#e65100');
    const reasonCell = hasReasons ? `<td style="padding:6px 12px;border:1px solid #ddd;font-size:13px;color:#555;">${c.reason || ''}</td>` : '';
    return `<tr>
      <td style="padding:6px 12px;border:1px solid #ddd;">${c.check_name}</td>
      <td style="padding:6px 12px;border:1px solid #ddd;color:${color};font-weight:bold;">${c.status}</td>
      ${reasonCell}
    </tr>`;
  }).join('');

  const reasonColHeader = hasReasons ? `<th style="padding:8px 12px;border:1px solid #1a73e8;text-align:left;">Reason / Remark</th>` : '';
  const tableHeader = `<tr style="background:#1a73e8;color:#fff;">
    <th style="padding:8px 12px;border:1px solid #1a73e8;text-align:left;">Check</th>
    <th style="padding:8px 12px;border:1px solid #1a73e8;text-align:left;">Status</th>
    ${reasonColHeader}
  </tr>`;

  // ── Colour + label based on traffic-light status ──────────────────────────
  const badgeColor = isGreen ? '#2e7d32' : isOrange ? '#e65100' : '#c62828';
  const badgeBg    = isGreen ? '#e8f5e9' : isOrange ? '#fff3e0' : '#ffebee';
  const badgeLabel = isGreen ? '&#9989; Verified (Green)' : isOrange ? '&#9888;&#65039; Unable to Verify (Orange)' : '&#10060; Discrepancy (Red)';

  const actionHtml = isGreen
    ? `<p style="color:#2e7d32;">BGV is clear. Onboarding can proceed.</p>`
    : isOrange
      ? `<p style="color:#e65100;font-weight:bold;">Action Required: BGV is Unable to Verify. One or more checks could not be confirmed. Please review and decide whether to proceed, request re-verification, or escalate.</p>`
      : `<p style="color:#c62828;font-weight:bold;">Action Required: BGV shows a Discrepancy. A document or claim appears to be forged or false. Please review immediately and decide on next steps before proceeding with onboarding.</p>`;

  const failingSection = (!isGreen && failingChecks.length > 0) ? `
    <p style="margin-top:16px;font-weight:bold;">Failing / Flagged Checks:</p>
    <ul style="margin:4px 0;padding-left:20px;">
      ${failingChecks.map(c => `<li><strong>${c.check_name}</strong> — ${c.status}${c.reason ? ': ' + c.reason : ''}</li>`).join('')}
    </ul>` : '';

  await sendEmail({
    to: hrEmail(employee),
    subject: `BGV Report — ${overallStatus} — ${employee.name} (${employee.employeeId})`,
    html: `
      <p>Hi HR Team,</p>
      <p>The Background Verification (BGV) report for <strong>${employee.name}</strong> (ID: ${employee.employeeId}) has been processed.</p>
      <p style="font-size:16px;font-weight:bold;color:${badgeColor};background:${badgeBg};display:inline-block;padding:6px 14px;border-radius:4px;">${badgeLabel}</p>
      <table style="margin:4px 0;font-size:14px;"><tr><td style="padding:2px 8px 2px 0;color:#555;">SSID:</td><td><strong>${ssid}</strong></td></tr></table>
      <p>${bgvResult.summary || ''}</p>
      ${failingSection}
      ${checksToShow.length > 0 ? `
      <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;margin:16px 0;">
        <thead>${tableHeader}</thead>
        <tbody>${checkRows}</tbody>
      </table>` : ''}
      <p>The BGV report PDF has been saved to the employee's BGV folder in Drive.</p>
      ${actionHtml}
      <p>Regards,<br/>${process.env.COMPANY_NAME} HR Automation</p>
    `,
  }).catch(err => console.warn(`[BGV] Notification email failed: ${err.message}`));

  // ── Update checklist based on traffic-light result ────────────────────────
  markAndLog(employee, 't25'); // Recruiter responded with BGV report

  if (isGreen) {
    // Green: BGV complete — mark t26 done
    markAndLog(employee, 't26');
    await markBGVDone(auth, employee).catch(() => {});
  } else if (isOrange) {
    // Orange: Unable to Verify — t26 stays pending; mark issue on status sheet
    await markDocumentIssue(auth, employee, 'BGV', `Unable to Verify — ${failingChecks.map(c => c.check_name).join(', ')}`).catch(() => {});
  } else if (isRed) {
    // Red: Discrepancy — t26 stays pending; mark issue on status sheet
    await markDocumentIssue(auth, employee, 'BGV', `Discrepancy — ${failingChecks.map(c => c.check_name + (c.reason ? ': ' + c.reason : '')).join('; ')}`).catch(() => {});
  }

  await uploadChecklist(auth, employee.driveFolderId, employee.checklist);
  saveState(employee.employeeId, snapshotEmployee(employee));
}

// ─── Handle classified Gmail reply ────────────────────────────────────────────
async function handleReply(auth, classified, rawMsg) {
  const { replyType, data } = classified;
  const rawId = String(classified.employeeId || '').trim();

  let employee = employeeRegistry[rawId];

  // Fallback 1: Gemini sometimes returns the employee name instead of the ID
  if (!employee && rawId) {
    const needle = rawId.toLowerCase();
    employee = Object.values(employeeRegistry).find(
      e => e.name && e.name.toLowerCase() === needle
    );
    if (employee) {
      console.log(`[Index] Matched employee by name "${rawId}" → ${employee.employeeId}`);
    }
  }

  // Fallback 2: when employeeId is null, match by sender email + pending task state
  if (!employee && replyType) {
    const senderEmail = rawMsg && rawMsg.from
      ? rawMsg.from.toLowerCase().replace(/.*<([^>]+)>.*/, '$1').trim()
      : '';

    const PENDING_TASK_MAP = {
      it_allocation:              e => isTaskDone(e.checklist, 't20') && !isTaskDone(e.checklist, 't21'),
      manager_allocation:         e => isTaskDone(e.checklist, 't17') && !isTaskDone(e.checklist, 't18'),
      official_email_created:     e => !isTaskDone(e.checklist, 't15'),
      greythr_welcome:            e => isTaskDone(e.checklist, 't14') && !isTaskDone(e.checklist, 't16'),
      official_email_access_confirmed: e => isTaskDone(e.checklist, 't15') && !isTaskDone(e.checklist, 't16'),
      official_email_access_failed:    e => isTaskDone(e.checklist, 't15') && !isTaskDone(e.checklist, 't16'),
      bgv_report:                 e => isTaskDone(e.checklist, 't23') && !isTaskDone(e.checklist, 't25'),
      induction_confirmed:        e => !isTaskDone(e.checklist, 't33'),
    };

    const pendingCheck = PENDING_TASK_MAP[replyType];
    const candidates = Object.values(employeeRegistry).filter(e => pendingCheck ? pendingCheck(e) : true);

    if (candidates.length === 1) {
      employee = candidates[0];
      console.log(`[Index] Matched employee by pending task state (${replyType}) → ${employee.employeeId}`);
    } else if (candidates.length > 1) {
      // For greythr_welcome: Gemini extracts the joinee name into data.notes — match by name
      if (replyType === 'greythr_welcome' && classified.data && classified.data.notes) {
        const greythrName = classified.data.notes.toLowerCase().trim();
        employee = candidates.find(e => e.name && e.name.toLowerCase().trim() === greythrName);
        if (employee) {
          console.log(`[Index] Matched greythr_welcome to ${employee.employeeId} by name "${greythrName}"`);
        }
      }
      // Narrow by sender address matching a known contact
      if (!employee && senderEmail) {
        employee = candidates.find(e => {
          const contacts = e.contacts || {};
          return [contacts.itEmail, contacts.managerEmail, contacts.recruiterEmail, e.personalEmail, e.officialEmail]
            .some(addr => addr && addr.toLowerCase() === senderEmail);
        });
        if (employee) {
          console.log(`[Index] Matched employee by sender email "${senderEmail}" → ${employee.employeeId}`);
        }
      }
    }
  }

  if (!employee) {
    console.warn(`[Index] Reply for unknown employee: ${classified.employeeId}`);
    return;
  }

  const employeeId = employee.employeeId;
  const { checklist } = employee;

  console.log(`[Index] Processing reply: ${replyType} for ${employee.name}`);
  activityLog.log(employee, 'reply_received', replyType);

  switch (replyType) {
    case 'meeting_time_preference': {
      const pd = employee.personalDetails || {};
      if (data.inductionTime) {
        pd['Preferred Time for HR Induction'] = data.inductionTime;
        console.log(`[Index] HR Induction preferred time set to ${data.inductionTime} for ${employee.name}`);
      }
      if (data.projectIntroTime) {
        pd['Preferred Time for Project Intro Meeting'] = data.projectIntroTime;
        console.log(`[Index] Project Intro preferred time set to ${data.projectIntroTime} for ${employee.name}`);
      }
      employee.personalDetails = pd;
      saveState(employee.employeeId, snapshotEmployee(employee));
      break;
    }

    case 'greythr_welcome': {
      // Greythr sent a welcome email directly to the engine inbox — this confirms
      // HR has created both the official email and the greythr login.
      // Mark t15 (HR responded with official email) and t16 (greythr login complete) done.
      if (isTaskDone(checklist, 't16')) {
        console.log(`[Index] Skipping duplicate greythr_welcome for ${employee.name} — t16 already done`);
        break;
      }
      markAndLog(employee, 't15');
      markAndLog(employee, 't16');
      activityLog.log(employee, 'greythr_welcome_received', data.notes || '');
      await markOfficialEmailConfirmed(auth, employee, employee.officialEmail || '').catch(() => {});
      if (employee.replyTimers && employee.replyTimers.hr) {
        employee.replyTimers.hr.stop && employee.replyTimers.hr.stop();
        delete employee.replyTimers.hr;
      }
      console.log(`[Index] Greythr welcome email detected — t15 + t16 marked done for ${employee.name}`);
      break;
    }

    case 'official_email_created':
      if (isTaskDone(checklist, 't15')) {
        console.log(`[Index] Skipping duplicate official_email_created for ${employee.name} — t15 already done`);
        break;
      }
      if (data.officialEmail) {
        employee.officialEmail = data.officialEmail;
        markAndLog(employee, 't15');
        markAndLog(employee, 't16'); // auto-complete — no need to wait for joinee reply
        console.log(`[Index] Official email recorded: ${data.officialEmail}`);
        activityLog.log(employee, 'official_email_recorded', data.officialEmail);
        await markOfficialEmailConfirmed(auth, employee, data.officialEmail).catch(() => {});
        if (employee.replyTimers && employee.replyTimers.hr) {
          employee.replyTimers.hr.stop && employee.replyTimers.hr.stop();
          delete employee.replyTimers.hr;
        }
        // Send welcome/access test email to the new official address (informational — no reply needed)
        try {
          await sendOfficialEmailAccessTest(employee);
          console.log(`[Index] Access test email sent to ${data.officialEmail} for ${employee.name}`);
        } catch (err) {
          console.warn(`[Index] Official email access test failed for ${employee.name}: ${err.message}`);
          // Alert HR so they can verify the official email address is correct
          await sendEmail({
            to: hrEmail(employee),
            subject: `Action Required — Could Not Reach Official Email for ${employee.name} (${employee.employeeId})`,
            html: `
              <p>Hi HR,</p>
              <p>The automation engine could not send the welcome/access test email to the official email address recorded for <strong>${esc(employee.name)}</strong> (${esc(employee.employeeId)}).</p>
              <p><strong>Official email recorded:</strong> ${esc(data.officialEmail || '')}</p>
              <p>Please verify that this email address is correct and active, then reply to the original official email creation request with the correct address if needed.</p>
              <p>Error: ${esc(err.message)}</p>
              <p>Regards,<br/>${esc(process.env.COMPANY_NAME || '')} HR Automation</p>
            `,
          }).catch(() => {});
        }
        // If asset allocation email was never sent (contacts missing at t14 time), send it now
        const assetNeeded = !employee.assetRequired || !String(employee.assetRequired).trim().toLowerCase().startsWith('no');
        if (!isTaskDone(employee.checklist, 't17') && !assetNeeded) {
          // Asset explicitly not required — auto-mark and update sheets
          markAndLog(employee, 't17');
          markAndLog(employee, 't18');
          markAndLog(employee, 't19');
          markAndLog(employee, 't20');
          markAndLog(employee, 't21');
          markAndLog(employee, 't22');
          saveState(employee.employeeId, snapshotEmployee(employee));
          markManagerConfirmed(auth, employee, {
            officeLocation: employee.officeLocation || '',
            assetType: 'No asset required',
            supervisorName: '',
          }).catch(err => console.warn(`[Index] Status sheet milestone 5 update failed for ${employee.name}: ${err.message}`));
          markITConfirmed(auth, employee)
            .catch(err => console.warn(`[Index] Status sheet milestone 6 update failed for ${employee.name}: ${err.message}`));
          console.log(`[Index] Asset not required for ${employee.name} — t17–t22 auto-marked, sheets updated`);
        } else if (!isTaskDone(employee.checklist, 't17') && employee.contacts && employee.contacts.managerEmail) {
          await sendAssetAllocationRequest(employee, employee.contacts.managerEmail).catch(err =>
            console.warn(`[Index] Asset allocation request failed for ${employee.name}: ${err.message}`)
          );
          markAndLog(employee, 't17');
          employee.replyTimers = employee.replyTimers || {};
          employee.replyTimers.manager = scheduleReplyDeadline(
            employee, 'Reporting Manager', employee.contacts.managerEmail, null,
            `The system sent the reporting manager an asset allocation request for ${employee.name}. The manager needs to confirm what assets (laptop, accessories, etc.) should be assigned and reply so IT can proceed. No response has been received.`
          );
          saveState(employee.employeeId, snapshotEmployee(employee));
          console.log(`[Index] Asset allocation request sent to manager for ${employee.name} (catch-up after contacts fix)`);
        }
      } else {
        console.warn(`[Index] official_email_created reply for ${employee.name} had no email address extracted — reply was consumed but checklist not advanced.`);
        activityLog.log(employee, 'official_email_parse_failed', 'Gemini could not extract email from reply');
        await sendEmail({
          to: hrEmail(employee),
          subject: `HR Automation — Official Email Reply Unreadable (${employee.name})`,
          html: `<p>Hi HR,</p><p>A reply to the official email creation request for <strong>${employee.name} (${employee.employeeId})</strong> was received but the automation could not extract the email address from it.</p><p>Please reply manually or use the status dashboard to mark task t15/t16 once the official email is confirmed.</p><p>Regards,<br/>${process.env.COMPANY_NAME} HR Automation</p>`,
        }).catch(err => console.warn('[Index] Could not send official-email parse-failure alert:', err.message));
      }
      break;

    case 'official_email_access_confirmed':
      markAndLog(employee, 't16');
      activityLog.log(employee, 'official_email_access_confirmed', employee.officialEmail || '');
      console.log(`[Index] Official email access confirmed by ${employee.name}`);
      await markOfficialEmailConfirmed(auth, employee, employee.officialEmail).catch(() => {});
      await sendEmail({
        to: hrEmail(employee),
        subject: `Official Email Access Confirmed — ${employee.name} (${employee.employeeId})`,
        html: `<p>Hi HR,</p><p><strong>${employee.name}</strong> (${employee.employeeId}) has confirmed access to their official email address <strong>${employee.officialEmail || ''}</strong>. The onboarding checklist has been updated.</p><p>Regards,<br/>${process.env.COMPANY_NAME} HR Automation</p>`,
      }).catch(() => {});
      break;

    case 'official_email_access_failed':
      activityLog.log(employee, 'official_email_access_failed', employee.officialEmail || '');
      console.warn(`[Index] Official email access issue reported by ${employee.name}`);
      await sendEmail({
        to: hrEmail(employee),
        subject: `Action Required — Official Email Issue for ${employee.name} (${employee.employeeId})`,
        html: `
          <p>Hi HR,</p>
          <p><strong>${employee.name}</strong> (${employee.employeeId}) has reported that they are unable to access their official email address <strong>${employee.officialEmail || ''}</strong>.</p>
          <p>Please check the account setup and resolve the issue. Once fixed, ask the employee to reply "Confirmed" to the access test email so the onboarding checklist can be updated.</p>
          <p>Regards,<br/>${process.env.COMPANY_NAME} HR Automation</p>
        `,
      }).catch(() => {});
      break;

    case 'manager_allocation':
      if (data.assetType || data.officeLocation || data.supervisorName) {
        employee.assetDetails = data;
        markAndLog(employee, 't18');
        markAndLog(employee, 't19');
        activityLog.log(employee, 'manager_allocation_confirmed', JSON.stringify(data));
        await markManagerConfirmed(auth, employee, data).catch(() => {});
        if (employee.replyTimers && employee.replyTimers.manager) {
          employee.replyTimers.manager.stop && employee.replyTimers.manager.stop();
          delete employee.replyTimers.manager;
        }
        // Send IT asset request with full allocation details (t20) and start its reply timer
        if (!isTaskDone(employee.checklist, 't20')) {
          markAndLog(employee, 't20');
          saveState(employee.employeeId, snapshotEmployee(employee));
          await sendITAssetRequest(employee, employee.contacts.itEmail, data);
          employee.replyTimers = employee.replyTimers || {};
          employee.replyTimers.it = scheduleReplyDeadline(
            employee, 'IT Team', employee.contacts.itEmail, null,
            `The system sent an IT asset request for ${employee.name} based on the manager's allocation confirmation. IT needs to assign the assets (laptop, accessories, etc.) and reply with "Asset Assigned: Y/N" along with the reason if not assigned. No response has been received.`
          );
          saveState(employee.employeeId, snapshotEmployee(employee));
        }
      } else {
        console.warn(`[Index] manager_allocation reply for ${employee.name} had no allocation data extracted — checklist not advanced.`);
        activityLog.log(employee, 'manager_allocation_parse_failed', 'Gemini could not extract allocation details from reply');
        await sendEmail({
          to: hrEmail(employee),
          subject: `HR Automation — Manager Reply Unreadable (${employee.name})`,
          html: `<p>Hi HR,</p><p>A reply to the asset allocation request for <strong>${employee.name} (${employee.employeeId})</strong> was received but the automation could not extract allocation details from it.</p><p>Please ask the manager to reply again with: Asset Type, Office Location, and Supervisor Name — or manually mark tasks t18/t19/t20 via the status dashboard.</p><p>Regards,<br/>${process.env.COMPANY_NAME} HR Automation</p>`,
        }).catch(err => console.warn('[Index] Could not send manager parse-failure alert:', err.message));
      }
      break;

    case 'it_allocation':
      markAndLog(employee, 't21');
      markAndLog(employee, 't22');
      markAndLog(employee, 't35');
      activityLog.log(employee, 'it_allocation_confirmed');
      await markITConfirmed(auth, employee).catch(() => {});
      if (employee.replyTimers) {
        if (employee.replyTimers.it) {
          employee.replyTimers.it.stop && employee.replyTimers.it.stop();
          delete employee.replyTimers.it;
        }
        if (employee.replyTimers.itDoj) {
          employee.replyTimers.itDoj.stop && employee.replyTimers.itDoj.stop();
          delete employee.replyTimers.itDoj;
        }
      }
      break;

    case 'induction_confirmed':
      markAndLog(employee, 't33');
      markAndLog(employee, 't34');
      activityLog.log(employee, 'induction_confirmed');
      await markHRInductionDone(auth, employee).catch(() => {});
      if (employee.replyTimers && employee.replyTimers.induction) {
        employee.replyTimers.induction.stop && employee.replyTimers.induction.stop();
        delete employee.replyTimers.induction;
      }
      break;

    case 'admin_allocation':
      markAndLog(employee, 't36');
      activityLog.log(employee, 'admin_seat_allocation_confirmed');
      if (employee.replyTimers && employee.replyTimers.admin) {
        employee.replyTimers.admin.stop && employee.replyTimers.admin.stop();
        delete employee.replyTimers.admin;
      }
      break;

    case 'catchup25_complete':
      markAndLog(employee, 't64');
      markAndLog(employee, 't65');
      activityLog.log(employee, '25_day_catchup_complete');
      await mark25DayCatchupDone(auth, employee).catch(() => {});
      console.log(`[Index] 25-day catchup confirmed for ${employee.name}`);
      break;

    case 'catchup_complete':
      // Part 2 of 30-day review — manager confirms "Done" after recruiter already filled sheet (Part 1)
      // t43 (sheet filled) is marked by scheduleRecruiterSheetPoller when sheet is detected filled
      markAndLog(employee, 't44');
      markAndLog(employee, 't45');
      activityLog.log(employee, '30_day_catchup_complete');
      await mark30DayDone(auth, employee).catch(() => {});
      console.log(`[Index] 30-day review confirmed by manager for ${employee.name}`);
      break;

    case 'review_complete': {
      // Part 2 of 60/90-day review — manager confirms "Done" after recruiter already filled sheet (Part 1)
      // t46/t49 (sheet filled) are marked by scheduleRecruiterSheetPoller; here we only mark manager confirm tasks
      const daysSinceDoj = Math.floor(
        (Date.now() - new Date(employee.doj).getTime()) / (1000 * 60 * 60 * 24)
      );
      if (daysSinceDoj < 85) {
        markAndLog(employee, 't48');
        activityLog.log(employee, '60_day_review_complete');
        await mark60DayDone(auth, employee).catch(() => {});
        console.log(`[Index] 60-day review confirmed by manager for ${employee.name}`);
      } else if (daysSinceDoj < 135) {
        markAndLog(employee, 't51');
        activityLog.log(employee, '90_day_review_complete');
        await mark90DayDone(auth, employee).catch(() => {});
        console.log(`[Index] 90-day review confirmed by manager for ${employee.name}`);
      } else {
        console.warn(`[Index] review_complete reply for ${employee.name} arrived at day ${daysSinceDoj} — outside expected 60/90-day windows, ignoring`);
        activityLog.log(employee, 'review_complete_out_of_window', `day ${daysSinceDoj}`);
      }
      break;
    }

    case 'pre_probation_result':
      markAndLog(employee, 't52');
      markAndLog(employee, 't55');
      activityLog.log(employee, 'pre_probation_verified', data.notes || '');
      await markPreprobationDone(auth, employee).catch(() => {});
      console.log(`[Index] Pre-probation result received for ${employee.name}`);
      break;

    case 'bgv_report': {
      const bgvLockKey = `${employee.employeeId}:bgv_report`;
      if (isTaskDone(checklist, 't25')) {
        console.log(`[BGV] Skipping duplicate bgv_report for ${employee.name} — already done`);
        return;
      }
      if (_triggerLocks.has(bgvLockKey)) {
        console.log(`[BGV] Skipping duplicate bgv_report for ${employee.name} — in flight`);
        return;
      }
      _triggerLocks.add(bgvLockKey);
      try {
        await processBGVReport(auth, employee, rawMsg);
      } catch (err) {
        console.error(`[BGV] processBGVReport failed for ${employee.name}: ${err.message}`);
      } finally {
        // Clear lock so a retry with a different email (e.g. actual PDF reply) can proceed
        if (!isTaskDone(employee.checklist, 't25')) _triggerLocks.delete(bgvLockKey);
      }
      // checklist save and state save are handled inside processBGVReport
      return;
    }

    case 'doc_reupload': {
      // Joinee replied to a rejection email with corrected document attached.
      // Download each attachment, upload to correct Drive subfolder, verify.
      const attachments = (rawMsg && rawMsg.attachments) || [];
      if (attachments.length === 0) {
        console.warn(`[DocReupload] No attachments found in reply from ${employee.name} — skipping`);
        break;
      }
      const { google } = require('googleapis');
      const drive = google.drive({ version: 'v3', auth });

      // Determine docType from classified data or subject
      const rawDocLabel = (classified.data && classified.data.docType) || '';
      const DOC_LABEL_TO_SUBFOLDER = {
        'aadhaar': 'Aadhaar', 'aadhar': 'Aadhaar',
        'pan': 'PAN', 'pan card': 'PAN',
        'offer letter': 'Offer_Letter', 'appointment letter': 'Offer_Letter',
        'passport photo': 'Passport_Photo', 'passport size photo': 'Passport_Photo',
        'current address proof': 'Current_Address_Proof',
        'permanent address proof': 'Permanent_Address_Proof',
        '10th': 'Marksheet_10th', '10th marksheet': 'Marksheet_10th',
        '12th': 'Marksheet_12th', '12th marksheet': 'Marksheet_12th',
        'degree': 'Degree_Certificate', 'degree certificate': 'Degree_Certificate',
        'post graduation': 'Postgrad_Certificate', 'postgrad': 'Postgrad_Certificate',
        'relieving': 'Relieving_Letter', 'relieving letter': 'Relieving_Letter',
        'payslip': 'Payslip', 'pay slip': 'Payslip',
        'uan': 'UAN', 'universal account number': 'UAN',
      };
      const subfolder = DOC_LABEL_TO_SUBFOLDER[rawDocLabel.toLowerCase()] || null;

      if (!subfolder) {
        console.warn(`[DocReupload] Could not map docType "${rawDocLabel}" to a subfolder for ${employee.name} — will let Gemini classify from filename/content`);
      }

      console.log(`[DocReupload] Processing ${attachments.length} attachment(s) from ${employee.name} — docType: "${rawDocLabel || 'unknown'}" → subfolder: ${subfolder || 'auto-detect'}`);

      let anyUploaded = false;
      for (const att of attachments) {
        try {
          // Download attachment from Gmail
          let buffer;
          if (att.data) {
            buffer = Buffer.from(att.data, 'base64');
          } else if (att.attachmentId) {
            buffer = await downloadAttachment(auth, rawMsg.id, att.attachmentId);
          } else {
            console.warn(`[DocReupload] No data/attachmentId for ${att.filename} — skipping`);
            continue;
          }

          // If subfolder unknown, use filename keywords to guess; fall through to Aadhaar only as last resort
          let targetSubfolder = subfolder;
          if (!targetSubfolder) {
            const fname = att.filename.toLowerCase();
            if (fname.includes('offer') || fname.includes('appointment')) targetSubfolder = 'Offer_Letter';
            else if (fname.includes('aadhaar') || fname.includes('aadhar')) targetSubfolder = 'Aadhaar';
            else if (fname.includes('pan')) targetSubfolder = 'PAN';
            else if (fname.includes('payslip') || fname.includes('salary')) targetSubfolder = 'Payslip';
            else if (fname.includes('relieving')) targetSubfolder = 'Relieving_Letter';
            else if (fname.includes('degree')) targetSubfolder = 'Degree_Certificate';
            else if (fname.includes('10th') || fname.includes('tenth')) targetSubfolder = 'Marksheet_10th';
            else if (fname.includes('12th') || fname.includes('twelfth')) targetSubfolder = 'Marksheet_12th';
            else targetSubfolder = 'Aadhaar'; // last resort — Gemini will re-classify from content
            console.log(`[DocReupload] Guessed subfolder from filename: ${targetSubfolder} for ${att.filename}`);
          }

          const subfolderRes = await drive.files.list({
            q: `name='${targetSubfolder}' and '${employee.driveFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id)',
          });
          const targetFolderId = subfolderRes.data.files && subfolderRes.data.files[0] && subfolderRes.data.files[0].id;
          if (!targetFolderId) {
            // Subfolder doesn't exist — upload to root Drive folder so Gemini can classify
            console.warn(`[DocReupload] Subfolder '${targetSubfolder}' not found for ${employee.name} — uploading to root folder`);
            const rootUploadRes = await drive.files.create({
              requestBody: { name: att.filename, parents: [employee.driveFolderId] },
              media: { mimeType: att.mimeType, body: require('stream').Readable.from(buffer) },
              fields: 'id, name, mimeType',
            });
            console.log(`[DocReupload] Uploaded ${rootUploadRes.data.name} to root folder for ${employee.name} (subfolder missing)`);
            await handleNewFile(auth, employee, rootUploadRes.data, null).catch(err =>
              console.error(`[DocReupload] handleNewFile error for ${rootUploadRes.data.name}: ${err.message}`)
            );
            anyUploaded = true;
            continue;
          }

          const { Readable } = require('stream');
          const stream = Readable.from(buffer);
          const uploadRes = await drive.files.create({
            requestBody: { name: att.filename, parents: [targetFolderId] },
            media: { mimeType: att.mimeType, body: stream },
            fields: 'id, name, mimeType',
          });
          const uploadedFile = uploadRes.data;
          console.log(`[DocReupload] Uploaded ${uploadedFile.name} to ${targetSubfolder} for ${employee.name} — running verification`);
          anyUploaded = true;

          // Run verification — same path as any Drive upload
          await handleNewFile(auth, employee, uploadedFile, targetSubfolder).catch(err =>
            console.error(`[DocReupload] handleNewFile error for ${uploadedFile.name}: ${err.message}`)
          );
        } catch (err) {
          console.error(`[DocReupload] Error processing attachment ${att.filename}: ${err.message}`);
        }
      }
      if (!anyUploaded) {
        console.warn(`[DocReupload] No attachments were uploaded for ${employee.name} — reply may have been empty or all attachments failed`);
      }
      saveState(employee.employeeId, snapshotEmployee(employee));
      break;
    }

    case 'doc_manually_approved': {
      // Recruiter replied "Confirmed" to a document rejection email after reviewing
      // the document the joinee sent directly. Map the label back to internal docType key.
      const DOC_LABEL_MAP = {
        'aadhaar':                    'aadhaar',
        'aadhar':                     'aadhaar',
        'pan':                        'pan',
        'pan card':                   'pan',
        'offer letter':               'offerLetter',
        'appointment letter':         'offerLetter',
        'payslip':                    'payslip',
        'pay slip':                   'payslip',
        'relieving letter':           'relievingLetter',
        'experience letter':          'relievingLetter',
        '10th marksheet':             'marksheet10th',
        '10th':                       'marksheet10th',
        '12th marksheet':             'marksheet12th',
        '12th':                       'marksheet12th',
        'diploma':                    'marksheet12th',
        'degree certificate':         'degreeCertificate',
        'graduation':                 'degreeCertificate',
        'post graduation certificate':'postgradCertificate',
        'postgrad':                   'postgradCertificate',
        'pg certificate':             'postgradCertificate',
        'passport size photo':        'passportPhoto',
        'passport photo':             'passportPhoto',
        'current address proof':      'currentAddressProof',
        'permanent address proof':    'permanentAddressProof',
      };
      const rawDocType = (data.docType || '').toLowerCase().trim();
      const internalDocType = DOC_LABEL_MAP[rawDocType] || rawDocType;
      if (!internalDocType) {
        console.warn(`[Index] doc_manually_approved — could not determine docType from reply for ${employee.name}`);
        break;
      }
      employee.verificationResults = employee.verificationResults || {};
      employee.verificationResults[internalDocType] = { valid: true, manual: true, summary: 'Manually approved by recruiter' };
      const taskId = DOC_TASK_MAP[internalDocType];
      if (taskId && !isTaskDone(checklist, taskId)) markAndLog(employee, taskId);
      activityLog.log(employee, 'doc_manually_approved', `${internalDocType} approved by recruiter`);
      console.log(`[Index] Document manually approved by recruiter: ${internalDocType} for ${employee.name}`);
      // Update the status sheet to reflect the approval
      await markDocumentsVerifiedOk(auth, employee).catch(() => {});
      break;
    }

    default:
      console.log(`[Index] Unhandled reply type: ${replyType}`);
      return;
  }

  await uploadChecklist(auth, employee.driveFolderId, checklist);
  saveState(employee.employeeId, snapshotEmployee(employee));
}

// ─── Employee registry (shared with webhookServer) ────────────────────────────
const employeeRegistry = {};

// ─── Bootstrap an employee when they are first added ──────────────────────────
async function onboardEmployee(auth, employee) {
  // Register in shared registry so webhookServer can look them up
  employeeRegistry[employee.employeeId] = employee;
  // Store auth and markTask helper on employee so cron callbacks can update checklist/sheet
  employee._auth = auth;
  employee._markTask = (taskId) => markAndLog(employee, taskId);
  employee._saveState = () => saveState(employee.employeeId, snapshotEmployee(employee));

  // Restore reply-deadline timers that were active before restart.
  // Each entry is { expiresAt, recipientEmail } — use the stored recipient so
  // escalations go to the right person (manager, IT, recruiter) not just HR.
  if (employee.replyTimerExpiry) {
    // Timer key → checklist task ID that marks the awaited reply as received.
    // If the task is already done, the reply was received and the timer is moot — skip it.
    const TIMER_DONE_TASK = { hr: 't15', manager: 't19', it: 't20', itDoj: 't21', induction: 't33', '30dayReview': 't44', '60dayNoReply': 't48', '90dayNoReply': 't51', probationNoReply: 't52' };
    const now = Date.now();
    for (const [key, entry] of Object.entries(employee.replyTimerExpiry)) {
      const doneTask = TIMER_DONE_TASK[key];
      if (doneTask && isTaskDone(employee.checklist, doneTask)) {
        console.log(`[Index] Skipping reply-deadline timer "${key}" for ${employee.name} — task ${doneTask} already done`);
        continue;
      }
      // Support both old format (plain ISO string) and new format ({ expiresAt, recipientEmail })
      const isoDate = typeof entry === 'string' ? entry : entry.expiresAt;
      const recipientEmail = (typeof entry === 'object' && entry.recipientEmail)
        ? entry.recipientEmail
        : process.env.HR_EMAIL;
      const expiresAt = new Date(isoDate);
      if (expiresAt > now) {
        employee.replyTimers = employee.replyTimers || {};
        employee.replyTimers[key] = scheduleReplyDeadline(
          employee, key, recipientEmail,
          (expiresAt - now) / (60 * 60 * 1000)
        );
        console.log(`[Index] Restored reply-deadline timer "${key}" for ${employee.name} → ${recipientEmail} (fires ${expiresAt.toISOString()})`);
      } else {
        console.log(`[Index] Reply-deadline timer "${key}" for ${employee.name} already expired — skipping`);
      }
    }
  }

  // If milestones were scheduled in a previous run, re-register them after restart
  if (employee.milestonesScheduled && employee.contacts) {
    const completedTasks = [];
    for (const phase of Object.values(employee.checklist)) {
      if (phase.tasks) {
        for (const [id, task] of Object.entries(phase.tasks)) {
          if (task.done) completedTasks.push(id);
        }
      }
    }
    const markTaskForEmployee = (taskId) => markAndLog(employee, taskId);
    restoreMilestonesAfterRestart(employee, employee.contacts, completedTasks, markTaskForEmployee);
  }

  // Always scaffold folder structure on every startup.
  // scaffoldEmployeeFolder creates the "Name_EMPID" subfolder inside the root onboarding
  // folder and returns a folderMap with the employee's own folder ID at folderMap.root.
  // We update employee.driveFolderId to point to the employee's own folder so all
  // subsequent file uploads (checklist, instructions) land inside it, not in the root.
  try {
    const folderMap = await scaffoldEmployeeFolder(auth, employee.driveFolderId, employee.name, employee.employeeId, employee.isFresher);
    employee.rootFolderId = employee.driveFolderId; // keep root (Alethea Onboarding/) for status sheet
    employee.driveFolderId = folderMap.root; // now points to Test User_EMP002/, not Alethea Onboarding/
  } catch (err) {
    console.error(`[Index] ✖ Could not scaffold Drive folder for ${employee.name} — check driveFolderId "${employee.driveFolderId}" is correct and accessible. (${err.message})`);
    activityLog.log(employee, 'scaffold_failed', `driveFolderId: ${employee.driveFolderId} — ${err.message}`);
    return; // cannot continue without a working Drive folder
  }

  // Lock the employee folder to recruiter-only access.
  // The joinee uploads via Google Form (not directly to Drive), so they need no folder access.
  // All other inherited permissions from the root onboarding folder are removed.
  {
    const recruiterEmail = (employee.contacts && employee.contacts.recruiterEmail) || null;
    lockEmployeeFolder(auth, employee.driveFolderId, recruiterEmail, employee.name).catch(err =>
      console.warn(`[Index] lockEmployeeFolder failed for ${employee.name}: ${err.message}`)
    );
  }

  const alreadyStarted = isTaskDone(employee.checklist, 't4');

  // Always ensure the status sheet exists — even for employees being resumed after restart.
  // getOrCreateStatusSheet is idempotent: it searches Drive before creating a new sheet.
  if (!employee.statusSheetId) {
    await getOrCreateStatusSheet(auth, employee).catch(err =>
      console.error(`[Status] Could not create status sheet for ${employee.name}: ${err.message}`)
    );
  }

  if (!alreadyStarted) {
    console.log(`\n[Index] Starting onboarding for ${employee.name} (${employee.employeeId})`);
    activityLog.log(employee, 'onboarding_started', `DOJ: ${employee.doj}`);

    // Mark folder tasks done on first run
    markAndLog(employee, 't6');
    markAndLog(employee, 't7');
    markAndLog(employee, 't8');

    // Mark preonboarding initiated on the status sheet
    await markPreonboardingInitiated(auth, employee).catch(() => {});

    // Step 3: Send pre-onboarding form — 10 days before DOJ, or immediately if DOJ is within 10 days
    if (!employee.personalEmail) {
      console.error(`[Index] Cannot send pre-onboarding form to ${employee.name} — personalEmail is empty. Add it to employees.json and restart.`);
      activityLog.log(employee, 'pre_onboarding_skipped', 'personalEmail missing');
    } else {
      const dojDate = new Date(employee.doj);
      const daysUntilDoj = Math.ceil((dojDate - Date.now()) / (1000 * 60 * 60 * 24));
      const sendDelayMs = daysUntilDoj > 10 ? (daysUntilDoj - 10) * 24 * 60 * 60 * 1000 : 0;

      if (sendDelayMs > 0) {
        const sendDate = new Date(Date.now() + sendDelayMs);
        console.log(`[Index] Pre-onboarding form for ${employee.name} scheduled for ${sendDate.toDateString()} (10 days before DOJ)`);
        markAndLog(employee, 't4'); // mark as scheduled
        activityLog.log(employee, 'pre_onboarding_email_scheduled', `Sends ${sendDate.toDateString()}`);
        setTimeout(async () => {
          await sendPreOnboardingForm(employee).catch(err =>
            console.warn(`[Index] Pre-onboarding form send failed for ${employee.name}: ${err.message}`)
          );
          activityLog.log(employee, 'pre_onboarding_email_sent', employee.personalEmail);
        }, sendDelayMs);
      } else {
        // DOJ is within 10 days — send immediately
        await sendPreOnboardingForm(employee);
        markAndLog(employee, 't4');
        activityLog.log(employee, 'pre_onboarding_email_sent', employee.personalEmail);
      }
    }

    // Step 5: Save checklist to Drive and locally
    await uploadChecklist(auth, employee.driveFolderId, employee.checklist);
    saveState(employee.employeeId, snapshotEmployee(employee));

    // Step 6: Schedule pre-onboarding reminders to joinee at 24h/48h/72h + recruiter escalation at 72h
    employee.noResponseTimers['preOnboarding'] = schedulePreOnboardingReminders(
      employee,
      (employee.contacts && employee.contacts.recruiterEmail) || process.env.HR_EMAIL
    );

    // Step 7: Schedule optional-doc N/A timers — if payslip/relieving letter not
    // uploaded within grace period, auto-mark as N/A so the flow isn't blocked.
    const graceDays = config.optionalDocGraceDays || 3;
    const graceMs = graceDays * 24 * 60 * 60 * 1000;
    const optionalDocTaskMap = { payslip: 't57', postgradCertificate: 't62' };
    const optionalDocLabels = { payslip: 'Payslip', postgradCertificate: 'Post Graduation Certificate' };
    for (const [docType, taskId] of Object.entries(optionalDocTaskMap)) {
      setTimeout(async () => {
        if (!isTaskDone(employee.checklist, taskId)) {
          console.log(`[Index] Optional doc "${docType}" not uploaded within ${graceDays} days for ${employee.name} — marking N/A`);
          markAndLog(employee, taskId);
          await uploadChecklist(auth, employee.driveFolderId, employee.checklist).catch(() => {});
          saveState(employee.employeeId, snapshotEmployee(employee));
          activityLog.log(employee, 'optional_doc_na', `${optionalDocLabels[docType]} not uploaded — marked N/A`);
        }
      }, graceMs);
    }

    // Step 7b: UAN is mandatory — send a reminder email if not uploaded within 3 days of DOJ
    setTimeout(async () => {
      if (!isTaskDone(employee.checklist, 't69')) {
        console.log(`[Index] UAN not uploaded within 3 days for ${employee.name} — sending reminder`);
        const { sendEmail } = await import('./emailSender.js');
        await sendEmail({
          to: employee.contacts.personalEmail,
          cc: process.env.HR_EMAIL,
          subject: `Action Required: UAN not yet uploaded — ${employee.name}`,
          html: `<p>Hi ${employee.name.split(' ')[0]},</p>
<p>We noticed that your <strong>UAN (Universal Account Number)</strong> has not been uploaded yet.</p>
<p>Please generate your UAN via the <strong>UMANG app</strong> and upload a screenshot or PDF to your Drive folder under the <strong>UAN</strong> subfolder.</p>
<p>This is required within 3 days of your Date of Joining. Please upload it at the earliest.</p>
<p>Regards,<br/>${process.env.COMPANY_NAME} HR</p>`,
        }).catch(err => console.warn(`[Index] UAN reminder email failed: ${err.message}`));
        activityLog.log(employee, 'uan_reminder_sent', 'UAN not uploaded — reminder sent to employee');
      }
    }, graceMs);

    console.log(`[Index] Onboarding initiated for ${employee.name}\n`);
  } else {
    console.log(`[Index] Resuming onboarding for ${employee.name} (${employee.employeeId}) — already started, skipping welcome email`);

  }

  // On DOJ — fire HR induction + project intro if not already triggered by offer letter
  {
    const dojDate = new Date(employee.doj);
    const todayStr = new Date().toISOString().split('T')[0];
    const dojStr   = employee.doj ? employee.doj.split('T')[0] : '';
    const needsInduction = !isTaskDone(employee.checklist, 't27') || !isTaskDone(employee.checklist, 't29');
    if (needsInduction) {
      if (dojStr === todayStr) {
        await fireInductionAndProjectIntro(auth, employee);
        console.log(`[Index] HR induction + project intro fired on DOJ for ${employee.name}`);
      } else if (dojDate > new Date()) {
        const msUntilDOJ = dojDate.getTime() - Date.now();
        setTimeout(async () => {
          await fireInductionAndProjectIntro(auth, employee);
          console.log(`[Index] HR induction + project intro fired on DOJ for ${employee.name}`);
        }, msUntilDOJ);
        console.log(`[Index] HR induction + project intro scheduled for DOJ (${dojStr}) for ${employee.name}`);
      }
    }
  }

  // 2 days before DOJ — fire official email creation request.
  // If that date falls on a weekend, send on the preceding Friday instead.
  // Examples: Monday DOJ → Friday; Tuesday DOJ → Friday; Wednesday DOJ → Monday.
  {
    const todayStr = new Date().toISOString().split('T')[0];

    const fireOfficialEmailRequest = async () => {
      if (!isTaskDone(employee.checklist, 't14')) {
        markAndLog(employee, 't14');
        saveState(employee.employeeId, snapshotEmployee(employee));
        await sendOfficialEmailCreationRequest(employee).catch(err =>
          console.warn(`[Index] Official email creation request failed for ${employee.name}: ${err.message}`)
        );
        employee.replyTimers = employee.replyTimers || {};
        employee.replyTimers.hr = scheduleReplyDeadline(
          employee, 'HR Team', hrEmail(employee), null,
          `The system sent HR an email asking them to create the official ${process.env.COMPANY_NAME || ''} email ID and Greythr login for ${employee.name} (DOJ: ${employee.doj}). HR needs to create both accounts and reply with the official email ID and Greythr confirmation. No response has been received.`
        );
        saveState(employee.employeeId, snapshotEmployee(employee));
        console.log(`[Index] Official email creation request sent for ${employee.name}`);
      }
    };

    const preDOJDate = new Date(employee.doj);
    preDOJDate.setDate(preDOJDate.getDate() - 2);
    if (preDOJDate.getDay() === 6) preDOJDate.setDate(preDOJDate.getDate() - 1); // Saturday → Friday
    if (preDOJDate.getDay() === 0) preDOJDate.setDate(preDOJDate.getDate() - 2); // Sunday → Friday
    const preDOJStr = preDOJDate.toISOString().split('T')[0];

    if (preDOJStr <= todayStr) {
      await fireOfficialEmailRequest();
    } else {
      const msUntilPreDOJ = preDOJDate.getTime() - Date.now();
      setTimeout(fireOfficialEmailRequest, msUntilPreDOJ);
      console.log(`[Index] Official email creation request scheduled for ${preDOJStr} (2 days before DOJ) for ${employee.name}`);
    }
  }

  // On DOJ — fire asset allocation and BGV initiate independently of document verification.
  {
    const dojDate  = new Date(employee.doj);
    const todayStr = new Date().toISOString().split('T')[0];
    const dojStr   = employee.doj ? employee.doj.split('T')[0] : '';

    const fireDOJEmails = async () => {
      // Asset allocation request to manager (t17) + IT request (t20)
      // If assetRequired is "No" in recruiter form — skip both emails, auto-mark all tasks done, update status sheets
      const assetNeeded = !employee.assetRequired || !String(employee.assetRequired).trim().toLowerCase().startsWith('no');
      if (!assetNeeded) {
        if (!isTaskDone(employee.checklist, 't17')) {
          markAndLog(employee, 't17');
          markAndLog(employee, 't18');
          markAndLog(employee, 't19');
          markAndLog(employee, 't20');
          markAndLog(employee, 't21');
          markAndLog(employee, 't22');
          saveState(employee.employeeId, snapshotEmployee(employee));
          console.log(`[Index] Asset not required for ${employee.name} — t17–t22 auto-marked, no emails sent`);
          // Update status sheet milestones 5 (manager) and 6 (IT) to Done
          markManagerConfirmed(auth, employee, {
            officeLocation: employee.officeLocation || '',
            assetType: 'No asset required',
            supervisorName: '',
          }).catch(err => console.warn(`[Index] Status sheet milestone 5 update failed for ${employee.name}: ${err.message}`));
          markITConfirmed(auth, employee)
            .catch(err => console.warn(`[Index] Status sheet milestone 6 update failed for ${employee.name}: ${err.message}`));
        }
      } else if (!isTaskDone(employee.checklist, 't17') && employee.contacts && employee.contacts.managerEmail) {
        markAndLog(employee, 't17');
        saveState(employee.employeeId, snapshotEmployee(employee));
        await sendAssetAllocationRequest(employee, employee.contacts.managerEmail).catch(err =>
          console.warn(`[Index] Asset allocation request failed for ${employee.name}: ${err.message}`)
        );
        employee.replyTimers = employee.replyTimers || {};
        employee.replyTimers.manager = scheduleReplyDeadline(
          employee, 'Reporting Manager', employee.contacts.managerEmail, null,
          `The system sent the reporting manager an asset allocation request for ${employee.name} (DOJ: ${employee.doj}). The manager needs to confirm what assets (laptop, accessories, etc.) should be assigned to this employee and reply so IT can proceed. No response has been received.`
        );
        saveState(employee.employeeId, snapshotEmployee(employee));
        console.log(`[Index] Asset allocation request sent on DOJ for ${employee.name}`);
      }

      // BGV initiate email to recruiter (t23)
      if (!isTaskDone(employee.checklist, 't23') && employee.contacts && employee.contacts.recruiterEmail) {
        scheduleBGVInitiate(employee, employee.contacts.recruiterEmail, (taskId) => markAndLog(employee, taskId));
        console.log(`[Index] BGV initiate scheduled on DOJ for ${employee.name}`);
      }

      // BGV upload request fires 7 working days after DOJ (t24)
      if (!isTaskDone(employee.checklist, 't24') && employee.contacts && employee.contacts.recruiterEmail) {
        scheduleBGVRequest(employee, employee.contacts.recruiterEmail, (taskId) => markAndLog(employee, taskId));
        console.log(`[Index] BGV upload request scheduled for 7 working days after DOJ for ${employee.name}`);
      }
    };

    if (dojStr <= todayStr) {
      await fireDOJEmails();
    } else {
      const msUntilDOJ = dojDate.getTime() - Date.now();
      setTimeout(fireDOJEmails, msUntilDOJ);
      console.log(`[Index] DOJ emails (asset allocation, BGV initiate) scheduled for ${dojStr} for ${employee.name}`);
    }
  }

  // Always start watching the root Drive folder (push or poll)
  await watchFolder(auth, employee.driveFolderId, employee.employeeId,
    (file) => handleNewFile(auth, employee, file)
  );

  // Poll each document subfolder — push channels are only registered for the root folder
  // to avoid hitting Drive's per-user push channel quota.
  const docSubfolders = config.driveSubfolders.filter(sf => !['BGV', 'Reports'].includes(sf));
  const drive = require('googleapis').google.drive({ version: 'v3', auth });
  for (const subfolderName of docSubfolders) {
    try {
      const res = await drive.files.list({
        q: `name='${subfolderName}' and '${employee.driveFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
      });
      if (res.data.files && res.data.files.length > 0) {
        const subFolderId = res.data.files[0].id;
        watchFolderPolling(auth, subFolderId, (file) => handleNewFile(auth, employee, file, subfolderName));
        console.log(`[Index] Polling subfolder "${subfolderName}" for ${employee.name}`);
      }
    } catch (err) {
      console.warn(`[Index] Could not poll subfolder "${subfolderName}" for ${employee.name}: ${err.message}`);
    }
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${process.env.COMPANY_NAME} HR Automation Engine`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ─── Critical env var check — fail fast before any API calls ────────────────
  const REQUIRED_VARS = [
    ['GMAIL_USER',         'Gmail address used to send all automated emails'],
    ['GMAIL_APP_PASSWORD', 'Gmail App Password for nodemailer (Settings → Security → App passwords)'],
    ['COMPANY_NAME',       'Company name shown in every email subject and body'],
    ['HR_EMAIL',           'HR team email — receives escalations and reports'],
  ];
  const missing = REQUIRED_VARS.filter(([k]) => !process.env[k]);
  if (missing.length > 0) {
    console.error('\n[Config] FATAL — Missing required environment variables:\n');
    for (const [k, desc] of missing) {
      console.error(`  ✖  ${k.padEnd(22)} ${desc}`);
    }
    console.error('\n[Config] Set these in your .env file and restart.\n');
    process.exit(1);
  }

  // GEMINI_API_KEY is required for document verification and reply classification.
  // Warn (not fatal) so the engine can still run without it during initial testing.
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[Config] WARNING: GEMINI_API_KEY is not set.');
    console.warn('[Config]   Document verification and Gmail reply classification are DISABLED.');
    console.warn('[Config]   All documents will be marked as unverified until the key is added.\n');
  }

  // ─── Optional config warnings ────────────────────────────────────────────
  const feedbackFormLink = process.env.EMPLOYEE_FEEDBACK_FORM_LINK || '';
  if (!feedbackFormLink || feedbackFormLink.startsWith('#') || feedbackFormLink.includes('YOUR_FORM_ID')) {
    console.warn('[Config] WARNING: EMPLOYEE_FEEDBACK_FORM_LINK is not set or is a placeholder.');
    console.warn('[Config]   Employees on day 25 will receive an email with a broken feedback form link.');
    console.warn('[Config]   Set a real Google Form URL in .env to fix this.\n');
  }

  const webhookUrl = process.env.WEBHOOK_BASE_URL || '';
  if (!webhookUrl || webhookUrl.includes('your-ngrok-url') || webhookUrl.includes('localhost')) {
    console.warn('[Config] WARNING: WEBHOOK_BASE_URL is not set to a public URL.');
    console.warn('[Config]   Drive push notifications will not work — falling back to polling.\n');
  }

  if (!process.env.PREONBOARDING_FORM_LINK &&
      !process.env.PREONBOARDING_FORM_FRESHER_LINK &&
      !process.env.PREONBOARDING_FORM_EXPERIENCED_LINK) {
    console.warn('[Config] WARNING: PREONBOARDING_FORM_LINK is not set.');
    console.warn('[Config]   Welcome email will show a warning instead of a form link.\n');
  }

  // ─── Startup security checks ─────────────────────────────────────────────────
  (function runSecurityChecks() {
    const warnings = [];

    // Encryption key strength
    const encKey = process.env.MASTER_ENCRYPTION_KEY;
    if (!encKey) {
      warnings.push('MASTER_ENCRYPTION_KEY is not set — state files are stored unencrypted.');
    } else if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
      warnings.push('MASTER_ENCRYPTION_KEY must be a 64-character hex string (256-bit key).');
    }

    // HMAC audit key
    if (!process.env.AUDIT_HMAC_KEY) {
      warnings.push('AUDIT_HMAC_KEY is not set — audit log entries will not be HMAC-signed.');
    } else if (process.env.AUDIT_HMAC_KEY.length < 32) {
      warnings.push('AUDIT_HMAC_KEY is too short — use at least 32 characters for adequate HMAC security.');
    }

    // Pub/Sub subscription name for Gmail push verification
    if (!process.env.PUBSUB_SUBSCRIPTION_NAME) {
      warnings.push('PUBSUB_SUBSCRIPTION_NAME is not set — /gmail-push subscription verification is disabled.');
    }

    // HTTPS check for webhook base URL (production safeguard)
    const wb = process.env.WEBHOOK_BASE_URL || '';
    if (wb && !wb.startsWith('https://') && !wb.includes('localhost') && !wb.includes('127.0.0.1')) {
      warnings.push(`WEBHOOK_BASE_URL "${wb}" does not use HTTPS — webhooks should be served over TLS in production.`);
    }

    // .env file permissions — warn on Windows if env vars look like they came from a world-readable file
    // (Can't check file mode on Windows easily; log a reminder instead)
    if (process.platform !== 'win32') {
      try {
        const envPath = path.join(__dirname, '..', '.env');
        if (fs.existsSync(envPath)) {
          const mode = fs.statSync(envPath).mode & 0o777;
          if (mode & 0o044) { // readable by group or others
            warnings.push(`.env file permissions are too open (${mode.toString(8)}) — run: chmod 600 .env`);
          }
        }
      } catch { /* ignore if stat fails */ }
    }

    if (warnings.length > 0) {
      console.warn('\n[Security] Startup security warnings:');
      for (const w of warnings) console.warn(`  ⚠  ${w}`);
      console.warn('');
    }
  })();

  const auth = getAuthClient();
  saveState._auth = auth; // make auth available for dashboard refresh

  // Start webhook server (must come before onboarding so registry is available)
  webhookServer.init({
    auth,
    employeeRegistry,
    cancelAllJobs,
    saveState: (employeeId, emp) => saveState(employeeId, snapshotEmployee(emp)),
    handleNewFile: (a, emp, file) => handleNewFile(a, emp, file),
    handleReply: (classified, rawMsg) => handleReply(auth, classified, rawMsg),
    onNewEmployee: async (data) => {
      const dojDate = new Date(data.doj);
      if (!data.doj || isNaN(dojDate.getTime())) {
        console.error(`[Index] onNewEmployee rejected — invalid DOJ "${data.doj}" for ${data.name}. Use YYYY-MM-DD format.`);
        return;
      }
      const saved = loadState(data.employeeId);
      const employee = {
        ...data,
        checklist: (() => { const cl = saved ? saved.checklist : buildDefaultChecklist(); migrateChecklist(cl); return cl; })(),
        milestonesScheduled: saved ? (saved.milestonesScheduled || false) : false,
        statusSheetId: saved ? (saved.statusSheetId || null) : null,
        projectIntroSheetId: saved ? (saved.projectIntroSheetId || null) : null,
        employeeInfoSheetId: saved ? (saved.employeeInfoSheetId || null) : null,
        verificationResults: saved ? (saved.verificationResults || {}) : {},
        extractedData: saved ? (saved.extractedData || {}) : {},
        replyTimerExpiry: saved ? (saved.replyTimerExpiry || {}) : {},
        noResponseTimers: {},
        replyTimers: {},
        processedFileIds: new Set(saved && saved.processedFileIds ? saved.processedFileIds : []),
      };
      persistEmployeeToFile(data);
      await onboardEmployee(auth, employee);
    },
  });
  webhookServer.start();

  // Register Gmail watch if Pub/Sub topic is configured
  if (process.env.GMAIL_PUBSUB_TOPIC) {
    try {
      await registerGmailWatch(auth);
    } catch (err) {
      console.warn('[Index] Gmail watch registration failed:', err.message);
      console.warn('[Index] Reply-parsing disabled — check GMAIL_PUBSUB_TOPIC in .env');
    }
  } else {
    console.warn('[Index] GMAIL_PUBSUB_TOPIC not set — Gmail reply parsing disabled');
  }

  const employees = loadEmployees();

  if (employees.length === 0) {
    console.warn('[Index] No employees loaded. POST to /employee or set EMPLOYEE_* env vars.');
  } else {
    console.log(`[Index] Loaded ${employees.length} employee(s)\n`);
    for (const employee of employees) {
      // Validate DOJ before doing anything — an invalid date breaks all milestone math
      const dojDate = new Date(employee.doj);
      if (!employee.doj || isNaN(dojDate.getTime())) {
        console.error(`[Index] Skipping ${employee.name} (${employee.employeeId}) — invalid or missing DOJ: "${employee.doj}". Fix employees.json and restart.`);
        continue;
      }

      const saved = loadState(employee.employeeId);
      if (!employee.checklist) employee.checklist = saved ? saved.checklist : buildDefaultChecklist();
      migrateChecklist(employee.checklist);
      if (!employee.statusSheetId && saved && saved.statusSheetId) employee.statusSheetId = saved.statusSheetId;
      if (!employee.projectIntroSheetId && saved && saved.projectIntroSheetId) employee.projectIntroSheetId = saved.projectIntroSheetId;
      if (!employee.employeeInfoSheetId && saved && saved.employeeInfoSheetId) employee.employeeInfoSheetId = saved.employeeInfoSheetId;
      if (saved && saved.milestonesScheduled && !employee.milestonesScheduled) employee.milestonesScheduled = true;
      if (saved && saved.verificationResults) employee.verificationResults = saved.verificationResults;
      if (saved && saved.extractedData) employee.extractedData = saved.extractedData;
      if (saved && saved.replyTimerExpiry) employee.replyTimerExpiry = saved.replyTimerExpiry;
      if (!employee.noResponseTimers) employee.noResponseTimers = {};
      if (!employee.replyTimers) employee.replyTimers = {};
      if (!employee.verificationResults) employee.verificationResults = {};
      if (!employee.extractedData) employee.extractedData = {};
      employee.processedFileIds = new Set(saved && saved.processedFileIds ? saved.processedFileIds : []);
      // Fall back to .env contacts if employees.json entry has no contacts field
      if (!employee.contacts || !employee.contacts.managerEmail) {
        employee.contacts = {
          recruiterEmail: process.env.RECRUITER_EMAIL || process.env.HR_EMAIL,
          managerEmail:   process.env.MANAGER_EMAIL   || process.env.HR_EMAIL,
          itEmail:        process.env.IT_EMAIL        || process.env.HR_EMAIL,
        };
      }
      await onboardEmployee(auth, employee);
    }
  }

  // Build master dashboard with all loaded employees
  if (Object.keys(employeeRegistry).length > 0) {
    updateMasterDashboard(auth, Object.values(employeeRegistry))
      .then(sheetId => {
        if (sheetId) console.log(`[Dashboard] Master dashboard ready: https://docs.google.com/spreadsheets/d/${sheetId}`);
      })
      .catch(err => console.warn('[Dashboard] Initial build failed:', err.message));
  }

  // Start daily health-check cron
  startDailyHealthCheck();
  startDataRetentionCron();

  process.on('SIGINT', () => {
    console.log('\n[Index] Shutting down gracefully...');
    // Save state for all employees
    for (const employee of Object.values(employeeRegistry)) {
      try {
        saveState(employee.employeeId, snapshotEmployee(employee));
        console.log(`[Index] State saved for ${employee.name}`);
      } catch (err) {
        console.error(`[Index] Failed to save state for ${employee.name}:`, err.message);
      }
    }
    console.log('[Index] All states saved. Goodbye.');
    process.exit(0);
  });

  console.log('[Index] Engine running. Press Ctrl+C to stop.\n');
}

main().catch(err => {
  const isAuthError =
    err.message && (
      err.message.includes('invalid_grant') ||
      err.message.includes('Token has been expired') ||
      err.message.includes('token.json not found') ||
      (err.code === 401)
    );
  if (isAuthError) {
    console.error('\n[Auth] ✖ OAuth token is expired or invalid.');
    console.error('[Auth]   Delete token.json and re-run:  npm run auth\n');
  } else {
    console.error('[Index] Fatal error:', err.message);
  }
  process.exit(1);
});
