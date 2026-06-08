-- Committee
INSERT OR IGNORE INTO committees (id, name) VALUES ('ltf', 'Local Transport Forum');

-- Meeting
INSERT OR IGNORE INTO meetings (id, committee_id, date, minutes_published)
  VALUES ('ltf-18may2026', 'ltf', '2026-05-18', 1);

-- Documents (agenda + minutes for meeting 4285)
INSERT OR IGNORE INTO documents (id, meeting_id, type, url) VALUES
  ('doc-agn-4285',  'ltf-18may2026', 'agenda-html',  'https://innerwest.infocouncil.biz/Open/2026/05/LTF_18052026_AGN_4285_AT.HTM'),
  ('doc-min-4285', 'ltf-18may2026', 'minutes-html', 'https://innerwest.infocouncil.biz/Open/2026/05/LTF_18052026_MIN_4285.HTM');

-- Topics, agenda items, suburbs, streets, and document links
INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-01', 'crossing', 'New raised crossing and roundabout — Darling St at Curtis Rd', 'forum-yes', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-01', 'Balmain');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-01', 'Darling St');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-01', 'Curtis Rd');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-01', 'ltf-18may2026', 'topic-ltf-18may2026-01', 1, 'Approved — raised pedestrian crossing and roundabout reconstruction at Darling St/Curtis Rd to proceed, with construction coordinated with bus operator Transit Systems.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-01', 'doc-agn-4285'),
  ('ltf-18may2026-01', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-02', 'parking', 'No parking zone extended — Nelson Lane', 'forum-yes', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-02', 'Annandale');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-02', 'Nelson Lane');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-02', 'ltf-18may2026', 'topic-ltf-18may2026-02', 2, 'Approved — No Parking zone extended opposite the rear boundary of 265 Nelson St.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-02', 'doc-agn-4285'),
  ('ltf-18may2026-02', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-03', 'latm', 'Kerb blister going in — Warburton St', 'forum-amended', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-03', 'Marrickville');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-03', 'Warburton St');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-03', 'ltf-18may2026', 'topic-ltf-18may2026-03', 3, 'Approved in principle — kerb blister to proceed to detailed design including community engagement and consideration of barrier protection, then return to Forum before construction.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-03', 'doc-agn-4285'),
  ('ltf-18may2026-03', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-04', 'latm', 'Road closures for traffic calming works — Tempe South (Bunnings LATM)', 'forum-yes', '/meetings/ltf-18may2026/tempe-south/');
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-04', 'Tempe');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-04', 'Edwin St');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-04', 'Tramway St');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-04', 'Wentworth St');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-04', 'Holbeach Ave');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-04', 'ltf-18may2026', 'topic-ltf-18may2026-04', 4, 'Approved — temporary road closures across Tempe South streets and No Stopping restrictions on Wentworth St confirmed for 6 July to 5 August 2026, with contingency periods allowed.', '2026-07-06');
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-04', 'doc-agn-4285'),
  ('ltf-18may2026-04', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-05', 'event', 'Temporary road closures — Beer, Footy and Food Festival', 'forum-yes', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-05', 'Marrickville');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-05', 'Centennial St');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-05', 'Woodland St');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-05', 'Holmesdale St');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-05', 'ltf-18may2026', 'topic-ltf-18may2026-05', 5, 'Approved — full road closures on Centennial St, Woodland St, and Holmesdale St on 18 July 2026 from 10am to 9pm for the Henson Park Beer, Footy and Food Festival.', '2026-07-18');
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-05', 'doc-agn-4285'),
  ('ltf-18may2026-05', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-06', 'crossing', 'New raised crossing — Illawarra Rd at Wharf St', 'forum-yes', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-06', 'Marrickville');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-06', 'Illawarra Rd');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-06', 'Wharf St');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-06', 'ltf-18may2026', 'topic-ltf-18may2026-06', 6, 'Approved — raised pedestrian crossing at Illawarra Rd/Wharf St to proceed with associated signage and line markings.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-06', 'doc-agn-4285'),
  ('ltf-18may2026-06', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-07', 'crossing', 'New raised crossing — Illawarra Rd at Grove St', 'forum-yes', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-07', 'Marrickville');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-07', 'Illawarra Rd');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-07', 'Grove St');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-07', 'ltf-18may2026', 'topic-ltf-18may2026-07', 7, 'Approved — raised pedestrian crossing at Illawarra Rd/Grove St to proceed with associated signage and line markings.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-07', 'doc-agn-4285'),
  ('ltf-18may2026-07', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-08', 'parking', 'No stopping zone extended — Smidmore St at Edinburgh Rd', 'forum-yes', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-08', 'Marrickville');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-08', 'Smidmore St');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-08', 'Edinburgh Rd');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-08', 'ltf-18may2026', 'topic-ltf-18may2026-08', 8, 'Approved — No Stopping zone extended 17m northward on Smidmore St, with two 10-minute parking spaces installed in the area.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-08', 'doc-agn-4285'),
  ('ltf-18may2026-08', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-09', 'latm', 'Kerb extensions — Nowranie St at Smith St', 'forum-amended', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-09', 'Summer Hill');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-09', 'Nowranie St');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-09', 'Smith St');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-09', 'ltf-18may2026', 'topic-ltf-18may2026-09', 9, 'Approved in principle — kerb extensions and blister islands at Nowranie St/Smith St to proceed to detailed design including community engagement, then return to Forum before construction.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-09', 'doc-agn-4285'),
  ('ltf-18may2026-09', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-10', 'crossing', 'New raised crossing and kerb extensions — Hardy St at Mount St', 'forum-amended', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-10', 'Ashbury');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-10', 'Hardy St');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-10', 'Mount St');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-10', 'ltf-18may2026', 'topic-ltf-18may2026-10', 10, 'Approved in principle — raised pedestrian crossing with kerb extensions at Hardy St/Mount St to proceed to detailed design including community engagement, then return to Forum before construction.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-10', 'doc-agn-4285'),
  ('ltf-18may2026-10', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-11', 'crossing', 'New raised crossing — Allen St', 'forum-yes', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-11', 'Leichhardt');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-11', 'Allen St');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-11', 'ltf-18may2026', 'topic-ltf-18may2026-11', 11, 'Approved — raised pedestrian crossing on Allen St to proceed, including relocation of existing No Stopping and Bus Zone signs.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-11', 'doc-agn-4285'),
  ('ltf-18may2026-11', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-12', 'speed', 'Speed limit dropping from 50 to 40 km/h — Rozelle, Lilyfield, Ashfield, Haberfield', 'forum-yes', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-12', 'Rozelle');
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-12', 'Lilyfield');
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-12', 'Ashfield');
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-12', 'Haberfield');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-12', 'ltf-18may2026', 'topic-ltf-18may2026-12', 12, 'Approved — signage and line marking plans for 50 to 40 km/h speed limit reductions in Haberfield, Rozelle, Lilyfield, and Ashfield North to proceed.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-12', 'doc-agn-4285'),
  ('ltf-18may2026-12', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-13', 'parking', 'New kerbside EV charging spaces — various locations across Inner West', 'forum-yes', NULL);
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-13', 'ltf-18may2026', 'topic-ltf-18may2026-13', 13, 'Approved — EV kerbside charging sites supported and to be signed as No Parking 8am–10pm except for electric vehicles actively charging.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-13', 'doc-agn-4285'),
  ('ltf-18may2026-13', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-14', 'parking', 'Resident parking scheme proposed — Mackey Park area', 'forum-amended', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-14', 'Marrickville');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-14', 'ltf-18may2026', 'topic-ltf-18may2026-14', 14, 'Approved with amendments — 2P restrictions approved on Renwick St, Ruby St (with a 12-month review), Warren Rd, Carrington Rd, and Richardson''s Crescent; Junction St restrictions not supported.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-14', 'doc-agn-4285'),
  ('ltf-18may2026-14', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-15', 'parking', 'New angled parking — Schwebel St', 'forum-yes', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-15', 'Marrickville');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-15', 'Schwebel St');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-15', 'ltf-18may2026', 'topic-ltf-18may2026-15', 15, 'Approved — 45-degree angled parking to be installed on the northern side of Schwebel St between Station St and Leofrene Ave.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-15', 'doc-agn-4285'),
  ('ltf-18may2026-15', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-16', 'parking', 'No parking restriction — Little Brighton St', 'forum-yes', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-16', 'Petersham');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-16', 'Little Brighton St');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-16', 'ltf-18may2026', 'topic-ltf-18may2026-16', 16, 'Approved — 10.5m No Parking zone to be installed west of the driveway at 40 Station St (extended from the originally proposed 8.5m).', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-16', 'doc-agn-4285'),
  ('ltf-18may2026-16', 'doc-min-4285');

INSERT OR IGNORE INTO topics (id, type, headline, status, detail_page) VALUES
  ('topic-ltf-18may2026-17', 'parking', 'Resident parking scheme proposed — Lords Rd and Davies St', 'forum-yes', NULL);
INSERT OR IGNORE INTO topic_suburbs (topic_id, suburb) VALUES ('topic-ltf-18may2026-17', 'Leichhardt');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-17', 'Lords Rd');
INSERT OR IGNORE INTO topic_streets (topic_id, street) VALUES ('topic-ltf-18may2026-17', 'Davies St');
INSERT OR IGNORE INTO agenda_items (id, meeting_id, topic_id, item_number, resolution, works_start) VALUES
  ('ltf-18may2026-17', 'ltf-18may2026', 'topic-ltf-18may2026-17', 17, 'Approved — 2P permit parking restrictions (8am–6pm Mon–Fri, permit holders excepted, Area L1) to be installed on both sides of Davies St and on northern Lords Rd.', NULL);
INSERT OR IGNORE INTO agenda_item_documents (agenda_item_id, document_id) VALUES
  ('ltf-18may2026-17', 'doc-agn-4285'),
  ('ltf-18may2026-17', 'doc-min-4285');
