import type {
  MatchBombExploded,
  MatchBombSpawned,
  MatchEnd,
  MatchPlayerDamaged,
  MatchPlayerEliminated,
  MatchPlayerRespawned,
  MatchSnapshot,
  MatchTilesDestroyed,
  MoveDir,
} from './protocol';
import type { EnemyState, MatchState, PlayerState } from './types';

const TICK_RATE_MS = 50; // 20 Hz
const RESPAWN_DELAY_TICKS = 24;
const INVULN_TICKS = 20;
const MOVE_DURATION_TICKS = 6;
const ENEMY_HIT_COOLDOWN_TICKS = 12;
const LOG_MOVEMENT_STATE = false;
const LOG_EXPLOSION_DAMAGE = false;

type MatchEvent = MatchBombSpawned | MatchBombExploded | MatchTilesDestroyed | MatchPlayerDamaged | MatchPlayerRespawned | MatchPlayerEliminated | MatchEnd;

export function startMatch(match: MatchState, broadcast: (snapshot: MatchSnapshot, events: MatchEvent[]) => void) {
  match.interval = setInterval(() => tick(match, broadcast), TICK_RATE_MS);
}

export function stopMatch(match: MatchState) {
  if (match.interval) {
    clearInterval(match.interval);
    match.interval = undefined;
  }
}

function tick(match: MatchState, broadcast: (snapshot: MatchSnapshot, events: MatchEvent[]) => void) {
  if (match.ended) return;
  match.tick += 1;

  const events: MatchEvent[] = [];

  processRespawns(match, events);

  while (match.inputQueue.length > 0) {
    const input = match.inputQueue.shift();
    if (!input) continue;
    const player = match.players.get(input.tgUserId);
    if (!player) continue;
    if (match.eliminatedPlayers.has(input.tgUserId)) continue;
    if (player.state === 'dead_respawning') continue;
    if (input.seq <= player.lastInputSeq) continue;

    applyInput(match, input.tgUserId, input.seq, input.payload);
  }

  advancePlayerMovementStates(match);
  advanceEnemyMovementStates(match);
  processEnemyContactDamage(match, events);

  processBombExplosions(match, events);
  maybeEndMatch(match, events);
  const now = Date.now();

  const snapshot: MatchSnapshot = {
    version: 'match_v1',
    roomCode: match.roomId,
    matchId: match.matchId,
    tick: match.tick,
    serverTime: now,
    serverTimeMs: now,
    world: {
      gridW: match.world.gridW,
      gridH: match.world.gridH,
      worldHash: match.world.worldHash,
      bombs: Array.from(match.bombs.values()).map((bomb) => ({
        id: bomb.id,
        x: bomb.x,
        y: bomb.y,
        ownerId: bomb.ownerId,
        tickPlaced: bomb.tickPlaced,
        explodeAtTick: bomb.explodeAtTick,
      })),
    },
    players: Array.from(match.players.values()).map((p) => ({
      tgUserId: p.tgUserId,
      displayName: p.displayName,
      colorId: p.colorId,
      skinId: p.skinId,
      lastInputSeq: p.lastInputSeq,
      x: p.x,
      y: p.y,
      isMoving: p.isMoving,
      moveFromX: p.isMoving ? p.moveFromX : p.x,
      moveFromY: p.isMoving ? p.moveFromY : p.y,
      moveToX: p.isMoving ? p.moveToX : p.x,
      moveToY: p.isMoving ? p.moveToY : p.y,
      moveStartTick: p.isMoving ? p.moveStartTick : match.tick,
      moveDurationTicks: p.isMoving ? p.moveDurationTicks : 0,
      moveStartServerTimeMs: p.isMoving ? p.moveStartServerTimeMs : now,
      moveDurationMs: p.isMoving ? p.moveDurationTicks * TICK_RATE_MS : 0,
      lives: match.playerLives.get(p.tgUserId) ?? 0,
      eliminated: match.eliminatedPlayers.has(p.tgUserId),
    })),
    enemies: Array.from(match.enemies.values()).map((enemy) => ({
      id: enemy.id,
      x: enemy.x,
      y: enemy.y,
      alive: enemy.alive,
    })),
  };

  broadcast(snapshot, events);
}

