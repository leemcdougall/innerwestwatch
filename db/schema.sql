-- Inner West Watch — D1 database schema
-- Database: counciltracker (id: d721d0be-87d8-45dd-b2ee-56f06d9010ba, region OC/Sydney)
--
-- Domain model (see CONTEXT.md and docs/adr/0003, 0004):
--   A Committee (e.g. Local Transport Forum) holds periodic Meetings.
--   Each Meeting has source Documents on infocouncil.biz (agenda, minutes, attachments).
--
--   A Topic is a real-world issue residents follow. It PERSISTS across meetings,
--   item types, and committees. It has a canonical `subject` (the named thing,
--   e.g. "Leichhardt Aquatic Centre Stage 2"), the union of its suburbs/streets,
--   and a current lifecycle `stage`.
--
--   A Decision is one appearance of a Topic at one Meeting — what was decided that
--   day. MANY decisions point to ONE topic. Each decision carries its own headline
--   (the per-appearance summary) and raw `outcome`.
--
--   Topics are threaded, never merged: the LTF->Council ratification arc is a story
--   we show, not a duplicate we hide. See ADR 0003.

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
-- A persistent real-world issue. Threads many decisions across meetings/types/committees.
--
-- subject: the canonical name of the issue, AI-extracted and human-confirmable.
--   This is the primary linking signal (see topic_subjects). Stable across appearances.
--   e.g. "South Marrickville Flood Study", "King Street Crawl".
-- headline: a current display summary — denormalised from the latest decision.
-- stage: committee-neutral lifecycle (ADR 0004 + 0007):
--   proposed | deferred | under-review | decided | in-progress | completed
--   (under-review = approved only as a process step; see decisions.commitment. completed
--    is defined but never derived — no source signal marks a works finished.)
-- suburbs/streets: JSON arrays, the UNION across all of this topic's decisions.
CREATE TABLE IF NOT EXISTS topics (
    id          TEXT PRIMARY KEY,              -- e.g. "topic-leichhardt-aquatic-centre-stage-2"
    subject     TEXT NOT NULL,                 -- canonical issue name (primary linking signal)
    type        TEXT NOT NULL,                 -- representative type (crossing, latm, motion, …)
    headline    TEXT NOT NULL,                 -- current display summary (from latest decision)
    stage       TEXT NOT NULL DEFAULT 'proposed',
    suburbs     TEXT NOT NULL DEFAULT '[]',    -- JSON array, union across decisions
    streets     TEXT NOT NULL DEFAULT '[]',    -- JSON array, union across decisions
    detail_page TEXT,                          -- relative URL to a hand-crafted detail page, or null
    first_seen  TEXT,                          -- ISO date of earliest decision
    last_seen   TEXT                           -- ISO date of latest decision (drives `stage`)
);

-- ─── decisions ───────────────────────────────────────────────────────────────
-- One appearance of a topic at one meeting. Many decisions per topic.
--
-- headline: the per-appearance plain-language summary (was on topics in the old model).
-- outcome: the raw determination in council's own terms — approved, refused, adopted,
--   noted, "contract executed", etc. Null until a decision is made. See ADR 0004.
-- commitment: for a go-ahead outcome, what it commits to — 'action' (a concrete change)
--   or 'process' (only investigate/review/receive/note). Splits `decided` from
--   `under-review` in deriveStage. Null when pending or for a refusal/deferral. ADR 0007.
--   Populated by db/label-decisions.js reading the stored resolution text (ADR 0008).
-- resident_sentence: the one-to-two-sentence, impact-first plain-language summary a resident
--   reads on the card/trail — distinct from the terse `headline`. Written by the honest-label
--   pass (db/label-decisions.js) from the stored resolution. Null until read. ADR 0008.
-- outcome_unclear: 1 when the resolution text contradicts the stored `outcome` word (a "no"
--   outcome against a text that resolves to act, with no refusal in the text itself); the
--   card then shows "Outcome unclear" instead of a derived label. 0 otherwise. ADR 0008.
CREATE TABLE IF NOT EXISTS decisions (
    id          TEXT PRIMARY KEY,              -- e.g. "ltf-18may2026-04"
    meeting_id  TEXT NOT NULL REFERENCES meetings(id),
    topic_id    TEXT NOT NULL REFERENCES topics(id),
    item_number INTEGER NOT NULL,              -- 1-based position on the agenda
    headline    TEXT,                          -- per-appearance summary, AI-generated
    resolution  TEXT,                          -- plain-language outcome detail, AI-generated; null if pending
    outcome     TEXT,                          -- raw determination string; null if pending
    works_start TEXT,                          -- ISO 8601 date works begin; null if unknown
    commitment  TEXT CHECK(commitment IN ('action', 'process')),  -- ADR 0007; null if pending/refused
    resident_sentence TEXT,                    -- ADR 0008; resident-facing summary, null until read
    outcome_unclear   INTEGER NOT NULL DEFAULT 0  -- ADR 0008; 1 = text contradicts the outcome word
);

