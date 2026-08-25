// One-shot: fire 30-day catchup milestone for an employee.
// Usage: node src/fire30Day.js EMP008
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { google } = require('googleapis');
const { decrypt } = require('./encryption');
const { send30DayTechnicalReview } = require('./emailSender');
const { getOrCreateCatchupSheet, mark30DayDone } = require('./statusTracker');
const { create30DayCatchupEvent } = require('./calendarService');

const employeeId = process.argv[2];
if (!employeeId) { console.error('Usage: node src/fire30Day.js <employeeId>'); process.exit(1); }

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

const credsPath = path.join(__dirname, '..', 'credentials.json');
const tokenPath = path.join(__dirname, '..', 'token.json');
const creds = JSON.parse(fs.readFileSync(credsPath));
const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
auth.setCredentials(JSON.parse(fs.readFileSync(tokenPath)));
employee._auth = auth;

async function run() {
  console.log(`\nFiring 30-day catchup for ${employee.name} (${employeeId})...`);

  // Ensure personal catchup sheet copy is created from master template in joinee's folder
  const catchupUrl = await getOrCreateCatchupSheet(auth, employee).catch(e => {
    console.warn('  Catchup sheet copy failed:', e.message);
    return null;
  });
  if (catchupUrl) console.log(`  ✓ 30-day catchup sheet created: ${catchupUrl}`);

  // Create calendar event
  await create30DayCatchupEvent(auth, employee).catch(e => console.warn('  Calendar event failed:', e.message));
  console.log('  ✓ 30-day calendar event created');

  // Send technical review email to manager + joinee
  await send30DayTechnicalReview(employee).catch(e => console.warn('  30-day email failed:', e.message));
  console.log('  ✓ 30-day technical review email sent');

  // Mark sheet milestone Done
  await mark30DayDone(auth, employee);
  console.log('  ✓ Sheet: 30-day catchup completed → Done');

  console.log('\nDone. Check your email and the status sheet.');
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
