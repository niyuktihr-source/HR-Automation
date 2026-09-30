const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { create25DayCatchupEvent, create30DayCatchupEvent, createReviewEvent } = require('./calendarService');
const {
  sendPreProbationReminder,
  sendPhaseCompletionSummary,
  sendReviewSummaryRequest,
  sendNoReplyEscalation,
  sendReviewSheetReminder,
  sendManagerConfirmationRequest,
} = require('./emailSender');
const {
  markPreprobationDone,
} = require('./statusTracker');
function isTaskDone(checklist, taskId) {
  if (!checklist) return false;
  for (const phase of Object.values(checklist)) {
    if (phase.tasks && phase.tasks[taskId]) return phase.tasks[taskId].done;
  }
  return false;
}

// In-memory store of scheduled jobs, keyed by employeeId
// Structure: { [employeeId]: { tasks: cron.ScheduledTask[], employee: {}, milestones: {} } }
const activeJobs = {};

// Small, narrow duplicate guard for milestone creation.
// It checks: employee state, task done state, and a lightweight in-memory action registry.
// actionKey examples: 'surveyform23', '25day', '30day-review', 'hr-induction'
function isDuplicateAction(employee, actionKey) {
  if (!employee || !employee.employeeId || !actionKey) return false;
  const key = String(actionKey);

  // If the task is already done in the checklist, it should not be re-created.
  if (/^t\d+$/.test(key)) {
    if (isTaskDone(employee.checklist, key)) return true;
  }

  employee._scheduledActions = employee._scheduledActions || {};
  employee._createdActions = employee._createdActions || {};

  if (employee._scheduledActions[key] || employee._createdActions[key]) {
    return true;
  }

  return false;
}

function markActionHandled(employee, actionKey) {
  if (!employee || !employee.employeeId || !actionKey) return;
  const key = String(actionKey);
  employee._scheduledActions = employee._scheduledActions || {};
  employee._createdActions = employee._createdActions || {};
  employee._scheduledActions[key] = true;
  employee._createdActions[key] = true;
}

function scheduleActionOnce(employee, actionKey, factoryFn) {
  if (!employee || !employee.employeeId || !factoryFn) return null;
  if (isDuplicateAction(employee, actionKey)) {
    console.log(`[Cron] Duplicate action skipped for ${employee.employeeId}: ${actionKey}`);
    return null;
  }

  const task = factoryFn();
  if (task) {
    markActionHandled(employee, actionKey);
  }
  return task;
}

// Return a Date that is `days` calendar days after the given Date
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Working days = Mon–Fri excluding national holidays — see workingDays.js
const { ensureWorkingDay, addWorkingDays, previousWorkingDay, isWorkingDay } = require('./workingDays');

