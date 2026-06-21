#!/usr/bin/env node
/**
 * db/match.js — topic threading / reconciliation tool (supersedes db/dedupe.js)
 *
 * Threads Decisions into persistent Topics by their canonical SUBJECT, the way
 * ADR 0003 describes. Subject is the primary signal; meeting date discriminates
 * recurring-but-distinct instances (e.g. Italian Festa 2025 vs 2026). Every
 * resulting subject->topic mapping is written to topic_subjects so future ingests
 * attach automatically and human oversight trends to zero (ADR 0003).
 *
 * Modes:
 *   node db/match.js                # dry run: extract subjects, cluster, print summary,
 *                                   #   and write proposed SQL to db/migrations/0002-thread-backfill.sql
 *   node db/match.js --apply        # same, then execute the SQL against --remote via wrangler
 *
 * Subject extraction uses Claude Haiku. Falls back to a deterministic headline
 * cleaner if ANTHROPIC_API_KEY is absent.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { normKey, tokenSet, slug, sameSubject, deriveStage } from './lib/topics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const OUT_SQL = resolve(__dirname, 'migrations/0002-thread-backfill.sql');

// Two appearances of the same subject more than this many days apart are treated
// as distinct instances (annual events, fixed program cycles). See ADR 0003.
const INSTANCE_GAP_DAYS = 270;

// ─── load .env ────────────────────────────────────────────────────────────────
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {}

// ─── D1 read helper (wrangler, --json) ───────────────────────────────────────
function d1(sql) {
  const r = spawnSync('wrangler',
    ['d1', 'execute', 'counciltracker', '--remote', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw r.error;
  const raw = r.stdout || '';
  const i = raw.indexOf('[');
  if (i === -1) throw new Error(`no JSON from wrangler. stderr: ${(r.stderr||'').slice(0,300)}`);
  return JSON.parse(raw.slice(i))[0].results || [];
}

// ─── fetch every decision with the context needed to name + thread it ────────
function fetchDecisions() {
  return d1(`
    SELECT d.id, d.item_number, d.meeting_id, d.headline, d.resolution,
           d.outcome, t.type, t.stage, t.streets, t.suburbs, t.detail_page,
           m.date, c.id AS committee
    FROM decisions d
    JOIN topics t  ON t.id = d.topic_id
    JOIN meetings m ON m.id = d.meeting_id
    JOIN committees c ON c.id = m.committee_id
    ORDER BY m.date
  `);
}

// ─── canonical subject extraction (Claude Haiku, batched) ────────────────────
async function extractSubjects(decisions) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.log('No ANTHROPIC_API_KEY — using deterministic headline fallback for subjects.');
    return new Map(decisions.map(d => [d.id, fallbackSubject(d.headline)]));
  }
  const client = new Anthropic({ apiKey: key });
  const out = new Map();
  const BATCH = 40;
  for (let i = 0; i < decisions.length; i += BATCH) {
    const batch = decisions.slice(i, i + BATCH);
    const list = batch.map(d => `${d.id} :: ${d.headline}`).join('\n');
    const prompt =
`For each council agenda item below, output its canonical SUBJECT: the stable name of the
underlying project, place, event, policy, or works — the thing that stays the same if the
item returns to a later meeting. Strip meeting-specific verbs, outcomes, and dates. Keep
distinguishing place/street names that are part of the issue's identity.

Examples:
  "New raised crossing — Illawarra Rd at Wharf St" -> "Illawarra Rd & Wharf St crossing"
  "FDC Construction appointed to build Leichhardt aquatic centre" -> "Leichhardt Aquatic Centre Stage 2"
  "Sponsorship policy adopted — disability wage protection" -> "Sponsorship Policy"
  "Road closures — Italian Festa, Norton St, 25 October 2026" -> "Italian Festa road closures, Norton St"

Items (format "id :: headline"):
${list}

Return ONLY a JSON array of {"id": "...", "subject": "..."} — one per item, no commentary.`;
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = resp.content[0].text;
    const json = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1);
    for (const r of JSON.parse(json)) out.set(r.id, r.subject);
    process.stdout.write(`  subjects ${Math.min(i + BATCH, decisions.length)}/${decisions.length}\r`);
  }
  console.log('');
  // Any item the model skipped falls back deterministically.
  for (const d of decisions) if (!out.has(d.id)) out.set(d.id, fallbackSubject(d.headline));
  return out;
}

function fallbackSubject(headline) {
  return (headline || '').split(/ — | - /)[0].trim() || headline || 'untitled';
}

// normKey / tokenSet / slug / sameSubject / deriveStage are shared with the ingest
// pipeline — see db/lib/topics.js. deriveStage takes [{ outcome, works_start }].

// ─── cluster decisions into topics ───────────────────────────────────────────
// Returns { topics, suggestions } — suggestions are street-corroborated cross-type
// near-misses a human should confirm (ADR 0003: streets corroborate subject).
function cluster(decisions, subjects) {
  // Stage 1: collapse near-identical subject keys via union-find over the distinct
  // keys, so "Leichhardt Aquatic Centre Stage 2" and "Leichhardt Park Aquatic
  // Centre Stage 2" land in one bucket without a hard exact-match.
  const keyOf = new Map();   // decision id -> raw normKey
  const sets  = new Map();   // raw normKey -> token Set
  for (const d of decisions) {
    const k = normKey(subjects.get(d.id));
    keyOf.set(d.id, k);
    if (!sets.has(k)) sets.set(k, tokenSet(subjects.get(d.id)));
  }
  const keys = [...sets.keys()];
  const parent = new Map(keys.map(k => [k, k]));
  const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++)
      if (sameSubject(sets.get(keys[i]), sets.get(keys[j]))) unite(keys[i], keys[j]);

  // group decisions by their merged (root) subject key
  const byKey = new Map();
  for (const d of decisions) {
    const k = find(keyOf.get(d.id));
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(d);
  }
  // within each key, split on date gaps > INSTANCE_GAP_DAYS into distinct instances
  const topics = [];
  const usedIds = new Set();
  for (const [, group] of byKey) {
    group.sort((a, b) => a.date.localeCompare(b.date));
    let bucket = [];
    let prev = null;
    const flush = () => { if (bucket.length) { topics.push(bucket); bucket = []; } };
    for (const d of group) {
      if (prev) {
        const gap = (new Date(d.date) - new Date(prev.date)) / 86400000;
        if (gap > INSTANCE_GAP_DAYS) flush();
      }
      bucket.push(d); prev = d;
    }
    flush();
  }
  // assign a stable, unique topic id + canonical subject per cluster
  const built = topics.map(members => {
    const latest = members[members.length - 1];
    const subject = subjects.get(latest.id);
    let id = `topic-${slug(subject)}`;
    if (usedIds.has(id)) {
      // distinct instance or slug collision — disambiguate by first-decision year
      id = `${id}-${members[0].date.slice(0, 4)}`;
      let n = 2; while (usedIds.has(id)) id = `topic-${slug(subject)}-${members[0].date.slice(0,4)}-${n++}`;
    }
    usedIds.add(id);
    const union = (field) => {
      const s = new Set();
      for (const m of members) for (const v of JSON.parse(m[field] || '[]')) s.add(v);
      return [...s];
    };
    return {
      id, subject, members,
      type: latest.type,
      headline: latest.headline,
      stage: deriveStage(members),
      streets: union('streets'),
      suburbs: union('suburbs'),
      detail_page: members.map(m => m.detail_page).find(Boolean) || null,
      first_seen: members[0].date,
      last_seen: latest.date,
    };
  });

  // Stage 2: street-corroborated review suggestions. Two SEPARATE topics that
  // share a suburb and ≥2 streets are likely the same real-world works seen from
  // different angles (the Bunnings latm↔event case: phrased too differently to
  // match on subject, but the street footprint is the same). We do NOT auto-merge
  // these — a wrong link is a published falsehood (ADR 0003). They go to a human
  // confirm queue; each confirmation later becomes a durable subject alias.
  const suggestions = [];
  for (let i = 0; i < built.length; i++) {
    for (let j = i + 1; j < built.length; j++) {
      const A = built[i], B = built[j];
      const subA = new Set(A.suburbs), shareSub = B.suburbs.some(s => subA.has(s));
      if (!shareSub) continue;
      const stA = new Set(A.streets), shared = B.streets.filter(s => stA.has(s));
      if (shared.length >= 2) suggestions.push({ a: A, b: B, streets: shared });
    }
  }
  return { topics: built, suggestions };
}

// ─── emit the backfill SQL ───────────────────────────────────────────────────
function emitSQL(topics) {
  const q = s => s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;
  const now = new Date().toISOString();
  const lines = [
    '-- Migration 0002 — thread existing decisions into persistent topics (ADR 0003)',
    '-- Generated by db/match.js. Rebuilds the topic layer from canonical subjects.',
    '-- Safe ordering: stage new topics, repoint decisions+images, drop orphan old topics.',
    'PRAGMA foreign_keys = OFF;',
    '',
    '-- 1. new persistent topic rows',
  ];
  for (const t of topics) {
    lines.push(`INSERT OR REPLACE INTO topics (id, subject, type, headline, stage, suburbs, streets, detail_page, first_seen, last_seen) VALUES (${q(t.id)}, ${q(t.subject)}, ${q(t.type)}, ${q(t.headline)}, ${q(t.stage)}, ${q(JSON.stringify(t.suburbs))}, ${q(JSON.stringify(t.streets))}, ${q(t.detail_page)}, ${q(t.first_seen)}, ${q(t.last_seen)});`);
  }
  lines.push('', '-- 2. repoint decisions and images to their new topic');
  for (const t of topics) {
    for (const m of t.members) {
      lines.push(`UPDATE decisions SET topic_id = ${q(t.id)} WHERE id = ${q(m.id)};`);
      // images were keyed to the old per-item topic id (topic-<meeting>-<nn>)
      const oldTopicId = `topic-${m.meeting_id}-${String(m.item_number).padStart(2, '0')}`;
      lines.push(`UPDATE images SET topic_id = ${q(t.id)} WHERE topic_id = ${q(oldTopicId)};`);
    }
  }
  lines.push('', '-- 3. learned subject->topic aliases (source=auto; humans add source=human later)');
  for (const t of topics) {
    lines.push(`INSERT OR REPLACE INTO topic_subjects (subject_key, topic_id, source, created_at) VALUES (${q(normKey(t.subject))}, ${q(t.id)}, 'auto', ${q(now)});`);
  }
  lines.push('', '-- 4. delete orphaned old topic rows (no decisions point to them any more)');
  lines.push("DELETE FROM topics WHERE id NOT IN (SELECT DISTINCT topic_id FROM decisions);");
  lines.push('PRAGMA foreign_keys = ON;', '');
  writeFileSync(OUT_SQL, lines.join('\n'));
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const decisions = fetchDecisions();
  console.log(`Fetched ${decisions.length} decisions.`);
  const subjects = await extractSubjects(decisions);
  const { topics, suggestions } = cluster(decisions, subjects);

  const multi = topics.filter(t => t.members.length > 1);
  console.log(`\nThreaded into ${topics.length} persistent topics.`);
  console.log(`  ${multi.length} topics thread 2+ decisions (the real cross-meeting issues).`);
  console.log(`  ${topics.length - multi.length} single-decision topics.\n`);
  console.log('Largest threaded topics:');
  for (const t of multi.sort((a, b) => b.members.length - a.members.length).slice(0, 12)) {
    const types = [...new Set(t.members.map(m => m.type))].join('/');
    const cttees = [...new Set(t.members.map(m => m.committee))].join('/');
    console.log(`  [${t.members.length}] ${t.subject}  (${types} | ${cttees} | ${t.first_seen}..${t.last_seen})`);
  }

  // Street-corroborated cross-type near-misses for human confirmation (not auto-merged).
  if (suggestions.length) {
    console.log(`\n${suggestions.length} street-corroborated link suggestion(s) to review (NOT auto-merged):`);
    for (const s of suggestions) {
      console.log(`  ? "${s.a.subject}" (${s.a.type}) <-> "${s.b.subject}" (${s.b.type})`);
      console.log(`      shared streets: ${s.streets.join(', ')}`);
    }
  }

  emitSQL(topics);
  console.log(`\nWrote ${OUT_SQL}`);

  if (APPLY) {
    console.log('Applying to --remote ...');
    const r = spawnSync('wrangler',
      ['d1', 'execute', 'counciltracker', '--remote', `--file=${OUT_SQL}`],
      { encoding: 'utf8', stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
    console.log('Applied.');
  } else {
    console.log('Dry run. Review the SQL, then re-run with --apply.');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
