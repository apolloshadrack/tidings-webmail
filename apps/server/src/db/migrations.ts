/**
 * Forward-only schema migrations. Never edit a shipped migration; append a new one.
 * Every table holding user data is keyed by user_key = sha256(host:port \0 username).
 */
export const MIGRATIONS: string[] = [
  /* 1 — initial schema */ `
  CREATE TABLE users (
    user_key TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    sid TEXT PRIMARY KEY,               -- HMAC(secret, token); the token itself is never stored
    user_key TEXT NOT NULL REFERENCES users(user_key) ON DELETE CASCADE,
    username TEXT NOT NULL,
    cred_nonce BLOB NOT NULL,
    cred_ct BLOB NOT NULL,
    cred_tag BLOB NOT NULL,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    public_computer INTEGER NOT NULL DEFAULT 0,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_key);

  CREATE TABLE settings (
    user_key TEXT PRIMARY KEY REFERENCES users(user_key) ON DELETE CASCADE,
    json TEXT NOT NULL
  );

  CREATE TABLE mailboxes (
    user_key TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    delimiter TEXT,
    parent_path TEXT,
    special_use TEXT,
    flags TEXT NOT NULL DEFAULT '[]',
    subscribed INTEGER NOT NULL DEFAULT 1,
    uid_validity TEXT,
    uid_next INTEGER,
    highest_modseq TEXT,
    total INTEGER NOT NULL DEFAULT 0,
    unseen INTEGER NOT NULL DEFAULT 0,
    last_sync INTEGER,
    synced_count INTEGER NOT NULL DEFAULT 0,
    color TEXT,
    sort_order INTEGER,
    PRIMARY KEY (user_key, path)
  );

  CREATE TABLE messages (
    user_key TEXT NOT NULL,
    mailbox TEXT NOT NULL,
    uid INTEGER NOT NULL,
    uid_validity TEXT NOT NULL,
    message_id TEXT,
    thread_id TEXT NOT NULL,
    in_reply_to TEXT,
    refs TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    reply_to_json TEXT NOT NULL DEFAULT '[]',
    date INTEGER NOT NULL,
    internal_date INTEGER NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    flags TEXT NOT NULL DEFAULT '[]',
    seen INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0,
    draft INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    snippet TEXT NOT NULL DEFAULT '',
    list_unsubscribe TEXT,
    list_unsubscribe_post INTEGER NOT NULL DEFAULT 0,
    modseq TEXT,
    PRIMARY KEY (user_key, mailbox, uid)
  );
  CREATE INDEX messages_list ON messages(user_key, mailbox, date DESC);
  CREATE INDEX messages_thread ON messages(user_key, thread_id);
  CREATE INDEX messages_msgid ON messages(user_key, message_id);
  CREATE INDEX messages_from ON messages(user_key, from_addr);

  CREATE VIRTUAL TABLE messages_fts USING fts5(
    subject, from_text, to_text, snippet,
    content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'
  );
  -- rowid of messages_fts mirrors messages.rowid
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, subject, from_text, to_text, snippet)
    VALUES (new.rowid, new.subject, new.from_name || ' ' || new.from_addr, new.to_json || ' ' || new.cc_json, new.snippet);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.rowid;
  END;

  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',  -- manual | sent | received
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (user_key, email)
  );

  CREATE TABLE identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    reply_to TEXT,
    signature_html TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key TEXT NOT NULL,
    title TEXT NOT NULL,
    body_html TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE drafts (
    id TEXT PRIMARY KEY,
    user_key TEXT NOT NULL,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    imap_uid INTEGER,
    imap_uid_validity TEXT,
    imap_synced_at INTEGER
  );
  CREATE INDEX drafts_user ON drafts(user_key);

  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    user_key TEXT NOT NULL,
    draft_id TEXT,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    user_key TEXT NOT NULL,
    session_sid TEXT,
    message_id TEXT NOT NULL,
    state TEXT NOT NULL,          -- queued | sending | sent | failed | cancelled
    send_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    nonce BLOB NOT NULL,
    ct BLOB NOT NULL,
    tag BLOB NOT NULL,
    meta TEXT NOT NULL,           -- json: recipients, subject, draftId, inReplyTo ref
    error TEXT,
    UNIQUE (user_key, message_id)
  );

  CREATE TABLE snoozes (
    user_key TEXT NOT NULL,
    message_id TEXT NOT NULL,
    from_mailbox TEXT NOT NULL,
    wake_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_key, message_id)
  );

  CREATE TABLE trusted_senders (
    user_key TEXT NOT NULL,
    sender TEXT NOT NULL,
    PRIMARY KEY (user_key, sender)
  );

  CREATE TABLE blocked_senders (
    user_key TEXT NOT NULL,
    sender TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_key, sender)
  );

  CREATE TABLE send_counter (
    user_key TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (user_key, day)
  );
  `,
];
