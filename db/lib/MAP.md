# db/lib/ — shared subject/stage primitives

Pure functions shared by `ingest.js` and `match.js` so both thread topics the same way.

| File | What it does |
|---|---|
| `topics.js` | `normKey` / `tokenSet` / `slug` / `sameSubject` / `deriveStage` / `stageRank` — subject normalisation and stage derivation. Change stage/matching logic here, in one place. |
| `topics.test.js` | `node:assert` tests (no deps). Run with `npm test`. Covers stage derivation incl. the `under-review` rules (ADR 0007). |

**Structural change → update this MAP + the `lib/` line in `db/MAP.md`.**
