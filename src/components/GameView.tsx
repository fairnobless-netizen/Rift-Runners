import { useEffect, useRef, useState, useCallback, type CSSProperties, type FormEvent, type Ref } from 'react';
import Phaser from 'phaser';
import { GameScene } from '../game/GameScene';
import { clearSoloResumeSnapshot, loadSoloResumeSnapshot, type SoloResumeSnapshotV1 } from '../game/soloResume';
import { GAME_CONFIG } from '../game/config';

import {
  EVENT_ASSET_PROGRESS,
  EVENT_CAMPAIGN_STATE,
  EVENT_READY,
  EVENT_SIMULATION,
  EVENT_STATS,
  EVENT_LIFE_STATE,
  EVENT_ZOOM_CHANGED,
  gameEvents,
  type AssetProgressPayload,
  type LifeStatePayload,
  type ReadyPayload,
  type ZoomChangedPayload,
} from '../game/gameEvents';

import {
  createInitialCampaignState,
  fetchCampaignFromBackend,
  getCampaignSyncStatus,
  loadCampaignState,
  saveCampaignState,
  type CampaignState,
} from '../game/campaign';

import type { ControlsState, Direction, PlayerStats, SimulationEvent } from '../game/types';
import type { MatchServerMessage } from '@shared/protocol';
import {
  buyShopSku,
  claimReferral,
  closeRoom,
  createRoom,
  fetchFriends,
  fetchMyRooms,
  fetchPublicRooms,
  fetchRoom,
  fetchLeaderboard,
  fetchShopCatalog,
  fetchShopOwned,
  fetchLedger,
  fetchWallet,
  joinRoom,
  kickRoomMember,
  leaveRoom,
  requestFriend,
  setRoomReady,
  startRoom,
  respondFriend,
  submitLeaderboard,
  submitTeamLeaderboard,
  type FriendEntry,
  type IncomingFriendRequest,
  type LeaderboardMeEntry,
  type LeaderboardMode,
  type LeaderboardTopEntry,
  type MyRoomEntry,
  type OutgoingFriendRequest,
  type PublicRoomEntry,
  type RoomMember,
  type RoomState,
  type ShopCatalogItem,
  type TeamLeaderboardMember,
  type WalletLedgerEntry,
} from '../game/wallet';
import { WsDebugOverlay } from './WsDebugOverlay';
import { MultiplayerInspectorOverlay } from './MultiplayerInspectorOverlay';
import { useWsClient } from '../ws/useWsClient';
import type { WsDebugMetrics } from '../ws/wsTypes';
import { resolveDevIdentity } from '../utils/devIdentity';
import { API_BASE, apiUrl } from '../utils/apiBase';
import {
  clearLastSession,
  saveLastSession,
  type LastSessionMeta,
} from '../utils/sessionStorage';
import { RROverlayModal } from './RROverlayModal';
import { MultiplayerModal } from './MultiplayerModal';
import { isDebugEnabled } from '../debug/debugFlags';
import { diagnosticsStore } from '../debug/diagnosticsStore';
import { DiagnosticsOverlay } from '../debug/DiagnosticsOverlay';


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
  localMode?: string;
  localRenderDriftTiles?: number;
  localSnapCount?: number;
};

type AudioSettings = {
  musicEnabled: boolean;
  sfxEnabled: boolean;
};

type AccountInfo = {
  id: string;
  displayName: string;
  gameUserId: string;
  gameNickname: string | null;
  referralLink: string;
  nameChangeRemaining: number;
};

type GameFlowPhase = 'intro' | 'start' | 'playing';
type RejoinPhase = 'idle' | 'rejoin_wait_ack' | 'rejoin_resetting' | 'rejoin_ready' | 'rejoin_applying' | 'rejoin_complete' | 'rejoin_failed';
type NicknameCheckState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'taken'
  | 'invalid'
  | 'auth_required'
  | 'server_error';

type MatchWorldInitMessage = Extract<
  MatchServerMessage,
  { type: 'match:world_init' }
>;

type MatchSnapshotMessage = Extract<
  MatchServerMessage,
  { type: 'match:snapshot' }
>;

type MatchRejoinAckMessage = Extract<
  MatchServerMessage,
  { type: 'mp:rejoin_ack' }
>;

function isMatchServerMessage(message: { type: string }): message is MatchServerMessage {
  return message.type.startsWith('match:') || message.type.startsWith('room:restart_') || message.type.startsWith('mp:');
}

function isMatchWorldInit(message: { type: string }): message is MatchWorldInitMessage {
  return isMatchServerMessage(message) && message.type === 'match:world_init';
}

const DEBUG_NICK = false;

