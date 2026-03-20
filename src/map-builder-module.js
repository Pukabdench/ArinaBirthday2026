import * as THREE from 'three';

export function createMapBuilderModule(deps) {
  const {
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
  } = deps;



  /*
  Локальный helper: переводит разные формы записи позиции в THREE.Vector3.
  Поддерживает:
  - готовый THREE.Vector3
  - массив [x, y, z]
  - объект {x, y, z}
  Если формат не распознан, возвращает копию fallback.
  */
  function toVector3(value, fallback = new THREE.Vector3()) {
    if (value instanceof THREE.Vector3) return value.clone();
    if (Array.isArray(value) && value.length >= 3) {
      return new THREE.Vector3(value[0], value[1], value[2]);
    }
    if (value && typeof value === 'object' && 'x' in value && 'y' in value && 'z' in value) {
      return new THREE.Vector3(value.x, value.y, value.z);
    }
    return fallback.clone();
  }

  /*
  Локальный helper: рекурсивно проставляет флаги теней всем мешам внутри объекта.
  Нужен здесь, чтобы модуль карты не зависел от внешней функции из main.js.
  */
  function applyShadowFlagsRecursively(root, castShadow, receiveShadow) {
    root.traverse((node) => {
      if (!node.isMesh) return;
      node.castShadow = castShadow;
      node.receiveShadow = receiveShadow;
    });
    return root;
  }

  /*
  stablePlacementNoise() — детерминированный "случайный" шум в диапазоне [0, 1]
  для конкретной точки placement'а.

  Зачем нужен:
  - в полосе fogFadeDistance мы не можем плавно менять альфу у InstancedMesh без
    отдельного шейдера;
  - зато можем постепенно "прореживать" дальние экземпляры по стабильному шуму;
  - это визуально ломает жёсткую окружность culling'а и делает край похожим на
    растворение в дымке/тумане.

  Важно: шум стабилен от кадра к кадру, поэтому объекты не мерцают.
  */
  function stablePlacementNoise(seed, x, z) {
    let h = combineSeed(seed >>> 0, `${Math.round(x * 10)}:${Math.round(z * 10)}`);
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507);
    h ^= h >>> 13;
    h = Math.imul(h, 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }


  /*
  weightedSampleWithoutReplacement() — выбирает ровно count кандидатов без повторов,
  но не равновероятно, а с весами. Чем выше weight, тем выше шанс попасть в итоговую
  выборку.

  Зачем это нужно:
  - пользователь иногда хочет ЧЁТКОЕ количество предметов/объектов;
  - при этом хочется сохранить старую логику по клеткам: density/clustering всё ещё
    влияют на "предпочтительность" клетки;
  - поэтому мы сначала генерируем кандидаты по всей карте, а потом берём fixedCount
    штук с weighted random sampling.

  Важно:
  - это не просто первые N элементов и не ранний выход по maxCount;
  - карта просматривается полностью, поэтому предметы больше не набиваются в угол
    только из-за порядка обхода сетки.
  */
  function weightedSampleWithoutReplacement(candidates, count, rng) {
    if (!Number.isFinite(count)) return candidates.slice();
    const targetCount = Math.max(0, Math.floor(count));
    if (targetCount === 0 || candidates.length === 0) return [];
    if (targetCount >= candidates.length) return candidates.slice();

    const scored = [];
    for (const candidate of candidates) {
      const weight = Math.max(1e-6, candidate.weight ?? 0);
      if (weight <= 0) continue;
      const u = Math.max(rng(), 1e-9);
      const key = Math.pow(u, 1 / weight);
      scored.push({ candidate, key });
    }

    scored.sort((a, b) => b.key - a.key);
    return scored.slice(0, targetCount).map((entry) => entry.candidate);
  }

  /*
  Этот модуль хранит только архитектуру карты:
  - базовые классы слоёв;
  - генерацию placement'ов;
  - сборку карты через MapBuilder;
  - готовый пример createDemoMapBuilder().

  Важно: здесь больше НЕТ глобальных множителей растительности из UI.
  Каждый слой растительности задаётся явно и константно прямо в коде.
  То есть каждая .vegetation({ ... }) сама определяет density/clustering.
  */

class BaseLayer {
  constructor(options = {}) {
    this.type = options.type ?? 'base';
    this.id = options.id ?? `layer_${Math.random().toString(36).slice(2, 8)}`;
    this.label = options.label ?? this.id;
    this.enabled = options.enabled ?? true;
    this.modelPath = options.modelPath ?? null;
    this.createMesh = options.createMesh ?? null;
    this.modelScale = options.modelScale ?? 1;
    this.castShadow = options.castShadow ?? true;
    this.receiveShadow = options.receiveShadow ?? true;
  }

  getRequiredModelPaths() {
    return this.modelPath ? [this.modelPath] : [];
  }

  createRenderable(context) {
    if (this.modelPath) {
      return context.assets.createModelInstance(this.modelPath, {
        castShadow: this.castShadow,
        receiveShadow: this.receiveShadow,
      });
    }

    if (this.createMesh) {
      const object = this.createMesh(context, this);
      if (!object) {
        throw new Error(`Layer ${this.id} createMesh() returned nothing.`);
      }
      return applyShadowFlagsRecursively(object, this.castShadow, this.receiveShadow);
    }

    throw new Error(
      `Layer ${this.id} has neither modelPath nor createMesh(). `
      + 'Provide at least one geometry source.',
    );
  }

  resolveInstancedParts(context, descriptor = {}) {
    const modelPath = descriptor.modelPath ?? this.modelPath;
    const createMesh = descriptor.createMesh ?? this.createMesh;
    const sourceScale = descriptor.sourceScale ?? descriptor.modelScale ?? 1;

    if (modelPath) {
      return context.assets.getInstancedModelParts(modelPath, {
        sourceScale,
        castShadow: descriptor.castShadow ?? this.castShadow,
        receiveShadow: descriptor.receiveShadow ?? this.receiveShadow,
      });
    }

    if (createMesh) {
      const root = createMesh(context, this);
      return extractInstancedMeshParts(root, {
        sourceScale,
        castShadow: descriptor.castShadow ?? this.castShadow,
        receiveShadow: descriptor.receiveShadow ?? this.receiveShadow,
      });
    }

    throw new Error(`Layer ${this.id} has no source geometry for instancing.`);
  }
}

/*
ScatterLayer — базовый класс для слоёв, которые много раз повторяются по карте.

Логика генерации:
1) разбиваем карту на сетку cellSize x cellSize;
2) в каждой клетке пробуем один кандидат-объект;
3) добавляем джиттер (случайный сдвиг), чтобы не было ровной сетки;
4) проверяем ограничения (высота, крутизна);
5) считаем вероятность появления через density + clustering.

Дополнительный режим fixedCount:
- если fixedCount == null, всё работает как раньше: объект либо появляется,
  либо нет, а maxCount может рано остановить генерацию;
- если fixedCount задан, карта всё равно идёт по клеткам как раньше, но после
  полного прохода выбирается ровно N лучших/случайных кандидатов с весами,
  зависящими от density/clustering.

Про clustering:
- clustering = 0.0 -> объекты почти равномерно размазаны;
- clustering = 1.0 -> объекты собираются в крупные "пятна".

Новые важные поля для оптимизации:
- instanced      : если true, слой пытается рендериться через InstancedMesh;
- renderDistance : радиус "чёткой" прорисовки слоя;
- fogFadeDistance: дополнительная полоса мягкого растворения после renderDistance;
- lod            : массив уровней детализации вида
                   [{ maxDistance: 25, modelPath: 'high.glb' }, ...]
                   либо без modelPath/createMesh, если нужно использовать
                   базовую модель слоя на данном диапазоне;
- cullUpdateInterval: как часто (в секундах) пересчитывать видимые инстансы.
*/
class ScatterLayer extends BaseLayer {
  constructor(options = {}) {
    super(options);
    this.density = clamp(options.density ?? 0.15, 0, 1);
    this.clustering = clamp(options.clustering ?? 0.25, 0, 1);
    this.cellSize = options.cellSize ?? 10;
    this.maxCount = options.maxCount ?? Infinity;
    // fixedCount — новый режим для случаев, когда нужно жёстко получить ровно N
    // объектов, но при этом сохранить старую клеточную логику распределения.
    //
    // Как это работает:
    // - по всей карте всё так же строится по одному кандидату на клетку;
    // - density/clustering по-прежнему вычисляют "вес" клетки;
    // - затем из всех кандидатов выбирается ровно fixedCount штук.
    //
    // Важная разница с maxCount:
    // - maxCount просто обрывает генерацию, когда лимит уже набран;
    // - fixedCount просматривает ВСЮ карту и только потом делает выборку.
    this.fixedCount = Number.isFinite(options.fixedCount)
      ? Math.max(0, Math.floor(options.fixedCount))
      : null;
    this.minHeight = options.minHeight ?? -Infinity;
    this.maxHeight = options.maxHeight ?? Infinity;
    this.maxSlopeDeg = options.maxSlopeDeg ?? 90;
    this.minScale = options.minScale ?? 1;
    this.maxScale = options.maxScale ?? 1;
    this.alignToGround = clamp(options.alignToGround ?? 0, 0, 1);
    this.randomYaw = options.randomYaw ?? true;
    this.yOffset = options.yOffset ?? 0;
    this.jitter = clamp(options.jitter ?? 0.92, 0, 1);
    this.instanced = options.instanced ?? false;
    this.renderDistance = options.renderDistance ?? Infinity;
    // fogFadeDistance — дополнительная зона после renderDistance, где объекты
    // уже не обязаны оставаться плотными. Вместо жёсткого среза мы начинаем
    // постепенно "прореживать" экземпляры, а финальное исчезновение происходит
    // только в конце этой полосы.
    this.fogFadeDistance = Math.max(0, options.fogFadeDistance ?? config.lighting.scatterCullPadding ?? 0);
    // fogFadeExponent управляет кривой растворения:
    // 1.0  -> линейно,
    // >1.0 -> дольше держим плотность ближе к renderDistance,
    // <1.0 -> быстрее растворяем край.
    this.fogFadeExponent = Math.max(0.05, options.fogFadeExponent ?? 1.35);
    this.lod = Array.isArray(options.lod) ? options.lod.slice() : [];
    this.cullUpdateInterval = options.cullUpdateInterval ?? 0.12;
    this.cullMoveThreshold = options.cullMoveThreshold ?? 4;
  }

  getEffectiveDensity(context) {
    return clamp(this.density, 0, 1);
  }

  getEffectiveClustering(context) {
    return this.clustering;
  }

  passesPlacementRules(context, x, z, y) {
    if (y < this.minHeight || y > this.maxHeight) return false;
    const slopeDeg = context.terrain.sampleSlopeDeg(x, z);
    return slopeDeg <= this.maxSlopeDeg;
  }

  computePlacementChance(context, x, z, rng) {
    const density = this.getEffectiveDensity(context);
    const clustering = this.getEffectiveClustering(context);

    const lowFreqNoise = noise01(
      context.noise.fractal(
        x * lerp(0.004, 0.00065, clustering),
        z * lerp(0.004, 0.00065, clustering),
        3,
        0.55,
        2.0,
      ),
    );

    // hotspot усиливает только самые "подходящие" участки noise-поля.
    const hotspot = smoothstep(0.48, 0.86, lowFreqNoise);

    // При clustering=0 множитель почти единичный.
    // При clustering=1 он резко предпочитает "острова".
    const groupedMultiplier = lerp(1, hotspot * 2.25, clustering);

    // Небольшой микрошум ломает слишком идеальные границы кластеров.
    const microVariation = lerp(0.92, 1.08, rng());

    return clamp(density * groupedMultiplier * microVariation, 0, 1);
  }

  generatePlacements(context) {
    const placements = [];
    const weightedCandidates = [];
    const half = config.worldSize * 0.5;
    const step = this.cellSize;
    const rng = mulberry32(combineSeed(context.seed, this.id));
    const useFixedCount = Number.isFinite(this.fixedCount);

    for (let x = -half; x <= half; x += step) {
      for (let z = -half; z <= half; z += step) {
        if (!useFixedCount && placements.length >= this.maxCount) return placements;

        const jitterStrength = step * 0.5 * this.jitter;
        const px = x + (rng() - 0.5) * jitterStrength * 2;
        const pz = z + (rng() - 0.5) * jitterStrength * 2;

        if (Math.abs(px) > half || Math.abs(pz) > half) continue;

        const py = context.terrain.sampleHeight(px, pz);
        if (!this.passesPlacementRules(context, px, pz, py)) continue;

        const chance = this.computePlacementChance(context, px, pz, rng);
        if (chance <= 0) continue;

        const randomLocalScale = lerp(this.minScale, this.maxScale, rng());
        const finalScale = this.modelScale * randomLocalScale;
        const yawAngle = this.randomYaw ? rng() * Math.PI * 2 : 0;

        const position = new THREE.Vector3(px, py + this.yOffset, pz);
        const rotation = new THREE.Quaternion().setFromAxisAngle(worldUp, yawAngle);
        context.terrain.sampleNormal(px, pz, tempVectorA);
        const groundRotation = new THREE.Quaternion().setFromUnitVectors(worldUp, tempVectorA);
        rotation.slerp(groundRotation, this.alignToGround);

        const placement = {
          x: px,
          y: py + this.yOffset,
          z: pz,
          position,
          rotation,
          scale: finalScale,
          yawAngle,
          phase: rng() * Math.PI * 2,
        };

        if (useFixedCount) {
          weightedCandidates.push({ placement, weight: chance });
          continue;
        }

        if (rng() > chance) continue;
        placements.push(placement);
      }
    }

    if (!useFixedCount) {
      return placements;
    }

    const selectedCandidates = weightedSampleWithoutReplacement(
      weightedCandidates,
      this.fixedCount,
      rng,
    );

    return selectedCandidates.map((entry) => entry.placement);
  }

  applyPlacementTransform(object, placement) {
    object.position.copy(placement.position);
    object.scale.multiplyScalar(placement.scale);
    object.quaternion.copy(placement.rotation);
  }
}

/*
DynamicInstancedScatterSystem — runtime-система для массовых статических объектов
(деревья, трава, камни), которые рендерятся через InstancedMesh.

Что она делает:
1) хранит заранее сгенерированные placements слоя;
2) держит 1..N LOD-уровней (каждый уровень = набор instanced mesh по частям модели);
3) раз в небольшой интервал пересчитывает, какие экземпляры видимы рядом с игроком;
4) заполняет матрицы instanced mesh только для видимых объектов.

Это резко уменьшает draw calls по сравнению с сотнями/тысячами отдельных Group/Mesh.
*/
class DynamicInstancedScatterSystem {
  constructor(layer, context, placements) {
    this.layer = layer;
    this.context = context;
    this.placements = placements;
    this.group = new THREE.Group();
    this.group.name = `instanced:${layer.id}`;

    this.lastRefreshPosition = new THREE.Vector3(Number.POSITIVE_INFINITY, 0, Number.POSITIVE_INFINITY);
    this.refreshCooldown = 0;

    const descriptors = (layer.lod.length ? layer.lod : [{ maxDistance: layer.renderDistance }])
      .map((entry) => ({
        maxDistance: entry.maxDistance ?? layer.renderDistance,
        modelPath: entry.modelPath,
        createMesh: entry.createMesh,
        sourceScale: entry.sourceScale ?? entry.modelScale ?? 1,
        castShadow: entry.castShadow,
        receiveShadow: entry.receiveShadow,
      }))
      .sort((a, b) => a.maxDistance - b.maxDistance);

    const nominalRenderDistance = Number.isFinite(layer.renderDistance) ? layer.renderDistance : Infinity;
    const fadeCullDistance = nominalRenderDistance + layer.fogFadeDistance;

    if (descriptors.length > 0) {
      descriptors[descriptors.length - 1].maxDistance = Math.max(
        descriptors[descriptors.length - 1].maxDistance,
        fadeCullDistance,
      );
    }

    // clearDistance — радиус, внутри которого слой рисуется без дополнительного
    // прореживания. cullDistance — абсолютная граница, после которой экземпляр
    // вообще не показывается.
    this.clearDistance = nominalRenderDistance;
    this.cullDistance = fadeCullDistance;

    this.levels = descriptors.map((descriptor, levelIndex) => {
      const parts = layer.resolveInstancedParts(context, descriptor);
      const meshes = parts.map((part, partIndex) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, placements.length);
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.castShadow = part.castShadow;
        mesh.receiveShadow = part.receiveShadow;
        mesh.name = `${layer.id}:lod${levelIndex}:part${partIndex}`;
        this.group.add(mesh);
        return { mesh, localMatrix: part.localMatrix };
      });

      return {
        maxDistance: descriptor.maxDistance,
        meshes,
      };
    });
  }

  pickLevel(distance) {
    for (const level of this.levels) {
      if (distance <= level.maxDistance) return level;
    }
    return null;
  }

  needsRefresh(delta, playerPosition) {
    this.refreshCooldown -= delta;
    if (this.refreshCooldown <= 0) return true;
    return playerPosition.distanceToSquared(this.lastRefreshPosition) >= this.layer.cullMoveThreshold ** 2;
  }

  refresh(playerPosition) {
    const cullDistanceSq = this.cullDistance * this.cullDistance;

    for (const level of this.levels) {
      level.visibleCount = 0;
    }

    for (const placement of this.placements) {
      const distanceSq = placement.position.distanceToSquared(playerPosition);
      if (distanceSq > cullDistanceSq) continue;

      const distance = Math.sqrt(distanceSq);

      // Полоса мягкого растворения около границы renderDistance.
      // Вместо резкой окружности culling'а мы уменьшаем долю оставшихся объектов
      // по мере роста расстояния. Для InstancedMesh это дешёвая альтернатива
      // полноценному shader-based fade.
      if (distance > this.clearDistance && this.layer.fogFadeDistance > 0) {
        const fadeT = smoothstep(this.clearDistance, this.cullDistance, distance);
        const keepProbability = Math.pow(1 - fadeT, this.layer.fogFadeExponent);
        const stableNoise = stablePlacementNoise(this.context.seed ^ combineSeed(this.context.seed, this.layer.id), placement.x, placement.z);
        if (stableNoise > keepProbability) continue;
      }

      const level = this.pickLevel(distance);
      if (!level) continue;

      tempScaleVector.setScalar(placement.scale);
      tempMatrixA.compose(placement.position, placement.rotation, tempScaleVector);

      const targetIndex = level.visibleCount;
      for (const part of level.meshes) {
        tempMatrixB.multiplyMatrices(tempMatrixA, part.localMatrix);
        part.mesh.setMatrixAt(targetIndex, tempMatrixB);
      }
      level.visibleCount += 1;
    }

    for (const level of this.levels) {
      for (const part of level.meshes) {
        part.mesh.count = level.visibleCount;
        part.mesh.instanceMatrix.needsUpdate = true;
      }
    }

    this.lastRefreshPosition.copy(playerPosition);
    this.refreshCooldown = this.layer.cullUpdateInterval;
  }

  update(delta, playerPosition) {
    if (!this.needsRefresh(delta, playerPosition)) return;
    this.refresh(playerPosition);
  }
}

