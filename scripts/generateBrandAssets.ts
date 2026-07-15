/**
 * Deterministic brand-asset generator (favicon + OG bundle, spec
 * docs/superpowers/specs/2026-07-14-favicon-og-design.md).
 *
 * Renders the committed SVG masters in public/brand/ into the committed
 * Next.js metadata files. Rerun after editing a master:
 *   node --import tsx scripts/generateBrandAssets.ts
 *
 * Fonts come from @fontsource/arimo via the lockfile so output is
 * identical on every machine (the OG master's "Arimo" text). resvg-js's
 * native font loader (fontdb) only parses raw SFNT (TTF/OTF) — it
 * rejects the WOFF1/WOFF2 containers @fontsource ships with a "malformed
 * font" warning and silently drops the text. WOFF1 is just an SFNT with
 * each table individually zlib-deflated, so we unwrap it back to SFNT
 * in-memory (Node's built-in zlib, no new dependency) before handing
 * font files to resvg. Output is still 100% determined by the pinned
 * @fontsource/arimo bytes in the lockfile.
 */
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const ROOT = process.cwd();
const BRAND = join(ROOT, 'public', 'brand');
const FONT_DIR = join(ROOT, 'node_modules', '@fontsource', 'arimo', 'files');

/**
 * Unwraps a WOFF1 buffer into a raw SFNT (TTF) buffer: inflate each
 * table, then re-emit a standard sfnt offset table + table directory
 * (sorted by tag, 4-byte-aligned, per the OpenType spec) pointing at the
 * decompressed data.
 */
function woffToSfnt(woff: Buffer): Buffer {
  if (woff.readUInt32BE(0) !== 0x774f4646) throw new Error('not a WOFF1 file');
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);

  const entries: { tag: Buffer; data: Buffer }[] = [];
  let p = 44;
  for (let i = 0; i < numTables; i++) {
    const tag = woff.subarray(p, p + 4);
    const offset = woff.readUInt32BE(p + 4);
    const compLength = woff.readUInt32BE(p + 8);
    const origLength = woff.readUInt32BE(p + 12);
    const compData = woff.subarray(offset, offset + compLength);
    const data = compLength === origLength ? compData : inflateSync(compData);
    if (data.length !== origLength) {
      throw new Error(`table ${tag.toString('ascii')} decompressed to ${data.length}B, expected ${origLength}B`);
    }
    entries.push({ tag, data });
    p += 20;
  }
  entries.sort((a, b) => Buffer.compare(a.tag, b.tag));

  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= numTables) {
    searchRange *= 2;
    entrySelector++;
  }
  searchRange *= 16;
  const rangeShift = numTables * 16 - searchRange;

  const headerSize = 12;
  const dirSize = numTables * 16;
  let dataOffset = headerSize + dirSize;
  const dirRecords: { tag: Buffer; checksum: number; offset: number; length: number }[] = [];
  const dataBlocks: Buffer[] = [];
  for (const e of entries) {
    const pad = (4 - (e.data.length % 4)) % 4;
    const padded = pad === 0 ? e.data : Buffer.concat([e.data, Buffer.alloc(pad)]);
    let checksum = 0;
    for (let i = 0; i < padded.length; i += 4) checksum = (checksum + padded.readUInt32BE(i)) >>> 0;
    dirRecords.push({ tag: e.tag, checksum, offset: dataOffset, length: e.data.length });
    dataBlocks.push(padded);
    dataOffset += padded.length;
  }

  const out = Buffer.alloc(dataOffset);
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(rangeShift, 10);

  let recPos = headerSize;
  for (const r of dirRecords) {
    r.tag.copy(out, recPos);
    out.writeUInt32BE(r.checksum, recPos + 4);
    out.writeUInt32BE(r.offset, recPos + 8);
    out.writeUInt32BE(r.length, recPos + 12);
    recPos += 16;
  }
  let blockPos = headerSize + dirSize;
  for (const b of dataBlocks) {
    b.copy(out, blockPos);
    blockPos += b.length;
  }
  return out;
}

function renderPng(svgPath: string, widthPx: number, fontFiles: string[]): Buffer {
  const svg = readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: widthPx },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Arimo' },
  });
  return resvg.render().asPng();
}

async function main() {
  const mark = join(BRAND, 'mark.svg');
  const markSimple = join(BRAND, 'mark-simple.svg');
  const ogMaster = join(BRAND, 'og-master.svg');

  // The mark masters carry no <text>, so they render fine with no fonts
  // loaded at all. Only the OG master needs Arimo.
  const noFonts: string[] = [];

  const tmpDir = mkdtempSync(join(tmpdir(), 'kq-brand-fonts-'));
  try {
    const fontFiles = ['arimo-latin-400-normal', 'arimo-latin-700-normal'].map((name) => {
      const ttf = woffToSfnt(readFileSync(join(FONT_DIR, `${name}.woff`)));
      const outPath = join(tmpDir, `${name}.ttf`);
      writeFileSync(outPath, ttf);
      return outPath;
    });

    copyFileSync(mark, join(ROOT, 'app', 'icon.svg'));

    const ico = await pngToIco([
      renderPng(markSimple, 16, noFonts),
      renderPng(mark, 32, noFonts),
      renderPng(mark, 48, noFonts),
    ]);
    writeFileSync(join(ROOT, 'app', 'favicon.ico'), ico);

    writeFileSync(join(ROOT, 'app', 'apple-icon.png'), renderPng(mark, 180, noFonts));
    writeFileSync(join(BRAND, 'mark-512.png'), renderPng(mark, 512, noFonts));

    const og = renderPng(ogMaster, 1200, fontFiles);
    writeFileSync(join(ROOT, 'app', 'opengraph-image.png'), og);
    writeFileSync(join(ROOT, 'app', 'twitter-image.png'), og);
    writeFileSync(
      join(ROOT, 'app', 'opengraph-image.alt.txt'),
      'KeywordQuarry — find the high-demand, low-competition Amazon keywords your next launch needs.\n',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('brand assets generated: icon.svg favicon.ico apple-icon.png mark-512.png opengraph-image.png twitter-image.png alt.txt');
}

main().catch((e) => { console.error(e); process.exit(1); });
