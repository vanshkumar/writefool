import { describe, expect, it } from 'vitest';
import { parseClippings } from '../shared/clippings';

const entry = (kind: string, text: string, location = '10-12', title = 'A Room of One’s Own (Virginia Woolf)') => `${title}\n- Your ${kind} on page 3 | Location ${location} | Added on Monday, September 7, 2026 8:00:00 AM\n\n${text}\n==========\n`;

describe('My Clippings import', () => {
  it('reads BOM/Windows lines, preserves original text and unzoned date, and skips bookmarks', () => {
    const result = parseClippings('\uFEFF' + (entry('Highlight', 'A line.\nAnother line.') + entry('Bookmark', 'Bookmark')).replace(/\n/g, '\r\n'));
    expect(result.warnings).toEqual([]);
    expect(result.books).toHaveLength(1);
    expect(result.books[0]).toMatchObject({ title: 'A Room of One’s Own', author: 'Virginia Woolf' });
    expect(result.books[0].highlights).toHaveLength(1);
    expect(result.books[0].highlights[0]).toMatchObject({ text: 'A line.\nAnother line.', location: '10-12', highlightedAt: 'Monday, September 7, 2026 8:00:00 AM' });
  });
  it('deduplicates repeated highlights and updates notes without changing source identities', () => {
    const original = parseClippings(entry('Highlight', 'Hello.') + entry('Note', 'First thought.', '11'));
    const updated = parseClippings(entry('Highlight', 'Hello.') + entry('Highlight', 'Hello.') + entry('Note', 'First thought.', '11') + entry('Note', 'New thought.', '11'));
    expect(updated.books[0].highlights).toHaveLength(1);
    expect(updated.books[0].highlights[0].sourceId).toBe(original.books[0].highlights[0].sourceId);
    expect(updated.books[0].highlights[0].note).toBe('New thought.');
  });
  it('attaches notes exported before a highlight, but warns for ambiguous or orphan notes', () => {
    const result = parseClippings(entry('Note', 'Attach me.', '11') + entry('Highlight', 'First.') + entry('Highlight', 'Second.', '20-30') + entry('Highlight', 'Third.', '25-35') + entry('Note', 'Ambiguous.', '26') + entry('Note', 'Orphan.', '90'));
    expect(result.books[0].highlights[0].note).toBe('Attach me.');
    expect(result.books[0].highlights[1].note).toBeNull();
    expect(result.warnings).toHaveLength(2);
  });
  it('keeps different books distinct and supports page-only and authorless exports', () => {
    const result = parseClippings(entry('Highlight', 'First.', '10', 'A Book (Writer One)') + entry('Highlight', 'Second.', '10', 'A Book (Writer Two)') + 'Personal document\n- Your Highlight on page 9 | Added on Monday, September 7, 2026\n\nPassage.\n==========');
    expect(result.books).toHaveLength(3);
    expect(new Set(result.books.map((book) => book.sourceId)).size).toBe(3);
    expect(result.books[2]).toMatchObject({ title: 'Personal document', author: '' });
    expect(result.books[2].highlights[0].location).toBe('page 9');
  });
  it('surfaces malformed entries, empty passages and Kindle export limits', () => {
    const result = parseClippings('bad file\n==========\n' + entry('Highlight', '') + entry('Highlight', '<You have reached the clipping limit for this item>') + entry('Highlight', 'Valid.'));
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join(' ')).toContain('export limit');
    expect(result.books[0].highlights).toHaveLength(1);
  });
  it('returns an empty preview for an empty file', () => { expect(parseClippings('')).toEqual({ books: [], warnings: [] }); });
});
