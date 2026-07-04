# Inner West Watch — Project Goals & Module Map

## What we're building

A plain-language digest of Inner West Council decisions for residents who would never read a council agenda. Residents can find what's happening on their street, follow ongoing issues, and get context on complex decisions without decoding bureaucratic language.

The project may expand beyond Inner West to other Australian councils. Preferred brand name if that happens: **counciltracker**.

---

## North star

A resident types their **street or suburb** and immediately sees every council issue near them — threaded across meetings, types, and committees — with past context, current stage, and what's coming next. Street search **crosses suburb boundaries**: it answers "what's close to me", not "what was filed under my suburb".

The transport-only digest was the first, easy-win test case. The scope is now **every committee and every kind of issue** (transport, flood, waste, planning, governance), because residents care about all of them and the same threading model serves them all. The 14-committee / 6-month full ingest was intentional reconnaissance to understand that scope before modelling it.

**Infrastructure first.** The data layer must be right — ingest, threading, the ability to ask "what's the latest on X?" and get a true answer — before the resident-facing frontend is rebuilt on top of it. See `docs/adr/0003` (persistent topics by subject threading) and `0004` (committee-neutral status).

**Direction note (2026-07-04, under discussion, not yet an ADR):** session 16 reframed the middle layer around the distinct questions residents ask (change near me / what the council decided / follow a subject over time / have my say / did they follow through). Reading the data showed the followable unit residents want (e.g. the Leichhardt Aquatic Centre) sits a level above the current topic — one real-world project is spread across ~8 differently-named topics that threading can't join. Sequencing: honesty first (status/outcome semantics), then re-ingest safety (#45), then the entity/project grouping. **Honesty-first is now built** (session 18, ADR 0008): each of 651 decisions has a stored resident sentence + commitment tag, and stages reflect the actual resolution text (decided 347 / under-review 161, was 138 / 370). Next is widening `/api/items` to carry the sentence so the frontend can show it. Detail in the (gitignored) `memory/direction.md`; frontend (Milestone 7) waits on this settling.

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

**Committee** → holds many **Meetings** → each produces **Documents** (agenda, minutes, attachments).

**Topic** (persistent issue, carries a canonical **Subject** + neutral **Stage**) ← threads many **Decisions** → each Decision is one appearance at one Meeting, carrying its own headline + raw **Outcome**.

Many Decisions point to ONE Topic. We thread, never merge (ADR 0003). The learned `topic_subjects` alias store attaches recurring subjects automatically so human oversight trends to zero. Residents follow Topics; Decisions are the evidence trail underneath.

---

## API

`GET /api/items` — served by `functions/api/items.js`. Returns one object per **Topic**, each with its threaded `decisions[]` history, neutral `stage`, and the union of `suburbs`/`streets`.

Filters:
- `?suburb=Marrickville` — civic/interest filter (case-insensitive)
- `?street=Illawarra+Rd` — geographic filter (case-insensitive, repeatable for multiple streets)

A filter matches a Topic if any of its decisions touched that place. Suburb and street are intentionally separate filters — suburb boundaries do not map to physical proximity, and street search crosses them. See `docs/adr/0001-api-street-filter.md`.

---

## Modules

Modules are independent. Each can be built and shipped without the others being complete.

### 0. Core — data model + database ✅ DONE

- D1 schema: `committees`, `meetings`, `topics`, `decisions`, `documents`, `images`, `topic_subjects` (learned alias store)
- Threaded model: persistent `topics` carry `subject` + neutral `stage`; `decisions` carry per-appearance `headline` + raw `outcome` (migration `0001-topic-threading.sql`)
- `db/lib/topics.js` — shared subject/stage primitives (normKey, slug, sameSubject, deriveStage)
- `CONTEXT.md` — canonical term definitions

### 1. Pipeline — automated ingestion ✅ DONE (threading-aware)

*Fetches HTML from infocouncil.biz, extracts Subject + neutral Outcome with Claude, threads each Decision onto a persistent Topic via the alias store.*

