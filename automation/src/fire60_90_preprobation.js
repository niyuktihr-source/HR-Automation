// One-shot: fire 60-day, 90-day and pre-probation milestones for an employee.
// Usage: node src/fire60_90_preprobation.js EMP008
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { google } = require('googleapis');
const { decrypt } = require('./encryption');
const { sendPreProbationReminder } = require('./emailSender');
const { mark60DayDone, mark90DayDone, markPreprobationDone } = require('./statusTracker');
const { createReviewEvent } = require('./calendarService');

const employeeId = process.argv[2];
if (!employeeId) { console.error('Usage: node src/fire60_90_preprobation.js <employeeId>'); process.exit(1); }

const STATE_DIR = path.join(__dirname, '..');
const stateFile = path.join(STATE_DIR, `state-${employeeId}.json`);
if (!fs.existsSync(stateFile)) { console.error(`No state file for ${employeeId}`); process.exit(1); }

const raw  = fs.readFileSync(stateFile, 'utf8');
const data = JSON.parse(raw);
const state = data.ciphertext ? JSON.parse(decrypt(raw)) : data;

const empList = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'employees.json'), 'utf8'));
const empBase = empList.find(e => e.employeeId === employeeId);
if (!empBase) { console.error(`${employeeId} not found in employees.json`); process.exit(1); }

const employee = { ...empBase, ...state, employeeId };
const contacts = employee.contacts || {};
const recruiterEmail = contacts.recruiterEmail || process.env.HR_EMAIL;
const managerEmail   = contacts.managerEmail   || process.env.HR_EMAIL;

const credsPath = path.join(__dirname, '..', 'credentials.json');
const tokenPath = path.join(__dirname, '..', 'token.json');
const creds = JSON.parse(fs.readFileSync(credsPath));
const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
auth.setCredentials(JSON.parse(fs.readFileSync(tokenPath)));

async function run() {
  // ── 60-day ────────────────────────────────────────────────────────────────
  console.log(`\n[1] Firing 60-day review for ${employee.name}...`);
  await createReviewEvent(auth, employee, 60).catch(e => console.warn('  60-day calendar failed:', e.message));
  console.log('  ✓ 60-day calendar event created');
  await mark60DayDone(auth, employee);
  console.log('  ✓ Sheet: 60-day review completed → Done');

  // ── 90-day ────────────────────────────────────────────────────────────────
  console.log(`\n[2] Firing 90-day review for ${employee.name}...`);
  await createReviewEvent(auth, employee, 90).catch(e => console.warn('  90-day calendar failed:', e.message));
  console.log('  ✓ 90-day calendar event created');
  await mark90DayDone(auth, employee);
  console.log('  ✓ Sheet: 90-day review completed → Done');

  // ── Pre-probation ─────────────────────────────────────────────────────────
  console.log(`\n[3] Firing pre-probation for ${employee.name}...`);
  await sendPreProbationReminder(employee, managerEmail).catch(e => console.warn('  Pre-probation email failed:', e.message));
  console.log('  ✓ Pre-probation reminder email sent');
  await markPreprobationDone(auth, employee);
  console.log('  ✓ Sheet: Pre-probation verification completed → Done');

  console.log('\nAll done. Check your email and the status sheet.');
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
