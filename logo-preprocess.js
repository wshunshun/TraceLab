function colorDistance(red, green, blue, background) {
  return Math.hypot(red - background[0], green - background[1], blue - background[2]);
}

function flatLightBackground(data, width, height) {
  const samples = [];
  const addSample = (column, row) => {
    const offset = (row * width + column) * 4;
    if (data[offset + 3] === 255) samples.push([data[offset], data[offset + 1], data[offset + 2]]);
  };
  for (let step = 0; step < 32; step += 1) {
    const column = Math.round(step * (width - 1) / 31);
    const row = Math.round(step * (height - 1) / 31);
    addSample(column, 0);
    addSample(column, height - 1);
    addSample(0, row);
    addSample(width - 1, row);
  }
  if (samples.length !== 128) return null;
  const background = [0, 1, 2].map((channel) => samples.map((sample) => sample[channel]).sort((left, right) => left - right)[64]);
  if (Math.min(...background) < 225) return null;
  const matching = samples.filter((sample) => colorDistance(...sample, background) <= 14);
  return matching.length >= 120 ? background : null;
}

export function cleanLogoEdges(data, width, height, scale, maskOnly = false) {
  const background = flatLightBackground(data, width, height);
  if (!background) return false;
  const count = width * height;
  const contrast = new Float32Array(count);
  const rowPeaks = new Int32Array(count);
  for (let pixel = 0; pixel < count; pixel += 1) {
    const offset = pixel * 4;
    if (data[offset + 3] !== 255) return false;
    const red = data[offset] - background[0];
    const green = data[offset + 1] - background[1];
    const blue = data[offset + 2] - background[2];
    contrast[pixel] = Math.sqrt(red * red + green * green + blue * blue);
  }

  const radius = Math.max(1, Math.round(1.25 * scale));
  const mask = maskOnly ? new Uint8Array(count) : null;
  for (let row = 0; row < height; row += 1) {
    const start = row * width;
    for (let column = 0; column < width; column += 1) {
      let peak = start + column;
      for (let other = Math.max(0, column - radius); other <= Math.min(width - 1, column + radius); other += 1) {
        if (contrast[start + other] > contrast[peak]) peak = start + other;
      }
      rowPeaks[start + column] = peak;
    }
  }

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const pixel = row * width + column;
      const offset = pixel * 4;
      let peak = rowPeaks[pixel];
      for (let other = Math.max(0, row - radius); other <= Math.min(height - 1, row + radius); other += 1) {
        const candidate = rowPeaks[other * width + column];
        if (contrast[candidate] > contrast[peak]) peak = candidate;
      }
      const foreground = contrast[pixel] >= Math.max(18, 0.48 * contrast[peak]);
      if (mask) {
        mask[pixel] = Number(foreground);
        continue;
      }
      if (!foreground) {
        data.set(background, offset);
        continue;
      }
      const coverage = contrast[pixel] / contrast[peak];
      const gain = coverage < 0.88 ? 1 / coverage : 1;
      for (let channel = 0; channel < 3; channel += 1) {
        data[offset + channel] = background[channel] + (data[offset + channel] - background[channel]) * gain;
      }
    }
  }
  return mask ? { mask, background } : true;
}
