import { createVTracer } from './node_modules/vtracer-browser/dist/index.js';
import { cleanLogoEdges } from './logo-preprocess.js';
import { traceGradientLogo } from './gradient-logo.js';

const defaultPalettes = { auto: 16, logo: 16, gradient: 16, photo: 32 };
const defaults = { profile: 'auto', palette: defaultPalettes.auto, detail: 100, smooth: 2, speckle: 0, transparent: true };
const state = { file: null, image: null, sourceUrl: '', outputUrl: '', job: 0, busy: false, settings: { ...defaults } };
const element = (id) => document.getElementById(id);
const controls = { palette: 'paletteRange', detail: 'detailRange', smooth: 'smoothRange', speckle: 'speckleRange' };
const status = element('outputState');
const convertButton = element('convertButton');
const downloadButton = element('downloadButton');
const fileInput = element('fileInput');
const dropzone = element('dropzone');
let tracer;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function setStatus(text, kind = 'ready') {
  status.textContent = text;
  status.dataset.kind = kind;
  element('statusDot').dataset.kind = kind;
}

function clearOutput() {
  if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
  state.outputUrl = '';
  element('vectorStage').innerHTML = '';
  element('vectorStage').hidden = true;
  element('vectorEmpty').hidden = false;
  element('vectorChip').textContent = 'SVG · VECTOR';
  element('colorLabel').textContent = '使用颜色';
  downloadButton.disabled = true;
  updateZoomControls();
  for (const id of ['vectorSize', 'vectorWeight', 'pathCount', 'colorCount', 'processingTime']) {
    element(id).textContent = '—';
  }
}

function cancelConversion() {
  state.job += 1;
  if (state.busy) {
    tracer?.terminate();
    tracer = undefined;
    state.busy = false;
  }
}

function clearFile() {
  cancelConversion();
  clearOutput();
  if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
  Object.assign(state, { file: null, image: null, sourceUrl: '' });
  fileInput.value = '';
  element('fileRow').classList.add('hidden');
  element('fileThumb').removeAttribute('src');
  element('originalImage').removeAttribute('src');
  element('originalImage').hidden = true;
  element('originalEmpty').hidden = false;
  resetZoom();
  element('originalChip').textContent = 'PNG / JPEG';
  element('originalSize').textContent = '—';
  element('originalWeight').textContent = '—';
  convertButton.disabled = true;
  setStatus('等待图片');
}

async function loadFile(file) {
  if (!file) return;
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte);
  const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  if (!png && !jpeg) {
    setStatus('请选择 PNG 或 JPEG 图片', 'error');
    return;
  }
  clearFile();
  const image = new Image();
  const url = URL.createObjectURL(file);
  state.sourceUrl = url;
  setStatus('正在读取图片…', 'busy');
  image.src = url;
  try {
    await image.decode();
  } catch {
    if (state.sourceUrl !== url) return;
    clearFile();
    setStatus('无法读取图片，文件可能已损坏', 'error');
    return;
  }
  if (state.sourceUrl !== url) return;
  Object.assign(state, { file, image });
  element('originalImage').src = url;
  element('originalImage').hidden = false;
  element('originalEmpty').hidden = true;
  updateZoomControls();
  element('fileRow').classList.remove('hidden');
  element('fileThumb').src = url;
  element('fileName').textContent = file.name;
  element('fileMeta').textContent = formatBytes(file.size);
  element('originalChip').textContent = png ? 'PNG' : 'JPEG';
  element('originalSize').textContent = `${image.naturalWidth} × ${image.naturalHeight} px`;
  element('originalWeight').textContent = formatBytes(file.size);
  convertButton.disabled = false;
  setStatus('准备转换');
}

function updateLabels() {
  const { profile, palette, detail, smooth, speckle } = state.settings;
  element('paletteValue').textContent = profile === 'gradient' ? '自动' : `最多 ${palette} 色`;
  element('detailValue').textContent = `${detail}%`;
  element('smoothValue').textContent = ['锐利', '轻微', '中等', '柔和'][smooth];
  element('speckleValue').textContent = speckle ? `≤ ${speckle ** 2} 像素` : '关闭';
}

