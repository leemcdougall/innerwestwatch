/**
 * db/lib/topics.test.js — no-dependency unit tests for the stage primitives.
 *
 * Run: `node db/lib/topics.test.js` (or `npm test`). Uses node:assert only — no test
 * framework, matching the repo's zero-dev-dependency posture. Focused on the ADR 0007
 * `under-review` / commitment logic, where the subtle behaviour lives.
 */

import assert from 'node:assert';
import { stageRank, deriveStage, WORKS_TYPES, normKey, slug, sameSubject, tokenSet } from './topics.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('stageRank — lifecycle ranks');

check('no outcome → proposed (1)', () => {
  assert.strictEqual(stageRank({ outcome: null }, 'crossing'), 1);
  assert.strictEqual(stageRank({}, 'report'), 1);
});

check('deferred outcome → deferred (2)', () => {
  assert.strictEqual(stageRank({ outcome: 'deferred' }, 'crossing'), 2);
  assert.strictEqual(stageRank({ outcome: 'held over for more work' }, 'report'), 2);
});

check('works_start or executed/underway → in-progress (5)', () => {
  assert.strictEqual(stageRank({ outcome: 'approved', works_start: '2026-09-01' }, 'latm'), 5);
  assert.strictEqual(stageRank({ outcome: 'contract executed' }, 'infrastructure'), 5);
  assert.strictEqual(stageRank({ outcome: 'works underway' }, 'crossing'), 5);
});

check('completed (6) is never produced — pipeline tops out at in-progress', () => {
  // No input combination should rank 6. A past works_start is still a START, not an end.
  assert.strictEqual(stageRank({ outcome: 'approved', works_start: '2020-01-01' }, 'latm'), 5);
});

console.log('stageRank — the ADR 0007 action/process split');

check('CANONICAL BUG: process commitment → under-review (3), not decided', () => {
  // Unwins Bridge Rd / Hillcrest St: a motion "approved" only to undertake a safety
  // review. Before ADR 0007 this read `decided` (4); it must now read `under-review`.
  assert.strictEqual(
    stageRank({ outcome: 'approved', commitment: 'process' }, 'notice-of-motion'), 3);
});

check('action commitment → decided (4)', () => {
  assert.strictEqual(
    stageRank({ outcome: 'approved', commitment: 'action' }, 'notice-of-motion'), 4);
});

check('action wins on a deliberative type (mixed resolution rule)', () => {
  // "procure decorations AND investigate festive options" — the AI tags it `action`,
  // so a concrete commitment is never hidden behind under-review even on a NoM.
  assert.strictEqual(
    stageRank({ outcome: 'approved', commitment: 'action' }, 'report'), 4);
});

console.log('stageRank — type fallback when the commitment tag is absent');

check('works type + approved, no tag → decided (4)', () => {
  assert.strictEqual(stageRank({ outcome: 'approved' }, 'crossing'), 4);
  assert.strictEqual(stageRank({ outcome: 'endorsed' }, 'parking'), 4);
});

check('deliberative type + approved, no tag → under-review (3)', () => {
  assert.strictEqual(stageRank({ outcome: 'approved' }, 'notice-of-motion'), 3);
  assert.strictEqual(stageRank({ outcome: 'endorsed' }, 'report'), 3);
});

check('unknown/unlisted type fails safe to under-review (3)', () => {
  assert.strictEqual(stageRank({ outcome: 'approved' }, 'some-future-type'), 3);
  assert.strictEqual(stageRank({ outcome: 'approved' }, undefined), 3);
});

check('unrecognised commitment value falls back to type, not assumed action', () => {
  assert.strictEqual(stageRank({ outcome: 'approved', commitment: 'investigate' }, 'report'), 3);
  assert.strictEqual(stageRank({ outcome: 'approved', commitment: 'investigate' }, 'crossing'), 4);
});

console.log('stageRank — refusals stay decided (ADR 0004 + 0007)');

check('refusals → decided (4) regardless of type or commitment', () => {
  assert.strictEqual(stageRank({ outcome: 'refused' }, 'development'), 4);
  assert.strictEqual(stageRank({ outcome: 'not supported' }, 'notice-of-motion'), 4);
  assert.strictEqual(stageRank({ outcome: 'withdrawn' }, 'report'), 4);
  // even if a stray process tag is present, a refusal is settled, not "under review"
  assert.strictEqual(stageRank({ outcome: 'not supported', commitment: 'process' }, 'report'), 4);
});

console.log('deriveStage — most-advanced point across a topic\'s decisions');

check('maps ranks to labels', () => {
  assert.strictEqual(deriveStage([{ outcome: 'approved', commitment: 'process' }], 'notice-of-motion'), 'under-review');
  assert.strictEqual(deriveStage([{ outcome: 'approved', commitment: 'action' }], 'crossing'), 'decided');
  assert.strictEqual(deriveStage([{ outcome: null }], 'report'), 'proposed');
  assert.strictEqual(deriveStage([{ outcome: 'deferred' }], 'latm'), 'deferred');
  assert.strictEqual(deriveStage([{ outcome: 'approved', works_start: '2026-09-01' }], 'latm'), 'in-progress');
});

check('takes the MAX rank: a later action outranks an earlier process step', () => {
  const decs = [
    { outcome: 'approved', commitment: 'process' }, // under-review (3)
    { outcome: 'approved', commitment: 'action' },  // decided (4)
  ];
  assert.strictEqual(deriveStage(decs, 'notice-of-motion'), 'decided');
});

check('a pure process topic stays under-review even with multiple appearances', () => {
  const decs = [
    { outcome: null },                                // proposed (1)
    { outcome: 'approved', commitment: 'process' },   // under-review (3)
  ];
  assert.strictEqual(deriveStage(decs, 'notice-of-motion'), 'under-review');
});

console.log('sanity — untouched primitives still behave');

check('normKey / slug / sameSubject unchanged', () => {
  assert.strictEqual(normKey('The Darling St crossing'), 'crossing darling');
  assert.strictEqual(slug('Leichhardt Aquatic Centre Stage 2'), 'leichhardt-aquatic-centre-stage-2');
  assert.ok(sameSubject(tokenSet('Italian Festa Norton'), tokenSet('Norton Italian Festa park')));
  assert.ok(WORKS_TYPES.has('crossing') && !WORKS_TYPES.has('report'));
});

console.log(`\n${passed} checks passed.`);
