// Google Calendar integration — creates onboarding milestone events for employees
// All times are in IST (Asia/Kolkata, UTC+05:30)

const { google } = require('googleapis');
const config = require('./config');
const crypto = require('crypto');

// ─── Internal helpers ──────────────────────────────────────────────────────────

// Add N calendar days to a date
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Advance to next Monday if date falls on a weekend
function ensureWorkingDay(date) {
  const d = new Date(date);
  if (d.getDay() === 6) d.setDate(d.getDate() + 2); // Saturday → Monday
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sunday  → Monday
  return d;
}

// If the intended event date is in the past (cron fired late due to restart/OAuth expiry),
// bump to the next working day from today so the invite is still actionable.
// Returns { date, wasRescheduled, originalDate }
function resolveEventDate(intendedDate) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // midnight local
  const intended = new Date(intendedDate);
  const intendedDay = new Date(intended.getFullYear(), intended.getMonth(), intended.getDate());

  if (intendedDay >= today) {
    return { date: intended, wasRescheduled: false, originalDate: intended };
  }

  // Date is in the past — schedule for next working day from today
  const rescheduled = ensureWorkingDay(addDays(today, 1));
  return { date: rescheduled, wasRescheduled: true, originalDate: intended };
}

// Returns { dateTime, timeZone } for Google Calendar API in IST
function toGoogleDateTime(date, hour, minute) {
  // Build an ISO string with the IST offset +05:30
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(hour).padStart(2, '0');
  const mi = String(minute).padStart(2, '0');
  const tzOffset = config.timezone === 'Asia/Kolkata' ? '+05:30' : '+00:00';
  return {
    dateTime: `${y}-${mo}-${d}T${h}:${mi}:00${tzOffset}`,
    timeZone: config.timezone,
  };
}

// Parse a preferred time string like "10:00 AM", "14:30", "2 PM" into { hour, minute }
// Returns null if it can't be parsed — caller falls back to config default
function parsePreferredTime(str) {
  if (!str || typeof str !== 'string') return null;
  str = str.trim();

  // Match formats: "10:30 AM", "2:00 PM", "14:30", "10 AM", "2PM"
  const match = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = match[3] ? match[3].toUpperCase() : null;

  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  // Reject unreasonable times (before 7 AM or after 7 PM)
  if (hour < 7 || hour > 19) return null;

  return { hour, minute };
}

function hasChecklistTaskDone(employee, taskId) {
  if (!employee || !taskId || !employee.checklist) return false;
  for (const phase of Object.values(employee.checklist)) {
    if (phase && phase.tasks && phase.tasks[taskId] && phase.tasks[taskId].done) return true;
  }
  return false;
}

function isDuplicateCalendarAction(employee, actionKey) {
  if (!employee || !employee.employeeId || !actionKey) return false;
  const key = String(actionKey);

  const taskMap = {
    'hr-induction': 't28',
    'project-intro': 't32',
    '25day-catchup': 't65',
    '30day-catchup': 't45',
    '60day-review': 't48',
    '90day-review': 't51',
  };

  if (taskMap[key] && hasChecklistTaskDone(employee, taskMap[key])) {
    return true;
  }

  employee._createdActions = employee._createdActions || {};
  employee._calendarActions = employee._calendarActions || {};

  if (employee._createdActions[key] || employee._calendarActions[key]) {
    return true;
  }

  return false;
}

function markCalendarActionHandled(employee, actionKey, eventId) {
  if (!employee || !employee.employeeId || !actionKey) return;
  const key = String(actionKey);
  employee._createdActions = employee._createdActions || {};
  employee._calendarActions = employee._calendarActions || {};
  employee._createdActions[key] = true;
  employee._calendarActions[key] = eventId || true;
}

function calendarAutomationKey(employee, actionKey) {
  return `${employee.employeeId}:${actionKey}:${employee.doj || 'unknown-doj'}`;
}

function deterministicEventId(automationKey) {
  return `hr${crypto.createHash('sha256').update(automationKey).digest('hex')}`;
}

function getMeetLink(event) {
  if (!event) return null;
  if (event.hangoutLink) return event.hangoutLink;
  const entryPoint = (event.conferenceData && event.conferenceData.entryPoints || [])
    .find(point => point.entryPointType === 'video' && point.uri);
  return entryPoint ? entryPoint.uri : null;
}

