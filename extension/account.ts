import type { SyncState } from '../shared/contracts';

export const AMAZON_ACCOUNT_URL = 'https://www.amazon.com/';
export const NOTEBOOK_URL = 'https://read.amazon.com/notebook';
const AUTH_COOKIES = new Set(['at-main', 'sess-at-main', 'x-main', 'session-id']);
export class AccountError extends Error {
  constructor(message: string, public kind: SyncState = 'account_unverified') { super(message); }
}
const unverifiable = () => new AccountError('Sync paused: Amazon account identity could not be verified. Open Amazon and Kindle, sign in, then try again.');
const changed = () => new AccountError('Sync paused: the Amazon sign-in session changed during this import. Try again after signing in to your connected Kindle account.');
export async function sha256(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** This exact inline navigation configuration was observed in signed-in Amazon HTML.
 * Do not infer identity from a name, library overlap, cookies, or arbitrary page text.
 */
export function parseAmazonAccount(html: string): string {
  if (/\bid=["'](?:ap_email|ap_password|captchacharacters)["']|\bname=["']signIn["']/i.test(html)) {
    throw new AccountError('Sign in to Amazon and your Kindle notebook, then try again.', 'login_required');
  }
  const ids = new Set<string>();
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    for (const match of script[1].matchAll(/\$Nav\.declare\(\s*(['"])config\.lightningDeals\1\s*,\s*(\{[\s\S]*?\})\s*\)/g)) {
      let value: unknown;
      try { value = JSON.parse(match[2]); } catch { throw unverifiable(); }
      const id = (value as { customerID?: unknown } | null)?.customerID;
      if (typeof id !== 'string' || !/^A[A-Z0-9]{7,31}$/.test(id)) throw unverifiable();
      ids.add(id);
    }
  }
  if (ids.size !== 1) throw unverifiable();
  return [...ids][0];
}

export interface SessionStamp { hash: string; epoch: number }
export interface VerifiedAccount extends SessionStamp { fingerprint: string }
type CookieReader = Pick<typeof chrome.cookies, 'getAll'>;

/** Cookie values and their transient hashes never leave the background worker or
 * enter persistent storage. They prove continuity, not Amazon account identity.
 */
export class AmazonAccountGuard {
  private epoch = 0;
  private cookieValues = new Map<string, string>();
  private cookieKey(cookie: chrome.cookies.Cookie): string {
    return JSON.stringify([cookie.name,cookie.domain,cookie.path,cookie.storeId,cookie.partitionKey ?? null]);
  }
  private cached?: VerifiedAccount & { salt: string };
  constructor(private cookies: CookieReader, private fetchPage: typeof fetch = fetch) {}

  cookieChanged(cookie: Pick<chrome.cookies.Cookie, 'domain' | 'name'>, change?: { removed: boolean; cause: string }): boolean {
    if (!AUTH_COOKIES.has(cookie.name) || !/(^|\.)amazon\.com$/.test(cookie.domain)) return false;
    if (change && 'value' in cookie) {
      const full = cookie as chrome.cookies.Cookie;
      const key = this.cookieKey(full);
      // Chrome emits remove(overwrite) + add even when Amazon only renews expiry.
      // Keep the old value until add so a real A→B→A still advances the epoch twice.
      if (change.removed && change.cause === 'overwrite') return false;
      if (!change.removed && this.cookieValues.get(key) === full.value) return false;
      if (change.removed) this.cookieValues.delete(key);
      else this.cookieValues.set(key, full.value);
    }
    this.epoch++;
    this.cached = undefined;
    return true;
  }

  private async snapshot(): Promise<SessionStamp> {
    const epoch = this.epoch;
    let both: chrome.cookies.Cookie[][];
    try { both = await Promise.all([this.cookies.getAll({ url: AMAZON_ACCOUNT_URL }), this.cookies.getAll({ url: NOTEBOOK_URL })]); }
    catch { throw unverifiable(); }
    const signatures = both.map(cookies => {
      const auth = cookies.filter(c => AUTH_COOKIES.has(c.name));
      if (!auth.some(c => c.name === 'at-main' && c.value) || !auth.some(c => c.name === 'session-id' && c.value)) throw unverifiable();
      // Reject host/path-specific overrides: the identity page and notebook must
      // be authenticated by exactly the same shared Amazon sign-in cookies.
      if (auth.some(c => c.hostOnly || c.domain.replace(/^\./, '') !== 'amazon.com' || c.path !== '/' || c.partitionKey)
        || new Set(auth.map(c => c.name)).size !== auth.length) throw unverifiable();
      return JSON.stringify(auth.map(c => [c.name,c.value,c.domain,c.path,c.storeId]).sort((a,b) => a[0].localeCompare(b[0])));
    });
    const hashes = await Promise.all(signatures.map(sha256));
    if (epoch !== this.epoch) throw changed();
    if (hashes[0] !== hashes[1]) throw unverifiable();
    this.cookieValues = new Map(both[0].filter(c => AUTH_COOKIES.has(c.name)).map(c => [this.cookieKey(c), c.value]));
    return { hash: hashes[0], epoch };
  }

  async unchanged(stamp: SessionStamp): Promise<void> {
    const now = await this.snapshot();
    if (now.hash !== stamp.hash || now.epoch !== stamp.epoch) throw changed();
  }

  async verify(salt: string, expected?: string | null): Promise<VerifiedAccount> {
    const before = await this.snapshot();
    let account = this.cached;
    if (!account || account.hash !== before.hash || account.epoch !== before.epoch || account.salt !== salt) {
      let html: string;
      try {
        // Native worker fetch requires its global receiver, not this guard instance.
        const response = await this.fetchPage.call(globalThis, AMAZON_ACCOUNT_URL, { credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(18000) });
        if (!response.ok || (response.url && new URL(response.url).origin !== 'https://www.amazon.com')) throw unverifiable();
        // Bound the HTML buffer; do not retain or persist the account page.
        const reader = response.body?.getReader();
        if (!reader) throw unverifiable();
        const decoder = new TextDecoder(); let bytes = 0; html = '';
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            bytes += value.byteLength;
            if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw unverifiable(); }
            html += decoder.decode(value, { stream: true });
          }
          html += decoder.decode();
        } finally { reader.releaseLock(); }
      } catch { throw unverifiable(); }
      const id = parseAmazonAccount(html);
      const fingerprint = await sha256(JSON.stringify(['writefool-amazon-account-v1', salt, id]));
      await this.unchanged(before);
      account = { ...before, fingerprint, salt };
      this.cached = account;
    }
    if (expected && account.fingerprint !== expected) {
      throw new AccountError('Sync paused: a different Amazon account is signed in. Switch back to your connected Kindle account.', 'account_mismatch');
    }
    return account;
  }
}
