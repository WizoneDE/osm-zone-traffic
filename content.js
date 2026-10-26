// @ts-check
/**
 * OSM Traffic Zone Inspector – map script (runs in the page's own "MAIN" world).
 *
 * WHAT IT DOES
 *   Checks every regular road in the OpenStreetMap editor iD for zone:traffic=*
 *   (urban / rural / motorway zone of the national traffic rules) and colours it:
 *   green = official value, red = missing, yellow = wrong or to be checked. A zone
 *   icon on each road shows the value (in colour) or a suggestion (grey, with "?").
 *   Clicking the icon opens a small panel; in editor mode (off by default, beta in
 *   DE and NL) the chosen value can be inserted into iD's tag text box.
 *
 *   The extension NEVER saves or uploads anything. A value is only inserted after
 *   the user picked it (and confirmed replacing an existing value); iD records
 *   it like a typed change, so it can be undone and is saved by the user in iD.
 *
 * WHERE THE DATA COMES FROM
 *   iD attaches each way's data to its SVG <path> element (d3 data binding),
 *   readable as `path.__data__`, including tags and node ids. Only scripts in the
 *   page's own world can see that property, which is why this script runs with
 *   `world: "MAIN"`. The country comes from iD's own country lookup
 *   (iD.locationManager, country-coder); the Belgian regions from borders stored
 *   below. Only when the panel is opened for a way that reaches beyond the map, its
 *   full geometry is read from the OSM API (read only).
 *
 *   highway=* only decides WHICH roads are checked. Whether a road is urban or
 *   rural is never derived from it; other tags only feed a suggestion that the
 *   user has to confirm.
 *
 * SETTINGS
 *   The toolbar popup stores the settings in chrome.storage. This script cannot
 *   read chrome.storage from the page world, so bridge.js forwards them with
 *   window.postMessage, together with the tables from settings.js (countries,
 *   road classes, town signs). They are checked here, as any page script could
 *   send such a message.
 */
