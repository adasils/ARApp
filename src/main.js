const CONTENT_PATH = './data/wines.json';
const LOCAL_STORAGE_KEY = 'wine-label-admin-data-v1';

const ui = {
  arScene: document.getElementById('arScene'),
  targetsRoot: document.getElementById('targetsRoot'),
  startPanel: document.getElementById('startPanel'),
  startScanButton: document.getElementById('startScanButton'),
  openAdminButton: document.getElementById('openAdminButton'),
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
  adminPanel: document.getElementById('adminPanel'),
  closeAdminButton: document.getElementById('closeAdminButton'),
  newWineButton: document.getElementById('newWineButton'),
  wineAdminList: document.getElementById('wineAdminList'),
  wineForm: document.getElementById('wineForm'),
  wineIdInput: document.getElementById('wineIdInput'),
  wineTargetInput: document.getElementById('wineTargetInput'),
  wineTitleInput: document.getElementById('wineTitleInput'),
  wineSubtitleInput: document.getElementById('wineSubtitleInput'),
  wineStoryInput: document.getElementById('wineStoryInput'),
  wineServingInput: document.getElementById('wineServingInput'),
  winePairingsInput: document.getElementById('winePairingsInput'),
  wineGalleryInput: document.getElementById('wineGalleryInput'),
  adminNotice: document.getElementById('adminNotice'),
  deleteWineButton: document.getElementById('deleteWineButton'),
  downloadJsonButton: document.getElementById('downloadJsonButton'),
  resetDataButton: document.getElementById('resetDataButton'),
};

let wines = [];
let scanHandled = false;
let arStarted = false;
let viewportSyncBound = false;
let editingWineId = null;

const LABEL_FRAME = {
  width: 0.68,
  height: 1.02,
  sweepStartY: 0.78,
  sweepEndY: -0.78,
  sweepDuration: 1100,
};

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

function getMindArSystem() {
  return ui.arScene.systems['mindar-image-system'];
}

function toStringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toArrayValue(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function normalizeWine(wine, fallbackIndex) {
  const targetIndex = Number.parseInt(wine?.targetIndex, 10);
  return {
    id: toStringValue(wine?.id) || `wine-${fallbackIndex + 1}`,
    targetIndex: Number.isInteger(targetIndex) && targetIndex >= 0
      ? targetIndex
      : fallbackIndex,
    title: toStringValue(wine?.title),
    subtitle: toStringValue(wine?.subtitle),
    story: toStringValue(wine?.story),
    serving: toStringValue(wine?.serving),
    pairings: toArrayValue(wine?.pairings),
    gallery: toArrayValue(wine?.gallery),
  };
}

function normalizeWines(items) {
  return (items || []).map((wine, index) => normalizeWine(wine, index));
}

async function loadRemoteContent() {
  const response = await fetch(CONTENT_PATH);
  if (!response.ok) {
    throw new Error(`Не удалось загрузить ${CONTENT_PATH}`);
  }

  const payload = await response.json();
  return normalizeWines(payload.wines);
}

async function loadContent() {
  const localData = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (localData) {
    try {
      const parsed = JSON.parse(localData);
      return normalizeWines(parsed.wines);
    } catch (error) {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
    }
  }

  return loadRemoteContent();
}

function saveContentToStorage() {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ wines }));
}

function getWineByTargetIndex(index) {
  const targetIndex = Number.parseInt(index, 10);
  return wines.find((wine) => wine.targetIndex === targetIndex) || null;
}

