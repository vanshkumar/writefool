# Writefool Kindle connector

This unpacked Chrome Manifest V3 extension imports the US Kindle notebook. Amazon sign-in stays on Amazon; the extension reads Amazon authentication cookies only to verify that the account stays unchanged while reading highlights. It never sends cookies or passwords to Writefool. Its hosts are `read.amazon.com`, `www.amazon.com`, `amazon.com` (shared sign-in cookies), and the app origin chosen at build time. Amazon customer IDs are hashed locally with a library-specific salt; only the fingerprint reaches Writefool.

## Build and connect

From the repository root, install project dependencies and run:

```sh
npm run build:extension
```

The default app is `http://localhost:5183`. For a deployed app, build with its HTTPS origin:

```sh
WRITEFOOL_APP_URL=https://writefool.vanshkumar95.workers.dev npm run build:extension
```

1. Open Chrome → `chrome://extensions` → turn on Developer mode → Load unpacked → select this repository's `extension/dist` directory.
2. Sign in at [Kindle Notebook](https://read.amazon.com/notebook) directly in Chrome.
3. In Writefool, open **Connect Kindle** and generate a pairing code.
4. Open this extension's popup and paste the code. The app address is fixed at build time so the permission cannot silently widen to a different service.
5. Choose **Check Kindle account**, inspect the notebook preview, and explicitly confirm the account to lock this Writefool library. Confirmation starts the first protected sync. Existing libraries require this step too.
6. Later imports pause if another Amazon account is active or identity cannot be verified. Switch back and choose **Sync highlights**; a delayed cookie-change check also retries automatically. Re-pairing or using another Chrome profile does not reset the library lock.

Rebuild and click Reload in Chrome's extensions page after source changes. Version 0.2.0 adds cookies and www.amazon.com permissions, which Chrome must approve before it can run. The upgrade discards old unverified pending uploads and restarts discovery. For production, build with the production origin above and reconnect with a fresh pairing code if the previous connection was revoked. The September 19 cleanup preserved 34 books and 802 legitimate highlights; it did not alter the current email schedule.

The popup footer displays the installed version (currently `0.2.0`). Errors include that version, the failed import stage, and structural counts so a fresh retry can be distinguished from an old saved message. These diagnostics do not contain book titles, passages, identifiers, or pagination tokens. If Chrome still displays an earlier version after reloading, check that its unpacked directory is this repository's `extension/dist`.

## How sync works

- One daily alarm and a startup check import highlights while Chrome is available. A one-minute continuation alarm exists only during an active import; missing alarms are restored each time the service worker starts. Chrome may delay alarms during sleep, so email scheduling runs on the server independently.
- Imports use one inactive extension-owned notebook tab. Its content script waits up to 25 seconds for Amazon to populate the initial library in the rendered page; subsequent library pages and annotations use same-origin browser requests. Library and annotation pagination tokens remain in local extension storage along with the book cursor.
- Before each upload, the exact batch ID, payload, and next cursor are persisted. Large annotation pages split into chunks of at most 100 highlights; the page cursor advances only after every chunk succeeds. Interrupted or uncertain requests replay the current batch before advancing; the server deduplicates it. Imports never request deletion of missing books or highlights.
- Library and annotation pagination detect repeated tokens and stop on unrecognized layouts instead of claiming a partial import succeeded. Authentication challenges require the user to open Kindle and complete sign-in directly.
- A subsequent library response can contain only its pagination marker, without books or a library container. These empty pages retain any nonempty continuation token and end the list when the token is empty. Initial loading shells and responses with missing markers or unrecognized content still fail.
- Pairing exchanges a short-lived code for an import-only token. Local storage is restricted to trusted extension contexts; content scripts cannot read the token. Requests omit app cookies. The extension accepts popup messages only from its own popup; request IDs correlate notebook responses. There is no external messaging or page-to-extension bridge.
- Source ASINs and annotation IDs are preserved where present. If Amazon omits an annotation ID, the fallback derives from book, location, and original text, never the note. Changing the passage itself without a source ID can create a new saved highlight.

## Validation and limitations

Account protection is tested for session changes during reads, wrong-account pending uploads, legacy queues, explicit confirmation, and immutable server binding. Identity metadata was observed on the live signed-in Amazon page. The user approved permissions and confirmed the live account on September 19. The first protected sync succeeded with 3 new highlights, zero updates, and 802 unchanged (34 books, 805 highlights). A live switch to a second account correctly paused imports with account_mismatch, leaving all counts and batch receipts unchanged. If Amazon changes its identity metadata or cookie scope, imports pause; there is no bypass that silently accepts an unknown account. Incognito imports are disabled.

`node node_modules/vitest/vitest.mjs run tests/account.test.ts tests/clippings.test.ts tests/kindle.test.ts tests/kindle-loading.test.ts tests/extension.test.ts` checks synthetic notebook fixtures, delayed library rendering, clippings parsing, pagination URLs, and continuation behavior. Fixtures use invented IDs and public-domain or synthetic passages; **they were not captured from your Amazon account**.

On September 8, 2026, connector 0.1.3 completed the first real-account sync to localhost:5183: **34 books and 796 highlights**, with explicit source annotation IDs for every highlight. The validated flow reads the rendered initial page, follows library pagination including a cursor-only final page, and persists annotation batches. Two batches triggered the export-limit detector; this does not establish how many, if any, passages are unavailable.

Connector 0.1.4 corrects note extraction to prefer the actual '#note' field over its labeled wrapper and avoids detecting export-limit wording inside passages, notes, or hidden templates. The first import's saved note labels were cleaned locally, retaining one actual attached note. Automated checks pass; reload the extension before the next sync so the corrected fields stay clean. After rebuilding, click **Reload** on Writefool in Chrome's extensions page, then **Sync highlights** in the popup. The existing pairing is retained when reloading.

The second real sync with connector 0.1.4 completed with zero new records, zero updates, and all 796 highlights unchanged. The library remains at 34 books, with one attached note, and no export-limit warnings were generated. Repeat-import deduplication and corrected note extraction are verified for this notebook.

Before relying on daily imports, complete the remaining real-account checks: compare book totals with Kindle, inspect the first and last highlight of a paginated book, add a highlight and change a note on Kindle, then resync. Close Chrome during an import and reopen it to verify continuation. Log out of Amazon to check the sign-in prompt. Scheduled email should still arrive when Chrome is closed, using already imported highlights.

Amazon's notebook has no supported public import API. DOM selectors and internal pagination may change; the real-account checks above remain a launch gate. The current parser targets English `read.amazon.com/notebook`, not other regions or Scribe notebooks. Personal documents and publisher-limited passages may be absent from the notebook. Use the app's `My Clippings.txt` preview/import fallback for English device exports. Separate clipping notes attach only to an unambiguous highlight location; standalone or ambiguous notes produce warnings. Export dates remain verbatim because Kindle files do not carry timezone information.

Chrome reference documentation: [alarms and restart behavior](https://developer.chrome.com/docs/extensions/reference/api/alarms), [message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [content script isolation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).

September 19 live return test: after switching back to the confirmed Amazon account, the protected sync succeeded with all 805 highlights unchanged. Both switch directions are verified; the new lock survives extension reload.
