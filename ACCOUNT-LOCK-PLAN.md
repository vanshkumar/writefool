# Kindle account lock

## Outcome

One explicitly confirmed Amazon account per Writefool library. Switching Amazon accounts pauses imports; returning to the confirmed account allows them again. Missing or ambiguous identity blocks imports. Re-pairing cannot replace the library's account lock.

## Implementation

- Add an immutable, salted Amazon account fingerprint in D1, keyed by Writefool user. Add extension account-status and first-confirmation endpoints. Require the matching fingerprint for every Kindle batch, including completion and replay; reject old clients. Clippings remain unchanged.
- Read the live-observed Amazon `config.lightningDeals` customerID field from a fresh www.amazon.com response. Hash locally with the library salt; never upload the identifier, HTML, or Amazon credentials. Reject missing, conflicting, or malformed metadata.
- Add narrowly scoped www.amazon.com and amazon.com host access and the cookies permission (Chrome requires the parent host to read shared domain cookies). Compare the authentication cookies applicable to Amazon and Kindle, and monitor cookie changes. Validate account identity within that session, then bracket every notebook read with session checks. Reject session changes, including switch-away-and-back, before saving or uploading page data. Never modify Amazon cookies.
- Offer a preview of the current notebook's first three book titles and a separate explicit account-confirmation button. Revalidate the preview's session when confirming. Existing installations cannot auto-bind. Keep the confirmed account when reconnecting, and discard pre-upgrade cursors/batches without account provenance.
- Close stale owned tabs on resume. Preserve proven, exact pending payloads for idempotent retry. On account mismatch, stop continuation and show a clear pause reason. Recheck after sign-in cookie changes, at startup, daily, or on manual sync.

## Tests and rollout

Test initial confirmation, account mismatch, unreadable identity, missing or mismatched cookies, switching during a request and back again, restart/replay, untagged legacy queues, conflicting confirmations, other profiles, and same-text/different-note contamination. Run typecheck, extension/parser tests, D1 tests, and production builds. Deploy D1/server enforcement before loading extension 0.2.0. Verify the actual browser flow before claiming live account-switch protection.

## Existing contamination

The September 19 production cleanup removes only the nine highlights and three books matching the earlier incident backup. Preserve the 796 original highlights, six subsequent legitimate highlights, current daily four-highlight email schedule, all import receipts, and delivered email snapshots. Revoke the old unprotected connection. Save the scoped recovery backup and SQL under ignored `.wrangler/`, validate locally, then compare all 802 retained highlights after repair. Two unwanted passages already delivered cannot be recalled.

## Execution status

September 19: cleanup verified, 132 tests passed, typecheck and production builds passed, migration 0003 applied, Worker version 493afdfb-b087-48fa-86f1-fc08d27aa449 deployed. Connector 0.2.0 is built for production. Chrome permissions are approved, the connector is loaded and re-paired, and live account preview succeeds. The user explicitly confirmed the account preview (Anna Karenina, Blindsight, Chapterhouse: Dune). Protected sync ba4764f5-5a10-4abe-8eec-115f9b22a748 completed September 19 at 20:58 UTC: 3 new highlights, 0 updated, 802 unchanged. The library now has 34 books and 805 highlights. The live wrong-account test passed: sync reported account_mismatch, with 34 books, 805 highlights, and 168 batch receipts unchanged.

September 19 live return test: after switching back to the confirmed Amazon account, the protected sync succeeded with all 805 highlights unchanged. Both switch directions are verified; the new lock survives extension reload.
