-- Migration 0009 — projects: a followable grouping ABOVE topics (ADR 0010)
--
-- A Project is a named real-world standing thing (the Leichhardt pool, the GreenWay,
-- the Parramatta Rd corridor) that groups many Topics so a resident can follow it as
-- one page. It is an ANNOTATION above topics, never a merge: no topic row changes,
-- moves or disappears (ADR 0003's thread-never-merge rule still governs everything
-- below). Membership is many-to-many — one topic may belong to several Projects or
-- none (the Dive-In Cinema case: one record touches several pools).
--
-- These tables are DERIVED, exactly like topic_relations (ADR 0006 pattern). The
-- durable source of truth is db/projects.json, version-controlled and keyed by
-- SUBJECT (not topic id — ids churn on re-import). db/apply-projects.js
-- re-materialises these tables from the JSON any time; a re-import can never
-- destroy a Project, at worst it produces a short unresolved-subjects report.
--
-- projects.id is a HUMAN-CHOSEN slug (a person wrote it, never derived from
-- AI-extracted text), so it can never churn. No code mints project ids.

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,          -- human-chosen slug, e.g. 'leichhardt-park-aquatic-centre'
  name        TEXT NOT NULL,             -- resident-facing name, e.g. 'Leichhardt Park Aquatic Centre upgrade'
  description TEXT NOT NULL,             -- one plain-English line: what this thing is
  created_at  TEXT NOT NULL              -- date the human confirmed the Project (from projects.json, not now())
);

-- Membership: which topics belong to which Project. Composite PK makes every
-- reapply idempotent (INSERT OR IGNORE is a no-op on a row that already exists).
-- No Project-level stage/status column ANYWHERE — ADR 0010 rules a rolled-up
-- status word out (the pool proves a single word would lie); the follow view is
-- one timeline of member decisions instead.
CREATE TABLE IF NOT EXISTS project_topics (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  topic_id    TEXT NOT NULL REFERENCES topics(id),
  source      TEXT NOT NULL DEFAULT 'human' CHECK(source IN ('human', 'auto')),  -- who confirmed it ('auto' reserved; nothing auto-joins today, ADR 0010)
  created_at  TEXT NOT NULL,             -- date the human confirmed the membership (from projects.json)
  PRIMARY KEY (project_id, topic_id)
);

-- Both directions get an index: "what's in this Project?" (the follow page) and
-- "what Project is this topic part of?" (the per-topic project refs, issue #94).
CREATE INDEX IF NOT EXISTS idx_project_topics_project ON project_topics(project_id);
CREATE INDEX IF NOT EXISTS idx_project_topics_topic   ON project_topics(topic_id);
