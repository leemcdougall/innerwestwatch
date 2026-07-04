# db/lib/ — shared subject/stage/label primitives

Pure functions shared by the pipeline scripts (`ingest.js`, `match.js`, `label-decisions.js`)
so topic threading, stage derivation, and honest labels all use one definition each.

| File | What it does |
|---|---|
| `topics.js` | `normKey` / `tokenSet` / `slug` / `sameSubject` / `deriveStage` / `stageRank` / `isRefusal` — subject normalisation and stage derivation. Change stage/matching logic here, in one place. |
| `topics.test.js` | `node:assert` tests (no deps). Run with `npm test`. Covers stage derivation incl. the `under-review` rules (ADR 0007). |
| `labels.js` | The honest resident label (ADR 0008): the six-label map, `residentLabel`, `normalizeLabelResult` (guards the model's raw output), `outcomeUnclear` (deterministic text-vs-outcome contradiction rule). Used by `db/label-decisions.js`. |
| `labels.test.js` | `node:assert` tests. Pins the four ADR 0008 trap cases + the contradiction and sentence-clamp rules. |

**Structural change → update this MAP + the `lib/` line in `db/MAP.md`.**
