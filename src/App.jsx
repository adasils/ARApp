import { useEffect, useMemo, useRef, useState } from 'react';

const CONTENT_PATH = `${import.meta.env.BASE_URL}data/wines.json`;
const LOCAL_STORAGE_KEY = 'wine-label-admin-data-v2';
const WINE_PATTERN_IMAGE = `${import.meta.env.BASE_URL}images/wine-svgrepo-com.svg`;
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
const DEMO_MIND_TARGET_SRC = 'https://raw.githubusercontent.com/hiukim/mind-ar-js/master/examples/image-tracking/assets/card-example/card.mind';
const LOADER_MS = 850;
const BURST_MS = 280;
const DONE_MS = 900;
const MINDAR_TIMEOUT_MS = 3200;
const LABEL_MAX_SIDE = 1800;
const LABEL_JPEG_QUALITY = 0.9;
const LABEL_ROLES = ['front', 'left', 'right', 'closeup', 'alt'];

function isApiEnabled() {
  return Boolean(API_BASE_URL);
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(payload?.error || `API error: ${response.status}`);
  }

  return payload;
}

async function fetchTargetsManifest() {
  if (!isApiEnabled()) {
    return null;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/targets/manifest?ts=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return payload?.manifest || null;
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

function pickNextRole(existingAssets, index = 0) {
  const used = new Set((existingAssets || []).map((asset) => asset.role));
  const available = LABEL_ROLES.find((role) => !used.has(role));
  if (available) {
    return available;
  }
  return LABEL_ROLES[Math.min(index, LABEL_ROLES.length - 1)];
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
    subtitle: normalizeString(wine?.subtitle),
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
    subtitle: wine?.subtitle || '',
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
  };
}

function createEmptyForm(nextIndex = 0) {
  return {
    id: '',
    targetIndex: String(nextIndex),
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
  };
}

export default function App() {
  const sceneRef = useRef(null);
  const targetsRootRef = useRef(null);
  const arStartedRef = useRef(false);
  const scanHandledRef = useRef(false);
  const modeRef = useRef('home');
  const feedbackTimersRef = useRef([]);
  const labelPollTimerRef = useRef(null);
  const fallbackTimerRef = useRef(null);

  const [mode, setMode] = useState('home');
  const [wines, setWines] = useState([]);
  const [selectedWineId, setSelectedWineId] = useState(null);
  const [adminView, setAdminView] = useState('list');
  const [form, setForm] = useState(createEmptyForm(0));
  const [mindTargetSrc, setMindTargetSrc] = useState(DEMO_MIND_TARGET_SRC);
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

  const sortedWines = useMemo(() => {
    return [...wines].sort((a, b) => {
      if (a.targetIndex !== b.targetIndex) {
        return a.targetIndex - b.targetIndex;
      }
      return a.title.localeCompare(b.title, 'ru');
    });
  }, [wines]);

  const nextTargetIndex = useMemo(() => {
    if (!wines.length) {
      return 0;
    }
    return wines.reduce((max, wine) => Math.max(max, wine.targetIndex), 0) + 1;
  }, [wines]);

  const selectedWine = useMemo(() => {
    return wines.find((wine) => wine.id === selectedWineId) || null;
  }, [wines, selectedWineId]);

  const selectedCropAsset = useMemo(() => {
    return normalizeLabelAssets(form.labelAssets).find((asset) => asset.id === cropEditor.assetId) || null;
  }, [form.labelAssets, cropEditor.assetId]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

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
        if (isApiEnabled()) {
          const [payload, manifestPayload] = await Promise.all([
            apiRequest('/wines'),
            fetch(`${API_BASE_URL}/targets/manifest`)
              .then((response) => (response.ok ? response.json() : null))
              .catch(() => null),
          ]);
          const loaded = normalizeWines(payload.wines || []);
          const hasCompiledTargets = Boolean(manifestPayload?.manifest?.ready);
          const targetCount = Number.parseInt(manifestPayload?.manifest?.targetCount, 10) || 0;
          const targetWineMap = Array.isArray(manifestPayload?.manifest?.targetWineMap)
            ? manifestPayload.manifest.targetWineMap
            : [];
          if (!active) {
            return;
          }
          setCompiledTargetsReady(hasCompiledTargets);
          setCompiledTargetCount(targetCount);
          setCompiledTargetWineMap(targetWineMap);
          setMindTargetSrc(`${API_BASE_URL}/targets/mind`);
          setWines(loaded);
          if (loaded[0]) {
            setSelectedWineId(loaded[0].id);
            setForm(getFormFromWine(loaded[0]));
          } else {
            setForm(createEmptyForm(0));
          }
          return;
        }

        setCompiledTargetsReady(false);
        setCompiledTargetCount(0);
        setCompiledTargetWineMap([]);
        setMindTargetSrc(DEMO_MIND_TARGET_SRC);
        const localData = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (localData) {
          const parsed = JSON.parse(localData);
          const restored = normalizeWines(parsed.wines);
          if (!active) {
            return;
          }
          setWines(restored);
          if (restored[0]) {
            setSelectedWineId(restored[0].id);
            setForm(getFormFromWine(restored[0]));
          } else {
            setForm(createEmptyForm(0));
          }
          return;
        }

        const response = await fetch(CONTENT_PATH);
        if (!response.ok) {
          throw new Error(`Не удалось загрузить ${CONTENT_PATH}`);
        }

        const payload = await response.json();
        const loaded = normalizeWines(payload.wines);

        if (!active) {
          return;
        }

        setWines(loaded);
        if (loaded[0]) {
          setSelectedWineId(loaded[0].id);
          setForm(getFormFromWine(loaded[0]));
        } else {
          setForm(createEmptyForm(0));
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
    const manifestIndexes = isApiEnabled() && compiledTargetsReady && compiledTargetCount > 0
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
      if (labelPollTimerRef.current) {
        window.clearTimeout(labelPollTimerRef.current);
      }
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
    const video = document.querySelector('video.mindar-video');
    if (!(video instanceof HTMLVideoElement) || video.videoWidth < 32 || video.videoHeight < 32) {
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

      const ocrPayload = await apiRequest('/api/recognize/ocr', {
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

      const visualPayload = await apiRequest('/api/recognize/visual', {
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
      setRecognitionPhase('NOT_FOUND');
      setRecognitionHint(error.message || 'Не удалось распознать этикетку.');
    }
  }

  async function handleStartScan() {
    try {
      setStartError('');
      setNotice({ text: '', type: '' });

      if (isApiEnabled()) {
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
        const cacheSuffix = manifest?.compiledAt ? `?v=${manifest.compiledAt}` : `?ts=${Date.now()}`;
        setMindTargetSrc(`${API_BASE_URL}/targets/mind${cacheSuffix}`);
      }

      setMode('scan');
      setScanFeedbackPhase('idle');
      setRecognitionPhase('TRY_MINDAR');
      setRecognitionHint('Наведи камеру на этикетку');
      clearFeedbackTimers();
      scanHandledRef.current = false;
      document.body.classList.add('is-scanning');
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      await startAr();

      if (isApiEnabled()) {
        fallbackTimerRef.current = window.setTimeout(() => {
          if (!scanHandledRef.current && modeRef.current === 'scan') {
            runFallbackRecognition();
          }
        }, MINDAR_TIMEOUT_MS);
      }
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

  function openAdmin() {
    stopAr();
    setMode('admin');
    setAdminView('list');
    setScanFeedbackPhase('idle');
    clearFeedbackTimers();
    scanHandledRef.current = false;
    document.body.classList.remove('is-scanning');

    if (!selectedWineId && wines[0]) {
      setSelectedWineId(wines[0].id);
      setForm(getFormFromWine(wines[0]));
    }

    if (!wines.length) {
      setForm(createEmptyForm(nextTargetIndex));
    }
  }

  function closeAdmin() {
    setMode('home');
    setNotice({ text: '', type: '' });
  }

  async function persistWines(nextWines) {
    if (isApiEnabled()) {
      await apiRequest('/wines', {
        method: 'PUT',
        body: JSON.stringify({ wines: nextWines }),
      });
      return;
    }

    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ wines: nextWines }));
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
    setForm(createEmptyForm(nextTargetIndex));
    setAdminView('create');
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
    setLabelProcess({
      jobId: null,
      status: selectedWine.labelImage ? 'ready' : 'idle',
      targetIndex: selectedWine.targetIndex,
      error: '',
    });
  }

  function handleBackToAdminList() {
    setAdminView('list');
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

  async function handleLabelImageUpload(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      return;
    }

    try {
      const builtAssets = [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const optimized = await optimizeLabelImage(file);
        const visualEmbedding = await computeVisualEmbeddingFromDataUrl(optimized.dataUrl);
        const quality = await assessLabelQuality(optimized.dataUrl);
        builtAssets.push({
          id: crypto.randomUUID(),
          role: '',
          dataUrl: optimized.dataUrl,
          qualityScore: quality.score,
          qualityStatus: quality.status,
          qualityNotes: quality.notes,
          visualEmbedding,
          meta: optimized,
        });
      }

      setForm((prev) => {
        const existing = normalizeLabelAssets(prev.labelAssets);
        const enriched = builtAssets.map((asset, index) => ({
          ...asset,
          role: pickNextRole([...existing, ...builtAssets.slice(0, index)], index),
        }));
        const labelAssets = [...existing, ...enriched];
        return {
          ...prev,
          ...deriveLabelFieldsFromAssets(labelAssets),
        };
      });

      setLabelProcess({
        jobId: null,
        status: 'idle',
        targetIndex: null,
        error: '',
      });

      const reducedCount = builtAssets.filter((asset) => asset.meta?.reduced).length;
      setNotice({
        text: `Добавлено фото: ${builtAssets.length}. Оптимизировано: ${reducedCount}.`,
        type: 'success',
      });
    } catch (error) {
      setNotice({ text: error.message || 'Не удалось подготовить файлы этикеток.', type: 'error' });
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

  function handleLabelRoleChange(assetId, role) {
    setForm((prev) => {
      const nextAssets = normalizeLabelAssets(prev.labelAssets).map((asset) => (
        asset.id === assetId ? { ...asset, role } : asset
      ));
      return { ...prev, ...deriveLabelFieldsFromAssets(nextAssets) };
    });
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
      return;
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
      setNotice({ text: `Кадрирование применено. Качество: ${quality.score}/100.`, type: 'success' });
    } catch (error) {
      setNotice({ text: error.message || 'Не удалось применить crop.', type: 'error' });
    }
  }

  async function pollLabelJob(jobId) {
    try {
      const payload = await apiRequest(`/labels/process/${jobId}`);
      const job = payload.job;

      if (job.status === 'ready') {
        setLabelProcess({
          jobId,
          status: 'ready',
          targetIndex: job.targetIndex,
          error: '',
        });
        setForm((prev) => ({ ...prev, targetIndex: String(job.targetIndex) }));
        setNotice({ text: 'Этикетка обработана. Активация скана обычно занимает до 5 минут.', type: 'success' });
        return;
      }

      if (job.status === 'error') {
        setLabelProcess({
          jobId,
          status: 'error',
          targetIndex: null,
          error: job.error || 'Ошибка обработки этикетки.',
        });
        setNotice({ text: job.error || 'Ошибка обработки этикетки.', type: 'error' });
        return;
      }

      labelPollTimerRef.current = window.setTimeout(() => {
        pollLabelJob(jobId);
      }, 1200);
    } catch (error) {
      setLabelProcess({
        jobId,
        status: 'error',
        targetIndex: null,
        error: error.message || 'Не удалось получить статус обработки.',
      });
      setNotice({ text: error.message || 'Не удалось получить статус обработки.', type: 'error' });
    }
  }

  async function handleProcessLabel() {
    if (!isApiEnabled()) {
      setNotice({ text: 'Обработка этикетки доступна только в API-режиме.', type: 'error' });
      return;
    }

    const assets = normalizeLabelAssets(form.labelAssets);
    const primary = pickPrimaryAsset(assets);
    const roles = new Set(assets.map((asset) => asset.role));
    const hasRequired = ['front', 'left', 'right'].every((role) => roles.has(role));

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
      if (labelPollTimerRef.current) {
        window.clearTimeout(labelPollTimerRef.current);
      }

      setLabelProcess({
        jobId: null,
        status: 'processing',
        targetIndex: null,
        error: '',
      });
      setNotice({ text: 'Обрабатываем фото этикетки для сканирования...', type: '' });

      const payload = await apiRequest('/labels/process', {
        method: 'POST',
        body: JSON.stringify({
          wineId: selectedWineId,
          labelImage: primary.dataUrl,
        }),
      });

      const jobId = payload?.job?.id;
      if (!jobId) {
        throw new Error('Не получили jobId обработки.');
      }

      setLabelProcess({
        jobId,
        status: 'processing',
        targetIndex: null,
        error: '',
      });
      pollLabelJob(jobId);
    } catch (error) {
      setLabelProcess({
        jobId: null,
        status: 'error',
        targetIndex: null,
        error: error.message || 'Не удалось запустить обработку.',
      });
      setNotice({ text: error.message || 'Не удалось запустить обработку.', type: 'error' });
    }
  }

  function normalizeFormWine() {
    const id = normalizeString(form.id);
    const targetIndex = Number.parseInt(form.targetIndex, 10);
    const title = normalizeString(form.title);
    const subtitle = normalizeString(form.subtitle);
    const producer = normalizeString(form.producer);
    const region = normalizeString(form.region);
    const year = normalizeString(form.year);
    const grapes = normalizeString(form.grapes);
    const description = normalizeString(form.description);
    const story = normalizeString(form.story);
    const serving = normalizeString(form.serving);
    const rating = Number.parseFloat(form.rating);

    if (!id) {
      throw new Error('Укажи уникальный ID вина.');
    }

    if (!Number.isInteger(targetIndex) || targetIndex < 0) {
      throw new Error('Target Index должен быть целым числом 0 или больше.');
    }

    if (!title || !subtitle || !story || !serving) {
      throw new Error('Заполни заголовок, подзаголовок, историю и подачу.');
    }

    if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
      throw new Error('Рейтинг должен быть числом от 0 до 5.');
    }

    if (isApiEnabled() && normalizeString(form.labelImage) && labelProcess.status !== 'ready') {
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
      pairings: parseTags(form.pairings),
      gallery: parseGallery(form.gallery),
    };
  }

  async function handleSaveWine(event) {
    event.preventDefault();

    try {
      const wine = normalizeFormWine();

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
        throw new Error('Этот Target Index уже занят другим вином.');
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
      setNotice({ text: 'Сохранено.', type: 'success' });
      await persistWines(nextWines);
    } catch (error) {
      setNotice({ text: error.message || 'Не удалось сохранить вино.', type: 'error' });
    }
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
      setForm(createEmptyForm(0));
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

  async function handleResetDemo() {
    const approved = window.confirm('Сбросить локальные изменения и вернуть demo-данные?');
    if (!approved) {
      return;
    }

    try {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
      const response = await fetch(CONTENT_PATH);
      if (!response.ok) {
        throw new Error('Не удалось загрузить demo-данные.');
      }

      const payload = await response.json();
      const restored = normalizeWines(payload.wines);
      await persistWines(restored);
      setWines(restored);

      if (restored[0]) {
        setSelectedWineId(restored[0].id);
        setForm(getFormFromWine(restored[0]));
      } else {
        setSelectedWineId(null);
        setForm(createEmptyForm(0));
      }

      setNotice({ text: 'Данные сброшены к demo-версии.', type: 'success' });
    } catch (error) {
      setNotice({ text: error.message || 'Сброс не выполнен.', type: 'error' });
    }
  }

  return (
    <>
      <a-scene
        ref={sceneRef}
        mindar-image={`imageTargetSrc: ${mindTargetSrc}; autoStart: false; uiScanning: no; uiLoading: no`}
        color-space="sRGB"
        renderer="colorManagement: true, physicallyCorrectLights, alpha: true"
        vr-mode-ui="enabled: false"
        device-orientation-permission-ui="enabled: false"
        className={`ar-scene ${mode === 'scan' ? '' : 'hidden'}`}
        style={{
          display: mode === 'scan' ? 'block' : 'none',
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
                {isApiEnabled() && !compiledTargetsReady && (
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
                <p className="eyebrow">{contentWine.subtitle}</p>
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

        {mode === 'admin' && (
          <section className="panel admin-panel">
            <div className="admin-header">
              <div>
                <p className="eyebrow">Content Manager</p>
                <h2>
                  {adminView === 'list' && 'Список вин'}
                  {adminView === 'detail' && 'Карточка вина'}
                  {adminView === 'edit' && 'Редактирование вина'}
                  {adminView === 'create' && 'Добавить новое вино'}
                </h2>
                <p className="lead">
                  Управляй карточками вин, рейтингами и контентом для AR.
                </p>
              </div>
              <button className="ghost-btn" onClick={closeAdmin}>
                К сканеру
              </button>
            </div>
            {adminView === 'list' && (
              <div className="admin-overview">
                <div className="admin-actions-row">
                  <button className="primary-btn" onClick={handleNewWine}>
                    Добавить новое вино
                  </button>
                  <button className="ghost-btn" type="button" onClick={handleDownloadJson}>
                    Скачать JSON
                  </button>
                  <button className="ghost-btn" type="button" onClick={handleResetDemo}>
                    Сбросить к demo
                  </button>
                </div>

                <div className="wine-grid">
                  {!sortedWines.length && <div className="empty-item">Пока нет вин. Добавь первое.</div>}
                  {sortedWines.map((wine) => (
                    <button key={wine.id} className="wine-card" onClick={() => handleSelectWine(wine)}>
                      <div className="wine-item-title">{wine.title || wine.id}</div>
                      <div className="wine-item-subtitle">{wine.subtitle || 'Без подзаголовка'}</div>
                      <div className="wine-item-meta">Рейтинг: {wine.rating.toFixed(1)} / 5</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {adminView === 'detail' && selectedWine && (
              <div className="admin-detail">
                <div className="detail-grid">
                  <p><strong>Название:</strong> {selectedWine.title}</p>
                  <p><strong>Регион:</strong> {selectedWine.subtitle}</p>
                  <p><strong>Производитель:</strong> {selectedWine.producer || '—'}</p>
                  <p><strong>Апелласьон/регион:</strong> {selectedWine.region || '—'}</p>
                  <p><strong>Год:</strong> {selectedWine.year || '—'}</p>
                  <p><strong>Сорта:</strong> {selectedWine.grapes || '—'}</p>
                  <p><strong>Рейтинг:</strong> {selectedWine.rating.toFixed(1)} / 5</p>
                  <p><strong>Target Index:</strong> {selectedWine.targetIndex}</p>
                  <p><strong>ID:</strong> {selectedWine.id}</p>
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
              <form className="admin-form" onSubmit={handleSaveWine}>
                <div className="form-grid">
                  <label className="field">
                    <span>ID вина</span>
                    <input name="id" value={form.id} onChange={handleFormChange} placeholder="wine-barolo-001" required />
                  </label>

                  <label className="field">
                    <span>Target Index</span>
                    <input
                      name="targetIndex"
                      type="number"
                      min="0"
                      step="1"
                      value={form.targetIndex}
                      onChange={handleFormChange}
                      required
                    />
                  </label>

                  <label className="field">
                    <span>Рейтинг (0-5)</span>
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
                    <span>Заголовок</span>
                    <input name="title" value={form.title} onChange={handleFormChange} required />
                  </label>

                  <label className="field field-wide">
                    <span>Подзаголовок</span>
                    <input name="subtitle" value={form.subtitle} onChange={handleFormChange} required />
                  </label>

                  <label className="field">
                    <span>Производитель</span>
                    <input name="producer" value={form.producer} onChange={handleFormChange} />
                  </label>

                  <label className="field">
                    <span>Регион</span>
                    <input name="region" value={form.region} onChange={handleFormChange} />
                  </label>

                  <label className="field">
                    <span>Год</span>
                    <input name="year" value={form.year} onChange={handleFormChange} placeholder="2021" />
                  </label>

                  <label className="field">
                    <span>Сорт(а)</span>
                    <input name="grapes" value={form.grapes} onChange={handleFormChange} />
                  </label>

                  <label className="field field-wide">
                    <span>Описание</span>
                    <textarea name="description" rows="3" value={form.description} onChange={handleFormChange} />
                  </label>

                  <label className="field field-wide">
                    <span>История</span>
                    <textarea name="story" rows="4" value={form.story} onChange={handleFormChange} required />
                  </label>

                  <label className="field field-wide">
                    <span>Подача</span>
                    <textarea name="serving" rows="3" value={form.serving} onChange={handleFormChange} required />
                  </label>

                  <div className="field field-wide">
                    <span>Этикетки (front/left/right обязательны)</span>
                    <div className="label-upload-row">
                      <input type="file" accept="image/*" multiple onChange={handleLabelImageUpload} />
                      <button className="primary-btn" type="button" onClick={handleProcessLabel}>
                        Обработать этикетку
                      </button>
                      {!!form.labelAssets?.length && (
                        <button className="ghost-btn" type="button" onClick={handleClearLabelImage}>
                          Убрать все
                        </button>
                      )}
                    </div>
                    {!!form.labelAssets?.length && (
                      <div className="wine-grid">
                        {form.labelAssets.map((asset) => (
                          <div key={asset.id} className="wine-card">
                            <div className="field">
                              <span>Роль</span>
                              <select
                                value={asset.role}
                                onChange={(event) => handleLabelRoleChange(asset.id, event.target.value)}
                              >
                                {LABEL_ROLES.map((role) => (
                                  <option key={role} value={role}>{role}</option>
                                ))}
                              </select>
                            </div>
                            <img className="label-preview" src={asset.dataUrl} alt={`Этикетка ${asset.role}`} />
                            <p className="field-note">
                              {asset.qualityStatus === 'good' && `✅ ${asset.qualityScore}/100`}
                              {asset.qualityStatus === 'medium' && `⚠️ ${asset.qualityScore}/100`}
                              {asset.qualityStatus === 'bad' && `❌ ${asset.qualityScore}/100`}
                              {asset.qualityStatus === 'unknown' && '—'}
                            </p>
                            <div className="actions-row">
                              <button className="ghost-btn" type="button" onClick={() => openCropEditor(asset.id)}>
                                Crop
                              </button>
                              <button className="ghost-btn" type="button" onClick={() => handleRemoveLabelAsset(asset.id)}>
                                Удалить
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {selectedCropAsset && (
                      <div className="detail-grid">
                        <p className="detail-wide"><strong>Crop editor:</strong> {selectedCropAsset.role}</p>
                        <label className="field detail-wide">
                          <span>X (%)</span>
                          <input
                            type="range"
                            min="0"
                            max="95"
                            value={cropEditor.x}
                            onChange={(event) => setCropEditor((prev) => ({ ...prev, x: Number(event.target.value) }))}
                          />
                        </label>
                        <label className="field detail-wide">
                          <span>Y (%)</span>
                          <input
                            type="range"
                            min="0"
                            max="95"
                            value={cropEditor.y}
                            onChange={(event) => setCropEditor((prev) => ({ ...prev, y: Number(event.target.value) }))}
                          />
                        </label>
                        <label className="field detail-wide">
                          <span>Width (%)</span>
                          <input
                            type="range"
                            min="5"
                            max={100 - cropEditor.x}
                            value={cropEditor.width}
                            onChange={(event) => setCropEditor((prev) => ({ ...prev, width: Number(event.target.value) }))}
                          />
                        </label>
                        <label className="field detail-wide">
                          <span>Height (%)</span>
                          <input
                            type="range"
                            min="5"
                            max={100 - cropEditor.y}
                            value={cropEditor.height}
                            onChange={(event) => setCropEditor((prev) => ({ ...prev, height: Number(event.target.value) }))}
                          />
                        </label>
                        <div className="actions-row">
                          <button className="primary-btn" type="button" onClick={applyCropToAsset}>
                            Применить crop
                          </button>
                          <button
                            className="ghost-btn"
                            type="button"
                            onClick={() => setCropEditor({ assetId: '', x: 0, y: 0, width: 100, height: 100 })}
                          >
                            Закрыть
                          </button>
                        </div>
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
                        {labelProcess.status === 'ready' &&
                          `Готово. Назначен targetIndex: ${labelProcess.targetIndex}.`}
                        {labelProcess.status === 'error' &&
                          `Ошибка: ${labelProcess.error || 'Не удалось обработать.'}`}
                      </p>
                    )}
                    <p className="field-note">
                      Для текущей сборки target используется роль `front`, но visual fallback использует все загруженные ракурсы.
                    </p>
                  </div>

                  <label className="field field-wide">
                    <span>Pairings (запятая или новая строка)</span>
                    <textarea name="pairings" rows="3" value={form.pairings} onChange={handleFormChange} />
                  </label>

                  <label className="field field-wide">
                    <span>Gallery URLs (одна ссылка в строке)</span>
                    <textarea name="gallery" rows="4" value={form.gallery} onChange={handleFormChange} />
                  </label>
                </div>

                <p className={`notice ${notice.type ? `is-${notice.type}` : ''}`}>{notice.text}</p>

                <div className="actions-row">
                  <button className="primary-btn" type="submit">
                    Сохранить
                  </button>
                  {adminView === 'edit' && (
                    <button className="ghost-btn" type="button" onClick={handleDeleteWine}>
                      Удалить
                    </button>
                  )}
                  <button className="ghost-btn" type="button" onClick={handleBackToAdminList}>
                    Назад к списку
                  </button>
                </div>
              </form>
            )}
          </section>
        )}
      </main>
    </>
  );
}
