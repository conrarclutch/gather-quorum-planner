import { describe, expect, it } from 'vitest';
import { createCalendarFile } from '../src/calendar';
import type { PlannerEvent } from '../src/types';

const event = (patch: Partial<PlannerEvent> = {}): PlannerEvent => ({
  id: 'synthetic-event', groupId: 'synthetic-group', originalTitle: 'Sample activity',
  sourceUrl: 'https://example.invalid/schedule', sourceTab: 'Sample schedule', sourceRow: 1,
  sourceId: 'sample', sourceDate: 'Dec 31', originalDateSerial: null,
  dateCaveat: 'Year inferred from the source heading.', eventDate: '2026-12-31',
  yearConfidence: 'inferred', status: 'Details to confirm', scope: 'Sample group', details: '',
  location: null, meetingPoint: null, departureTime: null, startTime: null, endTime: null,
  returnTime: null, leader: null, notes: null, confirmed: false, updatedAt: '', createdAt: '',
  ...patch,
});
const unfold = (value: string) => value.replace(/\r\n /g, '');

describe('calendar exports preserve planning uncertainty', () => {
  it('exports an unknown time as a whole day with an exclusive end across the year boundary', () => {
    const calendar = unfold(createCalendarFile([event()]));
    expect(calendar).toContain('DTSTART;VALUE=DATE:20261231');
    expect(calendar).toContain('DTEND;VALUE=DATE:20270101');
    expect(calendar).toContain('Time: to confirm');
    expect(calendar).toContain('Year inferred from the source heading.');
    expect(calendar).not.toContain('DTSTART;TZID');
  });

  it('exports explicit times in the named Arizona timezone without inventing an end', () => {
    const calendar = unfold(createCalendarFile([event({ startTime: '10:30' })]));
    expect(calendar).toContain('TZID:America/Phoenix');
    expect(calendar).toContain('TZOFFSETTO:-0700');
    expect(calendar).toContain('DTSTART;TZID=America/Phoenix:20261231T103000');
    expect(calendar).not.toContain('DTEND');
  });

  it('retains an ambiguous source time as a note instead of choosing AM or PM', () => {
    const calendar = unfold(createCalendarFile([event({ startTime: '6:00-7:30' })]));
    expect(calendar).toContain('DTSTART;VALUE=DATE:20261231');
    expect(calendar).toContain('Source start time needs checking: 6:00-7:30');
  });

  it('rejects impossible dates and folds long Unicode text without losing content', () => {
    const title = 'Sample · '.repeat(22);
    const calendar = createCalendarFile([event({ eventDate: '2026-02-31' }), event({ originalTitle: title })]);
    expect(calendar.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(unfold(calendar)).toContain(`SUMMARY:${title}`);
    expect(calendar.split('\r\n').every(line => new TextEncoder().encode(line).length <= 75)).toBe(true);
  });
});
