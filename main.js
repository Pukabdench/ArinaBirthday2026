import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { createMapBuilderModule } from './src/map-builder-module.js';
import { createNpcSystemModule } from './src/npc-system.js';
import { updatePlayerMovement } from './src/player-controller.js';

/*
================================================================================
Terrain Explorer Builder
--------------------------------------------------------------------------------
Этот файл специально написан как учебная база. Здесь есть:
1) простая first-person сцена на Three.js;
2) процедурный ландшафт на основе 2D-шума;
3) текстурирование поверхности несколькими tile-текстурами;
4) конструктор карты с классами слоёв:
   - VegetationLayer  -> растительность / декор;
   - CollectibleLayer -> предметы, которые можно подбирать;
   - LandmarkLayer    -> одиночные объекты с фиксированной позицией или якорем;
5) очень подробные комментарии по архитектуре и использованию.

Самое важное место для редактирования — секция MAP CONSTRUCTOR AREA.
Там ты буквально описываешь карту в стиле:

new MapBuilder('My map')
  .vegetation({...})
  .collectibles({...})
  .landmark({...});

Это по духу похоже на plt.plot(): есть маленький и понятный API, через который
ты описываешь, ЧТО нужно построить, а низкоуровневая реализация уже скрыта.
================================================================================
*/

// =============================================================================
// 1. ГЛОБАЛЬНАЯ КОНФИГУРАЦИЯ "ДВИЖКА"
// =============================================================================
const debugTable = false;

// Здесь живут НЕ данные конкретной карты, а общие параметры движка:
// размеры мира, настройки шума, скорость игрока и т.п.
const config = {
  worldSize: 900,
  segments: 220,
  maxHeight: 95,
  waterLevel: 6,

  player: {
    // Высота камеры/уровня взгляда игрока относительно земли.
    // eyeHeight оставлен как обратная совместимость для старых кусочков кода,
    // но дальше в логике используем именно playerHeight.
    playerHeight: 10,
    eyeHeight: 10,
    walkSpeed: 45,
    sprintSpeed: 78,
    mouseSensitivity: 0.0022,
    pickupReach: 14,
  },

  terrainNoise: {
    scale: 0.0018,
    octaves: 5,
    persistence: 0.5,
    lacunarity: 2.12,
  },

  terrainSurface: {
    resolution: 512,
    tileWorldScale: 18,
    brightnessNoiseScale: 0.058,
    biomeNoiseScale: 0.0038,
    tilePaths: {
      sand: './assets/textures/sand.png',
      grass: './assets/textures/grass.png',
      meadow: './assets/textures/meadow.png',
      dirt: './assets/textures/dirt.png',
      rock: './assets/textures/rock.png',
      snow: './assets/textures/snow.png',
    },
  },

  collectibles: {
    // Если активных одуванчиков на карте стало меньше этого числа,
    // система досыпает новые в других местах, пока снова не восстановит
    // стартовое количество слоя.
    minDandelionsCount: 12,
    respawnCooldown: 0.75,
    respawnSeparationScale: 0.8,
  },

  gameplay: {
    // Короткое безопасное время в начале раунда: NPC не видят игрока,
    // патрулируют карту и могут собирать одуванчики.
    safeTime: 8,
    safeTimeEndMessageDuration: 2.2,
  },

  graphics: {
    // Когда флажок включён, игра ограничивает внутреннее разрешение примерно
    // уровнем 1280×720, сохраняя canvas растянутым на весь экран. Это даёт
    // выигрыш в производительности на больших экранах ценой более мягкой картинки.
    renderQuality: 'native',
    presets: {
      native: null,
      hd: { width: 1024, height: 576 },
      low: { width: 684, height: 384 },
    },
    maxPixelRatio: 2,
  },

  dandelionWeapon: {
    ammoKey: 'dandelion',
    ammoLabel: 'Одуванчик',

    // Если у тебя есть собственная модель одной "пушинки" / одного seed-парашюта,
    // просто положи GLB в проект и укажи путь здесь. Если path = null, игра
    // использует встроенную процедурную мини-модель.
    fluffModelPath: null,
    fluffModelScale: 0.4,
    // Цвет встроенной тестовой пушинки. Используется только если
    // fluffModelPath === null. Для внешней GLB-модели этот параметр игнорируется.
    fluffColor: 0xf6f9ff,
    tintColor: 0xf6f9ff,
    emissiveColor: 0xcfdfff,
    tintStrength: 0.24,

    particleCount: 22,
    simulationParticleCount: 22,
    renderParticleCount: 8,
    coneAngleDeg: 16,
    muzzleDistance: 1.8,
    muzzleDrop: 0.22,
    initialSpeedMin: 12,
    initialSpeedMax: 19,
    lateralJitter: 3.5,
    upwardBias: 1.8,
    gravity: 7.5,
    drag: 0.72,
    planarQuadraticDrag: 0.075,
    settleFriction: 0.86,
    lifeTime: 6.5,
    shotCooldown: 0.16,

    // Вероятность того, что конкретный выстрел попадёт под сдвиг ветром.
    // Ветер выбирается в горизонтальной плоскости по дуге от строго влево
    // до строго вправо через направление "назад на игрока".
    windShearChance: 0.38,
    windSpeedMin: 7,
    windSpeedMax: 15,
    windshearAlarmDuration: 2.8,

    // Приближённая геометрия облака для будущих NPC:
    // direction + segment + radius образуют похожую на капсулу область влияния.
    baseTrackingRadius: 2.4,
    spreadGrowthPerSecond: 1.35,
    forwardGrowthPerSecond: 5.8,
  },

  // Отдельный профиль оружия NPC. Он использует тот же тип облака и ту же физику,
  // но имеет собственную раскраску, урон и параметры шота.
  npcWeapon: {
    fluffModelPath: null,
    // Делаем NPC-пух немного крупнее и заметнее по умолчанию.
    fluffModelScale: 0.4,
    // Цвет встроенной тестовой пушинки NPC. Работает только если
    // fluffModelPath === null. Для внешней GLB-модели цвет задаётся уже
    // материалами самой модели / tint-параметрами.
    fluffColor: 0xff3030,
    tintColor: 0xff8080,
    emissiveColor: 0xff5f91,
    tintStrength: 0.5,

    particleCount: 24,
    simulationParticleCount: 24,
    renderParticleCount: 8,
    coneAngleDeg: 14,
    muzzleDistance: 2.0,
    muzzleDrop: -0.1,
    initialSpeedMin: 11,
    initialSpeedMax: 17,
    lateralJitter: 2.8,
    upwardBias: 1.2,
    gravity: 7.0,
    drag: 0.68,
    planarQuadraticDrag: 0.01,
    settleFriction: 0.84,
    lifeTime: 5.8,
    shotCooldown: 0.85,

    windShearChance: 0.38,
    windSpeedMin: 7,
    windSpeedMax: 15,
    windshearAlarmDuration: 2.2,

    baseTrackingRadius: 2.0,
    spreadGrowthPerSecond: 1.1,
    forwardGrowthPerSecond: 4.9,
  },

  combat: {
    playerMaxHp: 100,
    npcMaxHp: 100,

    // Базовый DPS при 100% перекрытии облака и цели. Реальный урон дальше
    // масштабируется overlap ratio, коэффициентами стороны и age fade облака.
    baseCloudDamagePerSecond: 22,

    // Один и тот же cloud может наносить урон одной и той же цели только
    // ограниченное суммарное время. После этого частицы ещё висят в воздухе,
    // но дополнительный урон не начисляется.
    maxDamageExposurePerCloudTarget: 1.6,

    // Глобальные поправки для подбора баланса.
    // playerDamageMultiplier — урон игрока по NPC.
    // npcDamageMultiplier    — урон NPC по игроку.
    playerDamageMultiplier: 1,
    npcDamageMultiplier: 1,
  },

npcDefaults: {
  cloudThreshold: 100,
  exposurePerSecond: 24,

  cloudVolume: {
    fitScale: [1.0, 1.0, 1.0],
    sampleCount: 5,
    minSphereRadius: 0.45,
    debug: false,
  },

  movement: {
    walkSpeed: 42,
    runSpeed: 72,
    turnSpeed: 25.5,
  },

  cloudAttack: {
    cooldown: 2.2,
    range: 18,

    // Быстрый "running shot" во время преследования: NPC может не ждать полной
    // остановки и короткого windup, а использовать окно слабости игрока прямо на бегу.
    runningShotEnabled: true,
    runningShotChance: 0.42,
    runningShotMinOverlap: 0.055,
    runningShotDamageScale: 0.76,
    runningShotParticleScale: 0.82,
    runningShotLifeScale: 0.86,
    runningShotRadiusScale: 0.88,
    runningShotCooldownScale: 1.08,
    runningShotDecisionInterval: 0.24,
  },
},

  lighting: {
    // Цвет тумана лучше держать близким к цвету неба: тогда дальняя граница
    // рендера визуально растворяется, а не выглядит как жёсткая "стена".
    fogColor: 0x9cc8ff,

    // Global atmospheric fog для всей сцены.
    // fogStartDistance — с какого расстояния от камеры начинает нарастать туман.
    fogStartDistance: 105,

    // fogFadeLength — длина зоны перехода от "почти нет тумана" к "почти всё
    // растворилось". Чем больше число, тем мягче и длиннее переход.
    fogFadeLength: 120,

    // Небольшой запас после nominal renderDistance инстанс-слоёв.
    // Объекты в этом буфере уже почти скрыты туманом, поэтому исчезновение
    // выглядит естественно, а не резким срезом по окружности.
    scatterCullPadding: 36,
  },

};

function getPlayerHeight() {
  return config.player.playerHeight ?? config.player.eyeHeight ?? 6;
}

// =============================================================================
// 2. DOM-ЭЛЕМЕНТЫ HUD / OVERLAY
// =============================================================================
const ui = {
  overlay: document.getElementById('overlay'),
  overlayCard: document.getElementById('overlayCard'),
  menuView: document.getElementById('menuView'),
  pauseView: document.getElementById('pauseView'),
  outcomeView: document.getElementById('outcomeView'),
  overlayTitle: document.getElementById('overlayTitle'),
  overlayText: document.getElementById('overlayText'),
  outcomeHeading: document.getElementById('outcomeHeading'),
  outcomeBody: document.getElementById('outcomeBody'),
  outcomeSignature: document.getElementById('outcomeSignature'),
  outcomeButtonRow: document.getElementById('outcomeButtonRow'),
  outcomeActionButton: document.getElementById('outcomeActionButton'),
  resumeButton: document.getElementById('resumeButton'),
  buildStatus: document.getElementById('buildStatus'),
  runtimeStatus: document.getElementById('runtimeStatus'),
  startButton: document.getElementById('startButton'),
  rebuildButton: document.getElementById('rebuildButton'),
  newSeedButton: document.getElementById('newSeedButton'),
  seedInput: document.getElementById('seedInput'),
  renderQualitySelect: document.getElementById('renderQualitySelect'),
  modelName: document.getElementById('modelName'),
  stats: document.getElementById('stats'),
  inventoryContent: document.getElementById('inventoryContent'),
  interactionHint: document.getElementById('interactionHint'),
  windshearAlarm: document.getElementById('windshearAlarm'),
  hud: document.getElementById('hud'),
  combatHud: document.getElementById('combatHud'),
  crosshair: document.getElementById('crosshair'),
  playerHpText: document.getElementById('playerHpText'),
  playerHpFill: document.getElementById('playerHpFill'),
  npcHpText: document.getElementById('npcHpText'),
  npcHpFill: document.getElementById('npcHpFill'),
};

// =============================================================================
// 3. THREE.JS: RENDERER / SCENE / CAMERA / LIGHTS
// =============================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

function getNativePixelRatio() {
  return Math.min(window.devicePixelRatio || 1, config.graphics.maxPixelRatio ?? 2);
}

function getPresetCappedPixelRatio(preset) {
  const nativePixelRatio = getNativePixelRatio();
  if (!preset || !Number.isFinite(preset.width) || !Number.isFinite(preset.height)) {
    return nativePixelRatio;
  }
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  const targetPixels = Math.max(1, preset.width * preset.height);
  const cappedRatio = Math.sqrt(targetPixels / (width * height));
  return Math.max(0.35, Math.min(nativePixelRatio, cappedRatio));
}

function getActiveRenderPixelRatio() {
  const quality = config.graphics.renderQuality ?? 'native';
  const preset = config.graphics.presets?.[quality] ?? null;
  return getPresetCappedPixelRatio(preset);
}

