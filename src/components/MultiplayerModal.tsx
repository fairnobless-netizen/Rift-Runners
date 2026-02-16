import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FriendEntry,
  IncomingFriendRequest,
  MyRoomEntry,
  OutgoingFriendRequest,
  RoomMember,
  RoomState,
} from '../game/wallet';

type MainTab = 'friends' | 'find' | 'room' | 'browse' | 'referral';
type RoomScreen = 'create' | 'join';

type Props = {
  open: boolean;
  onClose: () => void;
  initialTab?: 'room' | 'friends';
  initialRoomTab?: 'create' | 'join';
  initialJoinCode?: string;
  autoJoin?: boolean;
  roomsLoading: boolean;
  roomsError: string | null;
  myRooms: MyRoomEntry[];
  currentRoom: RoomState | null;
  currentRoomMembers: RoomMember[];
  joiningRoomCode: string | null;
  settingReady: boolean;
  startingRoom: boolean;
  onCreateRoom: (capacity: 2 | 3 | 4) => Promise<void>;
  onJoinRoomByCode: (code: string) => Promise<void>;
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
  localTgUserId?: string;
  onConsumeInitialJoinCode?: () => void;
};

export function MultiplayerModal({
  open,
  onClose,
  initialTab,
  initialRoomTab,
  initialJoinCode,
  autoJoin,
  roomsLoading,
  roomsError,
  myRooms,
  currentRoom,
  currentRoomMembers,
  joiningRoomCode,
  settingReady,
  startingRoom,
  onCreateRoom,
  onJoinRoomByCode,
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
  localTgUserId,
  onConsumeInitialJoinCode,
}: Props): JSX.Element | null {
  const [tab, setTab] = useState<MainTab>(initialTab ?? 'room');
  const [roomScreen, setRoomScreen] = useState<RoomScreen>(initialRoomTab ?? 'join');
  const [joinCodeDraft, setJoinCodeDraft] = useState(initialJoinCode ?? '');
  const [friendTargetDraft, setFriendTargetDraft] = useState('');
  const autoJoinRef = useRef<string | null>(null);
  const isCreateScreen = roomScreen === 'create';
  const isJoinScreen = roomScreen === 'join';

  useEffect(() => {
    if (!open) return;
    if (initialTab) setTab(initialTab);
    if (initialRoomTab) setRoomScreen(initialRoomTab);
    if (initialJoinCode) setJoinCodeDraft(initialJoinCode);
  }, [initialJoinCode, initialRoomTab, initialTab, open]);

  useEffect(() => {
    if (!open || !autoJoin || !initialJoinCode) return;

    const code = initialJoinCode.trim().toUpperCase();
    if (!code) return;

    // prevent repeated attempts for the same deep-link code
    if (autoJoinRef.current === code) return;

    // if join already in progress for this code, do nothing
    if (joiningRoomCode === code) return;

    // if we already joined this room, consume the code once
    if (currentRoom?.roomCode === code) {
      autoJoinRef.current = code;
      onConsumeInitialJoinCode?.();
      return;
    }

    autoJoinRef.current = code;
    void onJoinRoomByCode(code);
  }, [autoJoin, currentRoom?.roomCode, initialJoinCode, joiningRoomCode, onConsumeInitialJoinCode, onJoinRoomByCode, open]);

  const meReady = useMemo(
    () => currentRoomMembers.find((member) => member.tgUserId === localTgUserId)?.ready ?? false,
    [currentRoomMembers, localTgUserId],
  );

  if (!open) return null;

  return (
    <div className="settings-overlay rr-mp-overlay rr-overlay" role="dialog" aria-modal="true" aria-label="Multiplayer">
      <div className="settings-modal rr-mp-modal rr-overlay-modal">
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
                <h4>Find friend by tg_user_id</h4>
                <div className="rr-mp-row">
                  <input
                    type="text"
                    value={friendTargetDraft}
                    onChange={(event) => setFriendTargetDraft(event.target.value)}
                    placeholder="tg_user_id"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const id = friendTargetDraft.trim();
                      if (!id) return;
                      void onSendFriendRequest(id);
                      setFriendTargetDraft('');
                    }}
                  >
                    Send
                  </button>
                </div>
              </section>

              {friendsError ? <p className="rr-mp-error">{friendsError}</p> : null}
              {friendsLoading ? <p className="rr-mp-empty">Loading friends...</p> : null}

              <section className="rr-mp-section">
                <h4>Incoming requests</h4>
                {incomingRequests.length === 0 ? <p className="rr-mp-empty">No incoming requests.</p> : null}
                {incomingRequests.map((request) => (
                  <div key={request.fromTgUserId} className="rr-mp-card">
                    <span className="rr-mp-avatar">👤</span>
                    <span>{request.displayName}</span>
                    <button type="button" onClick={() => { void onRespondFriendRequest(request.fromTgUserId, 'accept'); }}>Accept</button>
                    <button type="button" className="ghost" onClick={() => { void onRespondFriendRequest(request.fromTgUserId, 'decline'); }}>Decline</button>
                  </div>
                ))}
              </section>

              <section className="rr-mp-section">
                <h4>Outgoing requests</h4>
                {outgoingRequests.length === 0 ? <p className="rr-mp-empty">No outgoing requests.</p> : null}
                {outgoingRequests.map((request) => (
                  <div key={request.toTgUserId} className="rr-mp-card">
                    <span className="rr-mp-avatar">⏳</span>
                    <span>{request.displayName}</span>
                    <span className="rr-mp-chip pending">{request.status}</span>
                  </div>
                ))}
              </section>

              <section className="rr-mp-section">
                <h4>Friends</h4>
                {friendsList.length === 0 ? <p className="rr-mp-empty">No friends yet.</p> : null}
                {friendsList.map((friend) => (
                  <div key={friend.tgUserId} className="rr-mp-card">
                    <span className="rr-mp-avatar">👥</span>
                    <span>{friend.displayName}</span>
                    <span className="rr-mp-chip">friend</span>
                    <button type="button" onClick={() => { void onInviteFriend(friend.tgUserId); }}>Invite</button>
                  </div>
                ))}
              </section>
            </>
          ) : null}

          {tab === 'room' ? (
            <>
              <div className="rr-room-subtabs">
                <button type="button" className={isCreateScreen ? 'active' : ''} onClick={() => setRoomScreen('create')}>Create</button>
                <button type="button" className={isJoinScreen ? 'active' : ''} onClick={() => setRoomScreen('join')}>Join</button>
              </div>

              {isCreateScreen ? (
                <section className="rr-mp-section rr-room-section">
                  <h4>Create room</h4>
                  <div className="rr-arena-grid">
                    <button type="button" disabled={Boolean(joiningRoomCode)} onClick={() => { void onCreateRoom(2); }}>2 players</button>
                    <button type="button" disabled={Boolean(joiningRoomCode)} onClick={() => { void onCreateRoom(3); }}>3 players</button>
                    <button type="button" disabled={Boolean(joiningRoomCode)} onClick={() => { void onCreateRoom(4); }}>4 players</button>
                  </div>
                </section>
              ) : null}

              {isJoinScreen ? (
                <section className="rr-mp-section rr-room-section">
                  <h4>Join room</h4>
                  <div className="rr-mp-row">
                    <input
                      type="text"
                      value={joinCodeDraft}
                      onChange={(event) => setJoinCodeDraft(event.target.value.toUpperCase())}
                      placeholder="Room code"
                    />
                    <button
                      type="button"
                      disabled={Boolean(joiningRoomCode)}
                      onClick={() => {
                        const code = joinCodeDraft.trim().toUpperCase();
                        if (!code) return;
                        void onJoinRoomByCode(code);
                      }}
                    >
                      {joiningRoomCode ? 'Joining...' : 'Join'}
                    </button>
                  </div>

                  {roomsError ? <p className="rr-mp-error">{roomsError}</p> : null}
                  {roomsLoading ? <p className="rr-mp-empty">Loading rooms...</p> : null}
                  {joiningRoomCode ? <p className="rr-mp-empty">Joining {joiningRoomCode}...</p> : null}

                  <section className="rr-mp-section">
                    <h4>My rooms</h4>
                    {myRooms.length === 0 ? <p className="rr-mp-empty">No joined rooms yet.</p> : null}
                    {myRooms.map((room) => (
                      <button
                        key={room.roomCode}
                        type="button"
                        className="rr-mp-row"
                        disabled={Boolean(joiningRoomCode)}
                        onClick={() => { void onJoinRoomByCode(room.roomCode.trim().toUpperCase()); }}
                      >
                        <span>{room.roomCode}</span>
                        <span>{room.memberCount}/{room.capacity} · {room.status}</span>
                      </button>
                    ))}
                  </section>

                  <section className="rr-mp-section">
                    <h4>Current room</h4>
                    {!currentRoom ? (
                      <p className="rr-mp-empty">Not in a room.</p>
                    ) : (
                      <>
                        <div className="settings-kv"><span>Code</span><strong>{currentRoom.roomCode}</strong></div>
                        <div className="settings-kv"><span>Status</span><strong>{currentRoom.status}</strong></div>
                        <div className="settings-kv"><span>Phase</span><strong>{currentRoom.phase ?? 'LOBBY'}</strong></div>
                        <div className="rr-mp-inline-actions">
                          <button type="button" onClick={() => { void onCopyInviteLink(); }}>Copy invite</button>
                          {currentRoom.ownerTgUserId === localTgUserId ? (
                            <button type="button" className="ghost" onClick={() => { void onCloseRoom(); }}>Close room</button>
                          ) : (
                            <button type="button" className="ghost" onClick={() => { void onLeaveRoom(); }}>Leave</button>
                          )}
                        </div>
                        <div className="rr-mp-inline-actions">
                          <button type="button" disabled={settingReady} onClick={() => { void onToggleReady(); }}>
                            {settingReady ? 'Saving...' : (meReady ? 'Ready ✓' : 'Set Ready')}
                          </button>
                          {currentRoom.ownerTgUserId === localTgUserId ? (
                            <button
                              type="button"
                              disabled={startingRoom || currentRoomMembers.length < 2 || currentRoomMembers.some((member) => !(member.ready ?? false)) || (currentRoom.phase ?? 'LOBBY') === 'STARTED'}
                              onClick={() => { void onStartRoom(); }}
                            >
                              {startingRoom ? 'Starting...' : 'Start'}
                            </button>
                          ) : null}
                        </div>
                        {currentRoomMembers.map((member) => (
                          <div key={member.tgUserId} className="settings-kv">
                            <span>{member.displayName}</span>
                            <strong>{member.ready ? 'Ready' : 'Not ready'}</strong>
                          </div>
                        ))}
                      </>
                    )}
                  </section>
                </section>
              ) : null}
            </>
          ) : null}

          {tab === 'find' ? <section className="rr-mp-section"><h4>Find</h4><p className="rr-mp-empty">Coming soon</p></section> : null}
          {tab === 'browse' ? <section className="rr-mp-section"><h4>Browse</h4><p className="rr-mp-empty">Coming soon</p></section> : null}
          {tab === 'referral' ? <section className="rr-mp-section"><h4>Referral</h4><p className="rr-mp-empty">Coming soon</p></section> : null}
        </div>
      </div>
    </div>
  );
}
