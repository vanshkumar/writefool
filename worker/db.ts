import type { Book, Preferences, Highlight } from '../shared/contracts';

export interface UserRow { id: string; email: string; name: string }
export interface PreferenceRow { user_id: string; interval_days: number; highlight_count: number; local_time: string; timezone: string; enabled: number; next_send_at: string | null; suppressed_at: string | null }

export async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export function randomToken(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export function validTimezone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length > 100) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return true; } catch { return false; }
}
export function preferencesFromRow(row: PreferenceRow): Preferences {
  return { intervalDays: row.interval_days, highlightCount: row.highlight_count, localTime: row.local_time, timezone: row.timezone, enabled: !!row.enabled, nextSendAt: row.next_send_at };
}
export async function ensurePreferences(db: D1Database, userId: string, timezone?: string): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO preferences(user_id,timezone,updated_at) VALUES(?,?,?)').bind(userId, validTimezone(timezone) ? timezone : 'America/Los_Angeles', now),
    db.prepare('INSERT OR IGNORE INTO sync_status(user_id,updated_at) VALUES(?,?)').bind(userId, now),
  ]);
}
export async function getPreferences(db: D1Database, userId: string): Promise<PreferenceRow> {
  const row = await db.prepare('SELECT * FROM preferences WHERE user_id=?').bind(userId).first<PreferenceRow>();
  if (!row) throw new Error('Preferences have not been initialized');
  return row;
}
export async function getBooks(db: D1Database, userId: string): Promise<Book[]> {
  const rows = await db.prepare('SELECT b.id,b.title,b.author,b.source,b.excluded,count(h.id) AS highlightCount FROM books b LEFT JOIN highlights h ON h.book_id=b.id AND h.user_id=b.user_id WHERE b.user_id=? GROUP BY b.id ORDER BY b.title COLLATE NOCASE').bind(userId).all<Book>();
  return rows.results.map(b => ({ ...b, excluded: !!b.excluded }));
}
export async function getHighlights(db: D1Database, userId: string, filters: { bookId?: string; q?: string; includeHidden?: boolean } = {}): Promise<Highlight[]> {
  const clauses = ['h.user_id=?', 'b.user_id=?'];
  const values: (string | number)[] = [userId, userId];
  if (filters.bookId) { clauses.push('h.book_id=?'); values.push(filters.bookId); }
  if (!filters.includeHidden) clauses.push('h.hidden=0');
  if (filters.q) { clauses.push("(h.text LIKE ? ESCAPE '\\' OR h.note LIKE ? ESCAPE '\\' OR b.title LIKE ? ESCAPE '\\' OR b.author LIKE ? ESCAPE '\\')"); const term = `%${filters.q.replace(/[\\%_]/g, c => `\\${c}`)}%`; values.push(term,term,term,term); }
  const rows = await db.prepare(`SELECT h.id,h.book_id AS bookId,b.title,b.author,h.text,h.note,h.location,h.hidden,h.last_sent_at AS lastSentAt,h.imported_at AS importedAt FROM highlights h JOIN books b ON b.id=h.book_id WHERE ${clauses.join(' AND ')} ORDER BY b.title COLLATE NOCASE,h.imported_at,h.id LIMIT 5000`).bind(...values).all<Highlight>();
  return rows.results.map(h => ({ ...h, hidden: !!h.hidden }));
}
/** Atomic fixed-window limiter. Identifiers are hashed before persistence. */
export async function rateLimit(db: D1Database, key: string, maximum: number, seconds: number): Promise<boolean> {
  const now = Date.now();
  const result = await db.prepare(`INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count`).bind(await hash(key), now + seconds * 1000, now, now).first<{ count: number }>();
  return !!result && result.count <= maximum;
}
export async function cancelUnattempted(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE digests SET status='cancelled',error='Preferences or library selection changed' WHERE user_id=? AND status='pending' AND first_attempt_at IS NULL").bind(userId).run();
}
