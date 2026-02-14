import Phaser from 'phaser';
import { RemotePlayersRenderer } from './RemotePlayersRenderer';
import { LocalPredictionController } from './LocalPredictionController';
import type { MatchSnapshotV1 } from '../ws/wsTypes';
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
  CAMPAIGN_ZONES,
  DEPTH_BOMB,
  DEPTH_BREAKABLE,
  DEPTH_ENEMY,
  DEPTH_FLAME,
  DEPTH_ITEM,
  DEPTH_PLAYER,
  FLAME_SEGMENT_SCALE,
  GAME_CONFIG,
  DOOR_CONFIG,
  BOSS_CONFIG,
} from './config';
import {
  campaignStateToLevelIndex,
  computeNextCampaignState,
  loadCampaignState,
  saveCampaignState,
  type CampaignState,
} from './campaign';
import {
  DOOR_REVEALED,
  PREBOSS_DOOR_REVEALED,
  EVENT_ASSET_PROGRESS,
  EVENT_READY,
  LEVEL_CLEARED,
  LEVEL_FAILED,
  LEVEL_STARTED,
  emitSimulationEvent,
  emitStats,
  emitCampaignState,
  gameEvents,
} from './gameEvents';
import { DoorController } from './DoorController';
import { createDeterministicRng, type DeterministicRng } from './rng';
import { BossController } from './boss/BossController';
import { createBossArena } from './boss/BossArena';
import { generateBossNodeStones } from './level/bossNode';
import type {
  ControlsState,
  Direction,
  EnemyKind,
  EnemyModel,
  EntityKind,
  EntityState,
  Facing,
  FlameArmAxis,
  FlameModel,
  FlameSegmentKind,
  LevelProgressModel,
  PlayerModel,
  PlayerStats,
  SimulationEvent,
  TileType,
} from './types';

interface TimedDirection {
  dir: Direction;
  justPressed: boolean;
}

const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];
const LEVELS_PER_ZONE = BOSS_CONFIG.zonesPerStage;
const MOVEMENT_SPEED_SCALE = 0.66;

export type SceneAudioSettings = {
  musicEnabled: boolean;
  sfxEnabled: boolean;
};

export class GameScene extends Phaser.Scene {
  private remotePlayers?: RemotePlayersRenderer;
  private prediction = new LocalPredictionController();
  private inputSeq = 0;
  private accumulator = 0;
  private readonly FIXED_DT = 1000 / 20;
  private localInputQueue: Array<{ seq: number; dx: number; dy: number }> = [];
  private localTgUserId?: string;
  private matchGridW: number = GAME_CONFIG.gridWidth;
  private matchGridH: number = GAME_CONFIG.gridHeight;
  private controls: ControlsState;
  private readonly baseSeed = 0x52494654;
  private readonly runId = 1;
  private rng: DeterministicRng = createDeterministicRng(this.baseSeed);
  private simulationTick = 0;
  private lastSnapshotTick = -1;
  private snapshotBuffer: MatchSnapshotV1[] = [];
  private readonly SNAPSHOT_BUFFER_SIZE = 10;
  private arena: ArenaModel = createArena(0, this.rng);
  private levelIndex = 0;
  private zoneIndex = 0;
  private levelInZone = 0;
  private isBossLevel = false;
  private bossAnchorKey: string | null = null;
  private progressionUnlockedStages = new Set<number>([0]);
  private campaignState: CampaignState = {
    stage: 1,
    zone: 1,
    score: 0,
    trophies: [],
  };

  private doorRevealed = false;
  private doorEntered = false;
  private isLevelCleared = false;
  private doorSprite?: Phaser.GameObjects.Rectangle;
  private doorIconSprite?: Phaser.GameObjects.Text;
  private doorEnterStartedAt: number | null = null;
  private waveSequence = 0;
  private enemySequence = 0;
  private bossController = new BossController(
    this,
    BOSS_CONFIG,
    {
      canOccupy: (x: number, y: number) => this.canBossOccupy(x, y),
      canSpawnMinion: (x: number, y: number) => this.canEnemyOccupy(x, y, '__boss-summon__'),
      spawnMinion: (x: number, y: number) => this.spawnEnemy(x, y, 'normal'),
      onPlayerHit: () => this.restartLevelAfterDeath(),
      onBossDefeated: () => this.handleBossDefeated(),
      onBossDamaged: (hp: number, maxHp: number) => this.emitSimulation('boss.damaged', this.time.now, { hp, maxHp }),
      onBossReveal: () => this.emitSimulation('boss.reveal', this.time.now, { ...this.getLevelProgressModel() }),
      onBossSpawned: (profile) => this.emitSimulation('boss.spawned', this.time.now, { profile }),
      getPlayerCell: () => ({ x: this.player.gridX, y: this.player.gridY }),
    },
  );

