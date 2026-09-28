// Test script — sends one of every email template to GMAIL_USER so you can verify
// all templates render correctly in a real inbox.
// Usage: node src/testEmails.js  (or: npm run test-emails)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  sendPreOnboardingForm,
  sendDocumentRejection,
  sendNoResponseAlert,
  sendOfficialEmailCreationRequest,
  sendAssetAllocationRequest,
  sendITAssetRequest,
  sendBGVRequest,
  sendHRInductionConfirmation,
  sendPreProbationReminder,
  sendPhaseCompletionSummary,
  sendVerificationReport,
  sendInductionCalendarInvite,
  sendProjectIntroInvite,
  sendCatchupXLSEmail,
  sendReviewSummaryRequest,
  sendNoReplyEscalation,
} = require('./emailSender');

const { getAuthClient } = require('./driveWatcher');

const testEmail = process.env.GMAIL_USER;

if (!testEmail) {
  console.error('Error: GMAIL_USER is not set in .env');
  process.exit(1);
}

// Build a fake employee — all emails point to GMAIL_USER so everything lands in one inbox
// _auth is injected after Google auth is ready so Drive/Sheets calls work (e.g. catchup XLS)
const employee = {
  employeeId: 'TEST001',
  name: 'Test Employee',
  designation: 'Software Engineer',
  team: 'Test Services Team',
  officeLocation: 'L4 Location',
  personalEmail: testEmail,
  officialEmail: testEmail,
  doj: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
  formLink: 'https://example.com/form',
  driveFolderId: process.env.TEST_DRIVE_FOLDER_ID || process.env.EMPLOYEE_DRIVE_FOLDER_ID || null,
  contacts: {
    recruiterEmail: testEmail,
    managerEmail: testEmail,
    itEmail: process.env.IT_EMAIL || testEmail,
    itPersonName: 'IT Team',
  },
};

// Each entry: [label, async fn]
const tests = [
  ['1/17 sendPreOnboardingForm',         () => sendPreOnboardingForm(employee)],
  ['2/17 sendDocumentRejection',         () => sendDocumentRejection(employee, 'Aadhaar Card', 'Document is blurry and Aadhaar number is not visible')],
  ['3/17 sendNoResponseAlert',           () => sendNoResponseAlert(employee, testEmail)],
  ['4/17 sendOfficialEmailCreationRequest', () => sendOfficialEmailCreationRequest(employee)],
  ['5/17 sendAssetAllocationRequest',    () => sendAssetAllocationRequest(employee, testEmail)],
  ['6/17 sendITAssetRequest',            () => sendITAssetRequest(employee, testEmail, { assetType: 'MacBook Pro', officeLocation: 'Bangalore HQ' })],
  ['7/17 sendBGVRequest',                () => sendBGVRequest(employee, testEmail)],
  ['8/17 sendHRInductionConfirmation',   () => sendHRInductionConfirmation(employee, testEmail)],
  ['9/17 sendReviewSummaryRequest(30)',   () => sendReviewSummaryRequest(employee, 30)],
  ['10/17sendPreProbationReminder',      () => sendPreProbationReminder(employee, testEmail)],
  ['11/17sendPhaseCompletionSummary',    () => sendPhaseCompletionSummary(employee, 'Phase 3 — Day of Joining', ['HR induction done', 'IT assets allocated', 'Project intro meeting done'])],
  ['12/17sendVerificationReport',        () => sendVerificationReport(employee, {
      aadhaar: { valid: true,  summary: 'Aadhaar card is clear and all fields visible' },
      pan:     { valid: false, summary: 'PAN number not visible' },
    })],
  ['13/17sendInductionCalendarInvite',   () => sendInductionCalendarInvite(employee)],
  ['14/17sendProjectIntroInvite',        () => sendProjectIntroInvite(employee)],
  ['15/17sendCatchupXLSEmail',           () => sendCatchupXLSEmail(employee)],
  ['16/17sendReviewSummaryRequest(30)',  () => sendReviewSummaryRequest(employee, 30)],
  ['17/17sendNoReplyEscalation',         () => sendNoReplyEscalation(employee, 'IT Team', process.env.IT_EMAIL || testEmail)],
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  // Inject real Google auth so Drive/Sheets-backed templates (e.g. catchup XLS) work
  try {
    employee._auth = getAuthClient();
    console.log('  Google auth ready — Drive/Sheets templates will create real files');
  } catch (err) {
    console.warn(`  Warning: Google auth failed (${err.message}) — Drive/Sheets templates will skip sheet creation`);
  }

  console.log(`\nSending ${tests.length} test emails to ${testEmail}\n`);
  let sent = 0;

  for (let i = 0; i < tests.length; i++) {
    const [label, fn] = tests[i];
    process.stdout.write(`  Sending ${label} ... `);
    try {
      await fn();
      console.log('OK');
      sent++;
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
    // 1s gap between sends to avoid rate limits
    if (i < tests.length - 1) {
      await sleep(1000);
    }
  }

  console.log(`\n✓ Sent ${sent}/${tests.length} emails to ${testEmail}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
