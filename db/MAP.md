# db/ — database schema, ingest, and reconciliation

Everything that reads council documents into D1 (`counciltracker`) and keeps the threaded-topic model
honest. D1 is the source of truth, not `data/items.json`. The *why* behind this design is in
`docs/adr/` (0003 threading, 0004 neutral status, 0006 relations-as-source, 0007 under-review stage).

## Files

| File | What it does |
|---|---|
| `schema.sql` | The live D1 schema (threaded topics + decisions + `topic_subjects` alias store). |
| `ingest.js` | Main ingest: reads committee agendas, extracts decisions, attaches-or-creates topics by exact subject alias. Prunes orphans at the end. ⚠️ Do NOT run `--force` (issue #45). |
| `match.js` | Offline reconciliation/backfill: clusters topics, proposes fuzzy + cross-type links for human review. Never auto-merges. |
| `apply-relations.js` | Re-runnable step that resolves `human-relations.json` subject pairs to current topic ids and writes `topic_relations`. |
| `apply-subject-aliases.js` | Upserts verified subject→topic aliases from `relation-subject-aliases.json` so links survive re-ingest. |
| `recompute-stages.js` | Recomputes every topic's `stage` from existing decisions — no source re-read. Use this to apply a changed stage rule. |
| `label-decisions.js` | The honest-label pass (ADR 0008): a model reads each decision's stored `resolution` → `commitment` + `resident_sentence`, and the text-vs-outcome contradiction flag is derived. Reads stored text only (not a re-ingest, #45-safe). Flags: `--dry-run` / `--sample` / `--limit N` / `--ids a,b,c`. Run `recompute-stages.js` after. |
| `human-relations.json` | Source of truth for human-confirmed topic links, keyed by **subject pair** (slug-immune). |
| `relation-subject-aliases.json` | Durable git record of human subject→topic judgements (mappings + `leave` entries). |
| `migrate.js` / `seed.sql` | Legacy: generates `seed.sql` from `items.json`. `seed.sql` is generated — don't hand-edit. |
| `lib/` | Shared primitives — see `lib/MAP.md`. |
| `migrations/` | Applied SQL migrations 0001–0008 — see `migrations/MAP.md`. |

## Common commands

```bash
node db/ingest.js                          # scan all committees, last 6 months
node db/ingest.js --committee ltf          # one committee
node db/ingest.js --meeting ltf-18may2026  # re-process one meeting
node db/match.js --dry-run                 # cluster + print link suggestions
node db/recompute-stages.js                # re-apply the stage rule, no re-read
node db/label-decisions.js --dry-run --sample   # preview honest labels on the trap cases
node db/label-decisions.js                  # honest-label pass, then recompute-stages
wrangler d1 execute counciltracker --remote --command "<SQL>"   # D1 is source of truth
```

**Structural change → update this MAP + the `db/` hook in the repo-root `MAP.md`.**
