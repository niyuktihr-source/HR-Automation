/**
 * fixStatusSheets.js — Re-validate/recreate the onboarding status sheet for one or
 * more employees.
 *
 * Uses the SAME logic as the engine (getOrCreateStatusSheet), which now verifies the
 * shape of whatever statusSheetId currently points to before trusting it. If it looks
 * like the AL_DI_HR_018 employee info sheet (or any other tracked sheet) instead of a
 * real single-tab status tracker, it clears the bad ID and creates a genuine, distinct
 * status sheet in its place — instead of the old behavior of blindly renaming a tab on
 * whichever file was already cached.
 *
 * Usage:
 *   node src/fixStatusSheets.js EMP0480 EMP0478      — specific employees
 *   node src/fixStatusSheets.js --all                — every state file found
 *
 * What it does:
 *   1. Reads the employee's encrypted state file (decrypts if needed).
 *   2. Calls getOrCreateStatusSheet(), which self-heals a mismatched/mixed-up
 *      statusSheetId as described above.
 *   3. Saves the (possibly new) statusSheetId back to the state file.
 *
 * Run this ONCE after deploying the statusTracker.js fix, for any employee whose
 * status sheet was reported as showing the wrong content.
 */

require('dotenv').config();
const path = require('path');
const fs   = require('fs');

const { google }  = require('googleapis');
const { decrypt, encrypt } = require('./encryption');
const { getOrCreateStatusSheet } = require('./statusTracker');

const ROOT = path.join(__dirname, '..');

// -- Auth ---------------------------------------------------------------------
function buildAuth() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'credentials.json')));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2.setCredentials(JSON.parse(fs.readFileSync(path.join(ROOT, 'token.json'))));
  return oAuth2;
}

// -- Load state (handles encrypted and plain) ---------------------------------
function loadState(employeeId) {
  const stateFile = path.join(ROOT, 'state-' + employeeId + '.json');
  if (!fs.existsSync(stateFile)) return null;
  const raw = fs.readFileSync(stateFile, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed.ciphertext ? JSON.parse(decrypt(raw)) : parsed;
}

// -- Save state back (preserves encryption) -----------------------------------
function saveState(employeeId, state) {
  const stateFile = path.join(ROOT, 'state-' + employeeId + '.json');
  const raw = fs.readFileSync(stateFile, 'utf8');
  const parsed = JSON.parse(raw);
  const isEncrypted = !!parsed.ciphertext;
  const toWrite = isEncrypted
    ? encrypt(JSON.stringify(state))
    : JSON.stringify(state, null, 2);
  fs.writeFileSync(stateFile, toWrite, 'utf8');
}

// -- Resolve employee IDs -----------------------------------------------------
function resolveIds(args) {
  if (args.includes('--all')) {
    return fs.readdirSync(ROOT)
      .filter(function(f) { return f.startsWith('state-') && f.endsWith('.json'); })
      .map(function(f) { return f.replace('state-', '').replace('.json', ''); });
  }
  return args.filter(function(a) { return !a.startsWith('--'); });
}

// -- Main ---------------------------------------------------------------------
async function run() {
  const ids = resolveIds(process.argv.slice(2));
  if (ids.length === 0) {
    console.error('Usage: node src/fixStatusSheets.js EMP0480 EMP0478 ...');
    console.error('       node src/fixStatusSheets.js --all');
    process.exit(1);
  }

  const auth = buildAuth();
  console.log('\nRe-validating status sheets for: ' + ids.join(', ') + '\n');

  for (const employeeId of ids) {
    const state = loadState(employeeId);
    if (!state) {
      console.warn('  No state file for ' + employeeId + ' - skipping');
      continue;
    }

    const employee = Object.assign({}, state, { employeeId });
    const nameDisplay = employee.name || employeeId;
    const before = employee.statusSheetId || '(none)';
    console.log('--- ' + employeeId + ' - ' + nameDisplay);
    console.log('    statusSheetId before:      ' + before);
    console.log('    employeeInfoSheetId:       ' + (employee.employeeInfoSheetId || '(none)'));

    try {
      const id = await getOrCreateStatusSheet(auth, employee);
      const changed = id !== before;
      console.log('    statusSheetId after:       ' + id + (changed ? '  (CHANGED)' : '  (unchanged)'));
      state.statusSheetId = employee.statusSheetId;
      saveState(employeeId, state);
      console.log('    Saved to state.');
      if (changed) {
        console.log('    NOTE: this employee now has a distinct status sheet at:');
        console.log('    https://docs.google.com/spreadsheets/d/' + id);
      }
    } catch (err) {
      console.error('    Failed for ' + employeeId + ': ' + err.message);
    }
    console.log();
  }

  console.log('Done.');
}

run().catch(function(err) { console.error('Fatal:', err.message); process.exit(1); });