class VegetationLayer extends ScatterLayer {
  constructor(options = {}) {
    super({ ...options, type: 'vegetation' });
  }

  async build(context) {
    if (!this.enabled) return;

    const placements = this.generatePlacements(context);

    if (this.instanced) {
      const system = new DynamicInstancedScatterSystem(this, context, placements);
      system.refresh(context.getAnchorPosition('spawn'));
      context.registerDynamicScatterSystem(this, system, placements.length);
      return;
    }

    const group = new THREE.Group();
    group.name = `vegetation:${this.id}`;

    for (const placement of placements) {
      const object = this.createRenderable(context);
      this.applyPlacementTransform(object, placement);
      group.add(object);
    }

    context.registerGroup(this, group, placements.length);
  }
}

class CollectibleLayer extends ScatterLayer {
  constructor(options = {}) {
    super({ ...options, type: 'collectible' });
    this.inventoryKey = options.inventoryKey ?? this.id;
    this.amount = options.amount ?? 1;
    this.pickupRadius = options.pickupRadius ?? 8;
    this.spinSpeed = options.spinSpeed ?? 1.1;
    this.floatAmplitude = options.floatAmplitude ?? 0.45;
    this.floatSpeed = options.floatSpeed ?? 1.7;
  }

  async build(context) {
    if (!this.enabled) return;

    const placements = this.generatePlacements(context);
    const group = new THREE.Group();
    group.name = `collectibles:${this.id}`;

    for (const placement of placements) {
      const object = this.createRenderable(context);
      this.applyPlacementTransform(object, placement);
      group.add(object);

      context.registerCollectible({
        layer: this,
        object,
        position: object.position.clone(),
        baseY: object.position.y,
        phase: placement.phase,
      });
    }

    context.registerGroup(this, group, placements.length);
  }
}

