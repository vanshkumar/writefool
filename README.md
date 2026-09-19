# Writefool

A private Kindle highlight library and recurring email ritual. React + Vite and a Hono API run on one Cloudflare Worker, D1 persists the library and delivery outbox, a Chrome extension reads Kindle's US notebook, and Resend delivers email.

Defaults: **5 highlights every 2 days at 08:00**, using your browser timezone at first sign-in. Delivery starts paused until you enable it. Frequency, quantity, local time, and timezone can be changed in Settings.

## Run locally

Use Node.js 22.12+, 24+, or 26+ and pnpm 11. This build was verified on Node.js 24.19.0. The lockfile pins the tested dependencies; esbuild and workerd are the only approved dependency build scripts.

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm db:migrate
pnpm dev
```

Set `AUTH_SECRET` in `.dev.vars` to a randomly generated value at least 32 characters long. Do not commit this file. Open [the local app](http://localhost:5183), choose **Enter development account**, and optionally load the clearly labeled public-domain sample passages. Local development sign-in requires both a development environment and a loopback hostname; it cannot authenticate on the production hostname. Samples are opt-in and local only.

The local app and database work without Cloudflare or Resend accounts. Email submission requires a verified Resend sender and credentials, even in development; the app never pretends to send an email. To test real magic links locally, also set `OWNER_EMAIL`, `EMAIL_FROM`, and `RESEND_API_KEY` in `.dev.vars`. Ordinary local testing uses a separate account whose address is `reader@localhost`; use magic-link sign-in with the configured owner to test actual delivery.

## Connect Kindle

```sh
pnpm build:extension
```

1. Open `chrome://extensions` in desktop Chrome, enable **Developer mode**, choose **Load unpacked**, and select `extension/dist` in this repository.
2. Sign in directly at [Kindle Notebook](https://read.amazon.com/notebook).
3. In Writefool, open **Connect Kindle**, create a one-time code, and paste it into the extension popup. Pairing starts an import.
4. Use the popup's **Sync highlights** button to resync manually. The extension also checks daily while Chrome is available.

For a deployed app, compile its exact origin into the extension and reload it in Chrome:

```sh
WRITEFOOL_APP_URL=https://your-app.example.com pnpm build:extension
```

The extension's host permissions cover the Kindle notebook, www.amazon.com, amazon.com (shared sign-in cookies), and this configured app origin. Its cookies permission verifies that Amazon and Kindle share the same sign-in session throughout each read. Amazon passwords, cookies, and raw account IDs never reach Writefool; the library stores a salted fingerprint. Explicitly confirm the intended account after pairing. Imports pause when the account differs or cannot be verified, and reconnecting cannot reset the lock. An import-only app token is stored in extension storage restricted to trusted extension contexts and can be revoked in Writefool.

Kindle has no supported public highlights API. This importer targets the English US notebook, with synthetic parser fixtures and resumable upload tests. **Real-account import and repeat-import deduplication were verified on September 8, 2026: 34 books and 796 highlights, unchanged after the second sync.** New-highlight detection and changed notes still need real-account checks. Amazon can change its markup or pagination. Personal documents and publisher-limited highlights may be missing from the online notebook; upload an English `My Clippings.txt` in Library instead. File import previews warnings and asks you to resolve ambiguous book matches before writing.

See [extension/README.md](extension/README.md) for the real-account import acceptance checks and technical limitations.

## Production setup

The deployment stays private through app-owned authentication: only `OWNER_EMAIL` can request a usable sign-in link or read the API. The login page itself is reachable. There is no public signup, password login, billing, or development login in production.

### Current personal deployment

As of September 19, 2026, the production account-lock migration and server are deployed, and connector 0.2.0 is built. All 132 tests, typecheck, and production builds pass. Connector 0.2.0 is loaded and re-paired in Chrome, and the live account preview succeeds. The user confirmed the account, and its protected sync succeeded: three new highlights, zero updates, 802 unchanged (34 books, 805 highlights total). The live wrong-account test passed: sync reported account_mismatch with no new import batches or highlights. The repeated contamination was removed from a scoped backup: **34 books and 802 legitimate highlights** remain, including six newer additions. The old extension connection is revoked. Email preferences remain enabled at four highlights daily, 08:00 America/Los_Angeles. Two already-delivered unwanted passages remain only in historical digest snapshots. See [the account-lock plan](ACCOUNT-LOCK-PLAN.md).

Historical deployment notes follow.

As of September 8, 2026, the app is live at **https://writefool.vanshkumar95.workers.dev**. Its separate production D1 database contains the owner's 34 Kindle books, 796 highlights, and one attached note. Every copied row was compared with the validated local export. Development sessions, sample passages, old pairing tokens, and test digests were not migrated. The account starts paused with 5 highlights every 2 days at 08:00 America/Los_Angeles.

The verified sender is **Writefool <highlights@writefool.vanshkumar.net>**, with **vanshkumar95@gmail.com** as the owner and recipient. Production has a separate authentication secret, the working Resend sending key, and the installed webhook signing secret. Live webhook checks accepted valid signatures, rejected unsigned requests, and deduplicated a repeated probe; the temporary probe was removed. A subsequent production test digest reached **delivered**, with real `email.sent` and `email.delivered` events recorded. Inbox appearance and rendering still require confirmation. All 100 automated tests and the production build passed. Live checks confirmed the login page loads, email configuration is active, private APIs reject anonymous requests, and development login is disabled.

Finish the personal setup:

The first production sync accidentally used another Amazon account. Its 3 added books and 9 highlights were backed up and removed; all original data matched the baseline afterward. After the old connection was revoked, the owner reconnected to the intended account. The next production sync completed 36 batches with zero new or updated highlights and all 796 unchanged. One connection is now active, and sync is successful. Keep the intended Amazon account signed in within the connector's Chrome profile.

1. Confirm the delivered test email's appearance in Gmail (and Apple Mail if available).
2. Enable the chosen schedule in Settings; it is currently paused, configured for five highlights every two days at 08:00 America/Los_Angeles.
3. Verify a scheduled delivery with Chrome closed. New-highlight detection, changed notes, and browser interruption recovery still need real-account checks.

Webhook setup is complete on the app side. The user added `https://writefool.vanshkumar95.workers.dev/api/webhooks/resend` in [Resend Webhooks](https://resend.com/webhooks) and supplied its signing secret, now installed as `RESEND_WEBHOOK_SECRET`. The intended subscriptions are `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, and `email.suppressed`. Confirm these if the live test produces no provider events; the sending-only key cannot inspect or update webhook settings. See [Resend's webhook setup](https://resend.com/docs/dashboard/webhooks/introduction).

The repeatable deployment steps below are retained for future setup and updates; the production database, sender verification, and initial deployment are already complete.

1. Reconnect your Cloudflare account with `pnpm exec wrangler login --scopes account:read user:read workers_scripts:write d1:write` and confirm it with `pnpm exec wrangler whoami`. These permissions cover this app's Workers deployment and D1 database. Wrangler may warn that other default scopes are absent; that does not mean this scoped login failed.
2. Create a production database with `pnpm exec wrangler d1 create writefool-production`. Put the returned ID in `env.production.d1_databases[0].database_id` in `wrangler.jsonc`. The development database remains separate.
3. In `env.production.vars`, set `OWNER_EMAIL`, `EMAIL_FROM` (for example `Writefool <highlights@your-verified-domain.com>`), and the final HTTPS `APP_URL`. Use your Cloudflare Workers subdomain or configure a custom domain in the Worker settings. Keep the origin consistent with the extension.
4. Verify the sending domain in Resend and complete the DNS records shown there. Keep open and click tracking disabled. Set a DMARC policy appropriate to that domain; preserve existing mail DNS records.
5. Store the runtime secrets through Wrangler's interactive prompts. They do not belong in `wrangler.jsonc`:

```sh
pnpm exec wrangler secret put AUTH_SECRET --config wrangler.jsonc --env production
pnpm exec wrangler secret put RESEND_API_KEY --config wrangler.jsonc --env production
pnpm exec wrangler secret put RESEND_WEBHOOK_SECRET --config wrangler.jsonc --env production
```

6. Add the Resend webhook URL `https://YOUR_APP_ORIGIN/api/webhooks/resend`, subscribe to `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, and `email.suppressed`, and store its signing secret above. Configure these against your exact production origin.
7. Apply migrations, validate, and deploy:

```sh
pnpm db:migrate:production
pnpm check
pnpm run deploy
WRITEFOOL_APP_URL=https://your-app.example.com pnpm build:extension
```

`pnpm run deploy` checks required production configuration, builds with `CLOUDFLARE_ENV=production`, and deploys the resulting production-specific Worker config. It will not deploy a development build as production. The first deployment supplied `AUTH_SECRET` and `RESEND_API_KEY` through Wrangler's `--secrets-file` option from an ignored, mode-600 file; subsequent deploys preserve them. Keep all secret files outside `dist/client`.

8. Sign in using the owner email, import highlights, preview and send a test, then enable your schedule. Verify the actual test email in Gmail and Apple Mail and confirm a scheduled delivery with Chrome closed.

## Email behavior and reliability

- One server Cron Trigger runs every five minutes. Actual provider delivery can take longer; email is not promised at an exact second.
- Selection rotates across books, prefers unseen and least-recently-sent passages, and avoids repeats for 30 days when possible. Small libraries reuse their oldest passages. Empty eligible libraries skip the email.
- Calendar-day scheduling preserves local delivery time across daylight-saving changes. A skipped time moves to the first valid minute; a repeated time uses its earlier occurrence. Enabling/resuming starts at the next selected local time, then follows the chosen day interval.
- A D1 transaction creates one digest per occurrence and advances the schedule. It freezes the exact recipient, passages, subject, HTML, and text before submission. Leases and Resend idempotency keys protect retries from duplicate submissions. Automatic uncertain retries stop after 22 hours, before Resend's 24-hour key window expires.
- After an outage, at most one catch-up email is created. There is no backlog burst. Preview and test emails do not change highlight history.
- Pause is checked immediately before sending. Hard bounces and complaints suppress future delivery; fix the provider/address issue before an operator clears `suppressed_at`. Unsubscribe links use signed tokens and a confirmation page; a link scanner's GET cannot pause the schedule.
- A library or count change cancels unattempted frozen emails; already attempted retries retain their original payload and key. A send already accepted by the provider cannot be recalled.
- Provider acceptance is distinct from delivery. Signed, deduplicated webhook events repair delayed or interrupted delivery updates. Exactly-once arrival in an inbox is not guaranteed by an email API.

## Validation and operations

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm build:extension
```

Tests cover selection, DST, parser changes, clippings, interrupted extension uploads, concurrent D1 imports and cron ticks, immutable retries, webhook order/signatures, unsubscribe, account isolation, and token revocation. D1 integration tests run a local workerd process and need permission to listen on localhost. They use disposable test databases and mocked outbound email; they do not send messages.

The app includes recent digest errors and sync status. Worker code emits structured operational events without highlight text or credentials. Automatic invocation logs and traces are disabled to avoid storing magic-link and unsubscribe URL tokens: Cloudflare's automatic spans include full request URLs ([documented attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)). Inspect the structured application events in Workers Logs. Review provider delivery status when a digest is uncertain; do not blindly resend after its idempotency window.

Source modules: `src/` is the web app, `worker/` is the API and email backend, `shared/` contains contracts/parsers/selection/scheduling, `extension/` contains the Chrome integration, and `migrations/` contains schema changes. `LEARNINGS.md` records project-specific findings.

Later ideas are intentionally outside this build: Secret passage, Literary mixtapes, Reading seasons, Try it for a day, Parallel lives, and A note for future you.

September 19 live return test: after switching back to the confirmed Amazon account, the protected sync succeeded with all 805 highlights unchanged. Both switch directions are verified; the new lock survives extension reload.
