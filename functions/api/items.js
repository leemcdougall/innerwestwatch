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
    // ── Base query ────────────────────────────────────────────────────────
    // Join agenda_items → topics → meetings to assemble the core row.
    // We also pull the agenda and minutes URLs from the documents table via
    // agenda_item_documents. The agenda doc is type='agenda-html' and the
    // minutes doc is type='minutes-html'.
    //
    // Minutes URL is included regardless of minutes_published; the caller
    // decides whether to expose it (we reflect minutes_published as
    // minutesDate: non-null when published, null when not).
    //
    // Suburb / street filters are applied below via CTEs so the GROUP_CONCAT
    // aggregates still include all suburbs/streets for the matched item.
    let baseSQL = `
      WITH matched_topics AS (
        -- Step 1: identify which topic_ids match the suburb/street filters.
        -- If no filters are given, all topics match.
        SELECT DISTINCT t.id AS topic_id
        FROM topics t
        ${suburbFilter ? `
          JOIN topic_suburbs ts ON ts.topic_id = t.id
            AND LOWER(ts.suburb) = LOWER(?)
        ` : ''}
        ${streetFilters.length > 0 ? `
          JOIN topic_streets tst ON tst.topic_id = t.id
            AND LOWER(tst.street) IN (${streetFilters.map(() => 'LOWER(?)').join(', ')})
        ` : ''}
      )
      SELECT
        ai.id                                    AS id,
        ai.meeting_id                            AS meeting,
        ai.item_number                           AS item,
        t.type                                   AS type,
        t.headline                               AS headline,
        t.status                                 AS status,
        t.detail_page                            AS detailPage,
        m.date                                   AS meetingDate,
        CASE WHEN m.minutes_published = 1
             THEN m.date ELSE NULL END           AS minutesDate,
        ai.resolution                            AS resolution,
        ai.works_start                           AS worksStart,
        -- Aggregate all suburbs for this topic into a JSON-like comma list
        (SELECT GROUP_CONCAT(suburb, '||')
           FROM topic_suburbs
          WHERE topic_id = t.id)                 AS suburbs_raw,
        -- Aggregate all streets for this topic
        (SELECT GROUP_CONCAT(street, '||')
           FROM topic_streets
          WHERE topic_id = t.id)                 AS streets_raw,
        -- Agenda URL: the agenda-html document linked to this item
        (SELECT d.url FROM documents d
           JOIN agenda_item_documents aid
             ON aid.document_id = d.id
          WHERE aid.agenda_item_id = ai.id
            AND d.type = 'agenda-html'
          LIMIT 1)                               AS agendaUrl,
        -- Minutes URL: the minutes-html document linked to this item
        (SELECT d.url FROM documents d
           JOIN agenda_item_documents aid
             ON aid.document_id = d.id
          WHERE aid.agenda_item_id = ai.id
            AND d.type = 'minutes-html'
          LIMIT 1)                               AS minutesUrl
      FROM agenda_items ai
      JOIN topics t   ON t.id  = ai.topic_id
      JOIN meetings m ON m.id  = ai.meeting_id
      JOIN matched_topics mt ON mt.topic_id = t.id
      ORDER BY ai.item_number
    `;

    // Build the parameter array in the order the placeholders appear.
    // The CTE uses suburb first (if present), then each street.
    const bindParams = [];
    if (suburbFilter)          bindParams.push(suburbFilter);
    if (streetFilters.length)  bindParams.push(...streetFilters);

    const { results } = await env.DB.prepare(baseSQL).bind(...bindParams).all();

    // ── Shape results to match items.json ─────────────────────────────────
    const items = results.map(row => ({
      id:          row.id,
      meeting:     row.meeting,
      item:        row.item,
      type:        row.type,
      // GROUP_CONCAT used "||" as delimiter to avoid clashing with street commas.
      // Split and filter out empties (GROUP_CONCAT returns null when no rows).
      suburbs:     row.suburbs_raw ? row.suburbs_raw.split('||').filter(Boolean) : [],
      streets:     row.streets_raw ? row.streets_raw.split('||').filter(Boolean) : [],
      headline:    row.headline,
      status:      row.status,
      meetingDate: row.meetingDate,
      minutesDate: row.minutesDate,
      resolution:  row.resolution,
      worksStart:  row.worksStart,
      detailPage:  row.detailPage,
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
