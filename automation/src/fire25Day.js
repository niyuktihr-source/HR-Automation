// One-shot: fire 25-day catchup milestone for an employee.
// Usage: node src/fire25Day.js EMP008
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { google } = require('googleapis');
const { decrypt } = require('./encryption');
const { send25DayCatchupEmail } = require('./emailSender');
const { getOrCreateCatchupSheet, mark25DayCatchupDone } = require('./statusTracker');
const { create25DayCatchupEvent } = require('./calendarService');
const config = require('./config');

const employeeId = process.argv[2];
if (!employeeId) { console.error('Usage: node src/fire25Day.js <employeeId>'); process.exit(1); }

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
  console.log(`\nFiring 25-day catchup for ${employee.name} (${employeeId})...`);

  // Ensure personal catchup sheet copy is created from master template in joinee's folder
  const catchupUrl = await getOrCreateCatchupSheet(auth, employee).catch(e => {
    console.warn('  Catchup sheet copy failed:', e.message);
    return null;
  });
  if (catchupUrl) console.log(`  ✓ Catchup sheet created: ${catchupUrl}`);

  // Create calendar event
  const calResult = await create25DayCatchupEvent(auth, employee).catch(err => {
    console.warn('  Calendar event failed:', err.message);
    return null;
  });
  if (calResult) console.log('  ✓ Calendar event created:', calResult.htmlLink);

  // Send 25-day catchup email to HR/recruiter
  await send25DayCatchupEmail(employee, { meetLink: employee.meetLinks && employee.meetLinks['25day-catchup'] }).catch(e => console.warn('  25-day catchup HR email failed:', e.message));
  console.log('  ✓ 25-day catchup email sent to HR');

  // Mark sheet milestone Done
  await mark25DayCatchupDone(auth, employee);
  console.log('  ✓ Sheet: 25th day catchup call completed → Done');

  console.log('\nDone. Check your email and the status sheet.');
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
