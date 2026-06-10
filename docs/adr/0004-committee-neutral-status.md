# ADR 0004 — Committee-neutral status: a lifecycle stage plus a raw outcome

**Status:** Accepted
**Date:** 2026-06-09

## Context

The original `status` vocabulary was built for the Local Transport Forum: `on-agenda`, `forum-yes`, `forum-amended`, `forum-no`, `council-confirmed`, `works-coming`. When ingest expanded to 14 committees, `normaliseStatus` (db/ingest.js) was forced to cram every other committee's outcomes into these LTF values. The result lies:

- `deferred` is mapped to `forum-no` — but deferred is "held over for more work," not "rejected." A resident reading "not supported" about a deferred item is being told something false.
- A Council infrastructure item whose contract has been **executed** with a closure date displays as `on-agenda`. The lifecycle has run past "decided" into delivery, but the vocabulary has no word for it, so it defaults to the start.

When we asked the data "what's the latest on the Leichhardt Aquatic Centre?", every row in a clearly-progressing project read `on-agenda`. The status field actively misinforms.

## Decision

Model status on two axes.

**1. `stage` — a committee-neutral lifecycle.** One of:

| stage | meaning |
|---|---|
| `proposed` | on an agenda, no decision made yet |
| `deferred` | held over, sent back, or awaiting more information |
| `decided` | a determination was made this meeting — see `outcome` for what |
| `in-progress` | approved and works / implementation are underway |
| `completed` | delivered or finished |

Stage is what a resident skims: where does this stand right now.

**2. `outcome` — the raw, specific result.** A short free string carrying the actual determination in the council's own terms: `approved`, `approved with amendments`, `refused`, `adopted`, `noted`, `endorsed`, `withdrawn`, `contract executed`, etc. Nullable until a decision exists.

`stage` lives on the **topic** (the issue's current position, derived from its latest decision). `outcome` lives on the **decision** (each appearance recorded its own determination). This matches ADR 0003: the topic carries current state, the decisions are the evidence trail.

## Why

- **One neutral lifecycle fits every committee.** A DA, a flood study, a notice of motion, and a raised crossing all move proposed → decided → (in-progress) → completed. The five stages cover all 14 committees without per-committee enums.
- **The raw outcome keeps fidelity.** Collapsing everything to a stage would lose "refused" vs "approved with amendments." Keeping `outcome` as text preserves the specific result for display and for answering precise questions.
- **Deferred gets its own stage.** It is neither a rejection nor a fresh proposal; it loops. Naming it prevents the false "not supported" mapping.

## Consequences

- `normaliseStatus` is replaced by a mapper that returns `{stage, outcome}` from the minutes extraction, defaulting to `stage = proposed` when no minutes exist yet.
- The old `status` column values (`forum-yes`, `works-coming`, …) are migrated to `stage` + `outcome`.
- The frontend status badges map to the five stages; the raw outcome shows as detail. The LTF-specific badge labels are retired.
