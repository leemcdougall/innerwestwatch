/**
 * functions/api/items.js
 *
 * Cloudflare Pages Function — GET /api/items
 *
 * Returns agenda items in the same shape as data/items.json, so the
 * front-end can swap between the static JSON fallback and this live endpoint
 * without any transformation code.
 *
 * Query parameters (all optional, combinable):
 *   ?suburb=Marrickville        — case-insensitive suburb filter
 *   ?street=Illawarra+Rd        — case-insensitive street filter (repeatable)
 *
 * When no parameters are supplied, all items are returned.
 *
 * Response shape per item:
 * {
 *   id, meeting, item, type, suburbs[], streets[],
 *   headline, status, meetingDate, minutesDate,
 *   resolution, worksStart, detailPage,
 *   agendaUrl, minutesUrl
 * }
 *
 * minutesDate is the meeting date when minutes_published=1, otherwise null.
 *
 * CORS: Access-Control-Allow-Origin: * so the static pages can call this
 * endpoint cross-origin during local development.
 */

export async function onRequestGet({ request, env }) {
  const url    = new URL(request.url);
  const params = url.searchParams;

  // Collect filter values. street is repeatable (?street=X&street=Y).
  const suburbFilter  = params.get('suburb') || null;
  const streetFilters = params.getAll('street');

  try {
    // ── Build WHERE clause ────────────────────────────────────────────────
    // suburbs and streets are stored as JSON arrays in the topics table,
    // e.g. '["Marrickville","Newtown"]'. LIKE '%"X"%' matches reliably.
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

    const whereSQL = whereClauses.length
      ? `WHERE ${whereClauses.join(' AND ')}`
      : '';

    // ── Base query ────────────────────────────────────────────────────────
    // decisions → topics → meetings
    // agenda_url and minutes_url live directly on meetings in the new schema.
    const baseSQL = `
      SELECT
        d.id                                       AS id,
        d.meeting_id                               AS meeting,
        d.item_number                              AS item,
        t.type                                     AS type,
        t.headline                                 AS headline,
        t.status                                   AS status,
        m.date                                     AS meetingDate,
        CASE WHEN m.minutes_published = 1
             THEN m.date ELSE NULL END             AS minutesDate,
        d.resolution                               AS resolution,
        d.works_start                              AS worksStart,
        t.suburbs                                  AS suburbs_json,
        t.streets                                  AS streets_json,
        m.agenda_url                               AS agendaUrl,
        m.minutes_url                              AS minutesUrl
      FROM decisions d
      JOIN topics   t ON t.id = d.topic_id
      JOIN meetings m ON m.id = d.meeting_id
      ${whereSQL}
      ORDER BY m.date DESC, d.item_number
    `;

    const { results } = await env.DB.prepare(baseSQL).bind(...bindParams).all();

    // ── Shape results to match items.json ─────────────────────────────────
    const items = results.map(row => ({
      id:          row.id,
      meeting:     row.meeting,
      item:        row.item,
      type:        row.type,
      suburbs:     JSON.parse(row.suburbs_json || '[]'),
      streets:     JSON.parse(row.streets_json || '[]'),
      headline:    row.headline,
      status:      row.status,
      meetingDate: row.meetingDate,
      minutesDate: row.minutesDate,
      resolution:  row.resolution,
      worksStart:  row.worksStart,
      detailPage:  null,
      agendaUrl:   row.agendaUrl,
      minutesUrl:  row.minutesUrl,
    }));

    return new Response(JSON.stringify(items), {
      status: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        // Cache for 60 seconds on Cloudflare's edge; stale-while-revalidate
        // means browsers keep using the cached response while a fresh one loads.
        'Cache-Control':               'public, max-age=60, stale-while-revalidate=300',
      },
    });

  } catch (err) {
    // Surface the error in the response body so it is visible in the network tab.
    // In production the static fallback in index.html will silently take over.
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
