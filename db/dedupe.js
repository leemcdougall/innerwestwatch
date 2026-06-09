#!/usr/bin/env node
/**
 * db/dedupe.js — Offline topic deduplication tool
 *
 * Surfaces candidate duplicate topic pairs for human review and records
 * dispositions. See ADR 0002 for design rationale.
 *
 * Usage:
 *   node db/dedupe.js              — review candidates interactively
 *   node db/dedupe.js --dry-run    — print candidates only, no prompts
 *   node db/dedupe.js --window 24  — override time window (months, default 18)
 *
 * Candidate query logic:
 *   - Same type
 *   - At least one overlapping street (skipped for types that rarely have streets)
 *   - Meeting dates within --window months of each other
 *   - Not already in merge_decisions
 *   - Ranked by street overlap fraction descending
 *
 * Three dispositions per pair:
 *   m — Merge: set canonical_topic_id on the older topic, log to topic_merge_log
 *   d — Dismiss once: suppress for 18 months
 *   r — Recurring: suppress permanently (same streets, genuinely distinct program)
 *   s — Skip: do nothing this run (not recorded)
 */

import { spawnSync } from 'child_process';
import * as readline from 'readline';

// ── Config ─────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const DRY_RUN    = args.includes('--dry-run');
const windowIdx  = args.indexOf('--window');
const WINDOW_MONTHS = windowIdx !== -1 ? parseInt(args[windowIdx + 1], 10) : 18;
const DECIDED_BY = process.env.USER || 'cli';

// ── D1 helpers ──────────────────────────────────────────────────────────────

// Use spawnSync with args as an array to bypass the shell entirely —
// avoids both shell quoting issues and the ENOBUFS arg-length limit.
function d1(sql, label = '') {
  const result = spawnSync(
    'wrangler',
    ['d1', 'execute', 'counciltracker', '--remote', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );

  if (result.error) throw result.error;

  // wrangler emits the warning line on stderr; stdout is the JSON array.
  const raw = result.stdout || '';
  const jsonStart = raw.indexOf('[');
  if (jsonStart === -1) {
    const hint = (result.stderr || '').slice(0, 200);
    throw new Error(`No JSON in wrangler output${label ? ' (' + label + ')' : ''}. stderr: ${hint}`);
  }
  const parsed = JSON.parse(raw.slice(jsonStart));
  const res = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!res.success) throw new Error(`D1 error${label ? ' (' + label + ')' : ''}: ${JSON.stringify(res)}`);
  return res.results || [];
}

// ── Candidate query ─────────────────────────────────────────────────────────

function fetchCandidates() {
  // Window cutoff: topics whose meetings are more than WINDOW_MONTHS apart are excluded.
  // SQLite date math: julianday difference / 30.44 ≈ months.
  //
  // We join topics a and b where:
  //   - same type
  //   - at least one common street (JSON array overlap via LIKE)
  //   - meeting dates within window
  //   - a.id < b.id to avoid surfacing both (a,b) and (b,a)
  //   - not already in merge_decisions (either order)
  //   - neither row is already merged away (canonical_topic_id IS NULL)
  //
  // Street overlap fraction = shared_streets / union_streets (approximated per pair
  // by counting LIKE matches — exact set math would require JSON each() which D1
  // may not support). We return raw streets and compute fraction in JS.

  // Subquery gets the earliest meeting date per topic (handles future multi-decision topics).
  // Main query pairs same-type topics, applies window + merge_decisions exclusion.
  // No GROUP BY needed — the subquery ensures one date row per topic.
  const sql = `
    WITH topic_dates AS (
      SELECT d.topic_id, MIN(m.date) AS earliest_date, m.id AS meeting_id
      FROM decisions d
      JOIN meetings m ON m.id = d.meeting_id
      GROUP BY d.topic_id
    )
    SELECT
      a.id            AS id_a,
      a.headline      AS headline_a,
      a.streets       AS streets_a,
      a.suburbs       AS suburbs_a,
      a.status        AS status_a,
      tda.earliest_date AS date_a,
      tda.meeting_id  AS meeting_a,
      b.id            AS id_b,
      b.headline      AS headline_b,
      b.streets       AS streets_b,
      b.suburbs       AS suburbs_b,
      b.status        AS status_b,
      tdb.earliest_date AS date_b,
      tdb.meeting_id  AS meeting_b,
      ABS(julianday(tda.earliest_date) - julianday(tdb.earliest_date)) / 30.44 AS months_apart
    FROM topics a
    JOIN topic_dates tda ON tda.topic_id = a.id
    JOIN topics b ON b.type = a.type AND b.id > a.id
    JOIN topic_dates tdb ON tdb.topic_id = b.id
    WHERE
      a.canonical_topic_id IS NULL
      AND b.canonical_topic_id IS NULL
      AND a.streets != '[]'
      AND b.streets != '[]'
      AND ABS(julianday(tda.earliest_date) - julianday(tdb.earliest_date)) / 30.44 <= ${WINDOW_MONTHS}
      AND NOT EXISTS (
        SELECT 1 FROM merge_decisions md
        WHERE (md.topic_id_a = a.id AND md.topic_id_b = b.id)
           OR (md.topic_id_a = b.id AND md.topic_id_b = a.id)
      )
    ORDER BY months_apart ASC
  `;

  return d1(sql, 'fetch candidates');
}

// ── Street overlap fraction ─────────────────────────────────────────────────

