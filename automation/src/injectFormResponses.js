/**
 * injectFormResponses.js
 *
 * Reads responses directly from the Google Form linked response spreadsheet
 * and POSTs them to the engine's /preonboarding-details endpoint.
 *
 * Usage:
 *   node src/injectFormResponses.js <spreadsheetId> <employeeId> [employeeId2 ...]
 *
 * Steps:
 *   1. Open your Google Form ? Responses tab ? click the Sheets icon (View in Sheets)
 *   2. Copy the spreadsheet ID from the URL
 *   3. Run this script with the spreadsheet ID and the employee IDs to inject
 *
 * Example:
 *   node src/injectFormResponses.js 1ABC...XYZ EMP0476 EMP0474 EMP0472
 */

require('dotenv').config();
const path  = require('path');
const fs    = require('fs');
const https = require('https');

const { google }  = require('googleapis');
const { decrypt } = require('./encryption');

const ROOT = path.join(__dirname, '..');

// -- Args ----------------------------------------------------------------------
const [spreadsheetId, ...employeeIds] = process.argv.slice(2);
if (!spreadsheetId || employeeIds.length === 0) {
  console.error('Usage: node src/injectFormResponses.js <spreadsheetId> <empId1> [empId2 ...]');
  console.error('');
  console.error('  spreadsheetId: from the form response sheet URL');
  console.error('  empId:         e.g. EMP0476 EMP0474 EMP0472');
  process.exit(1);
}

// -- Auth ----------------------------------------------------------------------
function buildAuth() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'credentials.json')));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2.setCredentials(JSON.parse(fs.readFileSync(path.join(ROOT, 'token.json'))));
  return oAuth2;
}

// -- Load state to get personalEmail for matching ------------------------------
function loadState(employeeId) {
  const stateFile = path.join(ROOT, 'state-' + employeeId + '.json');
  if (!fs.existsSync(stateFile)) return null;
  const raw = fs.readFileSync(stateFile, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed.ciphertext ? JSON.parse(decrypt(raw)) : parsed;
}

// -- POST to engine ------------------------------------------------------------
function postToEngine(payload) {
  return new Promise((resolve, reject) => {
    const engineHost = (process.env.ENGINE_WEBHOOK_URL || 'https://hr.aletheatech.com')
      .replace(/^https?:\/\//, '');
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: engineHost,
      port: 443,
      path: '/preonboarding-details',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// -- File-upload column titles (same as FOLDER_MAP in the .gs files) -----------
const FILE_UPLOAD_TITLES = new Set([
  'Upload Aadhaar Card', 'Upload PAN Card', 'Current Address Proof',
  'Permanent Address Proof', 'Upload Passport Size Photo', 'Upload Offer Letter',
  'Upload 10th Marksheet', 'Upload 12th Marksheet', 'Upload Degree Certificate',
  'Upload Relieving Letter', "Upload Last Month's Payslip",
]);

// -- Main ----------------------------------------------------------------------
async function run() {
  const auth   = buildAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // Read the entire response sheet
  console.log('\nReading form responses from spreadsheet: ' + spreadsheetId);
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const tabName = meta.data.sheets[0].properties.title;
  console.log('Using tab: ' + tabName);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tabName
  });

  const rows = res.data.values || [];
  if (rows.length < 2) {
    console.error('No responses found in the sheet.');
    process.exit(1);
  }

  const headers = rows[0];
  console.log('Columns: ' + headers.join(' | '));
  console.log('Total responses: ' + (rows.length - 1));
  console.log('');

  // Column index finders
  const empIdColIdx = headers.findIndex(h => {
    const t = h.trim().toLowerCase();
    return t === 'employee id' || t.startsWith('employee id(');
  });
  const emailColIdx = headers.findIndex(h => {
    const t = h.trim().toLowerCase();
    return t === 'email address' || t === 'email' || t === 'username' || t.includes('email');
  });
  const nameColIdx = headers.findIndex(h => {
    const t = h.trim().toLowerCase();
    return t === 'full name' || t === 'name' || t.startsWith('full name(');
  });

  function isTestRow(row) {
    let testCount = 0;
    for (const cell of row) {
      const s = String(cell || '').trim().toUpperCase();
      if (s === 'TEST' || s === '123456789' || s === '1234567890' || s === 'TESTING') {
        testCount++;
      }
    }
    return testCount >= 2;
  }

  // Process each requested employee
  for (const employeeId of employeeIds) {
    console.log('--- ' + employeeId);

    const state = loadState(employeeId);
    if (!state) {
      console.warn('    No state file — skipping');
      continue;
    }

    const empName = (state.name || '').trim().toLowerCase();
    const empEmail = (state.personalEmail || '').trim().toLowerCase();

    // Find all matching rows for this employee
    const matches = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const rowEmpId = empIdColIdx !== -1 ? (row[empIdColIdx] || '').trim() : '';
      const rowEmail = emailColIdx !== -1 ? (row[emailColIdx] || '').trim().toLowerCase() : '';
      const rowName = nameColIdx !== -1 ? (row[nameColIdx] || '').trim().toLowerCase() : '';

      let isMatch = false;
      if (rowEmpId && rowEmpId.toUpperCase() === employeeId.toUpperCase()) {
        isMatch = true;
      } else if (empEmail && rowEmail && rowEmail === empEmail) {
        isMatch = true;
      } else if (empName && rowName && (rowName === empName || rowName.includes(empName) || empName.includes(rowName))) {
        isMatch = true;
      }

      if (isMatch) {
        matches.push({ rowIdx: r + 1, row, isTest: isTestRow(row) });
      }
    }

    if (matches.length === 0) {
      console.warn('    No response row found in sheet for ' + employeeId);
      continue;
    }

    // Prefer non-test rows; take the latest non-test row if available
    const nonTestMatches = matches.filter(m => !m.isTest);
    const chosen = nonTestMatches.length > 0
      ? nonTestMatches[nonTestMatches.length - 1]
      : matches[matches.length - 1];

    console.log(`    Found ${matches.length} response(s) — using row ${chosen.rowIdx} ${chosen.isTest ? '(TEST row)' : '(Valid response)'}`);
    const row = chosen.row;

    // Build personalDetails from non-file columns
    const personalDetails = {};
    for (let c = 0; c < headers.length; c++) {
      const title = (headers[c] || '').trim();
      const value = (row[c] || '').trim();
      if (!value) continue;
      if (title === 'Timestamp') continue;
      if (title === 'Employee ID' || title.startsWith('Employee ID(')) continue;
      if (title === 'Drive Folder ID' || title.startsWith('Drive Folder ID(')) continue;
      if (FILE_UPLOAD_TITLES.has(title)) continue;  // skip file upload columns
      personalDetails[title] = value;
    }

    console.log('    personalDetails keys: ' + Object.keys(personalDetails).join(', '));

    // POST to engine
    const payload = {
      employeeId,
      respondentEmail: state.personalEmail || '',  // use registered email to pass validation
      personalDetails,
      uploadedFiles: [],
    };

    try {
      const result = await postToEngine(payload);
      if (result.status === 200) {
        console.log('    Engine accepted Â ' + result.body);
      } else {
        console.warn('    Engine returned ' + result.status + ': ' + result.body);
      }
    } catch (err) {
      console.error('    POST failed: ' + err.message);
    }

    console.log('');
  }

  console.log('Done. Run backfillInfoSheets.js to update the sheets:');
  console.log('  node src/backfillInfoSheets.js ' + employeeIds.join(' '));
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
