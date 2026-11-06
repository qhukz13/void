-- Migration 001: Initial schema for THE VOID

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS world_objects (
  id TEXT PRIMARY KEY,
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  max_x DOUBLE PRECISION NOT NULL,
  max_y DOUBLE PRECISION NOT NULL,
  chunk_x INTEGER NOT NULL,
  chunk_y INTEGER NOT NULL,
  rotation DOUBLE PRECISION NOT NULL DEFAULT 0,
  z_index INTEGER NOT NULL DEFAULT 0,
  html TEXT NOT NULL DEFAULT '',
  css TEXT NOT NULL DEFAULT '',
  javascript TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_world_objects_active_spatial
  ON world_objects (deleted, x, max_x, y, max_y);

CREATE INDEX IF NOT EXISTS idx_world_objects_chunks
  ON world_objects (deleted, chunk_x, chunk_y);

CREATE INDEX IF NOT EXISTS idx_world_objects_updated_at
  ON world_objects (updated_at DESC);

CREATE TABLE IF NOT EXISTS object_revisions (
  id BIGSERIAL PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES world_objects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  rotation DOUBLE PRECISION NOT NULL DEFAULT 0,
  z_index INTEGER NOT NULL DEFAULT 0,
  html TEXT NOT NULL DEFAULT '',
  css TEXT NOT NULL DEFAULT '',
  javascript TEXT NOT NULL DEFAULT '',
  html_bytes INTEGER NOT NULL DEFAULT 0,
  css_bytes INTEGER NOT NULL DEFAULT 0,
  js_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (object_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_object_revisions_lookup
  ON object_revisions (object_id, revision DESC);
