# Project learnings

## What Has Worked

**[2026-09-19] — Protected production sync and live account-switch check**
- Observation: The owner explicitly confirmed the notebook preview (Anna Karenina, Blindsight, Chapterhouse: Dune). Connector 0.2.0 completed protected run ba4764f5-5a10-4abe-8eec-115f9b22a748 with 3 newly imported, 0 updated, and 802 unchanged highlights across 36 batches. After the owner switched to the other Amazon account, a manual sync reported account_mismatch; production remained at 34 books, 805 highlights, and 168 total batch receipts.
- Action: Treat live wrong-account blocking and initial protected import as verified. Keep the immutable library lock through re-pairing/reload and preserve the current email preferences. After the user switched back, the protected sync completed successfully with all 805 highlights unchanged; the popup re-enabled its controls. Both live switch directions are verified.
- Confidence: high


**[2026-09-19] — Chrome live account-guard corrections**
- Observation: Chrome exposes shared .amazon.com authentication cookies only with parent amazon.com host access; www.amazon.com and read.amazon.com permissions alone returned none. Opening the notebook emits remove(overwrite) plus add for an unchanged session-id value. Native worker fetch also rejects the guard instance as its receiver, unlike test mocks.
- Action: Retain the exact parent-host permission, call native fetch with globalThis, and track cookie values only in worker memory. Ignore expiry-only overwrites while advancing the session epoch for actual value changes, including A→B→A. Keep the native-receiver and overwrite-pair regression tests. Publish settled sync state after releasing the busy flag so popup controls re-enable. Keep the short-lived confirmation candidate in session storage, with only its salted fingerprint, and reverify identity at confirmation; service-worker suspension can otherwise erase the preview before the user responds.
- Confidence: high


**[2026-09-19] — Repeated wrong-account recovery and account guard**
- Observation: The same nine unwanted highlights were reimported after the prior cleanup, while six legitimate highlights were added later. A scoped backup and guarded repair restored 34 books and 802 highlights, comparing every retained highlight against the baseline plus six additions. Two unwanted passages had already been delivered; historical digest snapshots and all import receipts were retained. The unprotected connection was revoked. Current preferences are enabled, four highlights daily at 08:00 America/Los_Angeles.
- Action: Keep the current preferences and historical records. Use .wrangler/wrong-account-recovery-20260919.json for incident recovery only. Require the new account-bound connector before reconnecting; deleting contamination without stopping its importer permits recurrence.
- Confidence: high

**[2026-09-19] — Live Amazon identity discovery**
- Observation: The signed-in Kindle notebook does not expose a stable account identifier, but a fresh www.amazon.com response exposes customerID in the inline $Nav config.lightningDeals declaration. Version 0.2.0 parses only this configuration, salts and hashes locally, checks shared Amazon/Kindle authentication cookie continuity, and rejects unverifiable sessions. All 130 automated tests pass, including D1 enforcement and interrupted switches; live extension activation still requires permission approval and explicit account confirmation.
- Action: Never infer account identity from book overlap or a displayed name. Preserve the cookie-change epoch around every read and the immutable server fingerprint on every queued batch. Revalidate real browser behavior if Amazon changes the identity metadata or cookie scope.
- Confidence: high


**[2026-09-13] — Account-lock feasibility review**
- Observation: The notebook fixtures contain synthetic books, annotations, and pagination markers but no Amazon account identity. The current extension state and import contracts also have no account binding, so neither fixture tests nor an existing pairing establish which Amazon account to trust during an upgrade.
- Action: Validate an account identity signal against real notebook responses before implementing its parser. Require explicit initial account selection for existing installations rather than silently trusting whichever account is active on the first upgraded sync.
- Confidence: high

**[2026-09-13] — Account-switching code review**
- Observation: Interrupted imports retain their book cursor and pending batches, and background.ts replays pending uploads before reading the notebook again. worker/import.ts also merges identical passage/location fingerprints within a book across differing annotation IDs and refreshes the stored note. Neither path distinguishes Amazon accounts.
- Action: Any future Amazon-account guard must cover resumed uploads and subsequent notebook requests, not just initial pairing. Include interrupted account switches and matching passages with different notes in its regression scenarios; switching back does not discard an already queued batch.
- Confidence: high

