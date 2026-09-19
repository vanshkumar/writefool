CREATE TABLE kindle_accounts (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  salt TEXT NOT NULL,
  fingerprint TEXT CHECK(fingerprint IS NULL OR (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*')),
  confirmed_at TEXT
);
