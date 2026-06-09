-- Inner West Watch — D1 database schema
-- Database: counciltracker (id: d721d0be-87d8-45dd-b2ee-56f06d9010ba, region OC/Sydney)
--
-- Domain model:
--   A Committee (e.g. Local Transport Forum) holds periodic Meetings.
--   Each Meeting has source Documents on infocouncil.biz (agenda, minutes, attachments).
--   A Topic is a real-world issue residents follow — it persists across meetings and
--   carries the current status. Each time a topic is heard at a meeting, a Decision
--   row records what was decided that day. If a topic recurs (deferred, revisited,
--   amended), it gets a second Decision row at the later meeting.

-- ─── committees ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS committees (
    id    TEXT PRIMARY KEY,  -- short slug, e.g. "ltf"
    name  TEXT NOT NULL      -- human-readable, e.g. "Local Transport Forum"
);

-- ─── meetings ────────────────────────────────────────────────────────────────
-- One session of a committee on a specific date.
CREATE TABLE IF NOT EXISTS meetings (
    id                TEXT PRIMARY KEY,  -- slug, e.g. "ltf-18may2026"
    committee_id      TEXT NOT NULL REFERENCES committees(id),
    date              TEXT NOT NULL,     -- ISO 8601, e.g. "2026-05-18"
    agenda_url        TEXT,              -- infocouncil agenda page URL
    minutes_url       TEXT,              -- infocouncil minutes page URL; null until published
    minutes_published INTEGER NOT NULL DEFAULT 0  -- 0 = not yet, 1 = published
);

-- ─── topics ──────────────────────────────────────────────────────────────────
-- A real-world issue residents can follow. Persists across meetings.
-- headline and suburbs/streets are AI-extracted from the agenda/minutes HTML.
--
-- suburbs and streets are stored as JSON arrays:
--   suburbs: '["Marrickville", "Tempe"]'
--   streets: '["Illawarra Rd", "Wharf St"]'
-- Simple for now; migrate to junction tables if query complexity demands it.
--
-- status values (ordered progression):
--   on-agenda         listed in an upcoming agenda, no decision yet
--   forum-yes         Local Transport Forum approved
--   forum-amended     approved with amendments; returns to Forum before works
--   forum-no          not supported by Forum
--   council-confirmed ratified at full Council
--   works-coming      construction/installation actively scheduled
--
-- type values:
--   crossing | parking | latm | speed | event | report | motion | notice-of-motion | infrastructure
--
-- canonical_topic_id: set on a merged-away duplicate to point to the surviving canonical row.
-- null means this row IS the canonical row (the normal case).
-- Rules enforced by trigger (trg_topics_no_chain):
--   - cannot point to itself
--   - cannot point to a row that is itself merged-away (no chaining)
-- API always filters WHERE canonical_topic_id IS NULL. See ADR 0002.
CREATE TABLE IF NOT EXISTS topics (
    id                 TEXT PRIMARY KEY,              -- e.g. "topic-ltf-18may2026-04"
    type               TEXT NOT NULL,
    headline           TEXT NOT NULL,                 -- plain-language summary, AI-generated
    status             TEXT NOT NULL DEFAULT 'on-agenda',
    suburbs            TEXT NOT NULL DEFAULT '[]',    -- JSON array of suburb names
    streets            TEXT NOT NULL DEFAULT '[]',    -- JSON array of street names
    detail_page        TEXT,                          -- relative URL to hand-crafted detail page, or null
    canonical_topic_id TEXT REFERENCES topics(id)     -- null = canonical; non-null = merged-away duplicate
);

-- Prevent self-reference and pointer chains on canonical_topic_id.
-- SQLite triggers fire per-row; RAISE(ABORT) rolls back the offending statement.
CREATE TRIGGER IF NOT EXISTS trg_topics_no_chain
BEFORE UPDATE OF canonical_topic_id ON topics
FOR EACH ROW
WHEN NEW.canonical_topic_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'canonical_topic_id cannot point to itself')
    WHERE NEW.canonical_topic_id = NEW.id;
    SELECT RAISE(ABORT, 'canonical_topic_id cannot chain — target is already a merged-away row')
    WHERE EXISTS (
        SELECT 1 FROM topics
        WHERE id = NEW.canonical_topic_id
          AND canonical_topic_id IS NOT NULL
    );
END;

-- ─── decisions ───────────────────────────────────────────────────────────────
-- One appearance of a topic at one meeting. Records what was decided that day.
-- A topic that recurs across meetings has multiple decision rows.
CREATE TABLE IF NOT EXISTS decisions (
    id          TEXT PRIMARY KEY,              -- e.g. "ltf-18may2026-04"
    meeting_id  TEXT NOT NULL REFERENCES meetings(id),
    topic_id    TEXT NOT NULL REFERENCES topics(id),
    item_number INTEGER NOT NULL,              -- 1-based position on the agenda
    resolution  TEXT,                          -- plain-language outcome, AI-generated; null if pending
    works_start TEXT                           -- ISO 8601 date works begin; null if unknown
);

-- ─── topic_merge_log ─────────────────────────────────────────────────────────
-- Append-only audit log of every confirmed topic merge.
-- Never queried by the API — used only for audit and rollback investigation.
CREATE TABLE IF NOT EXISTS topic_merge_log (
    id         INTEGER PRIMARY KEY,
    merge_from TEXT NOT NULL,              -- the merged-away topic id
    merge_to   TEXT NOT NULL,              -- the canonical topic id it now points to
    merged_at  TEXT NOT NULL,              -- ISO 8601 datetime
    merged_by  TEXT NOT NULL DEFAULT 'cli' -- 'cli' for script-driven merges, user id if UI added later
);

-- ─── merge_decisions ─────────────────────────────────────────────────────────
-- Disposition memory for the offline deduplication tool (db/dedupe.js).
-- Prevents the tool from surfacing the same candidate pair repeatedly.
--
-- decision values:
--   merged         — canonical_topic_id was set; pair is resolved
--   dismissed_once — suppress for 18 months, then resurface
--   recurring      — permanently suppress; same streets, genuinely distinct program
CREATE TABLE IF NOT EXISTS merge_decisions (
    topic_id_a TEXT NOT NULL,
    topic_id_b TEXT NOT NULL,
    decision   TEXT NOT NULL CHECK(decision IN ('merged', 'dismissed_once', 'recurring')),
    decided_at TEXT NOT NULL,
    decided_by TEXT NOT NULL DEFAULT 'cli',
    PRIMARY KEY (topic_id_a, topic_id_b)
);

-- ─── documents ───────────────────────────────────────────────────────────────
-- Source files fetched from infocouncil.biz.
-- Tracked so the scanner can skip unchanged content (compare fetched_at + hash).
--
-- type values:
--   agenda-html | minutes-html | attachment-pdf | image
CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,  -- e.g. "doc-agn-4285"
    meeting_id  TEXT NOT NULL REFERENCES meetings(id),
    type        TEXT NOT NULL CHECK(type IN ('agenda-html', 'minutes-html', 'attachment-pdf', 'image')),
    url         TEXT NOT NULL,
    fetched_at  TEXT               -- ISO 8601 datetime of last successful fetch; null = never fetched
);
