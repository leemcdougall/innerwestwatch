# Inner West Watch — Domain Glossary

This file defines the canonical terms used across the project. Implementation details belong elsewhere.

---

## Committee

A persistent council body that holds meetings over time.

Examples: Local Transport Forum (LTF), Ordinary Council, Inner West Local Planning Panel, Flood Management Advisory Committee (FMACC).

A Committee is not a single event — it is an ongoing institution. Residents may follow a Committee to see everything it decides.

---

## Meeting

A single session of a Committee on a specific date.

A Meeting produces Documents: an agenda, attachments, and eventually minutes. Its status reflects whether minutes have been published yet.

Example: Local Transport Forum, 18 May 2026.

---

## Document

A source file the system has fetched and tracked.

Types: agenda HTML, minutes HTML, attachment HTML, attachment PDF, embedded image.

Documents are tracked so the system knows what has been ingested and can detect when new ones appear. HTML is preferred over PDF when both are available.

---

## Topic

A persistent real-world issue that residents follow. It **threads** many Decisions across meetings, item types, and committees — it is never collapsed into another row. The Local Transport Forum → Council ratification arc is a story we show, not a duplicate we hide. See ADR 0003.

A Topic has a lifespan that may span months or years. It carries:
- a canonical **Subject** (see below) — the stable name and primary linking signal;
- a **Stage** (see below) — where the issue stands right now, derived from its decisions;
- a representative type (crossing, parking, latm, report, motion, event, …);
- the **union** of suburbs and streets across all its decisions;
- a current display headline (denormalised from its latest decision).

Examples: "Leichhardt Aquatic Centre Stage 2", "South Marrickville Flood Study", "Italian Festa road closures, Norton St".

Many Decisions point to ONE Topic. The Topic carries current state; the Decisions are the evidence trail.

---

## Subject

The canonical name of the issue — the stable thing that stays the same if the item returns to a later meeting (possibly at a different committee). AI-extracted at ingest, human-confirmable.

Subject is the **primary linking signal** (ADR 0003): meeting date discriminates recurring-but-distinct instances (e.g. Italian Festa 2025 vs 2026, ~300 days apart); shared streets corroborate. A normalised form of the subject (lowercase, punctuation-stripped, stop-words removed, tokens sorted) is the key stored in the **Subject Alias** store.

---

## Decision

A single appearance of a Topic at a specific Meeting — what was decided that day. Many Decisions per Topic.

Each Decision carries its own per-appearance **headline** (plain-language summary), a raw **Outcome** (below), the resolution detail text, and a works-start date. Every Decision points to a Topic (the threading FK is not null).

Each Decision also carries a **resident sentence** (session 17): a one-to-two-sentence plain-English explanation, written by a model reading the stored `resolution`, that leads with what it means for a resident ("Nothing's changing yet — the council will investigate...") before the process. Style: impact first, jargon spelled out, per the project writing rules. This is distinct from the `headline` (a short title) — the sentence explains, the headline names.

**Where the sentence shows (session 17):** one sentence + label per Decision. On the feed/card, only the Topic's **latest** Decision (its current state). On the Topic's own page, the **full trail** — every Decision, newest first, each with its own sentence, label and date. The trail is what answers "what changed since last time?" and "did the council follow through?"; collapsing a Topic to one summary sentence would discard it.

---

## Stage and Outcome

Committee-neutral status, modelled on two axes (ADR 0004). The old LTF-specific vocabulary (`forum-yes`, `works-coming`, …) is retired.

**Stage** lives on the Topic — the lifecycle position a resident skims, derived from the most-advanced point any of its decisions reached. Six stages, each with a plain-English label a resident actually sees (draft wording, session 17):

| stage (internal) | resident label | plain meaning |
|---|---|---|
| `proposed` | Coming up | On an agenda, not voted on yet |
| `deferred` | Held over | Voted to push to a later meeting |
| `under-review` | Being looked into | Agreed to investigate and report back — nothing being built |
| `decided` | Decided | A final call was made — yes (build/adopt) or no (rejected); the outcome says which |
| `in-progress` | Underway | Work has actually started |
| `completed` | Finished | Done and delivered (defined but never derived — no end-signal in the source) |

`under-review` (resident label "Under review") sits between `deferred` and `decided`. It is the stage for a decision the council *approved* but only as a **process step** — investigate, review, prepare a report, receive or note information — not as a concrete change. It stops an "approved to look into it" motion from reading the same as "approved to build it". See **Commitment** below and ADR 0007.

`completed` is defined but not yet derived: no source signal reliably marks a works as finished (a `works_start` date is a start, not an end), so the pipeline tops out at `in-progress`.

**Outcome** lives on the Decision — the raw determination in the council's own terms: `approved`, `approved with amendments`, `refused`, `not supported`, `deferred`, `adopted`, `noted`, `contract executed`, etc. Null until a determination is recorded. A refusal (`refused`, `not supported`, `withdrawn`) reads as stage `decided` with the outcome shown alongside — a determination *was* made; the outcome says it was "no" (ADR 0004).

