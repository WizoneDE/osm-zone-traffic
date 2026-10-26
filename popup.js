// @ts-check
/**
 * OSM Traffic Zone Inspector – toolbar popup.
 *
 * Shows the settings and saves every change to chrome.storage.sync right away.
 * bridge.js notices the change and passes it to the map, so open iD tabs update
 * immediately. Tables and the settings check come from settings.js.
 */

const POPUP_TEXT = {
  de: {
    enabled: 'Färbung der Straßen', icons: 'Zonen-Symbole', legend: 'Legende auf der Karte', stats: 'Statistik in der Legende',
    editor: 'Editor-Modus', editorHint: 'Klick auf ein Symbol bietet dann das Einfügen von zone:traffic in iDs Tag-Textbox an – nur nach deiner Bestätigung, nur in DE und NL. Gespeichert wird nie automatisch.',
    roads: 'Geprüfte Straßenklassen', countries: 'Länder', lang: 'Sprache',
    ok: 'korrekt', unusual: 'ungewöhnlich', missing: 'fehlt', review: 'prüfen',
    verified: 'verified', notVerified: 'not verified', beta: 'Editor Beta', prototype: 'Prototyp', unverifiedRow: 'übrige Länder Europas',
    source: (/** @type {string} */ edited, /** @type {string} */ checked) => `Werte laut OSM-Wiki Key:zone:traffic (Stand ${edited}, geprüft ${checked}).`,
    footer: 'Gilt sofort in allen offenen iD-Tabs. Die Erweiterung speichert und lädt nie etwas zu OpenStreetMap hoch.',
  },
  en: {
    enabled: 'Colour the roads', icons: 'Zone icons', legend: 'Legend on map', stats: 'Statistics in the legend',
    editor: 'Editor mode', editorHint: 'Clicking an icon then offers to insert zone:traffic into iD\'s tag text box – only after you confirm, only in DE and NL. Nothing is ever saved automatically.',
    roads: 'Road classes checked', countries: 'Countries', lang: 'Language',
    ok: 'correct', unusual: 'unusual', missing: 'missing', review: 'check',
    verified: 'verified', notVerified: 'not verified', beta: 'Editor beta', prototype: 'Prototype', unverifiedRow: 'other European countries',
    source: (/** @type {string} */ edited, /** @type {string} */ checked) => `Values from the OSM wiki Key:zone:traffic (as of ${edited}, checked ${checked}).`,
    footer: 'Applies at once to all open iD tabs. The extension never saves or uploads anything to OpenStreetMap.',
  },
};

/** On/off switches; each id equals its settings key. @type {Array<'enabled'|'icons'|'legend'|'stats'|'editor'>} */
const SWITCHES = ['enabled', 'icons', 'legend', 'stats', 'editor'];

/**
 * Element by id, checked to be of the expected type (fails loudly if popup.html changes).
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function byId(id, type) {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`popup.html: #${id} missing or not a ${type.name}`);
  return el;
}

/** @param {string} label @param {string} color */
function tag(label, color) {
  const span = document.createElement('span');
  span.className = 'tag';
  span.style.background = `var(${color})`;
  span.textContent = label;
  return span;
}

/**
 * Draws the popup for the given settings.
 * @param {Settings} s
 */
function render(s) {
  const words = POPUP_TEXT[s.lang];
  document.documentElement.lang = s.lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = /** @type {HTMLElement} */ (el).dataset.i18n;
    const value = key ? words[/** @type {keyof typeof words} */ (key)] : undefined;
    if (typeof value === 'string') el.textContent = value;
  }

  for (const key of SWITCHES) byId(key, HTMLInputElement).checked = s[key];
  for (const el of document.querySelectorAll('[data-needs]')) {
    const needs = (/** @type {HTMLElement} */ (el).dataset.needs || '').split(' ');
    el.classList.toggle('disabled', !needs.every((key) => s[/** @type {'enabled'} */ (key)]));
  }

  // Which statuses are shown on the map. Stored is the list of hidden ones.
  const colors = { ok: '#2e9d3a', unusual: '#a4c639', missing: '#e53935', review: '#f9c80e' };
  byId('statusList', HTMLDivElement).replaceChildren(.../** @type {const} */ (['ok', 'unusual', 'missing', 'review']).map((status) => {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !s.hidden.includes(status);
    box.addEventListener('change', () => {
      const hidden = s.hidden.filter((k) => k !== status);
      if (!box.checked) hidden.push(status);
      save({ hidden });
    });
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = colors[status];
    label.append(box, swatch, words[status]);
    return label;
  }));

  // Road classes, one checkbox each.
  byId('roadList', HTMLDivElement).replaceChildren(...OZT_ROAD_CLASSES.map(([key, , de, en]) => {
    const label = document.createElement('label');
    label.title = `highway=${key}`;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = s.roads.includes(key);
    box.addEventListener('change', () => {
      const roads = s.roads.filter((k) => k !== key);
      if (box.checked) roads.push(key);
      save({ roads });
    });
    label.append(box, `${s.lang === 'en' ? en : de}`);
    return label;
  }));

  // Countries with their status.
  const rows = Object.entries(OZT_COUNTRIES).map(([code, c]) => {
    const tr = document.createElement('tr');
    const tdCode = document.createElement('td'); tdCode.className = 'code'; tdCode.textContent = code;
    const tdName = document.createElement('td'); tdName.textContent = s.lang === 'en' ? c.en : c.de;
    const tdTags = document.createElement('td'); tdTags.className = 'right';
    tdTags.append(tag(c.verified ? words.verified : words.notVerified, c.verified ? '--ok' : '--bad'), ' ',
      tag(c.editor ? words.beta : words.prototype, c.editor ? '--beta' : '--proto'));
    tr.append(tdCode, tdName, tdTags);
    return tr;
  });
  const rest = document.createElement('tr');
  const restCode = document.createElement('td'); restCode.className = 'code'; restCode.textContent = '…';
  const restName = document.createElement('td'); restName.textContent = words.unverifiedRow;
  restName.title = OZT_UNVERIFIED.map(([code]) => code).join(', ');
  const restTags = document.createElement('td'); restTags.className = 'right';
  restTags.append(tag(words.notVerified, '--bad'), ' ', tag(words.prototype, '--proto'));
  rest.append(restCode, restName, restTags);
  byId('countryTable', HTMLTableElement).replaceChildren(...rows, rest);
  byId('sourceLine', HTMLDivElement).textContent = words.source(OZT_SOURCE.edited, OZT_SOURCE.checked);

  byId(`lang-${s.lang}`, HTMLInputElement).checked = true;
}

/** Reads the settings from storage and draws the popup. */
function load() {
  chrome.storage.sync.get(OZT_DEFAULTS, (stored) => render(oztCleanSettings(stored)));
}

/** Stores a change (after the same check the map applies) and redraws. @param {Partial<Settings>} change */
function save(change) {
  chrome.storage.sync.get(OZT_DEFAULTS, (stored) => {
    chrome.storage.sync.set(oztCleanSettings({ ...stored, ...change }), load);
  });
}

for (const key of SWITCHES) {
  const box = byId(key, HTMLInputElement);
  box.addEventListener('change', () => save({ [key]: box.checked }));
}
for (const radio of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name=lang]'))) {
  radio.addEventListener('change', () => save({ lang: radio.value === 'en' ? 'en' : 'de' }));
}

load();
