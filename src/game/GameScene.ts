import Phaser from 'phaser';
import {
  canOccupyCell,
  createArena,
  destroyBreakable,
  fromKey,
  getEnemyCountForLevel,
  getEnemySpawnCells,
  getExplosionResult,
  isInsideArena,
  maybeDropItem,
  pickupItem,
  placeBomb,
  removeBomb,
  setBombOwnerEscaped,
  toKey,
  type ArenaModel,
} from './arena';
import {
  ASSET_REGISTRY,
  BOMB_PULSE_CONFIG,
  DEPTH_BOMB,
  DEPTH_BREAKABLE,
  DEPTH_ENEMY,
  DEPTH_FLAME,
  DEPTH_ITEM,
  DEPTH_OVERLAY,
  DEPTH_PLAYER,
  FLAME_SEGMENT_SCALE,
  GAME_CONFIG,
} from './config';
import { emitSimulationEvent, emitStats, EVENT_READY, gameEvents } from './gameEvents';
import { createDeterministicRng, type DeterministicRng } from './rng';
import type {
  ControlsState,
  Direction,
  EnemyModel,
  EntityKind,
  EntityState,
  Facing,
  TileType,
  FlameArmAxis,
  FlameModel,
  FlameSegmentKind,
  PlayerModel,
  PlayerStats,
  SimulationEvent,
} from './types';

interface TimedDirection {
  dir: Direction;
  justPressed: boolean;
}

const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];

export class GameScene extends Phaser.Scene {
  private controls: ControlsState;
  private readonly baseSeed = 0x52494654;
  private readonly runId = 1;
  private rng: DeterministicRng = createDeterministicRng(this.baseSeed);
  private simulationTick = 0;
  private arena: ArenaModel = createArena(0, this.rng);
  private levelIndex = 0;

  private player: PlayerModel = {
    gridX: 1,
    gridY: 1,
    targetX: null,
    targetY: null,
    moveFromX: 1,
    moveFromY: 1,
    moveStartedAt: 0,
    facing: 'down',
    state: 'idle',
    graceBombKey: null,
  };

  private stats: PlayerStats = {
    capacity: GAME_CONFIG.defaultBombCapacity,
    placed: 0,
    range: GAME_CONFIG.defaultRange,
    score: 0,
  };

  private enemies = new Map<string, EnemyModel>();
  private enemySprites = new Map<string, Phaser.GameObjects.Image>();
  private enemyNextMoveAt = new Map<string, number>();

  private playerSprite?: Phaser.GameObjects.Image;
  private bombSprites = new Map<string, Phaser.GameObjects.Image>();
  private itemSprites = new Map<string, Phaser.GameObjects.Image>();
  private flameSprites = new Map<string, Phaser.GameObjects.Image>();
  private activeFlames = new Map<string, FlameModel>();

  private levelClearContainer?: Phaser.GameObjects.Container;
  private isLevelCleared = false;

  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private spaceKey?: Phaser.Input.Keyboard.Key;
  private heldSince: Partial<Record<Direction, number>> = {};
  private nextRepeatAt: Partial<Record<Direction, number>> = {};
  private pendingDirection: Direction | null = null;
  private placeBombUntil = 0;

  constructor(controls: ControlsState) {
    super('GameScene');
    this.controls = controls;
  }

  preload(): void {
    // Keep registry-driven loading centralized so scene render logic stays data-driven.
    this.ensureFallbackTexture();
    const seen = new Set<string>();

    for (const kind of Object.values(ASSET_REGISTRY)) {
      if (!kind) continue;
      for (const state of Object.values(kind)) {
        if (!state) continue;
        for (const asset of Object.values(state)) {
          if (!asset || seen.has(asset.textureKey)) continue;
          seen.add(asset.textureKey);
          this.load.image(asset.textureKey, asset.path);
        }
      }
    }
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1220');
    this.setupInput();
    this.setupCamera();
    this.startLevel(0, false);
  }

  update(time: number): void {
    if (this.isLevelCleared) return;

    this.simulationTick += 1;
    this.consumeKeyboard();
    this.tickPlayerMovement(time);
    this.consumeMovementIntent(time);
    this.tryPlaceBomb(time);
    this.processBombTimers(time);
    this.cleanupExpiredFlames(time);
    this.tickEnemies(time);
    this.updatePlayerStateFromTimers(time);
    this.syncSpritesFromArena(time);
    this.checkPlayerEnemyCollision();
  }