export function tryPlaceBomb(match: MatchState, tgUserId: string, x: number, y: number): MatchBombSpawned | null {
  const player = match.players.get(tgUserId);
  if (!player || match.eliminatedPlayers.has(tgUserId) || player.state !== 'alive') return null;
  if (player.x !== x || player.y !== y) return null;
  if (!canOccupyWorldCell(match, x, y)) return null;

  const ownedBombCount = Array.from(match.bombs.values()).filter((bomb) => bomb.ownerId === tgUserId).length;
  if (ownedBombCount >= match.maxBombsPerPlayer) return null;

  const collision = Array.from(match.bombs.values()).some((bomb) => bomb.x === x && bomb.y === y);
  if (collision) return null;

  const eventId = nextEventId(match);
  const bombId = `bomb_${eventId}`;
  match.bombs.set(bombId, {
    id: bombId,
    ownerId: tgUserId,
    x,
    y,
    tickPlaced: match.tick,
    explodeAtTick: match.tick + match.bombFuseTicks,
    range: match.bombRange,
  });

  return {
    type: 'match:bomb_spawned',
    roomCode: match.roomId,
    matchId: match.matchId,
    eventId,
    serverTick: match.tick,
    tick: match.tick,
    bomb: {
      id: bombId,
      x,
      y,
      ownerId: tgUserId,
      tickPlaced: match.tick,
      explodeAtTick: match.tick + match.bombFuseTicks,
    },
  };
}

function processRespawns(match: MatchState, events: MatchEvent[]): void {
  for (const player of match.players.values()) {
    if (player.state !== 'dead_respawning') continue;
    if (player.respawnAtTick == null || match.tick < player.respawnAtTick) continue;

    player.x = player.spawnX;
    player.y = player.spawnY;
    resetPlayerMovementState(player, match.tick, Date.now());
    player.state = 'alive';
    player.respawnAtTick = null;
    player.invulnUntilTick = match.tick + INVULN_TICKS;
    player.lastEnemyHitTick = Number.NEGATIVE_INFINITY;

    events.push({
      type: 'match:player_respawned',
      roomCode: match.roomId,
      matchId: match.matchId,
      eventId: nextEventId(match),
      serverTick: match.tick,
      tick: match.tick,
      tgUserId: player.tgUserId,
      x: player.x,
      y: player.y,
      invulnUntilTick: player.invulnUntilTick,
    });
  }
}

function processBombExplosions(match: MatchState, events: MatchEvent[]): void {
  const damagedPlayersThisTick = new Set<string>();

  while (true) {
    const dueBomb = Array.from(match.bombs.values())
      .filter((bomb) => match.tick >= bomb.explodeAtTick)
      .sort((a, b) => a.explodeAtTick - b.explodeAtTick)[0];

    if (!dueBomb) return;

    match.bombs.delete(dueBomb.id);

    const impacts = collectExplosionImpacts(match, dueBomb.x, dueBomb.y, dueBomb.range);
    const destroyedTiles: Array<{ x: number; y: number }> = [];

    for (const impact of impacts) {
      const idx = impact.y * match.world.gridW + impact.x;
      const tile = match.world.tiles[idx] ?? 1;
      if (tile === 2) {
        match.world.tiles[idx] = 0;
        destroyedTiles.push({ x: impact.x, y: impact.y });
      }
    }

    events.push({
      type: 'match:bomb_exploded',
      roomCode: match.roomId,
      matchId: match.matchId,
      eventId: nextEventId(match),
      serverTick: match.tick,
      tick: match.tick,
      bombId: dueBomb.id,
      x: dueBomb.x,
      y: dueBomb.y,
      impacts,
    });

    if (destroyedTiles.length > 0) {
      events.push({
        type: 'match:tiles_destroyed',
        roomCode: match.roomId,
        matchId: match.matchId,
        eventId: nextEventId(match),
        serverTick: match.tick,
        tick: match.tick,
        tiles: destroyedTiles,
      });
    }

    for (const enemy of match.enemies.values()) {
      if (!enemy.alive) continue;
      const hitEnemy = impacts.some((impact) => impact.x === enemy.x && impact.y === enemy.y);
      if (!hitEnemy) continue;
      enemy.alive = false;
    }

    for (const player of match.players.values()) {
      if (player.state !== 'alive') continue;
      if (player.invulnUntilTick > match.tick) continue;
      if (damagedPlayersThisTick.has(player.tgUserId)) continue;
      const hit = impacts.some((impact) => impact.x === player.x && impact.y === player.y);
      if (!hit) continue;

      damagedPlayersThisTick.add(player.tgUserId);
      applyPlayerDamage(match, player, events, 'explosion');
    }
  }
}


