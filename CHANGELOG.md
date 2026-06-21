# Changelog — Inner West Watch

Entries are in reverse chronological order. Each entry covers a session or milestone, not individual commits. For commit-level detail, see `git log`.

---

## 2026-06-21 (session 9) — Fix the ingest regression that wiped LTF/FMAC; restore coverage; verify fidelity

Worked the backend-to-90% plan. The headline find: the "cross-ref-leak fix" that shipped on this branch (commit 9cbc43e) had silently broken every multi-letter committee, which is what actually lost the LTF and FMAC data on 14 June — not a partial run.

### Root cause (diagnosed against live source agendas)
- 9cbc43e added a strict per-meeting `refPrefix` filter (`^LTF0526(...)`) to `splitHtmlByItems`. That exposed a latent bug in the item-boundary split: the greedy `[A-Z]+` satisfied the lookahead at **every** letter of a multi-letter prefix, so `String.split` fired before L, T **and** F of "LTF0526" and each content section started at the last letter (`F0526(1) Item 1`). The strict filter then matched nothing → **0 items for every multi-letter committee** (LTF, FMACC, ILPP…). Single-letter "C" (Council) was immune, which is why only Council survived 14 June.
- The flagship `ltf-18may2026` had a second failure: 17 image-heavy items in one request exceeded Claude's ~32 MB body cap → `413 request_too_large`. The existing caps were on item/image **count**, not bytes.

### Fixes (commit 0978008 + follow-ups)
- `db/ingest.js` `ITEM_BOUNDARY`: anchor the split with a negative lookbehind `(?<![A-Z])` so it fires only at the true start of the ref code. LTF/FMAC extract again.
- `db/ingest.js`: batch by request **bytes** (`MAX_REQUEST_BYTES` 18 MB), not just image/item counts. The Tempe LATM agenda now splits into 3 batches and writes all 17 decisions.
- Kept the in-flight fidelity work this branch carried (20-item-per-call cap + `max_tokens` 8192 to stop truncated-JSON item mislabeling; per-meeting try/catch isolation so one bad agenda can't abort a run and silently drop later committees).
- `db/match.js`: drop the `slice(0,20)` cap on link-suggestion printing.
- Reverted the stray regenerated `db/migrations/0002-thread-backfill.sql` (an applied migration must not change).

### Corrective reingest + verification
- Backed up live D1, then ran `node db/ingest.js --months 12`. Coverage restored: **council 14 / ltf 10 / fmac 4 / public-forum 5 = 33 meetings, 651 decisions, 600 topics, 0 orphans.** All 14 committees are scanned every run; the other 10 genuinely have no meetings in the window (acceptable — see GOALS north star).
- **Item-number fidelity confirmed fixed.** All 6 session-7 mismatches now match the live source agendas: St Peters (Jun item 16), Robyn Webster (May 10), Centenary Park (May 5, no phantom item 50), Renwick fire (May 25), Wran plaza (May 8), Investment split (Feb 17 property + 26 cash). Verified against raw `C0526`/`C0626` ref codes, not just D1 headlines.

### Relations preserved, not re-materialized (ADR 0005)
- The 100 Milestone-6 `topic_relations` are keyed by topic id — the one thing reingest churns — so they were wiped. Rescued all 100 into **`db/human-relations.json`**, keyed by **subject pair** (slug-immune), 0 unresolved. Materializing back into D1 is deferred until the data stabilizes / the frontend needs them (relations aren't served by the API yet). The re-runnable `subject → current topic id` apply step is the next relation task.

### Schema + housekeeping
- Added `db/migrations/0003-topic-relations.sql` (the table existed in live D1 but never in the repo; migrations 0004/0005 from an old branch never landed). Applied (IF NOT EXISTS, no-op on live).
- New **ADR 0005** documents the subject-keyed relations decision; notes legacy `merge_decisions`/`topic_merge_log` (ADR 0002 era) as drop candidates.
- Gitignored `backups/` and `review/` (large, regenerable; the human work was rescued into `db/human-relations.json` first).

---

## 2026-06-21 — Backend status review + handoff for the push to "90%"

Orientation session after a ~2-week gap. No code or schema changes. Audited the live backend and wrote a handoff so the next session can plan the work to get the data layer to ~90% before the frontend rebuild.

### What we found (verified against live D1)
- 350 topics / 368 decisions / 350 aliases. Stage split: decided 161 / proposed ~165 / in-progress 17 / deferred 7.
- Only **3 of 14 committees** have data: council (10 meetings, 9 with minutes), public-forum (4), ltf (1). Needs verifying — real, or a dropped reingest?
- Working tree is dirty and unexplained: `db/match.js` (suggestion display cap removed), `db/ingest.js` (the committed cross-ref fix), and ⚠️ a **regenerated `db/migrations/0002-thread-backfill.sql`** (topic ids/subjects rewritten ~2026-06-15 — an already-applied migration shouldn't change). Untracked `backups/` (pre-reingest dump 2026-06-14 + topic_relations dump/reapply) and `review/` (match.js HTML output). Left untouched — Lee couldn't speak to them, so the next session investigates before committing/deleting anything.
- Branch `claude/fix-ingest-cross-ref-leak` (commit 9cbc43e, cross-ref-leak fix) is built but **not merged**.
- 🔴 **Regression found:** `topic_relations` = 0 in live D1. The 100 human-confirmed relations from Milestone 6 (2026-06-13) were wiped by a ~2026-06-14 reingest (D1 grew 285→350 topics) and never reapplied. `backups/topic_relations-reapply.sql` is the unran reapply script. Reapplying it (after re-checking topic ids) is the next session's first job.
- Reconfirmed the still-open **ingest item-number fidelity bug** from session 7 (6+ places where stored item numbers don't match source agendas); unknown whether the 6-14 reingest fixed it.

### Decisions
- Backend before frontend: Milestone 7 (frontend rebuild) stays deferred. Target is data/ingest correctness first, with a final polish pass once we're in a good spot.
- Working-tree artifacts left as-is pending investigation (no blind commit/delete of a regenerated migration).

### Handoff
- `/tmp/handoff-backend-to-90.md` — full open-thread list and next-session prompt (not in repo; OS temp dir).

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
