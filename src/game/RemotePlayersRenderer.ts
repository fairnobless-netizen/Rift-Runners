import Phaser from 'phaser';
import type { MatchSnapshotPlayer, MatchSnapshotV1 } from '@shared/protocol';
import { GAME_CONFIG, scaleMovementDurationMs } from './config';

// M15.4: Frozen interpolation tuning constants (single source of truth)
const INTERP_TUNING = {
  // baseDelay (RTT-based) smoothing
  baseDelay: {
    minTicks: 1,
    maxTicks: 10, // hard ceiling for safety
    stepLimitPerUpdate: 1, // max +/- ticks per updateAdaptiveDelay call
    cooldownTicks: 20, // how often baseDelay can change (in simulation ticks)
    hysteresisTicks: 1, // dead-zone around target
    spikeGuardMs: 120, // ignore sudden RTT spikes beyond this (ms)
  },

  // targetBufferPairs smoothing (jitter-aware)
  targetBuffer: {
    minPairs: 2,
    maxPairs: 6,
    cooldownTicks: 20,
    hysteresisPairs: 1,
  },

  // adaptive cadence (how often controller runs)
  cadence: {
    minEvery: 2,
    maxEvery: 8,
    cooldownTicks: 30,
  },

  // late snapshot EMA
  late: {
    emaAlpha: 0.2, // smoothing factor for late rate
  },
} as const;

const REMOTE_RENDER_SNAP_DISTANCE_TILES = 1.5;
const FIXED_DT = 1000 / 20;
const MP_MOVE_TICKS_CONST = Math.max(1, Math.round(scaleMovementDurationMs(GAME_CONFIG.moveDurationMs) / FIXED_DT));
const PLAYER_SILHOUETTE_TEXTURE_KEYS = ['rr_player_a', 'rr_player_b', 'rr_player_c', 'rr_player_d'] as const;

function hashStringFNV1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function getSilhouetteIndexFromId(id: string): 0 | 1 | 2 | 3 {
  return (hashStringFNV1a(id) % PLAYER_SILHOUETTE_TEXTURE_KEYS.length) as 0 | 1 | 2 | 3;
}

function getPlayerSilhouetteTextureKeyFromId(id: string): string {
  return PLAYER_SILHOUETTE_TEXTURE_KEYS[getSilhouetteIndexFromId(id)] ?? PLAYER_SILHOUETTE_TEXTURE_KEYS[0];
}

function getBobPhaseFromId(id: string): number {
  return (hashStringFNV1a(id) % 6283) / 1000;
}


type RemotePlayerView = {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Image;
  nameText: Phaser.GameObjects.Text;
};

type RenderSegment = {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startTick: number;
  durationTicks: number;
};

type RemoteRenderState = {
  x: number;
  y: number;
  lastTargetX: number;
  lastTargetY: number;
  lastTargetTick: number;
  segment?: RenderSegment;
};

export class RemotePlayersRenderer {
  private scene: Phaser.Scene;
  private players = new Map<string, RemotePlayerView>();
  private velocities = new Map<string, { vx: number; vy: number }>();
  private remoteRenderStates = new Map<string, RemoteRenderState>();
  private remoteRenderSnapCount = new Map<string, number>();

  private readonly maxExtrapolationTicks = 3;
  private stallAfterTicks = 7;
  private renderTick = -1;
  private baseDelayTicks = 2;
  // M14.3: baseDelay smoothing / spike guard
  private baseDelayTargetTicks: number = 2;
  private baseDelayLastAppliedAtMs: number = 0;
  private rttLastGoodEmaMs: number | null = null;
  private rttMs: number | null = null;
  private rttJitterMs = 0;
  private delayTicks = 2;
  private minDelayTicks: number = INTERP_TUNING.baseDelay.minTicks;
  private maxDelayTicks: number = INTERP_TUNING.baseDelay.maxTicks;
  private targetBufferPairs = 2;
  // M15: targetBufferPairs smoothing
  private targetBufferTargetPairs = 2;
  private lastTargetBufferChangeTick = 0;
  // M15.2: adaptive update cadence (reduce noise under jitter)
  private adaptiveEveryTargetTicks: number = 2;
  private adaptiveEveryTicks: number = 2;
  private lastAdaptiveEveryChangeTick: number = 0;
  private bufferSize = 0;
  private extrapolatingTicks = 0;
  private stalled = false;
  private underrunCount = 0;
  private lateSnapshotCount = 0;
  private lateSnapshotEma = 0;
  private stallCount = 0;
  private extrapCount = 0;

