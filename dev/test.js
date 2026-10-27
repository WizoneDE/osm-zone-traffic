// Tests for the rules, the tag text and the geography in ../content.js: node dev/test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// The generated data comes first, as in the manifest.
require('../generated/signs.js');
require('../generated/regions.js');
const api = require('../content.js');
// settings.js is a plain browser script (its names are globals there); run it and pick them up.
const tables = vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8')}
;({ OZT_ROAD_CLASSES, OZT_COUNTRIES, OZT_DEFAULTS, oztCleanSettings, oztTables })`, {});
api.setTables(tables.oztTables());
api.setLang('de');
let fail = 0;
const eq = (name, got, want) => { const a = JSON.stringify(got), b = JSON.stringify(want); if (a !== b) { fail++; console.log('FAIL', name, '\n   got ', a, '\n   want', b); } };

const ROADS = new Set(tables.OZT_DEFAULTS.roads);
const place = (country, extra = {}) => ({ country, countries: country ? [country] : [], sides: null, regions: [], partial: false, ...extra });
const ctx = (country, extra = {}) => ({ place: place(country, extra.place), roads: ROADS, neighbours: { start: [], end: [] }, signs: [], ...extra, ...(extra.place ? { place: place(country, extra.place) } : {}) });
const E = (tags, country = 'DE', extra = {}) => api.evaluate({ highway: 'residential', ...tags }, ctx(country, extra));
const S = (tags, country, extra) => { const r = E(tags, country, extra); return [r.status, r.suggestion ? r.suggestion.value : '', r.problems.map((p) => p.code).join(','), r.blocked.map((p) => p.code).join(',')]; };

// Straßenklassen
eq('Fußweg ausgeschlossen', E({ highway: 'footway' }).status, 'excluded');
eq('service standardmäßig aus', E({ highway: 'service' }).status, 'excluded');
eq('track aus', E({ highway: 'track' }).status, 'excluded');
eq('Fußgängerzone-Fläche', E({ highway: 'pedestrian', area: 'yes' }).status, 'excluded');
eq('ohne Land', E({}, '').status, 'outside');
eq('außerhalb Europas', E({}, 'US').status, 'outside');

// Deutschland
eq('DE:urban ok', S({ 'zone:traffic': 'DE:urban' }), ['ok', '', '', '']);
eq('DE:rural ok', S({ 'zone:traffic': 'DE:rural' }), ['ok', '', '', '']);
eq('fehlt ohne Hinweis', S({}), ['missing', '', '', '']);
eq('Autobahn DE:motorway ok', S({ highway: 'motorway', 'zone:traffic': 'DE:motorway' }), ['ok', '', '', '']);
eq('Autobahn fehlt → Vorschlag', S({ highway: 'motorway' }), ['missing', 'DE:motorway', '', '']);
eq('Autobahn mit DE:rural', S({ highway: 'motorway', 'zone:traffic': 'DE:rural' }), ['review', 'DE:motorway', 'wrongKind', '']);
eq('Anschluss DE:motorway ok', S({ highway: 'motorway_link', 'zone:traffic': 'DE:motorway' }), ['ok', '', '', '']);
eq('Anschluss DE:urban ungewöhnlich', S({ highway: 'motorway_link', 'zone:traffic': 'DE:urban' }), ['unusual', '', '', '']);
eq('Anschluss DE:rural Hinweis', E({ highway: 'motorway_link', 'zone:traffic': 'DE:rural' }).notes.map((n) => n.code), ['beta', 'linkZone']);
eq('Anschluss mit Widerspruch bleibt gelb', S({ highway: 'motorway_link', 'zone:traffic': 'DE:urban', urban: 'no' }), ['review', '', 'conflictUrban', 'conflictUrban']);
eq('Anschluss NL:rural normal, NL:urban ungewöhnlich', [S({ highway: 'motorway_link', 'zone:traffic': 'NL:rural' }, 'NL')[0], S({ highway: 'motorway_link', 'zone:traffic': 'NL:urban' }, 'NL')[0]], ['ok', 'unusual']);
eq('Anschluss: urban/rural passen in der Auswahl', E({ highway: 'motorway_link' }).options.map((o) => `${o.value}${o.fits ? '' : '!'}`), ['DE:motorway', 'DE:urban', 'DE:rural']);
eq('DE:motorway an primary', S({ highway: 'primary', 'zone:traffic': 'DE:motorway' }), ['review', '', 'wrongKind', '']);
eq('Schreibfehler De:urban', S({ 'zone:traffic': 'De:urban' }), ['review', 'DE:urban', 'malformed', '']);
eq('Schreibfehler DE.rural', S({ 'zone:traffic': 'DE.rural' }), ['review', 'DE:rural', 'malformed', '']);
eq('Schreibfehler DEurban', S({ 'zone:traffic': 'DEurban' }), ['review', 'DE:urban', 'malformed', '']);
eq('DE:zone30 ist kein Zonenwert', S({ 'zone:traffic': 'DE:zone30' }), ['review', '', 'speedValue', 'speedValue']);
eq('anderes Land', S({ 'zone:traffic': 'NL:urban' }), ['review', '', 'otherCountry', 'otherCountry']);
eq('unbekannt', S({ 'zone:traffic': 'yes' }), ['review', '', 'unknownValue', 'unknownValue']);

// Hinweise und Vorschläge
eq('source:maxspeed', S({ 'source:maxspeed': 'DE:urban' }), ['missing', 'DE:urban', '', '']);
eq('maxspeed:type', S({ 'maxspeed:type': 'DE:rural' }), ['missing', 'DE:rural', '', '']);
eq('maxspeed=DE:urban', S({ maxspeed: 'DE:urban' }), ['missing', 'DE:urban', '', '']);
eq('fremder Code zählt nicht', S({ 'source:maxspeed': 'AT:urban' }), ['missing', '', '', '']);
eq('urban=yes', S({ urban: 'yes' }), ['missing', 'DE:urban', '', '']);
eq('urban=no', S({ urban: 'no' }), ['missing', 'DE:rural', '', '']);
eq('starke Hinweise widersprechen sich → kein Vorschlag', S({ urban: 'yes', 'source:maxspeed': 'DE:rural' }), ['missing', '', '', '']);
eq('maxspeed=50 ist kein Hinweis', S({ maxspeed: '50' }), ['missing', '', '', '']);
eq('Widerspruch source:maxspeed', S({ 'zone:traffic': 'DE:urban', 'source:maxspeed': 'DE:rural' }), ['review', 'DE:rural', 'conflictTag', 'conflictTag']);
eq('Widerspruch urban=no', S({ 'zone:traffic': 'DE:urban', urban: 'no' }), ['review', 'DE:rural', 'conflictUrban', 'conflictUrban']);
eq('passender urban-Tag ok', S({ 'zone:traffic': 'DE:urban', urban: 'yes' }), ['ok', '', '', '']);
eq('Lücke zwischen zwei urban', S({}, 'DE', { neighbours: { start: ['DE:urban'], end: ['DE:urban'] } }), ['missing', 'DE:urban', '', '']);
eq('Nachbar nur an einem Ende', S({}, 'DE', { neighbours: { start: ['DE:rural'], end: [] } }), ['missing', 'DE:rural', '', '']);
eq('Übergang urban/rural: Hinweis', E({}, 'DE', { neighbours: { start: ['DE:urban'], end: ['DE:rural'] } }).notes.map((n) => n.code), ['beta', 'transition']);

// Verkehrsberuhigter Bereich
eq('living_street fehlt: schwacher Vorschlag', S({ highway: 'living_street' }), ['missing', 'DE:urban', '', '']);
eq('living_street Hinweis', E({ highway: 'living_street' }).notes.map((n) => n.code), ['beta', 'livingMissing']);
eq('living_street urban ok', S({ highway: 'living_street', 'zone:traffic': 'DE:urban' }), ['ok', '', '', '']);
eq('living_street rural auffällig', S({ highway: 'living_street', 'zone:traffic': 'DE:rural' }), ['review', 'DE:urban', 'livingRural', '']);
eq('living_street=yes Hinweis', S({ living_street: 'yes' }), ['missing', 'DE:urban', '', '']);

// Ortstafeln
const sign = (position, type, direction, s = 'city_limit') => ({ position, type, direction, node: 'n1', sign: s });
eq('Ortstafel am Anfang vorwärts → innerorts', S({}, 'DE', { signs: [sign('start', 'entry', 'forward')] }), ['missing', 'DE:urban', '', '']);
eq('Ortstafel am Anfang rückwärts → außerorts', S({}, 'DE', { signs: [sign('start', 'entry', 'backward')] }), ['missing', 'DE:rural', '', '']);
eq('Ortstafel am Ende vorwärts → außerorts', S({}, 'DE', { signs: [sign('end', 'entry', 'forward')] }), ['missing', 'DE:rural', '', '']);
eq('Ortstafel am Ende rückwärts → innerorts', S({}, 'DE', { signs: [sign('end', 'entry', 'backward')] }), ['missing', 'DE:urban', '', '']);
eq('Ortsende (311) am Anfang vorwärts → außerorts', S({}, 'DE', { signs: [sign('start', 'exit', 'forward', 'DE:311')] }), ['missing', 'DE:rural', '', '']);
eq('Ortstafel mitten im Way', S({}, 'DE', { signs: [sign('inside', 'entry', 'forward')] }), ['missing', '', 'signInside', 'signInside']);
eq('Ortstafel ohne Richtung', E({}, 'DE', { signs: [sign('start', 'entry', '')] }).notes.map((n) => n.code), ['beta', 'signNoDirection']);
eq('Widerspruch zur Ortstafel', S({ 'zone:traffic': 'DE:rural' }, 'DE', { signs: [sign('start', 'entry', 'forward')] }), ['review', 'DE:urban', 'conflictSign', 'conflictSign']);
eq('townSignsOf direction', api.townSignsOf({ traffic_sign: 'city_limit', direction: 'forward' }), [{ type: 'entry', direction: 'forward', sign: 'city_limit' }]);
eq('townSignsOf :backward', api.townSignsOf({ 'traffic_sign:backward': 'DE:311' }), [{ type: 'exit', direction: 'backward', sign: 'DE:311' }]);
eq('townSignsOf Liste', api.townSignsOf({ traffic_sign: 'DE:310;DE:274[50]' }).map((s) => s.sign), ['DE:310']);
eq('signsAlong Positionen', api.signsAlong(['n1', 'n2', 'n3'], (id) => (id === 'n3' ? { traffic_sign: 'city_limit', direction: 'backward' } : undefined)).map((s) => s.position), ['end']);

// Richtungen, Seiten, Grenzen
eq('forward → manuell', S({ 'zone:traffic:forward': 'DE:urban' }), ['review', '', 'directional', 'directional']);
eq('left/right gleiche Land ok', S({ 'zone:traffic:left': 'DE:urban', 'zone:traffic:right': 'DE:rural' }), ['ok', '', '', 'sides']);
eq('left/right an Grenze', S({ 'zone:traffic:left': 'DE:rural', 'zone:traffic:right': 'NL:rural' }, 'DE', { place: { country: '', countries: ['DE', 'NL'], sides: { left: 'DE', right: 'NL' } } }), ['ok', '', '', 'sides']);
eq('left/right falsch herum', S({ 'zone:traffic:left': 'NL:rural', 'zone:traffic:right': 'DE:rural' }, 'DE', { place: { country: '', countries: ['DE', 'NL'], sides: { left: 'DE', right: 'NL' } } }), ['review', '', 'sideValue,sideValue', 'sides']);
eq('Grenzstraße ohne Tag', S({}, 'DE', { place: { country: '', countries: ['DE', 'NL'], sides: { left: 'DE', right: 'NL' } } }), ['missing', '', '', 'borderRoad']);
eq('Grenzstraße mit zone:traffic', S({ 'zone:traffic': 'DE:rural' }, 'DE', { place: { country: '', countries: ['DE', 'NL'], sides: { left: 'DE', right: 'NL' } } }), ['review', '', 'borderRoad', 'borderRoad']);
eq('grenzüberschreitend', S({ 'zone:traffic': 'DE:rural' }, 'DE', { place: { country: '', countries: ['DE', 'NL'] } }), ['review', '', 'crossBorder', 'crossBorder']);
eq('grenzüberschreitend ohne Tag', S({}, 'DE', { place: { country: '', countries: ['DE', 'NL'] } }), ['missing', '', '', 'crossBorder']);
eq('nur teilweise sichtbar', S({}, 'DE', { place: { partial: true } }), ['missing', '', '', 'partial']);

// Niederlande: Autobahnen sind NL:rural
eq('NL urban', S({ 'zone:traffic': 'NL:urban' }, 'NL'), ['ok', '', '', '']);
eq('NL Autobahn fehlt → NL:rural', S({ highway: 'motorway' }, 'NL'), ['missing', 'NL:rural', '', '']);
eq('NL Autobahn NL:rural ok', S({ highway: 'motorway', 'zone:traffic': 'NL:rural' }, 'NL'), ['ok', '', '', '']);
eq('NL:motorway gibt es nicht', S({ highway: 'motorway', 'zone:traffic': 'NL:motorway' }, 'NL'), ['review', 'NL:rural', 'unknownValue', 'unknownValue']);

// Belgien: Regionen
const be = (region, tags, extra = {}) => S(tags, 'BE', { place: { regions: region ? [region] : [] }, ...extra });
eq('BE-VLG:urban in Flandern', be('BE-VLG', { 'zone:traffic': 'BE-VLG:urban' }), ['ok', '', '', '']);
eq('BE-WAL:urban in Flandern', be('BE-VLG', { 'zone:traffic': 'BE-WAL:urban' }), ['review', '', 'regionMismatch', 'regionMismatch']);
eq('BE:urban statt Region', be('BE-WAL', { 'zone:traffic': 'BE:urban' }), ['review', '', 'nationalForRegion', '']);
eq('BE Autobahn BE:motorway', be('BE-VLG', { highway: 'motorway', 'zone:traffic': 'BE:motorway' }), ['ok', '', '', '']);
eq('BE Region uneindeutig', S({ 'zone:traffic': 'BE-VLG:rural' }, 'BE', { place: { regions: ['BE-VLG', 'BE-BRU'] } }), ['ok', '', '', 'regionAmbiguous']);
eq('BE ist Prototyp', E({ 'zone:traffic': 'BE-VLG:urban' }, 'BE', { place: { regions: ['BE-VLG'] } }).notes.map((n) => n.code), ['prototype']);

// Polen: Schnellstraße
eq('PL expressway', S({ highway: 'trunk', motorroad: 'yes', 'zone:traffic': 'PL:expressway' }, 'PL'), ['ok', '', '', '']);
eq('PL expressway fehlt', S({ highway: 'trunk', expressway: 'yes' }, 'PL'), ['missing', 'PL:expressway', '', '']);
eq('PL:expressway ohne motorroad', S({ highway: 'trunk', 'zone:traffic': 'PL:expressway' }, 'PL'), ['review', '', 'wrongKind', '']);

// Nicht verifizierte Länder
eq('AT urban (not verified)', S({ 'zone:traffic': 'AT:urban' }, 'AT'), ['ok', '', '', '']);
eq('AT Hinweis', E({}, 'AT').notes.map((n) => n.code), ['unverified', 'prototype']);
eq('AT Autobahn AT:motorway oder AT:rural', [S({ highway: 'motorway', 'zone:traffic': 'AT:motorway' }, 'AT')[0], S({ highway: 'motorway', 'zone:traffic': 'AT:rural' }, 'AT')[0]], ['ok', 'ok']);
eq('Editor nur DE und NL', ['DE', 'NL', 'BE', 'FR', 'LU', 'PL', 'AT'].map((c) => api.rulesFor(c, ['BE-VLG']).editor), [true, true, false, false, false, false, false]);

// Angebotene Werte
eq('Optionen residential DE', E({}).options.map((o) => `${o.value}${o.fits ? '' : '!'}`), ['DE:urban', 'DE:rural', 'DE:motorway!']);
eq('Optionen Autobahn NL', E({ highway: 'motorway' }, 'NL').options.map((o) => `${o.value}${o.fits ? '' : '!'}`), ['NL:rural', 'NL:urban!']);

// Texte
eq('Meldungstext', api.messageText({ code: 'crossBorder', list: 'DE, NL' }), 'Way überquert eine Grenze (DE, NL) – in iD an der Grenze teilen');

// Tag-Textbox
eq('anhängen', api.setInTagText('highway=residential\nname=Hauptstraße\nmaxspeed=50\n', 'zone:traffic', 'DE:urban'),
  { text: 'highway=residential\nname=Hauptstraße\nmaxspeed=50\nzone:traffic=DE:urban', changed: true, old: '' });
eq('ersetzen', api.setInTagText('highway=residential\nname=Hauptstraße\nzone:traffic=DE:rural', 'zone:traffic', 'DE:urban'),
  { text: 'highway=residential\nname=Hauptstraße\nzone:traffic=DE:urban', changed: true, old: 'DE:rural' });
eq('unverändert', api.setInTagText('zone:traffic=DE:urban', 'zone:traffic', 'DE:urban').changed, false);
eq('doppelt', api.setInTagText('zone:traffic=DE:urban\nzone:traffic=DE:rural', 'zone:traffic', 'DE:urban'), { error: 'duplicate' });
eq('ähnlicher Schlüssel bleibt', api.setInTagText('zone:traffic:left=DE:urban', 'zone:traffic', 'DE:urban').text, 'zone:traffic:left=DE:urban\nzone:traffic=DE:urban');
eq('andere Zeilen exakt gleich', api.setInTagText('name="A \\"B\\""\nzone:traffic=x', 'zone:traffic', 'DE:urban').text, 'name="A \\"B\\""\nzone:traffic=DE:urban');
eq('leer', api.setInTagText('', 'zone:traffic', 'DE:urban').text, 'zone:traffic=DE:urban');
eq('parse wie iD', api.parseTagText('name="A \\"B\\""\nhighway=residential\n'), { name: 'A "B"', highway: 'residential' });

// Geografie
const strip = (country) => (lon) => (lon < 6 ? 'NL' : country);
eq('quer zur Grenze', api.locateAlong([[5.9, 51], [6.0, 51], [6.1, 51]], strip('DE'), 25), { codes: ['NL', 'DE'], sides: null });
const north = (lon, lat) => (lat > 51 ? 'NL' : 'DE');
eq('entlang der Grenze', api.locateAlong([[5.9, 51], [6.0, 51], [6.1, 51]], north, 25), { codes: ['DE', 'NL'], sides: { left: 'NL', right: 'DE' } });
eq('Regionen: Brüssel', api.regionAt(4.3517, 50.8466), 'BE-BRU');
eq('Regionen: Gent', api.regionAt(3.7174, 51.0543), 'BE-VLG');
eq('Regionen: Namur', api.regionAt(4.8719, 50.4674), 'BE-WAL');
eq('Regionen: Voeren (Exklave)', api.regionAt(5.7928, 50.7565), 'BE-VLG');
eq('Regionen: Antwerpen', api.regionAt(4.4025, 51.2194), 'BE-VLG');
eq('Regionen: Lüttich', api.regionAt(5.5797, 50.6326), 'BE-WAL');

// Einstellungen
eq('Editor standardmäßig aus', tables.oztCleanSettings({}).editor, false);
eq('unbekannte Klassen fallen weg', tables.oztCleanSettings({ roads: ['primary', 'footway', 3] }).roads, ['primary']);
eq('Zeichen vorhanden', ['DE-330.1', 'NL-G1', 'BE-F5', 'PL-D-9', 'PL-D-7', 'neutral-urban', 'neutral-rural', 'neutral-motorway', 'neutral-expressway'].filter((k) => !api.SIGN_ART[k]), []);
for (const [code, c] of Object.entries(tables.OZT_COUNTRIES)) {
  for (const key of Object.values(c.signs)) if (!api.SIGN_ART[key]) { fail++; console.log('FAIL Zeichen fehlt', code, key); }
}

console.log(fail ? `${fail} Fehler` : 'alle Tests bestanden');
process.exit(fail ? 1 : 0);
