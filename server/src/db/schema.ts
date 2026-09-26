// SQLite schema. Each migration runs once, in order, tracked by PRAGMA user_version.
// Times are ISO-8601 UTC strings, so they sort and compare as text.

export const MIGRATIONS: string[] = [
  /* 1: jobs, attempts, stage status, append-only audit trail, model calls */ `
  CREATE TABLE jobs (
    id             TEXT PRIMARY KEY,              -- first 16 hex chars of file_hash
    file_hash      TEXT NOT NULL UNIQUE,          -- SHA-256 of the uploaded file; data/{file_hash}/
    original_name  TEXT NOT NULL,
    size_bytes     INTEGER,
    mime_type      TEXT,
    status         TEXT NOT NULL CHECK (status IN ('queued','running','retrying','done','error','deleted')),
    attempts       INTEGER NOT NULL DEFAULT 0,    -- attempts made so far, across every run
    max_attempts   INTEGER NOT NULL,              -- fails for good once attempts reaches this
    next_run_at    TEXT,                          -- when a queued/retrying job becomes due
    locked_by      TEXT,                          -- worker holding the job while running
    heartbeat_at   TEXT,                          -- last sign of life from that worker
    last_error     TEXT,
    duration_sec   REAL,
    break_count    INTEGER,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    started_at     TEXT,                          -- start of the latest attempt
    finished_at    TEXT,
    deleted_at     TEXT
  );
  CREATE INDEX jobs_due ON jobs (status, next_run_at);

  CREATE TABLE job_attempts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT NOT NULL REFERENCES jobs (id),
    attempt      INTEGER NOT NULL,
    worker_id    TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','interrupted')),
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    error        TEXT,
    error_stage  TEXT,
    retryable    INTEGER,
    UNIQUE (job_id, attempt)
  );

  CREATE TABLE job_stages (
    job_id       TEXT NOT NULL REFERENCES jobs (id),
    stage        TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('pending','running','done','cached','error')),
    attempt      INTEGER,
    started_at   TEXT,
    finished_at  TEXT,
    duration_ms  INTEGER,
    note         TEXT,
    PRIMARY KEY (job_id, stage)
  );

  CREATE TABLE audit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL,
    at          TEXT NOT NULL,
    actor       TEXT NOT NULL CHECK (actor IN ('api','worker','system')),
    type        TEXT NOT NULL,                   -- e.g. job.created, attempt.failed, job.deleted
    attempt     INTEGER,
    ip          TEXT,
    user_agent  TEXT,
    detail      TEXT                             -- JSON
  );
  CREATE INDEX audit_events_job ON audit_events (job_id, id);
  -- The audit trail is append-only, even for this app.
  CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
  CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

  CREATE TABLE model_calls (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id         TEXT,                          -- null for calls outside a job (scripts)
    attempt        INTEGER,
    stage          TEXT,
    provider       TEXT NOT NULL,
    model          TEXT NOT NULL,
    label          TEXT,
    started_at     TEXT NOT NULL,
    latency_ms     INTEGER NOT NULL,
    ok             INTEGER NOT NULL,
    http_status    INTEGER,
    error          TEXT,
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    audio_sec      REAL,
    cost_usd       REAL                           -- as reported by the provider; null when not reported
  );
  CREATE INDEX model_calls_job ON model_calls (job_id, id);
  `,
  /* 2: which brand catalogue a finished job used, so a catalogue change can mark it stale */ `
  ALTER TABLE jobs ADD COLUMN catalogue_hash TEXT;
  `,
  /* 3: the brand catalogue (was catalogue/brands.json, which now only seeds an empty database) */ `
  CREATE TABLE brands (
    id                 TEXT PRIMARY KEY,           -- brand_id in the catalogue JSON
    position           INTEGER NOT NULL,           -- catalogue order (kept so the catalogue hash is stable)
    name               TEXT NOT NULL,
    category           TEXT NOT NULL DEFAULT '',
    target_contexts    TEXT NOT NULL,              -- JSON array of strings
    negative_contexts  TEXT NOT NULL,              -- JSON array of strings
    headline           TEXT,
    tagline            TEXT,
    source             TEXT NOT NULL CHECK (source IN ('seed','ui','import')),
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );

  CREATE TABLE brand_creatives (
    brand_id      TEXT NOT NULL REFERENCES brands (id) ON DELETE CASCADE,
    id            TEXT NOT NULL,
    position      INTEGER NOT NULL,
    duration_sec  REAL NOT NULL,
    language      TEXT NOT NULL DEFAULT '',
    url           TEXT NOT NULL,                  -- media file, relative to the catalogue folder
    PRIMARY KEY (brand_id, id)
  );

  CREATE TABLE catalogue_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    actor       TEXT NOT NULL CHECK (actor IN ('api','system')),
    type        TEXT NOT NULL,                    -- catalogue.seeded, brand.created, brand.deleted, catalogue.imported, ...
    brand_id    TEXT,
    ip          TEXT,
    user_agent  TEXT,
    detail      TEXT                              -- JSON
  );
  CREATE TRIGGER catalogue_events_no_update BEFORE UPDATE ON catalogue_events
    BEGIN SELECT RAISE(ABORT, 'catalogue_events is append-only'); END;
  CREATE TRIGGER catalogue_events_no_delete BEFORE DELETE ON catalogue_events
    BEGIN SELECT RAISE(ABORT, 'catalogue_events is append-only'); END;
  `,
];
