# ADR 0008 — Honest labels by reading the resolution

**Status:** Accepted
**Date:** 2026-07-04
**Extends:** ADR 0004 (committee-neutral status), ADR 0007 (under-review + commitment tag)
**Relates:** ADR 0003 (LTF → Council threading)

## Context

Honesty-first (agreed in session 16) means the status a resident skims must tell the
truth. It does not today. 370 topics read `under-review` purely from the type fallback
(ADR 0007) though every one already has a recorded outcome; `outcome` is 22 uncontrolled
words plus 74 nulls; and stored `headline` values restate the motion *as proposed*, so a
rejected item reads as if it is going ahead.

ADR 0007 established that the single outcome word cannot separate "approved to build it"
from "approved to look into it" — that is why the `under-review` stage and the
`decisions.commitment` tag exist. But the commitment tag was deferred for two reasons:
the AI classifier was unreliable, and the re-ingest needed to populate it churns topic ids
and destroys human aliases (#45). Session 16 knocked out the second reason: the resolution
text is **already stored in D1**, so a pass that *reads stored text* is not a re-ingest and
does not touch topic ids or aliases. That reopens the door ADR 0007 closed.

## Decision

A pass reads each Decision's stored `resolution` and produces, per decision,
`{status, resident sentence, commitment}`:

1. **Commitment is judged by reading the full resolution, not the outcome word or a keyword
   rule.** `action` (build / adopt / execute) vs `process` (investigate / review / note).
   This revives ADR 0007's mechanism through the safe stored-text door and populates
   `decisions.commitment`, which `deriveStage` already reads. `action` wins a mixed
   resolution (understating a concrete commitment is the worse error — ADR 0007).

2. **Six resident labels**, mapping the ADR 0004/0007 stages:
   Coming up (`proposed`) · Held over (`deferred`) · Being looked into (`under-review`) ·
   Decided (`decided`) · Underway (`in-progress`) · Finished (`completed`, still unwired).

3. **A one-to-two-sentence resident sentence, impact first** (what it means before the
   process), per the project writing rules. Stored per decision, distinct from the short
   `headline`.

4. **One sentence + label per decision.** The feed/card shows the topic's latest decision;
   the topic page shows the full trail, newest first. Collapsing a topic to one summary
   sentence would discard the history that answers "what changed?" and "did they follow
   through?"

5. **A "no" reads as a "no", rejection first.** The read is given the outcome word too and
   describes what was *decided*, not what was asked. When the resolution text and the
   outcome word **disagree** (e.g. the June 2026 civic-offices motion whose text "resolves
   to investigate... requests a report in 4 months" is stored against `not supported`), the
   pass does **not** guess — it flags for a source check and shows "Outcome unclear".

6. **A null outcome is never upgraded to "Decided" from the headline.** A done-word in a
   headline ("...approved") is usually the officer's agenda *recommendation* leaking in, not
   a vote (verified against the LTF 15 Jun 2026 agenda). The 74 nulls split: agenda-only →
   Coming up; minutes-published-but-blank → Outcome unclear; confidential / no determination
   → an honest note. The real fix is fetching the minutes (a source re-read), which is where
   #45 bites.

## Why (rejected alternatives)

- **Coarse status from the outcome word alone** (the cheap `recompute-stages.js` path) was
  rejected as the whole fix: by ADR 0007's own finding it cannot tell action from process,
  so it structurally cannot make `under-review` honest. Reading is required.
- **Trusting the stored headline for status** was rejected after reading the source: headlines
  restate proposals and officer recommendations, so they read "approved" for both rejected
  motions and un-voted agenda items.
- **One summary sentence per topic** was rejected because it discards the decision trail.

## Consequences

- New per-decision stored text (resident sentence) and populated `decisions.commitment`; the
  sentence pass needs `ANTHROPIC_API_KEY` (in `.env`) and reads stored `resolution` only — no
  re-ingest, not blocked by #45.
- Coarse status/`under-review` correction where a clean outcome exists is a safe
  `db/recompute-stages.js`-style change over existing data.
- The contradiction cases and the 74 null outcomes form a "needs the source document" queue,
  gated on #45 (stable topic ids across re-reads). For LTF works items the true "Decided"
  lands at the later Ordinary Council ratification (ADR 0003), not in the LTF minutes.
