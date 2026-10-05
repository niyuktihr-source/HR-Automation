// Google Calendar integration — creates onboarding milestone events for employees
// All times are in IST (Asia/Kolkata, UTC+05:30)

const { google } = require('googleapis');
const config = require('./config');
const crypto = require('crypto');
const { attachRoom, roomDeclined } = require('./roomBooking');

// ─── Internal helpers ──────────────────────────────────────────────────────────

// Add N calendar days to a date
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Working days = Mon–Fri excluding national holidays — see workingDays.js
const { ensureWorkingDay } = require('./workingDays');

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
    // hr-induction (t28) and project-intro (t32) are deliberately NOT mapped: index.js marks
    // them done before creating the event (restart safety), so mapping them would skip every
    // invite. insertCalendarEvent's deterministic event ID already prevents duplicates.
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

// event.bookRoom (optional): a label such as 'HR Induction' — when set, a free room that
// seats everyone is added to a newly created event; if none can be booked, HR and the
// recruiter are alerted. Existing events are reused as-is and never re-booked.
async function insertCalendarEvent(calendar, employee, actionKey, event) {
  const automationKey = calendarAutomationKey(employee, actionKey);
  const eventId = deterministicEventId(automationKey);
  const { bookRoom, ...eventFields } = event;
  const resource = {
    ...eventFields,
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

  let room = null;
  let roomProblem = null;
  if (bookRoom) {
    const result = await attachRoom(calendar, resource);
    if (result && result.email) room = result;
    else if (result && result.unavailable) roomProblem = result.unavailable;
  }

  try {
    const created = await calendar.events.insert({
      calendarId: 'primary',
      resource,
      sendUpdates: 'all',
      conferenceDataVersion: 1, // Required to generate Meet links
    });

    persistCalendarEvent(employee, actionKey, created.data);

    if (room) {
      if (await roomDeclined(calendar, eventId, room.email)) {
        roomProblem = `${room.name} declined the booking`;
      } else {
        console.log(`[Rooms] ${room.name} booked for ${bookRoom} — ${employee.name}`);
      }
    }
    if (roomProblem) {
      console.warn(`[Rooms] No room for ${bookRoom} — ${employee.name}: ${roomProblem}`);
      const { sendRoomUnavailableAlert } = require('./emailSender');
      await sendRoomUnavailableAlert(employee, bookRoom, resource.start.dateTime, roomProblem, created.data.htmlLink).catch(err =>
        console.warn(`[Rooms] Room-unavailable alert failed for ${employee.name}: ${err.message}`)
      );
    }
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
      bookRoom: 'HR Induction',
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
      (employee.officialEmail || employee.personalEmail) && { email: employee.officialEmail || employee.personalEmail },
      employee.contacts && employee.contacts.recruiterEmail && { email: employee.contacts.recruiterEmail },
      employee.contacts && employee.contacts.managerEmail && { email: employee.contacts.managerEmail, optional: true },
    ].filter(Boolean);

    const cfg = config.calendarEvents.catchup25day;
    const endMins = cfg.minute + cfg.durationMins;
    const summary = wasRescheduled
      ? `HR Catchup ⚠️ (Rescheduled)`
      : `HR Catchup`;
    const letterBody = `Dear ${employee.name},\n\nHope you're settling in well! We'd love to have a quick catch-up with you to see how things are going, hear about your experience so far, and check if there's anything you need from us. Looking forward to connecting.\n\nWarm regards,\nHR Team`;
    const description = wasRescheduled
      ? `⚠️ This meeting was originally scheduled for ${originalDate.toDateString()} and has been rescheduled.\n\n${letterBody}`
      : letterBody;
    const event = {
      summary,
      description,
      start: toGoogleDateTime(eventDate, cfg.hour, cfg.minute),
      end: toGoogleDateTime(eventDate, cfg.hour + Math.floor(endMins / 60), endMins % 60),
      attendees,
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      bookRoom: '25-Day Catchup',
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

    // HR spec: invite recruiter + manager only — the joinee is not on this call.
    const attendees = [
      employee.contacts && employee.contacts.recruiterEmail,
      employee.contacts && employee.contacts.managerEmail,
    ]
      .filter(Boolean)
      .map(email => ({ email }));

    const sheetLink = employee.projectIntroSheetId
      ? `https://docs.google.com/spreadsheets/d/${employee.projectIntroSheetId}`
      : '';
    const managerName = (employee.contacts && employee.contacts.managerName) || 'Manager';
    const letterBody = `Hi ${managerName},\n\nAs part of the probation process, you are responsible for training ${employee.name} in your team. The monthly tasks and training plan were updated at the time of their joining.\nTo ensure that ${employee.name}'s training progress is well-documented and meets ISO requirements, please complete the progress sheet before our upcoming review meeting.\nDuring this meeting, we will briefly discuss the progress, and after the discussion, the summary sheet will be shared with you, the new Joinee, and the HR Manager. Your support in this process is greatly appreciated. Let me know if you have any questions.\n\nAL_DI_HR_019 Project Introduction — New Joinee (${employee.employeeId}) Sheet${sheetLink ? `: ${sheetLink}` : ' link not yet available'}`;

    const cfg = config.calendarEvents.catchup30day;
    const endMins = cfg.minute + cfg.durationMins;
    const summary = wasRescheduled
      ? `30-Day Catchup ⚠️ (Rescheduled) — ${employee.name}`
      : `30-Day Catchup — ${employee.name}`;
    const description = wasRescheduled
      ? `⚠️ This meeting was originally scheduled for ${originalDate.toDateString()} and has been rescheduled.\n\n${letterBody}`
      : letterBody;
    const event = {
      summary,
      description,
      start: toGoogleDateTime(eventDate, cfg.hour, cfg.minute),
      end: toGoogleDateTime(eventDate, cfg.hour + Math.floor(endMins / 60), endMins % 60),
      attendees,
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      bookRoom: '30-Day Review',
    };

    const res = await insertCalendarEvent(calendar, employee, actionKey, event);
    console.log(`[Calendar] 30-Day Catchup event created for ${employee.name}: ${res.data.htmlLink}`);
    return { htmlLink: res.data.htmlLink, eventDate };
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

    // HR spec: invite recruiter + manager only — the joinee is not on this call.
    const attendees = [
      employee.contacts && employee.contacts.recruiterEmail,
      employee.contacts && employee.contacts.managerEmail,
    ]
      .filter(Boolean)
      .map(email => ({ email }));

    const sheetLink = employee.projectIntroSheetId
      ? `https://docs.google.com/spreadsheets/d/${employee.projectIntroSheetId}`
      : '';
    const managerName = (employee.contacts && employee.contacts.managerName) || 'Manager';
    const letterBody = `Hi ${managerName},\n\nAs part of the probation process, you are responsible for training ${employee.name} in your team. The monthly tasks and training plan were updated at the time of their joining.\nTo ensure that ${employee.name}'s training progress is well-documented and meets ISO requirements, please complete the progress sheet before our upcoming review meeting.\nDuring this meeting, we will briefly discuss the progress, and after the discussion, the summary sheet will be shared with you, the new Joinee, and the HR Manager. Your support in this process is greatly appreciated. Let me know if you have any questions.\n\nAL_DI_HR_019 Project Introduction — New Joinee (${employee.employeeId}) Sheet${sheetLink ? `: ${sheetLink}` : ' link not yet available'}`;

    const cfg = config.calendarEvents.reviewMeeting;
    const endMins = cfg.minute + cfg.durationMins;
    const summary = wasRescheduled
      ? `${dayMark}-Day Review ⚠️ (Rescheduled) — ${employee.name}`
      : `${dayMark}-Day Review — ${employee.name}`;
    const description = wasRescheduled
      ? `⚠️ Originally scheduled for ${originalDate.toDateString()} — rescheduled due to a system restart.\n\n${letterBody}`
      : letterBody;
    const event = {
      summary,
      description,
      start: toGoogleDateTime(eventDate, cfg.hour, cfg.minute),
      end: toGoogleDateTime(eventDate, cfg.hour + Math.floor(endMins / 60), endMins % 60),
      attendees,
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      bookRoom: `${dayMark}-Day Review`,
    };

    const res = await insertCalendarEvent(calendar, employee, actionKey, event);
    console.log(`[Calendar] ${dayMark}-Day Review event created for ${employee.name}: ${res.data.htmlLink}`);
    return { htmlLink: res.data.htmlLink, eventDate };
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