function createLabelFrameMarkup() {
  return `
    <a-entity
      class="label-outline"
      visible="false"
      position="0 0 0.01"
      scale="${LABEL_FRAME.width} ${LABEL_FRAME.height} 1"
    >
      <a-plane
        width="1"
        height="1"
        material="shader: flat; color: #dcefff; opacity: 0.06; transparent: true; side: double"
      ></a-plane>

      <a-plane
        width="1.08"
        height="0.03"
        position="0 0.515 -0.001"
        material="shader: flat; color: #c6e9ff; opacity: 0.2; transparent: true"
        animation__glowtop="property: material.opacity; from: 0.12; to: 0.28; dir: alternate; dur: 420; loop: true"
      ></a-plane>
      <a-plane
        width="1.08"
        height="0.03"
        position="0 -0.515 -0.001"
        material="shader: flat; color: #c6e9ff; opacity: 0.2; transparent: true"
        animation__glowbottom="property: material.opacity; from: 0.12; to: 0.28; dir: alternate; dur: 420; loop: true"
      ></a-plane>
      <a-plane
        width="0.03"
        height="1.08"
        position="-0.515 0 -0.001"
        material="shader: flat; color: #c6e9ff; opacity: 0.2; transparent: true"
        animation__glowleft="property: material.opacity; from: 0.12; to: 0.28; dir: alternate; dur: 420; loop: true"
      ></a-plane>
      <a-plane
        width="0.03"
        height="1.08"
        position="0.515 0 -0.001"
        material="shader: flat; color: #c6e9ff; opacity: 0.2; transparent: true"
        animation__glowright="property: material.opacity; from: 0.12; to: 0.28; dir: alternate; dur: 420; loop: true"
      ></a-plane>

      <a-plane
        width="1.01"
        height="0.008"
        position="0 0.5 0"
        material="shader: flat; color: #ffffff; opacity: 0.95; transparent: true"
      ></a-plane>
      <a-plane
        width="1.01"
        height="0.008"
        position="0 -0.5 0"
        material="shader: flat; color: #ffffff; opacity: 0.95; transparent: true"
      ></a-plane>
      <a-plane
        width="0.008"
        height="1.01"
        position="-0.5 0 0"
        material="shader: flat; color: #ffffff; opacity: 0.95; transparent: true"
      ></a-plane>
      <a-plane
        width="0.008"
        height="1.01"
        position="0.5 0 0"
        material="shader: flat; color: #ffffff; opacity: 0.95; transparent: true"
      ></a-plane>

      <a-entity
        class="label-sweep-track"
        position="0 ${LABEL_FRAME.sweepStartY} 0.002"
        animation__sweep="property: position; from: 0 ${LABEL_FRAME.sweepStartY} 0.002; to: 0 ${LABEL_FRAME.sweepEndY} 0.002; dur: ${LABEL_FRAME.sweepDuration}; loop: true; easing: linear"
      >
        <a-plane
          width="0.92"
          height="0.78"
          material="shader: flat; src: #sweepGradient; transparent: true; opacity: 0.95; side: double"
        ></a-plane>
      </a-entity>
    </a-entity>
  `;
}

function hideAllTargetFrames() {
  ui.targetsRoot
    .querySelectorAll('.label-outline')
    .forEach((frame) => frame.setAttribute('visible', 'false'));
}

function showTargetFrame(targetIndex) {
  const target = ui.targetsRoot.querySelector(
    `[data-target-index="${targetIndex}"]`
  );
  if (!target) {
    return;
  }

  const frame = target.querySelector('.label-outline');
  if (frame) {
    frame.setAttribute('visible', 'true');
  }
}

function createTargetEntities() {
  ui.targetsRoot.innerHTML = '';

  const uniqueTargetIndices = [
    ...new Set(
      wines
        .map((wine) => Number.parseInt(wine.targetIndex, 10))
        .filter((index) => Number.isInteger(index) && index >= 0)
    ),
  ].sort((a, b) => a - b);

  if (uniqueTargetIndices.length === 0) {
    uniqueTargetIndices.push(0);
  }

  uniqueTargetIndices.forEach((targetIndex) => {
    const target = document.createElement('a-entity');
    target.dataset.targetIndex = String(targetIndex);
    target.setAttribute('mindar-image-target', `targetIndex: ${targetIndex}`);
    target.innerHTML = createLabelFrameMarkup();
    target.addEventListener('targetFound', () => {
      onTargetFound(targetIndex);
    });
    target.addEventListener('targetLost', () => {
      if (!scanHandled) {
        hideAllTargetFrames();
      }
    });
    ui.targetsRoot.appendChild(target);
  });
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

  hideAllTargetFrames();
  document.body.classList.remove('is-scanning');
  ui.arScene.classList.add('hidden');
}

function resetUiForScan() {
  scanHandled = false;
  hideAllTargetFrames();
  document.body.classList.add('is-scanning');
  ui.startPanel.classList.add('hidden');
  ui.adminPanel.classList.add('hidden');
  ui.contentPanel.classList.remove('reveal');
  ui.contentPanel.classList.add('hidden');
  ui.successOverlay.classList.add('hidden');
  ui.scanHud.classList.remove('hidden');
}

function showError(message) {
  document.body.classList.remove('is-scanning');
  ui.startPanel.classList.remove('hidden');
  ui.adminPanel.classList.add('hidden');
  ui.contentPanel.classList.remove('reveal');
  ui.scanHud.classList.add('hidden');
  ui.contentPanel.classList.add('hidden');
  ui.successOverlay.classList.add('hidden');

  let errorLine = document.getElementById('startErrorLine');
  if (!errorLine) {
    errorLine = document.createElement('p');
    errorLine.id = 'startErrorLine';
    errorLine.className = 'lead';
    ui.startPanel.appendChild(errorLine);
  }

  errorLine.textContent = message;
}

