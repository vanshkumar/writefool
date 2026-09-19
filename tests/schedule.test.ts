import { describe, expect, it } from 'vitest';
import { advanceOccurrence, nextOccurrence } from '../shared/schedule';

const schedule = { intervalDays: 2, localTime: '08:00', timezone: 'America/Los_Angeles' };
describe('local calendar schedules', () => {
  it('chooses the next local send time', () => {
    expect(nextOccurrence(schedule, new Date('2026-09-08T14:00:00Z')).toISOString()).toBe('2026-09-08T15:00:00.000Z');
    expect(nextOccurrence(schedule, new Date('2026-09-08T15:00:00Z')).toISOString()).toBe('2026-09-09T15:00:00.000Z');
  });
  it('preserves morning time across DST rather than adding 48 hours', () => {
    expect(advanceOccurrence(schedule, new Date('2026-03-07T16:00:00Z'), new Date('2026-03-07T16:00:00Z')).toISOString()).toBe('2026-03-09T15:00:00.000Z');
    expect(advanceOccurrence(schedule, new Date('2026-10-31T15:00:00Z'), new Date('2026-10-31T15:00:00Z')).toISOString()).toBe('2026-11-02T16:00:00.000Z');
  });
  it('moves a nonexistent time to the first valid minute', () => {
    expect(nextOccurrence({ ...schedule, localTime: '02:30' }, new Date('2026-03-08T08:00:00Z')).toISOString()).toBe('2026-03-08T10:00:00.000Z');
  });
  it('chooses the earlier instant in a repeated local hour', () => {
    expect(nextOccurrence({ ...schedule, localTime: '01:30' }, new Date('2026-11-01T07:00:00Z')).toISOString()).toBe('2026-11-01T08:30:00.000Z');
  });
  it('skips an outage backlog while retaining the original cadence', () => {
    expect(advanceOccurrence(schedule, new Date('2026-09-01T15:00:00Z'), new Date('2026-09-08T18:00:00Z')).toISOString()).toBe('2026-09-09T15:00:00.000Z');
  });
});
