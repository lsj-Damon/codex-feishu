CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message_id TEXT,
  chat_id TEXT NOT NULL,
  sender_open_id TEXT,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(platform, event_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  user_open_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_user_message_id INTEGER,
  last_assistant_message_id INTEGER,
  last_response_id TEXT,
  summary_text TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(platform, conversation_key)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  platform_message_id TEXT,
  reply_to_message_id TEXT,
  role TEXT NOT NULL,
  sender_open_id TEXT,
  content_text TEXT NOT NULL,
  content_json TEXT,
  token_input INTEGER,
  token_output INTEGER,
  model TEXT,
  response_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id),
  UNIQUE(platform, platform_message_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  trigger_message_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  available_at TEXT NOT NULL,
  locked_by TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  result_message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id),
  FOREIGN KEY(trigger_message_id) REFERENCES messages(id),
  FOREIGN KEY(result_message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
  ON messages(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_status_available_at
  ON jobs(status, available_at);

CREATE INDEX IF NOT EXISTS idx_jobs_conversation_created_at
  ON jobs(conversation_id, created_at DESC);

