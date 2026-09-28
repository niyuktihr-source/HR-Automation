// roomBooking.js — books a free meeting room (Google Workspace room resource) on an
// onboarding calendar event.
//
// Rooms come from MEETING_ROOMS in .env — a comma-separated list of
//   <resource email>|<room name>|<capacity>
// e.g. MEETING_ROOMS=c_1880abc@resource.calendar.google.com|Board Room|10,c_1880def@resource.calendar.google.com|Huddle 1|4
//
// For each event: count the people invited, ask Calendar free/busy which rooms are free
// for the whole slot, and pick the smallest free room that seats everyone. If none is
// free the event is still created — with its Meet link — and HR + the recruiter are
// emailed so they can arrange a room by hand. With MEETING_ROOMS unset, booking is off.

// Parse MEETING_ROOMS. Entries that are malformed are skipped with a warning.
function parseRooms(raw = process.env.MEETING_ROOMS) {
  if (!raw || !raw.trim()) return [];
  const rooms = [];
  for (const entry of raw.split(',')) {
    const [email, name, capacity] = entry.split('|').map(s => (s || '').trim());
    const cap = parseInt(capacity, 10);
    if (!email || !email.includes('@') || !Number.isFinite(cap) || cap < 1) {
      if (entry.trim()) console.warn(`[Rooms] Ignoring malformed MEETING_ROOMS entry "${entry.trim()}" — expected email|name|capacity`);
      continue;
    }
    rooms.push({ email, name: name || email, capacity: cap });
  }
  return rooms;
}

// Pure: given rooms, the free/busy result per room email, and a head count, returns the
// smallest room that is free and seats everyone (ties → listed order), or null.
// A room whose free/busy lookup errored (e.g. no access) counts as unavailable.
function pickRoom(rooms, freeBusyCalendars, attendeeCount) {
  const candidates = rooms
    .map((room, index) => ({ room, index }))
    .filter(({ room }) => room.capacity >= attendeeCount)
    .filter(({ room }) => {
      const fb = freeBusyCalendars[room.email];
      if (!fb || (fb.errors && fb.errors.length)) return false;
      return !(fb.busy && fb.busy.length);
    })
    .sort((a, b) => a.room.capacity - b.room.capacity || a.index - b.index);
  return candidates.length ? candidates[0].room : null;
}

// Number of people on an event — attendees that aren't rooms, plus the organiser (the
// automation account running the meeting) when they aren't already listed.
function countPeople(event) {
  const people = (event.attendees || []).filter(a => a && a.email && !a.resource);
  const organizer = process.env.GMAIL_USER;
  const organizerListed = organizer && people.some(a => a.email.toLowerCase() === organizer.toLowerCase());
  return people.length + (organizer && !organizerListed ? 1 : 0);
}

// Adds a free room to `event` (as a resource attendee + location) in place. Returns the
// chosen room, { unavailable: reason } when none could be booked, or null when room
// booking is switched off (MEETING_ROOMS not set) — no alert in that case.
async function attachRoom(calendar, event) {
  const rooms = parseRooms();
  if (rooms.length === 0) return null;

  const attendeeCount = countPeople(event);
  if (!rooms.some(r => r.capacity >= attendeeCount)) {
    return { unavailable: `no configured room seats ${attendeeCount} people` };
  }

  let calendars;
  try {
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: event.start.dateTime,
        timeMax: event.end.dateTime,
        timeZone: event.start.timeZone,
        items: rooms.map(r => ({ id: r.email })),
      },
    });
    calendars = res.data.calendars || {};
  } catch (err) {
    console.warn(`[Rooms] Free/busy lookup failed: ${err.message}`);
    return { unavailable: `room availability could not be checked (${err.message})` };
  }

  const room = pickRoom(rooms, calendars, attendeeCount);
  if (!room) return { unavailable: `no room seating ${attendeeCount} people is free at that time` };

  event.attendees = [...(event.attendees || []), { email: room.email, resource: true }];
  event.location = room.name;
  return room;
}

// Rooms accept or decline a booking a moment after the event is created (e.g. a clash
// that free/busy didn't show yet, or a room that only accepts certain people). Returns
// true if the room declined.
async function roomDeclined(calendar, eventId, roomEmail) {
  await new Promise(r => setTimeout(r, 5000));
  try {
    const res = await calendar.events.get({ calendarId: 'primary', eventId });
    const att = (res.data.attendees || []).find(a => a.email && a.email.toLowerCase() === roomEmail.toLowerCase());
    return !!att && att.responseStatus === 'declined';
  } catch (err) {
    console.warn(`[Rooms] Could not confirm room booking on event ${eventId}: ${err.message}`);
    return false;
  }
}

module.exports = { parseRooms, pickRoom, countPeople, attachRoom, roomDeclined };
