import GameView from './components/GameView';
import ProbePanel from './e2e/ProbePanel';

const probeModeFlag = String(import.meta.env.VITE_PROBE_MODE ?? '').trim().toLowerCase();
const probeModeEnabled = probeModeFlag === '1' || probeModeFlag === 'true';

export default function App(): JSX.Element {
  if (probeModeEnabled) return <ProbePanel />;
  return <GameView />;
}
