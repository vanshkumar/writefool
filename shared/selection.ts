import type { Highlight } from './contracts';

export const COOLDOWN_DAYS = 30;

/** Mix books while preferring unseen and least recently resurfaced passages. */
export function selectHighlights(highlights: Highlight[], count: number, now = new Date(), random = Math.random): Highlight[] {
  const cutoff = now.getTime() - COOLDOWN_DAYS * 86_400_000;
  const ranked = highlights.filter(h => !h.hidden).map(h => ({
    highlight: h,
    sentAt: h.lastSentAt ? Date.parse(h.lastSentAt) : -Infinity,
    tie: random(),
  })).sort((a, b) => a.sentAt - b.sentAt || a.tie - b.tie);
  const selected: Highlight[] = [];
  const seen = new Set<string>();
  const chooseRounds = (pool: typeof ranked) => {
    while (selected.length < count) {
      const roundBooks = new Set<string>();
      let added = false;
      for (const candidate of pool) {
        const h = candidate.highlight;
        if (selected.length >= count) break;
        if (seen.has(h.id) || roundBooks.has(h.bookId)) continue;
        selected.push(h);
        seen.add(h.id);
        roundBooks.add(h.bookId);
        added = true;
      }
      if (!added) break;
    }
  };
  chooseRounds(ranked.filter(h => h.sentAt <= cutoff));
  chooseRounds(ranked.filter(h => h.sentAt > cutoff));
  return selected;
}