function persistCalendarEvent(employee, actionKey, event) {
  markCalendarActionHandled(employee, actionKey, event && event.id);
  const meetLink = getMeetLink(event);
  if (meetLink) {
    employee.meetLinks = employee.meetLinks || {};
    employee.meetLinks[actionKey] = meetLink;
  }
  if (employee._saveState) employee._saveState();
}

async function insertCalendarEvent(calendar, employee, actionKey, event) {
  const automationKey = calendarAutomationKey(employee, actionKey);
  const eventId = deterministicEventId(automationKey);
  const resource = {
    ...event,
    id: eventId,
    conferenceData: event.conferenceData || {
      createRequest: {
        requestId: eventId,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    },
    extendedProperties: {
      ...(event.extendedProperties || {}),
      private: {
        ...((event.extendedProperties && event.extendedProperties.private) || {}),
        automationKey,
      },
    },
  };

  try {
    const existing = await calendar.events.get({ calendarId: 'primary', eventId });
    persistCalendarEvent(employee, actionKey, existing.data);
    console.log(`[Calendar] Existing event reused for ${employee.name}: ${existing.data.htmlLink}`);
    return existing;
  } catch (err) {
    if (err.code !== 404) throw err;
  }

  const legacy = await calendar.events.list({
    calendarId: 'primary',
    privateExtendedProperty: [`automationKey=${automationKey}`],
    maxResults: 1,
    singleEvents: false,
  });
  if (legacy.data.items && legacy.data.items.length > 0) {
    const existing = { data: legacy.data.items[0] };
    persistCalendarEvent(employee, actionKey, existing.data);
    console.log(`[Calendar] Legacy event reused for ${employee.name}: ${existing.data.htmlLink}`);
    return existing;
  }

  try {
    const created = await calendar.events.insert({
      calendarId: 'primary',
      resource,
      sendUpdates: 'all',
      conferenceDataVersion: 1, // Required to generate Meet links
    });

    persistCalendarEvent(employee, actionKey, created.data);
    return created;
  } catch (err) {
    // Another process may have won the insert race using the same stable ID.
    if (err.code !== 409) throw err;
    const existing = await calendar.events.get({ calendarId: 'primary', eventId });
    persistCalendarEvent(employee, actionKey, existing.data);
    console.log(`[Calendar] Existing event reused after insert race for ${employee.name}: ${existing.data.htmlLink}`);
    return existing;
  }
}

// ─── Exported calendar functions ───────────────────────────────────────────────

/**
 * Create HR Induction event on the employee's DOJ at 9:30–11:00 AM IST.
 * DOJ is always a working day but we guard against weekends just in case.
 * Attendees: employee + recruiter + manager — all receive a calendar invite
 * with accept/decline/reschedule options (sendUpdates: 'all').
 * Returns the event htmlLink, or null on failure.
 */
async function createHRInductionEvent(auth, employee) {
  const actionKey = 'hr-induction';
  try {
    if (isDuplicateCalendarAction(employee, actionKey)) {
      console.log(`[Calendar] Duplicate event skipped for ${employee.employeeId}: ${actionKey}`);
      return null;
    }

    const calendar = google.calendar({ version: 'v3', auth });
    const dojDate = new Date(employee.doj);
    if (!employee.doj || isNaN(dojDate.getTime())) {
      console.error(`[Calendar] createHRInductionEvent: invalid DOJ "${employee.doj}" for ${employee.name}`);
      return null;
    }

    // Guard: DOJ must be a working day — push to Monday if it lands on a weekend
    const inductionDate = ensureWorkingDay(dojDate);

    // Joinee is included — guestsCanModify:false disables "Propose new time" for all guests.
    const attendees = [
      employee.officialEmail || employee.personalEmail,
      employee.contacts && employee.contacts.recruiterEmail,
      employee.contacts && employee.contacts.managerEmail,
    ]
      .filter(Boolean)
      .map(email => ({ email }));

    const cfg = config.calendarEvents.hrInduction;
    const pd = employee.personalDetails || {};
    const preferred = parsePreferredTime(pd['Preferred Time for HR Induction']);
    const startHour = preferred ? preferred.hour : cfg.hour;
    const startMin  = preferred ? preferred.minute : cfg.minute;
    const endMins = startMin + cfg.durationMins;
    if (preferred) console.log(`[Calendar] HR Induction using preferred time ${startHour}:${String(startMin).padStart(2,'0')} for ${employee.name}`);
    const event = {
      summary: `HR Induction — ${employee.name}`,
      description: `HR Induction session for ${employee.name} (${employee.employeeId}).\n\nAgenda:\n• Company policies and culture\n• Tools and systems walkthrough\n• Greythr login setup\n• Team introductions\n\nConducted by: Recruiter / HR Team`,
      location: 'Office / As communicated by HR',
      start: toGoogleDateTime(inductionDate, startHour, startMin),
      end: toGoogleDateTime(inductionDate, startHour + Math.floor(endMins / 60), endMins % 60),
      attendees,
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: true,
    };

    const res = await insertCalendarEvent(calendar, employee, actionKey, event);
    console.log(`[Calendar] HR Induction event created for ${employee.name}: ${res.data.htmlLink}`);
    return res.data.htmlLink;
  } catch (err) {
    console.error('[Calendar] error: createHRInductionEvent failed:', err.message);
    return null;
  }
}

/**
 * Create Project Intro Meeting event on DOJ itself (post-lunch) at 2:00–3:00 PM IST.
 * Spec: "Automation schedules project intro meeting with new joinee on the DOJ
 * with reporting manager as per availability on managers' calendar post lunch."
 * DOJ is always a working day — weekend guard applied just in case.
 * Attendees: employee + manager + recruiter — all get invite with reschedule option.
 * Returns the event htmlLink, or null on failure.
 */
async function createProjectIntroEvent(auth, employee) {
  const actionKey = 'project-intro';
  try {
    if (isDuplicateCalendarAction(employee, actionKey)) {
      console.log(`[Calendar] Duplicate event skipped for ${employee.employeeId}: ${actionKey}`);
      return null;
    }

    const calendar = google.calendar({ version: 'v3', auth });
    const dojDate = new Date(employee.doj);
    if (!employee.doj || isNaN(dojDate.getTime())) {
      console.error(`[Calendar] createProjectIntroEvent: invalid DOJ "${employee.doj}" for ${employee.name}`);
      return null;
    }

    // Meeting is on DOJ itself (post-lunch) — guard for weekend just in case
    const eventDate = ensureWorkingDay(dojDate);

    // Joinee is included — guestsCanModify:false disables "Propose new time" for all guests.
    const attendees = [
      employee.officialEmail || employee.personalEmail,
      employee.contacts && employee.contacts.managerEmail,
      employee.contacts && employee.contacts.recruiterEmail,
    ]
      .filter(Boolean)
      .map(email => ({ email }));

    const cfg = config.calendarEvents.projectIntro;
    const pd = employee.personalDetails || {};
    const preferred = parsePreferredTime(pd['Preferred Time for Project Intro Meeting']);
    const startHour = preferred ? preferred.hour : cfg.hour;
    const startMin  = preferred ? preferred.minute : cfg.minute;
    const endMins = startMin + cfg.durationMins;
    if (preferred) console.log(`[Calendar] Project Intro using preferred time ${startHour}:${String(startMin).padStart(2,'0')} for ${employee.name}`);
    const event = {
      summary: `Project Intro Meeting — ${employee.name}`,
      description: `Project introduction meeting for ${employee.name} (${employee.employeeId}) with their reporting manager.\n\nAgenda:\n• Role overview and expectations\n• Key projects and initial goals\n• Team and buddy introduction\n• Q&A`,
      start: toGoogleDateTime(eventDate, startHour, startMin),
      end: toGoogleDateTime(eventDate, startHour + Math.floor(endMins / 60), endMins % 60),
      attendees,
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: true,
    };

    const res = await insertCalendarEvent(calendar, employee, actionKey, event);
    console.log(`[Calendar] Project Intro event created for ${employee.name}: ${res.data.htmlLink}`);
    return res.data.htmlLink;
  } catch (err) {
    console.error('[Calendar] error: createProjectIntroEvent failed:', err.message);
    return null;
  }
}

/**
 * Create 25-Day Catchup event on working day 25 at 11:00–11:30 AM IST.
 * Sent to new joinee + recruiter. Returns { htmlLink, eventDate } or null on failure.
 */
async function create25DayCatchupEvent(auth, employee) {
  const actionKey = '25day-catchup';
  try {
    if (isDuplicateCalendarAction(employee, actionKey)) {
      console.log(`[Calendar] Duplicate event skipped for ${employee.employeeId}: ${actionKey}`);
      return null;
    }

    const calendar = google.calendar({ version: 'v3', auth });
    const dojDate = new Date(employee.doj);
    if (!employee.doj || isNaN(dojDate.getTime())) {
      console.error(`[Calendar] create25DayCatchupEvent: invalid DOJ "${employee.doj}" for ${employee.name}`);
      return null;
    }
    const { date: eventDate, wasRescheduled, originalDate } = resolveEventDate(
      ensureWorkingDay(addDays(dojDate, config.milestones.surveyday))
    );
    if (wasRescheduled) {
      console.warn(`[Calendar] 25-day catchup for ${employee.name} was in the past (${originalDate.toDateString()}) — rescheduling invite to ${eventDate.toDateString()}`);
    }

    const attendees = [
      employee.officialEmail || employee.personalEmail,
      employee.contacts && employee.contacts.recruiterEmail,
      employee.contacts && employee.contacts.managerEmail,
    ]
      .filter(Boolean)
      .map(email => ({ email }));

    const cfg = config.calendarEvents.catchup25day;
    const endMins = cfg.minute + cfg.durationMins;
    const summary = wasRescheduled
      ? `25-Day Catchup ⚠️ (Rescheduled) — ${employee.name}`
      : `25-Day Catchup — ${employee.name}`;
    const description = wasRescheduled
      ? `25-day onboarding catchup call for ${employee.name} (${employee.employeeId}).\n\n⚠️ This meeting was originally scheduled for ${originalDate.toDateString()} and has been rescheduled.\n\nAgenda:\n• Onboarding experience so far\n• Any challenges or blockers\n• Role clarity check\n• Initial feedback from the team`
      : `25-day onboarding catchup call for ${employee.name} (${employee.employeeId}).\n\nAgenda:\n• Onboarding experience so far\n• Any challenges or blockers\n• Role clarity check\n• Initial feedback from the team`;
    const event = {
      summary,
      description,
      start: toGoogleDateTime(eventDate, cfg.hour, cfg.minute),
      end: toGoogleDateTime(eventDate, cfg.hour + Math.floor(endMins / 60), endMins % 60),
      attendees,
      guestsCanModify: false,
      guestsCanInviteOthers: false,
    };

    const res = await insertCalendarEvent(calendar, employee, actionKey, event);
    console.log(`[Calendar] 25-Day Catchup event created for ${employee.name}: ${res.data.htmlLink}`);
    return { htmlLink: res.data.htmlLink, eventDate };
  } catch (err) {
    console.error('[Calendar] error: create25DayCatchupEvent failed:', err.message);
    return null;
  }
}

/**
 * Create 30-Day Catchup event on working day 30 at 11:00–11:30 AM IST.
 * Returns the event htmlLink, or null on failure.
 */
async function create30DayCatchupEvent(auth, employee) {
  const actionKey = '30day-catchup';
  try {
    if (isDuplicateCalendarAction(employee, actionKey)) {
      console.log(`[Calendar] Duplicate event skipped for ${employee.employeeId}: ${actionKey}`);
      return null;
    }

    const calendar = google.calendar({ version: 'v3', auth });
    const dojDate = new Date(employee.doj);
    if (!employee.doj || isNaN(dojDate.getTime())) {
      console.error(`[Calendar] create30DayCatchupEvent: invalid DOJ "${employee.doj}" for ${employee.name}`);
      return null;
    }
    const { date: eventDate, wasRescheduled, originalDate } = resolveEventDate(
      ensureWorkingDay(addDays(dojDate, config.milestones.catchup30day))
    );
    if (wasRescheduled) {
      console.warn(`[Calendar] 30-day catchup for ${employee.name} was in the past (${originalDate.toDateString()}) — rescheduling invite to ${eventDate.toDateString()}`);
    }

    const attendees = [
      employee.officialEmail || employee.personalEmail,
      employee.contacts && employee.contacts.recruiterEmail,
      employee.contacts && employee.contacts.managerEmail,
    ]
      .filter(Boolean)
      .map(email => ({ email }));

    const catchupLink = employee.catchupSheetUrl || (employee.catchupSheetId ? `https://docs.google.com/spreadsheets/d/${employee.catchupSheetId}` : '');
    const sheetSection = catchupLink ? `\n\nCatchup Sheet: ${catchupLink}` : '';

    const cfg = config.calendarEvents.catchup30day;
    const endMins = cfg.minute + cfg.durationMins;
    const summary = wasRescheduled
      ? `30-Day Catchup ⚠️ (Rescheduled) — ${employee.name}`
      : `30-Day Catchup — ${employee.name}`;
    const description = wasRescheduled
      ? `30-day catchup call for ${employee.name} (${employee.employeeId}).\n\n⚠️ This meeting was originally scheduled for ${originalDate.toDateString()} and has been rescheduled.\n\nCovers onboarding experience, role clarity, challenges, and initial performance feedback.${sheetSection}`
      : `30-day catchup call for ${employee.name} (${employee.employeeId}). Covers onboarding experience, role clarity, challenges, and initial performance feedback.${sheetSection}`;
    const event = {
      summary,
      description,
      start: toGoogleDateTime(eventDate, cfg.hour, cfg.minute),
      end: toGoogleDateTime(eventDate, cfg.hour + Math.floor(endMins / 60), endMins % 60),
      attendees,
      guestsCanModify: false,
      guestsCanInviteOthers: false,
    };

    const res = await insertCalendarEvent(calendar, employee, actionKey, event);
    console.log(`[Calendar] 30-Day Catchup event created for ${employee.name}: ${res.data.htmlLink}`);
    return res.data.htmlLink;
  } catch (err) {
    console.error('[Calendar] error: create30DayCatchupEvent failed:', err.message);
    return null;
  }
}

/**
 * Create a 60-day or 90-day review event at 3:00–4:00 PM IST.
 * dayMark: 60 or 90
 * Returns the event htmlLink, or null on failure.
 */
async function createReviewEvent(auth, employee, dayMark) {
  const actionKey = `${dayMark}day-review`;
  try {
    if (isDuplicateCalendarAction(employee, actionKey)) {
      console.log(`[Calendar] Duplicate event skipped for ${employee.employeeId}: ${actionKey}`);
      return null;
    }

    const calendar = google.calendar({ version: 'v3', auth });
    const dojDate = new Date(employee.doj);
    if (!employee.doj || isNaN(dojDate.getTime())) {
      console.error(`[Calendar] createReviewEvent (${dayMark}-day): invalid DOJ "${employee.doj}" for ${employee.name}`);
      return null;
    }
    const { date: eventDate, wasRescheduled, originalDate } = resolveEventDate(
      ensureWorkingDay(addDays(dojDate, dayMark))
    );
    if (wasRescheduled) {
      console.warn(`[Calendar] ${dayMark}-day review for ${employee.name} was in the past (${originalDate.toDateString()}) — rescheduling invite to ${eventDate.toDateString()}`);
    }

    const attendees = [
      employee.officialEmail || employee.personalEmail,
      employee.contacts && employee.contacts.recruiterEmail,
      employee.contacts && employee.contacts.managerEmail,
    ]
      .filter(Boolean)
      .map(email => ({ email }));

    const cfg = config.calendarEvents.reviewMeeting;
    const endMins = cfg.minute + cfg.durationMins;
    const summary = wasRescheduled
      ? `${dayMark}-Day Review ⚠️ (Rescheduled) — ${employee.name}`
      : `${dayMark}-Day Review — ${employee.name}`;
    const description = wasRescheduled
      ? `${dayMark}-day performance review for ${employee.name} (${employee.employeeId}).\n\n⚠️ Originally scheduled for ${originalDate.toDateString()} — rescheduled due to a system restart.\n\nCovers performance assessment, key achievements, areas of improvement, and next goals.`
      : `${dayMark}-day performance review for ${employee.name} (${employee.employeeId}). Covers performance assessment, key achievements, areas of improvement, and next goals.`;
    const event = {
      summary,
      description,
      start: toGoogleDateTime(eventDate, cfg.hour, cfg.minute),
      end: toGoogleDateTime(eventDate, cfg.hour + Math.floor(endMins / 60), endMins % 60),
      attendees,
      guestsCanModify: false,
      guestsCanInviteOthers: false,
    };

    const res = await insertCalendarEvent(calendar, employee, actionKey, event);
    console.log(`[Calendar] ${dayMark}-Day Review event created for ${employee.name}: ${res.data.htmlLink}`);
    return res.data.htmlLink;
  } catch (err) {
    console.error(`[Calendar] error: createReviewEvent (${dayMark}-day) failed:`, err.message);
    return null;
  }
}

module.exports = {
  createHRInductionEvent,
  createProjectIntroEvent,
  create25DayCatchupEvent,
  create30DayCatchupEvent,
  createReviewEvent,
};
