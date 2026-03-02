import { useEffect, useMemo, useRef, useState } from 'react';

const CONTENT_PATH = `${import.meta.env.BASE_URL}data/wines.json`;
const LOCAL_STORAGE_KEY = 'wine-label-admin-data-v2';
const SUCCESS_MS = 1300;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeWine(wine, fallbackIndex) {
  const targetIndex = Number.parseInt(wine?.targetIndex, 10);
  return {
    id: normalizeString(wine?.id) || `wine-${fallbackIndex + 1}`,
    targetIndex: Number.isInteger(targetIndex) && targetIndex >= 0
      ? targetIndex
      : fallbackIndex,
    title: normalizeString(wine?.title),
    subtitle: normalizeString(wine?.subtitle),
    story: normalizeString(wine?.story),
    serving: normalizeString(wine?.serving),
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

function getFormFromWine(wine) {
  return {
    id: wine?.id || '',
    targetIndex: wine ? String(wine.targetIndex) : '0',
    title: wine?.title || '',
    subtitle: wine?.subtitle || '',
    story: wine?.story || '',
    serving: wine?.serving || '',
    pairings: wine?.pairings?.join('\n') || '',
    gallery: wine?.gallery?.join('\n') || '',
  };
}

function createEmptyForm(nextIndex = 0) {
  return {
    id: '',
    targetIndex: String(nextIndex),
    title: '',
    subtitle: '',
    story: '',
    serving: '',
    pairings: '',
    gallery: '',
  };
}

export default function App() {
  const sceneRef = useRef(null);
  const targetsRootRef = useRef(null);
  const arStartedRef = useRef(false);
  const scanHandledRef = useRef(false);
  const modeRef = useRef('home');

  const [mode, setMode] = useState('home');
  const [wines, setWines] = useState([]);
  const [selectedWineId, setSelectedWineId] = useState(null);
  const [form, setForm] = useState(createEmptyForm(0));
  const [contentWine, setContentWine] = useState(null);
  const [isSuccessShown, setIsSuccessShown] = useState(false);
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

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);

    const onResize = () => {
      document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
      applyCameraStyles();
    };

    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
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

    const targetIndexes = [...new Set(wines.map((wine) => wine.targetIndex))].sort(
      (a, b) => a - b
    );

    const indexes = targetIndexes.length ? targetIndexes : [0];

    const cleanup = [];

    indexes.forEach((targetIndex) => {
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
  }, [wines]);

  useEffect(() => {
    return () => {
      stopAr();
    };
  }, []);

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

  async function handleStartScan() {
    try {
      setStartError('');
      setNotice({ text: '', type: '' });
      setMode('scan');
      setIsSuccessShown(false);
      scanHandledRef.current = false;
      document.body.classList.add('is-scanning');
      await startAr();
    } catch (error) {
      setMode('home');
      setStartError(error.message || 'Проверь доступ к камере и попробуй снова.');
    }
  }

  async function handleStopScan() {
    await stopAr();
    setMode('home');
    setIsSuccessShown(false);
    scanHandledRef.current = false;
  }

  async function handleTargetFound(targetIndex) {
    if (scanHandledRef.current || modeRef.current !== 'scan') {
      return;
    }

    const wine = wines.find((item) => item.targetIndex === targetIndex);
    if (!wine) {
      return;
    }

    scanHandledRef.current = true;
    setIsSuccessShown(true);

    window.setTimeout(async () => {
      setIsSuccessShown(false);
      setContentWine(wine);
      setMode('content');
      await stopAr();
    }, SUCCESS_MS);
  }

  function openAdmin() {
    stopAr();
    setMode('admin');
    setIsSuccessShown(false);
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

  function saveToStorage(nextWines) {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ wines: nextWines }));
  }

  function handleSelectWine(wine) {
    setSelectedWineId(wine.id);
    setForm(getFormFromWine(wine));
    setNotice({ text: '', type: '' });
  }

  function handleNewWine() {
    setSelectedWineId(null);
    setForm(createEmptyForm(nextTargetIndex));
    setNotice({ text: 'Новая карточка: заполни поля и нажми «Сохранить».', type: '' });
  }

  function handleFormChange(event) {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function normalizeFormWine() {
    const id = normalizeString(form.id);
    const targetIndex = Number.parseInt(form.targetIndex, 10);
    const title = normalizeString(form.title);
    const subtitle = normalizeString(form.subtitle);
    const story = normalizeString(form.story);
    const serving = normalizeString(form.serving);

    if (!id) {
      throw new Error('Укажи уникальный ID вина.');
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
      pairings: parseTags(form.pairings),
      gallery: parseGallery(form.gallery),
    };
  }

  function handleSaveWine(event) {
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
      setNotice({ text: 'Сохранено.', type: 'success' });
      saveToStorage(nextWines);
    } catch (error) {
      setNotice({ text: error.message || 'Не удалось сохранить вино.', type: 'error' });
    }
  }

  function handleDeleteWine() {
    if (!selectedWineId) {
      setNotice({ text: 'Сначала выбери вино для удаления.', type: 'error' });
      return;
    }

    const nextWines = wines.filter((wine) => wine.id !== selectedWineId);
    setWines(nextWines);
    saveToStorage(nextWines);

    if (!nextWines.length) {
      setSelectedWineId(null);
      setForm(createEmptyForm(0));
      setNotice({ text: 'Карточка удалена. Добавь новое вино.', type: 'success' });
      return;
    }

    const first = [...nextWines].sort((a, b) => a.targetIndex - b.targetIndex)[0];
    setSelectedWineId(first.id);
    setForm(getFormFromWine(first));
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
        mindar-image="imageTargetSrc: https://raw.githubusercontent.com/hiukim/mind-ar-js/master/examples/image-tracking/assets/card-example/card.mind; autoStart: false; uiScanning: no; uiLoading: no"
        color-space="sRGB"
        renderer="colorManagement: true, physicallyCorrectLights, alpha: true"
        vr-mode-ui="enabled: false"
        device-orientation-permission-ui="enabled: false"
        className={`ar-scene ${mode === 'scan' ? '' : 'hidden'}`}
      >
        <a-camera position="0 0 0" look-controls="enabled: false"></a-camera>
        <a-entity ref={targetsRootRef}></a-entity>
      </a-scene>

      <main className={`app-shell ${mode === 'scan' ? 'is-scan' : ''}`}>
        {mode !== 'scan' && (
        <header className="topbar">
          <p className="topbar-brand">Wine Label AR</p>
          <nav className="topbar-nav">
            <button
              className={`topbar-tab ${mode === 'home' || mode === 'scan' || mode === 'content' ? 'is-active' : ''}`}
              onClick={() => setMode('home')}
            >
              Сканер
            </button>
            <button
              className={`topbar-tab ${mode === 'admin' ? 'is-active' : ''}`}
              onClick={openAdmin}
            >
              Админка
            </button>
          </nav>
        </header>
        )}

        {(mode === 'home' || mode === 'scan' || mode === 'content') && (
          <section className={mode === 'scan' ? 'scanner-panel scan-panel-hud' : 'panel scanner-panel'}>
            {mode === 'home' && (
              <div className="home-content">
                <p className="eyebrow">AR Scanning</p>
                <h1>Сканируй этикетки и показывай историю вина</h1>
                <p className="lead">
                  Запусти камеру, наведи на этикетку и покажи карточку с контентом.
                </p>
                {startError && <p className="notice is-error">{startError}</p>}
                <div className="actions-row">
                  <button className="primary-btn" onClick={handleStartScan}>
                    Включить камеру
                  </button>
                  <button className="ghost-btn" onClick={openAdmin}>
                    Открыть админку
                  </button>
                </div>
              </div>
            )}

            {mode === 'scan' && (
              <div className="scan-state">
                <div className="scan-toolbar">
                  <button className="ghost-btn" onClick={handleStopScan}>
                    Отмена
                  </button>
                </div>
                <p className="scan-pill">Наведи камеру на этикетку</p>
                <div className="scanner-frame" aria-hidden="true"></div>
                {isSuccessShown && (
                  <div className="success-overlay">
                    <p>Well done!</p>
                  </div>
                )}
              </div>
            )}

            {mode === 'content' && contentWine && (
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
            )}
          </section>
        )}

        {mode === 'admin' && (
          <section className="panel admin-panel">
            <div className="admin-header">
              <div>
                <p className="eyebrow">Content Manager</p>
                <h2>Панель управления винами</h2>
                <p className="lead">
                  Добавляй новые карточки, редактируй тексты и изображения, выгружай актуальный JSON.
                </p>
              </div>
              <button className="ghost-btn" onClick={closeAdmin}>
                К сканеру
              </button>
            </div>

            <div className="admin-layout">
              <aside className="admin-sidebar">
                <button className="primary-btn sidebar-btn" onClick={handleNewWine}>
                  + Новое вино
                </button>

                <div className="wine-list">
                  {!sortedWines.length && <div className="empty-item">Пока нет вин. Добавь первое.</div>}

                  {sortedWines.map((wine) => (
                    <button
                      key={wine.id}
                      className={`wine-item ${selectedWineId === wine.id ? 'is-active' : ''}`}
                      onClick={() => handleSelectWine(wine)}
                    >
                      <div className="wine-item-title">{wine.title || wine.id}</div>
                      <div className="wine-item-subtitle">{wine.subtitle || 'Без подзаголовка'}</div>
                      <div className="wine-item-meta">targetIndex: {wine.targetIndex}</div>
                    </button>
                  ))}
                </div>
              </aside>

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

                  <label className="field field-wide">
                    <span>Заголовок</span>
                    <input name="title" value={form.title} onChange={handleFormChange} required />
                  </label>

                  <label className="field field-wide">
                    <span>Подзаголовок</span>
                    <input name="subtitle" value={form.subtitle} onChange={handleFormChange} required />
                  </label>

                  <label className="field field-wide">
                    <span>История</span>
                    <textarea name="story" rows="4" value={form.story} onChange={handleFormChange} required />
                  </label>

                  <label className="field field-wide">
                    <span>Подача</span>
                    <textarea name="serving" rows="3" value={form.serving} onChange={handleFormChange} required />
                  </label>

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
                  <button className="ghost-btn" type="button" onClick={handleDeleteWine}>
                    Удалить
                  </button>
                  <button className="ghost-btn" type="button" onClick={handleDownloadJson}>
                    Скачать JSON
                  </button>
                  <button className="ghost-btn" type="button" onClick={handleResetDemo}>
                    Сбросить к demo
                  </button>
                </div>
              </form>
            </div>
          </section>
        )}
      </main>
    </>
  );
}
