import type { PlannerEvent } from './types';

const escapeText = (value: string) => value
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
  new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const validTime = (value: string | null): value is string => Boolean(value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
const toCalendarDate = (value: string) => value.replaceAll('-', '');
const toCalendarDateTime = (date: string, time: string) => `${toCalendarDate(date)}T${time.replace(':', '')}00`;
const nextDate = (value: string) => {
  const day = new Date(`${value}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
};

// RFC 5545 folds content lines at 75 octets without splitting UTF-8 characters.
const foldLine = (line: string) => {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) {
      parts.push(current);
      current = ' ';
      bytes = 1;
    }
    current += character;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n');
};

export function createCalendarFile(events: PlannerEvent[], generatedAt = new Date()) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gather//Priests quorum//EN',
    'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Gather activities',
    'BEGIN:VTIMEZONE', 'TZID:America/Phoenix', 'BEGIN:STANDARD',
    'DTSTART:19700101T000000', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0700',
    'TZNAME:MST', 'END:STANDARD', 'END:VTIMEZONE',
  ];
  for (const event of events) {
    if (!validDate(event.eventDate)) continue;
    const startIsTimed = validTime(event.startTime);
    const endIsTimed = validTime(event.endTime);
    const description = [
      event.details,
      event.notes,
      event.dateCaveat,
      event.meetingPoint ? `Meeting point: ${event.meetingPoint}` : '',
      !event.confirmed && event.status ? `Confirm before relying on this plan: ${event.status}` : '',
      startIsTimed ? '' : event.startTime ? `Source start time needs checking: ${event.startTime}` : 'Time: to confirm',
      event.endTime && !endIsTimed ? `Source end time needs checking: ${event.endTime}` : '',
      event.sourceUrl ? `Source schedule: ${event.sourceUrl}` : '',
    ].filter(Boolean).join('\n');
    const stamp = generatedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    lines.push('BEGIN:VEVENT', `UID:${escapeText(event.id)}@gather-planner`, `DTSTAMP:${stamp}`, `SUMMARY:${escapeText(event.originalTitle)}`);
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (startIsTimed && event.startTime) {
      lines.push(`DTSTART;TZID=America/Phoenix:${toCalendarDateTime(event.eventDate, event.startTime)}`);
      if (endIsTimed && event.endTime && event.endTime > event.startTime) lines.push(`DTEND;TZID=America/Phoenix:${toCalendarDateTime(event.eventDate, event.endTime)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${toCalendarDate(event.eventDate)}`);
      lines.push(`DTEND;VALUE=DATE:${toCalendarDate(nextDate(event.eventDate))}`);
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

export function downloadCalendar(events: PlannerEvent[]) {
  const blob = new Blob([createCalendarFile(events)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'gather-activities.ics';
  anchor.click();
  URL.revokeObjectURL(url);
}
