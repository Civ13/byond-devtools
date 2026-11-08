/**
 * Pure RGBA image helpers shared by the renders: background fill, integer scaling, marker
 * boxes, frame sheets and image comparison. Images are {width, height, rgba: Uint8Array}
 * with the top row first. No I/O here.
 */

export class ImageInputError extends Error { constructor(message) { super(message); this.name = 'ImageInputError'; } }

/** Parse "#rrggbb", "#rrggbbaa" or "transparent" into [r, g, b, a]; throws on anything else. */
export function parseBackground(text) {
  if (text == null || text === 'transparent') return null;
  const m = typeof text === 'string' && /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text);
  if (!m) throw new ImageInputError('background must be #rrggbb, #rrggbbaa or transparent');
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) : 255];
}

/** Composite the image over a solid colour (source-over). Returns a new image. */
export function withBackground(img, color) {
  if (!color) return img;
  const out = new Uint8Array(img.rgba.length), [br, bg, bb, ba] = color;
  for (let i = 0; i < out.length; i += 4) {
    const sa = img.rgba[i + 3] / 255, da = ba / 255, oa = sa + da * (1 - sa);
    if (oa <= 0) continue;
    out[i] = Math.round((img.rgba[i] * sa + br * da * (1 - sa)) / oa);
    out[i + 1] = Math.round((img.rgba[i + 1] * sa + bg * da * (1 - sa)) / oa);
    out[i + 2] = Math.round((img.rgba[i + 2] * sa + bb * da * (1 - sa)) / oa);
    out[i + 3] = Math.round(oa * 255);
  }
  return { ...img, rgba: out };
}

/** Nearest-neighbour integer upscale (1-8). */
export function scaleImage(img, scale = 1, { maxPixels = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 8) throw new ImageInputError('scale must be an integer from 1 to 8');
  if (scale === 1) return img;
  const width = img.width * scale, height = img.height * scale;
  if (width * height > maxPixels) throw new ImageInputError('Output pixel limit exceeded; lower scale or the region');
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < width; x++) {
      const si = (sy * img.width + Math.floor(x / scale)) * 4, di = (y * width + x) * 4;
      rgba[di] = img.rgba[si]; rgba[di + 1] = img.rgba[si + 1]; rgba[di + 2] = img.rgba[si + 2]; rgba[di + 3] = img.rgba[si + 3];
    }
  }
  return { ...img, width, height, rgba };
}

/**
 * Draw 2-pixel outlines in place. boxes: [{left, top, width, height, color}] in pixels,
 * color as [r, g, b, a]. Out-of-image parts are clipped.
 */
export function drawBoxes(img, boxes) {
  const { width, height, rgba } = img;
  const put = (x, y, c) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const i = (y * width + x) * 4; rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = c[3]; };
  for (const b of boxes) {
    const x2 = b.left + b.width - 1, y2 = b.top + b.height - 1;
    for (let t = 0; t < 2; t++) {
      for (let x = b.left; x <= x2; x++) { put(x, b.top + t, b.color); put(x, y2 - t, b.color); }
      for (let y = b.top; y <= y2; y++) { put(b.left + t, y, b.color); put(x2 - t, y, b.color); }
    }
  }
  return img;
}

/** Lay equally sized frames out in a grid: rows x columns, gap pixels between them. */
export function frameSheet(frames, { width, height, columns, gap = 1 }) {
  const rows = Math.ceil(frames.length / columns);
  const W = columns * width + (columns - 1) * gap, H = rows * height + (rows - 1) * gap, rgba = new Uint8Array(W * H * 4);
  frames.forEach((f, n) => {
    if (!f) return;
    const ox = (n % columns) * (width + gap), oy = Math.floor(n / columns) * (height + gap);
    for (let y = 0; y < height; y++) rgba.set(f.subarray(y * width * 4, (y + 1) * width * 4), ((oy + y) * W + ox) * 4);
  });
  return { width: W, height: H, rgba };
}

/** Side-by-side panels with a gap, top-aligned. */
export function sideBySide(images, gap = 4) {
  const W = images.reduce((s, i) => s + i.width, 0) + gap * (images.length - 1), H = Math.max(...images.map(i => i.height));
  const rgba = new Uint8Array(W * H * 4);
  let ox = 0;
  for (const img of images) {
    for (let y = 0; y < img.height; y++) rgba.set(img.rgba.subarray(y * img.width * 4, (y + 1) * img.width * 4), (y * W + ox) * 4);
    ox += img.width + gap;
  }
  return { width: W, height: H, rgba };
}

/**
 * Compare two images pixel by pixel. A pixel differs when any channel differs by more than
 * `threshold` (0-255). Returns {sameSize, width, height, differentPixels, totalPixels,
 * maxDelta, meanDelta, bounds, heatmap?}. Images of different sizes are compared over their
 * shared top-left area and every pixel outside it counts as different.
 */
export function compareImages(a, b, { threshold = 0, heatmap = false } = {}) {
  if (!Number.isSafeInteger(threshold) || threshold < 0 || threshold > 255) throw new ImageInputError('threshold must be an integer from 0 to 255');
  const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
  const map = heatmap ? new Uint8Array(width * height * 4) : null;
  let different = 0, maxDelta = 0, sum = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inA = x < a.width && y < a.height, inB = x < b.width && y < b.height;
    let delta = 255;
    if (inA && inB) {
      const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4;
      delta = Math.max(Math.abs(a.rgba[i] - b.rgba[j]), Math.abs(a.rgba[i + 1] - b.rgba[j + 1]), Math.abs(a.rgba[i + 2] - b.rgba[j + 2]), Math.abs(a.rgba[i + 3] - b.rgba[j + 3]));
    }
    sum += delta; if (delta > maxDelta) maxDelta = delta;
    const differs = delta > threshold;
    if (differs) { different++; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    if (map) {
      const k = (y * width + x) * 4;
      if (differs) { map[k] = 255; map[k + 1] = Math.round(255 * (1 - delta / 255)); map[k + 2] = 0; map[k + 3] = 255; }
      else if (inA) { const i = (y * a.width + x) * 4, g = Math.round((a.rgba[i] + a.rgba[i + 1] + a.rgba[i + 2]) / 3 * 0.35); map[k] = g; map[k + 1] = g; map[k + 2] = g; map[k + 3] = 255; }
    }
  }
  return { sameSize: a.width === b.width && a.height === b.height, width, height, differentPixels: different, totalPixels: width * height,
    maxDelta, meanDelta: Math.round((sum / Math.max(1, width * height)) * 100) / 100,
    bounds: maxX < 0 ? null : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    heatmap: map ? { width, height, rgba: map } : undefined };
}
