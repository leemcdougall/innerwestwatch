-- Migration 0006 — merge four source-verified duplicate-topic clusters (ADR 0003)
--
-- The session-9 reingest (and Haiku's slightly different per-meeting phrasing) minted a
-- separate topic for each appearance of four recurring matters, so a single real issue
-- showed up as 2–3 disconnected topics — the same failure the threading model exists to
-- prevent (cf. the Leichhardt Aquatic Centre, which used to read as 10 rows). These are
-- the FOUR "clear merge" clusters from the relations review backlog (the others on that
-- list are NOT duplicates — separate matters sharing a label — and are deliberately left
-- alone). Each merge below was confirmed against the infocouncil SOURCE documents, not the
-- D1 headlines (feedback_verify_merges_against_source — a headline guess was wrong once).
--
-- Mechanics mirror migration 0003: repoint the loser topics' decisions + images onto the
-- canonical topic, repoint the loser subject aliases (promoted to source='human' so the
-- matcher threads these phrasings automatically forever after — oversight trends to zero,
-- ADR 0003), recompute the canonical topic's stage / places / span from the full decision
-- set, then drop the now-empty loser topics. Hand-set stage values equal what deriveStage()
-- (db/lib/topics.js) recomputes from the same decisions, so the next ingest run is a no-op.
-- FK off while we repoint + drop.

PRAGMA foreign_keys = OFF;

-- ── Merge 1: Return and Earn (container-deposit recycling at council venues/events) ──
-- One scheme across three meetings: 9 Dec 2025 (item 52, "carried" — trial collections),
-- 19 May 2026 (item 3, "deferred" — trial expansion / donation baskets), 16 Jun 2026
-- (item 4, on agenda — trial launched). Source: all three reference the same Return and
-- Earn program at Council venues, offices and events (Jun agenda: "bins at Council venues,
-- offices and selected events", "throughout 2026/27").
-- Canonical = the Dec origin topic (cleanest persistent name).
UPDATE decisions      SET topic_id = 'topic-return-and-earn-recycling-at-council-events-and-ve'
  WHERE topic_id IN ('topic-return-and-earn-initiative-for-public-places-and-c',
                     'topic-return-and-earn-initiative-for-public-places-and-v');
UPDATE images         SET topic_id = 'topic-return-and-earn-recycling-at-council-events-and-ve'
  WHERE topic_id IN ('topic-return-and-earn-initiative-for-public-places-and-c',
                     'topic-return-and-earn-initiative-for-public-places-and-v');
UPDATE topic_subjects SET topic_id = 'topic-return-and-earn-recycling-at-council-events-and-ve', source = 'human'
  WHERE topic_id IN ('topic-return-and-earn-initiative-for-public-places-and-c',
                     'topic-return-and-earn-initiative-for-public-places-and-v');
-- recompute: stage = max(decided[Dec carried], deferred[May], proposed[Jun]) = decided;
-- span Dec 2025 → Jun 2026; suburbs = union (the May/Jun rows carried 4 suburbs, Dec none).
UPDATE topics SET stage = 'decided', first_seen = '2025-12-09', last_seen = '2026-06-16',
  suburbs = '["Balmain","Birchgrove","Tempe","Dulwich Hill"]'
  WHERE id = 'topic-return-and-earn-recycling-at-council-events-and-ve';
DELETE FROM topics WHERE id IN ('topic-return-and-earn-initiative-for-public-places-and-c',
                                'topic-return-and-earn-initiative-for-public-places-and-v');

-- ── Merge 2: Supporting Visual Artists and Writers — affordable creative spaces ──
-- One matter across three meetings: 17 Feb 2026 (item 12, "noted" — initiatives), 17 Mar
-- 2026 (item 21, "deferred" — report held over), 19 May 2026 (item 19, "noted" — report
-- returned). Source: all three minutes carry "Visual Artists and Writers … Affordable
-- Spaces". Canonical = the fullest descriptive name (the May report topic).
UPDATE decisions      SET topic_id = 'topic-supporting-visual-artists-and-writers-to-find-affo'
  WHERE topic_id IN ('topic-supporting-visual-artists-and-writers-affordable-c',
                     'topic-supporting-visual-artists-and-writers-affordable-s');
UPDATE images         SET topic_id = 'topic-supporting-visual-artists-and-writers-to-find-affo'
  WHERE topic_id IN ('topic-supporting-visual-artists-and-writers-affordable-c',
                     'topic-supporting-visual-artists-and-writers-affordable-s');
UPDATE topic_subjects SET topic_id = 'topic-supporting-visual-artists-and-writers-to-find-affo', source = 'human'
  WHERE topic_id IN ('topic-supporting-visual-artists-and-writers-affordable-c',
                     'topic-supporting-visual-artists-and-writers-affordable-s');
-- recompute: stage = max(decided[Feb noted], deferred[Mar], decided[May noted]) = decided;
-- span Feb → May 2026; suburbs = union of the three; streets = union ("Railway Rd"/"Railway
-- Road" are the same road — kept once as "Railway Road").
UPDATE topics SET stage = 'decided', first_seen = '2026-02-17', last_seen = '2026-05-19',
  suburbs = '["Marrickville","Rozelle","Ashfield","Lilyfield"]',
  streets = '["Railway Road"]'
  WHERE id = 'topic-supporting-visual-artists-and-writers-to-find-affo';
DELETE FROM topics WHERE id IN ('topic-supporting-visual-artists-and-writers-affordable-c',
                                'topic-supporting-visual-artists-and-writers-affordable-s');

-- ── Merge 3: Seniors Morning Teas to Celebrate the GreenWay ──
-- Same matter at 17 Feb 2026 (item 45, "approved") and 17 Mar 2026 (item 11, "adopted").
-- Source: BOTH minutes carry the identical item title "Seniors Morning Teas to Celebrate
-- the GreenWay"; Feb also resolves to "expand the Senior[s]" program (= the Mar headline).
-- Distinct from the broader "Expansion of Seniors Morning Teas program" topic (21 Apr,
-- left separate). Canonical = the topic whose name matches the source title exactly.
UPDATE decisions      SET topic_id = 'topic-seniors-morning-teas-to-celebrate-the-greenway'
  WHERE topic_id = 'topic-seniors-morning-teas-greenway-celebration';
UPDATE images         SET topic_id = 'topic-seniors-morning-teas-to-celebrate-the-greenway'
  WHERE topic_id = 'topic-seniors-morning-teas-greenway-celebration';
UPDATE topic_subjects SET topic_id = 'topic-seniors-morning-teas-to-celebrate-the-greenway', source = 'human'
  WHERE topic_id = 'topic-seniors-morning-teas-greenway-celebration';
-- recompute: stage = max(decided[Feb approved], decided[Mar adopted]) = decided; span Feb → Mar.
UPDATE topics SET stage = 'decided', first_seen = '2026-02-17', last_seen = '2026-03-17'
  WHERE id = 'topic-seniors-morning-teas-to-celebrate-the-greenway';
DELETE FROM topics WHERE id = 'topic-seniors-morning-teas-greenway-celebration';

-- ── Merge 4: Design Excellence LEP Amendment (Clause 6.9) ──
-- The same planning-rule amendment, deferred then re-listed: 19 May 2026 (item 2,
-- "deferred") resolved to defer "Clause 6.9 Design Excellence … for a further report to
-- June 2026"; 16 Jun 2026 (item 3, on agenda) IS that report — its agenda text cites back
-- to "C0526(1) Item 2 Design Excellence LEP Amendment" and Clause 6.9 throughout.
-- Canonical = the general "Design Excellence LEP Amendment" name (the live June matter).
UPDATE decisions      SET topic_id = 'topic-design-excellence-lep-amendment'
  WHERE topic_id = 'topic-design-excellence-lep-amendment-clause-6-9';
UPDATE images         SET topic_id = 'topic-design-excellence-lep-amendment'
  WHERE topic_id = 'topic-design-excellence-lep-amendment-clause-6-9';
UPDATE topic_subjects SET topic_id = 'topic-design-excellence-lep-amendment', source = 'human'
  WHERE topic_id = 'topic-design-excellence-lep-amendment-clause-6-9';
-- recompute: stage = max(deferred[May], proposed[Jun on-agenda]) = deferred; span May → Jun.
UPDATE topics SET stage = 'deferred', first_seen = '2026-05-19', last_seen = '2026-06-16'
  WHERE id = 'topic-design-excellence-lep-amendment';
DELETE FROM topics WHERE id = 'topic-design-excellence-lep-amendment-clause-6-9';

PRAGMA foreign_keys = ON;
