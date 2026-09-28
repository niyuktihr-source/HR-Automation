// fireJoineeEmails.js — fire all new joinee emails to a test address
require('dotenv').config();

const {
  sendPreOnboardingForm,
  sendOfficialEmailAccessTest,
  sendInductionCalendarInvite,
  sendProjectIntroInvite,
  sendJoineeOnboardingComplete,
  sendEmail,
} = require('./src/emailSender');

const TEST_EMAIL = 'achyuthcv2020@gmail.com';

const employee = {
  employeeId: 'EMP001',
  name: 'Achyuth C.V',
  personalEmail: TEST_EMAIL,
  officialEmail: TEST_EMAIL,
  doj: '2026-07-01',
  isFresher: false,
  role: 'Software Engineer',
  department: 'Engineering',
  driveFolderId: process.env.EMPLOYEE_DRIVE_FOLDER_ID,
  contacts: {
    recruiterEmail: TEST_EMAIL,
    managerEmail: TEST_EMAIL,
    itEmail: TEST_EMAIL,
  },
  checklist: {},
  extractedData: {},
  projectIntroSheetUrl: 'https://docs.google.com/spreadsheets/d/demo',
};

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log('Firing all new joinee emails to', TEST_EMAIL, '...\n');

  console.log('[1/5] Welcome + pre-onboarding form...');
  await sendPreOnboardingForm(employee);
  await delay(1500);

  console.log('[2/5] Official email access test...');
  await sendOfficialEmailAccessTest(employee);
  await delay(1500);

  console.log('[3/5] HR induction notification...');
  await sendInductionCalendarInvite(employee);
  await delay(1500);

  console.log('[4/5] Project intro notification (no sheet link)...');
  await sendProjectIntroInvite(employee, null);
  await delay(1500);

  console.log('[5/5] Onboarding complete...');
  await sendJoineeOnboardingComplete(employee);

  console.log('\nAll joinee emails sent! Check achyuthcv2020@gmail.com');
  process.exit(0);
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
