import Phaser from 'phaser';
import { RemotePlayersRenderer } from './RemotePlayersRenderer';
import { LocalPredictionController } from './LocalPredictionController';
import type { MatchSnapshotV1 } from '@shared/protocol';
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
  DEPTH_FLOOR,
  DEPTH_ITEM,
  DEPTH_PLAYER,
  GAME_CONFIG,
  DOOR_CONFIG,
  BOSS_CONFIG,
  scaleMovementDurationMs,
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
  emitLifeState,
  emitZoomChanged,
  gameEvents,
  type GameMode,
} from './gameEvents';
import { DoorController } from './DoorController';
import { createDeterministicRng, type DeterministicRng } from './rng';
import { BossController } from './boss/BossController';
import { createBossArena } from './boss/BossArena';
import { generateBossNodeStones } from './level/bossNode';
import { getDeterministicArenaTileTexture } from './tileTextures';
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

interface FlameBeamModel {
  key: string;
  axis: FlameArmAxis;
  x: number;
  y: number;
  lengthTiles: number;
  expiresAt: number;
}

const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];
const LEVELS_PER_ZONE = BOSS_CONFIG.zonesPerStage;
const TURN_BUFFER_MS = 220;
const INITIAL_LIVES = 3;
const MAX_LIVES = 6;
const EXTRA_LIFE_STEP_SCORE = 1000;
const MP_RENDER_SNAP_DISTANCE_TILES = 1.5;

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
  private worldReady = false;
  private worldHashServer: string | null = null;
  private worldHashClient: string | null = null;
  private controls: ControlsState;
  private gameMode: GameMode = 'solo';
  private partySize = 1;
  private pickupsSpawnedThisLevel = 0;
  private lives = INITIAL_LIVES;
  private nextExtraLifeScore = EXTRA_LIFE_STEP_SCORE;
  private awaitingSoloContinue = false;
  private soloGameOver = false;
  private multiplayerEliminated = false;
  private multiplayerRespawning = false;
  private readonly baseSeed = 0x52494654;
  private readonly runId = 1;
  private rng: DeterministicRng = createDeterministicRng(this.baseSeed);
  private simulationTick = 0;
  private lastSnapshotTick = -1;
  private lastAppliedSnapshotTick = -1;
  private snapshotBuffer: MatchSnapshotV1[] = [];
  private currentRoomCode: string | null = null;
  private currentMatchId: string | null = null;
  private droppedWrongRoom = 0;
  private droppedWrongMatch = 0;
  private droppedDuplicateTick = 0;
  // MP local render smoothing (server-first local movement)
  private localRenderPos: { x: number; y: number } | null = null;
  private localSegment?: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    startTick: number;
    durationTicks: number;
  };
  private lastLocalTarget?: { x: number; y: number };
  private localRenderSnapCount = 0;
  private invalidPosDrops = 0;
  private lastSnapshotRoom: string | null = null;
  private needsNetResync = false;
  private netResyncReason: string | null = null;
  private lastInvalidPosWarnAtMs = 0;
  private lastInvalidPosWarnKey: string | null = null;
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
      onPlayerHit: () => this.handlePlayerDeath('enemy'),
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
    moveStartedAtMs: 0,
    moveDurationMs: 0,
    isMoving: false,
    facing: 'down',
    state: 'idle',
    graceBombKey: null,
  };

  private stats: PlayerStats = {
    capacity: GAME_CONFIG.defaultBombCapacity,
    placed: 0,
    range: GAME_CONFIG.defaultRange,
    score: 0,
    lives: INITIAL_LIVES,
    remoteDetonateUnlocked: false,
  };

  private enemies = new Map<string, EnemyModel>();
  private enemySprites = new Map<string, Phaser.GameObjects.Image>();
  private enemyNextMoveAt = new Map<string, number>();

  private playerSprite?: Phaser.GameObjects.Image;
  private bombSprites = new Map<string, Phaser.GameObjects.Image>();
  private itemSprites = new Map<string, Phaser.GameObjects.Image>();
  private flameSprites = new Map<string, Phaser.GameObjects.Image>();
  private flameBeamSprites = new Map<string, Phaser.GameObjects.Image>();
  private activeFlames = new Map<string, FlameModel>();
  private activeFlameBeams = new Map<string, FlameBeamModel>();

  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private spaceKey?: Phaser.Input.Keyboard.Key;
  private detonateKey?: Phaser.Input.Keyboard.Key;
  private heldSince: Partial<Record<Direction, number>> = {};
  private nextRepeatAt: Partial<Record<Direction, number>> = {};
  private desiredDirection: Direction | null = null;
  private queuedDirection: Direction | null = null;
  private queuedDirectionUntilMs = 0;
  private placeBombUntil = 0;
  private audioSettings: SceneAudioSettings = { musicEnabled: true, sfxEnabled: true };
  private minZoom: number = GAME_CONFIG.minZoom;
  private maxZoom: number = GAME_CONFIG.maxZoom;
  private pinchStartDistance: number | null = null;
  private pinchStartZoom: number | null = null;
  private cameraFollowThresholdZoom: number = GAME_CONFIG.minZoom;
  private isCameraFollowingPlayer = false;

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
    this.scale.on('resize', this.onScaleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onSceneShutdown, this);
    this.events.once(Phaser.Scenes.Events.DESTROY, this.onSceneShutdown, this);
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


    const createExplosionTexture = (key: string, axis: 'core' | 'horizontal' | 'vertical'): void => {
      if (this.textures.exists(key)) return;
      const g = this.add.graphics().setVisible(false);
      const center = textureSize / 2;
      g.fillStyle(0xff9f4f, 0.26);
      if (axis === 'core') {
        g.fillCircle(center, center, 38);
      } else if (axis === 'horizontal') {
        g.fillRoundedRect(4, center - 24, textureSize - 8, 48, 22);
      } else {
        g.fillRoundedRect(center - 24, 4, 48, textureSize - 8, 22);
      }

      g.fillStyle(0xffcf73, 0.92);
      if (axis === 'core') {
        g.fillCircle(center, center, 20);
        g.lineStyle(4, 0xfff5c4, 0.95);
        g.strokeCircle(center, center, 20);
      } else if (axis === 'horizontal') {
        g.fillRoundedRect(6, center - 12, textureSize - 12, 24, 12);
      } else {
        g.fillRoundedRect(center - 12, 6, 24, textureSize - 12, 12);
      }

      g.generateTexture(key, textureSize, textureSize);
      g.destroy();
    };

    const createPickupTexture = (key: string, color: number, icon: 'bomb' | 'flame' | 'speed' | 'life'): void => {
      if (this.textures.exists(key)) return;
      const g = this.add.graphics().setVisible(false);
      const center = textureSize / 2;

      g.fillStyle(color, 0.22);
      g.fillCircle(center, center, 34);
      g.fillStyle(0x20152e, 0.95);
      g.fillCircle(center, center, 27);
      g.lineStyle(5, color, 0.95);
      g.strokeCircle(center, center, 27);

      g.fillStyle(color, 0.96);
      if (icon === 'bomb') {
        g.fillCircle(center, center + 4, 10);
        g.fillRoundedRect(center + 8, center - 10, 9, 4, 2);
      } else if (icon === 'flame') {
        g.fillTriangle(center, center - 16, center - 11, center + 10, center + 11, center + 10);
        g.fillTriangle(center, center - 8, center - 6, center + 9, center + 6, center + 9);
      } else if (icon === 'speed') {
        g.fillTriangle(center - 12, center - 7, center + 5, center - 7, center - 2, center + 3);
        g.fillTriangle(center - 2, center - 2, center + 13, center - 2, center + 2, center + 12);
      } else {
        g.fillCircle(center, center - 4, 7);
        g.fillRoundedRect(center - 5, center + 1, 10, 14, 4);
      }

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

    createExplosionTexture('fx_explosion_core', 'core');
    createExplosionTexture('fx_explosion_beam_h', 'horizontal');
    createExplosionTexture('fx_explosion_beam_v', 'vertical');

    createPickupTexture('pickup_bomb', 0xf0cf65, 'bomb');
    createPickupTexture('pickup_flame', 0xff8f57, 'flame');
    createPickupTexture('pickup_speed', 0x6ed3ff, 'speed');
    createPickupTexture('pickup_life', 0xff88ad, 'life');
  }

  update(time: number, delta: number): void {
    if (this.isLevelCleared || this.awaitingSoloContinue || this.soloGameOver || this.multiplayerEliminated) return;

    this.accumulator += delta;
    while (this.accumulator >= this.FIXED_DT) {
      this.fixedUpdate();
      this.accumulator -= this.FIXED_DT;
    }

    let renderSimulationTick = 0;
    if (this.worldReady) {
      renderSimulationTick = this.simulationTick + this.accumulator / this.FIXED_DT;
      this.remotePlayers?.update(renderSimulationTick, this.snapshotBuffer, this.localTgUserId, delta);
    }

    this.consumeKeyboard();
    this.tickPlayerMovement(time);

    // Multiplayer: render local player from the same delayed playhead as remotes (no easing).
    this.tickMultiplayerRenderInterpolation(renderSimulationTick);

    this.consumeMovementIntent(time);
    if (this.gameMode !== 'multiplayer') {
      this.tryPlaceBomb(time);
      this.tryRemoteDetonate(time);
      this.processBombTimers(time);
    }
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
  }

  private processLocalInputQueue(): void {
    const input = this.localInputQueue.shift();
    if (!input) return;

    if (this.gameMode === 'multiplayer') {
      // Server-first mode in multiplayer: keep sending/acking input, but do not move local grid by prediction.
      return;
    }

    this.applyLocalMove(input.dx, input.dy);

    // M16.2.1: record predicted state after local simulation applies the seq
    this.prediction.onLocalSimulated(input.seq, this.player.gridX, this.player.gridY);
  }

  private setupCamera(): void {
    const { worldWidth, worldHeight } = this.getWorldDimensions();
    const { maxZoom } = GAME_CONFIG;
    const viewportWidth = Math.max(1, this.scale.width);
    const viewportHeight = Math.max(1, this.scale.height);
    const minZoom = Math.min(viewportWidth / worldWidth, viewportHeight / worldHeight);
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.cameraFollowThresholdZoom = minZoom * 1.05;
    this.cameras.main.setBounds(0, 0, worldWidth, worldHeight, true);
    // Keep sub-pixel rendering for smoother interpolation between tile centers.
    this.cameras.main.roundPixels = false;
    this.cameras.main.setDeadzone(this.scale.width * 0.26, this.scale.height * 0.26);
    this.applyZoom(minZoom, false);
    this.cameras.main.centerOn(worldWidth / 2, worldHeight / 2);
    this.emitReady();
  }

  private getWorldDimensions(): { worldWidth: number; worldHeight: number } {
    const { tileSize } = GAME_CONFIG;
    return {
      worldWidth: this.arena.width * tileSize,
      worldHeight: this.arena.height * tileSize,
    };
  }

  private emitReady(): void {
    gameEvents.emit(EVENT_READY, {
      minZoom: this.minZoom,
      maxZoom: this.maxZoom,
      setZoom: (zoom: number) => {
        this.applyZoom(zoom, false);
      },
      resetZoom: () => {
        const { worldWidth, worldHeight } = this.getWorldDimensions();
        this.applyZoom(this.minZoom, false);
        this.cameras.main.centerOn(worldWidth / 2, worldHeight / 2);
      },
    });
  }

  private onScaleResize(): void {
    const camera = this.cameras.main;
    const { worldWidth, worldHeight } = this.getWorldDimensions();
    const viewportWidth = Math.max(1, this.scale.width);
    const viewportHeight = Math.max(1, this.scale.height);

    const oldMinZoom = this.minZoom;
    const newMinZoom = Math.min(viewportWidth / worldWidth, viewportHeight / worldHeight);
    const wasAtMin = camera.zoom <= oldMinZoom * 1.01;

    this.minZoom = newMinZoom;
    this.cameraFollowThresholdZoom = newMinZoom * 1.05;
    camera.setBounds(0, 0, worldWidth, worldHeight, true);
    camera.setDeadzone(this.scale.width * 0.26, this.scale.height * 0.26);

    if (wasAtMin) {
      this.applyZoom(newMinZoom, true);
      this.cameras.main.centerOn(worldWidth / 2, worldHeight / 2);
    } else {
      this.applyZoom(camera.zoom, true);
    }

    this.emitReady();
  }

  private onSceneShutdown(): void {
    this.scale.off('resize', this.onScaleResize, this);
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
      this.nextExtraLifeScore = Math.floor(this.stats.score / EXTRA_LIFE_STEP_SCORE) * EXTRA_LIFE_STEP_SCORE + EXTRA_LIFE_STEP_SCORE;
      this.progressionUnlockedStages = new Set<number>([...this.progressionUnlockedStages, campaign.stage - 1]);
      this.emitCampaignState();
      this.emitLifeState();
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

  private getShuffledEnemySpawnCells(levelIndex: number = this.levelIndex): Array<{ x: number; y: number }> {
    const minDistance = Math.min(8, 4 + Math.floor(levelIndex / 2));
    const allCells = [...getEnemySpawnCells(this.arena)];
    const farCells = allCells.filter((cell) => Math.abs(cell.x - this.player.gridX) + Math.abs(cell.y - this.player.gridY) >= minDistance);
    const cells = farCells.length > 0 ? farCells : allCells;
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
    this.pickupsSpawnedThisLevel = 0;
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
    this.syncCameraBoundsToArena();
    this.spawnPlayer();
    this.spawnEnemies();
    this.bossController.reset({ arena: this.arena, isBossLevel: this.isBossLevel, playerCount: 1 });

    if (!keepScore) {
      this.stats = {
        capacity: GAME_CONFIG.defaultBombCapacity,
        placed: 0,
        range: GAME_CONFIG.defaultRange,
        score: 0,
        lives: this.lives,
        remoteDetonateUnlocked: false,
      };
      this.nextExtraLifeScore = EXTRA_LIFE_STEP_SCORE;
    } else {
      this.stats.placed = 0;
      this.stats.lives = this.lives;
    }

    emitStats(this.stats);
    this.emitLifeState();
    this.updateCameraFollowMode();

    this.emitSimulation(LEVEL_STARTED, this.time.now, {
      ...this.getLevelProgressModel(),
      hiddenDoorKey: this.arena.hiddenDoorKey,
    });
  }

  private handlePlayerDeath(reason: 'bomb' | 'enemy' = 'enemy'): void {
    if (this.awaitingSoloContinue || this.soloGameOver || this.multiplayerEliminated) return;

    this.stats.score = Math.max(0, this.stats.score - GAME_CONFIG.playerDeathPenalty);
    this.lives = Math.max(0, this.lives - 1);
    this.stats.lives = this.lives;
    this.emitSimulation(LEVEL_FAILED, this.time.now, {
      ...this.getLevelProgressModel(),
      reason: 'player_death',
      deathSource: reason,
      mode: this.gameMode,
      lives: this.lives,
    });

    if (this.gameMode === 'multiplayer') {
      if (this.lives <= 0) {
        this.multiplayerEliminated = true;
        this.multiplayerRespawning = false;
        this.clearMovementInputs();
        this.playerSprite?.setVisible(false);
        this.emitLifeState();
        emitStats(this.stats);
        this.syncCampaignAndPersist();
        return;
      }

      this.multiplayerRespawning = true;
      this.clearMovementInputs();
      this.playerSprite?.setVisible(false);
      this.emitLifeState();
      emitStats(this.stats);
      this.syncCampaignAndPersist();
      return;
    }

    if (this.lives <= 0) {
      this.soloGameOver = true;
      this.awaitingSoloContinue = false;
      this.clearMovementInputs();
      this.emitLifeState();
      emitStats(this.stats);
      this.syncCampaignAndPersist();
      return;
    }

    this.awaitingSoloContinue = true;
    this.clearMovementInputs();
    this.emitLifeState();
    emitStats(this.stats);
    this.syncCampaignAndPersist();
  }


  private clearMovementInputs(): void {
    this.controls.up = false;
    this.controls.down = false;
    this.controls.left = false;
    this.controls.right = false;
    this.controls.placeBombRequested = false;
    this.controls.detonateRequested = false;
    this.desiredDirection = null;
    this.queuedDirection = null;
    this.queuedDirectionUntilMs = 0;
  }

  private emitLifeState(): void {
    emitLifeState({
      lives: this.lives,
      maxLives: MAX_LIVES,
      mode: this.gameMode,
      awaitingContinue: this.awaitingSoloContinue,
      gameOver: this.soloGameOver,
      eliminated: this.multiplayerEliminated,
      respawning: this.multiplayerRespawning,
    });
  }

  private grantExtraLivesFromScore(): boolean {
    let changed = false;
    while (this.stats.score >= this.nextExtraLifeScore) {
      const prevLives = this.lives;
      this.lives = Math.min(MAX_LIVES, this.lives + 1);
      this.nextExtraLifeScore += EXTRA_LIFE_STEP_SCORE;
      if (this.lives !== prevLives) changed = true;
    }

    if (changed) {
      this.stats.lives = this.lives;
      this.emitLifeState();
      emitStats(this.stats);
    }

    return changed;
  }

  public setGameMode(mode: GameMode): void {
    this.gameMode = mode;
    this.prediction.setServerFirstMode(mode === 'multiplayer');
    if (mode === 'multiplayer') {
      this.triggerNetResync('reset_state');
    }
    this.awaitingSoloContinue = false;
    this.soloGameOver = false;
    this.multiplayerEliminated = false;
    this.multiplayerRespawning = false;
    this.playerSprite?.setVisible(true);
    this.emitLifeState();
  }

  public setPartySize(count: number): void {
    this.partySize = Phaser.Math.Clamp(Math.floor(count), 1, 4);
  }

  public continueSoloRun(): void {
    if (this.gameMode !== 'solo' || !this.awaitingSoloContinue || this.soloGameOver) return;
    this.awaitingSoloContinue = false;
    this.spawnPlayer();
    this.playerSprite?.setVisible(true);
    this.emitLifeState();
  }

  public restartSoloRun(): void {
    this.gameMode = 'solo';
    this.prediction.setServerFirstMode(false);
    this.awaitingSoloContinue = false;
    this.soloGameOver = false;
    this.multiplayerEliminated = false;
    this.multiplayerRespawning = false;
    this.playerSprite?.setVisible(true);
    this.lives = INITIAL_LIVES;
    this.nextExtraLifeScore = EXTRA_LIFE_STEP_SCORE;
    this.stats = {
      capacity: GAME_CONFIG.defaultBombCapacity,
      placed: 0,
      range: GAME_CONFIG.defaultRange,
      score: 0,
      lives: this.lives,
      remoteDetonateUnlocked: false,
    };
    this.campaignState = {
      stage: 1,
      zone: 1,
      score: 0,
      trophies: [...this.campaignState.trophies],
    };
    saveCampaignState(this.campaignState);
    this.emitCampaignState();
    emitStats(this.stats);
    this.emitLifeState();
    this.startLevel(0, false);
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
    const themeId = this.getArenaThemeId();

    for (let y = 0; y < this.arena.tiles.length; y += 1) {
      for (let x = 0; x < this.arena.tiles[y].length; x += 1) {
        const tile = this.arena.tiles[y][x];

        // Floor is always rendered (even under blocks).
        const floorTexture = getDeterministicArenaTileTexture(this, 'Floor', x, y, tileSize, this.arena.width, this.arena.height, themeId);
        this.add
          .image(x * tileSize + tileSize / 2, y * tileSize + tileSize / 2, floorTexture)
          .setOrigin(0.5, 0.5)
          // No more "tileSize - 2" gap grid; seams are inside texture.
          .setDisplaySize(tileSize, tileSize)
          .setDepth(DEPTH_FLOOR)
          .setData('arenaTile', true);

        if (tile === 'Floor') continue;

        const tileTexture = this.getPolishedTileTexture(tile, x, y);
        const block = this.add
          .image(x * tileSize + tileSize / 2, y * tileSize + tileSize / 2, tileTexture)
          .setOrigin(0.5, 0.5)
          .setDisplaySize(tileSize, tileSize)
          .setDepth(DEPTH_BREAKABLE)
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


  private getScaledEnemyMoveInterval(kind: EnemyKind): number {
    const baseInterval = kind === 'elite'
      ? Math.max(GAME_CONFIG.enemyMoveIntervalMinMs, Math.floor(GAME_CONFIG.enemyMoveIntervalMs * 0.7))
      : GAME_CONFIG.enemyMoveIntervalMs;
    return scaleMovementDurationMs(baseInterval);
  }
  private spawnPlayer(): void {
    this.player.gridX = 1;
    this.player.gridY = 1;
    this.player.targetX = null;
    this.player.targetY = null;
    this.player.moveFromX = 1;
    this.player.moveFromY = 1;
    this.player.moveStartedAtMs = 0;
    this.player.moveDurationMs = 0;
    this.player.isMoving = false;
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
    this.updateCameraFollowMode();
  }

  private spawnEnemies(): void {
    if (this.isBossLevel) return;
    const spawnCells = this.getShuffledEnemySpawnCells(this.levelIndex);
    const targetCount = Math.min(spawnCells.length, getEnemyCountForLevel(this.levelIndex));

    for (let i = 0; i < targetCount; i += 1) {
      const cell = spawnCells[i];
      const key = `enemy-${this.levelIndex}-${i}-${cell.x}-${cell.y}`;
      this.enemies.set(key, {
        key,
        gridX: cell.x,
        gridY: cell.y,
        moveFromX: cell.x,
        moveFromY: cell.y,
        targetX: cell.x,
        targetY: cell.y,
        moveStartedAtMs: 0,
        moveDurationMs: this.getScaledEnemyMoveInterval('normal'),
        isMoving: false,
        facing: 'left',
        state: 'idle',
        kind: 'normal',
        moveIntervalMs: this.getScaledEnemyMoveInterval('normal'),
      });
      this.enemyNextMoveAt.set(key, 0);
    }
  }


  private getMaxPickupsPerLevel(): number {
    return this.partySize * 2;
  }

  private trySpawnPickup(x: number, y: number): ReturnType<typeof maybeDropItem> {
    if (this.pickupsSpawnedThisLevel >= this.getMaxPickupsPerLevel()) return null;
    const remaining = this.getMaxPickupsPerLevel() - this.pickupsSpawnedThisLevel;
    const dropChance = remaining <= 2 ? 0.2 : 0.26;
    const dropped = maybeDropItem(this.arena, x, y, this.randomFloat(), this.randomFloat(), dropChance);
    if (!dropped) return null;
    this.pickupsSpawnedThisLevel += 1;
    return dropped;
  }

  private setupInput(): void {
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.spaceKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.detonateKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
    this.input.addPointer(2);

    this.input.on('pointerdown', () => {
      this.tryStartPinch();
    });

    this.input.on('pointermove', () => {
      this.handlePinchMove();
    });

    this.input.on('pointerup', () => {
      this.resetPinch();
    });

    this.input.on('pointerupoutside', () => {
      this.resetPinch();
    });
  }

  private consumeKeyboard(): void {
    if (!this.cursors) return;
    if (this.spaceKey && Phaser.Input.Keyboard.JustDown(this.spaceKey)) this.controls.placeBombRequested = true;
    if (this.detonateKey && Phaser.Input.Keyboard.JustDown(this.detonateKey)) this.controls.detonateRequested = true;
  }

  private applyZoom(zoom: number, emitEvent = true): void {
    const clamped = Phaser.Math.Clamp(zoom, this.minZoom, this.maxZoom);
    this.cameras.main.setZoom(clamped);
    this.updateCameraFollowMode();
    if (emitEvent) emitZoomChanged({ zoom: clamped });
  }

  private syncCameraBoundsToArena(): void {
    const { worldWidth, worldHeight } = this.getWorldDimensions();
    this.cameras.main.setBounds(0, 0, worldWidth, worldHeight, true);
  }

  private updateCameraFollowMode(): void {
    if (!this.playerSprite) return;

    const camera = this.cameras.main;
    const shouldFollow = camera.zoom > this.cameraFollowThresholdZoom;

    if (shouldFollow) {
      if (!this.isCameraFollowingPlayer) {
        camera.centerOn(this.playerSprite.x, this.playerSprite.y);
        camera.startFollow(this.playerSprite, true, 0.14, 0.14);
        this.isCameraFollowingPlayer = true;
      }
      return;
    }

    if (this.isCameraFollowingPlayer) {
      camera.stopFollow();
      this.isCameraFollowingPlayer = false;
    }
    camera.centerOn(this.playerSprite.x, this.playerSprite.y);
  }

  private getActivePointers(): Phaser.Input.Pointer[] {
    const pointers = [this.input.activePointer, ...this.input.manager.pointers];
    return pointers.filter((pointer, index, all) => pointer.isDown && all.indexOf(pointer) === index);
  }

  private getPinchDistance(): number | null {
    const active = this.getActivePointers();
    if (active.length < 2) return null;
    const [p1, p2] = active;
    return Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
  }

  private tryStartPinch(): void {
    const dist = this.getPinchDistance();
    if (!dist || dist <= 0) return;
    if (this.pinchStartDistance !== null) return;
    this.pinchStartDistance = dist;
    this.pinchStartZoom = this.cameras.main.zoom;
  }

  private handlePinchMove(): void {
    if (this.pinchStartDistance === null || this.pinchStartZoom === null) {
      this.tryStartPinch();
      return;
    }

    const dist = this.getPinchDistance();
    if (!dist || dist <= 0) {
      this.resetPinch();
      return;
    }

    const scale = dist / this.pinchStartDistance;
    this.applyZoom(this.pinchStartZoom * scale);
  }

  private resetPinch(): void {
    if (this.getActivePointers().length >= 2) return;
    this.pinchStartDistance = null;
    this.pinchStartZoom = null;
  }

  private tickPlayerMovement(time: number): void {
    if (this.player.targetX === null || this.player.targetY === null || !this.playerSprite) return;

    const duration = Math.max(1, this.player.moveDurationMs);
    const progress = Phaser.Math.Clamp((time - this.player.moveStartedAtMs) / duration, 0, 1);
    const px = Phaser.Math.Linear(this.player.moveFromX, this.player.targetX, progress);
    const py = Phaser.Math.Linear(this.player.moveFromY, this.player.targetY, progress);
    this.placeLocalPlayerSpriteAt(px, py);

    if (progress < 1) return;

    const oldKey = toKey(this.player.moveFromX, this.player.moveFromY);
    this.player.targetX = null;
    this.player.targetY = null;
    this.player.isMoving = false;
    this.player.moveDurationMs = 0;
    this.player.moveStartedAtMs = 0;
    this.player.state = 'idle';

    if (this.player.graceBombKey === oldKey) {
      setBombOwnerEscaped(this.arena, oldKey);
      this.player.graceBombKey = null;
    }

    this.tryPickupItem(this.player.gridX, this.player.gridY);

    // Simulation remains tile-based; this only chains buffered input so render
    // interpolation does not pause/jitter at tile boundaries.
    this.tryStartBufferedMove(time);
  }

  private consumeMovementIntent(time: number): void {
    // IMPORTANT: In multiplayer, movement is driven by match:input + prediction/reconcile.
    // Do not run solo movement intent logic, otherwise clients will move locally without server authority.
    if (this.gameMode === 'multiplayer') {
      return;
    }

    const inputIntent = this.getDirectionIntent(time);
    if (inputIntent) {
      this.desiredDirection = inputIntent.dir;
      this.queueDirection(inputIntent.dir, time);
    } else if (!this.hasHeldDirection()) {
      this.desiredDirection = null;
    }

    if (this.player.targetX !== null || this.player.targetY !== null) {
      return;
    }

    this.tryStartBufferedMove(time);
  }

  private tryStartBufferedMove(time: number): void {
    const candidate = this.getBufferedDirection(time) ?? this.desiredDirection;
    if (!candidate) return;
    if (!this.canStartPlayerMove(candidate)) return;

    this.startMove(candidate, time);

    if (this.queuedDirection === candidate) {
      this.queuedDirection = null;
      this.queuedDirectionUntilMs = 0;
    }
  }

  // Keep the latest intent for a short time so slightly-early turns are applied
  // on the first available tile decision point.
  private queueDirection(direction: Direction, time: number): void {
    this.queuedDirection = direction;
    this.queuedDirectionUntilMs = time + scaleMovementDurationMs(TURN_BUFFER_MS);
  }

  private getBufferedDirection(time: number): Direction | null {
    if (!this.queuedDirection) return null;
    if (time > this.queuedDirectionUntilMs) {
      this.queuedDirection = null;
      this.queuedDirectionUntilMs = 0;
      return null;
    }
    return this.queuedDirection;
  }

  private hasHeldDirection(): boolean {
    return DIRECTIONS.some((direction) => this.isDirectionHeld(direction));
  }

  private canStartPlayerMove(direction: Direction): boolean {
    const { dx, dy } = this.toDelta(direction);
    const nx = this.player.gridX + dx;
    const ny = this.player.gridY + dy;
    return isInsideArena(this.arena, nx, ny) && canOccupyCell(this.arena, nx, ny);
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
        this.nextRepeatAt[dir] = time + scaleMovementDurationMs(GAME_CONFIG.moveRepeatDelayMs);
        intents.push({ dir, justPressed: true });
        continue;
      }

      const repeatAt = this.nextRepeatAt[dir] ?? Number.POSITIVE_INFINITY;
      if (time >= repeatAt) {
        this.nextRepeatAt[dir] = repeatAt + scaleMovementDurationMs(GAME_CONFIG.moveRepeatIntervalMs);
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

    if (!isInsideArena(this.arena, nx, ny) || !canOccupyCell(this.arena, nx, ny)) return;

    this.player.moveFromX = this.player.gridX;
    this.player.moveFromY = this.player.gridY;
    this.player.targetX = nx;
    this.player.targetY = ny;
    this.player.gridX = nx;
    this.player.gridY = ny;
    this.player.moveStartedAtMs = time;
    this.player.moveDurationMs = scaleMovementDurationMs(GAME_CONFIG.moveDurationMs);
    this.player.isMoving = true;
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
        const dropped = wasAnomalous ? null : this.trySpawnPickup(block.x, block.y);
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
      this.spawnFlameBeams(bomb.key, bomb.x, bomb.y, result.impacts, time + GAME_CONFIG.flameLifetimeMs);

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
    if (scoreChanged) {
      this.grantExtraLivesFromScore();
      this.syncCampaignAndPersist();
    }
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
    this.grantExtraLivesFromScore();
    emitStats(this.stats);
    this.syncCampaignAndPersist();
    this.emitSimulation('item.picked', this.time.now, { key: item.key, type: item.type, x, y });
  }

  private spawnFlame(x: number, y: number, expiresAt: number, segment: FlameSegmentKind, axis?: FlameArmAxis): void {
    const key = toKey(x, y);
    this.activeFlames.set(key, { key, x, y, expiresAt, segment, axis });
  }

  private spawnFlameBeams(centerKey: string, centerX: number, centerY: number, impacts: Array<{ x: number; y: number }>, expiresAt: number): void {
    let minX = centerX;
    let maxX = centerX;
    let minY = centerY;
    let maxY = centerY;

    for (const impact of impacts) {
      if (impact.y === centerY) {
        minX = Math.min(minX, impact.x);
        maxX = Math.max(maxX, impact.x);
      }
      if (impact.x === centerX) {
        minY = Math.min(minY, impact.y);
        maxY = Math.max(maxY, impact.y);
      }
    }

    this.activeFlameBeams.set(`${centerKey}:h`, {
      key: `${centerKey}:h`,
      axis: 'horizontal',
      x: (minX + maxX) / 2,
      y: centerY,
      lengthTiles: maxX - minX + 1,
      expiresAt,
    });

    this.activeFlameBeams.set(`${centerKey}:v`, {
      key: `${centerKey}:v`,
      axis: 'vertical',
      x: centerX,
      y: (minY + maxY) / 2,
      lengthTiles: maxY - minY + 1,
      expiresAt,
    });
  }

  private cleanupExpiredFlames(time: number): void {
    for (const [key, flame] of this.activeFlames.entries()) {
      if (time >= flame.expiresAt) this.activeFlames.delete(key);
    }
    for (const [key, beam] of this.activeFlameBeams.entries()) {
      if (time >= beam.expiresAt) this.activeFlameBeams.delete(key);
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
        enemy.moveFromX = enemy.gridX;
        enemy.moveFromY = enemy.gridY;
        enemy.targetX = nx;
        enemy.targetY = ny;
        enemy.moveStartedAtMs = time;
        enemy.moveDurationMs = enemy.moveIntervalMs;
        enemy.isMoving = true;
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
        if (!isInsideArena(this.arena, nx, ny)) continue;
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
      moveFromX: x,
      moveFromY: y,
      targetX: x,
      targetY: y,
      moveStartedAtMs: 0,
      moveDurationMs: this.getScaledEnemyMoveInterval(kind),
      isMoving: false,
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
    if (!isInsideArena(this.arena, x, y) || !canOccupyCell(this.arena, x, y)) return false;
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
    if (scoreChanged) {
      this.grantExtraLivesFromScore();
      emitStats(this.stats);
      this.syncCampaignAndPersist();
    }
  }

  private hitPlayerAt(x: number, y: number): void {
    if (this.gameMode === 'multiplayer') return;
    const playerOnCell =
      this.player.targetX === null
        ? this.player.gridX === x && this.player.gridY === y
        : this.player.targetX === x && this.player.targetY === y;
    if (!playerOnCell) return;
    this.handlePlayerDeath('bomb');
  }

  private checkPlayerEnemyCollision(): void {
    if (this.gameMode === 'multiplayer') return;
    if (this.player.targetX !== null || this.player.targetY !== null) return;
    for (const enemy of this.enemies.values()) {
      if (enemy.gridX === this.player.gridX && enemy.gridY === this.player.gridY) {
        this.handlePlayerDeath('enemy');
        return;
      }
    }
  }

  private clearDynamicSprites(): void {
    const groups = [this.bombSprites, this.itemSprites, this.flameSprites, this.flameBeamSprites, this.enemySprites] as const;
    for (const group of groups) {
      for (const sprite of group.values()) sprite.destroy();
      group.clear();
    }
    this.activeFlameBeams.clear();
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
    if (this.gameMode !== 'multiplayer' && (this.player.targetX === null || this.player.targetY === null)) {
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

      const bob = Math.sin(time * 0.005 + item.x * 0.9 + item.y * 0.4) * 3;
      sprite
        .setPosition(item.x * tileSize + tileSize / 2, item.y * tileSize + tileSize / 2 + bob)
        .setTexture(this.getPickupTextureKey(item.type))
        .setDisplaySize(tileSize * 0.52, tileSize * 0.52)
        .setOrigin(0.5, 0.5)
        .setAlpha(1);
    }

    for (const [key, sprite] of this.itemSprites.entries()) {
      if (itemKeys.has(key)) continue;
      this.playPickupCollectBurst(sprite);
      this.itemSprites.delete(key);
    }

    const centerFlameKeys = new Set([...this.activeFlames.values()].filter((flame) => flame.segment === 'center').map((flame) => flame.key));
    for (const flame of this.activeFlames.values()) {
      if (flame.segment !== 'center') continue;
      const sprite = this.flameSprites.get(flame.key) ?? this.createFlameSprite(flame.key);
      if (!sprite) continue;

      const pulse = 0.5 + 0.5 * Math.sin(time * 0.03 + flame.x + flame.y * 0.5);
      const coreSize = tileSize * Phaser.Math.Linear(0.52, 0.64, pulse);
      sprite
        .setPosition(flame.x * tileSize + tileSize / 2, flame.y * tileSize + tileSize / 2)
        .setTexture('fx_explosion_core')
        .setDisplaySize(coreSize, coreSize)
        .setOrigin(0.5, 0.5)
        .setAlpha(Phaser.Math.Linear(0.82, 0.98, pulse));
    }

    for (const [key, sprite] of this.flameSprites.entries()) {
      if (centerFlameKeys.has(key)) continue;
      sprite.destroy();
      this.flameSprites.delete(key);
    }

    const beamKeys = new Set(this.activeFlameBeams.keys());
    for (const beam of this.activeFlameBeams.values()) {
      const sprite = this.flameBeamSprites.get(beam.key) ?? this.createFlameBeamSprite(beam.key);
      if (!sprite) continue;
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.028 + beam.lengthTiles * 0.7);
      const beamWidthTiles = beam.axis === 'horizontal' ? beam.lengthTiles : 0.64 + pulse * 0.08;
      const beamHeightTiles = beam.axis === 'vertical' ? beam.lengthTiles : 0.64 + pulse * 0.08;
      sprite
        .setPosition(beam.x * tileSize + tileSize / 2, beam.y * tileSize + tileSize / 2)
        .setTexture(beam.axis === 'horizontal' ? 'fx_explosion_beam_h' : 'fx_explosion_beam_v')
        .setDisplaySize(tileSize * beamWidthTiles, tileSize * beamHeightTiles)
        .setOrigin(0.5, 0.5)
        .setAlpha(Phaser.Math.Linear(0.62, 0.88, pulse));
    }

    for (const [key, sprite] of this.flameBeamSprites.entries()) {
      if (beamKeys.has(key)) continue;
      sprite.destroy();
      this.flameBeamSprites.delete(key);
    }

    const enemyKeys = new Set(this.enemies.keys());
    for (const enemy of this.enemies.values()) {
      const sprite = this.enemySprites.get(enemy.key) ?? this.createEnemySprite(enemy.key);
      if (!sprite) continue;
      const style = this.getAssetStyle('enemy', enemy.state, enemy.facing);
      const anim = this.getEnemyAnimationState(enemy, time);
      const enemyDuration = Math.max(1, enemy.moveDurationMs);
      const enemyProgress = enemy.isMoving
        ? Phaser.Math.Clamp((time - enemy.moveStartedAtMs) / enemyDuration, 0, 1)
        : 1;
      const renderGX = enemy.isMoving ? Phaser.Math.Linear(enemy.moveFromX, enemy.targetX, enemyProgress) : enemy.gridX;
      const renderGY = enemy.isMoving ? Phaser.Math.Linear(enemy.moveFromY, enemy.targetY, enemyProgress) : enemy.gridY;
      if (enemy.isMoving && enemyProgress >= 1) {
        enemy.isMoving = false;
        enemy.moveStartedAtMs = 0;
      }

      sprite
        .setPosition(renderGX * tileSize + tileSize / 2, renderGY * tileSize + tileSize / 2 + anim.hoverOffset)
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

    const { tileSize } = GAME_CONFIG;
    const sprite = this.add
      .image(item.x * tileSize + tileSize / 2, item.y * tileSize + tileSize / 2, this.getPickupTextureKey(item.type))
      .setOrigin(0.5, 0.5)
      .setDepth(DEPTH_ITEM)
      .setDisplaySize(tileSize * 0.52, tileSize * 0.52);

    this.itemSprites.set(key, sprite);
    return sprite;
  }

  private createFlameSprite(key: string): Phaser.GameObjects.Image | null {
    const flame = this.activeFlames.get(key);
    if (!flame || flame.segment !== 'center') return null;

    const { tileSize } = GAME_CONFIG;
    const sprite = this.add
      .image(flame.x * tileSize + tileSize / 2, flame.y * tileSize + tileSize / 2, 'fx_explosion_core')
      .setDisplaySize(tileSize * 0.6, tileSize * 0.6)
      .setOrigin(0.5, 0.5)
      .setDepth(DEPTH_FLAME + 1)
      .setAlpha(0.92);

    this.flameSprites.set(key, sprite);
    return sprite;
  }

  private createFlameBeamSprite(key: string): Phaser.GameObjects.Image | null {
    const beam = this.activeFlameBeams.get(key);
    if (!beam) return null;

    const { tileSize } = GAME_CONFIG;
    const sprite = this.add
      .image(beam.x * tileSize + tileSize / 2, beam.y * tileSize + tileSize / 2, beam.axis === 'horizontal' ? 'fx_explosion_beam_h' : 'fx_explosion_beam_v')
      .setOrigin(0.5, 0.5)
      .setDepth(DEPTH_FLAME)
      .setDisplaySize(tileSize, tileSize);

    this.flameBeamSprites.set(key, sprite);
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
    if (!isInsideArena(this.arena, x, y) || !canOccupyCell(this.arena, x, y)) return false;
    if (this.player.gridX === x && this.player.gridY === y) return false;
    for (const enemy of this.enemies.values()) {
      if (enemy.gridX === x && enemy.gridY === y) return false;
    }
    return true;
  }

  private handleBossDefeated(): void {
    this.stats.score += BOSS_CONFIG.defeatScoreReward;
    this.grantExtraLivesFromScore();
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

  private getArenaThemeId(): number {
    // Theme is a VISUAL concern; must be deterministic within a given level.
    // zoneIndex already derives from levelIndex (see startLevel()).
    return Number.isFinite(this.zoneIndex) ? Math.max(0, Math.floor(this.zoneIndex)) : 0;
  }

  private getPolishedTileTexture(tile: TileType, x: number, y: number): string {
    const themeId = this.getArenaThemeId();
    return getDeterministicArenaTileTexture(this, tile, x, y, GAME_CONFIG.tileSize, this.arena.width, this.arena.height, themeId);
  }

  private getPickupTextureKey(type: 'BombUp' | 'FireUp'): string {
    return type === 'BombUp' ? 'pickup_bomb' : 'pickup_flame';
  }

  private playPickupCollectBurst(sprite: Phaser.GameObjects.Image): void {
    this.tweens.add({
      targets: sprite,
      scaleX: sprite.scaleX * 1.4,
      scaleY: sprite.scaleY * 1.4,
      alpha: 0,
      duration: 140,
      ease: 'Cubic.Out',
      onComplete: () => sprite.destroy(),
    });
  }

  private getAssetStyle(kind: Exclude<EntityKind, 'tile'>, state: EntityState, facing: Facing | 'none'): import('./types').AssetStyle {
    return (
      ASSET_REGISTRY[kind]?.[state]?.[facing] ??
      ASSET_REGISTRY[kind]?.idle?.[facing] ??
      ASSET_REGISTRY[kind]?.active?.none ??
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

  public onLocalMatchInput(input: { seq: number; dx: number; dy: number }) {
    this.inputSeq = Math.max(this.inputSeq, input.seq);
    this.prediction.pushInput(input);
    if (this.gameMode !== 'multiplayer') {
      this.enqueueLocalInput(input);
    }
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

    if (!isInsideArena(this.arena, nextX, nextY) || !canOccupyCell(this.arena, nextX, nextY)) {
      return false;
    }

    const now = this.time.now;
    this.player.moveFromX = this.player.gridX;
    this.player.moveFromY = this.player.gridY;
    this.player.targetX = nextX;
    this.player.targetY = nextY;
    this.player.gridX = nextX;
    this.player.gridY = nextY;
    this.player.moveStartedAtMs = now;
    this.player.moveDurationMs = scaleMovementDurationMs(GAME_CONFIG.moveDurationMs);
    this.player.isMoving = true;
    this.player.state = 'move';
    return true;
  }

  private placeLocalPlayerSpriteAt(x: number, y: number) {
    if (!this.playerSprite) return;

    const tileSize = GAME_CONFIG.tileSize;
    this.localRenderPos = { x, y };

    this.playerSprite.setPosition(
      x * tileSize + tileSize / 2,
      y * tileSize + tileSize / 2,
    );
  }

  private tickMultiplayerRenderInterpolation(simulationTick: number): void {
    if (this.gameMode !== 'multiplayer' || !this.playerSprite) return;
    if (!this.localTgUserId) return;
    if (this.snapshotBuffer.length === 0) return;

    const delayTicks = (this.remotePlayers as any)?.getDelayTicks?.() ?? 2;
    const renderTick = simulationTick - delayTicks;

    const local = this.getLocalRenderTarget(this.localTgUserId, renderTick);
    if (!local) return;

    if (!this.localRenderPos) {
      this.localRenderPos = { x: local.x, y: local.y };
    }

    if (!this.lastLocalTarget) {
      this.lastLocalTarget = { x: local.x, y: local.y };
    }

    if (local.x !== this.lastLocalTarget.x || local.y !== this.lastLocalTarget.y) {
      this.localSegment = {
        fromX: this.localRenderPos.x,
        fromY: this.localRenderPos.y,
        toX: local.x,
        toY: local.y,
        startTick: renderTick,
        durationTicks: this.getLocalStepDurationTicks(),
      };
      this.lastLocalTarget = { x: local.x, y: local.y };
    }

    if (this.localSegment) {
      const duration = Math.max(1, this.localSegment.durationTicks);
      const alpha = Phaser.Math.Clamp((renderTick - this.localSegment.startTick) / duration, 0, 1);
      this.localRenderPos.x = Phaser.Math.Linear(this.localSegment.fromX, this.localSegment.toX, alpha);
      this.localRenderPos.y = Phaser.Math.Linear(this.localSegment.fromY, this.localSegment.toY, alpha);
      if (alpha >= 1) {
        this.localSegment = undefined;
      }
    }

    const dx = local.x - this.localRenderPos.x;
    const dy = local.y - this.localRenderPos.y;
    const driftTiles = Math.hypot(dx, dy);

    if (this.needsNetResync || driftTiles > MP_RENDER_SNAP_DISTANCE_TILES) {
      this.snapLocalRenderPosition(local.x, local.y);
      return;
    }

    const tileSize = GAME_CONFIG.tileSize;
    this.playerSprite.setPosition(
      this.localRenderPos.x * tileSize + tileSize / 2,
      this.localRenderPos.y * tileSize + tileSize / 2,
    );
  }

  private getLocalStepDurationTicks(): number {
    const fallback = 3;
    const cadenceRaw = (this.remotePlayers as any)?.getDebugStats?.()?.adaptiveEveryTicks;
    const raw = Number.isFinite(cadenceRaw) ? cadenceRaw : fallback;
    return Math.max(2, Math.min(6, Math.round(raw)));
  }

  private getLocalRenderTarget(localTgUserId: string, renderTick: number): { x: number; y: number } | null {
    for (let i = this.snapshotBuffer.length - 1; i >= 0; i -= 1) {
      const snapshot = this.snapshotBuffer[i];
      if (snapshot.tick > renderTick) continue;

      const local = snapshot.players.find((player) => player.tgUserId === localTgUserId);
      if (local) {
        return { x: local.x, y: local.y };
      }
    }

    for (let i = this.snapshotBuffer.length - 1; i >= 0; i -= 1) {
      const local = this.snapshotBuffer[i].players.find((player) => player.tgUserId === localTgUserId);
      if (local) {
        return { x: local.x, y: local.y };
      }
    }

    return null;
  }

  private snapLocalRenderPosition(x: number, y: number): void {
    this.localRenderPos = { x, y };
    this.localSegment = undefined;
    this.lastLocalTarget = { x, y };
    this.localRenderSnapCount += 1;
    this.placeLocalPlayerSpriteAt(x, y);
  }


  public getLocalPlayerPosition(): { x: number; y: number } {
    return { x: this.player.gridX, y: this.player.gridY };
  }

  public setLocalPlayerPosition(x: number, y: number) {
    this.player.gridX = x;
    this.player.gridY = y;
    this.player.targetX = null;
    this.player.targetY = null;
    this.player.isMoving = false;
    this.player.moveDurationMs = 0;
    this.player.moveStartedAtMs = 0;

    if (this.gameMode !== 'multiplayer') {
      this.placeLocalPlayerSpriteAt(x, y);
      return;
    }

    if (!this.localRenderPos) {
      this.placeLocalPlayerSpriteAt(x, y);
    }
  }


  public setActiveMultiplayerSession(roomCode: string | null, matchId: string | null): void {
    const normalizedRoom = roomCode?.trim() ? roomCode : null;
    const normalizedMatch = matchId?.trim() ? matchId : null;

    const hasChanged = this.currentRoomCode !== normalizedRoom || this.currentMatchId !== normalizedMatch;
    this.currentRoomCode = normalizedRoom;
    this.currentMatchId = normalizedMatch;

    if (hasChanged) {
      this.resetMultiplayerNetState();
    }
  }

  public triggerNetResync(reason: string): void {
    this.needsNetResync = true;
    this.netResyncReason = reason;
    this.snapshotBuffer = [];
    this.lastSnapshotTick = -1;
    this.lastAppliedSnapshotTick = -1;
    this.localInputQueue = [];
    this.inputSeq = 0;
    this.accumulator = 0;
    this.prediction.reset?.();
    this.worldReady = false;
    this.localRenderPos = null;
    this.localSegment = undefined;
    this.lastLocalTarget = undefined;
    this.localRenderSnapCount = 0;
    this.remotePlayers?.resetNetState?.();
  }

  public resetMultiplayerNetState(): void {
    this.triggerNetResync('reset_state');
    this.worldHashServer = null;
    this.worldHashClient = null;
  }

  public pushMatchSnapshot(snapshot: MatchSnapshotV1, localTgUserId?: string): boolean {
    if (snapshot?.version !== 'match_v1') return false;

    this.lastSnapshotRoom = snapshot.roomCode ?? null;

    if (this.currentRoomCode && snapshot.roomCode !== this.currentRoomCode) {
      this.droppedWrongRoom += 1;
      return false;
    }

    if (this.currentMatchId && snapshot.matchId !== this.currentMatchId) {
      this.droppedWrongMatch += 1;
      return false;
    }

    if (snapshot.tick <= this.lastSnapshotTick) {
      this.droppedDuplicateTick += 1;
      return false;
    }

    if (localTgUserId) {
      this.localTgUserId = localTgUserId;
    }

    const isFirstSnapshot = this.lastSnapshotTick < 0 || this.snapshotBuffer.length === 0;
    const shouldResync = this.needsNetResync || isFirstSnapshot;

    // If our local simulation tick is far ahead (e.g. from solo run), remote interpolation will stall.
    // Resync on first multiplayer snapshot to align timebase.
    if (shouldResync) {
      this.needsNetResync = false;
      this.netResyncReason = null;

      this.simulationTick = snapshot.tick;
      this.accumulator = 0;

      this.localInputQueue = [];
      this.inputSeq = 0;

      this.lastSnapshotTick = -1;
      this.snapshotBuffer = [];

      this.prediction.reset?.();
      this.remotePlayers?.resetNetState?.();
    }

    this.lastSnapshotTick = snapshot.tick;
    this.lastAppliedSnapshotTick = Math.max(this.lastAppliedSnapshotTick, snapshot.tick);
    this.matchGridW = snapshot.world?.gridW ?? this.matchGridW;
    this.matchGridH = snapshot.world?.gridH ?? this.matchGridH;

    const snapshotWorldHash = snapshot.world?.worldHash ?? null;
    if (snapshotWorldHash && this.worldHashClient && snapshotWorldHash !== this.worldHashClient) {
      this.needsNetResync = true;
      this.netResyncReason = 'snapshot_world_hash_mismatch';
    }

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

    if (!this.worldReady) {
      return;
    }

    if (!isInsideArena(this.arena, me.x, me.y) || !canOccupyCell(this.arena, me.x, me.y)) {
      this.invalidPosDrops += 1;
      this.needsNetResync = true;
      this.netResyncReason = 'invalid_authoritative_position';
      this.warnInvalidAuthoritativePosition(snapshot, me, effectiveLocalId);
      return;
    }

    const localX = this.player.gridX;
    const localY = this.player.gridY;
    const driftTiles = Math.abs(me.x - localX) + Math.abs(me.y - localY);

    if (driftTiles > 1 || this.needsNetResync) {
      this.setLocalPlayerPosition(me.x, me.y);
      this.snapLocalRenderPosition(me.x, me.y);
      this.prediction.reset?.();
      this.prediction.setServerFirstMode(this.gameMode === 'multiplayer');
      return;
    }

    // Multiplayer local player is server-first: authoritative position from snapshots only.
    this.setLocalPlayerPosition(me.x, me.y);
    this.prediction.reconcile({
      serverX: me.x,
      serverY: me.y,
      localX,
      localY,
      lastInputSeq: me.lastInputSeq,
      setPosition: () => undefined,
      applyMove: () => undefined,
    });
  }



  private warnInvalidAuthoritativePosition(snapshot: MatchSnapshotV1, me: { x: number; y: number }, localTgUserId?: string): void {
    const now = Date.now();
    const warnKey = `${snapshot.roomCode ?? 'unknown'}:${snapshot.matchId ?? 'unknown'}:${snapshot.tick ?? -1}:${me.x}:${me.y}`;
    if (this.lastInvalidPosWarnKey === warnKey && now - this.lastInvalidPosWarnAtMs < 1000) {
      return;
    }

    if (now - this.lastInvalidPosWarnAtMs < 3000) {
      return;
    }

    this.lastInvalidPosWarnAtMs = now;
    this.lastInvalidPosWarnKey = warnKey;

    const tile = isInsideArena(this.arena, me.x, me.y)
      ? this.arena.tiles[me.y]?.[me.x] ?? null
      : null;

    console.warn('[MP] invalid_authoritative_position_drop', {
      roomCode: this.currentRoomCode,
      matchId: this.currentMatchId,
      snapshotRoom: snapshot.roomCode ?? null,
      snapshotMatchId: snapshot.matchId ?? null,
      currentRoomCode: this.currentRoomCode,
      tick: snapshot.tick ?? null,
      tgUserId: localTgUserId ?? this.localTgUserId ?? null,
      x: me.x,
      y: me.y,
      tile,
      gridW: this.arena.width,
      gridH: this.arena.height,
      worldHashServer: this.worldHashServer,
      worldHashClient: this.worldHashClient,
      invalidPosDrops: this.invalidPosDrops,
    });
  }

  private decodeWorldTile(tile: number): TileType {
    if (tile === 1) return 'HardWall';
    if (tile === 2) return 'BreakableBlock';
    if (tile === 3) return 'ANOMALOUS_STONE';
    return 'Floor';
  }

  private encodeWorldTile(tile: TileType): number {
    if (tile === 'HardWall') return 1;
    if (tile === 'BreakableBlock') return 2;
    if (tile === 'ANOMALOUS_STONE') return 3;
    return 0;
  }

  private computeWorldHash(tiles: number[]): string {
    let hash = 2166136261;
    for (const tile of tiles) {
      hash ^= tile & 0xff;
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  public applyMatchWorldInit(payload: { roomCode: string; matchId: string; world: { gridW: number; gridH: number; tiles: number[]; worldHash: string } }): boolean {
    if (this.currentRoomCode && payload.roomCode !== this.currentRoomCode) {
      this.droppedWrongRoom += 1;
      return false;
    }

    if (this.currentMatchId && payload.matchId !== this.currentMatchId) {
      this.droppedWrongMatch += 1;
      return false;
    }

    const { gridW, gridH, tiles } = payload.world;
    if (!Number.isInteger(gridW) || !Number.isInteger(gridH) || gridW <= 0 || gridH <= 0) {
      return false;
    }

    if (!Array.isArray(tiles) || tiles.length !== gridW * gridH) {
      return false;
    }

    const nextTiles: TileType[][] = [];
    for (let y = 0; y < gridH; y += 1) {
      const row: TileType[] = [];
      for (let x = 0; x < gridW; x += 1) {
        row.push(this.decodeWorldTile(tiles[y * gridW + x] ?? 0));
      }
      nextTiles.push(row);
    }

    this.arena.tiles = nextTiles;
    this.arena.width = gridW;
    this.arena.height = gridH;
    this.matchGridW = gridW;
    this.matchGridH = gridH;
    this.clearDynamicSprites();
    this.rebuildArenaTiles();
    this.syncCameraBoundsToArena();

    const clientTiles = this.arena.tiles.flatMap((row) => row.map((tile) => this.encodeWorldTile(tile)));
    this.worldHashServer = payload.world.worldHash || null;
    this.worldHashClient = this.computeWorldHash(clientTiles);
    if (this.worldHashServer && this.worldHashClient && this.worldHashServer !== this.worldHashClient) {
      this.needsNetResync = true;
      this.netResyncReason = 'world_hash_mismatch';
      console.warn('[MP] world_hash_mismatch', {
        roomCode: payload.roomCode,
        matchId: payload.matchId,
        worldHashServer: this.worldHashServer,
        worldHashClient: this.worldHashClient,
      });
    }
    this.worldReady = true;
    this.invalidPosDrops = 0;

    return true;
  }



  public applyAuthoritativeBombSpawned(payload: { bomb: { id: string; x: number; y: number; ownerId?: string; tickPlaced?: number; explodeAtTick?: number } }): void {
    const { bomb } = payload;
    this.arena.bombs.set(bomb.id, {
      key: bomb.id,
      x: bomb.x,
      y: bomb.y,
      range: this.stats.range,
      ownerId: bomb.ownerId ?? 'remote',
      detonateAt: this.time.now + GAME_CONFIG.bombFuseMs,
      escapedByOwner: false,
    });
  }

  public applyAuthoritativeBombExploded(payload: { bombId: string; x: number; y: number; impacts: Array<{ x: number; y: number }> }): void {
    this.arena.bombs.delete(payload.bombId);
    const expiresAt = this.time.now + GAME_CONFIG.flameLifetimeMs;
    this.spawnFlameBeams(payload.bombId, payload.x, payload.y, payload.impacts, expiresAt);
    for (const impact of payload.impacts) {
      const isCenter = impact.x === payload.x && impact.y === payload.y;
      const segment: FlameSegmentKind = isCenter ? 'center' : 'arm';
      const axis: FlameArmAxis | undefined = !isCenter ? (impact.x === payload.x ? 'vertical' : 'horizontal') : undefined;
      this.spawnFlame(impact.x, impact.y, expiresAt, segment, axis);
    }
  }

  public applyAuthoritativeTilesDestroyed(payload: { tiles: Array<{ x: number; y: number }> }): void {
    for (const tile of payload.tiles) {
      if (!isInsideArena(this.arena, tile.x, tile.y)) continue;
      destroyBreakable(this.arena, tile.x, tile.y);
      this.destroyBreakableSprite(tile.x, tile.y);
    }
  }

  public applyAuthoritativePlayerDamaged(payload: { tgUserId: string; lives: number }, localTgUserId?: string): void {
    if (payload.tgUserId !== localTgUserId) return;
    this.lives = Math.max(0, payload.lives);
    this.stats.lives = this.lives;
    this.multiplayerRespawning = this.lives > 0;
    this.emitLifeState();
    emitStats(this.stats);
  }

  public applyAuthoritativePlayerRespawned(payload: { tgUserId: string; x: number; y: number }, localTgUserId?: string): void {
    if (payload.tgUserId !== localTgUserId) return;
    this.multiplayerEliminated = false;
    this.multiplayerRespawning = false;
    this.setLocalPlayerPosition(payload.x, payload.y);
    this.playerSprite?.setVisible(true);
    this.emitLifeState();
  }

  public applyAuthoritativePlayerEliminated(payload: { tgUserId: string }, localTgUserId?: string): void {
    if (payload.tgUserId !== localTgUserId) return;
    this.multiplayerEliminated = true;
    this.multiplayerRespawning = false;
    this.playerSprite?.setVisible(false);
    this.emitLifeState();
  }

  public setAudioSettings(next: SceneAudioSettings): void {
    this.audioSettings = { ...next };
    if (this.sound) {
      this.sound.mute = !next.musicEnabled || !next.sfxEnabled;
    }
  }

  public getPredictionStats() {
    const stats = this.prediction?.getStats?.();
    if (!stats) return null;

    const authoritativeX = this.player.gridX;
    const authoritativeY = this.player.gridY;
    const renderX = this.localRenderPos?.x ?? authoritativeX;
    const renderY = this.localRenderPos?.y ?? authoritativeY;
    const localRenderDriftTiles = Math.hypot(authoritativeX - renderX, authoritativeY - renderY);

    return {
      ...stats,
      localMode: this.gameMode === 'multiplayer' ? 'server_first' : 'predicted',
      localRenderDriftTiles,
      localSnapCount: this.localRenderSnapCount,
    };
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

  public getLastAppliedSnapshotTick(): number {
    return this.lastAppliedSnapshotTick;
  }


  public getSnapshotRoutingStats(): {
    droppedWrongRoom: number;
    droppedWrongMatch: number;
    droppedDuplicateTick: number;
    invalidPosDrops: number;
    lastSnapshotRoom: string | null;
    currentRoomCode: string | null;
    currentMatchId: string | null;
    worldReady: boolean;
    worldHashServer: string | null;
    worldHashClient: string | null;
    needsNetResync: boolean;
    netResyncReason: string | null;
  } {
    return {
      droppedWrongRoom: this.droppedWrongRoom,
      droppedWrongMatch: this.droppedWrongMatch,
      droppedDuplicateTick: this.droppedDuplicateTick,
      invalidPosDrops: this.invalidPosDrops,
      lastSnapshotRoom: this.lastSnapshotRoom,
      currentRoomCode: this.currentRoomCode,
      currentMatchId: this.currentMatchId,
      worldReady: this.worldReady,
      worldHashServer: this.worldHashServer,
      worldHashClient: this.worldHashClient,
      needsNetResync: this.needsNetResync,
      netResyncReason: this.netResyncReason,
    };
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
