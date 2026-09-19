import type { NormalizedBook, NormalizedHighlight } from './contracts';

/** Stable identifier, not a security hash. Length-delimited callers avoid ambiguous joins. */
export function stableId(value: string): string {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, '0');
}

const clean = (value: string) => value.trim().replace(/\s+/g, ' ');
const key = (value: string) => clean(value).normalize('NFKC').toLowerCase();
interface Entry { book: NormalizedBook; kind: string; text: string; location: string | null; date: string | null; index: number }

/** English My Clippings.txt; source timestamps remain verbatim because the file has no timezone. */
export function parseClippings(input: string): { books: NormalizedBook[]; warnings: string[] } {
  const books = new Map<string, NormalizedBook>();
  const entries: Entry[] = [];
  const warnings: string[] = [];
  const blocks = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/^={10,}\s*$/m);
  blocks.forEach((block, index) => {
    const lines = block.trim().split('\n');
    if (!block.trim()) return;
    const metadataIndex = lines.findIndex((line) => /^-\s*(?:Your\s+)?(?:Highlight|Note|Bookmark)\b/i.test(line));
    if (metadataIndex < 1) {
      warnings.push(`Entry ${index + 1}: could not read English clipping metadata; skipped.`);
      return;
    }
    const header = clean(lines.slice(0, metadataIndex).join(' '));
    const authorMatch = header.match(/^(.*)\s+\(([^()]*)\)\s*$/);
    const title = authorMatch ? authorMatch[1].trim() : header;
    const author = authorMatch ? authorMatch[2].trim() : '';
    const metadata = lines[metadataIndex];
    const kind = metadata.match(/(?:Highlight|Note|Bookmark)/i)![0].toLowerCase();
    if (kind === 'bookmark') return;
    const body = lines.slice(metadataIndex + 1).join('\n').trim();
    if (/clipping limit|export limit|limit.*(?:clipping|highlight)|unable to (?:display|export)/i.test(body)) {
      warnings.push(`Entry ${index + 1}: Kindle reports an export limit; this passage is unavailable.`);
      return;
    }
    if (!body || !title) {
      warnings.push(`Entry ${index + 1}: empty ${kind} or book title; skipped.`);
      return;
    }
    const locationMatch = metadata.match(/\bLocation(?:s)?\s*:?\s*([\d,]+(?:\s*-\s*[\d,]+)?)/i);
    const pageMatch = metadata.match(/\bpage\s+([\d,]+(?:\s*-\s*[\d,]+)?)/i);
    const location = locationMatch ? locationMatch[1].replace(/[\s,]/g, '') : pageMatch ? `page ${pageMatch[1].replace(/[\s,]/g, '')}` : null;
    const sourceId = `clippings:${stableId(JSON.stringify([key(title), key(author)]))}`;
    let book = books.get(sourceId);
    if (!book) {
      book = { sourceId, title, author, highlights: [] };
      books.set(sourceId, book);
    }
    entries.push({ book, kind, text: body, location, date: metadata.match(/\bAdded on\s+(.+)$/i)?.[1].trim() ?? null, index: index + 1 });
  });

  const highlights = new Map<string, NormalizedHighlight>();
  for (const entry of entries.filter((item) => item.kind === 'highlight')) {
    const sourceId = `clippings:${stableId(JSON.stringify([entry.book.sourceId, entry.location, entry.text]))}`;
    const existing = highlights.get(sourceId);
    if (existing) { existing.highlightedAt = entry.date ?? existing.highlightedAt; continue; }
    const highlight: NormalizedHighlight = { sourceId, text: entry.text, location: entry.location, highlightedAt: entry.date, note: null };
    highlights.set(sourceId, highlight);
    entry.book.highlights.push(highlight);
  }

  for (const entry of entries.filter((item) => item.kind === 'note')) {
    // A note may be exported separately, even before its highlight. Only attach unambiguous locations.
    const matches = entry.book.highlights.filter((highlight) => {
      if (!entry.location || !highlight.location) return false;
      if (entry.location === highlight.location) return true;
      if (/^\d+(?:-\d+)?$/.test(entry.location) && /^\d+(?:-\d+)?$/.test(highlight.location)) {
        const [start, end = start] = highlight.location.split('-').map(Number);
        const [noteStart, noteEnd = noteStart] = entry.location.split('-').map(Number);
        return noteStart >= start && noteEnd <= end;
      }
      return false;
    });
    if (matches.length === 1) matches[0].note = entry.text;
    else warnings.push(`Entry ${entry.index}: note could not be attached to one highlight at its location; skipped.`);
  }
  return { books: [...books.values()].filter((book) => book.highlights.length > 0), warnings };
}
