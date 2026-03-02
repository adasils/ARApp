# Wine Label WebAR MVP

Минимальный прототип WebAR со сканированием этикетки и показом контента по вину.

## Текущий UX-сценарий
1. Стартовый экран с кнопкой `Включить камеру`
2. Полноэкранный режим сканирования
3. После распознавания короткая анимация `Well done!`
4. Появляется контент-карточка вина (текст + изображения)

## Что уже есть
- Сканирование image-target через MindAR
- Контент для найденного вина из `data/wines.json`
- Кнопка `Сканировать снова`
- Структура для добавления новых вин

## Быстрый запуск

```bash
python3 -m http.server 8080
```

Открой в браузере: `http://localhost:8080`

Важно: для камеры лучше HTTPS или localhost.

## Демо-этикетка для распознавания
MVP подключен к демо target-файлу MindAR.
Открой это изображение на втором экране или распечатай и наведи камеру:

- https://raw.githubusercontent.com/hiukim/mind-ar-js/master/examples/image-tracking/assets/card-example/card.png

## Как добавить новое вино
1. Добавь запись в `data/wines.json`.
2. Добавь target в `.mind` файл (через инструменты MindAR) и увеличь `targetIndex`.
3. В `src/main.js` расширь карту `TARGET_TO_WINE`:

```js
const TARGET_TO_WINE = {
  0: 'wine-demo-001',
  1: 'wine-demo-002'
};
```
