import { useEffect, useRef, useState, useCallback } from 'react';
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
  buyShopSku,
  closeRoom,
  createRoom,
  fetchFriends,
  fetchLeaderboard,
  fetchMyRooms,
  fetchRoom,
  fetchShopCatalog,
  fetchShopOwned,
  fetchLedger,
  fetchWallet,
  joinRoom,
  leaveRoom,
  requestFriend,
  respondFriend,
  type FriendEntry,
  type IncomingFriendRequest,
  type LeaderboardMeEntry,
  type LeaderboardMode,
  type LeaderboardTopEntry,
  type MyRoomEntry,
  type OutgoingFriendRequest,
  type RoomMember,
  type RoomState,
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

type AudioSettings = {
  musicEnabled: boolean;
  sfxEnabled: boolean;
};

type AccountInfo = {
  id: string;
  displayName: string;
  referralLink: string;
  nameChangeRemaining: number;
};

type MultiplayerTab = 'rooms' | 'friends';

type TickDebugStats = {
  snapshotTick: number;
  simulationTick: number;
  renderTick: number;
  baseDelayTicks: number;
  baseDelayTargetTicks: number;
  baseDelayStepCooldownMs: number;
  baseDelayStepCooldownTicks: number;
  delayTicks: number;
  minDelayTicks: number;
  maxDelayTicks: number;
  bufferSize: number;
  underrunRate: number;
  underrunCount: number;
  lateSnapshotCount: number;
  lateSnapshotEma: number;
  stallCount: number;
  extrapCount: number;
  extrapolatingTicks: number;
  stalled: boolean;
  rttMs: number | null;
  rttJitterMs: number;
  targetBufferPairs: number;
  targetBufferTargetPairs: number;
  adaptiveEveryTicks: number;
  adaptiveEveryTargetTicks: number;
  bufferHasReserve: boolean;
  tuning: {
    baseDelayMax: number;
    targetBufferMin: number;
    targetBufferMax: number;
    cadenceMin: number;
    cadenceMax: number;
  };
};

function mapRoomError(error?: string): string {
  if (error === 'room_full') return 'Room is full';
  if (error === 'room_closed') return 'Room is closed';
  if (error === 'room_not_found') return 'Room not found';
  if (error === 'forbidden') return 'Only owner can close this room';
  if (error) return error;
  return 'Request failed';
}

