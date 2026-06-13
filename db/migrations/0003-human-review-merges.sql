-- Migration 0003 — human review pass: thread two confirmed cross-type links (ADR 0003)
--
-- Milestone 6. The first-round ingest threaded decisions onto topics by EXACT subject
-- only, so genuine lifecycle links across phrasing/committee/document-type were missed.
-- A human review pass (reading the infocouncil source documents) confirmed two of the
-- matcher's street-corroborated suggestions are the same real-world issue, and rejected
-- the others. This migration applies only the two CONFIRMED merges.
--
-- Confirmed by source documents:
--   1. Bunnings Tempe LATM works (latm, 16 Feb 2026, Item 13) + temporary road closures
--      (event, 18 May 2026, Item 4). May agenda explicitly cites "Item 13, 16 Feb 2026"
--      and the same 8 streets/treatments; the closures construct the adopted design.
--   2. Unwins Bridge Rd / Hillcrest St pedestrian safety review (notice-of-motion,
--      17 Feb 2026, Item 37) + raised pedestrian crossing upgrade (crossing, 15 Jun 2026,
--      Item 18). The Feb motion directed a review of THIS crossing and to report to the
--      LTF within 3 months; the June LTF item is that review. Motion -> works, one topic.
--
-- Rejected (left as separate topics): Curtis Rd / Darling St (two different crossings,
-- design plans 10390 vs 10313); St Peters / WestConnex parklands (ingest data does not
-- match the source agenda — flagged for separate investigation, not threaded).
--
-- Each confirmed link becomes a source='human' subject alias so the matcher never
-- re-asks (oversight trends to zero, ADR 0003). FK off while we repoint+drop orphans.

PRAGMA foreign_keys = OFF;

-- ── Merge 1: Bunnings Tempe ───────────────────────────────────────────────────
-- Canonical = the LATM works topic (best persistent name; the originating project).
-- Loser     = the temporary-road-closures event topic (the construction phase).
UPDATE decisions      SET topic_id = 'topic-traffic-calming-works-near-bunnings-tempe'
  WHERE topic_id = 'topic-bunnings-latm-temporary-road-closures-tempe';
UPDATE images         SET topic_id = 'topic-traffic-calming-works-near-bunnings-tempe'
  WHERE topic_id = 'topic-bunnings-latm-temporary-road-closures-tempe';
-- repoint the loser's subject alias onto the canonical topic, promote to human source
UPDATE topic_subjects SET topic_id = 'topic-traffic-calming-works-near-bunnings-tempe', source = 'human'
  WHERE topic_id = 'topic-bunnings-latm-temporary-road-closures-tempe';
-- recompute: stage = max(decided, in-progress[works_start 2026-07-06]) = in-progress;
-- last_seen extends to the May closures decision. streets/suburbs unchanged (the event's
-- 8 streets are already a subset of the LATM topic's 9).
UPDATE topics SET stage = 'in-progress', last_seen = '2026-05-18'
  WHERE id = 'topic-traffic-calming-works-near-bunnings-tempe';
DELETE FROM topics WHERE id = 'topic-bunnings-latm-temporary-road-closures-tempe';

-- ── Merge 2: Unwins Bridge Rd / Hillcrest St, Tempe ───────────────────────────
-- Canonical = the raised pedestrian crossing topic (describes the actual works residents
-- care about; type=crossing more meaningful than notice-of-motion).
-- Loser     = the Feb pedestrian safety-review motion (the trigger).
UPDATE decisions      SET topic_id = 'topic-unwins-bridge-rd-tempe-raised-pedestrian-crossing-'
  WHERE topic_id = 'topic-pedestrian-safety-review-unwins-bridge-road-hillcr';
UPDATE images         SET topic_id = 'topic-unwins-bridge-rd-tempe-raised-pedestrian-crossing-'
  WHERE topic_id = 'topic-pedestrian-safety-review-unwins-bridge-road-hillcr';
UPDATE topic_subjects SET topic_id = 'topic-unwins-bridge-rd-tempe-raised-pedestrian-crossing-', source = 'human'
  WHERE topic_id = 'topic-pedestrian-safety-review-unwins-bridge-road-hillcr';
-- recompute: stage = max(decided[Feb motion approved], proposed[Jun crossing]) = decided
-- per deriveStage; first_seen pulls back to the Feb motion. (NOTE: deriveStage reads the
-- motion's "approved" as decided even though the crossing works themselves are not yet
-- approved — a known limitation of max-rank staging, tracked separately, not overridden
-- here because the next ingest run would deterministically recompute the same value.)
UPDATE topics SET stage = 'decided', first_seen = '2026-02-17'
  WHERE id = 'topic-unwins-bridge-rd-tempe-raised-pedestrian-crossing-';
DELETE FROM topics WHERE id = 'topic-pedestrian-safety-review-unwins-bridge-road-hillcr';

PRAGMA foreign_keys = ON;
