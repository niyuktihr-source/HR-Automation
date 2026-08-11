// statusTracker.js — live Google Sheet dashboard per employee
//
// One sheet per employee, created inside their Drive folder.
// 15 milestone rows, 4 columns: Milestone | Status | Last Updated | Notes
//
// Milestones map to exact onboarding phases:
//  Row 1:  Pre-onboarding initiated
//  Row 2:  Documents received
//  Row 3:  Document issue — re-upload requested
//  Row 4:  Documents verified OK
//  Row 5:  Official email & greythr login confirmed
//  Row 6:  Manager confirmed seat and work location
//  Row 7:  IT team confirmed assets
//  Row 8:  BGV initiated and completed
//  Row 9:  HR induction scheduled
//  Row 10: Project intro meeting scheduled
//  Row 11: Day of Joining — onboarding complete
//  Row 12: 30-day catchup completed
//  Row 13: 60-day review completed
//  Row 14: 90-day review completed
//  Row 15: Pre-probation verification completed

const { google } = require('googleapis');
const config = require('./config');

// Retry async Google API calls on transient errors (429, 5xx, network)
async function apiWithRetry(fn, label, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.code || (err.response && err.response.status);
      const retryable = !status || status === 429 || status >= 500;
      if (attempt === maxAttempts || !retryable) throw err;
      const delay = attempt * 3000;
      console.warn(`[Status] "${label}" attempt ${attempt} failed (${err.message}) — retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

const STATUS = {
  PENDING:     config.statusSymbols.pending,
  IN_PROGRESS: config.statusSymbols.inProgress,
  DONE:        config.statusSymbols.done,
  ACTION_REQ:  config.statusSymbols.actionReq,
  NOT_OK:      config.statusSymbols.notOk,
};

const MILESTONES = [
  'Pre-onboarding initiated',           // 0
  'Documents received',                  // 1
  'Documents not ok — re-upload requested', // 2
  'Documents verified OK',              // 3
  'Official email & greythr login confirmed', // 4
  'Manager confirmed seat and work location', // 5
  'IT team confirmed assets',           // 6
  'BGV initiated and completed',        // 7
  'HR induction scheduled',             // 8
  'Project intro meeting scheduled',    // 9
  'Day of Joining — onboarding complete', // 10
  '25th day catchup call completed',    // 11
  '30-day catchup completed',           // 12
  '60-day review completed',            // 13
  '90-day review completed',            // 14
  'Pre-probation verification completed', // 15
];

function nowIST() {
  return new Date().toLocaleString('en-IN', { timeZone: config.timezone });
}

// ─── Get or create the status sheet for an employee ──────────────────────────
async function getOrCreateStatusSheet(auth, employee) {
  if (employee.statusSheetId) return employee.statusSheetId;

  const drive  = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  // Status sheet goes in the employee's own subfolder (not root)
  const targetFolderId = employee.driveFolderId || employee.rootFolderId;
  console.log(`[Status] Creating sheet for ${employee.name} in folder ${targetFolderId}`);

  // Check if sheet already exists in employee subfolder
  const existing = await apiWithRetry(() => drive.files.list({
    q: `name='Onboarding Status — ${employee.name} (${employee.employeeId})' and '${targetFolderId}' in parents and trashed=false`,
    fields: 'files(id)',
  }), 'getOrCreateStatusSheet:list');

  if (existing.data.files.length > 0) {
    employee.statusSheetId = existing.data.files[0].id;
    console.log(`[Status] Found existing status sheet for ${employee.name}`);
    return employee.statusSheetId;
  }

  // Copy from master template if configured, otherwise create blank
  const templateId = process.env.ONBOARDING_STATUS_TEMPLATE_ID;
  let spreadsheetId;

  if (templateId) {
    const copy = await apiWithRetry(() => drive.files.copy({
      fileId: templateId,
      requestBody: {
        name: `Onboarding Status — ${employee.name} (${employee.employeeId})`,
        parents: [targetFolderId],
      },
      fields: 'id',
    }), 'getOrCreateStatusSheet:copyTemplate');
    spreadsheetId = copy.data.id;
    console.log(`[Status] Copied master template for ${employee.name}`);
  } else {
    const spreadsheet = await apiWithRetry(() => sheets.spreadsheets.create({
      requestBody: {
        properties: { title: `Onboarding Status — ${employee.name} (${employee.employeeId})` },
        sheets: [{ properties: { title: 'Status' } }],
      },
    }), 'getOrCreateStatusSheet:create');
    spreadsheetId = spreadsheet.data.spreadsheetId;

    // Move out of My Drive into employee folder
    const fileMeta = await drive.files.get({ fileId: spreadsheetId, fields: 'parents' });
    const currentParents = (fileMeta.data.parents || []).join(',');
    await drive.files.update({
      fileId: spreadsheetId,
      addParents: targetFolderId,
      removeParents: currentParents,
      fields: 'id, parents',
    });
  }

  // Write initial milestone data (statuses only — template already has formatting)
  const now = nowIST();
  const doneLabel = STATUS.DONE;
  const total = MILESTONES.length;
  const lastRow = 2 + total;
  const countifFormula = `=COUNTIF(B3:B${lastRow},"${doneLabel}")/${total}`;
  const pctFormula = `=TEXT(COUNTIF(B3:B${lastRow},"${doneLabel}")/${total},"0%")&" Complete ("&COUNTIF(B3:B${lastRow},"${doneLabel}")&"/${total})"`;
  const rows = [
    ['Onboarding Progress', countifFormula, '', pctFormula],
    ['Milestone', 'Status', 'Last Updated', 'Notes'],
    ...MILESTONES.map((m, i) => [
      m,
      i === 0 ? STATUS.IN_PROGRESS : STATUS.PENDING,
      i === 0 ? now : '',
      '',
    ]),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Status!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  if (!templateId) {
    // Format only needed when creating from scratch (template already has formatting)
    const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
    const sheetId = sheetMeta.data.sheets[0].properties.sheetId;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.13, green: 0.55, blue: 0.13 },
                  textFormat: { bold: true, fontSize: 12, foregroundColor: { red: 1, green: 1, blue: 1 } },
                  horizontalAlignment: 'CENTER',
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
            },
          },
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.15, green: 0.15, blue: 0.15 },
                  textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          },
          {
            mergeCells: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
              mergeType: 'MERGE_ALL',
            },
          },
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: 'PERCENT', pattern: '0%' },
                  backgroundColor: { red: 0.13, green: 0.55, blue: 0.13 },
                  textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } },
                  horizontalAlignment: 'CENTER',
                },
              },
              fields: 'userEnteredFormat(numberFormat,backgroundColor,textFormat,horizontalAlignment)',
            },
          },
          {
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 5 },
            },
          },
        ],
      },
    });
  }

  employee.statusSheetId = spreadsheetId;
  console.log(`[Status] Created status sheet for ${employee.name} → https://docs.google.com/spreadsheets/d/${spreadsheetId}`);

  return spreadsheetId;
}

// ─── Update a single milestone row ───────────────────────────────────────────
async function updateMilestone(auth, employee, milestoneIndex, status, notes = '') {
  try {
    const spreadsheetId = await getOrCreateStatusSheet(auth, employee);
    const sheets = google.sheets({ version: 'v4', auth });

    const rowNum = milestoneIndex + 3;
    await apiWithRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Status!B${rowNum}:D${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status, nowIST(), notes]] },
    }), `updateMilestone:${milestoneIndex}`);

    console.log(`[Status] "${MILESTONES[milestoneIndex]}" → ${status}${notes ? ' | ' + notes : ''}`);
  } catch (err) {
    console.error(`[Status] Failed to update milestone ${milestoneIndex}:`, err.message);
  }
}

