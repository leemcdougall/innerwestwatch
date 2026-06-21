# ADR 0005 — Topic relations, stored as subject-keyed human decisions

**Status:** Accepted
**Date:** 2026-06-21

## Context

Milestone 6 produced 100 human-confirmed cross-topic links: pairs of topics that are
`related`, in a `parent-child` arc (a Council resolution over the LTF approval it ratifies),
or where one `supersedes` another. These are deliberately NOT auto-created by the matcher —
a wrong cross-link is a published falsehood (ADR 0003), so they are the human layer on top of
the automated alias threading. They were stored in a `topic_relations` table keyed by topic id.

That table keys on the one thing that is unstable across reingests. A topic id is
`topic-<slug(subject)>`, derived from AI-extracted subject text. When a reingest re-reads an
agenda and Claude phrases a subject even slightly differently, the slug — and therefore the id —
changes. The orphan-prune in the backfill (`DELETE FROM topics WHERE id NOT IN (SELECT topic_id
FROM decisions)`) then removes the old id. The 14 June 2026 reingest did exactly this: it rewrote
116 of the 124 ids the relations referenced, and the 100 links were lost.

By contrast, **subject aliases** (`topic_subjects`, ADR 0003) trend human oversight to zero
precisely because they key on a *normalised subject*, not an id. The same subject is never
re-reviewed. Relations did not get that property.

## Decision

1. Keep the `topic_relations` table (id-keyed) as the materialised, queryable form the future
   frontend reads. Its schema lives in migration `0003-topic-relations.sql`.

2. Treat that table as **derived, not source**. The durable source of the human decisions is
   `db/human-relations.json`, version-controlled, where each link is keyed by the **subject pair**
   (plus `kind`, `note`, `source`, `created_at`) — not by topic id.

3. Re-materialise relations after any reingest by resolving each subject to the current topic id
   via the `topic_subjects` alias store (with a fuzzy `sameSubject` fallback from `db/lib/topics.js`),
   and reporting any subject that no longer resolves. Only those unresolved deltas need a human,
   and that set shrinks as subjects stabilise.

## Why

- **A human decided once; the machine reapplies it forever.** Keying on the stable subject gives
  relations the same trend-to-zero property the alias store already gives threading. No human
  re-confirms a link just because ingest re-slugged a topic.
- **Survives churn by construction.** The data is still settling and will be reingested many more
  times. An id-keyed store breaks on every pass; a subject-keyed store does not.
- **Source vs materialised is an honest split.** Git holds the irreplaceable human judgement;
  D1 holds a rebuildable projection of it.

## Consequences

- The 100 links are preserved now in `db/human-relations.json`; materialising them back into live
  D1 is deferred until the data stabilises / the frontend needs them (relations are not yet served
  by `/api/items`).
- A re-runnable apply step (`subject → current topic id → INSERT INTO topic_relations`) is the next
  piece of relation tooling to build.
- Legacy `merge_decisions` / `topic_merge_log` tables (from the abandoned merge approach, ADR 0002)
  remain in live D1 unused; documented as legacy, candidates for a later drop migration.
