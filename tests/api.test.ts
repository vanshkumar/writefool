import { readFile } from 'node:fs/promises';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../worker/index';
import { ensurePreferences, hash } from '../worker/db';
import { signUnsubscribeToken } from '../worker/email';
import type { Dashboard, Preferences } from '../shared/contracts';

let mf: Miniflare;
let env: Env;
let DB: D1Database;
const origin = 'http://localhost:5183';
const basePreferences = { intervalDays: 2, highlightCount: 5, localTime: '08:00', timezone: 'America/Los_Angeles', enabled: false };

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'api-test', modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-09-07', d1Databases: { DB: 'api-tests' } }));
  DB = await mf.getD1Database('DB');
  for (const filename of ['0001_initial.sql', '0002_import_payload.sql', '0003_kindle_account_lock.sql']) {
    const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await DB.prepare(statement).run();
  }
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  for (const table of ['user', 'verification', 'rate_limits', 'email_events']) await DB.prepare(`DELETE FROM ${table}`).run();
  env = { DB, APP_URL: origin, ENVIRONMENT: 'development', OWNER_EMAIL: '', EMAIL_FROM: '', AUTH_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', RESEND_API_KEY: '', RESEND_WEBHOOK_SECRET: '' } as Env;
});
afterEach(() => vi.unstubAllGlobals());