// ─── Named milestone updaters ─────────────────────────────────────────────────

async function markPreonboardingInitiated(auth, employee) {
  await updateMilestone(auth, employee, 0, STATUS.DONE);
}

async function markDocumentsReceived(auth, employee, docType) {
  // Don't downgrade if documents are already fully verified (row 6 = milestone index 3)
  const sheets = google.sheets({ version: 'v4', auth });
  try {
    const spreadsheetId = await getOrCreateStatusSheet(auth, employee);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Status!B6',
    });
    const currentStatus = (res.data.values && res.data.values[0] && res.data.values[0][0]) || '';
    if (currentStatus === STATUS.DONE) return;
  } catch { /* fall through and update anyway */ }
  await updateMilestone(auth, employee, 1, STATUS.IN_PROGRESS, docType || '');
}

async function markDocumentIssue(auth, employee, docType, reason) {
  await updateMilestone(auth, employee, 2, STATUS.NOT_OK, `${docType}: ${reason}`);
}

async function markDocumentsVerifiedOk(auth, employee) {
  // Only mark the "Documents not ok" row (index 2) as Done if it was previously set to NOT_OK
  // (i.e. a rejection was issued). If no rejection ever happened, leave row 2 as Pending.
  const sheets = google.sheets({ version: 'v4', auth });
  try {
    const spreadsheetId = await getOrCreateStatusSheet(auth, employee);
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Status!B5' });
    const current = (res.data.values && res.data.values[0] && res.data.values[0][0]) || '';
    if (current === STATUS.NOT_OK) {
      await updateMilestone(auth, employee, 2, STATUS.DONE, 'Issue resolved — all documents verified');
    }
  } catch { /* fall through */ }
  await updateMilestone(auth, employee, 1, STATUS.DONE);
  await updateMilestone(auth, employee, 3, STATUS.DONE);
}

async function markOfficialEmailConfirmed(auth, employee, officialEmail) {
  await updateMilestone(auth, employee, 4, STATUS.DONE, officialEmail || '');
}

async function markManagerConfirmed(auth, employee, details) {
  const notes = [details.officeLocation, details.assetType, details.supervisorName]
    .filter(Boolean).join(' | ');
  await updateMilestone(auth, employee, 5, STATUS.DONE, notes);
}

async function markITConfirmed(auth, employee) {
  await updateMilestone(auth, employee, 6, STATUS.DONE);
}

async function markBGVDone(auth, employee) {
  await updateMilestone(auth, employee, 7, STATUS.DONE);
}

async function markHRInductionScheduled(auth, employee) {
  await updateMilestone(auth, employee, 8, STATUS.IN_PROGRESS);
}

async function markHRInductionDone(auth, employee) {
  await updateMilestone(auth, employee, 8, STATUS.DONE);
}

async function markProjectIntroScheduled(auth, employee) {
  await updateMilestone(auth, employee, 9, STATUS.IN_PROGRESS);
}

async function markProjectIntroDone(auth, employee) {
  await updateMilestone(auth, employee, 9, STATUS.DONE);
}

async function markOnboardingComplete(auth, employee) {
  await updateMilestone(auth, employee, 10, STATUS.DONE);
}

async function mark25DayCatchupDone(auth, employee) {
  await updateMilestone(auth, employee, 11, STATUS.DONE);
}

async function mark30DayDone(auth, employee) {
  await updateMilestone(auth, employee, 12, STATUS.DONE);
}

async function mark60DayDone(auth, employee) {
  await updateMilestone(auth, employee, 13, STATUS.DONE);
}

async function mark90DayDone(auth, employee) {
  await updateMilestone(auth, employee, 14, STATUS.DONE);
}

async function markPreprobationDone(auth, employee) {
  await updateMilestone(auth, employee, 15, STATUS.DONE);
  await revokeEmployeeSheetAccess(auth, employee);
}

async function markOnboardingStopped(auth, employee, reason) {
  const note = `STOPPED — ${reason || 'Candidate did not join'}`;
  // Mark milestone 0 as NOT_OK / ACTION_REQ with note
  await updateMilestone(auth, employee, 0, STATUS.NOT_OK, note);
}

// Revoke the employee's view access to their status sheet once onboarding is fully complete
async function revokeEmployeeSheetAccess(auth, employee) {
  const spreadsheetId = employee.statusSheetId;
  if (!spreadsheetId) return;

  const emailToRevoke = employee.personalEmail || employee.officialEmail;
  if (!emailToRevoke) return;

  try {
    const drive = google.drive({ version: 'v3', auth });

    // List all permissions on the sheet to find the employee's permission ID
    const perms = await drive.permissions.list({
      fileId: spreadsheetId,
      fields: 'permissions(id, emailAddress, role)',
    });

    const empPerm = (perms.data.permissions || []).find(
      p => p.emailAddress && p.emailAddress.toLowerCase() === emailToRevoke.toLowerCase()
    );

    if (!empPerm) {
      console.log(`[Status] No active permission found for ${emailToRevoke} on status sheet — nothing to revoke`);
      return;
    }

    await drive.permissions.delete({
      fileId: spreadsheetId,
      permissionId: empPerm.id,
    });

    console.log(`[Status] Revoked sheet access for ${emailToRevoke} — onboarding complete`);
  } catch (err) {
    console.warn(`[Status] Could not revoke sheet access for ${emailToRevoke}: ${err.message}`);
  }
}

