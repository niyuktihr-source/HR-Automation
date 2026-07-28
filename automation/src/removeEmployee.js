// Remove an employee from employees.json and clean up their state files.
// Usage: npm run remove-employee

require('dotenv').config();
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { decrypt, isEncryptionEnabled } = require('./encryption');

const EMPLOYEES_PATH  = path.join(__dirname, '..', 'employees.json');
const STATE_DIR       = path.join(__dirname, '..');
const TOKEN_PATH      = path.join(__dirname, '..', 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, a => resolve(a.trim())));

async function buildAuth() {
  if (!fs.existsSync(CREDENTIALS_PATH) || !fs.existsSync(TOKEN_PATH)) return null;
  try {
    const { client_secret, client_id, redirect_uris } = JSON.parse(fs.readFileSync(CREDENTIALS_PATH)).installed;
    const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    oAuth2.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
    return oAuth2;
  } catch {
    return null;
  }
}

async function deleteDriveFile(auth, fileId) {
  const drive = google.drive({ version: 'v3', auth });
  await drive.files.update({ fileId, requestBody: { trashed: true } });
}

async function deleteDriveFolder(auth, folderId) {
  const drive = google.drive({ version: 'v3', auth });
  await drive.files.update({ fileId: folderId, requestBody: { trashed: true } });
}

async function main() {
  if (!fs.existsSync(EMPLOYEES_PATH)) {
    console.log('No employees.json found.');
    process.exit(0);
  }

  let employees = JSON.parse(fs.readFileSync(EMPLOYEES_PATH, 'utf8'));
  if (employees.length === 0) {
    console.log('No employees registered.');
    process.exit(0);
  }

  console.log('\nRegistered employees:');
  employees.forEach((e, i) => console.log(`  ${i + 1}. ${e.employeeId} — ${e.name} (DOJ: ${e.doj})`));

  const id = await ask('\nEmployee ID to remove: ');
  const idx = employees.findIndex(e => e.employeeId === id);

  if (idx === -1) {
    console.error(`Employee "${id}" not found.`);
    rl.close();
    process.exit(1);
  }

  const emp = employees[idx];
  const confirm = await ask(`Remove ${emp.name} (${emp.employeeId})? This also deletes their state file. (yes/no): `);
  if (confirm.toLowerCase() !== 'yes') {
    console.log('Cancelled.');
    rl.close();
    process.exit(0);
  }

  // Remove from employees.json
  employees.splice(idx, 1);
  fs.writeFileSync(EMPLOYEES_PATH, JSON.stringify(employees, null, 2));
  console.log(`Removed ${emp.name} from employees.json`);

  // Delete status sheet from Google Drive (read fileId from state before deleting state file)
  const stateFile = path.join(STATE_DIR, `state-${id}.json`);
  if (fs.existsSync(stateFile)) {
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const state = (isEncryptionEnabled() && raw.includes('"ciphertext"')) ? JSON.parse(decrypt(raw)) : JSON.parse(raw);
      const sheetId = state.statusSheetId;
      if (sheetId) {
        const auth = await buildAuth();
        if (auth) {
          await deleteDriveFile(auth, sheetId);
          console.log(`Deleted status sheet from Drive (${sheetId})`);
        } else {
          console.warn('Could not authenticate with Google — status sheet NOT deleted from Drive.');
        }
      }
    } catch (err) {
      console.warn(`Could not delete status sheet from Drive: ${err.message}`);
    }
    fs.unlinkSync(stateFile);
    console.log(`Deleted state-${id}.json`);
  }

  // Delete activity log
  const logFile = path.join(STATE_DIR, 'logs', `${id}.log`);
  if (fs.existsSync(logFile)) {
    const keepLog = await ask('Keep activity log for audit? (yes/no): ');
    if (keepLog.toLowerCase() !== 'yes') {
      fs.unlinkSync(logFile);
      console.log(`Deleted logs/${id}.log`);
    }
  }

  // Offer to delete the employee's Drive folder (documents, subfolders, checklist)
  const driveFolderId = emp.driveFolderId;
  if (driveFolderId) {
    const deleteFolder = await ask(`Delete employee Drive folder from Google Drive? This removes all documents permanently. (yes/no): `);
    if (deleteFolder.toLowerCase() === 'yes') {
      const auth = await buildAuth();
      if (auth) {
        try {
          await deleteDriveFolder(auth, driveFolderId);
          console.log(`Deleted Drive folder (${driveFolderId})`);
        } catch (err) {
          console.warn(`Could not delete Drive folder: ${err.message}`);
        }
      } else {
        console.warn('Could not authenticate with Google — Drive folder NOT deleted.');
      }
    } else {
      console.log(`Drive folder kept (${driveFolderId}) — delete it manually if needed.`);
    }
  }

  console.log(`\nDone. Restart the engine if it is running, or call DELETE /employee/${id} first to stop active timers.`);
  rl.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  rl.close();
  process.exit(1);
});
