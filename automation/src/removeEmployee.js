// Remove an employee from employees.json and clean up their state files.
// Usage: npm run remove-employee

require('dotenv').config();
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { decrypt, isEncryptionEnabled } = require('./encryption');
const { checkEmployeeFolder, checkEmployeeSheet } = require('./folderGuard');

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

// Live name / type / parents of a Drive item, or null if it cannot be read — used to verify an item
// really belongs to the employee before anything is trashed (see folderGuard.js).
async function getDriveMeta(auth, fileId) {
  try {
    const drive = google.drive({ version: 'v3', auth });
    const r = await drive.files.get({ fileId, fields: 'id,name,mimeType,parents,trashed' });
    return r.data;
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

  // Call the live engine to stop in-memory timers before touching files.
  // If the engine isn't running this will fail silently — that's fine.
  const port = process.env.WEBHOOK_PORT || 3000;
  await new Promise(resolve => {
    const http = require('http');
    const reqData = JSON.stringify({ reason: 'Employee removed via remove-employee CLI' });
    const req = http.request({
      hostname: 'localhost',
      port,
      path: `/employee/${encodeURIComponent(id)}/stop`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqData) },
    }, res => {
      if (res.statusCode === 200) console.log(`[Engine] Live engine stopped timers for ${id}`);
      else console.log(`[Engine] Engine returned ${res.statusCode} for stop request — state file will be marked stopped directly`);
      resolve();
    });
    req.on('error', () => {
      console.log(`[Engine] Engine not running on port ${port} — will mark state file stopped directly`);
      resolve();
    });
    req.write(reqData);
    req.end();
  });

  // Delete status sheet from Google Drive (read fileId from state before deleting state file)
  const stateFile = path.join(STATE_DIR, `state-${id}.json`);
  let employeeFolderId = null;
  let stateRootFolderId = null;
  if (fs.existsSync(stateFile)) {
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const state = (isEncryptionEnabled() && raw.includes('"ciphertext"')) ? JSON.parse(decrypt(raw)) : JSON.parse(raw);
      employeeFolderId = state.driveFolderId || null;
      stateRootFolderId = state.rootFolderId || null;
      const sheetId = state.statusSheetId;
      if (sheetId) {
        const auth = await buildAuth();
        if (auth) {
          const sheetCheck = checkEmployeeSheet({ sheetId, employeeId: id, meta: await getDriveMeta(auth, sheetId) });
          if (sheetCheck.safe) {
            await deleteDriveFile(auth, sheetId);
            console.log(`Deleted status sheet from Drive (${sheetId})`);
          } else {
            console.warn(`Status sheet NOT deleted — safety check failed: ${sheetCheck.reason}.`);
          }
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
  // employees.json may still contain the shared onboarding root folder ID.
  // The state file contains the employee-specific folder ID after scaffolding.
  const driveFolderId = employeeFolderId;
  if (driveFolderId) {
    const deleteFolder = await ask(`Delete employee Drive folder from Google Drive? This removes all documents permanently. (yes/no): `);
    if (deleteFolder.toLowerCase() === 'yes') {
      const auth = await buildAuth();
      if (auth) {
        // Never trash the shared onboarding root or anything that isn't demonstrably THIS employee's folder
        const guard = checkEmployeeFolder({
          folderId: driveFolderId,
          employeeId: id,
          meta: await getDriveMeta(auth, driveFolderId),
          rootIds: [stateRootFolderId, process.env.ONBOARDING_ROOT_FOLDER_ID, emp.driveFolderId],
        });
        if (!guard.safe) {
          console.warn(`Drive folder NOT deleted — safety check failed: ${guard.reason}.`);
          console.warn(`Delete it by hand in Google Drive if it really is this employee's folder (${driveFolderId}).`);
        } else {
          try {
            await deleteDriveFolder(auth, driveFolderId);
            console.log(`Deleted Drive folder (${driveFolderId}) — moved to Drive's Trash (restorable for ~30 days)`);
          } catch (err) {
            console.warn(`Could not delete Drive folder: ${err.message}`);
          }
        }
      } else {
        console.warn('Could not authenticate with Google — Drive folder NOT deleted.');
      }
    } else {
      console.log(`Drive folder kept (${driveFolderId}) — delete it manually if needed.`);
    }
  } else if (emp.driveFolderId) {
    console.warn('Employee state did not contain a verified employee folder ID — Drive folder deletion skipped for safety.');
  }

  console.log(`\nDone. Restart the engine if it is running, or call DELETE /employee/${id} first to stop active timers.`);
  rl.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  rl.close();
  process.exit(1);
});
