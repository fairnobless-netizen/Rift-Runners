import Phaser from 'phaser';
import {
  canOccupyCell,
  createArena,
  destroyBreakable,
  fromKey,
  getExplosionResult,
  isInsideArena,
  maybeDropItem,
  pickupItem,
  placeBomb,
  removeBomb,
  setBombOwnerEscaped,
  toKey,
} from './arena';
import { ASSET_REGISTRY, GAME_CONFIG, LAYERS } from './config';
import { emitStats, EVENT_READY, gameEvents } from './gameEvents';
import type {
  ControlsState,
  Direction,
  EntityKind,
  EntityState,
  Facing,
  ItemModel,
  PlayerModel,
  PlayerStats,
} from './types';

interface TimedDirection {
  dir: Direction;
  justPressed: boolean;
}

export class GameScene extends Phaser.Scene {
  private controls: ControlsState;

  private arena = createArena();

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

  private playerSprite?: Phaser.GameObjects.Rectangle;

  private bombSprites = new Map<string, Phaser.GameObjects.Rectangle>();

  private itemSprites = new Map<string, Phaser.GameObjects.Rectangle>();

  private flameSprites = new Map<string, Phaser.GameObjects.Rectangle>();

  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;

  private spaceKey?: Phaser.Input.Keyboard.Key;

  private heldSince: Partial<Record<Direction, number>> = {};

  private nextRepeatAt: Partial<Record<Direction, number>> = {};

  private pendingDirection: Direction | null = null;

  constructor(controls: ControlsState) {
    super('GameScene');
    this.controls = controls;
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1220');
    this.drawArena();
    this.createPlayer();
    this.setupInput();
    this.setupCamera();
    emitStats(this.stats);
  }

  update(time: number): void {
    this.consumeKeyboard();
    this.tickPlayerMovement(time);
    this.consumeMovementIntent(time);
    this.tryPlaceBomb(time);
    this.processBombTimers(time);
    this.cleanupExpiredFlames(time);
  }

  private setupCamera(): void {
    const { tileSize, startZoom, minZoom, maxZoom, gridWidth, gridHeight } = GAME_CONFIG;
    const worldWidth = gridWidth * tileSize;
    const worldHeight = gridHeight * tileSize;

    this.cameras.main.setBounds(0, 0, worldWidth, worldHeight);
    this.cameras.main.startFollow(this.playerSprite!, true, 0.2, 0.2);
    this.cameras.main.setZoom(startZoom);

    gameEvents.emit(EVENT_READY, {
      setZoom: (zoom: number) => {
        const clamped = Phaser.Math.Clamp(zoom, minZoom, maxZoom);
        this.cameras.main.setZoom(clamped);
      },
      resetZoom: () => {
        this.cameras.main.setZoom(startZoom);
      },
    });
  }

  private drawArena(): void {
    const { tileSize } = GAME_CONFIG;
    for (let y = 0; y < this.arena.tiles.length; y += 1) {
      for (let x = 0; x < this.arena.tiles[y].length; x += 1) {
        const tile = this.arena.tiles[y][x];
        const color =
          tile === 'HardWall' ? 0x3f4b63 : tile === 'BreakableBlock' ? 0x8f613f : 0x2a3249;

        const block = this.add
          .rectangle(
            x * tileSize + tileSize / 2,
            y * tileSize + tileSize / 2,
            tileSize - 2,
            tileSize - 2,
            color,
          )
          .setOrigin(0.5)
          .setDepth(tile === 'Floor' ? LAYERS.floor : LAYERS.breakable);

        if (tile === 'BreakableBlock') {
          block.setStrokeStyle(2, 0xb78153, 0.8);
          block.setData('breakable', true);
          block.setData('gridX', x);
          block.setData('gridY', y);
        }
      }
    }
  }

  private createPlayer(): void {
    const { tileSize } = GAME_CONFIG;
    const style = this.getAssetStyle('player', this.player.state, this.player.facing);
    this.playerSprite = this.add
      .rectangle(
        this.player.gridX * tileSize + tileSize / 2,
        this.player.gridY * tileSize + tileSize / 2,
        tileSize * (style.scale ?? 0.5),
        tileSize * (style.scale ?? 0.5),
        style.fillColor,
      )
      .setDepth(LAYERS.player);

    if (style.strokeColor) {
      this.playerSprite.setStrokeStyle(2, style.strokeColor);
    }
  }