  private setupCamera(): void {
    const { tileSize, startZoom, minZoom, maxZoom, gridWidth, gridHeight } = GAME_CONFIG;
    const worldWidth = gridWidth * tileSize;
    const worldHeight = gridHeight * tileSize;
    this.cameras.main.setBounds(0, 0, worldWidth, worldHeight);
    this.cameras.main.setZoom(startZoom);

    gameEvents.emit(EVENT_READY, {
      setZoom: (zoom: number) => {
        const clamped = Phaser.Math.Clamp(zoom, minZoom, maxZoom);
        this.cameras.main.setZoom(clamped);
      },
      resetZoom: () => this.cameras.main.setZoom(startZoom),
    });
  }


  private emitSimulation(type: string, timeMs: number, payload: Record<string, unknown>): void {
    const event: SimulationEvent = {
      type,
      tick: this.simulationTick,
      timeMs,
      payload,
    };
    emitSimulationEvent(event);
  }

  private randomFloat(): number {
    return this.rng.nextFloat();
  }

  private randomInt(maxExclusive: number): number {
    return this.rng.nextInt(maxExclusive);
  }

  private mixLevelSeed(levelIndex: number): number {
    // backend-relevant: stable seed mix keeps level generation + drops reproducible for the same run seed.
    const mixed = (this.baseSeed ^ Math.imul(levelIndex + 1, 0x9e3779b1) ^ Math.imul(this.runId, 0x85ebca6b)) >>> 0;
    return mixed === 0 ? 0x6d2b79f5 : mixed;
  }

  private getShuffledEnemySpawnCells() {
    // Deterministic Fisher-Yates to keep enemy spawn order stable per seed.
    const cells = [...getEnemySpawnCells(this.arena)];
    for (let i = cells.length - 1; i > 0; i -= 1) {
      const j = this.randomInt(i + 1);
      const temp = cells[i];
      cells[i] = cells[j];
      cells[j] = temp;
    }
    return cells;
  }

  private startLevel(levelIndex: number, keepScore: boolean): void {
    this.levelIndex = Math.max(0, levelIndex);
    // backend-relevant: reset simulation timeline and RNG state for deterministic level restarts.
    this.simulationTick = 0;
    this.rng = createDeterministicRng(this.mixLevelSeed(this.levelIndex));
    this.isLevelCleared = false;
    this.clearLevelOverlay();
    this.clearDynamicSprites();

    this.arena = createArena(this.levelIndex, this.rng);
    this.activeFlames.clear();
    this.enemies.clear();
    this.enemyNextMoveAt.clear();

    this.rebuildArenaTiles();
    this.spawnPlayer();
    this.spawnEnemies();

    if (!keepScore) {
      this.stats = {
        capacity: GAME_CONFIG.defaultBombCapacity,
        placed: 0,
        range: GAME_CONFIG.defaultRange,
        score: 0,
      };
    } else {
      this.stats.placed = 0;
    }

    emitStats(this.stats);
    if (this.playerSprite) this.cameras.main.startFollow(this.playerSprite, true, 0.2, 0.2);
  }

  private restartLevelAfterDeath(): void {
    this.stats.score = Math.max(0, this.stats.score - GAME_CONFIG.playerDeathPenalty);
    this.emitSimulation('player.death', this.time.now, { level: this.levelIndex });
    this.startLevel(this.levelIndex, true);
  }

  private rebuildArenaTiles(): void {
    const stale = this.children.list.filter((child) => child.getData('arenaTile') === true);
    for (const node of stale) node.destroy();

    const { tileSize } = GAME_CONFIG;
    for (let y = 0; y < this.arena.tiles.length; y += 1) {
      for (let x = 0; x < this.arena.tiles[y].length; x += 1) {
        const tile = this.arena.tiles[y][x];
        const spec = this.getTileAssetStyle(tile);
        const block = this.add
          .image(x * tileSize + tileSize / 2, y * tileSize + tileSize / 2, this.getTextureKey(spec))
          .setOrigin(spec.origin?.x ?? 0.5, spec.origin?.y ?? 0.5)
          // Why: display size keeps world-space dimensions deterministic even with mixed source image sizes.
          .setDisplaySize(tileSize - 2, tileSize - 2)
          .setDepth(spec.depth ?? (tile === 'Floor' ? 0 : DEPTH_BREAKABLE))
          .setData('arenaTile', true);

        if (tile === 'BreakableBlock') {
          block.setData('breakable', true);
          block.setData('gridX', x);
          block.setData('gridY', y);
        }
      }
    }
  }