// Convert a Date to a node-cron expression "minute hour day month *"
function dateToCron(date) {
  return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`;
}

// Schedule a one-shot cron that fires once on targetDate then destroys itself
function scheduleOnce(targetDate, label, fn) {
  const now = new Date();
  if (targetDate <= now) {
    console.log(`[Cron] "${label}" target is in the past — running immediately`);
    fn().catch(err => console.error(`[Cron] "${label}" error:`, err.message));
    return null;
  }

  const expression = dateToCron(targetDate);
  console.log(`[Cron] Scheduled "${label}" → ${targetDate.toDateString()} (${expression})`);

  const task = cron.schedule(expression, async () => {
    console.log(`[Cron] Firing "${label}"`);
    try {
      await fn();
    } catch (err) {
      console.error(`[Cron] "${label}" error:`, err.message);
    }
    task.stop();
  });
  return task;
}

// Schedule a one-shot cron that fires once at an explicit IST wall-clock hour:minute
// on targetDate's day/month, regardless of the server's own system timezone.
// Used where the fire time must match a specific real-world clock time (e.g. "N hours
// after a calendar invite's start time"), unlike scheduleOnce which derives hour/minute
// from the server-local interpretation of targetDate.
// ifPast: what to do when that IST time has already passed (e.g. after a restart) —
// 'run' runs it now (default; like scheduleOnce), 'skip' drops it. Without this, the
// "m h D M *" expression would fire on the same date next year.
function scheduleOnceAtIST(targetDate, hour, minute, label, fn, { ifPast = 'run' } = {}) {
  const targetMs = Date.UTC(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), hour, minute) - 330 * 60 * 1000;
  if (targetMs <= Date.now()) {
    if (ifPast === 'skip') {
      console.log(`[Cron] "${label}" time has already passed — skipping`);
      return null;
    }
    console.log(`[Cron] "${label}" target is in the past — running immediately`);
    fn().catch(err => console.error(`[Cron] "${label}" error:`, err.message));
    return null;
  }
  const expression = `${minute} ${hour} ${targetDate.getDate()} ${targetDate.getMonth() + 1} *`;
  console.log(`[Cron] Scheduled "${label}" → ${targetDate.toDateString()} at ${hour}:${String(minute).padStart(2, '0')} IST (${expression})`);

  const task = cron.schedule(expression, async () => {
    console.log(`[Cron] Firing "${label}"`);
    try {
      await fn();
    } catch (err) {
      console.error(`[Cron] "${label}" error:`, err.message);
    }
    task.stop();
  }, { timezone: config.timezone || 'Asia/Kolkata' });
  return task;
}

// IST calendar date ('YYYY-MM-DD') of a moment.
function istDayKey(date = new Date()) {
  return new Date(new Date(date).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

// Runs `check` every day at 9 AM IST — the one daily reminder slot. skipDay (an IST date key):
// no check on that day — the day the email that started this poller went out — so the first
// reminder is the next day's 9 AM, never a second email the same day.
function startDaily9amCheck(check, { skipDay = null } = {}) {
  return cron.schedule('0 9 * * *', () => {
    if (skipDay && istDayKey() === skipDay) return;
    return check();
  }, { timezone: config.timezone || 'Asia/Kolkata' });
}

// Formats an event Date + hour/minute config into "23 Sep 2026 at 11:00 AM IST"
function formatEventDateStr(eventDate, hour, minute) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hour12 = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  return `${eventDate.getDate()} ${months[eventDate.getMonth()]} ${eventDate.getFullYear()} at ${hour12}:${String(minute).padStart(2,'0')} ${ampm} IST`;
}

// Schedule a day-before reminder for a milestone: sent on the working day before the
// milestone's own (weekend-adjusted) date, so it always lands on a working day and
// never on the milestone day itself — e.g. a Monday call gets its heads-up on Friday.
function scheduleDayBeforeReminder(employee, dayMark, fireDate) {
  const { name } = employee;
  const milestoneDate = new Date(fireDate);
  const reminderDate = previousWorkingDay(milestoneDate);
  const { hour, minute } = config.emailSendTime;
  return scheduleOnceAtIST(reminderDate, hour, minute, `Day-Before Reminder (${dayMark}-day) — ${name}`, async () => {
    const { sendDayBeforeReminder } = require('./emailSender');
    await sendDayBeforeReminder(employee, dayMark, milestoneDate).catch(err =>
      console.warn(`[Cron] Day-before reminder (${dayMark}-day) failed for ${name}: ${err.message}`)
    );
    console.log(`[Cron] Day-before reminder sent for ${name} — ${dayMark}-day milestone on ${milestoneDate.toDateString()}`);
  }, { ifPast: 'skip' }); // heads-up time already passed — skip
}

// Schedule the day-23 onboarding survey: creates the joinee's own copy of "Employee Feedback
// Form: Onboarding Experience" (shared with the recruiter as editor), emails it to the joinee,
// notifies the recruiter, then starts the daily response poller.
// If the form can't be created, nothing is sent and it retries the next working day at 9 AM IST.
function scheduleOnboardingSurveyForm(employee, markTaskFn) {
  const { name, employeeId, doj } = employee;
  const fireDate = ensureWorkingDay(addDays(new Date(doj), config.milestones.onboardingSurveyDay));

  const send = async () => {
    if (isTaskDone(employee.checklist, 't70')) return;
    if (employee.status === 'stopped' || employee.isStopped) return;

    const { ensureJoineeSurveyForm } = require('./onboardingSurveyResponse');
    const form = employee._auth
      ? await ensureJoineeSurveyForm(employee._auth, employee).catch(err => {
          console.error(`[Cron] ❌ Could not create onboarding survey form for ${name} (${employeeId}): ${err.message}`);
          return null;
        })
      : null;
    if (!form || !form.responderUrl) {
      const retryDate = ensureWorkingDay(addDays(new Date(), 1));
      console.warn(`[Cron] Onboarding survey for ${name} not sent — retrying ${retryDate.toDateString()} 9:00 AM IST`);
      scheduleOnceAtIST(retryDate, config.emailSendTime.hour, config.emailSendTime.minute, `Onboarding Survey Form (retry) — ${name}`, send);
      return;
    }

    const { sendOnboardingSurveyForm, sendOnboardingSurveyRecruiterNotice } = require('./emailSender');
    await sendOnboardingSurveyForm(employee).catch(err =>
      console.warn(`[Cron] Onboarding survey email failed for ${name}: ${err.message}`)
    );
    await sendOnboardingSurveyRecruiterNotice(employee).catch(err =>
      console.warn(`[Cron] Onboarding survey recruiter notice failed for ${name}: ${err.message}`)
    );
    console.log(`[Cron] Onboarding survey form sent for ${name} (${employeeId})`);

    if (markTaskFn) markTaskFn('t70');
    if (employee._saveState) employee._saveState();

    scheduleOnboardingSurveyPoller(employee, markTaskFn, { skipDay: istDayKey() }); // first reminder: tomorrow 9 AM
  };

  return scheduleOnceAtIST(fireDate, config.emailSendTime.hour, config.emailSendTime.minute, `Onboarding Survey Form — ${name}`, send);
}

// Polls daily (starting 24h after the survey was sent) for a completed response.
// Once every field is filled, copies the joinee's individual answers into their
// Drive folder, shares that copy with their recruiter, and marks the milestone done.
// Stops once t71 is marked done or the employee is stopped.
function scheduleOnboardingSurveyPoller(employee, markTaskFn, { skipDay = null } = {}) {
  const { name, employeeId } = employee;
  let jobHandle = null;
  let stopped = false;

  const check = async () => {
    // Fresh cache per run — reusing one across daily runs would keep serving the
    // first day's rows and never see a response submitted afterwards.
    const rowCache = {};
    if (stopped || employee.status === 'stopped' || employee.isStopped) {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
      return;
    }
    if (isTaskDone(employee.checklist, 't71')) {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
      return;
    }
    if (!employee._auth) return; // can't check Drive/Sheets without auth — try again next run

    const { checkOnboardingSurveyResponse, createOnboardingSurveyResponseCopy, exportResponseAsXlsx } = require('./onboardingSurveyResponse');
    const result = await checkOnboardingSurveyResponse(employee._auth, employee, rowCache).catch(err => {
      console.warn(`[Cron] Onboarding survey check failed for ${name}: ${err.message}`);
      return null;
    });

    if (result && result.complete) {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }

      const copy = await createOnboardingSurveyResponseCopy(employee._auth, employee, result.headers, result.row).catch(err => {
        console.warn(`[Cron] Could not copy survey response for ${name}: ${err.message}`);
        return null;
      });
      if (copy) {
        const xlsx = await exportResponseAsXlsx(employee._auth, employee, copy.spreadsheetId).catch(err => {
          console.warn(`[Cron] Could not export survey response as .xlsx for ${name}: ${err.message}`);
          return null;
        });
        const { sendOnboardingSurveyResponseToRecruiter } = require('./emailSender');
        await sendOnboardingSurveyResponseToRecruiter(employee, copy.url, xlsx).catch(err =>
          console.warn(`[Cron] Survey response notice failed for ${name}: ${err.message}`)
        );
      }
      if (markTaskFn) markTaskFn('t71');
      if (employee._saveState) employee._saveState();
      console.log(`[Cron] Onboarding survey completed for ${name} (${employeeId})`);
      return;
    }

    // Not complete yet — remind the joinee
    const { sendOnboardingSurveyReminder } = require('./emailSender');
    await sendOnboardingSurveyReminder(employee).catch(err =>
      console.warn(`[Cron] Onboarding survey reminder failed for ${name}: ${err.message}`)
    );
    console.log(`[Cron] Onboarding survey reminder sent for ${name} (${employeeId})`);
  };

  // One reminder a day at 9 AM IST — none on the day the form was sent
  jobHandle = startDaily9amCheck(check, { skipDay });

  return {
    stop() {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
    },
  };
}

// Schedule the 25th day catchup: creates the calendar invite + tracking sheet on
// day 25, then fires the recruiter reminder email `reminderDelayHours` after the
// call's start time (e.g. call at 11:00 AM → reminder at 1:00 PM), and finally
// polls the tracking sheet daily until the recruiter fills it in.
function schedule25DayCatchup(employee, markTaskFn) {
  const { name, employeeId, doj } = employee;
  const fireDate = ensureWorkingDay(addDays(new Date(doj), config.milestones.surveyday));
  scheduleDayBeforeReminder(employee, 25, fireDate);

  return scheduleOnce(fireDate, `25-Day Catchup Setup — ${name}`, async () => {
    const { getOrCreateCatchupSheet } = require('./statusTracker');

    // Ensure personalized catchup sheet is created from template
    if (employee._auth) {
      await getOrCreateCatchupSheet(employee._auth, employee).catch(err =>
        console.warn(`[Cron] Could not get/create catchup sheet for ${name}: ${err.message}`)
      );
    }

    // Create calendar invite for joinee + recruiter + manager (manager optional)
    let eventDate = fireDate;
    if (employee._auth) {
      const result = await create25DayCatchupEvent(employee._auth, employee).catch(err => {
        console.error(`[Cron][Calendar] ❌ 25-day calendar invite FAILED for ${name} (${employeeId}): ${err.message}`);
        return null;
      });
      if (result) {
        eventDate = result.eventDate;
        console.log(`[Cron][Calendar] ✅ 25-day calendar invite sent for ${name}: ${result.htmlLink}`);
      }
    } else {
      console.warn(`[Cron][Calendar] ⚠️ 25-day calendar invite SKIPPED for ${name} — no auth on employee object`);
    }
    if (employee._saveState) employee._saveState();

    schedule25DayCatchupReminder(employee, eventDate, markTaskFn);
  });
}

// "25 Sep 2030 at 11:00 AM IST" — the 25-day call time shown in the recruiter reminder.
function formatCatchup25Date(eventDate) {
  const cfg = config.calendarEvents.catchup25day;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hour12 = cfg.hour > 12 ? cfg.hour - 12 : cfg.hour;
  const ampm = cfg.hour >= 12 ? 'PM' : 'AM';
  return `${eventDate.getDate()} ${months[eventDate.getMonth()]} ${eventDate.getFullYear()} at ${hour12}:${String(cfg.minute).padStart(2,'0')} ${ampm} IST`;
}

// Fires the recruiter reminder email `reminderDelayHours` after the call's start
// time, then kicks off the daily sheet-fill poller.
function schedule25DayCatchupReminder(employee, eventDate, markTaskFn) {
  const { name, employeeId } = employee;
  const cfg = config.calendarEvents.catchup25day;
  const reminderHour = cfg.hour + (cfg.reminderDelayHours || 0);
  const eventDateStr = formatCatchup25Date(eventDate);

  scheduleOnceAtIST(eventDate, reminderHour, cfg.minute, `25-Day Catchup Reminder — ${name}`, async () => {
    const { send25DayCatchupEmail } = require('./emailSender');

    // Recruiter only — the joinee already got the day-before heads-up, no second email on the call day.
    await send25DayCatchupEmail(employee, { meetLink: employee.meetLinks && employee.meetLinks['25day-catchup'], eventDateStr }).catch(err =>
      console.warn(`[Cron] 25-day catchup email failed for ${name}: ${err.message}`)
    );
    console.log(`[Cron] 25-day catchup reminder sent for ${name} (${employeeId})`);

    if (markTaskFn) markTaskFn('t63'); // Day 25 catchup call email sent
    if (employee._saveState) employee._saveState();

    // Poll the catchup tracking sheet daily — remind recruiter until filled, then summarize
    scheduleCatchup25SheetPoller(employee, eventDateStr, markTaskFn);
  });
}

// The 25-day step is complete only when BOTH are in: the recruiter has filled the catchup
// tracking sheet AND replied "Confirmed" with a meeting screenshot (t64). Until then the same
// reminder email goes to the recruiter every working day at 9 AM IST. Once both are in, the
// discussion is AI-summarised and emailed to manager + recruiter, and only after that email
// is sent is the milestone marked complete (t65) — a failed send is retried next working day.
const catchup25Checks = {}; // employeeId → check(), so a "Confirmed" reply can trigger it straight away

// Options (used when resuming after a restart): initialDelayMs: 0 — check straight away;
// firstCheckRemind — whether that first check may send a reminder; remind — false keeps the
// poller silent (summary still sent once both are in) for a call long in the past.
function scheduleCatchup25SheetPoller(employee, eventDateStr, markTaskFn, { initialDelayMs = null, firstCheckRemind = true, remind: remindDaily = true } = {}) {
  const { name, employeeId } = employee;
  let jobHandle = null;
  let stopped = false;
  let running = false;

  const stop = () => {
    stopped = true;
    if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
    if (catchup25Checks[employeeId] === check) delete catchup25Checks[employeeId];
  };

  // remind: false when triggered by the recruiter's reply — never answer a reply with a reminder
  const check = async ({ remind = true } = {}) => {
    if (stopped || employee.status === 'stopped' || employee.isStopped || isTaskDone(employee.checklist, 't65')) return stop();
    if (!employee._auth || running) return;
    if (remind && !isWorkingDay(new Date())) return; // no reminders on weekends / national holidays
    running = true;
    try {
      const { isCatchup25SheetFilled, readCatchup25QAPairs, readCatchup25RecruiterSummary, summarizeCatchup25Notes, mark25DayCatchupDone } = require('./statusTracker');
      const filled = await isCatchup25SheetFilled(employee._auth, employee).catch(err => {
        console.warn(`[Cron] Catchup25 sheet poll failed for ${name}: ${err.message}`);
        return false;
      });
      const confirmed = isTaskDone(employee.checklist, 't64');

      if (filled && confirmed) {
        const [qaResult, recruiterSummary] = await Promise.all([
          readCatchup25QAPairs(employee._auth, employee.catchupSheetId).catch(() => null),
          readCatchup25RecruiterSummary(employee._auth, employee.catchupSheetId).catch(() => ''),
        ]);
        const qaPairs = (qaResult && qaResult.qaPairs) || [];
        const summaryText = await summarizeCatchup25Notes(employee, qaPairs, recruiterSummary);

        const { send25DayCatchupSummary } = require('./emailSender');
        const sent = await send25DayCatchupSummary(employee, summaryText).then(() => true).catch(err => {
          console.warn(`[Cron] 25-day catchup summary email failed for ${name} — will retry next working day: ${err.message}`);
          return false;
        });
        if (!sent) return;
        console.log(`[Cron] 25-day catchup summary sent for ${name} (${employeeId})`);

        if (markTaskFn) markTaskFn('t65'); // 25-day milestone complete — only after the summary email went out
        await mark25DayCatchupDone(employee._auth, employee).catch(() => {});
        if (employee._saveState) employee._saveState();
        return stop();
      }

      const missing = [!filled && 'tracking sheet not filled', !confirmed && '"Confirmed" + screenshot reply not received'].filter(Boolean).join(', ');
      if (!remind) {
        console.log(`[Cron] 25-day catchup for ${name} still waiting: ${missing}`);
        return;
      }
      // Same mail as the initial reminder
      const { send25DayCatchupEmail } = require('./emailSender');
      await send25DayCatchupEmail(employee, { eventDateStr }).catch(err =>
        console.warn(`[Cron] 25-day catchup reminder failed for ${name}: ${err.message}`)
      );
      console.log(`[Cron] 25-day catchup reminder sent for ${name} (${employeeId}) — ${missing}`);
    } finally {
      running = false;
    }
  };

  catchup25Checks[employeeId] = check;
  // Resuming after a restart: check straight away (quietly unless told otherwise). Otherwise the
  // reminder email went out today — the daily 9 AM IST check starts tomorrow.
  if (initialDelayMs === 0) check({ remind: firstCheckRemind && remindDaily }).catch(err => console.warn(`[Cron] 25-day catchup check failed for ${name}: ${err.message}`));
  jobHandle = startDaily9amCheck(() => check({ remind: remindDaily }), { skipDay: initialDelayMs === 0 ? null : istDayKey() });

  return { stop };
}

// Called when the recruiter's "Confirmed" + screenshot reply arrives: if the sheet is already
// filled, the summary goes out now instead of at the next 9 AM check. Never sends a reminder.
async function checkCatchup25Now(employee) {
  const check = employee && catchup25Checks[employee.employeeId];
  if (check) await check({ remind: false });
}

// Schedule the 30-day catchup call reminder
// contacts: { recruiterEmail, managerEmail, itEmail }
// markTaskFn (optional): function(taskId) to mark checklist tasks from within the callback
function schedule30DayCatchup(employee, recruiterEmail, managerEmail, contacts, markTaskFn) {
  const { name, employeeId, doj } = employee;
  const fireDate = ensureWorkingDay(addDays(new Date(doj), config.milestones.catchup30day));
  scheduleDayBeforeReminder(employee, 30, fireDate);

  return scheduleOnce(fireDate, `30-Day Catchup — ${name}`, async () => {
    // Recruiter + manager only: the invite (AL_DI_HR_019 Tracking - Month -1 sheet) and the
    // pollers below. No joinee email and no 25-day catchup sheet on day 30.
    let eventDate = fireDate;
    if (employee._auth) {
      const result = await create30DayCatchupEvent(employee._auth, employee).catch(err => {
        console.error(`[Cron][Calendar] ❌ 30-day calendar invite FAILED for ${name} (${employeeId}): ${err.message}`);
        return null;
      });
      if (result) {
        eventDate = result.eventDate;
        console.log(`[Cron][Calendar] ✅ 30-day calendar invite sent for ${name}: ${result.htmlLink}`);
      }
    } else {
      console.warn(`[Cron][Calendar] ⚠️ 30-day calendar invite SKIPPED for ${name} — no auth on employee object`);
    }

    // t43/t44/t45 are no longer marked here unconditionally — t43 (recruiter section
    // filled) is driven by the poller below, t44 (manager confirms "Confirmed") and
    // t45 (final milestone, gated on the joinee's receipt confirmation) are driven by
    // the actual reply events in index.js.
    scheduleRecruiterSheetPoller(employee, recruiterEmail, managerEmail, 30, 't43', markTaskFn, eventDate);
    scheduleReviewSummaryFollowup(employee, 30, eventDate);

    if (employee._saveState) employee._saveState(); // triggers master dashboard refresh
  });
}

// Schedule 60-day review reminder
// contacts: { recruiterEmail, managerEmail, itEmail }
function schedule60DayReview(employee, recruiterEmail, managerEmail, contacts, markTaskFn) {
  const { name, employeeId, doj } = employee;
  const fireDate = ensureWorkingDay(addDays(new Date(doj), config.milestones.review60day));
  scheduleDayBeforeReminder(employee, 60, fireDate);

  return scheduleOnce(fireDate, `60-Day Review — ${name}`, async () => {
    // Recruiter + manager get the invite (AL_DI_HR_019 instructions + sheet link) and the
    // day-before heads-up — no separate review email, and nothing to the joinee here.
    let eventDate = fireDate;
    if (employee._auth) {
      const result = await createReviewEvent(employee._auth, employee, 60).catch(err => {
        console.error(`[Cron][Calendar] ❌ 60-day calendar invite FAILED for ${name} (${employeeId}): ${err.message}`);
        return null;
      });
      if (result) {
        eventDate = result.eventDate;
        console.log(`[Cron][Calendar] ✅ 60-day calendar invite sent for ${name}: ${result.htmlLink}`);
      }
    } else {
      console.warn(`[Cron][Calendar] ⚠️ 60-day calendar invite SKIPPED for ${name} — no auth on employee object`);
    }

    // t46 (recruiter section filled) driven by the poller; t47 (manager confirms) and
    // t48 (final milestone) are gated on the real reply events in index.js.
    scheduleRecruiterSheetPoller(employee, recruiterEmail, managerEmail, 60, 't46', markTaskFn, eventDate);
    scheduleReviewSummaryFollowup(employee, 60, eventDate);

    if (employee._saveState) employee._saveState(); // triggers master dashboard refresh
  });
}

// Schedule 90-day review reminder
// contacts: { recruiterEmail, managerEmail, itEmail }
function schedule90DayReview(employee, recruiterEmail, managerEmail, contacts, markTaskFn) {
  const { name, employeeId, doj } = employee;
  const fireDate = ensureWorkingDay(addDays(new Date(doj), config.milestones.review90day));
  scheduleDayBeforeReminder(employee, 90, fireDate);

  return scheduleOnce(fireDate, `90-Day Review — ${name}`, async () => {
    // Recruiter + manager get the invite (AL_DI_HR_019 instructions + sheet link) and the
    // day-before heads-up — no separate review email, and nothing to the joinee here.
    let eventDate = fireDate;
    if (employee._auth) {
      const result = await createReviewEvent(employee._auth, employee, 90).catch(err => {
        console.error(`[Cron][Calendar] ❌ 90-day calendar invite FAILED for ${name} (${employeeId}): ${err.message}`);
        return null;
      });
      if (result) {
        eventDate = result.eventDate;
        console.log(`[Cron][Calendar] ✅ 90-day calendar invite sent for ${name}: ${result.htmlLink}`);
      }
    } else {
      console.warn(`[Cron][Calendar] ⚠️ 90-day calendar invite SKIPPED for ${name} — no auth on employee object`);
    }

    // t49 (recruiter section filled) driven by the poller; t50 (manager confirms) and
    // t51 (final milestone) are gated on the real reply events in index.js.
    scheduleRecruiterSheetPoller(employee, recruiterEmail, managerEmail, 90, 't49', markTaskFn, eventDate);
    scheduleReviewSummaryFollowup(employee, 90, eventDate);

    if (employee._saveState) employee._saveState(); // triggers master dashboard refresh
  });
}

// Step 4 (HR spec): `reviewSummaryShareDelayDays` after the review call, ask the recruiter
// to reply "Confirmed" with a screenshot of the review call. The summary itself is emailed
// to the joinee (cc recruiter) automatically once the manager confirms — see reviewSummary.js.
function scheduleReviewSummaryFollowup(employee, dayMark, eventDate) {
  const { name } = employee;
  const cfg = dayMark === 30 ? config.calendarEvents.catchup30day : config.calendarEvents.reviewMeeting;
  const eventDateStr = formatEventDateStr(eventDate, cfg.hour, cfg.minute);
  const followupDate = ensureWorkingDay(addDays(new Date(eventDate), config.reviewSummaryShareDelayDays));

  scheduleOnceAtIST(followupDate, cfg.hour, cfg.minute, `${dayMark}-Day Review Summary Followup — ${name}`, async () => {
    const { sendReviewSummaryShareReminder } = require('./emailSender');
    await sendReviewSummaryShareReminder(employee, dayMark, eventDateStr).catch(err =>
      console.warn(`[Cron] ${dayMark}-day review call screenshot reminder failed for ${name}: ${err.message}`)
    );
    console.log(`[Cron] ${dayMark}-day review call screenshot reminder sent for ${name}`);
  }, { ifPast: 'skip' }); // already sent before a restart — don't send it again
}

// Schedule BGV initiation email to recruiter — fires on DOJ
function scheduleBGVInitiate(employee, recruiterEmail, markTaskFn) {
  const { name, employeeId, doj } = employee;
  const fireDate = ensureWorkingDay(new Date(doj));

  return scheduleOnce(fireDate, `BGV Initiate — ${name}`, async () => {
    if (isTaskDone(employee.checklist, 't23')) {
      console.log(`[Cron] BGV initiate already sent for ${name} — skipping`);
      return;
    }
    const { sendBGVInitiateRequest } = require('./emailSender');
    await sendBGVInitiateRequest(employee, recruiterEmail).catch(err =>
      console.warn(`[Cron] BGV initiate email failed for ${name}: ${err.message}`)
    );
    if (markTaskFn) markTaskFn('t23');
    console.log(`[Cron] BGV initiate email sent to recruiter for ${name} (${employeeId})`);
    if (employee._saveState) employee._saveState();
  });
}

// Schedule BGV upload request — fires 7 working days after DOJ, recruiter + HR
function scheduleBGVRequest(employee, recruiterEmail, markTaskFn) {
  const { name, employeeId, doj } = employee;
  const fireDate = ensureWorkingDay(addWorkingDays(new Date(doj), 7));

  return scheduleOnce(fireDate, `BGV Upload Request — ${name}`, async () => {
    if (isTaskDone(employee.checklist, 't24')) {
      console.log(`[Cron] BGV upload request already sent for ${name} — skipping`);
      return;
    }
    const { sendBGVUploadRequest } = require('./emailSender');
    await sendBGVUploadRequest(employee, recruiterEmail).catch(err =>
      console.warn(`[Cron] BGV upload request email failed for ${name}: ${err.message}`)
    );
    if (markTaskFn) markTaskFn('t24');
    console.log(`[Cron] BGV upload request sent for ${name} (${employeeId})`);
    if (employee._saveState) employee._saveState();
  });
}

// Schedule 5-month pre-probation reminder (approx 150 days)
function schedule5MonthProbation(employee, managerEmail) {
  const { name, employeeId, doj } = employee;
  const fireDate = ensureWorkingDay(addDays(new Date(doj), config.milestones.probation150day));

  return scheduleOnceAtIST(fireDate, config.emailSendTime.hour, config.emailSendTime.minute, `Pre-Probation — ${name}`, async () => {
    await sendPreProbationReminder(employee, managerEmail);
    console.log(`[Cron] Pre-probation reminder sent for ${name} (${employeeId})`);
    // t52 and t55 are marked only when HR replies with the result (handleReply → pre_probation_result)
    // Schedule 48h escalation if no reply arrives
    employee.replyTimers = employee.replyTimers || {};
    employee.replyTimers['probationNoReply'] = scheduleReplyDeadline(
      employee, 'HR / Manager (Pre-Probation)', managerEmail, 48,
      `The system sent a pre-probation verification email to the manager asking them to review ${employee.name}'s probation period, make a decision (confirm or extend), and reply with the outcome. No reply has been received.`
    );
    if (employee._saveState) employee._saveState();
  });
}

