# ADR 0002 — Topic linking: offline deduplication, not ingest-time matching

**Status:** Accepted  
**Date:** 2026-06-09

## Decision

Topic deduplication (linking multiple decisions about the same real-world issue to one canonical Topic) is handled by a separate offline tool, not at ingest time. Ingest always creates a new topic row per agenda item. The offline tool surfaces candidate duplicate pairs for human review and records dispositions.

Schema additions:
- `topics.canonical_topic_id` — nullable self-reference; set on a merged-away row to point to the canonical row. Enforced by trigger: no self-reference, no chaining.
- `topic_merge_log` — append-only audit table recording every confirmed merge.
- `merge_decisions` — the tool's disposition memory: merged, dismissed_once, or recurring (suppressed forever).

The API filters `WHERE canonical_topic_id IS NULL` to exclude merged-away rows.

## Why

The alternative was ingest-time matching: before inserting a new topic, query existing topics for type + street overlap and reuse the existing topic ID if confident. This was rejected for three reasons:

**The identity signal is too weak without a time bound.** The same street hosts multiple independent projects — Inner West's LATM reviews, kerb programs, and school zone renewals recur on fixed cycles. Type + street alone conflates distinct issues. Adding a time window makes the heuristic probabilistic, not reliable.

**Cold-start is a permanent condition, not a transitional one.** With 1.55 decisions per topic on average, the "high-confidence" path (type + street + prior human confirmation on that topic) fires rarely even at scale. The complexity cost was paid on every ingest run for a benefit that almost never materialised.

**Nullable `topic_id` on `decisions` breaks a schema guarantee.** The ingest-time approach required `decisions.topic_id` to become nullable for unresolved matches. Every downstream query — API, reporting — would need to handle NULL. That is a guarantee worth defending.

## What the offline tool does

Candidate query: topics with matching type, at least one overlapping street, and meeting dates within 18 months of each other. Pairs are ranked by street overlap fraction (shared streets / union of streets). Pairs already in `merge_decisions` are excluded (or re-included after one cycle if dismissed_once).

Three dispositions per candidate pair:
- **Merge** — set `canonical_topic_id` on the older row, write to `topic_merge_log`
- **Dismiss once** — suppress this pair for 18 months
- **Recurring** — suppress this pair permanently (same streets, same program type, genuinely distinct items)

## No-chaining rule

If topic A is canonical and B → A, any attempt to set C's `canonical_topic_id` to B is rejected by trigger. The tool resolves C to A automatically. This prevents recursive pointer chains in queries.

## Alternatives considered

- **`topic_links` join table instead of `canonical_topic_id`:** more flexible for many-to-many relationships but adds query complexity for a use case that is strictly one canonical row per duplicate cluster. Rejected — YAGNI.
- **Separate `topic_merges` table as primary mechanism:** cleaner separation but heavier than needed for low merge volume. `canonical_topic_id` on `topics` is simpler; the audit log covers the history need.
- **Ingest-time matching with confidence scoring:** described above. Rejected.
