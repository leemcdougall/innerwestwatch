/**
 * db/apply-projects.js — re-runnable Projects apply step (ADR 0010, issue #92)
 *
 * `projects` and `project_topics` are DERIVED tables. The durable source of every
 * Project — a human-confirmed grouping of many topics into one followable real-world
 * thing — is db/projects.json, keyed by SUBJECT (not topic id). Topic ids churn on
 * re-import — subjects get re-slugged and orphan-pruned — so an id-keyed store would
 * break each pass. Keying on the stable subject gives Projects the same trend-to-zero
 * property relations and threading already have: a human confirmed each membership
 * once, the machine reapplies it forever.
 *
 * What this does: for each project in projects.json, resolve every member subject to
 * its CURRENT topic id via the live topic_subjects alias store (exact normKey match),
 * with a fuzzy sameSubject() fallback for subjects rephrased since confirmation.
 * Every member that resolves becomes an idempotent INSERT OR IGNORE into
 * project_topics; the project row itself is upserted (name/description edits in the
 * JSON propagate). Anything that no longer resolves lands in the UNRESOLVED REPORT —
 * the only thing a human ever reviews after a re-import.
 *
 * This is a deliberate mirror of db/apply-relations.js (the ADR 0006 pattern). The
 * resolver is a copy of that script's makeResolver — each script in this repo carries
 * its own copy of shared plumbing — but BOTH build on the one set of subject
 * primitives in db/lib/topics.js, so a subject normalises here exactly as it does in
 * ingest/match/relations. That shared base is what stops the copies drifting.
 *
 * Usage:
 *   node db/apply-projects.js --self-test   # resolver + membership unit checks (node:assert, no deps)
 *   node db/apply-projects.js [--dry-run]   # resolve + print, write nothing (default)
 *   node db/apply-projects.js --apply       # upsert projects + INSERT OR IGNORE memberships into live D1
 *   node db/apply-projects.js --rebuild     # delete all projects/memberships, then re-insert from JSON
 *
 * Required env vars (db/../.env, gitignored): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID,
 * CLOUDFLARE_D1_TOKEN. (Same as db/apply-relations.js.)
 *
 * Project ids are HUMAN-CHOSEN slugs written directly in projects.json — this script
 * never mints an id and never invents a membership. Nothing here writes to topics,
 * decisions, or topic_relations.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert';
import { normKey, tokenSet, sameSubject } from './lib/topics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── load .env ──────────────────────────────────────────────────────────────
// Same minimal loader every db/ script uses — no dotenv dependency.
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

const PROJECTS_PATH = resolve(__dirname, 'projects.json');

// ─── D1 read/write helper (REST, parameterized) ──────────────────────────────
// Copied from db/apply-relations.js (each script in this repo carries its own copy).
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
 * Copied from db/apply-relations.js (only the "wrong link" wording adapted to
 * "wrong membership") so a subject resolves identically in both apply steps.
 *
 * @param aliasMap  Map<subject_key, topic_id> from the live topic_subjects store. The
 *                  subject_key is already normKey(...) output, so an exact lookup is the
 *                  primary, authoritative path (a human-confirmed alias trends oversight to zero).
 * @param topics    [{ id, tokens }] — token sets for every live topic subject, for the
 *                  fuzzy fallback when a subject was rephrased and no exact alias hits.
 *
 * Returns resolve(subject) -> { topicId, via } | { topicId: null, via: 'unresolved', reason }.
 * `via` is 'alias' | 'fuzzy' | 'unresolved'. An ambiguous fuzzy tie is treated as unresolved:
 * a wrong membership is a published falsehood, so we never guess between two equally-good topics.
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

// ─── membership resolution (pure — testable without network) ─────────────────
/**
 * Resolve every project's members against a resolver. Returns everything main()
 * needs to report and write, with no I/O, so the self-test can exercise the whole
 * pass (including dedupe) on fixtures.
 *
 * - projectRows: one row per project in the source, verbatim (id/name/description
 *   are human-written — never touched here).
 * - memberRows:  resolved (project_id, topic_id) pairs, deduped. Two source
 *   subjects can collapse onto ONE topic id after a re-import merges them; that is
 *   healthy (the membership survived), so it dedupes silently into `collapsed`
 *   rather than erroring.
 * - unresolved:  Map<subject, count> — the human-review report.
 */
