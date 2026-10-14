// Safety checks for the remove-employee script: it must only ever trash a folder / sheet that
// demonstrably belongs to THAT ONE employee — never the shared onboarding root folder (which holds
// every employee's folder) and never anything the state file merely happens to point at.
//
// Why this exists: before scaffolding finishes an employee's `driveFolderId` is the shared root, so a
// state file saved at that moment would make "delete the employee's folder" trash everyone's folders.

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

// Returns { safe: true } or { safe: false, reason } for trashing the employee's Drive folder.
//   meta      — { id, name, mimeType, parents } fetched live from Drive (null if it could not be read)
//   rootIds   — every folder ID known to be a shared root (state.rootFolderId, .env, employees.json)
function checkEmployeeFolder({ folderId, employeeId, meta, rootIds = [] }) {
  const roots = rootIds.filter(Boolean);
  if (!folderId) return { safe: false, reason: 'no folder ID recorded for this employee' };
  if (!employeeId) return { safe: false, reason: 'no employee ID given' };
  if (roots.includes(folderId)) {
    return { safe: false, reason: 'that folder is the SHARED onboarding root (it contains every employee\'s folder)' };
  }
  if (!meta) return { safe: false, reason: 'the folder could not be read from Drive, so it could not be verified' };
  if (meta.mimeType !== FOLDER_MIME) return { safe: false, reason: `it is not a folder (${meta.mimeType})` };
  if (!String(meta.name || '').endsWith(`_${employeeId}`)) {
    return { safe: false, reason: `its name "${meta.name}" does not end with "_${employeeId}", so it is not this employee's folder` };
  }
  // If we know the root, the employee folder must sit directly inside it
  const knownRoot = roots[0];
  if (knownRoot && Array.isArray(meta.parents) && meta.parents.length && !meta.parents.some(p => roots.includes(p))) {
    return { safe: false, reason: 'it is not inside the onboarding root folder' };
  }
  return { safe: true };
}

// Returns { safe: true } or { safe: false, reason } for trashing the employee's status sheet.
function checkEmployeeSheet({ sheetId, employeeId, meta }) {
  if (!sheetId) return { safe: false, reason: 'no sheet ID recorded' };
  if (!meta) return { safe: false, reason: 'the sheet could not be read from Drive, so it could not be verified' };
  if (meta.mimeType !== SHEET_MIME) return { safe: false, reason: `it is not a spreadsheet (${meta.mimeType})` };
  if (!String(meta.name || '').includes(`(${employeeId})`)) {
    return { safe: false, reason: `its name "${meta.name}" does not contain "(${employeeId})"` };
  }
  return { safe: true };
}

module.exports = { checkEmployeeFolder, checkEmployeeSheet };