/*
LandmarkLayer — одиночные объекты.

Способы задания позиции:
- position: [x, y, z] / THREE.Vector3 / {x, y, z}
- anchor: 'spawn' | 'highest' | 'lowest' | 'center'

Если position задан с y=0 и stickToGround=true, то y будет пересчитан по земле.
Это удобно, когда ты хочешь сказать: "поставь лагерь примерно вот здесь".
*/
class LandmarkLayer extends BaseLayer {
  constructor(options = {}) {
    super({ ...options, type: 'landmark' });
    this.anchor = options.anchor ?? null;
    this.position = options.position ?? null;
    this.offset = toVector3(options.offset ?? [0, 0, 0]);
    this.rotationY = options.rotationY ?? 0;
    this.stickToGround = options.stickToGround ?? true;
  }

  resolvePosition(context) {
    if (this.position) {
      const pos = toVector3(this.position);
      if (this.stickToGround) {
        pos.y = context.terrain.sampleHeight(pos.x, pos.z);
      }
      pos.add(this.offset);
      return pos;
    }

    const anchorPosition = context.getAnchorPosition(this.anchor ?? 'center');
    return anchorPosition.clone().add(this.offset);
  }

  async build(context) {
    if (!this.enabled) return;

    const object = this.createRenderable(context);
    const worldPosition = this.resolvePosition(context);
    object.position.copy(worldPosition);
    object.scale.multiplyScalar(this.modelScale);
    object.rotation.y = this.rotationY;

    context.registerLandmark({ layer: this, object });
    context.registerGroup(this, object, 1);
  }
}