export function resolveProjects(projects, resolveSubject) {
  const projectRows = [];
  const memberRows = [];
  const unresolved = new Map();
  let collapsed = 0;
  const trace = [];

  for (const p of projects) {
    projectRows.push({ id: p.id, name: p.name, description: p.description, created_at: p.created_at });
    const seenTopics = new Set();   // dedupe within this project

    for (const m of p.members || []) {
      const r = resolveSubject(m.subject);

      if (!r.topicId) {
        unresolved.set(m.subject, (unresolved.get(m.subject) || 0) + 1);
        trace.push(`  UNRESOLVED (${r.reason}): "${m.subject}" in project ${p.id}`);
        continue;
      }

      if (seenTopics.has(r.topicId)) {
        // Two confirmed subjects now live on one topic — the membership survived a
        // merge, nothing to add twice.
        collapsed++;
        trace.push(`  collapsed onto ${r.topicId}: "${m.subject}" in project ${p.id}`);
        continue;
      }
      seenTopics.add(r.topicId);

      memberRows.push({
        project_id: p.id,
        topic_id: r.topicId,
        source: m.source ?? 'human',
        created_at: m.created_at,   // preserve the original human-confirmation date, not now()
      });
      trace.push(`  member [${r.via}]: ${p.id} -> ${r.topicId}  ("${m.subject}")`);
    }
  }

  return { projectRows, memberRows, unresolved, collapsed, trace };
}

