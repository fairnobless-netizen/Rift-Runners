export type PendingInput = {
  seq: number;
  dx: number;
  dy: number;
};

type PredictedState = {
  x: number;
  y: number;
};

// DEV ONLY: force artificial prediction drift to validate correction pipeline.
let debugDriftTicksRemaining = 0;

export function triggerDebugDrift(ticks: number) {
  debugDriftTicksRemaining = Math.max(0, Math.floor(ticks));
}

export class LocalPredictionController {
  private serverFirstMode = false;
  private pending: PendingInput[] = [];
  private lastAckSeq = 0;

  // Correction / drift telemetry
  private correctionCount = 0;
  private softCorrectionCount = 0;
  private droppedInputCount = 0;
  private maxPending = 64;
  private drift = 0;
  private biasX = 0;
  private biasY = 0;
  private inSoftCorrection = false;
  private inHardCorrection = false;
  private lastHardCorrectionTime = 0;

  // --- NEW (M16.2.1): prediction history & error telemetry ---
  private history = new Map<number, PredictedState>();
  private readonly HISTORY_WINDOW = 128; // how many seq entries keep
  private predictionError = 0;
  private predictionErrorEma = 0;
  private missingHistoryCount = 0;
  private reconcileReason: 'none' | 'soft' | 'hard' = 'none';
  private readonly PRED_ERR_EMA_ALPHA = 0.12;

  // thresholds / smoothing
  private readonly SOFT_ENTER = 0.3;
  private readonly SOFT_EXIT = 0.2;
  private readonly HARD_ENTER = 1.3;
  private readonly HARD_EXIT = 1.1;
  private readonly HARD_CORRECTION_COOLDOWN_MS = 200;
  private readonly BIAS_DECAY = 0.85;

  pushInput(input: PendingInput) {
    if (this.pending.length >= this.maxPending) {
      this.pending.shift();
      this.droppedInputCount += 1;
    }
    this.pending.push(input);
  }

  setServerFirstMode(enabled: boolean) {
    this.serverFirstMode = enabled;
  }

  /**
   * Called AFTER the local simulation actually applied `seq`.
   * We record the predicted position for later server comparison.
   */
  onLocalSimulated(seq: number, x: number, y: number) {
    const predictedState: PredictedState = { x, y };

    if (import.meta.env.DEV && debugDriftTicksRemaining > 0) {
      predictedState.x += 1;
      debugDriftTicksRemaining -= 1;
    }

    this.history.set(seq, predictedState);

    // prune by window (based on newest seq)
    const minSeq = seq - this.HISTORY_WINDOW;
    for (const s of this.history.keys()) {
      if (s <= minSeq) this.history.delete(s);
    }
  }

  private notePredictionErrorFromHistory(lastInputSeq: number, serverX: number, serverY: number) {
    const predicted = this.history.get(lastInputSeq);
    if (!predicted) {
      this.missingHistoryCount += 1;
      return;
    }

    const err = Math.hypot(serverX - predicted.x, serverY - predicted.y);
    this.predictionError = err;
    this.predictionErrorEma = this.predictionErrorEma === 0
      ? err
      : this.predictionErrorEma + (err - this.predictionErrorEma) * this.PRED_ERR_EMA_ALPHA;
  }

  private pruneHistoryByAck(lastAckSeq: number) {
    // Anything <= ack is no longer needed for comparison
    for (const s of this.history.keys()) {
      if (s <= lastAckSeq) this.history.delete(s);
    }
  }

