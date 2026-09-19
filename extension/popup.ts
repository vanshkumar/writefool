export {};

const form = document.querySelector<HTMLFormElement>('#pair-form')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const syncButton = document.querySelector<HTMLButtonElement>('#sync-button')!;
const pairButton = document.querySelector<HTMLButtonElement>('#pair-button')!;
const reconnectButton = document.querySelector<HTMLButtonElement>('#reconnect-button')!;
const appUrl = document.querySelector<HTMLInputElement>('#app-url')!;
let reconnecting = false;
let accountNonce: string | undefined;
let checkingAccount = false;
const checkAccountButton = document.querySelector<HTMLButtonElement>('#check-account')!;
const confirmAccountButton = document.querySelector<HTMLButtonElement>('#confirm-account')!;
appUrl.value = WRITEFOOL_APP_URL;
document.querySelector<HTMLAnchorElement>('#app-link')!.href = WRITEFOOL_APP_URL;
document.querySelector<HTMLParagraphElement>('#extension-version')!.textContent = `Extension ${chrome.runtime.getManifest().version}`;

async function request(action: string, data: Record<string, string> = {}) {
  const requestId = crypto.randomUUID();
  const response = await chrome.runtime.sendMessage({ channel: 'writefool:popup', requestId, action, ...data });
  if (!response || response.requestId !== requestId || !response.ok) throw new Error(response?.error || 'Writefool could not connect. Try reopening the extension.');
  return response.data;
}

function showError(error: unknown) { status.textContent = error instanceof Error ? error.message : 'Something went wrong. Try again.'; status.dataset.error = 'true'; }
async function refresh() {
  try {
    const data = await request('state');
    form.hidden = data.connected && !reconnecting;
    document.querySelector<HTMLDivElement>('#paired')!.hidden = !data.connected || reconnecting;
    document.querySelector<HTMLDivElement>('#account-setup')!.hidden = !data.connected || data.accountConfirmed || reconnecting;
    syncButton.hidden = !data.accountConfirmed;
    syncButton.disabled = data.busy || checkingAccount;
    reconnectButton.disabled = data.busy || checkingAccount;
    checkAccountButton.disabled = data.busy || checkingAccount;
    confirmAccountButton.disabled = data.busy || checkingAccount;
    status.dataset.error = String(['error','login_required','account_mismatch','account_unverified'].includes(data.status));
    status.textContent = data.message || 'Generate a pairing code in Writefool → Connect Kindle.';
  } catch (error) { showError(error); }
}
form.addEventListener('submit', async (event) => {
  event.preventDefault(); pairButton.disabled = true;
  try { await request('pair', { code: document.querySelector<HTMLInputElement>('#pair-code')!.value.trim(), appUrl: appUrl.value }); reconnecting = false; await refresh(); }
  catch (error) { showError(error); }
  finally { pairButton.disabled = false; }
});
checkAccountButton.addEventListener('click', async () => {
  checkingAccount = true; accountNonce = undefined;
  document.querySelector<HTMLDivElement>('#account-preview')!.hidden = true;
  await refresh();
  status.textContent = 'Checking your Amazon account and Kindle books…';
  try {
    const preview = await request('prepare-account');
    if (!preview.alreadyConfirmed) {
      accountNonce = preview.nonce;
      const books = document.querySelector<HTMLUListElement>('#account-books')!;
      books.replaceChildren();
      for (const title of preview.titles.length ? preview.titles : ['No annotated books in this notebook.']) {
        const item = document.createElement('li'); item.textContent = title; books.appendChild(item);
      }
      document.querySelector<HTMLDivElement>('#account-preview')!.hidden = false;
    }
  } catch (error) { showError(error); }
  finally { checkingAccount = false; await refresh(); }
});
confirmAccountButton.addEventListener('click', async () => {
  if (!accountNonce) return;
  checkingAccount = true; await refresh();
  try {
    await request('confirm-account', { nonce: accountNonce });
    accountNonce = undefined;
    await request('sync');
  } catch (error) { showError(error); }
  finally { checkingAccount = false; await refresh(); }
});
reconnectButton.addEventListener('click', () => { reconnecting = true; void refresh(); });
syncButton.addEventListener('click', async () => {
  syncButton.disabled = true;
  try { await request('sync'); await refresh(); } catch (error) { showError(error); syncButton.disabled = false; }
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.writefool) void refresh(); });
void refresh();
