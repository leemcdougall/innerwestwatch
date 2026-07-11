# Inner West Watch — Project Goals & Module Map

## What we're building

A plain-language digest of Inner West Council decisions for residents who would never read a council agenda. Residents can find what's happening on their street, follow ongoing issues, and get context on complex decisions without decoding bureaucratic language.

The project may expand beyond Inner West to other Australian councils. Preferred brand name if that happens: **counciltracker**.

---

## North star

A resident types their **street or suburb** and immediately sees every council issue near them — threaded across meetings, types, and committees — with past context, current stage, and what's coming next. Street search **crosses suburb boundaries**: it answers "what's close to me", not "what was filed under my suburb".

The transport-only digest was the first, easy-win test case. The scope is now **every committee and every kind of issue** (transport, flood, waste, planning, governance), because residents care about all of them and the same threading model serves them all. The 14-committee / 6-month full ingest was intentional reconnaissance to understand that scope before modelling it.

**Infrastructure first.** The data layer must be right — ingest, threading, the ability to ask "what's the latest on X?" and get a true answer — before the resident-facing frontend is rebuilt on top of it. See `docs/adr/0003` (persistent topics by subject threading) and `0004` (committee-neutral status).

**Direction note:** the middle layer — the plain-language text and the links between issues — is the
actual product, and it leads. The honesty work is **done** (ADR 0008 — "honest labels by reading the
resolution": every decision carries a stored resident sentence + commitment tag, and a "no" reads as a
"no"). The last middle-layer piece — #85, "let residents follow one big project as one thing" — is now
**designed**: ADR 0010 — "Projects above topics" — defines a **Project** (Lee's name, 2026-07-11), a
human-confirmed grouping above topics, because one real-world project (e.g. the Leichhardt Aquatic
Centre, ~8 differently-named topics) can't be joined by subject-threading. The build is issues
#92/#93/#94 (storage · seed the first Projects · API). Full reasoning in the (gitignored)
`memory/direction.md`; the frontend rebuild (Milestone 7, #86) waits on the build landing.

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

**Project** (ADR 0010, designed — build pending #92/#93/#94): a named real-world standing thing that groups many Topics (the pool, the GreenWay), human-confirmed, many-to-many, stored subject-keyed so re-imports can't destroy it. Residents will follow Projects as one timeline of all member decisions.

---

## API

`GET /api/items` — served by `functions/api/items.js`. Returns one object per **Topic**, each with its threaded `decisions[]` history (each decision carrying its plain-English `residentSentence` and honest `label`), neutral `stage` + resident `label`, the union of `suburbs`/`streets`, plus `relations[]` (linked topics) and `images[]` (infocouncil diagram URLs). Full shape documented at the top of `functions/api/items.js`.

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

### 1. Pipeline — automated ingestion ✅ DONE (threading-aware, id-stable)

*Fetches HTML from infocouncil.biz, extracts Subject + neutral Outcome with Claude, threads each Decision onto a persistent Topic via the alias store.*

- `db/append-weekly.js` — the scheduled importer (ADR 0009 — "correct in place and id-stable appender"): appends new meetings, fills newly published minutes in place by decision id (via `db/correct-in-place.js`), chains the sentence-labeller + stage recompute, exits red on any failure
- Shared source/write code in `db/lib/infocouncil.js` (portal discovery, item splitting, extraction prompts), `db/lib/append-meeting.js` (attach-or-create by exact subject alias — never re-slugs), `db/lib/d1.js`
- `db/ingest.js` — legacy manual tool only (first-time bulk ingestion); retired from the schedule 2026-07-11, its `--force` path is banned
- GitHub Actions workflow `.github/workflows/weekly-append.yml` — runs Mondays 9am Sydney (replaced `ingest.yml`)
- Credentials live in `.env` (gitignored) + GitHub secrets: `ANTHROPIC_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`, `CLOUDFLARE_D1_TOKEN`

### 2. Scanner — detect new meetings automatically ✅ DONE (rebuilt 2026-07-11)
*Extends the pipeline to check infocouncil.biz for new or updated documents.*

- Check portal for new meetings not yet in D1 — done by `db/append-weekly.js`
- Re-check known meetings for newly published minutes — **restored** by the appender's second branch
  (the 2026-06→07 regression: the old non-force ingest skipped known meetings, so the weekly job ran
  green while importing nothing — fixed by #83, "new council minutes aren't reaching the site")
- Run on GitHub Actions schedule — no manual triggering needed; a failed week now shows red

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
| 7 | Frontend rebuild on the threaded model (#86 — "rebuild the resident-facing site": topic pages, street/suburb search crossing boundaries; colour-blind pass #84) | ⏸ ON HOLD (Lee's call) | Milestones 10, 11 |
| 8 | Document tools (image conversion, PDF extraction) | ⏳ Partial — images ingested + served by the API, not shown | Milestone 3 |
| 9 | Custom domain | ❌ Not started | Any time |
| 10 | Honest middle layer: resident sentence + commitment tag per decision, six resident labels, contradiction flag, correct-in-place sweep against source (ADR 0008 — "honest labels by reading the resolution"; ADR 0009 — "correct in place and id-stable appender") | ✅ Done 2026-07-07 (sessions 17–22) | Milestone 5 |
| 11 | Weekly id-stable importer — new meetings + newly published minutes flow in, get labelled, and go live with no human step (#83 — "new council minutes aren't reaching the site") | ✅ Done 2026-07-11 (session 24) — proven on the 15 Jun LTF minutes: 15 outcomes filled in place, topic ids unchanged, 96 aliases intact | Milestone 10 |
| 12 | Projects — follow one big project as one thing (#85 — "let residents follow one big project as one thing") | 🟡 Design accepted 2026-07-11 (ADR 0010 — "Projects above topics"); build issues filed: #92 storage · #93 propose+confirm the first Projects · #94 API | Milestone 10 |

---

## What's already built

Don't maintain a list here — it goes stale (this section once listed 4 ADRs when 9 existed). The
sources of truth, per the table in the repo-root `MAP.md`:

- **Code**: the module map above (each module says built/partial/not) + each directory's `MAP.md`.
- **Data shape**: the live D1 query in `memory/status.md` — never a hardcoded count.
- **Decisions**: `docs/adr/MAP.md` — the full, current ADR list.
- **History**: `CHANGELOG.md`, session by session.
