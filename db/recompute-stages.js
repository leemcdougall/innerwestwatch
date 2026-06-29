#!/usr/bin/env node
/**
 * db/recompute-stages.js — recompute every topic's `stage` from its decisions.
 *
 * Stage is derived (ADR 0004 + 0007): it is a pure function of a topic's decisions, so
 * after the stage LOGIC changes (db/lib/topics.js) the stored values can be brought into
 * line WITHOUT re-reading any source document. That matters because a full re-ingest
 * rewords AI subjects and re-slugs topic ids — churning the topic-id space and the learned
 * human aliases (see issue: re-ingest topic-id stability). This script touches only the
 * `stage` column; it never re-slugs, re-threads, or calls the AI, so it is safe to run on
 * the live database any time the derivation rule changes.
 *
 * It reuses deriveStage directly, so there is no second copy of the logic to drift. With
 * no `commitment` tags present (the AI tagging is deferred until re-ingest is stabilised),
 * deriveStage falls back to the item type — the deterministic rule that correctly reads a
 * notice-of-motion / report as `under-review` rather than `decided`.
 *
 * Usage:
 *   node db/recompute-stages.js            # apply changes to live D1
 *   node db/recompute-stages.js --dry-run  # report what would change, write nothing
 *
 * Required env (same as ingest.js, from .env): CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_DATABASE_ID, CLOUDFLARE_D1_TOKEN.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { deriveStage } from './lib/topics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── load .env ────────────────────────────────────────────────────────────────
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {}

const dryRun = process.argv.includes('--dry-run');

// ─── D1 REST API (same shape as db/ingest.js) ────────────────────────────────
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
    }
  );
  const data = await res.json();
  if (!data.success) throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}\nSQL: ${sql}`);
  return data.result;
}

async function main() {
  const required = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_D1_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  // One pass: every decision with its topic's current stage + type. The topic type is the
  // same on each of its rows; it feeds deriveStage's commitment fallback (ADR 0007).
  const rows = (await d1Query(`
    SELECT d.topic_id, d.outcome, d.works_start, d.commitment, t.type, t.stage AS current_stage
    FROM decisions d JOIN topics t ON t.id = d.topic_id
  `))[0]?.results || [];

  // Group decisions by topic.
  const byTopic = new Map();
  for (const r of rows) {
    if (!byTopic.has(r.topic_id)) {
      byTopic.set(r.topic_id, { type: r.type, current: r.current_stage, decisions: [] });
    }
    byTopic.get(r.topic_id).decisions.push(r);
  }

  const changes = [];
  for (const [topicId, { type, current, decisions }] of byTopic) {
    const next = deriveStage(decisions, type);
    if (next !== current) changes.push({ topicId, from: current, to: next });
  }

  // Report the before/after movement.
  const movement = new Map();
  for (const c of changes) {
    const key = `${c.from} -> ${c.to}`;
    movement.set(key, (movement.get(key) || 0) + 1);
  }
  console.log(`${byTopic.size} topics scanned, ${changes.length} stage change(s)${dryRun ? ' (dry run)' : ''}:`);
  for (const [k, n] of [...movement.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${n}`);
  }

  if (dryRun || changes.length === 0) return;

  for (const c of changes) {
    await d1Query('UPDATE topics SET stage = ? WHERE id = ?', [c.to, c.topicId]);
  }
  console.log(`\nupdated ${changes.length} topic(s).`);
}

main().catch(err => {
  console.error('fatal:', err.message);
  process.exit(1);
});
