#!/usr/bin/env node
/**
 * db/correct-in-place.js — the one-time correct-in-place sweep (ADR 0009).
 *
 * This is db/backfill-outcomes.js widened from "fill the null outcomes" to "re-check EVERY
 * decision in a meeting against its published source, and correct it in place". It re-reads a
 * meeting's agenda + minutes, has a model report what actually happened to each item, then
 * UPDATEs the existing decision rows BY ID. It never creates rows, never re-slugs a topic id,
 * and never touches the human aliases in topic_subjects — so it is NOT a re-ingest and issue
 * #45 cannot fire (ADR 0009). D1's 30-day Time Travel is the safety net.
 *
 * Why a re-read is needed (session 18 / ADR 0009): the per-item minutes extraction has real,
 * systematic gaps. On council-19aug2025, 16 agenda items were left with a null outcome even
 * though they are genuine items of that exact meeting (verified: their agenda item numbers
 * match, e.g. our item 34 = agenda "Item 34 Birchgrove Oval Floodlighting"). They fall into
 * two honest groups this sweep must tell apart:
 *   1. Items whose outcome IS in the minutes but the first pass skipped (e.g. item 66 Lambert
 *      Park, decided but null) — recoverable by re-reading.
 *   2. Items that never get a recorded outcome in the OPEN minutes because of what they ARE:
 *        - Question on Notice  → answered in writing, no vote            → honest label "Answered"
 *        - Notice of Motion not reached / lapsed → rolls to a later meeting → "Held over"
 *        - a confidential (closed-session) report → decided out of the open record → left honest
 * The item KIND is the tell, and it is explicit in the agenda title ("Notice of Motion:",
 * "Question on Notice:"), so we hand the model each item's agenda title alongside the minutes.
 *
 * The three ADR-0009 fault classes this closes: #59 (en-bloc/"in globo"), #60 (extraction
 * fidelity — a lost motion's resolution restating the defeated motion; outcome text bleeding
 * from an adjacent item), #61 (the "not in their minutes" bucket, diagnosed above as kind, not
 * mis-assignment). Agent-in-the-loop: always --dry-run first and eyeball the diffs before
 * applying. Go meeting-by-meeting, not all at once.
 *
 * Usage:
 *   node db/correct-in-place.js --meeting council-19aug2025 --dry-run           # preview all items
 *   node db/correct-in-place.js --meeting council-19aug2025 --dry-run --only-null  # preview the nulls
 *   node db/correct-in-place.js --meeting council-19aug2025                       # apply (writes D1)
 *   node db/correct-in-place.js --all --dry-run                                  # preview EVERY meeting
 *   node db/correct-in-place.js --all                                           # apply across all
 * `--all` sweeps every meeting with published minutes EXCEPT public-forum meetings (their items are
 * community addresses with no vote, already honest via the "Raised at public forum" label).
 * After applying a meeting, run `node db/recompute-stages.js` so corrected outcomes flow into
 * topic stages, then spot-check https://innerwestwatch.pages.dev/api/items.
 *
 * Required env (from .env): ANTHROPIC_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID,
 * CLOUDFLARE_D1_TOKEN.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { normalizeLabelResult, outcomeUnclear, residentLabel } from './lib/labels.js';
import { isRefusal } from './lib/topics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── load .env (same loader as db/backfill-outcomes.js) ─────────────────────────
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const onlyNull = argv.includes('--only-null');
const all = argv.includes('--all');
const meetingArg = argv.find(a => a.startsWith('--meeting'));
const meetingId = meetingArg ? (meetingArg.split('=')[1] ?? argv[argv.indexOf(meetingArg) + 1]) : null;
// --ids a,b,c restricts writes to these exact decision ids (still reads the whole meeting for
// context). Used to apply only the changes verified against source, when a meeting mixes a safe
// correction with a contested one.
const idsArg = argv.find(a => a.startsWith('--ids'));
const onlyIds = idsArg ? new Set((idsArg.split('=')[1] ?? argv[argv.indexOf(idsArg) + 1]).split(',')) : null;

// ─── D1 REST API (same shape as db/backfill-outcomes.js) ────────────────────────
async function d1Query(sql, params = []) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_DATABASE_ID;
  const token = process.env.CLOUDFLARE_D1_TOKEN;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }) },
  );
  const json = await res.json();
  if (!json.success) throw new Error(`D1 error: ${JSON.stringify(json.errors)}`);
  return json.result[0].results;
}

// Strip an infocouncil HTML page to whitespace-collapsed text (same as backfill-outcomes.js).
function htmlToText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&#8217;/g, "'").replace(/&#8211;|&#8212;/g, '-')
    .replace(/\s+/g, ' ').trim();
}

// Pull each item's TITLE out of the agenda's table of contents. The ToC lists every item as
// "Item N <Title> <pageNumber>", and the title carries the kind prefix we need ("Notice of
// Motion:", "Question on Notice:"). We take a bounded slice up to the trailing page number so
// a title never runs on into the next section header. Regex is fine HERE because we only need
// the title string for context — the model does the actual reading of what happened (the
// handoff's rule: don't let regex decide outcomes). Returns Map(itemNumber -> title).
function extractAgendaTitles(agendaText) {
  const titles = new Map();
  // Every table-of-contents entry starts with the delimiter "C{MMYY}(n) Item N". We SPLIT on
  // that delimiter and take the text up to the next one as item N's title. Splitting (rather
  // than one boundary-anchored match) stops item 57's title from swallowing item 58 when the
  // "Questions from Councillors" section header sits between them. The first occurrence of each
  // number is its ToC entry (title only); later occurrences are the full report body, so we
  // keep the first. The title runs up to its trailing page number.
  const delims = [...agendaText.matchAll(/C\d{4}\(\d+\)\s*Item (\d+)\s+/g)];
  for (let i = 0; i < delims.length; i++) {
    const n = Number(delims[i][1]);
    if (titles.has(n)) continue;
    const start = delims[i].index + delims[i][0].length;
    const end = i + 1 < delims.length ? delims[i + 1].index : start + 200;
    const title = agendaText.slice(start, end)
      .replace(/\s+\d{1,4}\b.*$/s, '')           // cut at the trailing page number + any bleed
      .slice(0, 120).trim();
    if (title) titles.set(n, title);
  }
  return titles;
}

// The read prompt. The model gets the full minutes text plus, per item, its number, the
// agenda title (which reveals the kind), and the outcome we currently hold. It reports what
// the minutes actually record. `kind` and `status` are the honesty controls that let us label
// a Question on Notice or a not-reached Notice of Motion truthfully instead of "Coming up".
function buildPrompt(minutesText, items) {
  const list = items.map(it => (
    `- item ${it.item_number}: "${it.agenda_title ?? it.headline ?? '(no title)'}"`
    + `  [currently stored outcome: ${it.outcome ?? 'null'}]`
  )).join('\n');

  return `You are reading the published MINUTES of an Inner West Council (Sydney) meeting to record, for each listed agenda item, what the council actually did with it. You also get each item's agenda title, which tells you what KIND of item it is.

For EACH requested item return one JSON object. Return ONLY a JSON array, same order:
{"item_number": <n>, "kind": "report"|"notice-of-motion"|"question-on-notice"|"mayoral-minute"|"confidential"|"other", "status": "decided"|"answered"|"not-reached"|"deferred"|"withdrawn"|"lost"|"no-determination", "outcome": "<raw word or null>", "resolution": "<plain summary>", "commitment": "action"|"process"|null, "resident_sentence": "<text>", "text_has_refusal": true|false}

kind — read it from the agenda title: a title starting "Notice of Motion:" is notice-of-motion; "Question on Notice:" is question-on-notice; a mayoral minute is mayoral-minute; anything the minutes flag as confidential / closed session is confidential; otherwise report. When unsure, "other".

status — what the minutes record for this item:
- "decided": the minutes record a determination — an individual motion (Carried/Lost), an "in globo"/en-bloc adoption that LISTS this item's number, a deferral, a withdrawal. Use this for anything actually resolved.
- "answered": a Question on Notice. These get a written answer, not a vote — there is no motion. Use this even if the minutes do not restate the question.
- "not-reached": a Notice of Motion the meeting did not get to (it is not in any motion, in-globo list, or resolution) and which therefore lapses to a later meeting.
- "deferred": explicitly deferred/held over to a later meeting.
- "withdrawn": explicitly withdrawn.
- "lost": a motion put and DEFEATED (Motion Lost). The resolution must say the motion was lost — do NOT restate the defeated motion as if it passed.
- "no-determination": genuinely nothing recorded and none of the above fit.

outcome — the council's raw determination word for a "decided" item (approved/carried/adopted/noted/endorsed/deferred/"not supported"/lost/withdrawn). For an in-globo adoption use "adopted". For status answered use "answered"; not-reached use "not reached"; deferred use "deferred"; withdrawn use "withdrawn"; lost use "lost"; no-determination use null.

resolution — one plain sentence of what was actually resolved or recorded (NOT the debate, NOT the motion-as-moved for a lost motion). For a lost motion, say it was lost. For a Question on Notice, one line on what was asked/answered.

commitment — judge from what was resolved: "action" (a concrete change: build, adopt a plan/budget, fund, execute) vs "process" (only investigate/review/receive/note/endorse in principle); null if refused, deferred, withdrawn, lost, not reached, answered-only, or not determined. Action wins a mixed resolution.

resident_sentence — one to two plain-English sentences, impact first, at most ~240 chars. Describe what was DECIDED (or that it was answered / held over / lost), not what was proposed. Spell out acronyms (LEP = Local Environmental Plan, RAP = Reconciliation Action Plan, LTF = Local Traffic Committee). A rejection reads as a rejection. For a question-on-notice, say plainly that a councillor asked about this and it was answered in writing outside the meeting, with no vote taken (never "no recorded answer"). For a held-over/deferred/not-reached item, say it was held over to a later meeting so nothing is decided yet.

text_has_refusal — true if the resolution text itself refuses/rejects/declines/knocks back anything; false otherwise.

ITEMS:
${list}

MINUTES TEXT:
${minutesText}`;
}

// ─── local honest-label preview ──────────────────────────────────────────────────
// What the resident would see for a proposed correction. For the two new honest cases the
// site does not render yet ("Answered" for a Question on Notice; "Held over" for a not-reached
// Notice of Motion), we compute the label HERE so the dry-run is truthful about the intent.
// Step 2 (on Lee's sign-off) folds these into db/lib/labels.js + the API. Everything else
// routes through the real residentLabel so card and data already agree.
const PREVIEW_ANSWERED = 'Answered';

// What the resident would see for a proposed correction. A Question on Notice is the one case
// the site does not render yet ("Answered"); Step 2 folds it into db/lib/labels.js + the API.
// Everything else routes through the REAL residentLabel, and the stored outcome word carries
// the meaning: "held over"/"deferred" already read as `deferred` → "Held over" in topics.js,
// a refusal word reads "Decided", null reads "Coming up". So the preview needs no second copy
// of the label logic beyond the one QoN special case.
function previewLabel({ kind, outcome, commitment, unclear, type }) {
  if (kind === 'question-on-notice') return PREVIEW_ANSWERED;
  return residentLabel({ outcome: outcome ?? null, commitment, outcome_unclear: unclear ? 1 : 0 }, type);
}

// Map a model read to the outcome word we would STORE, so the neutral-stage machinery keeps
// working. A Question on Notice stores "answered" (the one new word Step 2 teaches labels.js);
// a not-reached motion stores "held over" (already reads as `deferred` in db/lib/topics.js);
// a genuinely undetermined item stays null. Everything else keeps the council's raw word.
function storedOutcome(kind, status, outcome) {
  if (kind === 'question-on-notice') return 'answered';
  // A confidential (closed-session) item has NO public outcome. The open minutes only show a
  // procedural motion to enter closed session ("carried"), never the substance — which is
  // confidential by law (e.g. a personnel matter under s10A(2)(a)). We refuse to fabricate an
  // outcome here: writing "carried" would read as a public decision that was never disclosed.
  // Left null (skipped) as a genuine "no public outcome" case, pending a product decision on
  // how to label closed-session items honestly. (council-17feb2026-extra-01.)
  if (kind === 'confidential') return null;
  if (status === 'not-reached') return 'held over';
  if (status === 'no-determination') return null;
  return outcome ?? null;
}

// The DETERMINATION CLASS of an outcome word — the coarse "what did the council actually do"
// bucket that decides whether a row is genuinely WRONG and worth rewriting. We correct a row
// only when this class moves (e.g. null "none" → "held-over", or "passed" → "held-over" for
// the wrongly-approved 41/42/44). We deliberately do NOT rewrite when only the label wobbles
// from a re-rolled commitment tag, or when the word swaps within a class ("approved"↔"carried"
// are both "passed") — churning a correct row is the worse error (Lee: a wrong change beats a
// stale one). Passed vs refused are separate classes so a genuine approve→reject flip (the #60
// adjacent-bleed case) is still caught.
function determinationClass(outcome) {
  const o = (outcome || '').toLowerCase();
  if (!o) return 'none';
  if (o === 'answered') return 'answered';
  if (o.includes('defer') || o.includes('held over')) return 'held-over';
  if (isRefusal(o)) return 'refused';
  return 'passed';
}

// #60 sub-case detector. A refusal row can be correctly CLASSED yet still carry a `resolution`
// that RESTATES the defeated motion — the raw "That Council: 1. Notes that…" text as moved, or a
// stale "Approved —" left behind when only the outcome word was corrected — instead of recording
// the "no". Such a resolution contains none of the refusal markers a genuine refusal resolution
// carries. We use this only to decide whether to RE-EXAMINE the text; the fresh source read is
// what actually writes the honest resolution. Near-blank resolutions (e.g. a withdrawn item with
// no recorded detail) are not restatements, so they are left alone rather than churned.
function restatesMotion(resolution) {
  const r = (resolution || '').trim();
  if (r.length < 15) return false;
  return !isRefusal(r);
}

// ─── process one meeting ─────────────────────────────────────────────────────────
async function processMeeting(client, mid) {
  const [meeting] = await d1Query(
    `SELECT id, agenda_url, minutes_url, minutes_published FROM meetings WHERE id = ?`, [mid]);
  if (!meeting) { console.log(`  ! meeting ${mid} not found`); return { mid, changed: 0, applied: 0 }; }
  if (!meeting.minutes_published || !meeting.minutes_url) {
    console.log(`  ! ${mid} has no published minutes — skipping (agenda-only, honestly "Coming up")`);
    return { mid, changed: 0, applied: 0 };
  }

  // Every decision in the meeting (or just the nulls, with --only-null), plus the topic type
  // deriveStage needs as its commitment fallback.
  let items = await d1Query(
    `SELECT d.id, d.item_number, d.headline, d.outcome, d.resolution, d.commitment,
            d.resident_sentence, d.outcome_unclear, t.type
       FROM decisions d JOIN topics t ON t.id = d.topic_id
      WHERE d.meeting_id = ? ${onlyNull ? 'AND d.outcome IS NULL' : ''}
      ORDER BY d.item_number`, [mid]);
  // --ids: only READ the target items (the model still gets full minutes for context), so a
  // targeted apply is one fast call instead of re-reading a 60-item meeting in five batches.
  if (onlyIds) items = items.filter(it => onlyIds.has(it.id));
  if (items.length === 0) { console.log(`  ${mid}: nothing to check`); return { mid, changed: 0, applied: 0 }; }

  console.log(`\n${mid} — checking ${items.length} item(s); fetching source…`);
  const [minutesHtml, agendaHtml] = await Promise.all([
    fetch(meeting.minutes_url).then(r => r.text()),
    meeting.agenda_url ? fetch(meeting.agenda_url).then(r => r.text()) : Promise.resolve(''),
  ]);
  const minutesText = htmlToText(minutesHtml);
  const agendaTitles = extractAgendaTitles(htmlToText(agendaHtml));
  for (const it of items) it.agenda_title = agendaTitles.get(it.item_number) ?? null;

  // Read in batches so a big meeting's ~65 items never overflow one model response. Each batch
  // still sees the FULL minutes text (so it can resolve in-globo lists and cross-references);
  // it only reports on its own slice of items.
  const BATCH = 15;
  const results = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const part = await readMinutes(client, minutesText, items.slice(i, i + BATCH));
    results.push(...part);
  }
  const byNum = new Map(items.map(it => [it.item_number, it]));

  let changed = 0, same = 0;
  const writes = [];
  for (const r of results) {
    const src = byNum.get(r.item_number);
    if (!src) continue;
    if (onlyIds && !onlyIds.has(src.id)) continue;   // --ids: ignore items outside the verified set

    // Build the proposed record from the read.
    const norm = normalizeLabelResult(r);
    const proposedOutcome = storedOutcome(r.kind, r.status, r.outcome);

    // A Question on Notice is answered in writing, never voted on. The model occasionally
    // words its sentence as "not reached" for these (it is reading a silence in the minutes),
    // which would read as if a decision were pending. Force a deterministic, honest sentence so
    // the QoN framing never depends on the model's wording. The subject comes from the agenda
    // title (its "Question on Notice:" prefix stripped) or the stored headline.
    if (r.kind === 'question-on-notice') {
      const subject = (src.agenda_title ?? src.headline ?? 'this matter')
        .replace(/^Question on Notice:\s*/i, '').trim();
      norm.resident_sentence =
        `A councillor asked a question about ${subject} on notice. It was answered in writing outside the meeting, with no vote taken.`;
    }
    const unclear = outcomeUnclear({ outcome: proposedOutcome, commitment: norm.commitment, textHasRefusal: norm.textHasRefusal });

    const beforeLabel = residentLabel(
      { outcome: src.outcome, commitment: src.commitment, outcome_unclear: src.outcome_unclear }, src.type);
    const afterLabel = previewLabel(
      { kind: r.kind, status: r.status, outcome: proposedOutcome, commitment: norm.commitment, unclear, type: src.type });

    // A "real change" = the DETERMINATION CLASS moved (none→held-over, passed→held-over, …).
    // This ignores label wobble from a re-rolled commitment tag and within-class word swaps
    // ("approved"↔"carried"), so a correct row is never churned — only genuinely wrong
    // determinations are rewritten.
    // Guardrail: NEVER blank an outcome we already hold. If the model can't relocate a
    // determination we previously recorded, that is a limit of this read, not evidence the
    // stored outcome is wrong. This protects confidential items especially — their substance is
    // closed, but the open resolution we stored ("noted"/"adopted") is legitimate and must not
    // be erased into a misleading "Coming up". The sweep corrects and fills; it never deletes.
    if (src.outcome && proposedOutcome === null) { same++; continue; }

    const beforeClass = determinationClass(src.outcome);
    const afterClass = determinationClass(proposedOutcome);
    const isChange = beforeClass !== afterClass;

    // #60 within-class text fix: the refusal class is already right (refused→refused) so the
    // class-gate skips it, but the stored resolution still RESTATES the defeated motion. Catch it
    // by inspecting the stored text. We keep the (correct) refusal outcome word and refresh only
    // the resolution/sentence from the fresh source read — never a determination flip on this path.
    const staleRefusalText =
      !isChange && afterClass === 'refused' && restatesMotion(src.resolution);

    // The resolution the model read from source this pass. Previously this never reached the
    // write: normalizeLabelResult never returned a resolution, so `w.norm.resolution` was always
    // undefined and the stale stored resolution silently persisted — the other half of #60.
    const proposedResolution =
      typeof r.resolution === 'string' && r.resolution.trim() ? r.resolution.trim() : null;

    if (isChange || staleRefusalText) {
      changed++;
      // A text-only fix keeps the already-correct outcome word; a class change adopts the new one.
      const writeOutcome = isChange ? proposedOutcome : src.outcome;
      console.log(`\n  ▸ item ${r.item_number}  (${r.kind} · ${r.status})  ${src.id}`);
      console.log(`      reason:   ${isChange ? `${beforeClass} → ${afterClass}` : 'refusal text fix — stored resolution restated the motion'}`);
      console.log(`      outcome:  ${src.outcome ?? 'null'}   →   ${writeOutcome ?? 'null'}`);
      console.log(`      label:    ${beforeLabel}   →   ${afterLabel}`);
      console.log(`      title:    ${src.agenda_title ?? src.headline ?? ''}`);
      console.log(`      says:     ${norm.resident_sentence ?? '(none)'}`);
      writes.push({ src, proposedOutcome: writeOutcome, proposedResolution, norm, unclear });
    } else {
      same++;
    }
  }

  console.log(`\n  ${changed} item(s) would change; ${same} unchanged.`);

  if (!dryRun && writes.length) {
    for (const w of writes) {
      await d1Query(
        `UPDATE decisions SET outcome = ?, resolution = ?, commitment = ?, resident_sentence = ?, outcome_unclear = ?
           WHERE id = ?`,
        [w.proposedOutcome, w.proposedResolution ?? w.src.resolution ?? null, w.norm.commitment,
         w.norm.resident_sentence, w.unclear ? 1 : 0, w.src.id]);
    }
    console.log(`  applied ${writes.length} update(s) to ${mid}.`);
  }

  return { mid, changed, applied: dryRun ? 0 : writes.length };
}