**[2026-09-09] — Local server retirement**
- Observation: The user reports everything is working and requested the local test server be stopped. No process was listening on Writefool's localhost:5183 port. The remaining Node processes with this repository as their working directory belonged to desktop tooling, not Vite or Wrangler.
- Action: Use the deployed app for ordinary use and leave the local test server stopped unless development requires it. Do not terminate desktop tooling merely because its working directory is this repository.
- Confidence: high

**[2026-09-08] — Correct-account production resync after recovery**
- Observation: After reconnecting to the intended Amazon account, production run 3e1e8012-5ea0-43bd-9632-361607a66cc7 completed 36 batches at 20:55 Pacific with zero imported, zero updated, and 796 unchanged highlights. The live library remains 34 books, 796 highlights, and one note; one extension connection is active and sync reports success at 100%. The prior five-highlight production test remains delivered. Preferences remain paused at five highlights every two days at 08:00 America/Los_Angeles.
- Action: Treat the production connector's correct-account reconnection and repeat-import deduplication as validated. The next user step is enabling the desired schedule in Settings after checking the email; do not turn paused delivery on merely because a sync succeeds.
- Confidence: high

**[2026-09-08] — Recovery from an accidental Amazon-account sync**
- Observation: Production run a59a4389-c908-4ec7-b7d9-b12066413046 imported 3 books and 9 highlights from another Amazon account. Comparing every book, highlight, and source mapping with the verified migration snapshot showed all original 34 books and 796 highlights were unchanged. The delivered test selected none of the accidental highlights. A mode-600 backup was saved to ignored .wrangler/wrong-account-recovery-20260909.json before a guarded, simulated repair removed only the additions and that run's four batch receipts, revoked connection 0be1296b-a230-4307-ba5c-917d33f3d32d, and restored sync status. Post-repair comparison matched the original library exactly; the test digest remained intact and delivery stayed paused.
- Action: Sign into the intended Amazon account in the extension's Chrome profile before generating a new pairing code and reconnecting. The extension follows the active Amazon login and currently does not bind a pairing to an Amazon account identity. Use the verified baseline plus import timing and counts to isolate an accidental run; preserve unrelated library edits and delivery history. Do not replay the incident backup or its old batch IDs during normal sync.
- Confidence: high

**[2026-09-08] — Real production delivery and provider webhooks**
- Observation: Production test digest 6de4facc-e49e-4659-8e52-ff7f08f5cc4d reached delivered after the owner's live-app sign-in and test send. D1 now contains two email.sent and two email.delivered provider events. This validates receipt of actual signed Resend notifications beyond the earlier synthetic probe; inbox appearance and Chrome-closed scheduled delivery still need user checks.
- Action: Treat the production sending and webhook connection as operational. Keep acceptance, provider delivery, and inbox/rendering confirmation distinct. Resume recurring delivery through Settings after the user verifies the email and reconnects the intended Kindle account.
- Confidence: high

**[2026-09-08] — Production webhook secret and endpoint verification**
- Observation: The user saved a whsec_ signing secret in .dev.vars after adding the Resend webhook. It was installed as RESEND_WEBHOOK_SECRET on the production writefool Worker through Wrangler stdin. Live unsigned requests returned 400, valid signed requests returned 200, and replaying a signed probe persisted exactly one event. The temporary probe was removed. Production still has zero sessions, zero extension connections, zero digests, and a paused schedule; an actual event from Resend has not yet been observed.
- Action: Do not mistake a signed synthetic probe for provider delivery or inbox confirmation. A subsequent real production test and actual provider events are now verified in the entry above. The ignored production secret file includes the webhook secret for future deployment recovery.
- Confidence: high

