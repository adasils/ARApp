const CONTENT_PATH = './data/wines.json';
const TARGET_TO_WINE = {
  0: 'wine-demo-001',
};

const ui = {
  arScene: document.getElementById('arScene'),
  targetEntity: document.getElementById('targetEntity'),
  labelOutline: document.getElementById('labelOutline'),
  labelSweepTrack: document.getElementById('labelSweepTrack'),
  startPanel: document.getElementById('startPanel'),
  startScanButton: document.getElementById('startScanButton'),
  scanHud: document.getElementById('scanHud'),
  successOverlay: document.getElementById('successOverlay'),
  contentPanel: document.getElementById('contentPanel'),
  wineSubtitle: document.getElementById('wineSubtitle'),
  wineTitle: document.getElementById('wineTitle'),
  wineStory: document.getElementById('wineStory'),
  wineServing: document.getElementById('wineServing'),
  pairings: document.getElementById('pairings'),
  gallery: document.getElementById('gallery'),
  rescanButton: document.getElementById('rescanButton'),
};

let wines = [];
let scanHandled = false;
let arStarted = false;
let viewportSyncBound = false;
const LABEL_FRAME = {
  width: 0.68,
  height: 1.02,
  sweepAngle: -24,
  sweepOffsetX: 0.78,
  sweepOffsetY: 0.66,
  sweepDuration: 980,
};
const OUTLINE_MS = 700;
const SUCCESS_MS = 1300;

function syncViewportHeight() {
  document.documentElement.style.setProperty(
    '--app-height',
    `${window.innerHeight}px`
  );
}

function applyCameraFullscreenStyles() {
  const video = document.querySelector('video.mindar-video');
  if (video) {
    video.style.position = 'fixed';
    video.style.top = '0';
    video.style.left = '0';
    video.style.width = '100vw';
    video.style.height = 'var(--app-height)';
    video.style.objectFit = 'cover';
    video.style.zIndex = '0';
    video.style.maxWidth = 'none';
    video.style.maxHeight = 'none';
  }

  const overlay = document.querySelector('div.mindar-ui-overlay');
  if (overlay) {
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.width = '100vw';
    overlay.style.height = 'var(--app-height)';
  }
}

function ensureCameraLayout() {
  syncViewportHeight();
  applyCameraFullscreenStyles();

  if (!viewportSyncBound) {
    viewportSyncBound = true;
    window.addEventListener('resize', () => {
      syncViewportHeight();
      applyCameraFullscreenStyles();
    });
  }
}

function waitForSceneLoaded() {
  if (ui.arScene.hasLoaded) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    ui.arScene.addEventListener('loaded', resolve, { once: true });
  });
}

async function loadContent() {
  const response = await fetch(CONTENT_PATH);
  if (!response.ok) {
    throw new Error(`Не удалось загрузить ${CONTENT_PATH}`);
  }
  const payload = await response.json();
  wines = payload.wines || [];
}

function getWineByTargetIndex(index) {
  const wineId = TARGET_TO_WINE[index];
  return wines.find((wine) => wine.id === wineId) || null;
}

function getMindArSystem() {
  return ui.arScene.systems['mindar-image-system'];
}

function pickPositive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function pickNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function applyOutlineSize() {
  const width =
    pickPositive(LABEL_FRAME.width, 0.68);
  const height =
    pickPositive(LABEL_FRAME.height, 1.02);
  const sweepAngle =
    pickNumber(LABEL_FRAME.sweepAngle, -24);
  const sweepOffsetX =
    pickPositive(LABEL_FRAME.sweepOffsetX, 0.78);
  const sweepOffsetY =
    pickPositive(LABEL_FRAME.sweepOffsetY, 0.66);
  const sweepDuration =
    pickPositive(LABEL_FRAME.sweepDuration, 980);

  ui.labelOutline.setAttribute('scale', `${width} ${height} 1`);
  ui.labelSweepTrack.setAttribute('rotation', `0 0 ${sweepAngle}`);
  ui.labelSweepTrack.setAttribute(
    'animation__sweep',
    `property: position; from: -${sweepOffsetX} -${sweepOffsetY} 0.002; to: ${sweepOffsetX} ${sweepOffsetY} 0.002; dur: ${sweepDuration}; dir: alternate; loop: true; easing: easeInOutSine`
  );
}

function showOutline() {
  applyOutlineSize();
  ui.labelOutline.setAttribute('visible', true);
}