function applyRendererResolutionSettings() {
  renderer.setPixelRatio(getActiveRenderPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(config.lighting.fogColor);
scene.fog = null;

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 2200);

const hemiLight = new THREE.HemisphereLight(0xdbeeff, 0x47522e, 1.42);
scene.add(hemiLight);

const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(170, 220, 80);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -320;
sun.shadow.camera.right = 320;
sun.shadow.camera.top = 320;
sun.shadow.camera.bottom = -320;
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 1000;
scene.add(sun);

// =============================================================================
// 4. PLAYER-RIG ДЛЯ FPS-КАМЕРЫ
// =============================================================================
// Мы используем два вложенных объекта:
// - player: отвечает за позицию персонажа и yaw (поворот влево/вправо);
// - pitchHolder: отвечает за pitch (вверх/вниз);
// - camera: сама камера.
const player = new THREE.Object3D();
const pitchHolder = new THREE.Object3D();
pitchHolder.position.y = getPlayerHeight();
pitchHolder.add(camera);
player.add(pitchHolder);
scene.add(player);

// =============================================================================
// 5. ГЛОБАЛЬНЫЙ STATE МИРА
// =============================================================================
const world = {
  seed: Math.floor(Math.random() * 1_000_000_000),
  noise: null,
  terrain: null,
  terrainMesh: null,
  waterMesh: null,
  terrainTexture: null,
  mapRoot: null,
  assets: null,
  layerStats: [],
  collectibleEntries: [],
  landmarkEntries: [],
  npcEntries: [],
  npcSystem: null,
  inventory: new Map(),
  nearbyCollectible: null,
  totalCollectiblesBuilt: 0,
  buildToken: 0,
  isBuilding: false,
  activeMapBuilder: null,
  dynamicScatterSystems: [],
  activeDandelionClouds: [],
  nextCloudId: 1,
  shotCooldownRemaining: 0,
  lastShotSummary: null,
  windshearAlarmRemaining: 0,
  windshearAlarmDuration: config.dandelionWeapon.windshearAlarmDuration,
  windshearAlarmText: '',
  safeTimeRemaining: 0,
  safeTimeActive: false,
  safeTimeTotal: config.gameplay.safeTime,
  lastSafeTimeAnnouncementSecond: null,
  playerHp: config.combat.playerMaxHp,
  playerMaxHp: config.combat.playerMaxHp,
  playerDamageByNpcThisFrame: new Map(),
  playerOverlapByNpcThisFrame: new Map(),
  playerDamageWindowByNpc: new Map(),
  playerOverlapWindowByNpc: new Map(),
  nearestNpcSnapshot: null,
  lastPlayerShotTime: -Infinity,
  lastPlayerShotOrigin: null,
  currentOutcome: null,
  gameStarted: false,
  pauseRequested: false,
  overlayMode: 'menu',
  playerVelocity: new THREE.Vector3(),
  collectibleRespawnStates: new Map(),
  getDandelionCloudVolumes() {
    return this.activeDandelionClouds.map((cloud) => cloud.getTrackingSnapshot());
  },
  getNpcSnapshots() {
    return this.npcSystem ? this.npcSystem.getSnapshots() : [];
  },
};

// =============================================================================
// 6. ВВОД
// =============================================================================
const keys = {
  KeyW: false,
  KeyA: false,
  KeyS: false,
  KeyD: false,
  KeyE: false,
  ShiftLeft: false,
  ShiftRight: false,
};

// В keyPresses лежат одноразовые нажатия за текущий кадр.
// Это удобно для E, R и т.п.
const keyPresses = new Set();
const mousePresses = new Set();

let yaw = 0;
let pitch = 0;
let pointerLocked = false;

// =============================================================================
// 7. ОБЩИЕ ВРЕМЕННЫЕ ОБЪЕКТЫ / ВСПОМОГАТЕЛЬНАЯ МАТЕМАТИКА
// =============================================================================
const clock = {
  lastTime: performance.now() * 0.001,
  elapsedTime: 0,
  getDelta() {
    const now = performance.now() * 0.001;
    const delta = now - this.lastTime;
    this.lastTime = now;
    this.elapsedTime += delta;
    return delta;
  },
};
const moveDirection = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const candidatePosition = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);
const tempVectorA = new THREE.Vector3();
const tempVectorB = new THREE.Vector3();
const tempQuaternionA = new THREE.Quaternion();
const tempQuaternionB = new THREE.Quaternion();
const tempMatrixA = new THREE.Matrix4();
const tempMatrixB = new THREE.Matrix4();
const tempScaleVector = new THREE.Vector3();
const tempColor = new THREE.Color();
world.clock = clock;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function noise01(value) {
  return value * 0.5 + 0.5;
}

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function radToDeg(rad) {
  return (rad * 180) / Math.PI;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function formatNumber(value, digits = 2) {
  return Number(value).toFixed(digits);
}

function hashStringToSeed(text, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function combineSeed(seed, label) {
  return hashStringToSeed(String(label), seed >>> 0);
}

function toVector3(value, fallback = new THREE.Vector3()) {
  if (value instanceof THREE.Vector3) return value.clone();
  if (Array.isArray(value) && value.length >= 3) return new THREE.Vector3(value[0], value[1], value[2]);
  if (value && typeof value === 'object' && 'x' in value && 'y' in value && 'z' in value) {
    return new THREE.Vector3(value.x, value.y, value.z);
  }
  return fallback.clone();
}

// -----------------------------------------------------------------------------
// ПРОЗРАЧНОСТЬ ТЕКСТУР У 3D-МОДЕЛЕЙ
// -----------------------------------------------------------------------------
// В foliage-моделях (трава, ветки, кроны деревьев) обычно используется простая
// геометрия-плоскость + PNG-текстура с альфа-каналом. Если материал импортирован
// как полностью непрозрачный, Three.js честно рисует ВСЮ плоскость, и вместо
// ёлки получаются тёмные прямоугольники/треугольники, как на твоём скриншоте.
//
// Ниже — небольшой "авто-детектор":
// 1) он пытается прочитать несколько пикселей из texture.image;
// 2) если находит альфу < 250, считает текстуру масочной/прозрачной;
// 3) после этого переводит материал в foliage-friendly режим:
//    - alphaTest > 0, чтобы отбрасывать полностью прозрачные пиксели;
//    - DoubleSide, чтобы карточка-листик была видна с обеих сторон;
//    - transparent=false, чтобы использовать именно MASK/CUTOUT, а не мягкое
//      полупрозрачное смешивание, которое часто даёт сортировочные артефакты.
//
// Это не идеальная замена корректной настройке alphaMode в Blender, но как
// защитная эвристика для игрового прототипа работает очень неплохо.
const alphaProbeCanvas = document.createElement('canvas');
const alphaProbeContext = alphaProbeCanvas.getContext('2d', { willReadFrequently: true });

function getTextureImage(texture) {
  if (!texture) return null;
  return texture.source?.data ?? texture.image ?? null;
}

function detectTextureHasTransparency(texture) {
  if (!texture) return false;

  texture.userData ??= {};
  if (typeof texture.userData.detectedHasTransparency === 'boolean') {
    return texture.userData.detectedHasTransparency;
  }

  const image = getTextureImage(texture);
  if (!image) {
    texture.userData.detectedHasTransparency = false;
    return false;
  }

  try {
    // Некоторые источники (например ImageData) уже содержат RGBA-массив.
    if (image.data && image.width && image.height) {
      const stride = Math.max(4, Math.floor((image.data.length / 4) / 512)) * 4;
      for (let i = 3; i < image.data.length; i += stride) {
        if (image.data[i] < 250) {
          texture.userData.detectedHasTransparency = true;
          return true;
        }
      }
      texture.userData.detectedHasTransparency = false;
      return false;
    }

    const width = image.width ?? image.videoWidth ?? 0;
    const height = image.height ?? image.videoHeight ?? 0;
    if (!width || !height || !alphaProbeContext) {
      texture.userData.detectedHasTransparency = false;
      return false;
    }

    // Сэмплируем уменьшенную копию, чтобы проверка была дешёвой даже на больших
    // текстурах. Для определения наличия альфа-дырок этого вполне достаточно.
    const probeWidth = Math.min(64, width);
    const probeHeight = Math.min(64, height);
    alphaProbeCanvas.width = probeWidth;
    alphaProbeCanvas.height = probeHeight;
    alphaProbeContext.clearRect(0, 0, probeWidth, probeHeight);
    alphaProbeContext.drawImage(image, 0, 0, probeWidth, probeHeight);

    const data = alphaProbeContext.getImageData(0, 0, probeWidth, probeHeight).data;
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] < 250) {
        texture.userData.detectedHasTransparency = true;
        return true;
      }
    }
  } catch (error) {
    // Если браузер/источник изображения не дал прочитать пиксели, просто не
    // активируем эвристику. Сама модель всё равно продолжит загружаться.
    console.warn('Transparency probe skipped for texture:', texture, error);
  }

  texture.userData.detectedHasTransparency = false;
  return false;
}

function materialUsesTransparentTexture(material) {
  if (!material) return false;
  return detectTextureHasTransparency(material.alphaMap) || detectTextureHasTransparency(material.map);
}

function patchMaterialForAlphaCutout(material) {
  if (!material) return;

  const hasTransparentTexture = materialUsesTransparentTexture(material);
  if (!hasTransparentTexture) return;

  // Если материал уже корректно экспортирован из Blender как BLEND/MASK,
  // мы не ломаем его логику, а лишь мягко дополняем настройки для foliage.
  material.alphaTest = Math.max(material.alphaTest ?? 0, 0.33);
  material.transparent = false;
  material.side = THREE.DoubleSide;
  material.shadowSide = THREE.DoubleSide;
  material.needsUpdate = true;
}

function patchModelMaterialsForTransparency(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => patchMaterialForAlphaCutout(material));
  });
}

// =============================================================================
// 8. ДЕТЕРМИНИРОВАННЫЙ RNG + ШУМ ПЕРЛИНА
// =============================================================================
function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

class Perlin2D {
  constructor(seed) {
    const random = mulberry32(seed);
    const p = new Uint16Array(256);
    for (let i = 0; i < 256; i += 1) p[i] = i;

    for (let i = 255; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }

    this.perm = new Uint16Array(512);
    for (let i = 0; i < 512; i += 1) this.perm[i] = p[i & 255];
  }

  fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  lerp(a, b, t) {
    return a + (b - a) * t;
  }

  grad(hash, x, y) {
    switch (hash & 7) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  }

  noise(x, y) {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);

    const u = this.fade(xf);
    const v = this.fade(yf);

    const aa = this.perm[this.perm[xi] + yi];
    const ab = this.perm[this.perm[xi] + yi + 1];
    const ba = this.perm[this.perm[xi + 1] + yi];
    const bb = this.perm[this.perm[xi + 1] + yi + 1];

    const x1 = this.lerp(this.grad(aa, xf, yf), this.grad(ba, xf - 1, yf), u);
    const x2 = this.lerp(this.grad(ab, xf, yf - 1), this.grad(bb, xf - 1, yf - 1), u);

    return this.lerp(x1, x2, v);
  }

  fractal(x, y, octaves, persistence, lacunarity) {
    let amplitude = 1;
    let frequency = 1;
    let total = 0;
    let norm = 0;

    for (let i = 0; i < octaves; i += 1) {
      total += this.noise(x * frequency, y * frequency) * amplitude;
      norm += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }

    return total / norm;
  }
}

// =============================================================================
// 9. UI-УТИЛИТЫ
// =============================================================================
function setBuildMessage(text) {
  if (ui.buildStatus) ui.buildStatus.textContent = text;
  if (ui.runtimeStatus) ui.runtimeStatus.textContent = text;
}

function setUiBusy(isBusy) {
  world.isBuilding = isBusy;
  ui.startButton.disabled = isBusy;
  ui.rebuildButton.disabled = isBusy;
  ui.newSeedButton.disabled = isBusy;
  if (ui.outcomeActionButton) {
    ui.outcomeActionButton.disabled = isBusy;
  }
}

function isPauseOverlayActive() {
  return world.overlayMode === 'pause' && !ui.overlay.classList.contains('hidden');
}

function isSimulationRunning() {
  return world.gameStarted && !world.isBuilding && !world.currentOutcome && !isPauseOverlayActive();
}

function clearGameplayInputState() {
  for (const code of Object.keys(keys)) {
    keys[code] = false;
  }
  keyPresses.clear();
  mousePresses.clear();
}

function setVisibility(element, visible) {
  if (!element) return;
  element.classList.toggle('hidden', !visible);
  element.hidden = !visible;
}

function updateGameplayUiVisibility() {
  const gameplayVisible = pointerLocked && isSimulationRunning();
  setVisibility(ui.hud, gameplayVisible);
  setVisibility(ui.combatHud, gameplayVisible);
  setVisibility(ui.crosshair, gameplayVisible);
  setVisibility(ui.windshearAlarm, gameplayVisible);
  setVisibility(ui.interactionHint, gameplayVisible);

  if (ui.stats) {
    setVisibility(ui.stats, gameplayVisible && debugTable);
  }
}

function showOverlay() {
  ui.overlay.classList.remove('hidden');
  updateGameplayUiVisibility();
}

function hideOverlay() {
  ui.overlay.classList.add('hidden');
  updateGameplayUiVisibility();
}

