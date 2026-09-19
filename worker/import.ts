import { parseClippings } from '../shared/clippings';
import type { Book, ClippingsPreview, ImportBatch, ImportResult, NormalizedBook } from '../shared/contracts';

export class ImportError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type ImportEnv = Pick<Env, 'DB'>;
interface BookRow { id: string; user_id: string; title: string; author: string; source: Book['source']; excluded: number; highlight_count?: number }
interface BookSourceRow { source: string; source_id: string; book_id: string }
interface HighlightRow { id: string; book_id: string; text: string; note: string | null; location: string | null; highlighted_at: string | null; fingerprint: string }
interface HighlightSourceRow { source_book_id: string; source_id: string; highlight_id: string }
interface PlannedHighlight { id: string; bookId: string; text: string; note: string | null; location: string | null; highlightedAt: string | null; fingerprint: string }
interface PlannedSource { bookSourceId: string; sourceId: string; highlightId: string }

const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const bookKey = (title: string, author: string) => JSON.stringify([normalized(title).toLowerCase(), normalized(author).toLowerCase()]);
const sourceKey = (...parts: string[]) => JSON.stringify(parts);
async function hash(parts: unknown): Promise<string> {
  const serialized = JSON.stringify(parts, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function asBook(row: BookRow): Book {
  return { id: row.id, title: row.title, author: row.author, source: row.source, excluded: Boolean(row.excluded), highlightCount: row.highlight_count ?? 0 };
}

async function library(env: ImportEnv, userId: string): Promise<BookRow[]> {
  return (await env.DB.prepare('SELECT b.*, (SELECT count(*) FROM highlights h WHERE h.book_id=b.id AND h.user_id=b.user_id) AS highlight_count FROM books b WHERE b.user_id=?').bind(userId).all<BookRow>()).results;
}

export async function previewClippings(env: ImportEnv, userId: string, text: string): Promise<ClippingsPreview> {
  const parsed = parseClippings(text);
  const [books, mappings] = await Promise.all([library(env, userId), env.DB.prepare("SELECT source_id,book_id FROM book_sources WHERE user_id=? AND source='clippings'").bind(userId).all<{ source_id: string; book_id: string }>()]);
  const bySource = new Map(mappings.results.map((row) => [row.source_id, row.book_id]));
  return { ...parsed, matches: parsed.books.map((incoming) => ({ sourceId: incoming.sourceId, candidates: books.filter((book) => bySource.has(incoming.sourceId) ? book.id === bySource.get(incoming.sourceId) : bookKey(book.title, book.author) === bookKey(incoming.title, incoming.author)).map(asBook) })) };
}

async function savedResult(env: ImportEnv, userId: string, batchId: string, payloadHash: string): Promise<ImportResult | null> {
  const row = await env.DB.prepare('SELECT result_json,payload_hash FROM import_batches WHERE user_id=? AND batch_id=?').bind(userId, batchId).first<{ result_json: string; payload_hash: string | null }>();
  if (!row) return null;
  if (row.payload_hash !== payloadHash) throw new ImportError('This import batch ID was already used for different content. Start a new import.', 409);
  return JSON.parse(row.result_json) as ImportResult;
}

/** Every mutation and the saved result commit in one transaction; a lost response safely replays it. */
export async function importBatch(env: ImportEnv, userId: string, batch: ImportBatch): Promise<ImportResult> {
  // Enforce before replay too: legacy or differently tagged batches must not bypass the lock.
  if (batch.source === 'kindle') {
    const account = await env.DB.prepare('SELECT fingerprint FROM kindle_accounts WHERE user_id=?').bind(userId).first<{ fingerprint: string | null }>();
    if (!account?.fingerprint || !batch.accountFingerprint || account.fingerprint !== batch.accountFingerprint) {
      throw new ImportError('Kindle account verification required. Update the extension and confirm the connected Amazon account before syncing.', 409);
    }
  }
  const payloadHash = await hash(batch);
  const replay = await savedResult(env, userId, batch.batchId, payloadHash);
  if (replay) return replay;
  const [currentBooks, sourceRows] = await Promise.all([library(env, userId), env.DB.prepare('SELECT source,source_id,book_id FROM book_sources WHERE user_id=?').bind(userId).all<BookSourceRow>()]);
  const booksById = new Map(currentBooks.map((book) => [book.id, book]));
  const sourceBooks = new Map(sourceRows.results.map((row) => [sourceKey(row.source, row.source_id), row.book_id]));
  const targets = new Map<string, { id: string; incoming: NormalizedBook }>();
  for (const book of batch.books) {
    if (targets.has(book.sourceId)) throw new ImportError('Each book source ID must appear only once in a batch.');
    const mapped = sourceBooks.get(sourceKey(batch.source, book.sourceId));
    const sourceOwnedBookId = `book_${await hash([userId, batch.source, book.sourceId])}`;
    if (book.targetBookId && book.targetBookId !== 'new' && !booksById.has(book.targetBookId)) throw new ImportError('The selected book is not in your library.', 404);
    // A file upload can span batches. Repeating its explicit "new" choice continues the book
    // that this source created, but can never detach a source matched to another canonical book.
    const continuesNewBook = batch.source === 'clippings' && book.targetBookId === 'new' && mapped === sourceOwnedBookId;
    if (mapped && book.targetBookId && book.targetBookId !== mapped && !continuesNewBook) throw new ImportError('This source is already connected to another saved book. Keep its existing match.', 409);
    let target = mapped || (book.targetBookId !== 'new' ? book.targetBookId : undefined);
    if (!target && batch.source === 'clippings' && book.targetBookId !== 'new') {
      const candidates = currentBooks.filter((candidate) => bookKey(candidate.title, candidate.author) === bookKey(book.title, book.author));
      if (candidates.length > 1) throw new ImportError('More than one saved book matches this clipping. Choose a book or explicitly create a new one.', 409);
      target = candidates[0]?.id;
    }
    target ??= sourceOwnedBookId;
    targets.set(book.sourceId, { id: target, incoming: book });
  }

  const targetIds = [...new Set([...targets.values()].map((target) => target.id))];
  const [existingHighlights, existingSources] = targetIds.length ? await Promise.all([
    env.DB.prepare('SELECT id,book_id,text,note,location,highlighted_at,fingerprint FROM highlights WHERE user_id=? AND book_id IN (SELECT value FROM json_each(?))').bind(userId, JSON.stringify(targetIds)).all<HighlightRow>(),
    env.DB.prepare('SELECT source_book_id,source_id,highlight_id FROM highlight_sources WHERE user_id=? AND source=? AND source_book_id IN (SELECT value FROM json_each(?))').bind(userId, batch.source, JSON.stringify([...targets.keys()])).all<HighlightSourceRow>(),
  ]) : [{ results: [] as HighlightRow[] }, { results: [] as HighlightSourceRow[] }];
  const highlightById = new Map(existingHighlights.results.map((row) => [row.id, row]));
  const highlightsBySource = new Map(existingSources.results.map((row) => [sourceKey(row.source_book_id, row.source_id), row.highlight_id]));
  const fingerprints = new Map<string, string[]>();
  existingHighlights.results.forEach((row) => { const key = sourceKey(row.book_id, row.fingerprint); fingerprints.set(key, [...(fingerprints.get(key) ?? []), row.id]); });
  const planned = new Map<string, PlannedHighlight>();
  const sourceLinks = new Map<string, PlannedSource>();
  let inputHighlights = 0;
  for (const [sourceBookId, { id: bookId, incoming }] of targets) {
    for (const highlight of incoming.highlights) {
      inputHighlights++;
      const key = sourceKey(sourceBookId, highlight.sourceId);
      if (sourceLinks.has(key)) throw new ImportError('Each highlight source ID must appear only once per book in a batch.');
      const location = highlight.location?.trim() || null;
      const fingerprint = await hash([normalized(highlight.text), location ? normalized(location) : null]);
      const existingId = highlightsBySource.get(key);
      if (existingId && highlightById.get(existingId)?.book_id !== bookId) throw new ImportError('This annotation is already connected to another book.', 409);
      const candidates = fingerprints.get(sourceKey(bookId, fingerprint)) ?? [];
      const id = existingId || (candidates.length === 1 ? candidates[0] : `highlight_${await hash([userId, bookId, candidates.length > 1 ? key : fingerprint])}`);
      planned.set(id, { id, bookId, text: highlight.text, note: highlight.note ?? null, location, highlightedAt: highlight.highlightedAt ?? null, fingerprint });
      sourceLinks.set(key, { bookSourceId: sourceBookId, sourceId: highlight.sourceId, highlightId: id });
    }
  }

  const now = new Date().toISOString();
  const initial: ImportResult = { imported: 0, updated: 0, skipped: inputHighlights - planned.size, books: targetIds.length, warnings: [...new Set(batch.warnings ?? [])] };
  const statements: D1PreparedStatement[] = [env.DB.prepare('INSERT INTO import_batches(user_id,batch_id,run_id,source,result_json,created_at,payload_hash) VALUES (?,?,?,?,?,?,?)').bind(userId, batch.batchId, batch.runId, batch.source, JSON.stringify(initial), now, payloadHash)];
  for (const { id, incoming } of targets.values()) {
    // Imported metadata can refresh the title, while exclusion and rediscovery history remain untouched.
    statements.push(env.DB.prepare('INSERT INTO books(id,user_id,title,author,source,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author WHERE books.user_id=excluded.user_id').bind(id, userId, incoming.title, incoming.author, batch.source, now));
    // A conflicting source mapping aborts the entire transaction instead of leaving an orphaned copy.
    statements.push(env.DB.prepare('INSERT INTO book_sources(user_id,source,source_id,book_id) VALUES (?,?,?,?) ON CONFLICT(user_id,source,source_id) DO UPDATE SET book_id=CASE WHEN book_sources.book_id=excluded.book_id THEN book_sources.book_id ELSE NULL END').bind(userId, batch.source, incoming.sourceId, id));
  }
  const highlights = [...planned.values()];
  for (let offset = 0; offset < highlights.length; offset += 50) {
    const json = JSON.stringify(highlights.slice(offset, offset + 50));
    statements.push(env.DB.prepare(`UPDATE import_batches SET result_json=json_set(result_json,
      '$.imported', json_extract(result_json,'$.imported')+(SELECT count(*) FROM json_each(?) j LEFT JOIN highlights h ON h.id=json_extract(j.value,'$.id') AND h.user_id=? WHERE h.id IS NULL),
      '$.updated', json_extract(result_json,'$.updated')+(SELECT count(*) FROM json_each(?) j JOIN highlights h ON h.id=json_extract(j.value,'$.id') AND h.user_id=? WHERE h.text IS NOT json_extract(j.value,'$.text') OR h.note IS NOT json_extract(j.value,'$.note') OR h.location IS NOT json_extract(j.value,'$.location') OR h.highlighted_at IS NOT coalesce(json_extract(j.value,'$.highlightedAt'),h.highlighted_at)),
      '$.skipped', json_extract(result_json,'$.skipped')+(SELECT count(*) FROM json_each(?) j JOIN highlights h ON h.id=json_extract(j.value,'$.id') AND h.user_id=? WHERE h.text IS json_extract(j.value,'$.text') AND h.note IS json_extract(j.value,'$.note') AND h.location IS json_extract(j.value,'$.location') AND h.highlighted_at IS coalesce(json_extract(j.value,'$.highlightedAt'),h.highlighted_at))) WHERE user_id=? AND batch_id=?`).bind(json, userId, json, userId, json, userId, userId, batch.batchId));
    statements.push(env.DB.prepare(`INSERT INTO highlights(id,user_id,book_id,text,note,location,highlighted_at,imported_at,fingerprint)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.bookId'),json_extract(value,'$.text'),json_extract(value,'$.note'),json_extract(value,'$.location'),json_extract(value,'$.highlightedAt'),?,json_extract(value,'$.fingerprint') FROM json_each(?) WHERE true
      ON CONFLICT(id) DO UPDATE SET text=excluded.text,note=excluded.note,location=excluded.location,highlighted_at=coalesce(excluded.highlighted_at,highlights.highlighted_at),fingerprint=excluded.fingerprint WHERE highlights.user_id=excluded.user_id AND highlights.book_id=excluded.book_id`).bind(userId, now, json));
  }
  const sources = [...sourceLinks.values()];
  for (let offset = 0; offset < sources.length; offset += 50) {
    statements.push(env.DB.prepare(`INSERT INTO highlight_sources(user_id,source,source_book_id,source_id,highlight_id)
      SELECT ?,?,json_extract(value,'$.bookSourceId'),json_extract(value,'$.sourceId'),json_extract(value,'$.highlightId') FROM json_each(?) WHERE true
      ON CONFLICT(user_id,source,source_book_id,source_id) DO UPDATE SET highlight_id=CASE WHEN highlight_sources.highlight_id=excluded.highlight_id THEN highlight_sources.highlight_id ELSE NULL END`).bind(userId, batch.source, JSON.stringify(sources.slice(offset, offset + 50))));
  }
  try { await env.DB.batch(statements); }
  catch (error) {
    const winner = await savedResult(env, userId, batch.batchId, payloadHash);
    if (winner) return winner;
    if (String(error).includes('NOT NULL constraint failed')) throw new ImportError('Your library changed during import. Retry this batch to use the current source mappings.', 409);
    throw error;
  }
  const result = await savedResult(env, userId, batch.batchId, payloadHash);
  if (!result) throw new ImportError('Import completion could not be confirmed. Retry the same batch.', 503);
  return result;
}
