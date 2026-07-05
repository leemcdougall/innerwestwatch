/**
 * functions/api/items.js
 *
 * Cloudflare Pages Function — GET /api/items
 *
 * Serves the THREADED model (ADR 0003): a Topic is a persistent real-world issue,
 * and many Decisions (one per meeting appearance) hang off it. The endpoint returns
 * one object per Topic, each carrying its ordered decision history. This replaces the
 * old flat one-row-per-item shape, which assumed topic==item (1:1) — no longer true.
 *
 * Query parameters (all optional, combinable):
 *   ?suburb=Marrickville        — case-insensitive suburb filter (matches the topic's
 *                                 UNION of suburbs across all its decisions)
 *   ?street=Illawarra+Rd        — case-insensitive street filter, repeatable
 *
 * A street/suburb filter matches a topic if ANY of its threaded decisions touched
 * that place — street search crosses suburb boundaries by design (project vision:
 * "what's close to me", border residents). When no parameters are supplied, all
 * topics are returned.
 *
 * Response shape per topic:
 * {
 *   id, subject, type, headline, stage, label,
 *   suburbs[], streets[], firstSeen, lastSeen, detailPage,
 *   decisions: [
 *     { id, meeting, item, date, minutesDate, headline, outcome,
 *       resolution, residentSentence, worksStart, commitment,
 *       outcomeUnclear, label, agendaUrl, minutesUrl }
 *   ],
 *   relations: [ { topicId, subject, kind, relation } ],  // kind = parent-child|related|supersedes;
 *                                                          // relation = this topic's view of the other
 *                                                          // (parent|child|related|supersedes|superseded-by)
 *   images: [ url, … ]                                     // infocouncil diagram/plan URLs, ordered
 * }
 *
 * stage is the committee-neutral lifecycle on the topic (ADR 0004):
 *   proposed | deferred | decided | in-progress | completed.
 * label is the resident-facing word for that lifecycle point (ADR 0008): the topic's
 *   `label` maps its `stage`; each decision's `label` is derived from its own outcome and
 *   is "Outcome unclear" when the resolution text contradicts the outcome word. The six-word
 *   vocabulary and the derivation both live in db/lib/labels.js — one source of truth.
 * residentSentence is the one-to-two-sentence plain-language summary a resident reads
 *   (ADR 0008), distinct from the terse per-decision `headline`.
 * outcome is the raw determination, per decision (approved, refused, adopted, …).
 * minutesDate is a decision's meeting date when minutes_published=1, else null.
 *
 * CORS: Access-Control-Allow-Origin: * so static pages can call this cross-origin.
 */

import { residentLabel, RESIDENT_LABEL } from '../../db/lib/labels.js';