  private doorController = new DoorController(
    DOOR_CONFIG,
    {
      spawnNormalDoorWave: (count: number) => this.spawnDoorWave(count, 'normal', true),
      spawnEliteDoorWave: (count: number) => this.spawnDoorWave(count, 'elite', true),
      spawnPressureWave: (eliteCount: number, normalCount: number) => {
        this.spawnDoorWave(eliteCount, 'elite', false);
        this.spawnDoorWave(normalCount, 'normal', false);
      },
    },
    () => this.randomFloat(),
  );

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
    remoteDetonateUnlocked: false,
  };

  private enemies = new Map<string, EnemyModel>();
  private enemySprites = new Map<string, Phaser.GameObjects.Image>();
  private enemyNextMoveAt = new Map<string, number>();

  private playerSprite?: Phaser.GameObjects.Image;
  private bombSprites = new Map<string, Phaser.GameObjects.Image>();
  private itemSprites = new Map<string, Phaser.GameObjects.Image>();
  private flameSprites = new Map<string, Phaser.GameObjects.Image>();
  private activeFlames = new Map<string, FlameModel>();

  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private spaceKey?: Phaser.Input.Keyboard.Key;
  private detonateKey?: Phaser.Input.Keyboard.Key;
  private heldSince: Partial<Record<Direction, number>> = {};
  private nextRepeatAt: Partial<Record<Direction, number>> = {};
  private pendingDirection: Direction | null = null;
  private placeBombUntil = 0;
  private audioSettings: SceneAudioSettings = { musicEnabled: true, sfxEnabled: true };

  constructor(controls: ControlsState) {
    super('GameScene');
    this.controls = controls;
  }

  preload(): void {
    this.ensureFallbackTexture();

    this.load.on('progress', (progress: number) => {
      gameEvents.emit(EVENT_ASSET_PROGRESS, { progress });
    });

    this.load.on('fileprogress', (file: Phaser.Loader.File) => {
      const fileKey = typeof file?.key === 'string' ? file.key : undefined;
      gameEvents.emit(EVENT_ASSET_PROGRESS, { progress: this.load.progress, fileKey });
    });

    this.load.once('complete', () => {
      gameEvents.emit(EVENT_ASSET_PROGRESS, { progress: 1 });
    });

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
    this.ensurePolishedTextures();
    this.setAudioSettings(this.audioSettings);
    this.setupInput();
    this.setupCamera();
    this.remotePlayers = new RemotePlayersRenderer(this);
    this.remotePlayers.setTransform({ tileSize: GAME_CONFIG.tileSize, offsetX: 0, offsetY: 0 });
    const initialLevelIndex = this.loadProgress();
    this.startLevel(initialLevelIndex, true);
  }

  private ensurePolishedTextures(): void {
    const textureSize = 96;

    const createUnitTexture = (
      key: string,
      options: {
        fillColor: number;
        strokeColor: number;
        glowColor: number;
        markerColor: number;
        eyeColor: number;
        hasOuterHalo?: boolean;
      },
    ): void => {
      if (this.textures.exists(key)) return;

      const center = textureSize / 2;
      const g = this.add.graphics().setVisible(false);

      if (options.hasOuterHalo) {
        g.lineStyle(4, options.glowColor, 0.65);
        g.strokeCircle(center, center, 34);
      }

      const glowLayers = [
        { radius: 33, alpha: 0.16 },
        { radius: 30, alpha: 0.2 },
        { radius: 27, alpha: 0.24 },
      ];
      for (const layer of glowLayers) {
        g.fillStyle(options.glowColor, layer.alpha);
        g.fillCircle(center, center, layer.radius);
      }

      g.fillStyle(options.fillColor, 1);
      g.fillCircle(center, center, 24);
      g.lineStyle(4, options.strokeColor, 1);
      g.strokeCircle(center, center, 24);

      g.fillStyle(options.markerColor, 0.95);
      g.fillTriangle(center - 7, center - 16, center + 7, center - 16, center, center - 28);

      g.fillStyle(options.eyeColor, 0.95);
      g.fillCircle(center - 8, center - 4, 4);
      g.fillCircle(center + 8, center - 4, 4);

      g.generateTexture(key, textureSize, textureSize);
      g.destroy();
    };

    createUnitTexture('rr_player', {
      fillColor: 0x4ab3ff,
      strokeColor: 0xd8f1ff,
      glowColor: 0x2b6fbf,
      markerColor: 0xe9fbff,
      eyeColor: 0x0f2442,
    });

    createUnitTexture('rr_enemy_basic', {
      fillColor: 0xff6b6b,
      strokeColor: 0xfff1f1,
      glowColor: 0xbf3f57,
      markerColor: 0xffe3a6,
      eyeColor: 0x351423,
    });

    createUnitTexture('rr_enemy_elite', {
      fillColor: 0xb37cff,
      strokeColor: 0xf4e9ff,
      glowColor: 0x8a4ce3,
      markerColor: 0xfff6bc,
      eyeColor: 0x2c114b,
      hasOuterHalo: true,
    });
  }

  update(time: number, delta: number): void {
    if (this.isLevelCleared) return;

    this.accumulator += delta;
    while (this.accumulator >= this.FIXED_DT) {
      this.fixedUpdate();
      this.accumulator -= this.FIXED_DT;
    }

    this.consumeKeyboard();
    this.tickPlayerMovement(time);
    this.consumeMovementIntent(time);
    this.tryPlaceBomb(time);
    this.tryRemoteDetonate(time);
    this.processBombTimers(time);
    this.cleanupExpiredFlames(time);
    this.tickEnemies(time);
    this.bossController.update(time);
    this.updatePlayerStateFromTimers(time);
    this.syncSpritesFromArena(time);
    this.checkPlayerEnemyCollision();
    this.tryEnterDoor(time);
    if (!this.isBossLevel) {
      this.doorController.update(time, this.isLevelCleared);
    }
    this.updateDoorVisual(time);
  }

  private fixedUpdate(): void {
    this.simulationTick += 1;
    this.processLocalInputQueue();
    this.prediction.updateFixed();
    this.remotePlayers?.update(this.simulationTick, this.snapshotBuffer, this.localTgUserId);
  }

  private processLocalInputQueue(): void {
    const input = this.localInputQueue.shift();
    if (!input) return;

    this.applyLocalMove(input.dx, input.dy);

    // M16.2.1: record predicted state after local simulation applies the seq
    this.prediction.onLocalSimulated(input.seq, this.player.gridX, this.player.gridY);
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

  private getLevelProgressModel(): LevelProgressModel {
    return {
      zoneIndex: this.zoneIndex,
      levelInZone: this.levelInZone,
      levelIndex: this.levelIndex,
      isBossLevel: this.isBossLevel,
      isEndless: false,
      doorRevealed: this.doorRevealed,
      doorEntered: this.doorEntered,
      levelCleared: this.isLevelCleared,
    };
  }

  private emitCampaignState(): void {
    emitCampaignState({ ...this.campaignState });
  }

  private getCurrentZoneExitType(): 'normal' | 'boss_gate' | 'boss_exit' {
    const zoneId = this.levelInZone + 1;
    return CAMPAIGN_ZONES.find((zone) => zone.id === zoneId)?.exitType ?? 'normal';
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
    const mixed = (this.baseSeed ^ Math.imul(levelIndex + 1, 0x9e3779b1) ^ Math.imul(this.runId, 0x85ebca6b)) >>> 0;
    return mixed === 0 ? 0x6d2b79f5 : mixed;
  }

  private loadProgress(): number {
    const fallbackLevelIndex = 0;
    this.progressionUnlockedStages = new Set<number>([0]);

    try {
      const campaign = loadCampaignState();
      // TODO backend: merge initData campaign progress instead of localStorage
      this.campaignState = campaign;
      this.stats.score = campaign.score;
      this.progressionUnlockedStages = new Set<number>([...this.progressionUnlockedStages, campaign.stage - 1]);
      this.emitCampaignState();
      return campaignStateToLevelIndex(campaign);
    } catch {
      return fallbackLevelIndex;
    }
  }

  private syncCampaignAndPersist(): void {
    this.campaignState = {
      ...this.campaignState,
      score: Math.max(0, Math.floor(this.stats.score)),
    };
    saveCampaignState(this.campaignState);
    this.emitCampaignState();
  }

  private getShuffledEnemySpawnCells() {
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
    this.zoneIndex = Math.floor(this.levelIndex / LEVELS_PER_ZONE);
    const clampedZone = Math.min(this.zoneIndex, BOSS_CONFIG.stagesTotal - 1);
    if (!this.progressionUnlockedStages.has(clampedZone)) {
      this.levelIndex = clampedZone * LEVELS_PER_ZONE;
      this.zoneIndex = clampedZone;
    }
    this.levelInZone = this.levelIndex % LEVELS_PER_ZONE;
    this.isBossLevel = this.bossController.isBossLevel(this.levelIndex);
    // TODO(module-c): route to dedicated boss-level flow when zone milestones are added.
    // TODO(module-c): replace with endless progression branch when campaign is complete.

    this.simulationTick = 0;
    this.accumulator = 0;
    this.localInputQueue.length = 0;
    this.rng = createDeterministicRng(this.mixLevelSeed(this.levelIndex));
    this.isLevelCleared = false;
    this.doorRevealed = false;
    this.doorEntered = false;
    this.doorEnterStartedAt = null;
    this.waveSequence = 0;
    this.enemySequence = 0;
    this.bossAnchorKey = null;
    this.doorController.reset();
    this.clearDynamicSprites();

    this.arena = this.isBossLevel ? createBossArena() : createArena(this.levelIndex, this.rng);
    if (this.isBossLevel) {
      const bossNode = generateBossNodeStones(this.arena, this.rng, BOSS_CONFIG.anomalousStoneCount);
      this.bossAnchorKey = bossNode.anchorKey || null;
    }
    this.activeFlames.clear();
    this.enemies.clear();
    this.enemyNextMoveAt.clear();

    this.rebuildArenaTiles();
    this.spawnPlayer();
    this.spawnEnemies();
    this.bossController.reset({ arena: this.arena, isBossLevel: this.isBossLevel, playerCount: 1 });

    if (!keepScore) {
      this.stats = {
        capacity: GAME_CONFIG.defaultBombCapacity,
        placed: 0,
        range: GAME_CONFIG.defaultRange,
        score: 0,
        remoteDetonateUnlocked: false,
      };
    } else {
      this.stats.placed = 0;
    }

    emitStats(this.stats);
    if (this.playerSprite) this.cameras.main.startFollow(this.playerSprite, true, 0.2, 0.2);

    this.emitSimulation(LEVEL_STARTED, this.time.now, {
      ...this.getLevelProgressModel(),
      hiddenDoorKey: this.arena.hiddenDoorKey,
    });
  }

  private restartLevelAfterDeath(): void {
    this.stats.score = Math.max(0, this.stats.score - GAME_CONFIG.playerDeathPenalty);
    this.emitSimulation(LEVEL_FAILED, this.time.now, {
      ...this.getLevelProgressModel(),
      reason: 'player_death',
    });
    this.startLevel(this.levelIndex, true);
    this.syncCampaignAndPersist();
  }

  private advanceToNextLevel(time: number): void {
    this.doorEntered = true;
    this.isLevelCleared = true;
    this.emitSimulation(LEVEL_CLEARED, time, { ...this.getLevelProgressModel() });

    const nextCampaign = computeNextCampaignState(this.campaignState, this.bossController.isDefeated(), true);
    this.campaignState = {
      ...nextCampaign,
      score: Math.max(0, Math.floor(this.stats.score)),
      trophies: [...this.campaignState.trophies],
    };
    saveCampaignState(this.campaignState);
    this.emitCampaignState();
    this.progressionUnlockedStages.add(this.campaignState.stage - 1);

    const nextLevelIndex = campaignStateToLevelIndex(this.campaignState);
    this.startLevel(nextLevelIndex, true);
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
          .setDisplaySize(tileSize - 2, tileSize - 2)
          .setDepth(spec.depth ?? (tile === 'Floor' ? 0 : DEPTH_BREAKABLE))
          .setData('arenaTile', true);

        if (tile === 'BreakableBlock' || tile === 'ANOMALOUS_STONE') {
          block.setData('breakable', true);
          block.setData('gridX', x);
          block.setData('gridY', y);
        }
      }
    }

    this.bossController.clear();
    this.doorSprite?.destroy();
    this.doorIconSprite?.destroy();
    const doorPos = fromKey(this.arena.hiddenDoorKey);
    this.doorSprite = this.add
      .rectangle(doorPos.x * tileSize + tileSize / 2, doorPos.y * tileSize + tileSize / 2, tileSize - 8, tileSize - 8, 0x4a66cc)
      .setDepth(DEPTH_ITEM)
      .setVisible(false);
    this.doorIconSprite = this.add
      .text(doorPos.x * tileSize + tileSize / 2, doorPos.y * tileSize + tileSize / 2, '⚑', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: `${Math.floor(tileSize * 0.34)}px`,
        color: '#f7f2ff',
        stroke: '#2a1c4f',
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(DEPTH_ITEM + 1)
      .setVisible(false);
  }

  private revealDoor(time: number): void {
    if (this.doorRevealed) return;
    this.doorRevealed = true;
    this.doorSprite?.setVisible(true);
    const isBossGateDoor = this.getCurrentZoneExitType() === 'boss_gate' && !this.isBossLevel;
    this.doorIconSprite?.setVisible(isBossGateDoor);
    if (isBossGateDoor) {
      this.emitSimulation(PREBOSS_DOOR_REVEALED, time, { ...this.getLevelProgressModel() });
    }
    this.emitSimulation(DOOR_REVEALED, time, { ...this.getLevelProgressModel() });
  }

  private tryEnterDoor(time: number): void {
    if (!this.doorRevealed) return;
    if (this.isBossLevel && !this.bossController.isDefeated()) return;
    if (this.player.targetX !== null || this.player.targetY !== null) {
      this.doorEnterStartedAt = null;
      return;
    }

    const playerKey = toKey(this.player.gridX, this.player.gridY);
    if (playerKey !== this.arena.hiddenDoorKey) {
      this.doorEnterStartedAt = null;
      return;
    }

    if (this.doorEnterStartedAt === null) {
      this.doorEnterStartedAt = time;
      return;
    }

    if (time - this.doorEnterStartedAt >= DOOR_CONFIG.exitHoldMs) {
      this.advanceToNextLevel(time);
    }
  }



  private scaleMovementDuration(durationMs: number): number {
    return Math.round(durationMs / MOVEMENT_SPEED_SCALE);
  }

  private getScaledEnemyMoveInterval(kind: EnemyKind): number {
    const baseInterval = kind === 'elite'
      ? Math.max(GAME_CONFIG.enemyMoveIntervalMinMs, Math.floor(GAME_CONFIG.enemyMoveIntervalMs * 0.7))
      : GAME_CONFIG.enemyMoveIntervalMs;
    return this.scaleMovementDuration(baseInterval);
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
      .image(0, 0, this.getTextureKey(style))
      .setOrigin(style.origin?.x ?? 0.5, style.origin?.y ?? 0.5)
      .setDepth(style.depth ?? DEPTH_PLAYER)
      .setDisplaySize(tileSize * (style.scale ?? 0.74), tileSize * (style.scale ?? 0.74));
    this.placeLocalPlayerSpriteAt(this.player.gridX, this.player.gridY);
  }

  private spawnEnemies(): void {
    if (this.isBossLevel) return;
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
        kind: 'normal',
        moveIntervalMs: this.getScaledEnemyMoveInterval('normal'),
      });
      this.enemyNextMoveAt.set(key, 0);
    }
  }

  private setupInput(): void {
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.spaceKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.detonateKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
  }

  private consumeKeyboard(): void {
    if (!this.cursors) return;
    if (this.spaceKey && Phaser.Input.Keyboard.JustDown(this.spaceKey)) this.controls.placeBombRequested = true;
    if (this.detonateKey && Phaser.Input.Keyboard.JustDown(this.detonateKey)) this.controls.detonateRequested = true;
  }

  private tickPlayerMovement(time: number): void {
    if (this.player.targetX === null || this.player.targetY === null || !this.playerSprite) return;

    const progress = Phaser.Math.Clamp((time - this.player.moveStartedAt) / this.scaleMovementDuration(GAME_CONFIG.moveDurationMs), 0, 1);
    const px = Phaser.Math.Linear(this.player.moveFromX, this.player.targetX, progress);
    const py = Phaser.Math.Linear(this.player.moveFromY, this.player.targetY, progress);
    this.placeLocalPlayerSpriteAt(px, py);

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
        this.nextRepeatAt[dir] = time + this.scaleMovementDuration(GAME_CONFIG.moveRepeatDelayMs);
        intents.push({ dir, justPressed: true });
        continue;
      }

      const repeatAt = this.nextRepeatAt[dir] ?? Number.POSITIVE_INFINITY;
      if (time >= repeatAt) {
        this.nextRepeatAt[dir] = repeatAt + this.scaleMovementDuration(GAME_CONFIG.moveRepeatIntervalMs);
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

    const bomb = placeBomb(this.arena, this.player.gridX, this.player.gridY, this.stats.range, 'player-1', time + GAME_CONFIG.bombFuseMs);
    if (!bomb) return;

    this.player.state = 'placeBomb';
    this.placeBombUntil = time + 90;
    this.player.graceBombKey = bomb.key;
    this.stats.placed += 1;
    emitStats(this.stats);
    this.emitSimulation('bomb.placed', time, { key: bomb.key, x: bomb.x, y: bomb.y, range: bomb.range });
  }


  private tryRemoteDetonate(time: number): void {
    if (!this.controls.detonateRequested) return;
    this.controls.detonateRequested = false;
    if (!this.stats.remoteDetonateUnlocked) return;
    const target = [...this.arena.bombs.values()]
      .filter((bomb) => bomb.ownerId === 'player-1')
      .sort((a, b) => a.detonateAt - b.detonateAt || a.key.localeCompare(b.key))[0];
    if (!target) return;
    this.resolveBombDetonation(target.key, time);
    this.player.state = 'detonate';
    this.emitSimulation('bomb.remote_detonate', time, { key: target.key });
  }

  private processBombTimers(time: number): void {
    while (true) {
      const dueBomb = [...this.arena.bombs.values()]
        .filter((bomb) => time >= bomb.detonateAt)
        .sort((a, b) => a.detonateAt - b.detonateAt || a.key.localeCompare(b.key))[0];

      if (!dueBomb) break;
      this.resolveBombDetonation(dueBomb.key, time);
    }
  }

  private resolveBombDetonation(startKey: string, time: number): void {
    const queue: string[] = [startKey];
    const queued = new Set<string>(queue);
    let scoreChanged = false;

    while (queue.length > 0) {
      const key = queue.shift();
      if (!key) continue;

      const bomb = removeBomb(this.arena, key);
      if (!bomb) continue;

      this.stats.placed = Math.max(0, this.stats.placed - 1);
      const result = getExplosionResult(this.arena, bomb);
      const waveId = this.createWaveId();
      let doorRevealedThisWave = false;

      for (const block of result.destroyedBreakables) {
        const blockKey = toKey(block.x, block.y);
        const wasAnomalous = this.arena.tiles[block.y][block.x] === 'ANOMALOUS_STONE';
        destroyBreakable(this.arena, block.x, block.y);
        this.destroyBreakableSprite(block.x, block.y);
        this.stats.score += 10;
        scoreChanged = true;
        const dropped = wasAnomalous ? null : maybeDropItem(this.arena, block.x, block.y, this.randomFloat(), this.randomFloat());
        if (this.isBossLevel && wasAnomalous && this.bossAnchorKey === blockKey) {
          this.bossController.revealBoss();
        }
        if (toKey(block.x, block.y) === this.arena.hiddenDoorKey) {
          this.revealDoor(time);
          doorRevealedThisWave = true;
        }
        this.emitSimulation('breakable.destroyed', time, { x: block.x, y: block.y, item: dropped?.type ?? null, anomalous: wasAnomalous, isBossAnchor: this.bossAnchorKey === blockKey });
      }

      this.bossController.applyExplosionDamage(result.impacts);

      for (const impact of result.impacts) {
        const segment: FlameSegmentKind = impact.key === bomb.key ? 'center' : 'arm';
        const axis: FlameArmAxis | undefined = segment === 'arm' ? (impact.x === bomb.x ? 'vertical' : 'horizontal') : undefined;
        this.spawnFlame(impact.x, impact.y, time + GAME_CONFIG.flameLifetimeMs, segment, axis);
        this.hitEntitiesAt(impact.x, impact.y);
        this.tryRegisterDoorWaveHit(impact.x, impact.y, waveId, time, doorRevealedThisWave);
      }

      for (const chainKey of result.chainBombKeys) {
        if (queued.has(chainKey)) continue;
        queue.push(chainKey);
        queued.add(chainKey);
      }

      this.emitSimulation('bomb.wave', time, { waveId, sourceBombKey: bomb.key, impactedTiles: result.impacts.length });
    }

    emitStats(this.stats);
    if (scoreChanged) this.syncCampaignAndPersist();
    this.emitSimulation('bomb.detonated', time, { key: startKey });
  }

  private createWaveId(): string {
    this.waveSequence += 1;
    return `wave-${this.levelIndex}-${this.simulationTick}-${this.waveSequence}`;
  }

  private tryRegisterDoorWaveHit(x: number, y: number, waveId: string, time: number, doorRevealedThisWave: boolean): void {
    if (this.isBossLevel) return;
    if (!this.doorRevealed) return;
    if (toKey(x, y) !== this.arena.hiddenDoorKey) return;
    if (doorRevealedThisWave) return;
    const accepted = this.doorController.handleExplosionWaveHit(waveId, time);
    if (!accepted) return;
    const doorState = this.doorController.getDoorState();
    this.emitSimulation('door.hit', time, { waveId, doorHits: doorState.doorHits });
  }

  private tryPickupItem(x: number, y: number): void {
    const item = pickupItem(this.arena, x, y);
    if (!item) return;

    if (item.type === 'BombUp') {
      this.stats.capacity = Math.min(GAME_CONFIG.maxBombCapacity, this.stats.capacity + 1);
    } else {
      this.stats.range = Math.min(GAME_CONFIG.maxRange, this.stats.range + 1);
      this.stats.remoteDetonateUnlocked = true;
    }

    this.stats.score += 25;
    emitStats(this.stats);
    this.syncCampaignAndPersist();
    this.emitSimulation('item.picked', this.time.now, { key: item.key, type: item.type, x, y });
  }

  private spawnFlame(x: number, y: number, expiresAt: number, segment: FlameSegmentKind, axis?: FlameArmAxis): void {
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
        this.enemyNextMoveAt.set(enemy.key, time + enemy.moveIntervalMs);
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

      this.enemyNextMoveAt.set(enemy.key, time + enemy.moveIntervalMs);
    }
  }



  private getDoorSpawnCells(limit: number): Array<{ x: number; y: number }> {
    const origin = fromKey(this.arena.hiddenDoorKey);
    const visited = new Set<string>([toKey(origin.x, origin.y)]);
    const queue: Array<{ x: number; y: number }> = [{ x: origin.x, y: origin.y }];
    const result: Array<{ x: number; y: number }> = [];

    while (queue.length > 0 && result.length < limit) {
      const node = queue.shift();
      if (!node) break;
      for (const dir of DIRECTIONS) {
        const { dx, dy } = this.toDelta(dir);
        const nx = node.x + dx;
        const ny = node.y + dy;
        const key = toKey(nx, ny);
        if (visited.has(key)) continue;
        visited.add(key);
        if (!isInsideArena(nx, ny)) continue;
        queue.push({ x: nx, y: ny });
        if (!this.canEnemyOccupy(nx, ny, '__spawn__')) continue;
        result.push({ x: nx, y: ny });
        if (result.length >= limit) break;
      }
    }

    return result;
  }

  private spawnDoorWave(count: number, kind: EnemyKind, fanOut: boolean): void {
    if (count <= 0) return;
    const cells = fanOut ? this.getDoorSpawnCells(count) : this.getShuffledEnemySpawnCells().slice(0, count);
    for (const cell of cells) {
      this.spawnEnemy(cell.x, cell.y, kind);
    }
    this.emitSimulation('door.spawn.wave', this.time.now, { kind, count: cells.length, requested: count, fanOut });
  }

  private spawnEnemy(x: number, y: number, kind: EnemyKind): void {
    this.enemySequence += 1;
    const key = `enemy-live-${this.levelIndex}-${this.enemySequence}-${x}-${y}`;
    this.enemies.set(key, {
      key,
      gridX: x,
      gridY: y,
      facing: 'left',
      state: 'idle',
      kind,
      moveIntervalMs: this.getScaledEnemyMoveInterval(kind),
    });
    this.enemyNextMoveAt.set(key, this.time.now);
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
    if (scoreChanged) this.syncCampaignAndPersist();
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

  private clearDynamicSprites(): void {
    const groups = [this.bombSprites, this.itemSprites, this.flameSprites, this.enemySprites] as const;
    for (const group of groups) {
      for (const sprite of group.values()) sprite.destroy();
      group.clear();
    }
    this.bossController.clear();
    this.doorSprite?.destroy();
    this.doorSprite = undefined;
    this.doorIconSprite?.destroy();
    this.doorIconSprite = undefined;
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
      this.placeLocalPlayerSpriteAt(this.player.gridX, this.player.gridY);
    }
    this.playerSprite
      .setTexture('rr_player')
      .setAngle(this.getFacingAngle(this.player.facing))
      .setDisplaySize(
        tileSize * (playerStyle.scale ?? 0.74) * this.getPlayerBreathScale(time),
        tileSize * (playerStyle.scale ?? 0.74) * this.getPlayerBreathScale(time),
      )
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
      const anim = this.getEnemyAnimationState(enemy, time);
      sprite
        .setPosition(enemy.gridX * tileSize + tileSize / 2, enemy.gridY * tileSize + tileSize / 2 + anim.hoverOffset)
        .setTexture(enemy.kind === 'elite' ? 'rr_enemy_elite' : 'rr_enemy_basic')
        .setAngle(this.getFacingAngle(enemy.facing) + anim.extraRotation)
        .setDisplaySize(tileSize * (style.scale ?? 0.72) * anim.scale, tileSize * (style.scale ?? 0.72) * anim.scale)
        .setOrigin(style.origin?.x ?? 0.5, style.origin?.y ?? 0.5);
    }

    for (const [key, sprite] of this.enemySprites.entries()) {
      if (enemyKeys.has(key)) continue;
      sprite.destroy();
      this.enemySprites.delete(key);
    }
  }

  private getFacingAngle(facing: Facing): number {
    switch (facing) {
      case 'up':
        return 0;
      case 'right':
        return 90;
      case 'down':
        return 180;
      case 'left':
      default:
        return -90;
    }
  }

  private getPlayerBreathScale(time: number): number {
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.006);
    return Phaser.Math.Linear(1, 1.05, pulse);
  }

  private getEnemyAnimationState(enemy: EnemyModel, time: number): { scale: number; hoverOffset: number; extraRotation: number } {
    const waveSeed = enemy.key.length * 0.3;
    const wave = Math.sin(time * 0.005 + waveSeed);

    if (enemy.kind === 'elite') {
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.008 + waveSeed);
      return {
        scale: Phaser.Math.Linear(0.98, 1.08, pulse),
        hoverOffset: wave * 1.4,
        extraRotation: Math.sin(time * 0.0035 + waveSeed) * 6,
      };
    }

    return {
      scale: 1,
      hoverOffset: wave * 1.6,
      extraRotation: 0,
    };
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

  private getFlameSegmentSize(segment: FlameSegmentKind, axis: FlameArmAxis | undefined): { width: number; height: number } {
    if (segment === 'center') {
      return { width: FLAME_SEGMENT_SCALE.center, height: FLAME_SEGMENT_SCALE.center };
    }

    return axis === 'horizontal' ? FLAME_SEGMENT_SCALE.armHorizontal : FLAME_SEGMENT_SCALE.armVertical;
  }



  private updateDoorVisual(time: number): void {
    if (!this.doorSprite || !this.doorRevealed) return;
    const isPreBossLevel = this.getCurrentZoneExitType() === 'boss_gate';
    if (this.isBossLevel) {
      this.doorSprite.setFillStyle(0x4a66cc, 1);
      this.doorSprite.setScale(1);
      this.doorIconSprite?.setVisible(false);
      return;
    }
    if (isPreBossLevel) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.02);
      const tint = Phaser.Display.Color.Interpolate.ColorWithColor(
        Phaser.Display.Color.ValueToColor(0x7b3fe4),
        Phaser.Display.Color.ValueToColor(0xbd7dff),
        100,
        Math.floor(pulse * 100),
      );
      const color = Phaser.Display.Color.GetColor(tint.r, tint.g, tint.b);
      this.doorSprite.setFillStyle(color, 1);
      this.doorSprite.setScale(1 + pulse * 0.06);
      if (this.doorIconSprite) {
        this.doorIconSprite
          .setVisible(true)
          .setPosition(this.doorSprite.x, this.doorSprite.y)
          .setScale(1 + pulse * 0.04)
          .setAlpha(0.8 + pulse * 0.2);
      }
      return;
    }
    this.doorIconSprite?.setVisible(false);
    const doorState = this.doorController.getDoorState();
    if (!doorState.isTelegraphing) {
      this.doorSprite.setFillStyle(0x4a66cc, 1);
      this.doorSprite.setScale(1);
      return;
    }

    const pulse = 0.5 + 0.5 * Math.sin(time * 0.03);
    const tint = Phaser.Display.Color.Interpolate.ColorWithColor(
      Phaser.Display.Color.ValueToColor(0x4a66cc),
      Phaser.Display.Color.ValueToColor(0xff4d4d),
      100,
      Math.floor(pulse * 100),
    );
    const color = Phaser.Display.Color.GetColor(tint.r, tint.g, tint.b);
    this.doorSprite.setFillStyle(color, 1);
    this.doorSprite.setScale(1 + pulse * 0.08);
  }


  private canBossOccupy(x: number, y: number): boolean {
    if (!isInsideArena(x, y) || !canOccupyCell(this.arena, x, y)) return false;
    if (this.player.gridX === x && this.player.gridY === y) return false;
    for (const enemy of this.enemies.values()) {
      if (enemy.gridX === x && enemy.gridY === y) return false;
    }
    return true;
  }

  private handleBossDefeated(): void {
    this.stats.score += BOSS_CONFIG.defeatScoreReward;
    const earnedTrophies = Array.from(
      { length: BOSS_CONFIG.rewardTrophyAmount },
      (_, index) => `stage-${this.campaignState.stage}-boss-${Date.now()}-${index}`,
    );
    this.campaignState = {
      ...this.campaignState,
      trophies: [...this.campaignState.trophies, ...earnedTrophies],
    };
    const currentStage = Math.floor(this.levelIndex / LEVELS_PER_ZONE);
    const nextStage = Math.min(currentStage + 1, BOSS_CONFIG.stagesTotal - 1);
    this.progressionUnlockedStages.add(nextStage);
    emitStats(this.stats);
    this.emitSimulation('BOSS_DEFEATED', this.time.now, {
      reward: BOSS_CONFIG.defeatScoreReward,
      trophy: BOSS_CONFIG.rewardTrophyAmount,
      unlockedStage: nextStage,
    });
    this.revealDoor(this.time.now);
    this.syncCampaignAndPersist();
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
    return ASSET_REGISTRY.tile?.[tileType]?.none ?? { textureKey: 'fallback-missing', path: '', origin: { x: 0.5, y: 0.5 }, scale: 1, depth: DEPTH_BREAKABLE, alpha: 1 };
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

  public onLocalMatchInput(input: { seq: number; dx: number; dy: number }) {
    this.inputSeq = Math.max(this.inputSeq, input.seq);
    this.prediction.pushInput(input);
    this.enqueueLocalInput(input);
  }

  public setLocalTgUserId(id?: string) {
    this.localTgUserId = id;
  }

  private enqueueLocalInput(input: { seq: number; dx: number; dy: number }) {
    this.localInputQueue.push(input);
  }

  private applyLocalMove(dx: number, dy: number): boolean {
    const nextX = this.player.gridX + dx;
    const nextY = this.player.gridY + dy;

    if (!isInsideArena(nextX, nextY) || !canOccupyCell(this.arena, nextX, nextY)) {
      return false;
    }

    this.setLocalPlayerPosition(nextX, nextY);
    return true;
  }

  private placeLocalPlayerSpriteAt(x: number, y: number) {
    if (!this.playerSprite) return;

    const tileSize = GAME_CONFIG.tileSize;
    const bias = this.prediction.getVisualBias();
    this.playerSprite.setPosition(
      (x + bias.x) * tileSize + tileSize / 2,
      (y + bias.y) * tileSize + tileSize / 2,
    );
  }

  public getLocalPlayerPosition(): { x: number; y: number } {
    return { x: this.player.gridX, y: this.player.gridY };
  }

  public setLocalPlayerPosition(x: number, y: number) {
    this.player.gridX = x;
    this.player.gridY = y;
    this.player.targetX = null;
    this.player.targetY = null;

    this.placeLocalPlayerSpriteAt(x, y);
  }

  public pushMatchSnapshot(snapshot: MatchSnapshotV1, localTgUserId?: string): boolean {
    if (snapshot?.version !== 'match_v1') return false;
    if (snapshot.tick <= this.lastSnapshotTick) return false;

    if (localTgUserId) {
      this.localTgUserId = localTgUserId;
    }

    this.lastSnapshotTick = snapshot.tick;
    this.matchGridW = snapshot.world?.gridW ?? this.matchGridW;
    this.matchGridH = snapshot.world?.gridH ?? this.matchGridH;

    this.snapshotBuffer.push(snapshot);
    if (this.snapshotBuffer.length > this.SNAPSHOT_BUFFER_SIZE) {
      this.snapshotBuffer.shift();
    }

    this.remotePlayers?.onSnapshotBuffered(snapshot.tick, this.simulationTick);

    return true;
  }

  public applyMatchSnapshot(snapshot: MatchSnapshotV1, localTgUserId?: string) {
    const accepted = this.pushMatchSnapshot(snapshot, localTgUserId);
    if (!accepted) return;

    const effectiveLocalId = localTgUserId ?? this.localTgUserId;
    if (!effectiveLocalId) return;

    const me = snapshot.players?.find((p) => p.tgUserId === effectiveLocalId);
    if (!me) return;

    this.prediction.reconcile({
      serverX: me.x,
      serverY: me.y,
      localX: this.player.gridX,
      localY: this.player.gridY,
      lastInputSeq: me.lastInputSeq,
      setPosition: (x, y) => this.setLocalPlayerPosition(x, y),
      applyMove: (dx, dy) => this.applyLocalMove(dx, dy),
    });
  }


  public setAudioSettings(next: SceneAudioSettings): void {
    this.audioSettings = { ...next };
    if (this.sound) {
      this.sound.mute = !next.musicEnabled || !next.sfxEnabled;
    }
  }

  public getPredictionStats() {
    return this.prediction?.getStats?.() ?? null;
  }

  public getSimulationTick(): number {
    return this.simulationTick;
  }

  setNetRtt(rttMs: number | null, rttJitterMs: number): void {
    this.remotePlayers?.setNetworkRtt(rttMs, rttJitterMs, this.FIXED_DT);
  }

  public getLastSnapshotTick(): number {
    return this.lastSnapshotTick;
  }

  public getNetInterpStats(): {
    renderTick: number;
    baseDelayTicks: number;
    baseDelayTargetTicks: number;
    baseDelayStepCooldownMs: number;
    baseDelayStepCooldownTicks: number;
    delayTicks: number;
    minDelayTicks: number;
    maxDelayTicks: number;
    bufferSize: number;
    underrunRate: number;
    underrunCount: number;
    lateSnapshotCount: number;
    lateSnapshotEma: number;
    stallCount: number;
    extrapCount: number;
    extrapolatingTicks: number;
    stalled: boolean;
    rttMs: number | null;
    rttJitterMs: number;
    targetBufferPairs: number;
    targetBufferTargetPairs: number;
    adaptiveEveryTicks: number;
    adaptiveEveryTargetTicks: number;
    bufferHasReserve: boolean;
    tuning: {
      baseDelayMax: number;
      targetBufferMin: number;
      targetBufferMax: number;
      cadenceMin: number;
      cadenceMax: number;
    };
  } {
    return this.remotePlayers?.getDebugStats() ?? {
      renderTick: -1,
      baseDelayTicks: 2,
      baseDelayTargetTicks: 2,
      baseDelayStepCooldownMs: 20,
      baseDelayStepCooldownTicks: 20,
      delayTicks: 2,
      minDelayTicks: 1,
      maxDelayTicks: 10,
      bufferSize: this.snapshotBuffer.length,
      underrunRate: 0,
      underrunCount: 0,
      lateSnapshotCount: 0,
      lateSnapshotEma: 0,
      stallCount: 0,
      extrapCount: 0,
      extrapolatingTicks: 0,
      stalled: false,
      rttMs: null,
      rttJitterMs: 0,
      targetBufferPairs: 2,
      targetBufferTargetPairs: 2,
      adaptiveEveryTicks: 2,
      adaptiveEveryTargetTicks: 2,
      bufferHasReserve: false,
      tuning: {
        baseDelayMax: 10,
        targetBufferMin: 2,
        targetBufferMax: 6,
        cadenceMin: 2,
        cadenceMax: 8,
      },
    };
  }
}