// Schedule pre-onboarding form reminders to joinee at 24h, 48h, 72h.
// After 72h, also escalate to recruiter. Stops when t5 (docs uploaded) is done.
function schedulePreOnboardingReminders(employee, recruiterEmail) {
  const { name, employeeId } = employee;
  const REMINDER_HOURS = [24, 48, 72];
  const timers = [];
  let stopped = false;

  REMINDER_HOURS.forEach((hours, i) => {
    const attemptNumber = i + 1;
    const fireDate = new Date(Date.now() + hours * 60 * 60 * 1000);

    const task = scheduleOnce(fireDate, `Pre-Onboarding Reminder ${attemptNumber}/3 — ${name}`, async () => {
      if (stopped) return;
      if (isTaskDone(employee.checklist, 't5')) {
        stopped = true;
        return;
      }
      const { sendPreOnboardingReminder, sendNoResponseAlert } = require('./emailSender');
      await sendPreOnboardingReminder(employee, attemptNumber).catch(err =>
        console.warn(`[Cron] Pre-onboarding reminder ${attemptNumber} failed for ${name}: ${err.message}`)
      );
      console.log(`[Cron] Pre-onboarding reminder ${attemptNumber}/3 sent to ${name} (${employeeId})`);

      if (attemptNumber === REMINDER_HOURS.length) {
        await sendNoResponseAlert(employee, recruiterEmail).catch(err =>
          console.warn(`[Cron] Pre-onboarding recruiter escalation failed for ${name}: ${err.message}`)
        );
        console.log(`[Cron] Pre-onboarding recruiter escalated after 3 reminders for ${name}`);
      }
    });

    if (task) timers.push(task);
  });

  return {
    stop() {
      stopped = true;
      timers.forEach(t => { try { t.stop(); } catch (_) {} });
    },
  };
}

