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
 *   (iD.locationManager, country-coder); the Belgian regions from borders in
 *   generated/regions.js. Only when the panel is opened for a way that reaches beyond the map, its
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
  // Generated data (generated/*.js)
  // ===========================================================================
  // The sign artwork and the Belgian region borders are written by the scripts in
  // dev/ into files of their own, so this one stays readable. The manifest runs
  // those files right before this one, at document_start and so before any script
  // of the page. They leave the data on a global, which is taken here and removed
  // at once.

  /** @typedef {{ width: number, height: number, svg: string }} SignArt  Inner SVG markup and viewBox size. */
  /** @typedef {{ toleranceM: number, rings: Record<string, string[]> }} RegionData  Rings per region, "lon,lat;dlon,dlat;…" in 1e-5 degrees. */
  /** @typedef {{ signArt: Record<string, SignArt>, regions: RegionData }} GeneratedData */

  const globals = /** @type {typeof globalThis & { __osmZoneTrafficData?: GeneratedData }} */ (globalThis);
  const GENERATED = globals.__osmZoneTrafficData;
  delete globals.__osmZoneTrafficData;
  if (!GENERATED?.signArt || !GENERATED.regions) {
    throw new Error('OSM Traffic Zone Inspector: generated/signs.js or generated/regions.js not loaded');
  }

  /**
   * Traffic signs from Wikimedia Commons (public domain as official works) and own
   * neutral symbols for countries without a public-domain sign, see dev/signs/.
   * After changing them run `node dev/build-signs.js`.
   */
  const SIGN_ART = GENERATED.signArt;
  /** Borders of Flanders and Brussels (OSM, ODbL), from `node dev/build-regions.js`. */
  const REGION_RINGS = GENERATED.regions.rings;
  /** How far the stored borders may lie off the real ones, in metres. */
  const REGION_TOLERANCE_M = GENERATED.regions.toleranceM;

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
    const atStart = kindsAt(ctx.neighbours.start);
    const atEnd = kindsAt(ctx.neighbours.end);
    const valueText = (/** @type {Kind[]} */ kinds) => kinds.map((k) => valueFor(rules, k) || text().kinds[k]).join('/');
    if (atStart.length === 1 && atEnd.length === 1 && atStart[0] === atEnd[0]) {
      hints.push({ kind: atStart[0], strength: 2, reason: { code: 'gap', value: valueText(atStart) } });
    } else if (atStart.length && atEnd.length) {
      notes.push({ code: 'transition', start: valueText(atStart), end: valueText(atEnd) });
    } else if (atStart.length === 1 || atEnd.length === 1) {
      const [kinds, place] = atStart.length === 1 ? [atStart, 'start'] : [atEnd, 'end'];
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
   * @param {(lon: number, lat: number) => string} lookup  Country code at a point (iD's lookup in the browser).
   * @param {boolean} partial
   * @returns {Place}
   */
  function placeOf(points, lookup, partial) {
    const { codes, sides } = locateAlong(points, lookup, 25);
    const country = codes.length === 1 ? codes[0] : '';
    /** @type {string[]} */
    let regions = [];
    if (codes.includes('BE') && countries.BE?.regions) {
      const at = (/** @type {number} */ lon, /** @type {number} */ lat) => (lookup(lon, lat) === 'BE' ? regionAt(lon, lat) : '');
      regions = locateAlong(points, at, Math.max(40, 2 * REGION_TOLERANCE_M)).codes;
    }
    return { country, countries: codes, sides, regions, partial };
  }

  // ===========================================================================
  // Export for the tests
  // ===========================================================================

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

  // ===========================================================================
  // Map state shared by the sections below
  // ===========================================================================

  // unusual: between green and yellow – not wrong, but odd.
  const COLORS = { ok: '#2e9d3a', unusual: '#a4c639', missing: '#e53935', review: '#f9c80e' };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_HEIGHT = 20; // px
  const ICON_MIN_LINE = 36; // px of visible line needed for an icon
  // iD draws tunnels (tunnel=yes etc.) in .layer-osm.covered, not in .lines.
  const WAY_STROKES = '.layer-osm.lines path.way.line.stroke, .layer-osm.covered path.way.line.stroke';

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

  /** @param {Element} element @returns {{ id: string, tags: Tags, nodes: string[], version?: string } | null} */
  function entityOf(element) {
    const data = /** @type {any} */ (element).__data__;
    if (!data || typeof data !== 'object' || typeof data.id !== 'string') return null;
    return data.tags && typeof data.tags === 'object' ? data : null;
  }

  function initSettings() {
    onSettingsChanged = () => {
      evaluationCache = new WeakMap();
      countryIds = null;
      if (legend) { legend.remove(); legend = null; }
      if (panelWay) renderPanel();
      scheduleRedraw();
    };
    window.postMessage({ __ozt: 'ready' }, location.origin);
  }

  // ===========================================================================
  // Map position and countries
  // ===========================================================================
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

  function initMapPosition() {
    // iD writes the map position into the URL only after the map has stopped
    // moving, and without a hashchange event; a changed URL triggers a redraw.
    let lastHash = location.hash;
    setInterval(() => {
      if (location.hash === lastHash) return;
      lastHash = location.hash;
      scheduleRedraw();
    }, 1000);
  }

  // ===========================================================================
  // Checking the visible ways
  // ===========================================================================

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
    const lines = /** @type {SVGPathElement[]} */ (Array.from(document.querySelectorAll(WAY_STROKES)));
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

  // ===========================================================================
  // Zone icons on the roads
  // ===========================================================================

  /** @param {string} name @param {Record<string, string | number>} attrs */
  function svgElement(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
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

  /** @type {{ id: string, x: number, y: number } | null} */
  let pressed = null;

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

  function initIcons() {
    // A click on an icon is taken from pointerdown on the icon and pointerup anywhere
    // close by. A "click" event would get lost: iD changes the map on hover, the icons
    // are redrawn, and the element pressed is gone before the button is released
    // (panel did not open on openstreetmap.org, 2026-10-26).
    window.addEventListener('pointerup', (event) => {
      const press = pressed;
      pressed = null;
      if (!press || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) return;
      event.stopPropagation();
      openPanel(press.id, { x: press.x, y: press.y });
    }, true);
  }

  // ===========================================================================
  // Tooltip
  // ===========================================================================

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

  function initTooltip() {
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
  }

  // ===========================================================================
  // Panel next to the icon (details and, in editor mode, the input)
  // ===========================================================================

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
    for (const path of document.querySelectorAll(WAY_STROKES)) {
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
      const way = elements.find((/** @type {any} */ e) => e.type === 'way' && `w${e.id}` === id);
      /** @type {Map<string, any>} */
      const nodes = new Map(elements.filter((/** @type {any} */ e) => e.type === 'node').map((/** @type {any} */ e) => [`n${e.id}`, e]));
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
    const lines = /** @type {SVGPathElement[]} */ (Array.from(document.querySelectorAll(WAY_STROKES)));
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

  function initPanel() {
    window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && panelWay && !panelBusy) closePanel(); });
  }

  // ===========================================================================
  // Inserting into iD's tag text box
  // ===========================================================================

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

  // ===========================================================================
  // Legend with statistics (display only – the controls are in the popup)
  // ===========================================================================

  const STORE = 'osm-zone-traffic';
  /** @type {{ pos: { x: number, y: number } | null, collapsed: boolean }} */
  const legendState = { pos: null, collapsed: false };
  const saveLegendState = () => {
    try { localStorage.setItem(STORE, JSON.stringify(legendState)); } catch { /* storage full or blocked */ }
  };
  let keepLegendInWindow = () => {};
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

  function initLegend() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
      if (saved && Number.isFinite(saved.pos?.x) && Number.isFinite(saved.pos?.y)) legendState.pos = { x: saved.pos.x, y: saved.pos.y };
      legendState.collapsed = saved?.collapsed === true;
    } catch { /* unreadable – keep the defaults */ }
    window.addEventListener('resize', () => keepLegendInWindow());
  }

  // ===========================================================================
  // Start, once iD's map exists
  // ===========================================================================
  // The sections above only declare state and functions. Listeners, timers and the
  // first redraw are set up here, when the map is there.

  function start() {
    initSettings();
    initMapPosition();
    initIcons();
    initTooltip();
    initPanel();
    initLegend();

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
