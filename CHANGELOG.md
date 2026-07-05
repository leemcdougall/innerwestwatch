# Changelog — Inner West Watch

Entries are in reverse chronological order. Each entry covers a session or milestone, not individual commits. For commit-level detail, see `git log`.

---

## 2026-07-04 (session 18) — Honest labels end-to-end: pass, API contract, null triage (ADR 0008)

A long session that took the honest-label work from stored design to live, resident-facing data: built
and applied the ADR 0008 pass, widened `/api/items` to carry it (plus relations + images), resolved the
contradiction cases from source, and triaged the null outcomes. Sections below, newest work last.

### The honest-label pass
Built the pass ADR 0008 specified and ran it over live D1. For each of 651 decisions a model reads the
stored `resolution` (+ `outcome`, `headline`) and returns `{commitment, resident_sentence,
text_has_refusal}`; the coarse status stays derived by `deriveStage`, now fed the real commitment tag.
Test-first with the `tdd` skill.

- **New pure module `db/lib/labels.js`** (+ `labels.test.js`, 13 checks): the six resident labels
  (Coming up · Held over · Being looked into · Decided · Underway · Finished), `residentLabel`,
  `normalizeLabelResult` (guards the impure edge — commitment vocabulary, sentence cap with
  word-boundary ellipsis), and `outcomeUnclear` (the deterministic contradiction rule).
