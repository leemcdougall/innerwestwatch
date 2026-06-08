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
--   crossing | parking | latm | speed | event
CREATE TABLE IF NOT EXISTS topics (
    id          TEXT PRIMARY KEY,              -- e.g. "topic-ltf-18may2026-04"
    type        TEXT NOT NULL,
    headline    TEXT NOT NULL,                 -- plain-language summary, AI-generated
    status      TEXT NOT NULL DEFAULT 'on-agenda',
    suburbs     TEXT NOT NULL DEFAULT '[]',    -- JSON array of suburb names
    streets     TEXT NOT NULL DEFAULT '[]',    -- JSON array of street names
    detail_page TEXT                           -- relative URL to hand-crafted detail page, or null
);

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
