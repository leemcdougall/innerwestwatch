-- Migration 0008 — honest labels by reading the resolution (ADR 0008)
--
-- The honest-label pass (db/label-decisions.js) reads each decision's stored `resolution`
-- and emits, per decision, {commitment, resident_sentence, outcome_matches_text}. commitment
-- already exists (migration 0007). This migration adds the other two stores:
--
-- resident_sentence: the one-to-two-sentence, impact-first plain-language summary a resident
--   reads on the card/trail. Distinct from the terse `headline` — the headline is a label,
--   this is the "what it means for my street". Null until the pass has read the decision.
--
-- outcome_unclear: set to 1 only when the resolution text and the stored `outcome` word
--   DISAGREE (e.g. text "resolves to investigate" against outcome "not supported"). The pass
--   refuses to guess which is right; residentLabel (db/lib/labels.js) then shows "Outcome
--   unclear" instead of a derived label. 0 = text and outcome agree (the normal case).
--
-- Both are additive and default-safe: existing rows read resident_sentence NULL /
-- outcome_unclear 0, so the site behaves exactly as before until the pass runs. Reading
-- stored `resolution` is NOT a re-ingest, so this does not touch topic ids or human aliases
-- (issue #45 does not bite).

ALTER TABLE decisions ADD COLUMN resident_sentence TEXT;
ALTER TABLE decisions ADD COLUMN outcome_unclear INTEGER NOT NULL DEFAULT 0;
