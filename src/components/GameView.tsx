import { useEffect, useMemo, useRef, useState } from 'react';
import Phaser from 'phaser';
import { GameScene } from '../game/GameScene';
import { GAME_CONFIG } from '../game/config';
import { EVENT_READY, EVENT_STATS, gameEvents, type ReadyPayload } from '../game/gameEvents';
import type { ControlsState, PlayerStats } from '../game/types';

const defaultStats: PlayerStats = {
  capacity: GAME_CONFIG.defaultBombCapacity,
  placed: 0,
  range: GAME_CONFIG.defaultRange,
  score: 0,
};

export default function GameView(): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const controlsRef = useRef<ControlsState>({
    up: false,
    down: false,
    left: false,
    right: false,
    placeBombRequested: false,
  });

  const zoomApiRef = useRef<ReadyPayload | null>(null);
  const [stats, setStats] = useState<PlayerStats>(defaultStats);
  const [zoom, setZoom] = useState<number>(GAME_CONFIG.startZoom);

  useEffect(() => {
    const onStats = (nextStats: PlayerStats): void => setStats({ ...nextStats });
    const onReady = (payload: ReadyPayload): void => {
      zoomApiRef.current = payload;
      payload.setZoom(zoom);
    };

    gameEvents.on(EVENT_STATS, onStats);
    gameEvents.on(EVENT_READY, onReady);

    return () => {
      gameEvents.off(EVENT_STATS, onStats);
      gameEvents.off(EVENT_READY, onReady);
    };
  }, [zoom]);

  useEffect(() => {
    if (!mountRef.current) return;

    const width = GAME_CONFIG.gridWidth * GAME_CONFIG.tileSize;
    const height = GAME_CONFIG.gridHeight * GAME_CONFIG.tileSize;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: mountRef.current,
      width,
      height,
      transparent: true,
      scene: [new GameScene(controlsRef.current)],
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    });

    gameRef.current = game;

    return () => {
      zoomApiRef.current = null;
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  const controls = useMemo(
    () => [
      { key: 'up', label: '↑' },
      { key: 'left', label: '←' },
      { key: 'down', label: '↓' },
      { key: 'right', label: '→' },
    ] as const,
    [],
  );

  const setDirection = (direction: 'up' | 'down' | 'left' | 'right', active: boolean): void => {
    controlsRef.current[direction] = active;
  };

  const requestBomb = (): void => {
    controlsRef.current.placeBombRequested = true;
  };

  const onZoomInput = (value: number): void => {
    const clamped = Math.max(GAME_CONFIG.minZoom, Math.min(GAME_CONFIG.maxZoom, value));
    setZoom(clamped);
    zoomApiRef.current?.setZoom(clamped);
  };

  const resetZoom = (): void => {
    setZoom(GAME_CONFIG.startZoom);
    zoomApiRef.current?.resetZoom();
  };

  return (
    <main className="page">
      <section className="hud">
        <h1>Rift Runners MVP</h1>
        <div className="stats-row">
          <span>Bombs: {stats.placed}/{stats.capacity}</span>
          <span>Range: {stats.range}</span>
          <span>Score: {stats.score}</span>
        </div>
      </section>

      <section className="game-shell">
        <div className="game-canvas" ref={mountRef} />

        <aside className="zoom-panel">
          <label htmlFor="zoom">Zoom</label>
          <input
            id="zoom"
            type="range"
            orient="vertical"
            min={GAME_CONFIG.minZoom}
            max={GAME_CONFIG.maxZoom}
            step={0.05}
            value={zoom}
            onChange={(event) => onZoomInput(Number(event.target.value))}
          />
          <button type="button" onClick={resetZoom}>Reset</button>
        </aside>
      </section>

      <section className="controls">
        <div className="dpad">
          {controls.map((control) => (
            <button
              key={control.key}
              type="button"
              className={`dpad-btn dpad-${control.key}`}
              onTouchStart={() => setDirection(control.key, true)}
              onTouchEnd={() => setDirection(control.key, false)}
              onMouseDown={() => setDirection(control.key, true)}
              onMouseUp={() => setDirection(control.key, false)}
              onMouseLeave={() => setDirection(control.key, false)}
            >
              {control.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="bomb-btn"
          onTouchStart={requestBomb}
          onMouseDown={requestBomb}
        >
          Bomb
        </button>
      </section>
    </main>
  );
}