function advanceEnemyMovementStates(match: MatchState): void {
  if (match.enemyMoveIntervalTicks <= 0) return;
  if (match.tick % match.enemyMoveIntervalTicks !== 0) return;

  for (const enemy of match.enemies.values()) {
    if (!enemy.alive) continue;
    const next = chooseEnemyNextCell(match, enemy);
    if (!next) continue;
    enemy.x = next.x;
    enemy.y = next.y;
  }
}

function chooseEnemyNextCell(match: MatchState, enemy: EnemyState): { x: number; y: number } | null {
  const dirs: Array<{ dx: number; dy: number }> = [
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: -1 },
  ];
  const start = enemy.id.length % dirs.length;

  for (let i = 0; i < dirs.length; i += 1) {
    const dir = dirs[(start + match.tick + i) % dirs.length];
    const nx = enemy.x + dir.dx;
    const ny = enemy.y + dir.dy;
    if (!canOccupyWorldCell(match, nx, ny)) continue;
    const occupiedByEnemy = Array.from(match.enemies.values()).some((other) => (
      other.id !== enemy.id
      && other.alive
      && other.x === nx
      && other.y === ny
    ));
    if (occupiedByEnemy) continue;
    return { x: nx, y: ny };
  }

  return null;
}

function processEnemyContactDamage(match: MatchState, events: MatchEvent[]): void {
  for (const enemy of match.enemies.values()) {
    if (!enemy.alive) continue;

    for (const player of match.players.values()) {
      if (player.state !== 'alive') continue;
      if (player.invulnUntilTick > match.tick) continue;
      if (player.x !== enemy.x || player.y !== enemy.y) continue;
      if (match.tick - player.lastEnemyHitTick < ENEMY_HIT_COOLDOWN_TICKS) continue;

      player.lastEnemyHitTick = match.tick;
      applyPlayerDamage(match, player, events, 'enemy_contact');
    }
  }
}

function applyPlayerDamage(match: MatchState, player: PlayerState, events: MatchEvent[], source: 'explosion' | 'enemy_contact'): void {
  const prevLives = match.playerLives.get(player.tgUserId) ?? 0;
  const nextLives = Math.max(0, prevLives - 1);
  match.playerLives.set(player.tgUserId, nextLives);

  if (LOG_EXPLOSION_DAMAGE) {
    console.log(JSON.stringify({
      victimId: player.tgUserId,
      prevLives,
      newLives: nextLives,
      source,
      tick: match.tick,
    }));
  }

  events.push({
    type: 'match:player_damaged',
    roomCode: match.roomId,
    matchId: match.matchId,
    eventId: nextEventId(match),
    serverTick: match.tick,
    tick: match.tick,
    tgUserId: player.tgUserId,
    lives: nextLives,
  });

  if (nextLives <= 0) {
    player.state = 'eliminated';
    resetPlayerMovementState(player, match.tick, Date.now());
    player.respawnAtTick = null;
    player.invulnUntilTick = 0;
    match.eliminatedPlayers.add(player.tgUserId);
    events.push({
      type: 'match:player_eliminated',
      roomCode: match.roomId,
      matchId: match.matchId,
      eventId: nextEventId(match),
      serverTick: match.tick,
      tick: match.tick,
      tgUserId: player.tgUserId,
    });
    return;
  }

  player.state = 'dead_respawning';
  resetPlayerMovementState(player, match.tick, Date.now());
  player.respawnAtTick = match.tick + RESPAWN_DELAY_TICKS;
  player.invulnUntilTick = 0;
}
function maybeEndMatch(match: MatchState, events: MatchEvent[]): void {
  const alive = Array.from(match.players.values())
    .filter((player) => player.state !== 'eliminated')
    .map((player) => player.tgUserId);
  if (alive.length > 1) return;

  match.ended = true;
  events.push({
    type: 'match:end',
    roomCode: match.roomId,
    matchId: match.matchId,
    serverTick: match.tick,
    tick: match.tick,
    winnerTgUserId: alive[0] ?? null,
    reason: alive.length === 1 ? 'elimination' : 'draw',
  });
}

