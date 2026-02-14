import Phaser from 'phaser';
import type { PlayerStats, SimulationEvent } from './types';
import type { CampaignState } from './campaign';

export const gameEvents = new Phaser.Events.EventEmitter();

export const EVENT_STATS = 'stats';
export const EVENT_READY = 'ready';
export const EVENT_CAMPAIGN_STATE = 'campaign_state';
export const EVENT_ASSET_PROGRESS = 'asset_progress';
export const EVENT_LIFE_STATE = 'life_state';

export const EVENT_SIMULATION = 'simulation';

export const LEVEL_STARTED = 'LEVEL_STARTED';
export const DOOR_REVEALED = 'DOOR_REVEALED';
export const PREBOSS_DOOR_REVEALED = 'PREBOSS_DOOR_REVEALED';
export const LEVEL_CLEARED = 'LEVEL_CLEARED';
export const LEVEL_FAILED = 'LEVEL_FAILED';

export interface ReadyPayload {
  setZoom: (zoom: number) => void;
  resetZoom: () => void;
}

export interface AssetProgressPayload {
  progress: number;
  fileKey?: string;
}

export function emitStats(stats: PlayerStats): void {
  gameEvents.emit(EVENT_STATS, stats);
}

export function emitSimulationEvent(event: SimulationEvent): void {
  gameEvents.emit(EVENT_SIMULATION, event);
}

export function emitCampaignState(campaignState: CampaignState): void {
  gameEvents.emit(EVENT_CAMPAIGN_STATE, campaignState);
}

export type GameMode = 'solo' | 'multiplayer';

export interface LifeStatePayload {
  lives: number;
  maxLives: number;
  mode: GameMode;
  awaitingContinue: boolean;
  gameOver: boolean;
  eliminated: boolean;
}

export function emitLifeState(payload: LifeStatePayload): void {
  gameEvents.emit(EVENT_LIFE_STATE, payload);
}
