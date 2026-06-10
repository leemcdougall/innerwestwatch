# ADR 0003 — Persistent Topics by subject threading, with a learning matcher

**Status:** Accepted
**Date:** 2026-06-09
**Amends:** ADR 0002 (topic linking by offline deduplication)

## Context

ADR 0002 chose to keep topic linking offline (not at ingest time) and to record merges via `topics.canonical_topic_id`. That decision was sound for *deduplication* but, once we read the full corpus, it did not cover what the data actually needs.

Reconnaissance over 357 ingested items (23 meetings, 14 committees) plus two experiments produced concrete findings:

1. **One real-world issue appears many times, and the appearances cross item *type* and council *committee*.** The Bunnings Tempe works appear as both `latm` and `event`. The Leichhardt Aquatic Centre appears across `report`, `notice-of-motion`, `infrastructure`, and `motion` over five months. Council passes motions literally titled "Adopt Local Transport Forum recommendations" — Council ratifies sub-committee decisions, and the link is stated in the text.
2. **The reliable linking signal is the named subject**, not streets and not type. A cheap, no-AI clustering pass (headline token overlap + street overlap) recovered 277 candidate links and nearly every recurrence we found by hand. Type splits one issue across categories; streets are often absent (the March flood study, several aquatic-centre items have none).
3. **`canonical_topic_id` is the wrong shape.** It *merges* — it collapses one row into another and hides it. But the LTF→Council arc is a story we want to *show* residents (approved at the Forum, then ratified at Council), not collapse. We need threading, not merging.
4. **Recurring-but-distinct must not collapse.** Italian Festa road closures for Oct 2025 and Oct 2026 have near-identical subject and streets but are different events. The clustering pass flagged them cleanly as ~300 days apart — date is the discriminator.

See `CHANGELOG.md` (2026-06-09 rebuild entry) for the experiment numbers.

## Decision

### 1. A Topic is a persistent issue; a Decision is one appearance

`topics` becomes the real-world issue that persists across meetings, types, and committees. Each `decisions` row is one appearance of that issue at one meeting, and **many decisions point to one topic**. The per-appearance summary (`headline`) moves to the decision; the topic carries a stable canonical **subject**, the union of its suburbs and streets, and a current status.

We thread, we do not merge. `canonical_topic_id` is retired — there is no merged-away row to hide; there is one topic with a list of decisions.

### 2. The named subject is the primary linking signal

Ingest extracts a canonical `subject` per item (e.g. "South Marrickville Flood Study", "Leichhardt Aquatic Centre Stage 2"). Subject is matched first; shared streets and meeting dates corroborate; a date-distance rule keeps genuinely distinct recurrences (annual events, fixed program cycles) apart even when subjects match.

### 3. Matching stays offline — but it learns, and oversight trends to zero

Linking is still a reconciliation pass with human confirmation (ADR 0002's core choice holds — no AI guess is baked silently into the source data). What changes: every human decision is persisted as a durable **subject → topic** alias, not a one-off suppression. On the next ingest, an item whose normalised subject matches a known alias attaches automatically with no prompt. The review queue is only ever *new* subjects and genuinely ambiguous middles. Oversight shrinks ingest over ingest. (This is why ADR 0002's `dismissed_once` 18-month resurfacing is removed: it trends the wrong way — it re-asks settled questions.)

## Why not the alternatives

- **Keep `canonical_topic_id` and just relax `dedupe.js`'s filter.** Rejected — merging hides the cross-committee arc we want to display, and same-type/shared-street candidate generation is blind to 169 cross-type and 74 cross-committee pairs we found.
- **AI matching inline at ingest.** Rejected — non-deterministic, costs an LLM call per item against a growing set, and bakes wrong links into the source of truth with no review. For a civic-trust product a wrong link is a published falsehood. The learned-alias store gives most of the autonomy benefit deterministically.
- **A free `topic_links` many-to-many graph.** Rejected as the primary model — the need is one persistent topic per issue with an ordered decision history, not arbitrary graph edges. A topic-id foreign key on `decisions` expresses that directly.

## Consequences

- Ingest order starts to matter (an item should find its parent). We address this with a global reconciliation pass after items land, rather than depending on fetch order.
- The existing 357 isolated topics must be migrated: extract subjects, split headline to the decision, thread decisions into real topics via a one-off suggest-then-confirm run.
- `dedupe.js` and `topics.canonical_topic_id` are superseded. `topic_merge_log` is kept for audit history; `merge_decisions` is replaced by the learned subject→topic store.