  private readonly metricsWindowTicks = 60;
  private readonly adaptiveCooldownTicks = 20;
  private lastDelayChangeTick = 0;
  private windowUnderrunEvents: number[] = [];
  private windowStallEvents: number[] = [];
  private windowExtrapEvents: number[] = [];
  private windowUnderrunSum = 0;
  private windowStallSum = 0;
  private windowExtrapSum = 0;

  private tileSize = 32;
  private offsetX = 0;
  private offsetY = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  setTransform(params: { tileSize: number; offsetX: number; offsetY: number }) {
    this.tileSize = params.tileSize;
    this.offsetX = params.offsetX;
    this.offsetY = params.offsetY;
  }

  resetNetState() {
    for (const view of this.players.values()) {
      view.container.destroy(true);
    }
    this.players.clear();

    this.renderTick = -1;
    this.bufferSize = 0;

    this.extrapolatingTicks = 0;
    this.stalled = false;

    this.underrunCount = 0;
    this.lateSnapshotCount = 0;
    this.lateSnapshotEma = 0;
    this.stallCount = 0;
    this.extrapCount = 0;

    this.windowUnderrunEvents = [];
    this.windowStallEvents = [];
    this.windowExtrapEvents = [];
    this.windowUnderrunSum = 0;
    this.windowStallSum = 0;
    this.windowExtrapSum = 0;

    this.velocities.clear();
    this.remoteRenderStates.clear();
    this.remoteRenderSnapCount.clear();
  }

  setNetworkRtt(rttMs: number | null, rttJitterMs: number, tickMs: number): void {
    this.rttMs = rttMs;
    this.rttJitterMs = rttJitterMs;

    // M15: adaptive targetBufferPairs (jitter-aware)
    const nextTarget = this.computeTargetBufferPairs(tickMs);
    this.targetBufferTargetPairs = nextTarget;

    // M15.2: adaptive cadence target
    this.adaptiveEveryTargetTicks = this.computeAdaptiveEveryTicks(tickMs);

    if (rttMs == null || !Number.isFinite(rttMs) || tickMs <= 0) return;

    // Spike guard: if RTT suddenly doubles vs last good EMA, don't immediately raise baseDelay.
    if (this.rttLastGoodEmaMs != null && rttMs - this.rttLastGoodEmaMs > INTERP_TUNING.baseDelay.spikeGuardMs) {
      // keep target as is; let symptom-based controller handle short turbulence
      return;
    }

    this.rttLastGoodEmaMs = rttMs;

    // one-way ~= RTT/2. Add safety margin from jitter + 1 tick guard.
    const oneWayMs = rttMs * 0.5;
    const safetyMs = Math.max(0, rttJitterMs) * 0.5 + tickMs;
    const recommended = Math.round((oneWayMs + safetyMs) / tickMs);
    const clamped = Phaser.Math.Clamp(recommended, INTERP_TUNING.baseDelay.minTicks, INTERP_TUNING.baseDelay.maxTicks);

    this.baseDelayTargetTicks = clamped;

    // Apply with hysteresis + rate limit (at most 1 tick per cooldown)
    const now = performance.now ? performance.now() : Date.now();
    if (this.baseDelayLastAppliedAtMs === 0) this.baseDelayLastAppliedAtMs = now;

    const diff = this.baseDelayTargetTicks - this.baseDelayTicks;
    if (Math.abs(diff) <= INTERP_TUNING.baseDelay.hysteresisTicks) {
      return; // ignore small noise
    }

    const baseDelayCooldownMs = INTERP_TUNING.baseDelay.cooldownTicks * tickMs;
    if (now - this.baseDelayLastAppliedAtMs < baseDelayCooldownMs) {
      return; // too soon to change again
    }

    const step = Math.min(Math.abs(diff), INTERP_TUNING.baseDelay.stepLimitPerUpdate);
    this.baseDelayTicks += diff > 0 ? step : -step;
    this.baseDelayTicks = Phaser.Math.Clamp(
      this.baseDelayTicks,
      INTERP_TUNING.baseDelay.minTicks,
      INTERP_TUNING.baseDelay.maxTicks,
    );
    this.baseDelayLastAppliedAtMs = now;

    // keep current delay not below base
    if (this.delayTicks < this.baseDelayTicks) this.delayTicks = this.baseDelayTicks;
    this.minDelayTicks = Math.max(INTERP_TUNING.baseDelay.minTicks, this.baseDelayTicks - 1);
  }

