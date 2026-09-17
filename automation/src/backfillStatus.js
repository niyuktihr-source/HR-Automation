/**
 * backfillStatus.js — One-off manual repair tool: after clearing a broken
 * statusSheetId and letting the engine create a genuinely fresh status sheet
 * (which always starts every employee at milestone 0 = In Progress, everything
 * else Pending — it has no knowledge of real historical progress), this
 * replays the employee's actual progress onto that fresh sheet using the
 * exact same named milestone updater functions the live engine calls, so the
 * result matches what the engine would have written if the sheet had never
 * broken in the first place.
 *
 * IMPORTANT — run this only:
 *   1. AFTER `pm2 restart hr-engine` has already created the new status sheet
 *      (confirm state-<EMPID>.json's statusSheetId is populated, e.g. via
 *      `node src/inspectSheet.js <statusSheetId>`).
 *   2. With the engine not concurrently writing this employee's state, to
 *      avoid a lost update — either stop pm2 first, or run it when you know
 *      no other event for this employee is in flight.
 *
 * Usage:
 *   node src/backfillStatus.js <EMPID>
 *
 * Edit the MILESTONES_TO_APPLY list below per-employee before running —
 * there is deliberately no auto-detection from checklist/activity-log state,
 * so you always explicitly review what's being marked before it's written.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { decrypt, encrypt, isEncryptionEnabled } = require('./encryption');
const statusTracker = require('./statusTracker');

const ROOT = path.join(__dirname, '..');

function buildAuth() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'credentials.json')));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2.setCredentials(JSON.parse(fs.readFileSync(path.join(ROOT, 'token.json'))));
  return oAuth2;
}

function loadState(employeeId) {
  const file = path.join(ROOT, `state-${employeeId}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  if (isEncryptionEnabled() && raw.includes('"ciphertext"')) {
    return { data: JSON.parse(decrypt(raw)), file, wasEncrypted: true };
  }
  return { data: JSON.parse(raw), file, wasEncrypted: false };
}

function saveState(file, data, wasEncrypted) {
  const plaintext = JSON.stringify(data, null, 2);
  fs.writeFileSync(file, wasEncrypted ? encrypt(plaintext) : plaintext);
}

// Edit this per employee before running — each entry is applied in order.
// See statusTracker.js's named updaters for what each one actually sets:
//   markPreonboardingInitiated   → milestone 0  DONE
//   markDocumentsVerifiedOk      → milestones 1 & 3 DONE (and 2 DONE only if it was NOT_OK)
//   markBGVDone                  → milestone 7  DONE
//   markHRInductionScheduled     → milestone 8  IN_PROGRESS (invite sent, attendance not yet confirmed)
//   markHRInductionDone          → milestone 8  DONE (only once the screenshot/t34 actually lands)
//   markProjectIntroScheduled    → milestone 9  IN_PROGRESS (invite sent, not yet confirmed)
//   markProjectIntroDone         → milestone 9  DONE (only once the screenshot/t37 actually lands)
const MILESTONES_TO_APPLY = [
  'markPreonboardingInitiated',
  'markDocumentsVerifiedOk',
  'markBGVDone',
  'markHRInductionScheduled',
  'markProjectIntroScheduled',
];

async function run() {
  const employeeId = process.argv[2];
  if (!employeeId) {
    console.error('Usage: node src/backfillStatus.js <EMPID>');
    process.exit(1);
  }

  const auth = buildAuth();
  const { data: employee, file, wasEncrypted } = loadState(employeeId);

  if (!employee.statusSheetId) {
    console.error(`state-${employeeId}.json has no statusSheetId yet — restart the engine first so it creates the fresh sheet, then re-run this.`);
    process.exit(1);
  }

  console.log(`Backfilling status sheet for ${employee.name} (${employeeId}) → https://docs.google.com/spreadsheets/d/${employee.statusSheetId}`);

  for (const fnName of MILESTONES_TO_APPLY) {
    const fn = statusTracker[fnName];
    if (!fn) throw new Error(`No such statusTracker function: ${fnName}`);
    console.log(`  applying ${fnName}...`);
    await fn(auth, employee);
  }

  saveState(file, employee, wasEncrypted);
  console.log('Done. State file re-saved (statusSheetId unchanged unless the sheet needed re-resolving).');
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