function overlapFraction(streetsJsonA, streetsJsonB) {
  const a = new Set(JSON.parse(streetsJsonA || '[]').map(s => s.toLowerCase()));
  const b = new Set(JSON.parse(streetsJsonB || '[]').map(s => s.toLowerCase()));
  if (a.size === 0 && b.size === 0) return 0;
  const shared  = [...a].filter(s => b.has(s)).length;
  const union   = new Set([...a, ...b]).size;
  return shared / union;
}

// ── Disposition actions ─────────────────────────────────────────────────────

function recordMerge(idA, idB, dateA, dateB) {
  // Older topic (earlier meeting date) becomes the canonical row.
  // Newer topic points to it via canonical_topic_id.
  const [canonical, duplicate] = dateA <= dateB ? [idA, idB] : [idB, idA];
  const now = new Date().toISOString();

  d1(`UPDATE topics SET canonical_topic_id = '${canonical}' WHERE id = '${duplicate}'`, 'set canonical');
  d1(`
    INSERT INTO topic_merge_log (merge_from, merge_to, merged_at, merged_by)
    VALUES ('${duplicate}', '${canonical}', '${now}', '${DECIDED_BY}')
  `, 'log merge');
  d1(`
    INSERT OR REPLACE INTO merge_decisions (topic_id_a, topic_id_b, decision, decided_at, decided_by)
    VALUES ('${idA}', '${idB}', 'merged', '${now}', '${DECIDED_BY}')
  `, 'record decision');

  console.log(`  Merged: ${duplicate} → ${canonical}`);
}

function recordDismiss(idA, idB, mode) {
  const now = new Date().toISOString();
  const decision = mode === 'recurring' ? 'recurring' : 'dismissed_once';
  d1(`
    INSERT OR REPLACE INTO merge_decisions (topic_id_a, topic_id_b, decision, decided_at, decided_by)
    VALUES ('${idA}', '${idB}', '${decision}', '${now}', '${DECIDED_BY}')
  `, 'record decision');
  console.log(`  Recorded as ${decision}.`);
}

// ── CLI prompt ──────────────────────────────────────────────────────────────

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nInner West Watch — Topic Deduplication Tool`);
  console.log(`Time window: ${WINDOW_MONTHS} months | Dry run: ${DRY_RUN}\n`);

  const rows = fetchCandidates();

  if (rows.length === 0) {
    console.log('No candidate duplicate pairs found.');
    return;
  }

  // Compute overlap fraction and sort by descending overlap (strongest matches first).
  const candidates = rows
    .map(r => ({ ...r, overlap: overlapFraction(r.streets_a, r.streets_b) }))
    .filter(r => r.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);

  console.log(`Found ${candidates.length} candidate pair(s).\n`);

  if (DRY_RUN) {
    for (const c of candidates) {
      const pct = Math.round(c.overlap * 100);
      console.log(`[${pct}% overlap | ${c.months_apart.toFixed(1)} months apart]`);
      console.log(`  A: ${c.id_a} (${c.date_a}, ${c.meeting_a})`);
      console.log(`     ${c.headline_a}`);
      console.log(`     Streets: ${c.streets_a} | Suburbs: ${c.suburbs_a}`);
      console.log(`  B: ${c.id_b} (${c.date_b}, ${c.meeting_b})`);
      console.log(`     ${c.headline_b}`);
      console.log(`     Streets: ${c.streets_b} | Suburbs: ${c.suburbs_b}`);
      console.log('');
    }
    return;
  }

  // Interactive review.
  let merged = 0, dismissed = 0, recurring = 0, skipped = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c   = candidates[i];
    const pct = Math.round(c.overlap * 100);

    console.log(`\n─── Pair ${i + 1} of ${candidates.length} ─── [${pct}% street overlap | ${c.months_apart.toFixed(1)} months apart]`);
    console.log(`  A: ${c.id_a}`);
    console.log(`     ${c.date_a} | ${c.meeting_a} | status: ${c.status_a}`);
    console.log(`     "${c.headline_a}"`);
    console.log(`     Streets: ${JSON.parse(c.streets_a).join(', ')}`);
    console.log(`     Suburbs: ${JSON.parse(c.suburbs_a).join(', ')}`);
    console.log('');
    console.log(`  B: ${c.id_b}`);
    console.log(`     ${c.date_b} | ${c.meeting_b} | status: ${c.status_b}`);
    console.log(`     "${c.headline_b}"`);
    console.log(`     Streets: ${JSON.parse(c.streets_b).join(', ')}`);
    console.log(`     Suburbs: ${JSON.parse(c.suburbs_b).join(', ')}`);
    console.log('');

    const answer = await prompt('  Disposition — m=merge  d=dismiss once  r=recurring  s=skip  q=quit: ');

    if (answer === 'q') {
      console.log('\nStopped early.');
      break;
    } else if (answer === 'm') {
      recordMerge(c.id_a, c.id_b, c.date_a, c.date_b);
      merged++;
    } else if (answer === 'd') {
      recordDismiss(c.id_a, c.id_b, 'dismissed_once');
      dismissed++;
    } else if (answer === 'r') {
      recordDismiss(c.id_a, c.id_b, 'recurring');
      recurring++;
    } else {
      console.log('  Skipped.');
      skipped++;
    }
  }

  console.log(`\nDone. Merged: ${merged} | Dismissed: ${dismissed} | Recurring: ${recurring} | Skipped: ${skipped}\n`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
