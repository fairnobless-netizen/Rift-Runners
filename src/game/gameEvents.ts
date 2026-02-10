import Phaser from 'phaser';
import type { PlayerStats, SimulationEvent } from './types';

export const gameEvents = new Phaser.Events.EventEmitter();

export const EVENT_STATS = 'stats';
export const EVENT_READY = 'ready';

export const EVENT_SIMULATION = 'simulation';

export interface ReadyPayload {
  setZoom: (zoom: number) => void;
  resetZoom: () => void;
}

export function emitStats(stats: PlayerStats): void {
  gameEvents.emit(EVENT_STATS, stats);
}

export function emitSimulationEvent(event: SimulationEvent): void {
  gameEvents.emit(EVENT_SIMULATION, event);
}
