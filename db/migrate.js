#!/usr/bin/env node
/**
 * db/migrate.js
 *
 * Reads data/items.json and writes db/seed.sql.
 *
 * What it creates:
 *   1. One Committee row: id="ltf", name="Local Transport Forum"
 *   2. One Meeting row:   id="ltf-18may2026", date="2026-05-18", minutes_published=1
 *   3. Two Document rows: the agenda HTML and the minutes HTML for meeting 4285
 *   4. Per item in items.json:
 *        - One Topic row       (id = "topic-" + item.id)
 *        - topic_suburbs rows  (one per suburb)
 *        - topic_streets rows  (one per street)
 *        - One AgendaItem row  (id = item.id)
 *        - agenda_item_documents rows linking the item to both docs
 *
 * All inserts use INSERT OR IGNORE so the script is safe to re-run
 * without creating duplicates.
 */

const fs   = require('fs');
const path = require('path');

// ── paths ──────────────────────────────────────────────────────────────────
const ITEMS_PATH = path.join(__dirname, '..', 'data', 'items.json');
const OUTPUT     = path.join(__dirname, 'seed.sql');

// ── load source data ───────────────────────────────────────────────────────
const items = JSON.parse(fs.readFileSync(ITEMS_PATH, 'utf8'));

// ── helpers ────────────────────────────────────────────────────────────────

// Escape a string for SQL: wrap in single quotes, escape internal quotes.
function sq(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

// Build a line of SQL and append a newline.
const lines = [];
function emit(sql) { lines.push(sql); }

// ── static fixtures ────────────────────────────────────────────────────────

// Committee: the LTF is the only committee in the initial seed.
emit(`-- Committee`);
emit(`INSERT OR IGNORE INTO committees (id, name) VALUES ('ltf', 'Local Transport Forum');`);
emit('');

// Meeting: 18 May 2026 LTF. minutes_published=1 because minutes are out.
emit(`-- Meeting`);
emit(`INSERT OR IGNORE INTO meetings (id, committee_id, date, minutes_published)`);
emit(`  VALUES ('ltf-18may2026', 'ltf', '2026-05-18', 1);`);
emit('');

// Documents: agenda HTML and minutes HTML for meeting ID 4285.
// These two documents are shared by all 17 agenda items.
const AGENDA_DOC_ID  = 'doc-agn-4285';
const MINUTES_DOC_ID = 'doc-min-4285';
const AGENDA_URL  = 'https://innerwest.infocouncil.biz/Open/2026/05/LTF_18052026_AGN_4285_AT.HTM';
const MINUTES_URL = 'https://innerwest.infocouncil.biz/Open/2026/05/LTF_18052026_MIN_4285.HTM';

emit(`-- Documents (agenda + minutes for meeting 4285)`);
emit(`INSERT OR IGNORE INTO documents (id, meeting_id, type, url) VALUES`);
emit(`  (${sq(AGENDA_DOC_ID)},  'ltf-18may2026', 'agenda-html',  ${sq(AGENDA_URL)}),`);
emit(`  (${sq(MINUTES_DOC_ID)}, 'ltf-18may2026', 'minutes-html', ${sq(MINUTES_URL)});`);
emit('');

// ── per-item rows ──────────────────────────────────────────────────────────
emit(`-- Topics, agenda items, suburbs, streets, and document links`);

for (const item of items) {
  const topicId = 'topic-' + item.id;

  // Topic — the persistent real-world issue
  emit(`INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES`);
  emit(`  (${sq(topicId)}, ${sq(item.type)}, ${sq(item.headline)}, ${sq(item.status)}, ${sq(item.detailPage)});`);

  // Suburbs junction rows (may be empty for some items)
  for (const suburb of item.suburbs) {
    emit(`INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES (${sq(topicId)}, ${sq(suburb)});`);
  }

  // Streets junction rows (may be empty for some items)
  for (const street of item.streets) {
    emit(`INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES (${sq(topicId)}, ${sq(street)});`);
  }

  // AgendaItem — this item's appearance at the 18 May 2026 meeting
  emit(`INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES`);
  emit(`  (${sq(item.id)}, 'ltf-18may2026', ${sq(topicId)}, ${item.item}, ${sq(item.resolution)}, ${sq(item.worksStart)});`);

  // Link this agenda item to both agenda doc and minutes doc
  emit(`INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES`);
  emit(`  (${sq(item.id)}, ${sq(AGENDA_DOC_ID)}),`);
  emit(`  (${sq(item.id)}, ${sq(MINUTES_DOC_ID)});`);

  emit('');
}

// ── write output ───────────────────────────────────────────────────────────
fs.writeFileSync(OUTPUT, lines.join('\n'));
console.log(`Wrote ${lines.length} lines to ${OUTPUT}`);