/*
NpcLayer — базовый слой для живых NPC.

По позиционированию он похож на LandmarkLayer:
- можно задать position;
- можно использовать anchor: spawn / highest / lowest / center;
- можно прилипать к земле.

Отличие в том, что помимо самого renderable-объекта слой регистрирует runtime-данные:
- animationClips — имена клипов glb-модели;
- behavior       — будущая логика поведения;
- cloudVolume    — как натягивать облако поражения на модель;
- movement       — заготовка под скорость/поворот;
- cloudAttack    — заготовка под ответные облачные атаки NPC.
*/
class NpcLayer extends LandmarkLayer {
  constructor(options = {}) {
    super({ ...options, type: 'npc' });
    this.animationClips = options.animationClips ?? {};
    this.behavior = options.behavior ?? { type: 'idle' };
    this.cloudVolume = options.cloudVolume ?? null;
    this.cloudThreshold = options.cloudThreshold ?? null;
    this.exposurePerSecond = options.exposurePerSecond ?? null;
    this.maxHp = options.maxHp ?? null;
    this.damageMultiplier = options.damageMultiplier ?? null;
    this.movement = options.movement ?? null;
    this.cloudAttack = options.cloudAttack ?? null;
    this.npcDandelionsStartCount = options.npcDandelionsStartCount ?? null;
    this.npcDandelionCapacity = options.npcDandelionCapacity ?? null;
  }

