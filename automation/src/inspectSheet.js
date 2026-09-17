/**
 * inspectSheet.js — Read-only diagnostic: print a spreadsheet's title, tab names,
 * and the first few rows of each tab.
 *
 * Usage:
 *   node src/inspectSheet.js <spreadsheetId>
 *
 * Makes no writes. Use this to compare two spreadsheet IDs (e.g. an employee's
 * statusSheetId vs employeeInfoSheetId) when their reported content looks the same
 * but their IDs (from state-<EMPID>.json) are different — this shows exactly what's
 * actually in each tab so a mix-up (wrong template, mislabeled link, etc.) can be
 * pinpointed instead of guessed at.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const ROOT = path.join(__dirname, '..');

function buildAuth() {
  const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'credentials.json')));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2.setCredentials(JSON.parse(fs.readFileSync(path.join(ROOT, 'token.json'))));
  return oAuth2;
}

async function run() {
  const spreadsheetId = process.argv[2];
  if (!spreadsheetId) {
    console.error('Usage: node src/inspectSheet.js <spreadsheetId>');
    process.exit(1);
  }

  const auth = buildAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties',
  });

  console.log(`\nSpreadsheet: ${spreadsheetId}`);
  console.log(`Title      : ${meta.data.properties.title}`);
  console.log(`Tabs       : ${meta.data.sheets.map(s => s.properties.title).join(', ')}`);

  for (const s of meta.data.sheets) {
    const title = s.properties.title;
    console.log(`\n--- Tab: "${title}" (sheetId ${s.properties.sheetId}) — first 8 rows ---`);
    try {
      const vals = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${title}'!A1:J8`,
      });
      (vals.data.values || []).forEach(row => console.log('  ' + row.join(' | ')));
    } catch (err) {
      console.log(`  (could not read values: ${err.message})`);
    }
  }
  console.log();
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