// Rename all employee Google Sheets using the legally correct name from Aadhaar.
// Called after Aadhaar is verified — recruiter may have entered the wrong name.
async function renameStatusSheet(auth, employee, aadhaarName) {
  if (!aadhaarName) return;
  const drive = google.drive({ version: 'v3', auth });
  const id = employee.employeeId;

  const sheetsToRename = [
    { fileId: employee.statusSheetId,       newName: `Onboarding Status — ${aadhaarName} (${id})` },
    { fileId: employee.employeeInfoSheetId, newName: `AL_DI_HR_018 — Onboarding Employee Information — ${aadhaarName} (${id})` },
    { fileId: employee.projectIntroSheetId, newName: `AL_DI_HR_019 Project Introduction — ${aadhaarName} (${id})` },
  ].filter(s => s.fileId);

  for (const { fileId, newName } of sheetsToRename) {
    try {
      await drive.files.update({ fileId, requestBody: { name: newName } });
      console.log(`[Status] Renamed sheet → ${newName}`);
    } catch (err) {
      console.warn(`[Status] Could not rename sheet ${fileId} for ${employee.name}: ${err.message}`);
    }
  }
}

module.exports = {
  STATUS,
  MILESTONES,
  getOrCreateStatusSheet,
  updateMilestone,
  markPreonboardingInitiated,
  markDocumentsReceived,
  markDocumentIssue,
  markDocumentsVerifiedOk,
  markOfficialEmailConfirmed,
  markManagerConfirmed,
  markITConfirmed,
  markBGVDone,
  markHRInductionScheduled,
  markHRInductionDone,
  markProjectIntroScheduled,
  markProjectIntroDone,
  markOnboardingComplete,
  mark25DayCatchupDone,
  mark30DayDone,
  mark60DayDone,
  mark90DayDone,
  markPreprobationDone,
  markOnboardingStopped,
  revokeEmployeeSheetAccess,
  renameStatusSheet,
  createProjectIntroSheet,
  createEmployeeInfoSheet,
};

