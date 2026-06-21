/**
 * db/apply-relations.js — re-runnable relations apply step (ADR 0006)
 *
 * `topic_relations` is a DERIVED table. The durable source of the 100 human-confirmed
 * cross-topic links is db/human-relations.json, keyed by SUBJECT PAIR (not topic id).
 * Topic ids churn on every reingest — subjects get re-slugged and the orphan-prune drops
 * the old id — so an id-keyed populate (migration 0005) breaks each pass. Keying on the
 * stable subject gives relations the same trend-to-zero property threading already has:
 * a human decided each link once, the machine reapplies it forever.
 *
 * What this does: for each link, resolve BOTH subjects to their CURRENT topic id via the
 * live topic_subjects alias store (exact normKey match), with a fuzzy sameSubject() fallback
 * for subjects that were rephrased since 2026-06-13. Every pair that resolves on both sides
 * becomes an idempotent INSERT OR IGNORE into topic_relations. Anything that no longer
 * resolves (genuinely renamed/split) lands in the UNRESOLVED REPORT — the only thing a human
 * ever reviews, and the set that should shrink each reingest.
 *
 * Reuses the shared subject primitives (db/lib/topics.js) so a subject normalises here
 * exactly as it does in ingest.js / match.js — otherwise an alias written by one would
 * never be hit by another.
 *
 * Usage:
 *   node db/apply-relations.js --self-test   # resolver unit checks (node:assert, no deps)
 *   node db/apply-relations.js [--dry-run]   # resolve + print, write nothing (default)
 *   node db/apply-relations.js --apply       # additive INSERT OR IGNORE into live D1
 *   node db/apply-relations.js --rebuild     # delete source='human' rows, then re-insert
 *
 * Required env vars (db/../.env, gitignored): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID,
 * CLOUDFLARE_D1_TOKEN. (Same as db/ingest.js.)
 *
 * Do NOT run migration 0005-populate-topic-relations.sql — its ids are stale; this script
 * supersedes it as the reapply mechanism (ADR 0006).
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert';
import { normKey, tokenSet, sameSubject } from './lib/topics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── load .env ──────────────────────────────────────────────────────────────
// Same minimal loader ingest.js uses — no dotenv dependency.
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {}

// ─── flags ──────────────────────────────────────────────────────────────────
const SELF_TEST = process.argv.includes('--self-test');
const REBUILD = process.argv.includes('--rebuild');
const APPLY = process.argv.includes('--apply') || REBUILD;   // --rebuild implies write
const DRY_RUN = !APPLY;                                       // default: print, write nothing

const RELATIONS_PATH = resolve(__dirname, 'human-relations.json');

// ─── D1 read/write helper (REST, parameterized) ──────────────────────────────
// Copied from db/ingest.js (each script in this repo carries its own copy).
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

// ─── resolver ─────────────────────────────────────────────────────────────────
/**
 * Build a resolver that maps a free-text subject to a CURRENT topic id.
 *
 * @param aliasMap  Map<subject_key, topic_id> from the live topic_subjects store. The
 *                  subject_key is already normKey(...) output, so an exact lookup is the
 *                  primary, authoritative path (a human-confirmed alias trends oversight to zero).
 * @param topics    [{ id, tokens }] — token sets for every live topic subject, for the
 *                  fuzzy fallback when a subject was rephrased and no exact alias hits.
 *
 * Returns resolve(subject) -> { topicId, via } | { topicId: null, via: 'unresolved', reason }.
 * `via` is 'alias' | 'fuzzy' | 'unresolved'. An ambiguous fuzzy tie is treated as unresolved:
 * a wrong link is a published falsehood, so we never guess between two equally-good topics.
 */
export function makeResolver(aliasMap, topics) {
  return function resolveSubject(subject) {
    // Primary: exact alias hit on the normalised subject key.
    const key = normKey(subject);
    if (aliasMap.has(key)) return { topicId: aliasMap.get(key), via: 'alias' };

    // Fallback: fuzzy sameSubject() over every live topic, ranked by Jaccard overlap.
    const want = tokenSet(subject);
    if (want.size === 0) return { topicId: null, via: 'unresolved', reason: 'empty subject' };

    let best = null, bestScore = -1, tie = false;
    for (const t of topics) {
      if (!sameSubject(want, t.tokens)) continue;
      let inter = 0;
      for (const w of want) if (t.tokens.has(w)) inter++;
      const score = inter / (want.size + t.tokens.size - inter); // Jaccard
      if (score > bestScore) { best = t; bestScore = score; tie = false; }
      else if (score === bestScore) { tie = true; }
    }

    if (!best) return { topicId: null, via: 'unresolved', reason: 'no match' };
    if (tie) return { topicId: null, via: 'unresolved', reason: 'ambiguous fuzzy match' };
    return { topicId: best.id, via: 'fuzzy' };
  };
}

