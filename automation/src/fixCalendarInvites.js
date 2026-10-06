// One-shot: create the HR induction + project intro calendar events for an employee whose
// invites were skipped. Idempotent — events use a deterministic ID, so re-running reuses them.
// Usage: node src/fixCalendarInvites.js EMP0485
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { google } = require('googleapis');
const { decrypt } = require('./encryption');
const { createHRInductionEvent, createProjectIntroEvent } = require('./calendarService');

const employeeId = process.argv[2];
if (!employeeId) { console.error('Usage: node src/fixCalendarInvites.js <employeeId>'); process.exit(1); }

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
// Ignore the stale "done" checklist guard and any recorded actions: we are re-creating on purpose.
employee._createdActions = {};
employee._calendarActions = {};

const creds = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'credentials.json')));
const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
auth.setCredentials(JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'token.json'))));

async function run() {
  console.log(`Creating calendar invites for ${employee.name} (${employeeId}), DOJ ${employee.doj}...`);
  console.log('  HR induction :', await createHRInductionEvent(auth, employee));
  console.log('  Project intro:', await createProjectIntroEvent(auth, employee));
}
run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
