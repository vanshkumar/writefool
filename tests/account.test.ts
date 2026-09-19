import { describe, expect, it, vi } from 'vitest';
import { AmazonAccountGuard, parseAmazonAccount, sha256 } from '../extension/account';

const html = (id = 'ATESTACCOUNT001') => `<script>window.$Nav && $Nav.declare('config.lightningDeals', ${JSON.stringify({activeItems:[],marketplaceID:'TESTMARKET',customerID:id})});</script>`;
const cookie = (name: string, value = 'private-auth-value'): chrome.cookies.Cookie => ({name,value,domain:'.amazon.com',path:'/',storeId:'0',hostOnly:false,httpOnly:true,secure:true,session:false,sameSite:'no_restriction'});
function harness() {
  const rows = [cookie('at-main'), cookie('session-id')];
  const cookies = {getAll:vi.fn(async (_details: {url?: string}) => rows)};
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(html()));
  const guard = new AmazonAccountGuard(cookies,fetcher);
  return {rows,cookies,fetcher,guard};
}

describe('Amazon identity and sign-in continuity', () => {
  it('extracts only the observed navigation config and accepts consistent duplicates', () => {
    expect(parseAmazonAccount(html()+html())).toBe('ATESTACCOUNT001');
    expect(()=>parseAmazonAccount('<p>"customerID":"ATESTACCOUNT001"</p>')).toThrow('could not be verified');
  });
  it.each(['', html(''), html('not-an-account'), html()+html('AOTHERACCOUNT01'), html().replace('"customerID":','"renamed":')])('fails closed for missing, malformed, or ambiguous identity: %s', value => {
    expect(()=>parseAmazonAccount(value)).toThrow('could not be verified');
  });
  it.each(['<input id="ap_password">','<input id="captchacharacters">','<form name="signIn">'])('rejects authentication pages even if stale identity is also present', challenge => {
    expect(()=>parseAmazonAccount(html()+challenge)).toThrow('Sign in');
  });
  it('salts fingerprints per Writefool library and requests only Amazon with browser credentials', async () => {
    const {guard,fetcher}=harness();
    const a=await guard.verify('salt-a'); const b=await guard.verify('salt-b');
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).toBe(await sha256(JSON.stringify(['writefool-amazon-account-v1','salt-a','ATESTACCOUNT001'])));
    expect(fetcher).toHaveBeenCalledWith('https://www.amazon.com/',expect.objectContaining({credentials:'include',cache:'no-store',redirect:'error'}));
    expect(JSON.stringify(a)).not.toContain('private-auth-value');
    expect(JSON.stringify(a)).not.toContain('ATESTACCOUNT001');
  });
  it('uses the global receiver required by native service-worker fetch', async () => {
    const {cookies}=harness();
    const nativeLike = async function(this: unknown) { if(this !== globalThis) throw new TypeError('Illegal invocation'); return new Response(html()); };
    const guard = new AmazonAccountGuard(cookies,nativeLike);
    expect((await guard.verify('salt')).fingerprint).toHaveLength(64);
  });
  it('ignores expiry-only overwrites but detects real overwrite switches and switching back', async () => {
    const {guard}=harness(); const stamp=await guard.verify('salt');
    const remove={removed:true,cause:'overwrite'}; const add={removed:false,cause:'explicit'};
    expect(guard.cookieChanged(cookie('session-id'),remove)).toBe(false);
    expect(guard.cookieChanged(cookie('session-id'),add)).toBe(false);
    await guard.unchanged(stamp);
    expect(guard.cookieChanged(cookie('at-main'),remove)).toBe(false);
    expect(guard.cookieChanged(cookie('at-main','B'),add)).toBe(true);
    expect(guard.cookieChanged(cookie('at-main','B'),remove)).toBe(false);
    expect(guard.cookieChanged(cookie('at-main'),add)).toBe(true);
    await expect(guard.unchanged(stamp)).rejects.toThrow('session changed');
  });
  it('rejects another account instead of trusting its readable notebook', async () => {
    const {guard}=harness();
    await expect(guard.verify('salt','f'.repeat(64))).rejects.toMatchObject({kind:'account_mismatch'});
  });
  it('refetches identity when a login change is reported and can return to the original account', async () => {
    const {guard,fetcher}=harness();
    const a=await guard.verify('salt');
    fetcher.mockResolvedValueOnce(new Response(html('AOTHERACCOUNT01')));
    guard.cookieChanged(cookie('at-main','changed'));
    await expect(guard.verify('salt',a.fingerprint)).rejects.toMatchObject({kind:'account_mismatch'});
    guard.cookieChanged(cookie('at-main'));
    expect((await guard.verify('salt',a.fingerprint)).fingerprint).toBe(a.fingerprint);
  });
  it('detects an A→B→A switch even when final cookie values are identical', async () => {
    const {guard}=harness(); const before=await guard.verify('salt');
    guard.cookieChanged(cookie('at-main','B'));guard.cookieChanged(cookie('at-main','private-auth-value'));
    await expect(guard.unchanged(before)).rejects.toThrow('session changed');
  });
  it('rejects changes that happen during the identity request', async () => {
    const {guard,fetcher}=harness();
    fetcher.mockImplementation(async()=>{guard.cookieChanged(cookie('at-main','other'));return new Response(html());});
    await expect(guard.verify('salt')).rejects.toThrow('session changed');
  });
  it('ignores preference cookies and unrelated hosts', async () => {
    const {guard}=harness(); const before=await guard.verify('salt');
    expect(guard.cookieChanged(cookie('i18n-prefs'))).toBe(false);
    expect(guard.cookieChanged({...cookie('at-main'),domain:'.notamazon.com'})).toBe(false);
    await guard.unchanged(before);
  });
  it('rejects divergent Amazon and Kindle authentication cookies', async () => {
    const {guard,cookies}=harness();
    cookies.getAll.mockImplementation(async details=>[cookie('at-main',details.url?.includes('read.amazon')?'other':'first'),cookie('session-id')]);
    await expect(guard.verify('salt')).rejects.toThrow('could not be verified');
  });
  it.each(['absent','host-only','partitioned','path-specific','duplicate'])('rejects unsupported cookie state: %s', state => {
    const {guard,rows}=harness();
    if(state==='absent')rows.splice(0,1);
    if(state==='host-only')rows[0].hostOnly=true;
    if(state==='partitioned')rows[0].partitionKey={topLevelSite:'https://amazon.com'};
    if(state==='path-specific')rows[0].path='/notebook';
    if(state==='duplicate')rows.push(cookie('at-main','second'));
    return expect(guard.verify('salt')).rejects.toThrow('could not be verified');
  });
  it('blocks when cookie permission is missing', async () => {
    const {guard,cookies}=harness();cookies.getAll.mockRejectedValue(new Error('private browser detail'));
    await expect(guard.verify('salt')).rejects.toThrow('could not be verified');
  });
  it('does not expose network errors or trust failed identity responses', async () => {
    const {guard,fetcher}=harness();fetcher.mockRejectedValue(new Error('private network detail'));
    await expect(guard.verify('salt')).rejects.not.toThrow('private');
    fetcher.mockResolvedValue(new Response(html(),{status:503}));
    await expect(guard.verify('salt')).rejects.toThrow('could not be verified');
  });
});
