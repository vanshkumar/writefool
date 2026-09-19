import type { ImportBatch, KindleAccount, NormalizedBook, SyncState } from '../shared/contracts';
import type { AnnotationPage } from './parser';
import { AccountError, AmazonAccountGuard } from './account';

const APP_URL = WRITEFOOL_APP_URL;
const DAILY_ALARM = 'writefool-daily';
const RESUME_ALARM = 'writefool-resume';
const ACCOUNT_ALARM = 'writefool-account-check';
interface Cursor { phase: 'library' | 'annotations' | 'complete'; books: NormalizedBook[]; bookIndex: number; token: string; contentLimitState: string; seenTokens: string[] }
interface State { busy?: boolean; schemaVersion?: number; accountFingerprint?: string; runAccountFingerprint?: string; token?: string; tabId?: number; runId?: string; cursor?: Cursor; pending?: { batch: ImportBatch; next: Cursor; remaining?: ImportBatch[] }; status?: SyncState; message?: string; progress?: number; lastSuccessAt?: string; warnings?: string[] }
let running = false;
const guard = new AmazonAccountGuard(chrome.cookies);
interface AccountCandidate { nonce: string; token: string; salt: string; fingerprint: string; expiresAt: number }

const state = async () => (await chrome.storage.local.get('writefool')).writefool as State ?? {};
// Persist the UI busy flag to produce a storage event when only the mutex changes.
// The in-memory running flag remains authoritative after a worker restart.
const save = async (data: State) => chrome.storage.local.set({ writefool: { ...data, busy: running } });