function clearStartError() {
  const errorLine = document.getElementById('startErrorLine');
  if (errorLine) {
    errorLine.remove();
  }
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

async function onTargetFound(targetIndex) {
  if (scanHandled) {
    return;
  }

  const wine = getWineByTargetIndex(targetIndex);
  if (!wine) {
    return;
  }

  scanHandled = true;
  showTargetFrame(targetIndex);
  renderContent(wine);

  window.setTimeout(() => {
    ui.scanHud.classList.add('hidden');
    ui.successOverlay.classList.remove('hidden');
  }, 180);

  window.setTimeout(async () => {
    ui.successOverlay.classList.add('hidden');
    revealContentPanel();
    await stopAr();
  }, SUCCESS_MS + 180);
}

function parsePairingsInput(value) {
  return String(value || '')
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseGalleryInput(value) {
  return String(value || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getNextTargetIndex() {
  if (!wines.length) {
    return 0;
  }

  return wines.reduce((max, wine) => Math.max(max, wine.targetIndex), 0) + 1;
}

function showAdminNotice(message, type = '') {
  ui.adminNotice.textContent = message || '';
  ui.adminNotice.classList.remove('is-error', 'is-success');

  if (type === 'error') {
    ui.adminNotice.classList.add('is-error');
  }

  if (type === 'success') {
    ui.adminNotice.classList.add('is-success');
  }
}

function renderAdminList() {
  ui.wineAdminList.innerHTML = '';

  if (!wines.length) {
    const emptyState = document.createElement('div');
    emptyState.className = 'admin-empty';
    emptyState.textContent = 'Пока нет вин. Создай первую карточку.';
    ui.wineAdminList.appendChild(emptyState);
    return;
  }

  wines.forEach((wine) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'admin-item';

    if (wine.id === editingWineId) {
      item.classList.add('is-active');
    }

    item.innerHTML = `
      <div class="admin-item-title">${wine.title || wine.id}</div>
      <div class="admin-item-subtitle">${wine.subtitle || 'Без подзаголовка'}</div>
      <div class="admin-item-meta">targetIndex: ${wine.targetIndex}</div>
    `;

    item.addEventListener('click', () => {
      openWineForEdit(wine.id);
    });

    ui.wineAdminList.appendChild(item);
  });
}

function fillWineForm(wine) {
  ui.wineIdInput.value = wine.id;
  ui.wineTargetInput.value = String(wine.targetIndex);
  ui.wineTitleInput.value = wine.title;
  ui.wineSubtitleInput.value = wine.subtitle;
  ui.wineStoryInput.value = wine.story;
  ui.wineServingInput.value = wine.serving;
  ui.winePairingsInput.value = wine.pairings.join('\n');
  ui.wineGalleryInput.value = wine.gallery.join('\n');
}

function openWineForEdit(wineId) {
  const wine = wines.find((item) => item.id === wineId);
  if (!wine) {
    return;
  }

  editingWineId = wine.id;
  fillWineForm(wine);
  renderAdminList();
}

function resetFormForNewWine() {
  editingWineId = null;
  ui.wineForm.reset();
  ui.wineTargetInput.value = String(getNextTargetIndex());
  showAdminNotice('Новая карточка: заполни поля и нажми «Сохранить».');
  renderAdminList();
}

function collectWineFromForm() {
  const id = toStringValue(ui.wineIdInput.value);
  const targetIndex = Number.parseInt(ui.wineTargetInput.value, 10);
  const title = toStringValue(ui.wineTitleInput.value);
  const subtitle = toStringValue(ui.wineSubtitleInput.value);
  const story = toStringValue(ui.wineStoryInput.value);
  const serving = toStringValue(ui.wineServingInput.value);

  if (!id) {
    throw new Error('Укажи ID вина.');
  }

  if (!Number.isInteger(targetIndex) || targetIndex < 0) {
    throw new Error('Target Index должен быть целым числом 0 или больше.');
  }

  if (!title || !subtitle || !story || !serving) {
    throw new Error('Заполни заголовок, подзаголовок, историю и подачу.');
  }

  return {
    id,
    targetIndex,
    title,
    subtitle,
    story,
    serving,
    pairings: parsePairingsInput(ui.winePairingsInput.value),
    gallery: parseGalleryInput(ui.wineGalleryInput.value),
  };
}

function upsertWine(wine) {
  const existingIndex = wines.findIndex((item) => item.id === editingWineId);

  if (existingIndex === -1) {
    wines.push(wine);
  } else {
    wines[existingIndex] = wine;
  }

  wines.sort((a, b) => {
    if (a.targetIndex !== b.targetIndex) {
      return a.targetIndex - b.targetIndex;
    }
    return a.title.localeCompare(b.title, 'ru');
  });
}

function downloadJson() {
  const payload = JSON.stringify({ wines }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'wines.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function openAdminPanel() {
  await stopAr();
  scanHandled = false;
  document.body.classList.remove('is-scanning');

  ui.scanHud.classList.add('hidden');
  ui.successOverlay.classList.add('hidden');
  ui.contentPanel.classList.add('hidden');
  ui.startPanel.classList.add('hidden');
  ui.adminPanel.classList.remove('hidden');

  if (editingWineId) {
    openWineForEdit(editingWineId);
  } else if (wines.length > 0) {
    openWineForEdit(wines[0].id);
  } else {
    resetFormForNewWine();
  }
}

function closeAdminPanel() {
  ui.adminPanel.classList.add('hidden');
  ui.scanHud.classList.add('hidden');
  ui.successOverlay.classList.add('hidden');
  ui.contentPanel.classList.add('hidden');
  ui.startPanel.classList.remove('hidden');
  showAdminNotice('');
}

function attachEvents() {
  ui.startScanButton.addEventListener('click', async () => {
    try {
      clearStartError();
      resetUiForScan();
      await startAr();
    } catch (error) {
      showError(error.message || 'Проверь доступ к камере и попробуй снова.');
    }
  });

  ui.rescanButton.addEventListener('click', async () => {
    try {
      clearStartError();
      resetUiForScan();
      await startAr();
    } catch (error) {
      showError(error.message || 'Проверь доступ к камере и попробуй снова.');
    }
  });

  ui.openAdminButton.addEventListener('click', async () => {
    await openAdminPanel();
  });

  ui.closeAdminButton.addEventListener('click', () => {
    closeAdminPanel();
  });

  ui.newWineButton.addEventListener('click', () => {
    resetFormForNewWine();
  });

  ui.wineForm.addEventListener('submit', (event) => {
    event.preventDefault();

    try {
      const draftWine = collectWineFromForm();

      const hasDuplicateId = wines.some(
        (wine) => wine.id === draftWine.id && wine.id !== editingWineId
      );
      if (hasDuplicateId) {
        throw new Error('Вино с таким ID уже существует.');
      }

      upsertWine(draftWine);
      editingWineId = draftWine.id;
      saveContentToStorage();
      createTargetEntities();
      renderAdminList();
      openWineForEdit(editingWineId);
      showAdminNotice('Сохранено.', 'success');
    } catch (error) {
      showAdminNotice(error.message || 'Не удалось сохранить карточку.', 'error');
    }
  });

  ui.deleteWineButton.addEventListener('click', () => {
    if (!editingWineId) {
      showAdminNotice('Сначала выбери вино для удаления.', 'error');
      return;
    }

    const prevLength = wines.length;
    wines = wines.filter((wine) => wine.id !== editingWineId);

    if (wines.length === prevLength) {
      showAdminNotice('Карточка не найдена.', 'error');
      return;
    }

    saveContentToStorage();
    createTargetEntities();

    if (wines.length > 0) {
      openWineForEdit(wines[0].id);
    } else {
      resetFormForNewWine();
    }

    renderAdminList();
    showAdminNotice('Карточка удалена.', 'success');
  });

  ui.downloadJsonButton.addEventListener('click', () => {
    downloadJson();
    showAdminNotice('JSON выгружен.', 'success');
  });

  ui.resetDataButton.addEventListener('click', async () => {
    const approved = window.confirm(
      'Сбросить локальные изменения и загрузить demo-данные?'
    );

    if (!approved) {
      return;
    }

    try {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
      wines = await loadRemoteContent();
      editingWineId = wines[0] ? wines[0].id : null;
      createTargetEntities();
      renderAdminList();

      if (editingWineId) {
        openWineForEdit(editingWineId);
      } else {
        resetFormForNewWine();
      }

      showAdminNotice('Данные сброшены к demo-версии.', 'success');
    } catch (error) {
      showAdminNotice(error.message || 'Не удалось выполнить сброс.', 'error');
    }
  });
}

async function bootstrap() {
  try {
    ensureCameraLayout();
    wines = await loadContent();
    createTargetEntities();

    if (wines.length > 0) {
      editingWineId = wines[0].id;
      openWineForEdit(editingWineId);
    } else {
      resetFormForNewWine();
    }

    attachEvents();
  } catch (error) {
    showError(error.message || 'Ошибка загрузки данных.');
  }
}

bootstrap();