  private spawnPlayer(): void {
    this.player.gridX = 1;
    this.player.gridY = 1;
    this.player.targetX = null;
    this.player.targetY = null;
    this.player.moveFromX = 1;
    this.player.moveFromY = 1;
    this.player.moveStartedAt = 0;
    this.player.facing = 'down';
    this.player.state = 'idle';
    this.player.graceBombKey = null;

    const style = this.getAssetStyle('player', this.player.state, this.player.facing);
    const { tileSize } = GAME_CONFIG;
    this.playerSprite?.destroy();
    this.playerSprite = this.add
      .image(this.player.gridX * tileSize + tileSize / 2, this.player.gridY * tileSize + tileSize / 2, this.getTextureKey(style))
      .setOrigin(style.origin?.x ?? 0.5, style.origin?.y ?? 0.5)
      .setDepth(style.depth ?? DEPTH_PLAYER)
      .setDisplaySize(tileSize * (style.scale ?? 0.74), tileSize * (style.scale ?? 0.74));
  }

  private spawnEnemies(): void {
    const spawnCells = this.getShuffledEnemySpawnCells();
    const targetCount = Math.min(spawnCells.length, getEnemyCountForLevel(this.levelIndex));

    for (let i = 0; i < targetCount; i += 1) {
      const cell = spawnCells[i];
      const key = `enemy-${this.levelIndex}-${i}-${cell.x}-${cell.y}`;
      this.enemies.set(key, {
        key,
        gridX: cell.x,
        gridY: cell.y,
        facing: 'left',
        state: 'idle',
      });
      this.enemyNextMoveAt.set(key, 0);
    }
  }

  private setupInput(): void {
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.spaceKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
  }

  private consumeKeyboard(): void {
    if (!this.cursors) return;
    if (this.spaceKey && Phaser.Input.Keyboard.JustDown(this.spaceKey)) this.controls.placeBombRequested = true;
  }

  private tickPlayerMovement(time: number): void {
    if (this.player.targetX === null || this.player.targetY === null || !this.playerSprite) return;

    const progress = Phaser.Math.Clamp((time - this.player.moveStartedAt) / GAME_CONFIG.moveDurationMs, 0, 1);
    const { tileSize } = GAME_CONFIG;
    const px = Phaser.Math.Linear(this.player.moveFromX, this.player.targetX, progress);
    const py = Phaser.Math.Linear(this.player.moveFromY, this.player.targetY, progress);
    this.playerSprite.setPosition(px * tileSize + tileSize / 2, py * tileSize + tileSize / 2);

    if (progress < 1) return;

    const oldKey = toKey(this.player.moveFromX, this.player.moveFromY);
    this.player.gridX = this.player.targetX;
    this.player.gridY = this.player.targetY;
    this.player.targetX = null;
    this.player.targetY = null;
    this.player.state = 'idle';

    if (this.player.graceBombKey === oldKey) {
      setBombOwnerEscaped(this.arena, oldKey);
      this.player.graceBombKey = null;
    }

    this.tryPickupItem(this.player.gridX, this.player.gridY);
  }

  private consumeMovementIntent(time: number): void {
    const intent = this.pendingDirection ?? this.getDirectionIntent(time)?.dir;
    this.pendingDirection = null;
    if (!intent) return;

    if (this.player.targetX !== null) {
      this.pendingDirection = intent;
      return;
    }

    this.startMove(intent, time);
  }

  private getDirectionIntent(time: number): TimedDirection | null {
    const held = DIRECTIONS.filter((dir) => this.isDirectionHeld(dir));

    if (held.length === 0) {
      for (const dir of DIRECTIONS) {
        this.heldSince[dir] = undefined;
        this.nextRepeatAt[dir] = undefined;
      }
      return null;
    }

    const intents: TimedDirection[] = [];
    for (const dir of held) {
      const heldSince = this.heldSince[dir];
      if (heldSince === undefined) {
        this.heldSince[dir] = time;
        this.nextRepeatAt[dir] = time + GAME_CONFIG.moveRepeatDelayMs;
        intents.push({ dir, justPressed: true });
        continue;
      }

      const repeatAt = this.nextRepeatAt[dir] ?? Number.POSITIVE_INFINITY;
      if (time >= repeatAt) {
        this.nextRepeatAt[dir] = repeatAt + GAME_CONFIG.moveRepeatIntervalMs;
        intents.push({ dir, justPressed: false });
      }
    }

    if (intents.length === 0) return null;
    const fresh = intents.find((intent) => intent.justPressed);
    return fresh ?? intents[0];
  }

