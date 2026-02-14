import { useEffect, useRef, useState, useCallback } from 'react';
import Phaser from 'phaser';
import { GameScene } from '../game/GameScene';
import { GAME_CONFIG } from '../game/config';

import {
  EVENT_ASSET_PROGRESS,
  EVENT_CAMPAIGN_STATE,
  EVENT_READY,
  EVENT_SIMULATION,
  EVENT_STATS,
  EVENT_LIFE_STATE,
  gameEvents,
  type AssetProgressPayload,
  type LifeStatePayload,
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
  fetchMyRooms,
  fetchRoom,
  fetchShopCatalog,
  fetchShopOwned,
  fetchLedger,
  fetchWallet,
  joinRoom,
  leaveRoom,
  requestFriend,
  setRoomReady,
  startRoom,
  respondFriend,
  type FriendEntry,
  type IncomingFriendRequest,
  type LeaderboardMode,
  type MyRoomEntry,
  type OutgoingFriendRequest,
  type RoomMember,
  type RoomState,
  type ShopCatalogItem,
  type WalletLedgerEntry,
} from '../game/wallet';
import {
  getPersonalBest,
  listLeaderboardTop as listLocalLeaderboardTop,
  modeFromTeamSize,
  upsertLeaderboardScore,
  type LeaderboardRecord,
} from '../game/localLeaderboard';
import {
  getStoredPlayerProfile,
  upsertStoredPlayerProfile,
  validatePlayerName,
} from '../game/localProfile';
import { WsDebugOverlay } from './WsDebugOverlay';
import { useWsClient } from '../ws/useWsClient';
import { resolveDevIdentity } from '../utils/devIdentity';


const defaultStats: PlayerStats = {
  capacity: GAME_CONFIG.defaultBombCapacity,
  placed: 0,
  range: GAME_CONFIG.defaultRange,
  score: 0,
  lives: 3,
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
type GameFlowPhase = 'intro' | 'start' | 'playing';
type TutorialStep = {
  id: string;
  title: string;
  body: string;
};

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
  if (error === 'room_full') return 'Комната заполнена';
  if (error === 'room_closed') return 'Комната закрыта';
  if (error === 'room_not_found') return 'Комната не найдена';
  if (error === 'forbidden') return 'Only owner can perform this action';
  if (error === 'room_started') return 'Комната уже запущена';
  if (error === 'not_enough_players') return 'Недостаточно игроков';
  if (error === 'not_all_ready') return 'Не все игроки готовы';
  if (error === 'ready_invalid') return 'Некорректное значение ready';
  if (error) return error;
  return 'Request failed';
}

const JOYSTICK_RADIUS = 56;
const JOYSTICK_DEADZONE = 10;
const INTRO_PLACEHOLDER_MS = 5500;
const ONBOARDING_DONE_KEY = 'rift_onboarding_v1_done';
const PLAYER_REGISTRATION_DONE_PREFIX = 'rift_player_registration_v1_done';
const MOBILE_ROTATE_OVERLAY_BREAKPOINT = 700;

type TelegramWebApp = {
  ready?: () => void;
  expand?: () => void;
  requestFullscreen?: () => void;
  disableVerticalSwipes?: () => void;
  isExpanded?: boolean;
  viewportHeight?: number;
  viewportStableHeight?: number;
  contentSafeAreaInset?: { top: number; bottom: number; left: number; right: number };
  safeAreaInset?: { top: number; bottom: number; left: number; right: number };
  onEvent?: (eventType: 'viewportChanged' | 'safeAreaChanged' | 'contentSafeAreaChanged', handler: () => void) => void;
  offEvent?: (eventType: 'viewportChanged' | 'safeAreaChanged' | 'contentSafeAreaChanged', handler: () => void) => void;
};

