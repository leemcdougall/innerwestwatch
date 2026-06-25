/**
 * db/apply-subject-aliases.js — write the relations review-loop aliases (ADR 0006, session 11)
 *
 * Closes the gap that left 38/100 relations resolved after the session-9 reingest re-slugged
 * topics. For every subject in db/human-relations.json it writes a source='human' alias into
 * topic_subjects (normKey(subject) -> current topic id) so the link resolves by EXACT alias on
 * every future run, surviving slug churn (the trend-to-zero mechanism).
 *
 * Two sources of truth feed it:
 *   - db/relation-subject-aliases.json `mappings`: human-verified subject->topic decisions,
 *     each confirmed against the infocouncil SOURCE document (notes carry the ref). These
 *     OVERRIDE any fuzzy guess (e.g. the 'Local Transport Forum recommendations' umbrella, which
 *     fuzzy-matched the wrong month).
 *   - db/relation-subject-aliases.json `leave`: subjects deliberately left unresolved (generic
 *     phrasing with no single valid topic, or a matter the reingest split into near-duplicates).
 *     Forcing those would publish a falsehood, so they are skipped.
 *
 * Any OTHER human-relations subject that currently resolves via FUZZY sameSubject() (not an exact
 * alias) is pinned with a sticky source='human' alias too, so the whole resolved set survives the
 * next reingest (approved 2026-06-25). Subjects that already have an exact alias are left untouched.
 *
 * normKey()/tokenSet()/sameSubject() come from db/lib/topics.js so a subject normalises here
 * exactly as it does in ingest.js / match.js / apply-relations.js.
 *
 * Usage:
 *   node db/apply-subject-aliases.js            # dry run: resolve + print, write nothing
 *   node db/apply-subject-aliases.js --apply    # upsert source='human' aliases into live D1
 *
 * Required env (db/../.env): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID, CLOUDFLARE_D1_TOKEN.
 * After applying, run `node db/apply-relations.js --rebuild` to re-materialise topic_relations.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { normKey, tokenSet, sameSubject } from './lib/topics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── load .env (same minimal loader as the other db scripts) ──────────────────
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {}

const APPLY = process.argv.includes('--apply');

async function d1Query(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${process.env.CLOUDFLARE_DATABASE_ID}/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_D1_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params }) }
  );
  const data = await res.json();
  if (!data.success) throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}\nSQL: ${sql}`);
  return data.result;
}

async function main() {
  const { relations } = JSON.parse(readFileSync(resolve(__dirname, 'human-relations.json'), 'utf8'));
  const { mappings, leave } = JSON.parse(readFileSync(resolve(__dirname, 'relation-subject-aliases.json'), 'utf8'));

  const manual = new Map(mappings.map(m => [m.subject, m.topicId]));
  const leaveSet = new Set(leave.map(l => l.subject));

  // Snapshot live alias store + topics.
  const aliasRows = (await d1Query('SELECT subject_key, topic_id FROM topic_subjects')).at(0).results;
  const aliasMap = new Map(aliasRows.map(r => [r.subject_key, r.topic_id]));
  const topicRows = (await d1Query('SELECT id, subject FROM topics')).at(0).results;
  const topicIds = new Set(topicRows.map(t => t.id));
  const topics = topicRows.map(t => ({ id: t.id, tokens: tokenSet(t.subject) }));
  console.log(`Live D1: ${aliasMap.size} aliases, ${topics.length} topics`);

  // GUARD: every manual mapping must point at a topic that still exists. If a reingest churned an
  // id out from under a mapping, abort loudly rather than write a dangling alias.
  const badTargets = mappings.filter(m => !topicIds.has(m.topicId));
  if (badTargets.length) {
    console.error(`\nABORT: ${badTargets.length} mapping(s) point at a topic id no longer in D1 (reingest churn?):`);
    for (const m of badTargets) console.error(`  "${m.subject}" -> ${m.topicId}`);
    process.exitCode = 1;
    return;
  }

  // Fuzzy resolver (mirrors apply-relations.js makeResolver fallback).
  function fuzzy(subject) {
    const want = tokenSet(subject);
    if (!want.size) return null;
    let best = null, bestScore = -1, tie = false;
    for (const t of topics) {
      if (!sameSubject(want, t.tokens)) continue;
      let inter = 0; for (const w of want) if (t.tokens.has(w)) inter++;
      const score = inter / (want.size + t.tokens.size - inter);
      if (score > bestScore) { best = t; bestScore = score; tie = false; }
      else if (score === bestScore) tie = true;
    }
    if (!best || tie) return null;
    return best.id;
  }

  // Unique subjects across both sides of every link.
  const subjects = new Set();
  for (const rel of relations) { subjects.add(rel.subjectA); subjects.add(rel.subjectB); }

  const toWrite = [];   // { key, subject, topicId, mode }
  const skipped = { alreadyAlias: 0, left: 0 };
  const stillUnresolved = [];

  for (const subject of subjects) {
    const key = normKey(subject);
    if (leaveSet.has(subject)) { skipped.left++; continue; }

    if (manual.has(subject)) {
      toWrite.push({ key, subject, topicId: manual.get(subject), mode: 'manual' });
      continue;
    }
    if (aliasMap.has(key)) { skipped.alreadyAlias++; continue; }  // already sticky

    const fz = fuzzy(subject);
    if (fz) { toWrite.push({ key, subject, topicId: fz, mode: 'fuzzy-sticky' }); continue; }

    stillUnresolved.push(subject);   // not manual, not aliased, not fuzzy — expected only for novel gaps
  }

  // De-dup by key (several phrasings can normalise to the same key); manual wins over fuzzy.
  const byKey = new Map();
  for (const w of toWrite) {
    const prev = byKey.get(w.key);
    if (!prev || (prev.mode !== 'manual' && w.mode === 'manual')) byKey.set(w.key, w);
  }
  const writes = [...byKey.values()];

  // Report.
  const manualWrites = writes.filter(w => w.mode === 'manual');
  const fuzzyWrites = writes.filter(w => w.mode === 'fuzzy-sticky');
  console.log(`\nUnique subjects: ${subjects.size}`);
  console.log(`  manual (verified) aliases:   ${manualWrites.length}`);
  console.log(`  fuzzy-sticky aliases:        ${fuzzyWrites.length}`);
  console.log(`  already aliased (skipped):   ${skipped.alreadyAlias}`);
  console.log(`  left unresolved (by design): ${skipped.left}`);
  if (stillUnresolved.length) {
    console.log(`\n  ⚠ ${stillUnresolved.length} subject(s) neither mapped, aliased, fuzzy, nor in leave-list:`);
    for (const s of stillUnresolved) console.log(`      "${s}"`);
  }
  console.log('\nManual (source-verified) writes:');
  for (const w of manualWrites) console.log(`  [${w.key}] -> ${w.topicId}`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to upsert these aliases.');
    return;
  }

  // Upsert. ON CONFLICT lets a verified mapping override a stale alias key; fuzzy-sticky keys
  // never pre-exist (that is why they were fuzzy), so they simply insert. created_at marks the
  // review-loop date. Chunked: topic_subjects has 4 columns, D1 caps bound params at 100.
  const CHUNK = 20;
  let written = 0;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = writes.slice(i, i + CHUNK);
    const values = batch.map(() => '(?, ?, ?, ?)').join(', ');
    const params = batch.flatMap(w => [w.key, w.topicId, 'human', '2026-06-25']);
    const res = await d1Query(
      `INSERT INTO topic_subjects (subject_key, topic_id, source, created_at) VALUES ${values}
       ON CONFLICT(subject_key) DO UPDATE SET topic_id = excluded.topic_id, source = 'human'`,
      params
    );
    written += res.at(0).meta?.changes ?? 0;
  }
  const total = (await d1Query('SELECT COUNT(*) AS n FROM topic_subjects')).at(0).results.at(0).n;
  const human = (await d1Query("SELECT COUNT(*) AS n FROM topic_subjects WHERE source='human'")).at(0).results.at(0).n;
  console.log(`\nApplied. Rows changed: ${written}. topic_subjects now holds ${total} aliases (${human} source='human').`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
