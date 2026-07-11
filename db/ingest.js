#!/usr/bin/env node
/**
 * db/ingest.js — the LEGACY manual ingestion pipeline.
 *
 * ⚠️ Retired from the weekly schedule (session 24, issue #83): the scheduled job now runs
 * db/append-weekly.js, which also re-checks known meetings for newly published minutes —
 * the case this scan silently never handled (its non-force mode skips known meetings
 * entirely, so a meeting ingested agenda-only stayed "Coming up" forever). Keep this tool
 * for MANUAL bulk work only: first-time ingestion of a committee's history, or re-scanning
 * after a portal gap.
 *
 * Scans infocouncil.biz for all committee meetings across the past N months, extracts
 * structured data from each agenda and minutes using Claude, and writes to D1. The shared
 * source-reading code (discovery, item splitting, extraction prompts) lives in
 * db/lib/infocouncil.js; the id-stable write side in db/lib/append-meeting.js — both
 * extracted from this file and shared with the weekly appender.
 *
 * Usage:
 *   node db/ingest.js                       # scan all committees, last 6 months
 *   node db/ingest.js --months 12           # scan last 12 months
 *   node db/ingest.js --meeting ltf-18may2026  # re-process one specific meeting
 *   node db/ingest.js --committee ltf       # scan only LTF meetings
 *
 * Required env vars (put in .env at repo root, gitignored):
 *   ANTHROPIC_API_KEY
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_DATABASE_ID
 *   CLOUDFLARE_D1_TOKEN
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { d1Query } from './lib/d1.js';
import { discoverMeetings, sleep } from './lib/infocouncil.js';
import { processMeeting } from './lib/append-meeting.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── load .env ────────────────────────────────────────────────────────────────
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {}

// ─── parse CLI args ───────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { months: 6, meetingId: null, committeeSlug: null, force: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--months' && args[i + 1]) opts.months = parseInt(args[++i], 10);
    if (args[i] === '--meeting' && args[i + 1]) opts.meetingId = args[++i];
    if (args[i] === '--committee' && args[i + 1]) opts.committeeSlug = args[++i];
    // --force re-reads meetings already in D1 (a full in-place re-ingest) instead of the
    // default of only processing unseen meetings.
    //
    // ⚠️ DANGER (ADR 0007 update 2026-06-28, retired by ADR 0009): re-reading rewords AI
    // subjects, which re-slugs the subject-derived topic id; the old id orphans and is
    // pruned. A single --force run re-slugged ~424 of ~594 topics and destroyed 37 of 96
    // human-confirmed subject aliases (the ADR 0003 learning store). DO NOT run --force.
    // To correct existing rows against source, use db/correct-in-place.js (updates by
    // decision id, never re-slugs). To re-apply a changed stage rule without re-reading
    // anything, use db/recompute-stages.js.
    if (args[i] === '--force') opts.force = true;
  }
  return opts;
}

// ─── ensure schema has the images table ───────────────────────────────────────
async function ensureSchema() {
  await d1Query(`
    CREATE TABLE IF NOT EXISTS images (
      id          TEXT PRIMARY KEY,
      topic_id    TEXT NOT NULL,
      url         TEXT NOT NULL,
      description TEXT,
      sequence    INTEGER NOT NULL DEFAULT 0
    )
  `);
}

// ─── get set of meeting IDs already in D1 ────────────────────────────────────
async function getIngestedMeetingIds() {
  const result = await d1Query('SELECT id FROM meetings');
  const rows = result[0]?.results || [];
  return new Set(rows.map(r => r.id));
}

// ─── prune orphan topics ──────────────────────────────────────────────────────
// A re-extract can re-phrase a subject, which re-slugs its topic id. The decisions
// move to the new id (attach-or-create via the alias store), leaving the OLD topic
// with no decisions pointing at it — an orphan. Run once at the end of an ingest so
// reingests don't accumulate stale topics until someone hand-runs the cleanup.
// (The weekly appender never prunes: appending unseen meetings can't orphan anything,
// and pruning is exactly the operation that made --force destructive.)
//
// Order matters BECAUSE D1 enforces foreign keys over the REST API: a DELETE of a topic
// still referenced by a child row fails with SQLITE_CONSTRAINT_FOREIGNKEY (this aborted a
// --force re-ingest once). So delete every child that references an orphan FIRST — its
// relations, images, and learned aliases — THEN the orphan topics themselves. The orphan
// set is computed from `decisions` (the same condition each time), so it stays stable
// across these deletes until the final topic delete lands. topic_relations rows touching
// an orphan must go too (FK), which is harmless: relations are a derived projection
// rebuilt by db/apply-relations.js --rebuild (ADR 0006), and human links live in
// db/human-relations.json, so the rebuild re-resolves every surviving link afterward.
async function pruneOrphans() {
  const ORPHAN = '(SELECT id FROM topics WHERE id NOT IN (SELECT topic_id FROM decisions))';
  const rels = await d1Query(
    `DELETE FROM topic_relations WHERE topic_a IN ${ORPHAN} OR topic_b IN ${ORPHAN}`
  );
  const imgs = await d1Query(
    `DELETE FROM images WHERE topic_id IN ${ORPHAN}`
  );
  const aliases = await d1Query(
    `DELETE FROM topic_subjects WHERE topic_id IN ${ORPHAN}`
  );
  const topics = await d1Query(
    'DELETE FROM topics WHERE id NOT IN (SELECT topic_id FROM decisions)'
  );
  const n = r => r[0]?.meta?.changes ?? 0;
  const pruned = n(topics);
  if (pruned || n(aliases) || n(imgs) || n(rels)) {
    console.log(`pruned ${pruned} orphan topic(s), ${n(aliases)} alias(es), ${n(imgs)} image(s), ${n(rels)} relation(s)`);
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const required = ['ANTHROPIC_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_D1_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const opts = parseArgs();

  // Ensure D1 schema is up to date (adds images table if missing)
  await ensureSchema();

  // ── single-meeting mode ──
  if (opts.meetingId) {
    // Discover the specific meeting by scanning all committees
    const allMeetings = await discoverMeetings(opts.months, null);
    const target = allMeetings.find(m => m.id === opts.meetingId);
    if (!target) {
      console.error(`Meeting "${opts.meetingId}" not found in the last ${opts.months} months`);
      console.error('Try --months 12 to scan further back, or check the meeting ID');
      process.exit(1);
    }
    await processMeeting(target, client);
    await pruneOrphans();   // a re-extract may have orphaned the old slug of a topic
    console.log('\ndone.');
    return;
  }

  // ── full scan mode ──
  const discovered = await discoverMeetings(opts.months, opts.committeeSlug);
  const alreadyIngested = await getIngestedMeetingIds();

  // Default: process only meetings not yet in D1. --force: re-read everything (in-place
  // re-ingest) — RETIRED, see parseArgs.
  const toProcess = opts.force ? discovered : discovered.filter(m => !alreadyIngested.has(m.id));
  const skipped = discovered.length - toProcess.length;

  console.log(opts.force
    ? `\n--force: re-reading all ${toProcess.length} discovered meetings in place`
    : `\n${toProcess.length} new meetings to ingest (${skipped} already in D1)`);
  if (toProcess.length === 0) {
    console.log('nothing to do.');
    return;
  }

  // Process newest first so D1 has the most current data quickly
  toProcess.sort((a, b) => b.date.localeCompare(a.date));

  const failures = [];
  for (const meeting of toProcess) {
    // Isolate each meeting: one bad agenda (e.g. a malformed Claude JSON response)
    // must not abort the whole run and leave D1 half-populated. Record and continue.
    try {
      await processMeeting(meeting, client);
    } catch (err) {
      console.error(`  ERROR processing ${meeting.id}: ${err.message} — skipping`);
      failures.push({ id: meeting.id, error: err.message });
    }
    // Polite delay between meetings to avoid hammering either server
    await sleep(1000);
  }

  if (failures.length) {
    console.log(`\n${failures.length} meeting(s) failed:`);
    for (const f of failures) console.log(`  - ${f.id}: ${f.error}`);
  }
  await pruneOrphans();   // drop topics whose subject got re-slugged this run
  console.log('\ndone.');
}

main().catch(err => {
  console.error('fatal:', err.message);
  process.exit(1);
});
