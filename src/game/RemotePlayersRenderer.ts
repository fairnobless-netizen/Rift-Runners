import Phaser from 'phaser';
import type { MatchSnapshotV1 } from '@shared/protocol';

const SNAPSHOT_INTERP_MIN_MS = 80;
const MAX_EXTRAPOLATION_MS = 50;
const BUFFER_BASE_DELAY_MS = 120;
const BUFFER_MIN_DELAY_MS = 80;
const BUFFER_MAX_DELAY_MS = 250;
const OFFSET_EMA_ALPHA = 0.1;
const DELTA_EMA_ALPHA = 0.1;
const JITTER_EMA_ALPHA = 0.1;

export type TimedMatchSnapshot = {
  snapshot: MatchSnapshotV1;
  tick: number;
  serverTimeMs: number;
  arriveClientTimeMs: number;
};

type RemotePlayerView = {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Rectangle;
  nameText: Phaser.GameObjects.Text;
};

export class RemotePlayersRenderer {
  private scene: Phaser.Scene;
  private players = new Map<string, RemotePlayerView>();

  private tileSize = 32;
  private offsetX = 0;
  private offsetY = 0;

  private renderTimeMs = -1;
  private renderTick = -1;
  private serverTimeOffsetMs = 0;
  private snapshotDeltaEmaMs = 0;
  private snapshotRateHz = 0;
  private jitterMsEma = 0;
  private renderDelayMs = BUFFER_BASE_DELAY_MS;
  private lateFrames = 0;
  private extrapCount = 0;
  private bufferSize = 0;

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
    this.renderTimeMs = -1;
    this.renderTick = -1;
    this.serverTimeOffsetMs = 0;
    this.snapshotDeltaEmaMs = 0;
    this.snapshotRateHz = 0;
    this.jitterMsEma = 0;
    this.renderDelayMs = BUFFER_BASE_DELAY_MS;
    this.lateFrames = 0;
    this.extrapCount = 0;
    this.bufferSize = 0;
  }

  // kept for compatibility with existing call-site; RTT is no longer the primary delay driver.
  setNetworkRtt(_rttMs: number | null, _rttJitterMs: number, _tickMs: number): void {}

  onSnapshotBuffered(snapshot: TimedMatchSnapshot, prevSnapshot?: TimedMatchSnapshot): void {
    const clientNow = performance.now();
    const offsetEstimate = snapshot.serverTimeMs - clientNow;
    this.serverTimeOffsetMs = Phaser.Math.Linear(this.serverTimeOffsetMs, offsetEstimate, OFFSET_EMA_ALPHA);

    if (!prevSnapshot) return;

    const arrivalDelta = snapshot.arriveClientTimeMs - prevSnapshot.arriveClientTimeMs;
    if (arrivalDelta <= 0) return;

    if (this.snapshotDeltaEmaMs <= 0) {
      this.snapshotDeltaEmaMs = arrivalDelta;
    } else {
      this.snapshotDeltaEmaMs = Phaser.Math.Linear(this.snapshotDeltaEmaMs, arrivalDelta, DELTA_EMA_ALPHA);
    }

    const jitterSample = Math.abs(arrivalDelta - this.snapshotDeltaEmaMs);
    this.jitterMsEma = Phaser.Math.Linear(this.jitterMsEma, jitterSample, JITTER_EMA_ALPHA);
    this.snapshotRateHz = this.snapshotDeltaEmaMs > 0 ? 1000 / this.snapshotDeltaEmaMs : 0;

    const jitterMargin = this.jitterMsEma * 2;
    this.renderDelayMs = Phaser.Math.Clamp(BUFFER_BASE_DELAY_MS + jitterMargin, BUFFER_MIN_DELAY_MS, BUFFER_MAX_DELAY_MS);
  }

  update(_simulationTick: number, buffer: TimedMatchSnapshot[], localTgUserId?: string, _deltaMs: number = 0, _needsNetResync: boolean = false): void {
    this.bufferSize = buffer.length;
    if (buffer.length === 0) {
      this.destroyMissingPlayers(new Set<string>());
      return;
    }

    this.renderTimeMs = performance.now() + this.serverTimeOffsetMs - this.renderDelayMs;

    const newest = buffer[buffer.length - 1];
    if (this.renderTimeMs > newest.serverTimeMs) {
      this.lateFrames += 1;
    }

    const pair = this.findSnapshotsAroundTime(buffer, this.renderTimeMs);
    if (!pair) {
      this.renderFromSnapshot(newest.snapshot, localTgUserId);
      return;
    }

    const { a, b, alpha } = pair;
    this.renderTick = Phaser.Math.Linear(a.tick, b.tick, alpha);

    const aPlayers = new Map(a.snapshot.players.map((p) => [p.tgUserId, p]));
    const bPlayers = new Map(b.snapshot.players.map((p) => [p.tgUserId, p]));
    const alive = new Set<string>();

    for (const [tgUserId, nextPlayer] of bPlayers.entries()) {
      if (localTgUserId && tgUserId === localTgUserId) continue;
      alive.add(tgUserId);
      const prevPlayer = aPlayers.get(tgUserId) ?? nextPlayer;
      const x = Phaser.Math.Linear(prevPlayer.x, nextPlayer.x, alpha);
      const y = Phaser.Math.Linear(prevPlayer.y, nextPlayer.y, alpha);
      this.upsertPlayer(nextPlayer, x, y);
    }

    this.destroyMissingPlayers(alive);
  }

  private findSnapshotsAroundTime(buffer: TimedMatchSnapshot[], renderTimeMs: number): { a: TimedMatchSnapshot; b: TimedMatchSnapshot; alpha: number } | null {
    let a: TimedMatchSnapshot | null = null;
    let b: TimedMatchSnapshot | null = null;

    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      const candidate = buffer[i];
      if (candidate.serverTimeMs <= renderTimeMs) {
        a = candidate;
        b = buffer[Math.min(i + 1, buffer.length - 1)] ?? candidate;
        break;
      }
    }

    if (!a) {
      a = buffer[0];
      b = buffer[Math.min(1, buffer.length - 1)] ?? a;
    }

    if (!b) return null;

    if (b.serverTimeMs <= a.serverTimeMs) {
      return { a, b, alpha: 0 };
    }

    if (renderTimeMs > b.serverTimeMs) {
      const dt = renderTimeMs - b.serverTimeMs;
      if (dt > MAX_EXTRAPOLATION_MS) {
        return { a: b, b, alpha: 1 };
      }
      this.extrapCount += 1;
      return { a, b, alpha: 1 };
    }

    const alpha = Phaser.Math.Clamp((renderTimeMs - a.serverTimeMs) / (b.serverTimeMs - a.serverTimeMs), 0, 1);
    return { a, b, alpha };
  }

  private renderFromSnapshot(snapshot: MatchSnapshotV1, localTgUserId?: string): void {
    const alive = new Set<string>();
    for (const player of snapshot.players) {
      if (localTgUserId && player.tgUserId === localTgUserId) continue;
      alive.add(player.tgUserId);
      this.upsertPlayer(player, player.x, player.y);
    }
    this.destroyMissingPlayers(alive);
  }

  getDebugStats() {
    return {
      renderTick: this.renderTick,
      renderTimeMs: this.renderTimeMs,
      baseDelayTicks: this.renderDelayMs / 50,
      baseDelayTargetTicks: this.renderDelayMs / 50,
      baseDelayStepCooldownMs: 0,
      baseDelayStepCooldownTicks: 0,
      delayTicks: this.renderDelayMs / 50,
      minDelayTicks: BUFFER_MIN_DELAY_MS / 50,
      maxDelayTicks: BUFFER_MAX_DELAY_MS / 50,
      renderDelayMs: this.renderDelayMs,
      serverTimeOffsetMs: this.serverTimeOffsetMs,
      snapshotRateHz: this.snapshotRateHz,
      jitterMs: this.jitterMsEma,
      bufferSize: this.bufferSize,
      underrunRate: 0,
      underrunCount: this.lateFrames,
      lateSnapshotCount: this.lateFrames,
      lateSnapshotEma: 0,
      stallCount: 0,
      extrapCount: this.extrapCount,
      extrapolatingTicks: 0,
      stalled: false,
      lateFrames: this.lateFrames,
      rttMs: null,
      rttJitterMs: 0,
      targetBufferPairs: 0,
      targetBufferTargetPairs: 0,
      adaptiveEveryTicks: 0,
      adaptiveEveryTargetTicks: 0,
      bufferHasReserve: this.bufferSize >= 2,
      tuning: {
        baseDelayMax: BUFFER_MAX_DELAY_MS / 50,
        targetBufferMin: 0,
        targetBufferMax: 0,
        cadenceMin: 0,
        cadenceMax: 0,
      },
    };
  }

  getDelayTicks(): number {
    return this.renderDelayMs / 50;
  }

  getRenderTimeMs(): number {
    return this.renderTimeMs;
  }

  private upsertPlayer(
    player: { tgUserId: string; displayName: string; colorId: number },
    x: number,
    y: number,
  ): void {
    const px = this.offsetX + x * this.tileSize + this.tileSize / 2;
    const py = this.offsetY + y * this.tileSize + this.tileSize / 2;
    let view = this.players.get(player.tgUserId);
    if (!view) {
      view = this.createPlayer(player, px, py);
      this.players.set(player.tgUserId, view);
    } else {
      view.container.setPosition(px, py);
    }

    view.nameText.setText(player.displayName);
    view.body.setFillStyle(colorFromId(player.colorId), 0.75);
  }

  private destroyMissingPlayers(alive: Set<string>): void {
    for (const [id, view] of this.players.entries()) {
      if (alive.has(id)) continue;
      view.container.destroy(true);
      this.players.delete(id);
    }
  }

  private createPlayer(p: { displayName: string; colorId: number }, x: number, y: number): RemotePlayerView {
    const body = this.scene.add.rectangle(0, 0, 18, 18, colorFromId(p.colorId), 0.75);
    body.setOrigin(0.5, 0.5);

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