function request(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string | null; bearer?: string; bindings?: Env } = {}) {
  const bindings = options.bindings ?? env;
  const headers = new Headers();
  if (options.origin !== null) headers.set('Origin', options.origin ?? bindings.APP_URL);
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.bearer) headers.set('Authorization', `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  return app.request(new URL(path, bindings.APP_URL).href, { method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'), headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }, bindings);
}
async function login(timezone = 'Asia/Kolkata') {
  const response = await request('/api/dev/login', { body: { timezone } });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}
async function seedAccount(id: string) {
  const token = `${id}-session-token`;
  const now = new Date().toISOString();
  await DB.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').bind(id, `Reader ${id}`, `${id}@example.com`, Date.now(), Date.now()).run();
  await ensurePreferences(DB, id);
  await DB.prepare('INSERT INTO dev_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await hash(token), id, new Date(Date.now() + 86400000).toISOString()).run();
  await DB.prepare("INSERT INTO books(id,user_id,title,author,source,created_at) VALUES(?,?,?,'An Author','kindle',?)").bind(`${id}-book`, id, `Book ${id}`, now).run();
  await DB.prepare("INSERT INTO highlights(id,user_id,book_id,text,note,imported_at,fingerprint) VALUES(?,?,?,?,?,?,?)").bind(`${id}-highlight`, id, `${id}-book`, `Private passage ${id}`, `Private note ${id}`, now, `fingerprint-${id}`).run();
  return `wf_dev=${token}`;
}

async function pairedToken(cookie: string) {
  const response = await request('/api/pairing', { method: 'POST', cookie });
  expect(response.status).toBe(200);
  const { code } = await response.json() as { code: string };
  const paired = await request('/api/extension/pair', { body: { code }, origin: null });
  expect(paired.status).toBe(200);
  return (await paired.json() as { token: string }).token;
}

describe('private application authentication and account boundaries', () => {
  it('requires a session for private app data and does not accept arbitrary dev cookies', async () => {
    for (const path of ['/api/dashboard', '/api/books', '/api/highlights', '/api/preferences', '/api/digest/preview']) {
      expect((await request(path)).status).toBe(401);
      expect((await request(path, { cookie: 'wf_dev=invented' })).status).toBe(401);
    }
  });

  it('creates paused defaults in the browser timezone and invalidates development login at sign-out', async () => {
    const cookie = await login();
    const session = await request('/api/auth/get-session', { cookie });
    expect((await session.json() as { user: { email: string } }).user.email).toBe('reader@localhost');
    const dashboard = await (await request('/api/dashboard', { cookie })).json() as Dashboard;
    expect(dashboard.preferences).toMatchObject({ intervalDays: 2, highlightCount: 5, localTime: '08:00', timezone: 'Asia/Kolkata', enabled: false, nextSendAt: null });
    expect(dashboard.totals).toEqual({ books: 0, highlights: 0, eligible: 0 });
    expect((await request('/api/auth/sign-out', { method: 'POST', cookie })).status).toBe(200);
    expect((await request('/api/dashboard', { cookie })).status).toBe(401);
  });

  it('never exposes local development login on a production deployment', async () => {
    const bindings = { ...env, ENVIRONMENT: 'production' };
    expect(await (await request('/api/config', { bindings })).json()).toMatchObject({ development: false });
    expect((await request('/api/dev/login', { body: {}, bindings })).status).toBe(404);
    const cookie = await login();
    expect((await request('/api/dashboard', { cookie, bindings })).status).toBe(401);
  });

  it('keeps local development sessions readable when real email authentication is configured', async () => {
    const bindings = { ...env, OWNER_EMAIL: 'owner@example.com', EMAIL_FROM: 'letters@example.com', RESEND_API_KEY: 'unused-local-test-key' };
    const response = await request('/api/dev/login', { bindings, body: { timezone: 'Europe/London' } });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const session = await (await request('/api/auth/get-session', { bindings, cookie })).json() as { user: { id: string; email: string } };
    expect(session.user).toMatchObject({ id: 'local-development-user', email: 'reader@localhost' });
    const dashboard = await (await request('/api/dashboard', { bindings, cookie })).json() as Dashboard;
    expect(dashboard.user.id).toBe(session.user.id);
    expect(dashboard.preferences.timezone).toBe('Europe/London');
  });

  it('isolates books, highlights, filtering, updates, and connection revocation by account', async () => {
    const cookieA = await seedAccount('a');
    const cookieB = await seedAccount('b');
    const books = await (await request('/api/books', { cookie: cookieA })).json() as { books: { id: string }[] };
    expect(books.books.map(b => b.id)).toEqual(['a-book']);
    const otherBook = await (await request('/api/highlights?bookId=b-book&includeHidden=true', { cookie: cookieA })).json() as { highlights: unknown[] };
    expect(otherBook.highlights).toEqual([]);
    expect((await request('/api/books/b-book', { method: 'PATCH', cookie: cookieA, body: { excluded: true } })).status).toBe(404);
    expect((await request('/api/highlights/b-highlight', { method: 'PATCH', cookie: cookieA, body: { hidden: true } })).status).toBe(404);
    await pairedToken(cookieB);
    const tokenId = await DB.prepare("SELECT id FROM extension_tokens WHERE user_id='b'").first<string>('id');
    expect((await request(`/api/extension-tokens/${tokenId}`, { method: 'DELETE', cookie: cookieA })).status).toBe(404);
    const dashboardB = await (await request('/api/dashboard', { cookie: cookieB })).json() as Dashboard;
    expect(dashboardB.totals.eligible).toBe(1);
    expect(dashboardB.extensionTokens).toHaveLength(1);
  });

  it('rejects missing or cross-site Origin before mutating cookie-authenticated state', async () => {
    const cookie = await seedAccount('reader');
    for (const invalidOrigin of [null, 'https://attacker.example']) {
      expect((await request('/api/books/reader-book', { method: 'PATCH', cookie, body: { excluded: true }, origin: invalidOrigin })).status).toBe(403);
      expect((await request('/api/pairing', { method: 'POST', cookie, origin: invalidOrigin })).status).toBe(403);
    }
    expect(await DB.prepare("SELECT excluded FROM books WHERE id='reader-book'").first('excluded')).toBe(0);
    expect(await DB.prepare('SELECT count(*) AS count FROM pairing_codes').first('count')).toBe(0);
  });

  it('restores hidden highlights and keeps search wildcard characters literal', async () => {
    const cookie = await seedAccount('reader');
    expect((await request('/api/highlights/reader-highlight', { method: 'PATCH', cookie, body: { hidden: true } })).status).toBe(200);
    expect(await (await request('/api/highlights', { cookie })).json()).toEqual({ highlights: [] });
    expect((await (await request('/api/highlights?includeHidden=true', { cookie })).json() as { highlights: { hidden: boolean }[] }).highlights[0].hidden).toBe(true);
    expect(await (await request('/api/highlights?includeHidden=true&q=%25', { cookie })).json()).toEqual({ highlights: [] });
    expect((await request('/api/highlights/reader-highlight', { method: 'PATCH', cookie, body: { hidden: false } })).status).toBe(200);
    expect((await (await request('/api/highlights?q=private%20note', { cookie })).json() as { highlights: unknown[] }).highlights).toHaveLength(1);
  });
});

describe('single-use extension pairing and restricted import credentials', () => {
  it('allows only one concurrent exchange of a pairing code and never persists the bearer token', async () => {
    const cookie = await login();
    const { code } = await (await request('/api/pairing', { method: 'POST', cookie })).json() as { code: string };
    const exchanges = await Promise.all([request('/api/extension/pair', { body: { code }, origin: null }), request('/api/extension/pair', { body: { code: code.toLowerCase().replaceAll('-', ' ') }, origin: null })]);
    expect(exchanges.map(r => r.status).sort()).toEqual([200, 400]);
    const token = (await exchanges.find(r => r.status === 200)!.json() as { token: string }).token;
    expect(await DB.prepare('SELECT token_hash FROM extension_tokens').first('token_hash')).toBe(await hash(token));
    expect(await DB.prepare('SELECT count(*) AS count FROM pairing_codes').first('count')).toBe(0);
  });

  it('rejects expired codes and invalidates an older code when a replacement is issued', async () => {
    const cookie = await login();
    const first = await (await request('/api/pairing', { method: 'POST', cookie })).json() as { code: string };
    const second = await (await request('/api/pairing', { method: 'POST', cookie })).json() as { code: string };
    expect((await request('/api/extension/pair', { body: { code: first.code }, origin: null })).status).toBe(400);
    await DB.prepare('UPDATE pairing_codes SET expires_at=?').bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await request('/api/extension/pair', { body: { code: second.code }, origin: null })).status).toBe(400);
    expect(await DB.prepare('SELECT count(*) AS count FROM extension_tokens').first('count')).toBe(0);
  });

  it('accepts import status only until revoked and never treats an import token as an app session', async () => {
    const cookie = await login();
    const token = await pairedToken(cookie);
    expect((await request('/api/extension/status', { body: { status: 'login_required', message: 'Sign in to Kindle', progress: 0 }, bearer: token, origin: null })).status).toBe(200);
    expect((await request('/api/dashboard', { bearer: token })).status).toBe(401);
    expect((await request('/api/preferences', { method: 'PUT', body: basePreferences, bearer: token })).status).toBe(401);
    expect((await request('/api/extension/import', { bearer: token, body: { batchId: 'wrong-source', runId: 'wrong-source', source: 'clippings', books: [] }, origin: null })).status).toBe(400);
    const dashboard = await (await request('/api/dashboard', { cookie })).json() as Dashboard;
    expect(dashboard.sync).toMatchObject({ connected: true, status: 'login_required', message: 'Sign in to Kindle' });
    expect((await request(`/api/extension-tokens/${dashboard.extensionTokens[0].id}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect((await request('/api/extension/status', { body: { status: 'success' }, bearer: token, origin: null })).status).toBe(401);
    expect((await request('/api/extension/import', { body: { batchId: 'revoked', runId: 'revoked', source: 'kindle', books: [] }, bearer: token, origin: null })).status).toBe(401);
  });
});

