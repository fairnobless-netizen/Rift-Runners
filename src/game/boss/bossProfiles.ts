export interface BossProfile {
  players: 1 | 2 | 3 | 4;
  hp: number;
  speedMultiplier: number;
  phaseCount: number;
  attackIntervalMs: number;
  summonIntervalMs: number;
  summonCount: number;
  arenaEffectsEnabled: boolean;
}

export const BOSS_PROFILES: BossProfile[] = [
  {
    players: 1,
    hp: 8,
    speedMultiplier: 1,
    phaseCount: 2,
    attackIntervalMs: 2200,
    summonIntervalMs: 3800,
    summonCount: 1,
    arenaEffectsEnabled: false,
  },
  {
    players: 2,
    hp: 12,
    speedMultiplier: 1.08,
    phaseCount: 3,
    attackIntervalMs: 2000,
    summonIntervalMs: 3400,
    summonCount: 2,
    arenaEffectsEnabled: false,
  },
  {
    players: 3,
    hp: 16,
    speedMultiplier: 1.15,
    phaseCount: 3,
    attackIntervalMs: 1800,
    summonIntervalMs: 3000,
    summonCount: 3,
    arenaEffectsEnabled: true,
  },
  {
    players: 4,
    hp: 22,
    speedMultiplier: 1.22,
    phaseCount: 4,
    attackIntervalMs: 1600,
    summonIntervalMs: 2600,
    summonCount: 4,
    arenaEffectsEnabled: true,
  },
];

export function getBossProfile(playerCount: number): BossProfile {
  const clamped = Math.max(1, Math.min(4, Math.floor(playerCount || 1))) as 1 | 2 | 3 | 4;
  return BOSS_PROFILES.find((profile) => profile.players === clamped) ?? BOSS_PROFILES[0];
}
