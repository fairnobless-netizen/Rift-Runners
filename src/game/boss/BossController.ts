import Phaser, { type Scene } from 'phaser';
import { isInsideArena, toKey, type ExplosionImpact } from '../arena';
import { GAME_CONFIG } from '../config';
import { BossEntity } from './BossEntity';
import { getBossProfile } from './bossProfiles';
import type { BossConfig, BossControllerDeps, BossFightContext, BossHazard, BossLifecycleState } from './BossTypes';

const DIRECTIONS: Array<{ dx: number; dy: number }> = [
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
];

export class BossController {
  private boss?: BossEntity;
  private context?: BossFightContext;
  private profile = getBossProfile(1);
  private lifecycleState: BossLifecycleState = 'hidden';
  private spawnAt = 0;
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
    const zoneInStage = levelIndex % this.config.zonesPerStage;
    return zoneInStage === this.config.triggerZoneInStage;
  }

  reset(context: BossFightContext): void {
    this.context = context;
    this.clear();
    this.lifecycleState = context.isBossLevel ? 'hidden' : 'defeated';
    this.profile = getBossProfile(context.playerCount);
  }

  clear(): void {
    this.boss?.destroy();
    this.boss = undefined;
    for (const sprite of this.hazardSprites.values()) sprite.destroy();
    this.hazardSprites.clear();
    this.activeHazards.clear();
  }

  revealBoss(): void {
    if (!this.context?.isBossLevel) return;
    if (this.lifecycleState !== 'hidden') return;
    this.lifecycleState = 'revealing';
    this.spawnAt = this.scene.time.now + this.config.revealSpawnDelayMs;
    this.deps.onBossReveal();
    this.scene.cameras.main.shake(this.config.revealShakeMs, 0.005);
  }

  isDefeated(): boolean {
    return this.lifecycleState === 'defeated';
  }

  update(time: number): void {
    if (this.lifecycleState === 'revealing' && time >= this.spawnAt) {
      this.spawnBoss(time);
    }

    if (!this.boss || this.lifecycleState !== 'active') return;
    this.boss.closeVulnerability(time);
    this.boss.syncSprite();
    this.cleanupHazards(time);
    this.checkHazardPlayerCollision();

    if (time >= this.nextChaseAt) {
      this.executeChase();
      this.nextChaseAt = time + Math.floor(900 / this.profile.speedMultiplier);
    }

    if (time >= this.nextRangedAt) {
      this.executeRangedAttack(time);
      this.openVulnerableWindow(time);
      this.nextRangedAt = time + this.profile.attackIntervalMs;
    }

    if (time >= this.nextSummonAt) {
      this.executeSummon();
      this.nextSummonAt = time + this.profile.summonIntervalMs;
    }
  }

  applyExplosionDamage(impacts: ExplosionImpact[]): void {
    if (!this.boss || this.lifecycleState !== 'active') return;
    const model = this.boss.getModel();
    if (!model.isAlive) return;

    let damage = 0;
    for (const impact of impacts) {
      if (impact.x !== model.gridX || impact.y !== model.gridY) continue;
      if (impact.distance === 0) {
        this.openVulnerableWindow(this.scene.time.now);
      }
      damage = Math.max(damage, impact.distance === 0 ? 2 : 1);
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
      this.lifecycleState = 'defeated';
      this.deps.onBossDefeated();
    }
  }

  private spawnBoss(time: number): void {
    this.lifecycleState = 'active';
    this.boss = new BossEntity(
      this.scene,
      Math.floor(GAME_CONFIG.gridWidth / 2),
      Math.floor(GAME_CONFIG.gridHeight / 2),
      this.profile.hp,
      this.profile.phaseCount,
    );
    this.boss.spawn();
    this.nextChaseAt = time + 300;
    this.nextRangedAt = time + this.profile.attackIntervalMs;
    this.nextSummonAt = time + this.profile.summonIntervalMs;
    this.deps.onBossSpawned(this.profile);
  }

  private openVulnerableWindow(now: number): void {
    this.boss?.setVulnerable(now + this.config.vulnerableWindowMs);
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
      this.spawnHazardTile(x, y, time + 700);
      if (tile === 'BreakableBlock' || tile === 'ANOMALOUS_STONE') break;
    }
  }

  private executeSummon(): void {
    if (!this.boss) return;
    const boss = this.boss.getModel();
    let spawned = 0;
    for (const dir of DIRECTIONS) {
      if (spawned >= this.profile.summonCount) break;
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
