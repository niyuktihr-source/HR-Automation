const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { create25DayCatchupEvent, create30DayCatchupEvent, createReviewEvent } = require('./calendarService');
const {
  sendPeriodicReviewReminder,
  sendPreProbationReminder,
  sendPhaseCompletionSummary,
  sendReviewSummaryRequest,
  sendNoReplyEscalation,
  sendRecruiterSheetReminder,
  sendManagerConfirmationRequest,
} = require('./emailSender');
const {
  mark30DayDone,
  mark60DayDone,
  mark90DayDone,
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

// Return a Date that is `days` calendar days after the given Date
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Advance to next Monday if the date falls on a weekend
function ensureWorkingDay(date) {
  const d = new Date(date);
  if (d.getDay() === 6) d.setDate(d.getDate() + 2); // Saturday → Monday
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sunday  → Monday
  return d;
}

// Return a Date that is `workingDays` working days (Mon–Fri) after the given Date
function addWorkingDays(date, workingDays) {
  const d = new Date(date);
  let added = 0;
  while (added < workingDays) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added++; // skip Saturday (6) and Sunday (0)
  }
  return d;
}

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

// Schedule the employee feedback form to be sent on the 25th calendar day after DOJ,
// adjusted to the next working day if it falls on a weekend.
// Also creates a 25-day catchup calendar event and mentions it in the email.
function scheduleOnboardingSurvey(employee, markTaskFn) {
  const { name, employeeId, officialEmail, doj } = employee;
  const dojDate = new Date(doj);
  const surveyDate = ensureWorkingDay(addDays(dojDate, config.milestones.surveyday));

  return scheduleOnce(surveyDate, `Feedback Form — ${name}`, async () => {
    const { sendEmail } = require('./emailSender');

    // Create 25-day catchup calendar event and get back the event link + date
    let catchupCalendarLink = null;
    let catchupDateStr = null;
    if (employee._auth) {
      const calResult = await create25DayCatchupEvent(employee._auth, employee).catch(err => {
        console.warn(`[Cron] 25-day calendar event failed for ${name} — email still sent. (${err.message})`);
        return null;
      });
      if (calResult) {
        catchupCalendarLink = calResult.htmlLink;
        const cfg = config.calendarEvents.catchup25day;
        const d = calResult.eventDate;
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const hour = cfg.hour > 12 ? cfg.hour - 12 : cfg.hour;
        const ampm = cfg.hour >= 12 ? 'PM' : 'AM';
        catchupDateStr = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} at ${hour}:${String(cfg.minute).padStart(2,'0')} ${ampm} IST`;
      }
    }

    const catchupSection = catchupDateStr
      ? `<p>You also have a <strong>25-Day Catchup Call</strong> scheduled on <strong>${catchupDateStr}</strong> with your HR/Recruiter. Please check your calendar for the invite${catchupCalendarLink ? ` or <a href="${catchupCalendarLink}">view the event here</a>` : ''}.`
      : `<p>Your HR team will be in touch to schedule a 25-day catchup call with you soon.</p>`;

    const feedbackFormLink = process.env.EMPLOYEE_FEEDBACK_FORM_LINK;
    const formSection = feedbackFormLink
      ? `<p><a href="${feedbackFormLink}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;display:inline-block;">Employee Feedback Form</a></p>`
      : `<p style="color:#e65100;"><strong>Note:</strong> The feedback form link has not been configured yet. HR will share it with you separately.</p>`;

    await sendEmail({
      to: officialEmail || employee.personalEmail,
      subject: `Employee Feedback Form — ${process.env.COMPANY_NAME}`,
      html: `
        <p>Dear ${name},</p>
        <p>You've been with us for 25 days! Please take a moment to fill in the employee feedback form:</p>
        ${formSection}
        ${catchupSection}
        <p>Regards,<br/>HR Team, ${process.env.COMPANY_NAME}</p>
      `,
    });
    if (markTaskFn) markTaskFn('t38');
    if (employee._saveState) employee._saveState();
    console.log(`[Cron] Feedback form sent to ${name} (${employeeId})`);
  });
}

// Schedule a day-before reminder for a milestone (fires one calendar day before fireDate)
function scheduleDayBeforeReminder(employee, dayMark, fireDate) {
  const { name } = employee;
  const reminderDate = addDays(new Date(fireDate), -1);
  if (reminderDate <= new Date()) return null; // already past — skip
  return scheduleOnce(reminderDate, `Day-Before Reminder (${dayMark}-day) — ${name}`, async () => {
    const { sendDayBeforeReminder } = require('./emailSender');
    await sendDayBeforeReminder(employee, dayMark).catch(err =>
      console.warn(`[Cron] Day-before reminder (${dayMark}-day) failed for ${name}: ${err.message}`)
    );
    console.log(`[Cron] Day-before reminder sent for ${name} — ${dayMark}-day milestone tomorrow`);
  });
}

// Schedule the 25th day catchup call email to HR + new joiner
function schedule25DayCatchup(employee, markTaskFn) {
  const { name, employeeId, doj } = employee;
  const fireDate = ensureWorkingDay(addDays(new Date(doj), config.milestones.surveyday));
  scheduleDayBeforeReminder(employee, 25, fireDate);

  return scheduleOnce(fireDate, `25-Day Catchup — ${name}`, async () => {
    const { send25DayCatchupEmail } = require('./emailSender');
    const { mark25DayCatchupDone } = require('./statusTracker');

    await send25DayCatchupEmail(employee).catch(err =>
      console.warn(`[Cron] 25-day catchup email failed for ${name}: ${err.message}`)
    );
    const { sendJoineeReviewNotification } = require('./emailSender');
    await sendJoineeReviewNotification(employee, 25).catch(err =>
      console.warn(`[Cron] 25-day joinee notification failed for ${name}: ${err.message}`)
    );
    console.log(`[Cron] 25-day catchup email sent for ${name} (${employeeId})`);
    if (markTaskFn) markTaskFn('t63');
    if (employee._auth) await mark25DayCatchupDone(employee._auth, employee).catch(() => {});
    if (employee._saveState) employee._saveState();
  });
}

// Schedule the 30-day catchup call reminder
// contacts: { recruiterEmail, managerEmail, itEmail }
// markTaskFn (optional): function(taskId) to mark checklist tasks from within the callback
function schedule30DayCatchup(employee, recruiterEmail, managerEmail, contacts, markTaskFn) {
  const { name, employeeId, doj } = employee;
  const fireDate = ensureWorkingDay(addDays(new Date(doj), config.milestones.catchup30day));
  scheduleDayBeforeReminder(employee, 30, fireDate);

  return scheduleOnce(fireDate, `30-Day Catchup — ${name}`, async () => {
    if (employee._auth) await create30DayCatchupEvent(employee._auth, employee).catch(err =>
      console.warn(`[Cron] 30-day calendar event failed for ${name} — email still sent. (${err.message})`)
    );

    // Part 1: send review email to manager + joinee, then poll sheet daily until recruiter fills it
    const { send30DayTechnicalReview } = require('./emailSender');
    await send30DayTechnicalReview(employee).catch(err =>
      console.warn(`[Cron] 30-day technical review email failed for ${name}: ${err.message}`)
    );
    console.log(`[Cron] 30-day technical review email sent for ${name} (${employeeId})`);

    if (employee._auth) await mark30DayDone(employee._auth, employee).catch(() => {});

    // Poll sheet daily — remind recruiter until they fill it, then fire Part 2
    scheduleRecruiterSheetPoller(employee, recruiterEmail, managerEmail, 30, 't43', markTaskFn);

    if (employee._saveState) employee._saveState();
  });
}

// Schedule 60-day review reminder
// contacts: { recruiterEmail, managerEmail, itEmail }
function schedule60DayReview(employee, recruiterEmail, managerEmail, contacts, markTaskFn) {
  const { name, employeeId, doj } = employee;
  const fireDate = ensureWorkingDay(addDays(new Date(doj), config.milestones.review60day));
  scheduleDayBeforeReminder(employee, 60, fireDate);

  return scheduleOnce(fireDate, `60-Day Review — ${name}`, async () => {
    await sendPeriodicReviewReminder(employee, recruiterEmail, managerEmail, 60);
    console.log(`[Cron] 60-day review reminder sent for ${name} (${employeeId})`);
    if (employee._auth) await createReviewEvent(employee._auth, employee, 60).catch(err =>
      console.warn(`[Cron] 60-day calendar event failed for ${name} — email still sent. (${err.message})`)
    );

    if (employee._auth) await mark60DayDone(employee._auth, employee).catch(() => {});

    // Poll sheet daily — remind recruiter until they fill it, then fire Part 2
    scheduleRecruiterSheetPoller(employee, recruiterEmail, managerEmail, 60, 't46', markTaskFn);

    if (employee._saveState) employee._saveState();
  });
}

// Schedule 90-day review reminder
// contacts: { recruiterEmail, managerEmail, itEmail }
function schedule90DayReview(employee, recruiterEmail, managerEmail, contacts, markTaskFn) {
  const { name, employeeId, doj } = employee;
  const fireDate = ensureWorkingDay(addDays(new Date(doj), config.milestones.review90day));
  scheduleDayBeforeReminder(employee, 90, fireDate);

  return scheduleOnce(fireDate, `90-Day Review — ${name}`, async () => {
    await sendPeriodicReviewReminder(employee, recruiterEmail, managerEmail, 90);
    console.log(`[Cron] 90-day review reminder sent for ${name} (${employeeId})`);
    if (employee._auth) await createReviewEvent(employee._auth, employee, 90).catch(err =>
      console.warn(`[Cron] 90-day calendar event failed for ${name} — email still sent. (${err.message})`)
    );

    if (employee._auth) await mark90DayDone(employee._auth, employee).catch(() => {});

    // Poll sheet daily — remind recruiter until they fill it, then fire Part 2
    scheduleRecruiterSheetPoller(employee, recruiterEmail, managerEmail, 90, 't49', markTaskFn);

    if (employee._saveState) employee._saveState();
  });
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

  return scheduleOnce(fireDate, `Pre-Probation — ${name}`, async () => {
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
    scheduleOnboardingSurvey(employee, markTaskFn),
    schedule25DayCatchup(employee, markTaskFn),
    schedule30DayCatchup(employee, recruiterEmail, managerEmail, contacts, markTaskFn),
    schedule60DayReview(employee, recruiterEmail, managerEmail, contacts, markTaskFn),
    schedule90DayReview(employee, recruiterEmail, managerEmail, contacts, markTaskFn),
    schedule5MonthProbation(employee, managerEmail),
  ].filter(Boolean);

  activeJobs[employeeId] = { tasks, employee, contacts };
  console.log(`[Cron] All milestones scheduled for ${employee.name} (${employeeId})`);
  return tasks;
}

// Re-register milestone cron jobs after a process restart
// Only re-registers jobs whose corresponding tasks are not yet done.
// completedMilestones: array of completed task IDs e.g. ['t38', 't45']
// Task → milestone map: survey→t38, 30day→t45, 60day→t48, 90day→t51, probation→t52
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

  if (!done.has('t38')) {
    const t = scheduleOnboardingSurvey(employee, markTaskFn);
    if (t) tasks.push(t);
  } else {
    console.log(`[Cron]   Skipping onboarding survey (t38 already done)`);
  }

  if (!done.has('t63')) {
    const t = schedule25DayCatchup(employee, markTaskFn);
    if (t) tasks.push(t);
  } else {
    console.log(`[Cron]   Skipping 25-day catchup (t63 already done)`);
  }

  if (!done.has('t43')) {
    const t = schedule30DayCatchup(employee, recruiterEmail, managerEmail, contacts, markTaskFn);
    if (t) tasks.push(t);
  } else {
    console.log(`[Cron]   Skipping 30-day catchup (t43 already done)`);
  }

  if (!done.has('t48')) {
    const t = schedule60DayReview(employee, recruiterEmail, managerEmail, contacts, markTaskFn);
    if (t) tasks.push(t);
  } else {
    console.log(`[Cron]   Skipping 60-day review (t48 already done)`);
  }

  if (!done.has('t51')) {
    const t = schedule90DayReview(employee, recruiterEmail, managerEmail, contacts, markTaskFn);
    if (t) tasks.push(t);
  } else {
    console.log(`[Cron]   Skipping 90-day review (t51 already done)`);
  }

  if (!done.has('t52')) {
    const t = schedule5MonthProbation(employee, managerEmail);
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
function scheduleRecruiterSheetPoller(employee, recruiterEmail, managerEmail, dayMark, partOneTaskId, markTaskFn) {
  const { name, employeeId } = employee;
  const monthTab = dayMark === 30 ? 'Tracking - Month -1' : dayMark === 60 ? 'Tracking - Month -2' : 'Tracking - Month -3';
  let jobHandle = null;
  let stopped = false;

  const sheetUrl = employee.projectIntroSheetId
    ? `https://docs.google.com/spreadsheets/d/${employee.projectIntroSheetId}`
    : null;

  const isSheetFilled = async () => {
    if (!employee._auth || !employee.projectIntroSheetId) return false;
    try {
      const { google } = require('googleapis');
      const sheets = google.sheets({ version: 'v4', auth: employee._auth });
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: employee.projectIntroSheetId,
        range: `'${monthTab}'!B14:B16`,
      });
      const rows = (res.data.values || []);
      return rows.some(r => r && r[0] && String(r[0]).trim().length > 0);
    } catch (err) {
      console.warn(`[Cron] Sheet poll failed for ${name} (${dayMark}-day): ${err.message}`);
      return false;
    }
  };

  const check = async () => {
    if (stopped || employee.status === 'stopped' || employee.isStopped) {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
      return;
    }
    if (isTaskDone(employee.checklist, partOneTaskId)) {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
      return;
    }

    const filled = await isSheetFilled();

    if (filled) {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
      // Part 1 complete — mark review task green
      if (markTaskFn) markTaskFn(partOneTaskId);
      if (employee._saveState) employee._saveState();
      console.log(`[Cron] Recruiter filled ${dayMark}-day sheet for ${name} — ${partOneTaskId} marked done`);
      // Part 2 — email manager to confirm review is done
      if (managerEmail) {
        await sendManagerConfirmationRequest(employee, managerEmail, dayMark).catch(err =>
          console.warn(`[Cron] Manager confirmation request failed for ${name}: ${err.message}`)
        );
        console.log(`[Cron] Manager confirmation request sent for ${name} (${dayMark}-day)`);
      }
      return;
    }

    // Sheet not filled yet — remind recruiter
    if (recruiterEmail) {
      await sendRecruiterSheetReminder(employee, recruiterEmail, dayMark, sheetUrl).catch(err =>
        console.warn(`[Cron] Recruiter sheet reminder failed for ${name}: ${err.message}`)
      );
      console.log(`[Cron] Recruiter sheet reminder (${dayMark}-day) sent for ${name}`);
    }
  };

  // First check 24h after the initial review email fires, then daily at 9 AM IST
  const msDelay = 24 * 60 * 60 * 1000;
  setTimeout(async () => {
    await check();
    if (!stopped) {
      jobHandle = cron.schedule('0 9 * * *', check, { timezone: config.timezone || 'Asia/Kolkata' });
    }
  }, msDelay);

  return {
    stop() {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
    },
  };
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

  const msDelay = 24 * 60 * 60 * 1000;
  setTimeout(async () => {
    await check();
    if (!stopped) {
      jobHandle = cron.schedule('0 9 * * *', check, { timezone: config.timezone || 'Asia/Kolkata' });
    }
  }, msDelay);

  return {
    stop() {
      stopped = true;
      if (jobHandle) { try { jobHandle.stop(); } catch (_) {} }
    },
  };
}

module.exports = {
  scheduleAllMilestones,
  scheduleNoResponseAlert,
  scheduleDocumentReminders,
  scheduleReplyDeadline,
  restoreMilestonesAfterRestart,
  scheduleOnboardingSurvey,
  schedule25DayCatchup,
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
