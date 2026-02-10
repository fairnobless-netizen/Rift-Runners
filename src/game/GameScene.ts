import Phaser from 'phaser';
import { createArena } from './arena';
import { GAME_CONFIG, LAYERS } from './config';
import { emitStats, EVENT_READY, gameEvents } from './gameEvents';
import type { ControlsState, ItemType, PlayerStats, TileType } from './types';

interface BombData {
  x: number;
  y: number;
  range: number;
  sprite: Phaser.GameObjects.Rectangle;
  fuseTimer: Phaser.Time.TimerEvent;
  escapedByOwner: boolean;
}

interface ItemData {
  x: number;
  y: number;
  type: ItemType;
  sprite: Phaser.GameObjects.Rectangle;
}

export class GameScene extends Phaser.Scene {
  private controls: ControlsState;

  private arena = createArena();

  private player = {
    x: 1,
    y: 1,
    moving: false,
    sprite: undefined as Phaser.GameObjects.Rectangle | undefined,
  };

  private stats: PlayerStats = {
    capacity: GAME_CONFIG.defaultBombCapacity,
    placed: 0,
    range: GAME_CONFIG.defaultRange,
    score: 0,
  };

  private bombs = new Map<string, BombData>();

  private items = new Map<string, ItemData>();

  private flames = new Map<string, Phaser.GameObjects.Rectangle>();

  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;

  private spaceKey?: Phaser.Input.Keyboard.Key;

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

  update(): void {
    this.consumeKeyboard();
    this.tryMoveFromControls();
    this.tryPlaceBomb();
  }