// ─── self-test (pure logic, no network) ───────────────────────────────────────
function selfTest() {
  // Fixture: two topics. Alias store maps an exact rephrasing of topic A's subject.
  // Mirrors the apply-relations.js fixture so the two resolvers provably agree.
  const tA = { id: 'topic-flood-study', subject: 'South Marrickville Flood Study' };
  const tB = { id: 'topic-aquatic-centre', subject: 'Leichhardt Aquatic Centre Stage 2' };
  const topics = [tA, tB].map(t => ({ id: t.id, tokens: tokenSet(t.subject) }));
  const aliasMap = new Map([[normKey(tA.subject), tA.id]]);
  const resolveSubject = makeResolver(aliasMap, topics);

  // 1. Exact alias hit.
  let r = resolveSubject('South Marrickville Flood Study');
  assert.equal(r.topicId, 'topic-flood-study'); assert.equal(r.via, 'alias');

  // 2. Alias hit survives reordering/case/punctuation (normKey sorts + strips).
  r = resolveSubject('flood study, south marrickville!');
  assert.equal(r.topicId, 'topic-flood-study'); assert.equal(r.via, 'alias');

  // 3. Fuzzy hit: rephrased subject with no alias, but token overlap clears the bar.
  r = resolveSubject('Leichhardt Aquatic Centre Stage 2 renovation');
  assert.equal(r.topicId, 'topic-aquatic-centre'); assert.equal(r.via, 'fuzzy');

  // 4. Miss: unrelated subject resolves to nothing.
  r = resolveSubject('Norton Street Italian Festa road closure');
  assert.equal(r.topicId, null); assert.equal(r.via, 'unresolved');

  // 5. Ambiguous tie: two topics share the exact same token set -> refuse to guess.
  const ambTopics = [
    { id: 'topic-x', tokens: tokenSet('Centenary Park upgrade') },
    { id: 'topic-y', tokens: tokenSet('Centenary Park upgrade') },
  ];
  r = makeResolver(new Map(), ambTopics)('Centenary Park upgrade');
  assert.equal(r.topicId, null); assert.equal(r.reason, 'ambiguous fuzzy match');

  // 6. Whole-pass fixture: one project with a resolving member, an unresolved member,
  //    and a duplicate that collapses onto an already-resolved topic.
  const fixture = [{
    id: 'test-pool', name: 'Test pool', description: 'A fixture.', created_at: '2026-07-12',
    members: [
      { subject: 'South Marrickville Flood Study', source: 'human', created_at: '2026-07-12' },
      { subject: 'flood study, south marrickville!', source: 'human', created_at: '2026-07-12' },  // collapses onto the same topic
      { subject: 'Norton Street Italian Festa road closure', source: 'human', created_at: '2026-07-12' },  // unresolvable
    ],
  }];
  const out = resolveProjects(fixture, resolveSubject);
  assert.equal(out.projectRows.length, 1);
  assert.equal(out.memberRows.length, 1);
  assert.equal(out.memberRows[0].topic_id, 'topic-flood-study');
  assert.equal(out.collapsed, 1);
  assert.equal(out.unresolved.size, 1);

  // 7. Empty source (today's real state, pre-#93): resolves cleanly to zero everything.
  const empty = resolveProjects([], resolveSubject);
  assert.equal(empty.projectRows.length, 0);
  assert.equal(empty.memberRows.length, 0);
  assert.equal(empty.unresolved.size, 0);

  console.log('self-test: 7/7 passed');
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (SELF_TEST) { selfTest(); return; }

  // 1. Load the source of truth.
  const { projects } = JSON.parse(readFileSync(PROJECTS_PATH, 'utf8'));
  console.log(`Loaded ${projects.length} project(s) from projects.json`);

  // 2. Snapshot the live alias store + topics (two reads, then resolve offline).
  const aliasRows = (await d1Query('SELECT subject_key, topic_id FROM topic_subjects')).at(0).results;
  const aliasMap = new Map(aliasRows.map(r => [r.subject_key, r.topic_id]));
  const topicRows = (await d1Query('SELECT id, subject FROM topics')).at(0).results;
  const topics = topicRows.map(t => ({ id: t.id, tokens: tokenSet(t.subject) }));
  console.log(`Live D1: ${aliasMap.size} aliases, ${topics.length} topics\n`);

  // 3. Resolve every membership.
  const { projectRows, memberRows, unresolved, collapsed, trace } =
    resolveProjects(projects, makeResolver(aliasMap, topics));

  // 4. Report.
  console.log('Resolution trace:');
  for (const line of trace) console.log(line);
  if (!trace.length) console.log('  (source is empty — nothing to resolve)');

  if (unresolved.size) {
    console.log('\n── UNRESOLVED SUBJECTS (human review — should shrink each re-import) ──');
    for (const [subj, n] of [...unresolved.entries()].sort((x, y) => y[1] - x[1])) {
      console.log(`  (${n} membership${n > 1 ? 's' : ''}) ${subj}`);
    }
  }

  const totalMembers = projects.reduce((n, p) => n + (p.members?.length || 0), 0);
  console.log('\n── SUMMARY ──');
  console.log(`  projects in source:       ${projectRows.length}`);
  console.log(`  memberships in source:    ${totalMembers}`);
  console.log(`  memberships to write:     ${memberRows.length}`);
  console.log(`  collapsed (merged topic): ${collapsed}`);
  console.log(`  unresolved memberships:   ${totalMembers - memberRows.length - collapsed}`);
  console.log(`  unique unresolved subj:   ${unresolved.size}`);

  if (DRY_RUN) {
    console.log('\nDry run. Re-run with --apply to write (or --rebuild to delete+rewrite).');
    return;
  }

  // 5. Write. Guard: never write (and NEVER delete) from an empty source — an empty
  // projects.json plus --apply almost certainly means a broken read, not an intent
  // to clear the tables. (Same guard shape as apply-relations.js.)
  if (projectRows.length === 0) {
    console.error('\nAborting --apply: 0 projects in source. Refusing to touch projects/project_topics.');
    process.exitCode = 1;
    return;
  }

  if (REBUILD) {
    // The JSON is the ONLY writer of these tables today, so rebuild clears both
    // fully — a project deleted from the JSON disappears from D1 on the next rebuild.
    const delM = await d1Query('DELETE FROM project_topics');
    const delP = await d1Query('DELETE FROM projects');
    console.log(`\n--rebuild: deleted ${delM.at(0).meta?.changes ?? '?'} memberships, ${delP.at(0).meta?.changes ?? '?'} projects.`);
  }

  // Upsert project rows one by one (there will only ever be a handful): an edited
  // name/description in the JSON propagates, an unchanged row is a no-op.
  for (const p of projectRows) {
    await d1Query(
      `INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description`,
      [p.id, p.name, p.description, p.created_at]
    );
  }

  // Batch INSERT OR IGNORE memberships. The composite PK makes every reapply a
  // no-op, so re-running --apply is safe. D1 caps bound parameters at 100 per
  // statement; at 4 columns that means <=25 rows/batch.
  const CHUNK = 25;
  let inserted = 0;
  for (let i = 0; i < memberRows.length; i += CHUNK) {
    const batch = memberRows.slice(i, i + CHUNK);
    const values = batch.map(() => '(?, ?, ?, ?)').join(', ');
    const params = batch.flatMap(r => [r.project_id, r.topic_id, r.source, r.created_at]);
    const res = await d1Query(
      `INSERT OR IGNORE INTO project_topics (project_id, topic_id, source, created_at) VALUES ${values}`,
      params
    );
    inserted += res.at(0).meta?.changes ?? 0;
  }

  const nP = (await d1Query('SELECT COUNT(*) AS n FROM projects')).at(0).results.at(0).n;
  const nM = (await d1Query('SELECT COUNT(*) AS n FROM project_topics')).at(0).results.at(0).n;
  console.log(`\nApplied. Newly inserted memberships: ${inserted}. D1 now holds ${nP} project(s), ${nM} membership(s).`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
