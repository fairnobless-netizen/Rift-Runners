import GameView from './components/GameView';
import ProbePanel from './devtools/ProbePanel';

export default function App(): JSX.Element {
  if (window.location.pathname === '/probe') {
    return <ProbePanel />;
  }

  return <GameView />;
}