// Schedule a no-response follow-up 24 hours after a document request
function scheduleNoResponseAlert(employee, recruiterEmail, delayHours) {
  const hours = delayHours || config.replyDeadlines.noResponseAlertHours;
  const fireDate = new Date(Date.now() + hours * 60 * 60 * 1000);
  const { name, employeeId } = employee;

  return scheduleOnce(fireDate, `No-Response Alert — ${name}`, async () => {
    const { sendNoResponseAlert } = require('./emailSender');
    await sendNoResponseAlert(employee, recruiterEmail);
    console.log(`[Cron] No-response alert sent to recruiter for ${name} (${employeeId})`);
    // t11: alert sent to recruiter because employee didn't respond > 24h
    if (employee._markTask) employee._markTask('t11');
  });
}

// Schedule up to 3 reminder emails to the employee for a missing/rejected doc,
// at 24h, 48h, and 72h. After the final reminder, escalate to recruiter.
// Returns an object { stop } so the caller can cancel all timers on successful re-upload.
function scheduleDocumentReminders(employee, docType, reason, recruiterEmail) {
  const { name, employeeId } = employee;
  const REMINDER_HOURS = [24, 48, 72];
  const timers = [];
  let stopped = false;

  REMINDER_HOURS.forEach((hours, i) => {
    const attemptNumber = i + 1;
    const fireDate = new Date(Date.now() + hours * 60 * 60 * 1000);
    const label = `Doc Reminder ${attemptNumber}/3 — ${docType} — ${name}`;

    const task = scheduleOnce(fireDate, label, async () => {
      if (stopped) return;
      const { sendDocumentReminder, sendNoResponseAlert } = require('./emailSender');

      // Send reminder email to employee
      await sendDocumentReminder(employee, docType, attemptNumber, reason).catch(err =>
        console.warn(`[Cron] Reminder ${attemptNumber} email failed for ${name}: ${err.message}`)
      );
      console.log(`[Cron] Doc reminder ${attemptNumber}/3 sent to ${name} (${employeeId}) for ${docType}`);

      // After final reminder, also alert recruiter
      if (attemptNumber === REMINDER_HOURS.length) {
        await sendNoResponseAlert(employee, recruiterEmail).catch(err =>
          console.warn(`[Cron] Recruiter escalation failed for ${name}: ${err.message}`)
        );
        console.log(`[Cron] Recruiter escalated after 3 reminders for ${name} (${employeeId}) — ${docType}`);
        if (employee._markTask) employee._markTask('t11');
      }
    });

    if (task) timers.push(task);
  });

  return {
    stop() {
      stopped = true;
      timers.forEach(t => { try { t.stop(); } catch (_) {} });
    },
  };
}

