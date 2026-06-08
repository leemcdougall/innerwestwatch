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

- D1 schema defined (Committee, Meeting, Document, Topic, AgendaItem tables)
- `items.json` migrated into D1 — 17 LTF 18 May 2026 items seeded
- Frontend reads from D1 via Worker (`functions/api/items.js`)
- `CONTEXT.md` — canonical term definitions

### 1. Scanner — detect new council documents
*Runs on a GitHub Actions schedule. Feeds all other modules.*

- Scan infocouncil.biz portal for new meetings across all committee types
- Detect new Documents (agenda HTML, minutes HTML, attachments)
- Record each Document in D1 with fetch timestamp and source hash
- Re-scan known Documents to detect changes (e.g. minutes published after agenda)
- Prefer HTML over PDF when both exist

### 2. Ingestion — extract structured data from documents
*Transforms raw Documents into Topics and Agenda Items.*

- Parse agenda HTML → extract item list, headlines, streets, suburbs, type
- Parse minutes HTML → extract resolutions, amendments, outcome status
- Handle attachment PDFs as fallback when HTML is unavailable
- AI-assisted extraction for embedded images (maps, TGS diagrams, design plans)
- Output: candidate AgendaItems ready for Topic linking

### 3. Topic linking — connect items across meetings
*Associates new Agenda Items with existing Topics.*

- Auto-suggest links based on matching street + suburb + type
- Flag ambiguous matches for human confirmation
- Unlinked items remain visible on the site, marked as pending
- Human confirmation UI (simple — could be a script or a basic admin page)

### 4. Frontend — resident-facing site
*What residents actually see.*

- Entry points: by street, by suburb, by topic (follow), by committee
- Entry points are open-ended — new ones added as needed
- Topic page: current status, full history of Agenda Items, source links
- "Follow" via localStorage — no account required
- Link to original infocouncil source on every item (site is a digest, not a replacement)

### 5. Document tools — make source material readable
*Transforms council documents into resident-friendly formats.*

- Convert TGS diagrams and design plan images to readable visual summaries
- Render traffic management plan key points in plain language
- More tools added as new document types are encountered
- HTML preferred; PDF fallback; AI extraction for images

### 6. Backfill — open Topics from history
*One-time process to bring in unresolved decisions predating the scanner.*

- Scope: open Topics only — decisions not yet resolved, works not yet completed
- Start from infocouncil history, work backwards until no open items remain
- Use the same ingestion module — backfill is not a special case

---

## Milestones

| # | Milestone | Status | Depends on |
|---|---|---|---|
| 1 | D1 schema defined, items.json migrated, frontend reads from Worker | ✅ Done 2026-06-08 | — |
| 2 | Scanner running on schedule, new Documents detected | — | Milestone 1 |
| 3 | Ingestion producing AgendaItems from LTF agendas | — | Milestone 2 |
| 4 | Topic linking working for LTF items | — | Milestone 3 |
| 5 | Backfill of open Topics complete | — | Milestone 4 |
| 6 | Additional committee types added (Council, FMACC, etc.) | — | Milestone 3 |
| 7 | Document tools (image conversion, PDF extraction) | — | Milestone 3 |
| 8 | Custom domain | — | Any time |

---

## What's already built

- Home page with suburb-filtered card feed (17 items, 18 May 2026 LTF)
- Tempe South LATM detail page (`/meetings/ltf-18may2026/tempe-south/`)
- `data/items.json` — historical record (D1 is now source of truth)
- `CONTEXT.md` — canonical domain glossary
- `docs/adr/` — architecture decision records
- `db/schema.sql` — D1 schema
- `db/migrate.js` + `db/seed.sql` — migration tooling
- `functions/api/items.js` — Worker API
- `wrangler.toml` — Cloudflare config
- Cloudflare Pages deploy (auto-deploy from `main`)
- Branch strategy: `claude/*` → `beta` → `main`
