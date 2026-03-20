import * as THREE from 'three';

const moveDirection = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const candidatePosition = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);

/**
 * Обновляет перемещение игрока по рельефу.
 *
 * Почему это вынесено в отдельный файл:
 * - main.js остаётся точкой сборки сцены, а не свалкой всей логики;
 * - алгоритм движения можно развивать отдельно: прыжок, гравитация, head bob, коллизии;
 * - проще тестировать и читать логику локальных осей движения.
 */
export function updatePlayerMovement(delta, { world, config, keys, player, clamp }) {
  if (!world.terrain) return;

  moveDirection.set(0, 0, 0);

  // Берём фактическое мировое направление rig'а и затем инвертируем его.
  // Для текущей иерархии объекта игровой "вперёд" совпадает с -Z,
  // а getWorldDirection() возвращает противоположную ориентацию, если
  // смотреть на player как на обычный Object3D.
  player.getWorldDirection(forward);
  forward.negate();
  forward.y = 0;

  if (forward.lengthSq() < 1e-8) {
    forward.set(0, 0, -1);
  } else {
    forward.normalize();
  }

  right.crossVectors(forward, worldUp).normalize();

  if (keys.KeyW) moveDirection.add(forward);
  if (keys.KeyS) moveDirection.sub(forward);
  if (keys.KeyD) moveDirection.add(right);
  if (keys.KeyA) moveDirection.sub(right);

  if (moveDirection.lengthSq() > 0) moveDirection.normalize();

  const speed = (keys.ShiftLeft || keys.ShiftRight)
    ? config.player.sprintSpeed
    : config.player.walkSpeed;

  candidatePosition.copy(player.position);
  candidatePosition.addScaledVector(moveDirection, speed * delta);

  const half = config.worldSize * 0.5;
  candidatePosition.x = clamp(candidatePosition.x, -half, half);
  candidatePosition.z = clamp(candidatePosition.z, -half, half);
  candidatePosition.y = world.terrain.sampleHeight(candidatePosition.x, candidatePosition.z);

  player.position.copy(candidatePosition);
}
