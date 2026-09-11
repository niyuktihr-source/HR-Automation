// formRowMatcher.js — pure helpers for matching an employee to their pre-onboarding
// form response row. Extracted out of index.js so they can be unit tested without
// needing to load the whole engine (index.js boots the full app on require).

function isTestFormRow(row) {
  let testCount = 0;
  for (const cell of row) {
    const s = String(cell || '').trim().toUpperCase();
    if (s === 'TEST' || s === '123456789' || s === '1234567890' || s === 'TESTING') testCount++;
  }
  return testCount >= 2;
}

// Find this employee's most recent, non-test response row (they may have
// resubmitted the form more than once — the latest valid one wins, same
// precedence rule as scripts/injectFormResponses.js).
function findLatestFormRow(rows, employee) {
  if (!rows || rows.length < 2) return null;
  const headers = rows[0];
  const empIdColIdx = headers.findIndex(h => { const t = h.trim().toLowerCase(); return t === 'employee id' || t.startsWith('employee id('); });
  const emailColIdx = headers.findIndex(h => { const t = h.trim().toLowerCase(); return t === 'email address' || t === 'email' || t === 'username' || t.includes('email'); });
  const nameColIdx = headers.findIndex(h => { const t = h.trim().toLowerCase(); return t === 'full name' || t === 'name' || t.startsWith('full name('); });

  const empName = (employee.name || '').trim().toLowerCase();
  const empEmail = (employee.personalEmail || '').trim().toLowerCase();

  const matches = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowEmpId = empIdColIdx !== -1 ? (row[empIdColIdx] || '').trim() : '';
    const rowEmail = emailColIdx !== -1 ? (row[emailColIdx] || '').trim().toLowerCase() : '';
    const rowName = nameColIdx !== -1 ? (row[nameColIdx] || '').trim().toLowerCase() : '';
    let isMatch = false;
    if (rowEmpId && employee.employeeId && rowEmpId.toUpperCase() === employee.employeeId.toUpperCase()) isMatch = true;
    else if (empEmail && rowEmail && rowEmail === empEmail) isMatch = true;
    else if (empName && rowName && (rowName === empName || rowName.includes(empName) || empName.includes(rowName))) isMatch = true;
    if (isMatch) matches.push({ row, isTest: isTestFormRow(row) });
  }
  if (matches.length === 0) return null;
  const nonTest = matches.filter(m => !m.isTest);
  const chosen = nonTest.length > 0 ? nonTest[nonTest.length - 1] : matches[matches.length - 1];
  return { row: chosen.row, headers };
}

module.exports = { isTestFormRow, findLatestFormRow };
