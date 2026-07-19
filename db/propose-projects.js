#!/usr/bin/env node
/**
 * db/propose-projects.js — Project candidate proposal pass (ADR 0010, issue #93)
 *
 * Proposes candidate PROJECTS: groups of topics that look like one real-world
 * standing thing (a place, program, event or works) a resident would follow as a
 * single page. This is the "machine proposes" half of ADR 0010's rule — the human
 * half (confirming each group and each membership against the infocouncil source
 * documents) happens outside this script, and only confirmed groups are written
 * to db/projects.json by a person.
 *
 * THIS SCRIPT NEVER WRITES. Not to D1, not to projects.json. Its only outputs are
 * a ranked console summary and a review-queue JSON in review/ (gitignored). That
 * is by design: name-matching alone groups different real things (the Metro trap —
 * Sydney Metro the rail line vs Marrickville Metro the shopping centre; three
 * distinct pools all matching "aquatic centre"), and a wrong group is a published
 * falsehood. Over-proposing is fine — a candidate list is allowed to contain traps,
 * because a human rejects them with the source open. Silently missing a cluster is
 * the only real failure, so thresholds below lean generous.
 *
 * How it clusters (a sibling of db/match.js's street-corroborated suggestion pass,
 * kept separate because match.js clusters DECISIONS into topics and its --apply
 * rewrites the topic tables — this pass reads TOPICS and must never write):
 *
 *   1. Tokenise every topic subject with the shared primitives in db/lib/topics.js,
 *      so a word means the same thing here as in ingest/match/relations.
 *   2. Anchor candidates on shared name tokens: any single token, or unordered
 *      token PAIR, that appears in enough topics (>= MIN_MEMBERS) without being
 *      corpus-wide noise (single tokens capped at MAX_DF — "marrickville" names a
 *      suburb, not a project).
 *   3. Merge anchor groups whose member sets overlap heavily (Jaccard >= MERGE_AT):
 *      "leichhardt aquatic", "aquatic centre" and "leichhardt centre" are one
 *      candidate, not three.
 *   4. Corroborate, never decide: each candidate reports shared streets/suburbs
 *      among members and any existing human topic_relations inside the group.
 *      These raise a candidate's rank; they never auto-confirm anything.
 *
 * Modes:
 *   node db/propose-projects.js               # cluster live topics, print ranked candidates,
 *                                             #   write review/project-candidates-<date>.json
 *   node db/propose-projects.js --self-test   # clustering unit checks on fixtures (node:assert, no network)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import assert from 'node:assert';
import { tokenSet } from './lib/topics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF_TEST = process.argv.includes('--self-test');

// ─── tuning ───────────────────────────────────────────────────────────────────
// Generous on purpose (see header): the queue may contain traps for a human to
// reject, but should not miss a real cluster.
const MIN_MEMBERS = 3;   // a candidate below this isn't a followable grouping yet
const MAX_DF = 18;       // single-token anchors above this document frequency are corpus noise
const MERGE_AT = 0.5;    // Jaccard overlap of member sets at which two anchor groups merge
const TOP_N = 25;        // console shows at most this many candidates (JSON gets them all)

// ─── load .env ────────────────────────────────────────────────────────────────
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {}

// ─── D1 read helper (wrangler, --json) — same shape as db/match.js ───────────
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

// ─── clustering (pure — the self-test runs it on fixtures) ────────────────────
/**
 * @param topics    [{ id, subject, type, stage, streets, suburbs, first_seen,
 *                     last_seen, n_decisions }] — streets/suburbs already arrays.
 * @param relations [{ topic_a, topic_b, kind }] — existing human links, used only
 *                  to corroborate (a link inside a candidate is a hint a human
 *                  already saw these as connected).
 * @returns ranked candidate list; each { anchors, members, sharedStreets,
 *          sharedSuburbs, relationsInside, score }.
 */