- **New pass `db/label-decisions.js`** — reads stored text only (not a re-ingest, so #45 does not bite).
  Flags: `--dry-run`, `--sample` (4 traps + spread), `--limit N`, `--ids a,b,c`. Batches of 15 to Haiku.
- **Migration `0008-decision-resident-sentence.sql`** — adds `decisions.resident_sentence` and
  `decisions.outcome_unclear`; both additive and default-safe.
- **`db/lib/topics.js`** — exported `isRefusal` so the pass and the stage rule share one refusal
  definition (no drift).

### The over-flagging fix (the part worth remembering)
The first full run flagged **26** decisions "Outcome unclear" by asking the model whether text and
outcome word "match" — noisy: it flagged clean deferrals, contract awards, and condolence motions.
Reading the sources showed the genuine signal is deterministic: a contradiction is a **refusal outcome
word + a real commitment + no refusal in the text itself** (`outcomeUnclear`). The model now answers a
simple extractive question (`text_has_refusal`) and the flag is derived, not guessed. That dropped 26 →
**2 genuine cases** (civic-offices `council-16jun2026-38`; `ltf-20apr2026-06`, whose text reads
"Supported in-principle" against a "not supported" outcome) and, per Lee's "action wins a mixed
resolution" ruling (ADR 0008 decision 1), reads mixed "no to X but yes to Y" decisions as **Decided**
with a sentence covering both.

### Live data after the run
594 topics / 651 decisions unchanged. Stage split moved from `under-review 370 / decided 138` to
**decided 347 · under-review 161 · proposed 52 · in-progress 25 · deferred 9** — the type-fallback
over-count ADR 0008 targeted is corrected by reading the actual text. 651 resident sentences, 520
commitment tags, 2 "Outcome unclear".

### `/api/items` contract widened (now serves the honest data)
Three additive passes over `functions/api/items.js`, each verified on a Cloudflare preview deploy before
merging (the cross-dir import of `db/lib/labels.js` bundles fine in the Pages runtime):
- Each **decision** now returns `residentSentence`, `commitment`, `outcomeUnclear`, and a derived `label`
  ("Outcome unclear" or the six-word lifecycle label); each **topic** returns a `label` mapping its stage.
  Vocabulary imported from `db/lib/labels.js` — one source of truth, no copy in the frontend.
- Added **`relations[]`** (linked topics + direction: parent/child/related/supersedes/superseded-by) and
  **`images[]`** (infocouncil diagram URLs) — the last documented contract gap. 146 relation-links, 680
  images now served.
- Fixed two **`schema.sql` drifts**: `decisions.resident_sentence`/`outcome_unclear` (migration 0008) and
  `topic_relations` (migration 0004) were never mirrored into schema.sql.

### The 2 "Outcome unclear" cases — resolved from source
Read the actual infocouncil minutes for both, as Lee asked. Both were real data bugs the flag correctly
caught, not false alarms: civic-offices (`council-16jun2026-38`) was **Motion Lost 13–2** (outcome "not
supported" is right; the `resolution` field just restated the defeated motion) → now **Decided**;
Norton/Lapish (`ltf-20apr2026-06`) was a **mis-extraction** — the source recommends "supported
in-principle" but "not supported" bled in from the previous item → now **Being looked into**. Live data
now has **0 "Outcome unclear"**. Two systemic ingest bugs noted for #45 (lost-motion resolution text;
adjacent-item outcome bleed).

### Null-outcome triage (74 → 53, 35 of those now honest)
- **`db/backfill-outcomes.js`** (new tool) reads a meeting's published minutes and recovers outcomes the
  per-item ingest skipped (mostly items adopted "in globo"). **Filled 21**; #45-safe (updates rows by id).
- **`RAISED_LABEL` "Raised at public forum"** — 12 community-address items (residents speaking, no vote)
  no longer read a false "Coming up". 23 agenda-only nulls correctly stay "Coming up".
- Found a **data-integrity bug**: 18 items are tagged to meetings whose minutes don't contain them
  (verified content absent). Not a missing outcome — a separate dig, likely #45-adjacent.

### Prototype (design input, kept)
`prototype-topic-card.html` (local, not shipped) — three card/trail layouts on live data. Lee picked the
**status-rail-ledger**; verdict + follow-ups (no content repetition; colour-blind accessibility) captured
in `memory/design.md`. Frontend build itself is on hold.

### Issues opened
- **#59** — minutes ingest skips items adopted "in globo" / in grouped resolutions (null-outcome root cause).
- **#60** — extraction fidelity: lost-motion `resolution` restates the defeated motion; adjacent-item outcome bleed.
- **#61** — 18 decisions tagged to meetings whose minutes don't contain them (data-integrity).

### Not done this session (next steps)
- The **18 "not in their minutes"** decisions (#61 — data-integrity dig).
- Colour-blind accessibility for the chosen card layout, before any frontend build.
- The frontend rebuild (Milestone 7) remains on hold.

---

## 2026-07-04 (session 17) — Honest-label design locked (ADR 0008)

A grilling session (`grill-with-docs`), no schema or pipeline code. Turned session 16's honest-label
approach into a fully specified design, stress-tested against real data, and captured it as **ADR 0008**
plus inline `CONTEXT.md` updates. Six decisions locked:

1. **The read judges commitment (`action` vs `process`) itself** and drives the badge — reviving ADR
   0007's deferred tag through the safe stored-text door (reading stored `resolution` is not a re-ingest,
   so #45 does not bite). Both reasons 0007 deferred it are now gone.
2. **Six resident labels:** Coming up · Held over · Being looked into · Decided · Underway · Finished.
3. **Resident sentence: one-to-two sentences, impact first** (writing rules), stored per decision.
4. **One sentence + label per decision** — latest on the card, full trail on the topic page (shown with a
   real six-appearance example, the Leichhardt Aquatic Centre, every one recorded as "noted").
5. **A "no" reads as a "no", rejection first;** when resolution text and outcome word disagree, flag
   "Outcome unclear", don't guess (real case: June 2026 civic-offices motion).
6. **Nulls never upgraded to "Decided" from the headline.** Proven by *reading the source*: the LTF
   15 Jun 2026 agenda's "be approved" recommendations produced "approved" headlines with no vote. The
   74 nulls split three ways (agenda-only → Coming up; minutes-blank → unclear; confidential → honest
   note). The 15 Jun minutes now exist on infocouncil — that meeting is stale, ingested before its
   outcomes were published.

### Method note
Reading the actual infocouncil source (not just stored fields) overturned two of my own recommendations
mid-session — the "trust an approved headline" shortcut was wrong, and the civic-offices "rejection" is
actually a text-vs-outcome contradiction. Honesty-first applied to the design process itself.

### Docs
- New `docs/adr/0008-honest-labels-by-reading-the-resolution.md` (+ MAP row; 0007 marked extended).
- `CONTEXT.md`: Stage table with resident labels; resident-sentence definition; sentence granularity;
  honesty rules for rejections, contradictions, and null outcomes.

---

## 2026-07-04 (session 16) — Middle layer reframed around resident questions; honesty first

A thinking session, no code or schema changes. Widened the reading pile, then Lee asked whether the
whole approach was wrong given the scope has changed a few times. It reshaped how we think about the
middle layer. Everything below is direction, captured in `memory/direction.md` and `memory/status.md`
(no ADR yet: the reshape is agreed in principle, not locked to an implementation).

### Widened the reading pile
- Pulled raw stored content (topic headline, stage, decision headline/outcome/resolution/commitment)
  across the types not seen in session 15: development/VPAs, road closures + events, condolences,
  petitions, financial/governance reports.
- Confirmed at scale what session 15 saw on a small pile: `resolution` is three things wearing one
  label (already-plain / raw council-speak / empty). `outcome` is 22 uncontrolled words + 74 nulls.
  Self-contradicting records (Italian Festa has three different dates; VPA "67 Victoria Road" whose
  text describes 186).
- The stage finding, quantified: **all 370 `under-review` topics already have a recorded outcome** —
  none are genuinely pending. This is the documented type-fallback (deliberative type → under-review,
  ADR 0007), but it reads to a resident as "not yet decided" when the council actually noted/adopted it.

### The reframe (the substance of the session)
- **Residents ask several distinct questions**, and the middle layer's job is to answer each honestly:
  what's changing at a place near me / what did the council decide or spend / **what's the story with X
  over time** (follow a subject) / what can I have a say on / did they follow through / what's coming up.
- **The followable-subject model already exists on paper** (CONTEXT.md Topic, ADR 0003) **but the data
  does not deliver it.** The Leichhardt Park Aquatic Centre is stored as ~8 topics across ~11 meetings
  because each appearance has a different subject; subject-matching can't join them. The unit a resident
  wants to follow sits a level above the current topic: a real-world entity/project/place grouping many
  topics. That is the real "connection" half of the middle layer.
- **Honesty first (agreed).** Two faults: unreliable status/outcome (fix first, contained, no re-read),
  and self-contradicting frozen extractions.
- **Home page = both search and a followable feed** (settled). What fills the feed is parked for its own
  session (`memory/home-page-feed-question.md`).

### Honest labels: approach decided + tracer bullet run
- **Decided (via `memory/honest-labels-demo.html`):** the honest resident label can NOT be a lookup
  from the single outcome word. Real matters prove it — "noted" hid the adoption of the whole $164.7m
  2026/27 budget; "approved" often meant approved-to-go-to-exhibition; a "not supported" item's stored
  text reads like a plan to do the thing (the text is the motion as proposed, not the rejection).
- **The fix is two halves:** coarse status (decided/deferred/awaiting) from the outcome word + null
  check (safe recompute); the resident sentence from the model READING each stored resolution.
- **Key unlock:** the resolution text is already in D1, so the label pass reads stored text and does
  NOT re-ingest — it is *not* blocked by #45. Only the ~74 null/contradictory resolutions need the
  source doc (triage: a headline with a done-word = capture gap, not pending).
- **Tracer bullet run (in-conversation, 12 varied real matters):** reading the resolution caught every
  trap a word-lookup would misprint (budget, office-merger, endorsed-is-step-one). Bonus finding: one
  read yields THREE outputs at once — status, sentence, and the action-vs-process `commitment` tag
  (ADR 0007, currently unpopulated). Real-pass shape: per decision, `resolution` → `{status, sentence,
  commitment}`.

### Artifacts
- `memory/project-state-explainer.html` — interactive one-page explainer of where the project is at.
- `memory/honest-labels-demo.html` — interactive demo of real matters: why one-word labels mislead +
  the null-outcome triage.
- `memory/home-page-feed-question.md` — the parked home-page-feed design question.
- (all three gitignored working notes; built from live D1, open in browser)
- New sequencing in `memory/status.md`: honesty → re-ingest safety (#45) → entity/project grouping →
  API contract → frontend rebuild.

---

## 2026-07-01 (session 15) — Repo made self-describing; project memory consolidated

Started on the middle layer, hit a structural problem, fixed the structure first.

### Middle-layer grounding (started, not finished)
- Confirmed the plan: **gather many real resident-text examples before drafting a voice.**
- Pulled the raw stored content for the Ashfield/Camperdown parks topic and a type-diverse
  pile (crossings, trees, parking, governance, community). Key finding: the stored
  `resolution` text is **three different things wearing one label** — already-plain,
  raw council-speak, and empty/self-referential — plus live headline-vs-stage contradictions.
- Left here: widen the pile across the unseen types (DAs, closures, events, petitions,
  financial reports, condolences) before drawing any voice conclusions.

### The structural fix (commit `5df8a73`)
- Root cause of a mid-session mistake (assuming the project was 17 items when D1 holds 594):
  the top-level file **duplicated** a fact from below instead of pointing at it, so it went
  stale as the data grew.
- **`MAP.md` per directory** (root, db, db/lib, db/migrations, functions, docs/adr, app,
  meetings) — each names its contents and points down. Detail lives at one level.
- **`CLAUDE.md` rewired** — points at `MAP.md` instead of duplicating the tree; "17 items"
  framing removed; session-start now runs a live D1 count query (scale read from source, not
  a doc). Memory + Session-logging sections updated.
- **Project memory consolidated into the repo's (gitignored) `memory/` folder** — 25
  scattered harness files → 10 lean files (status, direction, design, conventions,
  research-workspace, infra + 3 reference files), browsable via `memory/MAP.md`. The harness
  store keeps only 8 genuinely cross-project memories. Two homes, one job each.
- Two rules baked in everywhere: **point-don't-duplicate**, and **a structural change updates
  the MAP at its level + the parent's one-line hook.**
- The POC "ask questions about the database with new info" now has a documented home:
  `memory/research-workspace.md`, including the two-tier scope rule (public site = IWC only;
  personal-research artifacts never committed).

---

## 2026-07-01 (session 14) — Priority reframed to the middle layer; API-contract gap found

Started as frontend polish, became a priority correction. No merges to beta/main.

### Frontend M7 slice (WIP, parked on `claude/m7-frontend-slice`, commit `3d6e2b0`)
- `index.html`: suburb sidebar rebuilt — grouped by Inner West Council ward using the
  recognisable suburb names (Balmain/Stanmore/Ashfield/Leichhardt/Marrickville). Desktop:
  sticky, internally scrollable, collapsible accordion **collapsed by default**. Mobile:
  flat horizontal chip scroller (collapse doesn't apply). Ashfield & Annandale straddle two
  wards → listed in both. "Other areas" bucket for non-IW / data-artifact names.
- Fixed a real bug: nested `auto-fill` grid needed `minmax(0, 1fr)` to stop mobile
  horizontal overflow. Verified at 1280px and 375px via the preview server.
- `topic.html` + `app/{iw.css,iw.js,follow.js}` from prior work also committed as WIP.

### Priority reframing (memory `middle_layer_priority.md`)
- The real priority is the **middle layer** — resident-facing text + how issues link
  together. The frontend wraps around it. But the two are intertwined: the frontend
  redesign is what surfaced the missing middle, so expect to iterate back and forth.

### The API-contract gap (the "backend isn't done" finding)
- `functions/api/items.js` serves topics + `decisions[]` but **not** `topic_relations`
  (73 rows live) or `images` (680 rows live) — both already populated in D1, verified via
  `wrangler d1 execute --remote`. Two of the three stubbed topic-page sections are data
  stranded one query away from the page. The Related-issues stub **is** the linking half of
  the middle layer.
- Oversight/risk section (issue #42) has no stored data — genuinely unbuilt, needs design.
- Next session: plan the middle layer; as its first concrete piece, widen `/api/items` to
  serve `relations[]` and `images[]`. Handoff: `/tmp/handoff-middle-layer-planning.md`.

---

## 2026-06-29 (session 13) — `under-review` stage; AI re-ingest attempted, reverted, shipped via type rule

Fixed the backend bug where a topic read `decided` when council had only approved an
*investigate/report-back* motion (the badge overstated progress on ~321 of 594 topics).
Grilled the design with Lee in plain language (ADR 0007).

### Shipped
- **New `under-review` stage** between `deferred` and `decided` (resident label "Under
  review"). `stageRank`/`deriveStage` reshaped in `db/lib/topics.js`; refusals stay
  `decided` (ADR 0004 preserved); `completed` stays unwired. New no-dep `node:assert` test
  (`db/lib/topics.test.js`, 16 checks) + `npm test`.
- **`decisions.commitment` column** (`action`|`process`) added to `schema.sql` + migration
  0007, applied live. `deriveStage` reads it, falling back to item type when absent.
- **`db/recompute-stages.js`** — recomputes every topic's stage from existing decisions via
  the real `deriveStage`, no source re-read. Activated the fix: 321 topics decided →
  under-review, nothing else moved. Canonical Unwins Bridge Rd safety-review motion now
  reads `under-review`.

### Attempted, then reverted (ADR 0007 update)
- Ran the full in-place AI re-ingest (`--force`) to populate `commitment`. It was unreliable
  (tagged the flagship Unwins motion `action` → `decided`, the exact inversion) and corrosive
  (rewording re-slugged ~424 of 594 topic ids, pruning 37 of 96 human-confirmed aliases).
- **Recovered via D1 Time Travel** rollback to the pristine pre-session state (594 topics,
  96 human aliases, 0 orphans), re-applied migration 0007, activated via `recompute-stages.js`.
- Fixed a real bug found en route: `pruneOrphans` deleted topics before their FK children
  (D1 *does* enforce foreign keys over REST), aborting the run. Now deletes
  relations/images/aliases first.
- **AI `commitment` tagging deferred** — column + code stay dormant; type fallback is the
  active mechanism. Do not run `--force` until topic ids are stable across re-reads.

### Issues
- Opened [#45](https://github.com/leemcdougall/innerwestwatch/issues/45) — re-ingest churns
  topic ids / destroys human aliases; prerequisite for reviving AI commitment tagging.

### Item #2 (missed minutes) — not pursued
A full re-ingest would have measured/closed it as a side effect, but re-ingest is shelved.
Re-evaluate once topic-id stability (#45) lands.

---

## 2026-06-28 (session 12) — Data-quality merge pass + leave-as-is cluster review

Worked the session-11 "13 remaining unresolved" backlog with Lee in plain language. The
13 broke into TWO kinds, not one: genuine duplicate splits (merge) and generic labels
spanning genuinely-distinct matters (leave). Went through every cluster against the
infocouncil source documents (`feedback_verify_merges_against_source`).

### Four clear merges applied (migration 0006, live D1 --remote; 600 → 594 topics)
Each was the reingest minting a separate topic per appearance of one recurring matter.
Confirmed against the source doc (not the D1 headline) before merging:
- **Return and Earn** recycling at council venues/events — Dec 25 / May 26 / Jun 26 → one
  topic, stage decided, 3 decisions.
- **Supporting Visual Artists and Writers — affordable creative spaces** — Feb / Mar / May
  26 → one topic, 3 decisions (places unioned; "Railway Rd"/"Railway Road" deduped).
- **Seniors Morning Teas to Celebrate the GreenWay** — Feb / Mar 26 → one topic; both
  minutes carry the identical item title. (Distinct from the broader "Expansion of Seniors
  Morning Teas program", left separate.)
- **Design Excellence LEP Amendment Clause 6.9** — May deferred → Jun report → one topic;
  the June agenda cites back to "C0526(1) Item 2" and Clause 6.9.
- Mechanics mirror migration 0003 (repoint decisions/images/aliases, promote loser subject
  aliases to `source='human'`, recompute stage/places/span, drop empty losers). Verified
  0 orphan decisions, 0 dangling aliases. Pre-merge row snapshots saved to `backups/`.

### Four "leave as is" clusters reviewed — confirmed NOT duplicates
- **InnerWest@40 speed limits** (Areas 1,2,11 vs 4,9,10) — two real area batches of one
  program. Left as two topics but **linked `related`** (one new row, via human-relations.json
  + `apply-relations.js --apply`; topic_relations 72 → 73). Areas 1,2,11 already threaded its
  May+Jun appearances correctly.
- **Audit, Risk & Improvement Committee minutes** (5 topics) — separate governance filings
  (investments, audited accounts, legal/risk, business continuity). No street-level content;
  left fully separate, no links. Filed **issue #42** (surface oversight/risk context on
  capital-project topic pages — a frontend/Milestone-7 display concern, not stored relations).
- **Fire & Rescue NSW reports** (7 topics) — each a different batch of buildings. Left
  separate and deliberately NOT linked (different addresses); existing street tags already
  let street search surface the right one.
- **"Victoria Road"** (4 topics) — two physically different roads (Rozelle planning agreements
  vs Marrickville traffic works). Left separate; the generic label was exactly why blanket
  linking by shared street name is unsafe.

### Net
600 → 594 topics; topic_relations 72 → 73; human-relations.json 100 → 101 links; 1 new
GitHub issue (#42). The honest residue of the original 13: the genuine duplicates are now
merged; the rest were never duplicates and are correctly left distinct.

## 2026-06-25 (session 11) — Relations review loop: resolution lifted 38 → 73/100

Worked the human-review backlog the unresolved report exists to drive. For each of the 54
subjects the session-9 reingest re-slugged out of reach, found the live topic it should map to,
**verified the mapping against the infocouncil source document** (not the D1 headline), and wrote
a confirmed `source='human'` alias so the link resolves by exact match forever after.

### New: `db/relation-subject-aliases.json` + `db/apply-subject-aliases.js`
- `relation-subject-aliases.json` is the durable, version-controlled record of the human
  judgements (ADR 0006: git holds the irreplaceable judgement; D1 holds the rebuildable
  projection). **41 `mappings`** (subject → topic, each with a source-doc ref in the note) and
  **15 `leave`** entries (subjects deliberately left unresolved — a generic phrasing with no single
  valid topic, or a matter the reingest split into near-duplicate topics; forcing a match would
  publish a falsehood).
- `apply-subject-aliases.js` upserts those 41 verified aliases plus pins **49 currently-fuzzy
  hits** as sticky `source='human'` aliases so the whole resolved set survives the next reingest
  (approved this session). Guards: aborts if any mapping points at a topic id no longer in D1;
  subjects with an existing exact alias are left untouched. Reuses `db/lib/topics.js` `normKey`.

### Source verification (the hard rule, `feedback_verify_merges_against_source`)
- Fetched **3 infocouncil documents** (curl with a browser UA — the site 403s the default agent):
  16 Feb 2026 LTF minutes (`LTF_16022026_MIN_4282`), 20 Apr 2026 LTF minutes
  (`LTF_20042026_MIN_4284`), 26 Nov 2025 Flood Mgmt Advisory Cttee agenda (`FMACC_26112025_AGN_4221`).
- **Caught a wrong fuzzy hit inside the existing 38:** the umbrella subject "Local Transport Forum
  recommendations" fuzzy-matched (0.80) the **October** batch topic, but its 17 children are
  exactly the **16 Feb 2026** LTF items 1-17 (adopted at council 17 Mar). Corrected via an
  overriding alias → `topic-local-transport-forum-meeting-february-2026`. Had the 38 been aliased
  blind, this falsehood would have been locked in. The other two LTF umbrellas verified: "…raised
  crossings and cycleways" = 20 Apr batch (items 1-7), "…May 2026" = 18 May batch.
- FMAC source confirmed the two flood items: "Illawarra Road pipeline — Hill & Thornley Streets" →
  `topic-illawarra-road-flooding-review`, "Osgood Avenue stormwater drainage" →
  `topic-review-of-flooding-on-osgood-avenue`.

### Applied to live D1
- 90 `source='human'` aliases written (`topic_subjects` now 690 aliases, 90 human).
- `apply-relations.js --rebuild`: **73 of 100 resolved** (41 parent-child + 31 related),
  **14 self-collapsed** (both subjects now thread to one topic — correct), **13 unresolved** across
  15 subjects (all the documented `leave` set). Up from 38 resolved / 2 self-collapsed / 60
  unresolved. `topic_relations` 38 → 72 rows; **0 dangling relation refs, 0 dangling aliases.** The
  13 remaining are the honest ceiling for this pass — generic phrasings and data-quality splits
  that would need a topic merge, not an alias.
- Did **not** loosen the fuzzy threshold in `db/lib/topics.js` (would risk false links pipeline-wide);
  every gain came from confirmed aliases.

## 2026-06-21 (session 10) — Re-runnable relations apply step; orphan-prune folded into ingest

Built the piece ADR 0006 named as next: a re-runnable step that materializes the 100
subject-keyed human links back into `topic_relations` against the *current* topic ids, so a
human never re-confirms a link after a reingest.

### New: `db/apply-relations.js`
- Reads `db/human-relations.json` (100 links keyed by subject pair). For each subject, resolves
  to the current topic id: **exact `normKey` hit in the `topic_subjects` alias store**, then a
  **fuzzy `sameSubject` fallback** (highest-Jaccard match; an ambiguous tie is refused, not
  guessed — a wrong link is a published falsehood). Reuses the shared primitives in
  `db/lib/topics.js` so subjects normalize identically to ingest/match.
- Emits idempotent `INSERT OR IGNORE INTO topic_relations`. Directionality per migration 0004:
  `parent-child`/`supersedes` keep A→B order; `related` is stored with `topic_a < topic_b` by id
  so the row is stable across id churn. `created_at` is preserved from the JSON (the original
  human-decision date, not now). Batches of 16 rows (D1 caps bound params at 100; 16×6 = 96).
- Flags: `--dry-run` (default, prints + writes nothing), `--apply` (additive), `--rebuild`
  (delete `source='human'` rows then re-insert — guarded to abort if zero resolve, never wipes
  the table on a resolver bug), `--self-test` (5 resolver unit checks via `node:assert`, no deps).
- Prints an **unresolved report** — the deduped set of subjects that no longer resolve. That set
  is the only thing a human reviews and it shrinks as aliases get confirmed (trend-to-zero,
  applied to relations).

### Applied to live D1
- First apply against the session-9 reingest's re-slugged 600-topic set: **38 of 100 resolved**
  (26 parent-child + 12 related), 2 self-collapsed (both subjects now thread to one topic), 60
  unresolved across 54 unique subjects. Verified: idempotent re-run inserts 0; 0 dangling topic
  refs. The low count is expected, not a bug — it's the first pass against a heavily re-slugged
  set with a thin alias store (≈1 alias/topic), and the fuzzy bar stays high on purpose. The 54
  unresolved subjects are the human-review backlog; confirming them as aliases lifts the next run.
- Migration `0005` (id-keyed populate) is **not** run — stale ids, superseded by this script.

### Ingest hygiene: orphan-prune folded in (`db/ingest.js`)
- `pruneOrphans()` now runs at the end of every ingest (full-scan and single-meeting). Deletes
  topics with no decisions (the re-slug orphan), then the aliases and images that would dangle —
  so the alias store can't resolve a subject to a dead topic. The orphan check is global, so
  partial/single-committee runs never delete a topic that still has decisions elsewhere.
  `topic_relations` is left to `apply-relations.js --rebuild` (it's a derived projection).
- Previously this lived only in a hand-run migration, so reingests accumulated stale topics.

---

## 2026-06-21 (session 9) — Fix the ingest regression that wiped LTF/FMAC; restore coverage; verify fidelity

Worked the backend-to-90% plan. The headline find: the "cross-ref-leak fix" (branch `claude/fix-ingest-cross-ref-leak`, never merged) had silently broken every multi-letter committee, which is what actually lost the LTF and FMAC data on 14 June — not a partial run.

### Root cause (diagnosed against live source agendas)
- The cross-ref fix added a strict per-meeting `refPrefix` filter (`^LTF0526(...)`) to `splitHtmlByItems`. That exposed a latent bug in the item-boundary split: the greedy `[A-Z]+` satisfied the lookahead at **every** letter of a multi-letter prefix, so `String.split` fired before L, T **and** F of "LTF0526" and each content section started at the last letter (`F0526(1) Item 1`). The strict filter then matched nothing → **0 items for every multi-letter committee** (LTF, FMACC, ILPP…). Single-letter "C" (Council) was immune, which is why only Council survived 14 June.
- The flagship `ltf-18may2026` had a second failure: 17 image-heavy items in one request exceeded Claude's ~32 MB body cap → `413 request_too_large`. The existing caps were on item/image **count**, not bytes.

### Fixes (db/ingest.js)
- `ITEM_BOUNDARY`: anchor the split with a negative lookbehind `(?<![A-Z])` so it fires only at the true start of the ref code. LTF/FMAC extract again.
- Batch by request **bytes** (`MAX_REQUEST_BYTES` 18 MB), not just image/item counts. The Tempe LATM agenda now splits into 3 batches and writes all 17 decisions.
- Folds in the cross-ref `refPrefix` filter (keeps another meeting's deferred items from leaking in) plus the in-flight fidelity work: 20-item-per-call cap + `max_tokens` 8192 (stops truncated-JSON item mislabeling) and per-meeting try/catch isolation so one bad agenda can't abort a run and silently drop later committees.
- `db/match.js`: drop the `slice(0,20)` cap on link-suggestion printing.

### Corrective reingest + verification
- Backed up live D1, then ran `node db/ingest.js --months 12`. Coverage restored: **council 14 / ltf 10 / fmac 4 / public-forum 5 = 33 meetings, 651 decisions, 600 topics, 0 orphans.** All 14 committees are scanned every run; the other 10 genuinely have no meetings in the window.
- **Item-number fidelity confirmed fixed.** All 6 session-7 mismatches now match the live source agendas (verified against raw `C0526`/`C0626` ref codes, not just D1 headlines): St Peters (Jun 16), Robyn Webster (May 10), Centenary Park (May 5, no phantom item 50), Renwick fire (May 25), Wran plaza (May 8), Investment split (Feb 17 property + 26 cash).

### Relations: preserved subject-keyed, not re-materialized (ADR 0006)
- The 100 Milestone-6 `topic_relations` key on topic id — the one thing reingest churns — so the 14 June reingest wiped them (0 rows) and migration 0005's id-keyed `INSERT`s no longer resolve. Rescued all 100 into **`db/human-relations.json`**, keyed by **subject pair** (slug-immune), 0 unresolved. Materializing back into D1 is deferred until the data stabilizes / the frontend needs them (relations aren't served by the API yet). ADR 0006 makes the table *derived* and the subject-keyed JSON the *source*; the re-runnable `subject → current topic id` apply step is the next relation task.

### Housekeeping
- Gitignored `backups/` and `review/` (large, regenerable; the human work was rescued into `db/human-relations.json` first). Reverted a stray regenerated `db/migrations/0002-thread-backfill.sql`. Noted legacy `merge_decisions`/`topic_merge_log` as drop candidates.

---

## 2026-06-13 — Milestone 6: comprehensive link pass over all 285 topics

Exhaustive review of every topic to find links and touchpoints, building a human-confirmed base so future ingest can recognise how this council's issues connect. 8 agents clustered candidates by shared local streets and argued each to a recommendation; the 7 high-stakes calls (5 merges, 2 supersedes) were re-verified by Sonnet agents against the infocouncil source documents.

### New relation model (ADR 0005, migrations 0004 + 0005, applied --remote)
- `topic_relations` table (migration `0004`) holds non-merge connections: `parent-child`, `related`, `supersedes`. `merge` is deliberately not a relation kind — confirmed same-issue links go through threading.
- Migration `0005` wrote **100 human-confirmed relations** (43 parent-child, 57 related). Source-verified reclassifications from the raw candidate set:
  - **Australia St parklets**: merge → **parent-child** (Council resolution is the parent over the LTF traffic approval — same scheme, two governance steps).
  - **Curtis/Darling crossing**: supersedes → **related** (confirmed two *different* crossings, Design Plan 10313 on Darling St vs 10390 on Curtis Rd).

### No merges applied — every merge candidate hit a data error
The verify pass found the same disease as St Peters: D1 item numbers that don't match the source agendas. All five merge candidates were rejected or routed to the ingest investigation:
- **Robyn Webster** — item 30 on `C_19052026` is a Marion St notice of motion, not the sports centre.
- **Centenary Park** — item 50 doesn't exist (the agenda ends at item 40).
- **Renwick St fire** — June item 25 is the "29 Damun Inclusive Playground (Camperdown Park)" tender, not the fire matter (the supersedes candidate was dropped).
- **Balmain/Wran** — May "Wran Square plaza" is stored as item 22, but item 22 is "Supporting Visual Artists and Writers"; the real plaza item is item 8. The May decision + its 5 images may belong to the wrong item, so the merge is unsafe until re-ingested.
- **Investment** — "Investment report" mixes a property report (Feb item 17, real estate) with cash reports; needs a split, not a merge.

These five join the St Peters parklands topics on the ingest data-quality investigation. First-round ingest clearly didn't go deep enough — item-number fidelity needs a second pass.

### Artifacts
- `review/links.html` — standalone review of all 106 candidate links (untracked, for Lee).
- `docs/adr/0005-topic-relations.md` — the relation-model decision.

---

## 2026-06-10 — Milestone 6: human review pass of cross-type link suggestions

Reviewed the matcher's street-corroborated cross-type suggestions (separate topics sharing a suburb + 2+ streets) and confirmed/rejected each against the actual infocouncil source documents. Four sub-agents read the agendas/minutes in parallel so calls were grounded in the source text, not guessed from headlines — which mattered: my initial "strong match" guess on Curtis/Darling was wrong.

### Confirmed and applied (`db/migrations/0003-human-review-merges.sql`, applied --remote)
- **Bunnings Tempe** — merged "Traffic calming works near Bunnings Tempe" (latm, 16 Feb, Item 13) + "Bunnings LATM temporary road closures" (event, 18 May, Item 4). The May agenda explicitly cites the Feb Item 13 approval; the closures construct the adopted design. Canonical = the LATM works topic; stage now `in-progress` (works_start 2026-07-06), span Feb–May.
- **Unwins Bridge Rd, Tempe** — merged "Pedestrian safety review — Unwins Bridge Rd & Hillcrest St" (notice-of-motion, 17 Feb, Item 37) + "raised pedestrian crossing upgrade" (crossing, 15 Jun, Item 18). The Feb motion directed a review of this crossing and to report to the LTF within 3 months; the June item is that review. Canonical = the crossing topic; span Feb–Jun.
- Each confirmed link repointed decisions+images, repointed its subject alias to the canonical topic and promoted it to `source='human'`, and dropped the orphan topic. Result: 287 → 285 topics, 0 orphan decisions/images/aliases, 2 human aliases.

### Rejected (kept separate)
- **Curtis Rd / Darling St, Balmain** — two *different* crossings on different legs of the intersection (Design Plan 10390 on Curtis Rd vs 10313 on Darling St; different parking impacts; B adds roundabout works; no cross-reference).
- **St Peters / WestConnex parklands** — not threaded. The three D1 topics do **not** match the real 16 Jun 2026 Council agenda (real Item 16 is a contamination *report*, Items 24/30 are unrelated confidential items). Looks like an ingest extraction/numbering error. Flagged as a separate investigation task — not a threading decision.

### Known limitation surfaced
- `deriveStage` (max rank across decisions) reads the Unwins Feb motion's "approved" outcome as `decided`, even though the crossing works themselves are only proposed. Not overridden (the next ingest run would recompute the same value); the fix belongs in the staging logic, tracked for later.

---

## 2026-06-10 — Persistent topics by subject threading + committee-neutral status

The big rebuild of the topic layer. "Topic" as a persistent issue never actually existed in the data — ingest minted one isolated topic per item (357 items = 357 topics), and the old dedupe tool only linked same-type, shared-street pairs. Asking "what's the latest on the Leichhardt Aquatic Centre?" returned 10 disconnected rows all reading "on-agenda". Now it returns one topic, `stage=decided`, with a 10-decision evidence trail Feb→Jun 2026.

### Scope change (recorded here so future sessions don't revert to the old framing)
- Transport-only was the easy-win test case. Scope is now **every committee, every kind of issue**. The full 14-committee ingest was intentional reconnaissance.
- Street search **crosses suburb boundaries** ("what's close to me", border residents).
- **Infrastructure first**: get ingest + threading right before rebuilding the frontend.
- Human oversight must **trend to zero** — every confirmed link is learned, never re-asked.

### What changed
- **ADR 0003** (persistent topics by subject threading, learning matcher) — amends/supersedes ADR 0002. We thread, never merge.
- **ADR 0004** (committee-neutral status) — `stage` on the topic + raw `outcome` on the decision; retires the LTF-specific status vocabulary.
- **Schema** — `migrations/0001-topic-threading.sql` (applied): `topics.subject/stage/first_seen/last_seen`, `decisions.headline/outcome`, new `topic_subjects` learned-alias store. `migrations/0002-thread-backfill.sql` (applied): threaded the 357 decisions into 287 topics.
- **`db/match.js`** (new, supersedes `db/dedupe.js` which was removed) — offline reconciliation: subject clustering (fuzzy subset/Jaccard ≥ 0.6), distinct-recurrence split on >270-day gap, street-corroborated cross-type review queue (never auto-merges). Backfill result: 287 topics, 45 thread 2+ decisions, 287 auto aliases.
- **`db/ingest.js`** — rewritten write path: extracts canonical `subject` + raw `outcome`, attaches-or-creates topics via `topic_subjects` (exact alias match, no fuzzy guess in source of truth), upserts topics in place (FK-safe), recomputes stage + union streets/suburbs from full decision history.
- **`db/lib/topics.js`** (new) — shared `normKey`/`slug`/`sameSubject`/`deriveStage` used by both ingest and match, so a subject normalises identically in both.
- **`functions/api/items.js`** — now serves one object per **topic** with its `decisions[]` history, neutral `stage`, union places. Dropped the retired `canonical_topic_id` filter.
- Docs rewritten top-down: CLAUDE.md, GOALS.md, CONTEXT.md.

### Verification
- Live DB after backfill: 287 topics / 357 decisions / 287 aliases, **0 orphan decisions or images**.
- Stage derivation: decided 161 / proposed 115 / in-progress 11. Leichhardt Aquatic Centre = `decided` (was falsely `proposed`).
- Known recurrences recovered: Leichhardt Aquatic Centre (10 decisions), South Marrickville flood study (4); Italian Festa 2025/2026 kept distinct; Bunnings LATM↔event surfaced for human review (not auto-merged).
- `db/lib/topics.js` unit-tested (9/9). All scripts pass `node --check`.

### Production deploy fixes (same day, after merge to main)
- **D1 binding** — Git-integrated Pages ignored the `[[d1_databases]]` binding in `wrangler.toml`, so `env.DB` was undefined and `/api/items` returned `Cannot read properties of undefined (reading 'prepare')`. Fixed by adding `pages_build_output_dir = "."`, which makes Pages use `wrangler.toml` as its config source (binding now version-controlled, not a hidden dashboard setting).
- **D1 param overflow** — unfiltered `/api/items` fetched all 287 topics then bound one parameter per topic id in a single `IN (...)`, overflowing D1's ~100 bound-parameter cap (`too many SQL variables`). Fixed by chunking the decision query into batches of 90.
- Verified live: `GET /api/items` returns 287 topics; Leichhardt Aquatic Centre = `decided`, 10 decisions.

### Next
- Human review pass of match.js cross-type suggestions (writes `source='human'` aliases).
- Frontend rebuild on the threaded model.

---

## 2026-06-09 — Milestone 4: topic linking schema, offline dedup tool, frontend hardcode purge

### What changed

**index.html — hardcoded data purged**
- Removed the 17-item hardcoded LTF May 2026 array and the dual render path (hardcoded-first, then API override)
- Page now fetches from `/api/items` only, with a proper loading state and error state
- Section heading is now generic ("Recent decisions") not hardcoded to a specific meeting
- Type tag CSS classes expanded to cover all types now in D1 (report, motion, notice-of-motion, infrastructure, etc.)

**D1 schema additions (applied remotely)**
- `topics.canonical_topic_id TEXT` — null = canonical row; non-null = merged-away duplicate pointing to its canonical parent
- Trigger `trg_topics_no_chain` — enforces no self-reference and no pointer chaining on `canonical_topic_id`
- `topic_merge_log` — append-only audit table for every confirmed merge
- `merge_decisions` — disposition memory for the dedup tool (merged / dismissed_once / recurring)

**API (`functions/api/items.js`)**
- Added `WHERE t.canonical_topic_id IS NULL` so merged-away rows are never returned to the frontend

**`db/dedupe.js` — offline deduplication tool**
- Interactive CLI: finds same-type topics with overlapping streets within an 18-month window
- Ranked by street overlap fraction (strongest candidates first)
- Three dispositions: merge (sets canonical_topic_id + logs), dismiss once (18-month suppression), recurring (permanent suppression)
- Dry-run mode: `node db/dedupe.js --dry-run`
- Finds 86 candidate pairs on current data

**`docs/adr/0002-topic-linking-offline-deduplication.md`**
- Records the design decision: offline dedup over ingest-time matching
- Documents why ingest-time matching was rejected (weak identity signal, cold-start problem, nullable FK risk)

### Decisions made

- Ingest-time deduplication rejected after a structured three-agent debate (pro / against / manager) that surfaced: type+street is not a reliable identity signal without a time bound; the high-confidence path fires rarely given 1.55 avg decisions per topic; nullable topic_id breaks existing query guarantees
- `canonical_topic_id` on `topics` chosen over a `topic_links` join table — simpler for strictly one canonical row per cluster
- Three dispositions (merge / dismiss_once / recurring) added to handle Inner West's recurring program cycles (annual LATM reviews, kerb programs, school zones)

### PRs merged

- PR #24: feature branch → beta
- PR #25: beta → main (auto-deployed to https://innerwestwatch.pages.dev)

---

## 2026-06-08 — Pipeline: schema redesign and automated ingestion script

### What changed

**Schema redesigned from scratch**
- Old 7-table schema (with `topics`, `topic_suburbs`, `topic_streets`, `agenda_items`, `agenda_item_documents`) dropped and replaced
- New 5-table schema: `committees`, `meetings`, `topics`, `decisions`, `documents`
- `agenda_items` renamed to `decisions` — clearer about what the row represents
- `topic_suburbs` and `topic_streets` junction tables replaced with JSON arrays on `topics` — simpler for now, easy to migrate later
- `agenda_url` and `minutes_url` moved from item-level to `meetings` — they are meeting-level fields
- D1 wiped and new schema applied

**Automated ingestion pipeline (`db/ingest.js`)**
- Fetches agenda and minutes HTML directly from infocouncil.biz
- Deterministic parser splits HTML into per-item sections on `LTF\d+\(\d+\) Item N` boundary
- Claude API (Haiku) extracts structured fields from agenda: `type`, `headline`, `suburbs`, `streets`
- Claude API (Haiku) extracts from minutes: `status`, `resolution`, `works_start`
- Writes committees → meetings → topics → decisions → documents to D1 via Cloudflare REST API
- Handles missing minutes gracefully (items stay `on-agenda`)
- Re-runnable: `INSERT OR REPLACE` throughout
- Usage: `node db/ingest.js` (all meetings) or `node db/ingest.js ltf-18may2026` (one meeting)

**GitHub Actions workflow (`.github/workflows/ingest.yml`)**
- Runs every Monday at 9am Sydney time
- Also triggerable manually from the GitHub Actions tab with optional `meeting_id` input
- Reads secrets: `ANTHROPIC_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`, `CLOUDFLARE_D1_TOKEN`

**Supporting files**
- `package.json` created — `@anthropic-ai/sdk` dependency, `type: module`
- `.env` added to `.gitignore`
- `node_modules/` installed locally

### Decisions made

- **Manual data entry abandoned** — previous `items.json` hand-editing approach replaced by pipeline. `data/items.json` is now historical reference only; D1 is populated by `ingest.js`.
- **Claude Haiku chosen for extraction** — fast and cheap. One meeting ingest costs ~5–10 cents.
- **D1 write uses Cloudflare REST API** — not wrangler, so GitHub Actions can call it without wrangler auth.
- **`migrate.js` and `seed.sql` are now obsolete** — pipeline replaces them. Left in repo for reference but no longer the source of truth.

### Not yet done (blocked on credentials)

- Anthropic API key not yet created — needed to run the pipeline
- Cloudflare D1 API token not yet created — needed for D1 writes from outside wrangler
- `.env` file not yet created locally
- GitHub repository secrets not yet set
- Pipeline not yet tested end-to-end

---

## 2026-06-08 — Milestone 1: Database, API, and repo restructure

### Milestone 1 complete (Issue #8 closed)

**D1 database (`counciltracker`) created and seeded**
- 7-table schema: `committees`, `meetings`, `documents`, `topics`, `topic_suburbs`, `topic_streets`, `agenda_items`, plus junction table `agenda_item_documents`
- All 17 LTF 18 May 2026 items migrated from `data/items.json` into D1 (234 rows)
- Migration tooling: `db/migrate.js` reads `items.json` and writes `db/seed.sql` — safe to re-run (INSERT OR IGNORE)
- Database ID: `d721d0be-87d8-45dd-b2ee-56f06d9010ba`, region OC (Sydney)

**Worker API (`/api/items`)**
- `functions/api/items.js` — Cloudflare Pages Function
- Filters: `?suburb=Marrickville` and `?street=Illawarra+Rd` (repeatable)
- Response shape matches `items.json` exactly — frontend swap is minimal
- CORS headers included, 60s cache

**Frontend updated**
- `index.html` now fetches from `/api/items` on load
- Hardcoded `ITEMS` array renders immediately as initial state and silent fallback
- No loading state visible to residents

**Architecture decision recorded**
- `docs/adr/0001-api-street-filter.md` — why suburb and street are separate filters, why no radius search yet, future path to geospatial lookup

### Repo restructured

- Git repo root promoted from `smith-st/` to `innerwestwatch/` — `smith-st/` directory is gone
- `CLAUDE.md`, `GOALS.md`, `CONTEXT.md` now tracked in git (were outside repo before)
- GitHub repo renamed: `leemcdougall/tempe-latm` → `leemcdougall/innerwestwatch`
- `docs/adr/` directory created

### Infrastructure set up

- Node v22.22.3 installed via nvm, symlinked to `/usr/local/bin/` for Claude tool access
- Wrangler 4.98.0 installed and authenticated to leeamcdougall@gmail.com
- `wrangler.toml` added to repo root

### Naming decision

Brand name **counciltracker** chosen for potential expansion beyond Inner West Council. Domain `counciltracker.com.au` available as of this date — not yet registered.

---

## 2026-05-21 — Home page and data model (Session 11)

- New home page (`index.html`) with suburb-filtered card feed
- 17 items from LTF 18 May 2026 displayed as cards
- `data/items.json` created as canonical data source (now superseded by D1)
- Suburb filter chips auto-built from data
- Status badges with colour coding by outcome
- Cloudflare Pages deploy set up — auto-deploy from `main`
- Branch strategy established: `claude/*` → `beta` → `main`

---

## 2026-05-18 — Tempe South LATM detail page

- Deep-dive detail page for Item 4 (Bunnings Tempe South LATM works)
- Per-street breakdown: Edwin St, Tramway St, Wentworth St, Holbeach Ave, and others
- Works dates: 6 Jul – 5 Aug 2026 (contingency to 22 Aug)
- Street picker: mobile accordion, desktop two-panel master/detail
- Lives at `/meetings/ltf-18may2026/tempe-south/` — do not touch without care