function hideOutline() {
  ui.labelOutline.setAttribute('visible', false);
}

async function startAr() {
  await waitForSceneLoaded();
  ui.arScene.classList.remove('hidden');
  const system = getMindArSystem();

  if (!system) {
    throw new Error('AR система не инициализирована. Обнови страницу.');
  }

  if (!arStarted) {
    await system.start();
    arStarted = true;
  }

  ensureCameraLayout();
}

async function stopAr() {
  const system = getMindArSystem();
  if (system && arStarted) {
    await system.stop();
    arStarted = false;
  }
  hideOutline();
  document.body.classList.remove('is-scanning');
  ui.arScene.classList.add('hidden');
}

function resetUiForScan() {
  scanHandled = false;
  hideOutline();
  document.body.classList.add('is-scanning');
  ui.startPanel.classList.add('hidden');
  ui.contentPanel.classList.remove('reveal');
  ui.contentPanel.classList.add('hidden');
  ui.successOverlay.classList.add('hidden');
  ui.scanHud.classList.remove('hidden');
}

function showError(message) {
  document.body.classList.remove('is-scanning');
  ui.startPanel.classList.remove('hidden');
  ui.contentPanel.classList.remove('reveal');
  ui.scanHud.classList.add('hidden');
  ui.contentPanel.classList.add('hidden');
  ui.successOverlay.classList.add('hidden');
  ui.startPanel.innerHTML = `
    <p class="eyebrow">Ошибка</p>
    <h1>Не удалось запустить сканирование</h1>
    <p class="lead">${message}</p>
    <button class="primary-btn" id="retryButton">Попробовать снова</button>
  `;

  const retryButton = document.getElementById('retryButton');
  retryButton.addEventListener('click', () => {
    window.location.reload();
  });
}

function renderContent(wine) {
  ui.wineSubtitle.textContent = wine.subtitle;
  ui.wineTitle.textContent = wine.title;
  ui.wineStory.textContent = wine.story;
  ui.wineServing.textContent = wine.serving;

  ui.pairings.innerHTML = '';
  (wine.pairings || []).forEach((item) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = item;
    ui.pairings.appendChild(chip);
  });

  ui.gallery.innerHTML = '';
  (wine.gallery || []).forEach((imageUrl) => {
    const image = document.createElement('img');
    image.className = 'gallery-image';
    image.src = imageUrl;
    image.alt = wine.title;
    image.loading = 'lazy';
    ui.gallery.appendChild(image);
  });
}

function revealContentPanel() {
  ui.contentPanel.classList.remove('hidden');
  ui.contentPanel.classList.remove('reveal');
  void ui.contentPanel.offsetWidth;
  ui.contentPanel.classList.add('reveal');
}

async function onTargetFound() {
  if (scanHandled) {
    return;
  }
  scanHandled = true;

  const indexAttr = ui.targetEntity.getAttribute('mindar-image-target');
  const wine = getWineByTargetIndex(Number(indexAttr.targetIndex));
  if (!wine) {
    return;
  }

  showOutline();
  renderContent(wine);

  window.setTimeout(() => {
    ui.scanHud.classList.add('hidden');
    ui.successOverlay.classList.remove('hidden');
  }, OUTLINE_MS);

  window.setTimeout(async () => {
    hideOutline();
    ui.successOverlay.classList.add('hidden');
    revealContentPanel();
    await stopAr();
  }, OUTLINE_MS + SUCCESS_MS);
}

function attachEvents() {
  ui.startScanButton.addEventListener('click', async () => {
    try {
      resetUiForScan();
      await startAr();
    } catch (error) {
      showError(error.message || 'Проверь доступ к камере и попробуй снова.');
    }
  });

  ui.targetEntity.addEventListener('targetFound', onTargetFound);
  ui.targetEntity.addEventListener('targetLost', () => {
    if (!scanHandled) {
      hideOutline();
    }
  });

  ui.rescanButton.addEventListener('click', async () => {
    try {
      resetUiForScan();
      await startAr();
    } catch (error) {
      showError(error.message || 'Проверь доступ к камере и попробуй снова.');
    }
  });
}

async function bootstrap() {
  try {
    ensureCameraLayout();
    await loadContent();
    attachEvents();
  } catch (error) {
    showError(error.message || 'Ошибка загрузки данных.');
  }
}

bootstrap();
