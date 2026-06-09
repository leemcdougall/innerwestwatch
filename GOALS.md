# Inner West Watch — Project Goals & Module Map

## What we're building

A plain-language digest of Inner West Council decisions for residents who would never read a council agenda. Residents can find what's happening on their street, follow ongoing issues, and get context on complex decisions without decoding bureaucratic language.

The project may expand beyond Inner West to other Australian councils. Preferred brand name if that happens: **counciltracker**.

---

## North star

A resident types their street name and immediately sees every open council decision that affects them — past context, current status, and what's coming next.

---

## Architecture

| Layer | Technology |
|---|---|
| Frontend | Cloudflare Pages (static HTML, auto-deploy from `main`) |
| API | Cloudflare Pages Functions (`functions/api/items.js`) |
| Database | Cloudflare D1 (`counciltracker`, region OC/Sydney) |
| Ingestion pipeline | GitHub Actions (scheduled — future) |
| Repo | https://github.com/leemcdougall/innerwestwatch |
| Live site | https://innerwestwatch.pages.dev |
| Custom domain | Future |

---

## Core data model

See `CONTEXT.md` (repo root) for canonical definitions.

**Committee** → holds many **Meetings** → each produces **Documents** (agenda, minutes, attachments)

**Topic** ← linked to many **Agenda Items** → each Item points to its source Documents

Residents follow Topics. Items are the evidence trail underneath.

---

## API

`GET /api/items` — served by `functions/api/items.js`

Filters:
- `?suburb=Marrickville` — civic/interest filter (case-insensitive)
- `?street=Illawarra+Rd` — geographic filter (case-insensitive, repeatable for multiple streets)

Suburb and street are intentionally separate filters — suburb boundaries do not map to physical proximity. See `docs/adr/0001-api-street-filter.md`.

---

## Modules

Modules are independent. Each can be built and shipped without the others being complete.

### 0. Core — data model + database ✅ DONE (Milestone 1, 2026-06-08)

- D1 schema defined: `committees`, `meetings`, `topics`, `decisions`, `documents`
- Schema redesigned 2026-06-08: `agenda_items` → `decisions`; suburb/street junction tables replaced with JSON arrays on `topics`; agenda/minutes URLs moved to `meetings`
- `CONTEXT.md` — canonical term definitions

### 1. Pipeline — automated ingestion ⏳ IN PROGRESS

*Fetches HTML from infocouncil.biz, extracts structured data with Claude API, writes to D1.*

- `db/ingest.js` — written, not yet tested end-to-end
- GitHub Actions workflow — written (`.github/workflows/ingest.yml`), runs Mondays 9am Sydney
- **Blocked on:** Anthropic API key, Cloudflare D1 API token, `.env` file, GitHub secrets

Next 4 steps to unblock:
1. Create Anthropic API key at console.anthropic.com (add $5 credit)
2. Create Cloudflare API token with D1 write permission (dash.cloudflare.com/profile/api-tokens)
3. Create `.env` file at repo root with all four credentials
4. Test: `node db/ingest.js ltf-18may2026` — verify one meeting ingests correctly, then run all four

### 2. Scanner — detect new meetings automatically
*Extends the pipeline to check infocouncil.biz for new or updated documents.*

- Check portal for new meetings not yet in D1
- Re-check known meetings for newly published minutes
- Run on GitHub Actions schedule — no manual triggering needed

### 3. Frontend — resident-facing site
*What residents actually see.*

- Entry points: by street, by suburb, by topic (follow), by committee
- Topic page: current status, full history of Decisions, source links
- "Follow" via localStorage — no account required
- Link to original infocouncil source on every item

### 4. Topic linking — connect decisions across meetings
*When the same real-world issue appears at multiple meetings, link them to one Topic.*

- Auto-suggest links based on matching street + suburb + type
- Flag ambiguous matches for human confirmation
- Unlinked decisions remain visible, marked pending

### 5. Document tools — make source material readable

- Convert TGS diagrams and design plan images to readable visual summaries
- Render traffic management plan key points in plain language

### 6. Backfill — open Topics from history

- Scope: open Topics only — decisions not yet resolved
- Use the same pipeline — backfill is not a special case

---

## Milestones

| # | Milestone | Status | Depends on |
|---|---|---|---|
| 1 | D1 schema defined, items.json migrated, frontend reads from Worker | ✅ Done 2026-06-08 | — |
| 2 | Scanner running on schedule, new Documents detected | ✅ Done 2026-06-09 | Milestone 1 |
| 3 | Ingestion producing decisions from all committee agendas | ✅ Done 2026-06-09 | Milestone 2 |
| 4 | Topic linking — offline dedup tool + schema | ✅ Done 2026-06-09 | Milestone 3 |
| 5 | Backfill — run dedupe.js to link 86 candidate pairs | ❌ Next | Milestone 4 |
| 6 | Additional committee types added (Council, FMACC, etc.) | ✅ Done 2026-06-09 | Milestone 3 |
| 7 | Document tools (image conversion, PDF extraction) | ⏳ Partial — images ingested, not shown | Milestone 3 |
| 8 | Custom domain | ❌ Not started | Any time |

---

## What's already built

- Home page with suburb-filtered card feed — fetches from `/api/items` (D1-backed, all committees)
- Tempe South LATM detail page (`/meetings/ltf-18may2026/tempe-south/`)
- `data/items.json` — historical record only (D1 is source of truth)
- `CONTEXT.md` — canonical domain glossary
- `docs/adr/` — two ADRs: street filter (0001), topic linking design (0002)
- `db/schema.sql` — D1 schema (8 tables including topic_merge_log, merge_decisions)
- `db/ingest.js` — auto-discovery ingestion pipeline (~990 lines)
- `db/dedupe.js` — offline topic deduplication tool
- `db/migrate.js` + `db/seed.sql` — migration tooling
- `functions/api/items.js` — Worker API
- `wrangler.toml` — Cloudflare config
- `.github/workflows/ingest.yml` — weekly scheduled ingest (Monday 9am AEST)
- Cloudflare Pages deploy (auto-deploy from `main`)
- Branch strategy: `claude/*` → `beta` → `main`
