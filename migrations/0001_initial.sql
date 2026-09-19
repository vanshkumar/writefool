PRAGMA foreign_keys = ON;

CREATE TABLE user (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON session(userId);
CREATE TABLE account (
  id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt INTEGER,
  refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE INDEX account_user_idx ON account(userId);
CREATE TABLE verification (
  id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
  expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE INDEX verification_identifier_idx ON verification(identifier);

CREATE TABLE preferences (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  interval_days INTEGER NOT NULL DEFAULT 2 CHECK(interval_days BETWEEN 1 AND 30),
  highlight_count INTEGER NOT NULL DEFAULT 5 CHECK(highlight_count BETWEEN 1 AND 20),
  local_time TEXT NOT NULL DEFAULT '08:00', timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  enabled INTEGER NOT NULL DEFAULT 0, next_send_at TEXT, suppressed_at TEXT,
  unsubscribe_version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE INDEX preferences_due_idx ON preferences(enabled, next_send_at);
CREATE TABLE books (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  title TEXT NOT NULL, author TEXT NOT NULL, source TEXT NOT NULL,
  excluded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX books_user_idx ON books(user_id);
CREATE TABLE book_sources (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, source TEXT NOT NULL,
  source_id TEXT NOT NULL, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, source, source_id)
);
CREATE TABLE highlights (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, text TEXT NOT NULL,
  note TEXT, location TEXT, highlighted_at TEXT, hidden INTEGER NOT NULL DEFAULT 0,
  last_sent_at TEXT, imported_at TEXT NOT NULL, fingerprint TEXT NOT NULL
);
CREATE INDEX highlights_user_book_idx ON highlights(user_id, book_id);
CREATE INDEX highlights_fingerprint_idx ON highlights(user_id, book_id, fingerprint);
CREATE TABLE highlight_sources (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, source TEXT NOT NULL,
  source_book_id TEXT NOT NULL, source_id TEXT NOT NULL,
  highlight_id TEXT NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, source, source_book_id, source_id)
);
CREATE TABLE import_batches (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, batch_id TEXT NOT NULL,
  run_id TEXT NOT NULL, source TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, batch_id)
);
CREATE TABLE sync_status (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'idle', last_success_at TEXT, message TEXT,
  progress INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE extension_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE dev_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE digests (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL, status TEXT NOT NULL, highlight_count INTEGER NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  first_attempt_at TEXT, next_attempt_at TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT, error TEXT, UNIQUE(user_id, scheduled_for)
);
CREATE INDEX digests_due_idx ON digests(status, next_attempt_at);
CREATE INDEX digests_provider_idx ON digests(provider_id);
CREATE TABLE digest_highlights (
  digest_id TEXT NOT NULL REFERENCES digests(id) ON DELETE CASCADE,
  highlight_id TEXT NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  PRIMARY KEY(digest_id, highlight_id)
);
CREATE TABLE email_events (id TEXT PRIMARY KEY, received_at TEXT NOT NULL, payload_json TEXT NOT NULL);