  private setupInput(): void {
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.spaceKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
  }

  private consumeKeyboard(): void {
    if (!this.cursors) return;

    if (this.spaceKey && Phaser.Input.Keyboard.JustDown(this.spaceKey)) {
      this.controls.placeBombRequested = true;
    }
  }

  private tickPlayerMovement(time: number): void {
    if (this.player.targetX === null || this.player.targetY === null || !this.playerSprite) return;

    const duration = GAME_CONFIG.moveDurationMs;
    const progress = Phaser.Math.Clamp((time - this.player.moveStartedAt) / duration, 0, 1);

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
    this.updatePlayerVisual();
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
    const ordered: Direction[] = ['up', 'down', 'left', 'right'];
    const held = ordered.filter((dir) => this.isDirectionHeld(dir));

    if (held.length === 0) {
      for (const dir of ordered) {
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
    const offset = this.toDelta(direction);
    const nx = this.player.gridX + offset.dx;
    const ny = this.player.gridY + offset.dy;
    this.player.facing = direction;

    if (!isInsideArena(nx, ny)) {
      this.updatePlayerVisual();
      return;
    }

    if (!canOccupyCell(this.arena, nx, ny)) {
      this.updatePlayerVisual();
      return;
    }

    this.player.moveFromX = this.player.gridX;
    this.player.moveFromY = this.player.gridY;
    this.player.targetX = nx;
    this.player.targetY = ny;
    this.player.moveStartedAt = time;
    this.player.state = 'move';
    this.updatePlayerVisual();
  }

  private tryPlaceBomb(time: number): void {
    if (!this.controls.placeBombRequested) return;
    this.controls.placeBombRequested = false;

    if (this.stats.placed >= this.stats.capacity) return;

    const x = this.player.gridX;
    const y = this.player.gridY;
    const bomb = placeBomb(this.arena, x, y, this.stats.range, 'player-1', time + GAME_CONFIG.bombFuseMs);
    if (!bomb) return;

    this.player.state = 'placeBomb';
    this.player.graceBombKey = bomb.key;
    this.stats.placed += 1;
    this.renderBomb(bomb.key);
    this.updatePlayerVisual();
    emitStats(this.stats);
  }

  private processBombTimers(time: number): void {
    const dueBombs = [...this.arena.bombs.values()]
      .filter((bomb) => time >= bomb.detonateAt)
      .map((bomb) => bomb.key);

    for (const key of dueBombs) {
      this.detonateBomb(key, time);
    }
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

      this.destroyBombSprite(key);
      this.stats.placed = Math.max(0, this.stats.placed - 1);

      const result = getExplosionResult(this.arena, bomb);
      for (const block of result.destroyedBreakables) {
        destroyBreakable(this.arena, block.x, block.y);
        this.destroyBreakableSprite(block.x, block.y);
        this.stats.score += 10;

        const dropped = maybeDropItem(this.arena, block.x, block.y, Math.random(), Math.random());
        if (dropped) this.renderItem(dropped);
      }

      for (const impactedKey of result.impactedKeys) {
        const pos = fromKey(impactedKey);
        this.spawnFlame(pos.x, pos.y, time + GAME_CONFIG.flameLifetimeMs);
        this.hitPlayerAt(pos.x, pos.y);
      }

      for (const chainKey of result.chainBombKeys) {
        queue.push(chainKey);
      }
    }

    emitStats(this.stats);
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
    this.destroyItemSprite(item.key);
    emitStats(this.stats);
  }

  private renderBomb(key: string): void {
    const bomb = this.arena.bombs.get(key);
    if (!bomb) return;

    const style = this.getAssetStyle('bomb', 'active', 'none');
    const { tileSize } = GAME_CONFIG;
    const sprite = this.add
      .rectangle(
        bomb.x * tileSize + tileSize / 2,
        bomb.y * tileSize + tileSize / 2,
        tileSize * (style.scale ?? 0.46),
        tileSize * (style.scale ?? 0.46),
        style.fillColor,
      )
      .setDepth(LAYERS.bomb);

    if (style.strokeColor) sprite.setStrokeStyle(2, style.strokeColor);
    this.bombSprites.set(key, sprite);
  }

  private destroyBombSprite(key: string): void {
    const sprite = this.bombSprites.get(key);
    if (!sprite) return;
    sprite.destroy();
    this.bombSprites.delete(key);
  }

  private renderItem(item: ItemModel): void {
    const style = this.getAssetStyle('item', 'active', 'none');
    const color = item.type === 'BombUp' ? 0x77ff9a : style.fillColor;
    const { tileSize } = GAME_CONFIG;
    const sprite = this.add
      .rectangle(
        item.x * tileSize + tileSize / 2,
        item.y * tileSize + tileSize / 2,
        tileSize * (style.scale ?? 0.3),
        tileSize * (style.scale ?? 0.3),
        color,
      )
      .setDepth(LAYERS.item);

    if (style.strokeColor) sprite.setStrokeStyle(2, style.strokeColor, 0.7);
    this.itemSprites.set(item.key, sprite);
  }

  private destroyItemSprite(key: string): void {
    const sprite = this.itemSprites.get(key);
    if (!sprite) return;
    sprite.destroy();
    this.itemSprites.delete(key);
  }

  private spawnFlame(x: number, y: number, expiresAt: number): void {
    const key = toKey(x, y);
    if (this.flameSprites.has(key)) return;

    const style = this.getAssetStyle('flame', 'active', 'none');
    const { tileSize } = GAME_CONFIG;
    const flame = this.add
      .rectangle(
        x * tileSize + tileSize / 2,
        y * tileSize + tileSize / 2,
        tileSize * (style.scale ?? 0.68),
        tileSize * (style.scale ?? 0.68),
        style.fillColor,
      )
      .setDepth(LAYERS.flame)
      .setAlpha(style.alpha ?? 1);

    flame.setData('expiresAt', expiresAt);
    this.flameSprites.set(key, flame);
  }

  private cleanupExpiredFlames(time: number): void {
    for (const [key, flame] of this.flameSprites.entries()) {
      const expiresAt = flame.getData('expiresAt') as number;
      if (time < expiresAt) continue;
      flame.destroy();
      this.flameSprites.delete(key);
    }
  }

  private destroyBreakableSprite(x: number, y: number): void {
    const match = this.children.list.find((child) => {
      if (!(child instanceof Phaser.GameObjects.Rectangle)) return false;
      if (!child.getData('breakable')) return false;
      return child.getData('gridX') === x && child.getData('gridY') === y;
    });

    match?.destroy();
  }

  private hitPlayerAt(x: number, y: number): void {
    const playerOnCell =
      this.player.targetX === null
        ? this.player.gridX === x && this.player.gridY === y
        : this.player.targetX === x && this.player.targetY === y;

    if (!playerOnCell) return;

    this.stats.score = Math.max(0, this.stats.score - 50);
    this.player.gridX = 1;
    this.player.gridY = 1;
    this.player.targetX = null;
    this.player.targetY = null;
    this.player.state = 'idle';
    this.player.graceBombKey = null;

    const { tileSize } = GAME_CONFIG;
    this.playerSprite?.setPosition(
      this.player.gridX * tileSize + tileSize / 2,
      this.player.gridY * tileSize + tileSize / 2,
    );

    this.updatePlayerVisual();
  }

  private updatePlayerVisual(): void {
    if (!this.playerSprite) return;

    const style = this.getAssetStyle('player', this.player.state, this.player.facing);
    const { tileSize } = GAME_CONFIG;
    this.playerSprite
      .setFillStyle(style.fillColor)
      .setSize(tileSize * (style.scale ?? 0.5), tileSize * (style.scale ?? 0.5));

    if (style.strokeColor) {
      this.playerSprite.setStrokeStyle(2, style.strokeColor);
    } else {
      this.playerSprite.setStrokeStyle(0, 0, 0);
    }

    if (this.player.state === 'placeBomb') {
      this.time.delayedCall(70, () => {
        if (this.player.state === 'placeBomb') {
          this.player.state = 'idle';
          this.updatePlayerVisual();
        }
      });
    }
  }

  private getAssetStyle(kind: EntityKind, state: EntityState, facing: Facing | 'none') {
    return (
      ASSET_REGISTRY[kind]?.[state]?.[facing] ??
      ASSET_REGISTRY[kind]?.idle?.[facing] ??
      ASSET_REGISTRY[kind]?.active?.none ?? { fillColor: 0xffffff }
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
