import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Bell, ChevronRight, LayoutGrid, ScanLine, Search, Settings, Wine } from 'lucide-react';
import { apiFetch, getApiBaseUrl } from './lib/api.js';
import { sha256HexFromArrayBuffer } from './lib/hash.js';

const WINE_PATTERN_IMAGE = `${import.meta.env.BASE_URL}images/wine-svgrepo-com.svg`;
const API_BASE_URL = getApiBaseUrl();
const LOADER_MS = 850;
const BURST_MS = 280;
const DONE_MS = 900;
const MINDAR_TIMEOUT_MS = 3200;
const LABEL_MAX_SIDE = 1800;
const LABEL_JPEG_QUALITY = 0.9;
const LABEL_ROLES = ['front', 'left', 'right'];
const REQUIRED_LABEL_ROLES = ['front', 'left', 'right'];
const COMPILE_IMAGE_MAX_SIDE = 1200;
const COMPILE_IMAGE_QUALITY = 0.82;
const COMPILE_TIMEOUT_MS = 90000;
let OfflineCompilerRef = null;

async function fetchTargetsManifest() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/mind/latest?wineId=global&ts=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return {
      ready: Boolean(payload?.url),
      url: payload?.url || '',
      hash: payload?.hash || '',
      targetCount: Number.parseInt(payload?.targetCount, 10) || 0,
      targetWineMap: Array.isArray(payload?.targetWineMap) ? payload.targetWineMap : [],
    };
  } catch {
    return null;
  }
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeLabelAsset(asset, fallbackIndex = 0) {
  const role = normalizeString(asset?.role) || LABEL_ROLES[Math.min(fallbackIndex, LABEL_ROLES.length - 1)];
  const qualityScore = Number.parseInt(asset?.qualityScore, 10);
  return {
    id: normalizeString(asset?.id) || `asset-${fallbackIndex + 1}`,
    role,
    dataUrl: normalizeString(asset?.dataUrl),
    qualityScore: Number.isFinite(qualityScore) ? qualityScore : 0,
    qualityStatus: normalizeString(asset?.qualityStatus) || 'unknown',
    qualityNotes: Array.isArray(asset?.qualityNotes)
      ? asset.qualityNotes.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    visualEmbedding: Array.isArray(asset?.visualEmbedding)
      ? asset.visualEmbedding.map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value))
      : [],
  };
}

function normalizeLabelAssets(assets) {
  if (!Array.isArray(assets)) {
    return [];
  }
  return assets.map((asset, index) => normalizeLabelAsset(asset, index)).filter((asset) => asset.dataUrl);
}

function averageEmbedding(assets) {
  const vectors = assets
    .map((asset) => (Array.isArray(asset.visualEmbedding) ? asset.visualEmbedding : []))
    .filter((vector) => vector.length > 0);
  if (!vectors.length) {
    return [];
  }
  const minLen = Math.min(...vectors.map((vector) => vector.length));
  if (!minLen) {
    return [];
  }
  const result = new Array(minLen).fill(0);
  vectors.forEach((vector) => {
    for (let i = 0; i < minLen; i += 1) {
      result[i] += Number.parseFloat(vector[i]) || 0;
    }
  });
  return result.map((value) => Number((value / vectors.length).toFixed(6)));
}

function pickPrimaryAsset(assets) {
  if (!Array.isArray(assets) || !assets.length) {
    return null;
  }
  return assets.find((asset) => asset.role === 'front') || assets[0];
}

function deriveLabelFieldsFromAssets(assets) {
  const normalized = normalizeLabelAssets(assets);
  const primary = pickPrimaryAsset(normalized);
  return {
    labelAssets: normalized,
    labelImage: primary?.dataUrl || '',
    visualEmbedding: averageEmbedding(normalized),
    qualityScore: Number.isFinite(primary?.qualityScore) ? primary.qualityScore : 0,
    qualityStatus: primary?.qualityStatus || 'unknown',
    qualityNotes: Array.isArray(primary?.qualityNotes) ? primary.qualityNotes : [],
  };
}

function normalizeWine(wine, fallbackIndex) {
  const targetIndex = Number.parseInt(wine?.targetIndex, 10);
  const rating = Number.parseFloat(wine?.rating);
  const labelAssets = normalizeLabelAssets(wine?.labelAssets);
  const derived = deriveLabelFieldsFromAssets(labelAssets);
  const fallbackLabelImage = normalizeString(wine?.labelImage);
  return {
    id: normalizeString(wine?.id) || `wine-${fallbackIndex + 1}`,
    targetIndex: Number.isInteger(targetIndex) && targetIndex >= 0
      ? targetIndex
      : fallbackIndex,
    title: normalizeString(wine?.title),
    subtitle: normalizeString(wine?.subtitle) || normalizeString(wine?.region),
    producer: normalizeString(wine?.producer),
    region: normalizeString(wine?.region),
    year: normalizeString(wine?.year),
    grapes: normalizeString(wine?.grapes),
    description: normalizeString(wine?.description),
    story: normalizeString(wine?.story),
    serving: normalizeString(wine?.serving),
    rating: Number.isFinite(rating) ? Math.min(5, Math.max(0, rating)) : 0,
    labelAssets,
    labelImage: derived.labelImage || fallbackLabelImage,
    visualEmbedding: derived.visualEmbedding.length
      ? derived.visualEmbedding
      : Array.isArray(wine?.visualEmbedding)
        ? wine.visualEmbedding.map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value))
        : [],
    qualityScore: derived.qualityScore || Number.parseInt(wine?.qualityScore, 10) || 0,
    qualityStatus: derived.qualityStatus || normalizeString(wine?.qualityStatus) || 'unknown',
    qualityNotes: derived.qualityNotes.length
      ? derived.qualityNotes
      : Array.isArray(wine?.qualityNotes)
        ? wine.qualityNotes.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
    status: normalizeString(wine?.status) === 'draft' ? 'draft' : 'published',
    pairings: normalizeArray(wine?.pairings),
    gallery: normalizeArray(wine?.gallery),
  };
}

function normalizeWines(wines) {
  return (wines || []).map((wine, index) => normalizeWine(wine, index));
}