  async build(context) {
    if (!this.enabled) return;

    const object = this.createRenderable(context);
    const worldPosition = this.resolvePosition(context);
    object.position.copy(worldPosition);
    object.scale.multiplyScalar(this.modelScale);
    object.rotation.y = this.rotationY;

    context.registerNpc({
      layer: this,
      object,
      animationClips: this.animationClips,
      behavior: this.behavior,
      cloudVolume: this.cloudVolume,
      cloudThreshold: this.cloudThreshold,
      exposurePerSecond: this.exposurePerSecond,
      maxHp: this.maxHp,
      damageMultiplier: this.damageMultiplier,
      movement: this.movement,
      cloudAttack: this.cloudAttack,
      npcDandelionsStartCount: this.npcDandelionsStartCount,
      npcDandelionCapacity: this.npcDandelionCapacity,
    });
    context.registerGroup(this, object, 1);
  }
}

/*
MapBuilder — основной пользовательский API.

Он позволяет очень лаконично описывать карту:

const builder = new MapBuilder('Demo')
  .vegetation({...})
  .collectibles({...})
  .landmark({...})
  .npc({...});

Дальше build(context) просто проходит по слоям по порядку и строит их.
*/
class MapBuilder {
  constructor(name = 'Unnamed map') {
    this.name = name;
    this.layers = [];
  }

  add(layer) {
    this.layers.push(layer);
    return this;
  }

  vegetation(options) {
    return this.add(new VegetationLayer(options));
  }

  collectibles(options) {
    return this.add(new CollectibleLayer(options));
  }

  landmark(options) {
    return this.add(new LandmarkLayer(options));
  }

  npc(options) {
    return this.add(new NpcLayer(options));
  }

  collectModelPaths() {
    const allPaths = [];

    for (const layer of this.layers) {
      allPaths.push(...layer.getRequiredModelPaths());
      if (Array.isArray(layer.lod)) {
        for (const entry of layer.lod) {
          if (entry?.modelPath) allPaths.push(entry.modelPath);
        }
      }
    }

    return [...new Set(allPaths.filter(Boolean))];
  }

  async build(context) {
    for (const layer of this.layers) {
      await layer.build(context);
      // Маленькая пауза между слоями даёт браузеру шанс обновить кадр,
      // чтобы UI не "замирал" на тяжёлой сборке.
      await nextFrame();
    }
  }
}

// =============================================================================
// 12. КОНТЕКСТ СБОРКИ КАРТЫ
// =============================================================================
// BuildContext — это объект-связка между конструктором карты и низким уровнем.
// Через него layer'ы получают доступ к:
// - terrain sampling;
// - assets;
// - anchor points;
// - регистрации групп / предметов / landmarks.
class MapBuildContext {
  constructor(builder) {
    this.builder = builder;
    this.seed = world.seed;
    this.assets = world.assets;
    this.noise = world.noise;
    this.terrain = world.terrain;

  }

  getAnchorPosition(anchorName) {
    const key = anchorName ?? 'center';
    const anchors = this.terrain.anchors;

    switch (key) {
      case 'spawn':
        return anchors.spawn.clone();
      case 'highest':
      case 'highestPoint':
        return anchors.highest.clone();
      case 'lowest':
      case 'lowestPoint':
        return anchors.lowest.clone();
      case 'center':
      default:
        return anchors.center.clone();
    }
  }

