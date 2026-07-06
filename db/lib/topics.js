/**
 * db/lib/topics.js — shared topic-threading primitives (ADR 0003, 0004)
 *
 * One source of truth for how a council item's SUBJECT becomes a clustering key,
 * how a topic id is slugged, and how a committee-neutral lifecycle STAGE is derived
 * from outcomes. Both the live ingest (db/ingest.js) and the offline reconciliation
 * pass (db/match.js) import these so a subject normalises the same way in both places
 * — otherwise an alias written by one would never be hit by the other.
 */

// Words dropped before clustering: articles, prepositions, street-type tokens, and a
// few council-generic words. Street NAMES survive (they corroborate); only the type
// suffix (st/rd/ave) is noise once the name is present.
export const STOP = new Set(('the a an and or of at to for on in with by st street rd road ave '
  + 'avenue ln lane pl place council plan policy new').split(' '));

// Normalise a subject to a stable clustering key: lowercase, strip punctuation, drop
// stop-words, sort the remaining content words so word order never matters.
export function normKey(subject) {
  return (subject || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(w => w && !STOP.has(w)).sort().join(' ');
}

export function tokenSet(subject) {
  return new Set(normKey(subject).split(' ').filter(Boolean));
}

// Slug a subject into a topic id stem, e.g. "Leichhardt Aquatic Centre Stage 2"
// -> "leichhardt-aquatic-centre-stage-2".
export function slug(subject) {
  return (subject || 'topic').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 50) || 'topic';
}

// Two subjects are the SAME issue when their content-word sets are near-identical:
// one is a subset of the other (an extra "park"/"indoor"/place token), or their
// Jaccard overlap clears SUBJECT_JACCARD. Used by the offline matcher to collapse
// the slightly different phrasings Haiku emits for a recurring subject. Ingest itself
// matches only on EXACT normKey via the alias store (no fuzzy guess baked into source).
export const SUBJECT_JACCARD = 0.6;
export function sameSubject(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const smaller = Math.min(a.size, b.size);
  if (inter === smaller) return true;                 // subset
  return inter / (a.size + b.size - inter) >= SUBJECT_JACCARD;
}

// Item types where an "approved" outcome means a CONCRETE change is coming to a street —
// these read `decided` when approved. Every other type (motions, notices of motion, staff
// reports, advisory items) defaults to the more cautious `under-review`, because their
// "approval" is usually a resolution to investigate, receive, or note — not to build.
//
// This allowlist is only the FALLBACK used when a decision has no AI `commitment` tag
// (rows ingested before ADR 0007, or the minutes-only Public Forum). Once a meeting is
// re-read, the per-decision `commitment` tag below takes precedence. Failing safe to
// `under-review` means an unknown future type understates progress rather than overstating
// it — the safer error for a resident-facing badge. (ADR 0007)
export const WORKS_TYPES = new Set((
  'crossing parking latm speed infrastructure development development-application '
  + 'planning-proposal modification rezoning asset waste event project'
).split(' '));

// A refusal IS a determination, so it reads `decided` (with the raw outcome shown
// alongside saying "no") — never `under-review`. Symmetry with ADR 0004's decided+outcome
// model: a knock-back is settled, not still being looked into. (ADR 0007)
//
// Exported so the honest-label pass (db/lib/labels.js) tests the SAME refusal words when
// it decides whether a "no" outcome contradicts a text that resolves to act (ADR 0008) —
// one definition, no drift between the stage rule and the contradiction rule.
export function isRefusal(o) {
  o = (o || '').toLowerCase();
  return o.includes('refus') || o.includes('not supported') || o.includes('withdraw')
    || o.includes('lapsed') || o.includes('reject') || o.includes('declined')
    || o.includes('lost');   // "Motion Lost" — a defeated motion is a settled "no", not progress
}

// Rank a single decision's progress on the neutral lifecycle (ADR 0004 + 0007):
//   6 completed · 5 in-progress · 4 decided · 3 under-review · 2 deferred · 1 proposed
//
// `commitment` is the AI's `action` | `process` tag (ADR 0007): `action` = a concrete
// change was approved; `process` = only a step like investigate/review/receive/note. It
// is what separates `decided` from `under-review`. `type` (the topic's representative
// type) is used ONLY as the fallback when the tag is absent.
export function stageRank({ outcome, works_start, commitment } = {}, type) {
  const o = (outcome || '').toLowerCase();

  // Works underway or delivered. `completed` (6) is intentionally never produced: no
  // source signal marks a works finished — a works_start is a start, not an end (ADR 0007).
  if (works_start || o.includes('executed') || o.includes('underway')) return 5;

  // Held over — neither a rejection nor a fresh proposal; it loops (ADR 0004).
  if (o && (o.includes('defer') || o.includes('held over'))) return 2;

  // No determination recorded yet.
  if (!o) return 1;

  // A Question on Notice answered in writing (ADR 0009 sweep stores "answered") is settled —
  // nothing is pending — so at TOPIC level it reads `decided` rather than "under review". The
  // resident-facing decision label is the distinct "Answered" (db/lib/labels.js); this only
  // stops a lone question-on-notice topic from reading as if work were still underway.
  if (o === 'answered') return 4;

  // A refusal is a settled determination → decided (the outcome carries the "no").
  if (isRefusal(o)) return 4;

  // A positive determination. The action-vs-process split decides decided vs under-review.
  // Trust an explicit AI tag; otherwise fall back to the item type. An unrecognised tag
  // value also falls back to the type rule rather than being assumed an action.
  let kind;
  if (commitment === 'process') kind = 'process';
  else if (commitment === 'action') kind = 'action';
  else kind = WORKS_TYPES.has(type) ? 'action' : 'process';
  return kind === 'process' ? 3 : 4;
}

const STAGE_BY_RANK = {
  6: 'completed', 5: 'in-progress', 4: 'decided', 3: 'under-review', 2: 'deferred', 1: 'proposed',
};

// A topic's stage is the most-advanced point any of its decisions reached, so an issue
// approved months ago does not read "proposed" just because a follow-up motion is its
// latest row. `decisions` is an array of { outcome, works_start, commitment }; `type` is
// the topic's representative type, feeding the commitment fallback in stageRank.
export function deriveStage(decisions, type) {
  let rank = 1;
  for (const d of decisions) rank = Math.max(rank, stageRank(d, type));
  return STAGE_BY_RANK[rank];
}
