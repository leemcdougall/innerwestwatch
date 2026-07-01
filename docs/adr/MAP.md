# docs/adr/ — architecture decision records

One file per hard-to-reverse or genuinely trade-off decision, with full reasoning. Read these before
changing the data model or ingest — they explain *why* it's shaped this way.

| ADR | Decision | Status |
|---|---|---|
| `0001-api-street-filter.md` | Street filter separate from suburb filter; street search crosses suburb boundaries. | Current |
| `0002-topic-linking-offline-deduplication.md` | Original offline dedupe approach. | Superseded by 0003 |
| `0003-persistent-topics-and-subject-matching.md` | Persistent topics threaded by subject — **thread, never merge**. | Current |
| `0004-committee-neutral-status.md` | `stage` on the topic, raw `outcome` on the decision; retires LTF-specific status words. | Current |
| `0005-topic-relations.md` | The `topic_relations` table for parent-child / related / supersedes links. | Current |
| `0006-relations-as-subject-keyed-source.md` | Relations source of truth = subject-keyed JSON; the D1 table is derived (survives re-ingest). | Current |
| `0007-under-review-stage-and-commitment-tag.md` | New `under-review` stage + `decisions.commitment` tag. | Current |

**New decision → add an ADR here + a row above + update the `docs/` hook in the repo-root `MAP.md`.**