function setOverlayMode(mode) {
  world.overlayMode = mode;
  ui.overlay.classList.remove('overlay-mode-menu', 'overlay-mode-pause', 'overlay-mode-victory', 'overlay-mode-defeat');
  ui.overlay.classList.add(`overlay-mode-${mode}`);
  setVisibility(ui.menuView, mode === 'menu');
  setVisibility(ui.pauseView, mode === 'pause');
  setVisibility(ui.outcomeView, mode === 'victory' || mode === 'defeat');
}

function openPauseOverlay() {
  if (world.currentOutcome) return;
  world.pauseRequested = false;
  clearGameplayInputState();
  setOverlayMode('pause');
  showOverlay();
}

function getOutcomeOverlayContent(outcome, fallbackMessage = '') {
  if (outcome === 'victory') {
    return {
      mode: 'victory',
      headingHtml: 'СПРАВЕДЛИВОСТЬ<br />ВОСТОРЖЕСТВОВАЛА',
      bodyHtml: `
        <p class="lead">Поединок окончен — Арина побеждена.</p>
        <p>С днём рождения, Арина. Надеюсь, игра тебе понравилась. Двигайся по жизни так же уверенно, как тут уничтожаешь неопытного игрока. Всех</p>
      `,
      signatureHtml: `БЫЧЕСЛАВ КОРНЁВ и CHATGPT`,
      actionLabel: 'Новая игра',
      actionKind: 'menu',
      buttonRowClass: 'outcome-button-row outcome-button-row-left',
    };
  }

  return {
    mode: 'defeat',
    headingHtml: 'О НЕТ! ПОРАЖЕНИЕ',
    bodyHtml: `
      <p class="lead">Арина вновь одержала верх.</p>
      <p>Дуэль проиграна. Но настоящий ценитель одуванчиков не сдается. Возьми реванш - но на той же карте</p>
      <p class="muted">${fallbackMessage || 'Поражение зафиксировано. Позже сюда можно добавить отдельную кат-сцену или экран с развёрнутым текстом.'}</p>
    `,
    signatureHtml: '',
    actionLabel: 'Реванш',
    actionKind: 'revenge',
    buttonRowClass: 'outcome-button-row outcome-button-row-center',
  };
}


function formatHpLine(label, current, max) {
  return `${label}: ${formatNumber(current, 1)} / ${formatNumber(max, 1)}`;
}

function updateCombatHud() {
  if (ui.playerHpText) {
    ui.playerHpText.textContent = formatHpLine('Игрок HP', world.playerHp, world.playerMaxHp);
  }
  if (ui.playerHpFill) {
    const t = clamp(world.playerHp / Math.max(world.playerMaxHp, 1e-6), 0, 1);
    ui.playerHpFill.style.width = `${t * 100}%`;
  }

  const npcSnapshot = world.nearestNpcSnapshot;
  if (ui.npcHpText) {
    if (npcSnapshot) {
      ui.npcHpText.textContent = `${npcSnapshot.label} HP: ${formatNumber(npcSnapshot.hp, 1)} / ${formatNumber(npcSnapshot.maxHp, 1)}`;
    } else {
      ui.npcHpText.textContent = 'NPC HP: —';
    }
  }
  if (ui.npcHpFill) {
    const t = npcSnapshot ? clamp(npcSnapshot.hp / Math.max(npcSnapshot.maxHp, 1e-6), 0, 1) : 0;
    ui.npcHpFill.style.width = `${t * 100}%`;
  }
}

function configureOverlayForOutcome(outcome, message) {
  world.currentOutcome = outcome;
  world.pauseRequested = false;
  const content = getOutcomeOverlayContent(outcome, message);
  setOverlayMode(content.mode);
  ui.outcomeHeading.innerHTML = content.headingHtml;
  ui.outcomeBody.innerHTML = content.bodyHtml;
  ui.outcomeSignature.textContent = content.signatureHtml;
  ui.outcomeSignature.classList.toggle('hidden', !content.signatureHtml);
  ui.outcomeActionButton.textContent = content.actionLabel;
  ui.outcomeActionButton.dataset.action = content.actionKind;
  ui.outcomeButtonRow.className = content.buttonRowClass;
  showOverlay();
  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }
}

function resetOverlayToDefaultMenu() {
  world.currentOutcome = null;
  world.pauseRequested = false;
  world.pauseRequested = false;
  world.gameStarted = false;
  setOverlayMode('menu');
  ui.overlayTitle.textContent = 'ТЫ ВЕСЬ В ОДУВАНЧИКАХ!';
  ui.overlayText.innerHTML = `Стоило тебе отвернуться, и Арина тут же покрыла тебя плотным слоем плодов одуванчика. 
  Пришло время ответить на эту агрессию и восстановить справедливость!`;
  ui.startButton.textContent = 'Старт / продолжить';
  if (ui.outcomeActionButton) {
    ui.outcomeActionButton.dataset.action = '';
  }
}

function endGame(outcome, message) {
  if (world.currentOutcome) return;
  configureOverlayForOutcome(outcome, message);
}

function beginFreshRunState() {
  world.playerMaxHp = config.combat.playerMaxHp;
  world.playerHp = world.playerMaxHp;
  world.currentOutcome = null;
  world.lastPlayerShotTime = -Infinity;
  world.lastPlayerShotOrigin = null;
  world.playerLastOverlapRatio = 0;
  world.playerLastDamageTaken = 0;
  world.playerDamageByNpcThisFrame = new Map();
  world.playerOverlapByNpcThisFrame = new Map();
  world.playerDamageWindowByNpc = new Map();
  world.playerOverlapWindowByNpc = new Map();
  world.nearestNpcSnapshot = null;
  world.safeTimeRemaining = 0;
  world.safeTimeActive = false;
  world.safeTimeTotal = Math.max(0, config.gameplay.safeTime ?? 0);
  world.lastSafeTimeAnnouncementSecond = null;
  updateCombatHud();
}

function updateInventoryHud() {
  if (world.inventory.size === 0) {
    ui.inventoryContent.textContent = 'Пока пусто';
    return;
  }

  const lines = [];
  for (const [, entry] of world.inventory.entries()) {
    lines.push(`${entry.label}: ${entry.count}`);
  }
  ui.inventoryContent.textContent = lines.join('\n');
}

function setInteractionHint(text, visible) {
  ui.interactionHint.textContent = text;
  ui.interactionHint.classList.toggle('visible', visible);
}

function syncControlsFromConfig() {
  ui.seedInput.value = String(world.seed);
  if (ui.renderQualitySelect) {
    ui.renderQualitySelect.value = String(config.graphics.renderQuality ?? 'native');
  }
}

/*
readControlsIntoConfig() — обратная операция к syncControlsFromConfig().

После модульного рефакторинга в оверлее у нас остался только один действительно
редактируемый пользователем параметр: seed мира. Раньше эта функция читала ещё
глобальные множители растительности, но после перехода на явные слои в
MapBuilder такие контролы были удалены из интерфейса.

Поэтому текущая версия функции намеренно короткая: она синхронизирует только
seed, но оставлена как отдельная точка расширения. Если потом ты добавишь новые
поля управления (например, размер карты, уровень воды или debug-флаги), их нужно
будет читать именно здесь.
*/
function readControlsIntoConfig() {
  const parsedSeed = Number(ui.seedInput.value);
  if (Number.isFinite(parsedSeed)) {
    world.seed = parsedSeed >>> 0;
  }

  if (ui.renderQualitySelect) {
    const value = String(ui.renderQualitySelect.value || 'native');
    config.graphics.renderQuality = config.graphics.presets?.hasOwnProperty(value) ? value : 'native';
  }
}

/*
applyDistanceFogSettings() — единая точка настройки дальнего тумана сцены.

Идея:
- сам ландшафт и небо уже имеют атмосферную перспективу;
- массовые объекты (деревья/трава), которые отключаются по renderDistance,
  должны исчезать ПОСЛЕ того, как туман уже заметно "съел" контраст;
- поэтому туман и дальность отсечения должны быть согласованы по числам.

Параметры:
- fogStartDistance: расстояние, с которого туман начинает нарастать;
- fogFadeLength   : длина перехода, то есть субъективная "мягкость" края.

Именно fogFadeLength здесь отвечает за то, что пользователь назвал
"степенью размытия": чем она больше, тем длиннее и мягче зона растворения.
*/
function applyDistanceFogSettings() {
  const fogNear = Math.max(0, config.lighting.fogStartDistance);
  const fogFar = fogNear + Math.max(1, config.lighting.fogFadeLength);
  const fogColor = new THREE.Color(config.lighting.fogColor);

  scene.background.copy(fogColor);
  scene.fog = new THREE.Fog(fogColor, fogNear, fogFar);
}



function tintRenderableHierarchy(root, options = {}) {
  const tintColor = options.tintColor != null ? new THREE.Color(options.tintColor) : null;
  const emissiveColor = options.emissiveColor != null ? new THREE.Color(options.emissiveColor) : null;
  const tintStrength = clamp(options.tintStrength ?? 0, 0, 1);

  if (!tintColor && !emissiveColor) return root;

  root.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach((material, index) => {
      const cloned = material.clone();
      if (cloned.color && tintColor) {
        cloned.color.lerp(tintColor, tintStrength);
      }
      if (cloned.emissive && emissiveColor) {
        cloned.emissive.copy(emissiveColor).multiplyScalar(0.2 + tintStrength * 0.5);
        cloned.emissiveIntensity = Math.max(cloned.emissiveIntensity ?? 0, 0.18 + tintStrength * 0.35);
      }
      if (Array.isArray(node.material)) {
        node.material[index] = cloned;
      } else {
        node.material = cloned;
      }
    });
  });

  return root;
}

function getWeaponProfile(kind = 'player') {
  return kind === 'npc' ? config.npcWeapon : config.dandelionWeapon;
}

function createBuiltinDandelionFluffPrototype(options = {}) {
  const group = new THREE.Group();

  const builtinFluffColor = options.fluffColor ?? options.tintColor ?? 0xf6f9ff;

  const filamentMaterial = new THREE.MeshStandardMaterial({
    color: builtinFluffColor,
    emissive: 0x223344,
    emissiveIntensity: 0.04,
    roughness: 0.9,
    metalness: 0.0,
  });
  const seedMaterial = new THREE.MeshStandardMaterial({
    color: 0x8f6f49,
    roughness: 0.95,
  });

  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.62, 6), seedMaterial);
  stem.position.y = -0.22;
  group.add(stem);

  const seed = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), seedMaterial);
  seed.position.y = -0.48;
  group.add(seed);

  for (let i = 0; i < 10; i += 1) {
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.58, 5), filamentMaterial);
    spoke.position.y = 0.28;
    spoke.rotation.z = Math.PI * 0.5;
    spoke.rotation.y = (i / 10) * Math.PI * 2;
    group.add(spoke);
  }

  const tuft = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), filamentMaterial);
  tuft.position.y = 0.28;
  tuft.scale.set(1.0, 0.7, 1.0);
  group.add(tuft);

  return group;
}


function setWindshearAlarm(textMessage, duration = config.dandelionWeapon.windshearAlarmDuration) {
  world.windshearAlarmText = textMessage;
  world.windshearAlarmRemaining = duration;
  world.windshearAlarmDuration = Math.max(duration, 1e-6);
  if (ui.windshearAlarm) {
    ui.windshearAlarm.textContent = textMessage;
    ui.windshearAlarm.classList.add('visible');
  }
}

function startSafeTimeCountdown() {
  world.safeTimeTotal = Math.max(0, config.gameplay.safeTime ?? 0);
  world.safeTimeRemaining = world.safeTimeTotal;
  world.safeTimeActive = world.safeTimeRemaining > 0;
  world.lastSafeTimeAnnouncementSecond = null;
}

function announceSafeTimeCountdown(force = false) {
  if (!world.safeTimeActive) return;
  const secondsLeft = Math.max(0, Math.ceil(world.safeTimeRemaining));
  if (!force && world.lastSafeTimeAnnouncementSecond === secondsLeft) return;
  world.lastSafeTimeAnnouncementSecond = secondsLeft;
  if (ui.windshearAlarm) {
    ui.windshearAlarm.textContent = `До начала игры ${secondsLeft} с`;
  }
}

function updateSafeTime(delta) {
  if (!world.safeTimeActive) return;

  world.safeTimeRemaining = Math.max(0, world.safeTimeRemaining - delta);
  announceSafeTimeCountdown();

  if (world.safeTimeRemaining <= 0) {
    world.safeTimeActive = false;
    world.lastSafeTimeAnnouncementSecond = null;
    setWindshearAlarm('Игра началась', config.gameplay.safeTimeEndMessageDuration);
  }
}