  private startMove(direction: Direction, time: number): void {
    const { dx, dy } = this.toDelta(direction);
    const nx = this.player.gridX + dx;
    const ny = this.player.gridY + dy;
    this.player.facing = direction;

    if (!isInsideArena(nx, ny) || !canOccupyCell(this.arena, nx, ny)) return;

    this.player.moveFromX = this.player.gridX;
    this.player.moveFromY = this.player.gridY;
    this.player.targetX = nx;
    this.player.targetY = ny;
    this.player.moveStartedAt = time;
    this.player.state = 'move';
    this.emitSimulation('player.move.start', time, { from: { x: this.player.moveFromX, y: this.player.moveFromY }, to: { x: nx, y: ny } });
  }

  private tryPlaceBomb(time: number): void {
    if (!this.controls.placeBombRequested) return;
    this.controls.placeBombRequested = false;
    if (this.stats.placed >= this.stats.capacity) return;

    const bomb = placeBomb(
      this.arena,
      this.player.gridX,
      this.player.gridY,
      this.stats.range,
      'player-1',
      time + GAME_CONFIG.bombFuseMs,
    );
    if (!bomb) return;

    this.player.state = 'placeBomb';
    this.placeBombUntil = time + 90;
    this.player.graceBombKey = bomb.key;
    this.stats.placed += 1;
    emitStats(this.stats);
    this.emitSimulation('bomb.placed', time, { key: bomb.key, x: bomb.x, y: bomb.y, range: bomb.range });
  }

  private processBombTimers(time: number): void {
    const dueBombs = [...this.arena.bombs.values()].filter((bomb) => time >= bomb.detonateAt).map((bomb) => bomb.key);
    for (const key of dueBombs) this.detonateBomb(key, time);
  }

  private detonateBomb(startKey: string, time: number): void {
    const queue = [startKey];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const key = queue.shift();
      if (!key || visited.has(key)) continue;
      visited.add(key);

      const bomb = removeBomb(this.arena, key);
      if (!bomb) continue;

      this.stats.placed = Math.max(0, this.stats.placed - 1);
      const result = getExplosionResult(this.arena, bomb);

      for (const block of result.destroyedBreakables) {
        destroyBreakable(this.arena, block.x, block.y);
        this.destroyBreakableSprite(block.x, block.y);
        this.stats.score += 10;
        const dropped = maybeDropItem(this.arena, block.x, block.y, this.randomFloat(), this.randomFloat());
        this.emitSimulation('breakable.destroyed', time, { x: block.x, y: block.y, item: dropped?.type ?? null });
      }

      for (const impactedKey of result.impactedKeys) {
        const pos = fromKey(impactedKey);
        const segment: FlameSegmentKind = impactedKey === bomb.key ? 'center' : 'arm';
        const axis: FlameArmAxis | undefined = segment === 'arm' ? (pos.x === bomb.x ? 'vertical' : 'horizontal') : undefined;
        this.spawnFlame(pos.x, pos.y, time + GAME_CONFIG.flameLifetimeMs, segment, axis);
        this.hitEntitiesAt(pos.x, pos.y);
      }

      for (const chainKey of result.chainBombKeys) queue.push(chainKey);
    }