describe('library-wide Kindle account binding', () => {
  it('requires explicit confirmation, survives re-pairing, and rejects account replacement', async () => {
    const cookie = await login();
    const bearer = await pairedToken(cookie);
    const settings = async (token = bearer) => (await request('/api/extension/account', { body: {}, bearer: token, origin: null })).json();
    const original = await settings() as { salt: string; fingerprint: string | null };
    expect(original.fingerprint).toBeNull();
    const fingerprint = 'a'.repeat(64);
    expect((await request('/api/extension/account/confirm', { bearer, body: { fingerprint }, origin: null })).status).toBe(400);
    expect((await request('/api/extension/import', { bearer, body: { source:'kindle', batchId:'old', runId:'old', books:[] }, origin:null })).status).toBe(409);
    const confirm = (value: string) => request('/api/extension/account/confirm', { bearer, body: { fingerprint:value, confirmed:true }, origin:null });
    const responses = await Promise.all([confirm(fingerprint),confirm('b'.repeat(64))]);
    expect(responses.map(r => r.status).sort()).toEqual([200,409]);
    const locked = await settings() as { salt: string; fingerprint: string };
    expect(locked.salt).toBe(original.salt);
    expect((await confirm(locked.fingerprint)).status).toBe(200);
    expect(await settings(await pairedToken(cookie))).toEqual(locked);
    expect((await request('/api/extension/account', { body: {}, origin:null })).status).toBe(401);
    expect((await request('/api/extension/import', { bearer, body: { source:'kindle', accountFingerprint:locked.fingerprint, batchId:'new', runId:'new', books:[], complete:true }, origin:null })).status).toBe(200);
    const other = await pairedToken(await seedAccount('other'));
    const otherSettings = await settings(other) as { salt:string; fingerprint:string|null };
    expect(otherSettings.fingerprint).toBeNull();
    expect(otherSettings.salt).not.toBe(locked.salt);
  });
});

