/**
 * db/lib/infocouncil.js — reading the infocouncil.biz portal (shared source-side code).
 *
 * Everything that DISCOVERS meetings on infocouncil.biz and EXTRACTS structured data from
 * their agenda/minutes HTML, extracted verbatim from db/ingest.js (session 24, issue #83)
 * so the weekly appender (db/append-weekly.js) and the legacy manual ingest (db/ingest.js)
 * share one copy — one definition of the URL patterns, the item splitter, and the
 * extraction prompts, so a portal change is fixed in one place.
 *
 * Nothing in this module writes to D1. The id-stable write side lives in
 * db/lib/append-meeting.js (ADR 0009).
 */

import { readFileSync } from 'fs';

// ─── committee config ─────────────────────────────────────────────────────────
// site_id: the numeric value in infocouncil.biz's ddlCommittee dropdown
// slug: used in meeting IDs and D1 committee.id
// types: the item type vocabulary for this committee (used in Claude prompts)
export const COMMITTEES = {
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

// ─── helpers ──────────────────────────────────────────────────────────────────
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Emit a warning that shows up as a highlighted annotation in GitHub Actions.
// Outside CI it just prints to stderr.
export function warn(message) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::warning::${message}`);
  } else {
    console.warn(`WARNING: ${message}`);
  }
}

// ─── infocouncil: get fresh ViewState for form POSTs ─────────────────────────
export async function getViewstateData() {
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
export async function fetchMeetingList(committeeId, year, month, vsd) {
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
      // The in-document item reference code for THIS meeting, e.g. "C0526" for a
      // 19 May 2026 Council meeting, "LTF0526" for an LTF meeting. infocouncil
      // agendas embed cross-references to OTHER meetings' items (deferred items,
      // "previously considered at C0426 Item 5"), so the splitter must filter on
      // this prefix to keep only the current meeting's own items. See splitHtmlByItems.
      refPrefix: `${prefix}${mon}${yr.slice(2)}`,
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
        refPrefix: meta.refPrefix,
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
        refPrefix: meta.refPrefix,
        isExtra: meta.isExtra,
        minutesOnly: false,
      });
    }
  }

  return { meetings, unmatched };
}

// ─── discover all meetings across committees for the past N months ─────────────
export async function discoverMeetings(monthsBack, committeeSlugFilter) {
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
        warn(`Unknown committee on infocouncil.biz — id=${id} name="${name.trim()}" — add it to COMMITTEES in db/lib/infocouncil.js`);
      }
    }
  }

  // Warn about document links that couldn't be parsed
  for (const link of unmatchedLinks) {
    warn(`Unmatched document link (pattern may have changed): ${link}`);
  }
}

// ─── fetch HTML with retries ──────────────────────────────────────────────────
const UA = 'InnerWestWatch/1.0 (council data digest; contact via github.com/leemcdougall/innerwestwatch)';

export async function fetchHtml(url, { retries = 3, timeoutMs = 120_000 } = {}) {
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
//
// CRITICAL: infocouncil agendas embed cross-references to OTHER meetings' items —
// a deferred item carries its prior reference (e.g. a 19 May 2026 / C0526 agenda
// cites "C0426(1) Item 5" for the April meeting it was held over from). Each ref
// code is `<COMMITTEE><MMYY>(<n>) Item <N>`, so the MMYY part identifies which
// meeting an item belongs to. Without filtering on the CURRENT meeting's prefix,
// those cross-refs leak in as phantom items (April's Items 41-46 appearing under a
// May meeting that only has 40) and, via the "longest section wins" rule, can even
// overwrite a real item's content with a same-numbered item from another meeting.
// `refPrefix` (e.g. "C0526") restricts the split to this meeting's own items.
const MAX_IMAGES_PER_ITEM = 6;

export function splitHtmlByItems(html, docUrl, refPrefix) {
  // Pattern covers: LTF0526(1) Item 1, C0326(1) Item 2, ILPP0426(1) Item 3, etc.
  //
  // The negative lookbehind `(?<![A-Z])` is load-bearing for MULTI-LETTER committee
  // prefixes (LTF, ILPP, FMACC, …). Without it, the greedy `[A-Z]+` satisfies the
  // lookahead at every consecutive letter of the prefix — for "LTF0526" the boundary
  // fires before L, T AND F — so String.split inserts three adjacent split points and
  // the content section ends up starting at the LAST letter ("F0526(1) Item 1"), with
  // the "LT" shaved off. Single-letter "C" (Council) is immune, which is why Council
  // ingested fine while the strict per-meeting refPrefix filter below silently dropped
  // every multi-letter committee to zero items. Anchoring the split to a non-letter
  // boundary makes each section start at the true prefix start so refPrefix can match.
  const ITEM_BOUNDARY = /(?<![A-Z])(?=[A-Z]+\d{4}\(\d+\)\s+Item\s+\d+)/gi;
  const base = docUrl.replace(/\/[^/]+\.HTM$/i, '/');

  // Only keep sections whose reference code matches THIS meeting's prefix. The match
  // is case-insensitive and anchored to the start of the ref code so "C0526" never
  // also matches an unrelated committee. If no refPrefix is supplied (legacy callers),
  // fall back to the old number-only behaviour so nothing silently drops to empty.
  const prefixRe = refPrefix
    ? new RegExp(`^${refPrefix}\\(\\d+\\)\\s+Item\\s+(\\d+)`, 'i')
    : /^[A-Z]+\d{4}\(\d+\)\s+Item\s+(\d+)/i;

  // Split raw HTML at every item boundary occurrence
  const rawParts = html.split(ITEM_BOUNDARY).filter(p =>
    /[A-Z]+\d{4}\(\d+\)\s+Item\s+\d+/i.test(p)
  );

  // Group by item number — keep the longest section per item (the actual content, not
  // TOC stubs), but only for sections belonging to the current meeting (prefixRe).
  const byItemNum = new Map();
  for (const rawSection of rawParts) {
    const m = rawSection.match(prefixRe);
    if (!m) continue; // a cross-reference to another meeting — skip it
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

export function extractItemNumber(sectionText) {
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
- commitment: classify what an APPROVED/POSITIVE determination actually commits the council to. One of exactly:
    - "action" — a concrete change or directive that produces a real-world effect: building or installing works, adopting/endorsing a plan or policy, executing a contract, approving a development, or a specific instruction to do a defined thing.
    - "process" — only a procedural step: to investigate, review, consider, prepare or receive a report, note/receive information, consult, or write to another body. Nothing is built or finally settled.
  If a single resolution does BOTH (e.g. "procure X AND investigate Y"), choose "action". Set null when outcome is null, or when the determination is a refusal/deferral (refused, not supported, withdrawn, deferred) — commitment only describes go-ahead decisions.
- resolution: a plain-language one-sentence summary of what was decided, written for a resident. Include key details — what specifically was approved, rejected, or noted, any important conditions or amendments. E.g. "Approved — raised pedestrian crossing at Illawarra Rd/Wharf St to proceed."
- works_start: ISO 8601 date (YYYY-MM-DD) if a specific construction or implementation start date is mentioned, otherwise null

Return a JSON array, one object per item, in item number order. No commentary, just JSON.`;
}

