import Phaser from 'phaser';
import type { MatchSnapshotV1 } from '../ws/wsTypes';

type RemotePlayerView = {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Rectangle;
  nameText: Phaser.GameObjects.Text;
};

export class RemotePlayersRenderer {
  private scene: Phaser.Scene;
  private players = new Map<string, RemotePlayerView>();
  private velocities = new Map<string, { vx: number; vy: number }>();
  private lastRenderedGridPos = new Map<string, { x: number; y: number }>();

  private readonly maxExtrapolationTicks = 3;
  private stallAfterTicks = 7;
  private renderTick = -1;
  private baseDelayTicks = 2;
  private delayTicks = 2;
  private minDelayTicks = 1;
  private maxDelayTicks = 6;
  private targetBufferPairs = 2;
  private bufferSize = 0;
  private extrapolatingTicks = 0;
  private stalled = false;
  private underrunCount = 0;
  private stallCount = 0;
  private extrapCount = 0;

  private readonly metricsWindowTicks = 60;
  private readonly adaptiveUpdateEveryTicks = 10;
  private readonly adaptiveCooldownTicks = 20;
  private lastAdaptiveUpdateTick = 0;
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

  update(simulationTick: number, buffer: MatchSnapshotV1[], localTgUserId?: string): void {
    this.updateAdaptiveDelay(simulationTick, buffer.length);
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

    let snapshotA: MatchSnapshotV1 | undefined;
    let snapshotB: MatchSnapshotV1 | undefined;
    for (let i = 1; i < buffer.length; i += 1) {
      const prev = buffer[i - 1];
      const next = buffer[i];
      if (prev.tick <= renderTick && renderTick <= next.tick) {
        snapshotA = prev;
        snapshotB = next;
        break;
      }
    }

    if (!snapshotA || !snapshotB) {
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

    const tickSpan = snapshotB.tick - snapshotA.tick;
    const alpha = tickSpan <= 0 ? 1 : Phaser.Math.Clamp((renderTick - snapshotA.tick) / tickSpan, 0, 1);
    const fromPlayers = new Map(snapshotA.players.map((p) => [p.tgUserId, p]));
    const alive = new Set<string>();

    for (const to of snapshotB.players) {
      if (localTgUserId && to.tgUserId === localTgUserId) continue;

      alive.add(to.tgUserId);
      const from = fromPlayers.get(to.tgUserId) ?? to;
      const x = Phaser.Math.Linear(from.x, to.x, alpha);
      const y = Phaser.Math.Linear(from.y, to.y, alpha);
      this.upsertPlayer(to, x, y);
    }

    this.destroyMissingPlayers(alive);
  }

  private updateAdaptiveDelay(simulationTick: number, bufferSize: number): void {
    if (this.windowUnderrunEvents.length === 0) {
      this.lastAdaptiveUpdateTick = simulationTick;
      this.lastDelayChangeTick = simulationTick;
    }

    this.pushWindowSample(0, 0, 0);

    if (simulationTick - this.lastAdaptiveUpdateTick < this.adaptiveUpdateEveryTicks) {
      return;
    }

    this.lastAdaptiveUpdateTick = simulationTick;
    if (simulationTick - this.lastDelayChangeTick < this.adaptiveCooldownTicks) {
      return;
    }

    const windowSize = Math.max(1, this.windowUnderrunEvents.length);
    const underrunRate = this.windowUnderrunSum / windowSize;
    const bufferHasReserve = bufferSize >= this.targetBufferPairs + 2;

    if (underrunRate > 0.05 || this.windowStallSum > 0) {
      const nextDelay = Math.min(this.delayTicks + 1, this.maxDelayTicks);
      if (nextDelay !== this.delayTicks) {
        this.delayTicks = nextDelay;
        this.lastDelayChangeTick = simulationTick;
      }
      return;
    }

    if (this.windowUnderrunSum === 0 && bufferHasReserve) {
      const nextDelay = Math.max(this.delayTicks - 1, this.minDelayTicks);
      if (nextDelay !== this.delayTicks) {
        this.delayTicks = nextDelay;
        this.lastDelayChangeTick = simulationTick;
      }
    }
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
      this.upsertPlayer(player, player.x, player.y);
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
      this.upsertPlayer(player, x, y);
    }
    this.destroyMissingPlayers(alive);
  }

  private renderFrozen(snapshot: MatchSnapshotV1, localTgUserId?: string): void {
    const alive = new Set<string>();
    for (const player of snapshot.players) {
      if (localTgUserId && player.tgUserId === localTgUserId) continue;
      alive.add(player.tgUserId);
      const frozenPos = this.lastRenderedGridPos.get(player.tgUserId);
      this.upsertPlayer(player, frozenPos?.x ?? player.x, frozenPos?.y ?? player.y);
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

  getDebugStats(): {
    renderTick: number;
    baseDelayTicks: number;
    delayTicks: number;
    minDelayTicks: number;
    maxDelayTicks: number;
    bufferSize: number;
    underrunRate: number;
    underrunCount: number;
    stallCount: number;
    extrapCount: number;
    extrapolatingTicks: number;
    stalled: boolean;
  } {
    const windowSize = Math.max(1, this.windowUnderrunEvents.length);
    return {
      renderTick: this.renderTick,
      baseDelayTicks: this.baseDelayTicks,
      delayTicks: this.delayTicks,
      minDelayTicks: this.minDelayTicks,
      maxDelayTicks: this.maxDelayTicks,
      bufferSize: this.bufferSize,
      underrunRate: this.windowUnderrunSum / windowSize,
      underrunCount: this.underrunCount,
      stallCount: this.stallCount,
      extrapCount: this.extrapCount,
      extrapolatingTicks: this.extrapolatingTicks,
      stalled: this.stalled,
    };
  }

  private upsertPlayer(player: { tgUserId: string; displayName: string; colorId: number }, gridX: number, gridY: number): void {
    const px = this.offsetX + gridX * this.tileSize + this.tileSize / 2;
    const py = this.offsetY + gridY * this.tileSize + this.tileSize / 2;
    let view = this.players.get(player.tgUserId);
    if (!view) {
      view = this.createPlayer(player, px, py);
      this.players.set(player.tgUserId, view);
    } else {
      view.container.setPosition(px, py);
    }

    this.lastRenderedGridPos.set(player.tgUserId, { x: gridX, y: gridY });

    view.nameText.setText(player.displayName);
    view.body.setFillStyle(colorFromId(player.colorId), 0.75);
  }

  private destroyMissingPlayers(alive: Set<string>): void {
    for (const [id, view] of this.players.entries()) {
      if (alive.has(id)) continue;
      view.container.destroy(true);
      this.players.delete(id);
      this.lastRenderedGridPos.delete(id);
      this.velocities.delete(id);
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
