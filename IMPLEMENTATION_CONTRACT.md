# Working integration contract

All app routes below use a Better Auth session cookie. JSON errors are `{ error: string }` with non-2xx status. Types live in `shared/contracts.ts`. Same-origin writes require an allowed Origin. No production development bypass.

- GET /api/config → { configured: boolean, development: boolean }
- POST /api/auth/sign-in/magic-link { email, callbackURL } → Better Auth response
- GET /api/auth/get-session → Better Auth session or null
- POST /api/auth/sign-out → Better Auth
- POST /api/dev/login → local-only development session; POST /api/dev/seed → sample public-domain excerpts for local testing only
- GET /api/dashboard → Dashboard
- GET /api/books → { books: Book[] }
- GET /api/highlights?bookId=&q=&includeHidden=true → { highlights: Highlight[] }
- PATCH /api/books/:id { excluded: boolean } → { ok: true }
- PATCH /api/highlights/:id { hidden: boolean } → { ok: true }
- GET /api/preferences → Preferences
- PUT /api/preferences → Preferences (send mutable Preferences fields; server owns nextSendAt)
- GET /api/digest/preview → DigestPreview
- POST /api/digest/test → { id: string, status: DigestState }
- POST /api/pairing → { code: string, expiresAt: string, appUrl: string }
- DELETE /api/extension-tokens/:id → { ok: true }
- POST /api/clippings/preview { text: string } → ClippingsPreview
- POST /api/clippings/import → ImportBatch with source clippings; ambiguous matches must set targetBookId or explicitly choose a new book (targetBookId="new")

Extension routes (no cookie/session required):
- POST /api/extension/pair { code: string } → { token: string } (public, rate-limited, single-use code)
- POST /api/extension/import → ImportBatch, returns ImportResult (Bearer import token)
- POST /api/extension/status { status: SyncState, message?: string, progress?: number } → { ok: true } (Bearer import token)

Public verified webhooks and signed unsubscribe links:
- POST /api/webhooks/resend; GET /unsubscribe?token=... confirmation page; POST /api/unsubscribe?token=... pauses email.

App links: /, /library, /library?highlight=:id, /settings, /connect. Login is inline when session missing. Working product name Writefool.

Module ownership: root owns worker API/auth/database/migrations/scaffold; frontend agent owns src/ and index.html; extension agent owns extension/, scripts/build-extension.mjs, shared/clippings.ts and parser tests; email agent owns worker/digest.ts, worker/email.ts, shared/selection.ts, shared/schedule.ts and related tests.