describe('delivery preferences and explicit unsubscribe', () => {
  it.each([
    { intervalDays: 0 }, { intervalDays: 31 }, { intervalDays: 1.5 },
    { highlightCount: 0 }, { highlightCount: 21 }, { highlightCount: 2.5 },
    { localTime: '24:00' }, { localTime: '08:75' }, { timezone: 'Invalid/Timezone' },
  ])('rejects invalid preferences %j without altering saved cadence', async invalid => {
    const cookie = await login('America/Los_Angeles');
    expect((await request('/api/preferences', { method: 'PUT', cookie, body: { ...basePreferences, ...invalid } })).status).toBe(400);
    const saved = await (await request('/api/preferences', { cookie })).json() as Preferences;
    expect(saved).toMatchObject({ ...basePreferences, nextSendAt: null });
  });

  it('schedules a resumed account, preserves its next send on count-only changes, and clears it on pause', async () => {
    const cookie = await login('Europe/London');
    const enabled = { ...basePreferences, timezone: 'Europe/London', enabled: true };
    const response = await request('/api/preferences', { method: 'PUT', cookie, body: enabled });
    expect(response.status).toBe(200);
    const saved = await response.json() as Preferences;
    expect(Date.parse(saved.nextSendAt!)).toBeGreaterThan(Date.now());
    const countOnly = await (await request('/api/preferences', { method: 'PUT', cookie, body: { ...enabled, highlightCount: 10 } })).json() as Preferences;
    expect(countOnly.nextSendAt).toBe(saved.nextSendAt);
    const paused = await (await request('/api/preferences', { method: 'PUT', cookie, body: { ...enabled, enabled: false } })).json() as Preferences;
    expect(paused).toMatchObject({ enabled: false, nextSendAt: null });
    const resumed = await (await request('/api/preferences', { method: 'PUT', cookie, body: enabled })).json() as Preferences;
    expect(resumed.enabled).toBe(true);
    expect(Date.parse(resumed.nextSendAt!)).toBeGreaterThan(Date.now());
  });

  it('does not pause on a GET scanned by an email client; signed POST pauses without a session', async () => {
    const cookie = await login();
    await request('/api/preferences', { method: 'PUT', cookie, body: { ...basePreferences, enabled: true } });
    const token = await signUnsubscribeToken(env, 'local-development-user');
    const landing = await request(`/unsubscribe?token=${encodeURIComponent(token)}`, { origin: null });
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain('Pause my emails');
    expect(await DB.prepare('SELECT enabled FROM preferences').first('enabled')).toBe(1);
    expect((await request('/api/unsubscribe?token=invalid', { method: 'POST', origin: null })).status).toBe(400);
    expect(await DB.prepare('SELECT enabled FROM preferences').first('enabled')).toBe(1);
    expect((await request(`/api/unsubscribe?token=${encodeURIComponent(token)}`, { method: 'POST', origin: null })).status).toBe(200);
    expect(await DB.prepare('SELECT enabled FROM preferences').first('enabled')).toBe(0);
  });
});

describe('Better Auth owner magic link roundtrip', () => {
  function productionEnv(): Env {
    return { ...env, ENVIRONMENT: 'production', APP_URL: 'https://writefool.example', OWNER_EMAIL: 'owner@example.com', EMAIL_FROM: 'letters@writefool.example', RESEND_API_KEY: 'fake-for-provider-stub' };
  }

  it('rejects non-owner sign-in before creating a user or sending mail', async () => {
    const send = vi.fn(); vi.stubGlobal('fetch', send);
    const bindings = productionEnv();
    const response = await request('/api/auth/sign-in/magic-link', { bindings, body: { email: 'someone@example.com', callbackURL: bindings.APP_URL } });
    expect(response.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
    expect(await DB.prepare('SELECT count(*) AS count FROM user').first('count')).toBe(0);
  });

  it('sends a real one-use auth link, authenticates its owner, and initializes the selected timezone', async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ id: 'magic-link-provider-id' })); vi.stubGlobal('fetch', send);
    const bindings = productionEnv();
    const response = await request('/api/auth/sign-in/magic-link', { bindings, body: { email: 'owner@example.com', callbackURL: bindings.APP_URL + '/', timezone: 'Asia/Tokyo' } });
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(send.mock.calls[0][1].body) as { text: string; to: string };
    expect(payload.to).toBe('owner@example.com');
    const url = payload.text.match(/https:\/\/\S+/)?.[0];
    expect(url).toBeTruthy();
    const verified = await app.request(url!, { headers: { Origin: bindings.APP_URL } }, bindings);
    expect(verified.status).toBe(302);
    const cookies = verified.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    expect(cookies).toContain('session_token');
    const dashboard = await (await request('/api/dashboard', { bindings, cookie: cookies })).json() as Dashboard;
    expect(dashboard.user.email).toBe('owner@example.com');
    expect(dashboard.preferences.timezone).toBe('Asia/Tokyo');
    const again = await app.request(url!, { headers: { Origin: bindings.APP_URL } }, bindings);
    expect(again.headers.getSetCookie().some(cookie => cookie.includes('session_token='))).toBe(false);
    expect(again.status >= 400 || !!again.headers.get('location')?.includes('error=')).toBe(true);
  });
});
