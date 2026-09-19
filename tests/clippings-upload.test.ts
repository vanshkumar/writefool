import { describe, expect, it } from 'vitest';
import type { ClippingsPreview } from '../shared/contracts';
import { prepareClippingsBatches } from '../src/import-batches';

describe('resumable clippings upload preparation', () => {
  it('splits large books into stable, sequential bounded batches and carries explicit book matches', () => {
    const preview: ClippingsPreview = {
      books: [
        { sourceId: 'large', title: 'Large book', author: 'Writer', highlights: Array.from({ length: 620 }, (_, index) => ({ sourceId: `highlight-${index}`, text: `Passage ${index}` })) },
        { sourceId: 'other', title: 'Other book', author: 'Writer', highlights: [{ sourceId: 'last', text: 'A final passage' }] },
      ],
      matches: [], warnings: Array.from({ length: 120 }, (_, index) => `Warning ${index}`),
    };
    const choices = { large: 'existing-book', other: 'new' };
    const batches = prepareClippingsBatches(preview, choices, 'stable-run');
    expect(batches).toHaveLength(8);
    expect(batches.every(batch => batch.books.length === 1 && batch.books[0].highlights.length <= 100)).toBe(true);
    expect(batches.map(batch => batch.batchId)).toEqual(Array.from({ length: 8 }, (_, index) => `stable-run:${index}`));
    expect(batches.flatMap(batch => batch.books[0].highlights)).toEqual(preview.books.flatMap(book => book.highlights));
    expect(batches[0].books[0].targetBookId).toBe('existing-book');
    expect(batches.at(-1)?.books[0].targetBookId).toBe('new');
    expect(batches[0].warnings).toHaveLength(100);
    expect(preview.warnings).toHaveLength(120);
    expect(batches.filter(batch => batch.complete)).toEqual([batches.at(-1)]);
    expect(prepareClippingsBatches(preview, choices, 'stable-run')).toEqual(batches);
    choices.large = 'different-choice';
    expect(batches[0].books[0].targetBookId).toBe('existing-book');
  });

  it('bounds encoded payload size as well as highlight count', () => {
    const preview: ClippingsPreview = { books: [{ sourceId: 'large-quotes', title: 'A book', author: 'Writer', highlights: Array.from({ length: 30 }, (_, index) => ({ sourceId: String(index), text: '文'.repeat(50000) })) }], warnings: [], matches: [] };
    const batches = prepareClippingsBatches(preview, { 'large-quotes': 'new' }, 'large-payload');
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every(batch => new TextEncoder().encode(JSON.stringify(batch)).byteLength < 3 * 1024 * 1024)).toBe(true);
    expect(batches.flatMap(batch => batch.books[0].highlights)).toHaveLength(30);
  });

  it('requires explicit choices instead of silently resolving ambiguous books', () => {
    const preview: ClippingsPreview = { books: [{ sourceId: 'ambiguous', title: 'Same title', author: 'Writer', highlights: [{ sourceId: 'h', text: 'A thought' }] }], matches: [], warnings: [] };
    expect(() => prepareClippingsBatches(preview, {}, 'run')).toThrow('Choose where to import Same title.');
  });
});
