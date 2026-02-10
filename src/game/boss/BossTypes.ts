import type { ArenaModel, ExplosionImpact } from '../arena';
import type { BossProfile } from './bossProfiles';

export type BossAttackKind = 'chase' | 'ranged' | 'summon';
export type BossLifecycleState = 'hidden' | 'revealing' | 'active' | 'defeated';

export interface BossConfig {
  zonesPerStage: number;
  stagesTotal: number;
  triggerZoneInStage: number;
  anomalousStoneCount: number;
  revealShakeMs: number;
  revealFlashMs: number;
  revealSpawnDelayMs: number;
  vulnerableWindowMs: number;
  defeatScoreReward: number;
  rewardTrophyAmount: number;
}

export interface BossModel {
  key: string;
  gridX: number;
  gridY: number;
  hp: number;
  maxHp: number;
  isAlive: boolean;
  phase: number;
  totalPhases: number;
  isVulnerable: boolean;
  vulnerableUntil: number;
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
  onBossReveal: () => void;
  onBossSpawned: (profile: BossProfile) => void;
  getPlayerCell: () => { x: number; y: number };
}

export interface BossFightContext {
  arena: ArenaModel;
  isBossLevel: boolean;
  playerCount: number;
}

export interface BossExplosionDamageInput {
  impacts: ExplosionImpact[];
}
