/**
 * One-shot script: fire all pending milestones for a given employee immediately.
 * Usage: node src/fireMilestones.js EMP007
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');

const employeeId = process.argv[2];
if (!employeeId) { console.error('Usage: node src/fireMilestones.js <employeeId>'); process.exit(1); }

const { google } = require('googleapis');
const { decrypt } = require('./encryption');
const {
  sendPhaseCompletionSummary,
  send25DayCatchupEmail,
  send30DayTechnicalReview,
  sendPeriodicReviewReminder,
  sendPreProbationReminder,
  sendReviewSummaryRequest,
  sendAdminSeatAllocationRequest,
  sendHRInductionConfirmation,
  sendOnboardingCompletionReport,
  sendJoineeOnboardingComplete,
  sendJoineeReviewNotification,
} = require('./emailSender');
const {
  mark25DayCatchupDone,
  mark30DayDone,
  mark60DayDone,
  mark90DayDone,
  markPreprobationDone,
  markITConfirmed,
  markHRInductionScheduled,
  createEmployeeInfoSheet,
  getOrCreateCatchupSheet,
} = require('./statusTracker');
const { create30DayCatchupEvent, createReviewEvent } = require('./calendarService');
const { uploadChecklist } = require('./driveWatcher');

// ── Load & decrypt state ─────────────────────────────────────────────────────
const STATE_DIR  = path.join(__dirname, '..');
const stateFile  = path.join(STATE_DIR, `state-${employeeId}.json`);
if (!fs.existsSync(stateFile)) { console.error(`No state file for ${employeeId}`); process.exit(1); }

const raw  = fs.readFileSync(stateFile, 'utf8');
const data = JSON.parse(raw);
let state;
if (data.ciphertext) {
  state = JSON.parse(decrypt(raw));
} else {
  state = data;
}

// ── Load employee record from employees.json ──────────────────────────────────
const empList = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'employees.json'), 'utf8'));
const empBase  = empList.find(e => e.employeeId === employeeId);
if (!empBase) { console.error(`${employeeId} not found in employees.json`); process.exit(1); }

// Merge base + state into a live employee object
const employee = {
  ...empBase,
  ...state,
  employeeId,
  checklist: state.checklist,
};

const contacts = employee.contacts || {
  recruiterEmail: process.env.RECRUITER_EMAIL || process.env.HR_EMAIL,
  managerEmail:   process.env.MANAGER_EMAIL   || process.env.HR_EMAIL,
  itEmail:        process.env.IT_EMAIL        || process.env.HR_EMAIL,
};

function isTaskDone(taskId) {
  for (const phase of Object.values(employee.checklist || {})) {
    if (phase.tasks && phase.tasks[taskId]) return phase.tasks[taskId].done;
  }
  return false;
}

function markDone(taskId) {
  for (const phase of Object.values(employee.checklist || {})) {
    if (phase.tasks && phase.tasks[taskId] !== undefined) {
      phase.tasks[taskId].done = true;
      phase.tasks[taskId].doneAt = new Date().toISOString();
      console.log(`  ✓ ${taskId} marked done`);
      return;
    }
  }
  console.warn(`  ! taskId ${taskId} not found in checklist`);
}

function saveState() {
  const { encrypt, isEncryptionEnabled } = require('./encryption');
  const plain = JSON.stringify(employee, null, 2);
  const payload = isEncryptionEnabled() ? encrypt(plain) : plain;
  fs.writeFileSync(stateFile, payload);
  console.log(`  State saved for ${employeeId}`);
}

function buildAuth() {
  const credsPath = path.join(__dirname, '..', 'credentials.json');
  const tokenPath = path.join(__dirname, '..', 'token.json');
  const creds = JSON.parse(fs.readFileSync(credsPath));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenPath)));
  return oAuth2Client;
}

async function run() {
  const auth = buildAuth();
  employee._auth = auth;
  employee._saveState = saveState;

  // ── Admin seat allocation (t36) ────────────────────────────────────────────
  if (!isTaskDone('t36')) {
    console.log('\n[1] Firing: Admin seat allocation (t36)');
    await sendAdminSeatAllocationRequest(employee).catch(e => console.warn('  Admin email failed:', e.message));
    markDone('t36');
  } else {
    console.log('\n[1] t36 already done — skipping');
  }

  // ── HR Induction (t33/t34) ─────────────────────────────────────────────────
  if (!isTaskDone('t33')) {
    console.log('\n[2] Firing: HR Induction confirmation (t33/t34)');
    await sendHRInductionConfirmation(employee, contacts.recruiterEmail).catch(e => console.warn('  HR induction email failed:', e.message));
    await markHRInductionScheduled(auth, employee).catch(() => {});
    markDone('t33');
    markDone('t34');
  } else {
    console.log('\n[2] t33/t34 already done — skipping');
  }

  // ── Phase 3 completion summary ─────────────────────────────────────────────
  console.log('\n[3] Firing: Phase 3 (Day of Joining) completion summary');
  const phase3Tasks = Object.values(employee.checklist.phase3?.tasks || {}).map(t => t.label);
  await sendPhaseCompletionSummary(employee, 'Phase 3 — Day of Joining', phase3Tasks)
    .catch(e => console.warn('  Phase 3 summary failed:', e.message));

  // ── 25-day catchup ─────────────────────────────────────────────────────────
  if (!isTaskDone('t63')) {
    console.log('\n[4] Firing: 25-day catchup email (t63)');
    await getOrCreateCatchupSheet(auth, employee).catch(e => console.warn('  Catchup sheet failed:', e.message));
    await send25DayCatchupEmail(employee).catch(e => console.warn('  25-day email failed:', e.message));
    await sendJoineeReviewNotification(employee, 25).catch(e => console.warn('  25-day joinee email failed:', e.message));
    await mark25DayCatchupDone(auth, employee).catch(() => {});
    markDone('t63');
  } else {
    console.log('\n[4] t63 already done — updating sheet');
    await mark25DayCatchupDone(auth, employee).catch(() => {});
  }

  // ── Feedback form (t38) ────────────────────────────────────────────────────
  if (!isTaskDone('t38')) {
    console.log('\n[5] Firing: Employee feedback form email (t38)');
    const { sendEmail } = require('./emailSender');
    const feedbackFormLink = process.env.EMPLOYEE_FEEDBACK_FORM_LINK;
    const name = employee.name;
    const to   = employee.officialEmail || employee.personalEmail;
    const formSection = feedbackFormLink
      ? `<p><a href="${feedbackFormLink}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;">Employee Feedback Form</a></p>`
      : `<p style="color:#e65100;">Feedback form link not configured.</p>`;
    await sendEmail({
      to,
      subject: `Employee Feedback Form — ${process.env.COMPANY_NAME}`,
      html: `<p>Dear ${name},</p><p>You have been with us for 25 days! Please take a moment to fill in the employee feedback form:</p>${formSection}<p>Regards,<br/>${process.env.COMPANY_NAME} HR</p>`,
    }).catch(e => console.warn('  Feedback form email failed:', e.message));
    markDone('t38');
  } else {
    console.log('\n[5] t38 already done — skipping');
  }

  // ── 30-day catchup ─────────────────────────────────────────────────────────
  if (!isTaskDone('t43')) {
    console.log('\n[6] Firing: 30-day catchup (t43)');
    await getOrCreateCatchupSheet(auth, employee).catch(e => console.warn('  Catchup sheet failed:', e.message));
    await create30DayCatchupEvent(auth, employee).catch(e => console.warn('  30-day calendar failed:', e.message));
    await send30DayTechnicalReview(employee).catch(e => console.warn('  30-day email failed:', e.message));
    await sendJoineeReviewNotification(employee, 30).catch(e => console.warn('  30-day joinee email failed:', e.message));
    await mark30DayDone(auth, employee).catch(() => {});
    markDone('t43');
  } else {
    console.log('\n[6] t43 already done — updating sheet');
    await mark30DayDone(auth, employee).catch(() => {});
  }

  // ── 60-day review ──────────────────────────────────────────────────────────
  if (!isTaskDone('t46')) {
    console.log('\n[7] Firing: 60-day review (t46/t47)');
    await sendPeriodicReviewReminder(employee, contacts.recruiterEmail, contacts.managerEmail, 60)
      .catch(e => console.warn('  60-day reminder failed:', e.message));
    await createReviewEvent(auth, employee, 60).catch(e => console.warn('  60-day calendar failed:', e.message));
    await sendReviewSummaryRequest(employee, 60).catch(e => console.warn('  60-day summary request failed:', e.message));
    await sendJoineeReviewNotification(employee, 60).catch(e => console.warn('  60-day joinee email failed:', e.message));
    await mark60DayDone(auth, employee).catch(() => {});
    markDone('t46');
    markDone('t47');
  } else {
    console.log('\n[7] t46/t47 already done — skipping');
  }

  // ── 90-day review ──────────────────────────────────────────────────────────
  if (!isTaskDone('t49')) {
    console.log('\n[8] Firing: 90-day review (t49/t50)');
    await sendPeriodicReviewReminder(employee, contacts.recruiterEmail, contacts.managerEmail, 90)
      .catch(e => console.warn('  90-day reminder failed:', e.message));
    await createReviewEvent(auth, employee, 90).catch(e => console.warn('  90-day calendar failed:', e.message));
    await sendReviewSummaryRequest(employee, 90).catch(e => console.warn('  90-day summary request failed:', e.message));
    await sendJoineeReviewNotification(employee, 90).catch(e => console.warn('  90-day joinee email failed:', e.message));
    await mark90DayDone(auth, employee).catch(() => {});
    markDone('t49');
    markDone('t50');
  } else {
    console.log('\n[8] t49/t50 already done — skipping');
  }

  // ── Pre-probation (t52) ────────────────────────────────────────────────────
  if (!isTaskDone('t52')) {
    console.log('\n[9] Firing: Pre-probation reminder (t52)');
    await sendPreProbationReminder(employee, contacts.managerEmail)
      .catch(e => console.warn('  Pre-probation email failed:', e.message));
    await markPreprobationDone(auth, employee).catch(() => {});
    markDone('t52');
  } else {
    console.log('\n[9] t52 already done — updating sheet');
    await markPreprobationDone(auth, employee).catch(() => {});
  }

  // ── Final onboarding completion report ────────────────────────────────────
  console.log('\n[10] Firing: Final onboarding completion report');
  employee._auth = auth;
  await sendOnboardingCompletionReport(employee)
    .catch(e => console.warn('  Completion report failed:', e.message));
  await sendJoineeOnboardingComplete(employee)
    .catch(e => console.warn('  Joinee completion email failed:', e.message));

  // ── Save updated checklist ─────────────────────────────────────────────────
  saveState();
  await uploadChecklist(auth, employee.driveFolderId, employee.checklist)
    .catch(e => console.warn('Checklist upload failed:', e.message));

  console.log('\nAll milestones fired.');
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
