# Changelog — Inner West Watch

Entries are in reverse chronological order. Each entry covers a session or milestone, not individual commits. For commit-level detail, see `git log`.

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
