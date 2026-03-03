import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FriendEntry,
  IncomingFriendRequest,
  MyRoomEntry,
  OutgoingFriendRequest,
  PublicRoomEntry,
  RoomMember,
  RoomState,
} from '../game/wallet';

type MainTab = 'friends' | 'find' | 'room' | 'browse' | 'referral';
type RoomScreen = 'home' | 'create' | 'join' | 'lobby';
type SlotPosition = 'nw' | 'ne' | 'sw' | 'se';

type Props = {
  open: boolean;
  onClose: () => void;
  initialTab?: 'room' | 'friends';
  initialRoomTab?: 'create' | 'join';
  initialJoinCode?: string;
  autoJoin?: boolean;
  roomsLoading: boolean;
  roomsError: string | null;
  myRooms?: MyRoomEntry[];
  publicRooms: PublicRoomEntry[];
  currentRoom: RoomState | null;
  currentRoomMembers: RoomMember[];
  joiningRoomCode: string | null;
  creatingRoom: boolean;
  settingReady: boolean;
  startingRoom: boolean;
  onCreateRoom: (capacity: 2 | 3 | 4) => Promise<void>;
  onJoinRoomByCode: (code: string) => Promise<void>;
  onSearchPublicRooms: (query?: string) => Promise<void>;
  onLeaveRoom: () => Promise<void>;
  onCloseRoom: () => Promise<void>;
  onStartRoom: () => Promise<void>;
  onToggleReady: () => Promise<void>;
  onCopyInviteLink: () => Promise<void>;
  friendsLoading: boolean;
  friendsError: string | null;
  friendsList: FriendEntry[];
  incomingRequests: IncomingFriendRequest[];
  outgoingRequests: OutgoingFriendRequest[];
  onSendFriendRequest: (tgUserId: string) => Promise<void>;
  onRespondFriendRequest: (fromTgUserId: string, action: 'accept' | 'decline') => Promise<void>;
  onInviteFriend: (tgUserId: string) => Promise<void>;
  referralLink: string;
  onCopyReferralLink: () => Promise<void>;
  localTgUserId?: string;
  onConsumeInitialJoinCode?: () => void;
};

const SLOT_POSITIONS: readonly SlotPosition[] = ['nw', 'ne', 'sw', 'se'];

