import { useState } from 'react';

type ProbeResult = {
  runId: number;
  steps: number;
  score: number;
  generatedAt: string;
};

declare global {
  interface Window {
    __probeLastResult?: ProbeResult;
  }
}

export default function ProbePanel(): JSX.Element {
  const [result, setResult] = useState<ProbeResult | null>(null);

  const handleRunProbe = (): void => {
    const nextResult: ProbeResult = {
      runId: Date.now(),
      steps: 20,
      score: Math.floor(Math.random() * 1000),
      generatedAt: new Date().toISOString(),
    };

    window.__probeLastResult = nextResult;
    setResult(nextResult);
  };

  return (
    <main style={{ padding: '1rem', fontFamily: 'sans-serif' }}>
      <h1>Probe Panel</h1>
      <button data-testid="probe-btn" onClick={handleRunProbe} type="button">
        Run probe
      </button>

      {result && (
        <pre data-testid="probe-summary" style={{ marginTop: '1rem' }}>
          Probe result: {JSON.stringify(result)}
        </pre>
      )}
    </main>
  );
}
