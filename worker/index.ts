import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Dashboard, DigestSummary, SyncStatus, ImportBatch } from '../shared/contracts';
import { nextOccurrence } from '../shared/schedule';
import { configured, createAuth, currentUser, developmentUser, ensureOwner, isLocalDevelopment } from './auth';
import { ensurePreferences, getBooks, getHighlights, getPreferences, hash, preferencesFromRow, randomToken, rateLimit, validTimezone, type UserRow } from './db';
import { buildPreview, handleWebhook, pauseByToken, processScheduled, sendTest } from './digest';
import { importBatch, previewClippings, ImportError } from './import';
import { kindleAccount, confirmKindleAccount } from './kindle-account';

type App = { Bindings: Env; Variables: { user: UserRow; extensionUserId: string } };
const app = new Hono<App>();
const stringId = z.string().min(1).max(300);
const normalizedHighlight = z.object({ sourceId: stringId, text: z.string().min(1).max(100000), note: z.string().max(100000).nullable().optional(), location: z.string().max(500).nullable().optional(), highlightedAt: z.string().max(200).nullable().optional() });
const normalizedBook = z.object({ sourceId: stringId, title: z.string().min(1).max(1000), author: z.string().max(500), highlights: z.array(normalizedHighlight).max(500), targetBookId: stringId.optional() });
const batchSchema = z.object({ batchId: stringId, runId: stringId, source: z.enum(['kindle', 'clippings']), books: z.array(normalizedBook).max(50), complete: z.boolean().optional(), warnings: z.array(z.string().max(1000)).max(100).optional(), accountFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }).refine(v => v.books.reduce((n,b) => n + b.highlights.length, 0) <= 500, 'Import at most 500 highlights per batch');
const preferencesSchema = z.object({ intervalDays: z.number().int().min(1).max(30), highlightCount: z.number().int().min(1).max(20), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().refine(validTimezone, 'Choose a valid timezone'), enabled: z.boolean() });
const safeHtml = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  c.header('Cache-Control', 'no-store');
  await next();
});
app.use('/api/*', bodyLimit({ maxSize: 4 * 1024 * 1024, onError: c => c.json({ error: 'This import is too large. Split it into smaller batches.' }, 413) }));
app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  const publicTokenRoute = path.startsWith('/api/extension/') || path === '/api/webhooks/resend' || path === '/api/unsubscribe';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !publicTokenRoute) {
    const origin = c.req.header('Origin');
    const ownOrigin = new URL(c.req.url).origin;
    if (!origin || !(origin === c.env.APP_URL || (isLocalDevelopment(c.env, c.req.url) && origin === ownOrigin))) return c.json({ error: 'Request origin is not allowed' }, 403);
  }
  await next();
});

app.get('/api/config', c => c.json({ configured: configured(c.env), development: isLocalDevelopment(c.env, c.req.url) }));

app.on(['GET','POST'], '/api/auth/*', async c => {
  if (c.req.path === '/api/auth/sign-out') {
    const devToken = getCookie(c, 'wf_dev');
    if (devToken && isLocalDevelopment(c.env, c.req.url)) await c.env.DB.prepare('DELETE FROM dev_sessions WHERE token_hash=?').bind(await hash(devToken)).run();
    deleteCookie(c, 'wf_dev', { path: '/' });
    if (!configured(c.env)) return c.json({ success: true });
  }
  if (c.req.path === '/api/auth/get-session') {
    const local = await developmentUser(c);
    if (local) return c.json({ user: local, session: { id: 'local-development' } });
    if (!configured(c.env)) return c.json(null);
  }
  if (!configured(c.env)) return c.json({ error: 'Email sign-in is not configured yet. Set the owner email, sending domain, and Resend credentials.' }, 503);
  if (c.req.path === '/api/auth/sign-in/magic-link' && c.req.method === 'POST') {
    const input = z.object({ email: z.email(), timezone: z.string().optional() }).parse(await c.req.raw.clone().json());
    if (!await rateLimit(c.env.DB, `login:${c.req.header('cf-connecting-ip') || 'local'}`, 5, 600)) return c.json({ error: 'Please wait before requesting another sign-in link.' }, 429);
    if (input.email.toLowerCase() !== c.env.OWNER_EMAIL.trim().toLowerCase()) return c.json({ error: 'This is a private account. Use the configured owner email.' }, 403);
    await ensureOwner(c.env, input.timezone);
  }
  return createAuth(c.env).handler(c.req.raw);
});

