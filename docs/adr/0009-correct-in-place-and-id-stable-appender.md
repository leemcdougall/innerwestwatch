# ADR 0009 — Correct-in-place + an id-stable appender (retire `ingest.js --force`)

**Status:** Accepted
**Date:** 2026-07-04
**Relates:** ADR 0003 (persistent topics / subject threading), ADR 0008 (honest labels),
issues #45, #59, #60, #61

## Context

The automated ingest (`db/ingest.js`) couples two operations that should be separate:

- **(A) read the source** — fetch a meeting's agenda + minutes and extract decision data
  (outcome, resolution, threading).
- **(B) regenerate identity** — re-slug topic ids from AI-worded subjects and rebuild the
  alias store.

Because Haiku re-words a subject slightly on each read, (B) re-slugs topic ids and destroys
the 96 human-confirmed aliases (#45). That is why `--force` is banned and why every reshape
has felt blocked: we could not re-read source without also blowing away the topic spine.

Session 18 showed the data genuinely needs (A): the extraction has real, systematic bugs —
en-bloc / "in globo" items left with null outcomes (#59); outcome text bleeding across
adjacent items and a lost motion's `resolution` restating the defeated motion (#60); and 18
decisions attached to meetings whose minutes don't contain them (#61). But every fix that
session made — the 2 "Outcome unclear" cases read from source, the 21 backfilled outcomes,
the 12 public-forum labels — did (A) **without** (B): each updated existing rows **by id**,
never re-slugged, and it worked cleanly on live D1.

## Decision

Decouple (A) from (B). The **topic spine** — the current topic ids + the 96 human aliases —
is the canonical, human-verified anchor and is **never regenerated**. Data is produced two
ways, both id-stable:

1. **Correct-in-place sweep (one-time — the "initial load").** Re-read every meeting's source
   and correct decision-level fields — `outcome`, `resolution`, `resident_sentence`,
   `commitment`, and threading (which topic a decision belongs to) — by UPDATE-ing existing
   rows by id. This generalises `db/backfill-outcomes.js` from "fill nulls" to "re-check every
   decision against its source". A new topic id is minted only for a genuinely new subject;
   existing ids and aliases survive by construction. Agent-in-the-loop for the hard cases
   (expanding en-bloc motions, re-threading, the #61 mis-assignments).

2. **Id-stable appender (recurring — the "weekly delta").** A scheduled Claude-API pipeline
   processes only the new meeting: extract its decisions, match each to an existing topic via
   the alias store (ADR 0003), and append; mint a new topic id only for a genuinely new
   subject. It never touches prior topics, so it never re-slugs — #45 structurally cannot fire.

3. **Retire `ingest.js --force`.** The re-slugging full-ingest path is removed. The alias store
   + correct-in-place sweep + appender replace it. `db/recompute-stages.js` and the ADR 0008
   passes already follow this id-stable model.

## Why (rejected alternatives)

- **Full re-ingest / `--force`** — rejected: it re-slugs topic ids and destroys human aliases
  (#45) for no benefit a source re-read alone doesn't give. The dangerous half (regenerating
  identity) is unnecessary; only the source re-read is valuable. "Full re-ingest" was the wrong
  frame.
- **Leave the data as-is, fix only the known bugs** — rejected as the whole plan: #59–#61 are
  symptoms of systematic extraction faults, so latent errors likely remain in the ~600
  decisions not yet audited. A systematic sweep is warranted — but as correct-in-place, not
  re-ingest.
- **A fully-automated initial load** — the one-time sweep keeps an agent in the loop because the
  faults are subtle (en-bloc expansion, threading, mis-assignment) and automation alone
  reproduced them. The recurring weekly delta is small and regular enough to automate safely.

## Consequences

- Topic ids and the 96 aliases become permanently stable; **#45 is resolved by construction**
  (nothing re-slugs).
- Tooling: generalise `backfill-outcomes.js` into a full correct-in-place sweep; build the
  weekly appender (scheduled Claude-API). `ingest.js` loses its `--force` / re-slug path.
- The correct-in-place sweep is the vehicle that closes #59, #60, #61.
- The re-read fetches source but is **not** a re-ingest — it updates by id, so it is safe to run
  on live D1 (like `recompute-stages.js`). D1's 30-day Time Travel remains the safety net.
