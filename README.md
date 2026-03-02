# Wine Label AR + Admin Dashboard

Проект переведен на `Vite + React` и готов к деплою на GitHub Pages.

## Что есть сейчас
- AR-сканер этикетки через MindAR
- Контент-карточка вина после распознавания
- Админка для добавления/редактирования/удаления вин
- Экспорт актуального `wines.json`
- Локальное сохранение правок в `localStorage`

## Локальный запуск

```bash
npm install
npm run dev
```

Открой адрес из Vite (обычно `http://localhost:5173`).

## Production build

```bash
npm run build
npm run preview
```

Сборка лежит в `dist/`.

## Деплой на GitHub Pages

Проект использует `base: "./"` в `vite.config.js`, поэтому собранные ассеты работают в Pages без жесткой привязки к имени репозитория.

Базовый сценарий:
1. Выполни `npm run build`
2. Опубликуй содержимое `dist/` в ветку/папку, которую использует GitHub Pages

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