export function proposeCandidates(topics, relations = []) {
  // 1. token sets + document frequency
  const toks = new Map(topics.map(t => [t.id, tokenSet(t.subject)]));
  const df = new Map();
  for (const s of toks.values()) for (const w of s) df.set(w, (df.get(w) || 0) + 1);

  // 2. anchor -> member ids. Single tokens are df-capped. A pair anchor must
  // contain at least one token under the same cap: a pair of two corpus-common
  // words ("inner+west", "2026+meeting", "park+upgrade") names the council's
  // routine vocabulary, not a real-world thing, and lets generic pairs chain
  // unrelated topics into one mega-cluster.
  const groups = new Map();   // anchor label -> Set<topic id>
  const add = (label, id) => {
    if (!groups.has(label)) groups.set(label, new Set());
    groups.get(label).add(id);
  };
  for (const t of topics) {
    const words = [...toks.get(t.id)];
    for (const w of words) if (df.get(w) >= MIN_MEMBERS && df.get(w) <= MAX_DF) add(w, t.id);
    for (let i = 0; i < words.length; i++)
      for (let j = i + 1; j < words.length; j++)
        if (Math.min(df.get(words[i]), df.get(words[j])) <= MAX_DF)
          add([words[i], words[j]].sort().join('+'), t.id);
  }
  for (const [label, ids] of groups) if (ids.size < MIN_MEMBERS) groups.delete(label);

  // 3. merge heavily-overlapping anchor groups (union-find over anchors)
  const labels = [...groups.keys()];
  const parent = new Map(labels.map(l => [l, l]));
  const find = l => { while (parent.get(l) !== l) { parent.set(l, parent.get(parent.get(l))); l = parent.get(l); } return l; };
  const jaccard = (a, b) => {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  };
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++)
      if (jaccard(groups.get(labels[i]), groups.get(labels[j])) >= MERGE_AT) {
        const ra = find(labels[i]), rb = find(labels[j]);
        if (ra !== rb) parent.set(ra, rb);
      }
  const merged = new Map();   // root -> { anchors: [], ids: Set }
  for (const l of labels) {
    const r = find(l);
    if (!merged.has(r)) merged.set(r, { anchors: [], ids: new Set() });
    merged.get(r).anchors.push(l);
    for (const id of groups.get(l)) merged.get(r).ids.add(id);
  }

  // 4. corroborate and rank
  const byId = new Map(topics.map(t => [t.id, t]));
  const linked = relations.map(r => [r.topic_a, r.topic_b]);
  const candidates = [];
  for (const { anchors, ids } of merged.values()) {
    if (ids.size < MIN_MEMBERS) continue;
    const members = [...ids].map(id => byId.get(id))
      .sort((a, b) => (a.first_seen || '').localeCompare(b.first_seen || ''));

    // streets/suburbs appearing on 2+ members corroborate a shared footprint
    const count = field => {
      const c = new Map();
      for (const m of members) for (const v of m[field] || []) c.set(v, (c.get(v) || 0) + 1);
      return [...c.entries()].filter(([, n]) => n >= 2).map(([v]) => v);
    };
    const sharedStreets = count('streets');
    const sharedSuburbs = count('suburbs');
    const relationsInside = linked.filter(([a, b]) => ids.has(a) && ids.has(b)).length;

    // Rank: size first, then the corroboration hints. The score orders the queue
    // for a human's attention; it confirms nothing.
    const score = members.length
      + 2 * relationsInside
      + Math.min(sharedStreets.length, 3)
      + Math.min(sharedSuburbs.length, 2);

    // Show the most specific anchors first (pairs before singles, rarer first).
    anchors.sort((a, b) => (b.includes('+') - a.includes('+')) || a.localeCompare(b));
    candidates.push({ anchors, members, sharedStreets, sharedSuburbs, relationsInside, score });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

// ─── self-test (fixtures, no network) ─────────────────────────────────────────
function selfTest() {
  const T = (id, subject, streets = [], suburbs = []) =>
    ({ id, subject, type: 't', stage: 's', streets, suburbs, first_seen: '2026-01-01', last_seen: '2026-01-01', n_decisions: 1 });
  const fixture = [
    // the pool cluster — including a DIFFERENT pool that shares "aquatic centre";
    // the proposal pass must surface it (the human rejects it with the source open)
    T('t-lpac-1', 'Leichhardt Park Aquatic Centre Upgrade', ['Mary St'], ['Lilyfield']),
    T('t-lpac-2', 'Leichhardt Park Aquatic Centre Stage 2 Tender', ['Mary St'], ['Lilyfield']),
    T('t-lpac-3', 'Leichhardt Park Aquatic Centre children\'s pool staffing', [], ['Lilyfield']),
    T('t-kellerman', 'Annette Kellerman Aquatic Centre expansion', [], ['Marrickville']),
    // the greenway cluster — a single rare token, no shared second word
    T('t-gw-1', 'GreenWay Activation Program'),
    T('t-gw-2', 'GreenWay lighting improvements'),
    T('t-gw-3', 'GreenWay privacy impacts at Williams Parade'),
    // unrelated singletons — must produce no candidate
    T('t-x1', 'Italian Festa road closures'),
    T('t-x2', 'Sponsorship Policy'),
    T('t-x3', 'South Marrickville Flood Study'),
  ];

  const out = proposeCandidates(fixture, [{ topic_a: 't-lpac-1', topic_b: 't-lpac-2', kind: 'parent-child' }]);

  // 1. The pool candidate exists and includes the trap member (rejecting Annette
  //    Kellerman is the HUMAN's judgment, not this script's).
  const pool = out.find(c => c.members.some(m => m.id === 't-lpac-1'));
  assert.ok(pool, 'pool cluster proposed');
  assert.ok(pool.members.some(m => m.id === 't-kellerman'), 'trap member surfaced, not hidden');
  assert.equal(pool.relationsInside, 1);
  assert.ok(pool.sharedStreets.includes('Mary St'));

  // 2. The greenway candidate forms off a single shared rare token.
  const gw = out.find(c => c.members.some(m => m.id === 't-gw-1'));
  assert.ok(gw, 'greenway cluster proposed');
  assert.equal(gw.members.length, 3);

  // 3. Unrelated topics never appear in any candidate.
  for (const c of out)
    for (const m of c.members)
      assert.ok(!['t-x1', 't-x2', 't-x3'].includes(m.id), `unrelated ${m.id} leaked into a candidate`);

  // 4. The corroborated pool cluster outranks the uncorroborated greenway one.
  assert.ok(pool.score > gw.score, 'corroboration raises rank');

  console.log('self-test: 4/4 passed');
}

// ─── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (SELF_TEST) { selfTest(); return; }

  const rows = d1(`
    SELECT t.id, t.subject, t.type, t.stage, t.streets, t.suburbs,
           t.first_seen, t.last_seen, COUNT(d.id) AS n_decisions
    FROM topics t LEFT JOIN decisions d ON d.topic_id = t.id
    GROUP BY t.id
  `);
  const topics = rows.map(t => ({
    ...t,
    streets: JSON.parse(t.streets || '[]'),
    suburbs: JSON.parse(t.suburbs || '[]'),
  }));
  const relations = d1('SELECT topic_a, topic_b, kind FROM topic_relations');
  console.log(`Fetched ${topics.length} topics, ${relations.length} existing relations.\n`);

  const candidates = proposeCandidates(topics, relations);
  console.log(`${candidates.length} candidate Project(s) proposed (showing top ${Math.min(TOP_N, candidates.length)}).`);
  console.log('NOTHING here is confirmed — every group and membership needs a human yes against the source.\n');

  for (const c of candidates.slice(0, TOP_N)) {
    console.log(`[score ${c.score}] anchors: ${c.anchors.slice(0, 4).join(', ')}${c.anchors.length > 4 ? ` (+${c.anchors.length - 4})` : ''}`);
    if (c.relationsInside) console.log(`    ${c.relationsInside} existing human relation(s) inside the group`);
    if (c.sharedStreets.length) console.log(`    shared streets: ${c.sharedStreets.join(', ')}`);
    if (c.sharedSuburbs.length) console.log(`    shared suburbs: ${c.sharedSuburbs.join(', ')}`);
    for (const m of c.members)
      console.log(`    - ${m.subject}  (${m.type} | ${m.stage} | dec:${m.n_decisions} | ${m.first_seen}..${m.last_seen})`);
    console.log('');
  }

  const outPath = resolve(__dirname, `../review/project-candidates-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ generated: new Date().toISOString(), candidates }, null, 2));
  console.log(`Review queue written to ${outPath} (${candidates.length} candidates, gitignored).`);
  console.log('Next: verify each candidate against the infocouncil source, then a human writes confirmed');
  console.log('entries to db/projects.json and runs: node db/apply-projects.js --dry-run');
}

main();
