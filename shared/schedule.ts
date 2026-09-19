import { Temporal } from '@js-temporal/polyfill';
import type { Preferences } from './contracts';

type Schedule = Pick<Preferences, 'intervalDays' | 'localTime' | 'timezone'>;

/** Resolve a wall-clock minute; DST gaps move to the first real minute, folds use the earlier one. */
export function localOccurrence(date: Temporal.PlainDate, schedule: Schedule): Date {
  const [hour, minute] = schedule.localTime.split(':').map(Number);
  let wall = date.toPlainDateTime({ hour, minute });
  for (let offset = 0; offset <= 24 * 60; offset++) {
    const earlier = wall.toZonedDateTime(schedule.timezone, { disambiguation: 'earlier' });
    if (earlier.toPlainDateTime().equals(wall)) return new Date(earlier.epochMilliseconds);
    wall = wall.add({ minutes: 1 });
  }
  throw new Error('Unable to resolve the selected local time');
}

export function nextOccurrence(schedule: Schedule, after = new Date()): Date {
  const date = Temporal.Instant.from(after.toISOString()).toZonedDateTimeISO(schedule.timezone).toPlainDate();
  const today = localOccurrence(date, schedule);
  return today > after ? today : localOccurrence(date.add({ days: 1 }), schedule);
}

/** Calendar-day cadence anchored to the scheduled slot, skipping an outage backlog. */
export function advanceOccurrence(schedule: Schedule, scheduled: Date, now = new Date()): Date {
  let date = Temporal.Instant.from(scheduled.toISOString()).toZonedDateTimeISO(schedule.timezone).toPlainDate();
  const today = Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(schedule.timezone).toPlainDate();
  const elapsed = date.until(today, { largestUnit: 'days' }).days;
  const jumps = Math.max(1, Math.floor(elapsed / schedule.intervalDays));
  date = date.add({ days: jumps * schedule.intervalDays });
  let next = localOccurrence(date, schedule);
  if (next <= now) next = localOccurrence(date.add({ days: schedule.intervalDays }), schedule);
  return next;
}