  update(simulationTick: number, buffer: MatchSnapshotV1[], localTgUserId?: string, needsNetResync: boolean = false): void {
    const controlTick = Math.floor(simulationTick);
    this.updateAdaptiveDelay(controlTick, buffer.length);
    this.stallAfterTicks = this.delayTicks + this.maxExtrapolationTicks + 2;

    const renderTick = simulationTick - this.delayTicks;
    this.renderTick = renderTick;
    this.bufferSize = buffer.length;
    this.extrapolatingTicks = 0;
    this.stalled = false;

    this.updateVelocities(buffer);

    if (buffer.length === 0) {
      this.destroyMissingPlayers(new Set<string>());
      return;
    }

    // If renderTick is outside the buffered tick range, fall back to extrapolation/freeze.
    const firstTick = buffer[0].tick;
    const lastTick = buffer[buffer.length - 1].tick;
    if (renderTick < firstTick || renderTick > lastTick) {
      this.recordUnderrun();
      const anchorSnapshot = this.findAnchorSnapshot(buffer, renderTick) ?? buffer[buffer.length - 1];
      const extrapolationTicks = Math.max(0, renderTick - anchorSnapshot.tick);

      if (extrapolationTicks > 0 && extrapolationTicks <= this.maxExtrapolationTicks) {
        this.recordExtrapolation();
        this.extrapolatingTicks = extrapolationTicks;
        this.renderExtrapolated(anchorSnapshot, extrapolationTicks, localTgUserId);
        return;
      }

      if (extrapolationTicks > this.maxExtrapolationTicks) {
        this.recordExtrapolation();
        this.extrapolatingTicks = this.maxExtrapolationTicks;
        this.stalled = extrapolationTicks >= this.stallAfterTicks;
        if (this.stalled) {
          this.recordStall();
        }
        this.renderFrozen(anchorSnapshot, localTgUserId);
        return;
      }

      this.renderFromSnapshot(anchorSnapshot, localTgUserId);
      return;
    }

    // Normal case: segment-planned interpolation per player with fixed duration per tile step.
    const latest = buffer[buffer.length - 1];
    const alive = new Set<string>();

    for (const to of latest.players) {
      if (localTgUserId && to.tgUserId === localTgUserId) continue;

      alive.add(to.tgUserId);
      const target = this.getRenderTargetForPlayer(buffer, to.tgUserId, renderTick)
        ?? { x: to.x, y: to.y, targetTickUsed: latest.tick };
      this.upsertPlayer(to, target, renderTick, needsNetResync);
    }

    this.destroyMissingPlayers(alive);
  }

  renderFromMoveProgress(
    snapshot: MatchSnapshotV1,
    estimatedServerNowMs: number,
    renderTick: number,
    localTgUserId?: string,
    forceSnap: boolean = false,
  ): void {
    this.renderTick = renderTick;
    this.bufferSize = 1;
    this.extrapolatingTicks = 0;
    this.stalled = false;

    const alive = new Set<string>();
    for (const player of snapshot.players) {
      if (localTgUserId && player.tgUserId === localTgUserId) continue;
      alive.add(player.tgUserId);
      const target = this.getPlayerRenderPosFromMoveState(player, estimatedServerNowMs, renderTick);
      this.upsertPlayer(
        player,
        { x: target.x, y: target.y, targetTickUsed: snapshot.tick },
        renderTick,
        forceSnap,
      );
    }

    this.destroyMissingPlayers(alive);
  }

