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

  renderInterpolated(buffer: MatchSnapshotV1[], renderTick: number, localTgUserId?: string): void {
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
      this.renderFromSnapshot(buffer[buffer.length - 1], localTgUserId);
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

  private renderFromSnapshot(snapshot: MatchSnapshotV1, localTgUserId?: string): void {
    const alive = new Set<string>();
    for (const player of snapshot.players) {
      if (localTgUserId && player.tgUserId === localTgUserId) continue;
      alive.add(player.tgUserId);
      this.upsertPlayer(player, player.x, player.y);
    }
    this.destroyMissingPlayers(alive);
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
