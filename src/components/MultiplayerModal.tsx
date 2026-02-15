import { useEffect, useMemo, useRef, useState } from 'react';
import {
  friendsConfirmed,
  friendsIncoming,
  friendsOutgoing,
  mockJoinRoom,
  mockListRooms,
  mockSearchUsers,
  referralMock,
  roomsPublic,
  type FriendConfirmed,
  type FriendRequest,
  type RoomCard,
  type SearchUser,
} from '../ui/mock/multiplayerMock';

type Props = {
  open: boolean;
  onClose: () => void;
};

type MainTab = 'friends' | 'find' | 'room' | 'browse' | 'referral';
type RoomView = 'room_home' | 'create_setup' | 'join_list' | 'room_lobby';
type RoomSlotPosition = 'nw' | 'ne' | 'sw' | 'se';

type RoomSlot = {
  position: RoomSlotPosition;
  type: 'host' | 'invite';
  enabled: boolean;
  occupiedBy?: string;
  ready?: boolean;
};

type RoomState = {
  name: string;
  isPrivate: boolean;
  capacity: number;
  slots: RoomSlot[];
};

type Toast = { id: number; text: string };

const roomPositions: RoomSlotPosition[] = ['nw', 'ne', 'sw', 'se'];
const hostNickname = 'HostNickname';
const localGuestNickname = 'GuestNickname';

