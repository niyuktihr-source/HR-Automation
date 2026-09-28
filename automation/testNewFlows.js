// One-shot test script for the 25-day / 30-day / 60-day / 90-day flows built this
// session. Sends every real email to a single test inbox and (optionally) creates
// a real test calendar invite — nothing here touches employees.json, any
// state-EMP*.json file, activityLog, or the master dashboard. The fake "employee"
// below lives only in memory for the duration of this script.
//
// Usage:
//   node testNewFlows.js            → sends every email test
//   node testNewFlows.js 25         → only the 25-day flow's emails
//   node testNewFlows.js 30         → only the 30-day flow's emails
//   node testNewFlows.js 60         → only the 60-day flow's emails
//   node testNewFlows.js 90         → only the 90-day flow's emails
//   node testNewFlows.js calendar   → also creates REAL test calendar invites
//                                     (25/30/60/90-day) on this Google account,
//                                     inviting the test address — skipped by
//                                     default since it's a real, visible side
//                                     effect (shows up on the calendar).

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const {
  send25DayCatchupEmail,
  send25DayCatchupSummary,
  sendDayBeforeReminder,
  sendManagerConfirmationRequest,
  sendReviewSummaryShareReminder,
  sendReviewSummaryEscalation,
} = require('./src/emailSender');
const { summarizeCatchup25Notes } = require('./src/statusTracker');

const TEST_EMAIL = 'eshwarreddy8382@gmail.com';

// Deliberately NOT a real EMP#### id, and never added to employeeRegistry —
// this object is never read from or written to any state file.
const employee = {
  employeeId: 'ZZTEST99',
  name: 'Test Employee',
  officialEmail: TEST_EMAIL,
  personalEmail: TEST_EMAIL,
  doj: '2026-01-01',
  isFresher: true,
  officeLocation: 'Bangalore',
  assetRequired: 'Laptop',
  projectIntroSheetId: null, // intentionally absent — no real sheet is touched
  meetLinks: {},
  checklist: {},
  contacts: {
    recruiterEmail: TEST_EMAIL,
    managerEmail: TEST_EMAIL,
    managerName: 'Test Manager',
    hrEmail: TEST_EMAIL,
  },
  // No _auth and no _saveState — anything that would touch Calendar/Drive/state
  // is skipped by the functions' own `if (employee._auth)` / `if (employee._saveState)` guards.
};

const FAKE_EVENT_DATE_STR = '23 Sep 2026 at 11:00 AM IST';

const FAKE_QA_PAIRS = [
  { question: 'How was your first day in Alethea?', answer: 'Really welcoming, the team walked me through everything.' },
  { question: 'Did you receive the laptop within a week of joining?', answer: 'Yes, on day 2.' },
  { question: 'Are you facing any difficulty in your daily work?', answer: 'A bit with the internal deployment process, still learning it.' },
  { question: 'Has your project work started? If yes can you explain your project briefly?', answer: 'Yes, working on the HR automation onboarding pipeline.' },
];
const FAKE_RECRUITER_SUMMARY = 'Settling in well, no red flags. Slight ramp-up needed on deployment tooling.';

async function fire(label, fn) {
  try {
    await fn();
    console.log(`✅  ${label}`);
  } catch (err) {
    console.error(`❌  ${label} — ${err.message}`);
  }
  await new Promise(r => setTimeout(r, 1200)); // small gap between sends
}

async function test25Day() {
  console.log('\n── 25-Day Catchup ──────────────────────────────');
  await fire('Step 2h-after-call reminder → recruiter+HR (fill sheet, Confirmed + screenshot)', () =>
    send25DayCatchupEmail(employee, { eventDateStr: FAKE_EVENT_DATE_STR })
  );
  await fire('Same reminder, resent (simulates "sheet not filled yet")', () =>
    send25DayCatchupEmail(employee, { eventDateStr: FAKE_EVENT_DATE_STR })
  );

  console.log('  Calling real Gemini summarization on fake Q&A data...');
  const summaryText = await summarizeCatchup25Notes(employee, FAKE_QA_PAIRS, FAKE_RECRUITER_SUMMARY);
  console.log('  Summary generated:', summaryText.slice(0, 200) + (summaryText.length > 200 ? '...' : ''));
  await fire('Summary email → manager+recruiter (after "sheet filled")', () =>
    send25DayCatchupSummary(employee, summaryText)
  );
}

