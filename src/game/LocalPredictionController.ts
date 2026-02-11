export type PendingInput = {
  seq: number;
  dx: number;
  dy: number;
};

export class LocalPredictionController {
  private pending: PendingInput[] = [];
  private lastAckSeq = 0;
  private correctionCount = 0;
  private droppedInputCount = 0;
  private maxPending = 64;
  private reconcileThreshold = 0.1;

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

    this.pending = this.pending.filter((p) => p.seq > lastInputSeq);

    const drift = Math.hypot(serverX - localX, serverY - localY);
    if (drift > this.reconcileThreshold) {
      setPosition(serverX, serverY);
      this.correctionCount += 1;
    }

    for (const p of this.pending) {
      applyMove(p.dx, p.dy);
    }
  }

  getStats() {
    return {
      correctionCount: this.correctionCount,
      droppedInputCount: this.droppedInputCount,
      pendingCount: this.pending.length,
      lastAckSeq: this.lastAckSeq,
    };
  }
}
