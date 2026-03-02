# Wine Label WebAR MVP

Минимальный прототип WebAR со сканированием этикетки и показом контента по вину.

## Что уже есть
- Сканирование image-target через MindAR
- Контент для найденного вина: название, описание, видео
- Кнопка с тестом по вину
- Простая структура для добавления новых вин через `data/wines.json`

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

## Следующий шаг
- Вынести `TARGET_TO_WINE` и контент в backend/API
- Добавить аналитику (просмотры/досмотры/прохождение теста)
- Добавить админку загрузки этикеток и контента