type TutorialStep = {
  id: string;
  title: string;
  body: string;
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
const MP_RESUME_COUNTDOWN_START = 5;
const MP_RESUME_COUNTDOWN_STEP_MS = 1000;
const MP_RESUME_COUNTDOWN_FAILSAFE_MS = 7000;
const ONBOARDING_DONE_KEY = 'rift_onboarding_v1_done';
const MOBILE_ROTATE_OVERLAY_BREAKPOINT = 700;
const DISPLAY_NAME_KEY = 'rr_display_name_v1';
const PLAYER_ACCENT_PALETTE = ['#00ff00', '#ff0000', '#00aaff', '#ffffff'] as const;

function colorFromPlayerColorId(colorId: number): string {
  const paletteLength = PLAYER_ACCENT_PALETTE.length;
  const normalized = Number.isFinite(colorId)
    ? ((Math.trunc(colorId) % paletteLength) + paletteLength) % paletteLength
    : 0;
  return PLAYER_ACCENT_PALETTE[normalized];
}

type TelegramWebApp = {
  ready?: () => void;
  expand?: () => void;
  requestFullscreen?: () => void | Promise<void>;
  disableVerticalSwipes?: () => void;
  isExpanded?: boolean;
  viewportHeight?: number;
  viewportStableHeight?: number;
  contentSafeAreaInset?: { top: number; bottom: number; left: number; right: number };
  safeAreaInset?: { top: number; bottom: number; left: number; right: number };
  onEvent?: (eventType: 'viewportChanged' | 'safeAreaChanged' | 'contentSafeAreaChanged', handler: () => void) => void;
  offEvent?: (eventType: 'viewportChanged' | 'safeAreaChanged' | 'contentSafeAreaChanged', handler: () => void) => void;
};


function buildWsDebugMetrics(scene: GameScene, bombEventNetStats?: { serverTick: number; lastEventTick: number; eventsBuffered: number; eventsDroppedDup: number; eventsDroppedOutOfOrder: number }, bombGate?: { gated: boolean; reason: string | null }): WsDebugMetrics {
  const netInterpStats = scene.getNetInterpStats();
  const routingStats = scene.getSnapshotRoutingStats();

  return {
    snapshotTick: scene.getLastSnapshotTick(),
    lastAppliedSnapshotTick: scene.getLastAppliedSnapshotTick(),
    simulationTick: scene.getSimulationTick(),
    serverTick: bombEventNetStats?.serverTick ?? -1,
    lastEventTick: bombEventNetStats?.lastEventTick ?? -1,
    renderTick: netInterpStats.renderTick,
    baseDelayTicks: netInterpStats.baseDelayTicks,
    baseDelayTargetTicks: netInterpStats.baseDelayTargetTicks,
    baseDelayStepCooldownMs: netInterpStats.baseDelayStepCooldownMs,
    baseDelayStepCooldownTicks: netInterpStats.baseDelayStepCooldownTicks,
    delayTicks: netInterpStats.delayTicks,
    minDelayTicks: netInterpStats.minDelayTicks,
    maxDelayTicks: netInterpStats.maxDelayTicks,
    bufferSize: netInterpStats.bufferSize,
    eventsBuffered: bombEventNetStats?.eventsBuffered ?? 0,
    eventsDroppedDup: bombEventNetStats?.eventsDroppedDup ?? 0,
    eventsDroppedOutOfOrder: bombEventNetStats?.eventsDroppedOutOfOrder ?? 0,
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
    droppedWrongRoom: routingStats.droppedWrongRoom,
    invalidPosDrops: routingStats.invalidPosDrops,
    lastSnapshotRoom: routingStats.lastSnapshotRoom,
    worldReady: routingStats.worldReady,
    worldHashServer: routingStats.worldHashServer,
    worldHashClient: routingStats.worldHashClient,
    needsNetResync: routingStats.needsNetResync,
    netResyncReason: routingStats.netResyncReason,
    bombInputGated: bombGate?.gated ?? true,
    bombGateReason: bombGate?.reason ?? 'unknown',
  };
}

export default function GameView(): JSX.Element {
  const pageRef = useRef<HTMLElement | null>(null);
  const pageShellRef = useRef<HTMLElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<GameScene | null>(null);
  const inputSeqRef = useRef(0);
  const activeMoveDirRef = useRef<Direction | null>(null);

  const joystickTouchZoneRef = useRef<HTMLDivElement | null>(null);
  const joystickPadRef = useRef<HTMLDivElement | null>(null);
  const joystickPointerIdRef = useRef<number | null>(null);
  const joystickStartXRef = useRef(0);
  const joystickStartYRef = useRef(0);
  const hudLivesRef = useRef<HTMLSpanElement | null>(null);
  const handledMatchEventIdsRef = useRef<Set<string>>(new Set());
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
    respawning: false,
  });
  const [campaign, setCampaign] = useState<CampaignState>(() => loadCampaignState() ?? createInitialCampaignState());
  const [zoomBounds, setZoomBounds] = useState<{ min: number; max: number }>({ min: GAME_CONFIG.minZoom, max: GAME_CONFIG.maxZoom });
  const [zoom, setZoom] = useState<number>(GAME_CONFIG.minZoom);
  const [isRemoteDetonateUnlocked, setIsRemoteDetonateUnlocked] = useState(false);
  const [joystickPressed, setJoystickPressed] = useState(false);
  const [joystickOffset, setJoystickOffset] = useState({ x: 0, y: 0 });
  const [profileName, setProfileName] = useState<string>('—');
  const [token, setToken] = useState<string>(() => localStorage.getItem('rift_session_token') ?? '');
  // D1: show why a new user has no token (no secrets!)
  const [authDiag, setAuthDiag] = useState<string | null>(null);

  const [devIdentity] = useState(() => resolveDevIdentity(window.location.search));
  const [localTgUserId, setLocalTgUserId] = useState<string | undefined>(devIdentity.localFallbackTgUserId);
  const [, setWallet] = useState<{ stars: number; crystals: number }>({ stars: 0, crystals: 0 });
  const [, setSyncStatus] = useState<'synced' | 'offline'>('offline');
  const [storeItems, setStoreItems] = useState<ShopCatalogItem[]>([]);
  const [, setLedger] = useState<WalletLedgerEntry[]>([]);
  const [purchaseBusySku, setPurchaseBusySku] = useState<string | null>(null);
  const [isStoreOpen, setIsStoreOpen] = useState(false);
  const [storeTab, setStoreTab] = useState<'boosts' | 'cosmetics' | 'packs'>('boosts');
  const [ownedSkus, setOwnedSkus] = useState<string[]>([]);
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [predictionStats, setPredictionStats] = useState<PredictionStats | null>(null);
  const [ackLastInputSeq, setAckLastInputSeq] = useState(0);
  const [tickDebugStats, setTickDebugStats] = useState<WsDebugMetrics | null>(null);
  const [bombGateReason, setBombGateReason] = useState<string | null>('phase_not_started');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'audio' | 'account'>('audio');
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [leaderboardMode, setLeaderboardMode] = useState<LeaderboardMode>('solo');
  const [leaderboardTop, setLeaderboardTop] = useState<LeaderboardTopEntry[]>([]);
  const [leaderboardMe, setLeaderboardMe] = useState<LeaderboardMeEntry | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [multiplayerUiOpen, setMultiplayerUiOpen] = useState(false);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [joiningRoomCode, setJoiningRoomCode] = useState<string | null>(null);
  const [deepLinkJoinCode, setDeepLinkJoinCode] = useState<string | null>(null);
  const [, setMyRooms] = useState<MyRoomEntry[]>([]);
  const [publicRooms, setPublicRooms] = useState<PublicRoomEntry[]>([]);
  const [currentRoom, setCurrentRoom] = useState<RoomState | null>(null);
  const [currentRoomMembers, setCurrentRoomMembers] = useState<RoomMember[]>([]);
  const [multiplayerLivesByUserId, setMultiplayerLivesByUserId] = useState<Record<string, number>>({});
  const [multiplayerDisconnectedByUserId, setMultiplayerDisconnectedByUserId] = useState<Record<string, boolean>>({});
  const [multiplayerColorByUserId, setMultiplayerColorByUserId] = useState<Record<string, string>>({});
  const [currentMatchId, setCurrentMatchId] = useState<string | null>(null);
  const [restartVote, setRestartVote] = useState<{ active: boolean; yesCount: number; total: number; expiresAt: number | null } | null>(null);
  const [restartVoteNowMs, setRestartVoteNowMs] = useState<number>(() => Date.now());
  const [restartCooldownRetryAtMs, setRestartCooldownRetryAtMs] = useState<number | null>(null);
  const [restartCooldownNowMs, setRestartCooldownNowMs] = useState<number>(() => Date.now());
  const [spectatorRestartPromptDismissed, setSpectatorRestartPromptDismissed] = useState(false);
  const [matchEndState, setMatchEndState] = useState<{ winnerTgUserId: string | null; reason: 'elimination' | 'draw' } | null>(null);
  const expectedRoomCodeRef = useRef<string | null>(null);
  const expectedMatchIdRef = useRef<string | null>(null);
  const worldReadyRef = useRef(false);
  const firstSnapshotReadyRef = useRef(false);
  const pendingWorldInitRef = useRef<MatchWorldInitMessage | null>(null);
  const pendingSnapshotRef = useRef<MatchSnapshotMessage['snapshot'] | null>(null);
  const lastAppliedSnapshotTickRef = useRef<number | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [lastWorldInitAt, setLastWorldInitAt] = useState<number | null>(null);
  const [lastSnapshotAt, setLastSnapshotAt] = useState<number | null>(null);
  const [lastRecvSnapshotTick, setLastRecvSnapshotTick] = useState<number | null>(null);
  const [wrongRoomDrops, setWrongRoomDrops] = useState(0);
  const [wrongMatchDrops, setWrongMatchDrops] = useState(0);
  const [duplicateTickDrops, setDuplicateTickDrops] = useState(0);
  const processedWsMessagesRef = useRef(0);

  const wsJoinedRoomCodeRef = useRef<string | null>(null);
  const authReadyAtRef = useRef<number | null>(null);
  const userInteractedRef = useRef(false);
  const resumePromptShownRef = useRef(false);
  const pendingResumeIntentRef = useRef<{ roomCode: string; matchId: string | null } | null>(null);
  const resumeServerCheckDoneRef = useRef(false);
  const resumeIntentExecutedRef = useRef(false);
  const resumeRoomCodeRef = useRef<string | null>(null);
  const resumeExpectedMatchIdRef = useRef<string | null>(null);
  const resumeLifecycleActiveRef = useRef(false);
  const resumeWorldReadyLoggedRef = useRef(false);
  const resumeFirstSnapshotLoggedRef = useRef(false);
  const resumeInputUnblockedLoggedRef = useRef(false);
  const resumedActiveMatchIdRef = useRef<string | null>(null);
  const rejoinAttemptIdRef = useRef<string | null>(null);
  const rejoinCompletionSentRef = useRef(false);
  const [resumeJoinInProgress, setResumeJoinInProgress] = useState(false);
  const [rejoinPhase, setRejoinPhase] = useState<RejoinPhase>('idle');
  const [resumeModal, setResumeModal] = useState<{ open: boolean; roomCode: string; matchId: string | null } | null>(null);
  const [mpResumeCountdownActive, setMpResumeCountdownActive] = useState(false);
  const [mpResumeCountdownValue, setMpResumeCountdownValue] = useState(0);
  const mpResumeCountdownIntervalRef = useRef<number | null>(null);
  const mpResumeCountdownFailsafeRef = useRef<number | null>(null);
  const initialSoloResumeSnapshotRef = useRef<SoloResumeSnapshotV1 | null>(loadSoloResumeSnapshot());
  const [isSoloResumeFlow] = useState<boolean>(() => {
    const snapshot = initialSoloResumeSnapshotRef.current;
    return Boolean(snapshot && snapshot.campaignState.soloGameOver !== true);
  });
  const [soloResumeModalOpen, setSoloResumeModalOpen] = useState<boolean>(() => {
    const snapshot = initialSoloResumeSnapshotRef.current;
    return Boolean(snapshot && snapshot.campaignState.soloGameOver !== true);
  });
  const [soloStartReady, setSoloStartReady] = useState<boolean>(() => !soloResumeModalOpen);

  const stopMpResumeCountdown = useCallback((): void => {
    if (mpResumeCountdownIntervalRef.current != null) {
      window.clearInterval(mpResumeCountdownIntervalRef.current);
      mpResumeCountdownIntervalRef.current = null;
    }
    if (mpResumeCountdownFailsafeRef.current != null) {
      window.clearTimeout(mpResumeCountdownFailsafeRef.current);
      mpResumeCountdownFailsafeRef.current = null;
    }
    setMpResumeCountdownActive(false);
    setMpResumeCountdownValue(0);
  }, []);

  const startMpResumeCountdown = useCallback((): void => {
    stopMpResumeCountdown();
    setMpResumeCountdownActive(true);
    setMpResumeCountdownValue(MP_RESUME_COUNTDOWN_START);

    mpResumeCountdownIntervalRef.current = window.setInterval(() => {
      setMpResumeCountdownValue((prev) => {
        if (prev <= 1) {
          stopMpResumeCountdown();
          return 0;
        }
        return prev - 1;
      });
    }, MP_RESUME_COUNTDOWN_STEP_MS);

    mpResumeCountdownFailsafeRef.current = window.setTimeout(() => {
      stopMpResumeCountdown();
    }, MP_RESUME_COUNTDOWN_FAILSAFE_MS);
  }, [stopMpResumeCountdown]);

  const resetResumeAttemptState = useCallback((nextPhase: RejoinPhase = 'idle'): void => {
    if (resumeLifecycleActiveRef.current) {
      diagnosticsStore.log('ROOM', 'INFO', 'resume_exit', { nextPhase });
    }
    resumeLifecycleActiveRef.current = false;
    resumeWorldReadyLoggedRef.current = false;
    resumeFirstSnapshotLoggedRef.current = false;
    resumeInputUnblockedLoggedRef.current = false;
    resumedActiveMatchIdRef.current = null;
    setResumeJoinInProgress(false);
    setRejoinPhase(nextPhase);
    resumeRoomCodeRef.current = null;
    resumeExpectedMatchIdRef.current = null;
    rejoinAttemptIdRef.current = null;
    pendingWorldInitRef.current = null;
    pendingSnapshotRef.current = null;
    rejoinCompletionSentRef.current = false;
    pendingResumeIntentRef.current = null;
    resumeIntentExecutedRef.current = false;
  }, []);
  const handleResumeFailure = useCallback((message: string, options?: { stale?: boolean; nextPhase?: RejoinPhase }): void => {
    setRoomsError(message);
    if (options?.stale !== false) {
      clearLastSession();
    }
    resetResumeAttemptState(options?.nextPhase ?? 'rejoin_failed');
    stopMpResumeCountdown();
    setMultiplayerUiOpen(false);
    setDeepLinkJoinCode(null);
  }, [resetResumeAttemptState, stopMpResumeCountdown]);
  const cancelResumeAttemptByUser = useCallback((): void => {
    const cancellable = rejoinPhase === 'rejoin_wait_ack' || rejoinPhase === 'rejoin_resetting' || rejoinPhase === 'rejoin_applying';
    if (!resumeJoinInProgress || !cancellable) return;

    resetResumeAttemptState('idle');
    stopMpResumeCountdown();
    setMultiplayerUiOpen(false);
    setDeepLinkJoinCode(null);
    if (isDebugEnabled(window.location.search)) {
      diagnosticsStore.log('ROOM', 'INFO', 'rejoin:cancelled_by_user', { phase: rejoinPhase });
    }
  }, [rejoinPhase, resetResumeAttemptState, resumeJoinInProgress, stopMpResumeCountdown]);
  const resetMpMatchRuntimeForNewMatch = useCallback((nextMatchId: string): void => {
    expectedMatchIdRef.current = nextMatchId;
    setCurrentMatchId(nextMatchId);
    worldReadyRef.current = false;
    firstSnapshotReadyRef.current = false;
    pendingWorldInitRef.current = null;
    pendingSnapshotRef.current = null;
    lastAppliedSnapshotTickRef.current = null;
    handledMatchEventIdsRef.current.clear();
    processedWsMessagesRef.current = 0;
    setRestartVote(null);
    setMatchEndState(null);
    setSpectatorRestartPromptDismissed(false);
    setRestartCooldownRetryAtMs(null);
    setRoomsError(null);
    sceneRef.current?.setActiveMultiplayerSession(expectedRoomCodeRef.current, nextMatchId);
    sceneRef.current?.resetMultiplayerNetState();
  }, []);

  const resetMpMatchRuntimeAwaitingMatchStart = useCallback((): void => {
    expectedMatchIdRef.current = null;
    setCurrentMatchId(null);
    worldReadyRef.current = false;
    firstSnapshotReadyRef.current = false;
    pendingWorldInitRef.current = null;
    pendingSnapshotRef.current = null;
    lastAppliedSnapshotTickRef.current = null;
    handledMatchEventIdsRef.current.clear();
    processedWsMessagesRef.current = 0;
    setRestartVote(null);
    setMatchEndState(null);
    setSpectatorRestartPromptDismissed(false);
    setRestartCooldownRetryAtMs(null);
    setRoomsError(null);
    setLifeState((prev) => ({
      ...prev,
      awaitingContinue: false,
      gameOver: false,
      eliminated: false,
      respawning: false,
    }));
    sceneRef.current?.setActiveMultiplayerSession(expectedRoomCodeRef.current, null);
    sceneRef.current?.resetMultiplayerNetState();
  }, []);

  const switchToNextMatch = useCallback((nextMatchId: string): void => {
    resetMpMatchRuntimeForNewMatch(nextMatchId);
    sceneRef.current?.forceEnterMatchStarted();
    setGameFlowPhase('playing');
    setMatchEndState(null);
    setRestartVote(null);
    setSpectatorRestartPromptDismissed(false);
    setLifeState((prev) => ({
      ...prev,
      awaitingContinue: false,
      gameOver: false,
      eliminated: false,
      respawning: false,
    }));
  }, [resetMpMatchRuntimeForNewMatch]);

  const [settingReady, setSettingReady] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [startingRoom, setStartingRoom] = useState(false);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [friendsList, setFriendsList] = useState<FriendEntry[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<IncomingFriendRequest[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<OutgoingFriendRequest[]>([]);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>({ musicEnabled: true, sfxEnabled: true });
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [nicknameCheckState, setNicknameCheckState] = useState<NicknameCheckState>('idle');
  const [nicknameSubmitError, setNicknameSubmitError] = useState<string | null>(null);
  const [nicknameSubmitting, setNicknameSubmitting] = useState(false);
  const [gameUserIdCopied, setGameUserIdCopied] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState<boolean>(() => !(localStorage.getItem(DISPLAY_NAME_KEY) ?? '').trim());
  const lastSubmittedLeaderboardMatchIdRef = useRef<string>('');
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
  const markUserInteracted = useCallback((): void => {
    userInteractedRef.current = true;
  }, []);

  const maybeCompleteRejoinFromAppliedSnapshot = useCallback((appliedSnapshot: MatchSnapshotMessage['snapshot']): void => {
    if (!resumeJoinInProgress || rejoinCompletionSentRef.current) return;

    const expectedRoomCode = expectedRoomCodeRef.current;
    const expectedMatchId = expectedMatchIdRef.current;
    const gotRoomCode = appliedSnapshot.roomCode ?? null;
    const gotMatchId = appliedSnapshot.matchId ?? null;
    if (!expectedRoomCode || !expectedMatchId || gotRoomCode !== expectedRoomCode || gotMatchId !== expectedMatchId) {
      return;
    }

    rejoinCompletionSentRef.current = true;
    worldReadyRef.current = true;
    firstSnapshotReadyRef.current = true;
    lastAppliedSnapshotTickRef.current = appliedSnapshot.tick;

    ws.send({
      type: 'mp:snapshot_applied',
      matchId: appliedSnapshot.matchId,
      rejoinAttemptId: rejoinAttemptIdRef.current ?? undefined,
    }, { roomCode: appliedSnapshot.roomCode, expectedMatchId: appliedSnapshot.matchId });

    resetResumeAttemptState('rejoin_complete');
  }, [resetResumeAttemptState, resumeJoinInProgress, ws]);

  const sendMatchMoveIntent = useCallback((dir: Direction | null): void => {
    const expectedRoomCode = expectedRoomCodeRef.current;
    const expectedMatchId = expectedMatchIdRef.current;
    const phase = currentRoom?.phase ?? 'LOBBY';
    const scene = sceneRef.current;
    const needsNetResync = scene?.getSnapshotRoutingStats().needsNetResync ?? true;
    const lastSnapshotAgeMs = lastSnapshotAt == null ? null : Math.max(0, Date.now() - lastSnapshotAt);
    const phaseStartedByResumeEvidence = Boolean(
      resumedActiveMatchIdRef.current
      && expectedMatchId
      && resumedActiveMatchIdRef.current === expectedMatchId
      && worldReadyRef.current
      && firstSnapshotReadyRef.current,
    );

    let gateReason: string | null = null;
    if (!ws.connected) {
      gateReason = 'ws_not_ready';
    } else if (!expectedRoomCode || !expectedMatchId) {
      gateReason = 'no_match';
    } else if (!worldReadyRef.current) {
      gateReason = 'world_not_ready';
    } else if (needsNetResync) {
      gateReason = 'await_net_resync';
    } else if (mpResumeCountdownActive) {
      gateReason = 'resume_countdown';
    } else if ((phase !== 'STARTED' && !phaseStartedByResumeEvidence) || gameFlowPhase !== 'playing') {
      gateReason = 'phase_not_started';
    }

    diagnosticsStore.log('ROOM', 'INFO', 'input_gate_eval', {
      wsConnected: ws.connected,
      roomCode: expectedRoomCode ?? currentRoom?.roomCode ?? null,
      matchId: expectedMatchId ?? null,
      worldReady: worldReadyRef.current,
      currentPhase: phase,
      matchPhase: gameFlowPhase,
      lastSnapshotAgeMs,
      gateDecision: gateReason == null ? 'allow' : 'deny',
      gateReason,
    });

    if (gateReason) {
      setBombGateReason(gateReason);
      return;
    }

    if (!scene) return;

    if (resumeLifecycleActiveRef.current && !resumeInputUnblockedLoggedRef.current) {
      resumeInputUnblockedLoggedRef.current = true;
      diagnosticsStore.log('ROOM', 'INFO', 'input_gate_unblocked_after_resume', {
        roomCode: expectedRoomCode,
        matchId: expectedMatchId,
      });
    }

    const seq = inputSeqRef.current + 1;
    inputSeqRef.current = seq;

    if (dir) {
      const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
      const dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
      scene.onLocalMatchInput({ seq, dx, dy });
    }

    ws.send(
      { type: 'match:input', seq, payload: { kind: 'move', dir } },
      {
        roomCode: expectedRoomCode,
        expectedMatchId,
      },
    );
  }, [currentRoom?.phase, currentRoom?.roomCode, gameFlowPhase, lastSnapshotAt, mpResumeCountdownActive, ws]);

  const isMultiplayerDebugEnabled = isDebugEnabled(window.location.search);
  const wsDiagnostics = {
    enabled: isMultiplayerDebugEnabled,
    status: ws.connected ? 'OPEN' : ws.lastError ? 'ERROR' : 'CONNECTING',
    apiBase: API_BASE || window.location.origin,
    wsUrl: ws.urlUsed || 'n/a',
    roomCode: currentRoom?.roomCode ?? null,
    members: currentRoomMembers.length,
    lastError: ws.lastError,
  } as const;

  useEffect(() => {
    if (!isMultiplayerDebugEnabled) return;
    diagnosticsStore.setWsState({
      wsUrlUsed: ws.urlUsed || null,
      status: ws.connected ? 'OPEN' : ws.lastError ? 'ERROR' : 'CONNECTING',
      lastError: ws.lastError ?? null,
    });
  }, [isMultiplayerDebugEnabled, ws.connected, ws.lastError, ws.urlUsed]);


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

  const isMultiplayerMode = Boolean(currentRoom && currentRoomMembers.length >= 2);
  const isRoomOwner = Boolean(localTgUserId && currentRoom?.ownerTgUserId && localTgUserId === currentRoom.ownerTgUserId);
  const roomCanStart = Boolean(
    isRoomOwner
    && (currentRoom?.phase ?? 'LOBBY') !== 'STARTED'
    && currentRoomMembers.some((member) => member.tgUserId !== currentRoom?.ownerTgUserId)
    && currentRoomMembers
      .filter((member) => member.tgUserId !== currentRoom?.ownerTgUserId)
      .every((member) => member.ready ?? false),
  );
  const rejoinOverlayActive = rejoinPhase !== 'idle' && rejoinPhase !== 'rejoin_complete' && rejoinPhase !== 'rejoin_failed';
  const isMpResumeFlow = Boolean(resumeModal?.open || resumeJoinInProgress || rejoinOverlayActive);
  const isInputLocked = gameFlowPhase !== 'playing' || tutorialActive;
  const isMobileViewport = Math.min(viewportSize.width, viewportSize.height) < MOBILE_ROTATE_OVERLAY_BREAKPOINT;
  const isPortraitViewport = viewportSize.height >= viewportSize.width;
  const shouldShowRotateOverlay = isMobileViewport && isPortraitViewport;
  const deathOverlayVisible = lifeState.awaitingContinue || lifeState.gameOver;
  const isEliminatedSpectator = isMultiplayerMode && lifeState.eliminated && currentRoom?.phase === 'STARTED';
  const isInteractionBlocked = isInputLocked || shouldShowRotateOverlay || deathOverlayVisible || lifeState.eliminated || lifeState.respawning;
  const isRestartVoteActive = restartVote?.active === true;
  const restartVoteRemainingMs = isRestartVoteActive && restartVote?.expiresAt
    ? Math.max(0, restartVote.expiresAt - restartVoteNowMs)
    : 0;
  const restartVoteProgress = isRestartVoteActive && restartVote?.expiresAt
    ? Math.max(0, Math.min(1, restartVoteRemainingMs / 10_000))
    : 0;
  const restartCooldownRemainingMs = restartCooldownRetryAtMs
    ? Math.max(0, restartCooldownRetryAtMs - restartCooldownNowMs)
    : 0;
  const restartCooldownRemainingSec = Math.ceil(restartCooldownRemainingMs / 1000);
  const showAliveRestartVotePrompt = isMultiplayerMode
    && gameFlowPhase === 'playing'
    && !lifeState.eliminated
    && isRestartVoteActive;
  const showSpectatorRestartVotePrompt = isMultiplayerMode
    && gameFlowPhase === 'playing'
    && lifeState.eliminated
    && isRestartVoteActive;
  const showSpectatorRestartProposePrompt = isMultiplayerMode
    && gameFlowPhase === 'playing'
    && lifeState.eliminated
    && !isRestartVoteActive
    && !spectatorRestartPromptDismissed;
  const shellSizeRef = useRef<{ width: number; height: number }>({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    if (!isMultiplayerDebugEnabled) return;
    diagnosticsStore.setRoomState({
      roomCode: currentRoom?.roomCode ?? null,
      members: currentRoomMembers.length,
      isHost: isRoomOwner,
      canStart: roomCanStart,
      phase: currentRoom?.phase ?? null,
    });
    diagnosticsStore.log('ROOM', 'INFO', 'room:update', {
      roomCode: currentRoom?.roomCode ?? null,
      members: currentRoomMembers.length,
      isHost: isRoomOwner,
      canStart: roomCanStart,
      phase: currentRoom?.phase ?? null,
    });
  }, [isMultiplayerDebugEnabled, currentRoom?.roomCode, currentRoom?.phase, currentRoomMembers.length, isRoomOwner, roomCanStart]);

  useEffect(() => {
    const phase = currentRoom?.phase ?? 'LOBBY';
    if (phase !== 'STARTED') return;

    if (multiplayerUiOpen) {
      setMultiplayerUiOpen(false);
      setDeepLinkJoinCode(null);

      if (isMultiplayerDebugEnabled) {
        diagnosticsStore.log('UI', 'INFO', 'multiplayer:auto_close_on_started', {
          roomCode: currentRoom?.roomCode ?? null,
          phase,
        });
      }
    }
  }, [currentRoom?.phase, currentRoom?.roomCode, multiplayerUiOpen, isMultiplayerDebugEnabled]);

  useEffect(() => {
    if (!isRestartVoteActive) {
      return;
    }

    setRestartVoteNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setRestartVoteNowMs(Date.now());
    }, 100);

    return () => window.clearInterval(intervalId);
  }, [isRestartVoteActive, restartVote?.expiresAt]);

  useEffect(() => {
    if (!restartCooldownRetryAtMs) {
      return;
    }

    if (restartCooldownRetryAtMs <= Date.now()) {
      setRestartCooldownRetryAtMs(null);
      return;
    }

    setRestartCooldownNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      const now = Date.now();
      setRestartCooldownNowMs(now);
      if (restartCooldownRetryAtMs <= now) {
        setRestartCooldownRetryAtMs(null);
      }
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [restartCooldownRetryAtMs]);

  useEffect(() => {
    if (isRestartVoteActive) {
      setSpectatorRestartPromptDismissed(false);
      return;
    }

    if (!lifeState.eliminated) {
      setSpectatorRestartPromptDismissed(false);
    }
  }, [isRestartVoteActive, lifeState.eliminated]);

  const updateTgMetrics = useCallback((): void => {
    const tg = (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
    const insets = tg?.contentSafeAreaInset ?? tg?.safeAreaInset;
    const top = insets?.top ?? 0;
    const right = insets?.right ?? 0;
    const bottom = insets?.bottom ?? 0;
    const left = insets?.left ?? 0;
    const viewportHeight = tg?.viewportHeight ?? window.innerHeight;
    const stableHeight = tg?.viewportStableHeight ?? viewportHeight;
    const root = document.documentElement;
    const isAndroid = root.classList.contains('is-android');
    const androidOverlayTop = isAndroid ? (top < 20 ? 48 : 0) : 0;
    const androidOverlayRight = isAndroid ? (right < 20 ? 40 : 0) : 0;

    root.style.setProperty('--tg-viewport-h', `${Math.floor(viewportHeight)}px`);
    root.style.setProperty('--tg-viewport-stable-h', `${Math.floor(stableHeight)}px`);
    root.style.setProperty('--tg-content-top', `${Math.floor(top)}px`);
    root.style.setProperty('--tg-content-right', `${Math.floor(right)}px`);
    root.style.setProperty('--tg-content-bottom', `${Math.floor(bottom)}px`);
    root.style.setProperty('--tg-content-left', `${Math.floor(left)}px`);
    root.style.setProperty('--android-overlay-top', `${androidOverlayTop}px`);
    root.style.setProperty('--android-overlay-right', `${androidOverlayRight}px`);
    root.style.setProperty('--android-overlay-bottom', '0px');
  }, []);

  useEffect(() => {
    const tg = (window as any)?.Telegram?.WebApp;

    if (isMultiplayerDebugEnabled) {
      const startParam = tg?.initDataUnsafe?.start_param;
      const userId = tg?.initDataUnsafe?.user?.id;
      const maskedUserId = userId == null ? null : `***${String(userId).slice(-4)}`;
      diagnosticsStore.setAuthState({
        telegramPresent: Boolean(tg),
        startParamPresent: Boolean(startParam),
        userIdMasked: maskedUserId,
        nickname: profileName || null,
        reasonIfNotTelegram: tg ? null : 'Telegram WebApp unavailable',
      });
      diagnosticsStore.log('AUTH', 'INFO', 'telegram:init', {
        telegramPresent: Boolean(tg),
        startParamPresent: Boolean(startParam),
        userIdMasked: maskedUserId,
        nickname: profileName || null,
      });
    }

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
              : joystickTouchZoneRef.current;

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
    if (isMultiplayerMode && mpResumeCountdownActive) {
      controlsRef.current.up = false;
      controlsRef.current.down = false;
      controlsRef.current.left = false;
      controlsRef.current.right = false;
      if (activeMoveDirRef.current !== null) {
        activeMoveDirRef.current = null;
        sendMatchMoveIntent(null);
      }
      return;
    }

    controlsRef.current.up = direction === 'up';
    controlsRef.current.down = direction === 'down';
    controlsRef.current.left = direction === 'left';
    controlsRef.current.right = direction === 'right';

    // Multiplayer movement uses intent-state updates only on transitions.
    if (!isMultiplayerMode || !currentRoom) {
      return;
    }

    if (activeMoveDirRef.current === direction) {
      return;
    }

    activeMoveDirRef.current = direction;
    sendMatchMoveIntent(direction);
  };

  const clearMovement = (): void => {
    setMovementFromDirection(null);
  };

  useEffect(() => {
    if (!mpResumeCountdownActive) return;
    controlsRef.current.up = false;
    controlsRef.current.down = false;
    controlsRef.current.left = false;
    controlsRef.current.right = false;
    if (isMultiplayerMode && activeMoveDirRef.current !== null) {
      activeMoveDirRef.current = null;
      sendMatchMoveIntent(null);
    }
  }, [isMultiplayerMode, mpResumeCountdownActive, sendMatchMoveIntent]);


  const applyAudioSettings = useCallback((next: AudioSettings): void => {
    sceneRef.current?.setAudioSettings(next);
  }, []);

  const loadSettingsAndAccount = useCallback(async (authToken: string): Promise<void> => {
    const headers = { Authorization: `Bearer ${authToken}` };

    const [settingsRes, accountRes] = await Promise.all([
      fetch(apiUrl('/api/settings/me'), { headers }),
      fetch(apiUrl('/api/profile/account'), { headers }),
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
          gameUserId: String(accountJson.account.gameUserId ?? ''),
          gameNickname: accountJson.account.gameNickname == null ? null : String(accountJson.account.gameNickname),
          referralLink: String(accountJson.account.referralLink ?? ''),
          nameChangeRemaining: Number(accountJson.account.nameChangeRemaining ?? 3),
        };
        setAccountInfo(account);

        if (account.displayName) {
          localStorage.setItem(DISPLAY_NAME_KEY, account.displayName);
        }

        // IMPORTANT: in-game visible name should prefer game nickname
        const preferredName = (account.gameNickname ?? '').trim() || account.displayName || (localStorage.getItem(DISPLAY_NAME_KEY) ?? '').trim() || '—';
        setProfileName(preferredName);

        // Show nickname registration only if missing on backend
        setRegistrationOpen(!account.gameNickname);
      }
    }
  }, [applyAudioSettings]);

  const persistAudioSettings = useCallback(async (next: AudioSettings): Promise<void> => {
    setAudioSettings(next);
    applyAudioSettings(next);

    if (!token) return;

    await fetch(apiUrl('/api/settings/me'), {
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
      // D1: capture why auth/token bootstrap fails for new users (do NOT log secrets)
      setAuthDiag(null);

      try {
        const initDataRetryIntervalMs = 150;
        const initDataMaxAttempts = 20;
        let tgInitData = (window as any)?.Telegram?.WebApp?.initData ?? '';
        let initDataLen = typeof tgInitData === 'string' ? tgInitData.length : 0;
        let initDataAttemptCount = 0;

        if (!tgInitData || initDataLen === 0) {
          if (isMultiplayerDebugEnabled) {
            diagnosticsStore.log('ROOM', 'INFO', 'auth:initData_empty_initial', { attemptCount: initDataAttemptCount });
          }

          while (initDataAttemptCount < initDataMaxAttempts && (!tgInitData || initDataLen === 0)) {
            initDataAttemptCount += 1;
            await new Promise<void>((resolve) => window.setTimeout(resolve, initDataRetryIntervalMs));
            tgInitData = (window as any)?.Telegram?.WebApp?.initData ?? '';
            initDataLen = typeof tgInitData === 'string' ? tgInitData.length : 0;
          }

          if (tgInitData && initDataLen > 0) {
            if (isMultiplayerDebugEnabled) {
              diagnosticsStore.log('ROOM', 'INFO', 'auth:initData_available_after_retry', {
                attemptCount: initDataAttemptCount,
                initDataLen,
              });
            }
          } else {
            if (isMultiplayerDebugEnabled) {
              diagnosticsStore.log('ROOM', 'WARN', 'auth:initData_empty_exhausted', {
                attemptCount: initDataAttemptCount,
              });
            }
            setAuthDiag('Auth failed: Telegram initData is empty. Please reopen from Telegram.');
            return;
          }
        }

        initDataLen = typeof tgInitData === 'string' ? tgInitData.length : 0;

        const authRes = await fetch(apiUrl('/api/auth/telegram'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: tgInitData }),
        });

        const contentType = authRes.headers.get('content-type') ?? '';
        const rawText = await authRes.text();

        let authJson: any = null;
        if (contentType.includes('application/json')) {
          try {
            authJson = rawText ? JSON.parse(rawText) : null;
          } catch {
            authJson = null;
          }
        }

        if (!authRes.ok) {
          const msg =
            (authJson && (authJson.error || authJson.message))
              ? String(authJson.error || authJson.message)
              : rawText
                ? String(rawText).slice(0, 140).replace(/\s+/g, ' ')
                : 'No response body';

          setAuthDiag(
            `Auth failed: status=${authRes.status} ${authRes.statusText}. ${msg} (initDataLen=${initDataLen}, contentType=${contentType || 'n/a'})`,
          );
          return;
        }

        if (!authJson || !authJson.ok) {
          const msg =
            (authJson && (authJson.error || authJson.message))
              ? String(authJson.error || authJson.message)
              : rawText
                ? String(rawText).slice(0, 140).replace(/\s+/g, ' ')
                : 'Unexpected non-JSON response';

          setAuthDiag(`Auth failed: ok=false. ${msg} (initDataLen=${initDataLen}, contentType=${contentType || 'n/a'})`);
          return;
        }

        const token = String(authJson.token ?? '');
        if (!token) {
          setAuthDiag(`Auth failed: token missing in response (initDataLen=${initDataLen}).`);
          return;
        }

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
              const local = loadCampaignState() ?? createInitialCampaignState();
              saveCampaignState(local); // this will POST best-effort now that token exists
            }
          }
        } catch {
          // ignore
        }

        // Best-effort profile name; if this fails, keep going
        try {
          const meRes = await fetch(apiUrl('/api/profile/me'), {
            headers: { Authorization: `Bearer ${token}` },
          });

          const meContentType = meRes.headers.get('content-type') ?? '';
          const meRaw = await meRes.text();
          const meJson = meContentType.includes('application/json') ? JSON.parse(meRaw || 'null') : null;

          if (meJson?.ok) {
            const backendName = String(meJson.user?.displayName ?? '—');
            setProfileName(devIdentity.displayNameOverride ?? backendName);
          }
        } catch {
          // ignore
        }

        await loadSettingsAndAccount(token);

        const [w, nextLedger] = await Promise.all([
          fetchWallet(),
          fetchLedger(20),
        ]);
        if (w) setWallet(w);
        setLedger(nextLedger);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setAuthDiag(`Auth error: ${msg}`);
        // keep silent otherwise (dev may run without backend)
      }

      setProfileName((prev) => {
        if (devIdentity.displayNameOverride) return devIdentity.displayNameOverride;
        return prev === '—' ? 'Dev Player' : prev;
      });
    };

    // TODO backend: in production handle auth errors + refresh/retry strategy
    runAuth();
  }, [devIdentity.displayNameOverride, isMultiplayerDebugEnabled, loadSettingsAndAccount]);


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

    if (!scene) {
      setTickDebugStats(null);
      return;
    }

    setTickDebugStats(buildWsDebugMetrics(scene, ws.bombEventNetStats, { gated: Boolean(bombGateReason), reason: bombGateReason }));
  }, 350);

  return () => window.clearInterval(id);
}, [ws.bombEventNetStats, bombGateReason]);


  useEffect(() => {
    const onStats = (nextStats: PlayerStats): void => {
      setStats({ ...nextStats });
      setIsRemoteDetonateUnlocked(nextStats.remoteDetonateUnlocked);
    };
    const onReady = (payload: ReadyPayload): void => {
      zoomApiRef.current = payload;
      setZoomBounds({ min: payload.minZoom, max: payload.maxZoom });
      const minZoom = payload.minZoom;
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
    const onZoomChanged = (payload: ZoomChangedPayload): void => {
      const clamped = Math.max(zoomBounds.min, Math.min(zoomBounds.max, payload.zoom));
      setZoom(clamped);
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
    gameEvents.on(EVENT_ZOOM_CHANGED, onZoomChanged);

    return () => {
      gameEvents.off(EVENT_STATS, onStats);
      gameEvents.off(EVENT_READY, onReady);
      gameEvents.off(EVENT_CAMPAIGN_STATE, onCampaignState);
      gameEvents.off(EVENT_ASSET_PROGRESS, onAssetProgress);
      gameEvents.off(EVENT_SIMULATION, onSimulation);
      gameEvents.off(EVENT_LIFE_STATE, onLifeState);
      gameEvents.off(EVENT_ZOOM_CHANGED, onZoomChanged);
    };
  }, [zoomBounds.max, zoomBounds.min]);

  useEffect(() => {
    if (!mountRef.current || !soloStartReady) return;

    const scene = new GameScene(controlsRef.current, initialSoloResumeSnapshotRef.current);
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
  }, [soloStartReady]);


  useEffect(() => {
    applyAudioSettings(audioSettings);
  }, [applyAudioSettings, audioSettings]);

  useEffect(() => {
    sceneRef.current?.setLocalTgUserId(localTgUserId);
  }, [localTgUserId]);

  useEffect(() => {
    if (!localTgUserId || authReadyAtRef.current != null) {
      return;
    }

    authReadyAtRef.current = Date.now();
  }, [localTgUserId]);

  useEffect(() => {
    const localName = (localStorage.getItem(DISPLAY_NAME_KEY) ?? '').trim();
    if (!localName) return;
    setProfileName((prev) => (prev === '—' || prev === 'Dev Player' ? localName : prev));
  }, []);



  useEffect(() => {
    sceneRef.current?.setActiveMultiplayerSession(currentRoom?.roomCode ?? null, currentMatchId);
  }, [currentRoom?.roomCode, currentMatchId]);

  useEffect(() => {
    const nextRoomCode = currentRoom?.roomCode ?? null;
    const prevRoomCode = expectedRoomCodeRef.current;
    expectedRoomCodeRef.current = nextRoomCode;

    if (prevRoomCode !== nextRoomCode) {
      expectedMatchIdRef.current = null;
      worldReadyRef.current = false;
      firstSnapshotReadyRef.current = false;
      pendingWorldInitRef.current = null;
      pendingSnapshotRef.current = null;
      lastAppliedSnapshotTickRef.current = null;
      setCurrentMatchId(null);
      setRestartCooldownRetryAtMs(null);
    setRestartCooldownRetryAtMs(null);
      setRestartVote(null);
      setMatchEndState(null);
      setRestartCooldownRetryAtMs(null);
      setRoomsError(null);
      setWrongRoomDrops(0);
      setWrongMatchDrops(0);
      setDuplicateTickDrops(0);
      setMultiplayerLivesByUserId({});
      setMultiplayerDisconnectedByUserId({});
      setLastWorldInitAt(null);
      setLastSnapshotAt(null);
      setLastRecvSnapshotTick(null);
      handledMatchEventIdsRef.current.clear();
      processedWsMessagesRef.current = 0;
    }
  }, [currentRoom?.roomCode]);


  useEffect(() => {
    if (!ws.connected || !currentRoom?.roomCode || !localTgUserId) return;

    const roomId = currentRoom.roomCode;
    const joinKey = `${roomId}:${localTgUserId}`;
    if (wsJoinedRoomCodeRef.current === joinKey) return;

    ws.send({ type: 'room:join', roomId, tgUserId: localTgUserId });
    wsJoinedRoomCodeRef.current = joinKey;
  }, [currentRoom?.roomCode, localTgUserId, ws.connected, ws]);

  useEffect(() => {
    if (currentRoom?.roomCode) return;
    wsJoinedRoomCodeRef.current = null;
    worldReadyRef.current = false;
    firstSnapshotReadyRef.current = false;
    pendingWorldInitRef.current = null;
    pendingSnapshotRef.current = null;
    lastAppliedSnapshotTickRef.current = null;
    setCurrentMatchId(null);
    setMultiplayerLivesByUserId({});
    setMultiplayerDisconnectedByUserId({});
    handledMatchEventIdsRef.current.clear();
  }, [currentRoom?.roomCode]);

  useEffect(() => {
    if (!ws.connected) {
      wsJoinedRoomCodeRef.current = null;
      expectedMatchIdRef.current = null;
      worldReadyRef.current = false;
      firstSnapshotReadyRef.current = false;
      pendingWorldInitRef.current = null;
      pendingSnapshotRef.current = null;
      lastAppliedSnapshotTickRef.current = null;
      setCurrentMatchId(null);
      setMultiplayerLivesByUserId({});
      setMultiplayerDisconnectedByUserId({});
      handledMatchEventIdsRef.current.clear();
      rejoinAttemptIdRef.current = null;
      setRejoinPhase('idle');
      sceneRef.current?.resetMultiplayerNetState();
    }
  }, [ws.connected]);


  useEffect(() => {
    if (!resumeJoinInProgress) return;
    if (rejoinPhase !== 'rejoin_wait_ack') return;

    const lastAck = [...ws.messages].reverse().find((message): message is MatchRejoinAckMessage => message.type === 'mp:rejoin_ack');
    if (!lastAck) return;

    const expectedRoomCode = expectedRoomCodeRef.current;
    if (!expectedRoomCode || lastAck.roomCode !== expectedRoomCode) {
      diagnosticsStore.log('ROOM', 'WARN', 'rejoin:drop_ack_room_mismatch', {
        expectedRoomCode,
        gotRoomCode: lastAck.roomCode ?? null,
        gotMatchId: lastAck.matchId ?? null,
        gotAttemptId: lastAck.rejoinAttemptId ?? null,
      });
      return;
    }

    if (resumeExpectedMatchIdRef.current && resumeExpectedMatchIdRef.current !== lastAck.matchId) {
      handleResumeFailure('Resume failed: match changed, old resume context discarded.');
      return;
    }

    rejoinAttemptIdRef.current = lastAck.rejoinAttemptId;
    setRejoinPhase('rejoin_resetting');
    expectedMatchIdRef.current = lastAck.matchId;
    setCurrentMatchId(lastAck.matchId);
    worldReadyRef.current = false;
    firstSnapshotReadyRef.current = false;
    rejoinCompletionSentRef.current = false;
    pendingWorldInitRef.current = null;
    pendingSnapshotRef.current = null;
    lastAppliedSnapshotTickRef.current = null;
    handledMatchEventIdsRef.current.clear();
    sceneRef.current?.setActiveMultiplayerSession(lastAck.roomCode, lastAck.matchId);
    sceneRef.current?.resetMultiplayerNetState();

    ws.send({
      type: 'mp:rejoin_ready',
      roomCode: lastAck.roomCode,
      matchId: lastAck.matchId,
      rejoinAttemptId: lastAck.rejoinAttemptId,
    }, {
      roomCode: lastAck.roomCode,
      expectedMatchId: lastAck.matchId,
    });

    diagnosticsStore.log('ROOM', 'INFO', 'rejoin:ack', {
      roomCode: lastAck.roomCode,
      matchId: lastAck.matchId,
      serverTime: lastAck.serverTime,
      attemptId: lastAck.rejoinAttemptId,
    });
    diagnosticsStore.log('ROOM', 'INFO', 'rejoin:ready_sent', {
      roomCode: lastAck.roomCode,
      matchId: lastAck.matchId,
      attemptId: lastAck.rejoinAttemptId,
    });

    setRejoinPhase('rejoin_ready');
  }, [handleResumeFailure, rejoinPhase, resetMpMatchRuntimeForNewMatch, resumeJoinInProgress, ws, ws.messages]);


  useEffect(() => {
    const lastStarted = [...ws.messages].reverse().find((message) => message.type === 'match:started');
    if (!lastStarted || lastStarted.type !== 'match:started') return;

    const expectedRoomCode = expectedRoomCodeRef.current;
    const gotRoomCode = lastStarted.roomCode ?? null;
    const gotMatchId = lastStarted.matchId ?? null;
    if (!expectedRoomCode) {
      diagnosticsStore.log('ROOM', 'WARN', 'match:started:drop_no_room_context', {
        expectedRoomCode,
        gotRoomCode,
        gotMatchId,
      });
      return;
    }

    if (gotRoomCode !== expectedRoomCode) {
      diagnosticsStore.log('ROOM', 'WARN', 'match:started:drop_room_mismatch', {
        expectedRoomCode,
        gotRoomCode,
        gotMatchId,
      });
      return;
    }

    const nextMatchId = lastStarted.matchId;
    const currentMatchId = expectedMatchIdRef.current;
    if (nextMatchId !== currentMatchId) {
      diagnosticsStore.log('ROOM', 'INFO', 'match_switch:from_match_started', {
        roomCode: expectedRoomCode,
        oldMatchId: currentMatchId,
        newMatchId: nextMatchId,
      });
      switchToNextMatch(nextMatchId);
    }
    setCurrentRoom((prev) => {
      if (!prev || prev.roomCode !== expectedRoomCode) return prev;
      if (prev.phase === 'STARTED') return prev;
      return { ...prev, phase: 'STARTED' };
    });
    diagnosticsStore.log('ROOM', 'INFO', 'match:started:accepted', {
      roomCode: expectedRoomCode,
      matchId: lastStarted.matchId,
    });
  }, [resumeJoinInProgress, switchToNextMatch, ws.messages]);

  useEffect(() => {
    const lastError = [...ws.messages].reverse().find((message) => message.type === 'match:error');
    if (!lastError || lastError.type !== 'match:error') return;

    if (resumeJoinInProgress) {
      handleResumeFailure(`WS: ${lastError.error}`);
      return;
    }

    if (lastError.error === 'not_enough_ws_players') {
      setRoomsError('WS: второй игрок ещё не подключён к матчу. Попробуйте Start ещё раз.');
      return;
    }

    setRoomsError(`WS: ${lastError.error}`);
  }, [handleResumeFailure, resumeJoinInProgress, ws.messages]);

  const activeLeaderboardMode: LeaderboardMode = !isMultiplayerMode
    ? 'solo'
    : currentRoomMembers.length >= 4
      ? 'squad'
      : currentRoomMembers.length === 3
        ? 'trio'
        : 'duo';

  useEffect(() => {
    sceneRef.current?.setGameMode(isMultiplayerMode ? 'multiplayer' : 'solo');
  }, [isMultiplayerMode]);

  useEffect(() => {
    const partySize = Math.max(1, Math.min(4, currentRoomMembers.length || 1));
    sceneRef.current?.setPartySize(partySize);
  }, [currentRoomMembers.length]);


  useEffect(() => {
    const startIndex = processedWsMessagesRef.current;
    const newMessages = ws.messages.slice(startIndex);
    if (newMessages.length <= 0) return;

    processedWsMessagesRef.current = ws.messages.length;

    const expectedRoomCode = expectedRoomCodeRef.current;
    let expectedMatchId = expectedMatchIdRef.current;

    for (const message of newMessages) {
      if (message.type === 'match:snapshot') {
        const snapshot = message.snapshot;
        if (!expectedRoomCode) continue;

        const gotRoomCode = snapshot.roomCode ?? null;
        const gotMatchId = snapshot.matchId ?? null;

        if (gotRoomCode !== expectedRoomCode) {
          setWrongRoomDrops((v) => v + 1);
          diagnosticsStore.log('ROOM', 'WARN', 'firewall:drop_snapshot_wrong_room', {
            expectedRoomCode,
            expectedMatchId,
            gotRoomCode,
            gotMatchId,
            snapTick: snapshot.tick ?? null,
          });
          continue;
        }
        if (!expectedMatchId) {
          if (!gotMatchId) {
            diagnosticsStore.log('ROOM', 'INFO', 'snapshot:drop_waiting_match_context', {
              expectedRoomCode,
              gotRoomCode,
              gotMatchId,
              snapTick: snapshot.tick ?? null,
            });
            continue;
          }

          diagnosticsStore.log('ROOM', 'INFO', 'match_switch:adopt_from_snapshot_without_context', {
            roomCode: expectedRoomCode,
            oldMatchId: expectedMatchId,
            newMatchId: gotMatchId,
            tick: snapshot.tick ?? null,
          });
          switchToNextMatch(gotMatchId);
          expectedMatchId = gotMatchId;
        }

        if (gotMatchId && gotMatchId !== expectedMatchId) {
          diagnosticsStore.log('ROOM', 'INFO', 'match_switch:from_snapshot', {
            roomCode: expectedRoomCode,
            oldMatchId: expectedMatchId,
            newMatchId: gotMatchId,
            tick: snapshot.tick ?? null,
          });
          switchToNextMatch(gotMatchId);
          expectedMatchId = gotMatchId;
        }

        const lastAppliedTick = lastAppliedSnapshotTickRef.current;
        if (typeof lastAppliedTick === 'number' && snapshot.tick <= lastAppliedTick) {
          setDuplicateTickDrops((v) => v + 1);
          diagnosticsStore.log('ROOM', 'WARN', 'firewall:drop_snapshot_duplicate_or_out_of_order', {
            expectedRoomCode,
            expectedMatchId,
            gotRoomCode,
            gotMatchId,
            snapTick: snapshot.tick ?? null,
            lastAppliedTick,
          });
        }
        continue;
      }

      if (!isMatchServerMessage(message)) continue;
      if (!expectedRoomCode) continue;

      const msgWithScope = message as MatchServerMessage & { roomCode?: string; matchId?: string };
      const gotRoomCode = msgWithScope.roomCode ?? null;
      const gotMatchId = msgWithScope.matchId ?? null;

      if (gotRoomCode !== expectedRoomCode) {
        setWrongRoomDrops((v) => v + 1);
        diagnosticsStore.log('ROOM', 'WARN', 'firewall:drop_match_event_wrong_room', {
          type: message.type,
          expectedRoomCode,
          expectedMatchId,
          gotRoomCode,
          gotMatchId,
        });
        continue;
      }

      if (message.type === 'match:started') {
        if (gotMatchId) {
          const nextMatchId = gotMatchId;
          const currentMatchId = expectedMatchIdRef.current;
          if (nextMatchId !== currentMatchId) {
            diagnosticsStore.log('ROOM', 'INFO', 'match_switch:from_match_started', {
              roomCode: expectedRoomCode,
              oldMatchId: currentMatchId,
              newMatchId: nextMatchId,
            });
            switchToNextMatch(nextMatchId);
          }
          expectedMatchId = gotMatchId;
        }
        continue;
      }
      if (message.type.startsWith('match:') && message.type !== 'match:error') {
        if (!expectedMatchId || gotMatchId !== expectedMatchId) {
          setWrongMatchDrops((v) => v + 1);
          diagnosticsStore.log('ROOM', 'WARN', 'firewall:drop_match_event_match_mismatch', {
            type: message.type,
            expectedRoomCode,
            expectedMatchId,
            gotRoomCode,
            gotMatchId,
          });
        }
      }
    }
  }, [resumeJoinInProgress, switchToNextMatch, ws.messages]);

  useEffect(() => {
    const lastWorldInit = [...ws.messages].reverse().find(isMatchWorldInit);
    if (!lastWorldInit) return;

    const expectedRoomCode = expectedRoomCodeRef.current;
    if (!expectedRoomCode) {
      diagnosticsStore.log('ROOM', 'WARN', 'firewall:drop_world_init_no_expected_room', {
        expectedRoomCode,
        gotRoomCode: lastWorldInit.roomCode ?? null,
        gotMatchId: lastWorldInit.matchId ?? null,
      });
      return;
    }

    setLastWorldInitAt(Date.now());
    const gotRoomCode = lastWorldInit.roomCode ?? null;
    const gotMatchId = lastWorldInit.matchId ?? null;

    if (gotRoomCode !== expectedRoomCode) {
      diagnosticsStore.log('ROOM', 'WARN', 'firewall:drop_world_init', {
        expectedRoomCode,
        expectedMatchId: expectedMatchIdRef.current,
        gotRoomCode,
        gotMatchId,
      });
      return;
    }

    let currentExpectedMatchId = expectedMatchIdRef.current;
    if (!currentExpectedMatchId) {
      const roomIsActiveMultiplayer = isMultiplayerMode
        && currentRoom?.phase === 'STARTED'
        && currentRoom.roomCode === expectedRoomCode;
      if (roomIsActiveMultiplayer && gotMatchId) {
        diagnosticsStore.log('ROOM', 'INFO', 'world_init_adopted_match_id', {
          roomCode: expectedRoomCode,
          matchId: gotMatchId,
          expectedMatchIdWasNull: true,
        });
        switchToNextMatch(gotMatchId);
        currentExpectedMatchId = gotMatchId;
      }
    }

    if (gotMatchId && currentExpectedMatchId && gotMatchId !== currentExpectedMatchId) {
      diagnosticsStore.log('ROOM', 'INFO', 'match_switch:from_world_init', {
        roomCode: expectedRoomCode,
        oldMatchId: currentExpectedMatchId,
        newMatchId: gotMatchId,
      });
      switchToNextMatch(gotMatchId);
    }

    if (!currentExpectedMatchId && gotMatchId) {
      diagnosticsStore.log('ROOM', 'INFO', 'firewall:bind_expected_match_from_world_init', {
        expectedRoomCode,
        gotMatchId,
      });
    }

    const activeExpectedMatchId = expectedMatchIdRef.current;
    if (!activeExpectedMatchId || gotMatchId !== activeExpectedMatchId) {
      setWrongMatchDrops((v) => v + 1);
      worldReadyRef.current = false;
      firstSnapshotReadyRef.current = false;
      pendingWorldInitRef.current = null;
      pendingSnapshotRef.current = null;
      sceneRef.current?.triggerNetResync('wrong_match_world_init');
      diagnosticsStore.log('ROOM', 'WARN', 'firewall:drop_world_init_match_mismatch', {
        expectedRoomCode,
        expectedMatchId: activeExpectedMatchId,
        gotRoomCode,
        gotMatchId,
      });
      return;
    }

    const scene = sceneRef.current;
    if (!scene) return;

    if (resumeJoinInProgress && !(rejoinPhase === 'rejoin_ready' || rejoinPhase === 'rejoin_applying')) {
      pendingWorldInitRef.current = lastWorldInit;
      diagnosticsStore.log('ROOM', 'INFO', 'rejoin:buffer_world_init_not_ready', {
        roomCode: gotRoomCode,
        matchId: gotMatchId,
        rejoinPhase,
      });
      return;
    }

    if (resumeJoinInProgress) {
      setRejoinPhase('rejoin_applying');
    }

    pendingWorldInitRef.current = null;
    scene.applyMatchWorldInit(lastWorldInit);
    const { gridW, gridH } = lastWorldInit.world;
    worldReadyRef.current = true;
    if (resumeLifecycleActiveRef.current && !resumeWorldReadyLoggedRef.current) {
      resumeWorldReadyLoggedRef.current = true;
      diagnosticsStore.log('ROOM', 'INFO', 'resume_world_ready', {
        roomCode: gotRoomCode,
        matchId: activeExpectedMatchId,
      });
    }
    if (resumeJoinInProgress) {
      resumeRoomCodeRef.current = null;
    }
    diagnosticsStore.log('ROOM', 'INFO', 'world_init:accepted', {
      roomCode: gotRoomCode,
      matchId: activeExpectedMatchId,
      gridW,
      gridH,
    });

    const pendingSnapshot = pendingSnapshotRef.current;
    if (pendingSnapshot) {
      scene.applyMatchSnapshot(pendingSnapshot, localTgUserId);
      firstSnapshotReadyRef.current = true;
      lastAppliedSnapshotTickRef.current = pendingSnapshot.tick;
      pendingSnapshotRef.current = null;
      maybeCompleteRejoinFromAppliedSnapshot(pendingSnapshot);
      diagnosticsStore.log('ROOM', 'INFO', 'snapshot:applied_pending_after_world_init', {
        roomCode: pendingSnapshot.roomCode ?? null,
        matchId: pendingSnapshot.matchId ?? null,
        snapTick: pendingSnapshot.tick ?? null,
      });
    }
  }, [currentRoom?.phase, currentRoom?.roomCode, isMultiplayerMode, localTgUserId, maybeCompleteRejoinFromAppliedSnapshot, rejoinPhase, resumeJoinInProgress, switchToNextMatch, ws.messages]);

  useEffect(() => {
    const pendingWorldInit = pendingWorldInitRef.current;
    if (!pendingWorldInit) return;
    if (!resumeJoinInProgress) return;
    if (!(rejoinPhase === 'rejoin_ready' || rejoinPhase === 'rejoin_applying')) return;

    const expectedRoomCode = expectedRoomCodeRef.current;
    const expectedMatchId = expectedMatchIdRef.current;
    const gotRoomCode = pendingWorldInit.roomCode ?? null;
    const gotMatchId = pendingWorldInit.matchId ?? null;
    if (!expectedRoomCode || gotRoomCode !== expectedRoomCode || !expectedMatchId || gotMatchId !== expectedMatchId) {
      pendingWorldInitRef.current = null;
      return;
    }

    const scene = sceneRef.current;
    if (!scene) return;

    setRejoinPhase('rejoin_applying');
    pendingWorldInitRef.current = null;
    scene.applyMatchWorldInit(pendingWorldInit);
    worldReadyRef.current = true;
    if (resumeLifecycleActiveRef.current && !resumeWorldReadyLoggedRef.current) {
      resumeWorldReadyLoggedRef.current = true;
      diagnosticsStore.log('ROOM', 'INFO', 'resume_world_ready', {
        roomCode: gotRoomCode,
        matchId: expectedMatchId,
      });
    }

    const pendingSnapshot = pendingSnapshotRef.current;
    if (!pendingSnapshot) return;
    if (pendingSnapshot.roomCode !== expectedRoomCode || pendingSnapshot.matchId !== expectedMatchId) {
      pendingSnapshotRef.current = null;
      return;
    }
    if (typeof lastAppliedSnapshotTickRef.current === 'number' && pendingSnapshot.tick <= lastAppliedSnapshotTickRef.current) {
      pendingSnapshotRef.current = null;
      return;
    }

    scene.applyMatchSnapshot(pendingSnapshot, localTgUserId);
    firstSnapshotReadyRef.current = true;
    lastAppliedSnapshotTickRef.current = pendingSnapshot.tick;
    pendingSnapshotRef.current = null;
    maybeCompleteRejoinFromAppliedSnapshot(pendingSnapshot);
  }, [localTgUserId, maybeCompleteRejoinFromAppliedSnapshot, rejoinPhase, resumeJoinInProgress]);


  useEffect(() => {
    if (gameFlowPhase === 'playing') {
      setSpectatorRestartPromptDismissed(false);
    }
  }, [gameFlowPhase]);

  useEffect(() => {
    const expectedRoomCode = expectedRoomCodeRef.current;
    const activeExpectedMatchId = expectedMatchIdRef.current;

    const last = [...ws.messages].reverse().find((m): m is MatchSnapshotMessage => {
      if (m.type !== 'match:snapshot') return false;
      const snapshot = m.snapshot;
      if (!expectedRoomCode) return true;
      if (snapshot.roomCode !== expectedRoomCode) return false;
      return true;
    });
    if (!last) return;

    const snapshot = last.snapshot;
    setLastSnapshotAt(Date.now());
    setLastRecvSnapshotTick(snapshot.tick ?? null);
    if (!expectedRoomCode) {
      diagnosticsStore.log('ROOM', 'WARN', 'firewall:drop_snapshot_no_expected_room', {
        expectedRoomCode,
        expectedMatchId: activeExpectedMatchId,
        gotRoomCode: snapshot.roomCode ?? null,
        gotMatchId: snapshot.matchId ?? null,
      });
      return;
    }

    const gotRoomCode = snapshot.roomCode ?? null;
    const gotMatchId = snapshot.matchId ?? null;

    if (gotRoomCode !== expectedRoomCode) {
      setWrongRoomDrops((v) => v + 1);
      diagnosticsStore.log('ROOM', 'WARN', 'firewall:drop_snapshot', {
        expectedRoomCode,
        expectedMatchId: activeExpectedMatchId,
        gotRoomCode,
        gotMatchId,
      });
      return;
    }

    const currentExpectedMatchId = expectedMatchIdRef.current;
    if (gotMatchId && gotMatchId !== currentExpectedMatchId) {
      diagnosticsStore.log('ROOM', 'INFO', 'match_switch:from_snapshot', {
        roomCode: expectedRoomCode,
        oldMatchId: currentExpectedMatchId,
        newMatchId: gotMatchId,
        tick: snapshot.tick ?? null,
      });
      switchToNextMatch(gotMatchId);
    }

    const snapshotExpectedMatchId = expectedMatchIdRef.current;
    if (!snapshotExpectedMatchId) {
      if (!gotMatchId) {
        const pendingSnapshot = pendingSnapshotRef.current;
        if (!pendingSnapshot || snapshot.tick > pendingSnapshot.tick) {
          pendingSnapshotRef.current = snapshot;
        }
        diagnosticsStore.log('ROOM', 'INFO', 'snapshot:buffered_waiting_match_context', {
          expectedRoomCode,
          gotRoomCode,
          gotMatchId,
          snapTick: snapshot.tick ?? null,
        });
        return;
      }

      diagnosticsStore.log('ROOM', 'INFO', 'match_switch:adopt_from_snapshot_without_context', {
        roomCode: expectedRoomCode,
        oldMatchId: snapshotExpectedMatchId,
        newMatchId: gotMatchId,
        tick: snapshot.tick ?? null,
      });
      switchToNextMatch(gotMatchId);
    }

    if (resumeJoinInProgress && !(rejoinPhase === 'rejoin_ready' || rejoinPhase === 'rejoin_applying')) {
      const pendingSnapshot = pendingSnapshotRef.current;
      if (!pendingSnapshot || snapshot.tick > pendingSnapshot.tick) {
        pendingSnapshotRef.current = snapshot;
      }
      diagnosticsStore.log('ROOM', 'INFO', 'rejoin:buffer_snapshot_not_ready', {
        expectedRoomCode,
        gotRoomCode,
        gotMatchId,
        rejoinPhase,
        snapTick: snapshot.tick ?? null,
      });
      return;
    }

    if (gotMatchId !== snapshotExpectedMatchId) {
      setWrongMatchDrops((v) => v + 1);
      worldReadyRef.current = false;
      firstSnapshotReadyRef.current = false;
      pendingWorldInitRef.current = null;
      pendingSnapshotRef.current = null;
      sceneRef.current?.triggerNetResync('wrong_match_snapshot');
      diagnosticsStore.log('ROOM', 'WARN', 'firewall:drop_snapshot_match_mismatch', {
        expectedRoomCode,
        expectedMatchId: snapshotExpectedMatchId,
        gotRoomCode,
        gotMatchId,
        snapTick: snapshot.tick ?? null,
      });
      return;
    }

    const players = Array.isArray(snapshot.players) ? snapshot.players : [];
    setMultiplayerLivesByUserId(() => {
      const next: Record<string, number> = {};
      for (const player of players) {
        if (!player?.tgUserId) continue;
        next[player.tgUserId] = Math.max(0, Number(player.lives ?? 0));
      }
      return next;
    });
    setMultiplayerDisconnectedByUserId(() => {
      const next: Record<string, boolean> = {};
      for (const player of players) {
        if (!player?.tgUserId) continue;
        next[player.tgUserId] = Boolean(player.disconnected);
      }
      return next;
    });
    setMultiplayerColorByUserId(() => {
      const next: Record<string, string> = {};
      for (const player of players) {
        if (!player?.tgUserId) continue;
        next[player.tgUserId] = colorFromPlayerColorId(Number(player.colorId ?? 0));
      }
      return next;
    });

    if (localTgUserId) {
      const me = players.find((player) => String(player?.tgUserId) === String(localTgUserId));
      if (typeof me?.lastInputSeq === 'number') {
        setAckLastInputSeq(me.lastInputSeq);
        inputSeqRef.current = Math.max(inputSeqRef.current, me.lastInputSeq);
      }
    }

    if (typeof lastAppliedSnapshotTickRef.current === 'number' && snapshot.tick <= lastAppliedSnapshotTickRef.current) {
      setDuplicateTickDrops((v) => v + 1);
      return;
    }

    if (!worldReadyRef.current) {
      const pendingSnapshot = pendingSnapshotRef.current;
      if (!pendingSnapshot || snapshot.tick > pendingSnapshot.tick) {
        pendingSnapshotRef.current = snapshot;
      }
      diagnosticsStore.log('ROOM', 'INFO', 'snapshot:buffered_waiting_world_init', {
        expectedRoomCode,
        expectedMatchId: snapshotExpectedMatchId,
        gotRoomCode,
        gotMatchId,
        snapTick: snapshot.tick ?? null,
      });
      return;
    }

    const scene = sceneRef.current;
    if (!scene) return;

    scene.applyMatchSnapshot(snapshot, localTgUserId);
    firstSnapshotReadyRef.current = true;
    if (resumeLifecycleActiveRef.current && !resumeFirstSnapshotLoggedRef.current) {
      resumeFirstSnapshotLoggedRef.current = true;
      resumedActiveMatchIdRef.current = snapshot.matchId;
      diagnosticsStore.log('ROOM', 'INFO', 'resume_first_valid_snapshot', {
        roomCode: snapshot.roomCode ?? null,
        matchId: snapshot.matchId ?? null,
        tick: snapshot.tick,
      });
    }
    lastAppliedSnapshotTickRef.current = snapshot.tick;
    maybeCompleteRejoinFromAppliedSnapshot(snapshot);

    // If WS snapshots are flowing, match is live → ensure lobby overlay is gone for everyone.
    if (multiplayerUiOpen) {
      setMultiplayerUiOpen(false);
      setDeepLinkJoinCode(null);

      if (isMultiplayerDebugEnabled) {
        diagnosticsStore.log('UI', 'INFO', 'multiplayer:auto_close_on_snapshot', {
          roomCode: currentRoom?.roomCode ?? null,
        });
      }
    }
  }, [ws, ws.messages, localTgUserId, multiplayerUiOpen, isMultiplayerDebugEnabled, currentRoom?.roomCode, maybeCompleteRejoinFromAppliedSnapshot, rejoinPhase, resumeJoinInProgress, switchToNextMatch]);


  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const expectedRoomCode = expectedRoomCodeRef.current;
    const matchMessages = ws.messages.filter((message): message is MatchServerMessage => {
      if (!isMatchServerMessage(message)) return false;
      if (!expectedRoomCode) return true;
      const scoped = message as MatchServerMessage & { roomCode?: string; matchId?: string };
      const gotRoomCode = scoped.roomCode ?? null;
      const gotMatchId = scoped.matchId ?? null;

      if (gotRoomCode !== expectedRoomCode) {
        return false;
      }

      const currentExpectedMatchId = expectedMatchIdRef.current;
      if (!currentExpectedMatchId) return true;
      if (message.type === 'match:started' || message.type === 'match:error') return true;
      if (!message.type.startsWith('match:')) return true;
      return gotMatchId === currentExpectedMatchId;
    });

    for (const message of matchMessages) {
      if ('eventId' in message && typeof message.eventId === 'string') {
        if (handledMatchEventIdsRef.current.has(message.eventId)) {
          continue;
        }
        handledMatchEventIdsRef.current.add(message.eventId);
      }

      if (message.type === 'match:bomb_spawned') {
        scene.applyAuthoritativeBombSpawned(message);
        continue;
      }

      if (message.type === 'match:bomb_exploded') {
        scene.applyAuthoritativeBombExploded(message);
        continue;
      }

      if (message.type === 'match:tiles_destroyed') {
        scene.applyAuthoritativeTilesDestroyed(message);
        continue;
      }

      if (message.type === 'match:player_damaged') {
        scene.applyAuthoritativePlayerDamaged(message, localTgUserId);
        continue;
      }

      if (message.type === 'match:player_respawned') {
        scene.applyAuthoritativePlayerRespawned(message, localTgUserId);
        continue;
      }

      if (message.type === 'match:player_eliminated') {
        scene.applyAuthoritativePlayerEliminated(message, localTgUserId);
        continue;
      }

      if (message.type === 'match:end') {
        setCurrentRoom((prev) => {
          if (!prev) return prev;
          return { ...prev, phase: 'FINISHED' };
        });
        setMatchEndState({ winnerTgUserId: message.winnerTgUserId, reason: message.reason });
        setRoomsError(message.winnerTgUserId ? `Match ended. Winner: ${message.winnerTgUserId}` : 'Match ended. Draw.');
      }

      if (message.type === 'room:restart_proposed') {
        setRestartVote({ active: true, yesCount: 1, total: currentRoomMembers.length, expiresAt: message.expiresAt });
        continue;
      }

      if (message.type === 'room:restart_vote_state') {
        setRestartVote((prev) => ({ active: true, yesCount: message.yesCount, total: message.total, expiresAt: prev?.expiresAt ?? null }));
        continue;
      }

      if (message.type === 'room:restart_cancelled') {
        setRestartVote(null);
        setRoomsError(message.reason === 'timeout' ? 'Restart vote timed out.' : 'Restart vote cancelled.');
        continue;
      }

      if (message.type === 'room:restart_accepted') {
        resetMpMatchRuntimeAwaitingMatchStart();
        setCurrentRoom((prev) => (prev ? { ...prev, phase: 'STARTED' } : prev));
        setGameFlowPhase('playing');
        continue;
      }

      if (message.type === 'room:restart_rejected' && message.reason === 'cooldown') {
        setRestartCooldownRetryAtMs(message.retryAtMs);
        continue;
      }

      if (message.type === 'room:restart_cooldown') {
        setRestartCooldownRetryAtMs(message.retryAtMs);
        continue;
      }
    }
  }, [
    ws.messages,
    localTgUserId,
    currentRoomMembers.length,
    rejoinPhase,
    resumeJoinInProgress,
    switchToNextMatch,
    resetMpMatchRuntimeAwaitingMatchStart,
  ]);

  useEffect(() => {
    sceneRef.current?.setNetRtt(ws.rttMs ?? null, ws.rttJitterMs ?? 0);
  }, [ws.rttMs, ws.rttJitterMs]);

  useEffect(
    () => () => {
      clearMovement();
      activeMoveDirRef.current = null;
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

    const dx = clientX - joystickStartXRef.current;
    const dy = clientY - joystickStartYRef.current;
    const distance = Math.hypot(dx, dy);

    if (distance < JOYSTICK_DEADZONE) {
      setJoystickOffset({ x: 0, y: 0 });
      clearMovement();
      return;
    }

    const clampedScale = distance > JOYSTICK_RADIUS ? JOYSTICK_RADIUS / distance : 1;
    const clampedX = dx * clampedScale;
    const clampedY = dy * clampedScale;
    setJoystickOffset({ x: clampedX, y: clampedY });

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
    joystickStartXRef.current = event.clientX;
    joystickStartYRef.current = event.clientY;
    setJoystickPressed(true);
    setJoystickOffset({ x: 0, y: 0 });
    clearMovement();
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
    joystickStartXRef.current = 0;
    joystickStartYRef.current = 0;
    setJoystickPressed(false);
    setJoystickOffset({ x: 0, y: 0 });
    setMovementFromDirection(null);
  };

  const onJoystickPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (joystickPointerIdRef.current !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    releaseJoystick(event.pointerId);
  };

  const onJoystickLostPointerCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (joystickPointerIdRef.current !== event.pointerId) return;

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
    if (isInteractionBlocked) {
      setBombGateReason('interaction_blocked');
      return;
    }

    if (isMultiplayerMode) {
      const phase = currentRoom?.phase ?? 'LOBBY';
      const expectedRoomCode = expectedRoomCodeRef.current;
      const expectedMatchId = expectedMatchIdRef.current;
      const hasWorldInit = worldReadyRef.current;
      const hasFirstSnapshot = firstSnapshotReadyRef.current;
      const needsNetResync = sceneRef.current?.getSnapshotRoutingStats().needsNetResync ?? true;
      if (phase !== 'STARTED') {
        setBombGateReason('phase_not_started');
        return;
      }
      if (!expectedRoomCode || !expectedMatchId) {
        setBombGateReason('await_match_context');
        return;
      }
      if (!hasWorldInit) {
        setBombGateReason('await_world_init');
        return;
      }
      if (needsNetResync) {
        setBombGateReason('await_net_resync');
        return;
      }
      if (!hasFirstSnapshot) {
        setBombGateReason('await_first_snapshot');
        return;
      }
    }

    setBombGateReason(null);

    if (isMultiplayerMode) {
      const position = sceneRef.current?.getLocalPlayerPosition();
      if (position) {
        ws.send({ type: 'match:bomb_place', payload: { x: position.x, y: position.y } }, { roomCode: expectedRoomCodeRef.current, expectedMatchId: expectedMatchIdRef.current });
      }
      return;
    }

    controlsRef.current.placeBombRequested = true;
  };

  const requestDetonate = (): void => {
    if (isInteractionBlocked) return;
    if (!isRemoteDetonateUnlocked) return;
    controlsRef.current.detonateRequested = true;
  };

  const proposeRestart = (): void => {
    ws.send({ type: 'room:restart_propose' });
  };

  const sendRestartVote = (vote: 'yes' | 'no'): void => {
    ws.send({ type: 'room:restart_vote', vote });
  };

  const onZoomInput = (value: number): void => {
    const clamped = Math.max(zoomBounds.min, Math.min(zoomBounds.max, value));
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
      if (response?.ok) {
        setLeaderboardTop(response.top);
        setLeaderboardMe(response.me);
      } else {
        setLeaderboardTop([]);
        setLeaderboardMe(null);
      }
    } catch {
      setLeaderboardTop([]);
      setLeaderboardMe(null);
    } finally {
      setLeaderboardLoading(false);
    }
  }, []);

  const loadRooms = useCallback(async (publicQuery?: string): Promise<void> => {
    setRoomsLoading(true);
    setRoomsError(null);
    try {
      const [rooms, availableRooms] = await Promise.all([
        fetchMyRooms(),
        fetchPublicRooms(publicQuery),
      ]);
      setMyRooms(rooms);
      setPublicRooms(availableRooms);

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
    markUserInteracted();
    const roomCode = roomCodeRaw.trim().toUpperCase();
    if (!roomCode) return;
    if (currentRoom?.roomCode === roomCode) return;
    if (joiningRoomCode === roomCode) return;

    setRoomsError(null);
    setJoiningRoomCode(roomCode);
    if (isMultiplayerDebugEnabled) diagnosticsStore.log('UI', 'INFO', 'joinRoomByCode:start', { roomCode });
    try {
      const result = await joinRoom(roomCode);
      if (!result) {
        setRoomsError('Join failed');
        if (isMultiplayerDebugEnabled) diagnosticsStore.log('ROOM', 'ERROR', 'joinRoomByCode:failed', { roomCode, reason: 'Join failed' });
        return;
      }

      if (result.error) {
        setRoomsError(mapRoomError(result.error));
        if (isMultiplayerDebugEnabled) diagnosticsStore.log('ROOM', 'ERROR', 'joinRoomByCode:error', { roomCode, error: result.error });
        return;
      }

      setCurrentRoom(result.room);
      setCurrentRoomMembers(result.members);
      setCurrentMatchId(null);
      if (isMultiplayerDebugEnabled) diagnosticsStore.log('ROOM', 'INFO', 'joinRoomByCode:success', { roomCode, members: result.members.length });
      const [rooms, availableRooms] = await Promise.all([fetchMyRooms(), fetchPublicRooms()]);
      setMyRooms(rooms);
      setPublicRooms(availableRooms);
    } finally {
      setJoiningRoomCode((prev) => (prev === roomCode ? null : prev));
    }
  }, [currentRoom?.roomCode, isMultiplayerDebugEnabled, joiningRoomCode, markUserInteracted]);

  const resumeRoomByCode = useCallback(async (roomCodeRaw: string, expectedMatchId: string | null = null): Promise<void> => {
    const roomCode = roomCodeRaw.trim().toUpperCase();
    if (!roomCode) {
      clearLastSession();
      return;
    }

    if (!localTgUserId) {
      if (isMultiplayerDebugEnabled) {
        diagnosticsStore.log('ROOM', 'ERROR', 'rejoin:resume_failed', {
          roomCode,
          reason: 'identity_unavailable',
        });
      }
      handleResumeFailure('Resume failed: player identity is unavailable.');
      return;
    }

    if (isMultiplayerDebugEnabled) {
      diagnosticsStore.log('ROOM', 'INFO', 'rejoin:resume_execute_start', {
        roomCode,
        matchId: expectedMatchId,
      });
    }

    resumeLifecycleActiveRef.current = true;
    diagnosticsStore.log('ROOM', 'INFO', 'resume_enter', {
      roomCode,
      matchId: expectedMatchId,
    });

    setRoomsError(null);
    setResumeJoinInProgress(true);
    setRejoinPhase('rejoin_wait_ack');
    rejoinCompletionSentRef.current = false;
    resumeRoomCodeRef.current = roomCode;
    resumeExpectedMatchIdRef.current = expectedMatchId;

    try {
      const roomData = await fetchRoom(roomCode);
      if (!roomData) {
        if (isMultiplayerDebugEnabled) {
          diagnosticsStore.log('ROOM', 'WARN', 'rejoin:resume_execute_failed', {
            roomCode,
            reason: 'room_fetch_failed_transient',
            lastSessionCleared: false,
          });
        }
        handleResumeFailure('Resume failed: unable to fetch room.', { stale: false });
        return;
      }

      if (roomData.error) {
        const definitiveErrors = new Set(['room_not_found', 'forbidden', 'room_closed', 'room_finished', 'grace_expired']);
        const shouldClearLastSession = definitiveErrors.has(roomData.error);
        if (isMultiplayerDebugEnabled) {
          diagnosticsStore.log('ROOM', shouldClearLastSession ? 'ERROR' : 'WARN', 'rejoin:resume_execute_failed', {
            roomCode,
            reason: roomData.error,
            lastSessionCleared: shouldClearLastSession,
          });
        }
        handleResumeFailure(`Resume failed: ${mapRoomError(roomData.error)}`, { stale: shouldClearLastSession });
        return;
      }

      const isMember = roomData.members.some((member) => String(member.tgUserId) === String(localTgUserId));
      if (!isMember) {
        if (isMultiplayerDebugEnabled) {
          diagnosticsStore.log('ROOM', 'ERROR', 'rejoin:resume_execute_failed', {
            roomCode,
            reason: 'not_member',
            lastSessionCleared: true,
          });
        }
        handleResumeFailure('Resume failed: you are no longer a member of this room.');
        return;
      }

      if (roomData.room.phase !== 'STARTED') {
        if (isMultiplayerDebugEnabled) {
          diagnosticsStore.log('ROOM', 'ERROR', 'rejoin:resume_execute_failed', {
            roomCode,
            reason: `room_phase_${roomData.room.phase ?? 'unknown'}`,
            lastSessionCleared: true,
          });
        }
        handleResumeFailure('Resume failed: room is no longer in active match.');
        return;
      }

      diagnosticsStore.log('ROOM', 'INFO', 'resume_server_ok', {
        roomCode,
        matchId: expectedMatchId,
        phase: roomData.room.phase,
      });

      setCurrentRoom(roomData.room);
      setCurrentRoomMembers(roomData.members);
      setCurrentMatchId(null);
      setMultiplayerUiOpen(false);
      setDeepLinkJoinCode(null);
    } catch {
      if (isMultiplayerDebugEnabled) {
        diagnosticsStore.log('ROOM', 'WARN', 'rejoin:resume_execute_failed', {
          roomCode,
          reason: 'unexpected_error',
          lastSessionCleared: false,
        });
      }
      handleResumeFailure('Resume failed: unexpected error while restoring room.', { stale: false });
    }
  }, [handleResumeFailure, isMultiplayerDebugEnabled, localTgUserId]);

  const persistSessionActivity = useCallback((atMs = Date.now()): void => {
    if (!currentRoom?.roomCode || !localTgUserId) {
      return;
    }

    const meta: LastSessionMeta = {
      roomCode: currentRoom.roomCode,
      tgUserId: localTgUserId,
      mode: 'mp',
      matchId: currentMatchId,
      lastActivityAtMs: atMs,
    };
    saveLastSession(meta);
  }, [currentMatchId, currentRoom?.roomCode, localTgUserId]);

  useEffect(() => {
    if (!currentRoom?.roomCode || !localTgUserId) {
      return;
    }

    persistSessionActivity();
  }, [currentRoom?.roomCode, localTgUserId, persistSessionActivity]);

  useEffect(() => {
    if (!currentRoom?.roomCode || currentRoom.phase !== 'STARTED' || !localTgUserId) {
      return;
    }

    const intervalId = window.setInterval(() => {
      persistSessionActivity();
    }, 4_500);

    const onVisibilityOrHide = (): void => {
      persistSessionActivity();
    };

    document.addEventListener('visibilitychange', onVisibilityOrHide);
    window.addEventListener('pagehide', onVisibilityOrHide);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityOrHide);
      window.removeEventListener('pagehide', onVisibilityOrHide);
    };
  }, [currentRoom?.phase, currentRoom?.roomCode, localTgUserId, persistSessionActivity]);

  useEffect(() => {
    if (!token || !localTgUserId) return;
    if (currentRoom?.roomCode || resumePromptShownRef.current || resumeServerCheckDoneRef.current) return;

    resumeServerCheckDoneRef.current = true;

    const runServerResumeCheck = async (): Promise<void> => {
      if (isMultiplayerDebugEnabled) {
        diagnosticsStore.log('ROOM', 'INFO', 'resume:server_check_started');
      }

      try {
        const response = await fetch(apiUrl('/api/resume'), {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          throw new Error(`status_${response.status}`);
        }

        const payload = await response.json() as {
          canResume?: boolean;
          roomCode?: string;
          matchId?: string | null;
        };

        if (isMultiplayerDebugEnabled) {
          diagnosticsStore.log('ROOM', 'INFO', 'resume:server_check_result', {
            canResume: Boolean(payload?.canResume),
            roomCode: payload?.roomCode ? String(payload.roomCode) : null,
          });
        }

        if (!payload?.canResume || !payload?.roomCode) {
          return;
        }

        resumePromptShownRef.current = true;
        if (isMultiplayerDebugEnabled) {
          diagnosticsStore.log('ROOM', 'INFO', 'resume:server_prompt_shown_server_driven', {
            roomCode: payload.roomCode,
            matchId: payload.matchId ?? null,
          });
        }

        setResumeModal({
          open: true,
          roomCode: String(payload.roomCode),
          matchId: payload.matchId == null ? null : String(payload.matchId),
        });
      } catch (error) {
        if (isMultiplayerDebugEnabled) {
          diagnosticsStore.log('ROOM', 'WARN', 'resume:server_check_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    void runServerResumeCheck();
  }, [currentRoom?.roomCode, isMultiplayerDebugEnabled, localTgUserId, token]);

  const onCancelResumePrompt = useCallback((): void => {
    if (!resumeModal?.open) return;

    if (isMultiplayerDebugEnabled) {
      diagnosticsStore.log('ROOM', 'INFO', 'rejoin:resume_prompt_cancelled', {
        roomCode: resumeModal.roomCode,
        matchId: resumeModal.matchId,
      });
    }

    clearLastSession();
    pendingResumeIntentRef.current = null;
    setResumeModal(null);
    stopMpResumeCountdown();
    setGameFlowPhase('playing');
    setMultiplayerUiOpen(true);
    resetResumeAttemptState('idle');
  }, [isMultiplayerDebugEnabled, resetResumeAttemptState, resumeModal, stopMpResumeCountdown]);

  const onSoloResumeAccept = useCallback((): void => {
    setSoloResumeModalOpen(false);
    setSoloStartReady(true);
    setGameFlowPhase('playing');
  }, []);

  const onSoloResumeCancel = useCallback((): void => {
    clearSoloResumeSnapshot();
    initialSoloResumeSnapshotRef.current = null;
    try {
      const campaign = loadCampaignState() ?? createInitialCampaignState();
      saveCampaignState({ ...campaign, soloGameOver: true, lastActiveAtMs: Date.now() });
    } catch {
      // ignore local persistence errors
    }
    setSoloResumeModalOpen(false);
    setSoloStartReady(true);
    setGameFlowPhase('playing');
  }, []);

  const onAcceptResumePrompt = useCallback((): void => {
    if (!resumeModal?.open) return;

    resumedActiveMatchIdRef.current = null;

    if (isMultiplayerDebugEnabled) {
      diagnosticsStore.log('ROOM', 'INFO', 'rejoin:resume_prompt_accepted', {
        roomCode: resumeModal.roomCode,
        matchId: resumeModal.matchId,
        wsConnected: ws.connected,
      });
    }

    const pendingIntent = {
      roomCode: resumeModal.roomCode,
      matchId: resumeModal.matchId,
    };
    pendingResumeIntentRef.current = pendingIntent;
    resumeIntentExecutedRef.current = false;
    setResumeModal(null);
    // Ensure Telegram returns to expanded/fullscreen mode on the user gesture (Resume click).
    try {
      const tg = (window as any)?.Telegram?.WebApp as TelegramWebApp | undefined;
      tg?.ready?.();
      tg?.expand?.();
      tg?.disableVerticalSwipes?.();

      const res = tg?.requestFullscreen?.();
      if (res && typeof (res as any).catch === 'function') {
        (res as Promise<void>).catch(() => {});
      }
    } catch {
      // ignore
    }
    startMpResumeCountdown();
    setGameFlowPhase('playing');

    if (!ws.connected) {
      if (isMultiplayerDebugEnabled) {
        diagnosticsStore.log('ROOM', 'INFO', 'rejoin:resume_queued_waiting_for_ws', pendingIntent);
      }
      return;
    }

    resumeIntentExecutedRef.current = true;
    pendingResumeIntentRef.current = null;
    void resumeRoomByCode(pendingIntent.roomCode, pendingIntent.matchId);
  }, [isMultiplayerDebugEnabled, resumeModal, resumeRoomByCode, startMpResumeCountdown, ws.connected]);

  useEffect(() => () => {
    stopMpResumeCountdown();
  }, [stopMpResumeCountdown]);

  useEffect(() => {
    if (!ws.connected) return;
    if (resumeJoinInProgress) return;
    if (resumeIntentExecutedRef.current) return;
    const pendingIntent = pendingResumeIntentRef.current;
    if (!pendingIntent) return;

    resumeIntentExecutedRef.current = true;
    pendingResumeIntentRef.current = null;
    if (isMultiplayerDebugEnabled) {
      diagnosticsStore.log('ROOM', 'INFO', 'rejoin:resume_started_after_ws_connected', {
        roomCode: pendingIntent.roomCode,
        matchId: pendingIntent.matchId,
      });
    }
    void resumeRoomByCode(pendingIntent.roomCode, pendingIntent.matchId);
  }, [isMultiplayerDebugEnabled, resumeJoinInProgress, resumeRoomByCode, ws.connected]);

  useEffect(() => {
    if (!resumeJoinInProgress) return;
    if (!ws.lastError) return;

    handleResumeFailure(`Resume failed: WS ${ws.lastError}`);
    setCurrentRoom(null);
    setCurrentRoomMembers([]);
    setCurrentMatchId(null);
  }, [handleResumeFailure, resumeJoinInProgress, ws.lastError]);

  useEffect(() => {
    const appliedTick = lastAppliedSnapshotTickRef.current;
    if (!worldReadyRef.current || !firstSnapshotReadyRef.current || appliedTick === null) return;
    if (resumeJoinInProgress) return;

    if (multiplayerUiOpen || deepLinkJoinCode || rejoinOverlayActive) {
      setMultiplayerUiOpen(false);
      setDeepLinkJoinCode(null);
      if (rejoinOverlayActive) {
        setRejoinPhase('rejoin_complete');
      }

      if (isMultiplayerDebugEnabled) {
        diagnosticsStore.log('ROOM', 'INFO', 'rejoin:ui_force_close', {
          phase: rejoinPhase,
          appliedTick,
        });
      }
    }
  }, [deepLinkJoinCode, isMultiplayerDebugEnabled, multiplayerUiOpen, rejoinOverlayActive, rejoinPhase, resumeJoinInProgress, ws.messages]);

  const onCreateRoom = useCallback(async (capacity: 2 | 3 | 4): Promise<void> => {
    markUserInteracted();
    setRoomsError(null);
    setCreatingRoom(true);
    if (isMultiplayerDebugEnabled) diagnosticsStore.log('UI', 'INFO', 'onCreateRoom:start', { capacity });
    try {
      const created = await createRoom(capacity);
      if (!created) {
        setRoomsError('Failed to create room');
        if (isMultiplayerDebugEnabled) diagnosticsStore.log('ROOM', 'ERROR', 'onCreateRoom:failed');
        return;
      }

      if (isMultiplayerDebugEnabled) diagnosticsStore.log('ROOM', 'INFO', 'onCreateRoom:success', { roomCode: created.roomCode, capacity });
      await joinRoomByCode(created.roomCode);
    } finally {
      setCreatingRoom(false);
    }
  }, [isMultiplayerDebugEnabled, joinRoomByCode, markUserInteracted]);


  const clearMultiplayerSessionState = useCallback((): void => {
    ws.send({ type: 'room:leave' });
    clearLastSession();
    setMultiplayerUiOpen(false);
    setDeepLinkJoinCode(null);
    setCurrentRoom(null);
    setCurrentRoomMembers([]);
    setCurrentMatchId(null);
    setMultiplayerLivesByUserId({});
    setMultiplayerDisconnectedByUserId({});
    setRestartVote(null);
    setMatchEndState(null);
    resetResumeAttemptState('idle');
    expectedRoomCodeRef.current = null;
    expectedMatchIdRef.current = null;
    worldReadyRef.current = false;
    firstSnapshotReadyRef.current = false;
    pendingWorldInitRef.current = null;
    pendingSnapshotRef.current = null;
    lastAppliedSnapshotTickRef.current = null;
    handledMatchEventIdsRef.current.clear();
    processedWsMessagesRef.current = 0;
    wsJoinedRoomCodeRef.current = null;
    sceneRef.current?.setActiveMultiplayerSession(null, null);
    sceneRef.current?.resetMultiplayerNetState();
  }, [resetResumeAttemptState, ws]);

  const onLeaveMultiplayerMatch = useCallback(async (): Promise<void> => {
    const roomCode = currentRoom?.roomCode;
    clearMultiplayerSessionState();
    clearLastSession();

    if (roomCode) {
      try {
        await leaveRoom();
      } catch {
        // best effort: ws detach already executed
      }
    }

    sceneRef.current?.setGameMode('solo');
    sceneRef.current?.restartSoloRun();
    setGameFlowPhase('start');
  }, [clearMultiplayerSessionState, currentRoom?.roomCode]);

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

    ws.send({ type: 'room:leave' });
    clearLastSession();
    setCurrentRoom(null);
    setCurrentRoomMembers([]);
    setCurrentMatchId(null);
    sceneRef.current?.resetMultiplayerNetState();
    processedWsMessagesRef.current = 0;
    const [rooms, availableRooms] = await Promise.all([fetchMyRooms(), fetchPublicRooms()]);
    setMyRooms(rooms);
    setPublicRooms(availableRooms);
  }, [currentRoom, ws]);

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

    ws.send({ type: 'room:leave' });
    clearLastSession();
    setCurrentRoom(null);
    setCurrentRoomMembers([]);
    setCurrentMatchId(null);
    sceneRef.current?.resetMultiplayerNetState();
    processedWsMessagesRef.current = 0;
    const [rooms, availableRooms] = await Promise.all([fetchMyRooms(), fetchPublicRooms()]);
    setMyRooms(rooms);
    setPublicRooms(availableRooms);
  }, [currentRoom?.roomCode, ws]);



  const onToggleReady = useCallback(async (): Promise<void> => {
    if (!currentRoom?.roomCode || !localTgUserId) return;
    const me = currentRoomMembers.find((member) => member.tgUserId === localTgUserId);
    const nextReady = !(me?.ready ?? false);

    setSettingReady(true);
    setRoomsError(null);
    if (isMultiplayerDebugEnabled) diagnosticsStore.log('UI', 'INFO', 'onToggleReady:start', { roomCode: currentRoom.roomCode, nextReady });
    try {
      const result = await setRoomReady(currentRoom.roomCode, nextReady);
      if (!result) {
        setRoomsError('Ready update failed');
        if (isMultiplayerDebugEnabled) diagnosticsStore.log('ROOM', 'ERROR', 'onToggleReady:failed', { roomCode: currentRoom.roomCode });
        return;
      }
      if (result.error) {
        setRoomsError(mapRoomError(result.error));
        if (isMultiplayerDebugEnabled) diagnosticsStore.log('ROOM', 'ERROR', 'onToggleReady:error', { roomCode: currentRoom.roomCode, error: result.error });
        return;
      }
      setCurrentRoom(result.room);
      setCurrentRoomMembers(result.members);
      setCurrentMatchId(null);
      if (isMultiplayerDebugEnabled) diagnosticsStore.log('ROOM', 'INFO', 'onToggleReady:success', { roomCode: result.room.roomCode, members: result.members.length });
    } finally {
      setSettingReady(false);
    }
  }, [currentRoom?.roomCode, currentRoomMembers, isMultiplayerDebugEnabled, localTgUserId]);


  const onKickRoomMember = useCallback(async (targetTgUserId: string): Promise<void> => {
    if (!currentRoom?.roomCode || !targetTgUserId) return;

    setRoomsError(null);
    const result = await kickRoomMember(currentRoom.roomCode, targetTgUserId);
    if (!result) {
      setRoomsError('Kick failed');
      return;
    }

    if (!result.ok) {
      setRoomsError(mapRoomError(result.error));
      return;
    }

    if (result.room) setCurrentRoom(result.room);
    if (result.members) setCurrentRoomMembers(result.members);
    if (localTgUserId && localTgUserId === targetTgUserId) {
      ws.send({ type: 'room:leave' });
      clearLastSession();
      setCurrentRoom(null);
      setCurrentRoomMembers([]);
      setCurrentMatchId(null);
      sceneRef.current?.resetMultiplayerNetState();
      processedWsMessagesRef.current = 0;
    }
  }, [currentRoom?.roomCode, localTgUserId, ws]);

  const onStartRoom = useCallback(async (): Promise<void> => {
    if (!currentRoom?.roomCode) return;

    setStartingRoom(true);
    setRoomsError(null);
    if (isMultiplayerDebugEnabled) diagnosticsStore.log('UI', 'INFO', 'onStartRoom:start', { roomCode: currentRoom.roomCode });
    try {
      const result = await startRoom(currentRoom.roomCode);
      if (!result) {
        setRoomsError('Start failed');
        if (isMultiplayerDebugEnabled) diagnosticsStore.log('ROOM', 'ERROR', 'onStartRoom:failed', { roomCode: currentRoom.roomCode });
        return;
      }
      if (result.error) {
        setRoomsError(mapRoomError(result.error));
        if (isMultiplayerDebugEnabled) diagnosticsStore.log('ROOM', 'ERROR', 'onStartRoom:error', { roomCode: currentRoom.roomCode, error: result.error });
        return;
      }
      setCurrentRoom(result.room);
      setCurrentRoomMembers(result.members);
      setCurrentMatchId(null);
      ws.send({ type: 'match:start' });
      if (isMultiplayerDebugEnabled) diagnosticsStore.log('ROOM', 'INFO', 'onStartRoom:success', { roomCode: result.room.roomCode });
    } finally {
      setStartingRoom(false);
    }
  }, [currentRoom?.roomCode, isMultiplayerDebugEnabled, ws]);

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

  const onSendFriendRequest = useCallback(async (toTgUserIdRaw: string): Promise<void> => {
    const toTgUserId = toTgUserIdRaw.trim();
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
    await loadFriends();
  }, [loadFriends]);

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

  const onInviteFriend = useCallback(async (_tgUserId: string): Promise<void> => {
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
    if (!leaderboardOpen) return;
    setLeaderboardMode(activeLeaderboardMode);
  }, [activeLeaderboardMode, leaderboardOpen]);

  useEffect(() => {
    const isTrueMatchEnd = lifeState.gameOver || Boolean(matchEndState);
    if (!isTrueMatchEnd) {
      lastSubmittedLeaderboardMatchIdRef.current = '';
      return;
    }

    const matchIdentity = currentMatchId ?? `${activeLeaderboardMode}:${currentRoom?.roomCode ?? 'solo'}`;
    if (lastSubmittedLeaderboardMatchIdRef.current === matchIdentity) return;
    lastSubmittedLeaderboardMatchIdRef.current = matchIdentity;

    void (async () => {
      if (activeLeaderboardMode === 'solo') {
        const submitResult = await submitLeaderboard('solo', stats.score);
        if (!submitResult) return;
        await loadLeaderboard('solo');
        return;
      }

      const members: TeamLeaderboardMember[] = currentRoomMembers
        .map((member) => ({
          tgUserId: member.tgUserId,
          displayName: member.displayName,
        }))
        .sort((a, b) => a.tgUserId.localeCompare(b.tgUserId));

      const submitResult = await submitTeamLeaderboard(activeLeaderboardMode, stats.score, members);
      if (!submitResult) return;
      await loadLeaderboard(activeLeaderboardMode);
    })();
  }, [activeLeaderboardMode, currentMatchId, currentRoom?.roomCode, currentRoomMembers, lifeState.gameOver, loadLeaderboard, matchEndState, stats.score]);

  useEffect(() => {
    if (!multiplayerUiOpen) return;
    void loadRooms();
    void loadFriends();
  }, [loadFriends, loadRooms, multiplayerUiOpen]);

  useEffect(() => {
    if (!multiplayerUiOpen) return;
    if (!currentRoom?.roomCode) return;

    const id = window.setInterval(() => {
      void loadRooms();
    }, 2500);

    return () => {
      window.clearInterval(id);
    };
  }, [currentRoom?.roomCode, loadRooms, multiplayerUiOpen]);

  useEffect(() => {
    if (!token) return;

    const telegramStartParam = (window as Window & { Telegram?: { WebApp?: { initDataUnsafe?: { start_param?: string } } } }).Telegram?.WebApp?.initDataUnsafe?.start_param;
    const search = new URLSearchParams(window.location.search);
    const startappRaw = search.get('startapp') ?? '';
    const startParam = telegramStartParam || startappRaw;

    if (startParam?.startsWith('ref_')) {
      void claimReferral(startParam);
      return;
    }

    if (!startParam?.startsWith('room_')) return;

    const deepLinkRoomCode = startParam.replace('room_', '').trim().toUpperCase();
    if (!deepLinkRoomCode) return;

    setDeepLinkJoinCode(deepLinkRoomCode);
    setMultiplayerUiOpen(true);
  }, [token]);

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


  const onCopyGameUserId = async (): Promise<void> => {
    if (!accountInfo?.gameUserId) return;
    try {
      await navigator.clipboard.writeText(accountInfo.gameUserId);
      setGameUserIdCopied(true);
    } catch {
      setGameUserIdCopied(false);
    }
  };

  useEffect(() => {
    if (!gameUserIdCopied) return;
    const timeoutId = window.setTimeout(() => {
      setGameUserIdCopied(false);
    }, 1200);
    return () => window.clearTimeout(timeoutId);
  }, [gameUserIdCopied]);

  const nicknameInput = nicknameDraft.trim();
  const nicknameFormatValid = /^[A-Za-z0-9_]{3,16}$/.test(nicknameInput);

  const debugNicknameFailure = useCallback((params: {
    endpoint: string;
    method: string;
    payload?: Record<string, unknown>;
    response?: Response;
    responseBody?: unknown;
    error?: unknown;
  }): void => {
    if (!DEBUG_NICK) return;
    // GDX backend-relevant: nickname registration failure diagnostics
    const payloadKeys = params.payload ? Object.keys(params.payload) : [];
    const status = params.response?.status ?? null;
    const endpoint = params.endpoint;

    console.warn('[nickname-debug] request failed', {
      endpoint,
      method: params.method,
      status,
      payloadKeys,
      responseBody: params.responseBody ?? null,
      error: params.error instanceof Error ? params.error.message : params.error ?? null,
    });
  }, []);

  useEffect(() => {
    if (!registrationOpen) return;

    if (!nicknameInput) {
      setNicknameCheckState('idle');
      return;
    }

    if (!nicknameFormatValid) {
      setNicknameCheckState('invalid');
      return;
    }

    // Backend nickname-check requires Bearer token
    if (!token) {
      setNicknameCheckState('auth_required');
      return;
    }

    const controller = new AbortController();

    const timeoutId = window.setTimeout(() => {
      setNicknameCheckState('checking');

      const endpoint = apiUrl(`/api/profile/nickname-check?nick=${encodeURIComponent(nicknameInput)}`);

      void fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      })
        .then(async (response) => {
          const json = await response.json().catch(() => null);

          if (response.status === 401) {
            setNicknameCheckState('auth_required');
            return;
          }

          if (response.status === 409 || json?.available === false) {
            setNicknameCheckState('taken');
            return;
          }

          if (response.status === 400) {
            setNicknameCheckState('invalid');
            return;
          }

          if (!response.ok || !json || typeof json !== 'object') {
            setNicknameCheckState('server_error');
            return;
          }

          if (json.available === true || json.ok === true) {
            setNicknameCheckState('available');
            return;
          }

          setNicknameCheckState('server_error');
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setNicknameCheckState('server_error');
          }
        });
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [nicknameFormatValid, nicknameInput, registrationOpen, token]);

  const onSubmitNickname = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!token) return;

    const nickname = nicknameInput;
    setNicknameSubmitError(null);
    if (!nicknameFormatValid) {
      setNicknameCheckState('invalid');
      setNicknameSubmitError('Invalid nickname format');
      return;
    }

    if (nicknameCheckState !== 'available') return;

    setNicknameSubmitting(true);

    try {
      const endpoint = apiUrl('/api/profile/nickname');
      const payload = { nickname };
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const json = await response.json().catch(() => null);
      if (response.status === 401) {
        setNicknameCheckState('auth_required');
        setNicknameSubmitError('Auth required. Please reopen from Telegram.');
        return;
      }
      if (!response.ok || !json?.ok) {
        if (!response.ok) {
          debugNicknameFailure({ endpoint, method: 'POST', payload, response, responseBody: json });
        }
        if (response.status === 409 || json?.available === false) {
          setNicknameCheckState('taken');
          setNicknameSubmitError('Nickname is already taken');
          return;
        }
        if (response.status === 400) {
          setNicknameCheckState('invalid');
          setNicknameSubmitError('Invalid nickname format');
          return;
        }
        debugNicknameFailure({ endpoint, method: 'POST', payload, response, responseBody: json });
        setNicknameCheckState('server_error');
        setNicknameSubmitError('Server error. Please try again.');
        return;
      }

      const nextNickname = String(json.gameNickname ?? nickname);

      setAccountInfo((prev) => (prev ? {
        ...prev,
        // GDX: keep identity update centralized here so social layer hooks can subscribe later.
        gameNickname: nextNickname,
        gameUserId: String(json.gameUserId ?? prev.gameUserId),
      } : prev));

      // Keep UI name in sync (solo HUD + local leaderboard participant name)
      setProfileName(nextNickname);

      if (leaderboardOpen) {
        void loadLeaderboard(leaderboardMode);
      }

      setRegistrationOpen(false);
    } catch (error) {
      debugNicknameFailure({ endpoint: '/api/profile/nickname', method: 'POST', payload: { nickname }, error });
      setNicknameCheckState('server_error');
      setNicknameSubmitError('Server error. Please try again.');
    } finally {
      setNicknameSubmitting(false);
    }
  };

  const nicknameStatusText =
    nicknameCheckState === 'checking'
      ? 'Checking…'
      : nicknameCheckState === 'available'
        ? '✅ Available'
        : nicknameCheckState === 'taken'
          ? '❌ Taken'
          : nicknameCheckState === 'invalid'
            ? '❌ Invalid'
            : nicknameCheckState === 'auth_required'
              ? '❌ Auth required. Please reopen from Telegram.'
              : nicknameCheckState === 'server_error'
                ? '❌ Server error'
                : null;
  const canSaveNickname = Boolean(
    nicknameInput.length >= 3
    && nicknameInput.length <= 16
    && nicknameFormatValid
    && nicknameCheckState === 'available'
    && !nicknameSubmitting,
  );

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
  const renderHudLives = (member: RoomMember | null, ref?: Ref<HTMLSpanElement>): JSX.Element | null => {
    if (!member) return null;

    const lives = isMultiplayerHud
      ? Math.max(0, Math.min(3, multiplayerLivesByUserId[member.tgUserId] ?? 0))
      : Math.max(0, Math.min(3, lifeState.lives));

    return (
      <span ref={ref} className="hud-lives" aria-label="Lives" title="Lives">
        {Array.from({ length: 3 }, (_, index) => {
          const isFullHeart = index < lives;
          return (
            <span
              key={index}
              className={`hud-heart ${isFullHeart ? 'hud-heart--full' : 'hud-heart--empty'}`}
              aria-hidden="true"
            >
              {isFullHeart ? '❤️' : '♡'}
            </span>
          );
        })}
      </span>
    );
  };
  const getHudAccent = (member: RoomMember, fallbackColorId: number): string => {
    if (!isMultiplayerHud) return colorFromPlayerColorId(0);
    return multiplayerColorByUserId[member.tgUserId] ?? colorFromPlayerColorId(fallbackColorId);
  };
  const hudSlots = isMultiplayerHud
    ? Array.from({ length: 4 }, (_, index) => currentRoomMembers[index] ?? null)
    : [{ tgUserId: localTgUserId ?? 'local', displayName: profileName, joinedAt: '', ready: true }];

  const requestTelegramFullscreenBestEffort = async (): Promise<void> => {
    const w = window as Window & { Telegram?: { WebApp?: TelegramWebApp } };
    const webApp = w.Telegram?.WebApp;

    if (!webApp) return;

    const tryExpand = async (): Promise<void> => {
      if (typeof webApp.expand !== 'function') return;
      try {
        await Promise.resolve(webApp.expand());
      } catch {
        // best effort only
      }
    };

    // Native Telegram WebApp API
    try {
      webApp.ready?.();
    } catch {
      // best effort only
    }

    if (typeof webApp.requestFullscreen === 'function') {
      try {
        await Promise.resolve(webApp.requestFullscreen());
      } catch {
        await tryExpand();
      }
    } else {
      await tryExpand();
    }

    // prevent swipe-to-close while interacting (iOS)
    try {
      webApp.disableVerticalSwipes?.();
    } catch {
      // best effort only
    }
  };

  const onStartGame = (): void => {
    markUserInteracted();
    void requestTelegramFullscreenBestEffort();
    if (shouldShowRotateOverlay) return;
    const minZoom = zoomBounds.min;
    setZoom(minZoom);
    setGameFlowPhase('playing');
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        zoomApiRef.current?.setZoom(minZoom);
      });
    });
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
    <main ref={pageRef} className="page" onContextMenu={(event) => event.preventDefault()}>
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
      {!showBootSplash && gameFlowPhase !== 'playing' && !resumeJoinInProgress && !rejoinOverlayActive && !isSoloResumeFlow && !isMpResumeFlow && (
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
      {registrationOpen && (
        <div className="settings-overlay rr-overlay" role="dialog" aria-modal="true" aria-label="Create your player">
          <form className="settings-modal rr-overlay-modal" onSubmit={(event) => { void onSubmitNickname(event); }}>
            <div className="settings-header">
              <strong>Create your player</strong>
            </div>
            <div className="settings-panel">
              <input
                type="text"
                maxLength={16}
                minLength={3}
                value={nicknameDraft}
                onChange={(event) => {
                  setNicknameDraft(event.target.value);
                  setNicknameSubmitError(null);
                }}
                placeholder="Game nickname"
                autoFocus
              />
              <div className="settings-kv"><span>Length</span><strong>3–16</strong></div>
              {nicknameStatusText ? <div className="settings-inline-status">{nicknameStatusText}</div> : null}
              {nicknameCheckState === 'auth_required' && authDiag
                ? <div className="settings-inline-error">{authDiag}</div>
                : null}
              {nicknameSubmitError ? <div className="settings-inline-error">{nicknameSubmitError}</div> : null}
              <button type="submit" disabled={!canSaveNickname}>{nicknameSubmitting ? 'Saving…' : 'Save nickname'}</button>
            </div>
          </form>
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
      {gameFlowPhase === 'playing' && resumeJoinInProgress && (rejoinPhase === 'rejoin_wait_ack' || rejoinPhase === 'rejoin_resetting' || rejoinPhase === 'rejoin_applying') && (
        <div className="waiting-overlay" role="status" aria-live="polite">
          <div className="waiting-overlay__card">
            <strong>Rejoining match…</strong>
            <p>Phase: {rejoinPhase}</p>
            <button type="button" onClick={cancelResumeAttemptByUser}>Cancel rejoin</button>
          </div>
        </div>
      )}
      {gameFlowPhase === 'playing' && mpResumeCountdownActive && isMultiplayerMode && (
        <div className="mp-resume-countdown-overlay" role="status" aria-live="polite" aria-label="Back to the game countdown">
          <div className="mp-resume-countdown-overlay__title">Back to the game</div>
          <div key={mpResumeCountdownValue} className="mp-resume-countdown-overlay__value">{mpResumeCountdownValue}</div>
        </div>
      )}
      {soloResumeModalOpen && !currentRoom?.roomCode && (
        <RROverlayModal
          title="Do you want to resume the run?"
          tabs={[{ key: 'resume', label: 'Resume' }]}
          activeTab="resume"
          onTabChange={() => {}}
          onClose={onSoloResumeCancel}
        >
          <div className="solo-resume-modal-content">
            <div className="solo-resume-modal-actions">
              <button type="button" className="rr-btn-neon-green" onClick={onSoloResumeAccept}>Resume</button>
              <button type="button" className="rr-btn-neon-orange" onClick={onSoloResumeCancel}>Cancel</button>
            </div>
          </div>
        </RROverlayModal>
      )}
      {resumeModal?.open && !currentRoom?.roomCode && (
        <RROverlayModal
          title="Do you want to resume the match?"
          tabs={[{ key: 'resume', label: 'Resume' }]}
          activeTab="resume"
          onTabChange={() => {}}
          onClose={onCancelResumePrompt}
        >
          <div className="solo-resume-modal-content">
            <div className="solo-resume-modal-actions">
              <button type="button" className="rr-btn-neon-green" onClick={onAcceptResumePrompt}>Resume</button>
              <button type="button" className="rr-btn-neon-orange" onClick={onCancelResumePrompt}>Cancel</button>
            </div>
          </div>
        </RROverlayModal>
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
            <button type="button" onClick={() => sceneRef.current?.restartSoloRun()}>Restart The Game</button>
          </div>
        </div>
      )}
      {gameFlowPhase === 'playing' && isMultiplayerMode && currentRoom?.phase === 'FINISHED' && !isRestartVoteActive && (
        <div className="waiting-overlay" role="dialog" aria-modal="true" aria-label="Match finished">
          <div className="waiting-overlay__card">
            <strong>{matchEndState?.winnerTgUserId ? `Winner: ${matchEndState.winnerTgUserId}` : 'Draw'}</strong>
            <p>{matchEndState?.reason === 'draw' ? 'All players eliminated.' : 'Elimination victory.'}</p>
            <button type="button" onClick={proposeRestart}>Restart Match</button>
          </div>
        </div>
      )}
      {showAliveRestartVotePrompt && (
        <div className="restart-vote-hud" role="status" aria-live="polite">
          <span className="restart-vote-hud__label">Restart vote: {restartVote?.yesCount ?? 0}/{restartVote?.total ?? 0}</span>
          <div className="restart-vote-actions">
            <button type="button" onClick={() => sendRestartVote('yes')}>Yes</button>
            <button type="button" className="ghost" onClick={() => sendRestartVote('no')}>No</button>
          </div>
          <div className="restart-vote-progress" aria-label="Restart vote countdown">
            <div className="restart-vote-progress__fill" style={{ transform: `scaleX(${restartVoteProgress})` }} />
          </div>
          {restartCooldownRetryAtMs && restartCooldownRemainingSec > 0 ? <div className="restart-cooldown">Retry in: {restartCooldownRemainingSec}s</div> : null}
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
                <div
                  key={member?.tgUserId ?? `empty-${index}`}
                  className={`hud-slot ${member ? '' : 'hud-slot--empty'} ${member && multiplayerDisconnectedByUserId[member.tgUserId] ? 'hud-slot--inactive' : ''}`}
                  style={member ? ({ ['--player-accent' as string]: getHudAccent(member, index) } as CSSProperties) : undefined}
                >
                  {member ? (
                    <>
                      <span className="hud-slot-avatar" aria-hidden="true">
                        <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                          <circle cx="12" cy="7" r="3.2" />
                          <path d="M4.2 19.4c.28-3.65 3.33-6.2 7.8-6.2 4.47 0 7.52 2.55 7.8 6.2" />
                        </svg>
                      </span>
                      {renderHudLives(member, index === 0 ? hudLivesRef : undefined)}
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          <div className="hud-right">
            <div className="hud-cards">
              <div className="hud-card">
                <div className="hud-card__label">Stage</div>
                <div className="hud-card__value">{campaign.stage}</div>
              </div>
              <div className="hud-card">
                <div className="hud-card__label">Zone</div>
                <div className="hud-card__value">{campaign.zone}</div>
              </div>
              <div className="hud-card hud-card--score">
                <div className="hud-card__label">Score</div>
                <div className="hud-card__value">{stats.score}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section ref={pageShellRef} className="playfield-shell page-shell">
        <aside className="control-column control-column--left" aria-label="Movement controls">
          <div className="left-panel left-panel--icons">
            <div className="left-nav" aria-label="Navigation quick controls">
              <div className="nav-grid">
                <button type="button" className="nav-btn" aria-label="Map placeholder">
                  <span className="nav-btn__plate" aria-hidden="true">
                    <span className="nav-btn__icon" aria-hidden="true">🗺️</span>
                  </span>
                </button>
                <button type="button" className="nav-btn" aria-label="Leaderboard" onClick={() => setLeaderboardOpen(true)}>
                  <span className="nav-btn__plate" aria-hidden="true">
                    <span className="nav-btn__icon" aria-hidden="true">🏆</span>
                  </span>
                </button>
                <button type="button" className="nav-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
                  <span className="nav-btn__plate" aria-hidden="true">
                    <span className="nav-btn__icon" aria-hidden="true">⚙️</span>
                  </span>
                </button>
                <button type="button" className="nav-btn" aria-label="Store" onClick={() => setIsStoreOpen(true)}>
                  <span className="nav-btn__plate" aria-hidden="true">
                    <span className="nav-btn__icon" aria-hidden="true">🛍️</span>
                  </span>
                </button>
                {isMultiplayerMode && currentRoom?.phase === 'STARTED' ? (
                  <button ref={multiplayerBtnRef} type="button" className="nav-btn nav-btn--multiplayer" aria-label="Leave Multiplayer" onClick={() => { void onLeaveMultiplayerMatch(); }}>
                    <span className="nav-btn__plate" aria-hidden="true">
                      <span className="nav-btn__icon" aria-hidden="true">↩️</span>
                    </span>
                  </button>
                ) : (
                  <button ref={multiplayerBtnRef} type="button" className="nav-btn nav-btn--multiplayer" aria-label="Multiplayer" onClick={() => {
                    markUserInteracted();
                    setMultiplayerUiOpen(true);
                  }}>
                    <span className="nav-btn__plate" aria-hidden="true">
                      <span className="nav-btn__icon" aria-hidden="true">👥</span>
                    </span>
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="left-panel left-panel--joystick">
            <div className="left-joystick">
              <div
                ref={joystickTouchZoneRef}
                className={`joystick-touch-zone ${joystickPressed ? 'joystick-touch-zone--active' : ''}`}
                onPointerDown={onJoystickPointerDown}
                onPointerMove={onJoystickPointerMove}
                onPointerUp={onJoystickPointerUp}
                onPointerCancel={onJoystickPointerUp}
                onPointerLeave={onJoystickPointerLeave}
                onLostPointerCapture={onJoystickLostPointerCapture}
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
          </div>
        </aside>

        <section
          className="game-shell"
          // Keep world aspect ratio on the host element to avoid tall RESIZE viewport "empty bottom".
          style={{ ['--arena-ar' as string]: arenaAspectRatio }}
        >
          <div className="game-canvas" ref={mountRef} />
          {isEliminatedSpectator ? <div className="spectator-overlay" aria-hidden="true" /> : null}
        </section>

        <aside className="control-column control-column--right" aria-label="Action controls">
          <div className="right-stack">
            <div className="right-stack-top">
              <div className="right-panel right-panel--zoom" aria-label="Zoom panel">
                <input
                  id="zoom"
                  type="range"
                  className="zoom-slider telescope-range"
                  min={zoomBounds.min}
                  max={zoomBounds.max}
                  step={0.05}
                  value={zoom}
                  onChange={(event) => onZoomInput(Number(event.target.value))}
                />
                <button
                  type="button"
                  className="right-reset-btn"
                  onClick={() => {
                    const minZoom = zoomBounds.min;
                    setZoom(minZoom);
                    zoomApiRef.current?.setZoom(minZoom);
                  }}
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="right-stack-middle">
              <div className="right-panel right-panel--actions" aria-label="Action buttons">
                <button type="button" className="action-btn action-btn--boost action-btn--boost-upper" disabled aria-hidden="true" tabIndex={-1}>Boost</button>
                <button
                  ref={detonateBtnRef}
                  type="button"
                  className="action-btn detonate-btn action-btn--detonate"
                  onTouchStart={requestDetonate}
                  onMouseDown={requestDetonate}
                  disabled={!isRemoteDetonateUnlocked}
                >
                  Detonate
                </button>
                <button
                  ref={bombBtnRef}
                  type="button"
                  className="action-btn bomb-btn action-btn--bomb"
                  onTouchStart={requestBomb}
                  onMouseDown={requestBomb}
                >
                  Bomb
                </button>
                <button type="button" className="action-btn action-btn--boost action-btn--boost-lower" disabled aria-hidden="true" tabIndex={-1}>Boost</button>
              </div>
            </div>
          </div>
        </aside>
      </section>

      {showSpectatorRestartVotePrompt && (
        <div className="restart-spectator-dock" role="status" aria-live="polite">
          <strong>Restart vote: {restartVote?.yesCount ?? 0}/{restartVote?.total ?? 0}</strong>
          <div className="restart-vote-actions">
            <button type="button" onClick={() => sendRestartVote('yes')}>Yes</button>
            <button type="button" className="ghost" onClick={() => sendRestartVote('no')}>No</button>
          </div>
          <div className="restart-vote-progress" aria-label="Restart vote countdown">
            <div className="restart-vote-progress__fill" style={{ transform: `scaleX(${restartVoteProgress})` }} />
          </div>
          {restartCooldownRetryAtMs && restartCooldownRemainingSec > 0 ? <div className="restart-cooldown">Retry in: {restartCooldownRemainingSec}s</div> : null}
        </div>
      )}

      {showSpectatorRestartProposePrompt && (
        <div className="restart-spectator-dock" role="dialog" aria-modal="false" aria-label="Restart prompt">
          <strong>Restart match?</strong>
          <div className="restart-vote-actions">
            <button type="button" onClick={proposeRestart}>OK</button>
            <button type="button" className="ghost" onClick={() => setSpectatorRestartPromptDismissed(true)}>Cancel</button>
          </div>
          {restartCooldownRetryAtMs && restartCooldownRemainingSec > 0 ? <div className="restart-cooldown">Retry in: {restartCooldownRemainingSec}s</div> : null}
        </div>
      )}


      {leaderboardOpen && (
        <RROverlayModal
          title="Leaderboard"
          tabs={([
            { key: 'solo', label: 'Solo' },
            { key: 'duo', label: 'Duo' },
            { key: 'trio', label: 'Trio' },
            { key: 'squad', label: 'Squad' },
          ] as const)}
          activeTab={leaderboardMode}
          onTabChange={(mode) => setLeaderboardMode(mode as LeaderboardMode)}
          onClose={() => setLeaderboardOpen(false)}
        >
              {leaderboardLoading ? (
                <div>Loading leaderboard...</div>
              ) : leaderboardError ? (
                <div>{leaderboardError}</div>
              ) : leaderboardTop.length === 0 ? (
                <div>No scores yet for this mode.</div>
              ) : (
                leaderboardTop.map((entry) => (
                  <div
                    key={`${entry.rank}-${entry.tgUserId}`}
                    className={`leaderboard-row ${entry.rank === 1 ? 'lb-row--gold' : entry.rank === 2 ? 'lb-row--silver' : entry.rank === 3 ? 'lb-row--bronze' : 'lb-row--neutral'}`}
                  >
                    <div className="leaderboard-row__left">
                      <span className="leaderboard-rank">
                        <span className="leaderboard-rank__icon" aria-hidden="true">{entry.rank === 1 ? '🏆' : entry.rank === 2 ? '🥈' : entry.rank === 3 ? '🥉' : ''}</span>
                        {entry.rank}
                      </span>
                      <span className="leaderboard-name">{entry.displayName}</span>
                    </div>
                    <strong className="leaderboard-score">{entry.score}</strong>
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
          </RROverlayModal>
      )}

      {isStoreOpen && (
        <RROverlayModal
          title="Store"
          tabs={([
            { key: 'boosts', label: 'Boosts' },
            { key: 'cosmetics', label: 'Cosmetics' },
            { key: 'packs', label: 'Packs' },
          ] as const)}
          activeTab={storeTab}
          onTabChange={(tab) => setStoreTab(tab as 'boosts' | 'cosmetics' | 'packs')}
          onClose={() => setIsStoreOpen(false)}
        >
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
          </RROverlayModal>
      )}

      <MultiplayerModal
        open={multiplayerUiOpen}
        onClose={() => {
          cancelResumeAttemptByUser();
          setMultiplayerUiOpen(false);
        }}
        initialTab={deepLinkJoinCode ? 'room' : undefined}
        initialRoomTab={deepLinkJoinCode ? 'join' : undefined}
        initialJoinCode={deepLinkJoinCode ?? undefined}
        autoJoin={Boolean(deepLinkJoinCode)}
        roomsLoading={roomsLoading}
        roomsError={roomsError}
        publicRooms={publicRooms}
        currentRoom={currentRoom}
        currentRoomMembers={currentRoomMembers}
        joiningRoomCode={joiningRoomCode}
        creatingRoom={creatingRoom}
        settingReady={settingReady}
        startingRoom={startingRoom}
        onCreateRoom={onCreateRoom}
        onJoinRoomByCode={joinRoomByCode}
        onSearchPublicRooms={loadRooms}
        onLeaveRoom={onLeaveRoom}
        onCloseRoom={onCloseRoom}
        onStartRoom={onStartRoom}
        onToggleReady={onToggleReady}
        onKickRoomMember={onKickRoomMember}
        onCopyInviteLink={onCopyInviteLink}
        friendsLoading={friendsLoading}
        friendsError={friendsError}
        friendsList={friendsList}
        incomingRequests={incomingRequests}
        outgoingRequests={outgoingRequests}
        onSendFriendRequest={onSendFriendRequest}
        onRespondFriendRequest={onRespondFriendRequest}
        onInviteFriend={onInviteFriend}
        referralLink={accountInfo?.referralLink ?? ''}
        onCopyReferralLink={onCopyReferral}
        localTgUserId={localTgUserId}
        onConsumeInitialJoinCode={() => setDeepLinkJoinCode(null)}
      />

      {settingsOpen && (
        <RROverlayModal
          title="Settings"
          tabs={([
            { key: 'audio', label: 'Audio' },
            { key: 'account', label: 'Account' },
          ] as const)}
          activeTab={settingsTab}
          onTabChange={(tab) => setSettingsTab(tab as 'audio' | 'account')}
          onClose={() => setSettingsOpen(false)}
        >
          {settingsTab === 'audio' ? (
            <>
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
            </>
          ) : (
            <>
                <div className="settings-kv"><span>User ID</span><strong>{accountInfo?.gameUserId || accountInfo?.id || '—'}</strong></div>
                <div className="settings-kv"><span>Telegram</span><strong>{localTgUserId ?? 'Not connected'}</strong></div>
                <div className="settings-kv"><span>Game nickname</span><strong>{accountInfo?.gameNickname ?? '—'}</strong></div>
                <div className="settings-kv"><span>Nickname changes remaining</span><strong>{accountInfo?.nameChangeRemaining ?? 3}</strong></div>
                <div className="settings-ref">
                  <input type="text" readOnly value={accountInfo?.referralLink ?? ''} />
                  <button type="button" onClick={() => { void onCopyReferral(); }}>Copy</button>
                  <button type="button" onClick={() => { void onCopyGameUserId(); }}>Copy User ID</button>
                </div>
                {gameUserIdCopied ? <div className="settings-inline-status">Copied</div> : null}
                <button
                  type="button"
                  onClick={() => {
                    setSettingsOpen(false);
                    setNicknameDraft(accountInfo?.gameNickname ?? '');
                    setNicknameCheckState('idle');
                    setNicknameSubmitError(null);
                    setRegistrationOpen(true);
                  }}
                >
                  Change nickname
                </button>
            </>
          )}
        </RROverlayModal>
      )}

      {isMultiplayerDebugEnabled ? <div className="debug-on-badge">DBG ON</div> : null}

      <DiagnosticsOverlay enabled={isMultiplayerDebugEnabled} />


      {isMultiplayerDebugEnabled && inspectorOpen ? (
        <MultiplayerInspectorOverlay
          connected={ws.connected}
          identity={{ tgUserId: localTgUserId ?? undefined, clientId: devIdentity.clientId, displayName: profileName }}
          inboundTrace={ws.inboundTrace}
          outboundTrace={ws.outboundTrace}
          tickDebugStats={tickDebugStats}
          binding={{
            currentRoomCode: currentRoom?.roomCode ?? null,
            expectedMatchId: expectedMatchIdRef.current,
            worldReady: worldReadyRef.current,
            lastWorldInitAt,
            lastSnapshotAt,
            lastRecvSnapshotTick,
            lastAppliedSnapshotTick: lastAppliedSnapshotTickRef.current,
            bufferedSnapshotsCount: pendingSnapshotRef.current ? 1 : 0,
            wrongRoomDrops,
            wrongMatchDrops,
            duplicateTickDrops,
            invalidPosDrops: tickDebugStats?.invalidPosDrops ?? 0,
          }}
        />
      ) : null}

      <WsDebugOverlay
        connected={ws.connected}
        messages={ws.messages}
        identity={{
          id: localTgUserId,
          clientId: devIdentity.clientId,
          displayName: profileName,
        }}
        wsDiagnostics={wsDiagnostics}
        netSim={ws.netSimConfig}
        netSimPresets={ws.netSimPresets}
        onToggleNetSim={ws.setNetSimEnabled}
        onSelectNetSimPreset={ws.setNetSimPreset}
        predictionStats={predictionStats}
        ackLastInputSeq={ackLastInputSeq}
        tickDebugStats={tickDebugStats}
        rttMs={ws.rttMs}
        rttJitterMs={ws.rttJitterMs}
        localInputSeq={inputSeqRef.current}
        onLobby={() => ws.send({ type: 'lobby:list' })}
        onCreateRoom={() => ws.send({ type: 'room:create' })}
        onStartMatch={() => ws.send({ type: 'match:start' })}
        getLocalPlayerPosition={() => sceneRef.current?.getLocalPlayerPosition() ?? null}
        onMove={(dir) => {
          sendMatchMoveIntent(dir);
        }}
        inspectorEnabled={inspectorOpen}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
      />
    </main>
  );
}
