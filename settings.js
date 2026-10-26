// @ts-check
/**
 * OSM Traffic Zone Inspector – shared settings and rule tables.
 *
 * Loaded before popup.js (toolbar popup) and before bridge.js (isolated world),
 * which both use these definitions directly.
 *
 * content.js (page world) can NOT use them directly: Chrome does not share
 * top-level variables between scripts injected into the page world. bridge.js
 * therefore sends the cleaned settings and the tables to content.js in its
 * settings message. Keeping the tables here means popup and map never disagree.
 */

/**
 * @typedef {object} Settings
 * @property {boolean} enabled        Colour the roads at all.
 * @property {boolean} icons          Draw the zone icons on the roads.
 * @property {boolean} legend         Show the legend box on the map.
 * @property {boolean} stats          Show the statistics in the legend box.
 * @property {boolean} editor         Editor mode: the icon panel can insert zone:traffic (off by default).
 * @property {string[]} roads         highway=* values that are checked (keys of OZT_ROAD_CLASSES).
 * @property {string[]} hidden        Statuses the user hid on the map: 'ok', 'unusual', 'missing', 'review'.
 * @property {'de'|'en'} lang         Language of popup, legend, tooltips and panel.
 */

/**
 * Road classes that can be checked: [highway value, checked by default, German, English].
 * Footways, paths, cycleways, construction and proposed roads are never checked:
 * they are no regular roads (handover, section 5).
 * @type {ReadonlyArray<readonly [string, boolean, string, string]>}
 */
const OZT_ROAD_CLASSES = [
  ['motorway', true, 'Autobahn', 'Motorway'],
  ['motorway_link', true, 'Autobahn-Anschluss', 'Motorway link'],
  ['trunk', true, 'Schnellstraße', 'Trunk'],
  ['trunk_link', true, 'Schnellstraßen-Anschluss', 'Trunk link'],
  ['primary', true, 'Bundesstraße / primary', 'Primary'],
  ['primary_link', true, 'primary-Anschluss', 'Primary link'],
  ['secondary', true, 'Landesstraße / secondary', 'Secondary'],
  ['secondary_link', true, 'secondary-Anschluss', 'Secondary link'],
  ['tertiary', true, 'Kreisstraße / tertiary', 'Tertiary'],
  ['tertiary_link', true, 'tertiary-Anschluss', 'Tertiary link'],
  ['unclassified', true, 'Gemeindeverbindung / unclassified', 'Unclassified'],
  ['residential', true, 'Wohnstraße / residential', 'Residential'],
  ['living_street', true, 'Verkehrsberuhigter Bereich', 'Living street'],
  ['service', false, 'Erschließungsweg / service', 'Service'],
  ['pedestrian', false, 'Fußgängerzone', 'Pedestrian street'],
  ['track', false, 'Wirtschaftsweg / track', 'Track'],
];

/**
 * Countries and their zone:traffic values.
 *
 * verified: the values are documented in the OSM wiki (Key:zone:traffic). Countries
 * without wiki entry follow the general pattern CC:urban / CC:rural and are shown
 * as "not verified".
 * editor: the editor mode may insert values there (beta). Only DE and NL for now.
 * motorway: values for highway=motorway(_link). A country without a value of its own
 * uses its rural value (NL, FR: motorways lie outside the built-up area by law).
 * Unverified countries accept CC:motorway and CC:rural there.
 * regions: the values name the region instead of the country (BE).
 * signs: keys of the sign artwork for motorway / expressway (official signs where public
 * domain). Urban and rural always use the generic symbols: a town sign with houses and a
 * sign with road and trees (the official town signs carry a place name and were not
 * recognisable at icon size, user feedback 2026-10-26).
 *
 * @typedef {object} CountryRules
 * @property {string} de
 * @property {string} en
 * @property {boolean} verified
 * @property {boolean} editor
 * @property {string[]} motorway
 * @property {string} [expressway]  PL:expressway for roads with motorroad=yes / expressway=yes.
 * @property {Record<string, { de: string, en: string }>} [regions]
 * @property {Record<string, string>} signs  kind → sign key
 */

/** Wiki revision the verified values were checked against. */
const OZT_SOURCE = Object.freeze({
  page: 'https://wiki.openstreetmap.org/wiki/Key:zone:traffic',
  revision: 3108296,
  edited: '2026-10-24',
  checked: '2026-10-26',
});

const OZT_NEUTRAL_SIGNS = Object.freeze({ urban: 'neutral-urban', rural: 'neutral-rural', motorway: 'neutral-motorway', expressway: 'neutral-expressway' });

/** @type {Readonly<Record<string, CountryRules>>} */
const OZT_COUNTRIES = Object.freeze({
  DE: {
    de: 'Deutschland', en: 'Germany', verified: true, editor: true, motorway: ['DE:motorway'],
    signs: { motorway: 'DE-330.1' },
  },
  NL: {
    de: 'Niederlande', en: 'Netherlands', verified: true, editor: true, motorway: ['NL:rural'],
    signs: { motorway: 'NL-G1' },
  },
  BE: {
    de: 'Belgien', en: 'Belgium', verified: true, editor: false, motorway: ['BE:motorway'],
    regions: {
      'BE-VLG': { de: 'Flandern', en: 'Flanders' },
      'BE-WAL': { de: 'Wallonien', en: 'Wallonia' },
      'BE-BRU': { de: 'Brüssel-Hauptstadt', en: 'Brussels-Capital' },
    },
    signs: { motorway: 'BE-F5' },
  },
  FR: { de: 'Frankreich', en: 'France', verified: true, editor: false, motorway: ['FR:rural'], signs: { ...OZT_NEUTRAL_SIGNS } },
  LU: { de: 'Luxemburg', en: 'Luxembourg', verified: true, editor: false, motorway: ['LU:motorway'], signs: { ...OZT_NEUTRAL_SIGNS } },
  PL: {
    de: 'Polen', en: 'Poland', verified: true, editor: false, motorway: ['PL:motorway'], expressway: 'PL:expressway',
    signs: { motorway: 'PL-D-9', expressway: 'PL-D-7' },
  },
});

