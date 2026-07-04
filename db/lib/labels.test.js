/**
 * db/lib/labels.test.js — no-dependency unit tests for the honest-label mapping.
 *
 * Run: `node db/lib/labels.test.js`. Uses node:assert only, matching the repo's
 * zero-dev-dependency posture. Pins the four ADR 0008 trap cases as tests of the
 * resident-facing label the model pass drives (db/label-decisions.js): the model
 * reads a resolution and emits {commitment, resident_sentence, outcome_matches_text};
 * these tests fix what a resident then sees, so the honesty contract can't silently drift.
 */

import assert from 'node:assert';
import { residentLabel, normalizeLabelResult, outcomeUnclear, SENTENCE_MAX } from './labels.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('residentLabel — the four ADR 0008 trap cases');

// Budget trap (council-16jun2026-02): stored outcome is "noted", but the resolution
// ADOPTS a $164.7m budget. Reading the text yields commitment=action, so an honest
// label reads "Decided", not the type-fallback "Being looked into".
check('budget "noted" read as action → Decided', () => {
  assert.strictEqual(
    residentLabel({ outcome: 'noted', commitment: 'action' }, 'motion'),
    'Decided',
  );
});

// Unwins Bridge Rd trap: a motion resolving to REVIEW road safety is approved. The
// commitment is process (investigate/review), not a concrete change, so an honest label
// reads "Being looked into" — not "Decided".
check('safety-review motion read as process → Being looked into', () => {
  assert.strictEqual(
    residentLabel({ outcome: 'carried', commitment: 'process' }, 'motion'),
    'Being looked into',
  );
});

// Civic-offices trap (council-16jun2026-38): resolution text says "resolves to
// investigate... requests a report in 4 months", but the stored outcome is "not supported".
// The text and the outcome word disagree, so the read flags outcome_matches_text=false.
// An honest label refuses to guess: "Outcome unclear", NOT the confident "Decided" the
// refusal word would otherwise derive.
check('text-vs-outcome contradiction → Outcome unclear (never guessed)', () => {
  assert.strictEqual(
    residentLabel({ outcome: 'not supported', outcome_unclear: 1 }, 'motion'),
    'Outcome unclear',
  );
});

// Agenda-only trap (LTF 15 Jun 2026): the headline restates the officer recommendation
// ("...approved"), but no vote has happened — outcome is null. An honest label reads
// "Coming up" off the null outcome, and never lets a done-word in the headline upgrade it
// to "Decided" (ADR 0008 decision 6). residentLabel only ever sees the outcome, not the
// headline, so a headline word structurally cannot leak into the badge.
check('agenda-only null outcome → Coming up (headline word never upgrades it)', () => {
  assert.strictEqual(
    residentLabel({ outcome: null, headline: 'Pedestrian crossing approved' }, 'crossing'),
    'Coming up',
  );
});

console.log('outcomeUnclear — the deterministic text-vs-outcome contradiction (ADR 0008)');

// The genuine contradiction (civic-offices council-16jun2026-38, and ltf-20apr2026-06):
// the council's OUTCOME WORD is a refusal, but the resolution text carries a real
// commitment and contains NO refusal of its own — the word flatly disagrees with the text.
check('refusal word + commitment + no refusal in text → unclear', () => {
  assert.strictEqual(
    outcomeUnclear({ outcome: 'not supported', commitment: 'action', textHasRefusal: false }),
    true,
  );
});

// A MIXED decision ("not supported [X] but approved [Y]", ltf-16feb2026-16) refuses inside
// its own text, so it is NOT a contradiction — it reads by its commitment (Decided).
check('mixed no-to-X-yes-to-Y (text refuses too) → not unclear', () => {
  assert.strictEqual(
    outcomeUnclear({ outcome: 'not supported', commitment: 'action', textHasRefusal: true }),
    false,
  );
});

// A plain rejection with no counter-commitment (council-19aug2025-44, motion ruled
// redundant) is a settled "no" → Decided, never unclear.
check('plain rejection, no commitment → not unclear', () => {
  assert.strictEqual(
    outcomeUnclear({ outcome: 'not supported', commitment: null, textHasRefusal: false }),
    false,
  );
});

// Clean go-aheads and clean deferrals never flag: the outcome word isn't a refusal.
check('clean approval / deferral → not unclear', () => {
  assert.strictEqual(outcomeUnclear({ outcome: 'approved', commitment: 'action' }), false);
  assert.strictEqual(outcomeUnclear({ outcome: 'deferred', commitment: null }), false);
  assert.strictEqual(outcomeUnclear({ outcome: 'noted', commitment: 'action' }), false);
});

console.log('normalizeLabelResult — coercing the model\'s raw JSON at the impure edge');

// A well-formed read passes through: commitment, the trimmed sentence, and the model's
// extractive text_has_refusal signal (used later by outcomeUnclear, which also needs the
// stored outcome word — so the contradiction is decided in the pass, not here).
check('valid action read passes through, exposes textHasRefusal', () => {
  const out = normalizeLabelResult({
    commitment: 'action',
    resident_sentence: 'Council adopted its 2026/27 budget.',
    text_has_refusal: false,
  });
  assert.strictEqual(out.commitment, 'action');
  assert.strictEqual(out.resident_sentence, 'Council adopted its 2026/27 budget.');
  assert.strictEqual(out.textHasRefusal, false);
});

// text_has_refusal is coerced to a strict boolean, defaulting false when the model omits it.
check('text_has_refusal coerced to boolean, defaults false', () => {
  assert.strictEqual(normalizeLabelResult({ text_has_refusal: true }).textHasRefusal, true);
  assert.strictEqual(normalizeLabelResult({ text_has_refusal: 'yes' }).textHasRefusal, false);
  assert.strictEqual(normalizeLabelResult({}).textHasRefusal, false);
});

// An off-vocabulary commitment fails safe to null rather than corrupting the badge.
check('off-vocabulary commitment → null (fails safe)', () => {
  assert.strictEqual(normalizeLabelResult({ commitment: 'adopt' }).commitment, null);
  assert.strictEqual(normalizeLabelResult({ commitment: '' }).commitment, null);
  assert.strictEqual(normalizeLabelResult({}).commitment, null);
});

// An over-long sentence is cut to the cap; a blank one becomes null (not an empty string).
check('sentence clamped to cap; blank → null', () => {
  const long = 'x'.repeat(400);
  assert.ok(normalizeLabelResult({ resident_sentence: long }).resident_sentence.length <= SENTENCE_MAX);
  assert.strictEqual(normalizeLabelResult({ resident_sentence: '   ' }).resident_sentence, null);
});

// The clamp cuts at a WORD boundary, never mid-word, and marks the truncation with an
// ellipsis — a broken final word ("…briefing due by") reads worse than a clean cut.
check('over-long sentence clamps at a word boundary with an ellipsis', () => {
  const words = ('Council committed to upgrading streetlights to LED lighting and '
    + 'transitioning the fleet with a briefing on Carbon Zero options due by December').repeat(3);
  const out = normalizeLabelResult({ resident_sentence: words }).resident_sentence;
  assert.ok(out.length <= SENTENCE_MAX, 'within cap');
  assert.ok(out.endsWith('…'), 'ends with an ellipsis');
  // The body is a clean prefix of the original AND the original continues with a space at
  // the cut point — proving we split between words, never inside one ("Decem|ber").
  const body = out.slice(0, -1).trimEnd();
  assert.ok(words.startsWith(body), 'body is a prefix of the original');
  assert.strictEqual(words[body.length], ' ', 'cut falls on a word boundary');
});

console.log(`\n${passed} checks passed.`);
