# Terrain Explorer Builder

Учебная заготовка 3D-игры под GitHub Pages и локальный HTTP-сервер.

## Что появилось в этой версии

- first-person сцена на Three.js;
- процедурный рельеф на height field;
- поверхность, собранная из нескольких tile-текстур;
- внешний GLB-ассет (`assets/models/grass_tuft.glb`);
- **конструктор карты** с понятным API:
  - `VegetationLayer`
  - `CollectibleLayer`
  - `LandmarkLayer`
- подбор предметов клавишей `E`;
- HUD-инвентарь;
- очень подробные комментарии в `main.js`;
- конкретный патч оптимизации для растительности: `InstancedMesh + renderDistance + LOD`.

## Как запускать

Нужно открывать проект через локальный сервер, а не через `file://`.

### Вариант 1

```bash
python -m http.server 8000
```

Потом открыть:

```text
http://localhost:8000
```

### Вариант 2

Открыть папку в VS Code и использовать расширение **Live Server**.

## Где редактировать карту

Открой `main.js` и найди секцию:

```js
// 14. MAP CONSTRUCTOR AREA
```

Именно там описывается карта.

## Пример API

```js
const builder = new MapBuilder('My map')
  .vegetation({
    id: 'grass',
    label: 'Трава',
    modelPath: './assets/models/grass_tuft.glb',
    modelScale: 2.8,
    minScale: 0.9,
    maxScale: 1.4,
    density: 0.32,
    clustering: 0.55,
    cellSize: 10,
    maxCount: 400,
    maxSlopeDeg: 32,
    alignToGround: 0.4,
    instanced: true,
    renderDistance: 120,
    cullUpdateInterval: 0.1,
    cullMoveThreshold: 3,
    lod: [
      { maxDistance: 25 },
      { maxDistance: 60, modelPath: './assets/models/tree_mid.glb' },
      { maxDistance: 90, modelPath: './assets/models/tree_low.glb' },
    ],
  })
  .collectibles({
    id: 'crystals',
    label: 'Кристалл',
    inventoryKey: 'crystal',
    amount: 1,
    createMesh: createCrystalPickupMesh,
    modelScale: 1.0,
    density: 0.04,
    clustering: 0.8,
    cellSize: 24,
    pickupRadius: 8,
  })
  .landmark({
    id: 'peak_obelisk',
    label: 'Обелиск',
    anchor: 'highest',
    createMesh: createObeliskMesh,
    modelScale: 1.3,
  });
```

## Как работает масштаб модели

У каждого слоя есть:

- `modelScale` — базовый масштаб модели слоя;
- `minScale` / `maxScale` — случайный разброс между экземплярами.

Итоговый масштаб одного экземпляра:

```text
finalScale = modelScale * random(minScale..maxScale)
```

Это удобно, если модель из Blender экспортировалась в “неудачных” единицах.

## Как добавить свою модель из Blender

1. В Blender экспортируй модель в **glTF 2.0 / GLB**.
2. Положи файл в `assets/models/`.
3. Укажи путь в `modelPath` у нужного слоя.
4. Подбери `modelScale`.

## Управление

- `WASD` — ходьба
- мышь — осмотр
- `Shift` — ускорение
- `E` — подобрать предмет
- `R` — пересобрать мир
- клик — захват курсора
- `Esc` — отпустить курсор

## Оптимизация растительности

Для тяжёлых моделей деревьев теперь можно включить:

- `instanced: true` — одинаковые модели рендерятся батчами через `THREE.InstancedMesh`;
- `renderDistance` — дальние экземпляры не показываются;
- `lod` — разные модели по дистанции;
- `castShadow` / `receiveShadow` — можно отключить тени для листвы.

Для LOD укажи массив уровней в порядке ближний → дальний по `maxDistance`.
Если у конкретного уровня не указан `modelPath`, используется базовая модель слоя.


## Обновление архитектуры

Проект частично разбит на модули:
- `main.js` — сборка сцены, рендер-цикл, загрузка ассетов;
- `src/player-controller.js` — движение игрока;
- `src/map-builder-module.js` — слои карты и декларативный конструктор карты.

Глобальные множители растительности удалены. Каждый тип растительности теперь задаётся явно отдельным вызовом `.vegetation({...})` внутри `createDemoMapBuilder()`.


## Точное количество предметов

Для `collectibles` и других scatter-слоёв можно задать `fixedCount`, если нужно
получить ровно N объектов при сохранении клеточной логики распределения:

```js
.collectibles({
  id: 'crystal_pickups',
  density: 0.04,
  clustering: 0.8,
  cellSize: 24,
  fixedCount: 48,
})
```

Разница между `fixedCount` и `maxCount`:
- `maxCount` просто рано останавливает генерацию;
- `fixedCount` просматривает всю карту и потом выбирает ровно N кандидатов по весам `density/clustering`.


## NPC base
- new `.npc({...})` layer in `src/map-builder-module.js`;
- runtime NPC logic in `src/npc-system.js`;
- cloud damage accumulates from approximate overlap of cloud capsule and NPC fitted volume;
- animated GLB clips may be mapped through `animationClips: { idle, move, attack, defeated }`.
