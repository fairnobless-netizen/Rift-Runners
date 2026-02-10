import type { ArenaModel, ExplosionImpact } from '../arena';

export type BossAttackKind = 'chase' | 'ranged' | 'summon';

export interface BossConfig {
  triggerLevelIndex: number;
  maxHp: number;
  explosionDamage: number;
  centerExplosionDamage: number;
  chaseIntervalMs: number;
  rangedIntervalMs: number;
  summonIntervalMs: number;
  hazardDurationMs: number;
  summonCount: number;
  defeatScoreReward: number;
}

export interface BossModel {
  key: string;
  gridX: number;
  gridY: number;
  hp: number;
  maxHp: number;
  isAlive: boolean;
}

export interface BossHazard {
  key: string;
  x: number;
  y: number;
  expiresAt: number;
}

export interface BossControllerDeps {
  canOccupy: (x: number, y: number) => boolean;
  canSpawnMinion: (x: number, y: number) => boolean;
  spawnMinion: (x: number, y: number) => void;
  onPlayerHit: () => void;
  onBossDefeated: () => void;
  onBossDamaged: (hp: number, maxHp: number) => void;
  getPlayerCell: () => { x: number; y: number };
}

export interface BossFightContext {
  arena: ArenaModel;
  isBossLevel: boolean;
}

export interface BossExplosionDamageInput {
  impacts: ExplosionImpact[];
}
