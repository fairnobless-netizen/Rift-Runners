import { useEffect, useRef, useState } from 'react';

type Props = {
  open: boolean;
  onClose: () => void;
  autoJoin?: boolean;
  initialJoinCode?: string | null;
  joiningRoomCode?: string | null;
  currentRoom?: {
    roomCode: string;
  } | null;
  myRooms?: Array<{
    roomCode: string;
  }>;
  onJoinRoomByCode?: (code: string) => Promise<void> | void;
  onConsumeInitialJoinCode?: () => void;
  onSendFriendRequest?: (targetId: string) => Promise<void> | void;
  hostDisplayName?: string | null;
  gameNickname?: string | null;
  account?: {
    gameNickname?: string | null;
  } | null;
  tgUsername?: string | null;
};

type MainTab = 'friends' | 'find' | 'room' | 'browse' | 'referral';

type FriendConfirmed = {
  id: string;
  name: string;
  status: 'online' | 'offline';
};

type FriendRequest = {
  id: string;
  name: string;
};

const emptyConfirmedFriends: FriendConfirmed[] = [];
const emptyIncomingRequests: FriendRequest[] = [];

export function MultiplayerModal({
  open,
  onClose,
  autoJoin = false,
  initialJoinCode,
  joiningRoomCode,
  currentRoom,
  myRooms,
  onJoinRoomByCode,
  onConsumeInitialJoinCode,
  onSendFriendRequest,
}: Props): JSX.Element | null {
  const [tab, setTab] = useState<MainTab>('friends');
  const [friendTargetDraft, setFriendTargetDraft] = useState('');
  const [joinCodeDraft, setJoinCodeDraft] = useState('');
  const autoJoinRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open || !autoJoin || !initialJoinCode || !onJoinRoomByCode) return;

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
  }, [
    autoJoin,
    currentRoom?.roomCode,
    initialJoinCode,
    joiningRoomCode,
    onConsumeInitialJoinCode,
    onJoinRoomByCode,
    open,
  ]);

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
                <h4>Confirmed Friends</h4>
                {emptyConfirmedFriends.length === 0 ? <p className="rr-mp-empty">No friends yet</p> : null}
              </section>

              <section className="rr-mp-section">
                <h4>Incoming Requests</h4>
                {emptyIncomingRequests.length === 0 ? <p className="rr-mp-empty">No incoming requests</p> : null}
              </section>

              <section className="rr-mp-section">
                <h4>Outgoing Requests</h4>
                <div className="rr-mp-inline-actions">
                  <input
                    type="text"
                    value={friendTargetDraft}
                    onChange={(event) => setFriendTargetDraft(event.target.value)}
                    placeholder="Telegram user id"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const id = friendTargetDraft.trim();
                      if (!id || !onSendFriendRequest) return;
                      void onSendFriendRequest(id);
                      setFriendTargetDraft('');
                    }}
                  >
                    Send
                  </button>
                </div>
              </section>
            </>
          ) : null}

          {tab === 'find' ? (
            <section className="rr-mp-section">
              <h4>Find friends</h4>
              <p className="rr-mp-empty">Coming soon</p>
            </section>
          ) : null}

          {tab === 'room' ? (
            <section className="rr-mp-section rr-room-section">
              <h4>Room</h4>
              <div className="rr-mp-inline-actions">
                <input
                  type="text"
                  value={joinCodeDraft}
                  onChange={(event) => setJoinCodeDraft(event.target.value)}
                  placeholder="Room code"
                />
                <button
                  type="button"
                  disabled={Boolean(joiningRoomCode)}
                  onClick={() => {
                    const code = joinCodeDraft.trim().toUpperCase();
                    if (!code || !onJoinRoomByCode) return;
                    void onJoinRoomByCode(code);
                  }}
                >
                  {joiningRoomCode ? 'Joining...' : 'Join'}
                </button>
              </div>
              <div className="rr-mp-inline-actions">
                {(myRooms ?? []).map((room) => (
                  <button
                    key={room.roomCode}
                    type="button"
                    onClick={() => {
                      if (!onJoinRoomByCode) return;
                      void onJoinRoomByCode(room.roomCode.trim().toUpperCase());
                    }}
                  >
                    {room.roomCode}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {tab === 'browse' ? (
            <section className="rr-mp-section">
              <h4>Browse rooms</h4>
              <p className="rr-mp-empty">Coming soon</p>
            </section>
          ) : null}

          {tab === 'referral' ? (
            <section className="rr-mp-section">
              <h4>Referral</h4>
              <p className="rr-mp-empty">Coming soon</p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