function collectExplosionImpacts(match: MatchState, x: number, y: number, range: number): Array<{ x: number; y: number }> {
  const impacts: Array<{ x: number; y: number }> = [{ x, y }];
  const dirs: Array<{ dx: number; dy: number }> = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  for (const { dx, dy } of dirs) {
    for (let step = 1; step <= range; step += 1) {
      const nx = x + dx * step;
      const ny = y + dy * step;
      if (nx < 0 || ny < 0 || nx >= match.world.gridW || ny >= match.world.gridH) break;
      const idx = ny * match.world.gridW + nx;
      const tile = match.world.tiles[idx] ?? 1;
      if (tile === 1) break;
      impacts.push({ x: nx, y: ny });
      if (tile === 2) break;
    }
  }

  return impacts;
}

function canOccupyWorldCell(match: MatchState, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= match.world.gridW || y >= match.world.gridH) {
    return false;
  }

  const idx = y * match.world.gridW + x;
  const tile = match.world.tiles[idx] ?? 1;
  return tile === 0;
}

function applyInput(match: MatchState, tgUserId: string, seq: number, payload: { kind: 'move'; dir: MoveDir } | { kind: 'bomb_place'; x: number; y: number }) {
  const p = match.players.get(tgUserId);
  if (!p) return;

  if (payload.kind === 'move') {
    p.intentDir = payload.dir;
    p.lastInputSeq = seq;
    return;
  }

  p.lastInputSeq = seq;
}

function advancePlayerMovementStates(match: MatchState): void {
  const now = Date.now();

  for (const player of match.players.values()) {
    if (player.state !== 'alive') continue;

    if (player.isMoving) {
      const elapsed = match.tick - player.moveStartTick;
      if (elapsed >= player.moveDurationTicks) {
        player.x = player.moveToX;
        player.y = player.moveToY;
        resetPlayerMovementState(player, match.tick, now, false);
        if (LOG_MOVEMENT_STATE) {
          // eslint-disable-next-line no-console
          console.debug('[mp][move:end]', {
            tgUserId: player.tgUserId,
            x: player.x,
            y: player.y,
            tick: match.tick,
          });
        }
      }
    }

    if (player.isMoving || player.intentDir == null) continue;

    const { x: nx, y: ny } = nextCellForDir(player.x, player.y, player.intentDir);
    if (!canOccupyWorldCell(match, nx, ny)) continue;

    player.isMoving = true;
    player.moveFromX = player.x;
    player.moveFromY = player.y;
    player.moveToX = nx;
    player.moveToY = ny;
    player.moveStartTick = match.tick;
    player.moveDurationTicks = MOVE_DURATION_TICKS;
    player.moveStartServerTimeMs = now;

    if (LOG_MOVEMENT_STATE) {
      // eslint-disable-next-line no-console
      console.debug('[mp][move:start]', {
        tgUserId: player.tgUserId,
        fromX: player.moveFromX,
        fromY: player.moveFromY,
        toX: player.moveToX,
        toY: player.moveToY,
        startTick: player.moveStartTick,
        durationTicks: player.moveDurationTicks,
      });
    }
  }
}

function nextCellForDir(x: number, y: number, dir: MoveDir): { x: number; y: number } {
  switch (dir) {
    case 'up':
      return { x, y: y - 1 };
    case 'down':
      return { x, y: y + 1 };
    case 'left':
      return { x: x - 1, y };
    case 'right':
      return { x: x + 1, y };
    default:
      return { x, y };
  }
}

function resetPlayerMovementState(player: PlayerState, tick: number, now: number, clearIntent = true): void {
  player.isMoving = false;
  player.moveFromX = player.x;
  player.moveFromY = player.y;
  player.moveToX = player.x;
  player.moveToY = player.y;
  player.moveStartTick = tick;
  player.moveDurationTicks = 0;
  player.moveStartServerTimeMs = now;
  if (clearIntent) {
    player.intentDir = null;
  }
}

function nextEventId(match: MatchState): string {
  match.eventSeq += 1;
  return `${match.matchId}_${match.eventSeq}`;
}