  registerGroup(layer, objectOrGroup, count) {
    world.mapRoot.add(objectOrGroup);
    world.layerStats.push({
      type: layer.type,
      id: layer.id,
      label: layer.label,
      count,
      modelPath: layer.modelPath,
      instanced: layer.instanced ?? false,
      renderDistance: Number.isFinite(layer.renderDistance) ? layer.renderDistance : null,
      fogFadeDistance: Number.isFinite(layer.fogFadeDistance) ? layer.fogFadeDistance : null,
      lodLevels: Array.isArray(layer.lod) ? layer.lod.length : 0,
    });
  }

  registerDynamicScatterSystem(layer, system, count) {
    world.dynamicScatterSystems.push(system);
    this.registerGroup(layer, system.group, count);
  }

  registerCollectible({ layer, object, position, baseY, phase }) {
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
      position,
      baseY,
      phase,
      collected: false,
    });
    world.totalCollectiblesBuilt += 1;
  }

  registerLandmark({ layer, object }) {
    world.landmarkEntries.push({
      id: layer.id,
      label: layer.label,
      object,
    });
  }

  registerNpc({ layer, object, animationClips, behavior, cloudVolume, cloudThreshold, exposurePerSecond, maxHp, damageMultiplier, movement, cloudAttack, npcDandelionsStartCount, npcDandelionCapacity }) {
    world.npcEntries.push({
      id: layer.id,
      label: layer.label,
      object,
      animationClips,
      behavior,
      cloudVolume,
      cloudThreshold,
      exposurePerSecond,
      maxHp,
      damageMultiplier,
      movement,
      cloudAttack,
      npcDandelionsStartCount,
      npcDandelionCapacity,
    });
  }
}

// =============================================================================
// 13. ВСТРОЕННЫЕ ФАБРИКИ MESH'ЕЙ
// =============================================================================
// Эти функции нужны как "шаблоны" для случаев, когда ты ещё не подготовил
// реальную внешнюю модель в Blender. Потом ты можешь заменить createMesh на
// modelPath без изменения логики слоя.

function setShadowsRecursively(root) {
  root.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return root;
}

function builtinCreateDandelionPickupMesh() {
  const group = new THREE.Group();

  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.09, 2.8, 8),
    new THREE.MeshStandardMaterial({ color: 0x74a54e, roughness: 0.95 }),
  );
  stem.position.y = 1.2;
  group.add(stem);

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xd6c84d, emissive: 0x655814, emissiveIntensity: 0.08, roughness: 0.9 }),
  );
  core.position.y = 2.55;
  group.add(core);

  for (let i = 0; i < 18; i += 1) {
    const angle = (i / 18) * Math.PI * 2;
    const filament = new THREE.Mesh(
      new THREE.CylinderGeometry(0.016, 0.016, 0.8, 5),
      new THREE.MeshStandardMaterial({ color: 0xf3f7ff, roughness: 1.0 }),
    );
    filament.position.set(Math.cos(angle) * 0.18, 2.95, Math.sin(angle) * 0.18);
    filament.rotation.z = Math.PI * 0.5;
    filament.rotation.y = angle;
    group.add(filament);
  }

  return setShadowsRecursively(group);
}

function builtinCreateCrystalPickupMesh() {
  const group = new THREE.Group();

  const gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(1.2, 0),
    new THREE.MeshStandardMaterial({ color: 0x8fe8ff, emissive: 0x1e8aff, emissiveIntensity: 0.28, roughness: 0.25 }),
  );
  gem.position.y = 1.5;
  group.add(gem);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.36, 0.5, 10),
    new THREE.MeshStandardMaterial({ color: 0x6b4d2d, roughness: 0.95 }),
  );
  base.position.y = 0.25;
  group.add(base);

  return setShadowsRecursively(group);
}

function builtinCreateBeaconMesh() {
  const group = new THREE.Group();

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.65, 0.85, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0x7e838b, roughness: 0.82 }),
  );
  pole.position.y = 6;
  group.add(pole);

  const crystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(2.2, 0),
    new THREE.MeshStandardMaterial({ color: 0xa8ecff, emissive: 0x2f8cff, emissiveIntensity: 0.45, roughness: 0.22 }),
  );
  crystal.position.y = 13.2;
  group.add(crystal);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(3.6, 4.4, 2.2, 16),
    new THREE.MeshStandardMaterial({ color: 0x615646, roughness: 1.0 }),
  );
  base.position.y = 1.1;
  group.add(base);

  return setShadowsRecursively(group);
}

function builtinCreateCampMesh() {
  const group = new THREE.Group();

  const tent = new THREE.Mesh(
    new THREE.ConeGeometry(5.2, 5.8, 4),
    new THREE.MeshStandardMaterial({ color: 0x7e7a53, roughness: 0.92 }),
  );
  tent.rotation.y = Math.PI * 0.25;
  tent.position.y = 2.9;
  tent.scale.set(1.2, 1, 1.5);
  group.add(tent);

  const fireRing = new THREE.Mesh(
    new THREE.TorusGeometry(2.2, 0.24, 8, 18),
    new THREE.MeshStandardMaterial({ color: 0x6d5a43, roughness: 1.0 }),
  );
  fireRing.rotation.x = Math.PI * 0.5;
  fireRing.position.y = 0.22;
  group.add(fireRing);

  return setShadowsRecursively(group);
}



