import type { DigestPreview, DigestState, Highlight, Preferences } from '../shared/contracts';
import { advanceOccurrence } from '../shared/schedule';
import { selectHighlights } from '../shared/selection';
import { deliverEmail, EmailSendError, freezeEmail, renderDigest, verifiedEvent, verifyUnsubscribeToken } from './email';
import type { FrozenEmail, ResendEvent } from './email';

interface PreferenceRow {
  user_id: string; interval_days: number; highlight_count: number; local_time: string; timezone: string;
  enabled: number; next_send_at: string | null; suppressed_at: string | null; email: string; updated_at: string;
}
interface DigestRow {
  id: string; user_id: string; scheduled_for: string; status: DigestState; is_test: number; payload_json: string;
  first_attempt_at: string | null; attempts: number; lease_until: string | null;
}
const MAX_RETRY_AGE = 22 * 60 * 60 * 1000;
const preferenceQuery = 'SELECT p.*, u.email FROM preferences p JOIN user u ON u.id = p.user_id';

function preferences(row: PreferenceRow): Preferences {
  return { intervalDays: row.interval_days, highlightCount: row.highlight_count, localTime: row.local_time, timezone: row.timezone, enabled: !!row.enabled, nextSendAt: row.next_send_at };
}

async function loadPreferences(env: Env, userId: string): Promise<PreferenceRow> {
  const row = await env.DB.prepare(`${preferenceQuery} WHERE p.user_id = ?`).bind(userId).first<PreferenceRow>();
  if (!row) throw new Error('Email preferences were not found');
  return row;
}

async function highlightsFor(env: Env, userId: string): Promise<Highlight[]> {
  const result = await env.DB.prepare(`SELECT h.id, h.book_id AS bookId, b.title, b.author, h.text, h.note, h.location,
    h.hidden, h.last_sent_at AS lastSentAt, h.imported_at AS importedAt FROM highlights h JOIN books b ON b.id = h.book_id
    WHERE h.user_id = ? AND b.user_id = ? AND b.excluded = 0 AND h.hidden = 0 AND length(trim(h.text)) > 0`).bind(userId, userId).all<Highlight>();
  return result.results.map(h => ({ ...h, hidden: !!h.hidden }));
}

export async function buildPreview(env: Env, userId: string): Promise<DigestPreview> {
  const prefs = await loadPreferences(env, userId);
  return renderDigest(selectHighlights(await highlightsFor(env, userId), prefs.highlight_count), env.APP_URL);
}