  reconcile(params: {
    serverX: number;
    serverY: number;
    localX: number;
    localY: number;
    lastInputSeq: number;
    setPosition: (x: number, y: number) => void;
    applyMove: (dx: number, dy: number) => void;
  }) {
    const { serverX, serverY, localX, localY, lastInputSeq, setPosition, applyMove } = params;

    if (lastInputSeq < this.lastAckSeq) return;

    // --- NEW: compute pred error BEFORE we mutate state/queues ---
    this.notePredictionErrorFromHistory(lastInputSeq, serverX, serverY);

    this.lastAckSeq = lastInputSeq;
    this.reconcileReason = 'none';

    if (this.serverFirstMode) {
      this.pending = this.pending.filter((p) => p.seq > lastInputSeq);
      this.pruneHistoryByAck(lastInputSeq);
      this.drift = Math.hypot(serverX - localX, serverY - localY);
      this.biasX = 0;
      this.biasY = 0;
      this.inSoftCorrection = false;
      this.inHardCorrection = false;
      return;
    }

    // Canonical reconciliation for simulation:
    // authoritative server base first, then replay unacknowledged inputs.
    this.pending = this.pending.filter((p) => p.seq > lastInputSeq);
    setPosition(serverX, serverY);
    for (const p of this.pending) {
      applyMove(p.dx, p.dy);
    }

    // prune history after ack advanced
    this.pruneHistoryByAck(lastInputSeq);

    // Visual correction is handled after the simulation state is reconciled.
    const drift = Math.hypot(serverX - localX, serverY - localY);
    this.drift = drift;

    if (this.inHardCorrection && drift <= this.HARD_EXIT) {
      this.inHardCorrection = false;
    } else if (!this.inHardCorrection && drift >= this.HARD_ENTER) {
      const now = Date.now();
      if (now - this.lastHardCorrectionTime >= this.HARD_CORRECTION_COOLDOWN_MS) {
        this.inHardCorrection = true;
        this.inSoftCorrection = false;
        this.biasX = 0;
        this.biasY = 0;
        this.lastHardCorrectionTime = now;
        this.correctionCount += 1;
        this.reconcileReason = 'hard';
      }
      return;
    }

    if (this.inSoftCorrection && drift <= this.SOFT_EXIT) {
      this.inSoftCorrection = false;
    } else if (!this.inSoftCorrection && drift >= this.SOFT_ENTER) {
      this.inSoftCorrection = true;
      this.reconcileReason = 'soft';
    }

    if (!this.inSoftCorrection) return;

    this.biasX += serverX - localX;
    this.biasY += serverY - localY;
    this.softCorrectionCount += 1;
  }

  updateFixed() {
    this.biasX *= this.BIAS_DECAY;
    this.biasY *= this.BIAS_DECAY;

    if (Math.abs(this.biasX) < 0.0001) this.biasX = 0;
    if (Math.abs(this.biasY) < 0.0001) this.biasY = 0;
  }

  getVisualBias() {
    return { x: this.biasX, y: this.biasY };
  }

  reset() {
    this.pending = [];
    this.lastAckSeq = 0;

    this.correctionCount = 0;
    this.softCorrectionCount = 0;
    this.droppedInputCount = 0;

    this.drift = 0;
    this.biasX = 0;
    this.biasY = 0;
    this.inSoftCorrection = false;
    this.inHardCorrection = false;
    this.lastHardCorrectionTime = 0;

    this.history.clear();
    this.predictionError = 0;
    this.predictionErrorEma = 0;
    this.missingHistoryCount = 0;
    this.reconcileReason = 'none';
  }

  getStats() {
    return {
      localMode: this.serverFirstMode ? 'server_first' : 'predicted',
      correctionCount: this.correctionCount,
      softCorrectionCount: this.softCorrectionCount,
      droppedInputCount: this.droppedInputCount,
      pendingCount: this.pending.length,
      lastAckSeq: this.lastAckSeq,
      drift: this.drift,
      biasX: this.biasX,
      biasY: this.biasY,

      // NEW (M16.2.1)
      predictionError: this.predictionError,
      predictionErrorEma: this.predictionErrorEma,
      historySize: this.history.size,
      missingHistoryCount: this.missingHistoryCount,
      reconcileReason: this.reconcileReason,
    };
  }
}