// ─── Claude API: extract structured data from agenda items (with images) ──────
// Batches items so no single API call exceeds Claude's 100-image limit.
const MAX_IMAGES_PER_CALL = 80; // leave headroom under Claude's 100-image limit
const MAX_ITEMS_PER_CALL  = 20; // cap items per call so JSON output never truncates at max_tokens
// Claude's HTTP request body cap is ~32 MB and base64 image data dominates it. A handful
// of 1.5 MB TGS plan scans (each ~2 MB once base64-encoded) blows that limit long before
// the 80-image COUNT cap — the ltf-18may2026 Tempe LATM agenda 413'd (request_too_large)
// with only 17 items. Budget well under 32 MB so a heavy-image batch always splits first.
const MAX_REQUEST_BYTES = 18 * 1024 * 1024;

export async function extractAgendaData(client, committeeId, itemSections) {
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

  // Batch items so each call stays under BOTH the image limit AND a per-call item
  // cap. Council agendas can carry 50+ items; with one JSON object per item, a single
  // call easily overruns max_tokens and returns truncated (invalid) JSON. Capping items
  // per batch keeps every response well within the token budget.
  // Estimated request bytes a section contributes: its base64 image payload plus the
  // (capped) text. Image bytes dominate; text is negligible but counted for honesty.
  const sectionBytes = s =>
    s.fetchedImages.reduce((n, img) => n + img.base64.length, 0) + (s.text ? s.text.length : 0);

  const batches = [];
  let current = [], currentImgCount = 0, currentBytes = 0;
  for (const section of sectionsWithImages) {
    const imgCount = section.fetchedImages.length;
    const bytes = sectionBytes(section);
    const wouldExceedImages = currentImgCount + imgCount > MAX_IMAGES_PER_CALL;
    const wouldExceedItems  = current.length >= MAX_ITEMS_PER_CALL;
    const wouldExceedBytes  = currentBytes + bytes > MAX_REQUEST_BYTES;
    if (current.length > 0 && (wouldExceedImages || wouldExceedItems || wouldExceedBytes)) {
      batches.push(current);
      current = [];
      currentImgCount = 0;
      currentBytes = 0;
    }
    current.push(section);
    currentImgCount += imgCount;
    currentBytes += bytes;
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
      max_tokens: 8192,
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

export async function extractMinutesData(client, committeeId, itemSections) {
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
