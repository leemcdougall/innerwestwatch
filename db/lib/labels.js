/**
 * db/lib/labels.js — the honest resident-facing label (ADR 0008).
 *
 * The model pass (db/label-decisions.js) reads a decision's stored resolution and emits
 * {commitment, resident_sentence, outcome_matches_text}. This module turns the resulting
 * decision fields into the six-word label a resident skims — reusing deriveStage so the
 * neutral lifecycle logic lives in ONE place (db/lib/topics.js), never re-implemented here.
 */

import { deriveStage, isRefusal } from './topics.js';

// The six resident labels, mapping the ADR 0004/0007 neutral stages one-for-one (ADR 0008).
export const RESIDENT_LABEL = {
  proposed: 'Coming up',
  deferred: 'Held over',
  'under-review': 'Being looked into',
  decided: 'Decided',
  'in-progress': 'Underway',
  completed: 'Finished',
};

// Shown when the resolution text contradicts the stored outcome word: the read refuses
// to guess which is right, so the resident sees the honest gap rather than a fabricated
// determination (ADR 0008 decision 5).
export const UNCLEAR_LABEL = 'Outcome unclear';

// Shown for a public-forum community address — a resident speaking to Council, with no vote.
// These have no `outcome`, so without this they would read "Coming up" as if a decision were
// pending; it never was. Honest: the community raised it, Council heard it, nothing decided.
export const RAISED_LABEL = 'Raised at public forum';

// Whether a decision's stored OUTCOME WORD genuinely contradicts its resolution TEXT
// (ADR 0008 decision 5). Derived, not model-judged: asking the model "do these disagree?"
// proved noisy (it flagged clean deferrals and contract awards). The reliable signal is a
// triple gate:
//   1. the outcome word is a refusal (isRefusal — "not supported", "refused", …), AND
//   2. the read still found a commitment (the text resolves to act or to run a process), AND
//   3. the text contains NO refusal of its OWN (textHasRefusal is false).
// Gate 3 is what separates a true conflict from a normal MIXED decision. A mixed "no to X
// but yes to Y" resolution says "not supported" inside its own text, so it fails gate 3 and
// reads by its commitment instead (Decided for an action) — matching the "action wins a
// mixed resolution" rule (ADR 0008 decision 1). Only when the word says "no" while the text
// nowhere refuses (civic-offices council-16jun2026-38; ltf-20apr2026-06 whose text reads
// "Supported in-principle") do we refuse to guess and show "Outcome unclear".
export function outcomeUnclear({ outcome, commitment, textHasRefusal } = {}) {
  return isRefusal(outcome) && commitment != null && !textHasRefusal;
}

// The honest label for a single decision. When the read flagged a text-vs-outcome
// contradiction (outcome_unclear), we never derive a confident label — we say so.
// Otherwise the neutral stage is derived from the decision (the model's `commitment`
// tag now feeds deriveStage for real, reviving ADR 0007) and mapped to the resident word.
export function residentLabel(decision, type) {
  if (decision.outcome_unclear) return UNCLEAR_LABEL;
  // A public-forum address with no recorded outcome was never a decision in progress.
  if (decision.publicForum && !decision.outcome) return RAISED_LABEL;
  return RESIDENT_LABEL[deriveStage([decision], type)];
}

// The one-to-two-sentence resident sentence cap (ADR 0008 decision 3). ~240 chars is
// roughly two plain sentences; anything longer is the model over-explaining and gets cut.
export const SENTENCE_MAX = 240;

// Coerce ONE raw read from the model into safe fields, defending against a model that
// emits an off-vocabulary commitment or an over-long sentence. This is the guard at the
// impure edge (db/label-decisions.js): everything downstream trusts these shapes.
//   commitment          → 'action' | 'process' | null (anything else fails safe to null,
//                          which deriveStage reads conservatively via the type fallback)
//   resident_sentence   → trimmed, capped at SENTENCE_MAX; blank becomes null
//   textHasRefusal      → strict boolean (default false): does the resolution TEXT itself
//                          refuse/reject/decline anything? Fed to outcomeUnclear alongside
//                          the stored outcome word to decide the contradiction flag.
export function normalizeLabelResult(raw = {}) {
  const commitment = raw.commitment === 'action' || raw.commitment === 'process'
    ? raw.commitment : null;

  let sentence = typeof raw.resident_sentence === 'string' ? raw.resident_sentence.trim() : '';
  if (sentence.length > SENTENCE_MAX) {
    // Cut at the last word boundary inside the cap (leaving room for the ellipsis) so a
    // truncated sentence never ends on a broken word like "…briefing due by Decem".
    const cut = sentence.slice(0, SENTENCE_MAX - 1);
    const lastSpace = cut.lastIndexOf(' ');
    sentence = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
  }
  const resident_sentence = sentence || null;

  const textHasRefusal = raw.text_has_refusal === true;

  return { commitment, resident_sentence, textHasRefusal };
}
