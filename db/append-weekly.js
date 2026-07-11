#!/usr/bin/env node
/**
 * db/append-weekly.js — the id-stable weekly appender (ADR 0009, issue #83).
 *
 * The scheduled importer that keeps the site fresh with zero human steps. Each run it
 * scans infocouncil.biz and handles exactly two kinds of news:
 *
 *   1. A NEW meeting (agenda just published, meeting id not in D1)
 *        → append it: extract its items, attach each to an existing topic via the
 *          topic_subjects alias store (EXACT normalised subject only) or mint a new
 *          topic for a genuinely new subject. Never touches prior topics, so it never
 *          re-slugs — issue #45 structurally cannot fire. (db/lib/append-meeting.js)
 *
 *   2. NEWLY PUBLISHED minutes for a meeting we already hold as agenda-only
 *        → record the minutes URL, then fill the outcomes IN PLACE by decision id via
 *          db/correct-in-place.js — the existing "Coming up" rows are UPDATEd, never
 *          duplicated, and topic ids are untouched.
 *
 * Then it chains the finishing passes over what changed, so no live row is ever missing
 * its plain-English layer:
 *   - db/label-decisions.js --ids …  over rows still lacking a resident_sentence
 *     (new rows; the correct-in-place fill writes its own sentences as it goes)
 *   - db/recompute-stages.js         so outcomes flow into topic stages
 *
 * This replaces db/ingest.js on the weekly schedule (.github/workflows/weekly-append.yml).
 * The old scan ran green while importing nothing: its non-force mode skipped every known
 * meeting entirely, so minutes published AFTER a meeting was first ingested were never
 * picked up — that is the #83 failure. The appender's "newly published minutes" branch is
 * the re-check the old scan lacked. Unlike ingest.js it never prunes orphan topics
 * (appending can't orphan anything) and it exits non-zero if any meeting failed, so a
 * broken week shows RED in GitHub Actions instead of a quiet green.
 *
 * Usage:
 *   node db/append-weekly.js                     # scan all committees, last 6 months
 *   node db/append-weekly.js --dry-run           # report what would be done, write nothing
 *   node db/append-weekly.js --committee ltf     # one committee only
 *   node db/append-weekly.js --months 3          # shorter lookback
 *
 * Required env (from .env locally, GitHub secrets in Actions): ANTHROPIC_API_KEY,
 * CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID, CLOUDFLARE_D1_TOKEN.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { d1Query, d1Rows } from './lib/d1.js';
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

// ─── CLI args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const monthsArg = argv.find(a => a.startsWith('--months'));
const months = monthsArg ? Number(monthsArg.split('=')[1] ?? argv[argv.indexOf(monthsArg) + 1]) : 6;
const committeeArg = argv.find(a => a.startsWith('--committee'));
const committee = committeeArg ? (committeeArg.split('=')[1] ?? argv[argv.indexOf(committeeArg) + 1]) : null;

// Run a sibling pipeline script as a child process, inheriting env + output. Reusing the
// existing CLIs (correct-in-place, label-decisions, recompute-stages) instead of importing
// their internals keeps each tool independently runnable and separately debuggable — the
// appender is an orchestrator, not a re-implementation.
function runStep(script, args = []) {
  console.log(`\n── ${script} ${args.join(' ')}`);
  execFileSync(process.execPath, [resolve(__dirname, script), ...args], { stdio: 'inherit' });
}

async function main() {
  const required = ['ANTHROPIC_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_D1_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  // ── 1. discover what the portal has, compare against what D1 holds ──
  const discovered = await discoverMeetings(months, committee);
  const knownRows = await d1Rows('SELECT id, minutes_published FROM meetings');
  const known = new Map(knownRows.map(r => [r.id, r]));

  const newMeetings = discovered.filter(m => !known.has(m.id));
  // A known meeting whose minutes just appeared on the portal. minutes-only committees
  // (Public Forum) can't be in this state — they only enter D1 once minutes exist.
  const newlyPublished = discovered.filter(m =>
    known.has(m.id) && !known.get(m.id).minutes_published && m.minutesUrl && !m.minutesOnly);

  console.log(`\n${newMeetings.length} new meeting(s); ${newlyPublished.length} known meeting(s) with newly published minutes.`);
  for (const m of newMeetings) console.log(`  NEW      ${m.id}${m.minutesUrl ? ' (minutes already out)' : ' (agenda only)'}`);
  for (const m of newlyPublished) console.log(`  MINUTES  ${m.id} → ${m.minutesUrl}`);

  if (newMeetings.length === 0 && newlyPublished.length === 0) {
    console.log('nothing new this week.');
    return;
  }
  if (dryRun) {
    console.log('\nDRY RUN — stopping before any write. The lines above are what a real run would do.');
    return;
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const touchedMeetings = [];
  const failures = [];

  // ── 2. append new meetings, newest first, isolated so one bad doc can't sink the run ──
  newMeetings.sort((a, b) => b.date.localeCompare(a.date));
  for (const meeting of newMeetings) {
    try {
      const ids = await processMeeting(meeting, client);
      if (ids.length) touchedMeetings.push(meeting.id);
    } catch (err) {
      console.error(`  ERROR appending ${meeting.id}: ${err.message}`);
      failures.push({ id: meeting.id, error: err.message });
    }
    await sleep(1000); // polite delay between meetings
  }

  // ── 3. fill outcomes for meetings whose minutes just appeared ──
  for (const meeting of newlyPublished) {
    try {
      // Record the minutes on the meeting row FIRST — correct-in-place reads them from D1.
      await d1Query(
        `UPDATE meetings SET minutes_url = ?, minutes_published = 1 WHERE id = ?`,
        [meeting.minutesUrl, meeting.id]);
      await d1Query(
        `INSERT OR REPLACE INTO documents (id, meeting_id, type, url, fetched_at) VALUES (?, ?, 'minutes-html', ?, ?)`,
        [`doc-min-${meeting.agendaId}`, meeting.id, meeting.minutesUrl, new Date().toISOString()]);

      // The in-place fill: UPDATEs existing decision rows by id from the fresh source
      // read; refuses to fabricate confidential outcomes; never inserts or re-slugs.
      runStep('correct-in-place.js', ['--meeting', meeting.id]);
      touchedMeetings.push(meeting.id);
    } catch (err) {
      console.error(`  ERROR filling minutes for ${meeting.id}: ${err.message}`);
      failures.push({ id: meeting.id, error: err.message });
    }
  }

  // ── 4. plain-English pass over rows still missing their resident sentence ──
  // New meetings arrive sentence-less (the extractor writes outcome/resolution only);
  // the correct-in-place fill writes sentences as it corrects, so this usually targets
  // just the fresh rows. Guarantees the home page never renders a card with no sentence.
  if (touchedMeetings.length) {
    const ph = touchedMeetings.map(() => '?').join(',');
    const unlabelled = await d1Rows(
      `SELECT id FROM decisions WHERE meeting_id IN (${ph}) AND resident_sentence IS NULL`,
      touchedMeetings);
    if (unlabelled.length) {
      runStep('label-decisions.js', ['--ids', unlabelled.map(r => r.id).join(',')]);
    } else {
      console.log('\nno rows missing a resident sentence — skipping the label pass.');
    }

    // ── 5. flow the new outcomes/commitments into topic stages ──
    runStep('recompute-stages.js');
  }

  // ── summary ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`WEEKLY APPEND SUMMARY — ${touchedMeetings.length} meeting(s) updated:`);
  for (const id of touchedMeetings) console.log(`  ✓ ${id}`);
  if (failures.length) {
    console.log(`${failures.length} meeting(s) FAILED (will retry next week):`);
    for (const f of failures) console.log(`  ✗ ${f.id}: ${f.error}`);
    // A failed week must show red in GitHub Actions — the old scan's quiet green while
    // importing nothing is the exact failure #83 exists to prevent.
    process.exit(1);
  }
}

main().catch(err => { console.error('fatal:', err); process.exit(1); });
