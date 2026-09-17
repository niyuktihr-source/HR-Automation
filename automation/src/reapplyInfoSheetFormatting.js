/**
 * reapplyInfoSheetFormatting.js — One-off repair tool: re-applies the AL_DI_HR_018
 * employee info sheet's formatting (colors, bold headers, wrap, column widths)
 * to an EXISTING sheet without touching any of its data.
 *
 * Why this is needed: createEmployeeInfoSheet() in statusTracker.js only runs its
 * formatting batchUpdate once, immediately after first creating the sheet and
 * writing its initial values. If that batchUpdate fails (or the process restarts
 * before it runs) but the sheet + values were already written successfully, the
 * sheet is left permanently unformatted — every later "already exists" retry path
 * only rewrites Personal Details / Education values, it never reapplies formatting.
 *
 * This script is that missing reapply step, extracted verbatim from
 * createEmployeeInfoSheet()'s formatting block so the visual result matches
 * exactly what a clean first-time creation would have produced.
 *
 * Usage:
 *   node src/reapplyInfoSheetFormatting.js <EMPID>
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { decrypt, isEncryptionEnabled } = require('./encryption');

const ROOT = path.join(__dirname, '..');

function buildAuth() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'credentials.json')));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2.setCredentials(JSON.parse(fs.readFileSync(path.join(ROOT, 'token.json'))));
  return oAuth2;
}

function loadEmployee(employeeId) {
  const raw = fs.readFileSync(path.join(ROOT, `state-${employeeId}.json`), 'utf8');
  if (isEncryptionEnabled() && raw.includes('"ciphertext"')) return JSON.parse(decrypt(raw));
  return JSON.parse(raw);
}

async function run() {
  const employeeId = process.argv[2];
  if (!employeeId) {
    console.error('Usage: node src/reapplyInfoSheetFormatting.js <EMPID>');
    process.exit(1);
  }

  const employee = loadEmployee(employeeId);
  const spreadsheetId = employee.employeeInfoSheetId;
  if (!spreadsheetId) {
    console.error(`state-${employeeId}.json has no employeeInfoSheetId — nothing to format.`);
    process.exit(1);
  }

  const auth = buildAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const tabIds = {};
  for (const s of meta.data.sheets) tabIds[s.properties.title] = s.properties.sheetId;

  const REQUIRED_TABS = ['Document Version history', 'Personal Details', 'Education & Professional Detail'];
  const missing = REQUIRED_TABS.filter(t => !(t in tabIds));
  if (missing.length) {
    console.error(`Sheet ${spreadsheetId} is missing expected tab(s): ${missing.join(', ')} — has: ${Object.keys(tabIds).join(', ')}. Refusing to guess; this doesn't look like a normal AL_DI_HR_018 sheet.`);
    process.exit(1);
  }

  const dvId = tabIds['Document Version history'];
  const pdId = tabIds['Personal Details'];
  const epId = tabIds['Education & Professional Detail'];

  const TEAL   = { red: 0.69, green: 0.91, blue: 0.90 };
  const GREEN  = { red: 0.0,  green: 0.80, blue: 0.0  };
  const YELLOW = { red: 1.0,  green: 0.93, blue: 0.0  };
  const BOLD   = { bold: true };
  const formatRequests = [];

  // ── Doc Version history formatting ─────────────────────────────────────────
  formatRequests.push({
    repeatCell: {
      range: { sheetId: dvId, startRowIndex: 0, endRowIndex: 2 },
      cell: { userEnteredFormat: {
        textFormat: { bold: true, fontSize: 13, foregroundColor: { red: 0.12, green: 0.33, blue: 0.71 } },
        horizontalAlignment: 'CENTER',
      }},
      fields: 'userEnteredFormat(textFormat,horizontalAlignment)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: dvId, startRowIndex: 4, endRowIndex: 5 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: dvId, startRowIndex: 3, endRowIndex: 4 },
      cell: { userEnteredFormat: { textFormat: BOLD } },
      fields: 'userEnteredFormat(textFormat)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: dvId, startRowIndex: 0, endRowIndex: 10 },
      cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
      fields: 'userEnteredFormat(wrapStrategy)',
    },
  });

  // ── Personal Details formatting ─────────────────────────────────────────────
  formatRequests.push({
    repeatCell: {
      range: { sheetId: pdId, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL, horizontalAlignment: 'CENTER' } },
      fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: pdId, startRowIndex: 26, endRowIndex: 27 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL, horizontalAlignment: 'CENTER' } },
      fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: pdId, startRowIndex: 27, endRowIndex: 28 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: pdId, startRowIndex: 28, endRowIndex: 29 },
      cell: { userEnteredFormat: { backgroundColor: GREEN } },
      fields: 'userEnteredFormat(backgroundColor)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: pdId, startRowIndex: 31, endRowIndex: 32 },
      cell: { userEnteredFormat: { backgroundColor: YELLOW } },
      fields: 'userEnteredFormat(backgroundColor)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: pdId, startRowIndex: 32, endRowIndex: 33 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: pdId, startRowIndex: 34, endRowIndex: 35 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: pdId, startRowIndex: 1, endRowIndex: 36, startColumnIndex: 1, endColumnIndex: 2 },
      cell: { userEnteredFormat: { textFormat: BOLD } },
      fields: 'userEnteredFormat(textFormat)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: pdId, startRowIndex: 0, endRowIndex: 36 },
      cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
      fields: 'userEnteredFormat(wrapStrategy)',
    },
  });

  // ── Education & Professional Detail formatting ──────────────────────────────
  formatRequests.push({
    repeatCell: {
      range: { sheetId: epId, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL, horizontalAlignment: 'CENTER' } },
      fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: epId, startRowIndex: 1, endRowIndex: 2 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: epId, startRowIndex: 7, endRowIndex: 8 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL, horizontalAlignment: 'CENTER' } },
      fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: epId, startRowIndex: 8, endRowIndex: 9 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: epId, startRowIndex: 12, endRowIndex: 13 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: epId, startRowIndex: 18, endRowIndex: 19 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: epId, startRowIndex: 23, endRowIndex: 24 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: epId, startRowIndex: 35, endRowIndex: 36 },
      cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: { sheetId: epId, startRowIndex: 0, endRowIndex: 50 },
      cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
      fields: 'userEnteredFormat(wrapStrategy)',
    },
  });

  for (const sid of [dvId, pdId, epId]) {
    formatRequests.push({
      autoResizeDimensions: {
        dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: 9 },
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: formatRequests } });
  console.log(`Formatting reapplied for ${employee.name} (${employeeId}) → https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
