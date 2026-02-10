export interface DoorControllerConfig {
  maxHits: number;
  hitLockMs: number;
  telegraphMinMs: number;
  telegraphMaxMs: number;
  pressureIntervalMinMs: number;
  pressureIntervalMaxMs: number;
  firstHitSpawnCount: number;
  secondHitSpawnCount: number;
  eliteWaveCount: number;
  pressureNormalCount: number;
  pressureEliteCount: number;
}

export interface DoorState {
  doorHits: number;
  hitLockMs: number;
  lastWaveId?: string;
  isTelegraphing: boolean;
}

export interface EnemySpawner {
  spawnNormalDoorWave(count: number): void;
  spawnEliteDoorWave(count: number): void;
  spawnPressureWave(eliteCount: number, normalCount: number): void;
}

export class DoorController {
  private state: DoorState;
  private lastHitAt = Number.NEGATIVE_INFINITY;
  private telegraphEndsAt: number | null = null;
  private pressureModeEnabled = false;
  private nextPressureAt: number | null = null;

  constructor(
    private readonly config: DoorControllerConfig,
    private readonly enemySpawner: EnemySpawner,
    private readonly nextFloat: () => number,
  ) {
    this.state = {
      doorHits: 0,
      hitLockMs: config.hitLockMs,
      isTelegraphing: false,
    };
  }

  reset(): void {
    this.state = {
      doorHits: 0,
      hitLockMs: this.config.hitLockMs,
      isTelegraphing: false,
    };
    this.lastHitAt = Number.NEGATIVE_INFINITY;
    this.telegraphEndsAt = null;
    this.pressureModeEnabled = false;
    this.nextPressureAt = null;
  }

  getDoorState(): Readonly<DoorState> {
    return this.state;
  }

  isPressureModeEnabled(): boolean {
    return this.pressureModeEnabled;
  }

  handleExplosionWaveHit(waveId: string, timeMs: number): boolean {
    if (this.state.lastWaveId === waveId) return false;
    if (this.state.isTelegraphing) return false;
    if (this.state.doorHits >= this.config.maxHits) return false;
    if (timeMs - this.lastHitAt < this.state.hitLockMs) return false;

    this.state.lastWaveId = waveId;
    this.lastHitAt = timeMs;
    this.state.doorHits = Math.min(this.config.maxHits, this.state.doorHits + 1);

    if (this.state.doorHits === 1) {
      this.enemySpawner.spawnNormalDoorWave(this.config.firstHitSpawnCount);
      return true;
    }

    if (this.state.doorHits === 2) {
      this.enemySpawner.spawnNormalDoorWave(this.config.secondHitSpawnCount);
      return true;
    }

    this.state.isTelegraphing = true;
    this.telegraphEndsAt = timeMs + this.randomBetween(this.config.telegraphMinMs, this.config.telegraphMaxMs);
    return true;
  }

  update(timeMs: number, levelCleared: boolean): void {
    if (this.state.isTelegraphing && this.telegraphEndsAt !== null && timeMs >= this.telegraphEndsAt) {
      this.state.isTelegraphing = false;
      this.telegraphEndsAt = null;
      this.enemySpawner.spawnEliteDoorWave(this.config.eliteWaveCount);
      this.enablePressureMode(timeMs);
    }

    if (levelCleared || !this.pressureModeEnabled || this.nextPressureAt === null) return;

    if (timeMs >= this.nextPressureAt) {
      this.enemySpawner.spawnPressureWave(this.config.pressureEliteCount, this.config.pressureNormalCount);
      this.nextPressureAt = timeMs + this.randomBetween(this.config.pressureIntervalMinMs, this.config.pressureIntervalMaxMs);
    }
  }

  private enablePressureMode(timeMs: number): void {
    if (this.pressureModeEnabled) return;
    this.pressureModeEnabled = true;
    this.nextPressureAt = timeMs + this.randomBetween(this.config.pressureIntervalMinMs, this.config.pressureIntervalMaxMs);
  }

  private randomBetween(min: number, max: number): number {
    if (min >= max) return min;
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }
}
