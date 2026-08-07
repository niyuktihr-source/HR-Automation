// masterDashboard.js — one Google Sheet showing ALL employees, all 16 milestones
//
// Row 1: title banner + last updated
// Row 2: column headers
// Row 3+: one row per employee, colour-coded milestone cells
//
// Call getOrCreateMasterDashboard(auth) once on startup to get the sheet ID.
// Call updateMasterDashboard(auth, employees) after every saveState.

const { google } = require('googleapis');
const config = require('./config');

const DASHBOARD_TITLE = 'Alethea HR Onboarding Dashboard';

const MILESTONES = [
  'Pre-onboarding',
  'Docs Received',
  'Re-upload Requested',
  'Docs Verified',
  'Official Email',
  'Manager Confirmed',
  'IT Assets',
  'BGV Done',
  'HR Induction',
  'Project Intro',
  'Day of Joining',
  'Day 25 Catchup',
  'Day 30 Catchup',
  'Day 60 Review',
  'Day 90 Review',
  'Pre-probation',
];

// Checklist task keys that map to each milestone (same order as MILESTONES)
// The checklist is nested: checklist.phaseN.tasks.tXX
const MILESTONE_TASKS = [
  't4',   // Pre-onboarding form sent to new joinee
  't5',   // Employee uploads documents
  't10',  // Re-upload reminder sent (only shows if triggered)
  't12',  // Document verification marked complete
  't16',  // Official email & greythr confirmed
  't19',  // Manager allocation confirmed
  't22',  // IT allocation confirmed
  't26',  // BGV done
  't34',  // HR induction screenshot confirmed
  't37',  // Project intro screenshot confirmed
  't42',  // DOJ phase complete
  't63',  // Day 25 catchup email sent
  't43',  // 30-day catchup transcribed
  't46',  // 60-day review done
  't49',  // 90-day review done
  't52',  // Pre-probation verification completed
];

// Colours as {red, green, blue} in 0–1 range (Sheets API format)
const COLOUR = {
  headerBg:   { red: 0.11, green: 0.11, blue: 0.15 },  // near-black slate
  titleBg:    { red: 0.04, green: 0.36, blue: 0.60 },  // deep corporate blue
  white:      { red: 1,    green: 1,    blue: 1    },
  done:       { red: 0.13, green: 0.55, blue: 0.13 },  // green
  doneText:   { red: 1,    green: 1,    blue: 1    },
  pending:    { red: 1,    green: 0.92, blue: 0.70 },  // pale amber
  pendingText:{ red: 0.40, green: 0.26, blue: 0.02 },
  notOk:      { red: 0.95, green: 0.22, blue: 0.22 },  // red
  notOkText:  { red: 1,    green: 1,    blue: 1    },
  rowEven:    { red: 0.96, green: 0.97, blue: 0.99 },
  rowOdd:     { red: 1,    green: 1,    blue: 1    },
  overdue:    { red: 1,    green: 0.60, blue: 0.30 },  // orange
  overdueText:{ red: 0.45, green: 0.12, blue: 0.00 },
  inProgress:    { red: 1,    green: 0.95, blue: 0.40 },  // yellow — invite sent, awaiting screenshot
  inProgressText:{ red: 0.35, green: 0.25, blue: 0.00 },
};

function nowIST() {
  return new Date().toLocaleString('en-IN', { timeZone: config.timezone });
}

