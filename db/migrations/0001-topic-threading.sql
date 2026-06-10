-- Migration 0001 — topic threading + neutral status (ADR 0003, 0004)
-- Phase 1: ADDITIVE ONLY. Adds new columns/tables and backfills them from existing
-- data. Does NOT drop canonical_topic_id / merge_decisions / the no-chain trigger —
-- those stay until the API cuts over (cleanup happens in migration 0002).
-- One-shot: ALTER ADD COLUMN is not re-runnable in SQLite. Run once against --remote.

-- ── topics: persistent-issue columns ────────────────────────────────────────
ALTER TABLE topics ADD COLUMN subject    TEXT NOT NULL DEFAULT '';
ALTER TABLE topics ADD COLUMN stage      TEXT NOT NULL DEFAULT 'proposed';
ALTER TABLE topics ADD COLUMN first_seen TEXT;
ALTER TABLE topics ADD COLUMN last_seen  TEXT;

-- ── decisions: per-appearance columns ───────────────────────────────────────
ALTER TABLE decisions ADD COLUMN headline TEXT;
ALTER TABLE decisions ADD COLUMN outcome  TEXT;

-- ── learned linking store ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS topic_subjects (
    subject_key TEXT PRIMARY KEY,
    topic_id    TEXT NOT NULL REFERENCES topics(id),
    source      TEXT NOT NULL DEFAULT 'auto' CHECK(source IN ('human', 'auto')),
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topic_subjects_topic ON topic_subjects(topic_id);
CREATE INDEX IF NOT EXISTS idx_decisions_topic      ON decisions(topic_id);

-- ── backfill: move per-item headline down to its decision (data is 1:1 today) ─
UPDATE decisions
   SET headline = (SELECT t.headline FROM topics t WHERE t.id = decisions.topic_id)
 WHERE headline IS NULL;

-- ── backfill: map old LTF status -> neutral stage ───────────────────────────
UPDATE topics SET stage = CASE status
    WHEN 'on-agenda'    THEN 'proposed'
    WHEN 'works-coming' THEN 'in-progress'
    ELSE 'decided'
END;

-- ── backfill: best-effort raw outcome from old status ───────────────────────
-- Historical only; going forward ingest extracts the true outcome. Note the old
-- model conflated deferred into forum-no, so 'not supported' here may be imperfect
-- for some migrated rows — re-ingest of minutes can correct individual cases.
UPDATE decisions
   SET outcome = (SELECT CASE t.status
        WHEN 'forum-yes'         THEN 'approved'
        WHEN 'forum-amended'     THEN 'approved with amendments'
        WHEN 'forum-no'          THEN 'not supported'
        WHEN 'council-confirmed' THEN 'adopted'
        WHEN 'works-coming'      THEN 'approved'
        ELSE NULL END
       FROM topics t WHERE t.id = decisions.topic_id)
 WHERE outcome IS NULL;

-- ── backfill: first/last seen from the topic's decisions ────────────────────
UPDATE topics SET
    first_seen = (SELECT MIN(m.date) FROM decisions d JOIN meetings m ON m.id = d.meeting_id WHERE d.topic_id = topics.id),
    last_seen  = (SELECT MAX(m.date) FROM decisions d JOIN meetings m ON m.id = d.meeting_id WHERE d.topic_id = topics.id);

-- subject stays '' here; db/backfill-subjects.js fills it via AI extraction,
-- then db/match.js threads decisions into shared topics.