async function testReviewDay(dayMark) {
  console.log(`\n── ${dayMark}-Day Review ──────────────────────────────`);
  await fire(`Day-${dayMark - 1} heads-up → recruiter+manager`, () =>
    sendDayBeforeReminder(employee, dayMark)
  );
  await fire('Step 3 — manager+recruiter, "Confirmed" to close sheet review', () =>
    sendManagerConfirmationRequest(employee, employee.contacts.managerEmail, dayMark, employee.contacts.recruiterEmail, FAKE_EVENT_DATE_STR)
  );
  await fire('Step 4 — recruiter screenshot reminder (Confirmed + screenshot)', () =>
    sendReviewSummaryShareReminder(employee, dayMark, FAKE_EVENT_DATE_STR)
  );
  await fire('Step 5 — summary to joinee, cc recruiter (Confirmed / Not Received)', () =>
    require('./src/emailSender').sendReviewSummaryEmail(employee, dayMark, null)
  );
  await fire('Step 6 negative branch — escalation to recruiter ("Not Received" despite confirming)', () =>
    sendReviewSummaryEscalation(employee, dayMark)
  );
}

async function testCalendarInvites() {
  console.log('\n── Real calendar invites (visible side effect) ──────────────────────────────');
  const path = require('path');
  const fs = require('fs');
  const { google } = require('googleapis');
  const credPath = path.join(__dirname, 'credentials.json');
  const tokenPath = path.join(__dirname, 'token.json');
  if (!fs.existsSync(credPath) || !fs.existsSync(tokenPath)) {
    console.warn('  credentials.json/token.json not found — skipping calendar tests');
    return;
  }
  const c = JSON.parse(fs.readFileSync(credPath));
  const { client_secret, client_id, redirect_uris } = c.installed || c.web;
  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  auth.setCredentials(JSON.parse(fs.readFileSync(tokenPath)));
  employee._auth = auth;

  const { create25DayCatchupEvent, create30DayCatchupEvent, createReviewEvent } = require('./src/calendarService');

  await fire('25-day "HR Catchup" invite (joinee+recruiter+manager[optional], 15 min, Meet link)', async () => {
    const r = await create25DayCatchupEvent(auth, employee);
    if (r) console.log('   →', r.htmlLink);
  });
  await fire('30-day review invite (recruiter+manager only, Meet link, AL_DI_HR_019 body)', async () => {
    const r = await create30DayCatchupEvent(auth, employee);
    if (r) console.log('   →', r.htmlLink);
  });
  await fire('60-day review invite', async () => {
    const r = await createReviewEvent(auth, employee, 60);
    if (r) console.log('   →', r.htmlLink);
  });
  await fire('90-day review invite', async () => {
    const r = await createReviewEvent(auth, employee, 90);
    if (r) console.log('   →', r.htmlLink);
  });
}

async function run() {
  const args = process.argv.slice(2);
  const runAll = args.length === 0;
  console.log(`Sending test emails to ${TEST_EMAIL} — no state files will be touched.\n`);

  if (runAll || args.includes('25')) await test25Day();
  if (runAll || args.includes('30')) await testReviewDay(30);
  if (runAll || args.includes('60')) await testReviewDay(60);
  if (runAll || args.includes('90')) await testReviewDay(90);
  if (args.includes('calendar')) await testCalendarInvites();

  console.log('\nDone. Check the inbox at', TEST_EMAIL);
}

run();
