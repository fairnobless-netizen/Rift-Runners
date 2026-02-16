import type { ReactNode } from 'react';

type OverlayTab = {
  key: string;
  label: string;
};

type Props = {
  title: string;
  tabs: OverlayTab[];
  activeTab: string;
  onTabChange: (key: string) => void;
  onClose: () => void;
  children: ReactNode;
};

export function RROverlayModal({
  title,
  tabs,
  activeTab,
  onTabChange,
  onClose,
  children,
}: Props): JSX.Element {
  return (
    <div className="settings-overlay rr-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="settings-modal rr-overlay-modal">
        <div className="rr-overlay-header">
          <strong>{title}</strong>
          <button type="button" className="rr-overlay-close" onClick={onClose}>Close</button>
        </div>

        <div className="rr-overlay-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`rr-overlay-tab${activeTab === tab.key ? ' active' : ''}`}
              onClick={() => onTabChange(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="rr-overlay-content rr-panel">
          {children}
        </div>
      </div>
    </div>
  );
}

