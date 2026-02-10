import { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import { GameScene } from '../game/GameScene';
import { GAME_CONFIG } from '../game/config';
import { EVENT_READY, EVENT_STATS, gameEvents, type ReadyPayload } from '../game/gameEvents';
import type { ControlsState, Direction, PlayerStats } from '../game/types';

const defaultStats: PlayerStats = {
  capacity: GAME_CONFIG.defaultBombCapacity,
  placed: 0,
  range: GAME_CONFIG.defaultRange,
  score: 0,
  remoteDetonateUnlocked: false,
};

const JOYSTICK_RADIUS = 56;
const JOYSTICK_KNOB_RADIUS = 22;
const JOYSTICK_DEADZONE = 10;

export default function GameView(): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const joystickPadRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<ControlsState>({
    up: false,
    down: false,
    left: false,
    right: false,
    placeBombRequested: false,
    detonateRequested: false,
  });

  const zoomApiRef = useRef<ReadyPayload | null>(null);
  const [stats, setStats] = useState<PlayerStats>(defaultStats);
  const [zoom, setZoom] = useState<number>(GAME_CONFIG.startZoom);
  const [isRemoteDetonateUnlocked, setIsRemoteDetonateUnlocked] = useState(false);
  const [joystickPressed, setJoystickPressed] = useState(false);
  const [joystickOffset, setJoystickOffset] = useState({ x: 0, y: 0 });

  const setMovementFromDirection = (direction: Direction | null): void => {
    controlsRef.current.up = direction === 'up';
    controlsRef.current.down = direction === 'down';
    controlsRef.current.left = direction === 'left';
    controlsRef.current.right = direction === 'right';
  };

  const clearMovement = (): void => {
    setMovementFromDirection(null);
  };

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('telegram-fullview');

    const webApp = (window as Window & { Telegram?: { WebApp?: { ready?: () => void; expand?: () => void } } }).Telegram?.WebApp;
    if (!webApp) return () => root.classList.remove('telegram-fullview');

    webApp.ready?.();
    webApp.expand?.();

    return () => {
      root.classList.remove('telegram-fullview');
    };
  }, []);

  useEffect(() => {
    const onStats = (nextStats: PlayerStats): void => {
      setStats({ ...nextStats });
      setIsRemoteDetonateUnlocked(nextStats.remoteDetonateUnlocked);
    };
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

  useEffect(
    () => () => {
      clearMovement();
    },
    [],
  );

  const setDirection = (direction: Direction, active: boolean): void => {
    if (active) {
      setMovementFromDirection(direction);
      return;
    }

    if (controlsRef.current[direction]) {
      clearMovement();
    }
  };

  const updateJoystickFromPointer = (clientX: number, clientY: number): void => {
    const pad = joystickPadRef.current;
    if (!pad) return;

    const rect = pad.getBoundingClientRect();
    const centerX = rect.left + (rect.width / 2);
    const centerY = rect.top + (rect.height / 2);
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const distance = Math.hypot(dx, dy);

    const clampedScale = distance > JOYSTICK_RADIUS ? JOYSTICK_RADIUS / distance : 1;
    const clampedX = dx * clampedScale;
    const clampedY = dy * clampedScale;
    setJoystickOffset({ x: clampedX, y: clampedY });

    if (distance < JOYSTICK_DEADZONE) {
      clearMovement();
      return;
    }

    let direction: Direction;
    if (Math.abs(dx) >= Math.abs(dy)) {
      direction = dx >= 0 ? 'right' : 'left';
    } else {
      direction = dy >= 0 ? 'down' : 'up';
    }

    setMovementFromDirection(direction);
  };

  const onJoystickPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const pad = joystickPadRef.current;
    if (!pad) return;

    pad.setPointerCapture(event.pointerId);
    setJoystickPressed(true);
    updateJoystickFromPointer(event.clientX, event.clientY);
  };

  const onJoystickPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!joystickPressed) return;
    updateJoystickFromPointer(event.clientX, event.clientY);
  };

  const releaseJoystick = (pointerId?: number): void => {
    const pad = joystickPadRef.current;
    if (pad && pointerId !== undefined && pad.hasPointerCapture(pointerId)) {
      pad.releasePointerCapture(pointerId);
    }
    setJoystickPressed(false);
    setJoystickOffset({ x: 0, y: 0 });
    clearMovement();
  };

  const onJoystickPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    releaseJoystick(event.pointerId);
  };

  const requestBomb = (): void => {
    controlsRef.current.placeBombRequested = true;
  };

  const requestDetonate = (): void => {
    if (!isRemoteDetonateUnlocked) return;
    controlsRef.current.detonateRequested = true;
  };

  const onZoomInput = (value: number): void => {
    const clamped = Math.max(GAME_CONFIG.minZoom, Math.min(GAME_CONFIG.maxZoom, value));
    setZoom(clamped);
    zoomApiRef.current?.setZoom(clamped);
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

      <section className="playfield-shell">
        <aside className="control-column control-column--left" aria-label="Movement controls">
          <div
            ref={joystickPadRef}
            className={`joystick-pad ${joystickPressed ? 'joystick-pad--active' : ''}`}
            onPointerDown={onJoystickPointerDown}
            onPointerMove={onJoystickPointerMove}
            onPointerUp={onJoystickPointerUp}
            onPointerCancel={onJoystickPointerUp}
            onPointerLeave={() => {
              if (!joystickPressed) return;
              releaseJoystick();
            }}
            role="application"
            aria-label="Virtual joystick"
          >
            <div
              className="joystick-knob"
              style={{
                transform: `translate(calc(-50% + ${joystickOffset.x}px), calc(-50% + ${joystickOffset.y}px))`,
                width: `${JOYSTICK_KNOB_RADIUS * 2}px`,
                height: `${JOYSTICK_KNOB_RADIUS * 2}px`,
              }}
            />
          </div>

          <div className="landscape-fallback-dpad" aria-hidden="true">
            {(['up', 'left', 'down', 'right'] as const).map((direction) => (
              <button
                key={direction}
                type="button"
                className={`dpad-btn dpad-${direction}`}
                onTouchStart={() => setDirection(direction, true)}
                onTouchEnd={() => setDirection(direction, false)}
                onMouseDown={() => setDirection(direction, true)}
                onMouseUp={() => setDirection(direction, false)}
                onMouseLeave={() => setDirection(direction, false)}
              >
                {direction === 'up' ? '↑' : direction === 'left' ? '←' : direction === 'down' ? '↓' : '→'}
              </button>
            ))}
          </div>
        </aside>

        <section className="game-shell">
          <div className="game-canvas" ref={mountRef} />
        </section>

        <aside className="control-column control-column--right" aria-label="Action controls">
          <div className="right-panel right-panel--zoom" aria-label="Zoom panel">
            <input
              id="zoom"
              type="range"
              className="zoom-slider"
              min={GAME_CONFIG.minZoom}
              max={GAME_CONFIG.maxZoom}
              step={0.05}
              value={zoom}
              onChange={(event) => onZoomInput(Number(event.target.value))}
            />
          </div>

          <div className="right-panel right-panel--actions" aria-label="Action buttons">
            <div className="boost-slot" aria-hidden="true">Boost</div>
            <button
              type="button"
              className="bomb-btn"
              onTouchStart={requestBomb}
              onMouseDown={requestBomb}
            >
              Bomb
            </button>
            <button
              type="button"
              className="detonate-btn"
              onTouchStart={requestDetonate}
              onMouseDown={requestDetonate}
              disabled={!isRemoteDetonateUnlocked}
            >
              Detonate
            </button>
            <div className="boost-slot" aria-hidden="true">Boost</div>
          </div>
        </aside>
      </section>
    </main>
  );
}