// ─── self-test (pure resolver logic, no network) ──────────────────────────────
function selfTest() {
  // Fixture: two topics. Alias store maps an exact rephrasing of topic A's subject.
  const tA = { id: 'topic-flood-study', subject: 'South Marrickville Flood Study' };
  const tB = { id: 'topic-aquatic-centre', subject: 'Leichhardt Aquatic Centre Stage 2' };
  const topics = [tA, tB].map(t => ({ id: t.id, tokens: tokenSet(t.subject) }));
  const aliasMap = new Map([[normKey(tA.subject), tA.id]]);
  const resolve = makeResolver(aliasMap, topics);

  // Exact alias hit.
  let r = resolve('South Marrickville Flood Study');
  assert.equal(r.topicId, 'topic-flood-study'); assert.equal(r.via, 'alias');

  // Alias hit survives reordering/case/punctuation (normKey sorts + strips).
  r = resolve('flood study, south marrickville!');
  assert.equal(r.topicId, 'topic-flood-study'); assert.equal(r.via, 'alias');

  // Fuzzy hit: rephrased subject with no alias, but token overlap clears the bar.
  r = resolve('Leichhardt Aquatic Centre Stage 2 renovation');
  assert.equal(r.topicId, 'topic-aquatic-centre'); assert.equal(r.via, 'fuzzy');

  // Miss: unrelated subject resolves to nothing.
  r = resolve('Norton Street Italian Festa road closure');
  assert.equal(r.topicId, null); assert.equal(r.via, 'unresolved');

  // Ambiguous tie: two topics share the exact same token set -> refuse to guess.
  const ambTopics = [
    { id: 'topic-x', tokens: tokenSet('Centenary Park upgrade') },
    { id: 'topic-y', tokens: tokenSet('Centenary Park upgrade') },
  ];
  r = makeResolver(new Map(), ambTopics)('Centenary Park upgrade');
  assert.equal(r.topicId, null); assert.equal(r.reason, 'ambiguous fuzzy match');

  console.log('self-test: 5/5 passed');
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (SELF_TEST) { selfTest(); return; }

  // 1. Load the source-of-truth links.
  const { relations } = JSON.parse(readFileSync(RELATIONS_PATH, 'utf8'));
  console.log(`Loaded ${relations.length} human-confirmed links from human-relations.json`);

  // 2. Snapshot the live alias store + topics (two reads, then resolve offline).
  const aliasRows = (await d1Query('SELECT subject_key, topic_id FROM topic_subjects')).at(0).results;
  const aliasMap = new Map(aliasRows.map(r => [r.subject_key, r.topic_id]));
  const topicRows = (await d1Query('SELECT id, subject FROM topics')).at(0).results;
  const topics = topicRows.map(t => ({ id: t.id, tokens: tokenSet(t.subject) }));
  console.log(`Live D1: ${aliasMap.size} aliases, ${topics.length} topics\n`);

  const resolve = makeResolver(aliasMap, topics);

  // 3. Resolve every pair.
  const rows = [];              // resolved, distinct-topic links ready to INSERT
  const unresolvedSubjects = new Map(); // subject -> count of links it blocked
  let selfCollapsed = 0;
  const trace = [];

  for (const rel of relations) {
    const a = resolve(rel.subjectA);
    const b = resolve(rel.subjectB);

    if (!a.topicId || !b.topicId) {
      if (!a.topicId) unresolvedSubjects.set(rel.subjectA, (unresolvedSubjects.get(rel.subjectA) || 0) + 1);
      if (!b.topicId) unresolvedSubjects.set(rel.subjectB, (unresolvedSubjects.get(rel.subjectB) || 0) + 1);
      const which = [!a.topicId && `A(${a.reason})`, !b.topicId && `B(${b.reason})`].filter(Boolean).join(' ');
      trace.push(`  UNRESOLVED ${which}: "${rel.subjectA}" ${rel.kind} "${rel.subjectB}"`);
      continue;
    }

    if (a.topicId === b.topicId) {
      // Reingest merged the two subjects into one topic — nothing to relate.
      selfCollapsed++;
      trace.push(`  self-collapse (${a.topicId}): "${rel.subjectA}" ~ "${rel.subjectB}"`);
      continue;
    }

    // Directionality (migration 0004): parent-child/supersedes keep A->B order;
    // 'related' is symmetric, so order by id so the row is stable across id churn.
    let topicA = a.topicId, topicB = b.topicId;
    if (rel.kind === 'related' && topicA > topicB) [topicA, topicB] = [topicB, topicA];

    rows.push({
      topic_a: topicA,
      topic_b: topicB,
      kind: rel.kind,
      note: rel.note ?? null,
      source: rel.source ?? 'human',
      created_at: rel.created_at,   // preserve the original human-decision date, not now()
      via: `${a.via}/${b.via}`,
    });
    trace.push(`  ${rel.kind} [${a.via}/${b.via}]: ${topicA} -> ${topicB}`);
  }

  // De-duplicate identical (topic_a, topic_b, kind) tuples that can arise when several
  // source subjects now collapse onto the same topic ids. INSERT OR IGNORE would dedupe
  // at the DB anyway, but trimming here keeps the inserted count honest.
  const seen = new Set();
  const distinctRows = rows.filter(r => {
    const k = `${r.topic_a} ${r.topic_b} ${r.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 4. Report.
  console.log('Resolution trace:');
  for (const line of trace) console.log(line);

  if (unresolvedSubjects.size) {
    console.log('\n── UNRESOLVED SUBJECTS (human review — should shrink each reingest) ──');
    for (const [subj, n] of [...unresolvedSubjects.entries()].sort((x, y) => y[1] - x[1])) {
      console.log(`  (${n} link${n > 1 ? 's' : ''}) ${subj}`);
    }
  }

  const kindCounts = distinctRows.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});
  console.log('\n── SUMMARY ──');
  console.log(`  links in source:        ${relations.length}`);
  console.log(`  resolved both sides:    ${rows.length}`);
  console.log(`  distinct rows to write: ${distinctRows.length}  ${JSON.stringify(kindCounts)}`);
  console.log(`  self-collapsed:         ${selfCollapsed}`);
  console.log(`  unresolved links:       ${relations.length - rows.length - selfCollapsed}`);
  console.log(`  unique unresolved subj: ${unresolvedSubjects.size}`);

  if (DRY_RUN) {
    console.log('\nDry run. Re-run with --apply to write (or --rebuild to delete+rewrite).');
    return;
  }

  // 5. Write. Guard: never delete on a resolver that produced nothing.
  if (distinctRows.length === 0) {
    console.error('\nAborting --apply: 0 rows resolved. Refusing to touch topic_relations.');
    process.exitCode = 1;
    return;
  }

  if (REBUILD) {
    const del = await d1Query("DELETE FROM topic_relations WHERE source = 'human'");
    console.log(`\n--rebuild: deleted ${del.at(0).meta?.changes ?? '?'} existing human rows.`);
  }

  // Batch INSERT OR IGNORE in chunks to keep D1 REST round-trips low. UNIQUE(topic_a,
  // topic_b, kind) makes every reapply a no-op, so re-running --apply is safe.
  // D1 caps bound parameters at 100 per statement; at 6 columns that means <=16 rows/batch.
  const CHUNK = 16;
  let inserted = 0;
  for (let i = 0; i < distinctRows.length; i += CHUNK) {
    const batch = distinctRows.slice(i, i + CHUNK);
    const values = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const params = batch.flatMap(r => [r.topic_a, r.topic_b, r.kind, r.note, r.source, r.created_at]);
    const res = await d1Query(
      `INSERT OR IGNORE INTO topic_relations (topic_a, topic_b, kind, note, source, created_at) VALUES ${values}`,
      params
    );
    inserted += res.at(0).meta?.changes ?? 0;
  }

  const total = (await d1Query('SELECT COUNT(*) AS n FROM topic_relations')).at(0).results.at(0).n;
  console.log(`\nApplied. Newly inserted: ${inserted}. topic_relations now holds ${total} rows.`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
