// Writes the sign artwork from dev/signs/*.svg into content.js, between the
// markers "BEGIN GENERATED SIGN ART" and "END GENERATED SIGN ART".
//
//   node dev/build-signs.js
//
// Files starting with a country code are traffic signs from Wikimedia Commons,
// public domain there, optimised with svgo (ids prefixed per sign, numbers rounded
// to one decimal). "neutral-*" are simple symbols of this project for countries
// without a public-domain sign. Only the viewBox and the inner markup are kept;
// content.js puts them into <symbol>s.
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'content.js');
const folder = path.join(__dirname, 'signs');
const BEGIN = '  // BEGIN GENERATED SIGN ART\n';
const END = '  // END GENERATED SIGN ART\n';

const entries = fs.readdirSync(folder).filter((f) => f.endsWith('.svg')).sort().map((file) => {
  const svg = fs.readFileSync(path.join(folder, file), 'utf8');
  const box = svg.match(/<svg[^>]*\bviewBox="0 0 ([\d.]+) ([\d.]+)"[^>]*>/);
  if (!box) throw new Error(`${file}: no viewBox "0 0 w h"`);
  const inner = svg.slice(svg.indexOf(box[0]) + box[0].length, svg.lastIndexOf('</svg>')).trim();
  if (/<script|\son\w+=|javascript:|<image|<foreignObject/i.test(inner)) throw new Error(`${file}: unexpected content`);
  const key = file.slice(0, -'.svg'.length);
  return `    ${JSON.stringify(key)}: { width: ${box[1]}, height: ${box[2]}, svg: ${JSON.stringify(inner)} },\n`;
});

const block = `${BEGIN}  /** @type {Record<string, { width: number, height: number, svg: string }>} */\n  const SIGN_ART = {\n${entries.join('')}  };\n${END}`;
const source = fs.readFileSync(target, 'utf8');
const start = source.indexOf(BEGIN);
const end = source.indexOf(END);
if (start < 0 || end < start) throw new Error('markers not found in content.js');
// Written only at the very end, after everything above succeeded.
fs.writeFileSync(target, source.slice(0, start) + block + source.slice(end + END.length));
console.log(`${entries.length} signs, ${block.length} characters written to content.js`);