export function MultiplayerModal({
  open,
  onClose,
  initialTab,
  initialRoomTab,
  initialJoinCode,
  autoJoin,
  roomsLoading,
  roomsError,
  myRooms = [],
  publicRooms,
  currentRoom,
  currentRoomMembers,
  joiningRoomCode,
  creatingRoom,
  settingReady,
  startingRoom,
  onCreateRoom,
  onJoinRoomByCode,
  onSearchPublicRooms,
  onLeaveRoom,
  onCloseRoom,
  onStartRoom,
  onToggleReady,
  onCopyInviteLink,
  friendsLoading,
  friendsError,
  friendsList,
  incomingRequests,
  outgoingRequests,
  onSendFriendRequest,
  onRespondFriendRequest,
  onInviteFriend,
  referralLink,
  onCopyReferralLink,
  localTgUserId,
  onConsumeInitialJoinCode,
}: Props): JSX.Element | null {
  const [activeMainTab, setActiveMainTab] = useState<MainTab>(initialTab ?? 'room');
  const [roomScreen, setRoomScreen] = useState<RoomScreen>(initialRoomTab ?? 'home');
  const [joinCodeDraft, setJoinCodeDraft] = useState(initialJoinCode ?? '');
  const [friendTargetDraft, setFriendTargetDraft] = useState('');
  const [roomNameDraft, setRoomNameDraft] = useState('');
  const [roomPasswordDraft, setRoomPasswordDraft] = useState('');
  const [createSlots, setCreateSlots] = useState<[boolean, boolean, boolean]>([true, false, false]);
  const [roomSearchDraft, setRoomSearchDraft] = useState('');
  const [passwordPromptRoomCode, setPasswordPromptRoomCode] = useState<string | null>(null);
  const [passwordPromptDraft, setPasswordPromptDraft] = useState('');
  const [passwordPromptError, setPasswordPromptError] = useState<string | null>(null);
  const autoJoinRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (initialTab) setActiveMainTab(initialTab);
    if (initialRoomTab) setRoomScreen(initialRoomTab);
    if (initialJoinCode) setJoinCodeDraft(initialJoinCode);
  }, [initialJoinCode, initialRoomTab, initialTab, open]);

  useEffect(() => {
    if (!open || activeMainTab !== 'room') return;
    if (currentRoom) {
      setRoomScreen('lobby');
      return;
    }
    if (roomScreen === 'lobby') {
      setRoomScreen('home');
    }
  }, [activeMainTab, currentRoom, open, roomScreen]);

  useEffect(() => {
    if (!open || !autoJoin || !initialJoinCode) return;

    const code = initialJoinCode.trim().toUpperCase();
    if (!code) return;
    if (autoJoinRef.current === code) return;
    if (joiningRoomCode === code) return;

    if (currentRoom?.roomCode === code) {
      autoJoinRef.current = code;
      onConsumeInitialJoinCode?.();
      return;
    }

    autoJoinRef.current = code;
    void onJoinRoomByCode(code);
  }, [autoJoin, currentRoom?.roomCode, initialJoinCode, joiningRoomCode, onConsumeInitialJoinCode, onJoinRoomByCode, open]);

  const roomNameError = roomNameDraft.trim() ? null : 'Room name is required';
  const selectedCreateSlots = createSlots.filter(Boolean).length;
  const desiredCapacity = 1 + selectedCreateSlots;
  const apiCapacity: 2 | 3 | 4 = desiredCapacity <= 2 ? 2 : desiredCapacity === 3 ? 3 : 4;

  const meReady = useMemo(
    () => currentRoomMembers.find((member) => member.tgUserId === localTgUserId)?.ready ?? false,
    [currentRoomMembers, localTgUserId],
  );

  const hostMember = useMemo(() => {
    if (!currentRoomMembers.length) return null;
    if (!currentRoom?.ownerTgUserId) return currentRoomMembers[0] ?? null;
    return currentRoomMembers.find((member) => member.tgUserId === currentRoom.ownerTgUserId) ?? currentRoomMembers[0] ?? null;
  }, [currentRoom?.ownerTgUserId, currentRoomMembers]);

  const nonHostMembers = useMemo(
    () => currentRoomMembers.filter((member) => member.tgUserId !== hostMember?.tgUserId),
    [currentRoomMembers, hostMember?.tgUserId],
  );

  const isHost = Boolean(localTgUserId && currentRoom?.ownerTgUserId && localTgUserId === currentRoom.ownerTgUserId);
  const canStart = isHost
    && !startingRoom
    && (currentRoom?.phase ?? 'LOBBY') !== 'STARTED'
    && nonHostMembers.length > 0
    && nonHostMembers.every((member) => member.ready ?? false);

  const filteredRooms = useMemo(() => {
    const roomsSource: PublicRoomEntry[] = publicRooms.length > 0
      ? publicRooms
      : myRooms.map((room) => ({
        roomCode: room.roomCode,
        name: `Room ${room.roomCode}`,
        hostDisplayName: 'Host',
        players: room.memberCount,
        capacity: room.capacity,
        hasPassword: false,
      }));
    const query = roomSearchDraft.trim().toLowerCase();
    if (!query) return roomsSource;
    return roomsSource.filter((room) => {
      const composite = `${room.roomCode} ${room.name} ${room.hostDisplayName}`.toLowerCase();
      return composite.includes(query);
    });
  }, [myRooms, publicRooms, roomSearchDraft]);

  const lobbyMembersBySlot = useMemo(() => {
    const members: Array<RoomMember | null> = [null, null, null, null];
    if (hostMember) members[0] = hostMember;

    const others = currentRoomMembers.filter((member) => member.tgUserId !== hostMember?.tgUserId);
    others.slice(0, 3).forEach((member, index) => {
      members[index + 1] = member;
    });

    return members;
  }, [currentRoomMembers, hostMember]);

  useEffect(() => {
    if (!open || activeMainTab !== 'room' || roomScreen !== 'join') return;

    const timeout = setTimeout(() => {
      void onSearchPublicRooms(roomSearchDraft);
    }, 150);

    return () => clearTimeout(timeout);
  }, [activeMainTab, onSearchPublicRooms, open, roomScreen, roomSearchDraft]);

  const handleCreate = async (): Promise<void> => {
    if (roomNameError) return;
    await onCreateRoom(apiCapacity);
    setRoomScreen('lobby');
  };

  const handleJoinByCode = async (codeRaw: string): Promise<void> => {
    const code = codeRaw.trim().toUpperCase();
    if (!code) return;
    await onJoinRoomByCode(code);
    setRoomScreen('lobby');
  };

  const handleLeave = async (): Promise<void> => {
    if (!currentRoom) {
      setRoomScreen('home');
      return;
    }

    if (isHost) {
      await onCloseRoom();
    } else {
      await onLeaveRoom();
    }

    setRoomScreen('home');
  };

  const parsedFriendTarget = useMemo(() => {
    const normalized = friendTargetDraft.trim();
    if (!normalized) return null;

    if (normalized.startsWith('@')) {
      const usernameWithoutAt = normalized.slice(1).trim();
      return usernameWithoutAt || null;
    }

    return normalized;
  }, [friendTargetDraft]);

  const onSendFriendTarget = (): void => {
    if (!parsedFriendTarget) return;
    void onSendFriendRequest(parsedFriendTarget);
    setFriendTargetDraft('');
  };

  if (!open) return null;

  return (
    <div className="settings-overlay rr-mp-overlay rr-overlay" role="dialog" aria-modal="true" aria-label="Multiplayer">
      <div className="settings-modal rr-mp-modal rr-overlay-modal">
        <div className="settings-header rr-mp-header">
          <strong className="rr-mp-title">MULTIPLAYER</strong>
          <button type="button" className="rr-mp-close" onClick={onClose}>Close</button>
        </div>

        <div className="rr-mp-tabs">
          {(['friends', 'find', 'room', 'browse', 'referral'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`rr-mp-tab rr-mp-tab--${item} ${activeMainTab === item ? 'active' : ''}`}
              onClick={() => setActiveMainTab(item)}
            >
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </div>

        <div className="settings-panel rr-mp-panel">
          {activeMainTab === 'friends' ? (
            <>
              {friendsError ? <p className="rr-mp-error">{friendsError}</p> : null}
              {friendsLoading ? <p className="rr-mp-empty">Loading friends...</p> : null}

              <section className="rr-mp-section rr-friends-panel">
                <h4 className="rr-mp-section-title">Incoming requests</h4>
                {incomingRequests.length === 0 ? <p className="rr-mp-empty">No incoming requests.</p> : null}
                {incomingRequests.map((request) => (
                  <div key={request.fromTgUserId} className="rr-mp-card">
                    <span className="rr-mp-avatar">👤</span>
                    <span className="rr-mp-card-label">{request.displayName}</span>
                    <button type="button" className="rr-mp-mini-button" onClick={() => { void onRespondFriendRequest(request.fromTgUserId, 'accept'); }}>Accept</button>
                    <button type="button" className="ghost rr-mp-mini-button" onClick={() => { void onRespondFriendRequest(request.fromTgUserId, 'decline'); }}>Decline</button>
                  </div>
                ))}
              </section>

              <section className="rr-mp-section rr-friends-panel">
                <h4 className="rr-mp-section-title">Outgoing requests</h4>
                {outgoingRequests.length === 0 ? <p className="rr-mp-empty">No outgoing requests.</p> : null}
                {outgoingRequests.map((request) => (
                  <div key={request.toTgUserId} className="rr-mp-card">
                    <span className="rr-mp-avatar">⏳</span>
                    <span className="rr-mp-card-label">{request.displayName}</span>
                    <span className="rr-mp-chip pending">{request.status}</span>
                  </div>
                ))}
              </section>

              <section className="rr-mp-section rr-friends-panel">
                <h4 className="rr-mp-section-title">Friends</h4>
                {friendsList.length === 0 ? <p className="rr-mp-empty">No friends yet.</p> : null}
                {friendsList.map((friend) => (
                  <div key={friend.tgUserId} className="rr-mp-card">
                    <span className="rr-mp-avatar">👥</span>
                    <span className="rr-mp-card-label">{friend.displayName}</span>
                    <span className="rr-mp-chip">friend</span>
                    <button type="button" className="rr-mp-mini-button" onClick={() => { void onInviteFriend(friend.tgUserId); }}>Invite</button>
                  </div>
                ))}
              </section>
            </>
          ) : null}

          {activeMainTab === 'room' ? (
            <section className="rr-mp-section rr-room-shell">
              {roomScreen === 'home' ? (
                <div className="rr-room-home">
                  <button type="button" onClick={() => setRoomScreen('create')}>Create</button>
                  <button type="button" onClick={() => setRoomScreen('join')}>Join</button>
                </div>
              ) : null}

              {roomScreen === 'create' ? (
                <div className="rr-room-flow">
                  <div className="rr-room-flow-head">
                    <button type="button" className="ghost rr-room-back-button" onClick={() => setRoomScreen('home')}>Back</button>
                  </div>
                  <div className="rr-room-fields-row">
                    <label className="rr-room-field">
                      <span>Room name</span>
                      <input type="text" value={roomNameDraft} placeholder="Room-host" onChange={(event) => setRoomNameDraft(event.target.value)} />
                    </label>
                    <label className="rr-room-field">
                      <span>Password (optional)</span>
                      <input type="password" value={roomPasswordDraft} placeholder="Optional" onChange={(event) => setRoomPasswordDraft(event.target.value)} />
                    </label>
                  </div>
                  {roomNameError ? <p className="rr-mp-error">{roomNameError}</p> : null}

                  <div className="rr-room-corner-board">
                    <div className="rr-room-slot-preview host nw">
                      <strong>{hostMember?.displayName ?? 'Host'}</strong>
                      <span>Host</span>
                    </div>
                    {createSlots.map((enabled, index) => {
                      const position = SLOT_POSITIONS[index + 1];
                      const canRemove = selectedCreateSlots > 1;
                      const isDisabled = enabled && !canRemove;
                      return (
                        <button
                          key={position}
                          type="button"
                          className={`rr-room-slot-preview ${position} ${enabled ? 'enabled' : 'waiting'}`}
                          disabled={isDisabled}
                          onClick={() => {
                            if (isDisabled) return;
                            setCreateSlots((prev) => {
                              const next: [boolean, boolean, boolean] = [...prev] as [boolean, boolean, boolean];
                              next[index] = !next[index];
                              return next;
                            });
                          }}
                        >
                          <strong>{enabled ? 'Remove player' : 'Add player'}</strong>
                          <span>{enabled ? (canRemove ? 'Tap to remove' : 'Minimum 2 players required') : 'Tap to include'}</span>
                        </button>
                      );
                    })}

                    <div className="rr-room-board-center">
                      <button type="button" className="rr-room-create-cta" disabled={Boolean(roomNameError) || creatingRoom} onClick={() => { void handleCreate(); }}>
                        {creatingRoom ? 'Creating...' : 'Create'}
                      </button>
                      <span className="rr-mp-empty rr-room-players-line">Players: {desiredCapacity} requested</span>
                    </div>
                  </div>
                </div>
              ) : null}

              {roomScreen === 'join' ? (
                <div className="rr-room-flow">
                  <div className="rr-room-flow-head">
                    <h4 className="rr-mp-section-title">Join room</h4>
                    <button type="button" className="ghost rr-room-back-button" onClick={() => setRoomScreen('home')}>Back</button>
                  </div>

                  <div className="rr-room-join-card">
                    <input
                      type="text"
                      className="rr-room-search-input"
                      value={roomSearchDraft}
                      onChange={(event) => setRoomSearchDraft(event.target.value)}
                      placeholder="Search rooms…"
                    />

                    <div className="rr-room-list">
                      {filteredRooms.length === 0 ? <p className="rr-mp-empty rr-room-empty-state">No rooms found.</p> : null}
                      {filteredRooms.map((room) => (
                        <button
                          key={room.roomCode}
                          type="button"
                          className="rr-room-list-item"
                          disabled={Boolean(joiningRoomCode)}
                          onClick={() => {
                            if (room.hasPassword) {
                              setPasswordPromptRoomCode(room.roomCode);
                              setPasswordPromptDraft('');
                              setPasswordPromptError(null);
                              return;
                            }
                            void handleJoinByCode(room.roomCode);
                          }}
                        >
                          <span>{room.roomCode} — {room.name}</span>
                          <span>Host: {room.hostDisplayName}</span>
                          <span>{room.players}/{room.capacity} {room.hasPassword ? '🔒' : '🔓'}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {roomsError ? <p className="rr-mp-error">{roomsError}</p> : null}
                  {roomsLoading ? <p className="rr-mp-empty">Loading rooms...</p> : null}
                  {joiningRoomCode ? <p className="rr-mp-empty">Joining {joiningRoomCode}...</p> : null}

                  <div className="rr-room-code-fallback">
                    <h4 className="rr-mp-section-title">Join by code</h4>
                    <div className="rr-mp-row rr-room-code-row">
                      <input
                        type="text"
                        value={joinCodeDraft}
                        onChange={(event) => setJoinCodeDraft(event.target.value.toUpperCase())}
                        placeholder="Room code"
                      />
                      <button
                        type="button"
                        className="rr-room-join-cta"
                        disabled={Boolean(joiningRoomCode)}
                        onClick={() => {
                          void handleJoinByCode(joinCodeDraft);
                        }}
                      >
                        {joiningRoomCode ? 'Joining...' : 'Join'}
                      </button>
                    </div>
                  </div>

                  {passwordPromptRoomCode ? (
                    <div className="rr-password-popup">
                      <strong>Enter password</strong>
                      <input
                        type="password"
                        value={passwordPromptDraft}
                        onChange={(event) => {
                          setPasswordPromptDraft(event.target.value);
                          if (passwordPromptError) setPasswordPromptError(null);
                        }}
                        placeholder="Password"
                      />
                      {passwordPromptError ? <p className="rr-mp-error">{passwordPromptError}</p> : null}
                      <div className="rr-mp-inline-actions">
                        <button
                          type="button"
                          onClick={() => {
                            if (!passwordPromptDraft.trim()) {
                              setPasswordPromptError('Wrong password');
                              return;
                            }
                            void handleJoinByCode(passwordPromptRoomCode);
                            setPasswordPromptRoomCode(null);
                          }}
                        >
                          Join
                        </button>
                        <button type="button" className="ghost" onClick={() => setPasswordPromptRoomCode(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {roomScreen === 'lobby' ? (
                <div className="rr-room-flow">
                  <div className="rr-room-lobby-head">
                    <h4>Lobby</h4>
                    <strong>{currentRoom?.roomCode ?? '---'}</strong>
                  </div>

                  <div className="rr-room-corner-board lobby">
                    {SLOT_POSITIONS.map((position, index) => {
                      const member = lobbyMembersBySlot[index];
                      const slotDisabled = index >= Number(currentRoom?.capacity ?? 4);
                      const isSlotHost = member?.tgUserId != null && member.tgUserId === hostMember?.tgUserId;
                      const isReady = member?.ready ?? false;

                      return (
                        <div
                          key={position}
                          className={`rr-room-slot-preview ${position} ${member ? 'occupied' : 'waiting'} ${isReady ? 'ready' : ''} ${isSlotHost ? 'host' : ''} ${slotDisabled ? 'disabled' : ''}`}
                        >
                          <strong>{slotDisabled ? 'Reserved slot' : (member?.displayName ?? 'Waiting for player')}</strong>
                          <span>{slotDisabled ? 'Not used for this room size' : (isSlotHost ? 'Host' : (member ? (isReady ? 'Ready' : 'Not ready') : 'Open slot'))}</span>
                          {isHost && member && !isSlotHost ? (
                            <button
                              type="button"
                              className="rr-slot-kick"
                              disabled
                              title="Kick is unavailable with current API"
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      );
                    })}

                    <div className="rr-room-board-center">
                      {!isHost ? (
                        <button type="button" className={meReady ? 'rr-ready-button-on' : ''} disabled={settingReady} onClick={() => { void onToggleReady(); }}>
                          {settingReady ? 'Saving...' : (meReady ? 'Ready ✓' : 'Ready')}
                        </button>
                      ) : (
                        <button type="button" disabled={!canStart} onClick={() => { void onStartRoom(); }}>
                          {startingRoom ? 'Starting...' : 'Start'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="rr-mp-inline-actions rr-room-actions">
                    <button type="button" onClick={() => { void onCopyInviteLink(); }}>Copy invite link</button>
                    <button type="button" className="ghost" onClick={() => { void handleLeave(); }}>Leave room</button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {activeMainTab === 'find' ? (
            <section className="rr-mp-section">
              <h4>Find a friend</h4>
              <div className="rr-mp-row">
                <input
                  type="text"
                  value={friendTargetDraft}
                  onChange={(event) => setFriendTargetDraft(event.target.value)}
                  placeholder="tg_user_id, nickname, or @username"
                />
                <button type="button" disabled={!parsedFriendTarget} onClick={onSendFriendTarget}>
                  Send
                </button>
              </div>
            </section>
          ) : null}
          {activeMainTab === 'browse' ? <section className="rr-mp-section"><h4>Browse</h4><p className="rr-mp-empty">Coming soon</p></section> : null}
          {activeMainTab === 'referral' ? (
            <section className="rr-mp-section">
              <h4>Referral</h4>
              {referralLink ? (
                <div className="rr-mp-row">
                  <input type="text" readOnly value={referralLink} />
                  <button type="button" onClick={() => { void onCopyReferralLink(); }}>Copy</button>
                </div>
              ) : (
                <p className="rr-mp-empty">Referral link is not available yet.</p>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