**[2026-09-08] — Verified sender and first real test email**
- Observation: Resend's full domain screenshot confirms writefool.vanshkumar.net is Verified. With EMAIL_FROM set to Writefool <highlights@writefool.vanshkumar.net>, the app's normal test endpoint submitted five highlights to vanshkumar95@gmail.com in one attempt. Digest 0718235a-f280-444e-9465-a1aa67e95899 is accepted; preferences remain paused and no last-sent history was advanced. Inbox arrival has not yet been confirmed.
- Action: Use the writefool sending subdomain in local and production configuration. Treat provider acceptance separately from delivery. Actual production delivery events are now verified; the email's appearance and Chrome-closed scheduled delivery still need user checks.
- Confidence: high

**[2026-09-08] — First production deployment and library transfer**
- Observation: Worker writefool is live at https://writefool.vanshkumar95.workers.dev, using production D1 45e42d5f-e745-46d0-bf9c-047f57cc1336 in WNAM. Both migrations applied. The owner's 34 Kindle books, 796 highlights, one note, source mappings, preferences, and sync status were copied under a fresh production user ID and compared field-for-field with a validated local export. No development sessions, sample books, extension credentials, or test digests were copied. All 100 tests passed; live checks reject anonymous APIs and development login.
- Action: Preserve the separate local and production databases. Reconnect the prepared 0.1.5 extension build to the live app using a new pairing code; do not rerun the one-time SQL import into the populated database. Keep delivery paused until webhook setup and inbox checks are complete. The ignored mode-600 .wrangler/production-library-manifest.json records the migration identity and SQL checksum.
- Confidence: high

**[2026-09-08] — Real-account repeat sync**
- Observation: Connector 0.1.4 completed a second real sync with 34 books and 796 highlights unchanged: zero new records, zero updates, 796 unchanged highlights across 36 batches, and zero warning-bearing batches. The one real attached note remained intact after reimport.
- Action: Treat repeat-import deduplication and corrected note extraction as validated for this notebook. Next verify new Kindle content and changed notes, then complete real email delivery setup and browser-closed scheduling checks.
- Confidence: high

**[2026-09-08] — First real Kindle import**
- Observation: Connector 0.1.3 completed the local account's first import: 34 books and 796 highlights across 36 persisted batches, with explicit source annotation IDs for every highlight. Two batches carried the broad export-limit warning; missing passages have not been confirmed.
- Action: Use 34 books and 796 highlights as the baseline until the user adds new Kindle content. Repeat-import deduplication is now verified; verify a new highlight and changed note before considering recurring sync fully validated.
- Confidence: high

**[2026-09-08] — Diagnosing extension retries**
- Observation: A fresh retry after rebuilding still reported the original generic library-layout error. Both builds were labeled 0.1.0, and the same error could arise on a later library page. Zero saved books does not identify the failed page because the extension enumerates the whole library before uploading annotations.
- Action: Bump the unpacked extension version when preparing user retries, display it in the popup, and include version, import stage, discovered book count, and fixed structural counts in reported failures. Do not include page text, identifiers, or pagination tokens in diagnostics.
- Confidence: high

**[2026-09-07] — Import reliability**
- Observation: Real D1 tests show that inserting the unique import batch record first and committing source mappings, highlight updates, and result counters in the same D1 batch makes lost-response replay safe; a mapping conflict rolls the whole batch back.
- Action: Preserve this transaction boundary and persist exact extension upload payloads before advancing page cursors. Large notebook and clippings pages must be split into bounded batches.
- Confidence: high

**[2026-09-07] — Authentication and testing**
- Observation: Better Auth 1.7.3 works directly with this D1 schema, including owner-only magic links and single-use verification. Local development sessions need explicit handling in get-session even when Resend is configured.
- Action: Keep the real magic-link integration test and the configured-development session regression test when upgrading authentication.
- Confidence: high

**[2026-09-07] — Email verification**
- Observation: The installed Svix SDK verifies webhook signatures without returning parsed JSON. Webhook events can arrive before a send response supplies the provider message ID.
- Action: Verify the raw body before parsing it, persist verified events, and reconcile them after provider acceptance; keep duplicate and out-of-order event tests.
- Confidence: high

## What Has Failed