// ─── Project Intro Sheet ───────────────────────────────────────────────────────
// Creates a Google Sheet in the employee's Reports folder with all known details
// pre-filled. Manager fills in Key Projects, Initial Goals, and Buddy Name.
// Returns the sheet URL, or null on failure.
async function createProjectIntroSheet(auth, employee) {
  const drive  = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  // Search Drive by employee ID if we don't have the sheet ID in memory (survives renames)
  if (!employee.projectIntroSheetId) {
    try {
      const found = await drive.files.list({
        q: `name contains '(${employee.employeeId})' and name contains 'AL_DI_HR_019' and trashed=false`,
        fields: 'files(id, name)',
        pageSize: 5,
      });
      if (found.data.files && found.data.files.length > 0) {
        employee.projectIntroSheetId = found.data.files[0].id;
        console.log(`[Status] Found existing project intro sheet for ${employee.name} via Drive search: ${employee.projectIntroSheetId}`);
      }
    } catch (err) {
      console.warn(`[Status] Drive search for project intro sheet failed for ${employee.name}: ${err.message}`);
    }
  }

  if (employee.projectIntroSheetId) {
    return `https://docs.google.com/spreadsheets/d/${employee.projectIntroSheetId}`;
  }
  const { name, employeeId, doj, officialEmail, personalEmail, contacts } = employee;
  const managerEmail = (contacts && contacts.managerEmail) || '—';
  const recruiterEmail = (contacts && contacts.recruiterEmail) || '—';

  // Tracking tab rows — matches AL_DI_HR_019 template exactly
  // Month -3 gets one extra question (probation confirmation)
  function trackingRows(includesProbationQuestion) {
    const rows = [
      ['Tasks Assigned', 'Task/ Training 1: Completion Percentage: Mention percentage only (For example 100% )Proficiency achieved on the tasks completed: Task/ Training 2:', ''],
      ['', '', ''],
      ['', '', ''],
      ['', '', ''],
      ['', 'Lead\'s Observations on the tasks assigned', 'Suggestions for improvements from the lead'],
      ['PERSONAL QUALITY\n1.Timely and accurate completion of activities with desired standards\n2.Takes initiative and is innovative\n3.Flexible and effective in taking up new challenges\n4.Response time', '', ''],
      ['TEAMWORK\nCo-operation with other team members', '', ''],
      ['LEADERSHIP\nAbility to plan\nOrganize\nDelegate\nControl', '', ''],
      ['COMMUNICATIONClarity  and Conciseness in one-to-one and group discussions', '', ''],
      ['Ownership & Accountability', '', ''],
      ['', '', ''],
      ['', '', ''],
      ['Filled by Recruiter', 'Filled by Recruiter', ''],
      ['Do you have any other concerns apart from technical output which is impacting the work currently ?', '', ''],
      ['Do you have any concerns on the time taken to complete the assigned tasks/training and/or the quality of the output?', '', ''],
    ];
    if (includesProbationQuestion) {
      rows.push(['Do you feel the probation will be confirmed or will it be extended ?', '', '']);
    }
    rows.push(['', '', '']);
    rows.push(['Summary', '', '']);
    return rows;
  }

  const templateId = process.env.PROJECT_INTRO_TEMPLATE_ID;

  try {
    let spreadsheetId;

    if (templateId) {
      // Copy the master template sheet
      const copy = await apiWithRetry(() => drive.files.copy({
        fileId: templateId,
        requestBody: { name: `AL_DI_HR_019 Project Introduction — ${name} (${employeeId})` },
      }), 'createProjectIntroSheet:copy');
      spreadsheetId = copy.data.id;
      console.log(`[Status] Project intro sheet copied from template for ${name}: ${spreadsheetId}`);

      // Update the "Details of New Joinee & Task" tab with employee info
      const dojStr = employee.doj || '';
      const teamJoined = employee.team || employee.department || '';
      const reportingManager = (contacts && contacts.managerName) || managerEmail || '';
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "'Details of New Joinee & Task'!B2",
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[name]] },
      }).catch(() => {});
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "'Details of New Joinee & Task'!B3",
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[employeeId]] },
      }).catch(() => {});
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "'Details of New Joinee & Task'!B4",
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[dojStr]] },
      }).catch(() => {});
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "'Details of New Joinee & Task'!B5",
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[teamJoined]] },
      }).catch(() => {});
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "'Details of New Joinee & Task'!B6",
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[reportingManager]] },
      }).catch(() => {});
    } else {
      // Fallback: build from scratch (legacy path, used if env var not set)
      const spreadsheet = await apiWithRetry(() => sheets.spreadsheets.create({
      requestBody: {
        properties: { title: `AL_DI_HR_019 Project Introduction — ${name} (${employeeId})` },
        sheets: [
          { properties: { title: 'Document Version history', sheetId: 0 } },
          { properties: { title: 'Details of New Joinee & Task', sheetId: 1 } },
          { properties: { title: 'Tracking - Month -1', sheetId: 2 } },
          { properties: { title: 'Tracking - Month -2', sheetId: 3 } },
          { properties: { title: 'Tracking - Month -3', sheetId: 4 } },
        ],
      },
    }), 'createProjectIntroSheet:create');

      spreadsheetId = spreadsheet.data.spreadsheetId;
    } // end else (legacy build-from-scratch)

    // ── Tab 1: Document Version history (legacy only — skipped when using template) ──
    if (!templateId) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "'Document Version history'!A1",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [
        ['', '', 'Project Introduction- Template', '', '', '', '', ''],
        ['', '', 'Revision History', '', '', '', '', ''],
        [],
        ['AL/DI/HR/019', '', 'Date: 12.09.2025', '', 'Rev No:', '1.2', 'Date:', '12.09.2025'],
        ['Revision Number', 'Date', 'Page Number/ Section', 'Description of Changes', 'Basis for Change', 'Author / Prepared by', 'Reviewed By', 'Approved by'],
        ['1.0', '20-June-2024', 'All', 'Internal quality audit', 'ISO Audit', 'Divya Rodrigues', 'Rubina Mallick', 'Gagan Mittal'],
        ['1.1', '14 March-2025', 'Monthly tracking', 'Format is changed', 'Internal audit', 'Divya Rodrigues', 'Rubina Mallick', 'Gagan Mittal'],
        ['1.2', '12 September-2025', 'Monthly tracking', 'Format is changed', 'Internal audit', 'Divya Rodrigues', 'Rubina Mallick', 'Gagan Mittal'],
      ]},
    });

    // Format Document Version history tab
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [
        // Title rows — bold, blue, centered
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 2 },
            cell: { userEnteredFormat: {
              textFormat: { bold: true, fontSize: 13, foregroundColor: { red: 0.12, green: 0.33, blue: 0.71 } },
              horizontalAlignment: 'CENTER',
            }},
            fields: 'userEnteredFormat(textFormat,horizontalAlignment)',
          },
        },
        // Meta row (row 4, 0-indexed: 3) — bold
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 3, endRowIndex: 4 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat(textFormat)',
          },
        },
        // Column header row (row 5, 0-indexed: 4) — bold teal
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 4, endRowIndex: 5 },
            cell: { userEnteredFormat: {
              textFormat: { bold: true },
              backgroundColor: { red: 0.69, green: 0.91, blue: 0.90 },
            }},
            fields: 'userEnteredFormat(textFormat,backgroundColor)',
          },
        },
        // Wrap all
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 10 },
            cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
            fields: 'userEnteredFormat(wrapStrategy)',
          },
        },
        // Auto-resize columns
        { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 9 } } },
      ]},
    });

    // ── Tab 2: Details of New Joinee & Task ──────────────────────────────────
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "'Details of New Joinee & Task'!A1",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [
        ['Details of New Joinee & Task'],
        [`Name: ${name}\nDOJ: ${doj}\nTeam Joined: \nReporting Manager: ${managerEmail}\nProject Buddy:`],
        ['Key Areas of Responsibilities:\n1.\n2.\n3.'],
        ['Objectives:\n1.\n2.\n3.'],
        ['Task/ Training Schedule:'],
      ]},
    });

    // ── Tabs 3/4/5: Tracking Month -1 / -2 / -3 ─────────────────────────────
    const trackingTabs = [
      { title: 'Tracking - Month -1', sheetId: 2, probation: false },
      { title: 'Tracking - Month -2', sheetId: 3, probation: true },
      { title: 'Tracking - Month -3', sheetId: 4, probation: true },
    ];

    // Row indices (0-based, after title row at index 0):
    // index 1 = Tasks Assigned header, 2-4 = task rows, 5 = Lead's Observations header
    // index 6 = PERSONAL QUALITY, 7 = TEAMWORK, 8 = LEADERSHIP, 9 = COMMUNICATION, 10 = Ownership
    // index 11-12 = blank, 13 = Filled by Recruiter, 14+ = recruiter questions
    const DROPDOWN_OPTIONS = { type: 'ONE_OF_LIST', values: ['Good', 'Satisfactory', 'Bad'], showCustomUi: true, strict: true };
    // Quality rows where manager fills columns B and C with dropdown
    const QUALITY_ROW_INDICES = [6, 7, 8, 9, 10]; // PERSONAL QUALITY, TEAMWORK, LEADERSHIP, COMMUNICATION, Ownership

    for (const tab of trackingTabs) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${tab.title}'!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[tab.title], ...trackingRows(tab.probation)] },
      });

      // Build dropdown validation requests for quality rows (columns B and C)
      const dropdownRequests = QUALITY_ROW_INDICES.flatMap(rowIdx => [
        {
          setDataValidation: {
            range: { sheetId: tab.sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 1, endColumnIndex: 3 },
            rule: {
              condition: {
                type: DROPDOWN_OPTIONS.type,
                values: DROPDOWN_OPTIONS.values.map(v => ({ userEnteredValue: v })),
              },
              showCustomUi: DROPDOWN_OPTIONS.showCustomUi,
              strict: DROPDOWN_OPTIONS.strict,
            },
          },
        },
      ]);

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [
          // Bold centred title row
          {
            repeatCell: {
              range: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: {
                textFormat: { bold: true, fontSize: 11 },
                horizontalAlignment: 'CENTER',
              }},
              fields: 'userEnteredFormat(textFormat,horizontalAlignment)',
            },
          },
          // "Lead's Observations" sub-header row (index 5) — bold teal
          {
            repeatCell: {
              range: { sheetId: tab.sheetId, startRowIndex: 5, endRowIndex: 6 },
              cell: { userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.69, green: 0.91, blue: 0.90 },
              }},
              fields: 'userEnteredFormat(textFormat,backgroundColor)',
            },
          },
          // Quality rows (6-10) — light grey background to indicate fillable
          {
            repeatCell: {
              range: { sheetId: tab.sheetId, startRowIndex: 6, endRowIndex: 11, startColumnIndex: 1, endColumnIndex: 3 },
              cell: { userEnteredFormat: {
                backgroundColor: { red: 0.95, green: 0.98, blue: 0.95 },
              }},
              fields: 'userEnteredFormat(backgroundColor)',
            },
          },
          // "Filled by Recruiter" row (index 13) — grey background
          {
            repeatCell: {
              range: { sheetId: tab.sheetId, startRowIndex: 13, endRowIndex: 14 },
              cell: { userEnteredFormat: {
                backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 },
                textFormat: { bold: true },
              }},
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          },
          // Merge title row A1:C1
          {
            mergeCells: {
              range: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 },
              mergeType: 'MERGE_ALL',
            },
          },
          // Wrap all rows
          {
            repeatCell: {
              range: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: 20 },
              cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
              fields: 'userEnteredFormat(wrapStrategy)',
            },
          },
          // Column widths: A=280, B=300, C=280
          { updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 280 }, fields: 'pixelSize' } },
          { updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 300 }, fields: 'pixelSize' } },
          { updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 280 }, fields: 'pixelSize' } },
          // Dropdown validations for quality rows
          ...dropdownRequests,
        ]},
      });
    }

    // ── Format Details tab ────────────────────────────────────────────────────
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [
        {
          repeatCell: {
            range: { sheetId: 1, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: {
              textFormat: { bold: true, fontSize: 12 },
              horizontalAlignment: 'CENTER',
            }},
            fields: 'userEnteredFormat(textFormat,horizontalAlignment)',
          },
        },
        {
          mergeCells: {
            range: { sheetId: 1, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 },
            mergeType: 'MERGE_ALL',
          },
        },
        { updateDimensionProperties: { range: { sheetId: 1, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 500 }, fields: 'pixelSize' } },
      ]},
    });

    } // end if (!templateId) legacy block

    // ── Move to employee's Reports folder ─────────────────────────────────────
    const reportsFolder = await drive.files.list({
      q: `name='Reports' and '${employee.driveFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    }).catch(() => null);
    const targetFolderId = (reportsFolder && reportsFolder.data.files.length > 0)
      ? reportsFolder.data.files[0].id
      : employee.driveFolderId;

    const introFileMeta = await drive.files.get({ fileId: spreadsheetId, fields: 'parents' });
    const introCurrentParents = (introFileMeta.data.parents || []).join(',');
    await drive.files.update({
      fileId: spreadsheetId,
      addParents: targetFolderId,
      removeParents: introCurrentParents,
      fields: 'id, parents',
    });

    // ── Share with manager and recruiter only — joinee has no access ─────────
    const shareWith = [managerEmail, recruiterEmail].filter(e => e && e !== '—');
    for (const email of [...new Set(shareWith)]) {
      await drive.permissions.create({
        fileId: spreadsheetId,
        requestBody: { type: 'user', role: 'writer', emailAddress: email },
        sendNotificationEmail: false,
      }).catch(() => {});
    }

    employee.projectIntroSheetId = spreadsheetId;
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    console.log(`[Status] Project intro sheet created for ${name}: ${sheetUrl}`);
    return sheetUrl;
  } catch (err) {
    console.error(`[Status] createProjectIntroSheet failed for ${name}: ${err.message}`);
    return null;
  }
}

// ─── Employee Info Sheet (AL/DI/HR/018) ──────────────────────────────────────
// Creates the Onboarding Employee Information sheet with 3 tabs:
//   1. Document Version history
//   2. Personal Details
//   3. Education & Professional Detail
// AI-extracted fields are pre-filled where available; rest left blank for HR.
async function createEmployeeInfoSheet(auth, employee) {
  const sheets = google.sheets({ version: 'v4', auth });
  const drive  = google.drive({ version: 'v3', auth });
  const { name, employeeId, doj, officialEmail, personalEmail, contacts } = employee;
  const ex = employee.extractedData || {};
  const pd = employee.personalDetails || {};

  // If we don't have the sheet ID in memory, search Drive by employee ID (survives renames)
  if (!employee.employeeInfoSheetId) {
    try {
      const found = await drive.files.list({
        q: `name contains '(${employeeId})' and name contains 'AL_DI_HR_018' and trashed=false`,
        fields: 'files(id, name)',
        pageSize: 5,
      });
      if (found.data.files && found.data.files.length > 0) {
        employee.employeeInfoSheetId = found.data.files[0].id;
        console.log(`[Status] Found existing employee info sheet for ${name} via Drive search: ${employee.employeeInfoSheetId}`);
      }
    } catch (err) {
      console.warn(`[Status] Drive search for employee info sheet failed for ${name}: ${err.message}`);
    }
  }

  // If sheet already exists, update both personal details and education with latest extracted data
  if (employee.employeeInfoSheetId) {
    const v = (val) => (val != null && val !== '' ? String(val) : '');

    function calcAge(dobStr) {
      if (!dobStr) return '';
      const parts = dobStr.split('/');
      if (parts.length !== 3) return '';
      const dob = new Date(+parts[2], +parts[1] - 1, +parts[0]);
      if (isNaN(dob)) return '';
      const now = new Date();
      let age = now.getFullYear() - dob.getFullYear();
      if (now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())) age--;
      return String(age);
    }

    const aadhaar  = ex.aadhaar            || {};
    const pan      = ex.pan                || {};
    const m10      = ex.marksheet10th      || {};
    const m12      = ex.marksheet12th      || {};
    const degree   = ex.degreeCertificate  || {};
    const postgrad = ex.postgradCertificate|| {};
    const reliev   = ex.relievingLetter    || {};

    try {
      // Update personal details rows (C2:C36 — value column only, preserves labels)
      const personalValueRows = [
        [v(pan.name)],
        [v(aadhaar.name)],
        [v(pan.name)],
        [v(aadhaar.dob || pan.dob)],
        [calcAge(aadhaar.dob || pan.dob)],
        [v(pan.fatherName)],
        [v(pd["Mother's Name"])],
        [v(pd['Marital Status'])],
        [v(pd['Name of Spouse'])],
        [v(pd['DOB of Spouse'])],
        [v(pd['Profession of Spouse'])],
        [v(pd['No of children'])],
        [v(pd['Name of child'])],
        [v(pd['DOB of child'])],
        [v(pd['Gender of child'])],
        [v(employee.phoneNumber)],
        [v(pd['Emergency Contact no (From Family)'])],
        [v(pd['Emergency Contact Person Name and Relationship'])],
        [v(pd['Nominee details for Group Insurance'])],
        [v(personalEmail)],
        [v(aadhaar.address)],
        [v(aadhaar.address)],
        [''],
        [''],
        [''],
      ];
      await apiWithRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: employee.employeeInfoSheetId,
        range: `'Personal Details'!C2:C26`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: personalValueRows },
      }), 'updatePersonalDetailsTab');

      // Update PAN and Aadhaar numbers in documentation list
      await apiWithRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: employee.employeeInfoSheetId,
        range: `'Personal Details'!C29:C30`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[v(pan.panNumber)], [v(aadhaar.aadhaarNumber)]] },
      }), 'updateDocNumbers');

      // Update education data rows
      const eduDataRows = [
        ['10th Marksheet',            'y/n', 'y/n', v(m10.board),    '',                    v(m10.yearOfCompletion),    v(m10.totalMarks),    v(m10.schoolName)],
        ['12th/Diploma Marksheet',    'y/n', 'y/n', v(m12.board),    v(m12.specialization), v(m12.yearOfCompletion),    v(m12.totalMarks),    v(m12.schoolName)],
        ['Graduation Consolidated Marksheet and Degree Certificate', 'y/n', 'y/n', v(degree.degree), v(degree.specialization), v(degree.yearOfCompletion), v(degree.totalMarks), v(degree.collegeName)],
        ['Post Graduation Consolidated Marksheet and Degree Certificate', 'y/n', 'y/n', v(postgrad.degree), v(postgrad.specialization), v(postgrad.yearOfCompletion), v(postgrad.totalMarks), v(postgrad.collegeName), '(Not Mandatory)'],
      ];
      await apiWithRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: employee.employeeInfoSheetId,
        range: `'Education & Professional Detail'!A3:I6`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: eduDataRows },
      }), 'updateEducationTab');

      console.log(`[Status] Personal details and education tabs updated for ${name}`);
    } catch (err) {
      console.warn(`[Status] Could not update info sheet tabs for ${name}: ${err.message}`);
    }
    return `https://docs.google.com/spreadsheets/d/${employee.employeeInfoSheetId}`;
  }

  // Helper to pull extracted value or blank
  const v = (val) => (val != null && val !== '' ? String(val) : '');

  // Calculate age from DD/MM/YYYY string
  function calcAge(dobStr) {
    if (!dobStr) return '';
    const parts = dobStr.split('/');
    if (parts.length !== 3) return '';
    const dob = new Date(+parts[2], +parts[1] - 1, +parts[0]);
    if (isNaN(dob)) return '';
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    if (now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())) age--;
    return String(age);
  }

  const aadhaar  = ex.aadhaar            || {};
  const pan      = ex.pan                || {};
  const reliev   = ex.relievingLetter    || {};
  const m10      = ex.marksheet10th      || {};
  const m12      = ex.marksheet12th      || {};
  const degree   = ex.degreeCertificate  || {};
  const postgrad = ex.postgradCertificate|| {};

  try {
    // ── Create workbook with 3 tabs ──────────────────────────────────────────
    const spreadsheet = await apiWithRetry(() => sheets.spreadsheets.create({
      requestBody: {
        properties: { title: `AL_DI_HR_018 — Onboarding Employee Information — ${name} (${employeeId})` },
        sheets: [
          { properties: { title: 'Document Version history', index: 0 } },
          { properties: { title: 'Personal Details',         index: 1 } },
          { properties: { title: 'Education & Professional Detail', index: 2 } },
        ],
      },
    }), 'createEmployeeInfoSheet:create');

    const spreadsheetId = spreadsheet.data.spreadsheetId;
    const tabIds = {};
    for (const s of spreadsheet.data.sheets) {
      tabIds[s.properties.title] = s.properties.sheetId;
    }

    // ── Tab 1: Document Version history ─────────────────────────────────────
    await apiWithRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "'Document Version history'!A1",
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [
          ['', '', 'Onboarding Employee Information- Template', '', '', '', '', ''],
          ['', '', 'Revision History', '', '', '', '', ''],
          [],
          ['AL/DI/HR/018', '', 'Date: 17.06.2025', '', 'Rev No:', '1.1', 'Date:', '17/06/2025'],
          ['Revision Number', 'Date', 'Page Number/ Section', 'Description of Changes', 'Basis for Change', 'Author / Prepared by', 'Reviewed By', 'Approved by'],
          ['1.0', '20-June-2024', 'All', 'First Draft', 'Internal quality audit', 'Divya Rodrigues', 'Rubina Mallick', 'Gagan Mittal'],
          ['1.1', '17- June-2025', 'Personal Details', 'Personal Details- Nominee details for Group Insurance', 'Internal review', 'Rubina Mallick', 'Divya Rodrigues', 'Gagan Mittal'],
        ],
      },
    }), 'docVersionHistory:values');

    // ── Tab 2: Personal Details ──────────────────────────────────────────────
    // Column A: row number / label | Column B: field label | Column C: value (AI pre-filled where possible)
    const personalRows = [
      ['', 'Personal Details', ''],
      ['1',  'Name as per PAN',          v(pan.name)],
      ['2',  'Name as per AADHAAR',      v(aadhaar.name)],
      ['3',  'Name as per bank records', v(pan.name)],
      ['4',  'Date of Birth',            v(aadhaar.dob || pan.dob)],
      ['5',  'Age',                      calcAge(aadhaar.dob || pan.dob)],
      ['6',  "Father's Name",            v(pan.fatherName)],
      ['7',  "Mother's Name",            v(pd["Mother's Name"])],
      ['8',  'Marital Status',           v(pd['Marital Status'])],
      ['9',  'Name of Spouse',           v(pd['Name of Spouse'])],
      ['10', 'DOB of Spouse',            v(pd['DOB of Spouse'])],
      ['11', 'Profession of Spouse',     v(pd['Profession of Spouse'])],
      ['12', 'No of children',           v(pd['No of children'])],
      ['13', 'Name of child',            v(pd['Name of child'])],
      ['14', 'DOB of child',             v(pd['DOB of child'])],
      ['15', 'Gender of child',          v(pd['Gender of child'])],
      ['16', 'Phone No',                 v(employee.phoneNumber)],
      ['17', 'Emergency Contact no (From Family)', v(pd['Emergency Contact no (From Family)'])],
      ['18', 'Emergency Contact Person Name and Relationship', v(pd['Emergency Contact Person Name and Relationship'])],
      ['19', 'Nominee details for Group Insurance', v(pd['Nominee details for Group Insurance'])],
      ['20', 'Personal Email ID',        v(personalEmail)],
      ['21', 'Current Address',          v(aadhaar.address)],
      ['22', 'Permanent Address',        v(aadhaar.address)],
      ['23', 'Blood Group',              ''],
      ['24', 'Knowledge of foreign languages', ''],
      ['25', 'Personal Bank Account Number\nEmployee Name:\nBank Name:\nBranch:\nIFSC Code:\nAccount Number:', ''],
      [],
      ['', 'Documentation List', ''],
      ['',  'Govt Related',              'Document Number / Details', 'Submitted to HR  (y/n)'],
      ['26', 'PAN Card',                 v(pan.panNumber),            ''],
      ['27', 'AADHAAR card',             v(aadhaar.aadhaarNumber),    ''],
      ['28', 'Passport No',              '',                          'y/n', '', '(Not Mandatory)'],
      ['29', 'UAN creation via UMANG app', '',                        'y/n', '', '(Not Mandatory)'],
      ['',  'Company Related',           'Document Number / Details', 'Submitted to HR  (y/n)'],
      ['30', 'Signed Offer Letter',      '',                          'y/n'],
      ['',  'Misc',                      '',                          ''],
      ['32', 'Passport sized photo',     '',                          'y/n'],
    ];

    await apiWithRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "'Personal Details'!A1",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: personalRows },
    }), 'personalDetails:values');

    // ── Tab 3: Education & Professional Detail ───────────────────────────────
    const eduRows = [
      // Education Details header
      ['Education Details:', '', '', '', '', '', '', ''],
      ['Education', 'Document Available (y/n)', 'Submitted to HR  (y/n)', 'Board/Degree', 'Specialization', 'Year of Completion', 'Marks', 'School / College name'],
      ['10th Marksheet',                            'y/n', 'y/n', v(m10.board),    '',                        v(m10.yearOfCompletion), v(m10.totalMarks), v(m10.schoolName)],
      ['12th/Diploma Marksheet',                    'y/n', 'y/n', v(m12.board),    v(m12.specialization),     v(m12.yearOfCompletion), v(m12.totalMarks), v(m12.schoolName)],
      ['Graduation Consolidated Marksheet and Degree Certificate', 'y/n', 'y/n', v(degree.degree), v(degree.specialization), v(degree.yearOfCompletion), v(degree.totalMarks), v(degree.collegeName)],
      ['Post Graduation Consolidated Marksheet and Degree Certificate', 'y/n', 'y/n', v(postgrad.degree), v(postgrad.specialization), v(postgrad.yearOfCompletion), v(postgrad.totalMarks), v(postgrad.collegeName), '(Not Mandatory)'],
      [],
      // Internships
      ['Internships Details:', '', '', '', '', '', '', ''],
      ['College Internships (if any)', 'Document Available (y/n)', 'Submitted to HR  (y/n)', 'Company Name', '', '', '', ''],
      ['Internship Start Date',        'y/n', 'y/n', '', '', '', '', ''],
      ['Internship End Date',          'y/n', 'y/n', '', '', '', '', ''],
      ['Internship certificate available', 'y/n', 'y/n', '', '', '', '', ''],
      ['Internships after completion of Education', 'Document Available (y/n)', 'Submitted to HR  (y/n)', 'Company Name', '', '', '', ''],
      ['Internship Start Date',        'y/n', 'y/n', '', '', '', '', ''],
      ['Internship End Date',          'y/n', 'y/n', '', '', '', '', ''],
      ['Internship certificate available', 'y/n', 'y/n', '', '', '', '', ''],
      ['',                             'y/n', 'y/n', '', '', '', '', ''],
      [],
      // Previous Employers
      ['Previous Employers details (Kindly fill all your experience mention as per your resume)', '', '', '', '', '', '', ''],
      ['Total Years of Experience:', '', '', '', '', '', '', ''],
      ['Total Years of Relevant Experience:', '', '', '', '', '', '', ''],
      ['PF Details (Name of the Trust and PF No):', '', '', '', '', '', '', ''],
      ['UAN Number:', '', '', '', '', '', '', ''],
      [],
      // Employer 1
      ['Employer 1', 'Document Available (y/n)', 'Submitted to HR  (y/n)', '', '', '', '', ''],
      ['Name of the Organisation:', v(reliev.previousEmployer || pd['Previous Company Name']), '', '', '', '', '', ''],
      ['Manager/ Immediate Supervisor Name', '', '', '', '', '', '', ''],
      ['Manager/ Immediate Supervisor Email Id', v(pd["Previous Manager's Email"]), '', '', '', '', '', ''],
      ['Manager/ Immediate Supervisor Contact Number', '', '', '', '', '', '', ''],
      ['Employment Start Date', v(reliev.dateOfJoining), '', '', '', '', '', ''],
      ['Employment End Date', v(reliev.dateOfRelieving), '', '', '', '', '', ''],
      ['Relieving/Experience letter Available', 'y/n', 'y/n', '', '', '', '', ''],
      ['Relieving/Experience letter Submitted', 'y/n', 'y/n', '', '', '', '', ''],
      ['Full and Final settlement (If not, please specify the submission date)', 'y/n', 'y/n', '', '', '', '', '', '(Not Mandatory if they submitted relieving month payslip also)'],
      ["Last 3 Month's Payslip", 'y/n', 'y/n', '', '', '', '', ''],
      [],
      [],
      // Employer 2
      ['Employer 2', 'Document Available (y/n)', 'Submitted to HR  (y/n)', '', '', '', '', ''],
      ['Name of the Organisation:', '', '', '', '', '', '', ''],
      ['Manager/ Immediate Supervisor Name', '', '', '', '', '', '', ''],
      ['Manager/ Immediate Supervisor Email Id', '', '', '', '', '', '', ''],
      ['Manager/ Immediate Supervisor Contact Number', '', '', '', '', '', '', ''],
      ['Employment Start Date', '', '', '', '', '', '', ''],
      ['Employment End Date', '', '', '', '', '', '', ''],
      ['Relieving/Experience letter Available', 'y/n', 'y/n', '', '', '', '', ''],
      ['Relieving/Experience letter Submitted', 'y/n', 'y/n', '', '', '', '', ''],
      ['Full and Final settlement (If not, please specify the submission date)', 'y/n', 'y/n', '', '', '', '', ''],
      ["Last 3 Month's Payslip", 'y/n', 'y/n', '', '', '', '', ''],
    ];

    await apiWithRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "'Education & Professional Detail'!A1",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: eduRows },
    }), 'eduProfDetail:values');

    // ── Formatting ───────────────────────────────────────────────────────────
    const TEAL  = { red: 0.69, green: 0.91, blue: 0.90 };   // header teal (#b0e8e5-ish)
    const GREEN = { red: 0.0,  green: 0.80, blue: 0.0  };   // bright green (PAN Card row)
    const YELLOW = { red: 1.0, green: 0.93, blue: 0.0  };   // yellow (UAN row)
    const WHITE  = { red: 1.0, green: 1.0,  blue: 1.0  };
    const BOLD   = { bold: true };
    const formatRequests = [];

    const dvId = tabIds['Document Version history'];
    const pdId = tabIds['Personal Details'];
    const epId = tabIds['Education & Professional Detail'];

    // ── Doc Version history formatting ───────────────────────────────────────
    // Title row (row 1, 0-indexed: 0) — centered bold blue
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
    // Header row (row 4, 0-indexed: 4) — bold
    formatRequests.push({
      repeatCell: {
        range: { sheetId: dvId, startRowIndex: 4, endRowIndex: 5 },
        cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    // Meta row (row 3, 0-indexed: 3) — bold
    formatRequests.push({
      repeatCell: {
        range: { sheetId: dvId, startRowIndex: 3, endRowIndex: 4 },
        cell: { userEnteredFormat: { textFormat: BOLD } },
        fields: 'userEnteredFormat(textFormat)',
      },
    });
    // Wrap all
    formatRequests.push({
      repeatCell: {
        range: { sheetId: dvId, startRowIndex: 0, endRowIndex: 10 },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat(wrapStrategy)',
      },
    });

    // ── Personal Details formatting ──────────────────────────────────────────
    // Row 1 (0-indexed: 0) — "Personal Details" header — teal background bold centered
    formatRequests.push({
      repeatCell: {
        range: { sheetId: pdId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: {
          textFormat: BOLD,
          backgroundColor: TEAL,
          horizontalAlignment: 'CENTER',
        }},
        fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)',
      },
    });
    // "Documentation List" header row (row 27, 0-indexed: 26) — teal bold centered
    formatRequests.push({
      repeatCell: {
        range: { sheetId: pdId, startRowIndex: 26, endRowIndex: 27 },
        cell: { userEnteredFormat: {
          textFormat: BOLD,
          backgroundColor: TEAL,
          horizontalAlignment: 'CENTER',
        }},
        fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)',
      },
    });
    // "Govt Related" sub-header (row 28, 0-indexed: 27) — teal bold
    formatRequests.push({
      repeatCell: {
        range: { sheetId: pdId, startRowIndex: 27, endRowIndex: 28 },
        cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    // PAN Card row (row 29, 0-indexed: 28) — bright green background
    formatRequests.push({
      repeatCell: {
        range: { sheetId: pdId, startRowIndex: 28, endRowIndex: 29 },
        cell: { userEnteredFormat: { backgroundColor: GREEN } },
        fields: 'userEnteredFormat(backgroundColor)',
      },
    });
    // UAN row (row 32, 0-indexed: 31) — yellow background
    formatRequests.push({
      repeatCell: {
        range: { sheetId: pdId, startRowIndex: 31, endRowIndex: 32 },
        cell: { userEnteredFormat: { backgroundColor: YELLOW } },
        fields: 'userEnteredFormat(backgroundColor)',
      },
    });
    // "Company Related" sub-header (row 33, 0-indexed: 32) — teal bold
    formatRequests.push({
      repeatCell: {
        range: { sheetId: pdId, startRowIndex: 32, endRowIndex: 33 },
        cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    // "Misc" sub-header (row 35, 0-indexed: 34) — teal bold
    formatRequests.push({
      repeatCell: {
        range: { sheetId: pdId, startRowIndex: 34, endRowIndex: 35 },
        cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    // All rows: bold label column (B, index 1)
    formatRequests.push({
      repeatCell: {
        range: { sheetId: pdId, startRowIndex: 1, endRowIndex: 36, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { textFormat: BOLD } },
        fields: 'userEnteredFormat(textFormat)',
      },
    });
    // Wrap all
    formatRequests.push({
      repeatCell: {
        range: { sheetId: pdId, startRowIndex: 0, endRowIndex: 36 },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat(wrapStrategy)',
      },
    });

    // ── Education & Professional Detail formatting ───────────────────────────
    // "Education Details:" header row 0 — teal bold centered
    formatRequests.push({
      repeatCell: {
        range: { sheetId: epId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: {
          textFormat: BOLD,
          backgroundColor: TEAL,
          horizontalAlignment: 'CENTER',
        }},
        fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)',
      },
    });
    // Column headers row 1 (0-indexed: 1) — teal bold
    formatRequests.push({
      repeatCell: {
        range: { sheetId: epId, startRowIndex: 1, endRowIndex: 2 },
        cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    // "Internships Details:" header row 7 (0-indexed: 7) — teal bold centered
    formatRequests.push({
      repeatCell: {
        range: { sheetId: epId, startRowIndex: 7, endRowIndex: 8 },
        cell: { userEnteredFormat: {
          textFormat: BOLD,
          backgroundColor: TEAL,
          horizontalAlignment: 'CENTER',
        }},
        fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)',
      },
    });
    // "College Internships" header row 8 (0-indexed: 8) — teal bold
    formatRequests.push({
      repeatCell: {
        range: { sheetId: epId, startRowIndex: 8, endRowIndex: 9 },
        cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    // "Internships after completion" header row 12 (0-indexed: 12) — teal bold
    formatRequests.push({
      repeatCell: {
        range: { sheetId: epId, startRowIndex: 12, endRowIndex: 13 },
        cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    // "Previous Employers details" row 18 (0-indexed: 18) — teal bold
    formatRequests.push({
      repeatCell: {
        range: { sheetId: epId, startRowIndex: 18, endRowIndex: 19 },
        cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    // "Employer 1" header row 23 (0-indexed: 23) — teal bold
    formatRequests.push({
      repeatCell: {
        range: { sheetId: epId, startRowIndex: 23, endRowIndex: 24 },
        cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    // "Employer 2" header row 35 (0-indexed: 35) — teal bold
    formatRequests.push({
      repeatCell: {
        range: { sheetId: epId, startRowIndex: 35, endRowIndex: 36 },
        cell: { userEnteredFormat: { textFormat: BOLD, backgroundColor: TEAL } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    // Wrap all
    formatRequests.push({
      repeatCell: {
        range: { sheetId: epId, startRowIndex: 0, endRowIndex: 50 },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat(wrapStrategy)',
      },
    });

    // Auto-resize all columns on all tabs
    for (const sid of [dvId, pdId, epId]) {
      formatRequests.push({
        autoResizeDimensions: {
          dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: 9 },
        },
      });
    }

    await apiWithRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: formatRequests },
    }), 'employeeInfoSheet:format');

    // ── Move into employee's Drive folder ────────────────────────────────────
    const fileMeta = await drive.files.get({ fileId: spreadsheetId, fields: 'parents' });
    const currentParents = (fileMeta.data.parents || []).join(',');
    await drive.files.update({
      fileId: spreadsheetId,
      addParents: employee.driveFolderId,
      removeParents: currentParents,
      fields: 'id, parents',
    });

    // ── Share with HR + recruiter only — joinee has no access ────────────────
    const hrEmail = process.env.HR_EMAIL;
    const recruiterEmail = (contacts && contacts.recruiterEmail) || null;
    const editList = [hrEmail, recruiterEmail].filter(Boolean);
    for (const email of [...new Set(editList)]) {
      await drive.permissions.create({
        fileId: spreadsheetId,
        requestBody: { type: 'user', role: 'writer', emailAddress: email },
        sendNotificationEmail: false,
      }).catch(() => {});
    }

    employee.employeeInfoSheetId = spreadsheetId;
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    console.log(`[Status] Employee info sheet (AL/DI/HR/018) created for ${name}: ${sheetUrl}`);
    return sheetUrl;
  } catch (err) {
    console.error(`[Status] createEmployeeInfoSheet failed for ${name}: ${err.message}`);
    return null;
  }
}
