-- Migration 0004 — topic_relations: connect topics that relate but are NOT the same issue (ADR 0005)
--
-- Threading (one topic, many decisions) captures "same real-world issue". But many topics
-- TOUCH each other without being the same: a masterplan and the individual crossings inside
-- it (parent/child), two motions about one precinct from different angles (related), or a new
-- scheme that replaces an earlier one (supersedes). The comprehensive link pass (Milestone 6)
-- surfaces these. They must not be merged — that would erase distinct council decisions — so
-- we record them as relations instead.
--
-- Directionality:
--   parent-child : topic_a is the parent (umbrella report / masterplan / precinct),
--                  topic_b is the child (an individual work / motion under it).
--   supersedes   : topic_a supersedes/replaces topic_b (topic_b is the earlier version).
--   related      : symmetric — same place/theme, no hierarchy. Store one row (a<b by id).
--
-- 'merge' is NOT a relation kind: confirmed same-issue links are applied by threading
-- (repoint decisions + drop the orphan + write a source='human' subject alias), as in
-- migration 0003. topic_relations only holds the non-merge connections.

CREATE TABLE IF NOT EXISTS topic_relations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_a    TEXT NOT NULL REFERENCES topics(id),
  topic_b    TEXT NOT NULL REFERENCES topics(id),
  kind       TEXT NOT NULL CHECK(kind IN ('parent-child', 'related', 'supersedes')),
  note       TEXT,                                  -- one-line human rationale (shown to no one yet; audit)
  source     TEXT NOT NULL DEFAULT 'human' CHECK(source IN ('human', 'auto')),
  created_at TEXT NOT NULL,
  UNIQUE(topic_a, topic_b, kind)                    -- idempotent: re-confirming a link is a no-op
);

CREATE INDEX IF NOT EXISTS idx_topic_relations_a ON topic_relations(topic_a);
CREATE INDEX IF NOT EXISTS idx_topic_relations_b ON topic_relations(topic_b);