async function readMinutes(client, minutesText, items) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    messages: [{ role: 'user', content: buildPrompt(minutesText, items) }],
  });
  const raw = response.content[0].text.trim();
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`Model returned no JSON array:\n${raw.slice(0, 300)}`);
  return JSON.parse(m[0]);
}

async function main() {
  const required = ['ANTHROPIC_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_D1_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) { console.error(`Missing env: ${missing.join(', ')}`); process.exit(1); }
  if (!meetingId && !all) { console.error('Pass --meeting <id>, or --all to sweep every meeting.'); process.exit(1); }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // The meetings to sweep. `--all` takes every meeting with published minutes EXCEPT public-forum
  // ones (community addresses, no vote — already honest via "Raised at public forum"). Otherwise
  // the single meeting named with --meeting.
  let meetings;
  if (all) {
    meetings = (await d1Query(
      `SELECT m.id FROM meetings m WHERE m.minutes_published = 1 AND m.id NOT LIKE 'public-forum%'
         AND EXISTS (SELECT 1 FROM decisions d WHERE d.meeting_id = m.id) ORDER BY m.id`)).map(r => r.id);
  } else {
    meetings = [meetingId];
  }

  console.log(`${dryRun ? 'DRY RUN — ' : ''}correct-in-place sweep — ${meetings.length} meeting(s)${onlyNull ? ' (null outcomes only)' : ''}`);

  const summary = [];
  for (const mid of meetings) summary.push(await processMeeting(client, mid));

  if (all) {
    // Aggregate so a broad sweep is reviewable at a glance: which meetings move, how much.
    const touched = summary.filter(s => s && s.changed > 0);
    const totalChanged = summary.reduce((n, s) => n + (s?.changed ?? 0), 0);
    const totalApplied = summary.reduce((n, s) => n + (s?.applied ?? 0), 0);
    console.log(`\n${'═'.repeat(60)}\nSWEEP SUMMARY — ${meetings.length} meetings, ${totalChanged} item(s) ${dryRun ? 'would change' : `changed (${totalApplied} applied)`}:`);
    for (const s of touched.sort((a, b) => b.changed - a.changed)) console.log(`  ${String(s.changed).padStart(3)}  ${s.mid}`);
    if (touched.length === 0) console.log('  (no changes — everything already matches source)');
  }

  if (!dryRun) console.log('\nNext: run `node db/recompute-stages.js`, then spot-check /api/items.');
}

main().catch(err => { console.error(err); process.exit(1); });
