export type PendingInput = {
  seq: number;
  dx: number;
  dy: number;
};

export class LocalPredictionController {
  private pending: PendingInput[] = [];
  private lastAckSeq = 0;

  pushInput(input: PendingInput) {
    this.pending.push(input);
  }

  applyAuthoritativeState(
    serverX: number,
    serverY: number,
    lastInputSeq: number,
    applyMove: (dx: number, dy: number) => void,
    setPosition: (x: number, y: number) => void,
  ) {
    if (lastInputSeq < this.lastAckSeq) return;
    this.lastAckSeq = lastInputSeq;

    this.pending = this.pending.filter((p) => p.seq > lastInputSeq);

    setPosition(serverX, serverY);

    for (const p of this.pending) {
      applyMove(p.dx, p.dy);
    }
  }
}
