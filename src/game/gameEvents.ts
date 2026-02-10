import Phaser from 'phaser';
import type { PlayerStats } from './types';

export const gameEvents = new Phaser.Events.EventEmitter();

export const EVENT_STATS = 'stats';
export const EVENT_READY = 'ready';

export interface ReadyPayload {
  setZoom: (zoom: number) => void;
  resetZoom: () => void;
}

export function emitStats(stats: PlayerStats): void {
  gameEvents.emit(EVENT_STATS, stats);
}