async function createOccurrence(env: Env, prefs: PreferenceRow, now: Date): Promise<void> {
  if (!prefs.next_send_at) return;
  const scheduledFor = prefs.next_send_at;
  const id = crypto.randomUUID();
  const highlights = selectHighlights(await highlightsFor(env, prefs.user_id), prefs.highlight_count, now);
  const frozen = await freezeEmail(env, prefs.user_id, prefs.email, id, highlights);
  const next = advanceOccurrence(preferences(prefs), new Date(scheduledFor), now).toISOString();
  const status: DigestState = highlights.length ? 'pending' : 'skipped';
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO digests (id,user_id,scheduled_for,status,highlight_count,is_test,payload_json,created_at,next_attempt_at)
      SELECT ?,?,?,?,?,0,?,?,? FROM preferences WHERE user_id = ? AND next_send_at = ? AND updated_at = ? AND enabled = 1 AND suppressed_at IS NULL`)
      .bind(id, prefs.user_id, scheduledFor, status, highlights.length, JSON.stringify(frozen), now.toISOString(), now.toISOString(), prefs.user_id, scheduledFor, prefs.updated_at),
    ...highlights.map(h => env.DB.prepare('INSERT OR IGNORE INTO digest_highlights (digest_id,highlight_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM digests WHERE id = ?)').bind(id, h.id, id)),
    env.DB.prepare(`UPDATE preferences SET next_send_at = ?, updated_at = ? WHERE user_id = ? AND next_send_at = ? AND updated_at = ? AND EXISTS (SELECT 1 FROM digests WHERE id = ?)`)
      .bind(next, now.toISOString(), prefs.user_id, scheduledFor, prefs.updated_at, id),
  ]);
}

function historyStatement(env: Env, digestId: string) {
  return env.DB.prepare(`UPDATE highlights SET last_sent_at = max(COALESCE(last_sent_at, ''), (SELECT COALESCE(first_attempt_at,created_at) FROM digests WHERE id = ?))
    WHERE id IN (SELECT highlight_id FROM digest_highlights WHERE digest_id = ?) AND EXISTS
      (SELECT 1 FROM digests WHERE id = ? AND is_test = 0 AND status IN ('accepted','delivered','bounced','complained'))`)
    .bind(digestId, digestId, digestId);
}

async function applyEvent(env: Env, event: ResendEvent, receivedAt: string): Promise<void> {
  const tags = event.data.tags;
  const taggedId = Array.isArray(tags) ? tags.find(t => t.name === 'digest_id')?.value : tags?.digest_id;
  const digest = await env.DB.prepare('SELECT id,user_id,is_test,status FROM digests WHERE provider_id = ? OR id = ? LIMIT 1').bind(event.data.email_id, taggedId || '').first<{ id: string; user_id: string; is_test: number; status: DigestState }>();
  if (!digest) return;
  const target: Partial<Record<string, DigestState>> = { 'email.sent': 'accepted', 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed', 'email.suppressed': 'bounced' };
  const status = target[event.type];
  if (!status) return;
  const excluded = status === 'complained' ? ['cancelled'] : status === 'bounced' ? ['complained', 'cancelled'] : status === 'delivered' ? ['bounced', 'complained', 'cancelled'] : ['delivered', 'bounced', 'complained', 'cancelled', 'failed'];
  const statements: D1PreparedStatement[] = [];
  if (status === 'bounced' || status === 'complained') {
    // Check the transition inside the transaction so replaying an old event cannot undo a resolved suppression.
    statements.push(env.DB.prepare(`UPDATE preferences SET enabled = 0, suppressed_at = COALESCE(suppressed_at, ?), updated_at = ? WHERE user_id = ? AND EXISTS
      (SELECT 1 FROM digests WHERE id = ? AND status <> ? AND status NOT IN (${excluded.map(() => '?').join(',')}))`)
      .bind(receivedAt, receivedAt, digest.user_id, digest.id, status, ...excluded));
    statements.push(env.DB.prepare("UPDATE digests SET status = 'cancelled', error = 'Email address is suppressed' WHERE user_id = ? AND status = 'pending' AND id <> ? AND EXISTS (SELECT 1 FROM preferences WHERE user_id = ? AND suppressed_at IS NOT NULL)").bind(digest.user_id, digest.id, digest.user_id));
  }
  statements.push(env.DB.prepare(`UPDATE digests SET status = ?, provider_id = COALESCE(provider_id, ?), lease_until = NULL, next_attempt_at = NULL WHERE id = ? AND status NOT IN (${excluded.map(() => '?').join(',')})`).bind(status, event.data.email_id, digest.id, ...excluded));
  statements.push(historyStatement(env, digest.id));
  await env.DB.batch(statements);
}

async function reconcileEvents(env: Env, providerId: string): Promise<void> {
  const events = await env.DB.prepare("SELECT payload_json,received_at FROM email_events WHERE json_extract(payload_json, '$.data.email_id') = ? ORDER BY received_at").bind(providerId).all<{ payload_json: string; received_at: string }>();
  for (const row of events.results) await applyEvent(env, JSON.parse(row.payload_json) as ResendEvent, row.received_at);
}

/** Recover the inbox-to-outbox handoff if a Worker stopped during reconciliation. */
async function reconcilePendingEvents(env: Env): Promise<void> {
  const events = await env.DB.prepare(`SELECT e.payload_json,e.received_at FROM email_events e JOIN digests d
    ON d.provider_id = json_extract(e.payload_json, '$.data.email_id') WHERE
    (json_extract(e.payload_json, '$.type') = 'email.sent' AND d.status IN ('pending','sending','uncertain')) OR
    (json_extract(e.payload_json, '$.type') = 'email.delivered' AND d.status NOT IN ('delivered','bounced','complained','cancelled')) OR
    (json_extract(e.payload_json, '$.type') IN ('email.bounced','email.suppressed') AND d.status NOT IN ('bounced','complained','cancelled')) OR
    (json_extract(e.payload_json, '$.type') = 'email.complained' AND d.status NOT IN ('complained','cancelled')) OR
    (json_extract(e.payload_json, '$.type') = 'email.failed' AND d.status IN ('pending','sending','accepted','uncertain'))
    ORDER BY e.received_at LIMIT 100`).all<{ payload_json: string; received_at: string }>();
  for (const row of events.results) await applyEvent(env, JSON.parse(row.payload_json) as ResendEvent, row.received_at);
}

async function dispatch(env: Env, id: string, now: Date): Promise<void> {
  const timestamp = now.toISOString();
  const row = await env.DB.prepare('SELECT * FROM digests WHERE id = ?').bind(id).first<DigestRow>();
  if (!row || !['pending', 'sending'].includes(row.status)) return;
  if (row.first_attempt_at && now.getTime() - Date.parse(row.first_attempt_at) >= MAX_RETRY_AGE) {
    await env.DB.prepare("UPDATE digests SET status = 'uncertain', error = 'Automatic retries stopped before the provider deduplication window expired', next_attempt_at = NULL, lease_until = NULL WHERE id = ? AND status IN ('pending','sending')").bind(id).run();
    return;
  }
  const lease = new Date(now.getTime() + 60_000).toISOString();
  const claimed = await env.DB.prepare(`UPDATE digests SET status = 'sending', lease_until = ?, first_attempt_at = COALESCE(first_attempt_at, ?), attempts = attempts + 1
    WHERE id = ? AND ((status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR (status = 'sending' AND lease_until <= ?))`)
    .bind(lease, timestamp, id, timestamp, timestamp).run();
  if (!claimed.meta.changes) return;
  const prefs = await loadPreferences(env, row.user_id);
  if (prefs.suppressed_at || (!row.is_test && !prefs.enabled)) {
    await env.DB.prepare("UPDATE digests SET status = 'cancelled', lease_until = NULL, error = 'Email delivery is paused' WHERE id = ? AND status = 'sending'").bind(id).run();
    return;
  }
  try {
    const providerId = await deliverEmail(env, JSON.parse(row.payload_json) as FrozenEmail, `digest/${id}`);
    await env.DB.batch([
      env.DB.prepare("UPDATE digests SET status = 'accepted', provider_id = ?, lease_until = NULL, next_attempt_at = NULL, error = NULL WHERE id = ? AND status = 'sending'").bind(providerId, id),
      historyStatement(env, id),
    ]);
    await reconcileEvents(env, providerId);
  } catch (error) {
    const failure = error instanceof EmailSendError ? error : new EmailSendError('Delivery result could not be recorded', true, true);
    const delay = [5, 15, 60, 240][Math.min(row.attempts, 3)] * 60_000;
    const firstAttempt = row.first_attempt_at ? Date.parse(row.first_attempt_at) : now.getTime();
    const retry = failure.retryable && now.getTime() + delay < firstAttempt + MAX_RETRY_AGE;
    await env.DB.prepare("UPDATE digests SET status = ?, error = ?, next_attempt_at = ?, lease_until = NULL WHERE id = ? AND status = 'sending'")
      .bind(retry ? 'pending' : failure.ambiguous ? 'uncertain' : 'failed', failure.message, retry ? new Date(now.getTime() + delay).toISOString() : null, id).run();
  }
}

export async function processScheduled(env: Env, now = new Date()): Promise<void> {
  await reconcilePendingEvents(env);
  const due = await env.DB.prepare(`${preferenceQuery} WHERE p.enabled = 1 AND p.suppressed_at IS NULL AND p.next_send_at <= ?`).bind(now.toISOString()).all<PreferenceRow>();
  for (const prefs of due.results) await createOccurrence(env, prefs, now);
  const pending = await env.DB.prepare("SELECT id FROM digests WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND lease_until <= ?) ORDER BY scheduled_for LIMIT 20").bind(now.toISOString(), now.toISOString()).all<{ id: string }>();
  for (const row of pending.results) await dispatch(env, row.id, now);
}

export async function sendTest(env: Env, userId: string): Promise<{ id: string; status: DigestState }> {
  const prefs = await loadPreferences(env, userId);
  if (prefs.suppressed_at) throw new Error('Email delivery is suppressed for this address');
  const selected = selectHighlights(await highlightsFor(env, userId), prefs.highlight_count);
  if (!selected.length) throw new Error('Import at least one visible highlight before sending a test');
  const id = crypto.randomUUID();
  const now = new Date();
  const payload = await freezeEmail(env, userId, prefs.email, id, selected);
  payload.subject = `[Test] ${payload.subject}`;
  await env.DB.prepare("INSERT INTO digests (id,user_id,scheduled_for,status,highlight_count,is_test,payload_json,created_at,next_attempt_at) VALUES (?,?,?,'pending',?,1,?,?,?)")
    .bind(id, userId, `${now.toISOString()}/test/${id}`, selected.length, JSON.stringify(payload), now.toISOString(), now.toISOString()).run();
  await dispatch(env, id, now);
  const result = await env.DB.prepare('SELECT status FROM digests WHERE id = ?').bind(id).first<{ status: DigestState }>();
  return { id, status: result?.status || 'uncertain' };
}

export async function handleWebhook(env: Env, request: Request): Promise<Response> {
  const verified = await verifiedEvent(env, request);
  if (!verified) return Response.json({ error: 'Invalid webhook signature or payload' }, { status: 400 });
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT OR IGNORE INTO email_events (id,received_at,payload_json) VALUES (?,?,?)').bind(verified.id, now, verified.raw).run();
  // Applying duplicate events is safe and repairs an interrupted earlier handler.
  await applyEvent(env, verified.event, now);
  return Response.json({ ok: true });
}

export async function pauseByToken(env: Env, token: string): Promise<boolean> {
  const userId = await verifyUnsubscribeToken(env, token);
  if (!userId) return false;
  const result = await env.DB.batch([
    env.DB.prepare('UPDATE preferences SET enabled = 0, next_send_at = NULL, updated_at = ? WHERE user_id = ?').bind(new Date().toISOString(), userId),
    env.DB.prepare("UPDATE digests SET status = 'cancelled', error = 'Email delivery is paused' WHERE user_id = ? AND status = 'pending'").bind(userId),
  ]);
  return !!result[0].meta.changes;
}