function rasterize(image, settings) {
  const longSide = Math.max(image.naturalWidth, image.naturalHeight);
  const logo = settings.profile !== 'photo';
  const sampling = logo ? Math.max(1, Math.min(3, 4096 / longSide)) : 1;
  const targetScale = sampling * settings.detail / 100;
  const scale = Math.min(targetScale, 4096 / longSide,
    Math.sqrt(12_000_000 / (image.naturalWidth * image.naturalHeight)));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法创建像素画布');
  context.imageSmoothingQuality = 'high';
  if (!settings.transparent) {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const cleaned = settings.profile === 'logo' && cleanLogoEdges(data, width, height, scale);
  return { data, width, height, scale, cleaned };
}

function traceOptions(settings, raster) {
  const { scale, cleaned } = raster;
  return {
    hierarchical: 'stacked',
    mode: settings.smooth === 0 ? 'polygon' : 'spline',
    filterSpeckle: Math.max(cleaned ? Math.ceil(scale) : 0, Math.round(settings.speckle * scale)),
    colorPrecision: cleaned ? 6 : 7,
    layerDifference: cleaned ? Math.round(48 - settings.palette / 2) : 10,
    cornerThreshold: (cleaned ? [40, 45, 48, 70] : [40, 55, 70, 85])[settings.smooth],
    lengthThreshold: (cleaned ? [0.75, 1.25, 1.8, 3][settings.smooth] * scale : [0.75, 1.25, 2.5, 4][settings.smooth]),
    simplify: (cleaned ? [0, 0.08, 0.18, 0.5][settings.smooth] * scale : [0, 0.1, 0.3, 0.65][settings.smooth]) || null,
    pathPrecision: 3,
    maxColors: settings.palette,
    optimize: 1,
  };
}

function renderResult(rawSvg, raster, image, elapsed, fallback) {
  const svg = new DOMParser().parseFromString(rawSvg, 'image/svg+xml').documentElement;
  if (svg.localName !== 'svg') throw new Error('生成的 SVG 无效');
  svg.setAttribute('viewBox', `0 0 ${raster.width} ${raster.height}`);
  svg.setAttribute('width', image.naturalWidth);
  svg.setAttribute('height', image.naturalHeight);
  svg.setAttribute('shape-rendering', 'geometricPrecision');
  svg.setAttribute('text-rendering', 'geometricPrecision');
  const paths = Array.from(svg.querySelectorAll('path'));
  const gradients = svg.querySelectorAll('linearGradient').length;
  const colors = new Set(paths.map((path) => path.closest('[fill]')?.getAttribute('fill') ?? '#000'));
  const serialized = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
  state.outputUrl = URL.createObjectURL(blob);
  element('vectorStage').innerHTML = serialized;
  element('vectorStage').hidden = false;
  element('vectorEmpty').hidden = true;
  updateZoomControls();
  element('vectorSize').textContent = `${raster.width} × ${raster.height} viewBox`;
  element('vectorWeight').textContent = formatBytes(blob.size);
  element('pathCount').textContent = paths.length.toLocaleString();
  element('colorLabel').textContent = gradients ? '矢量渐变' : '使用颜色';
  element('colorCount').textContent = (gradients || colors.size).toLocaleString();
  element('vectorChip').textContent = gradients ? 'SVG · 渐变' : 'SVG · VECTOR';
  element('processingTime').textContent = `${Math.round(elapsed)} ms`;
  downloadButton.disabled = false;
  setStatus(!paths.length ? '没有可见路径' : fallback ? '未识别到可拟合渐变，已按标志转换' : '转换完成');
}

async function convert() {
  if (!state.image || state.busy) return;
  const image = state.image;
  const settings = { ...state.settings };
  const job = ++state.job;
  const started = performance.now();
  clearOutput();
  state.busy = true;
  convertButton.disabled = true;
  setStatus('正在分析图像…', 'busy');
  try {
    const raster = rasterize(image, settings);
    tracer ??= createVTracer();
    const phases = { segment: '颜色分层', compose: '拟合轮廓', optimize: '优化路径' };
    function onProgress({ phase, fraction }) {
      if (job === state.job && phases[phase]) setStatus(`${phases[phase]} ${Math.round(fraction * 100)}%`, 'busy');
    }
    const tryGradient = ['auto', 'gradient'].includes(settings.profile);
    let svg;
    if (tryGradient) {
      setStatus('正在识别渐变…', 'busy');
      svg = await traceGradientLogo(tracer, raster, { ...traceOptions(settings, raster), onProgress });
      if (job !== state.job) return;
    }
    const fallback = settings.profile === 'gradient' && !svg;
    if (!svg) {
      if (tryGradient) raster.cleaned = cleanLogoEdges(raster.data, raster.width, raster.height, raster.scale);
      svg = await tracer.convertPixels(raster.data, raster.width, raster.height, { ...traceOptions(settings, raster), onProgress });
    }
    if (job === state.job) renderResult(svg, raster, image, performance.now() - started, fallback);
  } catch (error) {
    if (job !== state.job) return;
    console.error(error);
    tracer?.terminate();
    tracer = undefined;
    setStatus('转换失败，请重试或降低细节比例', 'error');
  } finally {
    if (job === state.job) {
      state.busy = false;
      convertButton.disabled = false;
    }
  }
}

function invalidateOutput() {
  cancelConversion();
  clearOutput();
  if (!state.image) return;
  convertButton.disabled = false;
  setStatus('参数已更新，等待转换');
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  loadFile(file);
});
element('removeFile').addEventListener('click', clearFile);
convertButton.addEventListener('click', convert);
downloadButton.addEventListener('click', () => {
  if (!state.outputUrl) return;
  const anchor = document.createElement('a');
  anchor.href = state.outputUrl;
  anchor.download = `${state.file.name.replace(/\.[^.]+$/, '')}.svg`;
  anchor.click();
});
dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  loadFile(event.dataTransfer.files[0]);
});