// Schedule a reply-deadline priority notice for any stakeholder who hasn't replied.
// context: short plain-text description of what the original email asked them to do.
function scheduleReplyDeadline(employee, recipientType, recipientEmail, delayHours, context) {
  const hours = delayHours || config.replyDeadlines.stakeholderReplyHours;
  const fireDate = new Date(Date.now() + hours * 60 * 60 * 1000);
  const { name, employeeId } = employee;

  const task = scheduleOnce(fireDate, `Reply Deadline — ${recipientType} — ${name}`, async () => {
    await sendNoReplyEscalation(employee, recipientType, recipientEmail, context);
    console.log(`[Cron] No-reply priority notice sent to HR for ${recipientType} re: ${name} (${employeeId})`);
  });
  if (task) {
    task._expiresAt = fireDate.toISOString();
    task._recipientEmail = recipientEmail;
  }
  return task;
}

// Register ALL milestones for a new employee and store their job handles
// markTaskFn (optional): function(taskId) — called from inside cron callbacks to update checklist
function scheduleAllMilestones(employee, contacts, markTaskFn) {
  const { employeeId } = employee;
  const { recruiterEmail, managerEmail, itEmail } = contacts;

  const tasks = [
    scheduleActionOnce(employee, 'surveyform23', () => scheduleOnboardingSurveyForm(employee, markTaskFn)),
    scheduleActionOnce(employee, '25day', () => schedule25DayCatchup(employee, markTaskFn)),
    scheduleActionOnce(employee, '30day', () => schedule30DayCatchup(employee, recruiterEmail, managerEmail, contacts, markTaskFn)),
    scheduleActionOnce(employee, '60day', () => schedule60DayReview(employee, recruiterEmail, managerEmail, contacts, markTaskFn)),
    scheduleActionOnce(employee, '90day', () => schedule90DayReview(employee, recruiterEmail, managerEmail, contacts, markTaskFn)),
    scheduleActionOnce(employee, '5month', () => schedule5MonthProbation(employee, managerEmail)),
  ].filter(Boolean);

  activeJobs[employeeId] = { tasks, employee, contacts };
  console.log(`[Cron] All milestones scheduled for ${employee.name} (${employeeId})`);
  return tasks;
}