(() => {
  'use strict';

  // ===========================================================================
  // Types (JSDoc, checked with `tsc --checkJs`)
  // ===========================================================================

  /** @typedef {Record<string, string>} Tags  OSM tags, e.g. { highway: "primary" }. */
  /** @typedef {'urban'|'rural'|'motorway'|'expressway'} Kind  Zone kind of a value. */
  /** @typedef {'ok'|'unusual'|'missing'|'review'|'excluded'|'outside'} Status  unusual: valid but odd (urban/rural on a motorway link). */
  /** @typedef {{ code: string, [param: string]: string }} Message  Code for TEXT.msg plus its parameters. */
  /** @typedef {{ kind: Kind, strength: number, reason: Message }} Hint  strength: 1 weak … 3 strong. */

  /**
   * Rules of one country (or of the Belgian region candidates of a way).
   * @typedef {object} Rules
   * @property {string} code           Country code, e.g. "DE".
   * @property {string[]} regions      Region candidates (BE), else empty.
   * @property {boolean} verified      Documented in the OSM wiki.
   * @property {boolean} editor        Editor mode allowed (beta).
   * @property {string} name           Country name in the current language.
   * @property {Record<Kind, string[]>} values  Valid values per kind of value.
   * @property {string[]} motorway     Values for highway=motorway(_link).
   * @property {Record<string, string>} signs   Kind → sign key.
   */

  /**
   * Where a way lies.
   * @typedef {object} Place
   * @property {string} country          Single country, "" = several or none.
   * @property {string[]} countries      All countries the way touches.
   * @property {{ left: string, right: string } | null} sides  Different countries left and right (border road).
   * @property {string[]} regions        Region candidates in Belgium.
   * @property {boolean} partial         Only part of the way was seen.
   */

  /**
   * Everything evaluate() needs besides the tags.
   * @typedef {object} Context
   * @property {Place} place
   * @property {Set<string>} roads                     Checked highway values.
   * @property {{ start: string[], end: string[] }} neighbours  zone:traffic of ways joined at the ends.
   * @property {Array<{ position: 'start'|'end'|'inside', type: 'entry'|'exit', direction: string, node: string, sign: string }>} signs
   * @property {boolean} [stale]                       Local geometry differs from the OSM API.
   */

  /**
   * Result of the check of one way.
   * @typedef {object} Result
   * @property {Status} status
   * @property {Rules | null} rules
   * @property {string} value             Current zone:traffic ("" = none).
   * @property {Kind | null} kind         Kind of the current value, if valid or repairable.
   * @property {Array<{ value: string, kind: Kind, fits: boolean }>} options  Values offered in the panel.
   * @property {{ value: string, kind: Kind } | null} suggestion
   * @property {Message[]} reasons        Why the suggestion (tooltip).
   * @property {Message[]} problems       Why yellow / red.
   * @property {Message[]} notes          Further hints (not verified, prototype …).
   * @property {Message[]} blocked        Why the simplified input is not offered.
   */

  // ===========================================================================
  // Language
  // ===========================================================================

  /** @type {'de'|'en'} */ let LANG = 'de';

  const TEXT = {
    de: {
      title: 'Traffic Zone',
      ok: 'zone:traffic korrekt', missing: 'zone:traffic fehlt', review: 'prüfen (falscher Wert, Widerspruch, Sonderfall)',
      unusual: 'ungewöhnlich, aber möglich (z. B. Autobahn-Anschluss mit urban/rural)',
      iconGrey: 'grau = fehlt', iconQuestion: '? = Vorschlag aus anderen Tags', iconWarn: '! = prüfen', iconUnusual: '~ = ungewöhnlich',
      kinds: { urban: 'innerorts', rural: 'außerorts', motorway: 'Autobahn', expressway: 'Schnellstraße' },
      verified: 'verified', notVerified: 'not verified', beta: 'Editor Beta', prototype: 'Prototyp',
      viewCountry: 'Ausschnitt', several: 'mehrere Länder', none: 'kein unterstütztes Land',
      statsTitle: 'Statistik', statsScope: 'Bezugsraum: sichtbarer Kartenausschnitt (nur sichtbare Wegteile), keine landesweite Abdeckung',
      statsWays: 'Untersuchte Ways', statsOk: 'korrekt', statsMissing: 'ohne zone:traffic', statsUnusual: 'ungewöhnlich', statsReview: 'Sonderfälle / prüfen',
      statsLength: 'Länge untersucht', statsLengthMissing: 'Länge ohne zone:traffic', statsCoverage: 'Abdeckung nach Länge',
      drag: 'Ziehen zum Verschieben', fold: 'Einklappen', unfold: 'Ausklappen',
      current: 'Aktuell', noValue: 'zone:traffic fehlt', suggestion: 'Vorschlag', noSuggestion: 'kein Vorschlag – Wert selbst wählen',
      reasons: 'Gründe', problems: 'Probleme', notes: 'Hinweise', blockedTitle: 'Keine vereinfachte Eingabe',
      clickHint: 'Klicken für Details', choose: 'Wert', notFitting: 'passt nicht zur Straßenklasse',
      confirmReplace: (/** @type {string} */ old) => `Vorhandenen Wert ${old} ersetzen.`,
      insert: 'In Tag-Textbox einfügen', close: 'Schließen',
      editorOff: 'Editor-Modus ist aus (Einstellungen der Erweiterung).',
      editorCountry: 'Editor-Modus für dieses Land noch nicht freigegeben (Prototyp, nur Analyse).',
      betaNote: 'Beta: Änderungen nur im iD-Bearbeitungsstand. Prüfen und speichern machst du in iD.',
      loading: 'Lade vollständige Geometrie …',
      done: (/** @type {string} */ v) => `Eingefügt: zone:traffic=${v}. Bitte in iD prüfen und wie gewohnt speichern (oder rückgängig machen).`,
      unchanged: 'Wert war bereits gesetzt – nichts geändert.',
      fail: {
        select: 'Way konnte in iD nicht ausgewählt werden. Bitte den Way anklicken und erneut versuchen.',
        textbox: 'Tag-Textbox von iD nicht gefunden.',
        focus: 'Die Tag-Textbox wird gerade bearbeitet. Bitte erst die Eingabe abschließen.',
        mismatch: 'Inhalt der Tag-Textbox passt nicht zu den Tags des Ways – nichts geändert.',
        duplicate: 'zone:traffic steht mehrfach in der Textbox – nichts geändert.',
        verify: 'iD hat die Änderung nicht wie erwartet übernommen. Bitte in iD prüfen (Rückgängig: Strg/Cmd+Z).',
        changed: 'Der Way wurde inzwischen geändert – bitte erneut öffnen.',
      },
      places: { start: 'Anfang', end: 'Ende', inside: 'innen' },
      directions: { forward: 'vorwärts', backward: 'rückwärts', '': 'ohne Richtung' },
      msg: {
        directional: (/** @type {Message} */ m) => `Richtungsabhängige Schlüssel (${m.keys}) – bitte manuell in iD bearbeiten`,
        sides: () => 'Seitenabhängige Werte (zone:traffic:left/right) – bitte manuell in iD bearbeiten',
        sideValue: (/** @type {Message} */ m) => `zone:traffic:${m.side}=${m.value} passt nicht (erwartet ${m.expected})`,
        plainAndSides: () => 'zone:traffic und zone:traffic:left/right gleichzeitig gesetzt',
        borderRoad: (/** @type {Message} */ m) => `Straße entlang der Grenze (links ${m.left}, rechts ${m.right}) – zone:traffic:left/right verwenden`,
        crossBorder: (/** @type {Message} */ m) => `Way überquert eine Grenze (${m.list}) – in iD an der Grenze teilen`,
        regionAmbiguous: (/** @type {Message} */ m) => `Region nicht eindeutig (${m.list}) – Way nahe der Regionsgrenze`,
        partial: () => 'Way reicht über den Kartenausschnitt hinaus und seine Geometrie ist nicht vollständig bekannt – herauszoomen',
        stale: () => 'Lokale Geometrie weicht vom Stand der OSM-API ab',
        signInside: (/** @type {Message} */ m) => `Ortstafel (${m.sign}) mitten im Way (${m.node}) – in iD an der Ortstafel teilen`,
        otherCountry: (/** @type {Message} */ m) => `${m.value} ist ein Wert eines anderen Landes (erwartet ${m.expected})`,
        nationalForRegion: (/** @type {Message} */ m) => `In Belgien wird der Wert der Region erwartet: ${m.expected} statt ${m.value}`,
        regionMismatch: (/** @type {Message} */ m) => `${m.value} gehört zu einer anderen Region (erwartet ${m.expected})`,
        wrongKind: (/** @type {Message} */ m) => `${m.value} passt nicht zu highway=${m.highway} (erwartet ${m.expected})`,
        malformed: (/** @type {Message} */ m) => `Schreibweise fehlerhaft: ${m.value} → ${m.fix}`,
        speedValue: (/** @type {Message} */ m) => `${m.value} ist kein Verkehrszonen-Wert (gehört eher zu zone:maxspeed oder maxspeed:type)`,
        unknownValue: (/** @type {Message} */ m) => `Unbekannter Wert ${m.value} (erwartet ${m.expected})`,
        conflictUrban: (/** @type {Message} */ m) => `Widerspruch zu urban=${m.value}`,
        conflictTag: (/** @type {Message} */ m) => `Widerspruch zu ${m.key}=${m.value}`,
        conflictSign: (/** @type {Message} */ m) => `Widerspruch zur Ortstafel ${m.sign} am ${m.place}`,
        livingRural: () => 'Verkehrsberuhigter Bereich mit Außerorts-Wert – auffällige Kombination, manuell prüfen',
        linkZone: (/** @type {Message} */ m) => `${m.value} an einer Autobahn-Anschlussstelle: möglich, wenn dieser Teil hinter dem Ende der Autobahn liegt (DE: Zeichen 330.2, ggf. Ortstafel) – ungewöhnlich, bitte prüfen`,
        livingMissing: () => 'Verkehrsberuhigter Bereich: Innerorts-Zuordnung prüfen (nicht automatisch innerorts)',
        transition: (/** @type {Message} */ m) => `Angrenzende Abschnitte unterschiedlich (Anfang ${m.start}, Ende ${m.end}) – Übergang? Ortstafel prüfen`,
        signNoDirection: (/** @type {Message} */ m) => `Ortstafel (${m.sign}) am ${m.place} ohne direction=forward/backward – Richtung unbekannt`,
        unverified: (/** @type {Message} */ m) => `${m.country}: Werte nicht im OSM-Wiki dokumentiert (not verified) – Muster ${m.cc}:urban / ${m.cc}:rural angenommen`,
        prototype: (/** @type {Message} */ m) => `${m.country}: Prototyp – nur Analyse, Editor noch nicht freigegeben`,
        beta: (/** @type {Message} */ m) => `${m.country}: Editor Beta`,
        tag: (/** @type {Message} */ m) => `${m.key}=${m.value}`,
        motorwayClass: (/** @type {Message} */ m) => `highway=${m.highway}`,
        living: (/** @type {Message} */ m) => `${m.key}=${m.value} (liegt meist innerorts)`,
        gap: (/** @type {Message} */ m) => `Lücke: angrenzende Abschnitte an beiden Enden ${m.value}`,
        neighbour: (/** @type {Message} */ m) => `angrenzender Abschnitt am ${m.place}: ${m.value}`,
        sign: (/** @type {Message} */ m) => `Ortstafel ${m.sign} am ${m.place}, ${m.direction}`,
      },
    },
    en: {
      title: 'Traffic Zone',
      ok: 'zone:traffic correct', missing: 'zone:traffic missing', review: 'check (wrong value, conflict, special case)',
      unusual: 'unusual but possible (e.g. motorway link with urban/rural)',
      iconGrey: 'grey = missing', iconQuestion: '? = suggestion from other tags', iconWarn: '! = check', iconUnusual: '~ = unusual',
      kinds: { urban: 'urban', rural: 'rural', motorway: 'motorway', expressway: 'expressway' },
      verified: 'verified', notVerified: 'not verified', beta: 'Editor beta', prototype: 'Prototype',
      viewCountry: 'View', several: 'several countries', none: 'no supported country',
      statsTitle: 'Statistics', statsScope: 'Scope: visible map area (visible parts of ways only), not national coverage',
      statsWays: 'Ways checked', statsOk: 'correct', statsMissing: 'without zone:traffic', statsUnusual: 'unusual', statsReview: 'special cases / check',
      statsLength: 'Length checked', statsLengthMissing: 'Length without zone:traffic', statsCoverage: 'Coverage by length',
      drag: 'Drag to move', fold: 'Collapse', unfold: 'Expand',
      current: 'Current', noValue: 'zone:traffic missing', suggestion: 'Suggestion', noSuggestion: 'no suggestion – choose a value yourself',
      reasons: 'Reasons', problems: 'Problems', notes: 'Notes', blockedTitle: 'No simplified input',
      clickHint: 'Click for details', choose: 'Value', notFitting: 'does not fit the road class',
      confirmReplace: (/** @type {string} */ old) => `Replace the existing value ${old}.`,
      insert: 'Insert into tag text box', close: 'Close',
      editorOff: 'Editor mode is off (extension settings).',
      editorCountry: 'Editor mode not yet enabled for this country (prototype, analysis only).',
      betaNote: 'Beta: changes only go into iD\'s edit state. You review and save them in iD.',
      loading: 'Loading full geometry …',
      done: (/** @type {string} */ v) => `Inserted: zone:traffic=${v}. Please review in iD and save as usual (or undo).`,
      unchanged: 'The value was already set – nothing changed.',
      fail: {
        select: 'Could not select the way in iD. Please click the way and try again.',
        textbox: 'iD\'s tag text box not found.',
        focus: 'The tag text box is being edited. Please finish typing first.',
        mismatch: 'The tag text box does not match the way\'s tags – nothing changed.',
        duplicate: 'zone:traffic appears more than once in the text box – nothing changed.',
        verify: 'iD did not take the change as expected. Please check in iD (undo: Ctrl/Cmd+Z).',
        changed: 'The way has changed in the meantime – please open it again.',
      },
      places: { start: 'start', end: 'end', inside: 'inside' },
      directions: { forward: 'forward', backward: 'backward', '': 'no direction' },
      msg: {
        directional: (/** @type {Message} */ m) => `Direction-dependent keys (${m.keys}) – please edit manually in iD`,
        sides: () => 'Side-dependent values (zone:traffic:left/right) – please edit manually in iD',
        sideValue: (/** @type {Message} */ m) => `zone:traffic:${m.side}=${m.value} does not fit (expected ${m.expected})`,
        plainAndSides: () => 'zone:traffic and zone:traffic:left/right both set',
        borderRoad: (/** @type {Message} */ m) => `Road along the border (left ${m.left}, right ${m.right}) – use zone:traffic:left/right`,
        crossBorder: (/** @type {Message} */ m) => `Way crosses a border (${m.list}) – split it in iD at the border`,
        regionAmbiguous: (/** @type {Message} */ m) => `Region not unique (${m.list}) – way close to the regional border`,
        partial: () => 'Way reaches beyond the map and its geometry is not fully known – zoom out',
        stale: () => 'Local geometry differs from the OSM API',
        signInside: (/** @type {Message} */ m) => `Town sign (${m.sign}) inside the way (${m.node}) – split it in iD at the sign`,
        otherCountry: (/** @type {Message} */ m) => `${m.value} is a value of another country (expected ${m.expected})`,
        nationalForRegion: (/** @type {Message} */ m) => `Belgium uses the regional value: ${m.expected} instead of ${m.value}`,
        regionMismatch: (/** @type {Message} */ m) => `${m.value} belongs to another region (expected ${m.expected})`,
        wrongKind: (/** @type {Message} */ m) => `${m.value} does not fit highway=${m.highway} (expected ${m.expected})`,
        malformed: (/** @type {Message} */ m) => `Misspelt value: ${m.value} → ${m.fix}`,
        speedValue: (/** @type {Message} */ m) => `${m.value} is no traffic zone value (belongs to zone:maxspeed or maxspeed:type)`,
        unknownValue: (/** @type {Message} */ m) => `Unknown value ${m.value} (expected ${m.expected})`,
        conflictUrban: (/** @type {Message} */ m) => `Conflicts with urban=${m.value}`,
        conflictTag: (/** @type {Message} */ m) => `Conflicts with ${m.key}=${m.value}`,
        conflictSign: (/** @type {Message} */ m) => `Conflicts with the town sign ${m.sign} at the ${m.place}`,
        livingRural: () => 'Living street with a rural value – unusual combination, check manually',
        linkZone: (/** @type {Message} */ m) => `${m.value} on a motorway link: possible where this part lies beyond the end of the motorway (DE: sign 330.2, maybe a town sign) – unusual, please check`,
        livingMissing: () => 'Living street: check the urban zone (not urban automatically)',
        transition: (/** @type {Message} */ m) => `Joined sections differ (start ${m.start}, end ${m.end}) – transition? Check the town sign`,
        signNoDirection: (/** @type {Message} */ m) => `Town sign (${m.sign}) at the ${m.place} without direction=forward/backward – direction unknown`,
        unverified: (/** @type {Message} */ m) => `${m.country}: values not documented in the OSM wiki (not verified) – pattern ${m.cc}:urban / ${m.cc}:rural assumed`,
        prototype: (/** @type {Message} */ m) => `${m.country}: prototype – analysis only, editor not yet enabled`,
        beta: (/** @type {Message} */ m) => `${m.country}: editor beta`,
        tag: (/** @type {Message} */ m) => `${m.key}=${m.value}`,
        motorwayClass: (/** @type {Message} */ m) => `highway=${m.highway}`,
        living: (/** @type {Message} */ m) => `${m.key}=${m.value} (usually urban)`,
        gap: (/** @type {Message} */ m) => `Gap: joined sections at both ends are ${m.value}`,
        neighbour: (/** @type {Message} */ m) => `joined section at the ${m.place}: ${m.value}`,
        sign: (/** @type {Message} */ m) => `town sign ${m.sign} at the ${m.place}, ${m.direction}`,
      },
    },
  };
  const text = () => TEXT[LANG];

  /** Text of a message in the current language. @param {Message} m */
  function messageText(m) {
    const format = /** @type {Record<string, (m: Message) => string>} */ (text().msg)[m.code];
    return format ? format(m) : m.code;
  }

  // ===========================================================================
  // Tables from settings.js (checked, as any page script could send them)
  // ===========================================================================

  /** @typedef {{ de: string, en: string, verified: boolean, editor: boolean, motorway: string[], expressway?: string, regions?: Record<string, { de: string, en: string }>, signs: Record<string, string> }} CountryTable */

  /** @type {Record<string, CountryTable>} */ let countries = {};
  /** @type {Map<string, { de: string, en: string }>} */ let unverified = new Map();
  /** @type {Map<string, { de: string, en: string }>} */ let roadNames = new Map();
  /** @type {{ entry: Set<string>, exit: Set<string> }} */ let townSigns = { entry: new Set(), exit: new Set() };
  /** @type {{ page: string, revision: number, edited: string, checked: string }} */
  let source = { page: '', revision: 0, edited: '', checked: '' };

  const CODE = /^[A-Z]{2}$/;
  const REGION = /^[A-Z]{2}-[A-Z]{2,3}$/;
  const VALUE = /^[A-Z]{2}(-[A-Z]{2,3})?:[a-z_]+$/;
  const isText = (/** @type {unknown} */ v) => typeof v === 'string' && v.length < 200;
  /** @param {unknown} v @returns {{ de: string, en: string } | null} */
  const names = (v) => {
    const o = /** @type {any} */ (v);
    return o && isText(o.de) && isText(o.en) ? { de: o.de, en: o.en } : null;
  };

  /** @param {unknown} input */
  function setTables(input) {
    const t = /** @type {any} */ (input);
    if (!t || typeof t !== 'object') return;
    /** @type {Record<string, CountryTable>} */
    const nextCountries = {};
    for (const [code, c] of Object.entries(t.countries || {})) {
      const n = names(c);
      if (!CODE.test(code) || !n || !c || typeof c !== 'object') continue;
      const motorway = Array.isArray(c.motorway) ? c.motorway.filter((/** @type {unknown} */ v) => isText(v) && VALUE.test(/** @type {string} */ (v))) : [];
      /** @type {Record<string, string>} */
      const signs = {};
      for (const [k, v] of Object.entries(c.signs || {})) if (isText(v) && /^[\w.-]+$/.test(/** @type {string} */ (v))) signs[k] = /** @type {string} */ (v);
      /** @type {CountryTable} */
      const entry = { ...n, verified: c.verified === true, editor: c.editor === true, motorway, signs };
      if (isText(c.expressway) && VALUE.test(c.expressway)) entry.expressway = c.expressway;
      if (c.regions && typeof c.regions === 'object') {
        /** @type {Record<string, { de: string, en: string }>} */
        const regions = {};
        for (const [r, rn] of Object.entries(c.regions)) { const x = names(rn); if (REGION.test(r) && x) regions[r] = x; }
        entry.regions = regions;
      }
      nextCountries[code] = entry;
    }
    countries = nextCountries;
    unverified = new Map();
    for (const row of Array.isArray(t.unverified) ? t.unverified : []) {
      if (Array.isArray(row) && CODE.test(row[0]) && isText(row[1]) && isText(row[2]) && !countries[row[0]]) unverified.set(row[0], { de: row[1], en: row[2] });
    }
    roadNames = new Map();
    for (const row of Array.isArray(t.roadClasses) ? t.roadClasses : []) {
      if (Array.isArray(row) && isText(row[0]) && isText(row[2]) && isText(row[3])) roadNames.set(row[0], { de: row[2], en: row[3] });
    }
    const signList = (/** @type {unknown} */ v) => new Set(Array.isArray(v) ? v.filter(isText) : []);
    townSigns = { entry: signList(t.townSigns?.entry), exit: signList(t.townSigns?.exit) };
    if (t.source && isText(t.source.page) && Number.isInteger(t.source.revision) && isText(t.source.edited) && isText(t.source.checked)) {
      source = { page: t.source.page, revision: t.source.revision, edited: t.source.edited, checked: t.source.checked };
    }
  }

  /**
   * @typedef {object} Settings
   * @property {boolean} enabled
   * @property {boolean} icons
   * @property {boolean} legend
   * @property {boolean} stats
   * @property {boolean} editor
   * @property {Set<string>} roads
   * @property {Set<string>} hidden
   * @property {'de'|'en'} lang
   */

  /** @param {unknown} input @returns {Settings} */
  function checkSettings(input) {
    const s = /** @type {any} */ (input && typeof input === 'object' ? input : {});
    const bool = (/** @type {string} */ key, /** @type {boolean} */ fallback) => (typeof s[key] === 'boolean' ? s[key] : fallback);
    const list = (/** @type {unknown} */ v) => new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^[a-z_]{1,30}$/.test(x)) : []);
    return {
      enabled: bool('enabled', true),
      icons: bool('icons', true),
      legend: bool('legend', true),
      stats: bool('stats', true),
      editor: bool('editor', false),
      roads: list(s.roads),
      hidden: list(s.hidden),
      lang: s.lang === 'en' ? 'en' : 'de',
    };
  }

  // ===========================================================================
  // Rules: which values are valid where
  // ===========================================================================

  /** @type {Kind[]} */
  const KINDS = ['urban', 'rural', 'motorway', 'expressway'];
  const NEUTRAL_SIGNS = { urban: 'neutral-urban', rural: 'neutral-rural', motorway: 'neutral-motorway', expressway: 'neutral-expressway' };

  /**
   * Rules for a country; for Belgium for the given region candidates.
   * @param {string} code
   * @param {string[]} [regions]
   * @returns {Rules | null}
   */
  function rulesFor(code, regions = []) {
    const c = countries[code];
    if (c) {
      const prefixes = c.regions ? regions.filter((r) => c.regions && r in c.regions) : [code];
      const motorway = [...c.motorway];
      return {
        code, regions: c.regions ? prefixes : [], verified: c.verified, editor: c.editor, name: c[LANG],
        values: {
          urban: prefixes.map((p) => `${p}:urban`),
          rural: prefixes.map((p) => `${p}:rural`),
          motorway: motorway.filter((v) => !v.endsWith(':rural')),
          expressway: c.expressway ? [c.expressway] : [],
        },
        motorway,
        signs: { ...NEUTRAL_SIGNS, ...c.signs },
      };
    }
    const u = unverified.get(code);
    if (!u) return null;
    return {
      code, regions: [], verified: false, editor: false, name: u[LANG],
      values: { urban: [`${code}:urban`], rural: [`${code}:rural`], motorway: [`${code}:motorway`], expressway: [] },
      motorway: [`${code}:motorway`, `${code}:rural`],
      signs: { ...NEUTRAL_SIGNS },
    };
  }

  /** Name of a country code in the current language ("" if unknown). @param {string} code */
  function countryName(code) {
    return countries[code]?.[LANG] || unverified.get(code)?.[LANG] || code;
  }

  /** Kind of a value under these rules, or null. @param {string} value @param {Rules} rules @returns {Kind | null} */
  function kindOf(value, rules) {
    for (const kind of KINDS) if (rules.values[kind].includes(value)) return kind;
    return null;
  }

  /** @param {Tags} tags @param {Rules} rules @returns {'motorway'|'expressway'|'road'} */
  function roadKind(tags, rules) {
    if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return 'motorway';
    if (rules.values.expressway.length && (tags.expressway === 'yes' || tags.motorroad === 'yes')) return 'expressway';
    return 'road';
  }

  /** Values that fit this road under these rules. @param {Tags} tags @param {Rules} rules */
  function expectedValues(tags, rules) {
    const road = roadKind(tags, rules);
    if (road === 'motorway') return [...rules.motorway];
    if (road === 'expressway') return [...rules.values.expressway, ...rules.values.urban, ...rules.values.rural];
    return [...rules.values.urban, ...rules.values.rural];
  }

  /**
   * A misspelt value that clearly means a valid one ("De:urban", "DE.rural", "DEurban").
   * @param {string} value @param {Rules} rules @returns {string}  The valid value, or "".
   */
  function repairValue(value, rules) {
    const m = /^\s*([A-Za-z]{2}(?:[-_][A-Za-z]{2,3})?)\s*(?:[:.\-ː;]+\s*)?(urban|rural|motorway|expressway)\s*$/i.exec(value);
    if (!m) return '';
    const fixed = `${m[1].toUpperCase().replace('_', '-')}:${m[2].toLowerCase()}`;
    return fixed !== value && kindOf(fixed, rules) ? fixed : '';
  }

  /** Value of the same kind for these rules, if there is exactly one. @param {Rules} rules @param {Kind} kind */
  function valueFor(rules, kind) {
    const values = kind === 'motorway' ? rules.motorway : rules.values[kind];
    return values.length === 1 || (kind === 'motorway' && values.length) ? values[0] : '';
  }

  /** "DE:urban, DE:rural" @param {string[]} values */
  const listOf = (values) => values.join(', ') || '–';

  /**
   * Problems of a value that is not valid here.
   * @param {string} value @param {Tags} tags @param {Rules} rules
   * @returns {{ problem: Message, kind: Kind | null, blocking: boolean }}
   */
  function badValue(value, tags, rules) {
    const expected = expectedValues(tags, rules);
    const fix = repairValue(value, rules);
    if (fix) return { problem: { code: 'malformed', value, fix }, kind: kindOf(fix, rules), blocking: false };
    const m = /^([A-Z]{2})(-[A-Z]{2,3})?:([a-z_]+)$/.exec(value);
    if (m && m[1] === rules.code) {
      const known = rulesFor(rules.code, Object.keys(countries[rules.code]?.regions || {}));
      const kind = known ? kindOf(value, known) : null;
      if (rules.regions.length && !m[2] && (m[3] === 'urban' || m[3] === 'rural')) {
        return { problem: { code: 'nationalForRegion', value, expected: listOf(rules.values[m[3]]) }, kind: m[3], blocking: false };
      }
      if (kind && m[2] && !rules.regions.includes(`${m[1]}${m[2]}`)) {
        return { problem: { code: 'regionMismatch', value, expected: listOf(expected) }, kind, blocking: true };
      }
      if (kind) return { problem: { code: 'wrongKind', value, highway: tags.highway, expected: listOf(expected) }, kind, blocking: false };
    }
    if (m && m[1] !== rules.code) return { problem: { code: 'otherCountry', value, expected: listOf(expected) }, kind: null, blocking: true };
    if (/zone|\d|speed|walk|living_street/i.test(value)) return { problem: { code: 'speedValue', value }, kind: null, blocking: true };
    return { problem: { code: 'unknownValue', value, expected: listOf(expected) }, kind: null, blocking: true };
  }

  /** Keys whose CC:urban / CC:rural values tell the zone (implicit speed limits). */
  const ZONE_HINT_KEYS = ['source:maxspeed', 'maxspeed:type', 'zone:maxspeed', 'maxspeed'];

  /**
   * Hints from other tags, neighbours and town signs.
   * @param {Tags} tags @param {Rules} rules @param {Context} ctx
   * @returns {{ hints: Hint[], notes: Message[], problems: Message[] }}
   */
  function hintsFor(tags, rules, ctx) {
    /** @type {Hint[]} */ const hints = [];
    /** @type {Message[]} */ const notes = [];
    /** @type {Message[]} */ const problems = [];
    const ownPrefix = (/** @type {string} */ p) => p === rules.code || (rules.regions.length > 0 && p.startsWith(`${rules.code}-`));
    for (const key of ZONE_HINT_KEYS) {
      for (const part of (tags[key] || '').split(';')) {
        const m = /^([A-Z]{2}(?:-[A-Z]{2,3})?):(urban|rural|motorway|expressway)$/.exec(part.trim());
        if (m && ownPrefix(m[1])) hints.push({ kind: /** @type {Kind} */ (m[2]), strength: 3, reason: { code: 'tag', key, value: part.trim() } });
      }
    }
    if (tags.urban === 'yes') hints.push({ kind: 'urban', strength: 2, reason: { code: 'tag', key: 'urban', value: 'yes' } });
    if (tags.urban === 'no') hints.push({ kind: 'rural', strength: 2, reason: { code: 'tag', key: 'urban', value: 'no' } });
    const road = roadKind(tags, rules);
    if (road === 'motorway') hints.push({ kind: 'motorway', strength: 3, reason: { code: 'motorwayClass', highway: tags.highway } });
    if (road === 'expressway') {
      const key = tags.expressway === 'yes' ? 'expressway' : 'motorroad';
      hints.push({ kind: 'expressway', strength: 2, reason: { code: 'tag', key, value: 'yes' } });
    }
    if (tags.highway === 'living_street') hints.push({ kind: 'urban', strength: 1, reason: { code: 'living', key: 'highway', value: 'living_street' } });
    else if (tags.living_street === 'yes') hints.push({ kind: 'urban', strength: 1, reason: { code: 'living', key: 'living_street', value: 'yes' } });

    // Joined sections: the same zone at both ends suggests a gap in the tagging.
    const kindsAt = (/** @type {string[]} */ values) => [...new Set(values.map((v) => kindOf(v, rules)).filter((k) => k !== null))];
    const start = kindsAt(ctx.neighbours.start);
    const end = kindsAt(ctx.neighbours.end);
    const valueText = (/** @type {Kind[]} */ kinds) => kinds.map((k) => valueFor(rules, k) || text().kinds[k]).join('/');
    if (start.length === 1 && end.length === 1 && start[0] === end[0]) {
      hints.push({ kind: start[0], strength: 2, reason: { code: 'gap', value: valueText(start) } });
    } else if (start.length && end.length) {
      notes.push({ code: 'transition', start: valueText(start), end: valueText(end) });
    } else if (start.length === 1 || end.length === 1) {
      const [kinds, place] = start.length === 1 ? [start, 'start'] : [end, 'end'];
      hints.push({ kind: kinds[0], strength: 1, reason: { code: 'neighbour', place: text().places[/** @type {'start'|'end'} */ (place)], value: valueText(kinds) } });
    }

    // Town signs on the way. At the first node, "after the sign" in forward direction
    // is this way; at the last node it is beyond. An entry sign starts the built-up area.
    for (const s of ctx.signs) {
      const place = text().places[s.position];
      if (s.position === 'inside') { problems.push({ code: 'signInside', sign: s.sign, node: s.node }); continue; }
      if (s.direction !== 'forward' && s.direction !== 'backward') { notes.push({ code: 'signNoDirection', sign: s.sign, place }); continue; }
      const thisWayIsAfter = (s.position === 'start') === (s.direction === 'forward');
      const kind = (s.type === 'entry') === thisWayIsAfter ? 'urban' : 'rural';
      hints.push({ kind, strength: 3, reason: { code: 'sign', sign: s.sign, place, direction: text().directions[s.direction] } });
    }
    return { hints, notes, problems };
  }

  /**
   * Suggestion from the hints: the strongest kind, unless another kind has a
   * strong hint too (then the user has to decide).
   * @param {Hint[]} hints @param {Rules} rules
   */
  function suggest(hints, rules) {
    /** @type {Map<string, number>} */
    const best = new Map();
    for (const h of hints) {
      const value = valueFor(rules, h.kind);
      if (value) best.set(value, Math.max(best.get(value) || 0, h.strength));
    }
    const ranked = [...best].sort((a, b) => b[1] - a[1]);
    if (!ranked.length || (ranked.length > 1 && ranked[1][1] >= 2)) return null;
    const kind = kindOf(ranked[0][0], rules);
    return kind ? { value: ranked[0][0], kind } : null;
  }

  /**
   * Checks one way.
   * @param {Tags} tags @param {Context} ctx @returns {Result}
   */
  function evaluate(tags, ctx) {
    /** @type {Result} */
    const result = {
      status: 'excluded', rules: null, value: tags['zone:traffic'] || '', kind: null, options: [],
      suggestion: null, reasons: [], problems: [], notes: [], blocked: [],
    };
    if (!tags.highway || !ctx.roads.has(tags.highway) || tags.area === 'yes') return result;
    const { place } = ctx;
    const country = place.country || (place.sides ? place.sides.left || place.sides.right : place.countries[0] || '');
    const rules = country ? rulesFor(country, place.regions) : null;
    if (!rules) { result.status = 'outside'; return result; }
    result.rules = rules;

    if (!rules.verified) result.notes.push({ code: 'unverified', country: rules.name, cc: rules.code });
    if (rules.editor) result.notes.push({ code: 'beta', country: rules.name });
    else result.notes.push({ code: 'prototype', country: rules.name });

    const zoneKeys = Object.keys(tags).filter((k) => k.startsWith('zone:traffic:'));
    /** @type {string[]} */
    const sideKeys = zoneKeys.filter((k) => k === 'zone:traffic:left' || k === 'zone:traffic:right');
    const otherKeys = zoneKeys.filter((k) => !sideKeys.includes(k));
    const multiCountry = place.countries.length > 1;
    if (place.regions.length > 1) result.blocked.push({ code: 'regionAmbiguous', list: place.regions.join(', ') });
    if (place.partial) result.blocked.push({ code: 'partial' });
    if (ctx.stale) result.blocked.push({ code: 'stale' });

    const { hints, notes, problems } = hintsFor(tags, rules, ctx);
    result.notes.push(...notes);
    if (tags.highway === 'living_street' && !result.value) result.notes.push({ code: 'livingMissing' });
    for (const p of problems) { result.problems.push(p); result.blocked.push(p); }

    // Values offered in the panel: all of the country, the fitting ones first.
    const expected = expectedValues(tags, rules);
    // A motorway link keeps its class up to the junction, beyond the end of the motorway
    // (DE: sign 330.2); there it may be urban or rural. Not wrong, but unusual (user, 2026-10-26).
    const linkValues = tags.highway === 'motorway_link' ? [...rules.values.urban, ...rules.values.rural].filter((v) => !expected.includes(v)) : [];
    const all = [...new Set([...expected, ...KINDS.flatMap((k) => (k === 'motorway' ? rules.motorway : rules.values[k]))])];
    result.options = all.map((value) => ({ value, kind: /** @type {Kind} */ (kindOf(value, rules)), fits: expected.includes(value) || linkValues.includes(value) }))
      .filter((o) => o.kind);

    // Direction- or side-dependent tagging is never edited here.
    if (otherKeys.length) {
      result.status = 'review';
      const m = { code: 'directional', keys: otherKeys.join(', ') };
      result.problems.push(m); result.blocked.push(m);
      return result;
    }
    if (sideKeys.length) {
      result.blocked.push({ code: 'sides' });
      if (result.value) result.problems.push({ code: 'plainAndSides' });
      for (const side of /** @type {Array<'left'|'right'>} */ (['left', 'right'])) {
        const value = tags[`zone:traffic:${side}`];
        const sideCountry = place.sides ? place.sides[side] : country;
        const sideRules = sideCountry ? rulesFor(sideCountry, place.regions) : null;
        const ok = value && sideRules && expectedValues(tags, sideRules).includes(value);
        if (!ok) result.problems.push({ code: 'sideValue', side, value: value || '–', expected: sideRules ? listOf(expectedValues(tags, sideRules)) : '–' });
      }
      result.status = result.problems.length ? 'review' : 'ok';
      return result;
    }
    if (place.sides) {
      const m = { code: 'borderRoad', left: place.sides.left || '–', right: place.sides.right || '–' };
      result.blocked.push(m);
      if (result.value) { result.status = 'review'; result.problems.push(m); return result; }
    } else if (multiCountry) {
      const m = { code: 'crossBorder', list: place.countries.join(', ') };
      result.blocked.push(m);
      if (result.value) { result.status = 'review'; result.problems.push(m); return result; }
    }

    const hintSuggestion = suggest(hints, rules);
    if (!result.value) {
      result.status = 'missing';
      result.suggestion = hintSuggestion;
      result.reasons = hints.map((h) => h.reason);
      return result;
    }

    // A value is set: is it valid, and do other tags agree?
    const value = result.value;
    if (expected.includes(value) || linkValues.includes(value)) {
      const kind = /** @type {Kind} */ (kindOf(value, rules));
      result.kind = kind;
      for (const h of hints) {
        const hintValue = valueFor(rules, h.kind);
        const hintKind = hintValue ? kindOf(hintValue, rules) : null;
        // The road class only decides the expected values, checked above.
        if (h.strength < 2 || !hintKind || hintKind === kind || h.reason.code === 'motorwayClass') continue;
        const r = h.reason;
        /** @type {Message} */
        const conflict = r.code === 'sign' ? { code: 'conflictSign', sign: r.sign, place: r.place }
          : r.code === 'tag' && r.key === 'urban' ? { code: 'conflictUrban', value: r.value }
          : { code: 'conflictTag', key: r.key || 'highway', value: r.value || tags.highway };
        result.problems.push(conflict);
        result.blocked.push(conflict);
      }
      if ((tags.highway === 'living_street' || tags.living_street === 'yes') && kind === 'rural') result.problems.push({ code: 'livingRural' });
      result.status = result.problems.length ? 'review' : linkValues.includes(value) ? 'unusual' : 'ok';
      if (result.status === 'unusual') result.notes.push({ code: 'linkZone', value });
      result.reasons = hints.map((h) => h.reason);
      if (result.status === 'review') result.suggestion = hintSuggestion;
      return result;
    }
    const bad = badValue(value, tags, rules);
    result.status = 'review';
    result.kind = bad.kind;
    result.problems.push(bad.problem);
    if (bad.blocking) result.blocked.push(bad.problem);
    const fix = bad.problem.code === 'malformed' ? bad.problem.fix : '';
    const fixKind = fix ? kindOf(fix, rules) : null;
    result.suggestion = fix && fixKind && expected.includes(fix) ? { value: fix, kind: fixKind } : hintSuggestion;
    result.reasons = hints.map((h) => h.reason);
    return result;
  }

  // ===========================================================================
  // Town signs on nodes
  // ===========================================================================

  /**
   * Town signs a node carries: [type, direction, sign]. traffic_sign with
   * direction=*, or traffic_sign:forward / :backward.
   * @param {Tags} tags
   * @returns {Array<{ type: 'entry'|'exit', direction: string, sign: string }>}
   */
  function townSignsOf(tags) {
    /** @type {Array<{ type: 'entry'|'exit', direction: string, sign: string }>} */
    const found = [];
    for (const [key, direction] of [['traffic_sign', tags.direction || ''], ['traffic_sign:forward', 'forward'], ['traffic_sign:backward', 'backward']]) {
      for (const part of (tags[key] || '').split(/[;,]/)) {
        const sign = part.trim().replace(/\[.*$/, '');
        if (townSigns.entry.has(sign)) found.push({ type: 'entry', direction, sign });
        else if (townSigns.exit.has(sign)) found.push({ type: 'exit', direction, sign });
      }
    }
    return found;
  }

  /**
   * Town signs on a way's nodes, by position.
   * @param {string[]} nodes  Node ids of the way.
   * @param {(id: string) => Tags | undefined} tagsOf
   * @returns {Context['signs']}
   */
  function signsAlong(nodes, tagsOf) {
    /** @type {Context['signs']} */
    const signs = [];
    nodes.forEach((node, i) => {
      const tags = tagsOf(node);
      if (!tags) return;
      const position = i === 0 ? 'start' : i === nodes.length - 1 ? 'end' : 'inside';
      for (const s of townSignsOf(tags)) signs.push({ position, node, ...s });
    });
    return signs;
  }

  // ===========================================================================
  // Tag text box (iD's raw tag editor, text view)
  // ===========================================================================
  // iD writes one "key=value" per line; values with special characters are quoted
  // JSON strings (stringify/unstringify in iD's raw_tag_editor.js).

  /** @param {string} s */
  function unstringify(s) {
    if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) {
      try { return JSON.parse(s); } catch { return s; }
    }
    return s;
  }

  /** Tags in the text box, as iD reads them. @param {string} textValue @returns {Tags} */
  function parseTagText(textValue) {
    /** @type {Tags} */
    const tags = {};
    for (const row of textValue.trim().split('\n')) {
      const m = /^\s*([^=]+)=(.*)$/.exec(row);
      if (m) tags[unstringify(m[1].trim())] = unstringify(m[2].trim());
    }
    return tags;
  }

  /**
   * Sets key=value in the text: replaces the one existing line of the key or
   * appends a new last line. Every other line stays exactly as it was.
   * @param {string} textValue @param {string} key @param {string} value
   * @returns {{ text: string, changed: boolean, old: string } | { error: 'duplicate' }}
   */
  function setInTagText(textValue, key, value) {
    const lines = textValue.replace(/\s+$/, '').split('\n');
    if (lines.length === 1 && lines[0].trim() === '') lines.length = 0;
    /** @type {number[]} */
    const hits = [];
    lines.forEach((line, i) => {
      const m = /^\s*([^=]+)=(.*)$/.exec(line);
      if (m && unstringify(m[1].trim()) === key) hits.push(i);
    });
    if (hits.length > 1) return { error: 'duplicate' };
    if (hits.length === 1) {
      const old = unstringify(lines[hits[0]].slice(lines[hits[0]].indexOf('=') + 1).trim());
      if (old === value) return { text: textValue, changed: false, old };
      lines[hits[0]] = `${key}=${value}`;
      return { text: lines.join('\n'), changed: true, old };
    }
    lines.push(`${key}=${value}`);
    return { text: lines.join('\n'), changed: true, old: '' };
  }

  /** Same tags? @param {Tags} a @param {Tags} b */
  function sameTags(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => b[k] === a[k]);
  }

  // ===========================================================================
  // Geography: countries along a way, Belgian regions
  // ===========================================================================

  /**
   * Country (or region) codes along a line and on both sides of it.
   * @param {Array<[number, number]>} points  [lon, lat] along the way.
   * @param {(lon: number, lat: number) => string} at  Code at a point ("" = none).
   * @param {number} offsetM  Distance of the side samples, in metres.
   * @returns {{ codes: string[], sides: { left: string, right: string } | null }}
   */
  function locateAlong(points, at, offsetM) {
    const centre = new Set();
    /** @type {Map<string, number>} */
    const pairs = new Map();
    let differing = 0;
    points.forEach(([lon, lat], i) => {
      const code = at(lon, lat);
      if (code) centre.add(code);
      if (points.length < 2) return;
      const [ax, ay] = points[Math.max(0, i - 1)];
      const [bx, by] = points[Math.min(points.length - 1, i + 1)];
      const cos = Math.cos((lat * Math.PI) / 180);
      const dx = (bx - ax) * cos, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (!len) return;
      // Left of the direction of travel: (-dy, dx).
      const nx = -dy / len, ny = dx / len;
      const dLon = (nx * offsetM) / (111320 * cos), dLat = (ny * offsetM) / 110540;
      const left = at(lon + dLon, lat + dLat);
      const right = at(lon - dLon, lat - dLat);
      if (left && right && left !== right) {
        differing++;
        const key = `${left}|${right}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    });
    if (differing && differing * 2 >= points.length) {
      const [key] = [...pairs].sort((a, b) => b[1] - a[1])[0];
      const [left, right] = key.split('|');
      return { codes: [...new Set([...centre, left, right])], sides: { left, right } };
    }
    return { codes: [...centre], sides: null };
  }

  // BEGIN GENERATED REGIONS
  // OSM data 2026-10-26T08:27:10Z, simplified to 20 m. © OpenStreetMap contributors, ODbL 1.0.
  /** Region → rings, each "lon,lat;dlon,dlat;…" in 1e-5 degrees. @type {Record<string, string[]>} */
  const REGION_RINGS = {
    "BE-VLG": [
      "565399,5082008;502,-160;417,-41;109,-88;246,6;-34,-42;126,-29;43,120;137,11;22,-60;308,-30;42,-95;511,47;18,-140;94,-33;32,-164;81,-104;115,8;124,99;144,29;16,-59;141,-34;6,-27;93,9;-3,-24;99,-15;-78,-199;102,-193;-54,-76;58,-138;-97,-176;-125,-22;-228,60;-338,191;-403,-47;22,-67;-239,-10;-51,68;12,105;-68,88;-224,-43;71,-140;-183,-32;-131,-87;-972,68;8,30;-238,13;-17,-87;-295,46;-215,-288;-67,-36;50,-37;-136,-151;177,-97;-546,-662;-877,-609;-84,-45;-445,-51;-339,-179;-93,-68;53,-31;-117,-60;-127,64;-120,18;-55,-90;-336,147;-40,-49;-83,46;-62,-50;-167,84;-13,-30;-106,53;-497,-335;-36,20;-403,-202;156,-127;83,47;131,-85;-97,-64;147,-143;-34,-20;-323,204;-60,-31;-54,31;-207,-147;-112,101;-827,-328;11,-34;-116,88;-217,-68;22,-19;-75,-50;228,-197;-137,-62;-256,218;-96,-52;-72,64;-165,-112;-40,22;-46,-40;-100,38;25,30;-61,29;-313,116;-183,-117;-373,-36;-68,-68;-66,-1;-64,-156;-62,15;-13,-26;63,-16;-37,-87;22,-88;-79,10;-12,-57;-81,31;-70,-70;-45,-165;29,-69;-265,0;-124,-38;-361,56;-6,-29;-105,-5;-479,82;-76,-125;-281,45;-171,-369;-155,21;-11,-72;-88,6;-30,-74;-72,-31;-326,-47;-315,-8;-297,59;-279,-15;-287,32;-59,-90;59,-119;-191,7;-41,56;-149,56;-128,-23;-25,92;-93,41;-183,-48;-196,-10;-98,-220;117,-119;-136,-98;-68,5;-134,-226;78,-22;138,-118;-188,-133;77,-81;-85,-33;60,-52;-91,-46;527,-361;-88,-58;69,-68;-181,-87;-59,61;-156,-133;-170,103;-578,-354;-397,-198;-1470,-567;-189,-128;-129,-185;-212,8;-532,-113;-214,-81;-287,-207;-452,238;152,149;-89,69;96,163;-2,382;-267,152;-198,-24;-346,172;39,47;-47,40;-42,168;-497,-30;50,-203;-249,-36;114,-152;193,-432;-328,-116;-284,-160;-57,-131;-197,65;-105,-143;129,-81;-230,-175;238,-144;-160,-82;-388,-74;-22,37;-82,-12;-34,102;36,11;-55,34;-494,32;-6,-41;-252,12;-45,8;-20,58;-203,-148;-191,109;-67,-86;24,-14;-289,-307;-95,234;-331,273;-509,-327;-106,56;-34,-24;38,-24;-141,-97;-415,168;35,32;-133,46;82,135;-644,134;-120,66;49,42;-107,62;28,35;-30,50;-332,14;5,43;-99,9;-26,64;-121,3;46,356;-100,360;-114,-18;-140,34;-268,9;-206,-61;-70,37;3,157;-91,171;46,112;-67,393;-199,331;-110,111;-716,-285;-638,-308;-141,183;-278,229;-182,51;-128,-10;-73,40;-1774,-58;-1660,-1090;-869,-325;-875,-399;-240,100;-444,-477;-132,-67;196,-271;-101,-62;127,-131;-51,-70;-70,-45;-106,19;-74,-79;-30,68;-83,-9;-30,-79;-183,-78;-14,-50;-253,205;-175,209;104,53;-142,131;-137,-72;-59,45;80,43;-157,150;-128,-61;-96,133;-230,-47;-75,136;-147,-64;-72,51;-80,-42;-115,18;-58,-73;-218,66;47,53;-178,62;42,42;-209,93;36,27;-539,152;0,-135;-38,-27;-50,39;-30,-16;-126,-149;-389,-46;33,-293;-171,-9;19,-26;-199,-114;38,-30;-275,-135;46,-17;-80,-69;68,-30;-75,-53;106,-24;-347,-129;-193,6;-192,-55;-31,-80;-221,5;-1180,158;-231,-3;-306,471;78,133;-97,143;-97,303;-252,-316;-60,-180;26,-105;-186,-224;-224,-94;-97,-23;-20,25;-92,-40;-354,314;-1049,9;-175,-92;-234,92;-323,9;-90,-6;-17,-39;-143,8;-89,-78;-567,-97;-332,-235;-304,38;24,72;-188,51;-63,99;-324,55;22,26;-164,89;-101,-79;28,49;-28,13;-51,-33;-190,136;-80,-72;-122,47;-219,103;44,101;-157,20;-10,-174;-60,-85;-486,144;-46,-72;90,-25;-122,-141;148,-43;-236,-253;-48,-68;70,-39;-88,-54;132,-132;642,30;-11,-182;123,-101;-47,-14;351,-441;53,-94;-80,-21;76,-65;36,16;60,-71;-651,-439;-392,-159;-576,-332;-246,15;-589,267;-578,-284;-191,-5;-413,189;-550,155;-447,251;-59,-37;-223,74;121,194;-465,81;-165,84;65,76;-794,218;-40,-36;-61,28;-121,-106;-483,136;-214,23;-163,101;-304,-14;-352,-106;-72,-72;9,-259;-112,36;-75,-67;-84,10;-276,-167;-396,59;-358,217;-188,54;-329,-133;-178,276;-599,98;-500,-259;-187,152;119,68;-210,125;-170,30;-283,330;237,109;-59,33;-52,-31;-86,65;-82,-24;-48,82;-264,-87;-55,116;-253,-45;-816,598;-428,179;242,184;-98,43;131,102;-52,164;-90,59;166,229;-455,279;320,163;24,41;-79,62;303,232;-694,274;12,28;-452,90;-189,119;-53,79;-112,-54;-70,93;-247,156;-851,344;-204,43;13,34;-230,242;-148,284;-165,148;-189,110;-358,336;-387,245;75,62;-35,18;-48,-33;-146,74;-135,-81;-153,67;-139,-4;-539,132;-607,200;-589,67;-1,-125;-331,-25;29,-230;-277,-4;-115,121;-288,75;-227,-25;-110,-41;84,-493;-360,-10;-105,-90;-50,15;-77,-51;84,-26;-127,-124;-605,-389;-156,-77;-42,33;-158,-33;-37,-220;78,-164;-631,-139;-484,-50;-371,-170;-567,34;-373,-21;-87,-30;91,-223;-206,-87;-205,-140;-248,257;-332,252;-397,149;-200,57;-211,8;-509,-45;-33,29;316,463;186,136;-207,64;-291,212;-365,201;480,434;-51,69;-147,33;316,328;-28,36;-307,-100;-294,-45;-54,58;-159,2;-56,45;46,108;-29,241;-78,-2;-26,85;-47,-135;-214,-140;-160,-1;-156,-165;64,-77;-82,-37;-12,-158;-61,-13;-29,-55;-83,5;-92,-61;-70,25;-172,-190;-74,28;-130,-93;-194,131;-131,-78;-437,239;-74,48;37,29;-74,36;-354,-245;-175,51;-235,139;-673,-159;-147,-82;-588,256;-9,45;-132,-6;-195,-156;-226,167;-287,108;-96,-116;-725,-377;-322,-31;-324,417;-72,351;56,89;77,25;151,-33;451,164;-221,143;88,28;-37,40;-82,-10;-80,130;-292,-68;-68,-105;-103,-14;-227,288;-190,0;-349,-104;-216,-21;-491,55;-367,-30;23,127;-310,349;-193,594;-326,87;-108,147;-253,113;-49,239;-358,270;-581,326;-515,120;-116,-51;-213,30;-1548,435;-158,-64;-163,-23;-151,-71;-157,203;-36,216;-623,-28;-519,82;-101,-13;-190,-163;-67,-4;-218,-136;-86,-21;-28,27;-137,-11;-125,29;3,-92;-91,-19;39,-60;86,27;37,-64;-73,-27;-25,27;-89,-15;-43,45;-108,-28;89,-134;-139,-64;-166,155;-213,-40;-198,137;-41,-20;-79,40;-199,-86;-70,99;-111,-86;27,-21;-169,-95;208,-141;-68,-46;44,-24;-8,-42;219,-81;-192,-83;-168,-134;-43,20;-433,-269;150,-102;-232,-192;-202,-19;-107,-104;-257,202;-95,164;-5,62;141,83;-148,161;-135,56;-107,-278;-317,-122;-312,-187;-77,41;-107,-59;-172,-23;-73,-54;-402,108;-99,-54;159,-20;69,-56;-29,-24;-203,5;-216,-83;25,284;-77,95;-122,-66;-251,-35;-44,99;77,86;-207,213;-109,-203;-248,52;-75,47;-16,-22;-152,12;-178,-65;-145,75;-76,110;-128,49;-53,-86;58,-58;-10,-51;-77,-140;-225,30;-8,80;-58,6;-60,-58;-53,30;-122,-42;-80,21;-51,-73;-222,31;-152,81;-388,12;-253,90;-512,257;-119,-32;-113,132;-456,43;45,39;-182,79;-8,-27;-124,-3;-54,-56;66,2;107,-102;-36,-25;126,-223;-7,-155;59,-32;37,-85;149,-100;37,-88;-40,-434;-109,-5;-35,-244;-86,7;-108,-314;2,-163;-370,-25;61,-81;-138,-112;-127,-1;-22,-43;42,-73;-72,-50;219,-31;26,-34;-140,-25;-46,-79;-82,19;-52,-112;145,-96;88,2;153,-114;2,-54;89,-19;4,-48;72,-8;-26,-66;-103,-27;122,-69;63,-111;200,-78;-1,-56;103,-108;-22,-65;64,8;45,-40;-56,-45;53,-159;98,-48;11,-133;158,59;65,-75;53,-6;264,83;175,-82;102,-141;-79,-96;53,-40;-34,-73;34,-53;-54,-13;-67,41;-22,-35;-79,4;-121,72;-63,-12;-77,-65;85,-52;-27,-50;173,-88;-23,-38;-281,-90;-230,60;-248,-264;197,-103;-199,-113;-125,-143;-213,-73;-236,107;-50,-88;11,-78;-378,-142;-45,-59;-95,41;3,30;-353,-54;-88,45;-111,-68;-232,161;-362,-59;-26,33;-153,-48;-85,61;-102,-45;-856,-121;-115,-63;-17,26;-345,-98;-179,99;50,58;-223,96;-326,207;102,79;-72,106;118,25;-42,243;180,173;-4,364;-148,93;-178,252;63,29;44,97;6,80;-69,102;22,54;-131,97;-48,-36;-106,55;-27,-39;61,-27;-23,-44;-106,63;31,-67;-131,-20;-148,-120;-250,13;-42,39;-35,-48;-170,-35;-18,-75;-69,28;-17,-71;-113,49;-64,-96;-129,0;-119,-128;-156,0;-81,-112;-56,16;20,43;-53,29;-12,-90;258,-272;-371,-260;-356,-309;187,-115;-406,-28;-237,22;13,59;-117,48;-177,43;-74,-41;-31,20;-103,-98;-60,8;30,-177;-90,2;34,-46;-76,-11;24,-33;-69,-13;-26,-33;41,-15;-58,-33;-268,92;-18,167;-278,218;-347,-214;-332,-117;-144,-85;-213,-39;-347,-212;-500,-135;-338,-170;-146,-12;-55,72;-228,121;-486,-243;741,-480;-93,-82;-112,-42;142,-113;-778,-400;-70,9;-20,115;-57,-53;-109,-11;-26,78;-71,23;-75,-64;-34,54;-94,-20;-15,65;-75,26;-42,2;-49,-52;-221,37;42,27;-47,9;6,46;-448,116;-14,-26;-34,28;147,7;34,76;131,-3;-52,18;35,31;-59,60;-90,15;24,61;-135,-15;-89,71;81,24;-5,57;-247,0;7,36;-44,3;13,102;-316,-3;15,51;-150,-18;-211,130;150,89;-28,17;67,45;-165,103;206,166;-42,30;58,27;-48,34;-157,63;-93,2;-230,-306;-94,32;-148,-108;-313,276;960,1070;-325,94;-413,233;-186,-259;-106,45;-105,-106;-482,-209;-284,272;-229,-308;-401,120;-516,-89;-164,93;-110,-13;-48,131;-152,65;-159,-63;-120,125;-243,-99;-2190,-1198;-1508,-622;-2783,-205;-58,125;-231,-77;-212,-223;-77,9;-252,-74;-482,-9;-729,-142;-409,-50;92,-1323;-859,62;-1263,-175;-1150,1689;-194,205;-305,-31;-60,55;-176,-112;-19,-75;-279,-223;-105,-140;-121,-20;-152,82;-207,-49;145,-405;-153,-125;157,-34;154,67;156,27;329,165;203,202;24,-14;-143,-218;25,-120;-48,-11;-54,50;-97,-399;453,-413;-56,-41;25,-81;-29,-16;-31,41;-71,-37;90,123;-278,8;-342,181;-129,-326;-66,25;-348,451;-141,-13;-283,43;-114,110;-45,-188;-344,84;-50,-143;8,-138;-66,-76;18,-133;-70,-81;-76,-17;24,-38;-73,-57;13,-83;59,-2;-19,-26;54,-62;-55,-17;-13,-102;-118,-75;-188,-337;27,-148;133,-131;135,-69;-318,-267;-201,-87;-305,-1;-517,-215;-374,-212;-365,-102;-249,137;-67,136;-86,59;-186,69;-161,-12;-361,90;-322,40;-174,-13;40,56;-24,42;-194,-36;-16,27;-175,-43;32,-82;-104,-9;-356,55;-223,55;-5,23;-247,42;-561,-490;-686,-427;-117,-144;-130,-42;-658,151;-48,157;-170,171;-652,464;-391,61;-337,106;-81,60;-257,93;-892,513;-279,92;-415,88;-200,-51;-889,-56;-87,29;-554,3;-415,-51;-133,-105;-486,858;-79,107;-177,107;-262,426;-325,91;-99,77;-260,7;-87,29;-161,111;-58,192;-141,33;-81,64;-291,65;-56,75;-401,-43;94,-110;302,8;103,28;66,-51;-321,-52;-178,-107;-22,-105;-483,168;58,178;-251,-15;-371,90;-118,-131;-41,-111;-57,1;-66,-155;26,-71;158,-109;-463,-347;-43,-104;-104,-40;-91,-225;-52,63;-178,30;-816,-209;-282,-114;-232,-20;-197,-73;-348,57;-133,-61;-71,118;72,45;-73,98;18,131;-252,-52;-67,-133;-454,-342;-100,-165;-539,-190;312,-193;-146,-44;-122,78;-42,-20;-136,50;29,30;-314,127;-242,-105;-528,483;145,128;-54,29;-171,-118;20,-18;-119,-38;-590,-16;5,-39;-391,-44;-195,98;-403,-452;-49,-134;-876,-1151;-87,42;-53,74;-293,529;-98,79;-204,24;-376,-26;-1008,-435;30,-22;-525,-240;-75,-76;-237,2;-54,23;-86,-38;-64,32;-179,16;-96,-28;-550,122;-208,-126;-108,53;-85,125;-136,28;-119,233;28,51;-147,-18;-139,78;-196,-152;-464,-105;-251,-115;30,-32;-182,-83;-74,-92;-96,-52;-74,0;-221,-150;-196,-228;-212,-146;-341,-48;-647,115;-568,-13;-382,214;-949,-131;-298,35;-257,-61;-263,49;-69,63;-272,41;-607,7;-67,24;-153,-44;-33,-64;-209,-41;-385,118;-418,-100;-152,167;94,203;-219,63;56,115;-234,51;-138,-7;-1,-145;-212,-31;53,-61;-31,-65;-134,61;43,95;-75,2;-284,-115;-54,35;-138,-91;-238,96;-57,-40;25,-76;-114,-79;-127,-10;-188,138;-50,-11;-2,30;129,308;249,291;-216,94;-111,91;-86,136;-152,49;-226,211;-195,82;32,121;-116,8;-118,134;5,296;-444,-183;-184,161;-100,-11;-171,-90;-245,25;-87,157;0,124;60,54;-9,178;213,265;42,255;233,358;26,270;159,91;40,167;-308,72;179,312;-180,42;-133,163;654,207;-141,138;-64,-8;-196,212;-65,-14;-20,87;-127,123;-348,157;83,138;-59,19;-226,282;-119,83;-646,216;-303,-175;-352,-49;-32,16;-240,-138;-325,118;-95,-124;-420,188;-69,109;-72,-33;-69,-113;-65,-6;-99,180;-69,42;-25,-146;124,-183;-51,-64;-128,-19;-103,185;-48,-78;26,-109;-392,135;-9,-36;-330,-229;-446,-61;-376,-325;-176,-93;-341,198;-598,-113;-121,93;-340,117;-321,48;-235,-14;-177,169;-89,362;-67,73;-197,-88;-265,52;-841,-19;-639,-64;-364,-86;-373,-3;-260,-72;-146,60;-104,-8;-104,58;-283,-70;-169,-87;-134,91;-100,-46;-347,434;0,55;95,40;0,89;-108,51;-143,9;23,99;-243,164;23,55;-182,97;-110,-4;-172,166;-183,43;-105,66;-105,105;-15,236;-166,214;22,103;-538,344;54,186;196,153;182,38;115,141;72,204;-76,168;-193,-128;-381,-109;-437,-372;-416,64;-64,-39;-163,14;-193,-219;-217,-109;25,-123;-205,36;-365,-8;-122,89;-958,-182;-578,-164;-193,3;-94,137;-150,121;306,253;-296,124;-180,-38;-79,75;147,339;249,163;31,63;-314,152;-549,-302;-326,-239;-374,-216;-50,-84;-104,19;-186,120;-287,-54;-267,37;-21,-120;-375,-250;-235,177;-229,-144;-190,98;-64,-159;-256,-201;233,-167;-786,-306;279,-251;-109,-44;233,-54;-110,-130;66,-45;-492,-351;-153,-74;-240,-40;-439,29;-37,-60;51,-14;37,-280;-161,-196;20,-199;-1189,-618;-480,-286;48,-53;19,-145;-125,-356;-45,-872;-86,-127;-398,12;-310,-23;-254,-118;-191,44;-186,98;-108,-32;-230,41;-166,127;-158,21;-147,154;-391,210;-88,172;52,46;-38,79;-205,48;-8,31;-105,26;-80,61;-225,-47;-73,46;-91,3;-284,-51;-149,36;-400,28;-577,-256;-124,-41;-181,-2;-108,-52;-184,11;-188,86;-304,-25;-362,66;-140,-32;-51,-43;-213,5;-553,-146;-224,68;-148,120;-110,-22;-250,283;-155,148;-56,12;-347,51;-224,-62;-174,-3;-34,-74;-242,-61;-379,-30;-323,42;-40,26;30,58;-96,66;315,346;154,60;-36,70;155,415;2,190;-56,161;197,42;-921,1021;-67,199;277,348;-169,134;-542,61;-523,-72;-529,-123;-321,-172;-433,-64;-233,-78;-265,-18;-144,-78;-324,-5;-350,37;-218,-30;-175,-95;-124,-24;-490,14;-354,97;-606,44;-206,-38;-229,35;-41,29;21,51;310,147;-242,87;-44,61;-320,-189;-581,185;-270,191;-698,-292;-36,40;67,166;-91,76;19,154;-311,129;57,333;-128,52;-85,-38;-58,-92;-41,-458;78,-72;255,-47;48,-65;-210,-227;-216,-102;3,-31;143,-68;-20,-80;-163,-47;-246,39;-147,-84;-487,-61;-106,153;-393,22;-281,-113;-65,-59;21,-80;254,-43;102,-57;-22,-54;-218,-35;-284,65;-132,172;-115,-8;-85,-96;12,-89;61,-43;201,-51;11,-42;-84,-68;-15,-63;83,-106;140,-72;12,-43;-232,-155;-82,4;-139,80;-366,-106;-46,-41;52,-61;-24,-36;-383,-74;-277,-17;-561,92;-478,25;-251,-19;-209,-75;-187,-165;-1,-93;63,-102;-152,-213;19,-26;157,-12;31,-52;-221,-123;-113,-150;-184,-41;-22,-128;-85,-136;144,-96;-11,-57;-461,-42;-150,17;-52,-31;38,-56;212,-87;-55,-63;-117,-26;-319,12;-402,-105;-1246,-53;-474,-173;-64,-243;-393,-289;-93,-127;33,-50;207,-49;-217,-221;-235,-147;-51,-66;-39,-456;-249,66;15,23;-547,218;-248,60;14,43;-134,7;-33,196;-51,-38;-65,16;-57,-30;-365,76;-156,158;-128,-56;-79,38;-143,-43;-30,33;-177,-24;-32,74;-96,-19;-51,71;-691,415;-167,34;-196,-35;-18,84;142,90;386,689;-105,30;-15,66;-290,126;6,57;-78,67;-65,2;-43,56;-36,71;146,67;-167,62;25,71;32,-7;106,97;-81,8;-265,191;-53,78;-375,298;-441,472;-647,554;-450,-145;-404,-32;-260,-205;34,-75;-283,-75;-16,42;-131,-19;-178,24;27,187;-518,25;-170,-6;-460,-112;-1260,-16;-135,56;-474,60;-349,160;-277,85;-315,170;-132,152;-748,-101;-64,157;-260,109;-248,171;-445,238;-175,55;-101,131;-116,-12;-111,29;-110,-44;-153,61;-130,-43;-89,95;-96,-19;-462,-225;-245,-174;-714,-111;-988,-360;-362,-89;-88,-57;-47,51;-107,-8;-245,120;-181,151;-225,-266;-178,-72;-455,129;-30,-25;-509,229;-15,52;53,52;-26,258;-231,206;-231,148;-170,168;-228,376;-244,248;-69,14;-475,435;-381,537;64,168;165,39;-144,142;30,97;-47,73;-138,132;-199,11;-1697,-324;-164,-4;-159,-60;-116,2;-11,36;-192,-8;-91,214;-270,201;-162,29;-238,151;-215,56;-60,128;-229,8;-201,-88;-322,-526;-9,-49;152,-41;6,-81;-310,-426;-540,-289;-550,-149;-255,-180;-204,9;-37,-69;56,-141;-199,-111;-518,-54;-234,34;-545,262;-1382,501;-395,23;-580,-110;-217,-170;-428,-44;-472,-162;-242,-244;-106,-218;-141,-97;-280,-57;-379,94;-251,103;-47,-23;-2,-75;-134,-1;-578,297;114,135;52,2;105,100;-18,43;124,76;57,-17;176,86;53,-6;162,65;217,8;51,41;-32,110;-118,26;-137,-32;-113,95;-176,63;-124,95;-164,30;-98,-44;-164,-21;-78,78;-239,90;-190,-41;-44,28;-23,41;95,124;-104,96;39,57;-11,140;46,93;118,72;-367,252;-242,272;46,285;227,220;373,246;-364,469;-528,135;-176,-78;-62,61;-110,-25;-263,242;-1054,-424;-769,-223;-67,-41;-448,-81;-869,-69;-262,-70;-541,-405;-312,-53;-50,32;-339,-12;-434,-249;-166,-28;-481,2;-491,-98;27,-51;959,-209;412,-375;216,-271;231,-121;-18,-43;243,-81;44,-86;87,-54;5,-94;116,-33;-27,-78;34,-78;-45,-6;34,-43;-101,-105;49,-22;-61,-9;-5,-43;-43,6;125,-215;-1120,-74;-381,-66;-1026,-372;-1593,-442;-100,-124;69,-193;319,-222;86,-136;-206,-40;-29,23;-235,-79;-142,8;-333,-94;-220,-3;-1048,-122;-318,-125;-257,-16;-180,53;-507,34;-112,49;-144,299;-200,61;-354,227;-147,158;-240,-37;250,-352;70,-288;-55,12;-74,-59;-154,-10;-82,38;-72,-19;-414,18;-88,546;-872,-188;-145,-57;-462,1;-129,-225;-44,-31;-51,26;-102,-119;-523,-86;-432,-171;265,-311;128,-99;92,-26;100,-98;480,-577;-404,-93;-175,-159;-67,24;-174,-159;-227,-85;403,-501;451,-353;205,-272;373,-245;102,18;38,-70;213,22;165,-303;255,-262;535,-299;-404,-336;-247,-141;-452,280;-15,105;-476,341;-231,392;-327,356;-761,-165;-57,-82;-1039,-83;-116,-84;-220,-22;-346,-85;-347,-230;-349,167;-15,46;-236,-63;-126,84;-137,-39;-372,283;-41,-34;-250,103;28,50;-155,43;28,30;-292,83;28,51;-135,37;-36,-38;-87,18;-321,116;78,92;-180,53;-57,-63;-125,48;-66,-70;-93,28;15,22;-66,21;171,196;-194,72;101,277;-324,101;3,58;-179,284;26,10;-87,74;-315,651;197,85;-63,172;41,6;-67,273;33,274;-223,-73;-283,-23;-174,275;-100,-66;-257,247;-503,-79;-170,33;-436,454;233,188;-82,179;-78,-9;-24,60;-446,-110;-111,41;218,394;332,406;-78,126;-424,213;-268,65;-76,228;-313,154;-502,119;-151,76;-189,41;-84,83;-285,-121;-106,240;-681,513;-130,180;70,204;-42,38;-198,39;-125,-26;-222,537;-109,119;-13,220;-141,114;209,158;-50,27;40,104;83,25;-31,25;60,27;-97,111;134,51;-25,21;136,120;-181,158;-165,-19;-95,104;-180,56;-84,112;-76,36;-253,31;-71,63;-70,-17;-115,110;-240,-72;15,-106;-666,-10;-1063,54;-490,-49;-964,-8;-37,151;-386,353;29,92;-575,327;-92,-105;-48,-186;-411,-206;-149,-134;-607,-275;-2111,-69;-351,482;-193,428;-231,584;-60,444;-122,439;-201,40;-131,118;-179,64;-164,-84;-121,60;-117,120;56,34;-39,75;67,17;-5,89;-161,189;60,54;-50,44;34,251;71,58;-416,103;-127,132;-393,-107;-384,-147;-66,129;-270,-57;-13,39;-98,4;17,59;-56,77;72,139;-63,67;30,65;75,36;199,256;57,7;20,-37;126,82;2,62;62,57;-39,54;26,31;91,0;345,187;93,64;2,91;111,76;-25,22;65,-2;31,51;80,11;-36,49;46,21;-8,120;-53,33;53,23;-53,91;83,41;-75,27;107,-2;-89,61;-112,10;-165,158;11,72;-69,2;40,55;-40,81;-93,-20;25,85;-59,12;-4,59;-77,3;-48,66;39,42;-15,130;94,27;65,152;83,10;-12,28;126,99;-8,98;66,19;-87,48;22,30;-45,33;87,6;-72,39;-94,-17;-13,44;-116,10;7,47;-89,15;74,43;-60,70;55,67;-11,171;-255,-3;-23,35;65,140;83,29;122,244;-94,28;4,69;47,-5;59,87;41,1;102,175;73,25;19,43;-50,46;52,48;-97,111;57,19;30,124;-66,39;-29,-19;-180,28;-114,186;126,131;-78,52;-4,83;-203,141;86,174;245,184;83,188;-163,99;132,85;-21,84;-273,142;-99,244;-97,12;-352,-156;-177,-10;-310,-71;-216,101;-131,248;-71,44;-3,63;15,31;183,42;362,159;156,112;164,210;146,57;238,241;325,123;290,173;-25,49;393,122;-24,42;145,27;25,-38;364,229;19,196;129,26;-93,211;-121,142;64,25;13,70;232,3;27,32;104,-16;207,65;136,-2;182,57;122,-19;223,65;268,291;-247,356;-173,82;-238,468;3,136;-158,117;-80,145;-144,122;-130,240;-32,131;29,57;-189,166;8,99;-332,299;-521,323;164,111;-244,202;83,87;-238,163;71,217;-254,62;165,203;176,128;-219,214;-100,175;8,197;-368,38;-197,-20;-620,76;-1084,446;-509,264;-335,236;-71,129;-120,41;137,272;-352,238;-83,212;127,242;-11,50;379,44;-1395,4457;86,649;-353,461;10,118;-1361,1791;-445,516;2039,577;2096,716;1821,678;1128,371;866,432;-91,63;-420,10;-163,31;-263,106;-23,51;48,46;107,-2;170,-58;187,58;182,-59;553,170;694,55;714,327;1011,384;316,165;680,236;1195,372;308,14;212,41;2917,897;211,41;1123,455;-108,30;148,114;94,-55;251,118;326,96;1043,232;737,296;403,123;473,221;300,67;745,290;2735,1092;3355,1401;2528,995;932,454;876,348;1770,875;1809,793;490,266;731,469;-18,68;211,245;366,126;316,15;70,-20;255,-207;511,149;1789,751;382,119;1283,523;1368,587;917,340;1007,466;3079,1300;1366,648;2511,1090;739,438;1112,378;1160,344;400,179;550,141;-41,28;208,34;20,-17;866,285;688,117;887,307;640,138;480,48;905,253;-24,106;580,244;304,162;256,185;319,305;177,227;205,527;-302,529;-5,169;82,150;1291,862;348,151;1191,64;2179,-270;227,-96;171,-159;285,-742;95,41;-48,325;203,154;178,31;504,-190;418,-213;799,-331;181,-49;407,-26;1338,201;1705,502;2613,596;2191,400;1319,305;699,41;304,78;535,200;177,137;1178,-1381;-128,-466;36,-572;944,-730;183,-709;-2696,-1914;1846,-1253;124,20;-632,-256;-435,-49;-167,-139;119,-273;336,-354;195,-112;669,-230;187,-156;18,-81;-59,-166;47,-128;102,-95;-15,-63;-85,-86;-115,-48;-248,-26;-129,-55;-58,-79;21,-124;137,-148;205,-118;492,-95;230,9;175,-74;97,-199;568,-586;210,-124;485,-92;177,-84;145,-128;154,-335;94,-69;174,-36;244,24;138,66;227,202;173,43;88,-98;5,-99;70,-58;309,-82;321,-254;71,-460;200,-484;484,95;933,-242;274,-46;4,-62;385,-62;2637,112;5294,343;45,31;-489,1656;-774,2425;1374,158;452,-525;444,18;207,161;214,273;111,319;638,-10;249,-132;274,-14;74,20;72,97;156,38;170,426;288,41;356,-124;28,-83;546,-183;-43,-90;208,-169;258,-117;160,62;199,4;40,-89;165,-106;207,197;-129,189;80,148;454,71;-402,307;-52,1;-229,230;473,334;418,427;177,-61;-96,-92;2184,-648;207,-21;60,-65;332,-122;56,-161;202,-148;448,57;517,-177;45,-53;117,-3;798,-287;278,55;115,142;1369,8;1866,-713;115,-253;466,56;736,-48;379,-453;1856,-390;663,-64;38,103;401,76;368,-23;2476,-394;69,110;331,-92;292,-330;125,-53;-27,-51;285,-321;687,-194;364,203;73,209;53,-8;382,-139;735,-400;1004,-245;-601,-1025;-100,-1929;123,-669;-16,-366;162,-215;275,-18;318,-87;221,-210;171,-28;399,-46;-94,308;198,18;26,-76;429,15;1021,-353;364,1;69,-32;63,78;118,-35;733,267;211,177;249,-34;337,-133;338,86;404,-126;276,149;370,-216;346,-23;255,157;803,386;1840,676;480,-436;-311,-466;-739,-383;-409,-147;-113,-69;207,-198;456,-243;209,-344;117,85;320,75;248,106;5,44;83,18;95,-7;378,-165;126,13;91,76;400,128;657,156;379,272;128,6;201,-46;-263,687;74,25;179,-5;110,223;582,4;397,315;391,-577;265,-260;716,173;-52,109;402,80;256,0;397,96;539,-66;126,214;138,114;36,113;166,34;53,46;-12,215;66,78;1202,140;144,-32;117,34;179,206;39,129;93,35;418,509;183,-92;40,6;416,312;705,139;10,135;309,171;822,316;369,103;73,-56;545,87;267,-215;89,-172;302,104;129,22;32,-20;328,74;294,139;-34,30;154,69;136,-115;198,-308;47,12;20,-25;1429,158;319,54;374,112;235,296;730,272;-79,50;643,178;154,108;823,370;19,36;311,110;15,46;86,-6;-8,74;144,-19;12,47;66,-3;7285,3274;7592,6108;-1530,579;-468,475;-214,381;-235,557;8612,307;3081,68;661,-2004;254,11;524,97;189,-1;9,-41;1586,-98;143,-121;173,62;875,-174;549,31;43,-89;485,95;458,36;474,121;2311,834;950,-138;-153,352;-207,231;-267,161;661,376;-4008,3312;-795,1291;606,338;81,-19;80,308;387,-45;21,76;-86,38;15,81;-47,87;44,182;-236,-8;25,134;465,-120;161,364;-340,27;26,115;-43,1;-7,158;31,152;156,114;-41,111;-461,436;-419,-108;-17,25;-103,-31;-732,151;49,101;168,57;122,190;213,-91;5772,1937;1449,113;766,119;200,100;180,209;314,222;431,182;414,15;669,-95;5139,506;990,-901;-1818,-2387;551,-2649;3932,982;747,-89;29,-58;576,-2;0,-22;4184,-522;385,-84;353,-206;382,-101;58,67;478,72;-1,54;77,45;80,-10;20,40;-40,18;137,53;-18,50;79,31;-31,26;79,-8;125,50;200,-106;270,-84;504,53;301,64;522,20;-310,1804;1423,493;165,29;397,165;666,46;621,824;9,97;343,370;123,83;-126,60;45,90;1365,189;-87,226;256,113;-22,41;223,79;-39,22;894,1024;1741,559;27,120;287,366;30,107;-106,125;376,313;256,73;307,-39;161,221;1382,275;503,-62;215,-44;-24,-46;74,-44;-51,-15;-14,-47;85,6;34,-24;-30,-54;60,-5;37,-52;-52,-48;89,-3;-30,-52;40,-69;189,22;107,-92;125,-11;104,33;244,-90;133,51;55,-22;121,130;97,17;47,-38;122,-9;138,38;105,-26;168,-106;91,2;78,-97;48,-12;30,41;53,5;97,-31;121,20;-12,-34;98,-51;107,-28;50,25;154,-93;396,-51;128,-46;157,-94;94,-112;65,-188;-60,-66;-20,-140;279,-298;26,-175;67,-119;369,-89;388,-38;637,35;257,-19;423,-122;-155,-221;-64,-572;-116,-138;-167,-341;-75,-677;229,12;562,-230;-267,-230;-288,-72;-63,6;-87,68;-176,195;-181,-134;-235,-347;-131,-102;4,-65;-158,-92;38,-46;-522,-226;256,-1258;-94,-11;-10,-62;373,-1156;-44,-155;118,11;84,-111;205,-51;99,7;3,-43;77,15;42,69;49,-27;40,28;62,-32;19,32;50,0;94,-35;67,90;155,19;102,65;64,-13;-208,-229;34,-35;-205,-127;-119,-128;-95,29;122,131;-135,36;-67,-81;-171,71;47,67;-349,98;-350,34;50,109;-123,40;36,53;-84,-38;-74,36;-155,-28;-66,28;-51,-17;19,-29;-62,-9;-102,81;16,41;-362,121;-67,69;-88,-50;-87,34;27,22;-101,-7;-87,63;-67,7;-55,-42;-121,42;-78,-32;-20,27;-120,13;-35,27;25,27;-73,51;-91,-12;-47,41;65,43;-106,41;-76,-15;-70,-62;-226,63;-40,-16;-23,63;-102,16;-166,-58;2,40;-79,-37;-62,53;-91,-81;-82,12;-14,42;-127,-33;-52,49;-75,-43;-49,64;-81,0;-4,62;-75,-23;-164,17;-136,235;-92,0;-18,62;-8,-20;-566,-17;-307,-54;-372,-17;-180,-88;-213,-21;-8,-39;-65,-14;-48,-4;-130,85;-112,-33;211,-138;-45,-63;69,-22;-37,-67;94,-10;-2,-77;70,-11;-68,-51;9,-88;68,-28;-51,-24;27,-26;-46,-81;68,14;-7,-59;84,2;-97,-74;12,-29;-63,1;-59,-69;33,-69;-71,-110;69,-50;-34,-57;76,4;11,36;54,-69;-61,-41;96,-126;80,22;42,-29;-10,-95;37,-33;-93,-43;118,-34;18,-47;54,2;25,-67;83,34;43,-25;68,58;244,-29;249,-176;244,-105;205,-34;11,-29;129,22;113,-122;207,-39;288,155;86,-105;233,70;812,110;2291,235;1290,98;695,-176;73,58;162,-69;119,155;44,-49;46,46;113,-13;117,-72;144,27;102,-94;110,17;8,-23;94,-2;21,52;45,-39;25,20;55,-18;-12,27;89,24;-13,-214;66,-69;568,-48;127,-90;108,94;-54,58;-135,5;-25,75;176,110;84,12;-13,23;167,10;86,73;163,-10;96,66;-29,47;246,45;178,14;65,-124;136,27;153,110;174,-18;-13,119;313,15;-19,-130;108,-27;147,10;64,34;44,0;79,-76;56,38;375,-220;185,-5;67,-118;147,24;-9,85;-95,71;157,33;-32,30;118,55;117,-59;-50,-79;119,65;134,-39;-63,-106;-227,3;20,-60;-57,-130;279,-37;114,216;103,-51;-118,-194;119,-23;81,19;25,-113;72,13;313,-148;-123,-285;196,-165;-37,-68;766,-175;-170,-179;201,-49;2,-30;47,36;465,26;96,-70;36,-97;-678,-4;-242,-151;-156,-26;712,-138;691,175;-262,121;-81,213;347,95;80,-382;28,14;3424,2624;3484,1806;284,240;368,118;53,53;-74,16;112,638;91,58;107,-11;66,96;129,23;93,95;65,192;-2,48;-119,111;77,77;-32,88;53,52;-198,295;-100,2;-54,212;89,282;266,506;585,295;-13,23;196,156;380,478;266,135;392,128;148,109;161,16;3,60;100,9;18,84;563,-19;-9,-46;151,-1;-12,-143;-124,-446;32,-86;-128,-43;187,-194;62,13;51,-93;225,-143;-65,-35;33,-27;53,19;193,-186;64,-110;-15,-67;2655,-2;577,41;37,-21;51,22;35,-20;186,-348;2339,-3649;-941,-914;-2398,-2872;4538,-3236;284,-549;515,-439;714,-420;266,-3155;2829,-518;1042,545;1750,430;600,29;370,230;4193,-1744;-1085,-2554;-537,-1142;1194,-691;2521,545;3303,-532;1978,206;2055,-47;364,129;132,135;85,-21;27,18;40,384;47,-17;70,55;223,318;-85,87;29,72;-31,16;54,28;11,65;4998,-882;2129,-466;1589,1405;282,7;224,-38;225,257;117,352;2306,246;539,358;666,324;72,358;183,180;376,188;-18,151;455,-42;2820,-454;324,-572;968,-772;1440,-971;62,-31;95,22;-7,-77;1184,-480;62,-212;-26,-150;108,1;6,-38;-21,-208;-17,-29;-78,3;-29,-256;102,-16;-102,-104;43,-49;-92,-142;56,-164;4,-251;-133,-280;11,-177;-50,-117;34,-10;524,-2208;7626,-1955;976,-283;626,-228;135,-342;-434,-62;830,-888;276,99;140,-4;211,59;483,-70;190,19;519,-112;31,-192;396,79;49,93;186,-49;118,13;319,68;65,63;154,2;105,-32;-9,-45;120,-52;-3,-39;378,-116;112,136;142,-34;35,38;340,-19;-32,-131;671,-43;108,-59;-37,-43;63,-61;514,309;330,87;190,32;203,-18;16,38;258,37;74,0;11,-63;147,29;-23,55;193,26;99,-12;61,-70;338,37;38,91;260,0;180,32;151,-177;36,180;203,110;95,-12;20,73;236,124;345,-82;428,-234;-23,-24;373,-70;-91,-94;1120,-77;957,-520;-242,-377;-136,-135;91,-68;551,-53;37,-36;-270,-125;-129,0;-280,-68;-34,-37;-59,-2;-54,56;-103,-2;-88,-94;62,-486;283,28;144,-56;-42,135;233,4;43,-213;-84,-15;186,-51;62,76;96,2;8,-394;-303,-167;71,-30;-240,-273;191,-28;98,-310;412,74;332,107;142,163;400,135;147,104;224,30;227,-27;159,71;70,-20;380,181;-59,56;47,30;-35,59;283,195;85,-49;47,45;760,-409;120,10;-37,222;102,53;26,157;272,111;352,196;136,136;74,24;323,-166;64,-190;180,-16;218,-167;53,-2;101,-133;-95,-107;13,-99;227,-65;67,-78;279,-52;-97,-145;-38,7;-91,-202;394,-136;572,-361;122,-6;161,-102;694,-301;-414,-163;-250,-62;-330,-162;-205,-243;-28,-100;48,-182;-60,-175;-106,-155;-98,-73;-123,-64;-115,-16;-576,-1;-444,-34;-387,-98;-420,-260;-248,-218;-54,-92;-357,-286;-138,-35;-288,-202;-200,-483;69,-228;146,-166;297,-176;325,-22;878,47;273,-66;224,-99;281,-189;100,-181;-11,-276;-125,-267;-142,-164;-201,-130;-343,-173;-142,-34;-148,-3;-133,35;-105,68;-766,258;-436,41;-292,-42;-528,-172;-404,-272;-91,-186;132,-263;70,-81;172,-40;372,-276;143,-162;87,-177;1,-170;-69,-100;-494,-192;-172,-147;-92,-172;152,-171;13,-193;153,-152;127,-264;11,-96;-83,-187;-157,-152;-132,-51;-427,-63;-272,38;-261,79;-345,175;-392,114;-426,52;-156,-13;-110,-63;-99,-73;-90,-173;64,-91;25,-268;-49,-83;-26,-363;-105,-265;-249,-330;-186,-336;-296,-207;-104,-171;-279,-201;-123,-173;-39,-134;30,-162;143,-143;109,-61;161,2;680,-125;363,-135;205,-144;150,-268;-77,-263;-361,-280;-269,-317;-185,-145;-121,-270;-21,-365;137,-255;19,-462;-269,-322;-747,-419;-173,-147;-72,-74;11,-114;-136,-161;-112,-65;-115,-258;-165,-164;-320,-184;-137,-39;-550,-47;-147,-42;-101,-69;-92,-78;-99,-354;-109,-163;-94,-88;-143,-28;-339,-171;-287,-318;-140,-48;-414,-379;-50,-189;27,-94;211,-246;211,-118;398,-99;314,-8;292,57;485,198;101,177;202,136;259,98;160,10;429,-90;553,-302;75,-82;200,-248;39,-188;-37,-88;-72,-90;-118,-51;-534,-101;-499,-194;-71,-80;45,-107;-17,-187;-194,-239;-64,-281;-270,-314;-834,-500;-101,-176;-124,-57;-220,-230;-218,-439;135,-540;-61,-273;-387,-391;-135,-36;-105,-73;-145,-26;-290,42;-135,26;-541,310;-284,41;-301,-29;-395,-95;-209,-128;-113,-177;9,-93;-56,-98;79,-83;61,-271;-144,-451;-340,-404;-600,-252;-382,-267;-341,-505;-16,-183;40,-115;-737,62;-235,71;-228,-151;-343,-129;-224,-35;-14,-47;-88,-47;35,-33;-241,-122;-69,48;-63,-35;-84,26;-310,-259;-202,111;-277,-177;-66,39;-373,-236;531,-301;-217,-141;-564,-277;235,-124;-173,-151;134,-93;-182,-123;199,-37;-210,-133;182,-77;-318,-305;136,-119;19,-138;83,-108;-242,-61;48,-177;-190,-3;30,-136;312,-322;-107,-20;157,-142;-94,-68;350,-139;-162,-146;369,-201;91,-271;170,67;135,-190;-108,-204;-32,-160;-108,-165;38,-34;258,115;432,-322;-67,-49;95,-64;-212,-189;89,-33;-124,-86",
      "588648,5077016;287,-466;57,-234;30,-303;-101,-302;70,-91;220,-98;-221,-168;117,-293;381,-356;45,-150;185,-112;387,46;41,-136;531,-133;-83,-146;291,-139;137,-336;89,-84;-618,-457;-116,-166;-145,-89;-1,-36;-332,-172;-611,-491;-84,-127;-139,-59;-244,-207;-161,-152;-323,-573;-167,50;-687,327;-576,137;-229,148;-549,96;-287,7;-552,-83;-491,13;-628,-64;-143,-63;-385,-88;-1375,-98;-281,30;-202,78;-490,57;125,228;-142,108;-166,474;-178,32;-919,837;55,19;-12,24;155,43;-44,94;135,39;21,57;-143,100;59,44;-290,29;-63,-71;-258,206;-38,-38;-248,143;-220,300;-65,-12;4,72;-119,115;-126,35;-218,143;-730,260;-619,159;-180,160;-191,-18;-209,-92;-1275,-391;-506,-108;-33,40;-49,-22;-199,122;52,73;-98,74;40,20;-126,80;111,74;-71,39;53,44;-53,24;36,57;29,25;66,-17;52,67;-349,94;15,127;-637,102;-14,-68;-393,-35;-24,87;-91,-36;50,-86;-162,24;110,-91;-141,-36;63,-110;-207,-20;-90,129;-180,-66;8,-41;-55,-30;77,-262;-195,-62;91,-173;-27,-67;-124,3;-132,76;-65,-112;-168,31;52,116;-202,21;-26,-71;-386,119;-18,-20;-94,25;-36,-77;-133,33;13,21;-133,40;17,18;-473,137;12,25;-334,71;31,-72;-264,63;-10,-24;-150,25;-16,-53;-268,21;-223,69;22,55;-77,16;-121,14;-27,-71;-153,7;16,69;-263,50;-284,281;-208,-28;-105,245;-2,26;559,17;19,-154;53,-45;631,-93;309,56;115,-7;237,176;115,188;275,-57;175,-5;36,72;127,0;22,93;134,-13;39,98;152,-31;14,48;138,-28;-11,-53;207,-27;378,341;86,143;258,-94;-83,-29;76,-36;-46,-35;157,-55;-28,-25;104,-56;-64,-51;239,-150;386,-114;13,-85;478,6;401,-41;239,409;-114,26;101,87;-29,72;-63,0;274,399;201,140;-37,42;144,56;-28,17;220,167;177,69;184,177;48,-25;221,176;122,-17;305,318;73,-24;625,459;777,70;379,-29;-72,-71;146,-280;157,-511;167,-300;53,7;262,-424;379,84;493,219;1448,-1416;206,-15;466,27;801,264;393,14;440,-38;245,199;493,279;690,203;279,-752;27,-242;82,-202;404,430;1017,566;583,157;182,-6;545,74;1025,454",
      "493059,5142997;-120,97;-58,-43;-85,57;-136,189;28,62;-80,-19;-9,46;-74,12;-31,-11;31,-46;-270,23;-13,43;-244,43;-186,72;-90,-63;-221,77;207,53;98,-61;150,118;105,-18;60,62;-141,119;150,102;-109,43;99,86;-201,27;235,152;36,-12;47,59;-110,79;20,33;-61,101;68,7;-30,45;-95,45;-39,-61;-160,63;113,115;112,-97;248,142;99,-107;-192,-61;221,-77;-121,-3;63,-101;166,63;267,-90;-227,-84;106,-111;-58,2;-14,-48;40,10;85,-128;-49,-20;141,-128;140,154;-100,151;121,36;-2,52;57,-2;44,41;142,38;141,-9;-47,105;229,214;62,-109;-99,-39;30,-59;264,44;44,-126;47,11;50,-174;-64,2;-42,159;-65,-14;29,-142;-384,23;-53,-123;116,-1;-1,-131;154,11;-6,-47;-179,-4;8,-61;168,5;9,-81;261,20;-25,133;109,13;50,-144;-93,-86;52,-103;-179,-17;-194,-171;68,-32;302,20;-52,-189;37,6;31,-70;-85,-17;45,-68;-355,-127;-172,113;-69,-4;-14,46;-266,-55;-35,-50",
      "493997,5143612;222,33;57,-134;-176,-47;-3,60;-57,0;-43,88",
      "493327,5144931;-19,22;50,11;365,28;65,17;6,31;314,6;-3,33;199,4;7,-47;355,39;70,36;26,-54;128,73;172,35;-24,55;-42,-6;-53,139;204,18;13,-117;116,-91;-150,-59;114,-89;-169,-69;-244,-43;-32,-170;-319,45;161,50;-38,81;-246,-43;-4,-118;-210,-37;11,-69;-80,-5;-25,44;-73,-24;65,-138;-86,130;-43,-14;-17,78;-218,-29;-49,7;55,61;-209,-5;-143,184",
      "492727,5140824;464,-21;105,96;284,31;59,-396;-789,-23;129,28;100,66;51,-26;70,8;38,64;-73,-4;-57,71;-121,50;-208,20;-52,36",
      "493153,5144700;43,20;-45,43;175,65;81,-88;-216,-74;-38,34",
      "492951,5144956;123,87;107,-116;-141,-55;-89,84",
      "494396,5144365;184,32;11,122;180,1;1,54;190,-42;3,-54;-71,-5;94,-108;-174,5;-7,34;-411,-39",
      "492267,5144008;-117,-83;83,-47;-1,-110;138,-3;105,149;-147,69;158,90;-55,38;81,63;-100,12;-180,-164;35,-14",
      "484086,5141745;-211,73;169,68;4,-78;89,-18;-51,-45",
      "492745,5144850;70,44;98,-82;-73,-29;-95,67",
      "488862,5142468;150,60;108,-75;40,25;71,-68;-87,-88;-207,23;99,45;-174,78",
      "483623,5144805;-49,41;47,33;45,-39;-43,-35",
      "494076,5143931;151,22;-22,51;107,12;-128,-111;39,-94;-86,-16;-61,136",
      "486586,5141412;114,27;82,-113;-150,-8;-46,94",
      "487363,5141548;-24,44;144,59;49,-45;-169,-58",
      "494271,5145308;6,25;202,18;14,-48;-211,-35;-11,40",
      "492533,5144527;-116,108;133,30;143,-129;-121,-45;-39,36",
      "491822,5144343;-7,53;73,5;-66,-58",
      "493971,5144187;-50,175;74,14;33,-196;-57,7",
      "494902,5145377;-26,122;83,12;20,-81;-55,-5;11,-46;-33,-2",
      "494100,5144527;112,28;20,-41;-113,-26;-19,39",
      "494072,5145563;138,-39;-148,9;10,30",
      "493987,5143949;-11,27;168,23;9,-26;-166,-24",
      "493133,5143644;-8,-177;74,-12;4,74;39,0;-4,-80;35,-6;-5,204;-135,-3",
      "487027,5141256;-104,-77;52,-63;263,34;-44,66;117,26;-91,50;-71,-51;-91,33;-31,-18",
      "493164,5143997;-101,-8;29,-111;130,6;17,119;-75,-6",
      "493547,5143319;3,30;-139,-6;7,-148;124,10;5,114",
      "493069,5143716;70,-55;24,56;-94,-1",
      "493537,5143752;9,-134;134,9;-32,128;-111,-3",
      "494165,5144948;-8,-154;45,7;18,148;-55,-1",
      "428462,5084530;-9,-145;-91,-5;17,-186;-48,-11;41,-117;-81,-9;11,-39;-141,-13;13,-52;101,7;19,-175;-529,0;-249,108;-85,-34;-108,9;-23,-67;-112,-95;2,-85;-379,10;-356,-44;-11,-34;-256,-35;-160,22;-151,59;-241,-106;-167,-138;47,-65;-73,-52;124,-198;-4,-108;-54,-2;-4,-38;46,-47;-68,-143;-167,-187;-198,-93;-34,16;-707,-480;61,-4;55,-181;189,-19;-30,154;326,38;154,-224;500,19;279,-353;88,-279;218,1;70,40;277,32;62,-30;118,4;79,47;476,12;192,-62;99,-79;114,-250;115,4;157,-75;125,8;176,-47;80,20;11,-28;179,48;102,76;340,45;161,15;106,-27;53,28;48,-58;87,-7;36,55;104,34;-2,57;186,35;47,149;113,8;-15,51;85,81;152,-18;36,27;459,-61;-79,-147;-21,-177;-111,-14;-102,-189;-28,-182;-101,-119;219,-358;29,-127;64,-68;556,-70;13,-28;318,-62;12,-69;79,23;168,-39;61,-98;50,-16;56,-257;49,-32;-57,-137;103,-67;-30,-42;78,-94;-52,-154;204,-185;64,-219;307,-227;44,-93;136,-48;98,-112;278,-146;71,-140;956,-191;103,80;215,70;9,29;310,10;66,-71;211,-25;309,-102;232,6;758,-123;-39,-42;122,-55;48,153;-105,17;-6,24;1795,-398;6,-75;154,15;28,-505;2804,823;1434,358;785,264;144,-165;1686,612;1188,529;1893,510;-204,93;38,30;-3343,1408;308,38;133,-35;124,17;199,159;175,-5;132,39;-5,23;-297,-17;-200,-140;-93,-16;-241,80;-172,161;638,371;103,11;234,117;-235,139;-55,70;2207,199;-1099,1513;242,185;-135,276;27,448;-188,-36;-239,435;-32,32;-71,-15;-81,218;31,5;-12,88;-299,83;-189,11;-261,65;-314,3;-242,65;-215,130;37,77;-28,64;-170,60;66,66;-589,231;-175,-195;-761,271;126,128;-234,55;-205,-17;-576,485;501,434;172,298;121,125;-157,69;11,49;972,131;-986,1108;-17,103;75,72;153,127;234,76;113,109;-156,53;14,40;-188,126;-273,90;-85,69;190,145;-137,44;-37,63;-112,42;-199,152;-46,-39;-38,59;-397,74;-66,59;43,92;-544,160;-5,155;132,95;48,201;-1076,237;-43,-86;-119,30;-278,-11;-15,-109;-172,-28;-232,-167;-27,18;-170,-41;-291,2;-74,38;-26,-36;-48,28;-76,-34;-72,-270;-86,-148;-323,-396;-373,-100;-130,-148;30,-204;-83,-29;-188,97;-480,92;-672,227;-1179,14;-410,24;-374,81;-362,-2;-752,-91;-304,-72;-675,-263;-436,-321;-446,-124;-718,-262;-545,-59;-104,16;-718,-151;44,-241;156,-131;129,-29;85,-153;95,-375;-124,-115;-332,-148;28,-30;-152,-110;-165,-44;64,-34;-47,-55;-352,-122;-219,-178;-39,-123;-143,-131;-287,-181;-85,2;-106,-136;37,-55;-33,-81;107,-210;-4,-76;45,-3;-44,-155;199,-71;32,49;124,-44;-44,-45;79,-30;-23,-19;302,-71;50,-69;85,66;146,-170;-320,-119;-216,-26;-134,-75;322,-229;189,-311;-197,-51;-138,62;-92,-31;-73,-107;139,-54;-35,-106;33,-10",
    ],
    "BE-BRU": [
      "428462,5084530;-9,-145;-91,-5;17,-186;-48,-11;41,-117;-81,-9;11,-39;-141,-13;13,-52;101,7;19,-175;-529,0;-249,108;-85,-34;-108,9;-23,-67;-112,-95;2,-85;-379,10;-356,-44;-11,-34;-256,-35;-160,22;-151,59;-241,-106;-167,-138;47,-65;-73,-52;124,-198;-4,-108;-54,-2;-4,-38;46,-47;-68,-143;-167,-187;-198,-93;-34,16;-707,-480;61,-4;55,-181;189,-19;-30,154;326,38;154,-224;500,19;279,-353;88,-279;218,1;70,40;277,32;62,-30;118,4;79,47;476,12;192,-62;99,-79;114,-250;115,4;157,-75;125,8;176,-47;80,20;11,-28;179,48;102,76;340,45;161,15;106,-27;53,28;48,-58;87,-7;36,55;104,34;-2,57;186,35;47,149;113,8;-15,51;85,81;152,-18;36,27;459,-61;-79,-147;-21,-177;-111,-14;-102,-189;-28,-182;-101,-119;219,-358;29,-127;64,-68;556,-70;13,-28;318,-62;12,-69;79,23;168,-39;61,-98;50,-16;56,-257;49,-32;-57,-137;103,-67;-30,-42;78,-94;-52,-154;204,-185;64,-219;307,-227;44,-93;136,-48;98,-112;278,-146;71,-140;956,-191;103,80;215,70;9,29;310,10;66,-71;211,-25;309,-102;232,6;758,-123;-39,-42;122,-55;48,153;-105,17;-6,24;1795,-398;6,-75;154,15;28,-505;2804,823;1434,358;785,264;144,-165;1686,612;1188,529;1893,510;-204,93;38,30;-3343,1408;308,38;133,-35;124,17;199,159;175,-5;132,39;-5,23;-297,-17;-200,-140;-93,-16;-241,80;-172,161;638,371;103,11;234,117;-235,139;-55,70;2207,199;-1099,1513;242,185;-135,276;27,448;-188,-36;-239,435;-32,32;-71,-15;-81,218;31,5;-12,88;-299,83;-189,11;-261,65;-314,3;-242,65;-215,130;37,77;-28,64;-170,60;66,66;-589,231;-175,-195;-761,271;126,128;-234,55;-205,-17;-576,485;501,434;172,298;121,125;-157,69;11,49;972,131;-986,1108;-17,103;75,72;153,127;234,76;113,109;-156,53;14,40;-188,126;-273,90;-85,69;190,145;-137,44;-37,63;-112,42;-199,152;-46,-39;-38,59;-397,74;-66,59;43,92;-544,160;-5,155;132,95;48,201;-1076,237;-43,-86;-119,30;-278,-11;-15,-109;-172,-28;-232,-167;-27,18;-170,-41;-291,2;-74,38;-26,-36;-48,28;-76,-34;-72,-270;-86,-148;-323,-396;-373,-100;-130,-148;30,-204;-83,-29;-188,97;-480,92;-672,227;-1179,14;-410,24;-374,81;-362,-2;-752,-91;-304,-72;-675,-263;-436,-321;-446,-124;-718,-262;-545,-59;-104,16;-718,-151;44,-241;156,-131;129,-29;85,-153;95,-375;-124,-115;-332,-148;28,-30;-152,-110;-165,-44;64,-34;-47,-55;-352,-122;-219,-178;-39,-123;-143,-131;-287,-181;-85,2;-106,-136;37,-55;-33,-81;107,-210;-4,-76;45,-3;-44,-155;199,-71;32,49;124,-44;-44,-45;79,-30;-23,-19;302,-71;50,-69;85,66;146,-170;-320,-119;-216,-26;-134,-75;322,-229;189,-311;-197,-51;-138,62;-92,-31;-73,-107;139,-54;-35,-106;33,-10",
    ],
  };
  const REGION_TOLERANCE_M = 20;
  // END GENERATED REGIONS

  /** @type {Array<{ region: string, ring: Float64Array, box: [number, number, number, number] }> | null} */
  let regionRings = null;

  function decodeRegions() {
    regionRings = [];
    for (const [region, rings] of Object.entries(REGION_RINGS)) {
      for (const encoded of rings) {
        const parts = encoded.split(';');
        const ring = new Float64Array(parts.length * 2);
        let x = 0, y = 0;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        parts.forEach((p, i) => {
          const [dx, dy] = p.split(',').map(Number);
          x += dx; y += dy;
          const lon = x / 1e5, lat = y / 1e5;
          ring[2 * i] = lon; ring[2 * i + 1] = lat;
          minX = Math.min(minX, lon); maxX = Math.max(maxX, lon); minY = Math.min(minY, lat); maxY = Math.max(maxY, lat);
        });
        regionRings.push({ region, ring, box: [minX, minY, maxX, maxY] });
      }
    }
    return regionRings;
  }

  /**
   * Belgian region of a point in Belgium: Brussels, Flanders (even-odd over its
   * rings, Brussels is a hole in it) or else Wallonia.
   * @param {number} lon @param {number} lat
   */
  function regionAt(lon, lat) {
    /** @type {Map<string, boolean>} */
    const inside = new Map();
    for (const { region, ring, box } of regionRings || decodeRegions()) {
      if (lon < box[0] || lon > box[2] || lat < box[1] || lat > box[3]) continue;
      let hit = false;
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const yi = ring[i + 1], yj = ring[j + 1];
        if ((yi > lat) !== (yj > lat) && lon < ((ring[j] - ring[i]) * (lat - yi)) / (yj - yi) + ring[i]) hit = !hit;
      }
      if (hit) inside.set(region, !inside.get(region));
    }
    if (inside.get('BE-BRU')) return 'BE-BRU';
    if (inside.get('BE-VLG')) return 'BE-VLG';
    return 'BE-WAL';
  }

  /**
   * Where a way lies, from points along it.
   * @param {Array<[number, number]>} points
   * @param {(lon: number, lat: number) => string} countryAt
   * @param {boolean} partial
   * @returns {Place}
   */
  function placeOf(points, countryAt, partial) {
    const { codes, sides } = locateAlong(points, countryAt, 25);
    const country = codes.length === 1 ? codes[0] : '';
    /** @type {string[]} */
    let regions = [];
    if (codes.includes('BE') && countries.BE?.regions) {
      const at = (/** @type {number} */ lon, /** @type {number} */ lat) => (countryAt(lon, lat) === 'BE' ? regionAt(lon, lat) : '');
      regions = locateAlong(points, at, Math.max(40, 2 * REGION_TOLERANCE_M)).codes;
    }
    return { country, countries: codes, sides, regions, partial };
  }

  // ===========================================================================
  // Sign artwork (generated) and the export for the tests
  // ===========================================================================
  // Traffic signs from Wikimedia Commons (public domain as official works) and own
  // neutral symbols for countries without a public-domain sign, see dev/signs/.
  // After changing them run `node dev/build-signs.js`.
  // BEGIN GENERATED SIGN ART
  /** @type {Record<string, { width: number, height: number, svg: string }>} */
  const SIGN_ART = {
    "BE-F5": { width: 68.7, height: 102.7, svg: "<path fill=\"#0071B3\" d=\"M68.6 94.9V7.6C68.6 3.4 65.2 0 61 0H7.6A7.5 7.5 0 0 0 0 7.5v87.7c0 4.2 3.4 7.5 7.6 7.5h53.6c4.1 0 7.5-3.3 7.5-7.5z\"/><path fill=\"#FFF\" d=\"M2 7.7c0-3.1 2.6-5.6 5.8-5.6H61c3.1 0 5.6 2.5 5.6 5.6V95c0 3.1-2.5 5.6-5.6 5.6H7.7A5.6 5.6 0 0 1 2 95z\"/><path fill=\"#0071B3\" d=\"M65 95V7.8c0-2.2-1.6-4.1-3.8-4.1H7.7a4 4 0 0 0-4 4V95a4 4 0 0 0 4 4h53.5c2.2 0 3.7-1.8 3.7-4\"/><path fill=\"#FFF\" d=\"m32.6 7.5-.6 26h-7.3l3.4-26z\"/><path fill=\"none\" stroke=\"#FFF\" stroke-miterlimit=\"3.9\" stroke-width=\".2\" d=\"m32.6 7.5-.6 26h-7.3l3.4-26z\"/><path fill=\"#FFF\" d=\"M17.3 95.5h13.5l.9-49.7h-8.2z\"/><path fill=\"none\" stroke=\"#FFF\" stroke-miterlimit=\"3.9\" stroke-width=\".2\" d=\"M17.3 95.5h13.5l.9-49.7h-8.2z\"/><path fill=\"#FFF\" d=\"m35.5 7.5.5 26h6.9l-3-26z\"/><path fill=\"none\" stroke=\"#FFF\" stroke-miterlimit=\"3.9\" stroke-width=\".2\" d=\"m35.5 7.5.5 26h6.9l-3-26z\"/><path fill=\"#FFF\" d=\"M51.6 95.5H38.3L37 45.9h8.1z\"/><path fill=\"none\" stroke=\"#FFF\" stroke-miterlimit=\"3.9\" stroke-width=\".2\" d=\"M51.6 95.5H38.3L37 45.9h8.1z\"/><path fill=\"#FFF\" d=\"M51.3 59.2h9.3l-2.1-16.6h3.6v-6.7H6.4v6.7H10L8 58.9h9.2l-1.4-16.5h37.5L51.4 59z\"/><path fill=\"none\" stroke=\"#FFF\" stroke-miterlimit=\"3.9\" stroke-width=\".2\" d=\"M51.3 59.2h9.3l-2.1-16.6h3.6v-6.7H6.4v6.7H10L8 58.9h9.2l-1.4-16.5h37.5L51.4 59z\"/>" },
    "DE-330.1": { width: 601, height: 601, svg: "<path d=\"M29.2 480.4C.3 480.4.4 451.6.4 451.6V29.2S.4.4 29.2.4h422.4c29 0 28.8 28.8 28.8 28.8v422.4s.2 28.9-28.8 28.8z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/><path d=\"M29.2 470.8A19 19 0 0 1 10 451.6V29.2C10 18.6 18.6 10 29.2 10h422.4c10.6 0 19.2 8.6 19.2 19.2v422.4c0 10.6-8.6 19.2-19.2 19.2z\" style=\"fill:#154889;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/><path d=\"M29.2 480.8c-14.6 0-22-7.3-25.6-14.6S0 451.6 0 451.6V29.2s0-7.3 3.6-14.6C7.3 7.3 14.6 0 29.2 0h422.4c14.7 0 22 7.3 25.7 14.6s3.5 14.6 3.5 14.6v422.4s0 7.3-3.6 14.6-11 14.6-25.6 14.6zm0-.4h422.4c29 .1 28.8-28.8 28.8-28.8V29.2S480.7.4 451.6.4H29.2C.3.4.4 29.2.4 29.2v422.4s0 28.8 28.8 28.8\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/><path d=\"m252.3 305.4-4.7 122.8h21.7l42.5-122.8zm-83.3 0 42.5 122.8h21.7l-4.7-122.8zm-76.7-50.6v21.7H52.6V291h375.6v-14.5h-39.7v-21.7h-36.1v21.7h-224v-21.7zM262.1 52.6l-7.8 202.2h75l70-202.2zm-180.6 0 70 202.2h75l-7.8-202.2\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/>" },
    "NL-G1": { width: 200, height: 300, svg: "<path fill=\"#0e518d\" d=\"M0 0h200v300H0z\"/><path fill=\"#f7fbf5\" d=\"m72.7 93.3 20.2-67.7h4.2l-4.4 67.7zM90.5 128l-9.3 142.7H19.5l42.8-142.6zm36.8-34.7-20.2-67.7h-4.3l4.4 67.7zM109.5 128l9.3 142.7h61.7l-42.8-142.6zm42.8-17.3V128h12.4v-17.3H180V102H20v8.7h15.3V128h12.3v-17.3z\"/><path d=\"M175.6 292c9 0 16.3-7 16.3-15.7V23.7a16 16 0 0 0-16.3-15.8H24.3c-9 0-16.2 7-16.2 15.8v252.6a16 16 0 0 0 16.2 15.8z\" style=\"fill:none;stroke:#f7fbf5;stroke-width:6.72582531\"/>" },
    "PL-D-7": { width: 602, height: 752, svg: "<rect width=\"600\" height=\"750\" x=\"1\" y=\"1\" fill=\"#fff\" rx=\"30\" ry=\"30\"/><rect width=\"601\" height=\"751\" x=\".5\" y=\".5\" fill=\"none\" stroke=\"#000\" rx=\"30.5\" ry=\"30.5\"/><rect width=\"588\" height=\"738\" x=\"7\" y=\"7\" fill=\"#039\" rx=\"24\" ry=\"24\"/><path fill=\"#fff\" fill-rule=\"evenodd\" d=\"m451 316-17.2-86-132.8-2.7-132.8 2.7-17.2 86-15 15v135h15v45h45v-45h210v45h45v-45h15V331zm-265-60h230l10 60H176zm-12.5 97.5a22.5 22.5 0 1 1 0 45 22.5 22.5 0 0 1 0-45M451 436H151v-15h300zm-22.5-37.5a22.5 22.5 0 1 1 0-45 22.5 22.5 0 0 1 0 45\"/>" },
    "PL-D-9": { width: 602, height: 752, svg: "<rect width=\"600\" height=\"750\" x=\"1\" y=\"1\" fill=\"#fff\" rx=\"30\" ry=\"30\"/><rect width=\"601\" height=\"751\" x=\".5\" y=\".5\" fill=\"none\" stroke=\"#000\" stroke-miterlimit=\"1\" rx=\"30.5\" ry=\"30.5\"/><rect width=\"588\" height=\"738\" x=\"7\" y=\"7\" fill=\"#039\" rx=\"24\" ry=\"24\"/><path fill=\"#fff\" d=\"M171.3 391h91.9L256 739H121zM226 13l-39.5 273h78.9L271 13zm150 0h-45l5.6 273h78.9zm54.7 378h-91.9l7.2 348h135zM13 301h576v15h-78l15 75h-60l15-75H121l15 75H76l15-75H13z\"/>" },
    "neutral-expressway": { width: 80, height: 80, svg: "<rect x=\"2\" y=\"2\" width=\"76\" height=\"76\" rx=\"8\" fill=\"#1565c0\" stroke=\"#fff\" stroke-width=\"4\"/><path fill=\"#fff\" d=\"M22 46l6-16c1-3 3-4 6-4h12c3 0 5 1 6 4l6 16v14h-8v-6H30v6h-8zm8-2h20l-4-12H34zm-2 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm24 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6z\"/>" },
    "neutral-motorway": { width: 80, height: 80, svg: "<rect x=\"2\" y=\"2\" width=\"76\" height=\"76\" rx=\"8\" fill=\"#1565c0\" stroke=\"#fff\" stroke-width=\"4\"/><path fill=\"#fff\" d=\"M36 14h-6L14 68h14zm8 0h6l16 54H52zm-6 6h4v8h-4zm0 14h4v10h-4zm0 16h4v14h-4z\"/>" },
    "neutral-rural": { width: 120, height: 80, svg: "<rect x=\"3\" y=\"3\" width=\"114\" height=\"74\" rx=\"7\" fill=\"#fff\" stroke=\"#111\" stroke-width=\"6\"/><path fill=\"#7CB342\" d=\"M7 40h106v33H7z\"/><path fill=\"#555\" d=\"M56 40h8l22 33H34z\"/><path stroke=\"#fff\" stroke-width=\"2.5\" d=\"M60 44v5m0 6v7m0 6v5\"/><circle cx=\"24\" cy=\"30\" r=\"12\" fill=\"#2E7D32\"/><path fill=\"#5D4037\" d=\"M22 38h4v14h-4z\"/><circle cx=\"96\" cy=\"27\" r=\"14\" fill=\"#2E7D32\"/><path fill=\"#5D4037\" d=\"M94 37h4v16h-4z\"/><circle cx=\"80\" cy=\"35\" r=\"7\" fill=\"#388E3C\"/>" },
    "neutral-urban": { width: 120, height: 80, svg: "<rect x=\"3\" y=\"3\" width=\"114\" height=\"74\" rx=\"7\" fill=\"#FFD400\" stroke=\"#111\" stroke-width=\"6\"/><path fill=\"#111\" d=\"M12 66V44l11-10 11 10v-6l9-8V18h4l2-7 2 7h4v12l9 8V28l12-11 12 11v8l8-7 9 8v29z\"/>" },
  };
  // END GENERATED SIGN ART

  if (typeof module !== 'undefined') {
    module.exports = {
      setTables, checkSettings, rulesFor, evaluate, repairValue, townSignsOf, signsAlong, parseTagText, setInTagText,
      locateAlong, regionAt, placeOf, messageText, SIGN_ART, setLang: (/** @type {'de'|'en'} */ l) => { LANG = l; },
    };
    return;
  }

  // ===========================================================================
  // From here on: browser only
  // ===========================================================================

  // iD runs at /id (an iframe inside /edit); other pages of the site are left alone.
  if (!/^\/(id|edit)(\/|$)/.test(location.pathname)) return;

  // Chrome injects the script once per frame; never run twice.
  const win = /** @type {Window & { __osmTrafficZone?: boolean }} */ (window);
  if (win.__osmTrafficZone) return;
  win.__osmTrafficZone = true;

  /** @type {Settings} */
  let settings = checkSettings(null);
  let onSettingsChanged = () => {};

  window.addEventListener('message', (event) => {
    // Only messages from this very page; anything else is ignored.
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.__ozt !== 'settings') return;
    settings = checkSettings(msg.settings);
    setTables(msg.tables);
    LANG = settings.lang;
    onSettingsChanged();
  });

  // iD is a single-page app: start once its map layer exists.
  const waitForMap = setInterval(() => {
    if (document.querySelector('.layer-osm')) { clearInterval(waitForMap); start(); }
  }, 1000);

  function start() {
    const STORE = 'osm-zone-traffic';
    /** @type {{ pos: { x: number, y: number } | null, collapsed: boolean }} */
    const legendState = { pos: null, collapsed: false };
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
      if (saved && Number.isFinite(saved.pos?.x) && Number.isFinite(saved.pos?.y)) legendState.pos = { x: saved.pos.x, y: saved.pos.y };
      legendState.collapsed = saved?.collapsed === true;
    } catch { /* unreadable – keep the defaults */ }
    const saveLegendState = () => {
      try { localStorage.setItem(STORE, JSON.stringify(legendState)); } catch { /* storage full or blocked */ }
    };

    // unusual: between green and yellow – not wrong, but odd.
    const COLORS = { ok: '#2e9d3a', unusual: '#a4c639', missing: '#e53935', review: '#f9c80e' };
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const ICON_HEIGHT = 20; // px
    const ICON_MIN_LINE = 36; // px of visible line needed for an icon

    /** @type {SVGGElement | null} */ let iconLayer = null;
    /** @type {HTMLDivElement | null} */ let legend = null;
    /** @type {HTMLDivElement | null} */ let panel = null;
    /** Way whose panel is open. */ let panelWay = '';
    let redrawPending = false;
    /** Results of the last redraw, per way id. @type {Map<string, { result: Result, path: SVGPathElement, tags: Tags }>} */
    let lastResults = new Map();
    /** Statistics of the last redraw. */
    let stats = { ways: 0, ok: 0, unusual: 0, missing: 0, review: 0, length: 0, lengthMissing: 0, lengthTagged: 0 };
    /** Country of the view for the legend: code, "" = none, null = several. @type {string | null} */
    let legendCountry = '';

    onSettingsChanged = () => {
      evaluationCache = new WeakMap();
      countryIds = null;
      if (legend) { legend.remove(); legend = null; }
      if (panelWay) renderPanel();
      scheduleRedraw();
    };
    window.postMessage({ __ozt: 'ready' }, location.origin);

    /** @param {Element} element @returns {{ id: string, tags: Tags, nodes: string[], version?: string } | null} */
    function entityOf(element) {
      const data = /** @type {any} */ (element).__data__;
      if (!data || typeof data !== 'object' || typeof data.id !== 'string') return null;
      return data.tags && typeof data.tags === 'object' ? data : null;
    }

    // -------------------------------------------------------------------------
    // Map position and countries
    // -------------------------------------------------------------------------
    // Where on earth a point of the map is, follows from iD's URL (#map=zoom/lat/lon
    // is the centre of the map) and Web Mercator with 256 px tiles, like iD itself.

    function mapView() {
      const m = /[#&]map=([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)/.exec(location.hash);
      const map = document.querySelector('.main-map');
      if (!m || !map) return null;
      const box = map.getBoundingClientRect();
      const zoom = Number(m[1]), lat0 = Number(m[2]), lon0 = Number(m[3]);
      const k = (256 * 2 ** zoom) / (2 * Math.PI);
      const y0 = Math.log(Math.tan(Math.PI / 4 + (lat0 * Math.PI) / 360));
      /** @returns {[number, number]} */
      const lonLat = (/** @type {number} */ x, /** @type {number} */ y) => [
        lon0 + ((x - (box.left + box.width / 2)) / k) * (180 / Math.PI),
        (2 * Math.atan(Math.exp(y0 - (y - (box.top + box.height / 2)) / k)) - Math.PI / 2) * (180 / Math.PI),
      ];
      const metresPerPixel = (6378137 * Math.cos((lat0 * Math.PI) / 180)) / k;
      return { key: `${m[0]} ${box.left} ${box.top} ${box.width} ${box.height}`, box, lonLat, metresPerPixel };
    }

    /** Location set id → country code; null until registered. @type {Map<string, string> | null} */
    let countryIds = null;
    const locationManager = () => /** @type {any} */ (window).iD?.locationManager;

    /** Country code at a point, "" if none of the table. @param {number} lon @param {number} lat */
    function countryAt(lon, lat) {
      const manager = locationManager();
      if (!countryIds) {
        countryIds = new Map();
        if (!manager) return '';
        /** @type {Array<{ code: string, locationSet: { include: string[] }, locationSetID?: string }>} */
        const sets = [];
        for (const code of [...Object.keys(countries), ...unverified.keys()]) {
          // An unknown code would be registered as the whole world, so it is checked first.
          try { manager.validateLocation(code.toLowerCase()); } catch { continue; }
          sets.push({ code, locationSet: { include: [code.toLowerCase()] } });
        }
        try { manager.registerLocationSets(sets); } catch { return ''; }
        for (const set of sets) if (set.locationSetID) countryIds.set(set.locationSetID, set.code);
      }
      if (!manager || !countryIds.size) return '';
      let best = '';
      let bestArea = Infinity;
      try {
        for (const [id, area] of manager.locationSetsAt([lon, lat])) {
          const code = countryIds.get(id);
          if (code && area < bestArea) { best = code; bestArea = area; }
        }
      } catch { return ''; }
      return best;
    }

    /** View the single country below was found for. */
    let viewKey = '';
    /** Country of the whole view if a 5×5 grid finds only one, else null. @type {string | null} */
    let viewCountry = null;

    function updateViewCountry() {
      const view = mapView();
      const key = view ? view.key : '';
      if (key === viewKey) return;
      viewKey = key;
      placeCache.clear();
      if (!view) { viewCountry = ''; return; }
      const found = new Set();
      for (let fx = 0; fx <= 1; fx += 0.25) {
        for (let fy = 0; fy <= 1; fy += 0.25) {
          const [lon, lat] = view.lonLat(view.box.left + fx * view.box.width, view.box.top + fy * view.box.height);
          found.add(countryAt(lon, lat));
        }
      }
      viewCountry = found.size === 1 ? [...found][0] : null;
    }

    // iD writes the map position into the URL only after the map has stopped
    // moving, and without a hashchange event; a changed URL triggers a redraw.
    let lastHash = location.hash;
    setInterval(() => {
      if (location.hash === lastHash) return;
      lastHash = location.hash;
      scheduleRedraw();
    }, 1000);

    /** Place per way id for the current view. @type {Map<string, Place>} */
    const placeCache = new Map();

    /** Points [lon, lat] along the visible line, and whether it is cut at the map edge. @param {SVGPathElement} path */
    function pointsOfPath(path) {
      const view = mapView();
      const matrix = path.getScreenCTM();
      if (!view || !matrix) return null;
      let length;
      try { length = path.getTotalLength(); } catch { return null; }
      const count = Math.min(12, Math.max(3, Math.ceil(length / 60) + 1));
      /** @type {Array<[number, number]>} */
      const points = [];
      for (let i = 0; i < count; i++) {
        const p = path.getPointAtLength((length * i) / (count - 1));
        const s = new DOMPoint(p.x, p.y).matrixTransform(matrix);
        points.push(view.lonLat(s.x, s.y));
      }
      const b = path.getBoundingClientRect();
      const box = view.box;
      // iD cuts lines 5 px outside the map.
      const partial = b.left < box.left - 1 || b.right > box.right + 1 || b.top < box.top - 1 || b.bottom > box.bottom + 1;
      return { points, partial, length };
    }

    /** @param {SVGPathElement} path @param {string} id @returns {Place} */
    function placeOfPath(path, id) {
      const cached = placeCache.get(id);
      if (cached) return cached;
      const sampled = pointsOfPath(path);
      /** @type {Place} */
      let place;
      if (viewCountry !== null && viewCountry !== 'BE') {
        place = { country: viewCountry, countries: viewCountry ? [viewCountry] : [], sides: null, regions: [], partial: !!sampled?.partial };
      } else if (!sampled) {
        place = { country: '', countries: [], sides: null, regions: [], partial: true };
      } else {
        place = placeOf(sampled.points, countryAt, sampled.partial);
      }
      placeCache.set(id, place);
      return place;
    }

    // -------------------------------------------------------------------------
    // Checking the visible ways
    // -------------------------------------------------------------------------

    /** Result per tags object; iD replaces the tags object whenever a way is edited. @type {WeakMap<object, { key: string, result: Result }>} */
    let evaluationCache = new WeakMap();

    /**
     * Neighbours and town signs of all visible ways.
     * @param {SVGPathElement[]} lines
     */
    function collectSurroundings(lines) {
      /** Node id → zone:traffic values of checked ways ending there. @type {Map<string, Array<{ id: string, value: string }>>} */
      const ends = new Map();
      for (const line of lines) {
        const e = entityOf(line);
        if (!e || !Array.isArray(e.nodes) || e.nodes.length < 2 || !settings.roads.has(e.tags.highway)) continue;
        for (const node of [e.nodes[0], e.nodes[e.nodes.length - 1]]) {
          let list = ends.get(node);
          if (!list) ends.set(node, (list = []));
          list.push({ id: e.id, value: e.tags['zone:traffic'] || '' });
        }
      }
      /** Node id → tags of nodes iD draws (tagged vertices and points). @type {Map<string, Tags>} */
      const nodeTags = new Map();
      for (const g of document.querySelectorAll('.layer-osm g.vertex, .layer-osm g.point')) {
        const n = entityOf(g);
        if (n && /^n/.test(n.id) && Object.keys(n.tags).some((k) => k.startsWith('traffic_sign'))) nodeTags.set(n.id, n.tags);
      }
      return { ends, nodeTags };
    }

    /**
     * @param {{ id: string, tags: Tags, nodes: string[] }} e
     * @param {ReturnType<typeof collectSurroundings>} around
     * @param {Place} place
     * @returns {Context}
     */
    function contextFor(e, around, place) {
      const at = (/** @type {string} */ node) => (around.ends.get(node) || []).filter((n) => n.id !== e.id && n.value).map((n) => n.value);
      const nodes = Array.isArray(e.nodes) ? e.nodes : [];
      return {
        place,
        roads: settings.roads,
        neighbours: { start: nodes.length ? at(nodes[0]) : [], end: nodes.length ? at(nodes[nodes.length - 1]) : [] },
        signs: signsAlong(nodes, (id) => around.nodeTags.get(id)),
      };
    }

    /** Colours one way line. @param {SVGPathElement} path @param {Status | null} status */
    function paintLine(path, status) {
      const css = path.style;
      if (!status || status === 'excluded' || status === 'outside') {
        if (css.getPropertyValue('stroke')) { css.removeProperty('stroke'); css.removeProperty('stroke-opacity'); }
        return;
      }
      const color = COLORS[status];
      if (css.getPropertyValue('stroke') !== color) {
        css.setProperty('stroke', color, 'important');
        css.setProperty('stroke-opacity', '1', 'important');
      }
    }

    function redraw() {
      redrawPending = false;
      if (!document.querySelector('.layer-osm')) { iconLayer?.replaceChildren(); return; }
      updateViewCountry();
      const lines = /** @type {SVGPathElement[]} */ (Array.from(document.querySelectorAll('.layer-osm.lines path.way.line.stroke')));
      const around = collectSurroundings(lines);
      const view = mapView();
      const mpp = view ? view.metresPerPixel : 0;
      /** @type {Map<string, { result: Result, path: SVGPathElement, tags: Tags }>} */
      const results = new Map();
      const next = { ways: 0, ok: 0, unusual: 0, missing: 0, review: 0, length: 0, lengthMissing: 0, lengthTagged: 0 };
      const legendCountries = new Set();
      for (const path of lines) {
        const e = settings.enabled ? entityOf(path) : null;
        if (!e || !e.tags.highway || !settings.roads.has(e.tags.highway)) { paintLine(path, null); continue; }
        const place = placeOfPath(path, e.id);
        const ctx = contextFor(e, around, place);
        const key = JSON.stringify([place, ctx.neighbours, ctx.signs, [...settings.roads].join(), LANG]);
        let cached = evaluationCache.get(e.tags);
        if (!cached || cached.key !== key) {
          cached = { key, result: evaluate(e.tags, ctx) };
          evaluationCache.set(e.tags, cached);
        }
        const { result } = cached;
        const shown = result.status !== 'excluded' && result.status !== 'outside' && !settings.hidden.has(result.status);
        paintLine(path, shown ? result.status : null);
        if (result.status === 'excluded' || result.status === 'outside') continue;
        results.set(e.id, { result, path, tags: e.tags });
        place.countries.forEach((c) => legendCountries.add(c));
        let length = 0;
        try { length = path.getTotalLength() * mpp; } catch { /* not rendered */ }
        next.ways++;
        next.length += length;
        if (result.status === 'ok') next.ok++;
        if (result.status === 'unusual') next.unusual++;
        if (result.status === 'missing') { next.missing++; next.lengthMissing += length; } else next.lengthTagged += length;
        if (result.status === 'review') next.review++;
      }
      lastResults = results;
      stats = next;
      legendCountry = legendCountries.size === 1 ? [...legendCountries][0] : legendCountries.size ? null : (viewCountry || '');
      drawIcons();
      updateLegend();
      if (panelWay) refreshPanelFromMap();
    }

    function scheduleRedraw() {
      if (redrawPending) return;
      redrawPending = true;
      requestAnimationFrame(redraw);
    }

    // -------------------------------------------------------------------------
    // Zone icons on the roads
    // -------------------------------------------------------------------------

    /** @param {string} name @param {Record<string, string | number>} attrs */
    function svgElement(name, attrs) {
      const el = document.createElementNS(SVG_NS, name);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      return el;
    }

    /** Puts the sign artwork as <symbol>s into the map (in a <g>: iD looks up its own <defs>). @param {SVGSVGElement} svg */
    function ensureArt(svg) {
      if (svg.querySelector(':scope > g.ozt-art')) return;
      const holder = svgElement('g', { class: 'ozt-art' });
      const markup = Object.entries(SIGN_ART).map(([key, art]) =>
        `<symbol id="ozt-sign-${key}" viewBox="0 0 ${art.width} ${art.height}">${art.svg}</symbol>`).join('');
      const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${markup}</svg>`, 'image/svg+xml');
      for (const symbol of Array.from(doc.documentElement.children)) holder.append(document.importNode(symbol, true));
      svg.prepend(holder);
    }

    /** Sign key for a kind under these rules. @param {Rules} rules @param {Kind} kind */
    const signKey = (rules, kind) => rules.signs[kind] || NEUTRAL_SIGNS[kind];

    /**
     * One icon: sign (grey if no valid value), badge "?" (suggestion) or "!" (check).
     * @param {string} id @param {Result} result @param {number} x @param {number} y
     */
    function iconFor(id, result, x, y) {
      const rules = /** @type {Rules} */ (result.rules);
      const g = /** @type {SVGGElement} */ (svgElement('g', { class: 'ozt-icon', 'data-way': id, transform: `translate(${x.toFixed(1)},${y.toFixed(1)})`, 'pointer-events': 'all', cursor: 'pointer' }));
      const kind = result.status === 'missing' ? result.suggestion?.kind || null : result.kind || result.suggestion?.kind || null;
      let half = ICON_HEIGHT / 2;
      if (kind) {
        const art = SIGN_ART[signKey(rules, kind)];
        const w = art ? Math.min(ICON_HEIGHT * 1.8, (ICON_HEIGHT * art.width) / art.height) : ICON_HEIGHT;
        half = w / 2;
        g.append(svgElement('rect', { x: -half - 1.5, y: -ICON_HEIGHT / 2 - 1.5, width: 2 * half + 3, height: ICON_HEIGHT + 3, rx: 3, fill: '#fff', 'fill-opacity': 0.85 }));
        const sign = svgElement('use', { href: `#ozt-sign-${signKey(rules, kind)}`, x: -half, y: -ICON_HEIGHT / 2, width: 2 * half, height: ICON_HEIGHT });
        // Grey for a missing value (CSSOM: openstreetmap.org's CSP drops style attributes).
        if (result.status === 'missing') /** @type {SVGElement} */ (sign).style.filter = 'grayscale(1) opacity(.7)';
        g.append(sign);
      } else {
        g.append(svgElement('circle', { r: ICON_HEIGHT / 2, fill: '#9e9e9e', stroke: '#fff', 'stroke-width': 1.5 }));
        const q = svgElement('text', { 'text-anchor': 'middle', y: 5, fill: '#fff', 'font-size': 14, 'font-weight': 700, 'font-family': 'system-ui,sans-serif' });
        q.textContent = '?';
        g.append(q);
      }
      const badge = result.status === 'review' ? ['!', COLORS.review, '#000']
        : result.status === 'unusual' ? ['~', COLORS.unusual, '#000']
        : result.status === 'missing' && kind ? ['?', '#616161', '#fff'] : null;
      if (badge) {
        const bx = half + 1, by = -ICON_HEIGHT / 2;
        g.append(svgElement('circle', { cx: bx, cy: by, r: 6.5, fill: badge[1], stroke: '#fff', 'stroke-width': 1.2 }));
        const t = svgElement('text', { x: bx, y: by + 3.6, 'text-anchor': 'middle', fill: badge[2], 'font-size': 10, 'font-weight': 700, 'font-family': 'system-ui,sans-serif' });
        t.textContent = badge[0];
        g.append(t);
      }
      if (id === panelWay || id === selectedWayId()) {
        g.prepend(svgElement('rect', { x: -half - 4, y: -ICON_HEIGHT / 2 - 4, width: 2 * half + 8, height: ICON_HEIGHT + 8, rx: 5, fill: 'none', stroke: '#1e88e5', 'stroke-width': 2.5 }));
      }
      // The map must not see clicks on the icon (no selection, no panning).
      for (const type of ['mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'touchstart']) {
        g.addEventListener(type, (event) => event.stopPropagation());
      }
      g.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        if (event.button === 0) pressed = { id, x: event.clientX, y: event.clientY };
      });
      return g;
    }

    // A click on an icon is taken from pointerdown on the icon and pointerup anywhere
    // close by. A "click" event would get lost: iD changes the map on hover, the icons
    // are redrawn, and the element pressed is gone before the button is released
    // (panel did not open on openstreetmap.org, 2026-10-26).
    /** @type {{ id: string, x: number, y: number } | null} */
    let pressed = null;
    window.addEventListener('pointerup', (event) => {
      const press = pressed;
      pressed = null;
      if (!press || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) return;
      event.stopPropagation();
      openPanel(press.id, { x: press.x, y: press.y });
    }, true);

    function drawIcons() {
      const first = /** @type {SVGPathElement | undefined} */ (lastResults.values().next().value?.path);
      const svg = first ? first.ownerSVGElement : null;
      if (!svg) { iconLayer?.replaceChildren(); return; }
      if (!iconLayer || !iconLayer.isConnected) iconLayer = /** @type {SVGGElement} */ (svgElement('g', { class: 'ozt-icons', 'pointer-events': 'none' }));
      if (svg.lastChild !== iconLayer) svg.append(iconLayer);
      const fragment = document.createDocumentFragment();
      const layerMatrix = iconLayer.getCTM();
      if (settings.enabled && settings.icons && layerMatrix) {
        ensureArt(svg);
        const toLayer = layerMatrix.inverse();
        /** @type {Array<[number, number]>} */
        const placed = [];
        for (const [id, { result, path }] of lastResults) {
          if (settings.hidden.has(result.status)) continue;
          let length;
          try { length = path.getTotalLength(); } catch { continue; }
          if (length < ICON_MIN_LINE) continue;
          const m = path.getCTM();
          const toIcons = m ? toLayer.multiply(m) : null;
          // Middle of the line, or a bit aside if another icon is there already.
          for (const at of [0.5, 0.3, 0.7]) {
            const p = path.getPointAtLength(length * at);
            const q = toIcons ? new DOMPoint(p.x, p.y).matrixTransform(toIcons) : p;
            if (placed.some(([x, y]) => Math.abs(x - q.x) < 34 && Math.abs(y - q.y) < 26)) continue;
            placed.push([q.x, q.y]);
            fragment.append(iconFor(id, result, q.x, q.y));
            break;
          }
        }
      }
      iconLayer.replaceChildren(fragment);
      checkTooltip();
    }

    // -------------------------------------------------------------------------
    // Tooltip
    // -------------------------------------------------------------------------

    const tooltip = document.createElement('div');
    tooltip.style.cssText = [
      'position:fixed', 'z-index:1003', 'pointer-events:none', 'white-space:pre-line',
      'background:rgba(20,20,20,.92)', 'color:#fff', 'font:12px/1.4 system-ui,sans-serif',
      'padding:5px 7px', 'border-radius:4px', 'max-width:340px', 'overflow-wrap:anywhere',
    ].join(';');
    tooltip.hidden = true;

    /** Lines describing a result (tooltip and panel). @param {Result} r */
    function describe(r) {
      const t = text();
      const rules = /** @type {Rules} */ (r.rules);
      const lines = [];
      lines.push(r.value ? `zone:traffic=${r.value}${r.status === 'ok' ? ' ✓' : r.status === 'unusual' ? ' ~' : ' ⚠'}` : t.noValue);
      const region = rules.regions.length === 1 ? ` · ${countries[rules.code]?.regions?.[rules.regions[0]]?.[LANG] || rules.regions[0]}` : '';
      lines.push(`${rules.name}${region} · ${rules.verified ? t.verified : t.notVerified} · ${rules.editor ? t.beta : t.prototype}`);
      if (r.suggestion) lines.push(`${t.suggestion}: ${r.suggestion.value} (${t.kinds[r.suggestion.kind]})`);
      return lines;
    }

    /** @param {string} id @param {MouseEvent} event */
    function showTooltip(id, event) {
      const entry = lastResults.get(id);
      if (!entry) { tooltip.hidden = true; return; }
      const r = entry.result;
      const t = text();
      const lines = describe(r);
      if (r.reasons.length) lines.push(`${t.reasons}:`, ...r.reasons.map((m) => `• ${messageText(m)}`));
      if (r.problems.length) lines.push(`${t.problems}:`, ...r.problems.map((m) => `• ${messageText(m)}`));
      const notes = r.notes.filter((n) => n.code !== 'beta' && n.code !== 'prototype' && n.code !== 'unverified');
      if (notes.length) lines.push(`${t.notes}:`, ...notes.map((m) => `• ${messageText(m)}`));
      lines.push(t.clickHint);
      if (!tooltip.isConnected) document.body.append(tooltip);
      tooltip.textContent = lines.join('\n');
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(0, Math.min(event.clientX + 14, window.innerWidth - tooltip.offsetWidth - 4))}px`;
      tooltip.style.top = `${Math.max(0, Math.min(event.clientY + 14, window.innerHeight - tooltip.offsetHeight - 4))}px`;
    }

    /** Last pointer position, to check the tooltip after a redraw. */
    let lastPointer = { x: -1, y: -1 };
    /** After a redraw: hide the tooltip unless an icon is still under the pointer. */
    function checkTooltip() {
      if (tooltip.hidden) return;
      if (!document.elementFromPoint(lastPointer.x, lastPointer.y)?.closest('.ozt-icon')) tooltip.hidden = true;
    }

    // The icons are redrawn on every map change, so an icon under the pointer can be
    // replaced without a mouseleave (tooltip stayed, 2026-10-26). Whatever is under the
    // pointer decides instead; capture phase, as iD stops some events on the map.
    window.addEventListener('mousemove', (event) => {
      const target = /** @type {Element | null} */ (event.target instanceof Element ? event.target : null);
      const icon = target?.closest('.ozt-icon');
      const id = icon?.getAttribute('data-way');
      lastPointer = { x: event.clientX, y: event.clientY };
      if (id) showTooltip(id, event);
      else if (!tooltip.hidden) tooltip.hidden = true;
    }, { capture: true, passive: true });
    for (const type of ['pointerdown', 'wheel']) window.addEventListener(type, () => { tooltip.hidden = true; }, { capture: true, passive: true });

    // -------------------------------------------------------------------------
    // Panel next to the icon (details and, in editor mode, the input)
    // -------------------------------------------------------------------------

    /** Full geometry from the OSM API, per way id and version. @type {Map<string, Promise<any>>} */
    const fullWays = new Map();
    /** Extra context from the API for the open panel. @type {{ id: string, place: Place | null, signs: Context['signs'] | null, stale: boolean, loading: boolean }} */
    let panelData = { id: '', place: null, signs: null, stale: false, loading: false };
    /** Status line of the panel. */
    let panelStatus = { text: '', error: false };
    /** Chosen value and confirmations survive re-rendering. */
    let panelChoice = { value: '', replace: false };
    let panelBusy = false;

    /** Id of the way iD has selected, "" if none or something else. */
    function selectedWayId() {
      const container = document.querySelector('.ideditor');
      if (!container || !container.classList.contains('mode-select')) return '';
      const ids = new URLSearchParams(location.hash.slice(1)).get('id') || '';
      return /^w-?\d+$/.test(ids) ? ids : '';
    }

    /** @param {string} id @param {{ x: number, y: number }} at  Screen point of the icon. */
    async function openPanel(id, at) {
      tooltip.hidden = true;
      try {
        if (panelWay !== id) {
          panelChoice = { value: '', replace: false };
          panelStatus = { text: '', error: false };
          panelData = { id, place: null, signs: null, stale: false, loading: false };
        }
        panelWay = id;
        // Select the way in iD too, like a click on the road: its tags show in the
        // sidebar and the input later works on this very way.
        if (!panelBusy) await selectWay(id);
        if (panelWay !== id) return;
        renderPanel();
        placePanel(at);
        loadFullWay(id);
        scheduleRedraw();
      } catch (error) {
        console.warn('[OSM Traffic Zone Inspector]', error);
      }
    }

    function closePanel() {
      panelWay = '';
      panel?.remove();
      panel = null;
      scheduleRedraw();
    }

    window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && panelWay && !panelBusy) closePanel(); });

    /** @param {{ x: number, y: number }} at */
    function placePanel(at) {
      if (!panel) return;
      const w = panel.offsetWidth, h = panel.offsetHeight;
      let left = at.x + 26;
      if (left + w > window.innerWidth - 8) left = Math.max(8, at.x - w - 26);
      const top = Math.max(8, Math.min(at.y - 30, window.innerHeight - h - 8));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    }

    /** The way's entity as drawn now. @param {string} id */
    function drawnWay(id) {
      for (const path of document.querySelectorAll('.layer-osm.lines path.way.line.stroke')) {
        const e = entityOf(path);
        if (e && e.id === id) return { entity: e, path: /** @type {SVGPathElement} */ (path) };
      }
      return null;
    }

    /**
     * Reads the saved geometry of a way from the OSM API (read only) when it reaches
     * beyond the map. Local edits win: the tags always come from iD, and if the node
     * list differs, the API data is not used.
     * @param {string} id
     */
    function loadFullWay(id) {
      const drawn = drawnWay(id);
      const entry = lastResults.get(id);
      if (!drawn || !entry || !/^w\d+$/.test(id) || !entry.result.rules) return;
      const place = placeOfPath(drawn.path, id);
      if (!place.partial) return;
      const key = `${id}@${drawn.entity.version || ''}`;
      let request = fullWays.get(key);
      if (!request) {
        request = fetch(`https://api.openstreetmap.org/api/0.6/way/${id.slice(1)}/full.json`, { credentials: 'omit' })
          .then((r) => (r.ok ? r.json() : null)).catch(() => null);
        fullWays.set(key, request);
      }
      panelData.loading = true;
      renderPanel();
      request.then((data) => {
        if (panelWay !== id) return;
        panelData.loading = false;
        const elements = Array.isArray(data?.elements) ? data.elements : [];
        const way = elements.find((/** @type {any} */ el) => el.type === 'way' && `w${el.id}` === id);
        /** @type {Map<string, any>} */
        const nodes = new Map(elements.filter((/** @type {any} */ el) => el.type === 'node').map((/** @type {any} */ el) => [`n${el.id}`, el]));
        const current = drawnWay(id);
        if (!way || !current) { renderPanel(); return; }
        const apiNodes = way.nodes.map((/** @type {number} */ n) => `n${n}`);
        const localNodes = current.entity.nodes || [];
        if (apiNodes.join() !== localNodes.join() || apiNodes.some((/** @type {string} */ n) => !nodes.has(n))) {
          panelData.stale = true;
          renderPanel();
          return;
        }
        /** @type {Array<[number, number]>} */
        const points = apiNodes.map((/** @type {string} */ n) => [nodes.get(n).lon, nodes.get(n).lat]);
        // Many nodes: every n-th is enough for the country, the ends are always used.
        const step = Math.max(1, Math.floor(points.length / 40));
        const sampled = points.filter((_, i) => i % step === 0 || i === points.length - 1);
        panelData.place = placeOf(sampled, countryAt, false);
        const around = collectSurroundings([]);
        panelData.signs = signsAlong(localNodes, (n) => around.nodeTags.get(n) || nodes.get(n)?.tags);
        renderPanel();
      });
    }

    /** Current result for the panel's way, with the API data if loaded. */
    function panelResult() {
      const drawn = drawnWay(panelWay);
      if (!drawn) return null;
      const lines = /** @type {SVGPathElement[]} */ (Array.from(document.querySelectorAll('.layer-osm.lines path.way.line.stroke')));
      const around = collectSurroundings(lines);
      const place = panelData.place || placeOfPath(drawn.path, panelWay);
      const ctx = contextFor(drawn.entity, around, place);
      if (panelData.signs) ctx.signs = panelData.signs;
      if (panelData.stale && place.partial) ctx.stale = true;
      return { result: evaluate(drawn.entity.tags, ctx), entity: drawn.entity };
    }

    let panelKey = '';
    function refreshPanelFromMap() {
      const now = panelResult();
      const key = now ? JSON.stringify([now.result, now.entity.tags]) : '';
      if (key !== panelKey && !panelBusy) renderPanel();
    }

    /** @param {string} tag @param {string} [css] @param {string} [content] */
    function el(tag, css = '', content = '') {
      const e = document.createElement(tag);
      if (css) e.style.cssText = css;
      if (content) e.textContent = content;
      return e;
    }

    function renderPanel() {
      if (!panelWay) return;
      const t = text();
      const now = panelResult();
      panelKey = now ? JSON.stringify([now.result, now.entity.tags]) : '';
      if (!panel || !panel.isConnected) {
        panel = /** @type {HTMLDivElement} */ (el('div', [
          'position:fixed', 'z-index:1002', 'width:320px', 'max-height:calc(100vh - 16px)', 'overflow:auto', 'box-sizing:border-box',
          'background:#fff', 'color:#1a1a1a', 'font:12px/1.45 system-ui,sans-serif', 'padding:8px 10px',
          'border-radius:8px', 'box-shadow:0 4px 18px rgba(0,0,0,.35)', 'left:400px', 'top:80px',
        ].join(';')));
        for (const type of ['pointerdown', 'mousedown', 'wheel', 'keydown', 'dblclick']) panel.addEventListener(type, (event) => event.stopPropagation());
        document.body.append(panel);
      }
      const box = panel;
      box.replaceChildren();
      const header = el('div', 'display:flex;align-items:center;gap:6px;font-weight:700;margin-bottom:4px');
      header.append(el('span', 'flex:1', `${t.title} · ${panelWay}`));
      const close = /** @type {HTMLButtonElement} */ (el('button', 'border:0;background:none;font:16px/1 system-ui;cursor:pointer;padding:0 2px', '×'));
      close.title = t.close;
      close.addEventListener('click', closePanel);
      header.append(close);
      box.append(header);
      if (!now) { box.append(el('div', 'color:#666', t.fail.changed)); return; }
      const { result: r, entity } = now;
      if (!r.rules) { box.append(el('div', '', `${entity.tags.highway || ''}: ${t.none}`)); return; }
      const rules = r.rules;

      const roadName = roadNames.get(entity.tags.highway)?.[LANG] || entity.tags.highway;
      box.append(el('div', 'color:#555', `${entity.tags.name ? `${entity.tags.name} · ` : ''}highway=${entity.tags.highway} (${roadName})`));
      const countryLine = el('div', 'margin:2px 0 6px');
      countryLine.append(`${rules.name}${rules.regions.length === 1 ? ` · ${countries[rules.code]?.regions?.[rules.regions[0]]?.[LANG] || rules.regions[0]}` : ''} `);
      const badge = (/** @type {string} */ label, /** @type {string} */ color) => {
        const b = el('span', `display:inline-block;margin-left:4px;padding:0 6px;border-radius:9px;color:#fff;font-size:11px;background:${color}`, label);
        countryLine.append(b);
      };
      badge(rules.verified ? t.verified : t.notVerified, rules.verified ? '#2e7d32' : '#c62828');
      badge(rules.editor ? t.beta : t.prototype, rules.editor ? '#1565c0' : '#757575');
      box.append(countryLine);

      const statusColor = r.status === 'ok' ? COLORS.ok : r.status === 'unusual' ? '#689f38' : r.status === 'missing' ? COLORS.missing : '#b58900';
      box.append(el('div', `font-weight:600;color:${statusColor}`, `${t.current}: ${r.value ? `zone:traffic=${r.value}` : t.noValue}`));
      box.append(el('div', 'margin-top:2px', r.suggestion ? `${t.suggestion}: ${r.suggestion.value} (${t.kinds[r.suggestion.kind]})` : (r.status === 'ok' ? '' : t.noSuggestion)));

      /** @param {string} title @param {Message[]} list @param {string} color */
      const section = (title, list, color) => {
        if (!list.length) return;
        box.append(el('div', `margin-top:6px;font-weight:600;color:${color}`, `${title}:`));
        const ul = el('ul', 'margin:2px 0 0 16px;padding:0');
        for (const m of list) ul.append(el('li', '', messageText(m)));
        box.append(ul);
      };
      section(t.reasons, r.reasons, '#333');
      section(t.problems, r.problems, '#b58900');
      section(t.notes, r.notes.filter((n) => n.code !== 'beta' && n.code !== 'prototype'), '#555');
      if (panelData.loading) box.append(el('div', 'margin-top:6px;color:#666', t.loading));

      // Input, only in editor mode, for enabled countries and clear cases.
      const form = el('div', 'margin-top:8px;padding-top:8px;border-top:1px solid #ddd');
      box.append(form);
      if (!settings.editor) { form.append(el('div', 'color:#666', t.editorOff)); return; }
      if (!rules.editor) { form.append(el('div', 'color:#666', t.editorCountry)); return; }
      const blocked = r.blocked.filter((m, i, all) => all.findIndex((x) => JSON.stringify(x) === JSON.stringify(m)) === i);
      if (blocked.length) {
        section(t.blockedTitle, blocked, '#c62828');
        return;
      }
      const select = /** @type {HTMLSelectElement} */ (el('select', 'width:100%;font:inherit;padding:3px;margin:2px 0 6px'));
      for (const o of r.options) {
        const option = /** @type {HTMLOptionElement} */ (el('option', '', `${o.value} – ${t.kinds[o.kind]}${o.fits ? '' : ` (⚠ ${t.notFitting})`}`));
        option.value = o.value;
        select.append(option);
      }
      if (!panelChoice.value || !r.options.some((o) => o.value === panelChoice.value)) {
        panelChoice.value = r.suggestion?.value || (r.status === 'missing' ? '' : r.value);
      }
      if (!panelChoice.value) {
        const empty = /** @type {HTMLOptionElement} */ (el('option', '', '…'));
        empty.value = '';
        select.prepend(empty);
      }
      select.value = panelChoice.value;
      const label = el('div', 'font-weight:600', t.choose);
      form.append(label, select);

      // No "applies to the whole way" confirmation: a tag always applies to the whole way,
      // and a way crossing a town sign is split before tagging (user, 2026-10-26). Town
      // signs inside the way and borders still block the input.
      /** @param {string} labelText @param {'replace'} key */
      const checkbox = (labelText, key) => {
        const row = el('label', 'display:flex;gap:6px;align-items:flex-start;margin:3px 0;cursor:pointer');
        const input = /** @type {HTMLInputElement} */ (el('input'));
        input.type = 'checkbox';
        input.checked = panelChoice[key];
        input.style.marginTop = '2px';
        input.addEventListener('change', () => { panelChoice[key] = input.checked; update(); });
        row.append(input, el('span', '', labelText));
        form.append(row);
      };
      const replacing = () => !!r.value && panelChoice.value !== r.value;
      if (r.value) checkbox(t.confirmReplace(r.value), 'replace');

      const button = /** @type {HTMLButtonElement} */ (el('button', 'margin-top:6px;width:100%;padding:5px;font:600 12px system-ui,sans-serif;border:0;border-radius:6px;color:#fff;cursor:pointer', t.insert));
      const update = () => {
        const ready = !!panelChoice.value && panelChoice.value !== r.value && (!replacing() || panelChoice.replace) && !panelBusy;
        button.disabled = !ready;
        button.style.background = ready ? '#1565c0' : '#9e9e9e';
        button.style.cursor = ready ? 'pointer' : 'default';
      };
      select.addEventListener('change', () => { panelChoice.value = select.value; update(); });
      button.addEventListener('click', () => { if (!button.disabled) insertValue(panelWay, panelChoice.value, entity.tags); });
      form.append(button);
      form.append(el('div', 'margin-top:4px;color:#666;font-size:11px', t.betaNote));
      if (panelStatus.text) form.append(el('div', `margin-top:6px;font-weight:600;color:${panelStatus.error ? '#c62828' : '#2e7d32'}`, panelStatus.text));
      update();
    }

    // -------------------------------------------------------------------------
    // Inserting into iD's tag text box
    // -------------------------------------------------------------------------

    const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /** Waits until check() returns something truthy. @template T @param {() => T} check @param {number} ms */
    async function waitFor(check, ms = 2000) {
      const end = Date.now() + ms;
      for (;;) {
        const value = check();
        if (value || Date.now() > end) return value;
        await sleep(80);
      }
    }

    /**
     * Selects the way in iD like a click on it: iD's own click area (the "target"
     * path of one of its segments) gets pointer events at a visible point.
     * @param {string} id
     */
    async function selectWay(id) {
      if (selectedWayId() === id) return true;
      const targets = Array.from(document.querySelectorAll('.layer-touch path.target')).filter((p) => {
        const d = /** @type {any} */ (p).__data__;
        return d && (d.properties?.entity?.id === id || (typeof d.id === 'string' && d.id.startsWith(`${id}-`)));
      });
      const hidden = [iconLayer, panel].filter((x) => x);
      // Our icon and panel must not be hit by the click.
      for (const h of hidden) /** @type {any} */ (h).style.visibility = 'hidden';
      try {
        for (const target of /** @type {SVGPathElement[]} */ (targets)) {
          let length;
          try { length = target.getTotalLength(); } catch { continue; }
          const m = target.getScreenCTM();
          if (!m) continue;
          for (const at of [0.5, 0.25, 0.75]) {
            const p = new DOMPoint(target.getPointAtLength(length * at).x, target.getPointAtLength(length * at).y).matrixTransform(m);
            if (document.elementFromPoint(p.x, p.y) !== target) continue;
            const init = { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, screenX: p.x, screenY: p.y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window };
            target.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
            await sleep(20);
            target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
            target.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
            if (await waitFor(() => selectedWayId() === id, 1500)) return true;
          }
        }
      } finally {
        for (const h of hidden) /** @type {any} */ (h).style.visibility = '';
      }
      return selectedWayId() === id;
    }

    /**
     * Puts zone:traffic=value into iD's tag text box of the selected way and lets iD
     * take it over with a "change" event, as after typing. Afterwards checks that
     * iD's data of the way has exactly the expected tags.
     * @param {string} id @param {string} value @param {Tags} before  Tags when the user confirmed.
     */
    async function insertValue(id, value, before) {
      const t = text();
      panelBusy = true;
      panelStatus = { text: '', error: false };
      /** @param {string} message @param {boolean} [error] */
      const finish = (message, error = true) => {
        panelBusy = false;
        panelStatus = { text: message, error };
        renderPanel();
      };
      try {
        const drawn = drawnWay(id);
        if (!drawn || !sameTags(drawn.entity.tags, before)) return finish(t.fail.changed);
        if (!(await selectWay(id))) return finish(t.fail.select);
        const section = await waitFor(() => document.querySelector('.entity-editor-pane .section-raw-tag-editor'));
        if (!section) return finish(t.fail.textbox);
        const details = section.querySelector('details.disclosure-wrap');
        if (details && !(/** @type {HTMLDetailsElement} */ (details)).open) /** @type {HTMLElement | null} */ (section.querySelector('summary.hide-toggle'))?.click();
        const textarea = /** @type {HTMLTextAreaElement | null} */ (await waitFor(() => section.querySelector('textarea.tag-text')));
        if (!textarea) return finish(t.fail.textbox);
        if (document.activeElement === textarea) return finish(t.fail.focus);
        if (selectedWayId() !== id) return finish(t.fail.select);
        const current = drawnWay(id);
        if (!current || !sameTags(current.entity.tags, before) || !sameTags(parseTagText(textarea.value), before)) return finish(t.fail.mismatch);
        const edit = setInTagText(textarea.value, 'zone:traffic', value);
        if ('error' in edit) return finish(t.fail.duplicate);
        if (!edit.changed) return finish(t.unchanged, false);
        textarea.value = edit.text;
        textarea.dispatchEvent(new Event('change'));
        const expected = { ...before, 'zone:traffic': value };
        const ok = await waitFor(() => { const now = drawnWay(id); return now && sameTags(now.entity.tags, expected); }, 2000);
        if (!ok) return finish(t.fail.verify);
        finish(t.done(value), false);
      } catch {
        finish(t.fail.verify);
      }
    }

    // -------------------------------------------------------------------------
    // Legend with statistics (display only – the controls are in the popup)
    // -------------------------------------------------------------------------

    let keepLegendInWindow = () => {};
    window.addEventListener('resize', () => keepLegendInWindow());
    let legendBody = /** @type {HTMLDivElement | null} */ (null);

    function updateLegend() {
      if (!(settings.enabled && settings.legend)) {
        if (legend) { legend.remove(); legend = null; }
        return;
      }
      if (!legend || !legend.isConnected) buildLegend();
      fillLegend();
    }

    function buildLegend() {
      const t = text();
      const box = /** @type {HTMLDivElement} */ (el('div', [
        'position:fixed', 'right:56px', 'bottom:46px', 'z-index:1000', 'width:max-content', 'max-width:300px',
        'background:rgba(20,20,20,.85)', 'color:#fff', 'font:12px/1.4 system-ui,sans-serif',
        'padding:6px 8px', 'border-radius:6px', 'user-select:none', 'pointer-events:auto',
        'max-height:calc(100vh - 56px)', 'overflow:auto', 'box-sizing:border-box',
      ].join(';')));
      legend = box;
      const header = el('div', 'display:flex;gap:6px;align-items:center;font-weight:600');
      const handle = el('span', 'flex:1;cursor:move;touch-action:none', `⠿ ${t.title}`);
      handle.title = t.drag;
      const fold = /** @type {HTMLButtonElement} */ (el('button', 'background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:0 2px;line-height:1'));
      header.append(handle, fold);
      legendBody = /** @type {HTMLDivElement} */ (el('div', 'margin-top:4px'));
      box.append(header, legendBody);
      const applyFold = () => {
        if (legendBody) legendBody.hidden = legendState.collapsed;
        fold.textContent = legendState.collapsed ? '▸' : '▾';
        fold.title = legendState.collapsed ? t.unfold : t.fold;
      };
      fold.addEventListener('click', () => { legendState.collapsed = !legendState.collapsed; applyFold(); saveLegendState(); keepLegendInWindow(); });
      applyFold();
      for (const type of ['pointerdown', 'mousedown', 'wheel', 'dblclick']) box.addEventListener(type, (event) => event.stopPropagation());
      document.body.append(box);

      /** @param {number} x @param {number} y */
      const moveTo = (x, y) => {
        const w = box.offsetWidth, h = box.offsetHeight;
        box.style.left = `${Math.max(0, Math.min(x, window.innerWidth - w))}px`;
        box.style.top = `${Math.max(0, Math.min(y, window.innerHeight - h))}px`;
        box.style.right = 'auto';
        box.style.bottom = 'auto';
      };
      keepLegendInWindow = () => { if (legendState.pos) moveTo(legendState.pos.x, legendState.pos.y); };
      keepLegendInWindow();
      handle.addEventListener('pointerdown', (down) => {
        down.preventDefault();
        const startBox = box.getBoundingClientRect();
        const dx = down.clientX - startBox.left, dy = down.clientY - startBox.top;
        handle.setPointerCapture(down.pointerId);
        const onMove = (/** @type {PointerEvent} */ move) => moveTo(move.clientX - dx, move.clientY - dy);
        const onUp = () => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          const end = box.getBoundingClientRect();
          legendState.pos = { x: Math.round(end.left), y: Math.round(end.top) };
          saveLegendState();
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
      });
    }

    let legendKey = '';
    function fillLegend() {
      if (!legendBody) return;
      const t = text();
      const key = JSON.stringify([stats, legendCountry, LANG, settings.stats, [...settings.hidden]]);
      if (key === legendKey) return;
      legendKey = key;
      const body = legendBody;
      body.replaceChildren();
      /** @param {string} color @param {string} label */
      const swatch = (color, label) => {
        const row = el('div', 'display:flex;align-items:center;gap:6px');
        row.append(el('span', `display:inline-block;width:22px;height:5px;border-radius:2px;background:${color}`), el('span', '', label));
        body.append(row);
      };
      if (!settings.hidden.has('ok')) swatch(COLORS.ok, t.ok);
      if (!settings.hidden.has('unusual')) swatch(COLORS.unusual, t.unusual);
      if (!settings.hidden.has('missing')) swatch(COLORS.missing, t.missing);
      if (!settings.hidden.has('review')) swatch(COLORS.review, t.review);
      body.append(el('div', 'opacity:.8;margin-top:2px', `${t.iconGrey} · ${t.iconQuestion} · ${t.iconWarn} · ${t.iconUnusual}`));

      const countryRow = el('div', 'margin-top:4px');
      if (legendCountry === null) countryRow.append(`${t.viewCountry}: ${t.several}`);
      else if (!legendCountry || !rulesFor(legendCountry)) countryRow.append(`${t.viewCountry}: ${t.none}`);
      else {
        const rules = /** @type {Rules} */ (rulesFor(legendCountry));
        countryRow.append(`${t.viewCountry}: ${rules.name} `);
        const badge = (/** @type {string} */ label, /** @type {string} */ color) =>
          countryRow.append(el('span', `display:inline-block;margin-left:3px;padding:0 5px;border-radius:8px;font-size:11px;background:${color}`, label));
        badge(rules.verified ? t.verified : t.notVerified, rules.verified ? '#2e7d32' : '#c62828');
        badge(rules.editor ? t.beta : t.prototype, rules.editor ? '#1565c0' : '#616161');
      }
      body.append(countryRow);

      if (settings.stats) {
        const km = (/** @type {number} */ m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
        body.append(el('div', 'margin-top:5px;font-weight:600', t.statsTitle));
        const table = el('div', 'display:grid;grid-template-columns:auto auto;column-gap:10px');
        /** @param {string} label @param {string} value */
        const row = (label, value) => { table.append(el('span', 'opacity:.8', label), el('span', 'text-align:right', value)); };
        row(t.statsWays, String(stats.ways));
        row(t.statsOk, String(stats.ok));
        row(t.statsMissing, String(stats.missing));
        row(t.statsUnusual, String(stats.unusual));
        row(t.statsReview, String(stats.review));
        row(t.statsLength, km(stats.length));
        row(t.statsLengthMissing, km(stats.lengthMissing));
        row(t.statsCoverage, stats.length ? `${Math.round((100 * stats.lengthTagged) / stats.length)} %` : '–');
        body.append(table);
        body.append(el('div', 'opacity:.7;font-size:11px;margin-top:2px;max-width:280px;white-space:normal', t.statsScope));
      }
      keepLegendInWindow();
    }

    // Redraw whenever the map changes. 'd' is watched too: when the map is moved,
    // iD only changes the path geometry, and the icons have to follow.
    // Our own updates are ignored, otherwise the layers would redraw forever.
    new MutationObserver((records) => {
      const ours = (/** @type {Node} */ node) => !!(iconLayer?.contains(node) || tooltip.contains(node) || legend?.contains(node) || panel?.contains(node));
      if (records.some((r) => !ours(r.target))) scheduleRedraw();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['d'] });
    scheduleRedraw();
  }
})();