CREATE INDEX IF NOT EXISTS idx_decisions_topic ON decisions(topic_id);

-- ─── topic_subjects ──────────────────────────────────────────────────────────
-- The learned linking store: normalised subject string -> topic. This is how
-- human oversight trends to zero (ADR 0003). On ingest, a new item's normalised
-- subject is looked up here; a hit attaches the decision to the known topic with
-- no prompt. A human confirming an ambiguous match writes a new alias here, so the
-- same subject never needs reviewing twice.
--
-- source: 'human' = confirmed by a person (authoritative); 'auto' = matcher-created.
CREATE TABLE IF NOT EXISTS topic_subjects (
    subject_key TEXT PRIMARY KEY,              -- normalised subject (lowercase, punctuation-stripped)
    topic_id    TEXT NOT NULL REFERENCES topics(id),
    source      TEXT NOT NULL DEFAULT 'auto' CHECK(source IN ('human', 'auto')),
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topic_subjects_topic ON topic_subjects(topic_id);

-- ─── documents ───────────────────────────────────────────────────────────────
-- Source files fetched from infocouncil.biz. Tracked so the scanner can skip
-- unchanged content.
CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,  -- e.g. "doc-agn-4285"
    meeting_id  TEXT NOT NULL REFERENCES meetings(id),
    type        TEXT NOT NULL CHECK(type IN ('agenda-html', 'minutes-html', 'attachment-pdf', 'image')),
    url         TEXT NOT NULL,
    fetched_at  TEXT               -- ISO 8601 datetime of last successful fetch; null = never fetched
);

-- ─── images ──────────────────────────────────────────────────────────────────
-- Key images extracted per topic appearance (TGS diagrams, design plans).
CREATE TABLE IF NOT EXISTS images (
    id        TEXT PRIMARY KEY,
    topic_id  TEXT NOT NULL REFERENCES topics(id),
    url       TEXT NOT NULL,
    sequence  INTEGER NOT NULL DEFAULT 0
);

-- ─── topic_relations ─────────────────────────────────────────────────────────
-- Connects topics that RELATE but are not the same issue (ADR 0005): the LTF→Council
-- ratification arc, two crossings at one intersection, a superseding proposal. Threaded,
-- never merged. `topic_a` is the parent for a 'parent-child' link; 'related' is symmetric.
-- Materialised from db/human-relations.json by db/apply-relations.js (added in migration
-- 0004; kept here so a from-scratch rebuild matches live D1). Served by /api/items.
CREATE TABLE IF NOT EXISTS topic_relations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_a    TEXT NOT NULL REFERENCES topics(id),
    topic_b    TEXT NOT NULL REFERENCES topics(id),
    kind       TEXT NOT NULL CHECK(kind IN ('parent-child', 'related', 'supersedes')),
    note       TEXT,                                  -- one-line human rationale (audit)
    source     TEXT NOT NULL DEFAULT 'human' CHECK(source IN ('human', 'auto')),
    created_at TEXT NOT NULL,
    UNIQUE(topic_a, topic_b, kind)                    -- idempotent: re-confirming a link is a no-op
);
CREATE INDEX IF NOT EXISTS idx_topic_relations_a ON topic_relations(topic_a);
CREATE INDEX IF NOT EXISTS idx_topic_relations_b ON topic_relations(topic_b);

-- ─── topic_merge_log ─────────────────────────────────────────────────────────
-- Append-only audit log, retained from the ADR 0002 era for history. Not queried
-- by the API. New linking is recorded in topic_subjects, not here.
CREATE TABLE IF NOT EXISTS topic_merge_log (
    id         INTEGER PRIMARY KEY,
    merge_from TEXT NOT NULL,
    merge_to   TEXT NOT NULL,
    merged_at  TEXT NOT NULL,
    merged_by  TEXT NOT NULL DEFAULT 'cli'
);

-- ─── RETIRED (ADR 0003) ──────────────────────────────────────────────────────
-- topics.canonical_topic_id, trigger trg_topics_no_chain, and table merge_decisions
-- belonged to the merge-based dedup model and are dropped by the threading migration
-- (db/migrations/0001-topic-threading.sql). dedupe.js is superseded by db/match.js.