// Re-register milestone cron jobs after a process restart
// Only re-registers jobs whose corresponding tasks are not yet done.
// completedMilestones: array of completed task IDs e.g. ['t63', 't45']
// Task → milestone map: surveyform23→t70/t71, 25day→t63, 30day→t45, 60day→t48, 90day→t51, probation→t52
function restoreMilestonesAfterRestart(employee, contacts, completedMilestones, markTaskFn) {
  if (employee.status === 'stopped' || employee.isStopped) {
    console.log(`[Cron] restoreMilestonesAfterRestart: ${employee.name} (${employee.employeeId}) is STOPPED — skipping milestone restoration`);
    return;
  }
  if (!contacts) {
    console.warn(`[Cron] restoreMilestonesAfterRestart: no contacts for ${employee.name} — skipping`);
    return;
  }

  const dojDate = new Date(employee.doj);
  if (!employee.doj || isNaN(dojDate.getTime())) {
    console.warn(`[Cron] restoreMilestonesAfterRestart: invalid or missing DOJ for ${employee.name} — skipping`);
    return;
  }

  const done = new Set(completedMilestones || []);
  const { employeeId, name } = employee;
  const { recruiterEmail, managerEmail } = contacts;

  console.log(`[Cron] Restoring milestones after restart for ${name} (${employeeId})`);

  const tasks = [];

  if (!done.has('t70')) {
    const t = scheduleActionOnce(employee, 'surveyform23', () => scheduleOnboardingSurveyForm(employee, markTaskFn));
    if (t) tasks.push(t);
  } else if (!done.has('t71')) {
    // Survey was already sent before restart — just resume polling for the response.
    scheduleOnboardingSurveyPoller(employee, markTaskFn);
    console.log(`[Cron]   Resuming onboarding survey response poll for ${name} (t70 done, t71 pending)`);
  } else {
    console.log(`[Cron]   Skipping onboarding survey form (t71 already done)`);
  }

  if (!done.has('t63')) {
    const t = scheduleActionOnce(employee, '25day', () => schedule25DayCatchup(employee, markTaskFn));
    if (t) tasks.push(t);
  } else if (!done.has('t65')) {
    // Reminder already sent before the restart — resume the daily check (sheet + "Confirmed" reply)
    // First check now but without a reminder (never remind at restart time); daily reminders
    // resume only if the call was within the last 14 days — no reminders for long-past calls.
    const eventDate = ensureWorkingDay(addDays(new Date(employee.doj), config.milestones.surveyday));
    const recent = Date.now() - eventDate.getTime() <= 14 * 24 * 60 * 60 * 1000;
    scheduleCatchup25SheetPoller(employee, formatCatchup25Date(eventDate), markTaskFn, { initialDelayMs: 0, firstCheckRemind: false, remind: recent });
    console.log(`[Cron]   Resuming 25-day catchup check for ${name} (t63 done, t65 pending)${recent ? '' : ' — call was over 14 days ago, no reminders'}`);
  } else {
    console.log(`[Cron]   Skipping 25-day catchup (t65 already done)`);
  }

  if (!done.has('t43')) {
    const t = scheduleActionOnce(employee, '30day', () => schedule30DayCatchup(employee, recruiterEmail, managerEmail, contacts, markTaskFn));
    if (t) tasks.push(t);
  } else {
    console.log(`[Cron]   Skipping 30-day catchup (t43 already done)`);
  }

  if (!done.has('t48')) {
    const t = scheduleActionOnce(employee, '60day', () => schedule60DayReview(employee, recruiterEmail, managerEmail, contacts, markTaskFn));
    if (t) tasks.push(t);
  } else {
    console.log(`[Cron]   Skipping 60-day review (t48 already done)`);
  }

  if (!done.has('t51')) {
    const t = scheduleActionOnce(employee, '90day', () => schedule90DayReview(employee, recruiterEmail, managerEmail, contacts, markTaskFn));
    if (t) tasks.push(t);
  } else {
    console.log(`[Cron]   Skipping 90-day review (t51 already done)`);
  }

  if (!done.has('t52')) {
    const t = scheduleActionOnce(employee, '5month', () => schedule5MonthProbation(employee, managerEmail));
    if (t) tasks.push(t);
  } else {
    console.log(`[Cron]   Skipping pre-probation (t52 already done)`);
  }

  // Merge with any existing job store entry
  if (!activeJobs[employeeId]) {
    activeJobs[employeeId] = { tasks: [], employee, contacts };
  }
  activeJobs[employeeId].tasks.push(...tasks);

  console.log(`[Cron] Restored ${tasks.length} milestone job(s) for ${name} (${employeeId})`);
}