function updateWindshearAlarm(delta) {
  if (!ui.windshearAlarm) return;

  if (world.safeTimeActive) {
    announceSafeTimeCountdown();
    ui.windshearAlarm.classList.add('visible');
    ui.windshearAlarm.style.opacity = '1';
    return;
  }

  if (world.windshearAlarmRemaining > 0) {
    world.windshearAlarmRemaining = Math.max(0, world.windshearAlarmRemaining - delta);
    const normalized = world.windshearAlarmDuration > 0
      ? clamp(world.windshearAlarmRemaining / world.windshearAlarmDuration, 0, 1)
      : 0;

    ui.windshearAlarm.textContent = world.windshearAlarmText || 'Сдвиг пуха ветром';
    ui.windshearAlarm.classList.add('visible');
    ui.windshearAlarm.style.opacity = String(0.2 + normalized * 0.8);
  } else {
    ui.windshearAlarm.classList.remove('visible');
    ui.windshearAlarm.style.opacity = '0';
  }
}


function sampleWindShear(direction, weaponConfig = config.dandelionWeapon, seedTag = `cloud:${world.nextCloudId}`) {
  const rng = mulberry32(combineSeed(world.seed, `windshear:${seedTag}`));
  if (rng() > (weaponConfig.windShearChance ?? config.dandelionWeapon.windShearChance)) {
    return {
      active: false,
      velocity: new THREE.Vector3(),
      speed: 0,
      angle: 0,
    };
  }

  const horizontalForward = direction.clone();
  horizontalForward.y = 0;
  if (horizontalForward.lengthSq() < 1e-8) {
    horizontalForward.set(0, 0, -1);
  } else {
    horizontalForward.normalize();
  }

  const horizontalRight = new THREE.Vector3().crossVectors(horizontalForward, worldUp).normalize();
  const angle = lerp(-Math.PI * 0.5, Math.PI * 0.5, rng());
  const speed = lerp(
    weaponConfig.windSpeedMin ?? config.dandelionWeapon.windSpeedMin,
    weaponConfig.windSpeedMax ?? config.dandelionWeapon.windSpeedMax,
    rng(),
  );

  const windDirection = horizontalRight.multiplyScalar(Math.sin(angle))
    .addScaledVector(horizontalForward, -Math.cos(angle))
    .normalize();

  return {
    active: true,
    velocity: windDirection.multiplyScalar(speed),
    speed,
    angle,
  };
}

class DandelionPuffCloud {
  constructor(options = {}) {
    this.id = options.id;
    this.sceneRoot = options.sceneRoot;
    this.terrain = options.terrain;
    this.lifeTime = options.lifeTime;
    this.gravity = options.gravity;
    this.drag = options.drag;
    this.planarQuadraticDrag = Number.isFinite(options.planarQuadraticDrag) ? options.planarQuadraticDrag : 0;
    this.settleFriction = options.settleFriction;
    this.direction = options.direction.clone().normalize();
    this.origin = options.origin.clone();
    this.baseTrackingRadius = options.baseTrackingRadius;
    this.spreadGrowthPerSecond = options.spreadGrowthPerSecond;
    this.forwardGrowthPerSecond = options.forwardGrowthPerSecond;
    this.team = options.team ?? 'player';
    this.ownerId = options.ownerId ?? this.team;
    this.weaponKind = options.weaponKind ?? this.team;
    this.displayColor = options.displayColor ?? null;
    this.damageMultiplier = Number.isFinite(options.damageMultiplier) ? options.damageMultiplier : 1;
    this.damageExposureByTarget = new Map();

    this.group = new THREE.Group();
    this.group.name = `dandelionCloud:${this.id}`;
    this.sceneRoot.add(this.group);

    this.particles = options.particles;
    this.simulationParticleCount = options.simulationParticleCount ?? this.particles.length;
    this.renderParticleCount = options.renderParticleCount ?? this.particles.filter((particle) => particle.object).length;
    for (const particle of this.particles) {
      if (particle.object) this.group.add(particle.object);
    }

    this.age = 0;
    this.dead = false;
    this.center = new THREE.Vector3();
    this.wind = options.wind ? {
      active: Boolean(options.wind.active),
      velocity: options.wind.velocity.clone(),
      speed: options.wind.speed ?? options.wind.velocity.length(),
      angle: options.wind.angle ?? 0,
    } : {
      active: false,
      velocity: new THREE.Vector3(),
      speed: 0,
      angle: 0,
    };

    this.tracking = {
      id: this.id,
      origin: this.origin.clone(),
      direction: this.direction.clone(),
      center: new THREE.Vector3(),
      startPoint: new THREE.Vector3(),
      endPoint: new THREE.Vector3(),
      radius: this.baseTrackingRadius,
      boundingSphere: new THREE.Sphere(new THREE.Vector3(), this.baseTrackingRadius),
      age: 0,
      lifeTime: this.lifeTime,
      normalizedAge: 0,
      approximateParticleCount: this.simulationParticleCount,
      team: this.team,
      ownerId: this.ownerId,
      weaponKind: this.weaponKind,
      damageMultiplier: this.damageMultiplier,
      windActive: this.wind.active,
      windVelocity: this.wind.velocity.clone(),
      windSpeed: this.wind.speed,
    };

    this.updateTrackingVolume();
  }

  update(delta) {
    if (this.dead) return;

    this.age += delta;
    const fadeT = clamp(this.age / this.lifeTime, 0, 1);
    const scaleFade = fadeT < 0.72 ? 1 : 1 - (fadeT - 0.72) / 0.28;

    for (const particle of this.particles) {
      if (!particle.settled) {
        // Планарное квадратичное сопротивление воздуха:
        // dv/dt = -k * |v_planar| * v_planar, где v_planar — XZ-компонента
        // собственной скорости пушинки относительно воздуха. Это даёт
        // естественное ограничение дальности, особенно после добавления
        // скорости самого стрелка к начальному импульсу облака.
        if (this.planarQuadraticDrag > 0) {
          tempVectorA.set(particle.velocity.x, 0, particle.velocity.z);
          const planarSpeed = tempVectorA.length();
          if (planarSpeed > 1e-6) {
            const decay = Math.max(0, 1 - this.planarQuadraticDrag * planarSpeed * delta);
            particle.velocity.x *= decay;
            particle.velocity.z *= decay;
          }
        }

        particle.velocity.multiplyScalar(Math.exp(-this.drag * delta));
        particle.velocity.y -= this.gravity * delta;

        // Физическая интерпретация сдвига ветром:
        // - particle.velocity — собственная скорость пушинки относительно воздуха;
        // - this.wind.velocity — скорость воздушного потока;
        // - реальное перемещение за кадр — сумма этих векторов.
        tempVectorB.copy(particle.velocity).add(this.wind.velocity);
        particle.position.addScaledVector(tempVectorB, delta);

        const groundY = this.terrain.sampleHeight(particle.position.x, particle.position.z) + 0.05;
        if (particle.position.y <= groundY) {
          particle.position.y = groundY;
          particle.velocity.y = 0;
          particle.velocity.x *= this.settleFriction;
          particle.velocity.z *= this.settleFriction;
          particle.settled = true;
        }
      } else {
        particle.velocity.x *= Math.exp(-2.8 * delta);
        particle.velocity.z *= Math.exp(-2.8 * delta);
      }

      if (particle.object) {
        particle.object.position.copy(particle.position);
        particle.object.quaternion.multiply(tempQuaternionA.setFromAxisAngle(worldUp, delta * particle.spinSpeed));
        particle.object.scale.copy(particle.baseScale).multiplyScalar(Math.max(0.001, scaleFade));
      }
    }

    this.updateTrackingVolume();

    if (this.age >= this.lifeTime) {
      this.dispose();
    }
  }

  updateTrackingVolume() {
    if (!this.particles.length) return;

    this.center.set(0, 0, 0);
    for (const particle of this.particles) {
      this.center.add(particle.position);
    }
    this.center.multiplyScalar(1 / this.particles.length);

    let minProjection = Infinity;
    let maxProjection = -Infinity;
    let maxRadialDistanceSq = 0;

    for (const particle of this.particles) {
      tempVectorA.copy(particle.position).sub(this.origin);
      const projection = tempVectorA.dot(this.direction);
      minProjection = Math.min(minProjection, projection);
      maxProjection = Math.max(maxProjection, projection);

      tempVectorB.copy(this.direction).multiplyScalar(projection);
      const radialDistanceSq = tempVectorA.sub(tempVectorB).lengthSq();
      maxRadialDistanceSq = Math.max(maxRadialDistanceSq, radialDistanceSq);
    }

    const ageT = clamp(this.age / this.lifeTime, 0, 1);
    const fallbackRadius = this.baseTrackingRadius + this.spreadGrowthPerSecond * this.age;
    const radius = Math.max(Math.sqrt(maxRadialDistanceSq), fallbackRadius * (0.65 + ageT * 0.35));
    const startProjection = Math.min(minProjection, -radius * 0.3);
    const endProjection = Math.max(maxProjection, this.forwardGrowthPerSecond * this.age);

    this.tracking.age = this.age;
    this.tracking.normalizedAge = ageT;
    this.tracking.radius = radius;
    this.tracking.center.copy(this.center);
    this.tracking.startPoint.copy(this.origin).addScaledVector(this.direction, startProjection);
    this.tracking.endPoint.copy(this.origin).addScaledVector(this.direction, endProjection);
    this.tracking.boundingSphere.center.copy(this.center);
    this.tracking.boundingSphere.radius = Math.sqrt(((endProjection - startProjection) * 0.5) ** 2 + radius ** 2);
  }


claimDamageTime(targetId, requestedDelta, maxDamageTime) {
  const alreadyUsed = this.damageExposureByTarget.get(targetId) ?? 0;
  const remaining = Math.max(0, maxDamageTime - alreadyUsed);
  const granted = Math.min(Math.max(requestedDelta, 0), remaining);
  if (granted > 0) {
    this.damageExposureByTarget.set(targetId, alreadyUsed + granted);
  }
  return granted;
}

dispose() {
    if (this.dead) return;
    this.dead = true;
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
  }

  getTrackingSnapshot() {
    return {
      id: this.tracking.id,
      origin: this.tracking.origin.clone(),
      direction: this.tracking.direction.clone(),
      center: this.tracking.center.clone(),
      startPoint: this.tracking.startPoint.clone(),
      endPoint: this.tracking.endPoint.clone(),
      radius: this.tracking.radius,
      boundingSphere: this.tracking.boundingSphere.clone(),
      age: this.tracking.age,
      lifeTime: this.tracking.lifeTime,
      normalizedAge: this.tracking.normalizedAge,
      approximateParticleCount: this.tracking.approximateParticleCount,
      team: this.team,
      ownerId: this.ownerId,
      weaponKind: this.weaponKind,
      damageMultiplier: this.damageMultiplier,
      windActive: this.tracking.windActive,
      windVelocity: this.tracking.windVelocity.clone(),
      windSpeed: this.tracking.windSpeed,
    };
  }
}


function createDandelionParticlePrototype(weaponConfig = config.dandelionWeapon) {
  if (weaponConfig.fluffModelPath) {
    const model = world.assets.createModelInstance(weaponConfig.fluffModelPath, {
      castShadow: false,
      receiveShadow: false,
    });

    // Внешняя модель пушинки использует собственные материалы. Параметр
    // fluffColor намеренно применяется только к встроенной тестовой модели,
    // чтобы не ломать авторские материалы GLB. Для импортированной модели при
    // желании можно использовать tintColor / emissiveColor.
    return tintRenderableHierarchy(model, weaponConfig);
  }
  return createBuiltinDandelionFluffPrototype(weaponConfig);
}


function getCloudSimulationParticleCount(weaponConfig = config.dandelionWeapon) {
  return Math.max(
    1,
    Math.round(
      weaponConfig.simulationParticleCount
      ?? weaponConfig.particleCount
      ?? config.dandelionWeapon.simulationParticleCount
      ?? config.dandelionWeapon.particleCount
      ?? 1,
    ),
  );
}

function getCloudRenderParticleCount(weaponConfig = config.dandelionWeapon, simulationParticleCount = getCloudSimulationParticleCount(weaponConfig)) {
  const explicit = weaponConfig.renderParticleCount;
  if (Number.isFinite(explicit)) {
    return clamp(Math.round(explicit), 0, simulationParticleCount);
  }
  return clamp(Math.ceil(simulationParticleCount / 3), 0, simulationParticleCount);
}