app.post('/api/dev/login', async c => {
  if (!isLocalDevelopment(c.env, c.req.url)) return c.json({ error: 'Not found' }, 404);
  const body = z.object({ timezone: z.string().optional() }).parse(await c.req.json());
  const now = Date.now();
  const userId = 'local-development-user';
  await c.env.DB.prepare("INSERT OR IGNORE INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Local reader','reader@localhost',1,?,?)").bind(userId,now,now).run();
  await ensurePreferences(c.env.DB, userId, body.timezone);
  const token = randomToken();
  await c.env.DB.prepare('INSERT INTO dev_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await hash(token),userId,new Date(now+7*86400000).toISOString()).run();
  setCookie(c, 'wf_dev', token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 7*86400 });
  return c.json({ ok: true });
});

app.use('/api/extension/*', async (c,next) => {
  const origin = c.req.header('Origin');
  if (origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    c.header('Access-Control-Allow-Methods', 'POST,OPTIONS');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  if (c.req.path === '/api/extension/pair') return next();
  const bearer = c.req.header('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!bearer) return c.json({ error: 'Pair the extension with your account first.' }, 401);
  const token = await c.env.DB.prepare('SELECT id,user_id FROM extension_tokens WHERE token_hash=? AND revoked_at IS NULL').bind(await hash(bearer)).first<{ id: string; user_id: string }>();
  if (!token) return c.json({ error: 'This extension connection was revoked. Pair it again.' }, 401);
  c.set('extensionUserId',token.user_id);
  await c.env.DB.prepare('UPDATE extension_tokens SET last_used_at=? WHERE id=?').bind(new Date().toISOString(),token.id).run();
  await next();
});
app.post('/api/extension/pair', async c => {
  const body = z.object({ code: z.string().min(6).max(32) }).parse(await c.req.json());
  if (!await rateLimit(c.env.DB, `pair:${c.req.header('cf-connecting-ip') || 'local'}`,10,600)) return c.json({ error: 'Too many pairing attempts. Try again in 10 minutes.' },429);
  const code = body.code.replace(/[\s-]/g,'').toUpperCase();
  const codeHash = await hash(code);
  const token = randomToken();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO extension_tokens(id,user_id,token_hash,created_at) SELECT ?,user_id,?,? FROM pairing_codes WHERE code_hash=? AND expires_at>?').bind(id,await hash(token),now,codeHash,now),
    c.env.DB.prepare('DELETE FROM pairing_codes WHERE code_hash=?').bind(codeHash),
  ]);
  if (!results[0].meta.changes) return c.json({ error: 'This code has expired or was already used. Generate a new code in Writefool.' },400);
  return c.json({ token });
});
app.post('/api/extension/account', async c => c.json(await kindleAccount(c.env.DB,c.get('extensionUserId'))));
app.post('/api/extension/account/confirm', async c => {
  const input = z.object({ fingerprint:z.string().regex(/^[a-f0-9]{64}$/), confirmed:z.literal(true) }).parse(await c.req.json());
  return c.json(await confirmKindleAccount(c.env.DB,c.get('extensionUserId'),input.fingerprint));
});
app.post('/api/extension/import', async c => {
  const input = batchSchema.parse(await c.req.json());
  if (input.source !== 'kindle') return c.json({ error: 'The extension can import Kindle notebook highlights only.' },400);
  return c.json(await importBatch(c.env,c.get('extensionUserId'),input));
});
app.post('/api/extension/status', async c => {
  const input = z.object({ status: z.enum(['idle','syncing','success','login_required','account_required','account_mismatch','account_unverified','error']), progress: z.number().int().min(0).max(100).optional(), message: z.string().max(1000).nullable().optional() }).parse(await c.req.json());
  const now = new Date().toISOString();
  await c.env.DB.prepare('UPDATE sync_status SET status=?,message=?,progress=?,last_success_at=CASE WHEN ?=\'success\' THEN ? ELSE last_success_at END,updated_at=? WHERE user_id=?').bind(input.status,input.message||null,input.progress||0,input.status,now,now,c.get('extensionUserId')).run();
  return c.json({ ok: true });
});
app.post('/api/webhooks/resend', c => handleWebhook(c.env,c.req.raw));
app.post('/api/unsubscribe', async c => {
  const paused = await pauseByToken(c.env,c.req.query('token') || '');
  if (c.req.header('Accept')?.includes('text/html')) return c.html(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Writefool emails</title></head><body style="background:#f6f3ed;color:#282820;font:18px/1.6 Georgia,serif"><main style="max-width:480px;margin:15vh auto;padding:24px"><h1>${paused ? 'Your emails are paused.' : 'This link is not valid.'}</h1><p>${paused ? 'Your library is safe. Come back whenever you are ready.' : 'Open settings to manage your email schedule.'}</p><a href="/settings">Open settings</a></main></body></html>`,paused ? 200 : 400);
  return c.json(paused ? { ok: true } : { error: 'This unsubscribe link is invalid.' },paused ? 200 : 400);
});
app.get('/unsubscribe', c => {
  const token = c.req.query('token') || '';
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pause Writefool emails</title></head><body style="margin:0;background:#f6f3ed;color:#282820;font:18px/1.6 Georgia,serif"><main style="max-width:480px;margin:15vh auto;padding:24px"><p>WRITEFOOL</p><h1>A little quiet.</h1><p>Pause your highlight emails. Your library stays here, and you can resume any time in settings.</p><form method="post" action="/api/unsubscribe?token=${safeHtml(encodeURIComponent(token))}"><button style="font:inherit;padding:12px 24px;background:#343e37;color:white;border:0;border-radius:5px">Pause my emails</button></form></main></body></html>`);
});

