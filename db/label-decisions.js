#!/usr/bin/env node
/**
 * db/label-decisions.js — the honest-label pass (ADR 0008).
 *
 * For each decision, a model READS the stored `resolution` (plus the stored `outcome` word
 * and `headline` for context) and emits three things:
 *   - commitment:          'action' | 'process' | null  — judged from the FULL resolution
 *                          text, not the outcome word. "Adopt a $164.7m budget" is action
 *                          even when the outcome word is "noted"; "resolve to review road
 *                          safety" is process even when approved. Populates decisions.commitment,
 *                          which deriveStage already reads (revives ADR 0007).
 *   - resident_sentence:   one-to-two plain-English sentences, impact first.
 *   - outcome_matches_text: false when the resolution text and the stored outcome word
 *                          DISAGREE — the pass refuses to guess and the card shows
 *                          "Outcome unclear" (via residentLabel).
 *
 * Reading STORED text is not a re-ingest: it never re-slugs topic ids or touches human
 * aliases, so this pass is NOT blocked by issue #45. After it runs, run
 * `node db/recompute-stages.js` so the now-populated commitment tags flow into topic stages.
 *
 * Usage:
 *   node db/label-decisions.js --dry-run --sample   # read the 4 trap cases + a spread,
 *                                                    #   print labels+sentences, write nothing
 *   node db/label-decisions.js --dry-run             # dry-run over ALL decisions
 *   node db/label-decisions.js                       # apply to live D1 (all decisions)
 *   node db/label-decisions.js --limit 50            # apply to the first 50 only
 *   node db/label-decisions.js --ids a,b,c           # only these decision ids
 *
 * Required env (from .env): ANTHROPIC_API_KEY, CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_DATABASE_ID, CLOUDFLARE_D1_TOKEN.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { normalizeLabelResult, residentLabel, outcomeUnclear } from './lib/labels.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── load .env (same loader as db/recompute-stages.js) ──────────────────────────
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {}

// ─── CLI flags ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const sample = argv.includes('--sample');
const limitArg = argv.find(a => a.startsWith('--limit'));
const limit = limitArg ? Number(limitArg.split('=')[1] ?? argv[argv.indexOf(limitArg) + 1]) : null;
const idsArg = argv.find(a => a.startsWith('--ids'));
const explicitIds = idsArg ? (idsArg.split('=')[1] ?? argv[argv.indexOf(idsArg) + 1]).split(',') : null;

// The four ADR 0008 trap cases, always pulled first in --sample so a preview run proves
// the honesty rules on the exact decisions that motivated them.
const TRAP_IDS = [
  'council-16jun2026-02',  // budget "noted" that ADOPTS $164.7m → action → Decided
  'council-17feb2026-37',  // Unwins Bridge Rd safety REVIEW, approved → process → Being looked into
  'council-16jun2026-38',  // civic offices: text "investigate" vs outcome "not supported" → unclear
  'ltf-15jun2026-07',      // agenda-only "…approved" headline, no vote → Coming up
];

// ─── D1 REST API (same shape as db/recompute-stages.js) ─────────────────────────
async function d1Query(sql, params = []) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_DATABASE_ID;
  const token = process.env.CLOUDFLARE_D1_TOKEN;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    },
  );
  const json = await res.json();
  if (!json.success) throw new Error(`D1 error: ${JSON.stringify(json.errors)}`);
  return json.result[0].results;
}

// ─── pick the decisions to read ──────────────────────────────────────────────────
// Each row carries the decision fields plus the topic's representative `type`, which
// deriveStage needs as the fallback when a commitment tag is absent.
async function loadDecisions() {
  const base =
    `SELECT d.id, d.outcome, d.headline, d.resolution, t.type
       FROM decisions d JOIN topics t ON t.id = d.topic_id`;

  if (explicitIds) {
    const ph = explicitIds.map(() => '?').join(',');
    return d1Query(`${base} WHERE d.id IN (${ph})`, explicitIds);
  }
  if (sample) {
    // The four traps first, then a spread of other decisions to eyeball the general tone.
    const ph = TRAP_IDS.map(() => '?').join(',');
    const traps = await d1Query(`${base} WHERE d.id IN (${ph})`, TRAP_IDS);
    const spread = await d1Query(
      `${base} WHERE d.id NOT IN (${ph}) ORDER BY d.id LIMIT 11`, TRAP_IDS,
    );
    return [...traps, ...spread];
  }
  const rows = await d1Query(`${base} ORDER BY d.id`);
  return limit ? rows.slice(0, limit) : rows;
}

// ─── the read prompt ─────────────────────────────────────────────────────────────
// Plain-language, honesty-first (ADR 0008). The model is handed the council's own outcome
// word AND the full resolution so it can catch the cases where they disagree.
function buildLabelPrompt(items) {
  const blocks = items.map((it, i) => (
    `=== ITEM ${i + 1} (id: ${it.id}) ===\n`
    + `OUTCOME WORD: ${it.outcome ?? '(none recorded — not yet decided)'}\n`
    + `HEADLINE: ${it.headline ?? ''}\n`
    + `RESOLUTION:\n${(it.resolution ?? '(no resolution text recorded)').slice(0, 2500)}`
  )).join('\n\n');

  return `You summarise Inner West Council (Sydney) decisions for local residents who would never read a council agenda. For each item you get the council's raw OUTCOME WORD, a short HEADLINE, and the full RESOLUTION text of what the council actually resolved.

Return ONLY a JSON array, one object per item, in the same order, each object exactly:
{"id": "<the id>", "commitment": "action" | "process" | null, "resident_sentence": "<text>", "text_has_refusal": true | false}

commitment — judge from the FULL RESOLUTION TEXT, not the outcome word:
- "action": the council committed to a concrete change — build, install, approve works, adopt a budget or plan, execute a contract, fund something. Adopting a budget or plan IS action even if the outcome word is only "noted".
- "process": the council only committed to a step — investigate, review, receive/note a report, consult, prepare a report, support "in principle". Approving a motion to REVIEW road safety is process, not action.
- null: the resolution refuses, rejects, defers, withdraws, or records no determination; OR the OUTCOME WORD is "(none recorded — not yet decided)".
- If a resolution mixes concrete action with process steps, choose "action" (understating a real commitment is the worse error).

resident_sentence — one to two plain-English sentences, at most ~240 characters:
- Lead with what it means for the neighbourhood (the impact: what is changing, where), then timing if given. Process comes last or not at all.
- Describe what was DECIDED, not what was asked. A "no" must read as a "no" (rejection first).
- No council jargon. Spell out acronyms (LTF = Local Traffic Committee, LATM = Local Area Traffic Management, RPS = Resident Parking Scheme, VPA = Voluntary Planning Agreement).
- If the OUTCOME WORD is "(none recorded — not yet decided)", this is coming up but NOT decided — write it as a proposal ("Council will consider…"), never as done.

text_has_refusal — a simple factual check of the RESOLUTION TEXT ONLY (ignore the outcome word and the headline): does the resolution text itself refuse, reject, decline, not support, withdraw, rule out, or knock back ANYTHING? Answer true if any part of the text refuses something; false if the text only proceeds — approves, adopts, notes, investigates, or defers without refusing. (A deferral is not a refusal.) Judge only what the text says, do not reason about whether it matches the outcome word.

ITEMS:
${blocks}`;
}

// The deterministic sentence for a flagged (contradiction) decision. We don't narrate a
// determination we can't trust — we state the gap plainly and say the source needs checking
// (ADR 0008: these join the "needs the source document" queue).
function unclearSentence(src) {
  const acts = 'the resolution reads as a decision to go ahead';
  return `The council's record here is inconsistent: the outcome is logged as "${src.outcome}", but ${acts}. We're checking the original document before saying what was decided.`;
}

// ─── run the model over one batch ────────────────────────────────────────────────
const BATCH_SIZE = 15;

async function readBatch(client, items) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    messages: [{ role: 'user', content: buildLabelPrompt(items) }],
  });
  const raw = response.content[0].text.trim();
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`Model returned no JSON array:\n${raw.slice(0, 300)}`);
  return JSON.parse(jsonMatch[0]);
}

// ─── main ─────────────────────────────────────────────────────────────────────────
async function main() {
  const required = ['ANTHROPIC_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_D1_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(', ')} (expected in .env)`);
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const decisions = await loadDecisions();
  console.log(`${dryRun ? 'DRY RUN — ' : ''}reading ${decisions.length} decision(s)${sample ? ' (4 traps + spread)' : ''}\n`);

  const byId = new Map(decisions.map(d => [d.id, d]));
  let applied = 0, unclear = 0;

  for (let i = 0; i < decisions.length; i += BATCH_SIZE) {
    const batch = decisions.slice(i, i + BATCH_SIZE);
    const results = await readBatch(client, batch);

    for (const raw of results) {
      const src = byId.get(raw.id);
      if (!src) { console.warn(`  ! model returned unknown id ${raw.id}, skipping`); continue; }

      const norm = normalizeLabelResult(raw);

      // The contradiction flag is DERIVED from the stored outcome word + the model's
      // commitment + its text_has_refusal signal (ADR 0008) — not the model guessing whether
      // things "match", which over-flagged clean deferrals and contract awards.
      const isUnclear = outcomeUnclear({
        outcome: src.outcome, commitment: norm.commitment, textHasRefusal: norm.textHasRefusal,
      });
      const outcome_unclear = isUnclear ? 1 : 0;
      if (isUnclear) unclear++;

      // When flagged, the sentence must SAY the record is inconsistent rather than narrate a
      // determination we don't trust — a deterministic note, so it never reads as fact.
      const sentence = isUnclear ? unclearSentence(src) : norm.resident_sentence;

      // The honest label a resident will actually see, using the SAME residentLabel the
      // site will call — so the dry-run shows the real outcome, not a guess about it.
      const label = residentLabel({ ...src, commitment: norm.commitment, outcome_unclear }, src.type);

      if (dryRun) {
        console.log(`  [${label}]  ${src.id}  (outcome: ${src.outcome ?? 'null'} · commitment: ${norm.commitment ?? 'null'})`);
        console.log(`     ${sentence ?? '(no sentence)'}\n`);
      } else {
        await d1Query(
          `UPDATE decisions SET commitment = ?, resident_sentence = ?, outcome_unclear = ? WHERE id = ?`,
          [norm.commitment, sentence, outcome_unclear, src.id],
        );
        applied++;
      }
    }
  }

  console.log(`\n${dryRun ? 'Dry run complete' : `Applied ${applied} update(s)`} — ${unclear} flagged "Outcome unclear".`);
  if (!dryRun) console.log('Next: run `node db/recompute-stages.js` to flow the new commitment tags into topic stages.');
}

main().catch(err => { console.error(err); process.exit(1); });