  private setupCamera(): void {
    const { tileSize, startZoom, minZoom, maxZoom, gridWidth, gridHeight } = GAME_CONFIG;
    const worldWidth = gridWidth * tileSize;
    const worldHeight = gridHeight * tileSize;

    this.cameras.main.setBounds(0, 0, worldWidth, worldHeight);
    this.cameras.main.startFollow(this.player.sprite!, true, 0.2, 0.2);
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
        }
      }
    }
  }

  private createPlayer(): void {
    const { tileSize } = GAME_CONFIG;
    this.player.sprite = this.add
      .rectangle(
        this.player.x * tileSize + tileSize / 2,
        this.player.y * tileSize + tileSize / 2,
        tileSize * 0.5,
        tileSize * 0.5,
        0x50d3ff,
      )
      .setDepth(LAYERS.player);
  }

  private setupInput(): void {
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.spaceKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
  }

  private consumeKeyboard(): void {
    if (!this.cursors) return;

    this.controls.up = this.controls.up || !!this.cursors.up.isDown;
    this.controls.down = this.controls.down || !!this.cursors.down.isDown;
    this.controls.left = this.controls.left || !!this.cursors.left.isDown;
    this.controls.right = this.controls.right || !!this.cursors.right.isDown;

    if (this.spaceKey && Phaser.Input.Keyboard.JustDown(this.spaceKey)) {
      this.controls.placeBombRequested = true;
    }
  }

  private tryMoveFromControls(): void {
    if (this.player.moving) return;

    if (this.controls.up) this.tryMove(0, -1);
    else if (this.controls.down) this.tryMove(0, 1);
    else if (this.controls.left) this.tryMove(-1, 0);
    else if (this.controls.right) this.tryMove(1, 0);

    this.controls.up = false;
    this.controls.down = false;
    this.controls.left = false;
    this.controls.right = false;
  }

  private tryMove(dx: number, dy: number): void {
    const nx = this.player.x + dx;
    const ny = this.player.y + dy;

    if (!this.isInside(nx, ny)) return;
    const tile = this.tileAt(nx, ny);
    if (tile === 'HardWall' || tile === 'BreakableBlock') return;

    const bomb = this.getBomb(nx, ny);
    if (bomb) {
      const isOwnerTile = this.player.x === bomb.x && this.player.y === bomb.y;
      if (!(isOwnerTile && !bomb.escapedByOwner)) return;
    }

    this.player.moving = true;
    const { tileSize, moveDurationMs } = GAME_CONFIG;
    this.tweens.add({
      targets: this.player.sprite,
      x: nx * tileSize + tileSize / 2,
      y: ny * tileSize + tileSize / 2,
      duration: moveDurationMs,
      ease: 'Sine.out',
      onComplete: () => {
        const oldX = this.player.x;
        const oldY = this.player.y;
        this.player.x = nx;
        this.player.y = ny;
        this.player.moving = false;
        this.markBombEscape(oldX, oldY, nx, ny);
        this.tryPickupItem(nx, ny);
      },
    });
  }

  private markBombEscape(oldX: number, oldY: number, newX: number, newY: number): void {
    if (oldX === newX && oldY === newY) return;
    const bomb = this.getBomb(oldX, oldY);
    if (bomb) {
      bomb.escapedByOwner = true;
    }
  }

  private tryPlaceBomb(): void {
    if (!this.controls.placeBombRequested) return;
    this.controls.placeBombRequested = false;

    if (this.stats.placed >= this.stats.capacity) return;
    if (this.getBomb(this.player.x, this.player.y)) return;

    const { tileSize, bombFuseMs } = GAME_CONFIG;
    const bombSprite = this.add
      .rectangle(
        this.player.x * tileSize + tileSize / 2,
        this.player.y * tileSize + tileSize / 2,
        tileSize * 0.46,
        tileSize * 0.46,
        0x222222,
      )
      .setDepth(LAYERS.bomb)
      .setStrokeStyle(2, 0xbac2d7);

    const key = this.key(this.player.x, this.player.y);
    const bomb: BombData = {
      x: this.player.x,
      y: this.player.y,
      range: this.stats.range,
      sprite: bombSprite,
      escapedByOwner: false,
      fuseTimer: this.time.delayedCall(bombFuseMs, () => this.detonateBomb(key)),
    };

    this.bombs.set(key, bomb);
    this.stats.placed += 1;
    emitStats(this.stats);
  }

  private detonateBomb(key: string): void {
    const bomb = this.bombs.get(key);
    if (!bomb) return;

    bomb.fuseTimer.remove(false);
    bomb.sprite.destroy();
    this.bombs.delete(key);
    this.stats.placed -= 1;

    const impacted = new Set<string>([this.key(bomb.x, bomb.y)]);

    const directions: Array<[number, number]> = [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ];

    for (const [dx, dy] of directions) {
      for (let step = 1; step <= bomb.range; step += 1) {
        const tx = bomb.x + dx * step;
        const ty = bomb.y + dy * step;
        if (!this.isInside(tx, ty)) break;

        const tile = this.tileAt(tx, ty);
        if (tile === 'HardWall') break;

        impacted.add(this.key(tx, ty));
        if (tile === 'BreakableBlock') {
          this.destroyBreakable(tx, ty);
          break;
        }
      }
    }

    impacted.forEach((coordKey) => {
      const [x, y] = coordKey.split(',').map(Number);
      this.spawnFlame(x, y);
      this.triggerBombAt(x, y);
      this.hitPlayerAt(x, y);
    });

    emitStats(this.stats);
  }

  private destroyBreakable(x: number, y: number): void {
    this.arena.tiles[y][x] = 'Floor';
    this.stats.score += 10;

    const found = this.children
      .list.filter((child) => child instanceof Phaser.GameObjects.Rectangle)
      .find(
        (child) =>
          Math.round((child.x - GAME_CONFIG.tileSize / 2) / GAME_CONFIG.tileSize) === x &&
          Math.round((child.y - GAME_CONFIG.tileSize / 2) / GAME_CONFIG.tileSize) === y &&
          child.depth === LAYERS.breakable,
      );

    if (found) {
      found.destroy();
    }

    if (Math.random() <= GAME_CONFIG.itemDropChance) {
      const type: ItemType = Math.random() < 0.5 ? 'BombUp' : 'FireUp';
      this.spawnItem(x, y, type);
    }
  }

  private spawnItem(x: number, y: number, type: ItemType): void {
    const { tileSize } = GAME_CONFIG;
    const color = type === 'BombUp' ? 0x77ff9a : 0xffc457;
    const sprite = this.add
      .rectangle(
        x * tileSize + tileSize / 2,
        y * tileSize + tileSize / 2,
        tileSize * 0.3,
        tileSize * 0.3,
        color,
      )
      .setDepth(LAYERS.item)
      .setStrokeStyle(2, 0x101010, 0.7);

    this.items.set(this.key(x, y), { x, y, type, sprite });
  }

  private tryPickupItem(x: number, y: number): void {
    const key = this.key(x, y);
    const item = this.items.get(key);
    if (!item) return;

    if (item.type === 'BombUp') {
      this.stats.capacity = Math.min(GAME_CONFIG.maxBombCapacity, this.stats.capacity + 1);
    } else {
      this.stats.range = Math.min(GAME_CONFIG.maxRange, this.stats.range + 1);
    }

    this.stats.score += 25;
    item.sprite.destroy();
    this.items.delete(key);
    emitStats(this.stats);
  }

  private spawnFlame(x: number, y: number): void {
    const key = this.key(x, y);
    if (this.flames.has(key)) return;

    const { tileSize, flameLifetimeMs } = GAME_CONFIG;
    const flame = this.add
      .rectangle(
        x * tileSize + tileSize / 2,
        y * tileSize + tileSize / 2,
        tileSize * 0.68,
        tileSize * 0.68,
        0xff6a3d,
      )
      .setDepth(LAYERS.flame)
      .setAlpha(0.95);

    this.flames.set(key, flame);
    this.time.delayedCall(flameLifetimeMs, () => {
      flame.destroy();
      this.flames.delete(key);
    });
  }

  private triggerBombAt(x: number, y: number): void {
    const key = this.key(x, y);
    if (this.bombs.has(key)) {
      this.detonateBomb(key);
    }
  }

  private hitPlayerAt(x: number, y: number): void {
    if (this.player.x !== x || this.player.y !== y) return;

    this.stats.score = Math.max(0, this.stats.score - 50);
    this.player.x = 1;
    this.player.y = 1;
    const { tileSize } = GAME_CONFIG;
    this.player.sprite?.setPosition(
      this.player.x * tileSize + tileSize / 2,
      this.player.y * tileSize + tileSize / 2,
    );
  }

  private getBomb(x: number, y: number): BombData | undefined {
    return this.bombs.get(this.key(x, y));
  }

  private isInside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < GAME_CONFIG.gridWidth && y < GAME_CONFIG.gridHeight;
  }

  private tileAt(x: number, y: number): TileType {
    return this.arena.tiles[y][x];
  }

  private key(x: number, y: number): string {
    return `${x},${y}`;
  }
}
