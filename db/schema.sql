-- Inner West Watch — D1 database schema
-- Database name: counciltracker
-- Chosen name: generic enough to scale beyond Inner West to any Australian council.
--
-- Domain overview:
--   A Committee (e.g. Local Transport Forum) holds periodic Meetings.
--   Each Meeting has Documents (agenda, minutes, attachments) sourced from infocouncil.biz.
--   A Topic is a real-world issue residents can follow across multiple meetings
--   (e.g. "Tempe South LATM works"). Topics have a current status that advances
--   over time: on-agenda → forum-yes → council-confirmed → works-coming.
--   An AgendaItem is one appearance of a Topic at one specific Meeting,
--   capturing what was decided that day.

-- ─── committees ──────────────────────────────────────────────────────────────
-- A persistent council body that holds recurring meetings.
-- Not a one-off event — an ongoing institution (e.g. Local Transport Forum,
-- Traffic Committee, Planning Panel).
CREATE TABLE IF NOT EXISTS committees (
    id          TEXT PRIMARY KEY,     -- short slug, e.g. "ltf"
    name        TEXT NOT NULL,        -- human-readable, e.g. "Local Transport Forum"
    description TEXT                  -- optional longer description for the UI
);

-- ─── meetings ────────────────────────────────────────────────────────────────
-- One session of a Committee on a specific calendar date.
-- A Committee has many Meetings over time; each Meeting belongs to one Committee.
CREATE TABLE IF NOT EXISTS meetings (
    id                 TEXT PRIMARY KEY,  -- slug, e.g. "ltf-18may2026"
    committee_id       TEXT NOT NULL REFERENCES committees(id),
    date               TEXT NOT NULL,     -- ISO 8601 date, e.g. "2026-05-18"
    minutes_published  INTEGER NOT NULL DEFAULT 0  -- boolean: 1 = minutes are out
);

-- ─── documents ───────────────────────────────────────────────────────────────
-- A source file from infocouncil.biz that has been (or will be) ingested.
-- Tracking documents separately prevents duplicate ingestion and lets the
-- system know which source material backs each AgendaItem.
--
-- type values:
--   agenda-html     — the meeting agenda page on infocouncil.biz
--   minutes-html    — the published minutes page
--   attachment-html — a supplementary HTML attachment (e.g. TMP, report)
--   attachment-pdf  — a PDF attachment
--   image           — an image file (e.g. map, diagram)
CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,  -- slug, e.g. "doc-agn-4285"
    meeting_id  TEXT NOT NULL REFERENCES meetings(id),
    type        TEXT NOT NULL CHECK(type IN (
                    'agenda-html', 'minutes-html',
                    'attachment-html', 'attachment-pdf', 'image'
                )),
    url         TEXT NOT NULL,     -- canonical URL on infocouncil.biz
    ingested_at TEXT               -- ISO 8601 datetime when content was last fetched; null = not yet ingested
);

-- ─── topics ──────────────────────────────────────────────────────────────────
-- A real-world issue that residents follow across multiple meetings.
-- Examples: "Tempe South LATM works", "Nelson Lane parking", "EV charging rollout".
-- A Topic's status reflects the most recent decision. Its lifespan can span
-- many AgendaItems across many Meetings.
--
-- status values (ordered progression):
--   on-agenda        — listed in an upcoming agenda, no decision yet
--   forum-yes        — Local Transport Forum approved
--   forum-amended    — approved with amendments; returns to Forum before works
--   forum-no         — not supported by Forum
--   council-confirmed — confirmed at full Council (needed for some items)
--   works-coming     — construction/installation actively scheduled
--
-- type values mirror items.json: crossing | parking | latm | event | speed
CREATE TABLE IF NOT EXISTS topics (
    id          TEXT PRIMARY KEY,     -- e.g. "topic-ltf-18may2026-04"
    type        TEXT NOT NULL,        -- item type: crossing, parking, latm, event, speed
    headline    TEXT NOT NULL,        -- plain-language summary shown on cards
    status      TEXT NOT NULL CHECK(status IN (
                    'on-agenda', 'forum-yes', 'forum-amended',
                    'forum-no', 'council-confirmed', 'works-coming'
                )),
    detail_page TEXT                  -- relative URL to level-3 detail page, or null
);

-- ─── topic_suburbs ───────────────────────────────────────────────────────────
-- Many-to-many: one Topic can affect multiple suburbs (e.g. speed zone item
-- covering Rozelle, Lilyfield, Ashfield, Haberfield simultaneously).
CREATE TABLE IF NOT EXISTS topic_suburbs (
    topic_id  TEXT NOT NULL REFERENCES topics(id),
    suburb    TEXT NOT NULL,
    PRIMARY KEY (topic_id, suburb)
);

-- ─── topic_streets ───────────────────────────────────────────────────────────
-- Many-to-many: one Topic can affect multiple streets.
-- Stored separately from suburbs so streets can be queried independently
-- (e.g. "show me everything on Illawarra Rd").
CREATE TABLE IF NOT EXISTS topic_streets (
    topic_id  TEXT NOT NULL REFERENCES topics(id),
    street    TEXT NOT NULL,
    PRIMARY KEY (topic_id, street)
);

-- ─── agenda_items ─────────────────────────────────────────────────────────────
-- One appearance of a Topic at one Meeting. Records what was decided at
-- that specific meeting: the resolution text, works start date, etc.
-- If a Topic appears at multiple meetings (e.g. deferred, then revisited),
-- there will be multiple AgendaItems for the same Topic.
CREATE TABLE IF NOT EXISTS agenda_items (
    id          TEXT PRIMARY KEY,    -- matches items.json id, e.g. "ltf-18may2026-04"
    meeting_id  TEXT NOT NULL REFERENCES meetings(id),
    topic_id    TEXT NOT NULL REFERENCES topics(id),
    item_number INTEGER NOT NULL,    -- order on the agenda, 1-based
    resolution  TEXT,                -- plain-language outcome; null if not yet decided
    works_start TEXT                 -- ISO 8601 date when physical works begin; null if unknown
);

-- ─── agenda_item_documents ────────────────────────────────────────────────────
-- Junction: which Documents support which AgendaItem.
-- An item is typically backed by both the agenda HTML and (once published)
-- the minutes HTML. Attachments (PDFs, maps) are linked here too.
CREATE TABLE IF NOT EXISTS agenda_item_documents (
    agenda_item_id  TEXT NOT NULL REFERENCES agenda_items(id),
    document_id     TEXT NOT NULL REFERENCES documents(id),
    PRIMARY KEY (agenda_item_id, document_id)
);