function parseTags(value) {
  return String(value || '')
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseGallery(value) {
  return String(value || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractPrefillFromOcr(rawText, ocrLines = []) {
  const source = String(rawText || '').trim();
  if (!source) {
    return {};
  }
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 2);
  const compact = source.replace(/\s+/g, ' ').trim();
  const yearMatch = compact.match(/\b(19|20)\d{2}\b/g) || [];
  const year = yearMatch.length ? yearMatch[0] : '';
  const producerHints = /(producer|produced|estate|estates|winery|vineyards|domaine|domaines|tenuta|cantina|chateau|maison|cellars|bodegas|azienda|vignobles|family|finca)/i;
  const skipHints = /\b(19|20)\d{2}\b|alc\.?|vol\.?|ml\b|cl\b|contains sulfites|mis en bouteille|appellation|denominacion/i;

  const regions = [
    'bordeaux', 'burgundy', 'tuscany', 'piedmont', 'rioja', 'champagne', 'provence',
    'france', 'italy', 'spain', 'chile', 'argentina', 'georgia', 'australia',
    'portugal', 'germany', 'austria', 'california', 'sonoma', 'napa', 'russia',
  ];
  const lower = compact.toLowerCase();
  const region = regions.find((item) => lower.includes(item)) || '';
  const grapesDictionary = [
    'cabernet sauvignon', 'merlot', 'pinot noir', 'syrah', 'shiraz', 'malbec',
    'sangiovese', 'tempranillo', 'nebbiolo', 'grenache', 'zinfandel', 'riesling',
    'chardonnay', 'sauvignon blanc', 'chenin blanc', 'pinot grigio', 'muscadet',
    'gewurztraminer', 'aligote', 'viognier', 'mourvedre', 'carignan',
  ];
  const foundGrapes = grapesDictionary
    .filter((grape) => lower.includes(grape))
    .slice(0, 3);
  const grapesRegex = new RegExp(grapesDictionary.map((item) => item.replace(/\s+/g, '\\s+')).join('|'), 'i');
  const regionRegex = new RegExp(regions.join('|'), 'i');
  const toNormalizedLine = (line) => String(line || '').replace(/\s+/g, ' ').trim();
  const hasEnoughLetters = (line) => (String(line || '').match(/[a-zа-яё]/gi) || []).length >= 3;
  const isMostlyNumeric = (line) => {
    const compactLine = String(line || '').replace(/\s+/g, '');
    if (!compactLine) {
      return true;
    }
    const digits = (compactLine.match(/\d/g) || []).length;
    return /^\d+$/.test(compactLine) || digits / compactLine.length >= 0.6;
  };
  const isValidTextCandidate = (line) => {
    const value = toNormalizedLine(line);
    return value.length >= 3 && hasEnoughLetters(value) && !isMostlyNumeric(value);
  };
  const cleanedLines = lines
    .map((line) => toNormalizedLine(line))
    .filter((line) => isValidTextCandidate(line))
    .filter((line) => !skipHints.test(line))
    .filter((line) => !grapesRegex.test(line))
    .filter((line) => !regionRegex.test(line));
  const normalizedOverlayLines = Array.isArray(ocrLines)
    ? ocrLines
      .map((line) => ({
        text: toNormalizedLine(line?.text || line?.LineText || ''),
        minTop: Number.parseFloat(line?.minTop ?? line?.MinTop ?? 0) || 0,
        maxHeight: Number.parseFloat(line?.maxHeight ?? line?.MaxHeight ?? 0) || 0,
      }))
      .filter((line) => isValidTextCandidate(line.text))
      .filter((line) => !skipHints.test(line.text))
      .filter((line) => !grapesRegex.test(line.text))
      .filter((line) => !regionRegex.test(line.text))
    : [];

  let titleCandidate = cleanedLines[0] || '';
  if (normalizedOverlayLines.length) {
    const rankedByVisualSize = [...normalizedOverlayLines]
      .filter((line) => !producerHints.test(line.text))
      .sort((a, b) => {
        if (b.maxHeight !== a.maxHeight) {
          return b.maxHeight - a.maxHeight;
        }
        return a.minTop - b.minTop;
      });
    titleCandidate = rankedByVisualSize[0]?.text || titleCandidate;
  }
  let producerCandidate = cleanedLines.find((line) => producerHints.test(line)) || '';
  if (!producerCandidate && normalizedOverlayLines.length) {
    const sortedByTop = [...normalizedOverlayLines].sort((a, b) => a.minTop - b.minTop);
    const topLimit = sortedByTop[0].minTop + Math.max(70, sortedByTop[0].maxHeight * 3);
    const topLines = sortedByTop.filter((line) => line.minTop <= topLimit);
    producerCandidate = topLines.find((line) => producerHints.test(line.text))?.text || '';
    if (!producerCandidate && titleCandidate) {
      const titleLine = sortedByTop.find((line) => line.text === titleCandidate);
      if (titleLine) {
        producerCandidate = sortedByTop
          .find((line) => line.minTop < titleLine.minTop && line.text !== titleCandidate)
          ?.text || '';
      }
    }
  }
  if (producerCandidate === titleCandidate) {
    titleCandidate = cleanedLines.find((line) => line !== producerCandidate) || titleCandidate;
    producerCandidate = '';
  }

  return {
    title: titleCandidate ? titleCandidate.slice(0, 120) : '',
    year,
    producer: producerCandidate ? producerCandidate.slice(0, 80) : '',
    region: region || '',
    grapes: foundGrapes.join(', '),
  };
}

function toIdSlug(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getNextFreeTargetIndex(wines, preferred = 0) {
  const used = new Set(
    (wines || [])
      .map((wine) => Number.parseInt(wine?.targetIndex, 10))
      .filter((x) => Number.isInteger(x) && x >= 0)
  );
  let index = Number.isInteger(preferred) && preferred >= 0 ? preferred : 0;
  while (used.has(index)) {
    index += 1;
  }
  return index;
}

function generateWineId({ title, region }, wines, currentId = '') {
  if (currentId) {
    return currentId;
  }
  const baseRaw = toIdSlug(region) || toIdSlug(title) || 'wine';
  const taken = new Set((wines || []).map((wine) => String(wine?.id || '')));
  let seq = 1;
  while (seq < 1000) {
    const candidate = `${baseRaw}-${String(seq).padStart(3, '0')}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
    seq += 1;
  }
  return `${baseRaw}-${Date.now()}`;
}

function estimateBase64Bytes(dataUrl) {
  const base64 = String(dataUrl || '').split(',')[1] || '';
  return Math.round((base64.length * 3) / 4);
}

function formatKb(bytes) {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Не удалось загрузить изображение.'));
    image.src = dataUrl;
  });
}

async function optimizeLabelImage(file) {
  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(sourceDataUrl);
  const sourceMime = String(file.type || '').toLowerCase();
  const maxSide = Math.max(image.naturalWidth, image.naturalHeight);
  const ratio = maxSide > LABEL_MAX_SIDE ? LABEL_MAX_SIDE / maxSide : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * ratio));
  const height = Math.max(1, Math.round(image.naturalHeight * ratio));

  if (ratio === 1 && /^data:image\/jpeg;base64,/i.test(sourceDataUrl)) {
    const bytes = estimateBase64Bytes(sourceDataUrl);
    return {
      dataUrl: sourceDataUrl,
      sourceBytes: bytes,
      optimizedBytes: bytes,
      reduced: false,
    };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('Не удалось подготовить изображение.');
  }

  context.drawImage(image, 0, 0, width, height);
  const outputMime = sourceMime === 'image/png' ? 'image/png' : 'image/jpeg';
  const optimizedDataUrl = outputMime === 'image/png'
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/jpeg', LABEL_JPEG_QUALITY);

  const sourceBytes = estimateBase64Bytes(sourceDataUrl);
  const optimizedBytes = estimateBase64Bytes(optimizedDataUrl);
  const reduced = optimizedBytes < sourceBytes;

  return {
    dataUrl: reduced ? optimizedDataUrl : sourceDataUrl,
    sourceBytes,
    optimizedBytes: reduced ? optimizedBytes : sourceBytes,
    reduced,
  };
}

async function downscaleForCompile(dataUrl) {
  const image = await loadImage(dataUrl);
  const maxSide = Math.max(image.naturalWidth, image.naturalHeight);
  const ratio = maxSide > COMPILE_IMAGE_MAX_SIDE ? COMPILE_IMAGE_MAX_SIDE / maxSide : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * ratio));
  const height = Math.max(1, Math.round(image.naturalHeight * ratio));

  if (ratio >= 1 && /^data:image\/jpeg;base64,/i.test(dataUrl)) {
    return dataUrl;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    return dataUrl;
  }
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', COMPILE_IMAGE_QUALITY);
}

async function getOfflineCompiler() {
  if (OfflineCompilerRef) {
    return OfflineCompilerRef;
  }
  const mod = await import(
    /* @vite-ignore */
    'https://esm.sh/mind-ar@1.2.5/src/image-target/offline-compiler.js'
  );
  OfflineCompilerRef = mod.OfflineCompiler;
  return OfflineCompilerRef;
}

function getMindarVideoElement() {
  const primary = document.querySelector('video.mindar-video');
  if (primary instanceof HTMLVideoElement) {
    return primary;
  }
  const fallback = document.querySelector('video');
  return fallback instanceof HTMLVideoElement ? fallback : null;
}

async function waitForMindarVideoReady(timeoutMs = 3500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const video = getMindarVideoElement();
    if (video && video.videoWidth > 32 && video.videoHeight > 32 && video.readyState >= 2) {
      return video;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }
  return null;
}

function computeVisualEmbeddingFromImageData(imageData) {
  const { data, width, height } = imageData;
  const bins = new Array(24).fill(0);
  const pixelCount = Math.max(1, width * height);
  const step = 4;

  for (let i = 0; i < data.length; i += step * 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    bins[Math.min(7, Math.floor((r / 255) * 8))] += 1;
    bins[8 + Math.min(7, Math.floor((g / 255) * 8))] += 1;
    bins[16 + Math.min(7, Math.floor((b / 255) * 8))] += 1;
    bins[0] += lum * 0.00001; // tiny luminance tie-breaker for very flat histograms
  }

  return bins.map((value) => Number((value / pixelCount).toFixed(6)));
}

async function computeVisualEmbeddingFromDataUrl(dataUrl) {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    return [];
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return computeVisualEmbeddingFromImageData(context.getImageData(0, 0, canvas.width, canvas.height));
}

function estimateFrameQuality(imageData) {
  const { data, width, height } = imageData;
  const gray = new Float32Array(width * height);
  let highlight = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[p] = lum;
    if (lum >= 245) {
      highlight += 1;
    }
  }

  let edgeEnergy = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      const gx = gray[p + 1] - gray[p - 1];
      const gy = gray[p + width] - gray[p - width];
      edgeEnergy += Math.sqrt(gx * gx + gy * gy);
    }
  }

  const pixelCount = Math.max(1, width * height);
  const sharpness = edgeEnergy / pixelCount;
  const highlightRatio = highlight / pixelCount;
  return {
    score: sharpness - highlightRatio * 140,
    sharpness,
    highlightRatio,
  };
}

async function assessLabelQuality(dataUrl) {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * canvas.width));
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) {
    return { score: 0, status: 'bad', notes: ['Не удалось оценить качество изображения.'] };
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const quality = estimateFrameQuality(context.getImageData(0, 0, canvas.width, canvas.height));
  const sharpnessNorm = Math.min(1, quality.sharpness / 18);
  const glarePenalty = Math.min(1, quality.highlightRatio / 0.2);
  const score = Math.max(0, Math.round((sharpnessNorm * 0.8 + (1 - glarePenalty) * 0.2) * 100));
  const notes = [];

  if (quality.sharpness < 9) {
    notes.push('Фото может быть размытым, попробуй сделать снимок четче.');
  }
  if (quality.highlightRatio > 0.11) {
    notes.push('Слишком много бликов/пересвета, измени угол или свет.');
  }
  if (!notes.length) {
    notes.push('Качество этикетки хорошее.');
  }

  return {
    score,
    status: score >= 70 ? 'good' : score >= 45 ? 'medium' : 'bad',
    notes,
  };
}

function getFormFromWine(wine) {
  const derived = deriveLabelFieldsFromAssets(wine?.labelAssets);
  return {
    id: wine?.id || '',
    targetIndex: wine ? String(wine.targetIndex) : '0',
    title: wine?.title || '',
    subtitle: wine?.subtitle || wine?.region || '',
    producer: wine?.producer || '',
    region: wine?.region || '',
    year: wine?.year || '',
    grapes: wine?.grapes || '',
    description: wine?.description || '',
    story: wine?.story || '',
    serving: wine?.serving || '',
    rating: wine ? String(wine.rating ?? 0) : '0',
    labelImage: derived.labelImage || wine?.labelImage || '',
    labelAssets: derived.labelAssets.length ? derived.labelAssets : normalizeLabelAssets(wine?.labelAssets),
    pairings: wine?.pairings?.join('\n') || '',
    gallery: wine?.gallery?.join('\n') || '',
    visualEmbedding: derived.visualEmbedding.length
      ? derived.visualEmbedding
      : Array.isArray(wine?.visualEmbedding)
        ? wine.visualEmbedding
        : [],
    qualityScore: derived.qualityScore || Number.parseInt(wine?.qualityScore, 10) || 0,
    qualityStatus: derived.qualityStatus || wine?.qualityStatus || 'unknown',
    qualityNotes: derived.qualityNotes.length
      ? derived.qualityNotes
      : Array.isArray(wine?.qualityNotes) ? wine.qualityNotes : [],
    status: wine?.status === 'draft' ? 'draft' : 'published',
  };
}

function createEmptyForm() {
  return {
    id: '',
    targetIndex: '',
    title: '',
    subtitle: '',
    producer: '',
    region: '',
    year: '',
    grapes: '',
    description: '',
    story: '',
    serving: '',
    rating: '0',
    labelImage: '',
    labelAssets: [],
    pairings: '',
    gallery: '',
    visualEmbedding: [],
    qualityScore: 0,
    qualityStatus: 'unknown',
    qualityNotes: [],
    status: 'draft',
  };
}

export default function App() {
  const sceneRef = useRef(null);
  const targetsRootRef = useRef(null);
  const cropStageRef = useRef(null);
  const cropInteractionRef = useRef(null);
  const arStartedRef = useRef(false);
  const scanHandledRef = useRef(false);
  const modeRef = useRef('home');
  const feedbackTimersRef = useRef([]);
  const fallbackTimerRef = useRef(null);

  const [mode, setMode] = useState('home');
  const [wines, setWines] = useState([]);
  const [selectedWineId, setSelectedWineId] = useState(null);
  const [adminView, setAdminView] = useState('list');
  const [createStep, setCreateStep] = useState('labels');
  const [adminSearch, setAdminSearch] = useState('');
  const [adminListTab, setAdminListTab] = useState('published');
  const [form, setForm] = useState(createEmptyForm());
  const [mindTargetSrc, setMindTargetSrc] = useState('');
  const [compiledTargetsReady, setCompiledTargetsReady] = useState(false);
  const [compiledTargetCount, setCompiledTargetCount] = useState(0);
  const [compiledTargetWineMap, setCompiledTargetWineMap] = useState([]);
  const [contentWine, setContentWine] = useState(null);
  const [scanFeedbackPhase, setScanFeedbackPhase] = useState('idle');
  const [recognitionPhase, setRecognitionPhase] = useState('TRY_MINDAR');
  const [recognitionHint, setRecognitionHint] = useState('');
  const [labelProcess, setLabelProcess] = useState({
    jobId: null,
    status: 'idle',
    targetIndex: null,
    error: '',
  });
  const [cropEditor, setCropEditor] = useState({
    assetId: '',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  const [notice, setNotice] = useState({ text: '', type: '' });
  const [startError, setStartError] = useState('');
  const [adminAuthChecked, setAdminAuthChecked] = useState(false);
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [adminAuthError, setAdminAuthError] = useState('');
  const [mindBuildStatus, setMindBuildStatus] = useState({ phase: 'idle', progress: 0, text: '' });
  const [arBooted, setArBooted] = useState(false);
  const [labelModal, setLabelModal] = useState({ open: false, role: 'front' });

  const sortedWines = useMemo(() => {
    return [...wines].sort((a, b) => {
      if (a.targetIndex !== b.targetIndex) {
        return a.targetIndex - b.targetIndex;
      }
      return a.title.localeCompare(b.title, 'ru');
    });
  }, [wines]);

  const selectedWine = useMemo(() => {
    return wines.find((wine) => wine.id === selectedWineId) || null;
  }, [wines, selectedWineId]);

  const visibleAdminWines = useMemo(() => {
    const query = normalizeString(adminSearch).toLowerCase();
    return sortedWines.filter((wine) => {
      const status = wine.status === 'draft' ? 'draft' : (wine.status || 'published');
      if (adminListTab !== 'all' && status !== adminListTab) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        wine.title,
        wine.producer,
        wine.region,
        wine.year,
        wine.grapes,
      ]
        .map((x) => String(x || '').toLowerCase())
        .join(' ');
      return haystack.includes(query);
    });
  }, [sortedWines, adminSearch, adminListTab]);

  const selectedCropAsset = useMemo(() => {
    return normalizeLabelAssets(form.labelAssets).find((asset) => asset.id === cropEditor.assetId) || null;
  }, [form.labelAssets, cropEditor.assetId]);

  const hasRequiredLabelShots = useMemo(() => {
    const assets = normalizeLabelAssets(form.labelAssets);
    const roles = new Set(assets.map((asset) => asset.role));
    return REQUIRED_LABEL_ROLES.every((role) => roles.has(role));
  }, [form.labelAssets]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    if (mode === 'scan' || mode === 'content') {
      setArBooted(true);
    }
  }, [mode]);

  useEffect(() => {
    let active = true;
    apiFetch('/api/auth/me')
      .then((payload) => {
        if (!active) {
          return;
        }
        const ok = Boolean(payload?.authenticated);
        setAdminAuthenticated(ok);
        setAdminAuthChecked(true);
        if (window.location.pathname.startsWith('/admin') && !ok) {
          setMode('admin-login');
        }
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setAdminAuthenticated(false);
        setAdminAuthChecked(true);
        if (window.location.pathname.startsWith('/admin')) {
          setMode('admin-login');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const applyPathMode = () => {
      const path = window.location.pathname;
      if (path.startsWith('/admin/login')) {
        setMode('admin-login');
        return;
      }
      if (path.startsWith('/admin')) {
        if (!adminAuthenticated) {
          setMode('admin-login');
          return;
        }
        setMode('admin');
        return;
      }
      if (mode !== 'scan' && mode !== 'content') {
        setMode('home');
      }
    };

    applyPathMode();
    window.addEventListener('popstate', applyPathMode);
    return () => {
      window.removeEventListener('popstate', applyPathMode);
    };
  }, [adminAuthenticated, mode]);

  useEffect(() => {
    const applyViewportHeight = () => {
      const viewport = window.visualViewport;
      const rawViewportHeight = viewport?.height;
      const fallbackHeight = Math.max(
        window.innerHeight || 0,
        document.documentElement?.clientHeight || 0,
        Math.round((window.screen?.height || 0) * 0.9)
      );
      const viewportHeight = Number.isFinite(rawViewportHeight) && rawViewportHeight > 320
        ? rawViewportHeight
        : fallbackHeight;
      const safeHeight = Math.max(320, Math.round(viewportHeight));
      const keyboardOffset = Math.max(
        0,
        Math.round(window.innerHeight - safeHeight - (viewport?.offsetTop || 0))
      );
      document.documentElement.style.setProperty('--app-height', `${safeHeight}px`);
      document.documentElement.style.setProperty(
        '--keyboard-offset',
        `${keyboardOffset > 0 && keyboardOffset < window.innerHeight * 0.55 ? keyboardOffset : 0}px`
      );
      applyCameraStyles();
    };

    const onResize = () => {
      applyViewportHeight();
    };

    const onFocusIn = (event) => {
      const element = event.target;
      if (!(element instanceof HTMLElement)) {
        return;
      }
      if (!element.matches('input, textarea, select')) {
        return;
      }

      const scrollElement = document.querySelector('.app-shell') || document.scrollingElement;

      window.setTimeout(() => {
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        scrollElement?.scrollBy({ top: 120, left: 0, behavior: 'smooth' });
      }, 240);
    };

    applyViewportHeight();
    window.requestAnimationFrame(applyViewportHeight);
    window.setTimeout(applyViewportHeight, 120);
    window.setTimeout(applyViewportHeight, 420);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.addEventListener('pageshow', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.removeEventListener('pageshow', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
        const [payload, manifestPayload] = await Promise.all([
          apiFetch('/wines'),
          fetchTargetsManifest(),
        ]);
        const loaded = normalizeWines(payload.wines || []);
        const hasCompiledTargets = Boolean(manifestPayload?.ready);
        const targetCount = Number.parseInt(manifestPayload?.targetCount, 10) || 0;
        const targetWineMap = Array.isArray(manifestPayload?.targetWineMap)
          ? manifestPayload.targetWineMap
          : [];

        if (!active) {
          return;
        }

        setCompiledTargetsReady(hasCompiledTargets);
        setCompiledTargetCount(targetCount);
        setCompiledTargetWineMap(targetWineMap);
        setMindTargetSrc(hasCompiledTargets && manifestPayload?.url ? manifestPayload.url : '');
        setWines(loaded);
        if (loaded[0]) {
          setSelectedWineId(loaded[0].id);
          setForm(getFormFromWine(loaded[0]));
        } else {
          setForm(createEmptyForm());
        }
      } catch (error) {
        if (active) {
          setStartError(error.message || 'Ошибка загрузки данных.');
        }
      }
    }

    loadData();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const root = targetsRootRef.current;
    if (!root) {
      return undefined;
    }

    root.innerHTML = '';

    const wineIndexes = [...new Set(wines.map((wine) => wine.targetIndex))].sort((a, b) => a - b);
    const manifestIndexes = compiledTargetsReady && compiledTargetCount > 0
      ? Array.from({ length: compiledTargetCount }, (_, index) => index)
      : [];
    const indexes = [...new Set([...wineIndexes, ...manifestIndexes])].sort((a, b) => a - b);
    const safeIndexes = indexes.length ? indexes : [0];

    const cleanup = [];

    safeIndexes.forEach((targetIndex) => {
      const target = document.createElement('a-entity');
      target.setAttribute('mindar-image-target', `targetIndex: ${targetIndex}`);

      const onFound = () => {
        handleTargetFound(targetIndex);
      };

      target.addEventListener('targetFound', onFound);
      cleanup.push(() => target.removeEventListener('targetFound', onFound));
      root.appendChild(target);
    });

    return () => {
      cleanup.forEach((fn) => fn());
      root.innerHTML = '';
    };
  }, [wines, compiledTargetsReady, compiledTargetCount]);

  useEffect(() => {
    return () => {
      clearFeedbackTimers();
      if (fallbackTimerRef.current) {
        window.clearTimeout(fallbackTimerRef.current);
      }
      stopAr();
    };
  }, []);

  function clearFeedbackTimers() {
    feedbackTimersRef.current.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    feedbackTimersRef.current = [];
    if (fallbackTimerRef.current) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }

  function applyCameraStyles() {
    const video = document.querySelector('video.mindar-video');
    if (video) {
      video.style.position = 'fixed';
      video.style.top = '0';
      video.style.left = '0';
      video.style.width = '100vw';
      video.style.height = 'var(--app-height)';
      video.style.objectFit = 'cover';
      video.style.zIndex = '0';
    }

    const overlay = document.querySelector('div.mindar-ui-overlay');
    if (overlay) {
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.width = '100vw';
      overlay.style.height = 'var(--app-height)';
    }
  }

  async function waitSceneLoaded() {
    const scene = sceneRef.current;
    if (!scene) {
      throw new Error('AR-сцена не найдена.');
    }

    if (scene.hasLoaded) {
      return;
    }

    await new Promise((resolve) => {
      scene.addEventListener('loaded', resolve, { once: true });
    });
  }

  function getMindArSystem() {
    return sceneRef.current?.systems?.['mindar-image-system'];
  }

  async function startAr() {
    await waitSceneLoaded();

    const system = getMindArSystem();
    if (!system) {
      throw new Error('MindAR не инициализирован. Обнови страницу.');
    }

    if (!arStartedRef.current) {
      await system.start();
      arStartedRef.current = true;
    }

    applyCameraStyles();
  }

  async function stopAr() {
    const system = getMindArSystem();

    if (system && arStartedRef.current) {
      await system.stop();
      arStartedRef.current = false;
    }

    document.body.classList.remove('is-scanning');
  }

  async function captureBestFrameFromVideo() {
    const video = await waitForMindarVideoReady();
    if (!(video instanceof HTMLVideoElement)) {
      throw new Error('Камера еще не готова, попробуй снова.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = 224;
    canvas.height = 224;
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) {
      throw new Error('Не удалось обработать кадр камеры.');
    }

    let best = null;
    for (let i = 0; i < 4; i += 1) {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const quality = estimateFrameQuality(imageData);
      const embedding = computeVisualEmbeddingFromImageData(imageData);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      const candidate = { quality, embedding, dataUrl };
      if (!best || candidate.quality.score > best.quality.score) {
        best = candidate;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 110));
    }

    if (!best) {
      throw new Error('Не удалось получить кадр для распознавания.');
    }
    return best;
  }

  async function runFallbackRecognition() {
    try {
      setRecognitionPhase('FALLBACK_OCR');
      setRecognitionHint('Ищу по тексту...');
      const frame = await captureBestFrameFromVideo();

      const ocrPayload = await apiFetch('/api/recognize/ocr', {
        method: 'POST',
        body: JSON.stringify({
          image_base64: frame.dataUrl,
          ocr_text: '',
          locale_hint: 'ru',
        }),
      }).catch(() => ({ best: null }));

      if (ocrPayload?.best?.wine_id) {
        const wine = wines.find((item) => item.id === ocrPayload.best.wine_id);
        if (wine) {
          setContentWine(wine);
          setMode('content');
          setRecognitionPhase('MINDAR_LOCKED');
          setRecognitionHint('');
          await stopAr();
          return;
        }
      }

      setRecognitionPhase('FALLBACK_VISUAL');
      setRecognitionHint('Ищу по изображению...');

      const visualPayload = await apiFetch('/api/recognize/visual', {
        method: 'POST',
        body: JSON.stringify({
          image_base64: frame.dataUrl,
          embedding: frame.embedding,
        }),
      }).catch(() => ({ best: null }));

      if (visualPayload?.best?.wine_id) {
        const wine = wines.find((item) => item.id === visualPayload.best.wine_id);
        if (wine) {
          setContentWine(wine);
          setMode('content');
          setRecognitionPhase('MINDAR_LOCKED');
          setRecognitionHint('');
          await stopAr();
          return;
        }
      }

      setRecognitionPhase('NOT_FOUND');
      setRecognitionHint('Не нашли этикетку. Убери блики и наведи камеру ближе.');
    } catch (error) {
      const text = String(error?.message || '');
      if (text.includes('Камера еще не готова')) {
        setRecognitionPhase('TRY_MINDAR');
        setRecognitionHint('Подожди секунду, камера настраивается...');
        fallbackTimerRef.current = window.setTimeout(() => {
          if (!scanHandledRef.current && modeRef.current === 'scan') {
            runFallbackRecognition();
          }
        }, 1200);
        return;
      }
      setRecognitionPhase('NOT_FOUND');
      setRecognitionHint('Не удалось распознать этикетку. Попробуй другой угол без бликов.');
    }
  }

  async function handleStartScan() {
    try {
      setStartError('');
      setNotice({ text: '', type: '' });

      const manifest = await fetchTargetsManifest();
      const hasCompiledTargets = Boolean(manifest?.ready);
      const targetCount = Number.parseInt(manifest?.targetCount, 10) || 0;
      const targetWineMap = Array.isArray(manifest?.targetWineMap) ? manifest.targetWineMap : [];
      setCompiledTargetsReady(hasCompiledTargets);
      setCompiledTargetCount(targetCount);
      setCompiledTargetWineMap(targetWineMap);
      if (!hasCompiledTargets) {
        setStartError('Этикетки еще не готовы для сканера. Дождись завершения Compile Mind Targets.');
        return;
      }
      setMindTargetSrc(manifest?.url || '');

      setArBooted(true);
      setMode('scan');
      setScanFeedbackPhase('idle');
      setRecognitionPhase('TRY_MINDAR');
      setRecognitionHint('Наведи камеру на этикетку');
      clearFeedbackTimers();
      scanHandledRef.current = false;
      document.body.classList.add('is-scanning');
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      await startAr();

      fallbackTimerRef.current = window.setTimeout(() => {
        if (!scanHandledRef.current && modeRef.current === 'scan') {
          runFallbackRecognition();
        }
      }, MINDAR_TIMEOUT_MS);
    } catch (error) {
      setMode('home');
      setStartError(error.message || 'Проверь доступ к камере и попробуй снова.');
    }
  }

  async function handleStopScan() {
    await stopAr();
    setMode('home');
    setScanFeedbackPhase('idle');
    setRecognitionPhase('TRY_MINDAR');
    setRecognitionHint('');
    clearFeedbackTimers();
    scanHandledRef.current = false;
  }

  async function handleTargetFound(targetIndex) {
    if (scanHandledRef.current || modeRef.current !== 'scan') {
      return;
    }

    const wine = wines.find((item) => item.targetIndex === targetIndex);
    const mappedWineId = Array.isArray(compiledTargetWineMap) ? compiledTargetWineMap[targetIndex]?.wineId : null;
    const resolvedWine = mappedWineId
      ? wines.find((item) => item.id === mappedWineId)
      : wine;
    if (!resolvedWine) {
      return;
    }

    scanHandledRef.current = true;
    clearFeedbackTimers();
    setRecognitionPhase('MINDAR_LOCKED');
    setRecognitionHint('');
    setScanFeedbackPhase('loading');

    const burstTimer = window.setTimeout(() => {
      setScanFeedbackPhase('burst');
    }, LOADER_MS);

    const doneTimer = window.setTimeout(() => {
      setScanFeedbackPhase('done');
    }, LOADER_MS + BURST_MS);

    const completeTimer = window.setTimeout(async () => {
      setScanFeedbackPhase('idle');
      setContentWine(resolvedWine);
      setMode('content');
      await stopAr();
    }, LOADER_MS + BURST_MS + DONE_MS);

    feedbackTimersRef.current = [burstTimer, doneTimer, completeTimer];
  }

  async function refreshAdminAuth() {
    try {
      const payload = await apiFetch('/api/auth/me');
      const ok = Boolean(payload?.authenticated);
      setAdminAuthenticated(ok);
      setAdminAuthChecked(true);
      return ok;
    } catch {
      setAdminAuthenticated(false);
      setAdminAuthChecked(true);
      return false;
    }
  }

  async function handleAdminLogin(event) {
    event.preventDefault();
    setAdminAuthError('');
    if (!adminPassword.trim()) {
      setAdminAuthError('Введи пароль администратора.');
      return;
    }
    try {
      await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: adminPassword }),
      });
      setAdminAuthenticated(true);
      setAdminAuthChecked(true);
      setAdminPassword('');
      window.history.pushState({}, '', '/admin');
      setMode('admin');
    } catch (error) {
      setAdminAuthError(error.message || 'Не удалось выполнить вход.');
    }
  }

  async function handleAdminLogout() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setAdminAuthenticated(false);
    setAdminAuthChecked(true);
    setMode('admin-login');
    window.history.pushState({}, '', '/admin/login');
  }

  async function openAdmin() {
    stopAr();
    const ok = await refreshAdminAuth();
    if (!ok) {
      setMode('admin-login');
      setAdminAuthError('');
      window.history.pushState({}, '', '/admin/login');
      return;
    }
    setMode('admin');
    setAdminView('list');
    setScanFeedbackPhase('idle');
    clearFeedbackTimers();
    scanHandledRef.current = false;
    document.body.classList.remove('is-scanning');
    window.history.pushState({}, '', '/admin');

    if (!selectedWineId && wines[0]) {
      setSelectedWineId(wines[0].id);
      setForm(getFormFromWine(wines[0]));
    }

    if (!wines.length) {
      setForm(createEmptyForm());
    }
  }

  function closeAdmin() {
    setMode('home');
    setNotice({ text: '', type: '' });
    if (window.location.pathname.startsWith('/admin')) {
      window.history.pushState({}, '', '/');
    }
  }

  async function persistWines(nextWines) {
    await apiFetch('/wines', {
      method: 'PUT',
      body: JSON.stringify({ wines: nextWines }),
    });
  }

  function handleSelectWine(wine) {
    setSelectedWineId(wine.id);
    setAdminView('detail');
    setLabelProcess({
      jobId: null,
      status: wine.labelImage ? 'ready' : 'idle',
      targetIndex: wine.targetIndex,
      error: '',
    });
    setNotice({ text: '', type: '' });
  }

  function handleNewWine() {
    setSelectedWineId(null);
    setForm(createEmptyForm());
    setAdminView('create');
    setCreateStep('labels');
    setLabelProcess({
      jobId: null,
      status: 'idle',
      targetIndex: null,
      error: '',
    });
    setNotice({ text: '', type: '' });
  }

  function handleEditSelectedWine() {
    if (!selectedWine) {
      return;
    }
    setForm(getFormFromWine(selectedWine));
    setAdminView('edit');
    setCreateStep('form');
    setLabelProcess({
      jobId: null,
      status: selectedWine.labelImage ? 'ready' : 'idle',
      targetIndex: selectedWine.targetIndex,
      error: '',
    });
  }

  function handleBackToAdminList() {
    setAdminView('list');
    setCreateStep('labels');
    setLabelProcess({
      jobId: null,
      status: 'idle',
      targetIndex: null,
      error: '',
    });
    setNotice({ text: '', type: '' });
  }

  function handleFormChange(event) {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function getAssetByRole(role, sourceAssets = form.labelAssets) {
    return normalizeLabelAssets(sourceAssets).find((asset) => asset.role === role) || null;
  }

  function upsertLabelAsset(nextAsset) {
    setForm((prev) => {
      const current = normalizeLabelAssets(prev.labelAssets);
      const filtered = current.filter((asset) => asset.role !== nextAsset.role && asset.id !== nextAsset.id);
      const nextAssets = [...filtered, nextAsset];
      return {
        ...prev,
        ...deriveLabelFieldsFromAssets(nextAssets),
      };
    });
  }

  function openLabelModal(role) {
    const safeRole = REQUIRED_LABEL_ROLES.includes(role) ? role : 'front';
    const existing = getAssetByRole(safeRole);
    if (existing?.id) {
      openCropEditor(existing.id);
    } else {
      setCropEditor({ assetId: '', x: 0, y: 0, width: 100, height: 100 });
    }
    setLabelModal({
      open: true,
      role: safeRole,
    });
    setNotice({ text: '', type: '' });
  }

  function closeLabelModal() {
    setLabelModal({ open: false, role: 'front' });
  }

  function saveAndCloseLabelModal() {
    const role = labelModal.role;
    const asset = getAssetByRole(role);
    if (!asset?.dataUrl) {
      setNotice({ text: `Сначала загрузи и проверь фото для ракурса ${role}.`, type: 'error' });
      return;
    }
    applyCropToAsset()
      .then((ok) => {
        if (!ok) {
          return;
        }
        closeLabelModal();
        setNotice({ text: `Ракурс ${role} сохранен.`, type: 'success' });
      })
      .catch((error) => {
        setNotice({ text: error.message || 'Не удалось сохранить crop.', type: 'error' });
      });
  }

  async function handleRoleModalUpload(event) {
    const file = Array.from(event.target.files || [])[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    const role = labelModal.role;
    try {
      const optimized = await optimizeLabelImage(file);
      const visualEmbedding = await computeVisualEmbeddingFromDataUrl(optimized.dataUrl);
      const quality = await assessLabelQuality(optimized.dataUrl);
      const nextAsset = {
        id: crypto.randomUUID(),
        role,
        dataUrl: optimized.dataUrl,
        qualityScore: quality.score,
        qualityStatus: quality.status,
        qualityNotes: quality.notes,
        visualEmbedding,
      };
      upsertLabelAsset(nextAsset);
      openCropEditor(nextAsset.id);
      setLabelProcess({
        jobId: null,
        status: 'idle',
        targetIndex: null,
        error: '',
      });
      setNotice({ text: `Фото ${role} загружено. Проверь crop и нажми «Сохранить ракурс».`, type: 'success' });
    } catch (error) {
      setNotice({ text: error.message || 'Не удалось загрузить фото для шага.', type: 'error' });
    }
  }

  function handleClearLabelImage() {
    setForm((prev) => ({
      ...prev,
      labelAssets: [],
      ...deriveLabelFieldsFromAssets([]),
    }));
    setLabelProcess({
      jobId: null,
      status: 'idle',
      targetIndex: null,
      error: '',
    });
  }

  function handleRemoveLabelAsset(assetId) {
    setForm((prev) => {
      const nextAssets = normalizeLabelAssets(prev.labelAssets).filter((asset) => asset.id !== assetId);
      return { ...prev, ...deriveLabelFieldsFromAssets(nextAssets) };
    });
    setCropEditor((prev) => (prev.assetId === assetId ? {
      assetId: '',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    } : prev));
    setLabelProcess({
      jobId: null,
      status: 'idle',
      targetIndex: null,
      error: '',
    });
  }

  function handleClearRoleAsset(role) {
    const target = getAssetByRole(role);
    if (!target?.id) {
      return;
    }
    handleRemoveLabelAsset(target.id);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function startCropInteraction(event, mode) {
    const stage = cropStageRef.current;
    if (!stage) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const startX = event.clientX;
    const startY = event.clientY;
    const start = {
      left: cropEditor.x,
      right: cropEditor.x + cropEditor.width,
      top: cropEditor.y,
      bottom: cropEditor.y + cropEditor.height,
    };
    const minSize = 8;

    cropInteractionRef.current = { mode, rect, startX, startY, start, minSize };

    const onMove = (moveEvent) => {
      const state = cropInteractionRef.current;
      if (!state) {
        return;
      }
      const dx = ((moveEvent.clientX - state.startX) / state.rect.width) * 100;
      const dy = ((moveEvent.clientY - state.startY) / state.rect.height) * 100;
      let left = state.start.left;
      let right = state.start.right;
      let top = state.start.top;
      let bottom = state.start.bottom;

      if (state.mode === 'move') {
        left += dx;
        right += dx;
        top += dy;
        bottom += dy;

        if (left < 0) {
          right -= left;
          left = 0;
        }
        if (right > 100) {
          left -= (right - 100);
          right = 100;
        }
        if (top < 0) {
          bottom -= top;
          top = 0;
        }
        if (bottom > 100) {
          top -= (bottom - 100);
          bottom = 100;
        }
      } else {
        if (state.mode.includes('w')) {
          left += dx;
        }
        if (state.mode.includes('e')) {
          right += dx;
        }
        if (state.mode.includes('n')) {
          top += dy;
        }
        if (state.mode.includes('s')) {
          bottom += dy;
        }

        left = clamp(left, 0, 100);
        right = clamp(right, 0, 100);
        top = clamp(top, 0, 100);
        bottom = clamp(bottom, 0, 100);

        if (right - left < state.minSize) {
          if (state.mode.includes('w') && !state.mode.includes('e')) {
            left = right - state.minSize;
          } else {
            right = left + state.minSize;
          }
        }
        if (bottom - top < state.minSize) {
          if (state.mode.includes('n') && !state.mode.includes('s')) {
            top = bottom - state.minSize;
          } else {
            bottom = top + state.minSize;
          }
        }

        left = clamp(left, 0, 100 - state.minSize);
        top = clamp(top, 0, 100 - state.minSize);
        right = clamp(right, state.minSize, 100);
        bottom = clamp(bottom, state.minSize, 100);

        if (right - left < state.minSize) {
          if (state.mode.includes('w')) {
            left = right - state.minSize;
          } else {
            right = left + state.minSize;
          }
        }
        if (bottom - top < state.minSize) {
          if (state.mode.includes('n')) {
            top = bottom - state.minSize;
          } else {
            bottom = top + state.minSize;
          }
        }
      }

      setCropEditor((prev) => ({
        ...prev,
        x: Number(clamp(left, 0, 95).toFixed(2)),
        y: Number(clamp(top, 0, 95).toFixed(2)),
        width: Number(clamp(right - left, state.minSize, 100).toFixed(2)),
        height: Number(clamp(bottom - top, state.minSize, 100).toFixed(2)),
      }));
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      cropInteractionRef.current = null;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function openCropEditor(assetId) {
    setCropEditor({
      assetId,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  }

  async function applyCropToAsset() {
    const asset = normalizeLabelAssets(form.labelAssets).find((item) => item.id === cropEditor.assetId);
    if (!asset?.dataUrl) {
      return false;
    }
    try {
      const image = await loadImage(asset.dataUrl);
      const sx = Math.round((cropEditor.x / 100) * image.naturalWidth);
      const sy = Math.round((cropEditor.y / 100) * image.naturalHeight);
      const sw = Math.max(8, Math.round((cropEditor.width / 100) * image.naturalWidth));
      const sh = Math.max(8, Math.round((cropEditor.height / 100) * image.naturalHeight));

      const boundedW = Math.min(sw, image.naturalWidth - sx);
      const boundedH = Math.min(sh, image.naturalHeight - sy);
      const canvas = document.createElement('canvas');
      canvas.width = boundedW;
      canvas.height = boundedH;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) {
        throw new Error('Не удалось применить crop.');
      }

      context.drawImage(image, sx, sy, boundedW, boundedH, 0, 0, boundedW, boundedH);
      const croppedDataUrl = canvas.toDataURL('image/jpeg', LABEL_JPEG_QUALITY);
      const visualEmbedding = await computeVisualEmbeddingFromDataUrl(croppedDataUrl);
      const quality = await assessLabelQuality(croppedDataUrl);

      setForm((prev) => {
        const nextAssets = normalizeLabelAssets(prev.labelAssets).map((item) => (
          item.id === asset.id
            ? {
              ...item,
              dataUrl: croppedDataUrl,
              visualEmbedding,
              qualityScore: quality.score,
              qualityStatus: quality.status,
              qualityNotes: quality.notes,
            }
            : item
        ));
        return { ...prev, ...deriveLabelFieldsFromAssets(nextAssets) };
      });

      setLabelProcess({
        jobId: null,
        status: 'idle',
        targetIndex: null,
        error: '',
      });
      return true;
    } catch (error) {
      setNotice({ text: error.message || 'Не удалось применить crop.', type: 'error' });
      return false;
    }
  }

  async function handleProcessLabel() {
    const assets = normalizeLabelAssets(form.labelAssets);
    const primary = pickPrimaryAsset(assets);
    const roles = new Set(assets.map((asset) => asset.role));
    const hasRequired = REQUIRED_LABEL_ROLES.every((role) => roles.has(role));

    if (!assets.length || !primary?.dataUrl) {
      setNotice({ text: 'Сначала загрузи фото этикеток (минимум front/left/right).', type: 'error' });
      return;
    }
    if (!hasRequired) {
      setNotice({ text: 'Добавь обязательные ракурсы: front, left и right.', type: 'error' });
      return;
    }
    if (primary.qualityStatus === 'bad') {
      setNotice({ text: 'Основное фото этикетки низкого качества. Пересними без бликов и размытия.', type: 'error' });
      return;
    }

    try {
      setMindBuildStatus({ phase: 'preparing', progress: 0, text: 'Готовим dataset...' });
      setLabelProcess({
        jobId: null,
        status: 'processing',
        targetIndex: Number.parseInt(form.targetIndex, 10) || getNextFreeTargetIndex(wines),
        error: '',
      });

      const draftWineId = generateWineId(
        { title: form.title, region: form.region },
        wines.filter((wine) => wine.id !== selectedWineId),
        normalizeString(selectedWineId || form.id)
      );

      const draftWine = {
        id: draftWineId,
        labelAssets: assets,
        labelImage: primary?.dataUrl || '',
      };

      const compileWines = [
        ...normalizeWines(wines).filter((wine) => wine.id !== draftWineId),
        draftWine,
      ];

      const compileItems = compileWines.flatMap((wine) => {
        const assets = normalizeLabelAssets(wine.labelAssets);
        const sourceAssets = assets.length
          ? assets
          : (wine.labelImage ? [{
            id: `legacy-${wine.id}`,
            role: 'front',
            dataUrl: wine.labelImage,
          }] : []);
        return sourceAssets.map((asset) => ({
          wineId: wine.id,
          role: asset.role || 'front',
          dataUrl: asset.dataUrl,
        })).filter((asset) => asset.dataUrl);
      });

      if (!compileItems.length) {
        throw new Error('Нет этикеток для компиляции.');
      }

      setMindBuildStatus({ phase: 'preparing', progress: 0, text: 'Оптимизируем фото перед компиляцией...' });
      const compileImages = await Promise.all(
        compileItems.map((item) => downscaleForCompile(item.dataUrl).catch(() => item.dataUrl))
      );

      const compiledBuffer = await new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          reject(new Error('Компиляция заняла слишком много времени. Попробуй уменьшить количество фото или их размер.'));
        }, COMPILE_TIMEOUT_MS);
        (async () => {
          try {
            const images = [];
            for (let i = 0; i < compileImages.length; i += 1) {
              images.push(await loadImage(compileImages[i]));
            }
            const OfflineCompiler = await getOfflineCompiler();
            const compiler = new OfflineCompiler();
            await compiler.compileImageTargets(images, (progress) => {
              setMindBuildStatus({
                phase: 'compiling',
                progress: Number.parseInt(progress, 10) || 0,
                text: `Компиляция ${Number.parseInt(progress, 10) || 0}%`,
              });
            });
            const compiled = compiler.exportData();
            window.clearTimeout(timeoutId);
            resolve(compiled?.buffer || compiled);
          } catch (error) {
            window.clearTimeout(timeoutId);
            reject(new Error(error?.message || 'Не удалось собрать .mind'));
          }
        })();
      });

      const mindArrayBuffer = compiledBuffer instanceof ArrayBuffer ? compiledBuffer : new Uint8Array(compiledBuffer).buffer;
      const hash = await sha256HexFromArrayBuffer(mindArrayBuffer);
      setMindBuildStatus({ phase: 'uploading', progress: 100, text: 'Загружаем в R2...' });

      const presign = await apiFetch('/api/admin/mind/presign-put', {
        method: 'POST',
        body: JSON.stringify({
          wineId: 'global',
          hash,
          targetCount: compileItems.length,
          targetWineMap: compileItems.map((item) => ({
            wineId: item.wineId,
            role: item.role,
            assetHash: `${item.wineId}:${item.role}`,
          })),
        }),
      });

      const putResponse = await fetch(presign.putUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(presign.requiredHeaders || {}),
        },
        body: mindArrayBuffer,
      });
      if (!putResponse.ok) {
        throw new Error(`Не удалось загрузить .mind в R2 (${putResponse.status})`);
      }

      const manifest = await fetchTargetsManifest();
      setCompiledTargetsReady(Boolean(manifest?.ready));
      setCompiledTargetCount(Number.parseInt(manifest?.targetCount, 10) || compileItems.length);
      setCompiledTargetWineMap(Array.isArray(manifest?.targetWineMap) ? manifest.targetWineMap : []);
      if (manifest?.url) {
        setMindTargetSrc(manifest.url);
      }
      setMindBuildStatus({ phase: 'ready', progress: 100, text: 'Mind dataset готов.' });
      setLabelProcess({
        jobId: null,
        status: 'ready',
        targetIndex: Number.parseInt(form.targetIndex, 10) || 0,
        error: '',
      });
      setNotice({ text: 'Этикетки скомпилированы и загружены в R2.', type: 'success' });
    } catch (error) {
      setMindBuildStatus({ phase: 'error', progress: 0, text: error.message || 'Ошибка сборки .mind' });
      setLabelProcess({
        jobId: null,
        status: 'error',
        targetIndex: null,
        error: error.message || 'Не удалось запустить обработку.',
      });
      setNotice({ text: error.message || 'Не удалось запустить обработку.', type: 'error' });
    }
  }

  async function handleAutofillFromLabel() {
    const front = getAssetByRole('front');
    if (!front?.dataUrl) {
      setNotice({ text: 'Сначала загрузи ракурс front.', type: 'error' });
      return;
    }
    try {
      const assetsForOcr = REQUIRED_LABEL_ROLES
        .map((role) => getAssetByRole(role))
        .filter((asset) => asset?.dataUrl);
      setNotice({ text: `Распознаем текст с ${assetsForOcr.length} ракурсов...`, type: 'success' });
      const payloads = await Promise.all(
        assetsForOcr.map((asset) => apiFetch('/api/recognize/ocr', {
          method: 'POST',
          body: JSON.stringify({
            image_base64: asset.dataUrl,
            ocr_text: '',
            locale_hint: 'ru',
          }),
        }))
      );
      const mergedRawText = payloads
        .map((payload) => String(payload?.ocr_text_raw || payload?.ocr_text || '').trim())
        .filter(Boolean)
        .join('\n');
      const mergedLines = payloads.flatMap((payload) => (Array.isArray(payload?.ocr_lines) ? payload.ocr_lines : []));
      const parsed = extractPrefillFromOcr(mergedRawText, mergedLines);
      let filledCount = 0;
      setForm((prev) => {
        const nextTitle = prev.title || parsed.title || '';
        const nextYear = prev.year || parsed.year || '';
        const nextRegion = prev.region || parsed.region || '';
        const nextProducer = prev.producer || parsed.producer || '';
        const nextGrapes = prev.grapes || parsed.grapes || '';
        filledCount = [
          !prev.title && Boolean(nextTitle),
          !prev.year && Boolean(nextYear),
          !prev.region && Boolean(nextRegion),
          !prev.producer && Boolean(nextProducer),
          !prev.grapes && Boolean(nextGrapes),
        ].filter(Boolean).length;
        return {
          ...prev,
          title: nextTitle,
          year: nextYear,
          producer: nextProducer,
          region: nextRegion,
          grapes: nextGrapes,
        };
      });
      if (filledCount > 0) {
        setNotice({
          text: `Автозаполнение сработало: заполнено полей ${filledCount}. Проверь и поправь при необходимости.`,
          type: 'success',
        });
      } else {
        setNotice({
          text: 'OCR не смог извлечь данные для автозаполнения. Проверь качество этикеток и наличие OCR ключа на backend.',
          type: 'error',
        });
      }
    } catch (error) {
      setNotice({ text: error.message || 'Не удалось распознать текст этикетки.', type: 'error' });
    }
  }

  async function handleContinueToWineCard() {
    if (!hasRequiredLabelShots) {
      setNotice({ text: 'Сначала заполни front, left и right.', type: 'error' });
      return;
    }
    await handleAutofillFromLabel();
    setCreateStep('form');
  }

  function normalizeFormWine({ asDraft = false } = {}) {
    const existingWine = selectedWineId ? wines.find((item) => item.id === selectedWineId) : null;
    const id = generateWineId(
      { title: form.title, region: form.region },
      wines.filter((item) => item.id !== selectedWineId),
      normalizeString(existingWine?.id || form.id || selectedWineId || '')
    );
    const targetIndexRaw = Number.parseInt(form.targetIndex, 10);
    const targetIndex = Number.isInteger(targetIndexRaw) && targetIndexRaw >= 0
      ? targetIndexRaw
      : Number.isInteger(existingWine?.targetIndex)
        ? existingWine.targetIndex
        : getNextFreeTargetIndex(wines);
    const title = normalizeString(form.title);
    const subtitle = normalizeString(form.region || form.subtitle);
    const producer = normalizeString(form.producer);
    const region = normalizeString(form.region);
    const year = normalizeString(form.year);
    const grapes = normalizeString(form.grapes);
    const description = normalizeString(form.description);
    const story = normalizeString(form.story);
    const serving = normalizeString(form.serving);
    const rating = Number.parseFloat(form.rating);

    if (!asDraft && (!title || !story || !serving)) {
      throw new Error('Заполни наименование, историю и подачу.');
    }

    if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
      throw new Error('Рейтинг должен быть числом от 0 до 5.');
    }

    if (!asDraft && normalizeString(form.labelImage) && labelProcess.status !== 'ready') {
      throw new Error('Сначала дождись завершения обработки этикетки.');
    }

    return {
      id,
      targetIndex,
      title,
      subtitle,
      producer,
      region,
      year,
      grapes,
      description,
      story,
      serving,
      rating: Number(rating.toFixed(1)),
      labelImage: normalizeString(form.labelImage),
      visualEmbedding: Array.isArray(form.visualEmbedding)
        ? form.visualEmbedding.map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value))
        : [],
      qualityScore: Number.parseInt(form.qualityScore, 10) || 0,
      qualityStatus: normalizeString(form.qualityStatus) || 'unknown',
      qualityNotes: Array.isArray(form.qualityNotes) ? form.qualityNotes.map((item) => String(item || '').trim()).filter(Boolean) : [],
      labelAssets: normalizeLabelAssets(form.labelAssets),
      status: asDraft ? 'draft' : 'published',
      pairings: parseTags(form.pairings),
      gallery: parseGallery(form.gallery),
    };
  }

  async function saveWineWithMode({ asDraft }) {
    try {
      const wine = normalizeFormWine({ asDraft });

      const duplicateId = wines.some(
        (item) => item.id === wine.id && item.id !== selectedWineId
      );
      if (duplicateId) {
        throw new Error('Вино с таким ID уже существует.');
      }

      const duplicateTarget = wines.some(
        (item) => item.targetIndex === wine.targetIndex && item.id !== selectedWineId
      );
      if (duplicateTarget) {
        throw new Error('Системный индекс уже занят. Измени регион/название и попробуй снова.');
      }

      let nextWines;
      if (!selectedWineId) {
        nextWines = [...wines, wine];
      } else {
        nextWines = wines.map((item) => (item.id === selectedWineId ? wine : item));
      }

      setWines(nextWines);
      setSelectedWineId(wine.id);
      setForm(getFormFromWine(wine));
      setAdminView('detail');
      setCreateStep('labels');
      setNotice({ text: asDraft ? 'Драфт сохранен.' : 'Опубликовано.', type: 'success' });
      await persistWines(nextWines);
    } catch (error) {
      setNotice({ text: error.message || 'Не удалось сохранить вино.', type: 'error' });
    }
  }

  async function handleSaveWine(event) {
    event.preventDefault();
    await saveWineWithMode({ asDraft: false });
  }

  async function handleSaveDraft() {
    await saveWineWithMode({ asDraft: true });
  }

  async function handleDeleteWine() {
    if (!selectedWineId) {
      setNotice({ text: 'Сначала выбери вино для удаления.', type: 'error' });
      return;
    }

    const nextWines = wines.filter((wine) => wine.id !== selectedWineId);
    try {
      await persistWines(nextWines);
      setWines(nextWines);
    } catch (error) {
      setNotice({ text: error.message || 'Не удалось удалить карточку.', type: 'error' });
      return;
    }

    if (!nextWines.length) {
      setSelectedWineId(null);
      setForm(createEmptyForm());
      setAdminView('list');
      setNotice({ text: 'Карточка удалена. Добавь новое вино.', type: 'success' });
      return;
    }

    const first = [...nextWines].sort((a, b) => a.targetIndex - b.targetIndex)[0];
    setSelectedWineId(first.id);
    setForm(getFormFromWine(first));
    setAdminView('list');
    setNotice({ text: 'Карточка удалена.', type: 'success' });
  }

  function handleDownloadJson() {
    const payload = JSON.stringify({ wines }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = 'wines.json';
    link.click();

    URL.revokeObjectURL(url);
    setNotice({ text: 'JSON выгружен.', type: 'success' });
  }

  return (
    <>
      {arBooted && (
        <a-scene
          ref={sceneRef}
          mindar-image={`imageTargetSrc: ${mindTargetSrc}; autoStart: false; uiScanning: no; uiLoading: no`}
          color-space="sRGB"
          renderer="colorManagement: true, physicallyCorrectLights, alpha: true"
          vr-mode-ui="enabled: false"
          device-orientation-permission-ui="enabled: false"
          className={`ar-scene ${mode === 'scan' ? '' : 'hidden'}`}
          style={{
            display: 'block',
            visibility: mode === 'scan' ? 'visible' : 'hidden',
            position: 'fixed',
            inset: 0,
            width: '100vw',
            height: 'var(--app-height)',
            zIndex: 1,
            pointerEvents: mode === 'scan' ? 'auto' : 'none',
          }}
        >
          <a-camera position="0 0 0" look-controls="enabled: false"></a-camera>
          <a-entity ref={targetsRootRef}></a-entity>
        </a-scene>
      )}

      <main
        className={`app-shell ${mode === 'scan' ? 'is-scan' : ''} ${mode === 'home' ? 'is-home' : ''} ${mode === 'admin' ? 'is-admin' : ''} ${mode === 'content' ? 'is-content' : ''}`}
      >
        {mode === 'home' && (
          <section className="home-screen">
            <div className="home-abstract" aria-hidden="true"></div>
            <div
              className="home-pattern"
              aria-hidden="true"
              style={{ backgroundImage: `url(${WINE_PATTERN_IMAGE})` }}
            ></div>
            <div className="home-center">
              <div className="home-card">
                <p className="eyebrow">AR Scanning</p>
                <h1>Сканируй этикетки и показывай историю вина</h1>
                <p className="lead">
                  Запусти камеру, наведи на этикетку и покажи карточку с контентом.
                </p>
                {!compiledTargetsReady && (
                  <p className="field-note">
                    Новые этикетки появятся в сканере после фоновой компиляции target-файла (обычно до 5 минут).
                  </p>
                )}
                {startError && <p className="notice is-error">{startError}</p>}
                <div className="actions-row">
                  <button className="primary-btn" onClick={handleStartScan}>
                    Начать сканирование
                  </button>
                </div>
              </div>
            </div>

            <footer className="entry-footer home-footer">
              <button className="admin-link" onClick={openAdmin}>
                Перейти в админку
              </button>
              <p className="copyright">VineLabs 2026</p>
            </footer>
          </section>
        )}

        {mode === 'scan' && (
          <section className="scanner-panel scan-panel-hud">
            <div className="scan-state">
              <div className="scan-toolbar">
                <button className="ghost-btn" onClick={handleStopScan}>
                  Отмена
                </button>
              </div>
              <p className="scan-pill">{recognitionHint || 'Наведи камеру на этикетку'}</p>
              <div className="scanner-frame" aria-hidden="true"></div>
              {scanFeedbackPhase !== 'idle' && (
                <div className={`scan-feedback is-${scanFeedbackPhase}`}>
                  {scanFeedbackPhase === 'loading' && <div className="scan-loader" />}
                  {scanFeedbackPhase === 'burst' && <div className="scan-burst" />}
                  {scanFeedbackPhase === 'done' && (
                    <div className="success-overlay">
                      <p>Well done!</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {mode === 'content' && contentWine && (
          <>
            <section className="panel scanner-panel">
              <div className="content-state">
                <p className="eyebrow">{contentWine.region || contentWine.producer || ''}</p>
                <h2>{contentWine.title}</h2>
                <p>{contentWine.story}</p>
                <p className="meta">{contentWine.serving}</p>

                <section>
                  <p className="section-title">Pairings</p>
                  <div className="chips-wrap">
                    {contentWine.pairings.map((item) => (
                      <span key={item} className="chip">
                        {item}
                      </span>
                    ))}
                  </div>
                </section>

                <section>
                  <p className="section-title">Visual Story</p>
                  <div className="gallery">
                    {contentWine.gallery.map((url) => (
                      <img key={url} src={url} alt={contentWine.title} className="gallery-image" loading="lazy" />
                    ))}
                  </div>
                </section>

                <div className="actions-row">
                  <button className="primary-btn" onClick={handleStartScan}>
                    Сканировать снова
                  </button>
                  <button className="ghost-btn" onClick={openAdmin}>
                    Редактировать контент
                  </button>
                </div>
              </div>
            </section>
            <footer className="entry-footer">
              <button className="admin-link" onClick={openAdmin}>
                Перейти в админку
              </button>
              <p className="copyright">VineLabs 2026</p>
            </footer>
          </>
        )}

        {mode === 'admin-login' && (
          <section className="panel admin-panel">
            <div className="admin-header">
              <div>
                <p className="eyebrow">Admin Auth</p>
                <h2>Вход в админку</h2>
                <p className="lead">Авторизуйся, чтобы управлять контентом и собирать .mind dataset.</p>
              </div>
              <button className="ghost-btn" onClick={closeAdmin}>
                На главную
              </button>
            </div>
            <form className="admin-form" onSubmit={handleAdminLogin}>
              <label className="field field-wide">
                <span>Пароль администратора</span>
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(event) => setAdminPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              {adminAuthError && <p className="notice is-error">{adminAuthError}</p>}
              <div className="actions-row">
                <button className="primary-btn" type="submit">
                  Войти
                </button>
              </div>
            </form>
          </section>
        )}

        {mode === 'admin' && (
          <section className="panel admin-panel">
            <div className="admin-header">
              <div className="admin-title-wrap">
                <div className="admin-title-icon"><Wine size={26} strokeWidth={2.1} /></div>
                <div>
                <p className="eyebrow">Vinoria Admin</p>
                <h2>
                  {adminView === 'list' && 'Wine Catalog'}
                  {adminView === 'detail' && 'Карточка вина'}
                  {adminView === 'edit' && 'Редактирование вина'}
                  {adminView === 'create' && (createStep === 'labels' ? 'Add New Wine - Step 1' : 'Add New Wine - Step 2')}
                </h2>
                </div>
              </div>
              <div className="actions-row admin-head-actions">
                <button className="ghost-btn admin-bell" type="button" aria-label="Уведомления">
                  <Bell size={18} />
                </button>
                <button className="ghost-btn" type="button" onClick={handleAdminLogout}>
                  Выйти
                </button>
                <button className="ghost-btn" onClick={closeAdmin}>
                  К сканеру
                </button>
              </div>
            </div>
            {adminView === 'list' && (
              <div className="admin-overview admin-mobile-shell">
                <div className="admin-search-box">
                  <Search size={18} className="search-icon" />
                  <input
                    type="search"
                    placeholder="Search wine labels, vintages..."
                    value={adminSearch}
                    onChange={(event) => setAdminSearch(event.target.value)}
                  />
                </div>
                <div className="admin-tabs">
                  <button
                    type="button"
                    className={`admin-tab ${adminListTab === 'published' ? 'is-active' : ''}`}
                    onClick={() => setAdminListTab('published')}
                  >
                    Published
                  </button>
                  <button
                    type="button"
                    className={`admin-tab ${adminListTab === 'draft' ? 'is-active' : ''}`}
                    onClick={() => setAdminListTab('draft')}
                  >
                    Drafts
                  </button>
                  <button
                    type="button"
                    className={`admin-tab ${adminListTab === 'all' ? 'is-active' : ''}`}
                    onClick={() => setAdminListTab('all')}
                  >
                    All
                  </button>
                </div>

                <div className="catalog-list">
                  {!visibleAdminWines.length && <div className="empty-item">Ничего не найдено.</div>}
                  {visibleAdminWines.map((wine) => {
                    const front = normalizeLabelAssets(wine.labelAssets).find((asset) => asset.role === 'front');
                    return (
                      <button key={wine.id} className="catalog-row" onClick={() => handleSelectWine(wine)}>
                        <div className="catalog-thumb">
                          {front?.dataUrl ? <img src={front.dataUrl} alt={wine.title || wine.id} /> : <span>∅</span>}
                        </div>
                        <div className="catalog-main">
                          <div className="wine-item-title">{[wine.title || wine.id, wine.year || ''].filter(Boolean).join(' ')}</div>
                          <div className="wine-item-subtitle">{wine.region || wine.producer || 'Без региона'}</div>
                        </div>
                        <div className={`catalog-badge ${wine.status === 'draft' ? 'is-draft' : 'is-published'}`}>
                          {wine.status === 'draft' ? 'DRAFT' : 'PUBLISHED'}
                        </div>
                        <div className="catalog-arrow"><ChevronRight size={18} /></div>
                      </button>
                    );
                  })}
                </div>
                <button className="admin-fab" type="button" onClick={handleNewWine} aria-label="Add new wine">
                  +
                </button>
                <div className="admin-bottom-nav">
                  <button type="button" className="is-active"><LayoutGrid size={18} />Catalog</button>
                  <button type="button"><BarChart3 size={18} />Analytics</button>
                  <button type="button" onClick={closeAdmin}><ScanLine size={18} />Scanner</button>
                  <button type="button" onClick={handleDownloadJson}><Settings size={18} />Export</button>
                </div>
                <div className="admin-actions-row">
                  <button className="ghost-btn" type="button" onClick={handleDownloadJson}>
                    Скачать JSON
                  </button>
                  <button className="ghost-btn" type="button" onClick={handleNewWine}>
                    Добавить новое вино
                  </button>
                </div>
              </div>
            )}

            {adminView === 'detail' && selectedWine && (
              <div className="admin-detail">
                <div className="detail-grid">
                  <p><strong>Наименование:</strong> {selectedWine.title}</p>
                  <p><strong>Производитель:</strong> {selectedWine.producer || '—'}</p>
                  <p><strong>Апелласьон/регион:</strong> {selectedWine.region || '—'}</p>
                  <p><strong>Год:</strong> {selectedWine.year || '—'}</p>
                  <p><strong>Сорта:</strong> {selectedWine.grapes || '—'}</p>
                  <p><strong>Рейтинг:</strong> {selectedWine.rating.toFixed(1)} / 5</p>
                  <p><strong>Подача:</strong> {selectedWine.serving}</p>
                  <p className="detail-wide"><strong>Описание:</strong> {selectedWine.description || '—'}</p>
                  <p className="detail-wide"><strong>История:</strong> {selectedWine.story}</p>
                  {!!selectedWine.labelAssets?.length && (
                    <p className="detail-wide">
                      <strong>Этикетки:</strong>
                      {selectedWine.labelAssets.map((asset) => (
                        <img key={asset.id} className="label-preview" src={asset.dataUrl} alt={`${selectedWine.title} ${asset.role}`} />
                      ))}
                    </p>
                  )}
                  <p className="detail-wide"><strong>Pairings:</strong> {selectedWine.pairings.join(', ') || '—'}</p>
                  <p className="detail-wide"><strong>Gallery:</strong> {selectedWine.gallery.length} изображений</p>
                </div>

                <div className="actions-row">
                  <button className="primary-btn" onClick={handleEditSelectedWine}>
                    Редактировать
                  </button>
                  <button className="ghost-btn" onClick={handleBackToAdminList}>
                    Назад к списку
                  </button>
                </div>
              </div>
            )}

            {(adminView === 'edit' || adminView === 'create') && (
              <form className={`admin-form ${createStep === 'labels' ? 'is-step-labels' : 'is-step-form'}`} onSubmit={handleSaveWine}>
                {adminView === 'create' && (
                  <div className="wizard-progress-wrap">
                    <div className="wizard-progress-head">
                      <span>Overall Progress</span>
                      <span>Step {createStep === 'labels' ? '1' : '2'} of 2</span>
                    </div>
                    <div className="wizard-progress-track">
                      <div className="wizard-progress-fill" style={{ width: createStep === 'labels' ? '50%' : '100%' }} />
                    </div>
                  </div>
                )}
                <div className="form-grid">
                  {(adminView !== 'create' || createStep === 'form') && (
                    <>
                  <p className="field-note field-wide">
                    Final Details & Characteristics
                  </p>

                  <label className="field">
                    <span>Points / Rating</span>
                    <input
                      name="rating"
                      type="number"
                      min="0"
                      max="5"
                      step="0.1"
                      value={form.rating}
                      onChange={handleFormChange}
                      required
                    />
                  </label>

                  <label className="field field-wide">
                    <span>Wine Name</span>
                    <input name="title" value={form.title} onChange={handleFormChange} required />
                  </label>

                  <label className="field">
                    <span>Producer</span>
                    <input name="producer" value={form.producer} onChange={handleFormChange} />
                  </label>

                  <label className="field">
                    <span>Region</span>
                    <input name="region" value={form.region} onChange={handleFormChange} />
                  </label>

                  <label className="field">
                    <span>Vintage</span>
                    <input name="year" value={form.year} onChange={handleFormChange} placeholder="2021" />
                  </label>

                  <label className="field">
                    <span>Grapes</span>
                    <input name="grapes" value={form.grapes} onChange={handleFormChange} />
                  </label>

                  <label className="field field-wide">
                    <span>Description</span>
                    <textarea name="description" rows="3" value={form.description} onChange={handleFormChange} />
                  </label>

                  <label className="field field-wide">
                    <span>The Story</span>
                    <textarea name="story" rows="4" value={form.story} onChange={handleFormChange} required />
                  </label>

                  <label className="field field-wide">
                    <span>Sommelier Tip</span>
                    <textarea name="serving" rows="3" value={form.serving} onChange={handleFormChange} required />
                  </label>
                    </>
                  )}

                  {(adminView !== 'create' || createStep === 'labels') && (
                  <div className="field field-wide">
                    <span>Upload wine labels from 3 sides</span>
                    <p className="field-note">Please provide clear images of the bottle packaging.</p>
                    <div className="quick-tip-box">
                      <strong>Quick Tips</strong>
                      <p>Ensure lighting is consistent. Use high-resolution JPG or PNG (max 5MB).</p>
                    </div>
                    <div className="wizard-upload-grid">
                      {REQUIRED_LABEL_ROLES.map((role) => {
                        const asset = getAssetByRole(role);
                        return (
                          <button
                            key={role}
                            type="button"
                            className={`upload-slot ${asset?.dataUrl ? 'is-ready' : ''}`}
                            onClick={() => openLabelModal(role)}
                          >
                            {asset?.dataUrl ? (
                              <img src={asset.dataUrl} alt={`Этикетка ${role}`} />
                            ) : (
                              <div className="upload-placeholder">Tap to upload</div>
                            )}
                            <div className="upload-slot-foot">
                              <strong>{role[0].toUpperCase() + role.slice(1)}</strong>
                              <span>{asset?.dataUrl ? 'OK' : 'Required'}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {!!form.labelAssets?.length && (
                      <div className="actions-row">
                        <button className="ghost-btn" type="button" onClick={handleClearLabelImage}>
                          Очистить
                        </button>
                      </div>
                    )}
                    {form.qualityStatus !== 'unknown' && (
                      <p className={`field-note process-note is-${
                        form.qualityStatus === 'good'
                          ? 'ready'
                          : form.qualityStatus === 'medium'
                            ? 'processing'
                            : 'error'
                      }`}>
                        Quality Gate: {
                          form.qualityStatus === 'good'
                            ? `✅ Хорошо (${form.qualityScore}/100)`
                            : form.qualityStatus === 'medium'
                              ? `⚠️ Средне (${form.qualityScore}/100)`
                              : `❌ Плохо (${form.qualityScore}/100)`
                        }
                      </p>
                    )}
                    {Array.isArray(form.qualityNotes) && form.qualityNotes.length > 0 && (
                      <p className="field-note">{form.qualityNotes.join(' ')}</p>
                    )}
                    {labelProcess.status !== 'idle' && (
                      <p className={`field-note process-note is-${labelProcess.status}`}>
                        {labelProcess.status === 'processing' && 'Обрабатываем изображение...'}
                        {labelProcess.status === 'ready' && 'Готово. Этикетка подготовлена для сохранения.'}
                        {labelProcess.status === 'error' &&
                          `Ошибка: ${labelProcess.error || 'Не удалось обработать.'}`}
                      </p>
                    )}
                    {mindBuildStatus.phase !== 'idle' && (
                      <p className={`field-note process-note is-${
                        mindBuildStatus.phase === 'ready'
                          ? 'ready'
                          : mindBuildStatus.phase === 'error'
                            ? 'error'
                            : 'processing'
                      }`}>
                        {mindBuildStatus.text}
                      </p>
                    )}
                    <div className="actions-row">
                      <button className="primary-btn" type="button" onClick={handleProcessLabel}>
                        Обработать этикетку
                      </button>
                      {adminView === 'create' && (
                        <button
                          className="primary-btn"
                          type="button"
                          onClick={handleContinueToWineCard}
                          disabled={!hasRequiredLabelShots}
                        >
                          Next Step
                        </button>
                      )}
                    </div>
                  </div>
                  )}

                  {(adminView !== 'create' || createStep === 'form') && (
                    <>
                  <div className="field field-wide">
                    <span>Autofill</span>
                    <div className="actions-row">
                      <button className="ghost-btn" type="button" onClick={handleAutofillFromLabel}>
                        Заполнить из этикетки
                      </button>
                    </div>
                  </div>
                  <label className="field field-wide">
                    <span>Sensory map tags (запятая или новая строка)</span>
                    <textarea name="pairings" rows="3" value={form.pairings} onChange={handleFormChange} />
                  </label>

                  <label className="field field-wide">
                    <span>Gallery URLs (одна ссылка в строке)</span>
                    <textarea name="gallery" rows="4" value={form.gallery} onChange={handleFormChange} />
                  </label>
                    </>
                  )}
                </div>

                <p className={`notice ${notice.type ? `is-${notice.type}` : ''}`}>{notice.text}</p>

                <div className="actions-row">
                  {adminView === 'create' && createStep === 'form' && (
                    <>
                      <button className="ghost-btn" type="button" onClick={handleSaveDraft}>
                        Save as Draft
                      </button>
                      <button className="primary-btn" type="submit">
                        Publish Wine
                      </button>
                    </>
                  )}
                  {adminView === 'edit' && (
                    <>
                      <button className="primary-btn" type="submit">
                        Сохранить
                      </button>
                      <button className="ghost-btn" type="button" onClick={handleDeleteWine}>
                        Удалить
                      </button>
                    </>
                  )}
                  <button className="ghost-btn" type="button" onClick={handleBackToAdminList}>
                    Назад к списку
                  </button>
                </div>
              </form>
            )}
          </section>
        )}

        {labelModal.open && (
          <div className="label-modal-backdrop" role="dialog" aria-modal="true">
            <div className="label-modal">
              <div className="label-modal-header">
                <h3>Ракурс: {labelModal.role}</h3>
                <button className="ghost-btn" type="button" onClick={closeLabelModal}>
                  Закрыть
                </button>
              </div>
              <p className="field-note">
                Загрузи фото и перетащи рамку прямо на изображении. Когда все ок, нажми «Сохранить».
              </p>
              <div className="label-upload-row">
                <input type="file" accept="image/*" onChange={handleRoleModalUpload} />
                <button className="ghost-btn" type="button" onClick={() => handleClearRoleAsset(labelModal.role)}>
                  Очистить ракурс
                </button>
              </div>

              {getAssetByRole(labelModal.role)?.dataUrl && (
                <>
                  <div
                    className="crop-stage"
                    ref={cropStageRef}
                    style={{
                      '--crop-left': `${cropEditor.x}%`,
                      '--crop-top': `${cropEditor.y}%`,
                      '--crop-right': `${cropEditor.x + cropEditor.width}%`,
                      '--crop-bottom': `${cropEditor.y + cropEditor.height}%`,
                    }}
                  >
                    <img
                      className="crop-stage-image"
                      src={getAssetByRole(labelModal.role)?.dataUrl}
                      alt={`Этикетка ${labelModal.role}`}
                    />
                    <div
                      className="crop-stage-box"
                      style={{
                        left: `${cropEditor.x}%`,
                        top: `${cropEditor.y}%`,
                        width: `${cropEditor.width}%`,
                        height: `${cropEditor.height}%`,
                      }}
                      onPointerDown={(event) => startCropInteraction(event, 'move')}
                    />
                    <button className="crop-handle is-nw" type="button" onPointerDown={(event) => { event.stopPropagation(); startCropInteraction(event, 'nw'); }} />
                    <button className="crop-handle is-ne" type="button" onPointerDown={(event) => { event.stopPropagation(); startCropInteraction(event, 'ne'); }} />
                    <button className="crop-handle is-sw" type="button" onPointerDown={(event) => { event.stopPropagation(); startCropInteraction(event, 'sw'); }} />
                    <button className="crop-handle is-se" type="button" onPointerDown={(event) => { event.stopPropagation(); startCropInteraction(event, 'se'); }} />
                    <button className="crop-handle is-n" type="button" onPointerDown={(event) => { event.stopPropagation(); startCropInteraction(event, 'n'); }} />
                    <button className="crop-handle is-s" type="button" onPointerDown={(event) => { event.stopPropagation(); startCropInteraction(event, 's'); }} />
                    <button className="crop-handle is-w" type="button" onPointerDown={(event) => { event.stopPropagation(); startCropInteraction(event, 'w'); }} />
                    <button className="crop-handle is-e" type="button" onPointerDown={(event) => { event.stopPropagation(); startCropInteraction(event, 'e'); }} />
                  </div>
                  <p className="field-note">Тяни рамку за углы/стороны или перемещай её целиком.</p>
                  <div className="actions-row">
                    <button className="primary-btn" type="button" onClick={saveAndCloseLabelModal}>
                      Сохранить
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