  onSnapshotBuffered(snapshotTick: number, simulationTick: number): void {
    const playheadTick = this.renderTick >= 0 ? this.renderTick : simulationTick - this.delayTicks;
    const isLateSnapshot = snapshotTick < playheadTick;

    if (isLateSnapshot) {
      this.lateSnapshotCount += 1;
    }

    const sample = isLateSnapshot ? 1 : 0;
    this.lateSnapshotEma += (sample - this.lateSnapshotEma) * INTERP_TUNING.late.emaAlpha;
  }

  private updateAdaptiveDelay(simulationTick: number, bufferSize: number): void {
    const prevDelay = this.delayTicks;

    // M15.2: smooth adaptive cadence (step-limited, cooldown)
    if (simulationTick - this.lastAdaptiveEveryChangeTick >= INTERP_TUNING.cadence.cooldownTicks) {
      const diff = this.adaptiveEveryTargetTicks - this.adaptiveEveryTicks;

      if (diff !== 0) {
        this.adaptiveEveryTicks += diff > 0 ? 1 : -1;
        this.adaptiveEveryTicks = Phaser.Math.Clamp(
          this.adaptiveEveryTicks,
          INTERP_TUNING.cadence.minEvery,
          INTERP_TUNING.cadence.maxEvery,
        );
        this.lastAdaptiveEveryChangeTick = simulationTick;
      }
    }

    if (this.windowUnderrunEvents.length === 0) {
      this.lastDelayChangeTick = simulationTick;
      this.lastTargetBufferChangeTick = simulationTick;
      this.lastAdaptiveEveryChangeTick = simulationTick;
    }

    this.pushWindowSample(0, 0, 0);

    const every = this.adaptiveEveryTicks;
    if (every > 1 && simulationTick % every !== 0) {
      return;
    }

    const cooldownPassed = simulationTick - this.lastDelayChangeTick >= this.adaptiveCooldownTicks;
    if (cooldownPassed) {
      const windowSize = Math.max(1, this.windowUnderrunEvents.length);
      const underrunRate = this.windowUnderrunSum / windowSize;
      const bufferHasReserve = bufferSize >= this.targetBufferPairs + 2;

      if (underrunRate > 0.05 || this.windowStallSum > 0) {
        const nextDelay = Math.min(this.delayTicks + 1, this.maxDelayTicks);
        if (nextDelay !== this.delayTicks) {
          this.delayTicks = nextDelay;
          this.lastDelayChangeTick = simulationTick;
        }
      } else if (this.windowUnderrunSum === 0 && bufferHasReserve) {
        const nextDelay = Math.max(this.delayTicks - 1, this.minDelayTicks);
        if (nextDelay !== this.delayTicks) {
          this.delayTicks = nextDelay;
          this.lastDelayChangeTick = simulationTick;
        }
      }
    }

    // M15: apply targetBufferPairs smoothly (cooldown + hysteresis + step)
    if (simulationTick - this.lastTargetBufferChangeTick >= INTERP_TUNING.targetBuffer.cooldownTicks) {
      const diff = this.targetBufferTargetPairs - this.targetBufferPairs;

      if (Math.abs(diff) > INTERP_TUNING.targetBuffer.hysteresisPairs) {
        this.targetBufferPairs += diff > 0 ? 1 : -1;
        this.targetBufferPairs = Phaser.Math.Clamp(
          this.targetBufferPairs,
          INTERP_TUNING.targetBuffer.minPairs,
          INTERP_TUNING.targetBuffer.maxPairs,
        );
        this.lastTargetBufferChangeTick = simulationTick;
      }
    }

    // Optional: limit delayTicks step to avoid visible jitter
    const maxStepPerUpdate = INTERP_TUNING.baseDelay.stepLimitPerUpdate;
    if (this.delayTicks > prevDelay + maxStepPerUpdate) this.delayTicks = prevDelay + maxStepPerUpdate;
    if (this.delayTicks < prevDelay - maxStepPerUpdate) this.delayTicks = prevDelay - maxStepPerUpdate;

    // M14.4: never go below RTT-based baseDelay
    if (this.delayTicks < this.baseDelayTicks) this.delayTicks = this.baseDelayTicks;
  }

