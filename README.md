# Wine Label AR + Admin Dashboard

Проект переведен на `Vite + React` и готов к деплою на GitHub Pages.

## Что есть сейчас
- AR-сканер этикетки через MindAR
- Контент-карточка вина после распознавания
- Админка для добавления/редактирования/удаления вин
- Опциональный API-режим через Cloudflare Worker (бесплатный backend)
- Экспорт актуального `wines.json`
- Локальное сохранение правок в `localStorage`

## Локальный запуск

```bash
npm install
npm run dev
```

Открой адрес из Vite (обычно `http://localhost:5173`).

Если хочешь включить backend API:
1. Скопируй `.env.example` в `.env`
2. Заполни `VITE_API_BASE_URL`
3. Перезапусти `npm run dev`

## Production build

```bash
npm run build
npm run preview
```

Сборка лежит в `dist/`.

## Структура папок (важно)

- `src/` — исходный код приложения (React, CSS, компоненты)
- `public/` — статические файлы, которые копируются в сборку как есть
- `dist/` — результат `npm run build` (генерируется автоматически, руками не редактируем)
- `worker/` — Cloudflare Worker API (CRUD для вин)

Куда класть картинку для стартового фона:
- `public/images/start-bg.svg` (можно заменить на `start-bg.jpg/png` и поменять путь в `src/App.jsx`)

## Деплой на GitHub Pages

Проект использует `base: "./"` в `vite.config.js`, поэтому собранные ассеты работают в Pages без жесткой привязки к имени репозитория.

Базовый сценарий:
1. Выполни `npm run build`
2. Опубликуй содержимое `dist/` в ветку/папку, которую использует GitHub Pages

## Бесплатный backend (Cloudflare Worker)

В проекте есть готовый Worker API:
- `GET /health`
- `GET /wines`
- `POST /wines`
- `PUT /wines`
- `PUT /wines/:id`
- `DELETE /wines/:id`
- `POST /labels/process` (запуск обработки фото этикетки)
- `GET /labels/process/:jobId` (статус обработки)

### Быстрый запуск API

```bash
cd worker
npm install
npx wrangler kv namespace create WINES_KV
npx wrangler kv namespace create WINES_KV --preview
```

Скопируй выданные `id` и `preview_id` в `worker/wrangler.toml`.

Дальше:

```bash
npm run dev
```

После деплоя (`npm run deploy`) пропиши URL воркера в `.env`:

```bash
VITE_API_BASE_URL=https://<your-worker>.workers.dev
```

Если `VITE_API_BASE_URL` пустой, админка работает в прежнем режиме через `localStorage`.

### Flow обработки этикетки в админке
1. Загрузи фото этикетки
2. Нажми `Обработать этикетку`
3. Дождись статуса `Готово`
4. Сохрани карточку вина

## Формат данных

`data/wines.json`

```json
{
  "wines": [
    {
      "id": "wine-demo-001",
      "targetIndex": 0,
      "title": "Barolo Riserva 2018",
      "subtitle": "Piemonte, Italy",
      "story": "...",
      "serving": "...",
      "pairings": ["..."],
      "gallery": ["https://..."]
    }
  ]
}
```

## Как пользоваться админкой
1. Открой вкладку `Админка`
2. Нажми `+ Новое вино`
3. Заполни форму и нажми `Сохранить`
4. Для выгрузки нажми `Скачать JSON`
5. Для возврата к demo-данным нажми `Сбросить к demo`

`targetIndex` должен соответствовать индексу target в `.mind` файле MindAR.
