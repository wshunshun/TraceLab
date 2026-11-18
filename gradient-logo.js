import { cleanLogoEdges } from './logo-preprocess.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const color = (channels) => '#' + channels.map((value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('');

function segmentRegions(data, mask, width, height, scale, minArea) {
  const labels = new Uint16Array(mask.length);
  const queue = new Int32Array(mask.length);
  const regions = [null];
  const radius = Math.max(1, Math.round(2 * scale));
  const edgeLimit = 12 ** 2;
  const isEdge = (start, end) => {
    const first = start * 4;
    const second = end * 4;
    return (data[first] - data[second]) ** 2 + (data[first + 1] - data[second + 1]) ** 2 + (data[first + 2] - data[second + 2]) ** 2 > edgeLimit;
  };
  const core = new Uint8Array(mask.length);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const pixel = row * width + column;
      if (!mask[pixel] || column < radius || row < radius || column >= width - radius || row >= height - radius) continue;
      const north = pixel - radius * width;
      const south = pixel + radius * width;
      const west = pixel - radius;
      const east = pixel + radius;
      if (mask[north] && mask[south] && mask[west] && mask[east] && !isEdge(north, south) && !isEdge(west, east)) core[pixel] = 1;
    }
  }

  let tail = 0;
  const visit = (pixel, source, label) => {
    if (source[pixel] && !labels[pixel]) {
      labels[pixel] = label;
      queue[tail++] = pixel;
    }
  };
  const neighbors = (pixel, source, label) => {
    const column = pixel % width;
    if (column) visit(pixel - 1, source, label);
    if (column < width - 1) visit(pixel + 1, source, label);
    if (pixel >= width) visit(pixel - width, source, label);
    if (pixel < mask.length - width) visit(pixel + width, source, label);
  };
  const collect = (source, area, hasCore) => {
    for (let pixel = 0; pixel < source.length; pixel += 1) {
      if (!source[pixel] || labels[pixel]) continue;
      const label = regions.length;
      if (label > 1024) return false;
      tail = 0;
      visit(pixel, source, label);
      for (let head = 0; head < tail; head += 1) neighbors(queue[head], source, label);
      if (tail < area) {
        for (let index = 0; index < tail; index += 1) {
          labels[queue[index]] = 0;
          source[queue[index]] = 0;
        }
        continue;
      }
      const samples = [];
      const step = Math.max(1, Math.floor(tail / 2500));
      for (let index = 0; index < tail; index += step) {
        const position = queue[index];
        const offset = position * 4;
        samples.push([position % width + 0.5, Math.floor(position / width) + 0.5, data[offset], data[offset + 1], data[offset + 2]]);
      }
      regions.push({ samples, hasCore });
    }
    return true;
  };

  if (!collect(core, Math.ceil((7 * scale) ** 2), true)) return null;
  tail = 0;
  for (let pixel = 0; pixel < labels.length; pixel += 1) {
    if (core[pixel]) neighbors(pixel, mask, labels[pixel]);
  }
  for (let head = 0; head < tail; head += 1) {
    const pixel = queue[head];
    neighbors(pixel, mask, labels[pixel]);
  }
  if (!collect(mask, minArea, false)) return null;
  return { labels, regions };
}

function fitPaint({ samples, hasCore }) {
  const mean = [0, 0, 0];
  for (const sample of samples) {
    for (let channel = 0; channel < 3; channel += 1) mean[channel] += sample[channel + 2] / samples.length;
  }
  const solid = { fill: color(mean) };
  if (!hasCore) return solid;
  let variance = 0;
  for (const sample of samples) {
    for (let channel = 0; channel < 3; channel += 1) variance += (sample[channel + 2] - mean[channel]) ** 2;
  }
  if (variance / samples.length < 144) return solid;

  const fitAngle = (angle) => {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const positions = samples.map((sample) => sample[0] * dx + sample[1] * dy);
    const start = Math.min(...positions);
    const span = Math.max(...positions) - start;
    if (!span) return null;
    const bins = Array.from({ length: 9 }, () => [0, 0, 0, 0, 0]);
    for (let index = 0; index < samples.length; index += 1) {
      const position = (positions[index] - start) / span;
      const bin = bins[Math.min(bins.length - 1, Math.floor(position * bins.length))];
      bin[0] += position;
      for (let channel = 0; channel < 3; channel += 1) bin[channel + 1] += samples[index][channel + 2];
      bin[4] += 1;
    }
    const stops = bins.filter((bin) => bin[4]).map((bin) => bin.slice(0, 4).map((value) => value / bin[4]));
    let error = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const position = (positions[index] - start) / span;
      let upper = 0;
      while (upper < stops.length - 1 && stops[upper][0] < position) upper += 1;
      const left = stops[Math.max(0, upper - 1)];
      const right = stops[upper];
      const mix = left === right ? 0 : Math.min(1, (position - left[0]) / (right[0] - left[0]));
      for (let channel = 1; channel <= 3; channel += 1) {
        error += (samples[index][channel + 1] - (left[channel] * (1 - mix) + right[channel] * mix)) ** 2;
      }
    }
    return { dx, dy, start, span, stops, error, angle };
  };
  let best = null;
  for (let step = 0; step < 12; step += 1) {
    const candidate = fitAngle(step * Math.PI / 12);
    if (candidate && (!best || candidate.error < best.error)) best = candidate;
  }
  if (!best || best.error > variance * 0.72) return solid;
  const initialAngle = best.angle;
  for (const offset of [-6, -3, 3, 6]) {
    const candidate = fitAngle(initialAngle + offset * Math.PI / 180);
    if (candidate && candidate.error < best.error) best = candidate;
  }
  return best.stops.length >= 3 ? best : solid;
}