function buildDandelionCloudParticles(origin, direction, weaponConfig = config.dandelionWeapon, seedTag = `cloud:${world.nextCloudId}`, emitterVelocity = null) {
  const particles = [];
  const rng = mulberry32(combineSeed(world.seed, seedTag));
  const coneAngle = THREE.MathUtils.degToRad(weaponConfig.coneAngleDeg ?? config.dandelionWeapon.coneAngleDeg);
  const simulationParticleCount = getCloudSimulationParticleCount(weaponConfig);
  const renderParticleCount = getCloudRenderParticleCount(weaponConfig, simulationParticleCount);

  for (let i = 0; i < simulationParticleCount; i += 1) {
    const shouldRender = i < renderParticleCount;
    const particleObject = shouldRender ? createDandelionParticlePrototype(weaponConfig) : null;
    if (particleObject) {
      applyShadowFlagsRecursively(particleObject, false, false);
    }

    const dir = direction.clone();
    const randomAxis = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();
    const angle = coneAngle * Math.pow(rng(), 0.65);
    dir.applyQuaternion(tempQuaternionA.setFromAxisAngle(randomAxis, angle)).normalize();

    const lateral = new THREE.Vector3(rng() * 2 - 1, rng() * 0.8, rng() * 2 - 1)
      .normalize()
      .multiplyScalar((weaponConfig.lateralJitter ?? config.dandelionWeapon.lateralJitter) * (0.25 + rng() * 0.75));

    const velocity = dir.multiplyScalar(lerp(
      weaponConfig.initialSpeedMin ?? config.dandelionWeapon.initialSpeedMin,
      weaponConfig.initialSpeedMax ?? config.dandelionWeapon.initialSpeedMax,
      rng(),
    ));
    velocity.add(lateral);
    velocity.y += (weaponConfig.upwardBias ?? config.dandelionWeapon.upwardBias) * (0.3 + rng() * 0.9);
    if (emitterVelocity) velocity.add(emitterVelocity);

    const startPosition = origin.clone().add(new THREE.Vector3(
      (rng() * 2 - 1) * 0.15,
      (rng() * 2 - 1) * 0.08,
      (rng() * 2 - 1) * 0.15,
    ));

    const baseScale = new THREE.Vector3(1, 1, 1).multiplyScalar(
      (weaponConfig.fluffModelScale ?? config.dandelionWeapon.fluffModelScale) * lerp(0.72, 1.28, rng())
    );

    if (particleObject) {
      particleObject.position.copy(startPosition);
      particleObject.rotation.set(rng() * Math.PI, rng() * Math.PI * 2, rng() * Math.PI);
      particleObject.scale.copy(baseScale);
    }

    particles.push({
      object: particleObject,
      position: startPosition,
      velocity,
      baseScale,
      spinSpeed: lerp(-2.2, 2.2, rng()),
      settled: false,
    });
  }

  return {
    particles,
    simulationParticleCount,
    renderParticleCount,
  };
}

function createWeaponCloud({
  origin,
  direction,
  weaponKind = 'player',
  team = 'player',
  ownerId = team,
  weaponConfig = getWeaponProfile(weaponKind),
  damageMultiplier = 1,
  emitterVelocity = null,
  seedTag = `${weaponKind}:${ownerId}:${world.nextCloudId}`,
  alarmText = 'Сдвиг пуха ветром',
  showWindAlarm = team === 'player',
} = {}) {
  const normalizedDirection = direction.clone().normalize();
  const wind = sampleWindShear(normalizedDirection, weaponConfig, seedTag);
  if (wind.active && showWindAlarm) {
    setWindshearAlarm(alarmText, weaponConfig.windshearAlarmDuration ?? config.dandelionWeapon.windshearAlarmDuration);
  }

  const particleBuild = buildDandelionCloudParticles(origin, normalizedDirection, weaponConfig, seedTag, emitterVelocity);
  const cloud = new DandelionPuffCloud({
    id: world.nextCloudId++,
    sceneRoot: world.mapRoot ?? scene,
    terrain: world.terrain,
    origin,
    direction: normalizedDirection,
    particles: particleBuild.particles,
    simulationParticleCount: particleBuild.simulationParticleCount,
    renderParticleCount: particleBuild.renderParticleCount,
    lifeTime: weaponConfig.lifeTime ?? config.dandelionWeapon.lifeTime,
    gravity: weaponConfig.gravity ?? config.dandelionWeapon.gravity,
    drag: weaponConfig.drag ?? config.dandelionWeapon.drag,
    planarQuadraticDrag: weaponConfig.planarQuadraticDrag ?? config.dandelionWeapon.planarQuadraticDrag,
    settleFriction: weaponConfig.settleFriction ?? config.dandelionWeapon.settleFriction,
    baseTrackingRadius: weaponConfig.baseTrackingRadius ?? config.dandelionWeapon.baseTrackingRadius,
    spreadGrowthPerSecond: weaponConfig.spreadGrowthPerSecond ?? config.dandelionWeapon.spreadGrowthPerSecond,
    forwardGrowthPerSecond: weaponConfig.forwardGrowthPerSecond ?? config.dandelionWeapon.forwardGrowthPerSecond,
    wind,
    team,
    ownerId,
    weaponKind,
    displayColor: weaponConfig.tintColor ?? null,
    damageMultiplier,
    emitterVelocity,
  });

  world.activeDandelionClouds.push(cloud);
  world.lastShotSummary = cloud.getTrackingSnapshot();
  return cloud;
}

function updateDandelionClouds(delta) {
  if (world.shotCooldownRemaining > 0) {
    world.shotCooldownRemaining = Math.max(0, world.shotCooldownRemaining - delta);
  }

  if (!world.activeDandelionClouds.length) return;

  for (const cloud of world.activeDandelionClouds) {
    cloud.update(delta);
  }

  world.activeDandelionClouds = world.activeDandelionClouds.filter((cloud) => !cloud.dead);
  world.lastShotSummary = world.activeDandelionClouds.length
    ? world.activeDandelionClouds[world.activeDandelionClouds.length - 1].getTrackingSnapshot()
    : null;
}

function getInventoryCount(key) {
  return world.inventory.get(key)?.count ?? 0;
}

function removeFromInventory(key, amount = 1) {
  const entry = world.inventory.get(key);
  if (!entry || entry.count < amount) return false;
  entry.count -= amount;
  if (entry.count <= 0) {
    world.inventory.delete(key);
  } else {
    world.inventory.set(key, entry);
  }
  updateInventoryHud();
  return true;
}


function getPlayerWeaponOriginAndDirection() {
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  direction.normalize();

  const origin = new THREE.Vector3();
  camera.getWorldPosition(origin);
  origin.addScaledVector(direction, config.dandelionWeapon.muzzleDistance);
  origin.y -= config.dandelionWeapon.muzzleDrop;

  return { origin, direction };
}

function tryFireDandelionShot() {
  if (!pointerLocked || world.isBuilding || !world.terrain || world.currentOutcome) return false;
  if (world.shotCooldownRemaining > 0) return false;

  const ammoKey = config.dandelionWeapon.ammoKey;
  if (!removeFromInventory(ammoKey, 1)) {
    return false;
  }

  const { origin, direction } = getPlayerWeaponOriginAndDirection();
  createWeaponCloud({
    origin,
    direction,
    weaponKind: 'player',
    team: 'player',
    ownerId: 'player',
    weaponConfig: config.dandelionWeapon,
    emitterVelocity: world.playerVelocity,
    seedTag: `player:${world.nextCloudId}`,
    alarmText: 'Сдвиг пуха ветром',
    showWindAlarm: true,
  });

  world.lastPlayerShotTime = clock.elapsedTime;
  world.lastPlayerShotOrigin = origin.clone();
  world.shotCooldownRemaining = config.dandelionWeapon.shotCooldown;
  return true;
}

function updateWeaponInput() {
  if (mousePresses.has(0)) {
    tryFireDandelionShot();
  }
}

// =============================================================================
// 10A. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ РАБОТЫ С МОДЕЛЯМИ И INSTANCING
// =============================================================================
/*
extractInstancedMeshParts() раскладывает произвольную модель на набор меш-частей.

Зачем это нужно:
- GLB-модель дерева может состоять не из одного Mesh, а из целой иерархии
  (ствол + несколько карточек хвои + вложенные группы);
- THREE.InstancedMesh умеет инстансить только ОДНУ пару geometry/material за раз;
- поэтому мы превращаем исходную модель в массив "частей":
    [{ geometry, material, localMatrix }, ...]
  и для каждой части создаём свой InstancedMesh.

Итог:
- одна ёлка может по-прежнему быть сложной составной моделью;
- но сотни одинаковых ёлок рендерятся батчами, а не как сотни отдельных Object3D.
*/
function cloneMaterialReference(material) {
  if (Array.isArray(material)) return material.map((entry) => entry);
  return material;
}

function applyShadowFlagsRecursively(root, castShadow, receiveShadow) {
  root.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = castShadow;
      child.receiveShadow = receiveShadow;
    }
  });
  return root;
}

function extractInstancedMeshParts(root, options = {}) {
  const sourceScale = options.sourceScale ?? 1;
  const castShadow = options.castShadow ?? true;
  const receiveShadow = options.receiveShadow ?? true;

  root.updateMatrixWorld(true);
  const inverseRootWorld = root.matrixWorld.clone().invert();
  const localScaleMatrix = new THREE.Matrix4().makeScale(sourceScale, sourceScale, sourceScale);

  const parts = [];
  root.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;

    const localMatrix = new THREE.Matrix4()
      .multiplyMatrices(inverseRootWorld, child.matrixWorld)
      .multiply(localScaleMatrix);

    parts.push({
      geometry: child.geometry,
      material: cloneMaterialReference(child.material),
      localMatrix,
      castShadow,
      receiveShadow,
    });
  });

  if (!parts.length) {
    throw new Error('Model contains no mesh parts suitable for instancing.');
  }

  return parts;
}

// =============================================================================
// 10. БИБЛИОТЕКА АССЕТОВ
// =============================================================================
// Эта обёртка централизует загрузку:
// - текстур поверхности;
// - внешних 3D-моделей в формате GLB / glTF 2.0.
//
// Почему GLB хорош для этого проекта:
// - Blender умеет экспортировать его напрямую;
// - модель, материалы и текстуры могут лежать в одном файле;
// - на GitHub Pages это удобно хранить как обычный статический ассет.
class AssetLibrary {
  constructor() {
    this.textureLoader = new THREE.TextureLoader();
    this.gltfLoader = new GLTFLoader();
    this.textures = new Map();
    this.models = new Map();
    this.instancedModelParts = new Map();
  }

  async preload(builder) {
    const texturePaths = Object.values(config.terrainSurface.tilePaths);
    const modelPaths = builder.collectModelPaths();
    if (config.dandelionWeapon.fluffModelPath) {
      modelPaths.push(config.dandelionWeapon.fluffModelPath);
    }
    if (config.npcWeapon.fluffModelPath) {
      modelPaths.push(config.npcWeapon.fluffModelPath);
    }

    await Promise.all(texturePaths.map((path) => this.loadTexture(path)));
    await Promise.all([...new Set(modelPaths.filter(Boolean))].map((path) => this.loadModel(path)));
  }

  loadTexture(path) {
    if (this.textures.has(path)) return Promise.resolve(this.textures.get(path));

    return new Promise((resolve, reject) => {
      this.textureLoader.load(
        path,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
          this.textures.set(path, texture);
          resolve(texture);
        },
        undefined,
        reject,
      );
    });
  }

  loadModel(path) {
    if (this.models.has(path)) return Promise.resolve(this.models.get(path));

    return new Promise((resolve, reject) => {
      this.gltfLoader.load(
        path,
        (gltf) => {
          const root = gltf.scene;
          root.traverse((child) => {
            if (child.isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });

          // Важный шаг для растительности и любых моделей с PNG-альфой:
          // пытаемся автоматически распознать прозрачность текстур и перевести
          // материал в alpha-cutout режим. Это как раз лечит ситуацию, когда
          // крона дерева/ветка в Blender прозрачная, а в игре видна как сплошной
          // тёмный прямоугольник или треугольная карточка.
          patchModelMaterialsForTransparency(root);

          const packageData = {
            scene: root,
            animations: gltf.animations ?? [],
          };

          this.models.set(path, packageData);
          resolve(packageData);
        },
        undefined,
        reject,
      );
    });
  }

  getTexture(path) {
    return this.textures.get(path);
  }

  createModelInstance(path, options = {}) {
    const template = this.models.get(path);
    if (!template) {
      throw new Error(`Model is not loaded: ${path}`);
    }

    const clone = template.animations?.length
      ? skeletonClone(template.scene)
      : template.scene.clone(true);

    clone.userData ??= {};
    clone.userData.modelPath = path;
    clone.userData.animations = template.animations ?? [];

    return applyShadowFlagsRecursively(
      clone,
      options.castShadow ?? true,
      options.receiveShadow ?? true,
    );
  }

  getInstancedModelParts(path, options = {}) {
    const sourceScale = options.sourceScale ?? 1;
    const cacheKey = `${path}::${sourceScale}`;

    if (!this.instancedModelParts.has(cacheKey)) {
      const template = this.models.get(path);
      if (!template) {
        throw new Error(`Model is not loaded: ${path}`);
      }

      this.instancedModelParts.set(
        cacheKey,
        extractInstancedMeshParts(template.scene, {
          sourceScale,
          castShadow: options.castShadow ?? true,
          receiveShadow: options.receiveShadow ?? true,
        }),
      );
    }

    return this.instancedModelParts.get(cacheKey);
  }
}

// =============================================================================
// 11. КЛАССЫ КОНСТРУКТОРА КАРТЫ
// =============================================================================

