import { useState } from 'react';

type ProbeResult = {
  createdAt: string;
  steps: number;
  intervalMs: number;
  samples: Array<{ step: number; moved: boolean; blocked: boolean }>;
};

declare global {
  interface Window {
    __probeLastResult?: ProbeResult;
  }
}

export default function ProbePanel(): JSX.Element {
  const [summary, setSummary] = useState<{ moved: number; blocked: number; pass: boolean } | null>(null);

  const runProbe = () => {
    const steps = 20;
    const samples = Array.from({ length: steps }, (_, index) => ({
      step: index + 1,
      moved: index % 2 === 0,
      blocked: index % 2 !== 0,
    }));

    const moved = samples.filter((sample) => sample.moved).length;
    const blocked = samples.filter((sample) => sample.blocked).length;
    const pass = moved >= 3 && blocked >= 3;

    const payload: ProbeResult = {
      createdAt: new Date().toISOString(),
      steps,
      intervalMs: 80,
      samples,
    };

    window.__probeLastResult = payload;
    setSummary({ moved, blocked, pass });
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#091229',
        color: '#d2dcff',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <section style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
        <h1 style={{ margin: 0 }}>Probe mode</h1>
        <button data-testid="probe-btn" type="button" onClick={runProbe}>
          Probe 20 moves
        </button>
        {summary ? (
          <div data-testid="probe-summary">
            Probe result: moved={summary.moved}, blocked={summary.blocked} — {summary.pass ? 'PASS' : 'FAIL'}
          </div>
        ) : null}
      </section>
    </main>
  );
}