function labelColor(label) {
  const value = (label * 0x9e3779) & 0xffffff;
  return [value >> 16, (value >> 8) & 255, value & 255];
}

function makeElement(svg, tag, attributes) {
  const element = svg.ownerDocument.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

export async function traceGradientLogo(tracer, raster, options) {
  const { data, width, height, scale } = raster;
  const detected = cleanLogoEdges(data, width, height, scale, true);
  if (!detected) return null;
  const { mask, background } = detected;
  const foregroundSize = mask.reduce((total, value) => total + value, 0);
  if (foregroundSize < 16 || foregroundSize > mask.length * 0.55) return null;
  const minArea = Math.ceil(Math.max(2, options.filterSpeckle ** 2, scale ** 2));
  const segmented = segmentRegions(data, mask, width, height, scale, minArea);
  if (!segmented) return null;
  const paints = new Map();
  const palette = segmented.regions.map((region, label) => {
    if (!region) return [0, 0, 0];
    const channels = labelColor(label);
    paints.set(color(channels), fitPaint(region));
    return channels;
  });
  if (![...paints.values()].some((paint) => paint.stops)) return null;
  const pixels = new Uint8ClampedArray(data.length);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const label = segmented.labels[pixel];
    pixels.set(palette[label], pixel * 4);
    pixels[pixel * 4 + 3] = 255;
  }
  const raw = await tracer.convertPixels(pixels, width, height, {
    ...options, hierarchical: 'cutout', filterSpeckle: 0, colorPrecision: 8, layerDifference: 0, maxColors: null,
  });
  const svg = new DOMParser().parseFromString(raw, 'image/svg+xml').documentElement;
  if (svg.localName !== 'svg') return null;
  const defs = makeElement(svg, 'defs', {});
  const output = makeElement(svg, 'g', {});
  for (const [index, path] of Array.from(svg.querySelectorAll('path')).entries()) {
    const paint = paints.get(path.getAttribute('fill')?.toLowerCase());
    if (!paint) {
      if (path.getAttribute('fill')?.toLowerCase() !== '#000000') return null;
      path.remove();
      continue;
    }
    if (paint.fill) {
      path.setAttribute('fill', paint.fill);
    } else {
      const id = `gradient-${index}`;
      const [offsetX = 0, offsetY = 0] = path.getAttribute('transform')?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      const { dx, dy, start, span, stops } = paint;
      const gradient = makeElement(svg, 'linearGradient', {
        id, gradientUnits: 'userSpaceOnUse',
        x1: (dx * start - offsetX).toFixed(3), y1: (dy * start - offsetY).toFixed(3),
        x2: (dx * (start + span) - offsetX).toFixed(3), y2: (dy * (start + span) - offsetY).toFixed(3),
      });
      for (const [offset, ...channels] of stops) gradient.append(makeElement(svg, 'stop', { offset: offset.toFixed(5), 'stop-color': color(channels) }));
      defs.append(gradient);
      path.setAttribute('fill', `url(#${id})`);
    }
    output.append(path);
  }
  if (!defs.childElementCount) return null;
  svg.replaceChildren(defs, makeElement(svg, 'rect', { width, height, fill: color(background) }), output);
  return new XMLSerializer().serializeToString(svg);
}
