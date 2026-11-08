import { encodePng } from '../../src/png.js';

/** An 8x8 DMI with one 2-frame state "spin": red then blue, delays 1 and 3 ticks. */
export function animatedDmi({ rewind = false, loop = 0, frames = 2 } = {}) {
  const width = 8 * frames, rgba = new Uint8Array(width * 8 * 4);
  const colours = [[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255]];
  for (let y = 0; y < 8; y++) for (let x = 0; x < width; x++) rgba.set(colours[Math.floor(x / 8)], (y * width + x) * 4);
  const delays = [1, 3, 2].slice(0, frames).join(',');
  const description = `# BEGIN DMI\nversion = 4.0\n\twidth = 8\n\theight = 8\nstate = "spin"\n\tdirs = 1\n\tframes = ${frames}\n\tdelay = ${delays}\n${loop ? `\tloop = ${loop}\n` : ''}${rewind ? '\trewind = 1\n' : ''}# END DMI\n`;
  return encodePng({ width, height: 8, rgba }, { text: { Description: description } });
}
