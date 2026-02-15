import { useEffect, useMemo, useRef, useState } from 'react';
import {
  friendsConfirmed,
  friendsIncoming,
  friendsOutgoing,
  mockCreateRoom,
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
type RoomTab = 'create' | 'join';
type LobbyPlayer = {
  name: string;
  ready: boolean;
  isSelf: boolean;
};
type MockLobbyRoom = {
  code: string;
  name: string;
  activeSlots: boolean[];
  players: Array<LobbyPlayer | null>;
  hostIsSelf: boolean;
};

type Toast = { id: number; text: string };

export function MultiplayerModal({ open, onClose }: Props): JSX.Element | null {
  const [tab, setTab] = useState<MainTab>('friends');
  const [roomTab, setRoomTab] = useState<RoomTab>('create');
  const [confirmed, setConfirmed] = useState<FriendConfirmed[]>(friendsConfirmed);
  const [incoming, setIncoming] = useState<FriendRequest[]>(friendsIncoming);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>(friendsOutgoing);
  const [query, setQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [requestedIds, setRequestedIds] = useState<string[]>([]);
  const [createName, setCreateName] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createSlots, setCreateSlots] = useState<boolean[]>([true, true, false, false]);
  const [creating, setCreating] = useState(false);
  const [roomLobby, setRoomLobby] = useState<MockLobbyRoom | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
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

  const activeSlots = useMemo(() => createSlots.filter(Boolean).length, [createSlots]);

  const toggleSlot = (index: number): void => {
    const currentActive = createSlots.filter(Boolean).length;
    const nextValue = !createSlots[index];
    if (!nextValue && currentActive <= 2) return;
    if (nextValue && currentActive >= 4) return;
    setCreateSlots((prev) => prev.map((slot, i) => (i === index ? nextValue : slot)));
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

  const onCreateRoom = async (): Promise<void> => {
    if (!createName.trim() || activeSlots < 2) {
      pushToast('Room Name and at least 2 active slots are required');
      return;
    }
    setCreating(true);
    const room = await mockCreateRoom({
      roomName: createName.trim(),
      password: createPassword.trim(),
      activeSlots,
    });
    const firstActiveSlot = createSlots.findIndex(Boolean);
    const nextPlayers = createSlots.map((isActive, index) => {
      if (!isActive) return null;
      if (index === firstActiveSlot) return { name: 'You', ready: false, isSelf: true } as LobbyPlayer;
      return null;
    });
    // backend-relevant: this lobby shape mirrors future WS events (roomCreated/playerJoined/playerReady/hostStart).
    setRoomLobby({
      code: room.code,
      name: room.name,
      activeSlots: [...createSlots],
      players: nextPlayers,
      hostIsSelf: true,
    });
    setCreating(false);
    pushToast('Room created (mock)');
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
    const capacity = Math.max(2, Math.min(result.room?.capacity ?? 4, 4));
    const activeSlotsFromRoom = [0, 1, 2, 3].map((index) => index < capacity);
    const players = activeSlotsFromRoom.map((isActive, index) => {
      if (!isActive) return null;
      if (index === 0) return { name: 'Host', ready: true, isSelf: false } as LobbyPlayer;
      if (index === 1) return { name: 'You', ready: false, isSelf: true } as LobbyPlayer;
      return null;
    });
    setRoomLobby({
      code: result.room?.code ?? code.trim().toUpperCase(),
      name: result.room?.name ?? 'Joined room',
      activeSlots: activeSlotsFromRoom,
      players,
      hostIsSelf: false,
    });
  };


  const activeLobbySlots = roomLobby?.activeSlots.reduce<number[]>((acc, isActive, index) => {
    if (isActive) acc.push(index);
    return acc;
  }, []) ?? [];
  const allActiveOccupied = roomLobby ? activeLobbySlots.every((index) => roomLobby.players[index]) : false;
  const allOccupiedReady = roomLobby ? activeLobbySlots.every((index) => {
    const player = roomLobby.players[index];
    return !player || player.ready;
  }) : false;
  const canHostStart = Boolean(roomLobby?.hostIsSelf && allActiveOccupied && allOccupiedReady);
  const selfSlotIndex = roomLobby?.players.findIndex((player) => player?.isSelf) ?? -1;

  const onToggleSelfReady = (): void => {
    if (!roomLobby || selfSlotIndex < 0 || roomLobby.hostIsSelf) return;
    setRoomLobby((prev) => {
      if (!prev || selfSlotIndex < 0) return prev;
      const players = [...prev.players];
      const current = players[selfSlotIndex];
      if (!current) return prev;
      players[selfSlotIndex] = { ...current, ready: !current.ready };
      return { ...prev, players };
    });
  };

  const onMockFillLobby = (): void => {
    if (!roomLobby) return;
    setRoomLobby((prev) => {
      if (!prev) return prev;
      const players = prev.players.map((player, index) => {
        if (!prev.activeSlots[index]) return null;
        if (player) return player;
        return { name: `Player ${index + 1}`, ready: false, isSelf: false } as LobbyPlayer;
      });
      return { ...prev, players };
    });
  };

  const onMockReadyAll = (): void => {
    if (!roomLobby) return;
    setRoomLobby((prev) => {
      if (!prev) return prev;
      const players = prev.players.map((player, index) => {
        if (!player || !prev.activeSlots[index]) return player;
        return { ...player, ready: true };
      });
      return { ...prev, players };
    });
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
              <div className="rr-room-subtabs">
                <button type="button" className={roomTab === 'create' ? 'active' : ''} onClick={() => setRoomTab('create')}>Create</button>
                <button type="button" className={roomTab === 'join' ? 'active' : ''} onClick={() => setRoomTab('join')}>Join</button>
              </div>

              {roomTab === 'join' ? (
                <>
                  <h4>Join room</h4>
                  <input value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="Room Code" />
                  <input value={joinPassword} onChange={(event) => setJoinPassword(event.target.value)} placeholder="Password (optional)" />
                  <button type="button" disabled={joinBusy} onClick={() => { void onJoin(joinCode, joinPassword); }}>{joinBusy ? 'Joining...' : 'Join by code'}</button>
                  {joinError ? <p className="rr-mp-error">{joinError}</p> : null}
                  <div className="rr-room-join-list">
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
                  </div>
                </>
              ) : null}

              {roomTab === 'create' && !roomLobby ? (
                <div className="rr-room-overlay" role="dialog" aria-modal="true" aria-label="Create Room Setup">
                  <h4>Create Room Setup</h4>
                  <input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="Room Name" />
                  <input value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} placeholder="Password (optional)" />
                  <div className="rr-arena-grid" aria-label="arena slots">
                    {createSlots.map((slot, index) => (
                      <button key={String(index)} type="button" className={slot ? 'active' : ''} onClick={() => toggleSlot(index)}>
                        {slot ? `Slot ${index + 1}: Active` : `+ Add player (${index + 1})`}
                      </button>
                    ))}
                  </div>
                  <p className="rr-mp-empty">Active slots: {activeSlots} / 4 (min 2)</p>
                  <button type="button" onClick={() => { void onCreateRoom(); }} disabled={creating || !createName.trim() || activeSlots < 2}>
                    {creating ? 'Creating...' : 'Create Room'}
                  </button>
                </div>
              ) : null}

              {roomTab === 'create' && roomLobby ? (
                <div className="rr-room-overlay" role="dialog" aria-modal="true" aria-label="Room Lobby">
                  <h4>Room Lobby — {roomLobby.name}</h4>
                  <div className="rr-mp-row">
                    <input ref={copyRef} readOnly value={roomLobby.code} />
                    <button type="button" onClick={() => { void onCopy(roomLobby.code); }}>Copy code</button>
                  </div>
                  <div className="rr-arena-grid" aria-label="lobby slots">
                    {roomLobby.activeSlots.map((isActive, index) => {
                      if (!isActive) {
                        return <div key={String(index)} className="rr-slot-disabled">Slot {index + 1} disabled</div>;
                      }
                      const player = roomLobby.players[index];
                      if (!player) {
                        return <div key={String(index)} className="rr-slot-waiting">Slot {index + 1}: Waiting…</div>;
                      }
                      return (
                        <div key={String(index)} className="rr-slot-occupied">
                          <strong>{player.name}</strong>
                          <span>{player.ready ? 'Ready' : 'Not ready'}</span>
                        </div>
                      );
                    })}
                  </div>
                  {!roomLobby.hostIsSelf ? (
                    <button type="button" onClick={onToggleSelfReady}>{roomLobby.players[selfSlotIndex]?.ready ? 'Unready' : 'Ready'}</button>
                  ) : (
                    <button type="button" disabled={!canHostStart}>Start</button>
                  )}
                  <div className="rr-mp-inline-actions">
                    <button type="button" className="ghost" onClick={onMockFillLobby}>Mock fill slots</button>
                    <button type="button" className="ghost" onClick={onMockReadyAll}>Mock ready all</button>
                    <button type="button" className="ghost" onClick={() => setRoomLobby(null)}>Close lobby</button>
                  </div>
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
