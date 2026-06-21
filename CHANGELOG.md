# Changelog — Inner West Watch

Entries are in reverse chronological order. Each entry covers a session or milestone, not individual commits. For commit-level detail, see `git log`.

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