// Cancel all cron jobs for an employee (e.g. if they leave)
function cancelAllJobs(employeeId) {
  const entry = activeJobs[employeeId];
  if (!entry) return;
  entry.tasks.forEach(t => t && t.stop());
  delete activeJobs[employeeId];
  console.log(`[Cron] All jobs cancelled for ${employeeId}`);
}

// Daily health-check cron — runs at 9 AM every day, logs active jobs
function startDailyHealthCheck() {
  cron.schedule(config.healthCheckCron, () => {
    const count = Object.keys(activeJobs).length;
    console.log(`[Cron] Daily health check — ${count} employee(s) with active scheduled jobs`);
    Object.entries(activeJobs).forEach(([id, entry]) => {
      console.log(`  → ${entry.employee.name} (${id}) | DOJ: ${entry.employee.doj}`);
    });
  });
  console.log('[Cron] Daily health-check scheduled at 9 AM on weekdays');
}

// Data retention cron — runs at 2 AM daily, purges logs older than RETENTION_DAYS
function startDataRetentionCron() {
  const retentionDays = parseInt(process.env.LOG_RETENTION_DAYS || '90', 10);
  if (isNaN(retentionDays) || retentionDays < 1) return;

  // Run at 2:00 AM every day
  cron.schedule('0 2 * * *', () => {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const logsDir = path.join(__dirname, '..', 'logs');
    const auditDir = path.join(logsDir, 'audit');

    let purged = 0;
    for (const dir of [logsDir, auditDir]) {
      if (!fs.existsSync(dir)) continue;
      try {
        for (const file of fs.readdirSync(dir)) {
          const full = path.join(dir, file);
          try {
            const stat = fs.statSync(full);
            if (stat.isFile() && stat.mtimeMs < cutoff) {
              fs.unlinkSync(full);
              purged++;
            }
          } catch { /* skip locked or vanished files */ }
        }
      } catch { /* skip unreadable dir */ }
    }

    if (purged > 0) {
      console.log(`[Cron] Data retention: purged ${purged} log file(s) older than ${retentionDays} days`);
    }
  });
  console.log(`[Cron] Data retention cron scheduled (purge logs older than ${retentionDays} days at 2 AM daily)`);
}

