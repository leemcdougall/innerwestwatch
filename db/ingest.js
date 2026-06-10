#!/usr/bin/env node
/**
 * db/ingest.js — Inner West Watch ingestion pipeline
 *
 * Scans infocouncil.biz for all committee meetings across the past N months,
 * extracts structured data from each agenda and minutes using Claude, and writes
 * to D1. Images embedded in agenda documents are fetched and passed to Claude
 * as vision content — traffic diagrams, maps, and site plans contain important
 * information that plain text alone misses.
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
import { normKey, slug, deriveStage } from './lib/topics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── load .env ────────────────────────────────────────────────────────────────
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {}

// ─── committee config ─────────────────────────────────────────────────────────
// site_id: the numeric value in infocouncil.biz's ddlCommittee dropdown
// slug: used in meeting IDs and D1 committee.id
// types: the item type vocabulary for this committee (used in Claude prompts)
const COMMITTEES = {
  '1':  {
    slug: 'council',
    name: 'Council',
    types: 'motion | notice-of-motion | mayoral-minute | development | infrastructure | report | other',
    typeHints: `
  - motion = council resolution or formal motion
  - notice-of-motion = councillor notice of motion
  - mayoral-minute = mayoral minute
  - development = development application or planning decision
  - infrastructure = infrastructure, capital works, road or park project
  - report = staff report or briefing
  - other = anything else`,
  },
  '6':  {
    slug: 'council-extra',
    name: 'Extraordinary Council',
    types: 'motion | notice-of-motion | report | other',
    typeHints: `
  - motion = formal resolution
  - notice-of-motion = councillor notice of motion
  - report = staff report or briefing
  - other = anything else`,
  },
  '12': {
    slug: 'ltf',
    name: 'Local Transport Forum',
    types: 'crossing | parking | latm | speed | event',
    typeHints: `
  - crossing = raised pedestrian crossing, roundabout, or pedestrian refuge
  - parking = parking restrictions, resident parking zones, EV charging, no stopping
  - latm = local area traffic management works (speed humps, kerb blisters, road closures, shared zones)
  - speed = speed limit changes
  - event = temporary road closure for a community event`,
  },
  '13': {
    slug: 'lrac',
    name: 'Local Representation Advisory Committee',
    types: 'transport | planning | community | report | other',
    typeHints: `
  - transport = transport or traffic matter
  - planning = planning or development matter
  - community = community or cultural matter
  - report = staff report or briefing
  - other = anything else`,
  },
  '14': {
    slug: 'lrac-leichhardt',
    name: 'LRAC Leichhardt',
    types: 'transport | planning | community | report | other',
    typeHints: `
  - transport = transport or traffic matter
  - planning = planning or development matter
  - community = community or cultural matter
  - report = staff report or briefing
  - other = anything else`,
  },
  '15': {
    slug: 'lrac-ashfield',
    name: 'LRAC Ashfield',
    types: 'transport | planning | community | report | other',
    typeHints: `
  - transport = transport or traffic matter
  - planning = planning or development matter
  - community = community or cultural matter
  - report = staff report or briefing
  - other = anything else`,
  },
  '16': {
    slug: 'lrac-marrickville',
    name: 'LRAC Marrickville',
    types: 'transport | planning | community | report | other',
    typeHints: `
  - transport = transport or traffic matter
  - planning = planning or development matter
  - community = community or cultural matter
  - report = staff report or briefing
  - other = anything else`,
  },
  '17': {
    slug: 'iag',
    name: 'Implementation Advisory Group',
    types: 'project | report | other',
    typeHints: `
  - project = implementation of a specific project or program
  - report = staff report or progress update
  - other = anything else`,
  },
  '23': {
    slug: 'fmac',
    name: 'Flood Management Advisory Committee',
    types: 'flood-study | infrastructure | policy | report | other',
    typeHints: `
  - flood-study = flood study, modelling, or risk assessment
  - infrastructure = drainage, detention basin, or flood infrastructure
  - policy = flood policy or development control guideline
  - report = staff report or briefing
  - other = anything else`,
  },
  '24': {
    slug: 'ilpp',
    name: 'Inner West Local Planning Panel',
    types: 'development-application | planning-proposal | modification | rezoning | other',
    typeHints: `
  - development-application = DA determined by the panel
  - planning-proposal = planning proposal or local environmental plan amendment
  - modification = modification to an existing approval
  - rezoning = rezoning application
  - other = anything else`,
  },
  '29': {
    slug: 'amsc',
    name: 'Asset Management Steering Committee',
    types: 'asset | report | other',
    typeHints: `
  - asset = asset management strategy or plan
  - report = staff report or briefing
  - other = anything else`,
  },
  '30': {
    slug: 'wmwg',
    name: 'Waste Management Working Group',
    types: 'waste | report | other',
    typeHints: `
  - waste = waste management, recycling, or sustainability initiative
  - report = staff report or briefing
  - other = anything else`,
  },
  '31': {
    slug: 'public-forum',
    name: 'Public Forum',
    // Public Forum publishes minutes only — no agenda docs.
    // Minutes list community members who addressed council and what they raised.
    minutesOnly: true,
    types: 'community-address',
    typeHints: `
  - community-address = a resident or community member addressing council`,
  },
};

// Months with no LTF activity (they just don't meet — saves unnecessary scan noise)
const LIKELY_NO_MEETING_MONTHS = {}; // empty — scan everything, let the site return nothing

// ─── parse CLI args ───────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { months: 6, meetingId: null, committeeSlug: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--months' && args[i + 1]) opts.months = parseInt(args[++i], 10);
    if (args[i] === '--meeting' && args[i + 1]) opts.meetingId = args[++i];
    if (args[i] === '--committee' && args[i + 1]) opts.committeeSlug = args[++i];
  }
  return opts;
}

// ─── infocouncil: get fresh ViewState for form POSTs ─────────────────────────
async function getViewstateData() {
  const ua = 'InnerWestWatch/1.0 (council data digest; contact via github.com/leemcdougall/innerwestwatch)';
  const resp = await fetch('https://innerwest.infocouncil.biz/', {
    headers: { 'User-Agent': ua },
  });
  const cookies = resp.headers.getSetCookie().join('; ');
  const html = await resp.text();
  return {
    vs:      html.split('id="__VIEWSTATE" value="')[1]?.split('"')[0] || '',
    ev:      html.split('id="__EVENTVALIDATION" value="')[1]?.split('"')[0] || '',
    vsg:     html.split('id="__VIEWSTATEGENERATOR" value="')[1]?.split('"')[0] || '',
    cookies,
    ua,
  };
}

// ─── infocouncil: discover meetings for one committee + month ─────────────────
// Returns array of raw meeting objects parsed from the site listing.
async function fetchMeetingList(committeeId, year, month, vsd) {
  const body = new URLSearchParams({
    '__VIEWSTATE': vsd.vs,
    '__VIEWSTATEGENERATOR': vsd.vsg,
    '__EVENTVALIDATION': vsd.ev,
    '__EVENTTARGET': '',
    '__EVENTARGUMENT': '',
    'ddlCommittee': String(committeeId),
    'ddlYear': String(year),
    'ddlMonth': String(month),
    'hdnSortColumn': 'Date',
    'hdnSortOrder': '1',
    'btnView': 'View',
  });

  const resp = await fetch('https://innerwest.infocouncil.biz/', {
    method: 'POST',
    headers: {
      'User-Agent': vsd.ua,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://innerwest.infocouncil.biz/',
      'Cookie': vsd.cookies,
    },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`infocouncil listing returned HTTP ${resp.status}`);
  const html = await resp.text();

  // Links go through RedirectToDoc.aspx?URL=Open/YYYY/MM/FILENAME
  // We want AGN (agenda) and MIN (minutes) files — skip ATT (attachments), EXCLUDED, PDFs
  const agendaLinks = [...html.matchAll(
    /RedirectToDoc\.aspx\?URL=(Open\/\d{4}\/\d{2}\/[^"]+_AGN_[^"]+_WEB\.htm)/gi
  )].map(m => m[1]);

  const minutesLinks = [...html.matchAll(
    /RedirectToDoc\.aspx\?URL=(Open\/\d{4}\/\d{2}\/[^"]+_MIN_[^"]+_WEB\.htm)/gi
  )].map(m => m[1]);

  const committee = COMMITTEES[String(committeeId)];
  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const meetings = [];
  const unmatched = []; // links we saw but couldn't parse — surfaced as audit warnings

  // Helper: parse a document path into meeting metadata
  function parseMeetingFromPath(path, type) {
    // type is 'AGN' or 'MIN'
    const pattern = type === 'AGN'
      ? /Open\/(\d{4})\/(\d{2})\/([A-Z0-9]+)_(\d{8})_AGN_(\d+)(_AT_EXTRA|_AT)?_WEB\.htm/i
      : /Open\/(\d{4})\/(\d{2})\/([A-Z0-9]+)_(\d{8})_MIN_(\d+)(_EXTRA)?_WEB\.htm/i;
    const m = path.match(pattern);
    if (!m) return null;
    const [, , , prefix, dateStr, docId, extraSuffix] = m;
    const isExtra = /_EXTRA/i.test(path);
    const day = dateStr.slice(0, 2);
    const mon = dateStr.slice(2, 4);
    const yr = dateStr.slice(4);
    return {
      prefix, dateStr, docId, isExtra,
      date: `${yr}-${mon}-${day}`,
      meetingId: `${committee.slug}-${day}${monthNames[parseInt(mon, 10) - 1]}${yr}${isExtra ? '-extra' : ''}`,
      htmUrl: `https://innerwest.infocouncil.biz/${path.replace(/_WEB\.htm$/i, '.HTM')}`,
    };
  }

  if (committee.minutesOnly) {
    // For committees that publish minutes only (e.g. Public Forum),
    // treat each minutes doc as a standalone meeting with no separate agenda.
    for (const minPath of minutesLinks) {
      const meta = parseMeetingFromPath(minPath, 'MIN');
      if (!meta) { unmatched.push(minPath); continue; }
      meetings.push({
        id: meta.meetingId,
        committee_id: committee.slug,
        committee_site_id: committeeId,
        date: meta.date,
        agendaId: meta.docId,
        agendaUrl: null,          // no agenda for minutes-only committees
        minutesUrl: meta.htmUrl,
        isExtra: meta.isExtra,
        minutesOnly: true,
      });
    }
  } else {
    // Build a minutes lookup keyed by prefix_dateStr_docId
    const minutesMap = new Map();
    for (const link of minutesLinks) {
      const meta = parseMeetingFromPath(link, 'MIN');
      if (meta) minutesMap.set(`${meta.prefix}_${meta.dateStr}_${meta.docId}`, meta.htmUrl);
    }

    for (const agendaPath of agendaLinks) {
      const meta = parseMeetingFromPath(agendaPath, 'AGN');
      if (!meta) { unmatched.push(agendaPath); continue; }
      const minutesUrl = minutesMap.get(`${meta.prefix}_${meta.dateStr}_${meta.docId}`) || null;
      meetings.push({
        id: meta.meetingId,
        committee_id: committee.slug,
        committee_site_id: committeeId,
        date: meta.date,
        agendaId: meta.docId,
        agendaUrl: meta.htmUrl,
        minutesUrl,
        isExtra: meta.isExtra,
        minutesOnly: false,
      });
    }
  }

  return { meetings, unmatched };
}

// ─── discover all meetings across committees for the past N months ─────────────
async function discoverMeetings(monthsBack, committeeSlugFilter) {
  console.log(`\ndiscovering meetings — last ${monthsBack} months across all committees...`);

  const vsd = await getViewstateData();

  const now = new Date();
  const monthsToScan = [];
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthsToScan.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  const committeeIds = Object.keys(COMMITTEES).filter(id => {
    if (!committeeSlugFilter) return true;
    return COMMITTEES[id].slug === committeeSlugFilter;
  });

  const allMeetings = [];
  const unmatchedLinks = [];

  for (const committeeId of committeeIds) {
    const committee = COMMITTEES[committeeId];
    let found = 0;
    for (const { year, month } of monthsToScan) {
      const { meetings, unmatched } = await fetchMeetingList(committeeId, year, month, vsd);
      allMeetings.push(...meetings);
      unmatchedLinks.push(...unmatched);
      found += meetings.length;
      await sleep(200);
    }
    if (found > 0) console.log(`  ${committee.name}: ${found} meetings`);
  }

  console.log(`  total discovered: ${allMeetings.length} meetings`);

  // Audit: warn about unknown committees or unmatched document links.
  // Runs on every invocation so the GitHub Actions log always reflects portal state.
  await auditPortal(vsd, unmatchedLinks).catch(err =>
    warn(`audit failed: ${err.message}`)
  );

  return allMeetings;
}

// ─── fetch HTML with retries ──────────────────────────────────────────────────
const UA = 'InnerWestWatch/1.0 (council data digest; contact via github.com/leemcdougall/innerwestwatch)';

async function fetchHtml(url, { retries = 3, timeoutMs = 120_000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (attempt > 1) {
      const wait = attempt * 5_000;
      console.log(`  retry ${attempt}/${retries} in ${wait / 1000}s...`);
      await sleep(wait);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA } });
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

// ─── fetch an image as base64 ─────────────────────────────────────────────────
// Returns null if the image is too large or fails to fetch.
const MAX_IMAGE_BYTES = 1_500_000; // 1.5 MB — skip larger files

async function fetchImageBase64(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) return null;
    const b64 = Buffer.from(buf).toString('base64');
    const ct = res.headers.get('content-type') || '';
    const mediaType = ct.includes('png') ? 'image/png'
      : ct.includes('gif') ? 'image/gif'
      : ct.includes('webp') ? 'image/webp'
      : 'image/jpeg';
    return { base64: b64, mediaType };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── split raw HTML into per-item sections, collecting image URLs per section ──
// Returns array of { text: string, imageUrls: string[] }
// imageUrls are fully resolved against docUrl.
//
// Large council documents repeat item reference codes in the table of contents,
// headers, and cross-references. We deduplicate by item number and keep only the
// largest section per item number (which is the actual item content, not a TOC stub).
const MAX_IMAGES_PER_ITEM = 6;

function splitHtmlByItems(html, docUrl) {
  // Pattern covers: LTF0526(1) Item 1, C0326(1) Item 2, ILPP0426(1) Item 3, etc.
  const ITEM_BOUNDARY = /(?=[A-Z]+\d{4}\(\d+\)\s+Item\s+\d+)/gi;
  const base = docUrl.replace(/\/[^/]+\.HTM$/i, '/');

  // Split raw HTML at every item boundary occurrence
  const rawParts = html.split(ITEM_BOUNDARY).filter(p =>
    /[A-Z]+\d{4}\(\d+\)\s+Item\s+\d+/i.test(p)
  );

  // Group by item number — keep the longest section per item (the actual content, not TOC stubs)
  const byItemNum = new Map();
  for (const rawSection of rawParts) {
    const m = rawSection.match(/[A-Z]+\d{4}\(\d+\)\s+Item\s+(\d+)/i);
    if (!m) continue;
    const itemNum = parseInt(m[1], 10);
    const existing = byItemNum.get(itemNum);
    if (!existing || rawSection.length > existing.length) {
      byItemNum.set(itemNum, rawSection);
    }
  }

  // Convert to sorted array of { text, imageUrls }
  return [...byItemNum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, rawSection]) => {
      const imgSrcs = [...rawSection.matchAll(/<img[^>]+src="([^"]+)"/gi)]
        .map(m => m[1])
        .filter(src => !src.startsWith('data:') && !src.startsWith('http'));

      const imageUrls = [...new Set(imgSrcs)]
        .slice(0, MAX_IMAGES_PER_ITEM)
        .map(src => `${base}${src}`);

      const text = rawSection
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

      return { text, imageUrls };
    });
}

function extractItemNumber(sectionText) {
  const m = sectionText.match(/[A-Z]+\d{4}\(\d+\)\s+Item\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ─── build Claude extraction prompt for agenda items ─────────────────────────
function buildAgendaPrompt(committeeId) {
  const committee = COMMITTEES[committeeId];
  return `You are extracting structured data from Inner West Council ${committee.name} agenda items.

For each item section below, extract:
- item_number: the integer from "Item N" in the heading
- type: one of exactly: ${committee.types}${committee.typeHints}
- subject: the canonical SUBJECT — the stable name of the underlying project, place, event, policy, or works that stays the same if this item returns to a later meeting (possibly at a different committee). Strip meeting-specific verbs, outcomes, and dates; keep distinguishing place/street names that are part of the issue's identity. This is what threads recurring items into one topic. E.g. headline "FDC appointed to build Leichhardt pool" -> subject "Leichhardt Aquatic Centre Stage 2"; headline "Road closures — Italian Festa, 25 Oct 2026" -> subject "Italian Festa road closures, Norton St".
- headline: a plain-language summary in 12 words or fewer, written for a resident (not bureaucratic). Lead with what's changing or being decided. Include street name if one is mentioned. E.g. "New raised crossing — Darling St at Curtis Rd" or "DA approved — 42 Smith St, Marrickville"
- suburbs: array of suburb names mentioned as affected locations (empty array if none)
- streets: array of street names mentioned as affected locations, e.g. "Illawarra Rd", "Wharf St" (empty array if none)
- key_image_indices: array of 0-based indices into the images for this item that are genuinely informative (traffic diagrams, site maps, engineering drawings) — exclude logos, headers, photos of unrelated locations. Empty array if no informative images.

Images appear in the content blocks after each item's text. Use them to identify specific street locations, understand the scope of works, and improve the headline.

Return a JSON array, one object per item, in item number order. No commentary, just the JSON array.

Example:
[
  {
    "item_number": 1,
    "type": "crossing",
    "subject": "Darling St & Curtis Rd crossing",
    "headline": "New raised crossing — Darling St at Curtis Rd",
    "suburbs": ["Balmain"],
    "streets": ["Darling St", "Curtis Rd"],
    "key_image_indices": [0, 2]
  }
]`;
}

// ─── build Claude extraction prompt for minutes resolutions ───────────────────
function buildMinutesPrompt(committeeId) {
  const committee = COMMITTEES[committeeId];

  // ADR 0004: capture the RAW determination in council's own terms, not a forced
  // committee-specific enum. The neutral lifecycle `stage` is derived from this
  // later (db/lib/topics.js). "deferred" stays "deferred" — it is not a rejection.
  return `You are extracting resolution outcomes from Inner West Council ${committee.name} minutes.

For each item section below, extract:
- item_number: the integer from "Item N" in the heading
- outcome: the raw determination in the council's own terms, as a short lower-case string. Use the actual word the minutes use: "approved", "approved with amendments", "refused", "not supported", "deferred", "adopted", "endorsed", "noted", "withdrawn", "contract executed", etc. Null if the item was listed but no determination was recorded.
- resolution: a plain-language one-sentence summary of what was decided, written for a resident. Include key details — what specifically was approved, rejected, or noted, any important conditions or amendments. E.g. "Approved — raised pedestrian crossing at Illawarra Rd/Wharf St to proceed."
- works_start: ISO 8601 date (YYYY-MM-DD) if a specific construction or implementation start date is mentioned, otherwise null

Return a JSON array, one object per item, in item number order. No commentary, just JSON.`;
}

// ─── Claude API: extract structured data from agenda items (with images) ──────
// Batches items so no single API call exceeds Claude's 100-image limit.
const MAX_IMAGES_PER_CALL = 80; // leave headroom under Claude's 100-image limit

async function extractAgendaData(client, committeeId, itemSections) {
  // Fetch all images in parallel first
  if (itemSections.some(s => s.imageUrls.length > 0)) {
    console.log('  fetching item images...');
  }
  const sectionsWithImages = await Promise.all(
    itemSections.map(async section => {
      const fetchedImages = await Promise.all(
        section.imageUrls.map(url => fetchImageBase64(url).catch(() => null))
      );
      return { ...section, fetchedImages: fetchedImages.filter(Boolean) };
    })
  );

  const totalImages = sectionsWithImages.reduce((n, s) => n + s.fetchedImages.length, 0);
  if (totalImages > 0) console.log(`  loaded ${totalImages} images for vision`);

  // Batch items so total images per call stays under the limit
  const batches = [];
  let current = [], currentImgCount = 0;
  for (const section of sectionsWithImages) {
    const imgCount = section.fetchedImages.length;
    if (current.length > 0 && currentImgCount + imgCount > MAX_IMAGES_PER_CALL) {
      batches.push(current);
      current = [];
      currentImgCount = 0;
    }
    current.push(section);
    currentImgCount += imgCount;
  }
  if (current.length > 0) batches.push(current);

  const allExtracted = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (batches.length > 1) console.log(`  batch ${b + 1}/${batches.length} (${batch.length} items)`);

    // Build content: prompt + interleaved text/images per item
    const content = [{ type: 'text', text: buildAgendaPrompt(committeeId) + '\n\nITEM SECTIONS:\n' }];
    for (let i = 0; i < batch.length; i++) {
      const { text, fetchedImages } = batch[i];
      content.push({ type: 'text', text: `\n=== ITEM SECTION ${i + 1} ===\n${text.slice(0, 3000)}` });
      for (const img of fetchedImages) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
      }
    }

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content }],
    });

    const raw = response.content[0].text.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error(`Claude returned no JSON array (batch ${b + 1}):\n${raw.slice(0, 300)}`);
    allExtracted.push(...JSON.parse(jsonMatch[0]));
  }

  // Attach resolved image URLs using key_image_indices
  for (const item of allExtracted) {
    const section = sectionsWithImages.find(s => extractItemNumber(s.text) === item.item_number);
    if (section) {
      item.keyImageUrls = (item.key_image_indices || [])
        .map(idx => section.imageUrls[idx])
        .filter(Boolean);
    }
    delete item.key_image_indices;
  }

  return allExtracted;
}

// ─── Claude API: extract resolution data from minutes ────────────────────────
// Batches items in groups of 20 so large Council minutes don't hit token limits.
const MINUTES_BATCH_SIZE = 20;

async function extractMinutesData(client, committeeId, itemSections) {
  const allExtracted = [];

  for (let i = 0; i < itemSections.length; i += MINUTES_BATCH_SIZE) {
    const batch = itemSections.slice(i, i + MINUTES_BATCH_SIZE);
    const batchNum = Math.floor(i / MINUTES_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(itemSections.length / MINUTES_BATCH_SIZE);
    if (totalBatches > 1) console.log(`  minutes batch ${batchNum}/${totalBatches}`);

    const itemsText = batch
      .map((s, j) => `=== ITEM SECTION ${i + j + 1} ===\n${s.text.slice(0, 2000)}`)
      .join('\n\n');

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{ role: 'user', content: `${buildMinutesPrompt(committeeId)}\n\nITEM SECTIONS:\n${itemsText}` }],
    });

    const raw = response.content[0].text.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error(`Claude returned no JSON array for minutes batch ${batchNum}:\n${raw.slice(0, 300)}`);
    allExtracted.push(...JSON.parse(jsonMatch[0]));
  }

  return allExtracted;
}

// ─── D1 REST API ──────────────────────────────────────────────────────────────
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

// ─── resolve an item's SUBJECT to a persistent topic (attach-or-create) ───────
// ADR 0003: the canonical subject is the linking signal, and matching LEARNS. We
// look the item's normalised subject up in topic_subjects (the learned alias store).
//   hit  → attach this appearance to the known topic, no human prompt (this is how
//          oversight trends to zero: a confirmed subject never needs reviewing again)
//   miss → mint a new persistent topic and record an `auto` alias for it. The offline
//          reconciliation pass (db/match.js) later proposes fuzzy/cross-type merges a
//          human confirms; a confirmation upgrades the alias to source='human'.
// Ingest itself only ever matches on EXACT normKey — no fuzzy AI guess is baked into
// the source of truth here (a wrong link is a published falsehood).
// Returns { id, key, isNew }. Does NOT write — the caller orders writes so the topic
// row exists before the alias/decision rows that reference it (foreign keys).
function resolveTopicId(subject, aliasMap, existingIds) {
  const key = normKey(subject);
  if (aliasMap.has(key)) return { id: aliasMap.get(key), key, isNew: false }; // attach

  // new subject → mint a unique topic id, disambiguating slug collisions
  let id = `topic-${slug(subject)}`;
  if (existingIds.has(id)) { let n = 2; while (existingIds.has(`${id}-${n}`)) n++; id = `${id}-${n}`; }
  existingIds.add(id);
  aliasMap.set(key, id);
  return { id, key, isNew: true };
}

// ─── write a meeting and its items to D1 ─────────────────────────────────────
async function writeMeetingToD1(meeting, agendaItems, minutesItems, minutesPublished) {
  const mid = meeting.id;
  const now = new Date().toISOString();
  const minutesMap = {};
  for (const m of minutesItems) minutesMap[m.item_number] = m;

  // Load the learned alias store and existing topic state so we can attach to known
  // topics and union place arrays without clobbering what earlier meetings recorded.
  const aliasRows  = (await d1Query('SELECT subject_key, topic_id FROM topic_subjects'))[0]?.results || [];
  const aliasMap   = new Map(aliasRows.map(r => [r.subject_key, r.topic_id]));
  const topicRows  = (await d1Query('SELECT id, subject, type, headline, suburbs, streets, first_seen, last_seen, detail_page FROM topics'))[0]?.results || [];
  const existingIds = new Set(topicRows.map(r => r.id));
  const topicState = new Map(topicRows.map(r => [r.id, r]));

  const stmts = [];

  // Committee (INSERT OR IGNORE — idempotent)
  stmts.push({
    sql: `INSERT OR IGNORE INTO committees (id, name) VALUES (?, ?)`,
    params: [meeting.committee_id, COMMITTEES[meeting.committee_site_id]?.name || meeting.committee_id],
  });

  // Meeting
  stmts.push({
    sql: `INSERT OR REPLACE INTO meetings (id, committee_id, date, agenda_url, minutes_url, minutes_published)
          VALUES (?, ?, ?, ?, ?, ?)`,
    params: [mid, meeting.committee_id, meeting.date, meeting.agendaUrl,
             minutesPublished ? meeting.minutesUrl : null, minutesPublished ? 1 : 0],
  });

  // Primary document (agenda for standard meetings; minutes for minutes-only committees)
  if (meeting.agendaUrl) {
    stmts.push({
      sql: `INSERT OR REPLACE INTO documents (id, meeting_id, type, url, fetched_at) VALUES (?, ?, 'agenda-html', ?, ?)`,
      params: [`doc-agn-${meeting.agendaId}`, mid, meeting.agendaUrl, now],
    });
  }

  if (minutesPublished) {
    stmts.push({
      sql: `INSERT OR REPLACE INTO documents (id, meeting_id, type, url, fetched_at) VALUES (?, ?, 'minutes-html', ?, ?)`,
      params: [`doc-min-${meeting.agendaId}`, mid, meeting.minutesUrl, now],
    });
  }

  // Each agenda item is ONE decision (this appearance) threaded onto a persistent topic.
  const touchedTopics = new Set();
  for (const item of agendaItems) {
    const n = item.item_number;
    const decisionId = `${mid}-${String(n).padStart(2, '0')}`;
    const mins = minutesMap[n];
    const outcome    = mins ? (mins.outcome || null) : null; // raw determination (ADR 0004)
    const resolution = mins ? mins.resolution : null;
    const worksStart = mins ? mins.works_start : null;

    const subject = item.subject || item.headline || 'untitled';
    const { id: topicId, key: subjectKey, isNew } = resolveTopicId(subject, aliasMap, existingIds);
    touchedTopics.add(topicId);

    // Topic FIRST (FKs: alias, decision and images all reference topics(id)).
    // Upsert in place — never DELETE+INSERT (that would break child FKs on re-ingest).
    // Union this appearance's places into the topic's running sets; let the LATEST
    // meeting own the display subject/headline/type. stage + first/last_seen are
    // recomputed from the full decision history after all writes land.
    const prev = topicState.get(topicId) || {};
    const mergeJson = (field, arr) => {
      const s = new Set(JSON.parse(prev[field] || '[]'));
      for (const v of (arr || [])) s.add(v);
      return JSON.stringify([...s]);
    };
    const isLatest = !prev.last_seen || meeting.date >= prev.last_seen;
    const next = {
      id: topicId,
      subject:  isLatest ? subject : (prev.subject || subject),
      type:     isLatest ? item.type : (prev.type || item.type),
      headline: isLatest ? item.headline : (prev.headline || item.headline),
      suburbs:  mergeJson('suburbs', item.suburbs),
      streets:  mergeJson('streets', item.streets),
      detail_page: prev.detail_page || null,
    };
    topicState.set(topicId, { ...next, last_seen: isLatest ? meeting.date : prev.last_seen });
    stmts.push({
      sql: `INSERT INTO topics (id, subject, type, headline, stage, suburbs, streets, detail_page, first_seen, last_seen)
            VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, NULL, NULL)
            ON CONFLICT(id) DO UPDATE SET
              subject = excluded.subject, type = excluded.type, headline = excluded.headline,
              suburbs = excluded.suburbs, streets = excluded.streets, detail_page = excluded.detail_page`,
      params: [next.id, next.subject, next.type, next.headline, next.suburbs, next.streets, next.detail_page],
    });

    // Learned alias for a brand-new subject (source=auto; a human confirm upgrades it).
    if (isNew) {
      stmts.push({
        sql: `INSERT OR IGNORE INTO topic_subjects (subject_key, topic_id, source, created_at) VALUES (?, ?, 'auto', ?)`,
        params: [subjectKey, topicId, now],
      });
    }

    // Decision: the per-appearance record (its own headline + raw outcome).
    stmts.push({
      sql: `INSERT OR REPLACE INTO decisions (id, meeting_id, topic_id, item_number, headline, resolution, outcome, works_start)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [decisionId, mid, topicId, n, item.headline, resolution, outcome, worksStart || null],
    });

    // Key images for this appearance hang off the topic.
    const keyImages = item.keyImageUrls || [];
    for (let seq = 0; seq < keyImages.length; seq++) {
      stmts.push({
        sql: `INSERT OR REPLACE INTO images (id, topic_id, url, sequence) VALUES (?, ?, ?, ?)`,
        params: [`img-${decisionId}-${String(seq).padStart(3, '0')}`, topicId, keyImages[seq], seq],
      });
    }
  }

  // Execute all writes first (sequentially — D1 REST has no true transactions), so the
  // recompute below sees this meeting's freshly-written decisions.
  for (const { sql, params } of stmts) {
    await d1Query(sql, params);
  }

  // Now recompute each touched topic's first/last_seen and neutral stage FROM its full
  // decision history (covers appearances written by earlier meetings AND this one).
  for (const topicId of touchedTopics) {
    const decs = (await d1Query(
      `SELECT d.outcome, d.works_start, m.date
         FROM decisions d JOIN meetings m ON m.id = d.meeting_id
        WHERE d.topic_id = ?`, [topicId]))[0]?.results || [];
    const dates = decs.map(d => d.date).filter(Boolean).sort();
    await d1Query(
      `UPDATE topics SET first_seen = ?, last_seen = ?, stage = ? WHERE id = ?`,
      [dates[0] || null, dates[dates.length - 1] || null, deriveStage(decs), topicId]);
  }

  const imageCount = agendaItems.reduce((n, it) => n + (it.keyImageUrls?.length || 0), 0);
  console.log(`  wrote ${agendaItems.length} decisions across ${touchedTopics.size} topics, ${imageCount} images to D1`);
}

// ─── process one meeting ──────────────────────────────────────────────────────
async function processMeeting(meeting, client) {
  const committeeName = COMMITTEES[meeting.committee_site_id]?.name || meeting.committee_id;
  console.log(`\nprocessing ${meeting.id} (${meeting.date}, ${committeeName})`);

  // ── minutes-only committees (e.g. Public Forum): no agenda doc ──
  if (meeting.minutesOnly) {
    let minutesHtml;
    try {
      console.log(`  fetching minutes (primary source): ${meeting.minutesUrl}`);
      minutesHtml = await fetchHtml(meeting.minutesUrl);
    } catch (err) {
      console.error(`  ERROR fetching minutes: ${err.message} — skipping`);
      return;
    }

    const sections = splitHtmlByItems(minutesHtml, meeting.minutesUrl);
    console.log(`  found ${sections.length} item sections`);
    if (sections.length === 0) {
      // Public Forum minutes may not follow the standard Item N pattern —
      // treat the whole document as a single item
      const stripped = minutesHtml
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/\s{3,}/g, '\n\n').trim();
      sections.push({ text: stripped, imageUrls: [] });
    }

    console.log('  extracting items with Claude...');
    const items = await extractAgendaData(client, meeting.committee_site_id, sections);
    console.log(`  extracted ${items.length} items`);

    // Minutes-only committees (e.g. Public Forum): the extracted doc IS the minutes,
    // but the agenda extractor doesn't emit an `outcome`, so these decisions land with
    // outcome=null (stage defaults to proposed). Capturing their raw outcome is a known
    // follow-up; for now they thread by subject like any other appearance.
    await writeMeetingToD1(meeting, items, [], true);
    return;
  }

  // ── standard agenda + optional minutes ──
  let agendaHtml;
  try {
    console.log(`  fetching agenda: ${meeting.agendaUrl}`);
    agendaHtml = await fetchHtml(meeting.agendaUrl);
  } catch (err) {
    console.error(`  ERROR fetching agenda: ${err.message} — skipping`);
    return;
  }

  const itemSections = splitHtmlByItems(agendaHtml, meeting.agendaUrl);
  console.log(`  found ${itemSections.length} item sections`);
  if (itemSections.length === 0) {
    console.error('  no items found — check HTML structure');
    return;
  }

  console.log('  extracting agenda data with Claude...');
  const agendaItems = await extractAgendaData(client, meeting.committee_site_id, itemSections);
  console.log(`  extracted ${agendaItems.length} items`);

  let minutesItems = [];
  let minutesPublished = false;
  if (meeting.minutesUrl) {
    try {
      console.log(`  fetching minutes: ${meeting.minutesUrl}`);
      const minutesHtml = await fetchHtml(meeting.minutesUrl);
      const minutesSections = splitHtmlByItems(minutesHtml, meeting.minutesUrl);
      if (minutesSections.length > 0) {
        console.log('  extracting minutes data with Claude...');
        minutesItems = await extractMinutesData(client, meeting.committee_site_id, minutesSections);
        minutesPublished = true;
        console.log(`  extracted ${minutesItems.length} resolutions`);
      }
    } catch (err) {
      console.log(`  minutes not available (${err.message}) — items will be on-agenda`);
    }
  }

  await writeMeetingToD1(meeting, agendaItems, minutesItems, minutesPublished);
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Emit a warning that shows up as a highlighted annotation in GitHub Actions.
// Outside CI it just prints to stderr.
function warn(message) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::warning::${message}`);
  } else {
    console.warn(`WARNING: ${message}`);
  }
}

// ─── audit: check for unknown committees or unmatched document links ──────────
// Fetches the live infocouncil.biz committee dropdown and warns about any IDs
// not in our COMMITTEES config, and any document links that couldn't be parsed.
// Called once per run so a human checking the Actions log will see any gaps.
async function auditPortal(vsd, unmatchedLinks) {
  // Check committee dropdown against our config
  const resp = await fetch('https://innerwest.infocouncil.biz/', {
    headers: { 'User-Agent': vsd.ua },
  });
  const html = await resp.text();

  const commIdx = html.indexOf('ddlCommittee');
  const yearIdx = html.indexOf('ddlYear');
  if (commIdx >= 0 && yearIdx > commIdx) {
    const section = html.slice(commIdx, yearIdx);
    const options = [...section.matchAll(/<option[^>]+value="(\d+)"[^>]*>([^<]+)<\/option>/g)];
    for (const [, id, name] of options) {
      if (id === '0') continue; // [All] option
      if (!COMMITTEES[id]) {
        warn(`Unknown committee on infocouncil.biz — id=${id} name="${name.trim()}" — add it to COMMITTEES in db/ingest.js`);
      }
    }
  }

  // Warn about document links that couldn't be parsed
  for (const link of unmatchedLinks) {
    warn(`Unmatched document link (pattern may have changed): ${link}`);
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
    console.log('\ndone.');
    return;
  }

  // ── full scan mode ──
  const discovered = await discoverMeetings(opts.months, opts.committeeSlug);
  const alreadyIngested = await getIngestedMeetingIds();

  const toProcess = discovered.filter(m => !alreadyIngested.has(m.id));
  const skipped = discovered.length - toProcess.length;

  console.log(`\n${toProcess.length} new meetings to ingest (${skipped} already in D1)`);
  if (toProcess.length === 0) {
    console.log('nothing to do.');
    return;
  }

  // Process newest first so D1 has the most current data quickly
  toProcess.sort((a, b) => b.date.localeCompare(a.date));

  for (const meeting of toProcess) {
    await processMeeting(meeting, client);
    // Polite delay between meetings to avoid hammering either server
    await sleep(1000);
  }

  console.log('\ndone.');
}

main().catch(err => {
  console.error('fatal:', err.message);
  process.exit(1);
});
