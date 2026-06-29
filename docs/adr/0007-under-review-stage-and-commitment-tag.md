# ADR 0007 — An "under review" stage, separated from "decided" by a commitment tag

**Status:** Accepted — but shipped via the type fallback only; the AI `commitment` tag is deferred (see "Update 2026-06-28" below)
**Date:** 2026-06-28
**Extends:** ADR 0004 (committee-neutral status)

## Context

ADR 0004 derived a topic's `stage` from its decisions' raw outcomes: any outcome that
wasn't a defer or an executed-works signal mapped to `decided`. That conflated two very
different things a council can "approve":

- approving a **concrete change** — build the crossing, adopt the plan, execute the contract; and
- approving only a **process step** — "undertake a safety review and report back in three months".

Both recorded `outcome = "approved"`, so both read `decided`. On the canonical example
(the Unwins Bridge Rd / Hillcrest St safety-review motion, Feb 2026) a resident skimming
the badge saw "decided" and reasonably assumed the crossing was going ahead, when council
had only agreed to look into it. At the time of this decision ~320 topics (notices of
motion, motions, reports) carried a `decided` badge whose meaning depended entirely on
this distinction — and the Milestone-7 frontend rebuild puts that badge front and centre
on every card, so the overstatement had to be fixed before the frontend.

The outcome word alone cannot separate the two: a notice of motion "approved" /
"endorsed" / "carried" is just as likely to be "approve investigating X" as "approve
doing X", and real resolutions frequently mix both ("procure the decorations **and**
investigate festive initiatives"). Plain keyword matching on the resolution text misfires
on the mixed cases. The reliable signal is a judgement made while reading the document.

## Decision

1. **Add a sixth stage, `under-review`** (resident label "Under review"), ranked between
   `deferred` and `decided`. Lifecycle ladder, lowest to highest:
   `proposed → deferred → under-review → decided → in-progress → completed`.
   As in ADR 0004, a topic shows the most-advanced point any of its decisions reached.

2. **Tag each approved decision with a `commitment`** of `action` or `process`, extracted
   by the AI as it reads the minutes (the minutes prompt in `db/ingest.js`). `action`
   commits to a concrete change; `process` commits only to investigate / review / receive
   / note. A `process` commitment lands the decision in `under-review`; an `action`
   commitment (or any positive outcome the tag doesn't cover) lands it in `decided`.
   **When a resolution does both, `action` wins** — understating a concrete commitment is
   the worse error.

3. **Item type is the fallback** when the `commitment` tag is absent (data ingested before
   this change, or the minutes-only Public Forum which emits no outcome): deliberative
   types (`motion`, `notice-of-motion`, `report`, `mayoral-minute`, `community-address`,
   `policy`, `other`) default to `under-review`; works/change types (`crossing`, `latm`,
   `parking`, `speed`, `infrastructure`, `development`, …) to `decided`.

4. **Refusals stay `decided`** (`refused`, `not supported`, `withdrawn`, `lapsed`). A
   determination *was* made; the raw `outcome`, shown alongside the badge, says it was
   "no". This keeps ADR 0004's decided-plus-outcome model rather than minting a separate
   "not proceeding" stage.

5. **`completed` stays unwired.** No source signal reliably marks a works as finished;
   `works_start` is a start date, not an end. The pipeline tops out at `in-progress`.

## Why a commitment tag rather than a keyword rule

The action-vs-process line lives in the *meaning* of the resolution, not in any fixed
vocabulary. A keyword rule over resolution text is both fragile (it cannot weigh a mixed
resolution) and unauditable by a non-technical maintainer. Tagging at ingest, when the AI
already has the full document in front of it, handles the mixed cases with judgement and
costs almost nothing because the documents are being re-read anyway (below). The tag is a
stored column, so `deriveStage` stays a pure, unit-testable function of its decisions.

## Consequences

- `db/lib/topics.js` — `stageRank` / `deriveStage` change shape: they now read a
  `commitment` signal (and the item `type` as fallback), not just `outcome` / `works_start`.
  Both callers (`db/ingest.js`, `db/match.js`) pass the new fields. Regression tests cover
  the motion-vs-works distinction.
- A new `commitment` column on `decisions`, populated by the minutes extraction.
- **A full in-place re-ingest** is required to backfill the tag and to re-read every
  meeting's minutes (which also closes the separate "proposed topic whose minutes were
  already published" gap — 37 of 104 proposed topics at decision time). In-place re-read
  preserves the 96 human-confirmed subject aliases (the merge/dedup memory from ADR 0003 /
  session 12); a from-scratch wipe was rejected because it would reset them. Topic
  relations are rebuilt afterward (`db/apply-relations.js --rebuild`, ADR 0006).
- Some genuinely-decisive deliberative items will read `under-review` until re-read with
  the tag; understating progress is the safer error for a resident-facing badge.

## Update 2026-06-28 — shipped via the type fallback; AI tagging deferred

We attempted the full in-place re-ingest to populate the `commitment` tag. It was both
unreliable and corrosive, so the tag is shelved and the **type fallback is the active
mechanism**. The decision (the `under-review` stage, the decided/under-review split, the
type rule) stands; only the AI-tag *source* is deferred. Two findings drove this:

1. **The classifier was wrong on the flagship case.** The Unwins Bridge Rd *safety-review
   motion* — the textbook "agreed to investigate" example — was tagged `action` → `decided`,
   the exact inversion the stage exists to prevent. The deterministic type rule
   (notice-of-motion → `under-review`) gets it right. On the one case we most cared about,
   the simple rule beat the model.
2. **Re-ingest churns topic ids and destroys human links.** Re-reading rewords AI subjects,
   which re-slugs the subject-derived topic id; the old id orphans and is pruned. One run
   re-slugged ~424 of ~594 topics and deleted 37 of 96 human-confirmed subject aliases (the
   ADR 0003 "oversight trends to zero" store). The database was rolled back with D1 Time
   Travel and the stages were activated instead by `db/recompute-stages.js`, which derives
   stage from existing decisions without re-reading anything.

So `decisions.commitment` exists and `deriveStage` reads it, but it is **unpopulated** — the
type fallback decides every stage today. Before the AI tag can be revived, two prerequisites
must be met (tracked as a GitHub issue): **stable topic ids across re-reads** (don't re-slug
an existing item's topic), and a **validated action/process classifier**. Until then, do not
run `node db/ingest.js --force`; use `db/recompute-stages.js` when the derivation rule changes.
