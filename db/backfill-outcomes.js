#!/usr/bin/env node
/**
 * db/backfill-outcomes.js — fill MISSING outcomes from published minutes (ADR 0008 null triage).
 *
 * Some decisions have a null `outcome` even though their meeting's minutes are published: the
 * minutes-extraction skipped them (items adopted "in globo"/en bloc, or grouped resolutions the
 * per-item parser missed). Those items read "Coming up" though the meeting already decided them.
 *
 * This pass fetches the published minutes, has a model LOCATE each null item's recorded outcome
 * in the source, and fills it in — reusing the ADR 0008 label logic (normalizeLabelResult,
 * outcomeUnclear). It UPDATEs only decisions.{outcome, resolution, commitment, resident_sentence,
 * outcome_unclear} for EXISTING rows, keyed by decision id. It never creates decisions, re-slugs
 * topics, or touches topic_subjects — so it is NOT a re-ingest and is not blocked by issue #45.
 * Run `node db/recompute-stages.js` afterwards to flow the new outcomes into topic stages.
 *
 * Usage:
 *   node db/backfill-outcomes.js --meeting council-19aug2025 --dry-run   # preview one meeting
 *   node db/backfill-outcomes.js --meeting council-19aug2025             # apply that meeting
 *   node db/backfill-outcomes.js --all --dry-run                        # every minutes-blank meeting
 *
 * Required env (from .env): ANTHROPIC_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID,
 * CLOUDFLARE_D1_TOKEN.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { normalizeLabelResult, outcomeUnclear, residentLabel } from './lib/labels.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── load .env ────────────────────────────────────────────────────────────────
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const all = argv.includes('--all');
const meetingArg = argv.find(a => a.startsWith('--meeting'));
const meetingId = meetingArg ? (meetingArg.split('=')[1] ?? argv[argv.indexOf(meetingArg) + 1]) : null;

// ─── D1 REST API ────────────────────────────────────────────────────────────────
async function d1Query(sql, params = []) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_DATABASE_ID;
  const token = process.env.CLOUDFLARE_D1_TOKEN;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }) },
  );
  const json = await res.json();
  if (!json.success) throw new Error(`D1 error: ${JSON.stringify(json.errors)}`);
  return json.result[0].results;
}

// Strip an infocouncil HTML page to whitespace-collapsed text.
function htmlToText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&#8217;/g, "'").replace(/&#8211;|&#8212;/g, '-')
    .replace(/\s+/g, ' ').trim();
}

// The read prompt: the model is given the full minutes text plus the exact items we still
// need, and must locate each item's RECORDED outcome (individual resolution, en-bloc "in
// globo" adoption, deferral, withdrawal, or none). Same {commitment, resident_sentence,
// text_has_refusal} contract as db/label-decisions.js, plus the raw `outcome` word and a
// `found` flag for items the minutes genuinely never determine (e.g. a public-forum address).
function buildPrompt(minutesText, items) {
  const list = items.map(it => `- item ${it.item_number}: ${it.headline ?? '(no headline)'}`).join('\n');
  return `You are reading the published MINUTES of an Inner West Council (Sydney) meeting to recover the recorded outcome of specific agenda items whose outcome we failed to capture. Items may be resolved individually ("Motion Carried/Lost"), adopted as a batch ("moved in globo ... recommendations ... adopted"), deferred, or withdrawn. Some items (e.g. a public-forum speaker, a question taken on notice) may have NO determination at all.

For EACH requested item, return one JSON object. Return ONLY a JSON array in the same order:
{"item_number": <n>, "found": true|false, "outcome": "<raw word>", "resolution": "<plain summary of what was resolved>", "commitment": "action"|"process"|null, "resident_sentence": "<text>", "text_has_refusal": true|false}

- found: false only when the minutes record NO determination for the item (then set outcome null and briefly say so in resident_sentence). If the item was adopted in globo / as recommended, that IS a determination → found true, outcome "adopted".
- outcome: the council's raw determination word — approved / carried / adopted / noted / endorsed / deferred / lost / withdrawn / "not supported", etc. For a batch "in globo" adoption use "adopted".
- resolution: one plain sentence of what was actually resolved (not the debate).
- commitment: judge from what was resolved — "action" (a concrete change: build, adopt a plan/budget, fund, execute) vs "process" (only investigate/review/receive/note/endorse in principle); null if the item was refused, deferred, withdrawn, or not determined. Action wins a mixed resolution.
- resident_sentence: one to two plain-English sentences, impact first, at most ~240 chars. Describe what was DECIDED, not what was proposed. Spell out acronyms (LEP = Local Environment Plan, RAP = Reconciliation Action Plan). A rejection reads as a rejection.
- text_has_refusal: true if the resolution text itself refuses/rejects/declines anything.

ITEMS TO FIND:
${list}

MINUTES TEXT:
${minutesText}`;
}

async function readMinutes(client, minutesText, items) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    messages: [{ role: 'user', content: buildPrompt(minutesText, items) }],
  });
  const raw = response.content[0].text.trim();
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`Model returned no JSON array:\n${raw.slice(0, 300)}`);
  return JSON.parse(m[0]);
}

// ─── process one meeting ─────────────────────────────────────────────────────────
async function processMeeting(client, mid) {
  const [meeting] = await d1Query(
    `SELECT id, minutes_url, minutes_published FROM meetings WHERE id = ?`, [mid]);
  if (!meeting) { console.log(`  ! meeting ${mid} not found`); return { filled: 0, unresolved: 0 }; }
  if (!meeting.minutes_published || !meeting.minutes_url) {
    console.log(`  ! ${mid} has no published minutes — skipping (agenda-only null, honestly "Coming up")`);
    return { filled: 0, unresolved: 0 };
  }

  const items = await d1Query(
    `SELECT id, item_number, headline FROM decisions
       WHERE meeting_id = ? AND outcome IS NULL ORDER BY item_number`, [mid]);
  if (items.length === 0) { console.log(`  ${mid}: no null outcomes`); return { filled: 0, unresolved: 0 }; }

  console.log(`\n${mid} — ${items.length} null item(s); fetching minutes…`);
  const html = await (await fetch(meeting.minutes_url)).text();
  const text = htmlToText(html);

  const results = await readMinutes(client, text, items);
  const byNum = new Map(items.map(it => [it.item_number, it]));

  let filled = 0, unresolved = 0;
  for (const r of results) {
    const src = byNum.get(r.item_number);
    if (!src) continue;

    if (!r.found || !r.outcome) {
      unresolved++;
      console.log(`  [no determination] item ${r.item_number} — ${src.headline}`);
      continue;
    }

    const norm = normalizeLabelResult(r);            // commitment, resident_sentence, textHasRefusal
    const unclear = outcomeUnclear({ outcome: r.outcome, commitment: norm.commitment, textHasRefusal: norm.textHasRefusal });
    const label = residentLabel(
      { outcome: r.outcome, commitment: norm.commitment, outcome_unclear: unclear ? 1 : 0 }, 'motion');

    if (dryRun) {
      console.log(`  [${label}] item ${r.item_number} (outcome: ${r.outcome} · commitment: ${norm.commitment ?? 'null'})`);
      console.log(`     ${norm.resident_sentence ?? '(no sentence)'}`);
    } else {
      await d1Query(
        `UPDATE decisions SET outcome = ?, resolution = ?, commitment = ?, resident_sentence = ?, outcome_unclear = ?
           WHERE id = ?`,
        [r.outcome, r.resolution ?? null, norm.commitment, norm.resident_sentence, unclear ? 1 : 0, src.id]);
    }
    filled++;
  }
  console.log(`  ${dryRun ? 'would fill' : 'filled'} ${filled}; ${unresolved} genuinely no-determination.`);
  return { filled, unresolved };
}

async function main() {
  const required = ['ANTHROPIC_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_D1_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) { console.error(`Missing env: ${missing.join(', ')}`); process.exit(1); }
  if (!meetingId && !all) { console.error('Pass --meeting <id> or --all'); process.exit(1); }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let meetings;
  if (all) {
    meetings = (await d1Query(
      `SELECT DISTINCT d.meeting_id AS id FROM decisions d JOIN meetings m ON m.id = d.meeting_id
         WHERE d.outcome IS NULL AND m.minutes_published = 1 ORDER BY d.meeting_id`)).map(r => r.id);
  } else {
    meetings = [meetingId];
  }

  console.log(`${dryRun ? 'DRY RUN — ' : ''}backfilling outcomes for ${meetings.length} meeting(s)`);
  let totalFilled = 0, totalUnresolved = 0;
  for (const mid of meetings) {
    const { filled, unresolved } = await processMeeting(client, mid);
    totalFilled += filled; totalUnresolved += unresolved;
  }
  console.log(`\n${dryRun ? 'Would fill' : 'Filled'} ${totalFilled} outcome(s); ${totalUnresolved} left as no-determination.`);
  if (!dryRun) console.log('Next: run `node db/recompute-stages.js`.');
}

main().catch(err => { console.error(err); process.exit(1); });