/*
BaseLayer — общий фундамент для всех слоёв карты.

Основные поля:
- id / label      : техническое и красивое имя слоя;
- modelPath       : путь к внешней GLB-модели;
- createMesh      : callback, если объект строится кодом, а не из файла;
- modelScale      : БАЗОВЫЙ масштаб модели. Это именно та настройка, о которой
                    ты попросил: "множитель преобразования подобия".
                    Полезно, когда Blender-модель импортируется слишком большой
                    или слишком маленькой.
- castShadow / receiveShadow
                  : базовые флаги теней для объектов этого слоя.
- enabled         : можно временно выключить слой.

Важная идея по масштабу:
- modelScale — общий постоянный множитель для слоя;
- minScale/maxScale — дополнительный случайный разброс между экземплярами.

То есть итоговый масштаб экземпляра = modelScale * random(minScale..maxScale)
*/

// =============================================================================
// 11-14. КОНСТРУКТОР КАРТЫ И ТИПЫ СЛОЁВ ВЫНЕСЕНЫ В ОТДЕЛЬНЫЙ МОДУЛЬ
// =============================================================================


const mapBuilderApi = createMapBuilderModule({
  THREE,
  config,
  world,
  worldUp,
  tempVectorA,
  tempQuaternionA,
  tempQuaternionB,
  tempMatrixA,
  tempMatrixB,
  tempScaleVector,
  clamp,
  lerp,
  smoothstep,
  noise01,
  nextFrame,
  combineSeed,
  mulberry32,
  extractInstancedMeshParts,
});

const { createDemoMapBuilder, MapBuildContext } = mapBuilderApi;

const npcSystemApi = createNpcSystemModule({
  THREE,
  world,
  config,
  player,
  getPlayerViewDirection: () => {
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    direction.y = 0;
    if (direction.lengthSq() < 1e-8) direction.set(0, 0, -1);
    return direction.normalize();
  },
  getPlayerHeight: () => getPlayerHeight(),
  spawnWeaponCloud: (options) => createWeaponCloud(options),
  collectWorldDandelion: (entry, actor) => collectItemForNpc(entry, actor),
});

// Активный конструктор карты теперь живёт в отдельном модуле.
// Каждый тип растительности прописывается явно как отдельный вызов .vegetation(...)
// без глобальных множителей плотности/кластеризации в UI.
world.activeMapBuilder = createDemoMapBuilder();
//ui.modelName.textContent = 'grass_tuft.glb';

// =============================================================================
// 15. ГЕНЕРАЦИЯ HEIGHT FIELD И TERRAIN SAMPLING
// =============================================================================
function gridIndex(size, x, z) {
  return z * size + x;
}

function worldCoordFromGrid(index, size, worldSize) {
  return (index / (size - 1)) * worldSize - worldSize * 0.5;
}

function buildHeightField(seed) {
  const size = config.segments + 1;
  const heights = new Float32Array(size * size);
  const noise = new Perlin2D(seed);

  const scale = config.terrainNoise.scale;
  const { octaves, persistence, lacunarity } = config.terrainNoise;

  let highest = new THREE.Vector3(0, -Infinity, 0);
  let lowest = new THREE.Vector3(0, Infinity, 0);

  for (let gz = 0; gz < size; gz += 1) {
    for (let gx = 0; gx < size; gx += 1) {
      const x = worldCoordFromGrid(gx, size, config.worldSize);
      const z = worldCoordFromGrid(gz, size, config.worldSize);

      const nx = x / (config.worldSize * 0.5);
      const nz = z / (config.worldSize * 0.5);
      const distanceFromCenter = Math.sqrt(nx * nx + nz * nz);

      // Базовая крупная форма континента/острова.
      const macro = noise01(noise.fractal(x * scale, z * scale, octaves, persistence, lacunarity));

      // Ridge-компонента даёт горные хребты.
      const ridge = 1 - Math.abs(noise.fractal(x * scale * 2.1 + 71, z * scale * 2.1 - 37, 3, 0.55, 2.0));

      // Более мелкая детализация поверхности.
      const detail = noise01(noise.fractal(x * scale * 5.8 - 17, z * scale * 5.8 + 23, 2, 0.5, 2.0));

      let elevation = macro * 0.6 + ridge * 0.28 + detail * 0.12;

      // Falloff к краям мира, чтобы карта ощущалась "островной".
      const falloff = 1 - smoothstep(0.58, 1.15, distanceFromCenter);
      elevation *= lerp(0.18, 1.0, falloff);

      const height = (elevation - 0.32) * config.maxHeight;
      heights[gridIndex(size, gx, gz)] = height;

      if (height > highest.y) highest.set(x, height, z);
      if (height < lowest.y) lowest.set(x, height, z);
    }
  }

  return { noise, heights, size, highest, lowest };
}

function createTerrainSampler(heightField) {
  const { heights, size, highest, lowest } = heightField;
  const half = config.worldSize * 0.5;

  function sampleHeight(x, z) {
    const gx = clamp((x + half) / config.worldSize * (size - 1), 0, size - 1);
    const gz = clamp((z + half) / config.worldSize * (size - 1), 0, size - 1);

    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(x0 + 1, size - 1);
    const z1 = Math.min(z0 + 1, size - 1);

    const tx = gx - x0;
    const tz = gz - z0;

    const h00 = heights[gridIndex(size, x0, z0)];
    const h10 = heights[gridIndex(size, x1, z0)];
    const h01 = heights[gridIndex(size, x0, z1)];
    const h11 = heights[gridIndex(size, x1, z1)];

    const hx0 = lerp(h00, h10, tx);
    const hx1 = lerp(h01, h11, tx);
    return lerp(hx0, hx1, tz);
  }

  function sampleNormal(x, z, target = new THREE.Vector3()) {
    const delta = config.worldSize / config.segments;
    const hL = sampleHeight(x - delta, z);
    const hR = sampleHeight(x + delta, z);
    const hD = sampleHeight(x, z - delta);
    const hU = sampleHeight(x, z + delta);

    target.set(hL - hR, 2 * delta, hD - hU).normalize();
    return target;
  }

  function sampleSlopeDeg(x, z) {
    sampleNormal(x, z, tempVectorB);
    return radToDeg(tempVectorB.angleTo(worldUp));
  }

  function findSpawnPoint() {
    // Ищем достаточно ровную точку вокруг центра карты.
    // Это лучше, чем слепо брать (0,0), потому что там может быть вода.
    const radii = [0, 25, 45, 70, 100, 140, 190];
    for (const radius of radii) {
      const steps = radius === 0 ? 1 : 18;
      for (let i = 0; i < steps; i += 1) {
        const angle = (i / steps) * Math.PI * 2;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        const y = sampleHeight(x, z);
        const slope = sampleSlopeDeg(x, z);
        if (y > config.waterLevel + 2 && slope < 18) {
          return new THREE.Vector3(x, y, z);
        }
      }
    }

    // Если не нашли ничего лучше — берём центр как fallback.
    return new THREE.Vector3(0, sampleHeight(0, 0), 0);
  }

  const center = new THREE.Vector3(0, sampleHeight(0, 0), 0);
  const spawn = findSpawnPoint();

  return {
    heights,
    size,
    sampleHeight,
    sampleNormal,
    sampleSlopeDeg,
    anchors: {
      center,
      spawn,
      highest,
      lowest,
    },
  };
}

// =============================================================================
// 16. СОЗДАНИЕ МЕША ЛАНДШАФТА И ЕГО TOP-DOWN ТЕКСТУРЫ
// =============================================================================
function createTileImageData(texture) {
  const canvas = document.createElement('canvas');
  const size = 128;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(texture.image, 0, 0, size, size);
  const imageData = ctx.getImageData(0, 0, size, size).data;
  return { data: imageData, size };
}

function sampleTile(tileInfo, u, v) {
  const size = tileInfo.size;
  const ix = ((Math.floor(u * size) % size) + size) % size;
  const iy = ((Math.floor(v * size) % size) + size) % size;
  const index = (iy * size + ix) * 4;
  return [
    tileInfo.data[index + 0],
    tileInfo.data[index + 1],
    tileInfo.data[index + 2],
  ];
}

function normalizeWeights(weights) {
  const sum = Object.values(weights).reduce((acc, value) => acc + value, 0);
  if (sum <= 0.00001) return weights;

  const normalized = {};
  for (const [key, value] of Object.entries(weights)) {
    normalized[key] = value / sum;
  }
  return normalized;
}

function selectTwoStrongestWeights(weights) {
  const entries = Object.entries(weights).sort((a, b) => b[1] - a[1]);
  return [entries[0], entries[1] ?? entries[0]];
}

function computeBiomeWeights(height, slopeDeg, biomeNoise) {
  const sand = 1 - smoothstep(config.waterLevel + 2, config.waterLevel + 10, height);
  const grass = smoothstep(config.waterLevel + 1, 28, height) * (1 - smoothstep(12, 28, slopeDeg));
  const meadow = smoothstep(16, 42, height) * (1 - smoothstep(8, 22, slopeDeg)) * (0.55 + biomeNoise * 0.85);
  const dirt = smoothstep(24, 58, height) * smoothstep(6, 22, slopeDeg);
  const rock = smoothstep(20, 38, slopeDeg) + smoothstep(config.maxHeight * 0.48, config.maxHeight * 0.75, height) * 0.55;
  const snow = smoothstep(config.maxHeight * 0.62, config.maxHeight * 0.88, height) * (0.7 + biomeNoise * 0.55);

  return normalizeWeights({ sand, grass, meadow, dirt, rock, snow });
}