app.use('/api/*', async (c,next) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'Sign in to your account to continue.' },401);
  c.set('user',user);
  await ensurePreferences(c.env.DB,user.id);
  await next();
});
app.get('/api/dashboard', async c => {
  const user = c.get('user');
  const [prefs, books, total, sync, digests, tokens] = await Promise.all([
    getPreferences(c.env.DB,user.id),
    getBooks(c.env.DB,user.id),
    c.env.DB.prepare('SELECT count(*) AS highlights,COALESCE(sum(CASE WHEN h.hidden=0 AND b.excluded=0 THEN 1 ELSE 0 END),0) AS eligible FROM highlights h JOIN books b ON b.id=h.book_id WHERE h.user_id=? AND b.user_id=?').bind(user.id,user.id).first<{ highlights: number; eligible: number }>(),
    c.env.DB.prepare('SELECT status,last_success_at AS lastSuccessAt,message,progress FROM sync_status WHERE user_id=?').bind(user.id).first<Omit<SyncStatus,'connected'>>(),
    c.env.DB.prepare('SELECT id,CASE WHEN is_test=1 THEN created_at ELSE scheduled_for END AS scheduledFor,status,highlight_count AS highlightCount,error,is_test AS isTest FROM digests WHERE user_id=? ORDER BY created_at DESC LIMIT 10').bind(user.id).all<DigestSummary>(),
    c.env.DB.prepare('SELECT id,created_at AS createdAt,last_used_at AS lastUsedAt FROM extension_tokens WHERE user_id=? AND revoked_at IS NULL').bind(user.id).all<{ id: string; createdAt: string; lastUsedAt: string | null }>(),
  ]);
  const result: Dashboard = { user, preferences: preferencesFromRow(prefs), totals: { books: books.length, highlights: total?.highlights||0,eligible:total?.eligible||0 }, sync: { status:'idle',lastSuccessAt:null,message:null,progress:0,...sync,connected:tokens.results.length>0 },recentDigests:digests.results.map(d => ({...d,isTest:!!d.isTest})),extensionTokens:tokens.results };
  return c.json(result);
});
app.get('/api/books', async c => c.json({ books: await getBooks(c.env.DB,c.get('user').id) }));
app.get('/api/highlights', async c => c.json({ highlights: await getHighlights(c.env.DB,c.get('user').id,{ bookId:c.req.query('bookId'),q:c.req.query('q')?.slice(0,300),includeHidden:c.req.query('includeHidden')==='true' }) }));
app.patch('/api/books/:id', async c => {
  const { excluded } = z.object({ excluded:z.boolean() }).parse(await c.req.json());
  const userId = c.get('user').id;
  const results = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE books SET excluded=? WHERE id=? AND user_id=?').bind(excluded?1:0,c.req.param('id'),userId),
    c.env.DB.prepare("UPDATE preferences SET updated_at=CASE WHEN updated_at>=? THEN strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds') ELSE ? END WHERE user_id=?").bind(new Date().toISOString(),new Date().toISOString(),userId),
    c.env.DB.prepare("UPDATE digests SET status='cancelled',error='Library selection changed' WHERE user_id=? AND status='pending' AND first_attempt_at IS NULL").bind(userId),
  ]);
  if (!results[0].meta.changes) return c.json({error:'Book not found'},404);
  return c.json({ok:true});
});
app.patch('/api/highlights/:id', async c => {
  const { hidden } = z.object({ hidden:z.boolean() }).parse(await c.req.json());
  const userId = c.get('user').id;
  const results = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE highlights SET hidden=? WHERE id=? AND user_id=?').bind(hidden?1:0,c.req.param('id'),userId),
    c.env.DB.prepare("UPDATE preferences SET updated_at=CASE WHEN updated_at>=? THEN strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds') ELSE ? END WHERE user_id=?").bind(new Date().toISOString(),new Date().toISOString(),userId),
    c.env.DB.prepare("UPDATE digests SET status='cancelled',error='Library selection changed' WHERE user_id=? AND status='pending' AND first_attempt_at IS NULL").bind(userId),
  ]);
  if (!results[0].meta.changes) return c.json({error:'Highlight not found'},404);
  return c.json({ok:true});
});
app.get('/api/preferences', async c => c.json(preferencesFromRow(await getPreferences(c.env.DB,c.get('user').id))));
app.put('/api/preferences', async c => {
  const input = preferencesSchema.parse(await c.req.json());
  const userId = c.get('user').id;
  const existing = await getPreferences(c.env.DB,userId);
  if (input.enabled && existing.suppressed_at) return c.json({error:'Delivery is stopped after a bounce or complaint. Resolve the address with your email provider before resuming.'},409);
  const scheduleChanged = input.intervalDays!==existing.interval_days || input.localTime!==existing.local_time || input.timezone!==existing.timezone || input.enabled!==!!existing.enabled;
  const next = !input.enabled ? null : scheduleChanged || !existing.next_send_at ? nextOccurrence(input).toISOString() : existing.next_send_at;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE preferences SET interval_days=?,highlight_count=?,local_time=?,timezone=?,enabled=?,next_send_at=?,updated_at=CASE WHEN updated_at>=? THEN strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds') ELSE ? END WHERE user_id=?").bind(input.intervalDays,input.highlightCount,input.localTime,input.timezone,input.enabled?1:0,next,new Date().toISOString(),new Date().toISOString(),userId),
    c.env.DB.prepare(`UPDATE digests SET status='cancelled',error='Email preferences changed' WHERE user_id=? AND status='pending' AND (?=0 OR first_attempt_at IS NULL)`).bind(userId,input.enabled?1:0),
  ]);
  return c.json({ ...input,nextSendAt:next });
});
app.get('/api/digest/preview', async c => c.json(await buildPreview(c.env,c.get('user').id)));
app.post('/api/digest/test', async c => {
  if (!c.env.RESEND_API_KEY || !c.env.EMAIL_FROM) return c.json({error:'Configure Resend and a verified sender before sending a test email.'},503);
  if (!await rateLimit(c.env.DB,`test:${c.get('user').id}`,3,600)) return c.json({error:'Please wait before sending another test email.'},429);
  const result = await sendTest(c.env,c.get('user').id);
  return c.json(result);
});
app.post('/api/pairing', async c => {
  const userId = c.get('user').id;
  if (!await rateLimit(c.env.DB,`new-pair:${userId}`,10,600)) return c.json({error:'Please wait before generating another pairing code.'},429);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from(crypto.getRandomValues(new Uint8Array(12)),byte => alphabet[byte%alphabet.length]).join('');
  const now = new Date(); const expiresAt = new Date(now.getTime()+600000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM pairing_codes WHERE user_id=? OR expires_at<=?').bind(userId,now.toISOString()),
    c.env.DB.prepare('INSERT INTO pairing_codes(code_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await hash(code),userId,expiresAt,now.toISOString()),
  ]);
  return c.json({code:code.match(/.{4}/g)!.join('-'),expiresAt,appUrl:c.env.APP_URL});
});
app.delete('/api/extension-tokens/:id', async c => {
  const result = await c.env.DB.prepare('UPDATE extension_tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL').bind(new Date().toISOString(),c.req.param('id'),c.get('user').id).run();
  if (!result.meta.changes) return c.json({error:'Connection not found'},404);
  return c.json({ok:true});
});
app.post('/api/clippings/preview', async c => {
  const input = z.object({text:z.string().min(1).max(3*1024*1024)}).parse(await c.req.json());
  return c.json(await previewClippings(c.env,c.get('user').id,input.text));
});
app.post('/api/clippings/import', async c => {
  const input = batchSchema.parse(await c.req.json());
  if (input.source!=='clippings') return c.json({error:'Choose a clippings import.'},400);
  return c.json(await importBatch(c.env,c.get('user').id,input));
});
app.post('/api/dev/seed', async c => {
  if (!isLocalDevelopment(c.env,c.req.url)) return c.json({error:'Not found'},404);
  const batch: ImportBatch = {source:'clippings',batchId:'sample-library-v1',runId:'sample-library-v1',books:[
    {sourceId:'sample-meditations',title:'Meditations',author:'Marcus Aurelius',highlights:[{sourceId:'sample-1',text:'The happiness of thy life depends upon the quality of thy thoughts.',location:'Book V'},{sourceId:'sample-2',text:'Look within. Within is the fountain of good, and it will ever bubble up, if thou wilt ever dig.',location:'Book VII'}]},
    {sourceId:'sample-walden',title:'Walden',author:'Henry David Thoreau',highlights:[{sourceId:'sample-3',text:'I went to the woods because I wished to live deliberately, to front only the essential facts of life.',location:'Where I Lived, and What I Lived For'},{sourceId:'sample-4',text:'Our life is frittered away by detail. Simplify, simplify.',location:'Where I Lived, and What I Lived For'}]},
    {sourceId:'sample-pride',title:'Pride and Prejudice',author:'Jane Austen',highlights:[{sourceId:'sample-5',text:'There is a stubbornness about me that never can bear to be frightened at the will of others.',location:'Chapter 31'}]},
  ]};
  return c.json(await importBatch(c.env,c.get('user').id,batch));
});
app.notFound(c => c.json({error:'Not found'},404));
app.onError((error,c) => {
  if (error instanceof z.ZodError) return c.json({error:error.issues[0]?.message || 'Please check the submitted values.'},400);
  if (error instanceof SyntaxError) return c.json({error:'The request must contain valid JSON.'},400);
  if (error instanceof ImportError) return c.json({error:error.message},error.status as 400 | 409);
  console.error(JSON.stringify({event:'request_failed',path:c.req.path,errorType:error.name}));
  return c.json({error:'This request could not be completed. Please try again.'},500);
});

export { app };
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController,env:Env,_ctx:ExecutionContext) {
    if (!configured(env)) { console.error(JSON.stringify({event:'scheduled_delivery_not_configured'})); return; }
    await processScheduled(env);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(Date.now()),
      env.DB.prepare('DELETE FROM pairing_codes WHERE expires_at<?').bind(new Date().toISOString()),
      env.DB.prepare('DELETE FROM dev_sessions WHERE expires_at<?').bind(new Date().toISOString()),
    ]);
  },
} satisfies ExportedHandler<Env>;