- `db/ingest.js` — auto-discovery pipeline; attaches-or-creates by subject (exact alias lookup), recomputes topic stage + union streets/suburbs from the full decision history; prunes re-slug orphan topics (+ their dangling aliases/images) at the end of every run
- GitHub Actions workflow `.github/workflows/ingest.yml` — runs Mondays 9am Sydney
- Credentials live in `.env` (gitignored) + GitHub secrets: `ANTHROPIC_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`, `CLOUDFLARE_D1_TOKEN`

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

### 4. Topic threading — connect decisions across meetings ✅ DONE (backfill applied)
*The same real-world issue appearing at multiple meetings threads onto one persistent Topic.*

- `db/match.js` — offline reconciliation: clusters by subject (fuzzy subset/Jaccard), splits distinct recurrences on a >270-day gap, surfaces street-corroborated cross-type near-misses for human review (never auto-merges)
- Backfill applied 2026-06-10: 357 decisions → 287 persistent topics (45 thread 2+ decisions), 287 learned aliases
- Confirmed links persist to `topic_subjects` so oversight trends to zero (ADR 0003)
- Superseded `db/dedupe.js` (merge-based, ADR 0002) — removed
- `db/apply-relations.js` — re-materializes the 100 subject-keyed human links (`db/human-relations.json`) into `topic_relations` against current topic ids after any reingest; resolves via the alias store + fuzzy fallback and reports unresolved subjects for review (ADR 0006). `topic_relations` is a derived projection, not a source.
- `db/relation-subject-aliases.json` + `db/apply-subject-aliases.js` — the review-loop output: source-verified `subject → topic` mappings (the durable git record of the human judgement) and a step that writes them, plus sticky pins for fuzzy hits, into `topic_subjects` as `source='human'`. Lifted relation resolution 38 → 73/100 (session 11); the rest are documented `leave` cases (no single valid topic) awaiting a future topic merge.

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
| 4 | Persistent topics by subject threading + neutral status (ADR 0003/0004): schema, match.js, ingest rewrite, API | ✅ Done 2026-06-10 | Milestone 3 |
| 5 | Backfill — thread the 357 existing decisions into real topics | ✅ Done 2026-06-10 | Milestone 4 |
| 6 | Comprehensive link/touchpoint pass over all 285 topics — 100 human-confirmed links, now subject-keyed (`db/human-relations.json`) and re-materialized into `topic_relations` by `db/apply-relations.js` after each reingest (ADR 0006); all merge candidates routed to the ingest data-quality fix | ✅ Done 2026-06-13 (relations apply step 2026-06-21) | Milestone 5 |
| 7 | Frontend rebuild on the threaded model (topic pages, street/suburb search crossing boundaries) | ❌ Not started | Milestone 5 |
| 8 | Document tools (image conversion, PDF extraction) | ⏳ Partial — images ingested, not shown | Milestone 3 |
| 9 | Custom domain | ❌ Not started | Any time |

---

## What's already built

- Home page with suburb-filtered card feed — fetches from `/api/items` (D1-backed, all committees)
- Tempe South LATM detail page (`/meetings/ltf-18may2026/tempe-south/`)
- `data/items.json` — historical record only (D1 is source of truth)
- `CONTEXT.md` — canonical domain glossary
- `docs/adr/` — ADRs: street filter (0001), offline dedup (0002, superseded), persistent topics by subject threading (0003), committee-neutral status (0004)
- `db/schema.sql` — D1 schema (threaded topics, decision-level headline/outcome, `topic_subjects` alias store)
- `db/migrations/` — `0001-topic-threading.sql` (applied), `0002-thread-backfill.sql` (applied)
- `db/ingest.js` — auto-discovery pipeline; attaches-or-creates topics by subject
- `db/match.js` — offline reconciliation / backfill tool (supersedes the removed `db/dedupe.js`)
- `db/lib/topics.js` — shared subject/stage primitives
- `db/migrate.js` + `db/seed.sql` — legacy seed tooling
- `functions/api/items.js` — Worker API (serves threaded topics)
- `wrangler.toml` — Cloudflare config
- `.github/workflows/ingest.yml` — weekly scheduled ingest (Monday 9am AEST)
- Cloudflare Pages deploy (auto-deploy from `main`)
- Branch strategy: `claude/*` → `beta` → `main`
