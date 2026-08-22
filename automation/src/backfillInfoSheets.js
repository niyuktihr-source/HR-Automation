/**
 * backfillInfoSheets.js — Re-fill the AL_DI_HR_018 info sheet for one or more employees.
 *
 * Uses the SAME logic as the engine (createEmployeeInfoSheet) so all the fixed
 * pd-key mappings and doc-number row corrections are automatically applied.
 *
 * Usage:
 *   node src/backfillInfoSheets.js EMP013 EMP0472          ? specific employees
 *   node src/backfillInfoSheets.js --all                   ? every state file found
 *
 * What it does:
 *   1. Reads the employee's encrypted state file (decrypts if needed).
 *   2. Calls createEmployeeInfoSheet(), which:
 *        - If the sheet already exists -> updates Personal Details C2:C26,
 *          doc numbers C30:C31 (fixed), and Education tab in-place.
 *        - If the sheet is gone -> creates a new one from scratch.
 *   3. Saves the sheet URL back to the state file so the engine finds it.
 *
 * Run this ONCE after deploying the statusTracker.js fix.
 */

require('dotenv').config();
const path = require('path');
const fs   = require('fs');

const { google }  = require('googleapis');
const { decrypt, encrypt } = require('./encryption');
const { createEmployeeInfoSheet } = require('./statusTracker');

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
    console.error('Usage: node src/backfillInfoSheets.js EMP013 EMP0472 ...');
    console.error('       node src/backfillInfoSheets.js --all');
    process.exit(1);
  }

  const auth = buildAuth();
  console.log('\nBackfilling info sheets for: ' + ids.join(', ') + '\n');

  for (const employeeId of ids) {
    const state = loadState(employeeId);
    if (!state) {
      console.warn('  No state file for ' + employeeId + ' - skipping');
      continue;
    }

    const employee = Object.assign({}, state, { employeeId });
    const nameDisplay = employee.name || employeeId;
    console.log('--- ' + employeeId + ' - ' + nameDisplay);
    console.log('    personalDetails keys: ' + Object.keys(employee.personalDetails || {}).join(', '));
    console.log('    extractedData keys:   ' + Object.keys(employee.extractedData   || {}).join(', '));

    try {
      const url = await createEmployeeInfoSheet(auth, employee);
      if (url) {
        console.log('    Sheet updated: ' + url);
        if (employee.employeeInfoSheetId) {
          state.employeeInfoSheetId = employee.employeeInfoSheetId;
          saveState(employeeId, state);
          console.log('    Sheet ID saved to state');
        }
      } else {
        console.warn('    createEmployeeInfoSheet returned null for ' + employeeId);
      }
    } catch (err) {
      console.error('    Failed for ' + employeeId + ': ' + err.message);
    }
    console.log();
  }

  console.log('Done.');
}

run().catch(function(err) { console.error('Fatal:', err.message); process.exit(1); });
