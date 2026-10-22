import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../extension/account';
const amazonHtml = `<script>window.$Nav && $Nav.declare('config.lightningDeals', {"activeItems":[],"customerID":"ATESTACCOUNT001"});</script>`;
const fingerprint = await sha256(JSON.stringify(['writefool-amazon-account-v1','test-salt','ATESTACCOUNT001']));
function responseFor(url: string) { return new Response(url === 'https://www.amazon.com/' ? amazonHtml : url.endsWith('/api/extension/account') ? JSON.stringify({salt:'test-salt',fingerprint}) : '{}', {status:200}); }

type Listener = (...args: any[]) => any;
function harness(saved: Record<string, any>) {
  let data: Record<string, any> = structuredClone({ schemaVersion:2, runAccountFingerprint:fingerprint, ...saved });
  const session: Record<string, any> = {};
  const listeners: Record<string, Listener> = {};
  const alarms = new Map<string, chrome.alarms.Alarm>();
  const event = (name: string) => ({ addListener: (listener: Listener) => { listeners[name] = listener; } });
  const chrome = {
    storage: {
      local: { get: vi.fn(async () => ({ writefool: structuredClone(data) })), set: vi.fn(async (value) => { data = structuredClone(value.writefool); }), setAccessLevel: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => session), set: vi.fn(async (value) => Object.assign(session, value)), remove: vi.fn(async (name: string) => { delete session[name]; }) },
    },
    cookies: { getAll: vi.fn(async () => ['at-main','session-id'].map(name => ({name,value:'test-cookie',domain:'.amazon.com',path:'/',storeId:'0',hostOnly:false}))), onChanged: event('cookie') },
    runtime: { id: 'test-extension', getManifest: () => ({ version: '0.2.2' }), getURL: (path: string) => `chrome-extension://test-extension/${path}`, onMessage: event('message'), onStartup: event('startup'), onInstalled: event('installed') },
    alarms: {
      get: vi.fn(async (name: string) => alarms.get(name)),
      create: vi.fn(async (name: string, info: chrome.alarms.AlarmCreateInfo) => { alarms.set(name, { name, scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000, periodInMinutes: info.periodInMinutes, persistAcrossSessions: true }); }),
      clear: vi.fn(async (name: string) => alarms.delete(name)), onAlarm: event('alarm'),
    },
    tabs: { create: vi.fn(async () => ({ id: 5 })), get: vi.fn(async () => ({ id: 5, status: 'complete', url: 'https://read.amazon.com/notebook' })), remove: vi.fn(async () => {}), sendMessage: vi.fn() },
  };
  vi.stubGlobal('chrome', chrome);
  vi.stubGlobal('WRITEFOOL_APP_URL', 'http://localhost:5183');
  return { chrome, listeners, read: () => data };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

const completeCursor = { phase: 'complete', books: [], bookIndex: 0, token: '', contentLimitState: '', seenTokens: [] };
const pending = { batch: { source: 'kindle', accountFingerprint:fingerprint, runId: 'resumable-run', batchId: 'fixed-batch-id', books: [], complete: true }, next: completeCursor };