**[2026-09-08] — Account-specific Resend DNS records**
- Observation: The user's Resend screenshot requests one DKIM TXT record and two sending CNAME records (rsend.writefool and send.writefool), not the TXT/MX sending setup in the generic Resend Namecheap guide. A subsequent screenshot confirms writefool.vanshkumar.net is verified. Public DNS resolves the CNAMEs to rsend.forge.rmta.net and send.forge.rmta.net.
- Action: Follow the account's displayed record types and full copied values; all three records belong in Namecheap Advanced DNS → Host Records, with no Mail Settings change. Use the verified writefool subdomain rather than the earlier proposed read subdomain.
- Confidence: high

**[2026-09-08] — Kindle note wrappers and warning text**
- Observation: All 796 imported note fields included the wrapper's "Note:" label: 795 were label-only, and one included real note content. The combined '#note, .kp-notebook-note' selector can return the wrapper before its nested note field. The limit detector also searched passage text and hidden page content.
- Action: Prefer '#note' explicitly before the class fallback, preserving literal note text. Exclude passages, notes, scripts, and hidden templates from warning detection. Connector 0.1.4 includes both fixes. The initial local note fields were backed up in ignored .wrangler/kindle-note-label-backup-20260908.json and corrected; one real attached note remains.
- Confidence: high

**[2026-09-08] — Empty Kindle library pagination**
- Observation: After discovering 34 books, connector 0.1.2 received HTTP 200 HTML for library page two with one library cursor and no library container, cards, ASIN elements, headings, or highlights. The parser required a book card or explicit empty-library message on every page, so it rejected this shape before annotation import could begin. The reported diagnostics did not expose whether the cursor was empty.
- Action: For pagination requests only, accept a fragment containing a readable library cursor and no other content. Continue when its value is nonempty and finish when empty; keep initial-page, blank-response, malformed-layout, and authentication checks strict. Keep the regression scenario that resumes a saved 34-book cursor through an empty final page and uploads all 34 books' highlights; the subsequent real-account retry succeeded.
- Confidence: high

**[2026-09-08] — Local app port collision**
- Observation: The rebuilt connector discovered 34 Kindle books, then received a Writefool API 404. Port 5173 was occupied by a Node process in the separate montessori-books project, so the connector was reaching another app. Writefool started successfully on 5183 using the same local D1 database, with its existing extension pairing intact.
- Action: Reserve localhost:5183 for Writefool and keep Vite's strict port setting, development APP_URL, connector build default, and onboarding instructions aligned. Inspect the listening process's working directory when the extension reports an unexpected local API 404.
- Confidence: high

**[2026-09-08] — Initial Kindle library loading**
- Observation: The first real extension pairing succeeded, but the library scrape returned an unrecognized-layout error and saved zero Kindle records. The content script was refetching the initial notebook as raw HTML, bypassing Amazon's client-side library rendering. A regression fixture verifies delayed DOM population without refetching the shell; connector 0.1.3 subsequently completed the first real import.
- Action: Read the initial library from the extension-owned tab's rendered document with a bounded wait. Reserve HTML requests for pagination and annotation fragments, and use the final pagination input's current value so stale tokens do not restart pagination.
- Confidence: high

**[2026-09-07] — Production build output**
- Observation: Cloudflare's Vite plugin names its output after the top-level Worker, even when CLOUDFLARE_ENV selects production. Assuming the deployment name determines the output directory points Wrangler at the wrong path.
- Action: Keep the explicit Vite environment name `worker`, deploy `dist/worker/wrangler.json`, and verify its production variables, D1 binding, and cron trigger after builds.
- Confidence: high

## Patterns and Preferences

**[2026-09-19] — Git repository setup**
- Observation: The deployed Writefool project had no Git metadata or remote. Git was initialized on main and connected to https://github.com/vanshkumar/writefool; the owner explicitly requested public visibility. The local pnpm store needed an ignore rule alongside secrets, .wrangler backups, and build output.
- Action: Use origin/main for this project and preserve the exclusions when adding files. Keep production recovery snapshots under ignored .wrangler rather than committing them to the public repository.
- Confidence: high


