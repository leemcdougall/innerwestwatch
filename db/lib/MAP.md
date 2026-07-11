# db/lib/ — shared pipeline primitives

Code shared by the pipeline scripts (`append-weekly.js`, `ingest.js`, `match.js`,
`label-decisions.js`, `correct-in-place.js`) so topic threading, stage derivation, honest labels,
portal reading, and the id-stable write each have one definition.

| File | What it does |
|---|---|
| `topics.js` | `normKey` / `tokenSet` / `slug` / `sameSubject` / `deriveStage` / `stageRank` / `isRefusal` — subject normalisation and stage derivation. Change stage/matching logic here, in one place. |
| `infocouncil.js` | Reading the infocouncil.biz portal: `COMMITTEES` config, meeting discovery (`discoverMeetings`), `fetchHtml`, the per-item splitter (`splitHtmlByItems` — the refPrefix cross-reference filter lives here), and the agenda/minutes extraction calls. Extracted from `ingest.js` (session 24, #83). No D1 writes. |
| `append-meeting.js` | The id-stable write side (ADR 0009): `resolveTopicId` (attach-or-create by EXACT subject alias — never re-slugs), `writeMeetingToD1`, `processMeeting` (fetch → extract → write one meeting, returns the decision ids written). |
| `d1.js` | The D1 REST call, shared: `d1Query` (full result array) / `d1Rows` (first statement's rows). |
| `topics.test.js` | `node:assert` tests (no deps). Run with `npm test`. Covers stage derivation incl. the `under-review` rules (ADR 0007). |
| `labels.js` | The honest resident label (ADR 0008): the six-label map, `residentLabel`, `normalizeLabelResult` (guards the model's raw output), `outcomeUnclear` (deterministic text-vs-outcome contradiction rule). Used by `db/label-decisions.js`. |
| `labels.test.js` | `node:assert` tests. Pins the four ADR 0008 trap cases + the contradiction and sentence-clamp rules. |

**Structural change → update this MAP + the `lib/` line in `db/MAP.md`.**