  private computeTargetBufferPairs(tickMs: number): number {
    const jitterMs = Math.max(0, this.rttJitterMs ?? 0);

    // Переводим jitter в тики. 1 tick guard + половина jitter как запас
    const jitterTicks = tickMs > 0 ? Math.ceil((jitterMs * 0.5) / tickMs) : 0;

    // База: 2 пары (минимум для нормальной интерполяции с запасом)
    const raw = 2 + jitterTicks;

    return Phaser.Math.Clamp(raw, INTERP_TUNING.targetBuffer.minPairs, INTERP_TUNING.targetBuffer.maxPairs);
  }

  private computeAdaptiveEveryTicks(tickMs: number): number {
    const jitterMs = Math.max(0, this.rttJitterMs ?? 0);
    const jitterTicks = tickMs > 0 ? Math.ceil((jitterMs * 0.5) / tickMs) : 0;

    // Higher jitter -> update less often (more stable controller)
    const raw = 2 + jitterTicks;

    return Phaser.Math.Clamp(raw, INTERP_TUNING.cadence.minEvery, INTERP_TUNING.cadence.maxEvery);
  }

  private pushWindowSample(underrunEvent: number, stallEvent: number, extrapEvent: number): void {
    this.windowUnderrunEvents.push(underrunEvent);
    this.windowStallEvents.push(stallEvent);
    this.windowExtrapEvents.push(extrapEvent);
    this.windowUnderrunSum += underrunEvent;
    this.windowStallSum += stallEvent;
    this.windowExtrapSum += extrapEvent;

    if (this.windowUnderrunEvents.length > this.metricsWindowTicks) {
      this.windowUnderrunSum -= this.windowUnderrunEvents.shift() ?? 0;
      this.windowStallSum -= this.windowStallEvents.shift() ?? 0;
      this.windowExtrapSum -= this.windowExtrapEvents.shift() ?? 0;
    }
  }

  private addEventSample(eventType: 'underrun' | 'stall' | 'extrap'): void {
    const lastIndex = this.windowUnderrunEvents.length - 1;
    if (lastIndex < 0) {
      this.pushWindowSample(0, 0, 0);
    }

    const safeIndex = this.windowUnderrunEvents.length - 1;
    if (eventType === 'underrun') {
      if (this.windowUnderrunEvents[safeIndex] === 0) {
        this.windowUnderrunEvents[safeIndex] = 1;
        this.windowUnderrunSum += 1;
      }
      return;
    }

    if (eventType === 'stall') {
      if (this.windowStallEvents[safeIndex] === 0) {
        this.windowStallEvents[safeIndex] = 1;
        this.windowStallSum += 1;
      }
      return;
    }

    if (this.windowExtrapEvents[safeIndex] === 0) {
      this.windowExtrapEvents[safeIndex] = 1;
      this.windowExtrapSum += 1;
    }
  }

  private recordUnderrun(): void {
    this.underrunCount += 1;
    this.addEventSample('underrun');
  }

  private recordStall(): void {
    this.stallCount += 1;
    this.addEventSample('stall');
  }

  private recordExtrapolation(): void {
    this.extrapCount += 1;
    this.addEventSample('extrap');
  }

  private renderFromSnapshot(snapshot: MatchSnapshotV1, localTgUserId?: string): void {
    const alive = new Set<string>();
    for (const player of snapshot.players) {
      if (localTgUserId && player.tgUserId === localTgUserId) continue;
      alive.add(player.tgUserId);
      this.upsertPlayer(player, { x: player.x, y: player.y, targetTickUsed: snapshot.tick }, this.renderTick);
    }
    this.destroyMissingPlayers(alive);
  }

