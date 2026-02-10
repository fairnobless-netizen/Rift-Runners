import Phaser, { type Scene } from 'phaser';
import { isInsideArena, toKey, type ExplosionImpact } from '../arena';
import { GAME_CONFIG } from '../config';
import { BossEntity } from './BossEntity';
import type { BossConfig, BossControllerDeps, BossFightContext, BossHazard } from './BossTypes';

const DIRECTIONS: Array<{ dx: number; dy: number }> = [
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
];

export class BossController {
  private boss?: BossEntity;
  private context?: BossFightContext;
  private nextChaseAt = 0;
  private nextRangedAt = 0;
  private nextSummonAt = 0;
  private hazardSeq = 0;
  private activeHazards = new Map<string, BossHazard>();
  private hazardSprites = new Map<string, Phaser.GameObjects.Rectangle>();

  constructor(
    private readonly scene: Scene,
    private readonly config: BossConfig,
    private readonly deps: BossControllerDeps,
  ) {}

  isBossLevel(levelIndex: number): boolean {
    return levelIndex === this.config.triggerLevelIndex;
  }

  reset(context: BossFightContext): void {
    this.context = context;
    this.clear();

    if (!context.isBossLevel) return;

    this.boss = new BossEntity(this.scene, Math.floor(GAME_CONFIG.gridWidth / 2), Math.floor(GAME_CONFIG.gridHeight / 2), this.config.maxHp);
    this.boss.spawn();
    this.nextChaseAt = this.scene.time.now + 300;
    this.nextRangedAt = this.scene.time.now + this.config.rangedIntervalMs;
    this.nextSummonAt = this.scene.time.now + this.config.summonIntervalMs;
  }

  clear(): void {
    this.boss?.destroy();
    this.boss = undefined;
    for (const sprite of this.hazardSprites.values()) sprite.destroy();
    this.hazardSprites.clear();
    this.activeHazards.clear();
  }

  update(time: number): void {
    if (!this.boss) return;
    this.boss.syncSprite();
    this.cleanupHazards(time);
    this.checkHazardPlayerCollision();

    if (time >= this.nextChaseAt) {
      this.executeChase();
      this.nextChaseAt = time + this.config.chaseIntervalMs;
    }

    if (time >= this.nextRangedAt) {
      this.executeRangedAttack(time);
      this.nextRangedAt = time + this.config.rangedIntervalMs;
    }

    if (time >= this.nextSummonAt) {
      this.executeSummon();
      this.nextSummonAt = time + this.config.summonIntervalMs;
    }
  }

  applyExplosionDamage(impacts: ExplosionImpact[]): void {
    if (!this.boss) return;
    const model = this.boss.getModel();
    if (!model.isAlive) return;

    let damage = 0;
    for (const impact of impacts) {
      if (impact.x !== model.gridX || impact.y !== model.gridY) continue;
      damage = Math.max(damage, impact.distance === 0 ? this.config.centerExplosionDamage : this.config.explosionDamage);
    }

    if (damage <= 0) return;
    const changed = this.boss.applyDamage(damage);
    if (!changed) return;

    const updated = this.boss.getModel();
    this.deps.onBossDamaged(updated.hp, updated.maxHp);
    if (!updated.isAlive) {
      this.boss.destroy();
      this.boss = undefined;
      this.clearHazards();
      this.deps.onBossDefeated();
    }
  }

  private executeChase(): void {
    if (!this.boss) return;
    const boss = this.boss.getModel();
    const player = this.deps.getPlayerCell();
    const dx = Math.sign(player.x - boss.gridX);
    const dy = Math.sign(player.y - boss.gridY);
    const candidates = Math.abs(player.x - boss.gridX) >= Math.abs(player.y - boss.gridY)
      ? [
          { x: boss.gridX + dx, y: boss.gridY },
          { x: boss.gridX, y: boss.gridY + dy },
        ]
      : [
          { x: boss.gridX, y: boss.gridY + dy },
          { x: boss.gridX + dx, y: boss.gridY },
        ];

    for (const cell of candidates) {
      if (!isInsideArena(cell.x, cell.y)) continue;
      if (!this.deps.canOccupy(cell.x, cell.y)) continue;
      this.boss.setPosition(cell.x, cell.y);
      return;
    }
  }

  private executeRangedAttack(time: number): void {
    if (!this.boss || !this.context) return;
    const boss = this.boss.getModel();
    const player = this.deps.getPlayerCell();
    const horizontal = Math.abs(player.x - boss.gridX) >= Math.abs(player.y - boss.gridY);
    const step = horizontal
      ? { dx: Math.sign(player.x - boss.gridX) || 1, dy: 0 }
      : { dx: 0, dy: Math.sign(player.y - boss.gridY) || 1 };

    for (let i = 1; i <= GAME_CONFIG.gridWidth; i += 1) {
      const x = boss.gridX + step.dx * i;
      const y = boss.gridY + step.dy * i;
      if (!isInsideArena(x, y)) break;
      const tile = this.context.arena.tiles[y]?.[x];
      if (tile === 'HardWall') break;
      this.spawnHazardTile(x, y, time + this.config.hazardDurationMs);
      if (tile === 'BreakableBlock') break;
    }
  }

  private executeSummon(): void {
    if (!this.boss) return;
    const boss = this.boss.getModel();
    let spawned = 0;
    for (const dir of DIRECTIONS) {
      if (spawned >= this.config.summonCount) break;
      const x = boss.gridX + dir.dx;
      const y = boss.gridY + dir.dy;
      if (!isInsideArena(x, y)) continue;
      if (!this.deps.canSpawnMinion(x, y)) continue;
      this.deps.spawnMinion(x, y);
      spawned += 1;
    }
  }

  private spawnHazardTile(x: number, y: number, expiresAt: number): void {
    const key = toKey(x, y);
    this.hazardSeq += 1;
    const hazardKey = `${key}-${this.hazardSeq}`;
    const hazard: BossHazard = { key: hazardKey, x, y, expiresAt };
    this.activeHazards.set(hazardKey, hazard);

    const { tileSize } = GAME_CONFIG;
    const sprite = this.scene.add
      .rectangle(x * tileSize + tileSize / 2, y * tileSize + tileSize / 2, tileSize - 10, tileSize - 10, 0xff6b1a, 0.45)
      .setDepth(7);
    this.hazardSprites.set(hazardKey, sprite);
  }

  private cleanupHazards(time: number): void {
    for (const [key, hazard] of this.activeHazards.entries()) {
      if (time < hazard.expiresAt) continue;
      this.activeHazards.delete(key);
      this.hazardSprites.get(key)?.destroy();
      this.hazardSprites.delete(key);
    }
  }

  private clearHazards(): void {
    for (const sprite of this.hazardSprites.values()) sprite.destroy();
    this.hazardSprites.clear();
    this.activeHazards.clear();
  }

  private checkHazardPlayerCollision(): void {
    const player = this.deps.getPlayerCell();
    for (const hazard of this.activeHazards.values()) {
      if (hazard.x !== player.x || hazard.y !== player.y) continue;
      this.deps.onPlayerHit();
      return;
    }
  }
}
