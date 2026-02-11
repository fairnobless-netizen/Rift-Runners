export type PendingInput = {
  seq: number;
  dx: number;
  dy: number;
};

export class LocalPredictionController {
  private pending: PendingInput[] = [];
  private lastAckSeq = 0;
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
    this.lastAckSeq = lastInputSeq;

    // Canonical reconciliation for simulation:
    // authoritative server base first, then replay unacknowledged inputs.
    this.pending = this.pending.filter((p) => p.seq > lastInputSeq);
    setPosition(serverX, serverY);
    for (const p of this.pending) {
      applyMove(p.dx, p.dy);
    }

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
      }
      return;
    }

    if (this.inSoftCorrection && drift <= this.SOFT_EXIT) {
      this.inSoftCorrection = false;
    } else if (!this.inSoftCorrection && drift >= this.SOFT_ENTER) {
      this.inSoftCorrection = true;
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

  getStats() {
    return {
      correctionCount: this.correctionCount,
      softCorrectionCount: this.softCorrectionCount,
      droppedInputCount: this.droppedInputCount,
      pendingCount: this.pending.length,
      lastAckSeq: this.lastAckSeq,
      drift: this.drift,
      biasX: this.biasX,
      biasY: this.biasY,
    };
  }
}