export function MultiplayerModal({ open, onClose }: Props): JSX.Element | null {
  const [tab, setTab] = useState<MainTab>('friends');
  const [roomView, setRoomView] = useState<RoomView>('room_home');
  const [confirmed, setConfirmed] = useState<FriendConfirmed[]>(friendsConfirmed);
  const [incoming, setIncoming] = useState<FriendRequest[]>(friendsIncoming);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>(friendsOutgoing);
  const [query, setQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [requestedIds, setRequestedIds] = useState<string[]>([]);

  const [isHost, setIsHost] = useState(true);
  const [currentRoom, setCurrentRoom] = useState<RoomState | null>(null);
  const [createName, setCreateName] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createInviteSlots, setCreateInviteSlots] = useState<Record<Exclude<RoomSlotPosition, 'nw'>, boolean>>({
    ne: false,
    sw: false,
    se: false,
  });
  const [joinSearch, setJoinSearch] = useState('');
  const [joinRooms, setJoinRooms] = useState<RoomCard[]>([]);
  const [joinLoading, setJoinLoading] = useState(false);

  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseQuery, setBrowseQuery] = useState('');
  const [rooms, setRooms] = useState<RoomCard[]>(roomsPublic);
  const [lockedRoom, setLockedRoom] = useState<RoomCard | null>(null);
  const [lockedPassword, setLockedPassword] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const copyRef = useRef<HTMLInputElement | null>(null);

  const pushToast = (text: string): void => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 1800);
  };

  useEffect(() => {
    if (!open) return;
    setBrowseLoading(true);
    void mockListRooms('').then((data) => {
      setRooms(data);
      setBrowseLoading(false);
    });
  }, [open]);

  useEffect(() => {
    if (!open || tab !== 'find') return;
    const id = window.setTimeout(() => {
      setSearchLoading(true);
      void mockSearchUsers(query).then((data) => {
        setSearchResults(data);
        setSearchLoading(false);
      });
    }, 300);
    return () => window.clearTimeout(id);
  }, [open, query, tab]);

  useEffect(() => {
    if (!open || tab !== 'browse') return;
    setBrowseLoading(true);
    void mockListRooms(browseQuery).then((data) => {
      setRooms(data);
      setBrowseLoading(false);
    });
  }, [browseQuery, open, tab]);

  useEffect(() => {
    if (!open || tab !== 'room') return;
    setJoinLoading(true);
    void mockListRooms(joinSearch).then((data) => {
      setJoinRooms(data);
      setJoinLoading(false);
    });
  }, [joinSearch, open, tab]);

  const activeInviteCount = useMemo(
    () => Object.values(createInviteSlots).filter(Boolean).length,
    [createInviteSlots],
  );

  const createRoomEnabled = createName.trim().length > 0 && activeInviteCount >= 1;

  const playersCount = useMemo(() => {
    if (!currentRoom) return 0;
    return currentRoom.slots.filter((slot) => Boolean(slot.occupiedBy)).length;
  }, [currentRoom]);

  const hostCanStart = useMemo(() => {
    if (!currentRoom || !isHost) return false;
    const inviteSlots = currentRoom.slots.filter((slot) => slot.type === 'invite' && slot.enabled);
    if (inviteSlots.length === 0) return false;
    return inviteSlots.every((slot) => Boolean(slot.occupiedBy) && slot.ready === true);
  }, [currentRoom, isHost]);

  const localGuestReady = useMemo(() => {
    if (!currentRoom || isHost) return false;
    const me = currentRoom.slots.find((slot) => slot.occupiedBy === localGuestNickname);
    return Boolean(me?.ready);
  }, [currentRoom, isHost]);

  const toggleCreateInviteSlot = (position: Exclude<RoomSlotPosition, 'nw'>): void => {
    setCreateInviteSlots((prev) => ({ ...prev, [position]: !prev[position] }));
  };

  const onCreateRoom = (): void => {
    if (!createRoomEnabled) return;

    const slots: RoomSlot[] = roomPositions.map((position) => {
      if (position === 'nw') {
        return { position, type: 'host', enabled: true, occupiedBy: hostNickname };
      }
      return {
        position,
        type: 'invite',
        enabled: createInviteSlots[position],
      };
    });

    setCurrentRoom({
      name: createName.trim(),
      isPrivate: Boolean(createPassword.trim()),
      capacity: 1 + activeInviteCount,
      slots,
    });
    setIsHost(true);
    setRoomView('room_lobby');
    setJoinError(null);
    pushToast('Room created (mock)');
  };

  const onJoinRoomCard = async (room: RoomCard): Promise<void> => {
    setJoinBusy(true);
    setJoinError(null);
    const result = await mockJoinRoom(room.code, room.password);
    setJoinBusy(false);
    if (!result.ok) {
      setJoinError(result.error ?? 'Join failed');
      return;
    }

    const inviteCapacity = Math.max(room.capacity - 1, 1);
    const slots: RoomSlot[] = roomPositions.map((position, index) => {
      if (position === 'nw') {
        return { position, type: 'host', enabled: true, occupiedBy: hostNickname };
      }

      const enabled = index <= inviteCapacity;
      return {
        position,
        type: 'invite',
        enabled,
        occupiedBy: index === 1 ? localGuestNickname : undefined,
        ready: index === 1 ? false : undefined,
      };
    });

    setCurrentRoom({
      name: room.name,
      isPrivate: room.hasPassword,
      capacity: room.capacity,
      slots,
    });
    setIsHost(false);
    setRoomView('room_lobby');
    pushToast('Joined room (mock)');
  };

  const onToggleReady = (): void => {
    if (!currentRoom || isHost) return;
    setCurrentRoom({
      ...currentRoom,
      slots: currentRoom.slots.map((slot) => {
        if (slot.occupiedBy !== localGuestNickname) return slot;
        return { ...slot, ready: !slot.ready };
      }),
    });
  };

  const onHostStart = (): void => {
    if (!hostCanStart) return;
    pushToast('Starting... (mock)');
    setRoomView('room_home');
    setCurrentRoom(null);
    setIsHost(true);
  };

  const onCopy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast('Copied (mock)');
    } catch {
      copyRef.current?.focus();
      copyRef.current?.select();
      document.execCommand('copy');
      pushToast('Copied (fallback)');
    }
  };

  const onJoin = async (code: string, password?: string): Promise<void> => {
    if (!code.trim()) {
      setJoinError('Room code is required');
      return;
    }
    setJoinBusy(true);
    setJoinError(null);
    const result = await mockJoinRoom(code, password);
    setJoinBusy(false);
    if (!result.ok) {
      setJoinError(result.error ?? 'Join failed');
      return;
    }
    pushToast('Joined room (mock)');
    setLockedRoom(null);
    setLockedPassword('');
  };

  if (!open) return null;

  return (
    <div className="settings-overlay rr-mp-overlay" role="dialog" aria-modal="true" aria-label="Multiplayer">
      <div className="settings-modal rr-mp-modal">
        <div className="settings-header">
          <strong>MULTIPLAYER</strong>
          <button type="button" onClick={onClose}>Close</button>
        </div>

        <div className="rr-mp-tabs">
          {(['friends', 'find', 'room', 'browse', 'referral'] as const).map((item) => (
            <button key={item} type="button" className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </div>

        <div className="settings-panel rr-mp-panel">
          {tab === 'friends' ? (
            <>
              <section className="rr-mp-section">
                <h4>Confirmed Friends</h4>
                {confirmed.map((friend) => (
                  <div key={friend.id} className="rr-mp-card">
                    <span className="rr-mp-avatar">◉</span>
                    <strong>{friend.name}</strong>
                    <span className={`rr-mp-chip ${friend.status}`}>{friend.status}</span>
                    <button type="button" disabled={friend.status !== 'online'} onClick={() => pushToast('Invite sent (mock)')}>Invite</button>
                  </div>
                ))}
              </section>

              <section className="rr-mp-section">
                <h4>Incoming Requests</h4>
                {incoming.length === 0 ? <p className="rr-mp-empty">No incoming requests</p> : incoming.map((request) => (
                  <div key={request.id} className="rr-mp-card">
                    <strong>{request.name}</strong>
                    <div className="rr-mp-inline-actions">
                      <button type="button" onClick={() => {
                        setIncoming((prev) => prev.filter((item) => item.id !== request.id));
                        setConfirmed((prev) => [...prev, { id: `f_${request.id}`, name: request.name, status: 'online' }]);
                      }}>
                        Accept
                      </button>
                      <button type="button" className="ghost" onClick={() => setIncoming((prev) => prev.filter((item) => item.id !== request.id))}>Decline</button>
                    </div>
                  </div>
                ))}
              </section>

              <section className="rr-mp-section">
                <h4>Outgoing Requests</h4>
                {outgoing.length === 0 ? <p className="rr-mp-empty">No outgoing requests</p> : outgoing.map((request) => (
                  <div key={request.id} className="rr-mp-card">
                    <strong>{request.name}</strong>
                    <span className="rr-mp-chip pending">Pending...</span>
                    <button type="button" className="ghost" onClick={() => setOutgoing((prev) => prev.filter((item) => item.id !== request.id))}>Cancel</button>
                  </div>
                ))}
              </section>
            </>
          ) : null}

          {tab === 'find' ? (
            <section className="rr-mp-section">
              <h4>Find friends</h4>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name" />
              {searchLoading ? <p>Searching...</p> : null}
              {!searchLoading && searchResults.length === 0 ? <p className="rr-mp-empty">No users found</p> : null}
              {searchResults.map((user) => {
                const requested = requestedIds.includes(user.id);
                return (
                  <div key={user.id} className="rr-mp-card">
                    <strong>{user.name}</strong>
                    <button
                      type="button"
                      disabled={requested}
                      onClick={() => {
                        setRequestedIds((prev) => [...prev, user.id]);
                        setOutgoing((prev) => [...prev, { id: user.id, name: user.name }]);
                      }}
                    >
                      {requested ? 'Requested' : 'Add'}
                    </button>
                  </div>
                );
              })}
            </section>
          ) : null}

          {tab === 'room' ? (
            <section className="rr-mp-section rr-room-section">
              {roomView === 'room_home' ? (
                <div className="rr-room-home">
                  <h4>ROOM</h4>
                  <button type="button" onClick={() => setRoomView('create_setup')}>Create Room</button>
                  <button type="button" onClick={() => setRoomView('join_list')}>Join Room</button>
                </div>
              ) : null}

              {roomView === 'create_setup' ? (
                <div className="rr-room-flow">
                  <h4>Create Room</h4>
                  <input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="Room Name" />
                  <input value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} placeholder="Password (optional)" />

                  <div className="rr-arena-container" aria-label="room arena">
                    {roomPositions.map((position) => {
                      const isHostSlot = position === 'nw';
                      const enabled = isHostSlot ? true : createInviteSlots[position as Exclude<RoomSlotPosition, 'nw'>];
                      return (
                        <button
                          key={position}
                          type="button"
                          className={`rr-arena-slot ${position} ${isHostSlot ? 'host' : enabled ? 'active' : 'inactive'}`}
                          onClick={() => {
                            if (isHostSlot) return;
                            toggleCreateInviteSlot(position as Exclude<RoomSlotPosition, 'nw'>);
                          }}
                        >
                          {isHostSlot ? (
                            <>
                              <strong>{hostNickname}</strong>
                              <span>Host</span>
                            </>
                          ) : enabled ? (
                            <>
                              <strong>ACTIVE</strong>
                              <span>Invite slot</span>
                            </>
                          ) : (
                            <>
                              <strong>Add Player</strong>
                              <span>👤＋</span>
                            </>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  <button type="button" onClick={onCreateRoom} disabled={!createRoomEnabled}>Create Room</button>
                </div>
              ) : null}

              {roomView === 'join_list' ? (
                <div className="rr-room-flow">
                  <h4>Join Lobby</h4>
                  <input value={joinSearch} onChange={(event) => setJoinSearch(event.target.value)} placeholder="Search by room name" />
                  {joinLoading ? <p>Loading rooms...</p> : null}
                  {!joinLoading && joinRooms.length === 0 ? <p className="rr-mp-empty">No rooms found</p> : null}
                  {joinRooms.map((room) => (
                    <div key={room.code} className="rr-mp-card rr-room-list-item">
                      <strong>{room.name}</strong>
                      <span>Players {room.players}/{room.capacity}</span>
                      <span>{room.hasPassword ? '🔒' : ''}</span>
                      <button type="button" disabled={joinBusy} onClick={() => { void onJoinRoomCard(room); }}>Join</button>
                    </div>
                  ))}
                  {joinError ? <p className="rr-mp-error">{joinError}</p> : null}
                </div>
              ) : null}

              {roomView === 'room_lobby' && currentRoom ? (
                <div className="rr-room-flow">
                  <div className="rr-room-lobby-head">
                    <strong>{currentRoom.name}</strong>
                    <span>{currentRoom.isPrivate ? '🔒 Private' : 'Public'}</span>
                    <span>Players: {playersCount}/{currentRoom.capacity}</span>
                  </div>

                  <div className="rr-arena-container" aria-label="lobby arena slots">
                    {currentRoom.slots.map((slot) => (
                      <div key={slot.position} className={`rr-arena-slot ${slot.position} ${slot.type === 'host' ? 'host' : slot.enabled ? 'active' : 'inactive'}`}>
                        {slot.type === 'host' ? (
                          <>
                            <strong>{slot.occupiedBy}</strong>
                            <span>Host</span>
                          </>
                        ) : !slot.enabled ? (
                          <span>Disabled</span>
                        ) : slot.occupiedBy ? (
                          <>
                            <strong>{slot.occupiedBy}</strong>
                            <span className={slot.ready ? 'rr-ready-on' : 'rr-ready-off'}>{slot.ready ? 'Ready' : 'Not ready'}</span>
                          </>
                        ) : (
                          <span>Waiting...</span>
                        )}
                      </div>
                    ))}
                  </div>

                  {isHost ? (
                    <button type="button" disabled={!hostCanStart} onClick={onHostStart}>Start</button>
                  ) : (
                    <button type="button" className={localGuestReady ? 'rr-ready-button-on' : ''} onClick={onToggleReady}>
                      {localGuestReady ? 'Ready' : 'Not Ready'}
                    </button>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}

          {tab === 'browse' ? (
            <section className="rr-mp-section">
              <h4>Browse rooms</h4>
              <input value={browseQuery} onChange={(event) => setBrowseQuery(event.target.value)} placeholder="Search room" />
              {browseLoading ? <p>Loading rooms...</p> : null}
              {!browseLoading && rooms.length === 0 ? <p className="rr-mp-empty">No rooms found</p> : null}
              {rooms.map((room) => (
                <div key={room.code} className="rr-mp-card">
                  <strong>{room.name}</strong>
                  <span>{room.players}/{room.capacity}</span>
                  <span>{room.hasPassword ? '🔒' : '🔓'}</span>
                  <button type="button" onClick={() => {
                    if (room.hasPassword) {
                      setLockedRoom(room);
                      return;
                    }
                    void onJoin(room.code);
                  }}>
                    Join
                  </button>
                </div>
              ))}
            </section>
          ) : null}

          {tab === 'referral' ? (
            <section className="rr-mp-section">
              <h4>Invite friends. Earn Plasma.</h4>
              <div className="rr-mp-row">
                <input ref={copyRef} readOnly value={referralMock.link} />
                <button type="button" onClick={() => { void onCopy(referralMock.link); }}>Copy</button>
              </div>
              <div className="rr-mp-card">
                <span>Plasma earned: {referralMock.plasmaEarned}</span>
                <span>Invited friends: {referralMock.invitedFriends}</span>
              </div>
              <div className="rr-mp-rules">
                <p>Friend reaches Stage 3 → +50 Plasma</p>
                <p>Friend makes purchase → +100 Plasma</p>
              </div>
              <button type="button" onClick={() => pushToast('Share opened (mock)')}>Share</button>
            </section>
          ) : null}
        </div>

        {lockedRoom ? (
          <div className="rr-password-popup" role="dialog" aria-modal="true" aria-label="Room password">
            <strong>Enter password for {lockedRoom.name}</strong>
            <input value={lockedPassword} onChange={(event) => setLockedPassword(event.target.value)} placeholder="Password" />
            <div className="rr-mp-inline-actions">
              <button type="button" onClick={() => { void onJoin(lockedRoom.code, lockedPassword); }}>Confirm</button>
              <button type="button" className="ghost" onClick={() => setLockedRoom(null)}>Cancel</button>
            </div>
          </div>
        ) : null}

        <div className="rr-toast-stack">
          {toasts.map((toast) => <div key={toast.id} className="rr-toast">{toast.text}</div>)}
        </div>
      </div>
    </div>
  );
}
