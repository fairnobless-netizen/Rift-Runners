import { useState } from 'react';

type Props = {
  open: boolean;
  onClose: () => void;
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
}: Props): JSX.Element | null {
  const [tab, setTab] = useState<MainTab>('friends');

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
                <p className="rr-mp-empty">Coming soon</p>
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
              <p className="rr-mp-empty">Coming soon</p>
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
