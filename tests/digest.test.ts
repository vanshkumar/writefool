import { readFile } from 'node:fs/promises';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { Webhook } from 'svix';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPreview, handleWebhook, pauseByToken, processScheduled, sendTest } from '../worker/digest';
import { signUnsubscribeToken } from '../worker/email';

let mf: Miniflare;
let env: Env;
const now = new Date('2026-09-08T15:00:00Z');
const webhookSecret = `whsec_${btoa('a sufficiently long webhook secret')}`;

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'digest-test', modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-09-07', d1Databases: { DB: 'digest-tests' } }));
  const DB = await mf.getD1Database('DB');
  env = { DB, APP_URL: 'https://writefool.example', EMAIL_FROM: 'read@writefool.example', AUTH_SECRET: 'strong test auth secret', RESEND_API_KEY: 'test', RESEND_WEBHOOK_SECRET: webhookSecret, ENVIRONMENT: 'test' } as Env;
  const migration = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  for (const statement of migration.split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM user').run();
  await env.DB.prepare('DELETE FROM email_events').run();
  await env.DB.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('u','Reader','reader@example.com',1,0,0)").run();
  await env.DB.prepare("INSERT INTO preferences (user_id,interval_days,highlight_count,enabled,next_send_at,updated_at) VALUES ('u',2,2,1,?,?)").bind(now.toISOString(), now.toISOString()).run();
  await env.DB.prepare("INSERT INTO books (id,user_id,title,author,source,created_at) VALUES ('b','u','A Book','Author','kindle',?)").bind(now.toISOString()).run();
  for (const id of ['h1', 'h2']) await env.DB.prepare("INSERT INTO highlights (id,user_id,book_id,text,imported_at,fingerprint) VALUES (?,'u','b',?,?,?)").bind(id, `Quote ${id}`, now.toISOString(), id).run();
});
afterEach(() => vi.unstubAllGlobals());

