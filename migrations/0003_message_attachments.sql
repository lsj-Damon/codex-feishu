CREATE TABLE IF NOT EXISTS message_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  attachment_index INTEGER NOT NULL,
  provider TEXT NOT NULL,
  attachment_kind TEXT NOT NULL,
  remote_key TEXT NOT NULL,
  local_path TEXT,
  mime_type TEXT,
  status TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  metadata_json TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES messages(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_attachments_message_index
  ON message_attachments(message_id, attachment_index);

CREATE INDEX IF NOT EXISTS idx_message_attachments_remote_key
  ON message_attachments(provider, remote_key);

CREATE INDEX IF NOT EXISTS idx_message_attachments_status_updated_at
  ON message_attachments(status, updated_at);