**[2026-09-08] — Targeted test invocation**
- Observation: `pnpm test -- tests/extension.test.ts` launched the entire suite with this installed runner instead of restricting it to the extension file. The unintended D1 suites then failed to bind localhost inside the filesystem sandbox; the previously authorized full run passed all 100 tests.
- Action: Run the local Vitest entry directly with `node node_modules/vitest/vitest.mjs run tests/extension.test.ts` for a targeted check. Run D1 integration suites with localhost socket access, as documented in README.md.
- Confidence: high

**[2026-09-08] — Resend key scope and DNS verification**
- Observation: The saved Resend API key is readable from .dev.vars, but GET /domains returns HTTP 401 with restricted_api_key. The later verified-domain screenshot and successful email submission establish that runtime sending works with this restricted key.
- Action: Use the current sending key for runtime email delivery and obtain account-specific verification values from Resend's Domains dashboard. Follow the actual screenshot's TXT/CNAME records rather than the earlier generic TXT/MX example. Retain the root domain's existing forwarding records when adding sending records.
- Confidence: high

**[2026-09-08] — Preparing personal email delivery**
- Observation: The user created and saved a Resend API key. Local .dev.vars sets OWNER_EMAIL to vanshkumar95@gmail.com and now uses the verified sender Writefool <highlights@writefool.vanshkumar.net>. The local-development-user account's placeholder email was changed to the chosen Gmail address with emailVerified=0, retaining its ID, 34 books, 796 highlights, and extension pairing.
- Action: Keep the same local account ID when testing local magic-link setup so the imported library remains attached. Read secret readiness as booleans only and never print the key. Production uses a distinct account ID and authentication secret.
- Confidence: high

**[2026-09-08] — Email recipient and available domain**
- Observation: The user chose vanshkumar95@gmail.com for digest delivery and owns vanshkumar.net. Public DNS points to dns1/dns2.registrar-servers.com and includes eforward MX records plus an email-forwarding SPF record. Resend now verifies the dedicated writefool.vanshkumar.net sending subdomain.
- Action: Use the chosen Gmail address as the account owner and digest recipient, and retain the root domain's existing forwarding configuration. No hosted inbox or self-managed mail server is required for this sender.
- Confidence: high

**[2026-09-08] — Reloading the unpacked connector**
- Observation: Reloading connector 0.1.4 did not start a repeat import; the database still showed only the first completed run and its original last-contact time. The reload handler restores alarms, while manual sync starts a new run.
- Action: After asking the user to reload a connector build, explicitly include clicking **Sync highlights** before checking repeat-import results.
- Confidence: high

**[2026-09-08] — Cloudflare authentication**
- Observation: Writefool's Wrangler login was successfully renewed with `account:read`, `user:read`, `workers_scripts:write`, and `d1:write`. Wrangler adds `offline_access` automatically; passing it explicitly to `--scopes` is rejected. Its generic missing-scopes warning includes unrelated services even after a successful scoped login.
- Action: Use the scoped login command in README.md for this project, verify with `wrangler whoami`, and do not restore unrelated write/admin permissions just to silence that warning.
- Confidence: high

**[2026-09-08] — Cloudflare refresh and private observability**
- Observation: The first D1 list after an automatic OAuth refresh returned authentication error 10000. Follow-up calls with the freshly saved token succeeded for accounts, D1, and Workers; resource creation and deployment then succeeded without another login or broader scopes. Cloudflare's documented automatic trace spans contain url.full and url.query, which can capture this app's magic-link and unsubscribe tokens.
- Action: After a refresh-related authentication error, retry a read-only scoped endpoint before asking for reauthentication. Keep automatic traces and invocation logs disabled for Writefool while retaining structured application logs, as required by the product's credential-free logging rule.
- Confidence: high

- Personal-first Kindle highlight rediscovery, with a quiet email experience and no AI commentary, tracking pixels, or gamification in the MVP.
- Cloudflare Workers and D1 host the application; a Chrome extension imports Kindle annotations and Resend delivers email independently of browser availability.
