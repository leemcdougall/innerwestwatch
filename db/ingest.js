#!/usr/bin/env node
/**
 * db/ingest.js — Inner West Watch ingestion pipeline
 *
 * Fetches agenda and minutes HTML from infocouncil.biz, uses the Claude API
 * to extract structured data from each item, and writes the results to D1.
 *
 * Usage:
 *   node db/ingest.js                  # process all known meetings
 *   node db/ingest.js ltf-18may2026    # process one specific meeting
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY   — from console.anthropic.com
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_DATABASE_ID
 *   CLOUDFLARE_D1_TOKEN — API token with D1 write permission
 *
 * For local development, put these in a .env file (gitignored).
 * In GitHub Actions, set them as repository secrets.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── load .env if present ─────────────────────────────────────────────────────
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {}

// ─── known meetings ───────────────────────────────────────────────────────────
// Extend this list as new meetings are published on infocouncil.biz.
// id format: {committee}-{DD}{MMM}{YYYY}
// infocouncil URL pattern:
//   agenda:  Open/{YYYY}/{MM}/LTF_{DDMMYYYY}_AGN_{ID}_AT.HTM
//   minutes: Open/{YYYY}/{MM}/LTF_{DDMMYYYY}_MIN_{ID}.HTM
const MEETINGS = [
  {
    id: 'ltf-18may2026',
    committee_id: 'ltf',
    date: '2026-05-18',
    agendaId: '4285',
    agendaUrl: 'https://innerwest.infocouncil.biz/Open/2026/05/LTF_18052026_AGN_4285_AT.HTM',
    minutesUrl: 'https://innerwest.infocouncil.biz/Open/2026/05/LTF_18052026_MIN_4285.HTM',
  },
  {
    id: 'ltf-20apr2026',
    committee_id: 'ltf',
    date: '2026-04-20',
    agendaId: '4284',
    agendaUrl: 'https://innerwest.infocouncil.biz/Open/2026/04/LTF_20042026_AGN_4284_AT.HTM',
    minutesUrl: 'https://innerwest.infocouncil.biz/Open/2026/04/LTF_20042026_MIN_4284.HTM',
  },
  {
    id: 'ltf-16mar2026',
    committee_id: 'ltf',
    date: '2026-03-16',
    agendaId: '4283',
    agendaUrl: 'https://innerwest.infocouncil.biz/Open/2026/03/LTF_16032026_AGN_4283_AT.HTM',
    minutesUrl: 'https://innerwest.infocouncil.biz/Open/2026/03/LTF_16032026_MIN_4283.HTM',
  },
  {
    id: 'ltf-16feb2026',
    committee_id: 'ltf',
    date: '2026-02-16',
    agendaId: '4282',
    agendaUrl: 'https://innerwest.infocouncil.biz/Open/2026/02/LTF_16022026_AGN_4282_AT.HTM',
    minutesUrl: 'https://innerwest.infocouncil.biz/Open/2026/02/LTF_16022026_MIN_4282.HTM',
  },
];

// ─── fetch HTML ───────────────────────────────────────────────────────────────
async function fetchHtml(url, { retries = 3, timeoutMs = 120_000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (attempt > 1) {
      const wait = attempt * 5_000; // 10s, 15s between retries
      console.log(`  retry ${attempt}/${retries} in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
    console.log(`  fetching ${url}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'InnerWestWatch/1.0 (council data digest; contact via github.com/leemcdougall/innerwestwatch)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error(`timed out after ${timeoutMs / 1000}s`) : err;
      console.log(`  attempt ${attempt} failed: ${lastErr.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`failed after ${retries} attempts: ${lastErr.message} — ${url}`);
}

// ─── split HTML into per-item sections ───────────────────────────────────────
// infocouncil agenda and minutes both use the pattern:
//   "LTF0526(1) Item N" at the start of each item section.
// We split on that boundary and return one string per item.
function splitIntoItems(html) {
  // Strip HTML tags to get plain text for Claude — keeps content, loses markup noise
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, '\n\n')
    .trim();

  // Split on item boundaries — pattern: "LTF\d+\(\d+\) Item \d+"
  // e.g. "LTF0526(1) Item 1", "LTF0526(1) Item 2"
  const parts = text.split(/(?=LTF\d+\(\d+\)\s+Item\s+\d+)/i);

  // Filter to actual item sections (skip preamble)
  return parts
    .filter(p => /LTF\d+\(\d+\)\s+Item\s+\d+/i.test(p))
    .map(p => p.trim());
}

// ─── extract item number from section text ────────────────────────────────────
function extractItemNumber(sectionText) {
  const m = sectionText.match(/LTF\d+\(\d+\)\s+Item\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Claude API: extract structured data from agenda item ────────────────────
// Sends all item sections in one call to minimise API round-trips.
async function extractAgendaData(client, meetingId, itemSections) {
  const itemsText = itemSections
    .map((text, i) => `=== ITEM SECTION ${i + 1} ===\n${text.slice(0, 2000)}`)
    .join('\n\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are extracting structured data from Inner West Council Local Transport Forum agenda items.

For each item section below, extract:
- item_number: the integer from "Item N" in the heading
- type: one of exactly: crossing, parking, latm, speed, event
  - crossing = raised pedestrian crossing or roundabout
  - parking = parking restrictions, resident parking, EV charging, no stopping/parking zones
  - latm = local area traffic management works (road closures, kerb blisters, humps, etc.)
  - speed = speed limit changes
  - event = temporary road closures for an event
- headline: a plain-language summary in 10 words or fewer, written for a resident (not bureaucratic). Lead with what's changing. E.g. "New raised crossing — Darling St at Curtis Rd"
- suburbs: array of suburb names mentioned as affected locations
- streets: array of street names mentioned as affected locations (e.g. "Illawarra Rd", "Wharf St")

Return a JSON array, one object per item, in item number order. No commentary, just the JSON array.

Example output:
[
  {
    "item_number": 1,
    "type": "crossing",
    "headline": "New raised crossing and roundabout — Darling St at Curtis Rd",
    "suburbs": ["Balmain"],
    "streets": ["Darling St", "Curtis Rd"]
  }
]

ITEM SECTIONS:
${itemsText}`,
      },
    ],
  });

  const raw = response.content[0].text.trim();
  // Extract JSON array from response (Claude may wrap in markdown code block)
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`Claude returned no JSON array for agenda extraction:\n${raw}`);
  return JSON.parse(jsonMatch[0]);
}

// ─── Claude API: extract resolution data from minutes item ───────────────────
async function extractMinutesData(client, itemSections) {
  const itemsText = itemSections
    .map((text, i) => `=== ITEM SECTION ${i + 1} ===\n${text.slice(0, 2000)}`)
    .join('\n\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are extracting resolution outcomes from Inner West Council Local Transport Forum minutes.

For each item section below, extract:
- item_number: the integer from "Item N" in the heading
- status: one of exactly:
  - forum-yes        = approved without changes
  - forum-amended    = approved with amendments, or approved in principle (returns to Forum)
  - forum-no         = not supported / deferred indefinitely
- resolution: a plain-language one-sentence summary of what was decided, written for a resident. Include key details like street name, what specifically was approved or rejected, and any important conditions. E.g. "Approved — raised pedestrian crossing at Illawarra Rd/Wharf St to proceed."
- works_start: ISO 8601 date (YYYY-MM-DD) if a specific construction start date is mentioned, otherwise null

Return a JSON array, one object per item, in item number order. No commentary, just JSON.

Example:
[
  {
    "item_number": 1,
    "status": "forum-yes",
    "resolution": "Approved — raised pedestrian crossing and roundabout at Darling St/Curtis Rd to proceed, coordinated with bus operator Transit Systems.",
    "works_start": null
  }
]

ITEM SECTIONS:
${itemsText}`,
      },
    ],
  });

  const raw = response.content[0].text.trim();
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`Claude returned no JSON array for minutes extraction:\n${raw}`);
  return JSON.parse(jsonMatch[0]);
}

// ─── D1 query via Cloudflare REST API ─────────────────────────────────────────
async function d1Query(sql, params = []) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_DATABASE_ID;
  const token = process.env.CLOUDFLARE_D1_TOKEN;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    }
  );

  const data = await res.json();
  if (!data.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}\nSQL: ${sql}`);
  }
  return data.result;
}

// ─── write a meeting and its items to D1 ─────────────────────────────────────
async function writeMeetingToD1(meeting, agendaItems, minutesItems, minutesPublished) {
  const mid = meeting.id;
  const now = new Date().toISOString();

  // Build a map of item_number → minutes data for fast lookup
  const minutesMap = {};
  for (const m of minutesItems) minutesMap[m.item_number] = m;

  const statements = [];

  // Committee (INSERT OR IGNORE — safe to re-run)
  statements.push({
    sql: `INSERT OR IGNORE INTO committees (id, name) VALUES (?, ?)`,
    params: [meeting.committee_id, 'Local Transport Forum'],
  });

  // Meeting
  statements.push({
    sql: `INSERT OR REPLACE INTO meetings (id, committee_id, date, agenda_url, minutes_url, minutes_published)
          VALUES (?, ?, ?, ?, ?, ?)`,
    params: [
      mid,
      meeting.committee_id,
      meeting.date,
      meeting.agendaUrl,
      minutesPublished ? meeting.minutesUrl : null,
      minutesPublished ? 1 : 0,
    ],
  });

  // Agenda document
  statements.push({
    sql: `INSERT OR REPLACE INTO documents (id, meeting_id, type, url, fetched_at)
          VALUES (?, ?, 'agenda-html', ?, ?)`,
    params: [`doc-agn-${meeting.agendaId}`, mid, meeting.agendaUrl, now],
  });

  // Minutes document (if published)
  if (minutesPublished) {
    statements.push({
      sql: `INSERT OR REPLACE INTO documents (id, meeting_id, type, url, fetched_at)
            VALUES (?, ?, 'minutes-html', ?, ?)`,
      params: [`doc-min-${meeting.agendaId}`, mid, meeting.minutesUrl, now],
    });
  }

  // Topics and decisions
  for (const item of agendaItems) {
    const n = item.item_number;
    const topicId = `topic-${mid}-${String(n).padStart(2, '0')}`;
    const decisionId = `${mid}-${String(n).padStart(2, '0')}`;
    const mins = minutesMap[n];
    const status = mins ? mins.status : 'on-agenda';
    const resolution = mins ? mins.resolution : null;
    const worksStart = mins ? mins.works_start : null;

    statements.push({
      sql: `INSERT OR REPLACE INTO topics (id, type, headline, status, suburbs, streets)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [
        topicId,
        item.type,
        item.headline,
        status,
        JSON.stringify(item.suburbs || []),
        JSON.stringify(item.streets || []),
      ],
    });

    statements.push({
      sql: `INSERT OR REPLACE INTO decisions (id, meeting_id, topic_id, item_number, resolution, works_start)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [decisionId, mid, topicId, n, resolution, worksStart || null],
    });
  }

  // Execute all statements
  // D1 REST API supports batch queries — send in chunks of 10 to stay under limits
  const CHUNK = 10;
  for (let i = 0; i < statements.length; i += CHUNK) {
    const chunk = statements.slice(i, i + CHUNK);
    // Execute sequentially within each chunk
    for (const { sql, params } of chunk) {
      await d1Query(sql, params);
    }
  }

  console.log(`  wrote ${agendaItems.length} topics + decisions to D1`);
}

// ─── purge all data ───────────────────────────────────────────────────────────
async function purgeAll() {
  console.log('purging existing data...');
  // Order matters — foreign key constraints (decisions → topics/meetings, etc.)
  for (const table of ['documents', 'decisions', 'topics', 'meetings', 'committees']) {
    await d1Query(`DELETE FROM ${table}`);
    console.log(`  cleared ${table}`);
  }
}

// ─── process one meeting ──────────────────────────────────────────────────────
async function processMeeting(meeting, client) {
  console.log(`\nprocessing ${meeting.id} (${meeting.date})`);

  // Fetch agenda
  let agendaHtml;
  try {
    agendaHtml = await fetchHtml(meeting.agendaUrl);
  } catch (err) {
    console.error(`  ERROR fetching agenda: ${err.message} — skipping`);
    return;
  }

  const agendaSections = splitIntoItems(agendaHtml);
  console.log(`  found ${agendaSections.length} item sections in agenda`);
  if (agendaSections.length === 0) {
    console.error('  no items found — check HTML structure');
    return;
  }

  // Extract structured data from agenda via Claude
  console.log('  extracting agenda data with Claude...');
  const agendaItems = await extractAgendaData(client, meeting.id, agendaSections);
  console.log(`  extracted ${agendaItems.length} items`);

  // Fetch minutes (may not exist yet)
  let minutesItems = [];
  let minutesPublished = false;
  try {
    const minutesHtml = await fetchHtml(meeting.minutesUrl);
    const minutesSections = splitIntoItems(minutesHtml);
    if (minutesSections.length > 0) {
      console.log('  extracting minutes data with Claude...');
      minutesItems = await extractMinutesData(client, minutesSections);
      minutesPublished = true;
      console.log(`  extracted ${minutesItems.length} resolutions`);
    }
  } catch (err) {
    console.log(`  minutes not available (${err.message}) — items will be on-agenda`);
  }

  // Write to D1
  await writeMeetingToD1(meeting, agendaItems, minutesItems, minutesPublished);
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Validate env
  const required = ['ANTHROPIC_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_D1_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    console.error('Add them to a .env file or set them in the environment.');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Determine which meetings to process
  const targetId = process.argv[2];
  const meetings = targetId
    ? MEETINGS.filter(m => m.id === targetId)
    : MEETINGS;

  if (meetings.length === 0) {
    console.error(`No meeting found with id: ${targetId}`);
    console.error(`Known meetings: ${MEETINGS.map(m => m.id).join(', ')}`);
    process.exit(1);
  }

  // Purge existing data before full re-ingest
  // Skip purge when processing a single meeting (incremental update)
  if (!targetId) {
    await purgeAll();
  }

  for (const meeting of meetings) {
    await processMeeting(meeting, client);
  }

  console.log('\ndone.');
}

main().catch(err => {
  console.error('fatal:', err.message);
  process.exit(1);
});