  private renderExtrapolated(snapshot: MatchSnapshotV1, extrapolationTicks: number, localTgUserId?: string): void {
    const alive = new Set<string>();
    for (const player of snapshot.players) {
      if (localTgUserId && player.tgUserId === localTgUserId) continue;
      alive.add(player.tgUserId);
      const velocity = this.velocities.get(player.tgUserId);
      const x = player.x + (velocity?.vx ?? 0) * extrapolationTicks;
      const y = player.y + (velocity?.vy ?? 0) * extrapolationTicks;
      this.upsertPlayer(player, { x, y, targetTickUsed: snapshot.tick }, this.renderTick);
    }
    this.destroyMissingPlayers(alive);
  }

  private renderFrozen(snapshot: MatchSnapshotV1, localTgUserId?: string): void {
    const alive = new Set<string>();
    for (const player of snapshot.players) {
      if (localTgUserId && player.tgUserId === localTgUserId) continue;
      alive.add(player.tgUserId);
      const frozenPos = this.remoteRenderStates.get(player.tgUserId);
      this.upsertPlayer(
        player,
        { x: frozenPos?.x ?? player.x, y: frozenPos?.y ?? player.y, targetTickUsed: snapshot.tick },
        this.renderTick,
        true,
      );
    }
    this.destroyMissingPlayers(alive);
  }

