# db/migrations/ — applied D1 migrations

Ordered SQL migrations, all applied to live D1. Read newest-last for how the schema got to today.
The reasoning behind each is in `docs/adr/`.

| Migration | What it did |
|---|---|
| `0001-topic-threading.sql` | Added `topics.subject/stage/first_seen/last_seen`, `decisions.headline/outcome`, and the `topic_subjects` alias store (ADR 0003). |
| `0002-thread-backfill.sql` | Threaded existing decisions into persistent topics. |
| `0003-human-review-merges.sql` | First human-confirmed topic merges. |
| `0004-topic-relations.sql` | Created the `topic_relations` table (ADR 0005). |
| `0005-populate-topic-relations.sql` | Seeded relations by topic id — **stale now** (re-ingest churns ids; superseded by `apply-relations.js`). |
| `0006-clear-merge-duplicate-topics.sql` | Merged 4 confirmed duplicate-split topics (600 → 594). |
| `0007-decision-commitment.sql` | Added `decisions.commitment` (action/process) for the `under-review` stage (ADR 0007). |

**Structural change → add the row here + update the `migrations/` line in `db/MAP.md`.**
