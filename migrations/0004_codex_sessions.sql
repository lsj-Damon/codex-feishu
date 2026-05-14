ALTER TABLE conversations ADD COLUMN workspace_root TEXT;
ALTER TABLE conversations ADD COLUMN current_project_name TEXT;
ALTER TABLE conversations ADD COLUMN current_project_path TEXT;
ALTER TABLE conversations ADD COLUMN active_session_id INTEGER;
ALTER TABLE conversations ADD COLUMN active_backend TEXT NOT NULL DEFAULT 'codex';
ALTER TABLE conversations ADD COLUMN last_switch_at TEXT;

CREATE TABLE IF NOT EXISTS codex_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  project_name TEXT NOT NULL,
  project_path TEXT NOT NULL,
  codex_session_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_codex_sessions_conversation_status
  ON codex_sessions(conversation_id, status);

CREATE INDEX IF NOT EXISTS idx_codex_sessions_project_path
  ON codex_sessions(project_path);

CREATE INDEX IF NOT EXISTS idx_codex_sessions_codex_session_id
  ON codex_sessions(codex_session_id);

CREATE TABLE IF NOT EXISTS codex_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  user_message_id INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  jsonl_path TEXT,
  stderr_path TEXT,
  final_reply_text TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY(session_id) REFERENCES codex_sessions(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(user_message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_codex_runs_session_status
  ON codex_runs(session_id, status);

CREATE INDEX IF NOT EXISTS idx_codex_runs_job_id
  ON codex_runs(job_id);

CREATE TABLE IF NOT EXISTS codex_stream_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  sequence_no INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  pushed_to_feishu INTEGER NOT NULL DEFAULT 0,
  feishu_message_id TEXT,
  FOREIGN KEY(run_id) REFERENCES codex_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_codex_stream_events_run_seq
  ON codex_stream_events(run_id, sequence_no);

CREATE INDEX IF NOT EXISTS idx_codex_stream_events_push_state
  ON codex_stream_events(run_id, pushed_to_feishu);