// Poll the review sheet tab daily to detect when recruiter has filled their section.
// Sends daily reminders to recruiter until the sheet is filled (Part 1).
// Once filled: marks the review task green, then emails manager to confirm "Done" (Part 2).
// dayMark: 30 | 60 | 90
// partOneTaskId: 't43' | 't46' | 't49' — marked green when recruiter fills sheet
// markTaskFn: function(taskId) to update checklist
// eventDate: the actual review call Date, used to render "<Calendar invite date>" in the manager email
function scheduleRecruiterSheetPoller(employee, recruiterEmail, managerEmail, dayMark, partOneTaskId, markTaskFn, eventDate) {
  const { name } = employee;
  const monthTab = dayMark === 30 ? 'Tracking - Month -1' : dayMark === 60 ? 'Tracking - Month -2' : 'Tracking - Month -3';
  const cfg = dayMark === 30 ? config.calendarEvents.catchup30day : config.calendarEvents.reviewMeeting;
  const eventDateStr = eventDate ? formatEventDateStr(eventDate, cfg.hour, cfg.minute) : '';
  let jobHandle = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
  };

  const check = async () => {
    if (stopped || employee.status === 'stopped' || employee.isStopped || isTaskDone(employee.checklist, partOneTaskId)) return stop();
    if (!employee._auth || !employee.projectIntroSheetId) return;
    if (!isWorkingDay(new Date())) return; // no reminders on weekends / national holidays

    const { reviewSheetSections } = require('./statusTracker');
    const sections = await reviewSheetSections(employee._auth, employee.projectIntroSheetId, monthTab);
    if (!sections) return; // couldn't read the sheet — try again next working day, don't send a wrong reminder

    if (sections.recruiterFilled && sections.managerFilled) {
      stop();
      // Tab filled by both — mark it and ask the manager (cc recruiter) to confirm, per HR Step 3
      if (markTaskFn) markTaskFn(partOneTaskId);
      if (employee._saveState) employee._saveState();
      console.log(`[Cron] ${monthTab} filled (recruiter + manager) for ${name} — ${partOneTaskId} marked done`);
      if (managerEmail) {
        await sendManagerConfirmationRequest(employee, managerEmail, dayMark, recruiterEmail, eventDateStr).catch(err =>
          console.warn(`[Cron] Manager confirmation request failed for ${name}: ${err.message}`)
        );
        console.log(`[Cron] Manager confirmation request sent for ${name} (${dayMark}-day)`);
      }
      return;
    }

    // Not filled yet — remind whoever's section is empty
    await sendReviewSheetReminder(employee, dayMark, { recruiterMissing: !sections.recruiterFilled, managerMissing: !sections.managerFilled }).catch(err =>
      console.warn(`[Cron] Review sheet reminder failed for ${name}: ${err.message}`)
    );
    console.log(`[Cron] ${dayMark}-day review sheet reminder sent for ${name} — pending: ${[!sections.recruiterFilled && 'recruiter', !sections.managerFilled && 'manager'].filter(Boolean).join(' + ')}`);
  };

  // Every day at 9 AM IST, starting the day after the review call
  jobHandle = startDaily9amCheck(check, { skipDay: istDayKey(eventDate || new Date()) });

  return { stop };
}

// Keep the old export name for any callers outside the review flow (e.g. project intro sheet)
function scheduleManagerSheetReminder(employee, managerEmail, sheetUrl, label, stopTaskId, checkFilledFn) {
  const { name, employeeId } = employee;
  let jobHandle = null;
  let stopped = false;

  const check = async () => {
    if (stopped || employee.status === 'stopped' || employee.isStopped) {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
      return;
    }
    if (isTaskDone(employee.checklist, stopTaskId)) {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
      return;
    }
    let filled = false;
    if (typeof checkFilledFn === 'function') {
      try { filled = await checkFilledFn(); } catch (_) {}
    }
    if (filled) {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
      return;
    }
    const { sendEmail } = require('./emailSender');
    const co = process.env.COMPANY_NAME || '';
    await sendEmail({
      to: managerEmail,
      subject: `Reminder — Please Fill ${label} Sheet for ${name} (${employeeId})`,
      html: `<p>Hi,</p><p>This is a reminder to fill in the <strong>${label}</strong> tracking sheet for <strong>${name}</strong> (${employeeId}).</p>${sheetUrl ? `<p style="margin:16px 0;"><a href="${sheetUrl}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">Open Sheet</a></p>` : ''}<p>Regards,<br/>${co} HR</p>`,
    }).catch(err => console.warn(`[Cron] Manager sheet reminder email failed for ${name}: ${err.message}`));
  };

  // Every day at 9 AM IST, starting tomorrow
  jobHandle = startDaily9amCheck(check, { skipDay: istDayKey() });

  return {
    stop() {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
    },
  };
}

module.exports = {
  scheduleActionOnce,
  scheduleAllMilestones,
  scheduleNoResponseAlert,
  scheduleDocumentReminders,
  scheduleReplyDeadline,
  restoreMilestonesAfterRestart,
  schedule25DayCatchup,
  checkCatchup25Now,
  schedule30DayCatchup,
  schedule60DayReview,
  schedule90DayReview,
  schedule5MonthProbation,
  scheduleBGVInitiate,
  scheduleBGVRequest,
  scheduleManagerSheetReminder,
  scheduleRecruiterSheetPoller,
  schedulePreOnboardingReminders,
  cancelAllJobs,
  startDailyHealthCheck,
  startDataRetentionCron,
};
