import { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import { GameScene } from '../game/GameScene';
import { GAME_CONFIG } from '../game/config';

import {
  EVENT_CAMPAIGN_STATE,
  EVENT_READY,
  EVENT_SIMULATION,
  EVENT_STATS,
  gameEvents,
  type ReadyPayload,
} from '../game/gameEvents';

import {
  fetchCampaignFromBackend,
  getCampaignSyncStatus,
  loadCampaignState,
  resetCampaignState,
  saveCampaignState,
  type CampaignState,
} from '../game/campaign';

import type { ControlsState, Direction, PlayerStats, SimulationEvent } from '../game/types';
import {
  confirmPurchase,
  createPurchaseIntent,
  fetchCatalog,
  fetchLedger,
  fetchWallet,
  type ShopCatalogItem,
  type WalletLedgerEntry,
} from '../game/wallet';
import { WsDebugOverlay } from './WsDebugOverlay';
import { useWsClient } from '../ws/useWsClient';
import { resolveDevIdentity } from '../utils/devIdentity';


const defaultStats: PlayerStats = {
  capacity: GAME_CONFIG.defaultBombCapacity,
  placed: 0,
  range: GAME_CONFIG.defaultRange,
  score: 0,
  remoteDetonateUnlocked: false,
};


type PredictionStats = {
  correctionCount: number;
  softCorrectionCount: number;
  droppedInputCount: number;
  pendingCount: number;
  lastAckSeq: number;
  drift: number;
  biasX: number;
  biasY: number;
};

type TickDebugStats = {
  snapshotTick: number;
  simulationTick: number;
};

const JOYSTICK_RADIUS = 56;
const JOYSTICK_KNOB_RADIUS = 22;
const JOYSTICK_DEADZONE = 10;

export default function GameView(): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<GameScene | null>(null);
  const inputSeqRef = useRef(0);
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
  const [campaign, setCampaign] = useState<CampaignState>(() => loadCampaignState());
  const [zoom, setZoom] = useState<number>(GAME_CONFIG.startZoom);
  const [isRemoteDetonateUnlocked, setIsRemoteDetonateUnlocked] = useState(false);
  const [joystickPressed, setJoystickPressed] = useState(false);
  const [joystickOffset, setJoystickOffset] = useState({ x: 0, y: 0 });
  const [profileName, setProfileName] = useState<string>('—');
  const [token, setToken] = useState<string>(() => localStorage.getItem('rift_session_token') ?? '');
  const [devIdentity] = useState(() => resolveDevIdentity(window.location.search));
  const [localTgUserId, setLocalTgUserId] = useState<string | undefined>(devIdentity.localFallbackTgUserId);
  const [wallet, setWallet] = useState<{ stars: number; crystals: number }>({ stars: 0, crystals: 0 });
  const [syncStatus, setSyncStatus] = useState<'synced' | 'offline'>('offline');
  const [catalog, setCatalog] = useState<ShopCatalogItem[]>([]);
  const [ledger, setLedger] = useState<WalletLedgerEntry[]>([]);
  const [purchaseBusySku, setPurchaseBusySku] = useState<string | null>(null);
  const [predictionStats, setPredictionStats] = useState<PredictionStats | null>(null);
  const [tickDebugStats, setTickDebugStats] = useState<TickDebugStats | null>(null);
  const ws = useWsClient(token || undefined);


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
    const runAuth = async () => {
      try {
        const tgInitData = (window as any)?.Telegram?.WebApp?.initData ?? '';
        const authRes = await fetch('/api/auth/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: tgInitData }),
        });

        const authJson = await authRes.json();
        if (!authJson?.ok) return;

        const token = String(authJson.token ?? '');
        if (!token) return;

        localStorage.setItem('rift_session_token', token);
        setToken(token);
        const nextLocalTgUserId = String(authJson.user?.tgUserId ?? '');
        if (nextLocalTgUserId) {
          setLocalTgUserId(nextLocalTgUserId);
          sceneRef.current?.setLocalTgUserId(nextLocalTgUserId);
        }

        // M5d: backend is source of truth for campaign progress
        try {
          const remote = await fetchCampaignFromBackend();

          if (remote?.ok) {
            if (remote.hasProgress) {
              // backend wins → overwrite local cache
              saveCampaignState(remote.campaignState);
            } else {
              // backend empty → seed it from local cache once
              const local = loadCampaignState();
              saveCampaignState(local); // this will POST best-effort now that token exists
            }
          }
        } catch {
          // ignore
        }

        const meRes = await fetch('/api/profile/me', {
          headers: { Authorization: `Bearer ${token}` },
        });

        const meJson = await meRes.json();
        if (meJson?.ok) {
          const backendName = String(meJson.user?.displayName ?? '—');
          setProfileName(devIdentity.displayNameOverride ?? backendName);
        }

        const [w, nextCatalog, nextLedger] = await Promise.all([
          fetchWallet(),
          fetchCatalog(),
          fetchLedger(20),
        ]);
        if (w) setWallet(w);
        setCatalog(nextCatalog);
        setLedger(nextLedger);
      } catch {
        // keep silent (dev may run without backend)
      }

      setProfileName((prev) => {
        if (devIdentity.displayNameOverride) return devIdentity.displayNameOverride;
        return prev === '—' ? 'Dev Player' : prev;
      });
    };

    // TODO backend: in production handle auth errors + refresh/retry strategy
    runAuth();
  }, [devIdentity.displayNameOverride]);


  useEffect(() => {
    const id = window.setInterval(() => {
      setSyncStatus(getCampaignSyncStatus());
    }, 1000);

    return () => window.clearInterval(id);
  }, []);


  useEffect(() => {
    const id = window.setInterval(() => {
      const scene = sceneRef.current;
      const nextStats = scene?.getPredictionStats?.() ?? null;
      setPredictionStats(nextStats);
      setTickDebugStats(
        scene
          ? {
              snapshotTick: scene.getLastSnapshotTick(),
              simulationTick: scene.getSimulationTick(),
            }
          : null,
      );
    }, 350);

    return () => window.clearInterval(id);
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
    const onCampaignState = (nextCampaign: CampaignState): void => {
      setCampaign({ ...nextCampaign });
    };
    const onSimulation = async (event: SimulationEvent): Promise<void> => {
      if (event.type !== 'BOSS_DEFEATED') return;

      // MVP: wallet rewards are not client-granted in mainline to avoid security holes.
      // TODO economy: apply boss rewards via server-authoritative ledger/events.
      const refreshed = await fetchWallet();
      if (refreshed) setWallet(refreshed);
    };


    gameEvents.on(EVENT_STATS, onStats);
    gameEvents.on(EVENT_READY, onReady);
    gameEvents.on(EVENT_CAMPAIGN_STATE, onCampaignState);
    gameEvents.on(EVENT_SIMULATION, onSimulation);

    return () => {
      gameEvents.off(EVENT_STATS, onStats);
      gameEvents.off(EVENT_READY, onReady);
      gameEvents.off(EVENT_CAMPAIGN_STATE, onCampaignState);
      gameEvents.off(EVENT_SIMULATION, onSimulation);
    };
  }, [zoom]);

  useEffect(() => {
    if (!mountRef.current) return;

    const width = GAME_CONFIG.gridWidth * GAME_CONFIG.tileSize;
    const height = GAME_CONFIG.gridHeight * GAME_CONFIG.tileSize;

    const scene = new GameScene(controlsRef.current);
    sceneRef.current = scene;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: mountRef.current,
      width,
      height,
      transparent: true,
      scene: [scene],
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
      sceneRef.current = null;
    };
  }, []);


  useEffect(() => {
    sceneRef.current?.setLocalTgUserId(localTgUserId);
  }, [localTgUserId]);

  useEffect(() => {
    const last = [...ws.messages].reverse().find((m) => m.type === 'match:snapshot') as any;
    if (!last?.snapshot) return;
    sceneRef.current?.applyMatchSnapshot(last.snapshot, localTgUserId);
  }, [ws.messages, localTgUserId]);

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

  const onBuy = async (sku: string): Promise<void> => {
    if (purchaseBusySku) return;

    setPurchaseBusySku(sku);
    try {
      const intent = await createPurchaseIntent(sku);
      if (!intent) return;

      const confirmed = await confirmPurchase(intent.intentId);
      if (!confirmed) return;

      setWallet(confirmed.wallet);
      const nextLedger = await fetchLedger(20);
      setLedger(nextLedger);
    } finally {
      setPurchaseBusySku(null);
    }
  };

  return (
    <main className="page">
      <section className="hud">
        <h1>Rift Runners MVP</h1>
        <div className="stats-row">
          <span>Player: {profileName}</span>
          <span>Stage: {campaign.stage}</span>
          <span>Zone: {campaign.zone}</span>
          <span>Bombs: {stats.placed}/{stats.capacity}</span>
          <span>Range: {stats.range}</span>
          <span>Score: {stats.score}</span>
          <span>Stars: {wallet.stars}</span>
          <span>Crystals: {wallet.crystals}</span>
          <span>Ledger: {ledger.length}</span>
          <span style={{ opacity: 0.7 }}>{syncStatus === 'synced' ? 'Synced' : 'Offline'}</span>
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
              onClick={() => {
                if (confirm('Reset campaign progress?')) {
                  const state = resetCampaignState();
                  // TODO: notify GameScene about new campaign state if needed
                  setCampaign(state);
                }
              }}
            >
              Reset
            </button>
            <div className="shop-panel">
              {catalog.map((item) => (
                <button
                  key={item.sku}
                  type="button"
                  className="shop-buy-btn"
                  disabled={!item.available || purchaseBusySku !== null}
                  onClick={() => {
                    void onBuy(item.sku);
                  }}
                >
                  Buy {item.title} ({item.priceStars}⭐)
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

      <WsDebugOverlay
        connected={ws.connected}
        messages={ws.messages}
        identity={{
          id: localTgUserId,
          clientId: devIdentity.clientId,
          displayName: profileName,
        }}
        netSim={ws.netSimConfig}
        predictionStats={predictionStats}
        tickDebugStats={tickDebugStats}
        onLobby={() => ws.send({ type: 'lobby:list' })}
        onCreateRoom={() => ws.send({ type: 'room:create' })}
        onStartMatch={() => ws.send({ type: 'match:start' })}
        onMove={(dir) => {
          const scene = sceneRef.current;
          if (!scene) return;

          const seq = inputSeqRef.current + 1;
          inputSeqRef.current = seq;

          const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
          const dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;

          scene.onLocalMatchInput({ seq, dx, dy });
          ws.send({ type: 'match:input', seq, payload: { kind: 'move', dir } });
        }}
      />
    </main>
  );
}