function builtinCreatePracticeNpcMesh() {
  const group = new THREE.Group();

  const robe = new THREE.Mesh(
    new THREE.CapsuleGeometry(1.1, 3.2, 6, 10),
    new THREE.MeshStandardMaterial({ color: 0x7c9670, roughness: 0.96 }),
  );
  robe.position.y = 3.1;
  group.add(robe);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.86, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0xd9c7a8, roughness: 0.92 }),
  );
  head.position.y = 6.35;
  group.add(head);

  const hat = new THREE.Mesh(
    new THREE.ConeGeometry(1.1, 2.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x6f7b48, roughness: 0.92 }),
  );
  hat.position.y = 7.45;
  group.add(hat);

  const leftArm = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.22, 2.1, 4, 6),
    new THREE.MeshStandardMaterial({ color: 0x6d8b5e, roughness: 0.95 }),
  );
  leftArm.position.set(-1.25, 4.5, 0.2);
  leftArm.rotation.z = Math.PI * 0.22;
  group.add(leftArm);

  const rightArm = leftArm.clone();
  rightArm.position.x = 1.25;
  rightArm.rotation.z = -Math.PI * 0.22;
  group.add(rightArm);

  const staff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.1, 5.8, 7),
    new THREE.MeshStandardMaterial({ color: 0x6d5636, roughness: 0.96 }),
  );
  staff.position.set(1.85, 3.3, 0.25);
  staff.rotation.z = Math.PI * 0.08;
  group.add(staff);

  return setShadowsRecursively(group);
}

function builtinCreateObeliskMesh() {
  const group = new THREE.Group();

  const shaft = new THREE.Mesh(
    new THREE.BoxGeometry(4, 16, 4),
    new THREE.MeshStandardMaterial({ color: 0x898b90, roughness: 0.75 }),
  );
  shaft.position.y = 8;
  group.add(shaft);

  const cap = new THREE.Mesh(
    new THREE.ConeGeometry(3.2, 4.6, 4),
    new THREE.MeshStandardMaterial({ color: 0x9ea2a9, roughness: 0.72 }),
  );
  cap.position.y = 18.3;
  cap.rotation.y = Math.PI * 0.25;
  group.add(cap);

  return setShadowsRecursively(group);
}

