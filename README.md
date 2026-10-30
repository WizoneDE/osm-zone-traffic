# OSM Traffic Zone Inspector

*Deutsch weiter unten.*

## English

OSM Traffic Zone Inspector is a Chrome extension for the OpenStreetMap editor **iD** on
`openstreetmap.org` (*Edit* → iD). It shows which regular roads already carry
[`zone:traffic=*`](https://wiki.openstreetmap.org/wiki/Key:zone:traffic) – the zone of the
national traffic rules, e.g. `DE:urban` (inside the built-up area) or `DE:rural` – and
which do not. An optional editor mode helps to add or correct the tag.

**The extension never saves or uploads anything.** It only prepares a change in iD's
current edit state, after you picked the value and confirmed it; you review and save in
iD as usual.

What you see on the map:

- **Coloured roads.** Green: an official value of the country is set. Yellow-green
  (icon with **~**): valid but unusual – `urban`/`rural` on a `motorway_link`, which keeps
  its class up to the junction beyond the end of the motorway (in Germany sign 330.2),
  where it may lie in or outside a built-up area. Red: `zone:traffic` is missing. Yellow: to be checked – a wrong or misspelt value
  (`De:urban`, `DE:zone30`), a value of another country or region, a value that does not
  fit the road class (`DE:motorway` on a primary road), a conflict with other tags
  (`urban=no`, `source:maxspeed=DE:rural`, a town sign), direction- or side-dependent
  tagging, or a way crossing a border.
- **Zone icons** on the roads: a yellow town sign with a row of houses for urban, a
  sign with a road between trees for rural, and the country's motorway sign for motorway
  values (official signs from Wikimedia Commons for DE, NL, BE and PL, a neutral symbol
  elsewhere). In colour when the value is
  set, grey when it is missing. A grey icon with **?** carries a suggestion derived from
  other tags; **!** marks a case to check. Hover for the details and reasons.
- **Legend** with statistics for the visible map area: ways checked, correct, missing,
  special cases, length checked, length without `zone:traffic` and coverage by length.
  The numbers only cover the visible parts of the ways, never a whole country.

Which roads are checked: motorway, trunk, primary, secondary, tertiary (each with its
link roads), unclassified, residential and living_street. Service roads, pedestrian
streets and tracks can be added in the popup; footways, paths, cycleways and roads under
construction or proposed are never checked. `highway=*` only decides **which** roads are
checked – never whether a road is urban or rural.

### Suggestions (grey icon with ?)

A suggestion is only a default for the drop-down; nothing is set automatically. It comes
from:

- `source:maxspeed`, `maxspeed:type`, `zone:maxspeed` or `maxspeed` with a value such as
  `DE:urban` (strong),
- `urban=yes/no`,
- the road class: `highway=motorway(_link)` → the country's motorway value
  (`NL:rural` in the Netherlands), `motorroad=yes`/`expressway=yes` → `PL:expressway`,
- `highway=living_street` or `living_street=yes` → urban (weak; a living street is not
  automatically urban),
- joined sections: the same value at both ends of a gap, or at one end (weak),
- town signs (`traffic_sign=city_limit`, `DE:310`, `DE:311`, `NL:H01` …) at the start
  or end of the way, evaluated with their direction (`direction=forward/backward` or
  `traffic_sign:forward/backward`). A town sign inside a way means the way has to be split.

`maxspeed=50`, `landuse=residential` or administrative boundaries are never used. If two
strong hints disagree, there is no default and you choose yourself.

### Editor mode (beta, off by default)

Switch it on in the popup. Clicking a zone icon opens a small panel next to it with the
country, the road class, the current value, the suggestion and its reasons. In Germany
and the Netherlands you can pick a value (confirm that an existing value is to be
**replaced**) and insert it. As always, the tag applies to the whole way: a way that
passes a town sign is split in iD first. The extension then

1. selects the way in iD like a click on it,
2. opens iD's tag section if it is folded and reads iD's tag text box,
3. checks that the text box shows exactly the way's tags,
4. appends `zone:traffic=…` as a new last line, or replaces only that one value,
5. lets iD take the text over like after typing, and
6. checks that iD's data of the way now has exactly the expected tags.

iD records the change like any other: the save counter goes up, *Undo* takes it back.

No simplified input is offered for direction- or side-dependent tags
(`zone:traffic:forward/backward/left/right`), ways crossing or running along a border,
an unclear Belgian region, unsupported or unclear values, conflicting tags, a town sign
inside the way, or a way that reaches beyond the map when its full geometry cannot be
read. These stay visible with a hint and are edited by hand in iD.

### Countries

| Country | Values | Status |
|---|---|---|
| Germany | `DE:urban`, `DE:rural`, `DE:motorway` | verified, editor beta |
| Netherlands | `NL:urban`, `NL:rural` (also on motorways) | verified, editor beta |
| Belgium | `BE-VLG:…`, `BE-WAL:…`, `BE-BRU:…` (`urban`/`rural`), `BE:motorway` | verified, prototype |
| France | `FR:urban`, `FR:rural` (also on motorways) | verified, prototype |
| Luxembourg | `LU:urban`, `LU:rural`, `LU:motorway` | verified, prototype |
| Poland | `PL:urban`, `PL:rural`, `PL:motorway`, `PL:expressway` | verified, prototype |
| other European countries | `CC:urban`, `CC:rural` (motorways `CC:motorway` or `CC:rural`) | not verified, prototype |

*Verified* means the values are documented in the OSM wiki (checked 2026-10-26 against
revision 3108296 of 2026-10-24). Other countries follow the general pattern and are
marked *not verified*. *Prototype* means analysis only; the editor mode is enabled per
country once its rules are confirmed.

Belgian values name the region: in OSM `BE-VLG`, `BE-WAL` and `BE-BRU` are used more
than 300 times as often as `BE:urban`/`BE:rural` in `zone:traffic` (55,691 to 176 ways,
taginfo, 2026-10-26), and
the wiki lists only the regional values plus `BE:motorway`. The regions are found from
borders built into the extension.

### How it works

iD keeps each way's data on its SVG element (`path.__data__`). The map script runs in
the page's own world to read it and colours the lines directly. The country comes from
iD's own country lookup (`iD.locationManager`, country-coder), sampled at several points
along the way and on both sides of it, so border crossings and roads along a border are
recognised. The Belgian regions come from simplified OSM boundaries
(`node dev/build-regions.js`). Only when the panel is opened for a way that reaches
beyond the map, its saved geometry and node tags are read from the OSM API (read only);
if the local node list differs, they are not used.

Checks: `node dev/test.js`, `node --check` on the scripts, and `tsc --checkJs --strict`.
The toolbar icon (a town sign split into urban and rural on a green/red road) is drawn for this project in
`dev/icon/`; `node dev/build-icons.js` renders the PNGs with headless Chrome.

### Install

1. Download the latest release (or *Code* → *Download ZIP*) and unpack it.
2. Open `chrome://extensions` and switch on *Developer mode*.
3. *Load unpacked* → choose the unpacked folder (the one containing `manifest.json`).
   On Windows, *Extract All* creates a second folder of the same name inside the first;
   choose the inner one, or Chrome reports that the manifest file is missing.
4. Reload the iD editor.

The extension works on its own. OSM Maxspeed Colors also colours the roads; use one of
the two at a time.

### License

The code is released under the [MIT License](LICENSE). The traffic sign artwork from
Wikimedia Commons (`dev/signs/` files starting with a country code, and the generated
`generated/signs.js`) is in the public domain and not covered by that license.
The Belgian region borders (the generated `generated/regions.js`) are
© OpenStreetMap contributors, available under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

---

## Deutsch

OSM Traffic Zone Inspector ist eine Chrome-Erweiterung für den OpenStreetMap-Editor
**iD** auf `openstreetmap.org` (*Bearbeiten* → iD). Sie zeigt, welche regulären Straßen
schon [`zone:traffic=*`](https://wiki.openstreetmap.org/wiki/DE:Key:zone:traffic) haben –
die Zone des nationalen Regelwerks, z. B. `DE:urban` (innerorts) oder `DE:rural`
(außerorts) – und welchen es fehlt. Ein zuschaltbarer Editor-Modus hilft beim Ergänzen
und Korrigieren.

**Die Erweiterung speichert und lädt nie etwas hoch.** Sie bereitet eine Änderung nur
im aktuellen Bearbeitungsstand von iD vor, nachdem du den Wert gewählt und bestätigt
hast; prüfen und speichern machst du wie gewohnt in iD.

Was auf der Karte zu sehen ist:

- **Gefärbte Straßen.** Grün: ein offizieller Wert des Landes ist gesetzt. Gelbgrün
  (Symbol mit **~**): gültig, aber ungewöhnlich – `urban`/`rural` an einem `motorway_link`,
  der seine Klasse bis zur Kreuzung hinter dem Ende der Autobahn behält (in Deutschland
  Zeichen 330.2) und dort inner- oder außerorts liegen kann. Rot: `zone:traffic` fehlt. Gelb: prüfen – falscher oder falsch geschriebener Wert
  (`De:urban`, `DE:zone30`), Wert eines anderen Landes oder einer anderen Region, Wert
  passt nicht zur Straßenklasse (`DE:motorway` an einer primary), Widerspruch zu anderen
  Tags (`urban=no`, `source:maxspeed=DE:rural`, Ortstafel), richtungs- oder
  seitenabhängige Werte oder ein Way über eine Grenze.
- **Zonen-Symbole** auf den Straßen: eine gelbe Ortstafel mit Häuserreihe für
  innerorts, ein Schild mit Straße zwischen Bäumen für außerorts und das Autobahnschild
  des Landes für Autobahnwerte (amtliche Zeichen von Wikimedia Commons für DE, NL, BE und
  PL, sonst ein neutrales Symbol). Farbig, wenn der Wert
  gesetzt ist, grau, wenn er fehlt. Ein graues Symbol mit **?** trägt einen Vorschlag aus
  anderen Tags; **!** heißt prüfen. Beim Darüberfahren erscheinen Details und Gründe.
- **Legende** mit Statistik für den sichtbaren Kartenausschnitt: untersuchte Ways,
  korrekt, fehlend, Sonderfälle, untersuchte Länge, Länge ohne `zone:traffic` und
  Abdeckung nach Länge. Die Zahlen gelten nur für die sichtbaren Wegteile, nie für ein
  ganzes Land.

Geprüft werden motorway, trunk, primary, secondary, tertiary (jeweils mit `_link`),
unclassified, residential und living_street. service, pedestrian und track lassen sich
im Popup dazunehmen; Fuß-, Rad- und sonstige Wege sowie Straßen im Bau oder in Planung
nie. `highway=*` entscheidet nur, **welche** Straßen geprüft werden – nie, ob eine Straße
innerorts oder außerorts liegt.

### Vorschläge (graues Symbol mit ?)

Ein Vorschlag ist nur die Vorauswahl im Auswahlfeld; gesetzt wird nichts automatisch.
Er stammt aus:

- `source:maxspeed`, `maxspeed:type`, `zone:maxspeed` oder `maxspeed` mit einem Wert wie
  `DE:urban` (stark),
- `urban=yes/no`,
- der Straßenklasse: `highway=motorway(_link)` → Autobahnwert des Landes (`NL:rural` in
  den Niederlanden), `motorroad=yes`/`expressway=yes` → `PL:expressway`,
- `highway=living_street` oder `living_street=yes` → innerorts (schwach; ein
  verkehrsberuhigter Bereich ist nicht automatisch innerorts),
- angrenzenden Abschnitten: gleicher Wert an beiden Enden einer Lücke, oder an einem
  Ende (schwach),
- Ortstafeln (`traffic_sign=city_limit`, `DE:310`, `DE:311`, `NL:H01` …) am Anfang oder
  Ende des Ways, ausgewertet mit ihrer Richtung (`direction=forward/backward` oder
  `traffic_sign:forward/backward`). Eine Ortstafel mitten im Way heißt: Way teilen.

`maxspeed=50`, `landuse=residential` oder Verwaltungsgrenzen werden nie verwendet. Wenn
sich zwei starke Hinweise widersprechen, gibt es keine Vorauswahl und du entscheidest.

### Editor-Modus (Beta, standardmäßig aus)

Im Popup einschalten. Ein Klick auf ein Zonen-Symbol öffnet daneben ein kleines Panel
mit Land, Straßenklasse, aktuellem Wert, Vorschlag und Gründen. In Deutschland und den
Niederlanden wählst du einen Wert (bestätigst, dass ein vorhandener Wert **ersetzt**
werden soll) und fügst ihn ein. Wie immer gilt das Tag für den ganzen Way: ein Way, der
über eine Ortstafel läuft, wird vorher in iD geteilt. Die Erweiterung

1. wählt den Way in iD aus wie ein Klick darauf,
2. klappt den Tag-Bereich von iD auf, falls nötig, und liest iDs Tag-Textbox,
3. prüft, dass die Textbox genau die Tags des Ways zeigt,
4. hängt `zone:traffic=…` als neue letzte Zeile an oder ersetzt nur diesen einen Wert,
5. lässt iD den Text übernehmen wie nach einer Eingabe und
6. prüft, dass iDs Daten des Ways jetzt genau die erwarteten Tags haben.

iD verbucht die Änderung wie jede andere: der Speichern-Zähler steigt, *Rückgängig*
nimmt sie zurück.

Keine vereinfachte Eingabe gibt es bei richtungs- oder seitenabhängigen Tags
(`zone:traffic:forward/backward/left/right`), Ways über oder entlang einer Grenze, unklarer
belgischer Region, nicht unterstützten oder unklaren Werten, widersprüchlichen Tags,
einer Ortstafel mitten im Way oder einem Way, der über den Kartenausschnitt hinausreicht,
wenn seine ganze Geometrie nicht gelesen werden kann. Diese Fälle bleiben mit Hinweis
sichtbar und werden von Hand in iD bearbeitet.

### Länder

| Land | Werte | Status |
|---|---|---|
| Deutschland | `DE:urban`, `DE:rural`, `DE:motorway` | verified, Editor Beta |
| Niederlande | `NL:urban`, `NL:rural` (auch auf Autobahnen) | verified, Editor Beta |
| Belgien | `BE-VLG:…`, `BE-WAL:…`, `BE-BRU:…` (`urban`/`rural`), `BE:motorway` | verified, Prototyp |
| Frankreich | `FR:urban`, `FR:rural` (auch auf Autobahnen) | verified, Prototyp |
| Luxemburg | `LU:urban`, `LU:rural`, `LU:motorway` | verified, Prototyp |
| Polen | `PL:urban`, `PL:rural`, `PL:motorway`, `PL:expressway` | verified, Prototyp |
| übrige Länder Europas | `CC:urban`, `CC:rural` (Autobahn `CC:motorway` oder `CC:rural`) | not verified, Prototyp |

*Verified* heißt: die Werte stehen im OSM-Wiki (geprüft am 2026-10-26 gegen Revision
3108296 vom 2026-10-24). Andere Länder folgen dem allgemeinen Muster und sind als
*not verified* markiert. *Prototyp* heißt: nur Analyse; der Editor-Modus wird je Land
freigeschaltet, sobald seine Regeln bestätigt sind.

Belgische Werte nennen die Region: In OSM werden `BE-VLG`, `BE-WAL` und `BE-BRU` in
`zone:traffic` über 300-mal so oft verwendet wie `BE:urban`/`BE:rural` (55.691 zu 176
Ways, taginfo, 2026-10-26), und das Wiki nennt nur die regionalen Werte und `BE:motorway`. Die Region
ermittelt die Erweiterung aus eingebauten Grenzen.

### Funktionsweise

iD legt die Daten jedes Ways an dessen SVG-Element ab (`path.__data__`). Das
Kartenskript läuft in der Seitenwelt, um sie zu lesen, und färbt die Linien direkt. Das
Land kommt aus iDs eigener Länderbestimmung (`iD.locationManager`, country-coder),
abgefragt an mehreren Punkten entlang des Ways und zu beiden Seiten, sodass
Grenzübertritte und Straßen entlang einer Grenze erkannt werden. Die belgischen Regionen
stammen aus vereinfachten OSM-Grenzen (`node dev/build-regions.js`). Nur wenn das Panel
für einen Way geöffnet wird, der über den Kartenausschnitt hinausreicht, werden seine
gespeicherte Geometrie und die Knoten-Tags aus der OSM-API gelesen (nur lesend); weicht
die lokale Knotenliste ab, werden sie nicht verwendet.

Prüfungen: `node dev/test.js`, `node --check` für die Skripte und `tsc --checkJs --strict`.
Das Symbol in der Symbolleiste (eine Ortstafel, geteilt in innerorts und außerorts, auf einer grün-roten
Straße) ist
für dieses Projekt gezeichnet, Quelle in `dev/icon/`; `node dev/build-icons.js` erzeugt
die PNGs mit Chrome im Headless-Modus.

### Installation

1. Neuestes Release herunterladen (oder *Code* → *Download ZIP*) und entpacken.
2. `chrome://extensions` öffnen und den *Entwicklermodus* einschalten.
3. *Entpackte Erweiterung laden* → den entpackten Ordner wählen (der mit `manifest.json`).
   Unter Windows legt *Alle extrahieren* darin einen zweiten, gleichnamigen Ordner an;
   den inneren wählen, sonst meldet Chrome, die Manifest-Datei fehle.
4. Den iD-Editor neu laden.

Die Erweiterung arbeitet für sich. OSM Maxspeed Colors färbt die Straßen ebenfalls;
nutze jeweils eine der beiden.

### Lizenz

Der Code steht unter der [MIT-Lizenz](LICENSE). Die Verkehrszeichen von Wikimedia Commons
(Dateien in `dev/signs/` mit Länderkürzel und die erzeugte Datei
`generated/signs.js`) sind gemeinfrei und fallen nicht unter diese Lizenz. Die belgischen
Regionsgrenzen (die erzeugte Datei `generated/regions.js`) sind
© OpenStreetMap-Mitwirkende, verfügbar unter der
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
