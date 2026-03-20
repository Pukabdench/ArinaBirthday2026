import * as THREE from 'three';

export function createNpcSystemModule(deps) {
  const {
    world,
    config,
    player,
    getPlayerViewDirection,
    getPlayerHeight,
    spawnWeaponCloud,
    collectWorldDandelion,
  } = deps;

  const tempVectorA = new THREE.Vector3();
  const tempVectorB = new THREE.Vector3();
  const tempVectorC = new THREE.Vector3();
  const tempSphere = new THREE.Sphere();
  const worldUp = new THREE.Vector3(0, 1, 0);

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

  function pickFirstDefined(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  }

  function toVector3(value, fallback = new THREE.Vector3(1, 1, 1)) {
    if (value instanceof THREE.Vector3) return value.clone();
    if (Array.isArray(value) && value.length >= 3) return new THREE.Vector3(value[0], value[1], value[2]);
    if (value && typeof value === 'object' && 'x' in value && 'y' in value && 'z' in value) {
      return new THREE.Vector3(value.x, value.y, value.z);
    }
    return fallback.clone();
  }

  function sphereVolume(radius) {
    return (4 / 3) * Math.PI * radius * radius * radius;
  }

  function intersectSphereSphereVolume(radiusA, radiusB, distance) {
    const r1 = radiusA;
    const r2 = radiusB;

    if (distance >= r1 + r2) return 0;
    if (distance <= Math.abs(r1 - r2)) {
      return sphereVolume(Math.min(r1, r2));
    }

    const sum = r1 + r2 - distance;
    const numerator = Math.PI * sum * sum * (
      distance * distance + 2 * distance * (r1 + r2) - 3 * (r1 - r2) * (r1 - r2)
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
      spheres.push({
        center: start.clone().lerp(end, t),
        radius,
      });
    }

    return spheres;
  }

  function computeBoundingBoxInRootLocalSpace(root) {
    root.updateWorldMatrix(true, true);
    const inverseRootWorld = root.matrixWorld.clone().invert();
    const localBounds = new THREE.Box3();
    let hasAnyMesh = false;

    root.traverse((node) => {
      if (!node.isMesh || !node.geometry) return;
      if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();

      const nodeBoundingBox = node.geometry.boundingBox.clone();
      const nodeLocalToRoot = inverseRootWorld.clone().multiply(node.matrixWorld);
      nodeBoundingBox.applyMatrix4(nodeLocalToRoot);

      if (!hasAnyMesh) {
        localBounds.copy(nodeBoundingBox);
        hasAnyMesh = true;
      } else {
        localBounds.union(nodeBoundingBox);
      }
    });

    if (!hasAnyMesh || localBounds.isEmpty()) {
      localBounds.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
    }

    return localBounds;
  }

  function createLocalVolumeSpheresFromBounds(localBounds, options = {}) {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    localBounds.getSize(size);
    localBounds.getCenter(center);

    const fitScale = toVector3(options.fitScale ?? [1, 1, 1]);
    const halfExtents = size.multiplyScalar(0.5).multiply(fitScale);
    const rx = Math.max(halfExtents.x, 0.08);
    const ry = Math.max(halfExtents.y, 0.08);
    const rz = Math.max(halfExtents.z, 0.08);

    const sampleCount = Math.max(1, Math.floor(options.sampleCount ?? 5));
    const minSphereRadius = Math.max(0.05, options.minSphereRadius ?? Math.min(rx, rz) * 0.35);

    const localSpheres = [];
    let totalVolume = 0;

    for (let i = 0; i < sampleCount; i += 1) {
      const t = sampleCount === 1 ? 0.5 : i / (sampleCount - 1);
      const yNorm = lerp(-1, 1, t);
      const crossSectionFactor = Math.sqrt(Math.max(0.12, 1 - yNorm * yNorm));
      const localRadius = Math.max(minSphereRadius, Math.min(rx, rz) * crossSectionFactor);
      const localY = center.y + yNorm * ry;

      const sphere = {
        center: new THREE.Vector3(center.x, localY, center.z),
        radius: localRadius,
        volume: sphereVolume(localRadius),
        weight: 0,
      };
      totalVolume += sphere.volume;
      localSpheres.push(sphere);
    }

    for (const sphere of localSpheres) {
      sphere.weight = sphere.volume / Math.max(totalVolume, 1e-6);
    }

    return {
      localBounds,
      localCenter: center,
      localSpheres,
      approximateRadius: Math.sqrt(rx * rx + ry * ry + rz * rz),
    };
  }

  function normalizeAnimationConfig(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function getPlayerForwardPlanar() {
    const direction = getPlayerViewDirection ? getPlayerViewDirection() : new THREE.Vector3(0, 0, -1);
    direction.y = 0;
    if (direction.lengthSq() < 1e-8) direction.set(0, 0, -1);
    return direction.normalize();
  }

  function getConfiguredPlayerHeight() {
    return getPlayerHeight ? getPlayerHeight() : (config.player?.playerHeight ?? config.player?.eyeHeight ?? 6);
  }

  function getPlayerVolumeSpheresAt(position) {
    const height = getConfiguredPlayerHeight();
    return [
      { center: new THREE.Vector3(position.x, position.y + height * 0.22, position.z), radius: 0.68, weight: 0.24 },
      { center: new THREE.Vector3(position.x, position.y + height * 0.52, position.z), radius: 0.86, weight: 0.46 },
      { center: new THREE.Vector3(position.x, position.y + height * 0.86, position.z), radius: 0.54, weight: 0.30 },
    ];
  }

  function computeCloudOverlapWithWeightedSpheres(cloudTracking, weightedSpheres) {
    if (!cloudTracking) return 0;
    if (cloudTracking.boundingSphere && weightedSpheres?.length) {
      tempSphere.copy(cloudTracking.boundingSphere);
      let anyHit = false;
      for (const sphere of weightedSpheres) {
        if (tempSphere.intersectsSphere(new THREE.Sphere(sphere.center, sphere.radius))) {
          anyHit = true;
          break;
        }
      }
      if (!anyHit) return 0;
    }

    const capsuleSpheres = createCapsuleSphereSamples(cloudTracking);
    let totalRatio = 0;
    for (const bodySphere of weightedSpheres) {
      let combined = 0;
      for (const cloudSphere of capsuleSpheres) {
        const distance = bodySphere.center.distanceTo(cloudSphere.center);
        const overlapVolume = intersectSphereSphereVolume(bodySphere.radius, cloudSphere.radius, distance);
        const ratio = clamp(overlapVolume / Math.max(sphereVolume(bodySphere.radius), 1e-6), 0, 1);
        combined = 1 - (1 - combined) * (1 - ratio);
      }
      totalRatio += combined * (bodySphere.weight ?? 1);
    }
    return clamp(totalRatio, 0, 1);
  }

  function createPredictedCloudTracking(origin, direction, weaponConfig, travelDistance, team = 'npc', ownerId = 'npc') {
    const normalizedDirection = direction.clone().normalize();
    const radius = Math.max(0.35, weaponConfig.baseTrackingRadius ?? config.npcWeapon.baseTrackingRadius);
    const forwardDistance = Math.max(1.2, Math.min(weaponConfig.forwardGrowthPerSecond * (weaponConfig.lifeTime ?? 1), travelDistance));
    const center = origin.clone().addScaledVector(normalizedDirection, forwardDistance * 0.5);
    const startPoint = origin.clone().addScaledVector(normalizedDirection, -radius * 0.18);
    const endPoint = origin.clone().addScaledVector(normalizedDirection, forwardDistance);
    return {
      origin: origin.clone(),
      direction: normalizedDirection,
      center,
      startPoint,
      endPoint,
      radius,
      boundingSphere: new THREE.Sphere(center.clone(), Math.sqrt((forwardDistance * 0.5) ** 2 + radius ** 2)),
      normalizedAge: 0.12,
      age: 0,
      lifeTime: weaponConfig.lifeTime ?? 1,
      team,
      ownerId,
    };
  }

  function clampWorldXZ(position) {
    const half = config.worldSize * 0.5;
    position.x = clamp(position.x, -half, half);
    position.z = clamp(position.z, -half, half);
    position.y = world.terrain.sampleHeight(position.x, position.z);
    return position;
  }

  function randomUnitPlanar(rng) {
    const angle = rng() * Math.PI * 2;
    return new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
  }

  function yawToForward(yaw) {
    return new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  }

  function signedAnglePlanar(from, to) {
    const a = from.clone().setY(0).normalize();
    const b = to.clone().setY(0).normalize();
    const crossY = a.x * b.z - a.z * b.x;
    const dot = clamp(a.dot(b), -1, 1);
    return Math.atan2(crossY, dot);
  }

  function planarDistance(a, b) {
    const dx = (a.x ?? 0) - (b.x ?? 0);
    const dz = (a.z ?? 0) - (b.z ?? 0);
    return Math.hypot(dx, dz);
  }

  function getCollectibleReferencePosition(entry) {
    return entry?.object?.position ?? entry?.position ?? null;
  }

  function getNpcPickupVerticalAllowance() {
    return pickFirstDefined(config.player?.pickupVerticalAllowance, getConfiguredPlayerHeight() * 0.9, 5.5);
  }

  function computeDirectChaseStopDistance(actor, weaponController, overlapThreshold) {
    const cloudRadius = Math.max(0.8, weaponController?.options?.baseTrackingRadius ?? config.npcWeapon.baseTrackingRadius ?? 1.5);
    const overlapBias = clamp(1 - overlapThreshold * 3.1, 0.42, 1.05);
    return clamp(
      cloudRadius * 0.48 * overlapBias,
      0.6,
      Math.max(1.5, (weaponController?.options?.attackStopDistance ?? 6) * 0.16),
    );
  }

  function computePointBlankDistance(actor, weaponController) {
    return clamp(
      Math.max(0.95, (weaponController?.options?.attackStopDistance ?? 6) * 0.1),
      0.95,
      1.8,
    );
  }


  class NpcVolumeField {
    constructor(actor, options = {}) {
      this.actor = actor;
      this.options = options;
      this.definition = createLocalVolumeSpheresFromBounds(actor.localBounds, options);
      this.worldSpheres = this.definition.localSpheres.map((localSphere) => ({
        center: new THREE.Vector3(),
        radius: localSphere.radius,
        weight: localSphere.weight,
        localCenter: localSphere.center.clone(),
        localRadius: localSphere.radius,
      }));
      this.boundingSphere = new THREE.Sphere(actor.root.position.clone(), this.definition.approximateRadius);
      this.updateFromActor();
    }

    updateFromActor() {
      this.actor.root.updateWorldMatrix(true, true);
      const weightedCenter = new THREE.Vector3();
      let totalWeight = 0;

      for (let i = 0; i < this.worldSpheres.length; i += 1) {
        const target = this.worldSpheres[i];
        const localSphere = this.definition.localSpheres[i];
        target.center.copy(localSphere.center).applyMatrix4(this.actor.root.matrixWorld);

        tempVectorA.setFromMatrixScale(this.actor.root.matrixWorld);
        const uniformScale = (tempVectorA.x + tempVectorA.y + tempVectorA.z) / 3;
        target.radius = localSphere.radius * uniformScale;

        weightedCenter.addScaledVector(target.center, target.weight);
        totalWeight += target.weight;
      }

      weightedCenter.multiplyScalar(1 / Math.max(totalWeight, 1e-6));
      this.boundingSphere.center.copy(weightedCenter);
      let maxDistance = 0;
      for (const sphere of this.worldSpheres) {
        const distance = sphere.center.distanceTo(weightedCenter) + sphere.radius;
        maxDistance = Math.max(maxDistance, distance);
      }
      this.boundingSphere.radius = maxDistance;
    }

    computeOverlapRatio(cloudTracking) {
      if (!cloudTracking) return 0;
      if (cloudTracking.boundingSphere && !this.boundingSphere.intersectsSphere(cloudTracking.boundingSphere)) {
        return 0;
      }

      const capsuleSpheres = createCapsuleSphereSamples(cloudTracking);
      let totalRatio = 0;

      for (const npcSphere of this.worldSpheres) {
        let combined = 0;
        for (const cloudSphere of capsuleSpheres) {
          const distance = npcSphere.center.distanceTo(cloudSphere.center);
          const overlapVolume = intersectSphereSphereVolume(npcSphere.radius, cloudSphere.radius, distance);
          const overlapRatio = clamp(overlapVolume / Math.max(sphereVolume(npcSphere.radius), 1e-6), 0, 1);
          combined = 1 - (1 - combined) * (1 - overlapRatio);
        }
        totalRatio += combined * npcSphere.weight;
      }

      return clamp(totalRatio, 0, 1);
    }

    getTrackingSnapshot() {
      return {
        boundingSphere: this.boundingSphere.clone(),
        spheres: this.worldSpheres.map((sphere) => ({
          center: sphere.center.clone(),
          radius: sphere.radius,
          weight: sphere.weight,
        })),
      };
    }

    dispose() {}
  }

  class NpcBehaviorBase {
    constructor(actor, options = {}) {
      this.actor = actor;
      this.options = options;
      this.type = options.type ?? 'idle';
    }
    onEnter() {}
    update() {}
    getDesiredAnimationRole() { return 'idle'; }
  }

  class NpcWeaponController {
    constructor(actor, options = {}) {
      this.actor = actor;
      this.options = {
        cooldown: pickFirstDefined(options.cooldown, config.npcDefaults.cloudAttack.cooldown),
        range: pickFirstDefined(options.range, config.npcDefaults.cloudAttack.range),
        attackStopDistance: pickFirstDefined(options.attackStopDistance, 12),
        muzzleHeightFactor: pickFirstDefined(options.muzzleHeightFactor, config.npcDefaults.npcMuzzleHeightFactor, 0.7),
        aimHeightFactor: pickFirstDefined(options.aimHeightFactor, 0.66),
        repeatAttackProbability: pickFirstDefined(options.repeatAttackProbability, 0.4),
        runningShotEnabled: pickFirstDefined(options.runningShotEnabled, config.npcDefaults.cloudAttack.runningShotEnabled, true),
        runningShotChance: pickFirstDefined(options.runningShotChance, config.npcDefaults.cloudAttack.runningShotChance, 0.42),
        runningShotMinOverlap: pickFirstDefined(options.runningShotMinOverlap, config.npcDefaults.cloudAttack.runningShotMinOverlap, 0.055),
        runningShotDamageScale: pickFirstDefined(options.runningShotDamageScale, config.npcDefaults.cloudAttack.runningShotDamageScale, 0.76),
        runningShotParticleScale: pickFirstDefined(options.runningShotParticleScale, config.npcDefaults.cloudAttack.runningShotParticleScale, 0.82),
        runningShotLifeScale: pickFirstDefined(options.runningShotLifeScale, config.npcDefaults.cloudAttack.runningShotLifeScale, 0.86),
        runningShotRadiusScale: pickFirstDefined(options.runningShotRadiusScale, config.npcDefaults.cloudAttack.runningShotRadiusScale, 0.88),
        runningShotCooldownScale: pickFirstDefined(options.runningShotCooldownScale, config.npcDefaults.cloudAttack.runningShotCooldownScale, 1.08),
        runningShotDecisionInterval: pickFirstDefined(options.runningShotDecisionInterval, config.npcDefaults.cloudAttack.runningShotDecisionInterval, 0.24),
      };
      this.cooldownRemaining = 0;
      this.lastFiredCloudId = null;
    }

    update(delta) {
      this.cooldownRemaining = Math.max(0, this.cooldownRemaining - delta);
    }

    hasAmmo() {
      return this.actor.dandelions > 0;
    }

    canFireAt(targetPosition) {
      if (this.actor.defeated || this.cooldownRemaining > 0 || !this.hasAmmo()) return false;
      return this.actor.root.position.distanceTo(targetPosition) <= this.options.range;
    }

    computeShotGeometry(targetPosition) {
      const weaponConfig = config.npcWeapon;
      const origin = this.actor.getMuzzleOrigin(this.options.muzzleHeightFactor);
      const aimPoint = targetPosition.clone();
      aimPoint.y += getConfiguredPlayerHeight() * this.options.aimHeightFactor;
      const direction = aimPoint.sub(origin).normalize();
      origin.addScaledVector(direction, weaponConfig.muzzleDistance ?? 1.5);
      origin.y -= weaponConfig.muzzleDrop ?? 0;
      return { origin, direction };
    }

    buildRunningShotWeaponConfig() {
      const baseSimulationParticleCount = config.npcWeapon.simulationParticleCount ?? config.npcWeapon.particleCount ?? 20;
      const simulationParticleCount = Math.max(6, Math.round(baseSimulationParticleCount * this.options.runningShotParticleScale));
      const renderParticleCount = Math.max(2, Math.ceil(simulationParticleCount / 3));
      return {
        ...config.npcWeapon,
        particleCount: simulationParticleCount,
        simulationParticleCount,
        renderParticleCount,
        lifeTime: (config.npcWeapon.lifeTime ?? 1) * this.options.runningShotLifeScale,
        baseTrackingRadius: Math.max(0.45, (config.npcWeapon.baseTrackingRadius ?? 1.5) * this.options.runningShotRadiusScale),
        shotCooldown: (config.npcWeapon.shotCooldown ?? this.options.cooldown) * this.options.runningShotCooldownScale,
      };
    }

    estimateOverlapAgainstPlayer(targetPosition, weaponConfig = config.npcWeapon) {
      const { origin, direction } = this.computeShotGeometry(targetPosition);
      const travelDistance = Math.min(
        this.options.range,
        Math.max(origin.distanceTo(targetPosition), (weaponConfig.baseTrackingRadius ?? config.npcWeapon.baseTrackingRadius ?? 1.5) * 2.2),
      );
      const tracking = createPredictedCloudTracking(origin, direction, weaponConfig, travelDistance, 'npc', this.actor.id);
      return computeCloudOverlapWithWeightedSpheres(tracking, getPlayerVolumeSpheresAt(player.position));
    }

    fireAt(targetPosition, shotOptions = null) {
      if (!this.canFireAt(targetPosition)) return null;
      if (!this.actor.consumeDandelion(1)) return null;

      const isRunningShot = Boolean(shotOptions?.isRunningShot);
      const weaponConfig = isRunningShot ? this.buildRunningShotWeaponConfig() : config.npcWeapon;
      const damageMultiplier = isRunningShot ? this.options.runningShotDamageScale : 1;
      const { origin, direction } = this.computeShotGeometry(targetPosition);
      const cloud = spawnWeaponCloud({
        origin,
        direction,
        weaponKind: 'npc',
        team: 'npc',
        ownerId: this.actor.id,
        weaponConfig,
        damageMultiplier,
        emitterVelocity: this.actor.getLinearVelocity(),
        seedTag: `npc:${this.actor.id}:${world.nextCloudId}`,
        showWindAlarm: false,
      });

      this.cooldownRemaining = weaponConfig.shotCooldown ?? this.options.cooldown;
      this.lastFiredCloudId = cloud?.id ?? null;
      this.actor.lastAttackTime = world.clock?.elapsedTime ?? 0;
      return cloud ?? null;
    }
  }

  class NpcLocomotionController {
    constructor(actor) {
      this.actor = actor;
      this.currentSpeed = 0;
      this.target = null;
      this.stopDistance = 0;
      this.speedMode = 'walk';
      this.turnAssist = 1;
    }

    setTarget(target, stopDistance = 0, speedMode = 'walk') {
      this.target = target.clone();
      this.stopDistance = stopDistance;
      this.speedMode = speedMode;
    }

    clearTarget() {
      this.target = null;
      this.stopDistance = 0;
    }

    getDesiredTopSpeed() {
      return this.speedMode === 'run' ? this.actor.movement.runSpeed : this.actor.movement.walkSpeed;
    }

    getVelocity(target = new THREE.Vector3()) {
      const forward = yawToForward(this.actor.root.rotation.y);
      return target.copy(forward).multiplyScalar(this.currentSpeed);
    }

    update(delta) {
      const acceleration = this.actor.movement.acceleration;
      if (!this.target || this.actor.defeated) {
        this.currentSpeed = Math.max(0, this.currentSpeed - acceleration * 1.5 * delta);
        this.actor.snapToGround();
        return;
      }

      tempVectorA.copy(this.target).sub(this.actor.root.position);
      tempVectorA.y = 0;
      const distance = tempVectorA.length();

      if (distance <= this.stopDistance) {
        this.clearTarget();
        this.currentSpeed = Math.max(0, this.currentSpeed - acceleration * 1.6 * delta);
        this.actor.snapToGround();
        return;
      }

      const desiredDirection = tempVectorA.normalize();
      const desiredYaw = Math.atan2(desiredDirection.x, desiredDirection.z);
      let deltaYaw = desiredYaw - this.actor.root.rotation.y;
      while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2;
      while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2;

      const maxTurnStep = this.actor.movement.turnSpeed * delta;
      this.actor.root.rotation.y += clamp(deltaYaw, -maxTurnStep, maxTurnStep);

      const alignment = clamp(1 - Math.abs(deltaYaw) / Math.PI, 0.12, 1);
      const arrivalFactor = smoothstep(this.stopDistance + 0.8, this.stopDistance + 10, distance);
      const desiredSpeed = this.getDesiredTopSpeed() * alignment * arrivalFactor;

      if (this.currentSpeed < desiredSpeed) {
        this.currentSpeed = Math.min(desiredSpeed, this.currentSpeed + acceleration * delta);
      } else {
        this.currentSpeed = Math.max(desiredSpeed, this.currentSpeed - acceleration * 1.18 * delta);
      }

      const forward = yawToForward(this.actor.root.rotation.y);
      this.actor.root.position.addScaledVector(forward, this.currentSpeed * delta);
      this.actor.clampAndGroundPosition();
    }
  }

  class HierarchicalDuelistBehavior extends NpcBehaviorBase {
    constructor(actor, options = {}) {
      super(actor, { ...options, type: 'duelistFsm' });
      this.approachDistanceMin = options.approachDistanceMin ?? 12;
      this.approachDistanceMax = options.approachDistanceMax ?? 22;
      this.hideDistanceMin = options.hideDistanceMin ?? 24;
      this.hideDistanceMax = options.hideDistanceMax ?? 46;
      this.retreatDistanceMin = options.retreatDistanceMin ?? 20;
      this.retreatDistanceMax = options.retreatDistanceMax ?? 38;
      this.patrolApproachDuration = options.patrolApproachDuration ?? 3.8;
      this.patrolHideDuration = options.patrolHideDuration ?? 3.1;
      this.patrolAttackChance = options.patrolAttackChance ?? 0.35;
      this.repeatAttackProbability = options.repeatAttackProbability ?? 0.36;
      this.combatReengageProbability = options.combatReengageProbability ?? 0.52;
      this.playerShotNoticeWindow = options.playerShotNoticeWindow ?? 2.2;
      this.playerShotNoticeRange = options.playerShotNoticeRange ?? 80;
      this.hideViewDot = options.hideViewDot ?? 0.18;
      this.successfulAttackDamageThreshold = options.successfulAttackDamageThreshold ?? 0.65;
      this.successfulAttackOverlapThreshold = options.successfulAttackOverlapThreshold ?? 0.08;
      this.attackReadinessOverlapThreshold = options.attackReadinessOverlapThreshold ?? 0.075;
      this.gatherSearchRadius = options.gatherSearchRadius ?? config.npcDefaults.dandelionGatherSearchRadius;
      this.gatherCollectRadius = options.gatherCollectRadius ?? config.npcDefaults.npcCollectRadius;
      this.gatherEnterBaseChancePerSecond = options.gatherEnterBaseChancePerSecond ?? config.npcDefaults.dandelionGatherBaseChancePerSecond;
      this.gatherScarcityBoostPerSecond = options.gatherScarcityBoostPerSecond ?? config.npcDefaults.dandelionGatherScarcityBoostPerSecond;
      this.gatherUrgencyExponent = options.gatherUrgencyExponent ?? config.npcDefaults.dandelionGatherUrgencyExponent;
      this.desiredCombatReserve = options.desiredCombatReserve ?? config.npcDefaults.dandelionComfortReserve;
      this.maxRepeatChain = options.maxRepeatChain ?? 2;
      this.mode = 'patrol';
      this.phase = 'approach';
      this.phaseDuration = 0;
      this.replanCooldown = 0;
      this.repeatCount = 0;
      this.gatherTarget = null;
      this.closerBias = 0;
      this.flankTriggerOverlapThreshold = options.flankTriggerOverlapThreshold ?? 0.09;
      this.flankTriggerDamageThreshold = options.flankTriggerDamageThreshold ?? 0.14;
      // flankPhaseDuration kept for backward compatibility, but now it is only a hard fallback cap;
      // the primary exit conditions of combatFlank are geometric and combat-related.
      this.flankMaxDuration = options.flankMaxDuration ?? options.flankPhaseDuration ?? 1.6;
      this.flankDistanceMin = options.flankDistanceMin ?? 6.8;
      this.flankDistanceMax = options.flankDistanceMax ?? 12.5;
      this.flankStopDistance = options.flankStopDistance ?? 1.05;
      this.flankMinSideDot = options.flankMinSideDot ?? 0.7;
      this.flankPreferredRearDot = options.flankPreferredRearDot ?? -0.12;
      this.flankRecoveryCooldown = options.flankRecoveryCooldown ?? 0.95;
      this.flankLockoutRemaining = 0;
      this.activeFlankSign = 1;

      const fogStartDistance = config.lighting?.fogStartDistance ?? 105;
      const fogFadeLength = config.lighting?.fogFadeLength ?? 120;
      const defaultLoseSightDistance = fogStartDistance + fogFadeLength * 0.25;
      const defaultReacquireDistance = Math.max(20, defaultLoseSightDistance - Math.max(12, fogFadeLength * 0.2));

      // Awareness / memory model:
      // - пока игрок близко, NPC "видит" его и продолжает бой;
      // - при уходе игрока глубоко в туман NPC временно теряет контакт,
      //   переключается на патруль или сбор одуванчиков "про запас";
      // - при повторном сближении NPC сразу вспоминает конфликт и возвращается в бой.
      this.loseSightDistance = Math.max(24, options.loseSightDistance ?? defaultLoseSightDistance);
      this.reacquireDistance = Math.max(16, Math.min(
        this.loseSightDistance - 1,
        options.reacquireDistance ?? defaultReacquireDistance,
      ));
      this.memoryDuration = Math.max(0.5, options.memoryDuration ?? 7.5);
      this.combatDisengageDelay = Math.max(0.1, options.combatDisengageDelay ?? 0.7);
      this.dandelionAdvanceCount = Math.max(1, Math.round(options.dandelionAdvanceCount ?? 8));

      this.playerVisible = true;
      this.timeSincePlayerSeen = 0;
      this.playerMemoryRemaining = this.memoryDuration;
      this.lastKnownPlayerPosition = null;
      this.gatherPurpose = 'normal';
      this.runningShotDecisionCooldown = 0;
    }

    getCurrentReferencePosition(runtime) {
      return this.playerVisible
        ? runtime.playerPosition
        : (this.lastKnownPlayerPosition ?? runtime.playerPosition ?? this.actor.root.position);
    }

    getCurrentReferenceForward(runtime) {
      if (this.playerVisible && runtime?.playerForward) return runtime.playerForward;
      const fallback = yawToForward(this.actor.root.rotation.y);
      return fallback.lengthSq() > 1e-8 ? fallback : new THREE.Vector3(0, 0, -1);
    }

    updatePlayerAwareness(delta, runtime) {
      if (runtime?.safeTimeActive) {
        const wasVisible = this.playerVisible;
        this.playerVisible = false;
        this.timeSincePlayerSeen = wasVisible ? 0 : (this.timeSincePlayerSeen + delta);
        this.playerMemoryRemaining = 0;
        this.lastKnownPlayerPosition = null;
        return {
          visible: false,
          distance: this.actor.root.position.distanceTo(runtime.playerPosition),
          justLost: wasVisible,
          remembered: false,
          lastKnownPlayerPosition: null,
          safeTimeActive: true,
        };
      }

      const distance = this.actor.root.position.distanceTo(runtime.playerPosition);
      const visibilityDistance = this.playerVisible ? this.loseSightDistance : this.reacquireDistance;
      const wasVisible = this.playerVisible;
      const visible = distance <= visibilityDistance;

      if (visible) {
        this.playerVisible = true;
        this.timeSincePlayerSeen = 0;
        this.playerMemoryRemaining = this.memoryDuration;
        this.lastKnownPlayerPosition = runtime.playerPosition.clone();
      } else {
        this.playerVisible = false;
        this.timeSincePlayerSeen = wasVisible ? 0 : (this.timeSincePlayerSeen + delta);
        this.playerMemoryRemaining = Math.max(0, this.playerMemoryRemaining - delta);
      }

      return {
        visible: this.playerVisible,
        distance,
        justLost: wasVisible && !visible,
        remembered: this.playerMemoryRemaining > 0 && Boolean(this.lastKnownPlayerPosition),
        lastKnownPlayerPosition: this.lastKnownPlayerPosition?.clone() ?? null,
        safeTimeActive: false,
      };
    }

    enterDisengagedPatrol(runtime) {
      this.mode = 'patrol';
      this.phase = 'hide';
      this.gatherPurpose = 'normal';
      this.phaseDuration = this.samplePhaseDuration(this.patrolHideDuration * 1.15, 0.38);
      this.replanCooldown = 0;
      this.repeatCount = 0;
      this.closerBias = 0;
      this.actor.setState('patrolHide');

      const referencePosition = this.lastKnownPlayerPosition?.clone() ?? this.actor.root.position.clone();
      const referenceForward = tempVectorA.copy(this.actor.root.position).sub(referencePosition).setY(0);
      if (referenceForward.lengthSq() < 1e-8) referenceForward.copy(yawToForward(this.actor.root.rotation.y));
      else referenceForward.normalize();

      const target = this.samplePointAroundReference(referencePosition, referenceForward, this.hideDistanceMin, this.hideDistanceMax, 'hide');
      this.actor.requestMoveTarget(target, 3.8, 'walk');
    }

    enterReserveBehavior(runtime) {
      this.repeatCount = 0;
      this.closerBias = 0;
      this.gatherTarget = null;

      if (this.actor.dandelions < this.dandelionAdvanceCount && this.findNearestDandelion(runtime)) {
        this.enterGather(runtime, 'reserve');
      } else {
        this.enterDisengagedPatrol(runtime);
      }
    }

    onEnter(runtime = null) {
      this.enterPatrolApproach(runtime);
    }

    getDesiredAnimationRole() {
      if (this.phase === 'combatWindup' || this.phase === 'combatObserve') return 'attack';
      if (this.actor.locomotion.currentSpeed > 0.45) return 'move';
      if (this.mode === 'combat' || this.mode === 'resource') return 'alert';
      return 'idle';
    }

    samplePhaseDuration(base, variance = 0.28) {
      return base * lerp(1 - variance, 1 + variance, this.actor.rng());
    }

    hasPlayerStartedAttacking(runtime) {
      const timeSinceShot = runtime.elapsedTime - (runtime.lastPlayerShotTime ?? -Infinity);
      if (timeSinceShot > this.playerShotNoticeWindow) return false;
      if (!runtime.lastPlayerShotOrigin) return false;
      return runtime.lastPlayerShotOrigin.distanceTo(this.actor.root.position) <= this.playerShotNoticeRange;
    }

    computeFinisherUrgency(runtime) {
      const playerMaxHp = Math.max(runtime.playerMaxHp ?? config.combat.playerMaxHp ?? 100, 1e-6);
      const playerHpRatio = clamp((runtime.playerHp ?? playerMaxHp) / playerMaxHp, 0, 1);
      return Math.pow(1 - playerHpRatio, 1.75);
    }

    computeDynamicCombatReserve(runtime) {
      const baseReserve = Math.max(1, this.desiredCombatReserve);
      const finisherUrgency = this.computeFinisherUrgency(runtime);
      // Когда игрок близок к поражению, тактически выгоднее "дожать" оставшимся
      // запасом, чем преждевременно уходить за новыми одуванчиками.
      return lerp(baseReserve, 1.35, finisherUrgency);
    }

    computeAmmoPressure(runtime = null) {
      const reserve = Math.max(1, runtime ? this.computeDynamicCombatReserve(runtime) : this.desiredCombatReserve);
      const ratio = clamp(this.actor.dandelions / reserve, 0, 1);
      return Math.pow(1 - ratio, this.gatherUrgencyExponent);
    }

    shouldSeekDandelions(delta, runtime, context = 'patrol') {
      const nearest = this.findNearestDandelion(runtime);
      if (!nearest) return false;
      if (context === 'reserve') return this.actor.dandelions < this.dandelionAdvanceCount;
      if (this.actor.dandelions <= 0) return true;

      const finisherUrgency = this.computeFinisherUrgency(runtime);
      const scarcity = this.computeAmmoPressure(runtime);
      let chancePerSecond = this.gatherEnterBaseChancePerSecond + scarcity * this.gatherScarcityBoostPerSecond;

      if (context === 'combat') {
        // В бою NPC должен гораздо неохотнее уходить на сбор, пока у него ещё есть
        // хотя бы 2–3 выстрела. А при почти добитом игроке — почти никогда.
        if (this.actor.dandelions <= 2) {
          chancePerSecond *= 1.35 + scarcity * 0.35;
        } else {
          chancePerSecond *= 0.08 + scarcity * 0.12;
        }
        chancePerSecond *= lerp(1.0, 0.04, finisherUrgency);
      } else if (context === 'retreat') {
        chancePerSecond *= 1.05 + scarcity * 0.45;
      }

      return this.actor.rng() < chancePerSecond * delta;
    }

    findNearestDandelion(runtime, fromPosition = this.actor.root.position) {
      let nearest = null;
      let nearestDistanceSq = Infinity;
      for (const entry of runtime.collectibles ?? []) {
        if (entry.collected || entry.inventoryKey !== config.dandelionWeapon.ammoKey) continue;
        const reference = entry.object?.position ?? entry.position;
        if (!reference) continue;
        const distance = planarDistance(fromPosition, reference);
        const distanceSq = distance * distance;
        if (distanceSq > this.gatherSearchRadius * this.gatherSearchRadius) continue;
        if (distanceSq < nearestDistanceSq) {
          nearestDistanceSq = distanceSq;
          nearest = entry;
        }
      }
      return nearest;
    }

    tryCollectNearbyDandelion(runtime) {
      const pickupVerticalAllowance = getNpcPickupVerticalAllowance();
      const nearby = [];

      const preferred = this.gatherTarget && !this.gatherTarget.collected ? this.gatherTarget : null;
      if (preferred) nearby.push(preferred);

      for (const entry of runtime.collectibles ?? []) {
        if (!entry || entry.collected || entry.inventoryKey !== config.dandelionWeapon.ammoKey) continue;
        if (preferred && entry === preferred) continue;
        nearby.push(entry);
      }

      let collectedAny = false;
      let closestRemaining = null;
      let closestDistanceSq = Infinity;

      for (const entry of nearby) {
        const reference = getCollectibleReferencePosition(entry);
        if (!reference) continue;

        const planar = planarDistance(this.actor.root.position, reference);
        const vertical = Math.abs((this.actor.root.position.y ?? 0) - (reference.y ?? 0));
        const reach = Math.max(this.gatherCollectRadius, entry.pickupRadius ?? 0, this.actor.collectRadius ?? 0, 1.0);

        if (planar <= reach + 0.45 && vertical <= pickupVerticalAllowance + 2.5) {
          const collected = runtime.collectWorldDandelion?.(entry, this.actor);
          if (collected) {
            collectedAny = true;
            if (entry === this.gatherTarget) this.gatherTarget = null;
            continue;
          }
        }

        const dSq = planar * planar;
        if (dSq < closestDistanceSq) {
          closestDistanceSq = dSq;
          closestRemaining = entry;
        }
      }

      if (collectedAny) {
        this.gatherTarget = closestRemaining;
        this.actor.clearMovementRequest();
        return true;
      }

      return false;
    }

    samplePointAroundReference(referencePosition, referenceForward, distanceMin, distanceMax, mode = 'approach') {
      const playerPos = referencePosition;
      const planarForward = tempVectorA.copy(referenceForward ?? new THREE.Vector3(0, 0, -1)).setY(0);
      if (planarForward.lengthSq() < 1e-8) planarForward.set(0, 0, -1);
      else planarForward.normalize();
      const playerForward = planarForward.clone();
      const playerRight = tempVectorC.crossVectors(playerForward, worldUp).normalize();

      let bestPoint = null;
      let bestScore = -Infinity;
      const idealMid = lerp(distanceMin, distanceMax, 0.55);

      for (let i = 0; i < 26; i += 1) {
        const radius = lerp(distanceMin, distanceMax, this.actor.rng());
        let direction;

        if (mode === 'hide') {
          const angle = lerp(Math.PI * 0.52, Math.PI * 1.48, this.actor.rng());
          direction = playerForward.clone().multiplyScalar(-Math.cos(angle)).addScaledVector(playerRight, Math.sin(angle)).normalize();
        } else if (mode === 'retreat') {
          direction = this.actor.root.position.clone().sub(playerPos).setY(0);
          if (direction.lengthSq() < 1e-8) direction = randomUnitPlanar(this.actor.rng);
          else direction.normalize();
          direction.applyAxisAngle(worldUp, lerp(-0.72, 0.72, this.actor.rng()));
        } else {
          const angle = lerp(-Math.PI * 0.92, Math.PI * 0.92, this.actor.rng());
          direction = playerForward.clone().multiplyScalar(Math.cos(angle)).addScaledVector(playerRight, Math.sin(angle)).normalize();
        }

        const candidate = playerPos.clone().addScaledVector(direction, radius);
        clampWorldXZ(candidate);
        candidate.y = this.actor.getGroundHeightAt(candidate.x, candidate.z);

        const toCandidate = candidate.clone().sub(playerPos).setY(0);
        const visibilityDot = toCandidate.lengthSq() > 1e-8 ? toCandidate.normalize().dot(playerForward) : -1;
        const distanceToActor = candidate.distanceTo(this.actor.root.position);
        const candidateToPlayer = candidate.distanceTo(playerPos);
        let score = -candidate.distanceToSquared(this.actor.root.position) * 0.013;

        if (mode === 'hide') {
          score += (visibilityDot < this.hideViewDot ? 1 : -1) * 60;
          score += candidateToPlayer * 0.52;
        } else if (mode === 'retreat') {
          score += candidateToPlayer * 0.72;
          score += visibilityDot < this.hideViewDot ? 18 : -8;
        } else {
          score += distanceToActor * -0.07;
          score += Math.abs(candidateToPlayer - idealMid) * -0.85;
          score += visibilityDot > -0.25 ? 10 : -4;
        }

        if (score > bestScore) {
          bestScore = score;
          bestPoint = candidate;
        }
      }

      return bestPoint ?? this.actor.root.position.clone();
    }

    samplePointAroundPlayer(runtime, distanceMin, distanceMax, mode = 'approach') {
      return this.samplePointAroundReference(
        this.getCurrentReferencePosition(runtime),
        this.getCurrentReferenceForward(runtime),
        distanceMin,
        distanceMax,
        mode,
      );
    }

    sampleAmbientPatrolPoint(runtime, mode = 'approach') {
      const terrain = runtime?.terrain;
      const anchors = terrain?.anchors ?? {};
      const references = [
        this.actor.root.position.clone(),
        anchors.center?.clone?.(),
        anchors.spawn?.clone?.(),
      ].filter(Boolean);
      const referencePosition = references[Math.floor(this.actor.rng() * references.length)] ?? this.actor.root.position.clone();
      const actorForward = yawToForward(this.actor.root.rotation.y);
      const fallbackForward = tempVectorA.copy(anchors.center ?? referencePosition).sub(referencePosition).setY(0);
      const referenceForward = fallbackForward.lengthSq() > 1e-8 ? fallbackForward.normalize() : actorForward;
      const minDistance = mode === 'hide' ? 24 : 16;
      const maxDistance = mode === 'hide' ? 88 : 72;
      return this.samplePointAroundReference(referencePosition, referenceForward, minDistance, maxDistance, mode);
    }

    sampleGatherPoint(runtime) {
      const target = this.findNearestDandelion(runtime);
      if (!target) return null;
      this.gatherTarget = target;
      return (target.object?.position ?? target.position)?.clone() ?? null;
    }

    enterPatrolApproach(runtime = null) {
      this.mode = 'patrol';
      this.gatherPurpose = 'normal';
      this.phase = 'approach';
      this.phaseDuration = this.samplePhaseDuration(this.patrolApproachDuration, 0.34);
      this.replanCooldown = 0;
      this.actor.setState('patrolApproach');
      if (runtime) {
        const confidence = this.actor.getAmmoConfidence(this.desiredCombatReserve);
        const distanceBias = lerp(1.4, -1.6, confidence);
        const target = this.samplePointAroundPlayer(runtime, this.approachDistanceMin + distanceBias, this.approachDistanceMax + distanceBias * 0.35, 'approach');
        this.actor.requestMoveTarget(target, 3.1, confidence > 0.45 ? 'walk' : 'run');
      }
    }

    enterPatrolHide(runtime) {
      this.mode = 'patrol';
      this.gatherPurpose = 'normal';
      this.phase = 'hide';
      this.phaseDuration = this.samplePhaseDuration(this.patrolHideDuration, 0.42);
      this.replanCooldown = 0;
      this.actor.setState('patrolHide');
      const target = this.samplePointAroundPlayer(runtime, this.hideDistanceMin, this.hideDistanceMax, 'hide');
      this.actor.requestMoveTarget(target, 3.8, 'run');
    }

    enterGather(runtime, purpose = 'normal') {
      this.mode = 'resource';
      this.gatherPurpose = purpose;
      this.phase = 'gather';
      this.phaseDuration = this.samplePhaseDuration(4.2, 0.38);
      this.replanCooldown = 0;
      this.actor.setState('gatherDandelions');
      const target = this.sampleGatherPoint(runtime);
      if (target) {
        const gatherStop = Math.max(0.35, Math.min(1.2, this.gatherCollectRadius * 0.18));
        this.actor.requestMoveTarget(target, gatherStop, 'run');
      } else {
        this.actor.clearMovementRequest();
      }
    }

    enterCombatApproach(runtime, closerBias = 0) {
      this.mode = 'combat';
      this.gatherPurpose = 'normal';
      this.phase = 'combatApproach';
      this.phaseDuration = this.samplePhaseDuration(2.3, 0.28);
      this.replanCooldown = 0;
      this.closerBias = clamp(closerBias, 0, 3.8);
      this.actor.setState('combatApproach');
      const attackDistance = clamp(
        Math.min(this.actor.weapon.options.attackStopDistance, this.actor.weapon.options.range - 1.4) - this.closerBias * 1.65,
        5.2,
        this.actor.weapon.options.range - 0.8,
      );
      const target = this.samplePointAroundPlayer(runtime, Math.max(4.6, attackDistance - 2.2), attackDistance + 1.2, 'approach');
      this.actor.requestMoveTarget(target, 1.15, 'run');
    }

    enterCombatWindup(runtime) {
      this.mode = 'combat';
      this.gatherPurpose = 'normal';
      this.phase = 'combatWindup';
      this.phaseDuration = this.samplePhaseDuration(0.28, 0.22);
      this.actor.setState('combatWindup');
      this.actor.clearMovementRequest();
      this.actor.lookToward(runtime.playerPosition, 0.24, 1);
    }

    enterCombatObserve() {
      this.mode = 'combat';
      this.gatherPurpose = 'normal';
      this.phase = 'combatObserve';
      this.phaseDuration = this.samplePhaseDuration(0.72, 0.26);
      this.actor.setState('combatObserve');
      this.actor.clearMovementRequest();
    }

    enterCombatRetreat(runtime) {
      this.mode = 'combat';
      this.gatherPurpose = 'normal';
      this.phase = 'retreat';
      this.phaseDuration = this.samplePhaseDuration(2.2, 0.34);
      this.replanCooldown = 0;
      this.actor.setState('combatRetreat');
      const target = this.samplePointAroundPlayer(runtime, this.retreatDistanceMin, this.retreatDistanceMax, 'retreat');
      this.actor.requestMoveTarget(target, 4.0, 'run');
    }

    shouldPerformCloudFlank(runtime) {
      if (this.mode !== 'combat') return false;
      if (this.phase === 'combatFlank' || this.phase === 'combatObserve' || this.phase === 'retreat') return false;
      if (!runtime?.playerPosition || !runtime?.playerForward) return false;
      if (this.flankLockoutRemaining > 0) return false;

      const overlap = this.actor.lastOverlapRatio ?? 0;
      const damage = this.actor.lastDamageTaken ?? 0;
      if (overlap < this.flankTriggerOverlapThreshold && damage < this.flankTriggerDamageThreshold) return false;

      const planarToPlayer = planarDistance(this.actor.root.position, runtime.playerPosition);
      if (planarToPlayer > this.flankDistanceMax + 8) return false;

      return true;
    }

    sampleSideApproachPoint(runtime, flankSign = 1) {
      const playerPos = runtime.playerPosition;
      const playerForward = tempVectorA.copy(runtime.playerForward).setY(0);
      if (playerForward.lengthSq() < 1e-8) playerForward.set(0, 0, -1);
      else playerForward.normalize();

      const playerRight = tempVectorB.crossVectors(playerForward, worldUp).normalize();
      const sign = flankSign === 0 ? (this.actor.rng() < 0.5 ? -1 : 1) : Math.sign(flankSign);
      const chosenSign = sign === 0 ? 1 : sign;

      let bestPoint = null;
      let bestScore = -Infinity;
      for (let i = 0; i < 24; i += 1) {
        const sideDistance = lerp(this.flankDistanceMin, this.flankDistanceMax, this.actor.rng());
        const rearOffset = lerp(sideDistance * 0.18, sideDistance * 0.62, this.actor.rng());
        const radialJitter = lerp(-0.8, 0.8, this.actor.rng());

        const candidate = playerPos.clone()
          .addScaledVector(playerRight, chosenSign * sideDistance)
          .addScaledVector(playerForward, -rearOffset)
          .addScaledVector(playerRight, radialJitter);
        clampWorldXZ(candidate);
        candidate.y = this.actor.getGroundHeightAt(candidate.x, candidate.z);

        const toPlayer = tempVectorC.copy(candidate).sub(playerPos).setY(0);
        const planarLenSq = toPlayer.lengthSq();
        const normalizedToPlayer = planarLenSq > 1e-8 ? toPlayer.normalize() : null;
        const sideDot = normalizedToPlayer ? Math.abs(normalizedToPlayer.dot(playerRight)) : 0;
        const frontDot = normalizedToPlayer ? normalizedToPlayer.dot(playerForward) : 1;
        const actorTravel = planarDistance(candidate, this.actor.root.position);

        let score = 0;
        score += sideDot * 18;
        if (frontDot > 0) score -= frontDot * 10;
        else score += Math.abs(frontDot) * 4.5;
        score += smoothstep(this.flankDistanceMin, this.flankDistanceMax, sideDistance) * 2.4;
        score -= actorTravel * 0.05;
        score -= candidate.distanceToSquared(this.actor.root.position) * 0.0015;
        if (score > bestScore) {
          bestScore = score;
          bestPoint = candidate.clone();
        }
      }

      return bestPoint ?? this.samplePointAroundPlayer(runtime, this.flankDistanceMin, this.flankDistanceMax, 'approach');
    }

    hasEstablishedFlank(runtime) {
      if (!runtime?.playerPosition || !runtime?.playerForward) return false;
      const toNpc = tempVectorA.copy(this.actor.root.position).sub(runtime.playerPosition).setY(0);
      if (toNpc.lengthSq() < 1e-8) return false;
      toNpc.normalize();
      const playerForward = tempVectorB.copy(runtime.playerForward).setY(0);
      if (playerForward.lengthSq() < 1e-8) playerForward.set(0, 0, -1);
      else playerForward.normalize();
      const playerRight = tempVectorC.crossVectors(playerForward, worldUp).normalize();
      const sideDot = Math.abs(toNpc.dot(playerRight));
      const frontDot = toNpc.dot(playerForward);
      return sideDot >= this.flankMinSideDot && frontDot <= this.flankPreferredRearDot;
    }

    enterCombatFlank(runtime, flankSign = 1) {
      this.mode = 'combat';
      this.gatherPurpose = 'normal';
      this.phase = 'combatFlank';
      this.phaseDuration = this.samplePhaseDuration(this.flankMaxDuration, 0.18);
      this.replanCooldown = 0;
      this.activeFlankSign = flankSign === 0 ? (this.actor.rng() < 0.5 ? -1 : 1) : Math.sign(flankSign);
      if (this.activeFlankSign === 0) this.activeFlankSign = 1;
      this.actor.setState('combatFlank');
      const target = this.sampleSideApproachPoint(runtime, this.activeFlankSign);
      this.actor.requestMoveTarget(target, this.flankStopDistance, 'run');
    }

    // v4 overlay/hud merge fix

    shouldAttemptRunningShot(delta, runtime, predictedOverlap, recentDamage, recentOverlap, planarToPlayer) {
      if (!this.actor.weapon.options.runningShotEnabled) return false;
      if (this.phase !== 'combatApproach' || this.mode !== 'combat') return false;
      if (!this.playerVisible || !this.actor.hasMoveTarget()) return false;
      if (this.actor.locomotion.currentSpeed <= this.actor.movement.walkSpeed * 0.42) return false;
      if (this.runningShotDecisionCooldown > 0) return false;
      if (this.actor.lastOverlapRatio >= this.flankTriggerOverlapThreshold * 0.92
        || this.actor.lastDamageTaken >= this.flankTriggerDamageThreshold * 0.92) return false;

      const minOverlap = Math.max(0.01, this.actor.weapon.options.runningShotMinOverlap);
      const overlapReady = predictedOverlap >= minOverlap
        || recentOverlap >= minOverlap * 0.82
        || recentDamage >= this.successfulAttackDamageThreshold * 0.16;
      if (!overlapReady) return false;

      const allowedDistance = this.actor.weapon.options.range - 0.2;
      if (planarToPlayer > allowedDistance) return false;

      const closeness = 1 - clamp(planarToPlayer / Math.max(allowedDistance, 1e-6), 0, 1);
      const overlapConfidence = clamp(predictedOverlap / Math.max(minOverlap, 1e-6), 0, 1.8);
      const chance = clamp(
        this.actor.weapon.options.runningShotChance * (0.72 + closeness * 0.55) * (0.7 + overlapConfidence * 0.32),
        0,
        0.95,
      );

      this.runningShotDecisionCooldown = this.actor.weapon.options.runningShotDecisionInterval;
      return this.actor.rng() < chance;
    }

    performRunningShot(runtime) {
      this.actor.lookToward(runtime.playerPosition, 0.09, 0.95);
      const cloud = this.actor.weapon.fireAt(runtime.playerPosition, { isRunningShot: true });
      this.runningShotDecisionCooldown = this.actor.weapon.options.runningShotDecisionInterval * 0.65;
      if (!cloud) return false;
      if (this.actor.dandelions <= 0 && this.findNearestDandelion(runtime)) {
        this.enterGather(runtime);
      } else if (this.actor.rng() < 0.28) {
        // Иногда после opportunistic shot NPC чуть поджимает дистанцию ещё сильнее.
        this.closerBias = Math.min(this.closerBias + 0.12, 3.8);
      }
      return true;
    }

    resolvePostAttack(runtime, attackWasEffective) {
      this.flankLockoutRemaining = this.flankRecoveryCooldown;
      if (this.actor.dandelions <= 0 && this.findNearestDandelion(runtime)) {
        this.enterGather(runtime);
        return;
      }

      if (!attackWasEffective) {
        this.enterCombatApproach(runtime, this.closerBias + 0.95);
        return;
      }

      const ammoConfidence = this.actor.getAmmoConfidence(this.desiredCombatReserve);
      const repeatProbability = (this.repeatAttackProbability * 0.8 + this.actor.weapon.options.repeatAttackProbability * 0.2)
        * lerp(0.55, 1.18, ammoConfidence);

      if (this.repeatCount < this.maxRepeatChain && this.actor.rng() < repeatProbability && this.actor.dandelions > 0) {
        this.repeatCount += 1;
        this.enterCombatApproach(runtime, Math.max(0, this.closerBias - 0.35));
      } else {
        this.repeatCount = 0;
        this.enterCombatRetreat(runtime);
      }
    }

    updatePatrol(delta, runtime) {
      const distanceToPlayer = this.actor.root.position.distanceTo(runtime.playerPosition);
      const ammoConfidence = this.actor.getAmmoConfidence(this.desiredCombatReserve);
      this.replanCooldown -= delta;

      if (runtime?.safeTimeActive) {
        const shouldGatherReserve = this.actor.dandelions < this.dandelionAdvanceCount && this.findNearestDandelion(runtime);
        if (shouldGatherReserve) {
          this.enterGather(runtime, 'reserve');
          return;
        }

        if (!this.actor.hasMoveTarget() || this.replanCooldown <= 0 || this.actor.distanceToMoveTarget() <= 3.6) {
          const ambientMode = this.phase === 'hide' ? 'hide' : 'approach';
          const target = this.sampleAmbientPatrolPoint(runtime, ambientMode);
          this.actor.requestMoveTarget(target, 3.2, 'walk');
          this.replanCooldown = this.samplePhaseDuration(1.35, 0.28);
        }

        if (this.actor.stateTime >= this.phaseDuration) {
          if (this.phase === 'hide') {
            this.phase = 'approach';
            this.phaseDuration = this.samplePhaseDuration(this.patrolApproachDuration, 0.34);
            this.actor.setState('patrolApproach');
          } else {
            this.phase = 'hide';
            this.phaseDuration = this.samplePhaseDuration(this.patrolHideDuration, 0.42);
            this.actor.setState('patrolHide');
          }
          this.replanCooldown = 0;
          this.actor.clearMovementRequest();
        }
        return;
      }

      if (this.actor.wasProvoked && !this.playerVisible && this.shouldSeekDandelions(delta, runtime, 'reserve')) {
        this.enterGather(runtime, 'reserve');
        return;
      }

      if (this.shouldSeekDandelions(delta, runtime, 'patrol')) {
        this.enterGather(runtime);
        return;
      }

      if (this.phase === 'approach') {
        if (!this.actor.hasMoveTarget() || this.replanCooldown <= 0) {
          const distanceBias = lerp(1.6, -1.4, ammoConfidence);
          const target = this.samplePointAroundPlayer(runtime, this.approachDistanceMin + distanceBias, this.approachDistanceMax + distanceBias * 0.45, 'approach');
          this.actor.requestMoveTarget(target, 3.1, ammoConfidence > 0.4 ? 'walk' : 'run');
          this.replanCooldown = this.samplePhaseDuration(0.9, 0.25);
        }

        const predictedOverlap = this.actor.weapon.estimateOverlapAgainstPlayer(runtime.playerPosition);
        const attackProbability = this.patrolAttackChance * lerp(0.45, 1.15, ammoConfidence);
        if (distanceToPlayer <= this.actor.weapon.options.range * 1.05
          && predictedOverlap >= this.attackReadinessOverlapThreshold
          && this.actor.dandelions > 0
          && this.actor.rng() < attackProbability * delta * 2.4) {
          this.enterCombatWindup(runtime);
          return;
        }

        if (this.actor.stateTime >= this.phaseDuration) {
          this.enterPatrolHide(runtime);
        }
      } else {
        if (!this.actor.hasMoveTarget() || this.replanCooldown <= 0) {
          const target = this.samplePointAroundPlayer(runtime, this.hideDistanceMin, this.hideDistanceMax, 'hide');
          this.actor.requestMoveTarget(target, 3.8, 'run');
          this.replanCooldown = this.samplePhaseDuration(1.05, 0.3);
        }

        if (this.actor.stateTime >= this.phaseDuration) {
          this.enterPatrolApproach(runtime);
        }
      }
    }

    updateGather(delta, runtime) {
      const reserveSatisfied = this.gatherPurpose === 'reserve' && this.actor.dandelions >= this.dandelionAdvanceCount;

      if (this.playerVisible && this.actor.wasProvoked && this.actor.dandelions > 0 && reserveSatisfied) {
        this.enterCombatApproach(runtime, 0.35);
        return;
      }

      if (reserveSatisfied) {
        this.enterDisengagedPatrol(runtime);
        return;
      }

      if (this.tryCollectNearbyDandelion(runtime)) {
        if (this.gatherPurpose === 'reserve') {
          if (this.actor.dandelions >= this.dandelionAdvanceCount) {
            if (this.playerVisible && this.actor.wasProvoked && this.actor.dandelions > 0) this.enterCombatApproach(runtime, 0.35);
            else this.enterDisengagedPatrol(runtime);
            return;
          }
        } else if (this.actor.getAmmoConfidence(this.desiredCombatReserve) >= 1 && this.actor.rng() < 0.62) {
          if (this.playerVisible && this.actor.wasProvoked && this.actor.dandelions > 0) this.enterCombatApproach(runtime, 0.25);
          else if (this.mode === 'combat') this.enterCombatRetreat(runtime);
          else this.enterPatrolHide(runtime);
          return;
        }
      }

      const nextTarget = this.gatherTarget && !this.gatherTarget.collected ? this.gatherTarget : this.findNearestDandelion(runtime);
      if (!nextTarget) {
        this.gatherTarget = null;
        this.actor.clearMovementRequest();
        if (this.playerVisible && this.actor.wasProvoked && this.actor.dandelions > 0) this.enterCombatApproach(runtime, 0.6);
        else this.enterDisengagedPatrol(runtime);
        return;
      }

      const targetChanged = this.gatherTarget !== nextTarget;
      this.gatherTarget = nextTarget;
      const targetPos = getCollectibleReferencePosition(nextTarget)?.clone();
      if (targetPos) {
        const gatherStop = Math.max(0.35, Math.min(1.2, this.gatherCollectRadius * 0.18));
        const currentMoveTarget = this.actor.locomotion.target;
        const currentMatchesTarget = currentMoveTarget ? planarDistance(currentMoveTarget, targetPos) <= 0.35 : false;
        const arrivedAtCurrentGoal = currentMoveTarget
          ? planarDistance(this.actor.root.position, currentMoveTarget) <= Math.max((this.actor.locomotion.stopDistance ?? 0) + 0.2, 0.55)
          : false;

        if (targetChanged
          || !this.actor.hasMoveTarget()
          || this.replanCooldown <= 0
          || !currentMatchesTarget
          || arrivedAtCurrentGoal) {
          this.actor.requestMoveTarget(targetPos, gatherStop, 'run');
          this.replanCooldown = this.samplePhaseDuration(0.22, 0.14);
        }
      }

      if (this.gatherPurpose !== 'reserve'
        && this.actor.getAmmoConfidence(this.desiredCombatReserve) > 0.9
        && this.actor.rng() < 0.24 * delta * 4) {
        if (this.playerVisible && this.actor.wasProvoked) this.enterCombatApproach(runtime, 0.3);
        else this.enterPatrolHide(runtime);
      }
    }

    updateCombat(delta, runtime) {
      this.replanCooldown -= delta;
      const predictedOverlap = this.actor.weapon.estimateOverlapAgainstPlayer(runtime.playerPosition);
      const recentDamage = runtime.playerDamageWindowByNpc?.get(this.actor.id) ?? 0;
      const recentOverlap = runtime.playerOverlapWindowByNpc?.get(this.actor.id) ?? 0;
      const canFireNow = this.actor.weapon.canFireAt(runtime.playerPosition);

      if (this.shouldPerformCloudFlank(runtime) && this.phase !== 'combatFlank') {
        const playerToNpc = tempVectorC.copy(this.actor.root.position).sub(runtime.playerPosition).setY(0);
        let preferredSign = 0;
        if (playerToNpc.lengthSq() > 1e-8) {
          const playerRight = tempVectorB.crossVectors(runtime.playerForward, worldUp).normalize();
          preferredSign = Math.sign(playerToNpc.normalize().dot(playerRight));
          if (preferredSign === 0) preferredSign = this.actor.rng() < 0.5 ? -1 : 1;
        }
        this.enterCombatFlank(runtime, preferredSign);
        return;
      }

      if (this.shouldSeekDandelions(delta, runtime, this.phase === 'retreat' ? 'retreat' : 'combat')) {
        this.enterGather(runtime);
        return;
      }

      if (this.phase === 'combatFlank') {
        // Do not force lookToward(player) while locomotion is trying to rotate toward a side target:
        // that direct conflict is what caused visible jerking and poor flank completion.
        const needNewTarget = !this.actor.hasMoveTarget()
          || this.replanCooldown <= 0
          || planarDistance(this.actor.locomotion.target ?? this.actor.root.position, runtime.playerPosition) < this.flankDistanceMin * 0.45;
        if (needNewTarget) {
          const target = this.sampleSideApproachPoint(runtime, this.activeFlankSign);
          this.actor.requestMoveTarget(target, this.flankStopDistance, 'run');
          this.replanCooldown = this.samplePhaseDuration(0.24, 0.14);
        }

        const safeFromCloud = this.actor.lastOverlapRatio < this.flankTriggerOverlapThreshold * 0.42
          && this.actor.lastDamageTaken < this.flankTriggerDamageThreshold * 0.42;
        const flankEstablished = this.hasEstablishedFlank(runtime);
        const closeToFlankTarget = !this.actor.hasMoveTarget()
          || planarDistance(this.actor.root.position, this.actor.locomotion.target ?? this.actor.root.position) <= Math.max(this.flankStopDistance + 0.3, 1.1);

        if (flankEstablished && safeFromCloud) {
          this.flankLockoutRemaining = this.flankRecoveryCooldown;
          if (canFireNow && predictedOverlap >= this.attackReadinessOverlapThreshold * 0.58) {
            this.enterCombatWindup(runtime);
          } else {
            this.enterCombatApproach(runtime, Math.max(this.closerBias, 0.15));
          }
          return;
        }

        if (closeToFlankTarget && !safeFromCloud) {
          // We reached a side point but are still being clipped by the cloud.
          // Re-sample a more lateral / slightly rear position on the same side.
          const target = this.sampleSideApproachPoint(runtime, this.activeFlankSign);
          this.actor.requestMoveTarget(target, this.flankStopDistance, 'run');
          this.replanCooldown = this.samplePhaseDuration(0.18, 0.12);
        }

        if (this.actor.stateTime >= this.phaseDuration) {
          // Failsafe: if geometry did not settle, stop stalling in flank.
          this.flankLockoutRemaining = this.flankRecoveryCooldown * 0.7;
          if (canFireNow && predictedOverlap >= this.attackReadinessOverlapThreshold * 0.5) {
            this.enterCombatWindup(runtime);
          } else {
            this.enterCombatApproach(runtime, Math.max(this.closerBias, 0.35));
          }
          return;
        }
      } else if (this.phase === 'combatApproach') {
        this.actor.lookToward(runtime.playerPosition, delta, 0.8);
        const planarToPlayer = planarDistance(this.actor.root.position, runtime.playerPosition);
        const directChaseStop = computeDirectChaseStopDistance(this.actor, this.actor.weapon, this.attackReadinessOverlapThreshold);
        const pointBlankDistance = computePointBlankDistance(this.actor, this.actor.weapon);
        const attackReady = predictedOverlap >= this.attackReadinessOverlapThreshold
          || recentDamage > 0.01
          || recentOverlap >= this.attackReadinessOverlapThreshold * 0.72;

        const shouldCommitDirectChase = !canFireNow || !attackReady || planarToPlayer > pointBlankDistance + 0.2;

        if (shouldCommitDirectChase) {
          if (!this.actor.hasMoveTarget()
            || this.replanCooldown <= 0
            || planarDistance(this.actor.locomotion.target ?? this.actor.root.position, runtime.playerPosition) > directChaseStop + 0.35) {
            const chaseTarget = runtime.playerPosition.clone();
            chaseTarget.y = this.actor.getGroundHeightAt(chaseTarget.x, chaseTarget.z);
            this.actor.requestMoveTarget(chaseTarget, directChaseStop, 'run');
            this.replanCooldown = this.samplePhaseDuration(0.12, 0.1);
          }
        } else if (!this.actor.hasMoveTarget() || this.replanCooldown <= 0) {
          const dynamicBias = this.closerBias;
          const attackDistance = clamp(
            Math.min(this.actor.weapon.options.attackStopDistance, this.actor.weapon.options.range - 1.2) - dynamicBias * 1.35,
            2.4,
            this.actor.weapon.options.range - 0.6,
          );
          const target = this.samplePointAroundPlayer(runtime, Math.max(1.9, attackDistance - 0.8), attackDistance + 0.45, 'approach');
          this.actor.requestMoveTarget(target, 0.55, 'run');
          this.replanCooldown = this.samplePhaseDuration(0.22, 0.14);
        }

        if (canFireNow && this.shouldAttemptRunningShot(delta, runtime, predictedOverlap, recentDamage, recentOverlap, planarToPlayer)) {
          if (this.performRunningShot(runtime)) return;
        }

        if (canFireNow && (attackReady || planarToPlayer <= pointBlankDistance)) {
          this.enterCombatWindup(runtime);
          return;
        }
      } else if (this.phase === 'combatWindup') {
        this.actor.lookToward(runtime.playerPosition, delta, 1.0);

        if (!canFireNow) {
          if (this.actor.dandelions <= 0) this.enterGather(runtime);
          else this.enterCombatApproach(runtime, this.closerBias + 0.25);
          return;
        }

        if (this.actor.stateTime >= this.phaseDuration) {
          const planarToPlayer = planarDistance(this.actor.root.position, runtime.playerPosition);
          const pointBlankDistance = computePointBlankDistance(this.actor, this.actor.weapon);
          if (predictedOverlap < this.attackReadinessOverlapThreshold * 0.92
            && recentDamage <= 0.01
            && recentOverlap < this.attackReadinessOverlapThreshold * 0.7
            && planarToPlayer > pointBlankDistance) {
            this.enterCombatApproach(runtime, this.closerBias + 0.7);
            return;
          }
          const cloud = this.actor.weapon.fireAt(runtime.playerPosition);
          if (cloud) this.enterCombatObserve();
          else if (this.actor.dandelions <= 0) this.enterGather(runtime);
          else this.enterCombatApproach(runtime, this.closerBias + 0.45);
        }
      } else if (this.phase === 'combatObserve') {
        this.actor.clearMovementRequest();
        this.actor.lookToward(runtime.playerPosition, delta, 0.8);
        const attackWasEffective = recentDamage >= this.successfulAttackDamageThreshold || recentOverlap >= this.successfulAttackOverlapThreshold;
        if (attackWasEffective && this.actor.stateTime >= 0.18) {
          this.resolvePostAttack(runtime, true);
          return;
        }
        if (this.actor.stateTime >= this.phaseDuration) {
          this.resolvePostAttack(runtime, false);
          return;
        }
      } else {
        if (!this.actor.hasMoveTarget() || this.replanCooldown <= 0) {
          const target = this.samplePointAroundPlayer(runtime, this.retreatDistanceMin, this.retreatDistanceMax, 'retreat');
          this.actor.requestMoveTarget(target, 4.0, 'run');
          this.replanCooldown = this.samplePhaseDuration(0.95, 0.26);
        }

        if (this.actor.stateTime >= this.phaseDuration) {
          const ammoConfidence = this.actor.getAmmoConfidence(this.desiredCombatReserve);
          const reengageProbability = this.combatReengageProbability * lerp(0.38, 1.08, ammoConfidence);
          if (this.actor.dandelions > 0 && this.actor.rng() < reengageProbability) {
            this.enterCombatApproach(runtime, Math.max(0, this.closerBias - 0.15));
          } else if (this.shouldSeekDandelions(delta, runtime, 'retreat')) {
            this.enterGather(runtime);
          } else {
            this.enterPatrolHide(runtime);
          }
        }
      }
    }

    update(delta, runtime) {
      if (this.actor.defeated) return;

      this.flankLockoutRemaining = Math.max(0, this.flankLockoutRemaining - delta);
      this.runningShotDecisionCooldown = Math.max(0, this.runningShotDecisionCooldown - delta);
      const awareness = this.updatePlayerAwareness(delta, runtime);

      const playerProvoked = !runtime?.safeTimeActive && (this.actor.wasProvoked || this.hasPlayerStartedAttacking(runtime));
      if (playerProvoked) {
        this.actor.markProvoked();
      }

      if (runtime?.safeTimeActive && this.mode === 'combat') {
        this.enterDisengagedPatrol(runtime);
      }

      if (this.mode === 'combat' && this.actor.wasProvoked && !awareness.visible && this.timeSincePlayerSeen >= this.combatDisengageDelay) {
        this.enterReserveBehavior(runtime);
      } else if (this.actor.wasProvoked && awareness.visible) {
        // Important: do not rip the actor out of gatherDandelions every tick just because
        // the player is visible again. Gather-mode already contains its own explicit exits
        // back to combat after a successful pickup / reserve satisfaction / target loss.
        // Interrupting it here is exactly what made battle -> gather regress into the old bug.
        const canAutoReengage = this.mode === 'resource' ? false : true;

        if (this.mode !== 'combat' && canAutoReengage) {
          this.enterCombatApproach(runtime, 0.4);
        }
      }

      if (this.mode === 'combat') {
        this.updateCombat(delta, runtime);
      } else if (this.mode === 'resource') {
        this.updateGather(delta, runtime);
      } else {
        this.updatePatrol(delta, runtime);
      }
    }
  }

  class IdleNpcBehavior extends NpcBehaviorBase {
    update() {
      this.actor.clearMovementRequest();
    }
  }

  function createBehaviorController(actor, options = {}) {
    switch (options.type) {
      case 'duelistFsm':
      case 'duelist':
      case 'combat':
        return new HierarchicalDuelistBehavior(actor, options);
      case 'idle':
      default:
        return new IdleNpcBehavior(actor, options);
    }
  }

  class NpcActor {
    constructor(entry) {
      this.entry = entry;
      this.id = entry.id;
      this.label = entry.label;
      this.root = entry.object;
      this.maxHp = pickFirstDefined(entry.maxHp, config.combat.npcMaxHp);
      this.hp = this.maxHp;
      this.damageMultiplier = pickFirstDefined(entry.damageMultiplier, 1);
      this.dandelionsStartCount = pickFirstDefined(entry.npcDandelionsStartCount, config.npcDefaults.npcDandelionsStartCount, 8);
      this.dandelionCapacity = pickFirstDefined(entry.npcDandelionCapacity, config.npcDefaults.npcDandelionCapacity, Math.max(this.dandelionsStartCount, 12));
      this.dandelions = this.dandelionsStartCount;
      this.collectRadius = pickFirstDefined(entry.behavior?.gatherCollectRadius, config.npcDefaults.npcCollectRadius, 8);
      this.movement = {
        walkSpeed: pickFirstDefined(entry.movement?.walkSpeed, config.npcDefaults.movement.walkSpeed),
        runSpeed: pickFirstDefined(entry.movement?.runSpeed, config.npcDefaults.movement.runSpeed),
        turnSpeed: pickFirstDefined(entry.movement?.turnSpeed, config.npcDefaults.movement.turnSpeed),
        acceleration: pickFirstDefined(entry.movement?.acceleration, 28),
      };
      this.animationConfig = {
        idle: normalizeAnimationConfig(entry.animationClips?.idle),
        move: normalizeAnimationConfig(entry.animationClips?.move),
        attack: normalizeAnimationConfig(entry.animationClips?.attack),
        defeated: normalizeAnimationConfig(entry.animationClips?.defeated),
        alert: normalizeAnimationConfig(entry.animationClips?.alert),
      };

      this.localBounds = computeBoundingBoxInRootLocalSpace(this.root);
      this.volumeField = new NpcVolumeField(this, entry.cloudVolume ?? config.npcDefaults.cloudVolume);
      this.weapon = new NpcWeaponController(this, entry.cloudAttack ?? {});
      this.locomotion = new NpcLocomotionController(this);

      this.state = 'idle';
      this.stateTime = 0;
      this.lastOverlapRatio = 0;
      this.lastDamageTaken = 0;
      this.defeated = false;
      this.wasProvoked = false;
      this.lastAttackTime = -Infinity;

      this.rng = (() => {
        let seed = 0;
        const source = `${world.seed}:${this.id}`;
        for (let i = 0; i < source.length; i += 1) {
          seed = (seed * 31 + source.charCodeAt(i)) >>> 0;
        }
        return () => {
          seed = (seed + 0x6D2B79F5) >>> 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      })();

      this.behavior = createBehaviorController(this, entry.behavior ?? { type: 'duelistFsm' });

      this.mixer = null;
      this.actionsByName = new Map();
      this.activeAction = null;
      this.defaultMaterials = new Map();
      this.activeAnimationRole = null;
      this.setupVisualDefaults();
      this.setupAnimations();
      this.snapToGround();
      this.behavior.onEnter();
    }

    setupVisualDefaults() {
      this.root.traverse((node) => {
        if (!node.isMesh || !node.material) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material) => {
          if (!this.defaultMaterials.has(material.uuid)) {
            this.defaultMaterials.set(material.uuid, {
              material,
              emissive: material.emissive ? material.emissive.clone() : null,
              emissiveIntensity: material.emissiveIntensity ?? 0,
              color: material.color ? material.color.clone() : null,
            });
          }
        });
      });
    }

    setupAnimations() {
      const animations = this.root.userData.animations ?? [];
      if (!animations.length) return;
      this.mixer = new THREE.AnimationMixer(this.root);
      for (const clip of animations) {
        this.actionsByName.set(clip.name, this.mixer.clipAction(clip));
      }
      this.playAnimationRole('idle', 0.01);
    }

    resolveActionForRole(role) {
      const preferredNames = this.animationConfig[role] ?? [];
      for (const name of preferredNames) {
        const action = this.actionsByName.get(name);
        if (action) return action;
      }
      if (role === 'idle' && this.actionsByName.size) {
        return this.actionsByName.values().next().value;
      }
      return null;
    }

    playAnimationRole(role, fadeDuration = 0.18) {
      if (!this.mixer) return;
      const nextAction = this.resolveActionForRole(role);
      if (!nextAction || this.activeAction === nextAction) return;
      nextAction.reset();
      nextAction.enabled = true;
      nextAction.fadeIn(fadeDuration);
      nextAction.play();
      if (this.activeAction) this.activeAction.fadeOut(fadeDuration);
      this.activeAction = nextAction;
      this.activeAnimationRole = role;
    }

    setState(nextState) {
      if (this.state === nextState) return;
      this.state = nextState;
      this.stateTime = 0;
    }

    requestMoveTarget(target, stopDistance = 0, speedMode = 'walk') {
      const grounded = target.clone();
      grounded.y = this.getGroundHeightAt(grounded.x, grounded.z);
      this.locomotion.setTarget(grounded, stopDistance, speedMode);
    }

    clearMovementRequest() {
      this.locomotion.clearTarget();
    }

    hasMoveTarget() {
      return Boolean(this.locomotion.target);
    }

    distanceToMoveTarget() {
      if (!this.locomotion.target) return Infinity;
      return planarDistance(this.root.position, this.locomotion.target);
    }

    getAverageWorldScale() {
      tempVectorA.setFromMatrixScale(this.root.matrixWorld);
      return (tempVectorA.x + tempVectorA.y + tempVectorA.z) / 3;
    }

    getGroundHeightAt(x, z) {
      this.root.updateWorldMatrix(true, false);
      tempVectorA.setFromMatrixScale(this.root.matrixWorld);
      const scaleY = tempVectorA.y;
      return world.terrain.sampleHeight(x, z) - this.localBounds.min.y * scaleY;
    }

    snapToGround() {
      this.root.position.y = this.getGroundHeightAt(this.root.position.x, this.root.position.z);
    }

    clampAndGroundPosition() {
      const half = config.worldSize * 0.5;
      this.root.position.x = clamp(this.root.position.x, -half, half);
      this.root.position.z = clamp(this.root.position.z, -half, half);
      this.snapToGround();
      return this.root.position;
    }

    getMuzzleOrigin(heightFactor = 0.7) {
      this.root.updateWorldMatrix(true, true);
      const localCenterX = (this.localBounds.min.x + this.localBounds.max.x) * 0.5;
      const localCenterZ = (this.localBounds.min.z + this.localBounds.max.z) * 0.5;
      const localY = lerp(this.localBounds.min.y, this.localBounds.max.y, clamp(heightFactor, 0, 1));
      return new THREE.Vector3(localCenterX, localY, localCenterZ).applyMatrix4(this.root.matrixWorld);
    }

    getLinearVelocity(target = new THREE.Vector3()) {
      return this.locomotion.getVelocity(target);
    }

    getAmmoConfidence(reserve = config.npcDefaults.dandelionComfortReserve) {
      return clamp(this.dandelions / Math.max(reserve, 1), 0, 1);
    }

    addDandelions(amount) {
      this.dandelions = clamp(this.dandelions + Math.max(0, amount ?? 0), 0, this.dandelionCapacity);
      return this.dandelions;
    }

    consumeDandelion(amount = 1) {
      if (this.dandelions < amount) return false;
      this.dandelions -= amount;
      return true;
    }

    lookToward(targetPosition, delta, weight = 1) {
      if (weight <= 0) return;
      tempVectorA.copy(targetPosition).sub(this.root.position);
      tempVectorA.y = 0;
      if (tempVectorA.lengthSq() <= 1e-8) return;
      const targetYaw = Math.atan2(tempVectorA.x, tempVectorA.z);
      let deltaYaw = targetYaw - this.root.rotation.y;
      while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2;
      while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2;
      const maxStep = this.movement.turnSpeed * delta * weight;
      this.root.rotation.y += clamp(deltaYaw, -maxStep, maxStep);
    }

    markProvoked() {
      this.wasProvoked = true;
    }

    applyIncomingCloudDamage(delta, activeClouds) {
      if (this.defeated) {
        this.lastOverlapRatio = 0;
        this.lastDamageTaken = 0;
        return;
      }

      let strongestOverlap = 0;
      let accumulatedDamage = 0;

      for (const cloud of activeClouds) {
        if (!cloud?.tracking || cloud.team !== 'player') continue;
        const overlapRatio = this.volumeField.computeOverlapRatio(cloud.tracking);
        if (overlapRatio <= 0) continue;

        strongestOverlap = Math.max(strongestOverlap, overlapRatio);
        const effectiveDelta = cloud.claimDamageTime(this.id, delta, config.combat.maxDamageExposurePerCloudTarget);
        if (effectiveDelta <= 0) continue;

        const ageFade = 1 - smoothstep(0.65, 1.0, cloud.tracking.normalizedAge ?? 0);
        const damage = overlapRatio
          * config.combat.baseCloudDamagePerSecond
          * config.combat.playerDamageMultiplier
          * ageFade
          * effectiveDelta;
        accumulatedDamage += damage;
      }

      this.lastOverlapRatio = strongestOverlap;
      this.lastDamageTaken = accumulatedDamage;
      if (accumulatedDamage > 0) {
        this.hp = Math.max(0, this.hp - accumulatedDamage);
        this.markProvoked();
        if (this.hp <= 0) this.setDefeated();
      }
    }

    applyDamageTint() {
      // Намеренно оставляем внешний вид модели неизменным при получении урона.
      // Это важно и для встроенной тестовой модели, и для импортированных GLB:
      // никаких принудительных перекрасок или emissive-вспышек.
    }

    setDefeated() {
      if (this.defeated) return;
      this.defeated = true;
      this.setState('defeated');
      this.clearMovementRequest();
    }

    update(delta, runtime) {
      this.stateTime += delta;
      this.weapon.update(delta);
      this.volumeField.updateFromActor();
      this.applyIncomingCloudDamage(delta, runtime.activeClouds);

      if (!this.defeated) {
        this.behavior.update(delta, runtime);
        this.locomotion.update(delta);
      }

      this.applyDamageTint();
      const desiredRole = this.defeated ? 'defeated' : (this.behavior.getDesiredAnimationRole?.() ?? 'idle');
      this.playAnimationRole(desiredRole, 0.18);
      if (this.mixer) this.mixer.update(delta);
      this.volumeField.updateFromActor();
    }

    getPublicSnapshot() {
      return {
        id: this.id,
        label: this.label,
        position: this.root.position.clone(),
        state: this.state,
        hp: this.hp,
        maxHp: this.maxHp,
        dandelions: this.dandelions,
        lastOverlapRatio: this.lastOverlapRatio,
        lastDamageTaken: this.lastDamageTaken,
        defeated: this.defeated,
        boundingSphere: this.volumeField.boundingSphere.clone(),
      };
    }

    dispose() {
      if (this.mixer) this.mixer.stopAllAction();
      this.volumeField.dispose();
    }
  }

  class NpcSystem {
    constructor(entries = []) {
      this.entries = entries;
      this.actors = entries.map((entry) => new NpcActor(entry));
    }

    update(delta) {
      if (!this.actors.length) return;
      const runtime = {
        world,
        terrain: world.terrain,
        playerPosition: player.position.clone(),
        playerForward: getPlayerForwardPlanar(),
        playerHeight: getConfiguredPlayerHeight(),
        activeClouds: world.activeDandelionClouds,
        collectibles: world.collectibleEntries,
        collectWorldDandelion,
        playerDamageByNpcThisFrame: world.playerDamageByNpcThisFrame,
        playerOverlapByNpcThisFrame: world.playerOverlapByNpcThisFrame,
        playerDamageWindowByNpc: world.playerDamageWindowByNpc,
        playerOverlapWindowByNpc: world.playerOverlapWindowByNpc,
        playerHp: world.playerHp,
        playerMaxHp: world.playerMaxHp,
        safeTimeActive: Boolean(world.safeTimeActive),
        safeTimeRemaining: world.safeTimeRemaining ?? 0,
        elapsedTime: world.clock?.elapsedTime ?? 0,
        lastPlayerShotTime: world.lastPlayerShotTime,
        lastPlayerShotOrigin: world.lastPlayerShotOrigin,
      };

      for (const actor of this.actors) {
        actor.update(delta, runtime);
      }
    }

    getSnapshots() {
      return this.actors.map((actor) => actor.getPublicSnapshot());
    }

    dispose() {
      for (const actor of this.actors) actor.dispose();
      this.actors.length = 0;
    }
  }

  return {
    NpcBehaviorBase,
    IdleNpcBehavior,
    HierarchicalDuelistBehavior,
    NpcVolumeField,
    NpcActor,
    NpcSystem,
  };
}