async function eventRequest(id: string, emailId: string, type: string): Promise<Request> {
  const payload = JSON.stringify({ type, created_at: now.toISOString(), data: { email_id: emailId } });
  const timestamp = new Date();
  const signature = new Webhook(webhookSecret).sign(id, timestamp, payload);
  return new Request('https://writefool.example/api/webhooks/resend', { method: 'POST', headers: { 'svix-id': id, 'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)), 'svix-signature': signature }, body: payload });
}

function interleaveBeforeOutboxStage(change: () => Promise<void>): Env {
  let changed = false;
  return { ...env, DB: new Proxy(env.DB, {
    get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (!changed) { changed = true; await change(); }
        return target.batch(statements);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) };
}

describe('durable digest delivery against D1', () => {
  it('concurrent cron ticks create one occurrence and send once', async () => {
    const send = vi.fn().mockImplementation(async () => Response.json({ id: 'provider-1' }));
    vi.stubGlobal('fetch', send);
    await Promise.all([processScheduled(env, now), processScheduled(env, now)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM digests').first('count')).toBe(1);
    expect(await env.DB.prepare('SELECT next_send_at FROM preferences').first('next_send_at')).toBe('2026-09-10T15:00:00.000Z');
    expect(await env.DB.prepare('SELECT last_sent_at FROM highlights LIMIT 1').first('last_sent_at')).toBe(now.toISOString());
  });
  it('retries a frozen payload with the same key and stops an aged ambiguity', async () => {
    const send = vi.fn().mockRejectedValue(new Error('lost response'));
    vi.stubGlobal('fetch', send);
    await processScheduled(env, now);
    await env.DB.prepare("UPDATE highlights SET text = 'Updated later'").run();
    await processScheduled(env, new Date(now.getTime() + 6 * 60_000));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1].body).toBe(send.mock.calls[1][1].body);
    expect(send.mock.calls[0][1].headers['Idempotency-Key']).toBe(send.mock.calls[1][1].headers['Idempotency-Key']);
    await processScheduled(env, new Date(now.getTime() + 22 * 60 * 60_000));
    expect(send).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare('SELECT status FROM digests').first('status')).toBe('uncertain');
  });
  it('does not alter history for preview or test email', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 'provider-test' })));
    expect((await buildPreview(env, 'u')).highlights).toHaveLength(2);
    expect((await sendTest(env, 'u')).status).toBe('accepted');
    expect(await env.DB.prepare('SELECT last_sent_at FROM highlights LIMIT 1').first('last_sent_at')).toBeNull();
    expect(await env.DB.prepare('SELECT next_send_at FROM preferences').first('next_send_at')).toBe(now.toISOString());
  });
  it('keeps suppression terminal across duplicate and out-of-order webhooks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 'provider-1' })));
    await processScheduled(env, now);
    expect((await handleWebhook(env, await eventRequest('evt-bounce', 'provider-1', 'email.bounced'))).status).toBe(200);
    await handleWebhook(env, await eventRequest('evt-deliver', 'provider-1', 'email.delivered'));
    await handleWebhook(env, await eventRequest('evt-bounce', 'provider-1', 'email.bounced'));
    expect(await env.DB.prepare('SELECT status FROM digests').first('status')).toBe('bounced');
    expect(await env.DB.prepare('SELECT enabled FROM preferences').first('enabled')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) FROM email_events').first('count(*)')).toBe(2);
  });
  it('records early webhooks until the send response can link them', async () => {
    const early = await eventRequest('early-bounce', 'provider-early', 'email.bounced');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      await handleWebhook(env, early);
      return Response.json({ id: 'provider-early' });
    }));
    await processScheduled(env, now);
    expect(await env.DB.prepare('SELECT status FROM digests').first('status')).toBe('bounced');
    expect(await env.DB.prepare('SELECT enabled FROM preferences').first('enabled')).toBe(0);
  });
  it('pauses by signed token and cancels queued retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await processScheduled(env, now);
    expect(await pauseByToken(env, await signUnsubscribeToken(env, 'u'))).toBe(true);
    expect(await env.DB.prepare('SELECT status FROM digests').first('status')).toBe('cancelled');
    await processScheduled(env, new Date(now.getTime() + 6 * 60_000));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('skips an empty eligible library and advances cadence without sending', async () => {
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    await env.DB.prepare('UPDATE books SET excluded = 1').run();
    await processScheduled(env, now);
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status FROM digests').first('status')).toBe('skipped');
    expect(await env.DB.prepare('SELECT next_send_at FROM preferences').first('next_send_at')).toBe('2026-09-10T15:00:00.000Z');
  });
  it('reclaims an expired send lease but does not race an active lease', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(Response.json({ id: 'recovered' }));
    vi.stubGlobal('fetch', send);
    await processScheduled(env, now);
    await env.DB.prepare("UPDATE digests SET status = 'sending', lease_until = ?").bind(new Date(now.getTime() + 60_000).toISOString()).run();
    await processScheduled(env, new Date(now.getTime() + 30_000));
    expect(send).toHaveBeenCalledTimes(1);
    await processScheduled(env, new Date(now.getTime() + 90_000));
    expect(send).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare('SELECT status FROM digests').first('status')).toBe('accepted');
  });
  it('rejects an unverified webhook without recording it', async () => {
    const response = await handleWebhook(env, new Request('https://writefool.example/api/webhooks/resend', { method: 'POST', body: JSON.stringify({ type: 'email.complained', data: { email_id: 'forged' } }) }));
    expect(response.status).toBe(400);
    expect(await env.DB.prepare('SELECT count(*) FROM email_events').first('count(*)')).toBe(0);
    expect(await env.DB.prepare('SELECT enabled FROM preferences').first('enabled')).toBe(1);
  });
  it('recovers a recorded webhook after an interrupted reconciliation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 'provider-reconcile' })));
    await processScheduled(env, now);
    const payload = JSON.stringify({ type: 'email.complained', data: { email_id: 'provider-reconcile' } });
    await env.DB.prepare('INSERT INTO email_events (id,received_at,payload_json) VALUES (?,?,?)').bind('saved-before-crash', now.toISOString(), payload).run();
    await processScheduled(env, new Date(now.getTime() + 5 * 60_000));
    expect(await env.DB.prepare('SELECT status FROM digests').first('status')).toBe('complained');
    expect(await env.DB.prepare('SELECT enabled FROM preferences').first('enabled')).toBe(0);
  });
  it('abandons a stale settings snapshot without consuming its due occurrence', async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ id: 'updated-settings' }));
    vi.stubGlobal('fetch', send);
    const raced = interleaveBeforeOutboxStage(async () => {
      await env.DB.prepare('UPDATE preferences SET highlight_count = 1, updated_at = ?').bind(new Date(now.getTime() + 1).toISOString()).run();
    });
    await processScheduled(raced, now);
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT count(*) FROM digests').first('count(*)')).toBe(0);
    expect(await env.DB.prepare('SELECT next_send_at FROM preferences').first('next_send_at')).toBe(now.toISOString());
    await processScheduled(env, new Date(now.getTime() + 5 * 60_000));
    expect(send).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare('SELECT highlight_count FROM digests').first('highlight_count')).toBe(1);
  });
  it('does not send a book excluded after selection but before outbox creation', async () => {
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    const raced = interleaveBeforeOutboxStage(async () => {
      await env.DB.batch([
        env.DB.prepare('UPDATE books SET excluded = 1'),
        env.DB.prepare('UPDATE preferences SET updated_at = ?').bind(new Date(now.getTime() + 1).toISOString()),
      ]);
    });
    await processScheduled(raced, now);
    expect(await env.DB.prepare('SELECT count(*) FROM digests').first('count(*)')).toBe(0);
    await processScheduled(env, new Date(now.getTime() + 5 * 60_000));
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status FROM digests').first('status')).toBe('skipped');
  });
  it('does not reapply a resolved suppression when an old event is replayed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 'previous-bounce' })));
    await processScheduled(env, now);
    await handleWebhook(env, await eventRequest('original-bounce', 'previous-bounce', 'email.bounced'));
    // Simulate an operator resolving the provider suppression before explicitly resuming.
    await env.DB.prepare('UPDATE preferences SET enabled = 1, suppressed_at = NULL').run();
    await handleWebhook(env, await eventRequest('original-bounce', 'previous-bounce', 'email.bounced'));
    expect(await env.DB.prepare('SELECT enabled FROM preferences').first('enabled')).toBe(1);
    expect(await env.DB.prepare('SELECT suppressed_at FROM preferences').first('suppressed_at')).toBeNull();
  });
});