function syncControls() {
  for (const [key, id] of Object.entries(controls)) element(id).value = state.settings[key];
  element('traceProfile').value = state.settings.profile;
  element('paletteRange').disabled = state.settings.profile === 'gradient';
  element('transparentToggle').checked = state.settings.transparent;
  updateLabels();
}

for (const [key, id] of Object.entries(controls)) {
  element(id).addEventListener('input', (event) => {
    state.settings[key] = Number(event.target.value);
    updateLabels();
    invalidateOutput();
  });
}
element('traceProfile').addEventListener('change', (event) => {
  const profile = event.target.value;
  if (state.settings.palette === defaultPalettes[state.settings.profile]) state.settings.palette = defaultPalettes[profile];
  state.settings.profile = profile;
  syncControls();
  invalidateOutput();
});
element('transparentToggle').addEventListener('change', (event) => {
  state.settings.transparent = event.target.checked;
  invalidateOutput();
});
element('resetButton').addEventListener('click', () => {
  state.settings = { ...defaults };
  syncControls();
  invalidateOutput();
});

const views = document.querySelectorAll('.tab-button');
for (const view of views) {
  view.addEventListener('click', () => {
    for (const item of views) item.setAttribute('aria-pressed', String(item === view));
    element('previewGrid').dataset.view = view.dataset.view;
  });
}
syncControls();

const zoom = { scale: 1, x: 0, y: 0 };
const previewGrid = element('previewGrid');
const viewports = Array.from(previewGrid.querySelectorAll('.zoom-viewport'));

function updateZoomControls() {
  for (const viewport of viewports) {
    const disabled = viewport.querySelector('.preview-content').hidden;
    for (const button of viewport.querySelectorAll('[data-zoom]')) {
      button.disabled = disabled;
      if (button.dataset.zoom === 'fit') button.textContent = `${Math.round(zoom.scale * 100)}%`;
    }
  }
}

function applyZoom() {
  previewGrid.style.setProperty('--preview-size', `${88 * zoom.scale}%`);
  previewGrid.style.setProperty('--pan-x', `${zoom.x * 100}%`);
  previewGrid.style.setProperty('--pan-y', `${zoom.y * 100}%`);
  updateZoomControls();
}

function resetZoom() {
  Object.assign(zoom, { scale: 1, x: 0, y: 0 });
  applyZoom();
}

function setZoom(scale, anchorX = 0, anchorY = 0) {
  const next = Math.min(8, Math.max(0.5, scale));
  const ratio = next / zoom.scale;
  zoom.x = anchorX + (zoom.x - anchorX) * ratio;
  zoom.y = anchorY + (zoom.y - anchorY) * ratio;
  zoom.scale = next;
  applyZoom();
}

for (const viewport of viewports) {
  const content = viewport.querySelector('.preview-content');
  let drag;
  viewport.querySelector('.zoom-toolbar').addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.zoom;
    if (action === 'in') setZoom(zoom.scale * 1.25);
    if (action === 'out') setZoom(zoom.scale / 1.25);
    if (action === 'fit') resetZoom();
  });
  viewport.addEventListener('wheel', (event) => {
    if (content.hidden || !event.deltaY) return;
    event.preventDefault();
    const bounds = viewport.getBoundingClientRect();
    const anchorX = (event.clientX - bounds.left) / bounds.width - 0.5;
    const anchorY = (event.clientY - bounds.top) / bounds.height - 0.5;
    setZoom(zoom.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), anchorX, anchorY);
  }, { passive: false });
  viewport.addEventListener('pointerdown', (event) => {
    if (content.hidden || event.button !== 0 || !content.contains(event.target)) return;
    drag = { pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: zoom.x, y: zoom.y };
    viewport.setPointerCapture(drag.pointer);
  });
  viewport.addEventListener('pointermove', (event) => {
    if (drag?.pointer !== event.pointerId) return;
    zoom.x = drag.x + (event.clientX - drag.clientX) / viewport.clientWidth;
    zoom.y = drag.y + (event.clientY - drag.clientY) / viewport.clientHeight;
    applyZoom();
  });
  viewport.addEventListener('lostpointercapture', (event) => {
    if (drag?.pointer === event.pointerId) drag = undefined;
  });
}
resetZoom();
