-- Migration 0007 — add decisions.commitment for the under-review stage (ADR 0007)
--
-- `commitment` records, for a go-ahead determination, whether the council approved a
-- concrete change ('action') or only a process step like investigate/review/receive/note
-- ('process'). deriveStage (db/lib/topics.js) uses it to split `decided` from the new
-- `under-review` stage, so an "approved to investigate" motion no longer reads the same as
-- "approved to build". Null for pending items and for refusals/deferrals.
--
-- The column is populated by the AI minutes extraction (db/ingest.js). Existing rows stay
-- NULL until the in-place re-ingest re-reads each meeting; until then deriveStage falls
-- back to the item type, so no row is left without a sensible stage. NULL satisfies the
-- CHECK (an IN test against NULL is NULL, not false), so adding the column is safe.

ALTER TABLE decisions ADD COLUMN commitment TEXT CHECK(commitment IN ('action', 'process'));