describe('extension continuation and trust boundary', () => {
  it('walks library and annotation pages, preserves IDs, and surfaces export warnings', async () => {
    const app = harness({ token: 'import-only-secret' });
    const book = (sourceId: string) => ({ sourceId, title: 'A synthetic book', author: 'Example Writer', highlights: [] });
    app.chrome.tabs.sendMessage.mockImplementation(async (_id, request) => {
      let data;
      if (request.kind === 'library') data = { books: [book(request.token ? 'B000000002' : 'B000000001')], nextToken: request.token ? null : 'library-next' };
      else data = { highlights: request.asin === 'B000000001' ? [{ sourceId: request.token ? 'highlight-two' : 'highlight-one', text: 'A passage.' }] : [], nextToken: request.asin === 'B000000001' && !request.token ? 'annotation-next' : null, contentLimitState: 'state', warnings: request.token ? ['Amazon reports an export limit; some highlights may be unavailable.'] : [] };
      return { requestId: request.requestId, ok: true, data };
    });
    const batches: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/extension/import')) batches.push(JSON.parse(init.body as string));
      return responseFor(url);
    }));
    await import('../extension/background');
    app.listeners.startup();
    await vi.waitFor(() => expect(app.read().status).toBe('success'));
    expect(batches).toHaveLength(4);
    expect(batches.slice(0, 2).map((batch) => batch.books[0].highlights[0].sourceId)).toEqual(['highlight-one', 'highlight-two']);
    expect(batches[3]).toMatchObject({ books: [], complete: true });
    expect(new Set(batches.map((batch) => batch.runId)).size).toBe(1);
    expect(app.chrome.tabs.create).toHaveBeenCalledOnce();
    expect(app.chrome.tabs.remove).toHaveBeenCalledWith(5);
    expect(app.read().message).toContain('export limit');
  });

  it('replays a persisted batch after a service-worker restart before advancing its cursor', async () => {
    const app = harness({ token: 'import-only-secret', runId: 'resumable-run', status: 'syncing', cursor: { ...completeCursor, phase: 'annotations' }, pending });
    const fetcher = vi.fn(async (url: string, _init: RequestInit) => responseFor(url));
    vi.stubGlobal('fetch', fetcher);
    await import('../extension/background');
    app.listeners.startup();
    await vi.waitFor(() => expect(app.read().status).toBe('success'));
    const imports = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/extension/import'));
    expect(imports).toHaveLength(1);
    expect(JSON.parse((imports[0] as any)[1].body)).toEqual(pending.batch);
    expect(app.read().pending).toBeUndefined();
    expect(app.chrome.tabs.create).not.toHaveBeenCalled();
    expect(app.chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(app.chrome.alarms.create).toHaveBeenCalledWith('writefool-daily', { when: Date.parse(app.read().lastAttemptAt) + 86400000, periodInMinutes: 1440 });
  });
  it('resumes from an empty final library page and imports highlights for all previously discovered books', async () => {
    const books = Array.from({ length: 34 }, (_, index) => ({ sourceId: `B${String(index + 1).padStart(9, '0')}`, title: `Synthetic book ${index + 1}`, author: 'Writer', highlights: [] }));
    const cursor = { ...completeCursor, phase: 'library', token: 'saved-page-2', seenTokens: [''], books };
    const app = harness({ token: 'import-only-secret', runId: 'resumable-run', status: 'error', cursor });
    app.chrome.tabs.sendMessage.mockImplementation(async (_id, request) => ({ requestId: request.requestId, ok: true, data: request.kind === 'library'
      ? { books: [], nextToken: null }
      : { highlights: [{ sourceId: `passage-${request.asin}`, text: 'A synthetic passage.' }], nextToken: null, contentLimitState: '', warnings: [] } }));
    const batches: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/extension/import')) batches.push(JSON.parse(init.body as string));
      return responseFor(url);
    }));
    await import('../extension/background');
    app.listeners.startup();
    await vi.waitFor(() => expect(app.read().status).toBe('success'));
    expect(app.chrome.tabs.sendMessage.mock.calls[0][1]).toMatchObject({ kind: 'library', token: 'saved-page-2' });
    expect(batches).toHaveLength(35);
    expect(batches.flatMap((batch) => batch.books.map((book: any) => book.sourceId))).toEqual(books.map((book) => book.sourceId));
    expect(batches.at(-1)).toMatchObject({ runId: 'resumable-run', books: [], complete: true });
  });
  it('splits oversized Amazon pages into bounded persisted batches', async () => {
    const app = harness({ token: 'import-only-secret' });
    app.chrome.tabs.sendMessage.mockImplementation(async (_id, request) => ({ requestId: request.requestId, ok: true, data: request.kind === 'library' ? { books: [{ sourceId: 'B000000001', title: 'Large notebook', author: 'Writer', highlights: [] }], nextToken: null } : { highlights: Array.from({ length: 501 }, (_, index) => ({ sourceId: `highlight-${index}`, text: `Passage ${index}.` })), nextToken: null, contentLimitState: '', warnings: [] } }));
    const batches: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/extension/import')) batches.push(JSON.parse(init.body as string));
      return responseFor(url);
    }));
    await import('../extension/background');
    app.listeners.startup();
    await vi.waitFor(() => expect(app.read().status).toBe('success'));
    expect(batches).toHaveLength(7);
    expect(batches.every((batch) => !batch.books.length || batch.books[0].highlights.length <= 100)).toBe(true);
    expect(new Set(batches.flatMap((batch) => batch.books.flatMap((book: any) => book.highlights.map((highlight: any) => highlight.sourceId)))).size).toBe(501);
  });
  it('resumes at an empty final book and completes the existing run without replaying earlier books', async () => {
    const books = Array.from({ length: 45 }, (_, index) => ({ sourceId: `B${String(index + 1).padStart(9, '0')}`, title: `Synthetic book ${index + 1}`, author: 'Writer', highlights: [] }));
    const cursor = { ...completeCursor, phase: 'annotations', books, bookIndex: 44 };
    const app = harness({ token: 'import-only-secret', runId: 'resumable-run', status: 'error', cursor });
    app.chrome.tabs.sendMessage.mockImplementation(async (_id, request) => ({
      requestId: request.requestId, ok: true, data: { highlights: [], nextToken: null, contentLimitState: 'synthetic-limit-state', warnings: [] },
    }));
    const batches: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/extension/import')) batches.push(JSON.parse(init.body as string));
      return responseFor(url);
    }));
    await import('../extension/background');
    await popup(app, 'sync');
    await vi.waitFor(() => expect(app.read().status).toBe('success'));
    expect(app.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(app.chrome.tabs.sendMessage.mock.calls[0][1]).toMatchObject({ kind: 'annotations', asin: books[44].sourceId, token: '' });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ runId: 'resumable-run', accountFingerprint: fingerprint, books: [books[44]] });
    expect(batches[1]).toMatchObject({ runId: 'resumable-run', books: [], complete: true });
    expect(app.read()).toMatchObject({ progress: 100, busy: false });
    expect(app.read().cursor).toBeUndefined();
  });
  it('keeps the exact payload after an uncertain upload and replays its idempotency key on retry', async () => {
    const app = harness({ token: 'import-only-secret', runId: 'resumable-run', status: 'syncing', cursor: { ...completeCursor, phase: 'annotations' }, pending });
    const payloads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/extension/import')) {
        payloads.push(init.body as string);
        if (payloads.length === 1) throw new Error('Connection interrupted after acceptance');
      }
      return responseFor(url);
    }));
    await import('../extension/background');
    app.listeners.startup();
    await vi.waitFor(() => expect(app.read().status).toBe('error'));
    expect(app.read().pending).toEqual(pending);
    app.listeners.message({ channel: 'writefool:popup', requestId: 'valid-request-identifier', action: 'sync' }, { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' }, vi.fn());
    await vi.waitFor(() => expect(app.read().status).toBe('success'));
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe(payloads[0]);
  });
  it('rejects content-script and foreign-extension requests for credentials or syncing', async () => {
    const app = harness({ token: 'import-only-secret' });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await import('../extension/background');
    const reply = vi.fn();
    const message = { channel: 'writefool:popup', requestId: 'valid-request-identifier', action: 'state' };
    app.listeners.message(message, { id: 'test-extension', url: 'https://read.amazon.com/notebook', tab: { id: 5 } }, reply);
    app.listeners.message(message, { id: 'other-extension', url: 'chrome-extension://test-extension/popup.html' }, reply);
    expect(reply).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('identifies the running version and failed library page while preserving its continuation', async () => {
    const cursor = { ...completeCursor, phase: 'library', token: 'private-pagination-token', seenTokens: [''], books: [{ sourceId: 'PRIVATEASIN', title: 'Private book', author: 'Private author', highlights: [] }] };
    const app = harness({ token: 'import-only-secret', runId: 'resumable-run', status: 'error', cursor });
    app.chrome.tabs.sendMessage.mockImplementation(async (_id, request) => ({ requestId: request.requestId, ok: false, kind: 'error', error: 'The Kindle next library page was not recognized.' }));
    const messages: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/extension/status')) messages.push(JSON.parse(init.body as string).message);
      return responseFor(url);
    }));
    await import('../extension/background');
    app.listeners.startup();
    await vi.waitFor(() => expect(app.read().message).toContain('[Extension 0.2.2; library page 2, 1 books found]'));
    await vi.waitFor(() => expect(messages.at(-1)).toContain('next library page was not recognized'));
    expect(app.read().cursor).toEqual(cursor);
    expect(messages.join(' ')).not.toMatch(/Private|private|import-only-secret/);
  });
});