**Honesty rules for the resident sentence (session 17):**
- The read always gets the outcome word alongside the `resolution` text, and describes what the council *decided*, not what was proposed. For a "no", the rejection leads: "The council rejected a proposal to..." — never the proposal phrased as if it happened. (The old AI `headline` states the motion *as proposed*, so it reads as if a rejected item is going ahead; the resident sentence supersedes it on the card.)
- **When the text and the outcome word disagree** — the resolution reads as an adopted action but the outcome says "no" (e.g. the June 2026 civic-offices motion whose full text "resolves to investigate... requests a report in 4 months" is stored against outcome `not supported`; or `ltf-20apr2026-06`, text "Supported in-principle" against `not supported`) — the pass does **not** guess. It flags the Decision and shows "Outcome unclear". These cases join the null-outcome rows as the "needs the source document" pile, where issue #45 bites. **How it's detected (session 18):** the flag is *derived*, not model-judged — a contradiction is a refusal outcome word **+** a commitment read from the text **+** no refusal in the text itself (`outcomeUnclear` in `db/lib/labels.js`); the model only answers a simple extractive `text_has_refusal`. A *mixed* "no to X but yes to Y" resolution refuses inside its own text, so it is NOT flagged — it reads by its commitment (Decided for an action, per ADR 0008 decision 1). Only 2 of 651 flag. Asking the model directly whether things "matched" was tried first and over-flagged (26, mostly clean deferrals and contract awards).

**Null outcomes are never upgraded to "Decided" from the headline (session 17).** A done-word in a stored `headline` ("...approved", "...cut") is usually the *officer's recommendation* leaking from the agenda, not a recorded vote — verified against the LTF 15 Jun 2026 agenda, whose "be approved" recommendations produced "approved" headlines with no minutes ingested. The 74 null-outcome decisions split three ways by what the record actually holds:
- **Agenda only, no minutes in our data** → resident label **Coming up** (it is a proposal awaiting a vote). Fix = ingest the minutes, which for older meetings now exist on infocouncil (source re-read, #45-gated).
- **Minutes published but this item's outcome not captured** → **Outcome unclear — see the original**, queued for source re-read.
- **Confidential session / no determination recorded** → an honest note ("Discussed in confidential session" / "No decision recorded").
Because the LTF only *recommends*, the true "Decided" for its works items lands at the later Ordinary Council ratification (the LTF → Council thread, ADR 0003).

**Commitment** is the action-versus-process nature of an approved Decision: `action` (commits to a concrete change — build, install, adopt a plan, execute a contract) or `process` (commits only to investigate / review / receive / note). It is what would separate `decided` from `under-review` per decision. The intent is for the AI to tag it while reading the minutes, with `action` winning when a resolution does both.

In practice the tag was long **unpopulated**: the first AI classifier proved unreliable (it inverted the flagship case) and the re-ingest that would fill it churns topic ids and destroys human aliases, so it was deferred (ADR 0007). The type fallback filled in meanwhile: deliberative types (motion, notice-of-motion, report) → `under-review`, works types (crossing, parking, latm, …) → `decided`.

**As of the honest-label pass (designed session 17, built and run session 18):** `commitment` is populated (520 of 651) by a model that **reads the already-stored `resolution` text** — not by a re-ingest, so it does not touch topic ids or aliases (#45 does not bite). Reading the full resolution, rather than the single outcome word or a keyword rule, is what lets the model tell "approved to build it" (`action`) from "approved to look into it" (`process`). This revives ADR 0007's mechanism through a safe door. `deriveStage` already reads `commitment`; stages are still recomputed from existing decisions by `db/recompute-stages.js`, never by re-reading source documents.

---

## Entry Point

A way residents navigate into the site.

Current entry points: by suburb, by street. Planned: by Topic (follow an ongoing issue). Entry points are open-ended — new ones will be added as the site grows. The data model must support flexible lookup by any combination of suburb, street, committee, or topic.

**Street search crosses suburb boundaries by design.** A resident searching a street near a suburb border should see everything physically close to them, regardless of which suburb a given item filed it under (project vision). A topic matches a street/suburb filter if ANY of its threaded decisions touched that place.

---

## Ingestion

The process of fetching a Document from infocouncil.biz, extracting structured data from it (including the canonical **Subject** and raw **Outcome**), and writing a Decision threaded onto a persistent Topic.

Ingestion is automated and **attaches by subject**: a new item's normalised subject is looked up in the Subject Alias store. A hit threads the Decision onto the known Topic with no human prompt; a miss mints a new Topic and records an `auto` alias. Ingest only ever matches on an *exact* normalised subject — no fuzzy AI guess is baked into the source of truth. Fuzzy and cross-type links are proposed offline by the reconciliation pass and confirmed by a human (see Topic Linking).

`db/ingest.js` is the pipeline; `db/lib/topics.js` holds the shared subject/stage primitives used by both ingest and reconciliation.

---

## Issue Tracker

Open work items are tracked as GitHub Issues at https://github.com/leemcdougall/innerwestwatch/issues.

When starting a new session, run `gh issue list` to see what's open. When work is complete, close the relevant issue. Do not maintain a separate backlog file — GitHub Issues is the single source of truth for outstanding work.

---

## Topic Linking (threading)

The process of recognising that two or more Decisions refer to the same persistent issue and threading them onto one Topic. We **thread, never merge** — there is no hidden, merged-away row; there is one Topic with an ordered list of Decisions. See ADR 0003 (which supersedes the merge-based ADR 0002).

- **At ingest:** exact subject-alias match attaches automatically (above).
- **Offline reconciliation (`db/match.js`):** clusters by subject (fuzzy: subset / Jaccard ≥ 0.6), splits genuinely distinct recurrences on a date gap (> 270 days), and surfaces street-corroborated cross-type near-misses (the Bunnings LATM ↔ event case) as a review queue. It does NOT auto-merge those — a wrong link is a published falsehood.

## Subject Alias (learning, oversight → zero)

The durable `topic_subjects` store maps a normalised subject → Topic. It is how human oversight **trends to zero**: every confirmed link is persisted as an alias (`source='human'`; matcher-created ones are `source='auto'`), so the same subject never needs reviewing twice. Each ingest hits more aliases and prompts less. (This replaces ADR 0002's `dismissed_once` 18-month resurfacing, which trended the wrong way by re-asking settled questions.)
