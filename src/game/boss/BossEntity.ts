import Phaser from 'phaser';
import type { Scene } from 'phaser';
import { GAME_CONFIG, DEPTH_ENEMY } from '../config';
import type { BossModel } from './BossTypes';

export class BossEntity {
  private sprite?: Phaser.GameObjects.Ellipse;
  private hpBarBg?: Phaser.GameObjects.Rectangle;
  private hpBarFill?: Phaser.GameObjects.Rectangle;
  private readonly model: BossModel;

  constructor(private readonly scene: Scene, x: number, y: number, hp: number) {
    this.model = {
      key: 'boss-m1',
      gridX: x,
      gridY: y,
      hp,
      maxHp: hp,
      isAlive: true,
    };
  }

  getModel(): BossModel {
    return this.model;
  }

  spawn(): void {
    if (this.sprite) return;
    const { tileSize } = GAME_CONFIG;
    this.sprite = this.scene.add
      .ellipse(this.model.gridX * tileSize + tileSize / 2, this.model.gridY * tileSize + tileSize / 2, tileSize * 0.85, tileSize * 0.85, 0x8f2cff)
      .setDepth(DEPTH_ENEMY + 1)
      .setStrokeStyle(3, 0xfbefff, 1);

    this.hpBarBg = this.scene.add
      .rectangle(this.sprite.x, this.sprite.y - tileSize * 0.62, tileSize * 0.9, 8, 0x1f1f1f)
      .setDepth(DEPTH_ENEMY + 2)
      .setOrigin(0.5, 0.5);

    this.hpBarFill = this.scene.add
      .rectangle(this.hpBarBg.x - (tileSize * 0.9) / 2, this.hpBarBg.y, tileSize * 0.9, 6, 0xff3f73)
      .setDepth(DEPTH_ENEMY + 3)
      .setOrigin(0, 0.5);
  }

  setPosition(x: number, y: number): void {
    this.model.gridX = x;
    this.model.gridY = y;
    this.syncSprite();
  }

  applyDamage(damage: number): boolean {
    if (!this.model.isAlive || damage <= 0) return false;
    this.model.hp = Math.max(0, this.model.hp - damage);
    if (this.model.hp === 0) this.model.isAlive = false;
    this.syncSprite();
    return true;
  }

  syncSprite(): void {
    if (!this.sprite) return;
    const { tileSize } = GAME_CONFIG;
    this.sprite.setPosition(this.model.gridX * tileSize + tileSize / 2, this.model.gridY * tileSize + tileSize / 2);
    if (this.hpBarBg) {
      this.hpBarBg.setPosition(this.sprite.x, this.sprite.y - tileSize * 0.62);
    }
    if (this.hpBarFill && this.hpBarBg) {
      const ratio = this.model.maxHp <= 0 ? 0 : this.model.hp / this.model.maxHp;
      this.hpBarFill
        .setPosition(this.hpBarBg.x - this.hpBarBg.width / 2, this.hpBarBg.y)
        .setDisplaySize(this.hpBarBg.width * ratio, this.hpBarFill.height);
    }
  }

  destroy(): void {
    this.sprite?.destroy();
    this.hpBarBg?.destroy();
    this.hpBarFill?.destroy();
    this.sprite = undefined;
    this.hpBarBg = undefined;
    this.hpBarFill = undefined;
  }
}
