import Phaser from 'phaser';

type RemotePlayerView = {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Rectangle;
  nameText: Phaser.GameObjects.Text;
};

export type MatchSnapshotV1 = {
  version: 'match_v1';
  matchId: string;
  tick: number;
  world: { gridW: number; gridH: number };
  players: Array<{
    tgUserId: string;
    displayName: string;
    colorId: number;
    skinId: string;
    x: number;
    y: number;
  }>;
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


  update(_delta: number) {
    // Placeholder for interpolation/smoothing between snapshots.
  }
  applySnapshot(snapshot: MatchSnapshotV1, localTgUserId?: string) {
    const alive = new Set<string>();

    for (const p of snapshot.players) {
      alive.add(p.tgUserId);

      if (localTgUserId && p.tgUserId === localTgUserId) continue;

      let view = this.players.get(p.tgUserId);
      if (!view) {
        view = this.createPlayer(p);
        this.players.set(p.tgUserId, view);
      }

      const px = this.offsetX + p.x * this.tileSize + this.tileSize / 2;
      const py = this.offsetY + p.y * this.tileSize + this.tileSize / 2;

      view.container.setPosition(px, py);
      view.nameText.setText(p.displayName);
      view.body.setFillStyle(colorFromId(p.colorId), 0.75);
    }

    for (const [id, view] of this.players.entries()) {
      if (!alive.has(id)) {
        view.container.destroy(true);
        this.players.delete(id);
      }
    }
  }

  private createPlayer(p: { displayName: string; colorId: number }) {
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

    return { container, body, nameText };
  }
}

function colorFromId(id: number): number {
  const colors = [0x00ff00, 0xff0000, 0x00aaff, 0xffffff];
  return colors[(id ?? 0) % colors.length];
}
