// workingDays.js — what counts as a working day: Monday–Friday, excluding India's three
// national holidays — the only holidays mandatory for every organisation:
// Republic Day (26 Jan), Independence Day (15 Aug) and Gandhi Jayanti (2 Oct).
// They fall on the same date every year, so no calendar lookup is needed.

const NATIONAL_HOLIDAYS = new Map([
  ['01-26', 'Republic Day'],
  ['08-15', 'Independence Day'],
  ['10-02', 'Gandhi Jayanti'],
]);

// Local (server = IST) calendar date of a Date, as 'YYYY-MM-DD'.
function dateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function holidayName(date) {
  return NATIONAL_HOLIDAYS.get(dateKey(date).slice(5)) || null;
}

function isWorkingDay(date) {
  const day = new Date(date).getDay();
  return day !== 0 && day !== 6 && !holidayName(date);
}

// The same day if it's a working day, otherwise the next working day.
function ensureWorkingDay(date) {
  const d = new Date(date);
  while (!isWorkingDay(d)) d.setDate(d.getDate() + 1);
  return d;
}

// The same day if it's a working day, otherwise the previous working day.
function ensureWorkingDayBackward(date) {
  const d = new Date(date);
  while (!isWorkingDay(d)) d.setDate(d.getDate() - 1);
  return d;
}

// The last working day strictly before the given date.
function previousWorkingDay(date) {
  const d = new Date(date);
  do { d.setDate(d.getDate() - 1); } while (!isWorkingDay(d));
  return d;
}

// `workingDays` working days after the given date.
function addWorkingDays(date, workingDays) {
  const d = new Date(date);
  let added = 0;
  while (added < workingDays) {
    d.setDate(d.getDate() + 1);
    if (isWorkingDay(d)) added++;
  }
  return d;
}

module.exports = {
  isWorkingDay,
  holidayName,
  ensureWorkingDay,
  ensureWorkingDayBackward,
  previousWorkingDay,
  addWorkingDays,
};