    emitStats(this.stats);
    this.emitSimulation('bomb.detonated', time, { key: startKey });
  }

  private tryPickupItem(x: number, y: number): void {
    const item = pickupItem(this.arena, x, y);
    if (!item) return;

    if (item.type === 'BombUp') {
      this.stats.capacity = Math.min(GAME_CONFIG.maxBombCapacity, this.stats.capacity + 1);
    } else {
      this.stats.range = Math.min(GAME_CONFIG.maxRange, this.stats.range + 1);
    }

    this.stats.score += 25;
    emitStats(this.stats);
    this.emitSimulation('item.picked', this.time.now, { key: item.key, type: item.type, x, y });
  }

  private spawnFlame(
    x: number,
    y: number,
    expiresAt: number,
    segment: FlameSegmentKind,
    axis?: FlameArmAxis,
  ): void {
    const key = toKey(x, y);
    this.activeFlames.set(key, { key, x, y, expiresAt, segment, axis });
  }

  private cleanupExpiredFlames(time: number): void {
    for (const [key, flame] of this.activeFlames.entries()) {
      if (time >= flame.expiresAt) this.activeFlames.delete(key);
    }
  }

  private tickEnemies(time: number): void {
    for (const enemy of this.enemies.values()) {
      const next = this.enemyNextMoveAt.get(enemy.key) ?? 0;
      if (time < next) continue;

      const direction = this.chooseEnemyDirection(enemy);
      if (!direction) {
        this.enemyNextMoveAt.set(enemy.key, time + GAME_CONFIG.enemyMoveIntervalMs);
        enemy.state = 'idle';
        continue;
      }

      const { dx, dy } = this.toDelta(direction);
      const nx = enemy.gridX + dx;
      const ny = enemy.gridY + dy;
      if (this.canEnemyOccupy(nx, ny, enemy.key)) {
        enemy.gridX = nx;
        enemy.gridY = ny;
        enemy.facing = direction;
        enemy.state = 'move';
      } else {
        enemy.state = 'idle';
      }

      this.enemyNextMoveAt.set(enemy.key, time + GAME_CONFIG.enemyMoveIntervalMs);
    }
  }

  private chooseEnemyDirection(enemy: EnemyModel): Direction | null {
    const valid = DIRECTIONS.filter((dir) => {
      const { dx, dy } = this.toDelta(dir);
      return this.canEnemyOccupy(enemy.gridX + dx, enemy.gridY + dy, enemy.key);
    });

    if (valid.length === 0) return null;

    if (valid.includes(enemy.facing) && this.randomFloat() < GAME_CONFIG.enemyForwardBias) {
      return enemy.facing;
    }

    return valid[this.randomInt(valid.length)] ?? null;
  }

  private canEnemyOccupy(x: number, y: number, selfKey: string): boolean {
    if (!isInsideArena(x, y) || !canOccupyCell(this.arena, x, y)) return false;
    for (const enemy of this.enemies.values()) {
      if (enemy.key === selfKey) continue;
      if (enemy.gridX === x && enemy.gridY === y) return false;
    }
    return true;
  }

  private hitEntitiesAt(x: number, y: number): void {
    this.hitPlayerAt(x, y);
    let scoreChanged = false;
    for (const enemy of [...this.enemies.values()]) {
      if (enemy.gridX !== x || enemy.gridY !== y) continue;
      this.enemies.delete(enemy.key);
      this.enemyNextMoveAt.delete(enemy.key);
      this.enemySprites.get(enemy.key)?.destroy();
      this.enemySprites.delete(enemy.key);
      this.stats.score += GAME_CONFIG.enemyScore;
      this.emitSimulation('enemy.defeated', this.time.now, { key: enemy.key, x, y });
      scoreChanged = true;
    }
    if (scoreChanged) emitStats(this.stats);
    if (this.enemies.size === 0) this.showLevelClearOverlay();
  }

  private hitPlayerAt(x: number, y: number): void {
    const playerOnCell =
      this.player.targetX === null
        ? this.player.gridX === x && this.player.gridY === y
        : this.player.targetX === x && this.player.targetY === y;
    if (!playerOnCell) return;
    this.restartLevelAfterDeath();
  }

  private checkPlayerEnemyCollision(): void {
    if (this.player.targetX !== null || this.player.targetY !== null) return;
    for (const enemy of this.enemies.values()) {
      if (enemy.gridX === this.player.gridX && enemy.gridY === this.player.gridY) {
        this.restartLevelAfterDeath();
        return;
      }
    }
  }

  private showLevelClearOverlay(): void {
    if (this.isLevelCleared || this.levelClearContainer) return;
    this.isLevelCleared = true;

    const worldWidth = GAME_CONFIG.gridWidth * GAME_CONFIG.tileSize;
    const worldHeight = GAME_CONFIG.gridHeight * GAME_CONFIG.tileSize;

    const bg = this.add
      .rectangle(worldWidth / 2, worldHeight / 2, worldWidth, worldHeight, 0x000000, 0.5)
      .setDepth(DEPTH_OVERLAY)
      .setScrollFactor(0);
    const text = this.add
      .text(worldWidth / 2, worldHeight / 2 - 36, 'LEVEL CLEAR', {
        color: '#ffffff',
        fontSize: '30px',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(DEPTH_OVERLAY + 1)
      .setScrollFactor(0);

    const nextButton = this.add
      .rectangle(worldWidth / 2, worldHeight / 2 + 34, 132, 44, 0x2f3f72)
      .setDepth(DEPTH_OVERLAY + 1)
      .setScrollFactor(0)
      .setInteractive({ useHandCursor: true });
    const nextText = this.add
      .text(worldWidth / 2, worldHeight / 2 + 34, 'Next', { color: '#ecf1ff', fontSize: '20px' })
      .setOrigin(0.5)
      .setDepth(DEPTH_OVERLAY + 2)
      .setScrollFactor(0);

    nextButton.on('pointerdown', () => {
      this.startLevel(this.levelIndex + 1, true);
    });

    this.levelClearContainer = this.add.container(0, 0, [bg, text, nextButton, nextText]).setDepth(DEPTH_OVERLAY);
  }

  private clearLevelOverlay(): void {
    this.levelClearContainer?.destroy(true);
    this.levelClearContainer = undefined;
  }

  private clearDynamicSprites(): void {
    const groups = [this.bombSprites, this.itemSprites, this.flameSprites, this.enemySprites] as const;
    for (const group of groups) {
      for (const sprite of group.values()) sprite.destroy();
      group.clear();
    }
  }

  private destroyBreakableSprite(x: number, y: number): void {
    const match = this.children.list.find((child) => {
      if (!(child instanceof Phaser.GameObjects.Image)) return false;
      if (!child.getData('breakable')) return false;
      return child.getData('gridX') === x && child.getData('gridY') === y;
    });
    match?.destroy();
  }

  private updatePlayerStateFromTimers(time: number): void {
    if (this.player.targetX !== null) {
      this.player.state = 'move';
      return;
    }

    if (this.player.state === 'placeBomb' && time >= this.placeBombUntil) {
      this.player.state = 'idle';
    }
  }

  private syncSpritesFromArena(time: number): void {
    if (!this.playerSprite) return;

    const { tileSize } = GAME_CONFIG;

    const playerStyle = this.getAssetStyle('player', this.player.state, this.player.facing);
    if (this.player.targetX === null || this.player.targetY === null) {
      this.playerSprite.setPosition(this.player.gridX * tileSize + tileSize / 2, this.player.gridY * tileSize + tileSize / 2);
    }
    this.playerSprite
      .setTexture(this.getTextureKey(playerStyle))
      .setDisplaySize(tileSize * (playerStyle.scale ?? 0.74), tileSize * (playerStyle.scale ?? 0.74))
      .setOrigin(playerStyle.origin?.x ?? 0.5, playerStyle.origin?.y ?? 0.5)
      .setDepth(playerStyle.depth ?? DEPTH_PLAYER);

    const bombKeys = new Set(this.arena.bombs.keys());
    for (const bomb of this.arena.bombs.values()) {
      const sprite = this.bombSprites.get(bomb.key) ?? this.createBombSprite(bomb.key);
      if (!sprite) continue;

      const baseStyle = this.getAssetStyle('bomb', 'active', 'none');
      const remain = Phaser.Math.Clamp((bomb.detonateAt - time) / GAME_CONFIG.bombFuseMs, 0, 1);
      const warningRatio = Phaser.Math.Clamp(1 - (bomb.detonateAt - time) / BOMB_PULSE_CONFIG.warningThresholdMs, 0, 1);
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.02);
      const pulseScale = Phaser.Math.Linear(BOMB_PULSE_CONFIG.pulseMinScale, BOMB_PULSE_CONFIG.pulseMaxScale, pulse * warningRatio);
      const alpha = Phaser.Math.Linear(BOMB_PULSE_CONFIG.maxAlpha, BOMB_PULSE_CONFIG.minAlpha, warningRatio * (1 - remain));
      const shouldWarn = warningRatio > 0.1;

      sprite
        .setPosition(bomb.x * tileSize + tileSize / 2, bomb.y * tileSize + tileSize / 2)
        .setTexture(this.getTextureKey(baseStyle))
        .setDisplaySize(tileSize * (baseStyle.scale ?? 0.7) * pulseScale, tileSize * (baseStyle.scale ?? 0.7) * pulseScale)
        .setOrigin(baseStyle.origin?.x ?? 0.5, baseStyle.origin?.y ?? 0.5)
        .setAlpha(alpha)
        // Why: keep pulse warning visible without introducing extra animation state in the model.
        .setTint(shouldWarn ? 0xffc457 : 0xffffff);
    }

    for (const [key, sprite] of this.bombSprites.entries()) {
      if (bombKeys.has(key)) continue;
      sprite.destroy();
      this.bombSprites.delete(key);
    }

    const itemKeys = new Set(this.arena.items.keys());
    for (const item of this.arena.items.values()) {
      const sprite = this.itemSprites.get(item.key) ?? this.createItemSprite(item.key);
      if (!sprite) continue;

      const style = this.getAssetStyle('item', item.type === 'BombUp' ? 'pickup' : 'active', 'none');
      sprite
        .setPosition(item.x * tileSize + tileSize / 2, item.y * tileSize + tileSize / 2)
        .setTexture(this.getTextureKey(style))
        .setDisplaySize(tileSize * (style.scale ?? 0.48), tileSize * (style.scale ?? 0.48))
        .setOrigin(style.origin?.x ?? 0.5, style.origin?.y ?? 0.5)
        .setAlpha(style.alpha ?? 1);
    }

    for (const [key, sprite] of this.itemSprites.entries()) {
      if (itemKeys.has(key)) continue;
      sprite.destroy();
      this.itemSprites.delete(key);
    }

    const flameKeys = new Set(this.activeFlames.keys());
    for (const flame of this.activeFlames.values()) {
      const sprite = this.flameSprites.get(flame.key) ?? this.createFlameSprite(flame.key);
      if (!sprite) continue;

      const state = flame.segment === 'center' ? 'active' : flame.axis === 'vertical' ? 'move' : 'idle';
      const style = this.getAssetStyle('flame', state, 'none');
      const size = this.getFlameSegmentSize(flame.segment, flame.axis);
      sprite
        .setPosition(flame.x * tileSize + tileSize / 2, flame.y * tileSize + tileSize / 2)
        .setTexture(this.getTextureKey(style))
        .setDisplaySize(tileSize * size.width, tileSize * size.height)
        .setOrigin(style.origin?.x ?? 0.5, style.origin?.y ?? 0.5)
        .setAlpha(style.alpha ?? 1);
    }

    for (const [key, sprite] of this.flameSprites.entries()) {
      if (flameKeys.has(key)) continue;
      sprite.destroy();
      this.flameSprites.delete(key);
    }

    const enemyKeys = new Set(this.enemies.keys());
    for (const enemy of this.enemies.values()) {
      const sprite = this.enemySprites.get(enemy.key) ?? this.createEnemySprite(enemy.key);
      if (!sprite) continue;
      const style = this.getAssetStyle('enemy', enemy.state, enemy.facing);
      sprite
        .setPosition(enemy.gridX * tileSize + tileSize / 2, enemy.gridY * tileSize + tileSize / 2)
        .setTexture(this.getTextureKey(style))
        .setDisplaySize(tileSize * (style.scale ?? 0.72), tileSize * (style.scale ?? 0.72))
        .setOrigin(style.origin?.x ?? 0.5, style.origin?.y ?? 0.5);
    }

    for (const [key, sprite] of this.enemySprites.entries()) {
      if (enemyKeys.has(key)) continue;
      sprite.destroy();
      this.enemySprites.delete(key);
    }
  }

  private createBombSprite(key: string): Phaser.GameObjects.Image | null {
    const bomb = this.arena.bombs.get(key);
    if (!bomb) return null;

    const style = this.getAssetStyle('bomb', 'active', 'none');
    const { tileSize } = GAME_CONFIG;
    const sprite = this.add
      .image(bomb.x * tileSize + tileSize / 2, bomb.y * tileSize + tileSize / 2, this.getTextureKey(style))
      .setOrigin(style.origin?.x ?? 0.5, style.origin?.y ?? 0.5)
      .setDepth(style.depth ?? DEPTH_BOMB)
      .setDisplaySize(tileSize * (style.scale ?? 0.7), tileSize * (style.scale ?? 0.7));

    this.bombSprites.set(key, sprite);
    return sprite;
  }

  private createItemSprite(key: string): Phaser.GameObjects.Image | null {
    const item = this.arena.items.get(key);
    if (!item) return null;

    const style = this.getAssetStyle('item', item.type === 'BombUp' ? 'pickup' : 'active', 'none');
    const { tileSize } = GAME_CONFIG;
    const sprite = this.add
      .image(item.x * tileSize + tileSize / 2, item.y * tileSize + tileSize / 2, this.getTextureKey(style))
      .setOrigin(style.origin?.x ?? 0.5, style.origin?.y ?? 0.5)
      .setDepth(style.depth ?? DEPTH_ITEM)
      .setDisplaySize(tileSize * (style.scale ?? 0.48), tileSize * (style.scale ?? 0.48));

    this.itemSprites.set(key, sprite);
    return sprite;
  }

  private createFlameSprite(key: string): Phaser.GameObjects.Image | null {
    const flame = this.activeFlames.get(key);
    if (!flame) return null;

    const style = this.getAssetStyle('flame', flame.segment === 'center' ? 'active' : flame.axis === 'vertical' ? 'move' : 'idle', 'none');
    const { tileSize } = GAME_CONFIG;
    const size = this.getFlameSegmentSize(flame.segment, flame.axis);
    const sprite = this.add
      .image(flame.x * tileSize + tileSize / 2, flame.y * tileSize + tileSize / 2, this.getTextureKey(style))
      .setDisplaySize(tileSize * size.width, tileSize * size.height)
      .setOrigin(style.origin?.x ?? 0.5, style.origin?.y ?? 0.5)
      .setDepth(style.depth ?? DEPTH_FLAME)
      .setAlpha(style.alpha ?? 1);

    this.flameSprites.set(key, sprite);
    return sprite;
  }

  private createEnemySprite(key: string): Phaser.GameObjects.Image | null {
    const enemy = this.enemies.get(key);
    if (!enemy) return null;

    const style = this.getAssetStyle('enemy', enemy.state, enemy.facing);
    const { tileSize } = GAME_CONFIG;
    const sprite = this.add
      .image(enemy.gridX * tileSize + tileSize / 2, enemy.gridY * tileSize + tileSize / 2, this.getTextureKey(style))
      .setOrigin(style.origin?.x ?? 0.5, style.origin?.y ?? 0.5)
      .setDepth(style.depth ?? DEPTH_ENEMY)
      .setDisplaySize(tileSize * (style.scale ?? 0.72), tileSize * (style.scale ?? 0.72));

    this.enemySprites.set(key, sprite);
    return sprite;
  }

  private getFlameSegmentSize(
    segment: FlameSegmentKind,
    axis: FlameArmAxis | undefined,
  ): { width: number; height: number } {
    if (segment === 'center') {
      return { width: FLAME_SEGMENT_SCALE.center, height: FLAME_SEGMENT_SCALE.center };
    }

    return axis === 'horizontal' ? FLAME_SEGMENT_SCALE.armHorizontal : FLAME_SEGMENT_SCALE.armVertical;
  }


  private ensureFallbackTexture(): void {
    if (this.textures.exists('fallback-missing')) return;

    const g = this.make.graphics({ x: 0, y: 0 });
    g.fillStyle(0xff00ff, 1);
    g.fillRect(0, 0, 32, 32);
    g.lineStyle(5, 0x111111, 1);
    g.lineBetween(0, 0, 32, 32);
    g.lineBetween(0, 32, 32, 0);
    g.generateTexture('fallback-missing', 32, 32);
    g.destroy();
  }

  private getTextureKey(asset: { textureKey: string }): string {
    return this.textures.exists(asset.textureKey) ? asset.textureKey : 'fallback-missing';
  }

  private getAssetStyle(kind: Exclude<EntityKind, 'tile'>, state: EntityState, facing: Facing | 'none'): import('./types').AssetStyle {
    return (
      ASSET_REGISTRY[kind]?.[state]?.[facing] ??
      ASSET_REGISTRY[kind]?.idle?.[facing] ??
      ASSET_REGISTRY[kind]?.active?.none ??
      { textureKey: 'fallback-missing', path: '', origin: { x: 0.5, y: 0.5 }, scale: 1, depth: DEPTH_BREAKABLE, alpha: 1 }
    );
  }

  private getTileAssetStyle(tileType: TileType): import('./types').AssetStyle {
    return (
      ASSET_REGISTRY.tile?.[tileType]?.none ??
      { textureKey: 'fallback-missing', path: '', origin: { x: 0.5, y: 0.5 }, scale: 1, depth: DEPTH_BREAKABLE, alpha: 1 }
    );
  }

  private toDelta(direction: Direction): { dx: number; dy: number } {
    switch (direction) {
      case 'up':
        return { dx: 0, dy: -1 };
      case 'down':
        return { dx: 0, dy: 1 };
      case 'left':
        return { dx: -1, dy: 0 };
      case 'right':
        return { dx: 1, dy: 0 };
      default:
        return { dx: 0, dy: 0 };
    }
  }

  private isDirectionHeld(direction: Direction): boolean {
    if (this.controls[direction]) return true;
    if (!this.cursors) return false;

    switch (direction) {
      case 'up':
        return this.cursors.up.isDown;
      case 'down':
        return this.cursors.down.isDown;
      case 'left':
        return this.cursors.left.isDown;
      case 'right':
        return this.cursors.right.isDown;
      default:
        return false;
    }
  }
}