function buildTerrainTexture() {
  const resolution = config.terrainSurface.resolution;
  const tileWorldScale = config.terrainSurface.tileWorldScale;
  const brightnessNoiseScale = config.terrainSurface.brightnessNoiseScale;
  const biomeNoiseScale = config.terrainSurface.biomeNoiseScale;

  const tileData = {};
  for (const [name, path] of Object.entries(config.terrainSurface.tilePaths)) {
    tileData[name] = createTileImageData(world.assets.getTexture(path));
  }

  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.createImageData(resolution, resolution);
  const out = image.data;

  for (let py = 0; py < resolution; py += 1) {
    for (let px = 0; px < resolution; px += 1) {
      const worldX = (px / (resolution - 1)) * config.worldSize - config.worldSize * 0.5;
      const worldZ = (py / (resolution - 1)) * config.worldSize - config.worldSize * 0.5;

      const height = world.terrain.sampleHeight(worldX, worldZ);
      const slopeDeg = world.terrain.sampleSlopeDeg(worldX, worldZ);
      const biomeNoise = noise01(world.noise.fractal(worldX * biomeNoiseScale, worldZ * biomeNoiseScale, 3, 0.55, 2.0));
      const weights = computeBiomeWeights(height, slopeDeg, biomeNoise);
      const [primary, secondary] = selectTwoStrongestWeights(weights);

      const primaryColor = sampleTile(tileData[primary[0]], worldX / tileWorldScale, worldZ / tileWorldScale);
      const secondaryColor = sampleTile(tileData[secondary[0]], worldX / tileWorldScale, worldZ / tileWorldScale);

      const secondaryMix = clamp(secondary[1] * 0.65, 0, 0.48);
      const brightness = 0.82 + noise01(world.noise.noise(worldX * brightnessNoiseScale, worldZ * brightnessNoiseScale)) * 0.32;

      const r = lerp(primaryColor[0], secondaryColor[0], secondaryMix) * brightness;
      const g = lerp(primaryColor[1], secondaryColor[1], secondaryMix) * brightness;
      const b = lerp(primaryColor[2], secondaryColor[2], secondaryMix) * brightness;

      const index = (py * resolution + px) * 4;
      out[index + 0] = clamp(r, 0, 255);
      out[index + 1] = clamp(g, 0, 255);
      out[index + 2] = clamp(b, 0, 255);
      out[index + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function createTerrainMesh() {
  const geometry = new THREE.PlaneGeometry(config.worldSize, config.worldSize, config.segments, config.segments);
  geometry.rotateX(-Math.PI * 0.5);

  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    position.setY(i, world.terrain.heights[i]);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();

  world.terrainTexture = buildTerrainTexture();

  const material = new THREE.MeshStandardMaterial({
    map: world.terrainTexture,
    roughness: 1.0,
    metalness: 0.0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'terrain';
  return mesh;
}

function createWaterMesh() {
  const geometry = new THREE.PlaneGeometry(config.worldSize, config.worldSize, 1, 1);
  geometry.rotateX(-Math.PI * 0.5);

  const material = new THREE.MeshPhysicalMaterial({
    color: 0x4fa6dd,
    roughness: 0.08,
    metalness: 0.02,
    transmission: 0.12,
    transparent: true,
    opacity: 0.78,
    clearcoat: 1.0,
    clearcoatRoughness: 0.12,
  });

  const water = new THREE.Mesh(geometry, material);
  water.position.y = config.waterLevel;
  water.receiveShadow = true;
  water.name = 'water';
  return water;
}

// =============================================================================
// 17. ПОЛНЫЙ ЦИКЛ СБОРКИ МИРА
// =============================================================================
function clearCurrentWorld() {
  if (world.terrainMesh) {
    scene.remove(world.terrainMesh);
    world.terrainMesh.geometry.dispose();
    world.terrainMesh.material.dispose();
    world.terrainMesh = null;
  }

  if (world.waterMesh) {
    scene.remove(world.waterMesh);
    world.waterMesh.geometry.dispose();
    world.waterMesh.material.dispose();
    world.waterMesh = null;
  }

  if (world.mapRoot) {
    scene.remove(world.mapRoot);
    world.mapRoot = null;
  }

  if (world.terrainTexture) {
    world.terrainTexture.dispose();
    world.terrainTexture = null;
  }

  world.layerStats = [];
  world.collectibleEntries = [];
  world.landmarkEntries = [];
  world.npcEntries = [];
  if (world.npcSystem) {
    world.npcSystem.dispose();
    world.npcSystem = null;
  }
  world.dynamicScatterSystems = [];
  world.activeDandelionClouds = [];
  world.nextCloudId = 1;
  world.shotCooldownRemaining = 0;
  world.lastShotSummary = null;
  world.windshearAlarmRemaining = 0;
  world.windshearAlarmDuration = config.dandelionWeapon.windshearAlarmDuration;
  world.windshearAlarmText = '';
  world.safeTimeRemaining = 0;
  world.safeTimeActive = false;
  world.safeTimeTotal = Math.max(0, config.gameplay.safeTime ?? 0);
  world.lastSafeTimeAnnouncementSecond = null;
  world.playerLastOverlapRatio = 0;
  world.playerLastDamageTaken = 0;
  world.playerDamageByNpcThisFrame = new Map();
  world.playerOverlapByNpcThisFrame = new Map();
  world.playerDamageWindowByNpc = new Map();
  world.playerOverlapWindowByNpc = new Map();
  world.nearestNpcSnapshot = null;
  if (ui.windshearAlarm) {
    ui.windshearAlarm.classList.remove('visible');
    ui.windshearAlarm.style.opacity = '0';
  }
  world.inventory = new Map();
  world.totalCollectiblesBuilt = 0;
  world.nearbyCollectible = null;
  world.playerVelocity.set(0, 0, 0);
  world.collectibleRespawnStates = new Map();
  updateInventoryHud();
  setInteractionHint('Подойдите к предмету, чтобы подобрать его', false);
}

async function buildWorld() {
  const buildToken = ++world.buildToken;
  setUiBusy(true);

  try {
    readControlsIntoConfig();
    world.seed = Number(ui.seedInput.value || world.seed) >>> 0;
    syncControlsFromConfig();

    setBuildMessage('Очистка предыдущего мира…');
    resetOverlayToDefaultMenu();
    beginFreshRunState();
    clearCurrentWorld();
    await nextFrame();

    setBuildMessage('Загрузка ассетов…');
    world.assets = new AssetLibrary();
    await world.assets.preload(world.activeMapBuilder);
    if (buildToken !== world.buildToken) return;

    setBuildMessage('Генерация карты высот…');
    const heightField = buildHeightField(world.seed);
    world.noise = heightField.noise;
    world.terrain = createTerrainSampler(heightField);
    if (buildToken !== world.buildToken) return;
    await nextFrame();

    setBuildMessage('Создание меша ландшафта…');
    world.terrainMesh = createTerrainMesh();
    world.waterMesh = createWaterMesh();
    scene.add(world.terrainMesh);
    scene.add(world.waterMesh);

    world.mapRoot = new THREE.Group();
    world.mapRoot.name = 'mapRoot';
    scene.add(world.mapRoot);
    await nextFrame();

    setBuildMessage('Построение слоёв карты из конструктора…');
    const context = new MapBuildContext(world.activeMapBuilder);
    await world.activeMapBuilder.build(context);
    if (buildToken !== world.buildToken) return;

    initializeCollectibleRespawnStates();
    world.npcSystem = new npcSystemApi.NpcSystem(world.npcEntries);

    // Ставим игрока в точку спавна.
    player.position.copy(world.terrain.anchors.spawn);
    player.position.y += 0.01;

    setBuildMessage('');
    updateCombatHud();
    updateStatsHud();
  } catch (error) {
    console.error(error);
    setBuildMessage(`Ошибка сборки мира: ${error.message}`);
  } finally {
    if (buildToken === world.buildToken) {
      setUiBusy(false);
    }
  }
}

// =============================================================================
// 18. ДВИЖЕНИЕ ИГРОКА И POINTER LOCK
// =============================================================================
function requestGamePointerLock() {
  if (world.isBuilding || world.currentOutcome) return;
  if (pointerLocked || document.pointerLockElement === renderer.domElement) return;
  world.pauseRequested = false;
  clearGameplayInputState();
  renderer.domElement.requestPointerLock();
}

function updatePointerLockState() {
  const wasPointerLocked = pointerLocked;
  pointerLocked = document.pointerLockElement === renderer.domElement;
  if (pointerLocked) {
    if (!world.gameStarted) {
      world.gameStarted = true;
      startSafeTimeCountdown();
    }
    hideOverlay();
  } else if (!world.isBuilding) {
    clearGameplayInputState();
    if (world.currentOutcome) {
      showOverlay();
    } else if (world.gameStarted && wasPointerLocked) {
      openPauseOverlay();
    } else if (world.gameStarted) {
      hideOverlay();
    } else {
      setOverlayMode('menu');
      showOverlay();
    }
  }
  updateGameplayUiVisibility();
}

function onMouseMove(event) {
  if (!pointerLocked) return;

  yaw -= event.movementX * config.player.mouseSensitivity;
  pitch -= event.movementY * config.player.mouseSensitivity;
  pitch = clamp(pitch, -Math.PI * 0.495, Math.PI * 0.495);

  player.rotation.y = yaw;
  pitchHolder.rotation.x = pitch;
}

function handleKeyChange(event, isDown) {
  if (event.code in keys) {
    keys[event.code] = isDown;
    if (isDown && !event.repeat) {
      keyPresses.add(event.code);
    }
  }

  if (isDown && !event.repeat && event.code === 'Escape' && pointerLocked && !world.currentOutcome) {
    world.pauseRequested = true;
    document.exitPointerLock();
    return;
  }

  // R — быстро пересобрать мир.
  if (isDown && !event.repeat && event.code === 'KeyR' && !world.isBuilding) {
    buildWorld();
  }
}


function handleMouseDown(event) {
  if (!pointerLocked) return;
  event.preventDefault();
  if (event.button === 0) {
    mousePresses.add(0);
  }
}

function consumePressedKey(code) {
  const has = keyPresses.has(code);
  if (has) keyPresses.delete(code);
  return has;
}

// Логика движения игрока вынесена в src/player-controller.js

function updateDynamicScatterSystems(delta) {
  if (!world.dynamicScatterSystems.length) return;
  for (const system of world.dynamicScatterSystems) {
    system.update(delta, player.position);
  }
}

// =============================================================================
// 19. ПРЕДМЕТЫ, ИНВЕНТАРЬ, ПОДБОР
// =============================================================================
function addToInventory(key, label, amount) {
  const entry = world.inventory.get(key) ?? { label, count: 0 };
  entry.count += amount;
  world.inventory.set(key, entry);
  updateInventoryHud();
}

function markCollectibleCollected(entry, collector = null) {
  if (!entry || entry.collected) return false;
  entry.collected = true;
  entry.collectedBy = collector ?? null;

  if (entry.object.parent) {
    entry.object.parent.remove(entry.object);
  }
  return true;
}

function collectItem(entry) {
  if (!markCollectibleCollected(entry, 'player')) return false;
  addToInventory(entry.inventoryKey, entry.label, entry.amount);
  return true;
}

function collectItemForNpc(entry, actor) {
  if (!actor || !markCollectibleCollected(entry, actor.id)) return false;
  actor.addDandelions?.(entry.amount ?? 1);
  return true;
}

function updateCollectibles(delta, elapsedTime) {
  let nearest = null;
  let nearestDistance = Infinity;

  for (const entry of world.collectibleEntries) {
    if (entry.collected) continue;

    // Лёгкая анимация предмета: плавание вверх-вниз + вращение.
    entry.object.position.y = entry.baseY + Math.sin(elapsedTime * entry.floatSpeed + entry.phase) * entry.floatAmplitude;
    entry.object.rotation.y += delta * entry.spinSpeed;

    const distance = entry.object.position.distanceTo(player.position);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = entry;
    }
  }

  world.nearbyCollectible = null;

  if (nearest && nearestDistance <= Math.min(nearest.pickupRadius, config.player.pickupReach)) {
    world.nearbyCollectible = nearest;
    setInteractionHint(`[E] Подобрать: ${nearest.label}`, true);

    if (consumePressedKey('KeyE')) {
      collectItem(nearest);
    }
  } else {
    setInteractionHint('Подойдите к предмету, чтобы подобрать его', false);
  }

  updateCollectibleRespawns(delta);
}


function getCollectibleLayerById(layerId) {
  return world.activeMapBuilder?.layers?.find((layer) => layer.type === 'collectible' && layer.id === layerId) ?? null;
}

function initializeCollectibleRespawnStates() {
  world.collectibleRespawnStates = new Map();

  const dandelionKey = config.dandelionWeapon.ammoKey;
  const groups = new Map();
  for (const entry of world.collectibleEntries) {
    if (entry.inventoryKey !== dandelionKey) continue;
    const list = groups.get(entry.layerId) ?? [];
    list.push(entry);
    groups.set(entry.layerId, list);
  }

  for (const [layerId, entries] of groups.entries()) {
    const layer = getCollectibleLayerById(layerId);
    if (!layer) continue;

    const group = new THREE.Group();
    group.name = `collectibleRespawn:${layerId}`;
    world.mapRoot?.add(group);

    world.collectibleRespawnStates.set(layerId, {
      layerId,
      layer,
      inventoryKey: dandelionKey,
      initialActiveCount: entries.length,
      minActiveCount: Math.max(0, Math.min(entries.length, layer.minActiveCount ?? config.collectibles.minDandelionsCount)),
      cooldownRemaining: 0,
      respawnSerial: 0,
      group,
    });
  }
}

function updateCollectibleRespawns(delta) {
  if (!world.collectibleRespawnStates?.size || world.isBuilding || !world.mapRoot) return;

  for (const state of world.collectibleRespawnStates.values()) {
    state.cooldownRemaining = Math.max(0, state.cooldownRemaining - delta);

    const activeCount = world.collectibleEntries.reduce((count, entry) => (
      entry.layerId === state.layerId && !entry.collected ? count + 1 : count
    ), 0);

    if (activeCount >= state.minActiveCount || state.cooldownRemaining > 0) continue;

    const missingCount = Math.max(0, state.initialActiveCount - activeCount);
    if (missingCount <= 0) continue;

    const spawned = respawnCollectiblesForState(state, missingCount);
    if (spawned > 0) {
      state.cooldownRemaining = config.collectibles.respawnCooldown;
    }
  }
}

function respawnCollectiblesForState(state, desiredCount) {
  const layer = state.layer;
  if (!layer || desiredCount <= 0 || !world.terrain || !world.assets) return 0;

  const context = new MapBuildContext(world.activeMapBuilder);
  context.seed = combineSeed(world.seed, `${layer.id}:respawn:${state.respawnSerial++}`);

  const candidates = layer.generatePlacements(context);
  if (!candidates.length) return 0;

  const occupied = world.collectibleEntries
    .filter((entry) => entry.layerId === state.layerId)
    .map((entry) => entry.position.clone());

  const minSeparation = Math.max(4, layer.cellSize * (config.collectibles.respawnSeparationScale ?? 0.8));
  const actorAvoidRadius = Math.max(12, minSeparation * 1.5);
  const actorPositions = [player.position.clone()];
  if (world.npcSystem) {
    for (const snapshot of world.npcSystem.getSnapshots()) {
      if (!snapshot.defeated) actorPositions.push(snapshot.position.clone());
    }
  }

  let spawned = 0;
  for (const placement of candidates) {
    if (spawned >= desiredCount) break;

    const tooCloseToOld = occupied.some((position) => position.distanceToSquared(placement.position) < minSeparation * minSeparation);
    if (tooCloseToOld) continue;

    const tooCloseToActor = actorPositions.some((position) => position.distanceToSquared(placement.position) < actorAvoidRadius * actorAvoidRadius);
    if (tooCloseToActor) continue;

    const object = layer.createRenderable(context);
    layer.applyPlacementTransform(object, placement);
    state.group.add(object);

    world.collectibleEntries.push({
      layerId: layer.id,
      label: layer.label,
      inventoryKey: layer.inventoryKey,
      amount: layer.amount,
      pickupRadius: layer.pickupRadius,
      floatAmplitude: layer.floatAmplitude,
      floatSpeed: layer.floatSpeed,
      spinSpeed: layer.spinSpeed,
      object,
      position: object.position.clone(),
      baseY: object.position.y,
      phase: placement.phase,
      collected: false,
      respawned: true,
    });

    occupied.push(object.position.clone());
    spawned += 1;
  }

  return spawned;
}

function sphereVolume(radius) {
  return (4 / 3) * Math.PI * radius * radius * radius;
}

function intersectSphereSphereVolume(radiusA, radiusB, distance) {
  if (distance >= radiusA + radiusB) return 0;
  if (distance <= Math.abs(radiusA - radiusB)) {
    return sphereVolume(Math.min(radiusA, radiusB));
  }

  const sum = radiusA + radiusB - distance;
  const numerator = Math.PI * sum * sum * (
    distance * distance + 2 * distance * (radiusA + radiusB) - 3 * (radiusA - radiusB) * (radiusA - radiusB)
  );
  return numerator / (12 * Math.max(distance, 1e-6));
}

function createCapsuleSphereSamples(cloudTracking) {
  const radius = Math.max(0.05, cloudTracking.radius ?? 0.05);
  const start = cloudTracking.startPoint ?? cloudTracking.center ?? new THREE.Vector3();
  const end = cloudTracking.endPoint ?? cloudTracking.center ?? start;
  const length = start.distanceTo(end);
  const steps = Math.max(2, Math.ceil(length / Math.max(radius * 0.8, 0.25)) + 1);
  const spheres = [];
  for (let i = 0; i < steps; i += 1) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    spheres.push({ center: start.clone().lerp(end, t), radius });
  }
  return spheres;
}

function getPlayerVolumeSpheres() {
  const base = player.position;
  return [
    { center: new THREE.Vector3(base.x, base.y + getPlayerHeight() * 0.22, base.z), radius: 0.68, weight: 0.24 },
    { center: new THREE.Vector3(base.x, base.y + getPlayerHeight() * 0.52, base.z), radius: 0.86, weight: 0.46 },
    { center: new THREE.Vector3(base.x, base.y + getPlayerHeight() * 0.86, base.z), radius: 0.54, weight: 0.30 },
  ];
}

function computeOverlapAgainstPlayer(cloudTracking) {
  if (!cloudTracking) return 0;
  const playerSpheres = getPlayerVolumeSpheres();
  const capsuleSpheres = createCapsuleSphereSamples(cloudTracking);
  let totalRatio = 0;
  for (const bodySphere of playerSpheres) {
    let combined = 0;
    for (const cloudSphere of capsuleSpheres) {
      const distance = bodySphere.center.distanceTo(cloudSphere.center);
      const overlapVolume = intersectSphereSphereVolume(bodySphere.radius, cloudSphere.radius, distance);
      const ratio = clamp(overlapVolume / Math.max(sphereVolume(bodySphere.radius), 1e-6), 0, 1);
      combined = 1 - (1 - combined) * (1 - ratio);
    }
    totalRatio += combined * bodySphere.weight;
  }
  return clamp(totalRatio, 0, 1);
}

function accumulateNumericMap(map, key, value) {
  if (!map || key == null || !Number.isFinite(value) || value === 0) return;
  map.set(key, (map.get(key) ?? 0) + value);
}

function decayNumericMap(map, delta, halfLife = 0.45) {
  if (!map) return;
  const factor = Math.exp(-Math.max(delta, 0) * Math.LN2 / Math.max(halfLife, 1e-4));
  for (const [key, value] of map.entries()) {
    const next = value * factor;
    if (next <= 1e-4) map.delete(key);
    else map.set(key, next);
  }
}

function applyPlayerCloudDamage(delta) {
  world.playerDamageByNpcThisFrame.clear();
  world.playerOverlapByNpcThisFrame.clear();
  decayNumericMap(world.playerDamageWindowByNpc, delta, 0.5);
  decayNumericMap(world.playerOverlapWindowByNpc, delta, 0.35);
  world.playerLastOverlapRatio = 0;
  world.playerLastDamageTaken = 0;

  if (world.currentOutcome || !world.activeDandelionClouds.length) return;

  let strongestOverlap = 0;
  let damageThisFrame = 0;

  for (const cloud of world.activeDandelionClouds) {
    if (cloud.team !== 'npc' || !cloud?.tracking) continue;
    const overlapRatio = computeOverlapAgainstPlayer(cloud.tracking);
    if (overlapRatio <= 0) continue;

    strongestOverlap = Math.max(strongestOverlap, overlapRatio);
    accumulateNumericMap(world.playerOverlapByNpcThisFrame, cloud.ownerId ?? 'npc', overlapRatio);
    const effectiveDelta = cloud.claimDamageTime('player', delta, config.combat.maxDamageExposurePerCloudTarget);
    if (effectiveDelta <= 0) continue;

    const ageFade = 1 - smoothstep(0.65, 1.0, cloud.tracking.normalizedAge ?? 0);
    const cloudDamageMultiplier = Number.isFinite(cloud.damageMultiplier) ? cloud.damageMultiplier : 1;
    const damage = overlapRatio * config.combat.baseCloudDamagePerSecond * config.combat.npcDamageMultiplier * cloudDamageMultiplier * ageFade * effectiveDelta;
    damageThisFrame += damage;
    accumulateNumericMap(world.playerDamageByNpcThisFrame, cloud.ownerId ?? 'npc', damage);
    accumulateNumericMap(world.playerDamageWindowByNpc, cloud.ownerId ?? 'npc', damage);
    const previousOverlapWindow = world.playerOverlapWindowByNpc.get(cloud.ownerId ?? 'npc') ?? 0;
    world.playerOverlapWindowByNpc.set(cloud.ownerId ?? 'npc', Math.max(previousOverlapWindow, overlapRatio));
  }

  world.playerLastOverlapRatio = strongestOverlap;
  world.playerLastDamageTaken = damageThisFrame;

  if (damageThisFrame > 0) {
    world.playerHp = Math.max(0, world.playerHp - damageThisFrame);
    if (world.playerHp <= 0) {
      endGame('defeat', 'Игрок оказался полностью засыпан вражеским пухом. Текущий seed сохранён: можно немедленно взять реванш на той же карте.');
    }
  }
}

function updateNpcSystem(delta) {
  if (!world.npcSystem) return;
  world.npcSystem.update(delta);

  const npcSnapshots = world.npcSystem.getSnapshots();
  const aliveNpc = npcSnapshots.filter((npc) => !npc.defeated);
  world.nearestNpcSnapshot = npcSnapshots.length
    ? npcSnapshots.slice().sort((a, b) => a.position.distanceToSquared(player.position) - b.position.distanceToSquared(player.position))[0]
    : null;

  if (!world.currentOutcome && npcSnapshots.length > 0 && aliveNpc.length === 0) {
    endGame('victory', '');
  }
}

// =============================================================================
// 20. HUD / СТАТИСТИКА
// =============================================================================
function updateStatsHud() {
  if (!debugTable) {
    if (ui.stats) ui.stats.textContent = '';
    return;
  }

  if (!world.terrain) {
    ui.stats.textContent = 'Мир ещё не построен';
    return;
  }

  const remainingCollectibles = world.collectibleEntries.filter((item) => !item.collected).length;
  const ammoCount = getInventoryCount(config.dandelionWeapon.ammoKey);
  const npcSnapshots = world.npcSystem ? world.npcSystem.getSnapshots() : [];
  const aliveNpcCount = npcSnapshots.filter((npc) => !npc.defeated).length;
  const nearestNpc = world.nearestNpcSnapshot;
  const activeWindClouds = world.activeDandelionClouds.filter((cloud) => cloud.wind?.active).length;
  const lines = [
    `Builder: ${world.activeMapBuilder.name}`,
    `Seed: ${world.seed}`,
    `Player XZ: ${formatNumber(player.position.x, 1)} / ${formatNumber(player.position.z, 1)}`,
    `Ground Y: ${formatNumber(player.position.y, 1)}`,
    `Collectibles: ${remainingCollectibles} / ${world.totalCollectiblesBuilt}`,
    `Одуванчики: ${ammoCount} | Облака: ${world.activeDandelionClouds.length} | Ветровые: ${activeWindClouds}`,
    `HP игрока: ${formatNumber(world.playerHp, 1)} / ${formatNumber(world.playerMaxHp, 1)} | overlap ${formatNumber((world.playerLastOverlapRatio ?? 0) * 100, 0)}% | dmg/frame ${formatNumber(world.playerLastDamageTaken ?? 0, 2)}`,
    `NPC: ${aliveNpcCount} / ${npcSnapshots.length}`,
    ...(nearestNpc ? [`NPC target: ${nearestNpc.label} | HP ${formatNumber(nearestNpc.hp, 1)} / ${formatNumber(nearestNpc.maxHp, 1)} | одуванчики ${nearestNpc.dandelions ?? 0} | overlap ${formatNumber(nearestNpc.lastOverlapRatio * 100, 0)}% | dmg/frame ${formatNumber(nearestNpc.lastDamageTaken ?? 0, 2)} | state ${nearestNpc.state}`] : []),
    `Layers: ${world.layerStats.map((layer) => {
      const mode = layer.instanced ? 'inst' : 'obj';
      const lod = layer.lodLevels ? `/lod${layer.lodLevels}` : '';
      return `${layer.type}:${layer.count}[${mode}${lod}]`;
    }).join(' | ')}`,
  ];

  ui.stats.textContent = lines.join('\n');
}

// =============================================================================
// 21. RENDER LOOP
// =============================================================================
function animate() {
  requestAnimationFrame(animate);

  const rawDelta = Math.min(clock.getDelta(), 0.05);
  const simulationRunning = isSimulationRunning();
  const delta = simulationRunning ? rawDelta : 0;
  if (!simulationRunning) {
    clock.elapsedTime = Math.max(0, clock.elapsedTime - rawDelta);
  }
  const elapsedTime = clock.elapsedTime;

  if (pointerLocked && simulationRunning) {
    tempVectorA.copy(player.position);
    updatePlayerMovement(delta, { world, config, keys, player, clamp });
    if (delta > 0) {
      world.playerVelocity.copy(player.position).sub(tempVectorA).multiplyScalar(1 / delta);
      world.playerVelocity.y = 0;
    } else {
      world.playerVelocity.set(0, 0, 0);
    }
  } else {
    world.playerVelocity.set(0, 0, 0);
  }

  if (simulationRunning) {
    updateWeaponInput();
    updateDynamicScatterSystems(delta);
    updateCollectibles(delta, elapsedTime);
    updateDandelionClouds(delta);
    applyPlayerCloudDamage(delta);
    updateSafeTime(delta);
    updateNpcSystem(delta);
  }

  updateWindshearAlarm(rawDelta);
  updateCombatHud();
  updateStatsHud();
  renderer.render(scene, camera);

  // Одноразовые нажатия живут только один кадр.
  keyPresses.clear();
  mousePresses.clear();
}

// =============================================================================
// 22. RESIZE
// =============================================================================
function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  applyRendererResolutionSettings();
}

// =============================================================================
// 23. ИНИЦИАЛИЗАЦИЯ
// =============================================================================
async function rebuildWorld(options = {}) {
  if (world.isBuilding) return;

  if (options.newSeed) {
    world.seed = Math.floor(Math.random() * 1_000_000_000);
    ui.seedInput.value = String(world.seed);
  }

  await buildWorld();
}

async function init() {
  syncControlsFromConfig();
  readControlsIntoConfig();
  applyRendererResolutionSettings();
  applyDistanceFogSettings();
  updateInventoryHud();
  updateCombatHud();
  showOverlay();
  updateGameplayUiVisibility();
  await buildWorld();
}

// =============================================================================
// 24. EVENTS
// =============================================================================
ui.startButton.addEventListener('click', async () => {
  requestGamePointerLock();
});
ui.rebuildButton.addEventListener('click', () => rebuildWorld());
ui.newSeedButton.addEventListener('click', () => rebuildWorld({ newSeed: true }));
ui.renderQualitySelect?.addEventListener('change', () => {
  readControlsIntoConfig();
  applyRendererResolutionSettings();
});
ui.resumeButton?.addEventListener('click', () => {
  requestGamePointerLock();
});
ui.outcomeActionButton.addEventListener('click', async () => {
  const action = ui.outcomeActionButton.dataset.action;
  if (action === 'menu') {
    await rebuildWorld({ newSeed: true });
    resetOverlayToDefaultMenu();
    showOverlay();
    return;
  }

  if (action === 'revenge') {
    ui.seedInput.value = String(world.seed);
    await rebuildWorld();
    requestGamePointerLock();
  }
});
renderer.domElement.addEventListener('click', () => {
  if (!pointerLocked && !world.currentOutcome && ui.overlay.classList.contains('hidden')) {
    requestGamePointerLock();
  }
});
document.addEventListener('pointerlockchange', updatePointerLockState);
document.addEventListener('mousemove', onMouseMove);
document.addEventListener('mousedown', handleMouseDown);
document.addEventListener('contextmenu', (event) => {
  if (pointerLocked) event.preventDefault();
});
document.addEventListener('keydown', (event) => handleKeyChange(event, true));
document.addEventListener('keyup', (event) => handleKeyChange(event, false));
window.addEventListener('resize', resize);

// =============================================================================
// 25. СТАРТ
// =============================================================================
resize();
animate();
init();
