import { describe, expect, it } from 'vitest';
import type { Highlight } from '../shared/contracts';
import { selectHighlights } from '../shared/selection';

const now = new Date('2026-09-08T15:00:00Z');
const h = (id: string, bookId: string, lastSentAt: string | null = null): Highlight => ({ id, bookId, title: bookId, author: 'Author', text: id, note: null, location: null, hidden: false, lastSentAt, importedAt: now.toISOString() });
describe('highlight rediscovery selection', () => {
  it('rotates books even when one book has many highlights', () => {
    const selected = selectHighlights([h('a1', 'a'), h('a2', 'a'), h('a3', 'a'), h('b1', 'b'), h('c1', 'c')], 4, now, () => 0.5);
    expect(selected.map(x => x.id)).toEqual(['a1', 'b1', 'c1', 'a2']);
  });
  it('prefers unseen highlights and then the oldest sent, excluding hidden entries', () => {
    const selected = selectHighlights([h('old', 'a', '2026-06-01'), h('new', 'b'), { ...h('hidden', 'c'), hidden: true }, h('recent', 'd', '2026-09-07')], 3, now, () => 0.5);
    expect(selected.map(x => x.id)).toEqual(['new', 'old', 'recent']);
  });
  it('returns a small library once each without changing source records', () => {
    const items = [h('a', 'a', '2026-09-07'), h('b', 'b', '2026-09-06')];
    expect(selectHighlights(items, 5, now).map(x => x.id)).toEqual(['b', 'a']);
    expect(items[0].lastSentAt).toBe('2026-09-07');
  });
  it('fills from the oldest cooldown highlight when the pool is exhausted', () => {
    const items = [h('a', 'a', '2026-09-07'), h('b', 'b', '2026-09-06'), h('unseen', 'a')];
    expect(selectHighlights(items, 2, now, () => 0.5).map(x => x.id)).toEqual(['unseen', 'b']);
  });
});