export default function GameView(): JSX.Element {
  const pageRef = useRef<HTMLElement | null>(null);
  const pageShellRef = useRef<HTMLElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<GameScene | null>(null);
  const inputSeqRef = useRef(0);
  const joystickTouchZoneRef = useRef<HTMLDivElement | null>(null);
  const joystickPadRef = useRef<HTMLDivElement | null>(null);
  const joystickPointerIdRef = useRef<number | null>(null);
  const hudLivesRef = useRef<HTMLSpanElement | null>(null);
  const bombBtnRef = useRef<HTMLButtonElement | null>(null);
  const detonateBtnRef = useRef<HTMLButtonElement | null>(null);
  const multiplayerBtnRef = useRef<HTMLButtonElement | null>(null);
  const tutorialStepTargetRef = useRef<HTMLElement | null>(null);
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
  const [lifeState, setLifeState] = useState<LifeStatePayload>({
    lives: 3,
    maxLives: 6,
    mode: 'solo',
    awaitingContinue: false,
    gameOver: false,
    eliminated: false,
  });
  const [campaign, setCampaign] = useState<CampaignState>(() => loadCampaignState());
  const [zoom, setZoom] = useState<number>(GAME_CONFIG.minZoom);
  const [isRemoteDetonateUnlocked, setIsRemoteDetonateUnlocked] = useState(false);
  const [joystickPressed, setJoystickPressed] = useState(false);
  const [joystickOffset, setJoystickOffset] = useState({ x: 0, y: 0 });
  const [profileName, setProfileName] = useState<string>('—');
  const [playerRegistrationOpen, setPlayerRegistrationOpen] = useState(false);
  const [playerNameDraft, setPlayerNameDraft] = useState('');
  const [playerNameError, setPlayerNameError] = useState<string | null>(null);
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
  const [leaderboardTop, setLeaderboardTop] = useState<LeaderboardRecord[]>([]);
  const [leaderboardMe, setLeaderboardMe] = useState<{ rank: number; score: number } | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [multiplayerOpen, setMultiplayerOpen] = useState(false);
  const [multiplayerTab, setMultiplayerTab] = useState<MultiplayerTab>('rooms');
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [joinCodeDraft, setJoinCodeDraft] = useState('');
  const [joiningRoomCode, setJoiningRoomCode] = useState<string | null>(null);
  const [myRooms, setMyRooms] = useState<MyRoomEntry[]>([]);
  const [currentRoom, setCurrentRoom] = useState<RoomState | null>(null);
  const [currentRoomMembers, setCurrentRoomMembers] = useState<RoomMember[]>([]);
  const [settingReady, setSettingReady] = useState(false);
  const [startingRoom, setStartingRoom] = useState(false);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [friendTargetDraft, setFriendTargetDraft] = useState('');
  const [friendsList, setFriendsList] = useState<FriendEntry[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<IncomingFriendRequest[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<OutgoingFriendRequest[]>([]);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>({ musicEnabled: true, sfxEnabled: true });
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [referralDraft, setReferralDraft] = useState('Coming soon');
  const [gameFlowPhase, setGameFlowPhase] = useState<GameFlowPhase>('intro');
  const [tutorialStepIndex, setTutorialStepIndex] = useState(0);
  const [tutorialActive, setTutorialActive] = useState(false);
  const [tutorialTargetRect, setTutorialTargetRect] = useState<DOMRect | null>(null);
  const [onboardingDone, setOnboardingDone] = useState<boolean>(() => localStorage.getItem(ONBOARDING_DONE_KEY) === '1');
  const bootSplashSeen = localStorage.getItem('rift_boot_v1_done') === '1';
  const [showBootSplash, setShowBootSplash] = useState<boolean>(() => !bootSplashSeen);
  const [bootSplashProgress, setBootSplashProgress] = useState<number>(() => (bootSplashSeen ? 1 : 0));
  const [bootSplashFileKey, setBootSplashFileKey] = useState<string>('');
  const [bootSplashClosing, setBootSplashClosing] = useState(false);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const ws = useWsClient(token || undefined);

  const baseWidth = GAME_CONFIG.gridWidth * GAME_CONFIG.tileSize;
  const baseHeight = GAME_CONFIG.gridHeight * GAME_CONFIG.tileSize;
  const arenaAspectRatio = `${baseWidth} / ${baseHeight}`;
  const tutorialSteps: TutorialStep[] = [
    { id: 'lives', title: 'Lives HUD', body: 'Верхний левый HUD показывает игроков и их lives.' },
    { id: 'bomb', title: 'Bomb', body: 'Кнопка Bomb ставит бомбу рядом с персонажем.' },
    { id: 'detonate', title: 'Detonate', body: 'Detonate взрывает ваши бомбы вручную, когда способность разблокирована.' },
    { id: 'multiplayer', title: 'Multiplayer', body: 'Иконка Multiplayer открывает комнаты и друзей.' },
    { id: 'joystick', title: 'Joystick', body: 'Удерживайте и тяните джойстик для движения.' },
  ];
  const currentTutorialStep = tutorialSteps[tutorialStepIndex] ?? null;

  const myRoomMember = currentRoomMembers.find((member) => member.tgUserId === localTgUserId);
  const waitingForOtherPlayer = Boolean(
    multiplayerOpen
    && multiplayerTab === 'rooms'
    && currentRoom
    && ((myRoomMember?.ready ?? false) || startingRoom)
    && (currentRoom.phase ?? 'LOBBY') !== 'STARTED',
  );

  const isInputLocked = gameFlowPhase !== 'playing' || tutorialActive || waitingForOtherPlayer || playerRegistrationOpen;
  const isMobileViewport = Math.min(viewportSize.width, viewportSize.height) < MOBILE_ROTATE_OVERLAY_BREAKPOINT;
  const isPortraitViewport = viewportSize.height >= viewportSize.width;
  const shouldShowRotateOverlay = isMobileViewport && isPortraitViewport;
  const deathOverlayVisible = lifeState.awaitingContinue || lifeState.gameOver;
  const isInteractionBlocked = isInputLocked || shouldShowRotateOverlay || deathOverlayVisible || lifeState.eliminated;
  const shellSizeRef = useRef<{ width: number; height: number }>({ width: window.innerWidth, height: window.innerHeight });
  const lastSubmittedSignatureRef = useRef<string>('');

  const getCurrentLeaderboardPayload = useCallback(() => {
    const teamPlayers = (currentRoomMembers.length >= 2 ? currentRoomMembers : [{
      tgUserId: localTgUserId ?? '__local__',
      displayName: profileName,
      joinedAt: '',
      ready: true,
    }]).map((member) => ({ tgUserId: member.tgUserId, displayName: member.displayName }));

    const mode = modeFromTeamSize(teamPlayers.length);
    return {
      mode,
      score: Math.max(0, Math.floor(stats.score ?? 0)),
      players: teamPlayers,
    };
  }, [currentRoomMembers, localTgUserId, profileName, stats.score]);

  const submitScoreIfNeeded = useCallback((reason: string): void => {
    const payload = getCurrentLeaderboardPayload();
    if (payload.score <= 0) return;

    const signature = `${reason}:${payload.mode}:${payload.players.map((p) => p.tgUserId).sort().join('|')}:${payload.score}`;
    if (lastSubmittedSignatureRef.current === signature) return;
    lastSubmittedSignatureRef.current = signature;

    upsertLeaderboardScore(payload);
  }, [getCurrentLeaderboardPayload]);

  const updateTgMetrics = useCallback((): void => {
    const tg = (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
    const insets = tg?.contentSafeAreaInset ?? tg?.safeAreaInset;
    const top = insets?.top ?? 0;
    const right = insets?.right ?? 0;
    const bottom = insets?.bottom ?? 0;
    const left = insets?.left ?? 0;
    const viewportHeight = tg?.viewportHeight ?? window.innerHeight;
    const stableHeight = tg?.viewportStableHeight ?? viewportHeight;

    document.documentElement.style.setProperty('--tg-viewport-h', `${Math.floor(viewportHeight)}px`);
    document.documentElement.style.setProperty('--tg-viewport-stable-h', `${Math.floor(stableHeight)}px`);
    document.documentElement.style.setProperty('--tg-content-top', `${Math.floor(top)}px`);
    document.documentElement.style.setProperty('--tg-content-right', `${Math.floor(right)}px`);
    document.documentElement.style.setProperty('--tg-content-bottom', `${Math.floor(bottom)}px`);
    document.documentElement.style.setProperty('--tg-content-left', `${Math.floor(left)}px`);
  }, []);

  useEffect(() => {
    const tg = (window as any)?.Telegram?.WebApp;

    // Telegram WebApp init (Eggs&Dragons parity)
    try {
      tg?.ready?.();
      tg?.expand?.();

      // Critical on iOS Telegram: prevent "pull to close" / vertical swipes while playing
      tg?.disableVerticalSwipes?.();
    } catch {
      // no-op
    }

    // Apply metrics right after init/expand (Telegram may finalize viewport on next tick)
    updateTgMetrics();
    requestAnimationFrame(() => updateTgMetrics());

    // Keep metrics in sync
    const onViewportChanged = (): void => {
      updateTgMetrics();
    };

    try {
      tg?.onEvent?.('viewportChanged', onViewportChanged);
      tg?.onEvent?.('safeAreaChanged', onViewportChanged);
      tg?.onEvent?.('contentSafeAreaChanged', onViewportChanged);
    } catch {
      // no-op
    }

    return () => {
      try {
        tg?.offEvent?.('viewportChanged', onViewportChanged);
        tg?.offEvent?.('safeAreaChanged', onViewportChanged);
        tg?.offEvent?.('contentSafeAreaChanged', onViewportChanged);
      } catch {
        // no-op
      }
    };
  }, [updateTgMetrics]);

  const updateShellMetrics = useCallback((shellW: number, shellH: number): void => {
    const width = Math.max(1, Math.round(shellW));
    const height = Math.max(1, Math.round(shellH));
    const scale = Math.max(0.45, Math.min(Math.min(width, height) / 900, 1.2));
    const device = width < 900 ? 'phone' : width <= 1200 ? 'tablet' : 'desktop';
    const orient = height >= width ? 'portrait' : 'landscape';

    shellSizeRef.current = { width, height };
    setViewportSize({ width, height });
    document.documentElement.style.setProperty('--shell-w', `${width}px`);
    document.documentElement.style.setProperty('--shell-h', `${height}px`);
    document.documentElement.style.setProperty('--ui-scale', scale.toFixed(4));
    document.documentElement.dataset.device = device;
    document.documentElement.dataset.orient = orient;
  }, []);

  useEffect(() => {
    if (!tutorialActive || !currentTutorialStep) {
      tutorialStepTargetRef.current = null;
      setTutorialTargetRect(null);
      return;
    }

    const nextTarget =
      currentTutorialStep.id === 'lives'
        ? hudLivesRef.current
        : currentTutorialStep.id === 'bomb'
          ? bombBtnRef.current
          : currentTutorialStep.id === 'detonate'
            ? detonateBtnRef.current
            : currentTutorialStep.id === 'multiplayer'
              ? multiplayerBtnRef.current
              : joystickPadRef.current;

    tutorialStepTargetRef.current = nextTarget;

    const updateRect = (): void => {
      const rect = tutorialStepTargetRef.current?.getBoundingClientRect() ?? null;
      setTutorialTargetRect(rect);
    };

    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    const rafId = window.requestAnimationFrame(updateRect);

    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
      window.cancelAnimationFrame(rafId);
    };
  }, [currentTutorialStep, tutorialActive]);


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
    const shell = pageShellRef.current;
    if (!shell) return;

    let rafId = 0;
    const measure = (): void => {
      rafId = 0;
      const rect = shell.getBoundingClientRect();
      updateShellMetrics(rect.width, rect.height);
    };
    const queueMeasure = (): void => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(measure);
    };

    queueMeasure();
    const observer = new ResizeObserver(queueMeasure);
    observer.observe(shell);
    window.addEventListener('resize', queueMeasure);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', queueMeasure);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [updateShellMetrics]);

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
    const stored = getStoredPlayerProfile(localTgUserId);
    if (stored?.playerName) {
      setProfileName(stored.playerName);
      setDisplayNameDraft(stored.playerName);
      setPlayerNameDraft(stored.playerName);
      setPlayerRegistrationOpen(false);
      return;
    }

    const base = profileName && profileName !== '—' ? profileName : '';
    setPlayerNameDraft(base);
    setPlayerRegistrationOpen(true);
  }, [localTgUserId]);

  useEffect(() => {
    if (!lifeState.gameOver) return;
    submitScoreIfNeeded('game_over');
  }, [lifeState.gameOver, submitScoreIfNeeded]);

  useEffect(() => {
    const onPageHide = (): void => {
      submitScoreIfNeeded('exit');
    };
    window.addEventListener('beforeunload', onPageHide);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      window.removeEventListener('beforeunload', onPageHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [submitScoreIfNeeded]);

  useEffect(() => {
    setReferralDraft(accountInfo?.referralLink || `https://t.me/share/url?text=Join%20Rift%20Runners&user=${localTgUserId ?? 'player'}`);
  }, [accountInfo?.referralLink, localTgUserId]);

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
      const minZoom = GAME_CONFIG.minZoom;
      setZoom(minZoom);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          payload.setZoom(minZoom);
        });
      });
    };
    const onCampaignState = (nextCampaign: CampaignState): void => {
      setCampaign({ ...nextCampaign });
    };
    const onAssetProgress = (payload: AssetProgressPayload): void => {
      setBootSplashProgress(Math.max(0, Math.min(1, Number(payload.progress) || 0)));
      if (payload.fileKey) {
        setBootSplashFileKey(payload.fileKey);
      }
    };
    const onLifeState = (payload: LifeStatePayload): void => {
      setLifeState({ ...payload });
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
    gameEvents.on(EVENT_ASSET_PROGRESS, onAssetProgress);
    gameEvents.on(EVENT_SIMULATION, onSimulation);
    gameEvents.on(EVENT_LIFE_STATE, onLifeState);

    return () => {
      gameEvents.off(EVENT_STATS, onStats);
      gameEvents.off(EVENT_READY, onReady);
      gameEvents.off(EVENT_CAMPAIGN_STATE, onCampaignState);
      gameEvents.off(EVENT_ASSET_PROGRESS, onAssetProgress);
      gameEvents.off(EVENT_SIMULATION, onSimulation);
      gameEvents.off(EVENT_LIFE_STATE, onLifeState);
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

  const isMultiplayerMode = Boolean(currentRoom && currentRoomMembers.length >= 2);

  useEffect(() => {
    sceneRef.current?.setGameMode(isMultiplayerMode ? 'multiplayer' : 'solo');
  }, [isMultiplayerMode]);

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

  useEffect(() => {
    if (showBootSplash) return;
    if (gameFlowPhase !== 'intro') return;

    const timerId = window.setTimeout(() => {
      setGameFlowPhase('start');
    }, INTRO_PLACEHOLDER_MS);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [gameFlowPhase, showBootSplash]);

  useEffect(() => {
    if (!isInteractionBlocked) return;
    releaseJoystick();
    controlsRef.current.placeBombRequested = false;
    controlsRef.current.detonateRequested = false;
  }, [isInteractionBlocked]);

  const setDirection = (direction: Direction, active: boolean): void => {
    if (isInteractionBlocked) return;

    if (active) {
      setMovementFromDirection(direction);
      return;
    }

    if (controlsRef.current[direction]) {
      clearMovement();
    }
  };

  const updateJoystickFromPointer = (clientX: number, clientY: number): void => {
    if (isInteractionBlocked) return;

    const visualPad = joystickPadRef.current;
    if (!visualPad) return;

    const rect = visualPad.getBoundingClientRect();
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
    if (isInteractionBlocked) return;

    event.preventDefault();
    event.stopPropagation();

    const touchZone = joystickTouchZoneRef.current;
    if (!touchZone) return;

    if (typeof touchZone.setPointerCapture === 'function') {
      touchZone.setPointerCapture(event.pointerId);
    }
    joystickPointerIdRef.current = event.pointerId;
    setJoystickPressed(true);
    updateJoystickFromPointer(event.clientX, event.clientY);
  };

  const onJoystickPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (isInteractionBlocked) return;
    if (joystickPointerIdRef.current !== event.pointerId) return;
    if (!joystickPressed) return;

    event.preventDefault();
    event.stopPropagation();

    updateJoystickFromPointer(event.clientX, event.clientY);
  };

  const releaseJoystick = (pointerId?: number): void => {
    const touchZone = joystickTouchZoneRef.current;
    if (touchZone && pointerId !== undefined && typeof touchZone.hasPointerCapture === 'function' && touchZone.hasPointerCapture(pointerId)) {
      touchZone.releasePointerCapture(pointerId);
    }
    joystickPointerIdRef.current = null;
    setJoystickPressed(false);
    setJoystickOffset({ x: 0, y: 0 });
    clearMovement();
  };

  const onJoystickPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (joystickPointerIdRef.current !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    releaseJoystick(event.pointerId);
  };

  const onJoystickPointerLeave = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (joystickPointerIdRef.current !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    const touchZone = joystickTouchZoneRef.current;
    if (touchZone && typeof touchZone.hasPointerCapture === 'function' && touchZone.hasPointerCapture(event.pointerId)) {
      return;
    }

    releaseJoystick(event.pointerId);
  };

  const requestBomb = (): void => {
    if (isInteractionBlocked) return;
    controlsRef.current.placeBombRequested = true;
  };

  const requestDetonate = (): void => {
    if (isInteractionBlocked) return;
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
      const top = listLocalLeaderboardTop(mode, 10);
      const me = getPersonalBest(mode, localTgUserId);
      setLeaderboardTop(top);
      setLeaderboardMe(me);
    } catch {
      setLeaderboardError('Failed to load leaderboard');
      setLeaderboardTop([]);
      setLeaderboardMe(null);
    } finally {
      setLeaderboardLoading(false);
    }
  }, [localTgUserId]);

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
  }, [currentRoom?.roomCode, submitScoreIfNeeded]);

  const joinRoomByCode = useCallback(async (roomCodeRaw: string): Promise<void> => {
    const roomCode = roomCodeRaw.trim().toUpperCase();
    if (!roomCode) return;
    if (currentRoom?.roomCode === roomCode) return;
    if (joiningRoomCode === roomCode) return;

    setRoomsError(null);
    setJoiningRoomCode(roomCode);
    try {
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
    } finally {
      setJoiningRoomCode((prev) => (prev === roomCode ? null : prev));
    }
  }, [currentRoom?.roomCode, joiningRoomCode]);

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
    submitScoreIfNeeded('exit_room');

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
  }, [currentRoom, submitScoreIfNeeded]);

  const onCloseRoom = useCallback(async (): Promise<void> => {
    if (!currentRoom?.roomCode) return;
    submitScoreIfNeeded('close_room');

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



  const onToggleReady = useCallback(async (): Promise<void> => {
    if (!currentRoom?.roomCode || !localTgUserId) return;
    const me = currentRoomMembers.find((member) => member.tgUserId === localTgUserId);
    const nextReady = !(me?.ready ?? false);

    setSettingReady(true);
    setRoomsError(null);
    try {
      const result = await setRoomReady(currentRoom.roomCode, nextReady);
      if (!result) {
        setRoomsError('Ready update failed');
        return;
      }
      if (result.error) {
        setRoomsError(mapRoomError(result.error));
        return;
      }
      setCurrentRoom(result.room);
      setCurrentRoomMembers(result.members);
    } finally {
      setSettingReady(false);
    }
  }, [currentRoom?.roomCode, currentRoomMembers, localTgUserId]);

  const onStartRoom = useCallback(async (): Promise<void> => {
    if (!currentRoom?.roomCode) return;

    setStartingRoom(true);
    setRoomsError(null);
    try {
      const result = await startRoom(currentRoom.roomCode);
      if (!result) {
        setRoomsError('Start failed');
        return;
      }
      if (result.error) {
        setRoomsError(mapRoomError(result.error));
        return;
      }
      setCurrentRoom(result.room);
      setCurrentRoomMembers(result.members);
    } finally {
      setStartingRoom(false);
    }
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

    const telegramStartParam = (window as Window & { Telegram?: { WebApp?: { initDataUnsafe?: { start_param?: string } } } }).Telegram?.WebApp?.initDataUnsafe?.start_param;
    const startParam = telegramStartParam;
    if (startParam?.startsWith('room_')) {
      const deepLinkRoomCode = startParam.replace('room_', '').trim().toUpperCase();
      if (!deepLinkRoomCode) return;

      setMultiplayerOpen(true);
      setMultiplayerTab('rooms');
      setJoinCodeDraft(deepLinkRoomCode);
      const timer = window.setTimeout(() => {
        void joinRoomByCode(deepLinkRoomCode);
      }, 300);
      return () => {
        window.clearTimeout(timer);
      };
    }

    const search = new URLSearchParams(window.location.search);
    const startappRaw = search.get('startapp') ?? '';
    if (!startappRaw.startsWith('room_')) return;

    const deepLinkRoomCode = startappRaw.slice(5).trim().toUpperCase();
    if (!deepLinkRoomCode) return;

    setMultiplayerOpen(true);
    setMultiplayerTab('rooms');
    setJoinCodeDraft(deepLinkRoomCode);
    const timer = window.setTimeout(() => {
      void joinRoomByCode(deepLinkRoomCode);
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
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
    if (!referralDraft) return;
    try {
      await navigator.clipboard.writeText(referralDraft);
    } catch {
      // no-op
    }
  };

  const onSubmitDisplayName = async (): Promise<void> => {
    const validation = validatePlayerName(displayNameDraft);
    if (!validation.ok) return;

    const stored = upsertStoredPlayerProfile(localTgUserId, validation.value);
    if (stored) {
      setProfileName(stored.playerName);
      setDisplayNameDraft(stored.playerName);
      setAccountInfo((prev) => (prev ? { ...prev, displayName: stored.playerName } : prev));
    }

    if (!token) return;

    const response = await fetch('/api/profile/name', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: validation.value }),
    });

    const json = await response.json().catch(() => null);
    if (response.ok && json?.ok) {
      setAccountInfo((prev) => (prev ? { ...prev, nameChangeRemaining: Number(json.remaining ?? prev.nameChangeRemaining) } : prev));
      return;
    }

    if (response.status === 429) {
      setAccountInfo((prev) => (prev ? { ...prev, nameChangeRemaining: 0 } : prev));
    }
  };

  const onSubmitPlayerRegistration = (): void => {
    const validation = validatePlayerName(playerNameDraft);
    if (!validation.ok) {
      setPlayerNameError(validation.error);
      return;
    }

    const stored = upsertStoredPlayerProfile(localTgUserId, validation.value);
    if (!stored) {
      setPlayerNameError('Failed to save player name.');
      return;
    }

    setPlayerNameError(null);
    setPlayerRegistrationOpen(false);
    setProfileName(stored.playerName);
    setDisplayNameDraft(stored.playerName);
    localStorage.setItem(`${PLAYER_REGISTRATION_DONE_PREFIX}:${stored.tgUserId}`, '1');
  };

  useEffect(() => {
    if (!showBootSplash) return;
    if (bootSplashProgress < 1) return;

    localStorage.setItem('rift_boot_v1_done', '1');
    setBootSplashClosing(true);
    const timeoutId = window.setTimeout(() => {
      setShowBootSplash(false);
      setBootSplashClosing(false);
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [bootSplashProgress, showBootSplash]);

  useEffect(() => {
    if (showBootSplash) return;

    updateTgMetrics();
    const canvasRect = mountRef.current?.getBoundingClientRect();
    const shellW = canvasRect?.width ?? shellSizeRef.current.width;
    const shellH = canvasRect?.height ?? shellSizeRef.current.height;
    gameRef.current?.scale.resize(Math.max(1, Math.round(shellW)), Math.max(1, Math.round(shellH)));
  }, [showBootSplash, updateTgMetrics]);

  const bootProgressPercent = Math.round(bootSplashProgress * 100);

  const isMultiplayerHud = currentRoomMembers.length >= 2;
  const hudSlots = isMultiplayerHud
    ? Array.from({ length: 4 }, (_, index) => currentRoomMembers[index] ?? null)
    : [{ tgUserId: localTgUserId ?? 'local', displayName: profileName, joinedAt: '', ready: true }];

  const requestTelegramFullscreenBestEffort = (): void => {
    const w = window as Window & { Telegram?: { WebApp?: TelegramWebApp } };

    // Native Telegram WebApp API
    if (w.Telegram?.WebApp) {
      try {
        w.Telegram.WebApp.ready?.();
      } catch { /* no-op */ }

      if (typeof w.Telegram.WebApp.requestFullscreen === 'function') {
        w.Telegram.WebApp.requestFullscreen();
      }
      if (typeof w.Telegram.WebApp.expand === 'function') {
        w.Telegram.WebApp.expand();
      }

      // prevent swipe-to-close while interacting (iOS)
      try {
        w.Telegram.WebApp.disableVerticalSwipes?.();
      } catch { /* no-op */ }
    }
  };

  const onStartGame = (): void => {
    requestTelegramFullscreenBestEffort();
    if (shouldShowRotateOverlay) return;
    const minZoom = GAME_CONFIG.minZoom;
    setZoom(minZoom);
    setGameFlowPhase('playing');
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        zoomApiRef.current?.setZoom(minZoom);
      });
    });
    if (playerRegistrationOpen) {
      return;
    }
    if (!onboardingDone) {
      setTutorialStepIndex(0);
      setTutorialActive(true);
    }
  };

  const onTutorialNext = (): void => {
    if (tutorialStepIndex >= tutorialSteps.length - 1) {
      setTutorialActive(false);
      setOnboardingDone(true);
      localStorage.setItem(ONBOARDING_DONE_KEY, '1');
      return;
    }
    setTutorialStepIndex((prev) => prev + 1);
  };

  return (
    <main ref={pageRef} className="page">
      {showBootSplash && (
        <div className={`boot-splash ${bootSplashClosing ? 'boot-splash--closing' : ''}`} role="status" aria-live="polite">
          <div className="boot-splash-card">
            {/* Future swap hook: replace inline SVG with <img src="/assets/ui/splash/logo_rift_runners.png" alt="Rift Runners" /> when binary assets are available. */}
            <svg className="boot-splash-logo" viewBox="0 0 860 180" role="img" aria-label="Rift Runners">
              <defs>
                <linearGradient id="bootLogoGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#69d1ff" />
                  <stop offset="55%" stopColor="#8f92ff" />
                  <stop offset="100%" stopColor="#d683ff" />
                </linearGradient>
              </defs>
              <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle">RIFT RUNNERS</text>
            </svg>
            <div className="boot-splash-progress-row">
              <div className="boot-splash-progress-track" aria-label="Asset loading progress">
                <div className="boot-splash-progress-fill" style={{ width: `${bootProgressPercent}%` }} />
              </div>
              <strong>{bootProgressPercent}%</strong>
            </div>
            {bootSplashFileKey ? <div className="boot-splash-file">Loading: {bootSplashFileKey}</div> : null}
          </div>
        </div>
      )}
      {!showBootSplash && gameFlowPhase !== 'playing' && (
        <div className="game-flow-overlay" role="status" aria-live="polite">
          {gameFlowPhase === 'intro' ? (
            <div className="intro-layer" aria-label="Rift Runners intro animation">
              <div className="intro-layer__brand-wrap">
                <strong className="intro-layer__brand">RIFT RUNNERS</strong>
                <p>Preparing mission briefing...</p>
              </div>
            </div>
          ) : (
            <div className="game-flow-card">
              <h2>Ready to start?</h2>
              <button type="button" className="game-flow-start-btn" disabled={shouldShowRotateOverlay} onClick={onStartGame}>Start</button>
            </div>
          )}
        </div>
      )}
      {gameFlowPhase === 'playing' && playerRegistrationOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Create your player">
          <div className="settings-modal">
            <div className="settings-header">
              <strong>Create your player</strong>
            </div>
            <div className="settings-panel">
              <input
                type="text"
                maxLength={24}
                value={playerNameDraft}
                onChange={(event) => {
                  setPlayerNameDraft(event.target.value);
                  setPlayerNameError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    onSubmitPlayerRegistration();
                  }
                }}
                placeholder="Player name"
              />
              {playerNameError ? <div>{playerNameError}</div> : null}
              <button type="button" onClick={onSubmitPlayerRegistration}>Continue</button>
            </div>
          </div>
        </div>
      )}
      {gameFlowPhase === 'playing' && tutorialActive && currentTutorialStep && (
        <div className="tutorial-overlay" role="dialog" aria-modal="true" aria-label="Tutorial spotlight">
          {tutorialTargetRect ? (
            <div
              className="tutorial-spotlight"
              style={{
                left: tutorialTargetRect.left,
                top: tutorialTargetRect.top,
                width: tutorialTargetRect.width,
                height: tutorialTargetRect.height,
              }}
            />
          ) : null}
          <div className="tutorial-card">
            <strong>{currentTutorialStep.title}</strong>
            <p>{currentTutorialStep.body}</p>
            <button type="button" onClick={onTutorialNext}>{tutorialStepIndex >= tutorialSteps.length - 1 ? 'Finish' : 'Next'}</button>
          </div>
        </div>
      )}
      {gameFlowPhase === 'playing' && waitingForOtherPlayer && (
        <div className="waiting-overlay" role="status" aria-live="polite">
          <div className="waiting-overlay__card">
            <strong>Waiting for other player…</strong>
            <p>Вы готовы. Ждём, пока второй игрок нажмёт Ready.</p>
          </div>
        </div>
      )}
      {gameFlowPhase === 'playing' && lifeState.awaitingContinue && (
        <div className="waiting-overlay" role="dialog" aria-modal="true" aria-label="Continue overlay">
          <div className="waiting-overlay__card">
            <strong>Continue?</strong>
            <p>Вы потеряли жизнь. Нажмите Continue для респауна.</p>
            <button type="button" onClick={() => sceneRef.current?.continueSoloRun()}>Continue</button>
          </div>
        </div>
      )}
      {gameFlowPhase === 'playing' && lifeState.gameOver && (
        <div className="waiting-overlay" role="dialog" aria-modal="true" aria-label="Game over overlay">
          <div className="waiting-overlay__card">
            <strong>GAME OVER</strong>
            <p>Жизни закончились.</p>
            <button type="button" onClick={() => { submitScoreIfNeeded('restart'); sceneRef.current?.restartSoloRun(); }}>Restart The Game</button>
          </div>
        </div>
      )}
      {shouldShowRotateOverlay && (
        <div className="rotate-overlay" role="status" aria-live="polite">
          <div className="rotate-overlay__card">
            <strong>Поверните телефон</strong>
            <p>Для Rift Runners нужен ландшафтный режим.</p>
          </div>
        </div>
      )}
      <section className="hud">
        <div className="stats-row">
          <div className="hud-left">
            <div className={`hud-slots ${isMultiplayerHud ? 'hud-slots--multiplayer' : 'hud-slots--single'}`}>
              {hudSlots.map((member, index) => (
                <div key={member?.tgUserId ?? `empty-${index}`} className={`hud-slot ${member ? '' : 'hud-slot--empty'}`}>
                  {member ? (
                    <>
                      <span className="hud-slot-name" title={member.displayName}>{member.displayName}</span>
                      <span ref={index === 0 ? hudLivesRef : undefined} className="hud-lives" aria-label="Lives" title="Lives">{index === 0 ? ('❤️'.repeat(Math.max(0, lifeState.lives)) || '💀') : '❤️❤️❤️'}</span>
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          <div className="hud-right">
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
        </div>
      </section>

      <section ref={pageShellRef} className="playfield-shell page-shell">
        <aside className="control-column control-column--left" aria-label="Movement controls">
          <div className="left-nav" aria-label="Navigation quick controls">
            <div className="nav-grid">
              <button type="button" className="nav-btn" aria-label="Map placeholder">🗺️</button>
              <button type="button" className="nav-btn" aria-label="Leaderboard" onClick={() => setLeaderboardOpen(true)}>🏆</button>
              <button type="button" className="nav-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}>⚙️</button>
              <button type="button" className="nav-btn" aria-label="Store" onClick={() => setIsStoreOpen(true)}>🛍️</button>
            </div>
            <div className="nav-secondary">
              <button ref={multiplayerBtnRef} type="button" className="nav-btn nav-btn--multiplayer" aria-label="Multiplayer" onClick={() => setMultiplayerOpen(true)}>👥</button>
            </div>
          </div>

          <div className="left-joystick">
            <div
              ref={joystickTouchZoneRef}
              className={`joystick-touch-zone ${joystickPressed ? 'joystick-touch-zone--active' : ''}`}
              onPointerDown={onJoystickPointerDown}
              onPointerMove={onJoystickPointerMove}
              onPointerUp={onJoystickPointerUp}
              onPointerCancel={onJoystickPointerUp}
              onPointerLeave={onJoystickPointerLeave}
              role="application"
              aria-label="Virtual joystick"
            >
              <div className="joystick-wrap">
                <div ref={joystickPadRef} className={`joystick-pad ${joystickPressed ? 'joystick-pad--active' : ''}`}>
                  <div
                    className="joystick-knob"
                    style={{
                      transform: `translate(calc(-50% + ${joystickOffset.x}px), calc(-50% + ${joystickOffset.y}px))`,
                    }}
                  />
                </div>
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
            <div className="right-stack-top">
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
              </div>
            </div>

            <div className="right-stack-middle">
              <div className="right-panel right-panel--actions" aria-label="Action buttons">
                <div className="boost-slot boost-slot--upper" aria-hidden="true">Boost</div>
                <button
                  ref={detonateBtnRef}
                  type="button"
                  className="detonate-btn"
                  onTouchStart={requestDetonate}
                  onMouseDown={requestDetonate}
                  disabled={!isRemoteDetonateUnlocked}
                >
                  Detonate
                </button>
                <button
                  ref={bombBtnRef}
                  type="button"
                  className="bomb-btn"
                  onTouchStart={requestBomb}
                  onMouseDown={requestBomb}
                >
                  Bomb
                </button>
                <div className="boost-slot boost-slot--lower" aria-hidden="true">Boost</div>
              </div>
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
                leaderboardTop.map((entry, index) => {
                  const rank = index + 1;
                  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
                  const names = entry.players.map((player) => player.displayName).join(', ');
                  return (
                    <div key={entry.id} className={`settings-kv leaderboard-row leaderboard-row--${rank <= 3 ? rank : 'other'}`}>
                      <span>{medal} #{rank} • {entry.mode} • {names}</span>
                      <strong>{entry.score}</strong>
                    </div>
                  );
                })
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
                  <button type="button" disabled={Boolean(joiningRoomCode)} onClick={() => { void onCreateRoom(2); }}>2p</button>
                  <button type="button" disabled={Boolean(joiningRoomCode)} onClick={() => { void onCreateRoom(3); }}>3p</button>
                  <button type="button" disabled={Boolean(joiningRoomCode)} onClick={() => { void onCreateRoom(4); }}>4p</button>
                </div>
              </div>

              <div className="room-join-row">
                <input
                  type="text"
                  value={joinCodeDraft}
                  onChange={(event) => setJoinCodeDraft(event.target.value.toUpperCase())}
                  placeholder="Room code"
                />
                <button type="button" disabled={Boolean(joiningRoomCode)} onClick={() => { void joinRoomByCode(joinCodeDraft); }}>{joiningRoomCode ? 'Joining...' : 'Join'}</button>
              </div>

              {roomsError ? <div>{roomsError}</div> : null}
              {roomsLoading ? <div>Loading rooms...</div> : null}
              {joiningRoomCode ? <div>Joining {joiningRoomCode}...</div> : null}

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
                      disabled={Boolean(joiningRoomCode)}
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
                    <div className="settings-kv"><span>Phase</span><strong>{currentRoom.phase ?? 'LOBBY'}</strong></div>
                    <div className="room-create-actions">
                      <button type="button" onClick={() => { void onCopyInviteLink(); }}>Copy invite link</button>
                      {currentRoom.ownerTgUserId && currentRoom.ownerTgUserId === localTgUserId ? (
                        <button type="button" onClick={() => { void onCloseRoom(); }}>Close room</button>
                      ) : (
                        <button type="button" onClick={() => { void onLeaveRoom(); }}>Leave</button>
                      )}
                    </div>
                    <div className="room-create-actions">
                      <button type="button" disabled={settingReady} onClick={() => { void onToggleReady(); }}>
                        {settingReady ? 'Saving...' : ((currentRoomMembers.find((m) => m.tgUserId === localTgUserId)?.ready ?? false) ? 'Ready ✓' : 'Set Ready')}
                      </button>
                      {currentRoom.ownerTgUserId && currentRoom.ownerTgUserId === localTgUserId ? (
                        <button
                          type="button"
                          disabled={startingRoom || currentRoomMembers.length < 2 || currentRoomMembers.some((member) => !(member.ready ?? false)) || (currentRoom.phase ?? 'LOBBY') === 'STARTED'}
                          onClick={() => { void onStartRoom(); }}
                        >
                          {startingRoom ? 'Starting...' : 'Start'}
                        </button>
                      ) : null}
                    </div>
                    <div className="room-members-list">
                      {currentRoomMembers.map((member) => (
                        <div key={member.tgUserId} className="settings-kv">
                          <span>{member.displayName}</span>
                          <strong>{member.ready ?? false ? 'Ready' : 'Not ready'}</strong>
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
                <div className="settings-kv"><span>Player name</span><strong>{profileName}</strong></div>
                <div className="settings-kv"><span>Telegram ID</span><strong>{localTgUserId ?? accountInfo?.id ?? '—'}</strong></div>
                <div className="settings-kv"><span>Name changes left</span><strong>{accountInfo?.nameChangeRemaining ?? 3}</strong></div>
                <div className="settings-ref">
                  <input type="text" readOnly value={referralDraft} />
                  <button type="button" onClick={() => { void onCopyReferral(); }}>Copy</button>
                </div>
                <input
                  type="text"
                  maxLength={24}
                  value={displayNameDraft}
                  onChange={(event) => setDisplayNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                                      }
                  }}
                  placeholder="Player name"
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
