CREATE TABLE IF NOT EXISTS job_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  error_code TEXT,
  error_message TEXT,
  openai_request_id TEXT,
  feishu_send_status TEXT,
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL UNIQUE,
  assistant_message_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  delivery_type TEXT NOT NULL,
  status TEXT NOT NULL,
  platform_message_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(assistant_message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_job_attempts_job_attempt_no
  ON job_attempts(job_id, attempt_no);

CREATE INDEX IF NOT EXISTS idx_deliveries_status_updated_at
  ON deliveries(status, updated_at);

UPDATE jobs
SET max_attempts = 4
WHERE max_attempts < 4;
