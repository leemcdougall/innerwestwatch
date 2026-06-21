# ADR 0006 — Relations are a subject-keyed human decision; the table is derived

Status: accepted — 2026-06-21
Extends: ADR 0005 (topic relations), ADR 0003 (persistent topics by subject threading)

## Context

ADR 0005 added `topic_relations` (migration 0004) and migration 0005 populated 100 human-confirmed
links keyed by **topic id** (`topic_a` / `topic_b`). A topic id is `topic-<slug(subject)>`, derived
from AI-extracted subject text. When a reingest re-reads an agenda and Claude phrases a subject
even slightly differently, the slug — and the id — changes, and the orphan-prune
(`DELETE FROM topics WHERE id NOT IN (SELECT topic_id FROM decisions)`) removes the old id.

The 14 June 2026 reingest did exactly this: it rewrote 116 of the 124 ids the relations referenced.
`topic_relations` went to 0 rows and migration 0005's id-keyed `INSERT`s would no longer resolve.
So the relations, as stored, do **not** trend human oversight to zero — they break on every reingest.

By contrast, subject **aliases** (`topic_subjects`, ADR 0003) trend oversight to zero precisely
because they key on a *normalised subject*, not an id. Relations did not get that property.

## Decision

1. `topic_relations` (id-keyed) remains the materialised, queryable form the frontend will read.
   Migration 0004 still owns its schema.

2. Treat that table as **derived, not source**. The durable source of the human decisions is
   `db/human-relations.json`, version-controlled, where each link is keyed by the **subject pair**
   (plus `kind`, `note`, `source`, `created_at`) — not by topic id. All 100 Milestone-6 links were
   rescued there from the pre-reingest dump.

3. Re-materialise after any reingest by resolving each subject to the current topic id via the
   `topic_subjects` alias store (fuzzy `sameSubject` fallback, `db/lib/topics.js`), reporting any
   subject that no longer resolves. Only those unresolved deltas need a human, and that set shrinks
   as subjects stabilise.

Migration 0005 (id-keyed populate) is therefore **superseded** as the reapply mechanism: it is a
one-time historical record, not the way relations are restored after a reingest.

## Why

- **A human decided once; the machine reapplies it forever.** Keying on the stable subject gives
  relations the same trend-to-zero property threading already has. No human re-confirms a link
  because ingest re-slugged a topic.
- **Survives churn by construction.** The data is still settling and will be reingested many more
  times; an id-keyed store breaks each pass, a subject-keyed one does not.
- **Source vs materialised is an honest split.** Git holds the irreplaceable human judgement; D1
  holds a rebuildable projection of it.

## Consequences

- The 100 links live in `db/human-relations.json` now; materialising them back into live D1 is
  deferred until the data stabilises / the frontend needs them (relations aren't served by
  `/api/items` yet).
- Next relation task: a re-runnable apply step (`subject → current topic id → INSERT INTO
  topic_relations`) plus the unresolved-deltas report.
- Legacy `merge_decisions` / `topic_merge_log` tables (ADR 0002 era) remain in live D1 unused;
  documented as drop candidates.
