/**
 * db/lib/append-meeting.js — read ONE meeting from source and write it to D1, id-stably.
 *
 * The write side of the pipeline, extracted verbatim from db/ingest.js (session 24,
 * issue #83) so the weekly appender (db/append-weekly.js) and the legacy manual ingest
 * (db/ingest.js) share one copy of the attach-or-create rule.
 *
 * Why this is id-stable BY CONSTRUCTION (ADR 0009): an item's subject is matched against
 * the topic_subjects alias store on EXACT normalised key only. A hit attaches the new
 * decision to the existing topic — the topic id is never recomputed, so human-confirmed
 * aliases can't be orphaned (#45 cannot fire). Only a genuinely NEW subject mints a new
 * topic id. The danger in the retired `ingest.js --force` path was never this code — it
 * was re-READING a known meeting, which rewords the AI subject and misses the alias.
 * Appending an unseen meeting, as the weekly appender does, only ever adds.
 */

import { d1Query } from './d1.js';
import { normKey, slug, deriveStage } from './topics.js';
import {
  COMMITTEES, fetchHtml, splitHtmlByItems, extractAgendaData, extractMinutesData,
} from './infocouncil.js';

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
export function resolveTopicId(subject, aliasMap, existingIds) {
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
export async function writeMeetingToD1(meeting, agendaItems, minutesItems, minutesPublished) {
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
    const commitment = mins ? (mins.commitment || null) : null; // action|process (ADR 0007)

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

    // Decision: the per-appearance record (its own headline + raw outcome + commitment).
    stmts.push({
      sql: `INSERT OR REPLACE INTO decisions (id, meeting_id, topic_id, item_number, headline, resolution, outcome, works_start, commitment)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [decisionId, mid, topicId, n, item.headline, resolution, outcome, worksStart || null, commitment],
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
      `SELECT d.outcome, d.works_start, d.commitment, m.date, t.type
         FROM decisions d
         JOIN meetings m ON m.id = d.meeting_id
         JOIN topics t   ON t.id = d.topic_id
        WHERE d.topic_id = ?`, [topicId]))[0]?.results || [];
    const dates = decs.map(d => d.date).filter(Boolean).sort();
    // type is the topic's representative type — same on every row; feeds the commitment
    // fallback in deriveStage when a decision has no AI commitment tag (ADR 0007).
    await d1Query(
      `UPDATE topics SET first_seen = ?, last_seen = ?, stage = ? WHERE id = ?`,
      [dates[0] || null, dates[dates.length - 1] || null, deriveStage(decs, decs[0]?.type), topicId]);
  }

  const imageCount = agendaItems.reduce((n, it) => n + (it.keyImageUrls?.length || 0), 0);
  console.log(`  wrote ${agendaItems.length} decisions across ${touchedTopics.size} topics, ${imageCount} images to D1`);
}

// ─── process one meeting: fetch source, extract, write ────────────────────────
// Returns the decision ids written (for chaining the sentence-writer over exactly the
// new rows), or [] when the meeting was skipped (fetch failure, no items found).
export async function processMeeting(meeting, client) {
  const committeeName = COMMITTEES[meeting.committee_site_id]?.name || meeting.committee_id;
  console.log(`\nprocessing ${meeting.id} (${meeting.date}, ${committeeName})`);

  const decisionIds = items =>
    items.map(it => `${meeting.id}-${String(it.item_number).padStart(2, '0')}`);

  // ── minutes-only committees (e.g. Public Forum): no agenda doc ──
  if (meeting.minutesOnly) {
    let minutesHtml;
    try {
      console.log(`  fetching minutes (primary source): ${meeting.minutesUrl}`);
      minutesHtml = await fetchHtml(meeting.minutesUrl);
    } catch (err) {
      console.error(`  ERROR fetching minutes: ${err.message} — skipping`);
      return [];
    }

    const sections = splitHtmlByItems(minutesHtml, meeting.minutesUrl, meeting.refPrefix);
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
    return decisionIds(items);
  }

  // ── standard agenda + optional minutes ──
  let agendaHtml;
  try {
    console.log(`  fetching agenda: ${meeting.agendaUrl}`);
    agendaHtml = await fetchHtml(meeting.agendaUrl);
  } catch (err) {
    console.error(`  ERROR fetching agenda: ${err.message} — skipping`);
    return [];
  }

  const itemSections = splitHtmlByItems(agendaHtml, meeting.agendaUrl, meeting.refPrefix);
  console.log(`  found ${itemSections.length} item sections`);
  if (itemSections.length === 0) {
    console.error('  no items found — check HTML structure');
    return [];
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
      const minutesSections = splitHtmlByItems(minutesHtml, meeting.minutesUrl, meeting.refPrefix);
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
  return decisionIds(agendaItems);
}