/**
 * Other European countries: [code, German, English]. No wiki entry (2026-10-26); taginfo
 * shows CC:urban / CC:rural in use for some (AT, CH, FI, HU, GR, NO, CZ).
 * @type {ReadonlyArray<readonly [string, string, string]>}
 */
const OZT_UNVERIFIED = [
  ['AD', 'Andorra', 'Andorra'], ['AL', 'Albanien', 'Albania'], ['AT', 'Österreich', 'Austria'],
  ['BA', 'Bosnien und Herzegowina', 'Bosnia and Herzegovina'], ['BG', 'Bulgarien', 'Bulgaria'],
  ['CH', 'Schweiz', 'Switzerland'], ['CY', 'Zypern', 'Cyprus'], ['CZ', 'Tschechien', 'Czechia'],
  ['DK', 'Dänemark', 'Denmark'], ['EE', 'Estland', 'Estonia'], ['ES', 'Spanien', 'Spain'],
  ['FI', 'Finnland', 'Finland'], ['GB', 'Vereinigtes Königreich', 'United Kingdom'], ['GR', 'Griechenland', 'Greece'],
  ['HR', 'Kroatien', 'Croatia'], ['HU', 'Ungarn', 'Hungary'], ['IE', 'Irland', 'Ireland'], ['IS', 'Island', 'Iceland'],
  ['IT', 'Italien', 'Italy'], ['LI', 'Liechtenstein', 'Liechtenstein'], ['LT', 'Litauen', 'Lithuania'],
  ['LV', 'Lettland', 'Latvia'], ['MC', 'Monaco', 'Monaco'], ['MD', 'Moldau', 'Moldova'], ['ME', 'Montenegro', 'Montenegro'],
  ['MK', 'Nordmazedonien', 'North Macedonia'], ['MT', 'Malta', 'Malta'], ['NO', 'Norwegen', 'Norway'],
  ['PT', 'Portugal', 'Portugal'], ['RO', 'Rumänien', 'Romania'], ['RS', 'Serbien', 'Serbia'], ['SE', 'Schweden', 'Sweden'],
  ['SI', 'Slowenien', 'Slovenia'], ['SK', 'Slowakei', 'Slovakia'], ['SM', 'San Marino', 'San Marino'],
  ['UA', 'Ukraine', 'Ukraine'], ['VA', 'Vatikanstadt', 'Vatican City'], ['XK', 'Kosovo', 'Kosovo'],
];

/**
 * traffic_sign values of town signs: entering ("entry") or leaving ("exit") the
 * built-up area in the direction the sign faces.
 */
const OZT_TOWN_SIGNS = Object.freeze({
  entry: ['city_limit', 'DE:310', 'NL:H01', 'NL:H1', 'BE:F1', 'BE:F1a', 'BE:F1b', 'PL:D-42'],
  exit: ['DE:311', 'NL:H02', 'NL:H2', 'BE:F3', 'BE:F3a', 'BE:F3b', 'PL:D-43'],
});

/** Default settings, used until the user changes something in the popup. @type {Readonly<Settings>} */
const OZT_DEFAULTS = Object.freeze({
  enabled: true,
  icons: true,
  legend: true,
  stats: true,
  editor: false,
  roads: OZT_ROAD_CLASSES.filter(([, on]) => on).map(([key]) => key),
  hidden: [],
  lang: 'de',
});

/**
 * Turns whatever came out of storage or a message into valid Settings.
 * Unknown keys are dropped, wrong types fall back to the default.
 * @param {unknown} input
 * @returns {Settings}
 */
function oztCleanSettings(input) {
  /** @type {Record<string, unknown>} */
  const s = input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
  /** @param {keyof Settings} key @param {boolean} fallback */
  const bool = (key, fallback) => (typeof s[key] === 'boolean' ? /** @type {boolean} */ (s[key]) : fallback);
  const knownRoads = new Set(OZT_ROAD_CLASSES.map(([key]) => key));
  const statuses = new Set(['ok', 'unusual', 'missing', 'review']);
  return {
    enabled: bool('enabled', OZT_DEFAULTS.enabled),
    icons: bool('icons', OZT_DEFAULTS.icons),
    legend: bool('legend', OZT_DEFAULTS.legend),
    stats: bool('stats', OZT_DEFAULTS.stats),
    editor: bool('editor', OZT_DEFAULTS.editor),
    roads: Array.isArray(s.roads)
      ? s.roads.filter((k) => typeof k === 'string' && knownRoads.has(k))
      : [...OZT_DEFAULTS.roads],
    hidden: Array.isArray(s.hidden) ? s.hidden.filter((k) => typeof k === 'string' && statuses.has(k)) : [],
    lang: s.lang === 'en' ? 'en' : 'de',
  };
}

/** The tables content.js needs, as one plain object for postMessage. */
function oztTables() {
  return {
    roadClasses: OZT_ROAD_CLASSES,
    countries: OZT_COUNTRIES,
    unverified: OZT_UNVERIFIED,
    townSigns: OZT_TOWN_SIGNS,
    source: OZT_SOURCE,
  };
}
