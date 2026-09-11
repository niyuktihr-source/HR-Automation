// formDocReconciler.js — recovers a joinee's pre-onboarding documents when the
// Apps Script → engine hand-off (webhookServer.js /preonboarding-details) failed
// and they were left stuck in the Google Form's own file-response storage instead
// of reaching the employee's Drive folder. Extracted out of index.js so it can be
// unit tested without loading the whole engine (index.js boots the app on require).
//
// Safety: once employee.formDocsReconciled is true, this never touches Drive for
// that employee again — see reconcileFormDocuments below for why that matters.

const config = require('./config');
const { findLatestFormRow } = require('./formRowMatcher');

async function fetchFormResponseRows(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const tab = meta.data.sheets[0].properties.title;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: tab });
  return res.data.values || [];
}

// Checks (and recovers) one employee's missing documents. Returns true if anything
// was actually recovered. Safe to call on every restart — once a full check has
// completed (employee.formDocsReconciled), it returns immediately without touching
// Drive again, so a document later removed on purpose (rejected upload, manual
// correction) is never silently re-added.
//
// deps: { handleNewFile, saveState, snapshotEmployee, activityLog } — injected so
// this module doesn't need to require the whole engine to run.
async function reconcileFormDocuments(auth, employee, formRowCache, deps) {
  const { handleNewFile, saveState, snapshotEmployee, activityLog } = deps;

  if (employee.formDocsReconciled) return false;
  if (!employee.driveFolderId) return false; // folder not scaffolded yet — try again next restart

  const { google } = require('googleapis');
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  const spreadsheetId = employee.isFresher
    ? (process.env.PREONBOARDING_RESPONSES_FRESHER_ID || '1PfoPQV_wghbxnzdUURD25pkvk6LeK8A52h42KkB4eSc')
    : (process.env.PREONBOARDING_RESPONSES_EXPERIENCED_ID || '1a8Qpu6LRu6XFxFOW2QlXZefkJnas6NKT-gwuMwT-Dk8');

  let recovered = false;
  try {
    if (!formRowCache[spreadsheetId]) {
      formRowCache[spreadsheetId] = await fetchFormResponseRows(sheets, spreadsheetId);
    }
    const match = findLatestFormRow(formRowCache[spreadsheetId], employee);
    if (!match) return false; // no response found yet — try again next run

    const { row, headers } = match;
    let anyChecked = false;

    for (let i = 0; i < headers.length; i++) {
      const title = (headers[i] || '').trim();
      const subfolder = config.formFileUploadMap[title];
      if (!subfolder) continue;
      const cell = (row[i] || '').trim();
      if (!cell) continue;
      const idMatch = cell.match(/[-\w]{25,}/); // Drive file ID out of the "open?id=" link
      if (!idMatch) continue;
      const fileId = idMatch[0];

      try {
        const subfolderRes = await drive.files.list({
          q: `name='${subfolder}' and '${employee.driveFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id)',
        });
        const subfolderId = subfolderRes.data.files && subfolderRes.data.files[0] && subfolderRes.data.files[0].id;
        if (!subfolderId) continue; // subfolder doesn't exist yet — scaffold incomplete, try again next run

        const existingRes = await drive.files.list({
          q: `'${subfolderId}' in parents and trashed=false`,
          fields: 'files(id)',
        });
        anyChecked = true;
        if (existingRes.data.files && existingRes.data.files.length > 0) continue; // already has something — never touch

        const fileMeta = await drive.files.get({ fileId, fields: 'name,mimeType' });
        const copy = await drive.files.copy({
          fileId,
          requestBody: { name: fileMeta.data.name, parents: [subfolderId] },
          fields: 'id,name,mimeType',
        });
        console.log(`[Reconcile] 📄 Recovered "${fileMeta.data.name}" from form response → ${subfolder} for ${employee.name} (${employee.employeeId})`);
        activityLog.log(employee, 'form_document_recovered', `${subfolder}: ${fileMeta.data.name}`);
        recovered = true;

        // Run it through the normal verification path, same as a fresh upload.
        const file = { id: copy.data.id, name: copy.data.name, mimeType: copy.data.mimeType || 'application/octet-stream' };
        await handleNewFile(auth, employee, file, subfolder).catch(err =>
          console.warn(`[Reconcile] handleNewFile error for recovered ${subfolder} doc: ${err.message}`)
        );
      } catch (err) {
        console.warn(`[Reconcile] Could not check/recover ${subfolder} for ${employee.name}: ${err.message}`);
      }
    }

    if (anyChecked) {
      employee.formDocsReconciled = true;
      saveState(employee.employeeId, snapshotEmployee(employee));
    }
  } catch (err) {
    console.warn(`[Reconcile] Form document reconciliation failed for ${employee.name}: ${err.message}`);
  }
  return recovered;
}

module.exports = { fetchFormResponseRows, reconcileFormDocuments };