export async function onRequestGet({ request, env }) {
  const url    = new URL(request.url);
  const params = url.searchParams;

  const suburbFilter  = params.get('suburb') || null;
  const streetFilters = params.getAll('street');

  try {
    // ── Which topics match the place filter? ──────────────────────────────────
    // suburbs/streets are JSON arrays on the topic (the UNION across its decisions),
    // e.g. '["Marrickville","Newtown"]'. LIKE '%"X"%' matches a whole array element.
    const whereClauses = [];
    const bindParams   = [];

    if (suburbFilter) {
      whereClauses.push(`LOWER(t.suburbs) LIKE LOWER(?)`);
      bindParams.push(`%"${suburbFilter}"%`);
    }
    for (const street of streetFilters) {
      whereClauses.push(`LOWER(t.streets) LIKE LOWER(?)`);
      bindParams.push(`%"${street}"%`);
    }
    const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // ── Fetch matching topics ─────────────────────────────────────────────────
    const topicSQL = `
      SELECT
        t.id          AS id,
        t.subject     AS subject,
        t.type        AS type,
        t.headline    AS headline,
        t.stage       AS stage,
        t.suburbs     AS suburbs_json,
        t.streets     AS streets_json,
        t.detail_page AS detailPage,
        t.first_seen  AS firstSeen,
        t.last_seen   AS lastSeen
      FROM topics t
      ${whereSQL}
      ORDER BY t.last_seen DESC, t.subject
    `;
    const { results: topicRows } = await env.DB.prepare(topicSQL).bind(...bindParams).all();

    if (topicRows.length === 0) {
      return json([], 200);
    }

    // ── Fetch every decision for the matched topics ───────────────────────────
    // D1 caps bound parameters per query (~100), so the IN (...) list is chunked.
    // Without this, an unfiltered request (287 topics) overflows the limit and D1
    // returns "too many SQL variables".
    const ids = topicRows.map(r => r.id);
    const CHUNK = 90;
    const decisionRows = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const decisionSQL = `
        SELECT
          d.id                                       AS id,
          d.topic_id                                 AS topicId,
          d.meeting_id                               AS meeting,
          d.item_number                              AS item,
          d.headline                                 AS headline,
          d.outcome                                  AS outcome,
          d.resolution                               AS resolution,
          d.resident_sentence                        AS residentSentence,
          d.works_start                              AS worksStart,
          d.commitment                               AS commitment,
          d.outcome_unclear                          AS outcomeUnclear,
          m.date                                     AS date,
          CASE WHEN m.minutes_published = 1
               THEN m.date ELSE NULL END             AS minutesDate,
          m.agenda_url                               AS agendaUrl,
          m.minutes_url                              AS minutesUrl
        FROM decisions d
        JOIN meetings m ON m.id = d.meeting_id
        WHERE d.topic_id IN (${placeholders})
        ORDER BY m.date ASC, d.item_number
      `;
      const { results } = await env.DB.prepare(decisionSQL).bind(...slice).all();
      decisionRows.push(...results);
    }

    // group decisions under their topic
    const byTopic = new Map(ids.map(id => [id, []]));
    for (const r of decisionRows) {
      byTopic.get(r.topicId)?.push({
        id:              r.id,
        meeting:         r.meeting,
        item:            r.item,
        date:            r.date,
        minutesDate:     r.minutesDate,
        headline:        r.headline,
        outcome:         r.outcome,
        resolution:      r.resolution,
        residentSentence:r.residentSentence,
        worksStart:      r.worksStart,
        commitment:      r.commitment,
        // D1 stores the flag as 0/1; expose a boolean.
        outcomeUnclear:  r.outcomeUnclear === 1,
        agendaUrl:       r.agendaUrl,
        minutesUrl:      r.minutesUrl,
      });
    }

    const idSet = new Set(ids);

    // ── Related topics (ADR 0005) ─────────────────────────────────────────────
    // Only ~73 relations exist total, so fetch them ALL in one join (no IN-list to chunk)
    // and attach in JS. A relation connects topic_a↔topic_b; `topic_a` is the parent for a
    // 'parent-child' link (human-relations.json convention). For each matched topic we serve
    // the OTHER topic plus that topic's role relative to it, so the frontend can say
    // "part of" / "leads to" without re-deriving direction.
    const OTHER_ROLE = {
      'parent-child': { a: 'child',      b: 'parent' },        // this=a → other is the child
      'supersedes':   { a: 'supersedes', b: 'superseded-by' }, // this=a → this supersedes other
      'related':      { a: 'related',    b: 'related' },        // symmetric
    };
    const relByTopic = new Map(ids.map(id => [id, []]));
    const { results: relRows } = await env.DB.prepare(`
      SELECT r.topic_a AS a, r.topic_b AS b, r.kind AS kind,
             ta.subject AS aSubject, tb.subject AS bSubject
      FROM topic_relations r
      JOIN topics ta ON ta.id = r.topic_a
      JOIN topics tb ON tb.id = r.topic_b
    `).all();
    for (const r of relRows) {
      const roles = OTHER_ROLE[r.kind] || OTHER_ROLE.related;
      if (idSet.has(r.a)) relByTopic.get(r.a).push({ topicId: r.b, subject: r.bSubject, kind: r.kind, relation: roles.a });
      if (idSet.has(r.b)) relByTopic.get(r.b).push({ topicId: r.a, subject: r.aSubject, kind: r.kind, relation: roles.b });
    }

    // ── Key images per topic ──────────────────────────────────────────────────
    // Chunked by topic_id like decisions (680 rows across topics). Ordered by `sequence`;
    // served as a plain URL list — the images are just infocouncil diagram/plan URLs.
    const imgByTopic = new Map(ids.map(id => [id, []]));
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const { results } = await env.DB.prepare(
        `SELECT topic_id AS topicId, url FROM images
           WHERE topic_id IN (${placeholders}) ORDER BY topic_id, sequence`
      ).bind(...slice).all();
      for (const r of results) imgByTopic.get(r.topicId)?.push(r.url);
    }

    const topics = topicRows.map(t => {
      const decisions = (byTopic.get(t.id) || []).map(d => ({
        ...d,
        // The honest resident label for this appearance (ADR 0008): "Outcome unclear" when
        // the text contradicts the outcome word, else the six-word map of its lifecycle
        // point. Derived by the SAME residentLabel the pass used, so card and data agree.
        label: residentLabel(
          { outcome: d.outcome, works_start: d.worksStart, commitment: d.commitment,
            outcome_unclear: d.outcomeUnclear ? 1 : 0,
            // A public-forum appearance with no outcome is a community address, not a
            // pending decision → "Raised at public forum", not "Coming up".
            publicForum: String(d.meeting).startsWith('public-forum') },
          t.type,
        ),
      }));

      return {
        id:        t.id,
        subject:   t.subject,
        type:      t.type,
        headline:  t.headline,
        stage:     t.stage,
        // The topic's resident label mirrors its neutral `stage` in the six-word vocabulary.
        label:     RESIDENT_LABEL[t.stage] ?? t.stage,
        suburbs:   JSON.parse(t.suburbs_json || '[]'),
        streets:   JSON.parse(t.streets_json || '[]'),
        firstSeen: t.firstSeen,
        lastSeen:  t.lastSeen,
        detailPage:t.detailPage,
        decisions,
        relations: relByTopic.get(t.id) || [],
        images:    imgByTopic.get(t.id) || [],
      };
    });

    return json(topics, 200);

  } catch (err) {
    // Surface the error in the body so it is visible in the network tab.
    return json({ error: err.message }, 500);
  }
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=60, stale-while-revalidate=300',
    },
  });
}