// =============================================================================
// 14. MAP CONSTRUCTOR AREA — САМАЯ ВАЖНАЯ СЕКЦИЯ ДЛЯ РЕДАКТИРОВАНИЯ
// =============================================================================
/*
Как использовать этот конструктор:

1) Растительность / массовый декор:
   builder.vegetation({
     id: 'grass',
     label: 'Трава',
     modelPath: './assets/models/my_grass.glb',
     modelScale: 2.8,      // базовый масштаб модели
     minScale: 0.8,        // случайный разброс экземпляров
     maxScale: 1.35,
     density: 0.35,
     clustering: 0.6,
     ...
   })

   Важная заметка про листья / траву / ёлки:
   - если у модели текстуры с прозрачным PNG-альфа-каналом, движок теперь
     автоматически пытается это распознать и включает alpha-cutout режим;
   - это особенно полезно для tree/grass-card моделей из Blender.

2) Предметы:
   builder.collectibles({
     id: 'berries',
     label: 'Ягоды',
     inventoryKey: 'berries',
     amount: 1,
     modelPath: './assets/models/berry.glb',
     // или createMesh: createBerryMesh,
   })

3) Одиночные объекты:
   builder.landmark({
     id: 'peak_obelisk',
     label: 'Обелиск',
     anchor: 'highest',
     modelScale: 1.4,
     createMesh: builtinCreateObeliskMesh,
   })

Смысл modelScale:
- это постоянный множитель масштаба для ВСЕЙ модели слоя;
- удобно, если модель из Blender пришла "в неправильных единицах".
*/
function createDemoMapBuilder() {
  return new MapBuilder('Demo terrain builder')
    .vegetation({
      id: 'grass_layer',
      label: 'Трава',
      modelPath: './assets/models/grass_tuft.glb',
      modelScale: 2.8,
      minScale: 0.9,
      maxScale: 1.55,
      density: 0.32,
      clustering: 0.55,
      cellSize: 10,
      maxCount: 420,
      minHeight: config.waterLevel + 1,
      maxHeight: config.maxHeight * 0.7,
      maxSlopeDeg: 32,
      alignToGround: 0.42,
      yOffset: 0.02,
      // Конкретный патч оптимизации:
      // одинаковые экземпляры травы теперь рендерятся через InstancedMesh.
      // Для тяжёлых ёлок / камней используй тот же набор опций.
      instanced: true,
      renderDistance: 120,
      fogFadeDistance: 42,
      fogFadeExponent: 1.45,
      cullUpdateInterval: 0.1,
      cullMoveThreshold: 3,
      castShadow: false,
      receiveShadow: false,
      // Пример LOD-конфигурации для дерева:
      // lod: [
      //   { maxDistance: 22 },
      //   { maxDistance: 52, modelPath: './assets/models/tree_mid.glb' },
      //   { maxDistance: 90, modelPath: './assets/models/tree_low.glb', sourceScale: 1.0 },
      // ],
    })
    .vegetation({
      id: 'grass_2',
      label: 'Трава',
      modelPath: './assets/models/grass_tuft.glb',
      modelScale: 5.4,
      minScale: 0.85,
      maxScale: 1.45,
      density: 0.08,
      clustering: 0.72,
      cellSize: 20,
      maxCount: 180,
      minHeight: config.waterLevel + 2,
      maxHeight: config.maxHeight * 0.88,
      maxSlopeDeg: 28,
      alignToGround: 0.18,
      yOffset: 0.02,
      instanced: true,
      renderDistance: 140,
      fogFadeDistance: 55,
      fogFadeExponent: 1.35,
      cullUpdateInterval: 0.15,
      cullMoveThreshold: 4,
      castShadow: false,
      receiveShadow: false,
    })
    .collectibles({
      id: 'dandelion_pickups',
      label: 'Одуванчик',
      inventoryKey: 'dandelion',
      amount: 1,
      modelPath: './assets/models/dandelion.glb',
      modelScale: 10,
      minScale: 0.85,
      maxScale: 1.25,
      density: 0.038,
      clustering: 0.82,
      cellSize: 24,
      fixedCount: 48,
      minHeight: config.waterLevel + 2,
      maxHeight: config.maxHeight * 0.8,
      maxSlopeDeg: 24,
      pickupRadius: 8,
      floatAmplitude: 0.55,
      floatSpeed: 1.9,
      spinSpeed: 0.0,
      yOffset: 0.3,
    })

.npc({
  id: 'practice_npc',
  label: 'Арина',
  anchor: 'spawn',
  offset: [32, 0, -18],
  modelPath: './assets/models/arina_faced2.glb',
  modelScale: 6.5,
  rotationY: Math.PI * 0.18,
  behavior: {
    type: 'duelistFsm',
    approachDistanceMin: 12,
    approachDistanceMax: 22,
    hideDistanceMin: 24,
    hideDistanceMax: 46,
    retreatDistanceMin: 22,
    retreatDistanceMax: 40,
    patrolApproachDuration: 3.8,
    patrolHideDuration: 3.1,
    patrolAttackChance: 0.42,
    repeatAttackProbability: 0.36,
    combatReengageProbability: 0.52,
    // Opportunistic shots on the move: NPC can exploit a weak spot without
    // fully stopping for windup, but these shots are intentionally weaker.
    runningShotEnabled: true,
    runningShotChance: 0.46,
    runningShotMinOverlap: 0.055,
    playerShotNoticeWindow: 2.2,
    playerShotNoticeRange: 80,
    successfulAttackDamageThreshold: 0.65,
    flankTriggerOverlapThreshold: 0.09,
    flankTriggerDamageThreshold: 0.14,
    flankPhaseDuration: 1.15,
    gatherSearchRadius: 160,
    gatherCollectRadius: 11.5,
    gatherEnterBaseChancePerSecond: 0.025,
    gatherScarcityBoostPerSecond: 0.95,
    gatherUrgencyExponent: 2.25,
    desiredCombatReserve: 3,

    // Awareness / "уход в туман":
    // если игрок ушёл далеко в туман, NPC временно выходит из активного боя,
    // патрулирует и/или добирает одуванчики "про запас" до advanceCount.
    loseSightDistance: config.lighting.fogStartDistance + config.lighting.fogFadeLength * 0.25,
    reacquireDistance: config.lighting.fogStartDistance + config.lighting.fogFadeLength * 0.10,
    combatDisengageDelay: 0.75,
    dandelionAdvanceCount: 8,
  },
  maxHp: 100,
  cloudThreshold: 42,
  exposurePerSecond: 26,
  cloudVolume: {
    fitScale: [1.05, 1.0, 1.05],
    sampleCount: 6,
    minSphereRadius: 0.58,
    debug: false,
  },
  // Если здесь указать modelPath на анимированный glb, можно задать имена
  // клипов так:
  // animationClips: {
  //   idle: ['Idle'],
  //   move: ['Run', 'Walk'],
  //   attack: ['Attack'],
  //   defeated: ['Death'],
  // },
  movement: {
    walkSpeed: 41,
    runSpeed: 73,
    turnSpeed: 5.2,
    acceleration: 24,
  },
  npcDandelionsStartCount: 0,
  npcDandelionCapacity: 20,
  cloudAttack: {
    cooldown: 0.7,
    range: 16,
    attackStopDistance: 10.5,
    repeatAttackProbability: 0.42,
    muzzleHeightFactor: 0.7,
    runningShotDamageScale: 0.76,
    runningShotParticleScale: 0.82,
    runningShotLifeScale: 0.86,
    runningShotRadiusScale: 1.8,
    runningShotCooldownScale: 1.08,
    runningShotDecisionInterval: 0.24,
    runningShotMinOverlap: 0.035,
    runningShotChance: 0.6
  },
})
    .landmark({
      id: 'spawn_beacon',
      label: 'Маяк спавна',
      anchor: 'spawn',
      createMesh: builtinCreateBeaconMesh,
      modelScale: 1.05,
      offset: [12, 0, 10],
    })
    .landmark({
      id: 'peak_obelisk',
      label: 'Обелиск на вершине',
      anchor: 'highest',
      createMesh: builtinCreateObeliskMesh,
      modelScale: 1.3,
      offset: [0, 0, 0],
      rotationY: Math.PI * 0.1,
    })
    .landmark({
      id: 'camp_fixed_coords',
      label: 'Лагерь',
      position: [150, 0, -120],
      stickToGround: true,
      createMesh: builtinCreateCampMesh,
      modelScale: 1.0,
      rotationY: Math.PI * 0.15,
    });
}



  return { BaseLayer, ScatterLayer, VegetationLayer, CollectibleLayer, LandmarkLayer, NpcLayer, MapBuilder, MapBuildContext, createDemoMapBuilder };
}
