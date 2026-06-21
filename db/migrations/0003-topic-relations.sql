-- Migration 0003 — topic_relations table (Milestone 6 / ADR 0005)
-- Captures schema that was applied to live D1 out-of-band: the topic_relations
-- table holds human-confirmed cross-topic links (kind = parent-child | related |
-- supersedes). The original create/populate migrations (0004/0005 in an earlier
-- branch) never landed on main, so this migration re-establishes the table in the
-- repo so the schema is reproducible from a clean D1.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, so safe to run against a D1 that already
-- has the table from the earlier out-of-band apply.
--
-- NOTE: relations are NOT seeded here. The 100 human links are preserved in
-- db/human-relations.json (keyed by SUBJECT, not topic id, so they survive reingest
-- slug churn) and are re-materialised by resolving each subject -> current topic id
-- via the topic_subjects alias store. See CHANGELOG / ADR 0006.

CREATE TABLE IF NOT EXISTS topic_relations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_a    TEXT NOT NULL REFERENCES topics(id),
    topic_b    TEXT NOT NULL REFERENCES topics(id),
    kind       TEXT NOT NULL CHECK(kind IN ('parent-child', 'related', 'supersedes')),
    note       TEXT,                                  -- one-line human rationale (audit; not shown yet)
    source     TEXT NOT NULL DEFAULT 'human' CHECK(source IN ('human', 'auto')),
    created_at TEXT NOT NULL,
    UNIQUE(topic_a, topic_b, kind)                    -- idempotent: re-confirming a link is a no-op
);
