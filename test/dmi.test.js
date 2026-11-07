import test from 'node:test'; import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises'; import { deflateSync, crc32 } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { decodePng, encodePng, readChunks, PngError } from '../src/png.js';
import { decodeDmi, parseDmiMetadata, pixelText, DmiError } from '../src/dmi.js';
import { fixtureQueries, decodedPixel } from '../scripts/native-icons.js';
const DIR = 'fixtures/dmi';
const icons = (await readdir(DIR)).filter(f => f.endsWith('.dmi')).sort();
const native = JSON.parse(await readFile(`${DIR}/pixels.native.json`, 'utf8'));

test('fixtures cover every colour type and depth', async () => {
  const kinds = new Set();
  for (const f of icons) { const d = decodeDmi(await readFile(`${DIR}/${f}`)); kinds.add(`${d.colorType}/${d.bitDepth}`); }
  assert.deepEqual([...kinds].sort(), ['0/1', '0/16', '0/2', '0/4', '0/8', '2/16', '2/8', '3/1', '3/2', '3/4', '3/8', '4/16', '4/8', '6/16', '6/8']);
});
for (const f of icons) test(`decoded pixels equal DreamDaemon GetPixel: ${f}`, async () => {
  const icon = decodeDmi(await readFile(`${DIR}/${f}`)), q = fixtureQueries(), got = native.results[f];
  assert.equal(native.byond, '516.1688'); assert.equal(got.length, q.length);
  q.forEach((query, i) => assert.equal(decodedPixel(icon, query), got[i] ?? null, `${f} ${JSON.stringify(query)}`));
});
test('state rules: first duplicate wins, movement namespace, missing dir/frame is null', async () => {
  const icon = decodeDmi(await readFile(`${DIR}/rgba8.dmi`));
  assert.equal(icon.findState('a').dirs, 4); assert.equal(icon.findState('a', { movement: true }).movement, true);
  assert.equal(icon.findState('b', { movement: true }), null); assert.equal(icon.findState('zzz'), null);
  const b = icon.findState('b');
  assert.equal(icon.frame(b, 4, 1), null); assert.equal(icon.frame(b, 2, 3), null);
  assert.ok(icon.frame(b, 4, 3, { display: true })); assert.equal(icon.frameIndex(icon.findState('a'), 6, 1, { display: true }), icon.frameIndex(icon.findState('a'), 4, 1));
});
test('RGBA encode/decode round trip with zTXt metadata', () => {
  const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) & 255);
  const png = encodePng({ width: 3, height: 2, rgba }, { text: { Description: '# BEGIN DMI\nversion = 4.0\n\twidth = 3\n\theight = 2\nstate = "x"\n\tdirs = 1\n\tframes = 1\n# END DMI\n' } });
  const d = decodeDmi(png); assert.deepEqual(d.frame(d.findState('x')), rgba);
  assert.equal(pixelText(new Uint8Array([1, 2, 3, 255]), 0), '#010203'); assert.equal(pixelText(new Uint8Array([1, 2, 3, 0]), 0), null);
  assert.equal(pixelText(new Uint8Array([1, 2, 3, 16]), 0), '#01020310');
});
function rebuild(bytes, mutate) {
  const chunks = readChunks(bytes).map(c => ({ type: c.type, data: Buffer.from(c.data) })); mutate(chunks);
  return Buffer.concat([bytes.subarray(0, 8), ...chunks.map(({ type, data }) => {
    const h = Buffer.alloc(8); h.writeUInt32BE(data.length); h.write(type, 4, 'latin1');
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([h.subarray(4), data])) >>> 0); return Buffer.concat([h, data, c]);
  })]);
}
test('malformed PNG and DMI input is rejected, not repaired', async () => {
  const good = await readFile(`${DIR}/palette4.dmi`);
  const badCrc = Buffer.from(good); badCrc[40] ^= 1;
  assert.throws(() => decodePng(badCrc), /CRC/);
  assert.throws(() => decodePng(good.subarray(0, 60)), PngError);
  assert.throws(() => decodePng(Buffer.from('not a png')), /Not a PNG/);
  assert.throws(() => decodePng(rebuild(good, c => { c[0].data[12] = 1; })), /Interlaced/);
  assert.throws(() => decodePng(rebuild(good, c => { c[0].data[9] = 5; })), /Unsupported colour type/);
  assert.throws(() => decodePng(rebuild(good, c => { const i = c.findIndex(x => x.type === 'PLTE'); c[i].data = c[i].data.subarray(0, 6); })), /Palette index/);
  assert.throws(() => decodePng(rebuild(good, c => { const ids = c.filter(x => x.type === 'IDAT'); ids[0].data = deflateSync(Buffer.alloc(10)); ids[1].data = Buffer.alloc(0); })), /expected/);
  const noMeta = rebuild(good, c => { c.splice(c.findIndex(x => x.type === 'zTXt'), 1); });
  assert.throws(() => decodeDmi(noMeta), DmiError);
  assert.throws(() => decodePng(good, { maxPixels: 10 }), /Pixel limit/);
});
test('metadata parser rejects malformed descriptions', () => {
  const ok = '# BEGIN DMI\nversion = 4.0\n\twidth = 4\n\theight = 4\nstate = "a"\n\tdirs = 4\n\tframes = 1\n\tcustom = x\n# END DMI\n';
  assert.equal(parseDmiMetadata(ok).states[0].extra.custom, 'x');
  for (const bad of [ok.replace('# BEGIN DMI', 'x'), ok.replace('# END DMI\n', ''), ok.replace('dirs = 4', 'dirs = 3'), ok.replace('frames = 1', 'frames = 0'), ok.replace('state = "a"', 'state = a'), ok.replace('\twidth = 4', '\twidth = four')])
    assert.throws(() => parseDmiMetadata(bad), DmiError);
});
test('icon metadata needs enough image cells', async () => {
  const png = encodePng({ width: 4, height: 4, rgba: new Uint8Array(64) }, { text: { Description: '# BEGIN DMI\nversion = 4.0\n\twidth = 4\n\theight = 4\nstate = "a"\n\tdirs = 4\n\tframes = 1\n# END DMI\n' } });
  assert.throws(() => decodeDmi(png), /needs 4 icons/);
});
test('CLI icon command summarises a DMI', () => {
  const r = spawnSync(process.execPath, ['src/cli.js', 'icon', '--root', '.', '--dmi', 'fixtures/dmi/rgba8.dmi'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); const d = JSON.parse(r.stdout).data;
  assert.equal(d.states.length, 5); assert.equal(d.width, 4); assert.match(JSON.parse(r.stdout).provenance.sha256, /^[0-9a-f]{64}$/);
});
const bin = process.env.BYOND_BIN;
test('live GetPixel matches the recording (set BYOND_BIN to run)', { skip: bin ? false : 'BYOND_BIN not set' }, async () => {
  const { recordIconPixels } = await import('../src/native.js');
  const r = await recordIconPixels({ files: { [`${DIR}/rgba16.dmi`]: fixtureQueries(), [`${DIR}/palette2.dmi`]: fixtureQueries() }, binDir: bin });
  assert.deepEqual(r.results[`${DIR}/rgba16.dmi`], native.results['rgba16.dmi']); assert.deepEqual(r.results[`${DIR}/palette2.dmi`], native.results['palette2.dmi']);
});
test('a plain PNG icon (icon = \'x.png\') decodes as one "" state only when asked', () => {
  const rgba = new Uint8Array(5 * 3 * 4).fill(200);
  const png = encodePng({ width: 5, height: 3, rgba });
  assert.throws(() => decodeDmi(png), DmiError);
  const icon = decodeDmi(png, { plainPng: true });
  assert.equal(icon.plain, true); assert.equal(icon.width, 5); assert.equal(icon.height, 3);
  const state = icon.findState('');
  assert.equal(state.dirs, 1); assert.deepEqual([...icon.frame(state, 4, 1, { display: true })], [...rgba]);
});
