# Changelog — Inner West Watch

Entries are in reverse chronological order. Each entry covers a session or milestone, not individual commits. For commit-level detail, see `git log`.

---

## 2026-06-09 — Ingest pipeline: full portal scan, vision, all committees (Milestones 2, 3, 6)

### What changed

**`db/ingest.js` — complete rewrite**
- Was: hardcoded 4-meeting LTF list, no images, LTF-only item splitting
- Now: auto-discovery scanner across all committees on infocouncil.biz
- POSTs to infocouncil.biz with ViewState to discover meetings by committee/year/month
- Converts `_WEB.htm` stub links to `_AT.HTM` content pages automatically
- Generalised item splitting works for any committee code, not just LTF
- Groups duplicate item refs by item number, keeps largest section (eliminates TOC stubs)
- Images: extracts `<img>` URLs per item, fetches as base64, sends to Claude vision
- Batching: max 80 images per Claude call; minutes batched at 20 items/call
- Large agendas (Council has 50+ items, 100+ images) handled correctly
- Minutes-only committees (Public Forum) handled as special case
- Self-auditing: warns via GitHub Actions `::warning::` annotations when new/unknown committees appear
- Incremental: skips already-ingested meetings
- 6th table added: `images` (id, topic_id, url, description, sequence) — auto-migrated on run

**New committees in config**
- Council, Local Transport Forum, Flood Management, Public Forum
- LRAC Leichhardt (ID 14), Implementation Advisory Group (ID 17) added after audit warnings
- 12 committees total in COMMITTEES config

**GitHub Actions workflow (`.github/workflows/ingest.yml`)**
- `--months` and `--committee` inputs for manual dispatch
- `GITHUB_ACTIONS: 'true'` env var triggers `::warning::` annotations on unknown docs

**Full data ingest run completed**
- D1 now contains 357 decisions across 23 meetings, 170 images
- Span: Aug 2025 – Jun 2026 (LTF); Dec 2025 – Jun 2026 (Council/FMAC)
- Auto-discovered brand new meeting `ltf-15jun2026` (June 15, 2026) during run

### D1 state after this session

| Committee | Meetings | Items |
|-----------|----------|-------|
| Council | 8 | 250 |
| Local Transport Forum | 9 | 98 |
| Flood Management | 2 | 7 |
| Public Forum | 2 | 2 |
| **Total** | **23** | **357** |

### Issues closed

- #9 and #12 closed (pipeline complete and data ingested)
- PR #23 merged to main; beta synced

### Not yet done

- `index.html` still renders hardcoded May 2026 LTF data — display layer rebuild is next
- Topic linking (Milestone 4) and backfill (Milestone 5) not started

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