function popup(app: ReturnType<typeof harness>, action: string, extra: Record<string, unknown> = {}) {
  return new Promise<any>(resolve => app.listeners.message({channel:'writefool:popup',requestId:crypto.randomUUID(),action,...extra}, {id:'test-extension',url:'chrome-extension://test-extension/popup.html'},resolve));
}

describe('daily automatic sync limit', () => {
  const day = 86400000;
  const start = Date.parse('2026-10-21T12:00:00Z');

  function scheduledApp(saved: Record<string, unknown> = {}) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    const app = harness({ token: 'import-only-secret', ...saved });
    app.chrome.tabs.sendMessage.mockImplementation(async (_id, request) => ({ requestId: request.requestId, ok: true, data: { books: [], nextToken: null } }));
    const fetcher = vi.fn(async (url: string) => responseFor(url));
    vi.stubGlobal('fetch', fetcher);
    return { ...app, fetcher };
  }

  it('honors a pre-upgrade success and clears old retry alarms without reopening Amazon', async () => {
    const lastSuccessAt = new Date(start - 60 * 60000).toISOString();
    const app = scheduledApp({ lastSuccessAt, status: 'success' });
    await app.chrome.alarms.create('writefool-resume', { periodInMinutes: 1 });
    await app.chrome.alarms.create('writefool-account-check', { delayInMinutes: 1 });
    await app.chrome.alarms.create('writefool-daily', { when: start, periodInMinutes: 1440 });
    await import('../extension/background');
    await app.listeners.startup();
    await app.listeners.alarm({ name: 'writefool-daily' });
    expect(app.fetcher).not.toHaveBeenCalled();
    expect(app.chrome.tabs.create).not.toHaveBeenCalled();
    expect(await app.chrome.alarms.get('writefool-resume')).toBeUndefined();
    expect(await app.chrome.alarms.get('writefool-account-check')).toBeUndefined();
    expect(await app.chrome.alarms.get('writefool-daily')).toMatchObject({ scheduledTime: Date.parse(lastSuccessAt) + day });
    expect(app.read()).toMatchObject({ lastSuccessAt, status: 'success' });
  });

  it('ignores cookie changes and stale account/resume events even when a daily sync is due', async () => {
    const app = scheduledApp();
    await import('../extension/background');
    app.listeners.cookie({ cookie: { name: 'at-main', domain: '.amazon.com' } });
    await app.listeners.alarm({ name: 'writefool-account-check' });
    await app.listeners.alarm({ name: 'writefool-resume' });
    expect(app.chrome.storage.session.remove).toHaveBeenCalledWith('accountCandidate');
    expect(await app.chrome.alarms.get('writefool-account-check')).toBeUndefined();
    expect(app.fetcher).not.toHaveBeenCalled();
    expect(app.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('allows at most one automatic attempt per 24 hours across concurrent events and worker restarts', async () => {
    const app = scheduledApp();
    await import('../extension/background');
    await Promise.all([app.listeners.startup(), app.listeners.alarm({ name: 'writefool-daily' })]);
    expect(app.read()).toMatchObject({ status: 'success', lastAttemptAt: new Date(start).toISOString() });
    expect(app.chrome.tabs.create).toHaveBeenCalledOnce();

    vi.setSystemTime(start + day - 1);
    vi.resetModules();
    await import('../extension/background');
    await app.listeners.startup();
    await app.listeners.alarm({ name: 'writefool-daily' });
    expect(app.chrome.tabs.create).toHaveBeenCalledOnce();

    vi.setSystemTime(start + day);
    await app.listeners.alarm({ name: 'writefool-daily' });
    expect(app.chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(app.read().status).toBe('success');
  });

  it('persists failed attempts before opening Amazon and waits a day before resuming the same cursor', async () => {
    const app = scheduledApp();
    app.chrome.tabs.sendMessage.mockImplementationOnce(async () => {
      expect(app.read().lastAttemptAt).toBe(new Date(start).toISOString());
      throw new Error('Amazon is unavailable');
    });
    await import('../extension/background');
    await app.listeners.startup();
    expect(app.read().status).toBe('login_required');
    const runId = app.read().runId;
    const cursor = structuredClone(app.read().cursor);
    const calls = app.fetcher.mock.calls.length;
    vi.setSystemTime(start + 60000);
    vi.resetModules();
    await import('../extension/background');
    await app.listeners.startup();
    await app.listeners.alarm({ name: 'writefool-daily' });
    expect(app.fetcher).toHaveBeenCalledTimes(calls);
    expect(app.chrome.tabs.create).toHaveBeenCalledOnce();
    expect(app.read()).toMatchObject({ runId, cursor });
    vi.setSystemTime(start + day);
    await app.listeners.alarm({ name: 'writefool-daily' });
    expect(app.chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(app.read().status).toBe('success');
  });

  it('keeps an interrupted upload intact until the daily limit expires', async () => {
    const app = scheduledApp({ lastAttemptAt: new Date(start).toISOString(), runId: 'resumable-run', status: 'syncing', cursor: { ...completeCursor, phase: 'annotations' }, pending });
    await import('../extension/background');
    await app.listeners.startup();
    await app.listeners.alarm({ name: 'writefool-resume' });
    expect(app.fetcher).not.toHaveBeenCalled();
    expect(app.read().pending).toEqual(pending);
    vi.setSystemTime(start + day);
    await app.listeners.alarm({ name: 'writefool-daily' });
    expect(app.read().status).toBe('success');
    expect(app.read().pending).toBeUndefined();
    expect(app.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('allows manual sync during the cooldown and schedules the next automatic attempt from it', async () => {
    const app = scheduledApp({ lastAttemptAt: new Date(start - 3600000).toISOString(), status: 'success' });
    await import('../extension/background');
    await popup(app, 'sync');
    await vi.waitFor(() => {
      expect(app.read()).toMatchObject({ busy: false, status: 'success' });
      expect(Date.parse(app.read().lastAttemptAt)).toBeGreaterThanOrEqual(start);
    });
    expect(app.chrome.tabs.create).toHaveBeenCalledOnce();
    expect(await app.chrome.alarms.get('writefool-daily')).toMatchObject({ scheduledTime: Date.parse(app.read().lastAttemptAt) + day });
    vi.setSystemTime(start + day - 3600000);
    await app.listeners.startup();
    await app.listeners.alarm({ name: 'writefool-daily' });
    expect(app.chrome.tabs.create).toHaveBeenCalledOnce();
  });
});

describe('account-switch regression protection', () => {
  it('blocks queued uploads on another account and resumes the exact batch after switching back', async () => {
    const app = harness({token:'secret',runId:'resumable-run',cursor:{...completeCursor,phase:'annotations'},pending});
    let wrong = true;
    const uploads: any[] = [];
    vi.stubGlobal('fetch',vi.fn(async (url:string, init:RequestInit) => {
      if (url === 'https://www.amazon.com/' && wrong) return new Response(amazonHtml.replace('ATESTACCOUNT001','AOTHERACCOUNT02'));
      if (url.endsWith('/import')) uploads.push(JSON.parse(init.body as string));
      return responseFor(url);
    }));
    await import('../extension/background'); app.listeners.startup();
    await vi.waitFor(() => expect(app.read().status).toBe('account_mismatch'));
    expect(uploads).toEqual([]); expect(app.read().pending).toEqual(pending);
    await vi.waitFor(() => expect(app.read().busy).toBe(false));
    wrong = false; app.listeners.cookie({cookie:{name:'at-main',domain:'.amazon.com'}});
    await popup(app,'sync');
    await vi.waitFor(() => expect(app.read().status).toBe('success'));
    expect(uploads).toEqual([pending.batch]);
  });
  it.each(['library','annotations'])('rejects a session switch during a %s response, including A to B to A', async phase => {
    const book = {sourceId:'B000000001',title:'Book',author:'Writer',highlights:[]};
    const app = harness({token:'secret'});
    const uploads: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url:string,init:RequestInit) => { if(url.endsWith('/import')) uploads.push(init.body); return responseFor(url); }));
    app.chrome.tabs.sendMessage.mockImplementation(async (_id,request) => {
      if(request.kind === phase) {
        app.listeners.cookie({cookie:{name:'at-main',domain:'.amazon.com'}});
        app.listeners.cookie({cookie:{name:'at-main',domain:'.amazon.com'}});
      }
      return {requestId:request.requestId,ok:true,data:request.kind === 'library' ? {books:[book],nextToken:null} : {highlights:[{sourceId:'wrong',text:'Wrong passage'}],nextToken:null,warnings:[]}};
    });
    await import('../extension/background'); app.listeners.startup();
    await vi.waitFor(() => expect(app.read().status).toBe('account_unverified'));
    expect(uploads).toEqual([]); expect(app.read().pending).toBeUndefined();
  });
  it('discards pre-upgrade batches instead of giving them the current account fingerprint', async () => {
    const app = harness({schemaVersion:undefined,token:'secret',runId:'old',pending,cursor:completeCursor});
    vi.stubGlobal('fetch',vi.fn(async (url:string) => url.endsWith('/account') ? new Response(JSON.stringify({salt:'test-salt',fingerprint:null})) : responseFor(url)));
    await import('../extension/background'); app.listeners.startup();
    await vi.waitFor(() => expect(app.read().status).toBe('account_required'));
    expect(app.read().pending).toBeUndefined(); expect(app.read().runId).toBeUndefined();
    expect(app.chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('requires a current preview, invalidates it on cookie changes, and releases the busy lock before confirming', async () => {
    const app = harness({token:'secret'});
    let locked: string | null = null;
    const uploads: unknown[] = [];
    vi.stubGlobal('fetch',vi.fn(async (url:string,init:RequestInit) => {
      if(url.endsWith('/account')) return new Response(JSON.stringify({salt:'test-salt',fingerprint:locked}));
      if(url.endsWith('/account/confirm')) { locked = JSON.parse(init.body as string).fingerprint; return new Response(JSON.stringify({salt:'test-salt',fingerprint:locked})); }
      if(url.endsWith('/import')) uploads.push(init.body);
      return responseFor(url);
    }));
    app.chrome.tabs.sendMessage.mockImplementation(async (_id,request) => ({requestId:request.requestId,ok:true,data:{books:[],nextToken:null}}));
    await import('../extension/background');
    expect((await popup(app,'confirm-account',{nonce:'invented'})).ok).toBe(false);
    const preview = await popup(app,'prepare-account'); expect(preview.ok).toBe(true);
    expect((await popup(app,'state')).data.busy).toBe(false);
    expect(uploads).toEqual([]);
    app.listeners.cookie({cookie:{name:'at-main',domain:'.amazon.com'}});
    expect((await popup(app,'confirm-account',{nonce:preview.data.nonce})).ok).toBe(false);
    expect(locked).toBeNull();
    const next = await popup(app,'prepare-account');
    // Chrome may suspend the service worker while the user considers the preview.
    vi.resetModules(); await import('../extension/background');
    expect((await popup(app,'confirm-account',{nonce:next.data.nonce})).ok).toBe(true);
    await popup(app,'sync');
    await vi.waitFor(() => expect(app.read().status).toBe('success'));
    expect(locked).toBe(fingerprint); expect(uploads).toHaveLength(1);
    expect(JSON.stringify(app.read())).not.toContain('test-cookie');
  });
});