const JOYSTICK_RADIUS = 56;
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
  const [storeItems, setStoreItems] = useState<ShopCatalogItem[]>([]);
  const [ledger, setLedger] = useState<WalletLedgerEntry[]>([]);
  const [purchaseBusySku, setPurchaseBusySku] = useState<string | null>(null);
  const [isStoreOpen, setIsStoreOpen] = useState(false);
  const [storeTab, setStoreTab] = useState<'boosts' | 'cosmetics' | 'packs'>('boosts');
  const [ownedSkus, setOwnedSkus] = useState<string[]>([]);
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [predictionStats, setPredictionStats] = useState<PredictionStats | null>(null);
  const [tickDebugStats, setTickDebugStats] = useState<TickDebugStats | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'audio' | 'account'>('audio');
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [leaderboardMode, setLeaderboardMode] = useState<LeaderboardMode>('solo');
  const [leaderboardTop, setLeaderboardTop] = useState<LeaderboardTopEntry[]>([]);
  const [leaderboardMe, setLeaderboardMe] = useState<LeaderboardMeEntry | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [multiplayerOpen, setMultiplayerOpen] = useState(false);
  const [multiplayerTab, setMultiplayerTab] = useState<MultiplayerTab>('rooms');
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [joinCodeDraft, setJoinCodeDraft] = useState('');
  const [myRooms, setMyRooms] = useState<MyRoomEntry[]>([]);
  const [currentRoom, setCurrentRoom] = useState<RoomState | null>(null);
  const [currentRoomMembers, setCurrentRoomMembers] = useState<RoomMember[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [friendTargetDraft, setFriendTargetDraft] = useState('');
  const [friendsList, setFriendsList] = useState<FriendEntry[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<IncomingFriendRequest[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<OutgoingFriendRequest[]>([]);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>({ musicEnabled: true, sfxEnabled: true });
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const ws = useWsClient(token || undefined);

  const baseWidth = GAME_CONFIG.gridWidth * GAME_CONFIG.tileSize;
  const baseHeight = GAME_CONFIG.gridHeight * GAME_CONFIG.tileSize;
  const arenaAspectRatio = `${baseWidth} / ${baseHeight}`;


  const setMovementFromDirection = (direction: Direction | null): void => {
    controlsRef.current.up = direction === 'up';
    controlsRef.current.down = direction === 'down';
    controlsRef.current.left = direction === 'left';
    controlsRef.current.right = direction === 'right';
  };

  const clearMovement = (): void => {
    setMovementFromDirection(null);
  };

  const applyAudioSettings = useCallback((next: AudioSettings): void => {
    sceneRef.current?.setAudioSettings(next);
  }, []);

  const loadSettingsAndAccount = useCallback(async (authToken: string): Promise<void> => {
    const headers = { Authorization: `Bearer ${authToken}` };

    const [settingsRes, accountRes] = await Promise.all([
      fetch('/api/settings/me', { headers }),
      fetch('/api/profile/account', { headers }),
    ]);

    if (settingsRes.ok) {
      const settingsJson = await settingsRes.json();
      if (settingsJson?.ok && settingsJson.settings) {
        const next = {
          musicEnabled: Boolean(settingsJson.settings.musicEnabled),
          sfxEnabled: Boolean(settingsJson.settings.sfxEnabled),
        };
        setAudioSettings(next);
        applyAudioSettings(next);
      }
    }

    if (accountRes.ok) {
      const accountJson = await accountRes.json();
      if (accountJson?.ok && accountJson.account) {
        const account: AccountInfo = {
          id: String(accountJson.account.id ?? ''),
          displayName: String(accountJson.account.displayName ?? ''),
          referralLink: String(accountJson.account.referralLink ?? ''),
          nameChangeRemaining: Number(accountJson.account.nameChangeRemaining ?? 3),
        };
        setAccountInfo(account);
        setDisplayNameDraft(account.displayName);
      }
    }
  }, [applyAudioSettings]);

  const persistAudioSettings = useCallback(async (next: AudioSettings): Promise<void> => {
    setAudioSettings(next);
    applyAudioSettings(next);

    if (!token) return;

    await fetch('/api/settings/me', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(next),
    });
  }, [applyAudioSettings, token]);

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

        await loadSettingsAndAccount(token);

        const [w, nextLedger] = await Promise.all([
          fetchWallet(),
          fetchLedger(20),
        ]);
        if (w) setWallet(w);
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
  }, [devIdentity.displayNameOverride, loadSettingsAndAccount]);


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
      setTickDebugStats(() => {
        if (!scene) return null;
        const netInterpStats = scene.getNetInterpStats();
        return {
          snapshotTick: scene.getLastSnapshotTick(),
          simulationTick: scene.getSimulationTick(),
          renderTick: netInterpStats.renderTick,
          baseDelayTicks: netInterpStats.baseDelayTicks,
          baseDelayTargetTicks: netInterpStats.baseDelayTargetTicks,
          baseDelayStepCooldownMs: netInterpStats.baseDelayStepCooldownMs,
          baseDelayStepCooldownTicks: netInterpStats.baseDelayStepCooldownTicks,
          delayTicks: netInterpStats.delayTicks,
          minDelayTicks: netInterpStats.minDelayTicks,
          maxDelayTicks: netInterpStats.maxDelayTicks,
          bufferSize: netInterpStats.bufferSize,
          underrunRate: netInterpStats.underrunRate,
          underrunCount: netInterpStats.underrunCount,
          lateSnapshotCount: netInterpStats.lateSnapshotCount,
          lateSnapshotEma: netInterpStats.lateSnapshotEma,
          stallCount: netInterpStats.stallCount,
          extrapCount: netInterpStats.extrapCount,
          extrapolatingTicks: netInterpStats.extrapolatingTicks,
          stalled: netInterpStats.stalled,
          rttMs: netInterpStats.rttMs,
          rttJitterMs: netInterpStats.rttJitterMs,
          targetBufferPairs: netInterpStats.targetBufferPairs,
          targetBufferTargetPairs: netInterpStats.targetBufferTargetPairs,
          adaptiveEveryTicks: netInterpStats.adaptiveEveryTicks,
          adaptiveEveryTargetTicks: netInterpStats.adaptiveEveryTargetTicks,
          bufferHasReserve: netInterpStats.bufferHasReserve,
          tuning: netInterpStats.tuning,
        };
      });
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

    const scene = new GameScene(controlsRef.current);
    sceneRef.current = scene;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: mountRef.current,
      width: baseWidth,
      height: baseHeight,
      transparent: true,
      scene: [scene],
      scale: {
        // Key change: canvas resizes to the container (rectangular)
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.NO_CENTER,
      },
    });

    gameRef.current = game;
    scene.setAudioSettings(audioSettings);

    return () => {
      zoomApiRef.current = null;
      game.destroy(true);
      gameRef.current = null;
      sceneRef.current = null;
    };
  }, []);


  useEffect(() => {
    applyAudioSettings(audioSettings);
  }, [applyAudioSettings, audioSettings]);

  useEffect(() => {
    sceneRef.current?.setLocalTgUserId(localTgUserId);
  }, [localTgUserId]);

  useEffect(() => {
    const last = [...ws.messages].reverse().find((m) => m.type === 'match:snapshot') as any;
    if (!last?.snapshot) return;
    sceneRef.current?.applyMatchSnapshot(last.snapshot, localTgUserId);
  }, [ws.messages, localTgUserId]);

  useEffect(() => {
    sceneRef.current?.setNetRtt(ws.rttMs ?? null, ws.rttJitterMs ?? 0);
  }, [ws.rttMs, ws.rttJitterMs]);

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

  const loadStore = useCallback(async (): Promise<void> => {
    setStoreLoading(true);
    setStoreError(null);
    try {
      const [items, owned] = await Promise.all([fetchShopCatalog(), fetchShopOwned()]);
      setStoreItems(items);
      setOwnedSkus(owned);
    } catch {
      setStoreError('Failed to load store');
    } finally {
      setStoreLoading(false);
    }
  }, []);

  const loadLeaderboard = useCallback(async (mode: LeaderboardMode): Promise<void> => {
    setLeaderboardLoading(true);
    setLeaderboardError(null);
    try {
      const response = await fetchLeaderboard(mode);
      if (!response) {
        setLeaderboardError('Failed to load leaderboard');
        setLeaderboardTop([]);
        setLeaderboardMe(null);
        return;
      }
      setLeaderboardTop(response.top);
      setLeaderboardMe(response.me);
    } catch {
      setLeaderboardError('Failed to load leaderboard');
      setLeaderboardTop([]);
      setLeaderboardMe(null);
    } finally {
      setLeaderboardLoading(false);
    }
  }, []);

  const loadRooms = useCallback(async (): Promise<void> => {
    setRoomsLoading(true);
    setRoomsError(null);
    try {
      const rooms = await fetchMyRooms();
      setMyRooms(rooms);

      if (currentRoom?.roomCode) {
        const roomData = await fetchRoom(currentRoom.roomCode);
        if (!roomData || roomData.error === 'room_not_found') {
          setCurrentRoom(null);
          setCurrentRoomMembers([]);
          return;
        }

        if (roomData.error) {
          setRoomsError(mapRoomError(roomData.error));
          return;
        }

        setCurrentRoom(roomData.room);
        setCurrentRoomMembers(roomData.members);
      }
    } catch {
      setRoomsError('Failed to load rooms');
    } finally {
      setRoomsLoading(false);
    }
  }, [currentRoom?.roomCode]);

  const joinRoomByCode = useCallback(async (roomCodeRaw: string): Promise<void> => {
    const roomCode = roomCodeRaw.trim().toUpperCase();
    if (!roomCode) return;

    setRoomsError(null);
    const result = await joinRoom(roomCode);
    if (!result) {
      setRoomsError('Join failed');
      return;
    }

    if (result.error) {
      setRoomsError(mapRoomError(result.error));
      return;
    }

    setCurrentRoom(result.room);
    setCurrentRoomMembers(result.members);
    setJoinCodeDraft(roomCode);

    const rooms = await fetchMyRooms();
    setMyRooms(rooms);
  }, []);

  const onCreateRoom = useCallback(async (capacity: 2 | 3 | 4): Promise<void> => {
    setRoomsError(null);
    const created = await createRoom(capacity);
    if (!created) {
      setRoomsError('Failed to create room');
      return;
    }

    await joinRoomByCode(created.roomCode);
  }, [joinRoomByCode]);

  const onLeaveRoom = useCallback(async (): Promise<void> => {
    if (!currentRoom) return;

    setRoomsError(null);
    const result = await leaveRoom();
    if (!result) {
      setRoomsError('Leave failed');
      return;
    }

    if (!result.ok) {
      setRoomsError(mapRoomError(result.error));
      return;
    }

    setCurrentRoom(null);
    setCurrentRoomMembers([]);
    const rooms = await fetchMyRooms();
    setMyRooms(rooms);
  }, [currentRoom]);

  const onCloseRoom = useCallback(async (): Promise<void> => {
    if (!currentRoom?.roomCode) return;

    setRoomsError(null);
    const result = await closeRoom(currentRoom.roomCode);
    if (!result) {
      setRoomsError('Close failed');
      return;
    }

    if (!result.ok) {
      setRoomsError(mapRoomError(result.error));
      return;
    }

    setCurrentRoom(null);
    setCurrentRoomMembers([]);
    const rooms = await fetchMyRooms();
    setMyRooms(rooms);
  }, [currentRoom?.roomCode]);

  const onCopyInviteLink = useCallback(async (): Promise<void> => {
    if (!currentRoom?.roomCode) return;

    const inviteUrl = `${window.location.origin}${window.location.pathname}?startapp=room_${currentRoom.roomCode}`;
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      setRoomsError('Failed to copy invite link');
    }
  }, [currentRoom?.roomCode]);

  const loadFriends = useCallback(async (): Promise<void> => {
    setFriendsLoading(true);
    setFriendsError(null);
    try {
      const payload = await fetchFriends();
      if (!payload) {
        setFriendsError('Failed to load friends');
        setFriendsList([]);
        setIncomingRequests([]);
        setOutgoingRequests([]);
        return;
      }

      setFriendsList(payload.friends);
      setIncomingRequests(payload.incoming);
      setOutgoingRequests(payload.outgoing);
    } catch {
      setFriendsError('Failed to load friends');
      setFriendsList([]);
      setIncomingRequests([]);
      setOutgoingRequests([]);
    } finally {
      setFriendsLoading(false);
    }
  }, []);

  const onSendFriendRequest = useCallback(async (): Promise<void> => {
    const toTgUserId = friendTargetDraft.trim();
    if (!toTgUserId) return;

    setFriendsError(null);
    const result = await requestFriend(toTgUserId);
    if (!result) {
      setFriendsError('Request failed');
      return;
    }
    if (!result.ok) {
      setFriendsError(result.error ?? 'Request failed');
      return;
    }

    setFriendTargetDraft('');
    await loadFriends();
  }, [friendTargetDraft, loadFriends]);

  const onRespondFriendRequest = useCallback(async (fromTgUserId: string, action: 'accept' | 'decline'): Promise<void> => {
    setFriendsError(null);
    const result = await respondFriend(fromTgUserId, action);
    if (!result) {
      setFriendsError('Action failed');
      return;
    }
    if (!result.ok) {
      setFriendsError(result.error ?? 'Action failed');
      return;
    }

    await loadFriends();
  }, [loadFriends]);

  const onInviteFriend = useCallback(async (): Promise<void> => {
    let roomCode = currentRoom?.roomCode;
    if (!roomCode) {
      const created = await createRoom(2);
      if (!created) {
        setFriendsError('Failed to create room for invite');
        return;
      }
      roomCode = created.roomCode;
      await joinRoomByCode(roomCode);
    }

    if (!roomCode) {
      setFriendsError('No room to invite');
      return;
    }

    const inviteUrl = `${window.location.origin}${window.location.pathname}?startapp=room_${roomCode}`;
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      setFriendsError('Failed to copy invite link');
    }
  }, [currentRoom?.roomCode, joinRoomByCode]);


  useEffect(() => {
    if (!isStoreOpen) return;
    void loadStore();
  }, [isStoreOpen, loadStore]);

  useEffect(() => {
    if (!leaderboardOpen) return;
    void loadLeaderboard(leaderboardMode);
  }, [leaderboardMode, leaderboardOpen, loadLeaderboard]);

  useEffect(() => {
    if (!multiplayerOpen) return;
    if (multiplayerTab === 'rooms') {
      void loadRooms();
      return;
    }
    void loadFriends();
  }, [loadFriends, loadRooms, multiplayerOpen, multiplayerTab]);

  useEffect(() => {
    if (!multiplayerOpen) return;
    if (multiplayerTab !== 'rooms') return;
    if (!currentRoom?.roomCode) return;

    const id = window.setInterval(() => {
      void loadRooms();
    }, 2500);

    return () => {
      window.clearInterval(id);
    };
  }, [currentRoom?.roomCode, loadRooms, multiplayerOpen, multiplayerTab]);

  useEffect(() => {
    if (!token) return;

    const search = new URLSearchParams(window.location.search);
    const startappRaw = search.get('startapp') ?? '';
    if (!startappRaw.startsWith('room_')) return;

    const deepLinkRoomCode = startappRaw.slice(5).trim().toUpperCase();
    if (!deepLinkRoomCode) return;

    setMultiplayerOpen(true);
    setMultiplayerTab('rooms');
    setJoinCodeDraft(deepLinkRoomCode);
    void joinRoomByCode(deepLinkRoomCode);
  }, [joinRoomByCode, token]);

  const onBuy = async (sku: string): Promise<void> => {
    if (purchaseBusySku) return;

    setPurchaseBusySku(sku);
    try {
      const result = await buyShopSku(sku);
      if (!result) return;

      setWallet(result.wallet);
      setOwnedSkus(result.ownedSkus);
      const nextLedger = await fetchLedger(20);
      setLedger(nextLedger);
    } finally {
      setPurchaseBusySku(null);
    }
  };

  const onCopyReferral = async (): Promise<void> => {
    if (!accountInfo?.referralLink) return;
    try {
      await navigator.clipboard.writeText(accountInfo.referralLink);
    } catch {
      // no-op
    }
  };

  const onSubmitDisplayName = async (): Promise<void> => {
    if (!token) return;
    const trimmed = displayNameDraft.trim();
    if (!trimmed) return;

    const response = await fetch('/api/profile/name', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: trimmed }),
    });

    const json = await response.json().catch(() => null);
    if (response.ok && json?.ok) {
      setProfileName(trimmed);
      setAccountInfo((prev) => (prev ? { ...prev, displayName: trimmed, nameChangeRemaining: Number(json.remaining ?? prev.nameChangeRemaining) } : prev));
      return;
    }

    if (response.status === 429) {
      setAccountInfo((prev) => (prev ? { ...prev, nameChangeRemaining: 0 } : prev));
    }
  };

  return (
    <main className="page">
      <section className="hud">
        <div className="stats-row">
          <span className="hud-metric hud-metric--primary">Player: {profileName}</span>
          <span className="hud-metric">Stage: {campaign.stage}</span>
          <span className="hud-metric">Zone: {campaign.zone}</span>
          <span className="hud-metric">Bombs: {stats.placed}/{stats.capacity}</span>
          <span className="hud-metric">Range: {stats.range}</span>
          <span className="hud-metric">Score: {stats.score}</span>
          <span className="hud-metric">Stars: {wallet.stars}</span>
          <span className="hud-metric hud-metric--secondary">Crystals: {wallet.crystals}</span>
          <span className="hud-metric hud-metric--secondary">Ledger: {ledger.length}</span>
          <span className="hud-metric hud-metric--secondary" style={{ opacity: 0.7 }}>
            {syncStatus === 'synced' ? 'Synced' : 'Offline'}
          </span>
        </div>
      </section>

      <section className="playfield-shell">
        <aside className="control-column control-column--left" aria-label="Movement controls">
          <div className="left-nav" aria-label="Navigation quick controls">
            <div className="nav-grid">
              <button type="button" className="nav-btn" aria-label="Map placeholder">🗺️</button>
              <button type="button" className="nav-btn" aria-label="Leaderboard" onClick={() => setLeaderboardOpen(true)}>🏆</button>
              <button type="button" className="nav-btn" aria-label="Multiplayer" onClick={() => setMultiplayerOpen(true)}>👥</button>
              <button type="button" className="nav-btn" aria-label="Store" onClick={() => setIsStoreOpen(true)}>🛍️</button>
              <button type="button" className="nav-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}>⚙️</button>
            </div>
          </div>

          <div className="left-joystick">
            <div className="joystick-wrap">
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
            </div>
          </div>
        </aside>

        <section
          className="game-shell"
          // Keep world aspect ratio on the host element to avoid tall RESIZE viewport "empty bottom".
          style={{ ['--arena-ar' as string]: arenaAspectRatio }}
        >
          <div className="game-canvas" ref={mountRef} />
        </section>

        <aside className="control-column control-column--right" aria-label="Action controls">
          <div className="right-stack">
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
          </div>
        </aside>
      </section>


      {leaderboardOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Leaderboard">
          <div className="settings-modal">
            <div className="settings-header">
              <strong>Leaderboard</strong>
              <button type="button" onClick={() => setLeaderboardOpen(false)}>Close</button>
            </div>
            <div className="settings-tabs">
              {(['solo', 'duo', 'trio', 'squad'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={leaderboardMode === mode ? 'active' : ''}
                  onClick={() => setLeaderboardMode(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
            <div className="settings-panel">
              {leaderboardLoading ? (
                <div>Loading leaderboard...</div>
              ) : leaderboardError ? (
                <div>{leaderboardError}</div>
              ) : leaderboardTop.length === 0 ? (
                <div>No scores yet for this mode.</div>
              ) : (
                leaderboardTop.map((entry) => (
                  <div key={`${entry.rank}-${entry.tgUserId}`} className="settings-kv">
                    <span>#{entry.rank} {entry.displayName}</span>
                    <strong>{entry.score}</strong>
                  </div>
                ))
              )}

              <hr />
              <div className="settings-kv"><span>You</span><strong /></div>
              {leaderboardMe ? (
                <div className="settings-kv">
                  <span>Rank: {leaderboardMe.rank ?? '—'}</span>
                  <strong>Score: {leaderboardMe.score}</strong>
                </div>
              ) : (
                <div>No personal record yet.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {isStoreOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Store">
          <div className="settings-modal">
            <div className="settings-header">
              <strong>Store</strong>
              <button type="button" onClick={() => setIsStoreOpen(false)}>Close</button>
            </div>
            <div className="settings-tabs">
              <button type="button" className={storeTab === 'boosts' ? 'active' : ''} onClick={() => setStoreTab('boosts')}>Boosts</button>
              <button type="button" className={storeTab === 'cosmetics' ? 'active' : ''} onClick={() => setStoreTab('cosmetics')}>Cosmetics</button>
              <button type="button" className={storeTab === 'packs' ? 'active' : ''} onClick={() => setStoreTab('packs')}>Packs</button>
            </div>
            <div className="settings-panel">
              {storeLoading ? (
                <div>Loading store...</div>
              ) : storeError ? (
                <div>{storeError}</div>
              ) : storeItems.filter((item) => item.category === storeTab).length === 0 ? (
                <div>No items in this category yet.</div>
              ) : (
                storeItems
                  .filter((item) => item.category === storeTab)
                  .map((item) => {
                    const isOwned = ownedSkus.includes(item.sku);
                    const isPurchasable = item.purchaseEnabled !== false;
                    const buyDisabled = isOwned || purchaseBusySku !== null || !isPurchasable;
                    return (
                      <div key={item.sku} className="store-card">
                        <div className="store-card-head">
                          <strong>{item.title}</strong>
                          <span>
                            {item.priceStars}⭐ {!isPurchasable ? <em className="store-soon-badge">Coming soon</em> : null}
                          </span>
                        </div>
                        <div className="store-card-desc">{item.description || '—'}</div>
                        <button
                          type="button"
                          className="shop-buy-btn"
                          disabled={buyDisabled}
                          onClick={() => {
                            void onBuy(item.sku);
                          }}
                        >
                          {isOwned ? 'Owned' : purchaseBusySku === item.sku ? 'Buying...' : !isPurchasable ? 'Soon' : 'Buy'}
                        </button>
                      </div>
                    );
                  })
              )}
            </div>
          </div>
        </div>
      )}

      {multiplayerOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Multiplayer">
          <div className="settings-modal">
            <div className="settings-header">
              <strong>Multiplayer</strong>
              <button type="button" onClick={() => setMultiplayerOpen(false)}>Close</button>
            </div>
            <div className="settings-tabs">
              <button type="button" className={multiplayerTab === 'rooms' ? 'active' : ''} onClick={() => setMultiplayerTab('rooms')}>Rooms</button>
              <button type="button" className={multiplayerTab === 'friends' ? 'active' : ''} onClick={() => setMultiplayerTab('friends')}>Friends</button>
            </div>

            <div className="settings-panel">
              {multiplayerTab === 'rooms' ? (
                <>
              <div className="room-create-row">
                <span>Create room</span>
                <div className="room-create-actions">
                  <button type="button" onClick={() => { void onCreateRoom(2); }}>2p</button>
                  <button type="button" onClick={() => { void onCreateRoom(3); }}>3p</button>
                  <button type="button" onClick={() => { void onCreateRoom(4); }}>4p</button>
                </div>
              </div>

              <div className="room-join-row">
                <input
                  type="text"
                  value={joinCodeDraft}
                  onChange={(event) => setJoinCodeDraft(event.target.value.toUpperCase())}
                  placeholder="Room code"
                />
                <button type="button" onClick={() => { void joinRoomByCode(joinCodeDraft); }}>Join</button>
              </div>

              {roomsError ? <div>{roomsError}</div> : null}
              {roomsLoading ? <div>Loading rooms...</div> : null}

              <div className="room-section">
                <strong>My rooms</strong>
                {myRooms.length === 0 ? (
                  <div>No joined rooms yet.</div>
                ) : (
                  myRooms.map((room) => (
                    <button
                      key={room.roomCode}
                      type="button"
                      className="room-list-item"
                      onClick={() => { void joinRoomByCode(room.roomCode); }}
                    >
                      <span>{room.roomCode}</span>
                      <span>{room.memberCount}/{room.capacity}</span>
                      <span>{room.status}</span>
                    </button>
                  ))
                )}
              </div>

              <div className="room-section">
                <strong>Current room</strong>
                {!currentRoom ? (
                  <div>Not in a room.</div>
                ) : (
                  <>
                    <div className="settings-kv"><span>Code</span><strong>{currentRoom.roomCode}</strong></div>
                    <div className="settings-kv"><span>Status</span><strong>{currentRoom.status}</strong></div>
                    <div className="room-create-actions">
                      <button type="button" onClick={() => { void onCopyInviteLink(); }}>Copy invite link</button>
                      {currentRoom.ownerTgUserId && currentRoom.ownerTgUserId === localTgUserId ? (
                        <button type="button" onClick={() => { void onCloseRoom(); }}>Close room</button>
                      ) : (
                        <button type="button" onClick={() => { void onLeaveRoom(); }}>Leave</button>
                      )}
                    </div>
                    <div className="room-members-list">
                      {currentRoomMembers.map((member) => (
                        <div key={member.tgUserId} className="settings-kv">
                          <span>{member.displayName}</span>
                          <strong>{member.tgUserId}</strong>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
                </>
              ) : (
                <>
                  <div className="room-join-row">
                    <input
                      type="text"
                      value={friendTargetDraft}
                      onChange={(event) => setFriendTargetDraft(event.target.value)}
                      placeholder="tg_user_id"
                    />
                    <button type="button" onClick={() => { void onSendFriendRequest(); }}>Send request</button>
                  </div>

                  {friendsError ? <div>{friendsError}</div> : null}
                  {friendsLoading ? <div>Loading friends...</div> : null}

                  <div className="room-section">
                    <strong>Incoming</strong>
                    {incomingRequests.length === 0 ? (
                      <div>No incoming requests.</div>
                    ) : (
                      incomingRequests.map((request) => (
                        <div key={request.fromTgUserId} className="friend-list-item">
                          <span>{request.displayName}</span>
                          <strong>{request.fromTgUserId}</strong>
                          <div className="friend-actions">
                            <button type="button" onClick={() => { void onRespondFriendRequest(request.fromTgUserId, 'accept'); }}>Accept</button>
                            <button type="button" onClick={() => { void onRespondFriendRequest(request.fromTgUserId, 'decline'); }}>Decline</button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="room-section">
                    <strong>Outgoing</strong>
                    {outgoingRequests.length === 0 ? (
                      <div>No outgoing requests.</div>
                    ) : (
                      outgoingRequests.map((request) => (
                        <div key={request.toTgUserId} className="settings-kv">
                          <span>{request.displayName}</span>
                          <strong>{request.status}</strong>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="room-section">
                    <strong>Friends</strong>
                    {friendsList.length === 0 ? (
                      <div>No friends yet.</div>
                    ) : (
                      friendsList.map((friend) => (
                        <div key={friend.tgUserId} className="friend-list-item">
                          <span>{friend.displayName}</span>
                          <strong>{friend.tgUserId}</strong>
                          <button type="button" onClick={() => { void onInviteFriend(); }}>Invite</button>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
          <div className="settings-modal">
            <div className="settings-header">
              <strong>Settings</strong>
              <button type="button" onClick={() => setSettingsOpen(false)}>Close</button>
            </div>
            <div className="settings-tabs">
              <button type="button" className={settingsTab === 'audio' ? 'active' : ''} onClick={() => setSettingsTab('audio')}>Audio</button>
              <button type="button" className={settingsTab === 'account' ? 'active' : ''} onClick={() => setSettingsTab('account')}>Account</button>
            </div>

            {settingsTab === 'audio' ? (
              <div className="settings-panel">
                <label className="settings-row">
                  <span>Music</span>
                  <input
                    type="checkbox"
                    checked={audioSettings.musicEnabled}
                    onChange={(event) => {
                      void persistAudioSettings({ ...audioSettings, musicEnabled: event.target.checked });
                    }}
                  />
                </label>
                <label className="settings-row">
                  <span>SFX</span>
                  <input
                    type="checkbox"
                    checked={audioSettings.sfxEnabled}
                    onChange={(event) => {
                      void persistAudioSettings({ ...audioSettings, sfxEnabled: event.target.checked });
                    }}
                  />
                </label>
              </div>
            ) : (
              <div className="settings-panel">
                <div className="settings-kv"><span>ID</span><strong>{accountInfo?.id ?? '—'}</strong></div>
                <div className="settings-kv"><span>Remaining</span><strong>{accountInfo?.nameChangeRemaining ?? 3}</strong></div>
                <div className="settings-ref">
                  <input type="text" readOnly value={accountInfo?.referralLink ?? ''} />
                  <button type="button" onClick={() => { void onCopyReferral(); }}>Copy</button>
                </div>
                <input
                  type="text"
                  maxLength={32}
                  value={displayNameDraft}
                  onChange={(event) => setDisplayNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void onSubmitDisplayName();
                    }
                  }}
                  placeholder="Display name"
                />
              </div>
            )}
          </div>
        </div>
      )}

      <WsDebugOverlay
        connected={ws.connected}
        messages={ws.messages}
        identity={{
          id: localTgUserId,
          clientId: devIdentity.clientId,
          displayName: profileName,
        }}
        netSim={ws.netSimConfig}
        netSimPresets={ws.netSimPresets}
        onToggleNetSim={ws.setNetSimEnabled}
        onSelectNetSimPreset={ws.setNetSimPreset}
        predictionStats={predictionStats}
        tickDebugStats={tickDebugStats}
        rttMs={ws.rttMs}
        rttJitterMs={ws.rttJitterMs}
        localInputSeq={inputSeqRef.current}
        onLobby={() => ws.send({ type: 'lobby:list' })}
        onCreateRoom={() => ws.send({ type: 'room:create' })}
        onStartMatch={() => ws.send({ type: 'match:start' })}
        getLocalPlayerPosition={() => sceneRef.current?.getLocalPlayerPosition() ?? null}
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
