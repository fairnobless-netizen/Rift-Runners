import Phaser from 'phaser';
import type { Scene } from 'phaser';
import { GAME_CONFIG, DEPTH_ENEMY } from '../config';
import type { BossModel } from './BossTypes';

export class BossEntity {
  private sprite?: Phaser.GameObjects.Ellipse;
  private hpBarBg?: Phaser.GameObjects.Rectangle;
  private hpBarFill?: Phaser.GameObjects.Rectangle;
  private readonly model: BossModel;

  constructor(private readonly scene: Scene, x: number, y: number, hp: number, totalPhases: number) {
    this.model = {
      key: 'boss-m4',
      gridX: x,
      gridY: y,
      moveFromX: x,
      moveFromY: y,
      targetX: x,
      targetY: y,
      moveStartedAtMs: 0,
      moveDurationMs: 0,
      isMoving: false,
      hp,
      maxHp: hp,
      isAlive: true,
      phase: 1,
      totalPhases,
      isVulnerable: false,
      vulnerableUntil: 0,
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

  setPosition(x: number, y: number, timeMs: number, moveDurationMs: number): void {
    this.model.moveFromX = this.model.gridX;
    this.model.moveFromY = this.model.gridY;
    this.model.targetX = x;
    this.model.targetY = y;
    this.model.gridX = x;
    this.model.gridY = y;
    this.model.moveStartedAtMs = timeMs;
    this.model.moveDurationMs = Math.max(1, moveDurationMs);
    this.model.isMoving = true;
    this.syncSprite(timeMs);
  }

  setVulnerable(until: number): void {
    this.model.isVulnerable = true;
    this.model.vulnerableUntil = until;
    this.syncSprite();
  }

  closeVulnerability(now: number): void {
    if (!this.model.isVulnerable) return;
    if (now < this.model.vulnerableUntil) return;
    this.model.isVulnerable = false;
    this.syncSprite();
  }

  applyDamage(damage: number): boolean {
    if (!this.model.isAlive || damage <= 0 || !this.model.isVulnerable) return false;
    this.model.hp = Math.max(0, this.model.hp - damage);
    if (this.model.hp === 0) {
      this.model.isAlive = false;
    } else {
      const remainingRatio = this.model.maxHp <= 0 ? 0 : this.model.hp / this.model.maxHp;
      const phase = Math.min(this.model.totalPhases, Math.max(1, Math.ceil((1 - remainingRatio) * this.model.totalPhases)));
      this.model.phase = phase;
    }
    this.syncSprite();
    return true;
  }

  syncSprite(timeMs?: number): void {
    if (!this.sprite) return;
    const { tileSize } = GAME_CONFIG;
    const now = timeMs ?? this.scene.time.now;
    const progress = this.model.isMoving
      ? Phaser.Math.Clamp((now - this.model.moveStartedAtMs) / Math.max(1, this.model.moveDurationMs), 0, 1)
      : 1;
    const renderGX = this.model.isMoving
      ? Phaser.Math.Linear(this.model.moveFromX, this.model.targetX, progress)
      : this.model.gridX;
    const renderGY = this.model.isMoving
      ? Phaser.Math.Linear(this.model.moveFromY, this.model.targetY, progress)
      : this.model.gridY;

    if (this.model.isMoving && progress >= 1) {
      this.model.isMoving = false;
      this.model.moveStartedAtMs = 0;
    }

    this.sprite
      .setPosition(renderGX * tileSize + tileSize / 2, renderGY * tileSize + tileSize / 2)
      .setFillStyle(this.model.isVulnerable ? 0xff76ff : 0x8f2cff, 1);

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