function daysFromDOJ(doj) {
  if (!doj) return null;
  const ms = Date.now() - new Date(doj).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// Flatten nested checklist (checklist.phaseN.tasks.tXX) into a flat {tXX: task} map
function flattenChecklist(checklist) {
  const flat = {};
  if (!checklist) return flat;
  for (const phase of Object.values(checklist)) {
    if (phase && phase.tasks) Object.assign(flat, phase.tasks);
  }
  return flat;
}

function pctComplete(checklist) {
  // Count only the 16 milestone tasks shown as columns — same as individual status sheet
  const flat = flattenChecklist(checklist);
  const milestoneTasks = MILESTONE_TASKS.filter(k => k !== 't10'); // t10 = re-upload, skipped as N/A
  const total = milestoneTasks.length;
  const done = milestoneTasks.filter(k => flat[k] && flat[k].done).length;
  if (!total) return 0;
  return Math.round((done / total) * 100);
}

function isTaskDone(checklist, taskId) {
  const flat = flattenChecklist(checklist);
  return !!(flat[taskId] && flat[taskId].done);
}

// Determine if a milestone is overdue based on DOJ + expected day range
function milestoneStatus(employee, milestoneIdx) {
  const taskKey = MILESTONE_TASKS[milestoneIdx];

  // Docs Verified (t12): t12 is marked as soon as the first identity doc passes, so
  // checking it alone gives false-green when other docs failed. Use verificationResults
  // instead for an accurate colour.
  if (taskKey === 't12') {
    const vr = employee.verificationResults || {};
    const results = Object.values(vr);
    if (results.some(r => r && r.valid === false)) return 'notok';
    if (isTaskDone(employee.checklist, taskKey)) return 'done';
    const days = daysFromDOJ(employee.doj);
    if (days !== null && days > 2) return 'overdue';
    return 'pending';
  }

  const done = isTaskDone(employee.checklist, taskKey);
  if (done) return 'done';

  // HR Induction (t34) — yellow if invite was sent (t27 marked) but screenshot not yet uploaded
  if (taskKey === 't34' && isTaskDone(employee.checklist, 't27')) return 'inProgress';
  // Project Intro (t37) — yellow if invite was sent (t29 marked) but screenshot not yet uploaded
  if (taskKey === 't37' && isTaskDone(employee.checklist, 't29')) return 'inProgress';

  // t10 (re-upload reminder) — only relevant if actually triggered
  if (taskKey === 't10') {
    return isTaskDone(employee.checklist, 't10') ? 'done' : 'na';
  }

  const days = daysFromDOJ(employee.doj);
  if (days === null) return 'pending';

  // Overdue thresholds (days after DOJ)
  const overdueAfter = {
    t4:  -5,  // pre-onboarding form should go before joining
    t5:  -2,  // docs uploaded before DOJ
    t12:  2,  // verification within 2 days of joining
    t16:  3,  // official email within 3 days
    t19:  3,  // manager confirmed within 3 days
    t22:  3,  // IT assets within 3 days
    t26:  5,  // BGV within 5 days
    t34:  1,  // HR induction screenshot — expected on DOJ
    t37:  1,  // Project intro screenshot — expected on DOJ
    t42:  0,  // DOJ phase complete on DOJ
    t63: 25,  // day 25 catchup
    t43: 30,  // 30-day review
    t46: 60,  // 60-day review
    t49: 90,  // 90-day review
    t52: 90,  // pre-probation
  };

  const threshold = overdueAfter[taskKey];
  if (threshold !== undefined && days > threshold) return 'overdue';
  return 'pending';
}

// ─── Retry helper ─────────────────────────────────────────────────────────────
async function apiWithRetry(fn, label, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.code || (err.response && err.response.status);
      const retryable = !status || status === 429 || status >= 500;
      if (attempt === maxAttempts || !retryable) throw err;
      const delay = attempt * 3000;
      console.warn(`[Dashboard] "${label}" attempt ${attempt} failed — retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─── Get or create the master dashboard sheet ─────────────────────────────────
async function getOrCreateMasterDashboard(auth) {
  const drive  = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  // Look for existing sheet in root of Drive
  const existing = await apiWithRetry(() => drive.files.list({
    q: `name='${DASHBOARD_TITLE}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  }), 'findDashboard');

  if (existing.data.files.length > 0) {
    const id = existing.data.files[0].id;
    console.log(`[Dashboard] Found existing dashboard: ${id}`);
    return id;
  }

  console.log('[Dashboard] Creating master dashboard sheet...');
  const spreadsheet = await apiWithRetry(() => sheets.spreadsheets.create({
    requestBody: {
      properties: { title: DASHBOARD_TITLE },
      sheets: [{ properties: { title: 'Dashboard' } }],
    },
  }), 'createDashboard');

  const spreadsheetId = spreadsheet.data.spreadsheetId;
  console.log(`[Dashboard] Created dashboard: ${spreadsheetId}`);
  return spreadsheetId;
}

// ─── Main update function ─────────────────────────────────────────────────────
async function updateMasterDashboard(auth, employees) {
  if (!employees || employees.length === 0) {
    console.log('[Dashboard] No employees to render — skipping');
    return;
  }

  const sheets = google.sheets({ version: 'v4', auth });
  let spreadsheetId;

  try {
    spreadsheetId = await getOrCreateMasterDashboard(auth);
  } catch (err) {
    console.error('[Dashboard] Failed to get/create sheet:', err.message);
    return;
  }

  // Get sheetId (numeric) for the Dashboard tab
  const meta = await apiWithRetry(() => sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  }), 'getSheetMeta');

  const sheetProps = meta.data.sheets[0].properties;
  const sheetId = sheetProps.sheetId;

  // ── Build value rows ──────────────────────────────────────────────────────
  const now = nowIST();

  // Row 1: title banner
  const titleRow = [`${config.companyName || 'Alethea'} HR Onboarding Dashboard`, ...Array(MILESTONES.length + 5).fill('')];

  // Row 2: column headers
  const headerRow = [
    'Emp ID', 'Name', 'DOJ', 'Days', 'Status', '% Done',
    ...MILESTONES,
  ];

  // Data rows (one per employee)
  const dataRows = employees.map(emp => {
    const days = daysFromDOJ(emp.doj);
    const pct  = pctComplete(emp.checklist);
    const dojDisplay = emp.doj ? emp.doj.split('T')[0] : '—';
    const daysDisplay = days !== null ? (days < 0 ? `${Math.abs(days)}d until DOJ` : `Day ${days}`) : '—';

    let status = 'Pending';
    if (pct === 100) status = 'Complete';
    else if (pct >= 50) status = 'In Progress';
    else if (pct > 0) status = 'Started';

    const milestoneValues = MILESTONES.map((_, i) => {
      const s = milestoneStatus(emp, i);
      if (s === 'done')       return '✓';
      if (s === 'inProgress') return '◑';
      if (s === 'overdue')    return '!';
      if (s === 'notok')      return '✗';
      if (s === 'na')         return '—';
      return '○';
    });

    return [
      emp.employeeId,
      emp.name,
      dojDisplay,
      daysDisplay,
      status,
      `${pct}%`,
      ...milestoneValues,
    ];
  });

  // Last row: legend
  const legendRow = ['', '', '', '', '', 'Legend:', '✓ Done', '○ Pending', '! Overdue', '✗ Issue', '—', `Updated: ${now}`, ...Array(MILESTONES.length - 6).fill('')];

  const allRows = [titleRow, headerRow, ...dataRows, legendRow];
  const totalRows = allRows.length;
  const totalCols = headerRow.length;

  // ── Write values ───────────────────────────────────────────────────────────
  await apiWithRetry(() => sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'Dashboard',
  }), 'clearSheet');

  await apiWithRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Dashboard!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: allRows },
  }), 'writeValues');

  // ── Format requests ────────────────────────────────────────────────────────
  const requests = [];

  // Title row (row 0): merge all, dark blue bg, white bold text, large font
  requests.push({
    mergeCells: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: totalCols },
      mergeType: 'MERGE_ALL',
    },
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: {
        userEnteredFormat: {
          backgroundColor: COLOUR.titleBg,
          textFormat: { bold: true, fontSize: 16, foregroundColor: COLOUR.white },
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
    },
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 50 },
      fields: 'pixelSize',
    },
  });

  // Header row (row 1): dark bg, white bold
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
      cell: {
        userEnteredFormat: {
          backgroundColor: COLOUR.headerBg,
          textFormat: { bold: true, fontSize: 10, foregroundColor: COLOUR.white },
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'WRAP',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
    },
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
      properties: { pixelSize: 44 },
      fields: 'pixelSize',
    },
  });

  // Employee data rows: alternating background, centre-align milestone columns
  for (let i = 0; i < employees.length; i++) {
    const rowIdx = i + 2; // 0-indexed; rows 0=title, 1=header, 2+=data
    const bg = i % 2 === 0 ? COLOUR.rowEven : COLOUR.rowOdd;

    // Base row background + font
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: bg,
            textFormat: { fontSize: 10 },
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)',
      },
    });

    // Milestone cells (columns 6 onwards): colour-coded individually
    for (let m = 0; m < MILESTONES.length; m++) {
      const colIdx = m + 6;
      const status = milestoneStatus(employees[i], m);
      let cellBg, cellFg;
      if (status === 'done')         { cellBg = COLOUR.done;       cellFg = COLOUR.doneText;       }
      else if (status === 'inProgress') { cellBg = COLOUR.inProgress; cellFg = COLOUR.inProgressText; }
      else if (status === 'overdue') { cellBg = COLOUR.overdue;    cellFg = COLOUR.overdueText;    }
      else if (status === 'notok')   { cellBg = COLOUR.notOk;      cellFg = COLOUR.notOkText;      }
      else { cellBg = COLOUR.pending; cellFg = COLOUR.pendingText; }

      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: colIdx, endColumnIndex: colIdx + 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: cellBg,
              textFormat: { bold: status === 'done', fontSize: 11, foregroundColor: cellFg },
              horizontalAlignment: 'CENTER',
              verticalAlignment: 'MIDDLE',
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
        },
      });
    }

    // % Done column (col 5): bold
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 5, endColumnIndex: 6 },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true, fontSize: 10 },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(textFormat,horizontalAlignment)',
      },
    });
  }

  // Legend row: light grey bg
  const legendRowIdx = 2 + employees.length;
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: legendRowIdx, endRowIndex: legendRowIdx + 1 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.92, green: 0.92, blue: 0.92 },
          textFormat: { italic: true, fontSize: 9 },
          verticalAlignment: 'MIDDLE',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)',
    },
  });

  // Column widths: ID, Name, DOJ, Days, Status, %, then milestone cols
  const colWidths = [70, 160, 90, 90, 90, 60, ...Array(MILESTONES.length).fill(78)];
  colWidths.forEach((px, i) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: px },
        fields: 'pixelSize',
      },
    });
  });

  // Freeze first 2 rows (title + header). Do NOT freeze columns — the title row
  // is merged across all columns and Sheets rejects a column freeze that cuts
  // through a merged region.
  requests.push({
    updateSheetProperties: {
      properties: {
        sheetId,
        gridProperties: { frozenRowCount: 2, frozenColumnCount: 0 },
      },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
    },
  });

  // Row height for data rows: 36px
  if (employees.length > 0) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 2, endIndex: 2 + employees.length },
        properties: { pixelSize: 36 },
        fields: 'pixelSize',
      },
    });
  }

  // Apply all formatting in one shot
  await apiWithRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  }), 'batchFormat');

  console.log(`[Dashboard] Updated master dashboard (${employees.length} employees) — https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
  return spreadsheetId;
}

module.exports = { getOrCreateMasterDashboard, updateMasterDashboard };