async function api<T = { token?: string }>(path: string, payload: unknown, token?: string): Promise<T> {
  const response = await fetch(`${APP_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload), credentials: 'omit', signal: AbortSignal.timeout(18000), redirect: 'error' });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(response.status === 401 ? 'Your connection expired or was revoked. Pair the extension again.' : data.error || `Writefool returned ${response.status}. Try again shortly.`);
  return data;
}

async function accountSettings(data: State): Promise<KindleAccount> {
  const account = await api<KindleAccount>('/api/extension/account', {}, data.token);
  if (typeof account.salt !== 'string' || !account.salt || !(account.fingerprint === null || /^[a-f0-9]{64}$/.test(account.fingerprint))) {
    throw new AccountError('Account protection is unavailable. Update Writefool and the extension before syncing.');
  }
  return account;
}

async function upgrade(data: State) {
  if (data.schemaVersion === 2) return;
  // Old cursors and pending batches have no proven Amazon account provenance.
  // Never stamp today's account onto yesterday's unknown payload.
  await closeOwnedTab(data);
  delete data.pending; delete data.cursor; delete data.runId; delete data.runAccountFingerprint;
  delete data.accountFingerprint;
  data.schemaVersion = 2;
  await save(data);
}

async function prepareAccount(data: State) {
  await upgrade(data);
  await closeOwnedTab(data);
  const settings = await accountSettings(data);
  const account = await guard.verify(settings.salt, settings.fingerprint);
  const tab = await notebookTab(data);
  await guard.unchanged(account);
  const page = await readPage<{ books: NormalizedBook[] }>(tab, { kind: 'library', token: '' });
  await guard.unchanged(account);
  if (settings.fingerprint) {
    data.accountFingerprint = settings.fingerprint;
    await report(data, 'idle', 'Your connected Kindle account is verified. Choose Sync highlights.');
    return { alreadyConfirmed: true };
  }
  const candidate: AccountCandidate = { nonce: crypto.randomUUID(), token: data.token!, salt: settings.salt, fingerprint: account.fingerprint, expiresAt: Date.now() + 10 * 60 * 1000 };
  await chrome.storage.session.set({ accountCandidate: candidate });
  return { nonce: candidate.nonce, titles: page.books.slice(0,3).map(book => book.title) };
}

async function confirmAccount(data: State, nonce?: string) {
  const preview = (await chrome.storage.session.get('accountCandidate')).accountCandidate as AccountCandidate | undefined;
  if (!preview || preview.nonce !== nonce || preview.token !== data.token || Date.now() > preview.expiresAt) {
    throw new AccountError('Check your Kindle account again before confirming it.', 'account_required');
  }
  const settings = await accountSettings(data);
  if (settings.salt !== preview.salt) throw new AccountError('Account settings changed. Check your Kindle account again.');
  const current = await guard.verify(settings.salt, preview.fingerprint);
  await guard.unchanged(current);
  const locked = await api<KindleAccount>('/api/extension/account/confirm', { fingerprint: current.fingerprint, confirmed: true }, data.token);
  if (locked.fingerprint !== current.fingerprint) throw new AccountError('Account confirmation could not be verified.');
  data.accountFingerprint = current.fingerprint;
  await chrome.storage.session.remove('accountCandidate');
  await report(data, 'idle', 'Kindle account locked. Your first protected sync is ready.');
}

async function report(data: State, status: SyncState, message: string, progress = data.progress ?? 0) {
  data.status = status; data.message = message; data.progress = progress;
  await save(data);
  if (data.token) await api('/api/extension/status', { status, message, progress }, data.token);
}

async function closeOwnedTab(data: State) {
  const owned = (await chrome.storage.session.get('ownedTab')).ownedTab as number | undefined;
  if (data.tabId !== undefined && owned === data.tabId) {
    const tab = await chrome.tabs.get(data.tabId).catch(() => null);
    if (tab?.url?.startsWith('https://read.amazon.com/notebook')) await chrome.tabs.remove(data.tabId).catch(() => {});
    await chrome.storage.session.remove('ownedTab');
  }
  delete data.tabId;
}

async function notebookTab(data: State): Promise<number> {
  // Session storage prevents a restored numeric tab ID from being mistaken for an unrelated tab after restart.
  const owned = (await chrome.storage.session.get('ownedTab')).ownedTab as number | undefined;
  if (data.tabId !== undefined && owned === data.tabId) {
    try { await chrome.tabs.get(data.tabId); return data.tabId; } catch { /* reopen closed notebook */ }
  }
  const tab = await chrome.tabs.create({ url: 'https://read.amazon.com/notebook', active: false });
  data.tabId = tab.id!;
  await chrome.storage.session.set({ ownedTab: tab.id });
  await save(data);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tab.id!);
    if (current.status === 'complete') return tab.id!;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Kindle took too long to open. Check your connection and try again.');
}

async function readPage<T>(tabId: number, request: Record<string, string>): Promise<T> {
  const requestId = crypto.randomUUID();
  let result: { requestId?: string; ok?: boolean; kind?: string; error?: string; data?: T };
  try {
    result = await chrome.tabs.sendMessage(tabId, { channel: 'writefool:notebook', requestId, ...request });
  } catch {
    throw Object.assign(new Error('Open your Kindle notebook in Chrome and sign in, then sync again.'), { kind: 'login_required' });
  }
  if (!result || result.requestId !== requestId) throw new Error('Kindle returned an unexpected response. Try syncing again.');
  if (!result.ok) throw Object.assign(new Error(result.error || 'The Kindle notebook could not be read.'), { kind: result.kind });
  return result.data!;
}

async function ensureAlarms() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (!(await chrome.alarms.get(DAILY_ALARM))) await chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 24 * 60 });
  const data = await state();
  if (data.runId && data.status === 'syncing' && !(await chrome.alarms.get(RESUME_ALARM))) await chrome.alarms.create(RESUME_ALARM, { periodInMinutes: 1 });
}

async function sync() {
  if (running) return;
  running = true;
  const data = await state();
  try {
    if (!data.token) return;
    await upgrade(data);
    // Never reuse a rendered document left behind by an interrupted worker.
    await closeOwnedTab(data);
    const account = await accountSettings(data);
    if (!account.fingerprint) throw new AccountError('Confirm your Kindle account in the extension before importing highlights.', 'account_required');
    data.accountFingerprint = account.fingerprint;
    if (data.runId && data.runAccountFingerprint !== account.fingerprint) {
      throw new AccountError('This unfinished import belongs to an unverified account. Reconnect the extension to start a fresh import.');
    }
    const session = await guard.verify(account.salt, account.fingerprint);
    if (!data.runId) {
      data.runId = crypto.randomUUID();
      data.runAccountFingerprint = account.fingerprint;
      data.warnings = [];
      data.cursor = { phase: 'library', books: [], bookIndex: 0, token: '', contentLimitState: '', seenTokens: [] };
    }
    await report(data, 'syncing', 'Reading your Kindle notebook…');
    await chrome.alarms.create(RESUME_ALARM, { periodInMinutes: 1 });
    while (data.cursor) {
      // The session remains fixed for the entire invocation, including A→B→A switches.
      await guard.unchanged(session);
      if (data.pending) {
        const pending = data.pending;
        if ([pending.batch, ...(pending.remaining ?? [])].some(batch => batch.accountFingerprint !== account.fingerprint)) {
          throw new AccountError('An unfinished batch has no verified account. Reconnect the extension to start a fresh import.');
        }
        await api('/api/extension/import', pending.batch, data.token);
        if (pending.remaining?.length) {
          const [nextBatch, ...remaining] = pending.remaining;
          data.pending = { batch: nextBatch, next: pending.next, remaining };
        } else {
          data.cursor = pending.next;
          delete data.pending;
        }
        await save(data);
        const cursor = data.cursor;
        await report(data, 'syncing', cursor.phase === 'complete' ? 'Finishing your import…' : `Importing book ${Math.min(cursor.bookIndex + 1, cursor.books.length)} of ${cursor.books.length}…`, Math.round((cursor.bookIndex / Math.max(1, cursor.books.length)) * 100));
        continue;
      }
      const cursor = data.cursor;
      if (cursor.phase === 'complete') {
        data.lastSuccessAt = new Date().toISOString();
        delete data.cursor; delete data.runId; delete data.runAccountFingerprint;
        await closeOwnedTab(data);
        await report(data, 'success', ['Your Kindle highlights are up to date.', ...(data.warnings ?? [])].join(' '), 100);
        await chrome.alarms.clear(RESUME_ALARM);
        break;
      }
      const tabId = await notebookTab(data);
      await guard.unchanged(session);
      if (cursor.phase === 'library') {
        const page = await readPage<{ books: NormalizedBook[]; nextToken: string | null }>(tabId, { kind: 'library', token: cursor.token });
        await guard.unchanged(session);
        if (page.nextToken && (page.nextToken === cursor.token || cursor.seenTokens.includes(page.nextToken))) throw new Error('Kindle library pagination repeated a page. Sync stopped without removing saved highlights.');
        const unique = new Map(cursor.books.map((book) => [book.sourceId, book]));
        page.books.forEach((book) => unique.set(book.sourceId, book));
        cursor.books = [...unique.values()];
        if (page.nextToken) { cursor.seenTokens.push(cursor.token); cursor.token = page.nextToken; }
        else { cursor.phase = 'annotations'; cursor.token = ''; cursor.seenTokens = []; }
        await save(data);
        continue;
      }
      const book = cursor.books[cursor.bookIndex];
      if (!book) {
        data.pending = { batch: { source: 'kindle', accountFingerprint: account.fingerprint, runId: data.runId!, batchId: `${data.runId}:complete`, books: [], complete: true }, next: { ...cursor, phase: 'complete' } };
        await save(data); continue;
      }
      const page = await readPage<AnnotationPage>(tabId, { kind: 'annotations', asin: book.sourceId, token: cursor.token, contentLimitState: cursor.contentLimitState });
      await guard.unchanged(session);
      data.warnings = [...new Set([...(data.warnings ?? []), ...page.warnings])];
      if (page.nextToken && (page.nextToken === cursor.token || cursor.seenTokens.includes(page.nextToken))) throw new Error('Kindle highlight pagination repeated a page. Sync stopped without removing saved highlights.');
      const next: Cursor = { ...cursor, token: page.nextToken || '', contentLimitState: page.nextToken ? page.contentLimitState : '', bookIndex: cursor.bookIndex + (page.nextToken ? 0 : 1), seenTokens: page.nextToken ? [...cursor.seenTokens, cursor.token] : [] };
      const batches: ImportBatch[] = [];
      for (let offset = 0; offset < Math.max(1, page.highlights.length); offset += 100) {
        batches.push({ source: 'kindle', accountFingerprint: account.fingerprint, runId: data.runId!, batchId: crypto.randomUUID(), books: [{ ...book, highlights: page.highlights.slice(offset, offset + 100) }], warnings: page.warnings });
      }
      data.pending = { batch: batches[0], next, remaining: batches.slice(1) };
      // Freeze every chunk and the final page continuation before submission. Only advance the
      // page after all chunks succeed; an uncertain response replays the exact current chunk.
      await save(data);
    }
  } catch (error) {
    const status = error instanceof AccountError ? error.kind : (error as { kind?: string }).kind === 'login_required' ? 'login_required' : 'error';
    const cursor = data.cursor;
    const stage = data.pending ? 'upload' : cursor?.phase === 'library' ? `library page ${cursor.seenTokens.length + 1}, ${cursor.books.length} books found` : cursor?.phase === 'annotations' ? `highlights for book ${cursor.bookIndex + 1} of ${cursor.books.length}` : 'connection';
    const message = error instanceof Error ? error.message : 'Sync interrupted. Try again to resume.';
    // Explicit errors wait for a manual or next daily retry. Worker interruptions retain the resume alarm.
    await closeOwnedTab(data);
    await report(data, status, `[Extension ${chrome.runtime.getManifest().version}; ${stage}] ${message}`.slice(0, 1000)).catch(() => {});
    await chrome.alarms.clear(RESUME_ALARM);
  } finally {
    running = false;
    // Publish the settled state so an open popup can enable its controls.
    await save(data);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) return;
  if (!message || typeof message !== 'object') return;
  const request = message as { channel?: string; requestId?: string; action?: string; code?: string; appUrl?: string; nonce?: string };
  if (request.channel !== 'writefool:popup' || typeof request.requestId !== 'string' || !/^[\w-]{10,100}$/.test(request.requestId)) return;
  void (async () => {
    try {
      const data = await state();
      if (request.action === 'state') {
        reply({ requestId: request.requestId, ok: true, data: { connected: Boolean(data.token), accountConfirmed: Boolean(data.accountFingerprint), busy: running, status: data.status ?? 'idle', message: data.message, progress: data.progress, lastSuccessAt: data.lastSuccessAt, appUrl: APP_URL } }); return;
      }
      if (request.action === 'prepare-account' || request.action === 'confirm-account') {
        if (running) throw new Error('Wait for the current sync or account check to finish.');
        if (!data.token) throw new Error('Pair the extension first.');
        running = true;
        let result: unknown;
        try {
          result = request.action === 'prepare-account' ? await prepareAccount(data) : await confirmAccount(data, request.nonce);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Account verification failed.';
          await report(data, error instanceof AccountError ? error.kind : 'error', message).catch(() => {});
          throw error;
        } finally {
          try { await closeOwnedTab(data); await save(data); } finally { running = false; }
        }
        reply({ requestId: request.requestId, ok: true, data: result });
        return;
      }
      if (request.action === 'pair') {
        if (running) throw new Error('Wait for the current sync to finish before pairing again.');
        if (request.appUrl !== APP_URL || typeof request.code !== 'string' || !/^[A-Za-z0-9-]{6,32}$/.test(request.code)) throw new Error('Check your app URL and pairing code.');
        running = true;
        try {
        const result = await api('/api/extension/pair', { code: request.code });
        if (!result.token) throw new Error('No connection token was returned. Generate a new code in Writefool.');
        await closeOwnedTab(data);
        await chrome.storage.session.remove('accountCandidate');
        await save({ schemaVersion: 2, token: result.token, status: 'idle' });
        } finally { running = false; }
      } else if (request.action !== 'sync') throw new Error('Unknown extension action.');
      reply({ requestId: request.requestId, ok: true });
      void sync();
    } catch (error) { reply({ requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : 'The request failed.' }); }
  })();
  return true;
});

chrome.cookies?.onChanged.addListener((change) => {
  if (guard.cookieChanged(change.cookie, change)) {
    void chrome.storage.session.remove('accountCandidate');
    // A single delayed check avoids retrying on every cookie in a login sequence.
    void chrome.alarms.create(ACCOUNT_ALARM, { delayInMinutes: 1 });
  }
});
chrome.alarms.onAlarm.addListener((alarm) => { if ([DAILY_ALARM, RESUME_ALARM, ACCOUNT_ALARM].includes(alarm.name)) void sync(); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarms().then(async () => { const data = await state(); if (data.token && (data.runId || !data.lastSuccessAt || Date.now() - Date.parse(data.lastSuccessAt) > 86400000)) await sync(); }); });
chrome.runtime.onInstalled.addListener(() => { void ensureAlarms(); });
void ensureAlarms();
