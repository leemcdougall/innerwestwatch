# Inner West Watch — Project Goals & Module Map

## What we're building

A plain-language digest of Inner West Council decisions for residents who would never read a council agenda. Residents can find what's happening on their street, follow ongoing issues, and get context on complex decisions without decoding bureaucratic language.

---

## North star

A resident types their street name and immediately sees every open council decision that affects them — past context, current status, and what's coming next.

---

## Architecture

| Layer | Technology |
|---|---|
| Frontend | Cloudflare Pages (static HTML) |
| Dynamic queries | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Ingestion pipeline | GitHub Actions (scheduled) |
| Repo | GitHub (can be private) |
| Domain | innerwestwatch.pages.dev → custom domain (future) |

---

## Core data model

See `smith-st/CONTEXT.md` for canonical definitions.

**Committee** → holds many **Meetings** → each produces **Documents** (agenda, minutes, attachments)

**Topic** ← linked to many **Agenda Items** → each Item points to its source Documents

Residents follow Topics. Items are the evidence trail underneath.

---

## Modules

Modules are independent. Each can be built and shipped without the others being complete. The core (data model + database) must exist before any module can write to it.

### 0. Core — data model + database
*Must be built first. Everything else depends on it.*

- Define the D1 schema (Committee, Meeting, Document, Topic, AgendaItem tables)
- Migrate current `items.json` content into D1
- Update the frontend to read from D1 via a Worker instead of inline JSON
- Write CONTEXT.md (done) — canonical term definitions

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

| # | Milestone | Depends on |
|---|---|---|
| 1 | D1 schema defined, items.json migrated | — |
| 2 | Frontend reads from D1 via Worker | Milestone 1 |
| 3 | Scanner running on schedule, new Documents detected | Milestone 1 |
| 4 | Ingestion producing AgendaItems from LTF agendas | Milestone 3 |
| 5 | Topic linking working for LTF items | Milestone 4 |
| 6 | Backfill of open Topics complete | Milestone 5 |
| 7 | Additional committee types added (Council, FMACC, etc.) | Milestone 4 |
| 8 | Document tools (image conversion, PDF extraction) | Milestone 4 |
| 9 | Custom domain | Any time |

---

## What's already built

- Home page with suburb-filtered card feed (17 items, 18 May 2026 LTF)
- Tempe South LATM detail page
- `items.json` — will be migrated into D1 in Milestone 1
- `CONTEXT.md` — canonical domain glossary
- Cloudflare Pages deploy (auto-deploy from `main`)
- Branch strategy: `claude/*` → `beta` → `main`