  private findAnchorSnapshot(buffer: MatchSnapshotV1[], renderTick: number): MatchSnapshotV1 | undefined {
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      if (buffer[i].tick <= renderTick) {
        return buffer[i];
      }
    }
    return undefined;
  }

  private getRenderTargetForPlayer(
    buffer: MatchSnapshotV1[],
    tgUserId: string,
    renderTick: number,
  ): { x: number; y: number; targetTickUsed: number } | undefined {
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      const snapshot = buffer[i];
      if (snapshot.tick > renderTick) continue;

      const player = snapshot.players.find((candidate) => candidate.tgUserId === tgUserId);
      if (player) {
        return { x: player.x, y: player.y, targetTickUsed: snapshot.tick };
      }
    }

    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      const player = buffer[i].players.find((candidate) => candidate.tgUserId === tgUserId);
      if (player) {
        return { x: player.x, y: player.y, targetTickUsed: buffer[i].tick };
      }
    }

    return undefined;
  }

  private updateVelocities(buffer: MatchSnapshotV1[]): void {
    if (buffer.length < 2) return;

    const snapshotA = buffer[buffer.length - 2];
    const snapshotB = buffer[buffer.length - 1];
    const dt = snapshotB.tick - snapshotA.tick;
    if (dt <= 0) return;

    const prevPlayers = new Map(snapshotA.players.map((p) => [p.tgUserId, p]));
    for (const nextPlayer of snapshotB.players) {
      const prevPlayer = prevPlayers.get(nextPlayer.tgUserId);
      if (!prevPlayer) continue;
      this.velocities.set(nextPlayer.tgUserId, {
        vx: (nextPlayer.x - prevPlayer.x) / dt,
        vy: (nextPlayer.y - prevPlayer.y) / dt,
      });
    }
  }

  private getPlayerRenderPosFromMoveState(
    player: MatchSnapshotPlayer,
    estimatedServerNowMs: number,
    renderTick: number,
  ): { x: number; y: number } {
    if (!player.isMoving || (player.moveDurationMs ?? 0) <= 0) {
      return { x: player.x, y: player.y };
    }

    const hasMsMoveState =
      typeof player.moveFromX === 'number'
      && typeof player.moveFromY === 'number'
      && typeof player.moveToX === 'number'
      && typeof player.moveToY === 'number'
      && typeof player.moveStartServerTimeMs === 'number'
      && typeof player.moveDurationMs === 'number'
      && player.moveDurationMs > 0;

    if (hasMsMoveState) {
      const moveDurationMs = player.moveDurationMs as number;
      const t = Phaser.Math.Clamp((estimatedServerNowMs - (player.moveStartServerTimeMs as number)) / moveDurationMs, 0, 1);
      return {
        x: Phaser.Math.Linear(player.moveFromX as number, player.moveToX as number, t),
        y: Phaser.Math.Linear(player.moveFromY as number, player.moveToY as number, t),
      };
    }

    const hasTickMoveState =
      typeof player.moveFromX === 'number'
      && typeof player.moveFromY === 'number'
      && typeof player.moveToX === 'number'
      && typeof player.moveToY === 'number'
      && typeof player.moveStartTick === 'number'
      && typeof player.moveDurationTicks === 'number'
      && player.moveDurationTicks > 0;

    if (hasTickMoveState) {
      const moveDurationTicks = player.moveDurationTicks as number;
      const tTicks = Phaser.Math.Clamp((renderTick - (player.moveStartTick as number)) / moveDurationTicks, 0, 1);
      return {
        x: Phaser.Math.Linear(player.moveFromX as number, player.moveToX as number, tTicks),
        y: Phaser.Math.Linear(player.moveFromY as number, player.moveToY as number, tTicks),
      };
    }

    return { x: player.x, y: player.y };
  }

  getDebugStats(): {
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
    const windowSize = Math.max(1, this.windowUnderrunEvents.length);
    const bufferHasReserve = this.bufferSize >= this.targetBufferPairs + 2;
    return {
      renderTick: this.renderTick,
      baseDelayTicks: this.baseDelayTicks,
      baseDelayTargetTicks: this.baseDelayTargetTicks,
      baseDelayStepCooldownMs: INTERP_TUNING.baseDelay.cooldownTicks,
      baseDelayStepCooldownTicks: INTERP_TUNING.baseDelay.cooldownTicks,
      delayTicks: this.delayTicks,
      minDelayTicks: this.minDelayTicks,
      maxDelayTicks: this.maxDelayTicks,
      bufferSize: this.bufferSize,
      underrunRate: this.windowUnderrunSum / windowSize,
      underrunCount: this.underrunCount,
      lateSnapshotCount: this.lateSnapshotCount,
      lateSnapshotEma: this.lateSnapshotEma,
      stallCount: this.stallCount,
      extrapCount: this.extrapCount,
      extrapolatingTicks: this.extrapolatingTicks,
      stalled: this.stalled,
      rttMs: this.rttMs,
      rttJitterMs: this.rttJitterMs,
      targetBufferPairs: this.targetBufferPairs,
      targetBufferTargetPairs: this.targetBufferTargetPairs,
      adaptiveEveryTicks: this.adaptiveEveryTicks,
      adaptiveEveryTargetTicks: this.adaptiveEveryTargetTicks,
      bufferHasReserve,
      tuning: {
        baseDelayMax: INTERP_TUNING.baseDelay.maxTicks,
        targetBufferMin: INTERP_TUNING.targetBuffer.minPairs,
        targetBufferMax: INTERP_TUNING.targetBuffer.maxPairs,
        cadenceMin: INTERP_TUNING.cadence.minEvery,
        cadenceMax: INTERP_TUNING.cadence.maxEvery,
      },
    };
  }

  getDelayTicks(): number {
    return this.delayTicks;
  }

  private upsertPlayer(
    player: { tgUserId: string; displayName: string; colorId: number; isMoving?: boolean },
    target: { x: number; y: number; targetTickUsed: number },
    renderTick: number = this.renderTick,
    forceSnap: boolean = false,
  ): void {
    let state = this.remoteRenderStates.get(player.tgUserId);
    if (!state) {
      state = {
        x: target.x,
        y: target.y,
        lastTargetX: target.x,
        lastTargetY: target.y,
        lastTargetTick: target.targetTickUsed,
      };
      this.remoteRenderStates.set(player.tgUserId, state);
    }

    if (forceSnap) {
      state.x = target.x;
      state.y = target.y;
      state.lastTargetX = target.x;
      state.lastTargetY = target.y;
      state.lastTargetTick = target.targetTickUsed;
      state.segment = undefined;
    } else if (target.x !== state.lastTargetX || target.y !== state.lastTargetY) {
      const fromX = state.lastTargetX;
      const fromY = state.lastTargetY;
      const startTick = Math.max(state.lastTargetTick + 1, target.targetTickUsed);
      state.segment = {
        fromX,
        fromY,
        toX: target.x,
        toY: target.y,
        startTick,
        durationTicks: this.getStepDurationTicks(),
      };
      state.lastTargetX = target.x;
      state.lastTargetY = target.y;
      state.lastTargetTick = target.targetTickUsed;
    }

    if (state.segment) {
      const duration = Math.max(1, state.segment.durationTicks);
      const alpha = Phaser.Math.Clamp((renderTick - state.segment.startTick) / duration, 0, 1);
      state.x = Phaser.Math.Linear(state.segment.fromX, state.segment.toX, alpha);
      state.y = Phaser.Math.Linear(state.segment.fromY, state.segment.toY, alpha);
      if (alpha >= 1) {
        state.segment = undefined;
      }
    }

    const dx = target.x - state.x;
    const dy = target.y - state.y;
    const driftTiles = Math.hypot(dx, dy);
    const shouldSnap = driftTiles > REMOTE_RENDER_SNAP_DISTANCE_TILES;

    if (shouldSnap) {
      const snapCount = this.remoteRenderSnapCount.get(player.tgUserId) ?? 0;
      this.remoteRenderSnapCount.set(player.tgUserId, snapCount + 1);
      state.x = target.x;
      state.y = target.y;
      state.segment = undefined;
    }

    const moving = Boolean(player.isMoving ?? state.segment);
    const bobPhase = getBobPhaseFromId(player.tgUserId);
    const bobTime = performance.now() * (moving ? 0.016 : 0.006) + bobPhase;
    const bobOffset = Math.sin(bobTime) * (moving ? 1.8 : 0.5);
    const swayAngle = Math.sin(performance.now() * 0.02 + bobPhase) * (moving ? 2 : 0.45);
    const scalePulse = 1 + Math.sin(bobTime) * (moving ? 0.017 : 0.008);

    const px = this.offsetX + state.x * this.tileSize + this.tileSize / 2;
    const py = this.offsetY + state.y * this.tileSize + this.tileSize / 2;
    let view = this.players.get(player.tgUserId);
    if (!view) {
      view = this.createPlayer(player, px, py);
      this.players.set(player.tgUserId, view);
    }

    view.container.setPosition(px, py + bobOffset);
    view.nameText.setText(player.displayName);
    view.body
      .setTexture(getPlayerSilhouetteTextureKeyFromId(player.tgUserId))
      .setTint(colorFromId(player.colorId))
      .setAngle(swayAngle)
      .setScale(scalePulse);
  }

  private getStepDurationTicks(): number {
    return MP_MOVE_TICKS_CONST;
  }

  private destroyMissingPlayers(alive: Set<string>): void {
    for (const [id, view] of this.players.entries()) {
      if (alive.has(id)) continue;
      view.container.destroy(true);
      this.players.delete(id);
      this.remoteRenderStates.delete(id);
      this.velocities.delete(id);
      this.remoteRenderSnapCount.delete(id);
    }
  }

  private createPlayer(p: { displayName: string; colorId: number; tgUserId?: string }, x: number, y: number): RemotePlayerView {
    const silhouetteKey = getPlayerSilhouetteTextureKeyFromId(p.tgUserId ?? p.displayName);
    const body = this.scene.add.image(0, 0, silhouetteKey);
    body.setOrigin(0.5, 0.5);
    body.setDisplaySize(this.tileSize * 0.74, this.tileSize * 0.74);
    body.setTint(colorFromId(p.colorId));

    const nameText = this.scene.add.text(0, -18, p.displayName, {
      fontSize: '10px',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3,
    });
    nameText.setOrigin(0.5, 1);

    const container = this.scene.add.container(0, 0, [body, nameText]);
    container.setDepth(10_000);
    container.setPosition(x, y);

    return {
      container,
      body,
      nameText,
    };
  }
}

function colorFromId(id: number): number {
  const colors = [0x00ff00, 0xff0000, 0x00aaff, 0xffffff];
  return colors[(id ?? 0) % colors.length];
}
