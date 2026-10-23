/**
 * Family FPS — authoritative-ish multiplayer server
 * Free-for-all deathmatch, max 3 players per room.
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const PORT = process.env.PORT || 3080;
const TICK_HZ = 25;
const TICK_MS = 1000 / TICK_HZ;
const MAX_PLAYERS = 3;
const KILL_LIMIT = 10;
const PLAYER_SPEED = 8.5;
const EYE_HEIGHT = 1.55;
const JUMP_VEL = 7.5;
const GRAVITY = 22;
const RESPAWN_MS = 2500;
const MAX_HP = 100;
const AR_DAMAGE = 22;
const AR_HS_MULT = 1.75;
const AR_ROF_MS = 95;
const AR_SPREAD = 0.028;
const AR_MAG = 30;
const AR_RESERVE = 90;
const RELOAD_MS = 1800;
const HIT_RADIUS = 0.48;
const HEAD_OFFSET = 1.35; // above feet for headshot band

const SPAWNS = [
  { x: -18, y: 0, z: -14, yaw: -0.6 },
  { x: 18, y: 0, z: 14, yaw: 2.5 },
  { x: -14, y: 4, z: 16, yaw: 0.8 },
  { x: 16, y: 0, z: -16, yaw: -2.2 },
  { x: 0, y: 0, z: 0, yaw: 0 },
  { x: -8, y: 2.5, z: -2, yaw: -1.2 },
];

/** Arena collision boxes [minX,minY,minZ, maxX,maxY,maxZ] — match client map */
const SOLIDS = [
  // Outer walls (thin)
  [-22, 0, -22, 22, 6, -20.5],
  [-22, 0, 20.5, 22, 6, 22],
  [-22, 0, -22, -20.5, 6, 22],
  [20.5, 0, -22, 22, 6, 22],
  // Buildings / cover
  [-16, 0, -10, -8, 5, -4],
  [6, 0, 4, 14, 4, 12],
  [-4, 0, 8, 2, 3, 14],
  [8, 0, -16, 14, 6, -8],
  [-14, 0, 6, -10, 2.5, 12],
  // Mid platforms / ramps approximated as boxes
  [-10, 0, -2, -4, 2.5, 2],
  [2, 0, -8, 8, 2, -2],
  // Low cover crates
  [-2, 0, -14, 2, 1.2, -10],
  [10, 0, -2, 14, 1.2, 2],
  [-18, 0, 2, -14, 1.2, 6],
];

const FLOORS = [
  // Raised floors players can stand on (y = top)
  { minX: -10, maxX: -4, minZ: -2, maxZ: 2, y: 2.5 },
  { minX: 2, maxX: 8, minZ: -8, maxZ: -2, y: 2 },
  { minX: -16, maxX: -8, minZ: -10, maxZ: -4, y: 5 }, // roof access optional
  { minX: 8, maxX: 14, minZ: -16, maxZ: -8, y: 6 },
  { minX: 6, maxX: 14, minZ: 4, maxZ: 12, y: 4 },
];

const rooms = new Map(); // code -> Room

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += chars[(Math.random() * chars.length) | 0];
  } while (rooms.has(c));
  return c;
}

function aabbOverlap(px, py, pz, rad, h, box) {
  const [x0, y0, z0, x1, y1, z1] = box;
  const nx = Math.max(x0, Math.min(px, x1));
  const ny = Math.max(y0, Math.min(py + h * 0.5, y1));
  const nz = Math.max(z0, Math.min(pz, z1));
  const dx = px - nx, dy = (py + h * 0.5) - ny, dz = pz - nz;
  return dx * dx + dy * dy + dz * dz < rad * rad;
}

function resolveMove(px, py, pz, dx, dy, dz) {
  const rad = 0.4;
  const h = 1.6;
  let nx = px + dx;
  let ny = py + dy;
  let nz = pz + dz;

  // Horizontal X then Z separately for sliding
  if (!SOLIDS.some((b) => aabbOverlap(nx, py, pz, rad, h, b))) {
    px = nx;
  }
  if (!SOLIDS.some((b) => aabbOverlap(px, py, nz, rad, h, b))) {
    pz = nz;
  }

  // Vertical + floor support
  let onGround = false;
  let groundY = 0;
  for (const f of FLOORS) {
    if (px >= f.minX - rad && px <= f.maxX + rad && pz >= f.minZ - rad && pz <= f.maxZ + rad) {
      if (py >= f.y - 0.4 && ny <= f.y + 0.05) {
        groundY = Math.max(groundY, f.y);
      }
    }
  }
  // World floor
  if (ny <= 0) {
    ny = 0;
    onGround = true;
  }
  if (ny <= groundY + 0.02 && py >= groundY - 0.5) {
    ny = groundY;
    onGround = true;
  }
  // Ceiling / solids vertical
  if (SOLIDS.some((b) => aabbOverlap(px, ny, pz, rad, h, b))) {
    ny = py;
  }
  return { x: px, y: ny, z: pz, onGround };
}

function raycastPlayers(ox, oy, oz, dx, dy, dz, excludeId, players, maxDist = 80) {
  let best = null;
  let bestT = maxDist;
  for (const [id, p] of players) {
    if (id === excludeId || p.dead || !p.alive) continue;
    // Cylinder approx: body + head
    const cx = p.x, cz = p.z;
    // Ray-cylinder on XZ, then check Y bands
    const fx = ox - cx, fz = oz - cz;
    const a = dx * dx + dz * dz;
    const b = 2 * (fx * dx + fz * dz);
    const c = fx * fx + fz * fz - HIT_RADIUS * HIT_RADIUS;
    let tBody = null;
    if (a > 1e-8) {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        if (t > 0.05 && t < bestT) tBody = t;
      }
    }
    if (tBody == null) continue;
    const hy = oy + dy * tBody;
    const feet = p.y;
    if (hy < feet + 0.1 || hy > feet + 1.75) continue;
    const headshot = hy >= feet + HEAD_OFFSET;
    bestT = tBody;
    best = { id, t: tBody, headshot, x: ox + dx * tBody, y: hy, z: oz + dz * tBody };
  }
  return best;
}


// ——— Practice bots ———
function losClear(ax, ay, az, bx, by, bz) {
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / 0.4);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
    for (const s of SOLIDS) {
      if (x > s[0] && x < s[3] && y > s[1] && y < s[4] && z > s[2] && z < s[5]) return false;
    }
  }
  return true;
}

function botThink(room, b, now) {
  const inp = { f: 0, b: 0, l: 0, r: 0, jump: 0, fire: 0, reload: 0, yaw: b.yaw, pitch: b.pitch };
  const ai = b.ai;
  // nearest visible enemy
  let target = null, best = 1e9;
  for (const o of room.players.values()) {
    if (o === b || o.dead) continue;
    const d = Math.hypot(o.x - b.x, o.z - b.z);
    if (d < best && d < 45 && losClear(b.x, b.y + EYE_HEIGHT, b.z, o.x, o.y + 1.2, o.z)) { best = d; target = o; }
  }
  if (target) {
    const dx = target.x - b.x, dz = target.z - b.z;
    const dy = (target.y + 1.1) - (b.y + EYE_HEIGHT);
    // Three.js convention: forward = (-sin yaw, -cos yaw)
    const wantYaw = Math.atan2(-dx, -dz);
    const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
    let dyaw = wantYaw - b.yaw;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    const turn = 3.2 / TICK_HZ; // rad per tick, human-ish
    inp.yaw = b.yaw + Math.max(-turn, Math.min(turn, dyaw)) + (Math.random() - 0.5) * 0.04;
    inp.pitch = b.pitch + (wantPitch - b.pitch) * 0.3;
    if (!ai.seenAt) ai.seenAt = now;
    inp.fire = (Math.abs(dyaw) < 0.12 && now - ai.seenAt > 500 && (now % 1000) < 380) ? 1 : 0; // short bursts
    if (best > 14) inp.f = 1; else if (best < 6) inp.b = 1;
    if (now > ai.strafeUntil) { ai.strafeDir = Math.random() < 0.5 ? -1 : 1; ai.strafeUntil = now + 600 + Math.random() * 900; }
    if (ai.strafeDir < 0) inp.l = 1; else inp.r = 1;
  } else {
    ai.seenAt = 0;
    // wander: walk forward, turn when stuck or on timer
    const moved = Math.hypot(b.x - ai.lx, b.z - ai.lz);
    ai.lx = b.x; ai.lz = b.z;
    if (now > ai.wanderUntil || (moved < 0.05 && now - ai.wanderStart > 300)) {
      ai.wanderYaw = b.yaw + (Math.random() - 0.5) * 2.5 + (moved < 0.05 ? Math.PI * 0.6 : 0);
      ai.wanderUntil = now + 1500 + Math.random() * 2500;
      ai.wanderStart = now;
    }
    let dyaw = ai.wanderYaw - b.yaw;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    inp.yaw = b.yaw + Math.max(-0.1, Math.min(0.1, dyaw));
    inp.pitch = b.pitch * 0.8;
    inp.f = 1;
  }
  if (b.ammo === 0 || (!target && b.ammo < 12)) inp.reload = 1;
  b.input = inp;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.started = false;
    this.finished = false;
    this.winner = null;
    this.killLimit = KILL_LIMIT;
    this.spawnIdx = 0;
    this.events = []; // short-lived fx events this tick
  }

  addPlayer(socket, name, color) {
    if (this.players.size >= MAX_PLAYERS) return null;
    if (this.started) return null;
    const spawn = SPAWNS[this.spawnIdx++ % SPAWNS.length];
    const p = {
      id: socket.id,
      name: (name || 'Player').slice(0, 12),
      color: color || '#4af',
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: spawn.yaw,
      pitch: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      onGround: true,
      hp: MAX_HP,
      kills: 0,
      deaths: 0,
      ammo: AR_MAG,
      reserve: AR_RESERVE,
      lastShot: 0,
      reloading: false,
      reloadAt: 0,
      dead: false,
      alive: true,
      respawnAt: 0,
      ready: false,
      input: { f: 0, b: 0, l: 0, r: 0, jump: 0, fire: 0, reload: 0, yaw: spawn.yaw, pitch: 0 },
    };
    this.players.set(socket.id, p);
    return p;
  }

  addBot(name, color) {
    const fake = { id: 'bot-' + Math.random().toString(36).slice(2, 8) };
    const p = this.addPlayer(fake, name, color);
    if (p) { p.bot = true; p.ready = true; p.ai = { strafeDir: 1, strafeUntil: 0, wanderUntil: 0, wanderStart: 0, wanderYaw: p.yaw, lx: p.x, lz: p.z, seenAt: 0 }; }
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  getLobbyState() {
    return {
      code: this.code,
      started: this.started,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        ready: p.ready,
        bot: !!p.bot,
      })),
      max: MAX_PLAYERS,
      killLimit: this.killLimit,
    };
  }

  maybeStart() {
    if (this.started) return;
    const list = [...this.players.values()];
    if (list.length >= 2 && list.every((p) => p.ready)) {
      this.started = true;
      this.finished = false;
      this.winner = null;
      for (const p of list) {
        const spawn = SPAWNS[this.spawnIdx++ % SPAWNS.length];
        p.x = spawn.x; p.y = spawn.y; p.z = spawn.z;
        p.yaw = spawn.yaw; p.pitch = 0;
        p.hp = MAX_HP; p.ammo = AR_MAG; p.reserve = AR_RESERVE;
        p.kills = 0; p.deaths = 0; p.dead = false; p.alive = true;
        p.vy = 0; p.reloading = false;
      }
    }
  }

  tick(dt) {
    if (!this.started || this.finished) return;
    this.events = [];
    const now = Date.now();

    for (const p of this.players.values()) {
      if (p.bot && !p.dead) botThink(this, p, now);
    }

    for (const p of this.players.values()) {
      if (p.dead) {
        if (now >= p.respawnAt) {
          const spawn = SPAWNS[this.spawnIdx++ % SPAWNS.length];
          p.x = spawn.x; p.y = spawn.y; p.z = spawn.z;
          p.yaw = spawn.yaw; p.pitch = 0;
          p.hp = MAX_HP; p.ammo = AR_MAG;
          if (p.reserve < AR_RESERVE) p.reserve = Math.min(AR_RESERVE, p.reserve + AR_MAG);
          p.dead = false; p.alive = true; p.vy = 0; p.reloading = false;
        }
        continue;
      }

      const inp = p.input;
      p.yaw = inp.yaw;
      p.pitch = Math.max(-1.4, Math.min(1.4, inp.pitch));

      // Movement
      let mx = 0, mz = 0;
      const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      // Three.js right-handed convention (camera.rotation.y = yaw, order YXZ):
      // forward = (-sin, 0, -cos), right = (cos, 0, -sin). Positive yaw turns left.
      if (inp.f) { mx -= sy; mz -= cy; }
      if (inp.b) { mx += sy; mz += cy; }
      if (inp.l) { mx -= cy; mz += sy; }
      if (inp.r) { mx += cy; mz -= sy; }
      const len = Math.hypot(mx, mz);
      if (len > 0) { mx = (mx / len) * PLAYER_SPEED; mz = (mz / len) * PLAYER_SPEED; }

      if (inp.jump && p.onGround) {
        p.vy = JUMP_VEL;
        p.onGround = false;
      }
      p.vy -= GRAVITY * dt;

      const moved = resolveMove(p.x, p.y, p.z, mx * dt, p.vy * dt, mz * dt);
      p.x = moved.x; p.y = moved.y; p.z = moved.z;
      if (moved.onGround) {
        p.onGround = true;
        if (p.vy < 0) p.vy = 0;
      } else {
        p.onGround = false;
      }

      // Reload
      if (inp.reload && !p.reloading && p.ammo < AR_MAG && p.reserve > 0) {
        p.reloading = true;
        p.reloadAt = now + RELOAD_MS;
      }
      if (p.reloading && now >= p.reloadAt) {
        const need = AR_MAG - p.ammo;
        const take = Math.min(need, p.reserve);
        p.ammo += take;
        p.reserve -= take;
        p.reloading = false;
      }

      // Fire hitscan
      if (inp.fire && !p.reloading && p.ammo > 0 && now - p.lastShot >= AR_ROF_MS) {
        p.lastShot = now;
        p.ammo--;
        // Spread
        const spreadY = (Math.random() - 0.5) * AR_SPREAD * 2;
        const spreadP = (Math.random() - 0.5) * AR_SPREAD * 2;
        const yaw = p.yaw + spreadY;
        const pitch = p.pitch + spreadP;
        const dx = -Math.sin(yaw) * Math.cos(pitch);
        const dy = Math.sin(pitch);
        const dz = -Math.cos(yaw) * Math.cos(pitch);
        const ox = p.x;
        const oy = p.y + EYE_HEIGHT;
        const oz = p.z;
        const hit = raycastPlayers(ox, oy, oz, dx, dy, dz, p.id, this.players);
        if (hit) {
          const victim = this.players.get(hit.id);
          if (victim && !victim.dead) {
            const dmg = Math.round(AR_DAMAGE * (hit.headshot ? AR_HS_MULT : 1));
            victim.hp -= dmg;
            this.events.push({
              type: 'hit',
              from: p.id,
              to: hit.id,
              headshot: hit.headshot,
              x: hit.x, y: hit.y, z: hit.z,
              dmg,
            });
            if (victim.hp <= 0) {
              victim.hp = 0;
              victim.dead = true;
              victim.alive = false;
              victim.deaths++;
              victim.respawnAt = now + RESPAWN_MS;
              p.kills++;
              this.events.push({ type: 'kill', killer: p.id, victim: hit.id, headshot: hit.headshot });
              if (p.kills >= this.killLimit) {
                this.finished = true;
                this.winner = p.id;
              }
            }
          }
        } else {
          this.events.push({
            type: 'shot',
            from: p.id,
            x: ox + dx * 40,
            y: oy + dy * 40,
            z: oz + dz * 40,
          });
        }
      }
    }
  }

  getState() {
    return {
      t: Date.now(),
      started: this.started,
      finished: this.finished,
      winner: this.winner,
      killLimit: this.killLimit,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        bot: !!p.bot,
        x: p.x, y: p.y, z: p.z,
        yaw: p.yaw, pitch: p.pitch,
        hp: p.hp,
        kills: p.kills,
        deaths: p.deaths,
        ammo: p.ammo,
        reserve: p.reserve,
        reloading: p.reloading,
        dead: p.dead,
        alive: p.alive,
      })),
      events: this.events,
    };
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

app.use(express.static(path.join(__dirname, 'public')));

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6'];

io.on('connection', (socket) => {
  let roomCode = null;

  socket.on('create', ({ name }) => {
    leaveCurrent();
    const code = makeCode();
    const room = new Room(code);
    rooms.set(code, room);
    const color = COLORS[0];
    const p = room.addPlayer(socket, name, color);
    roomCode = code;
    socket.join(code);
    socket.emit('joined', { code, id: socket.id, you: snapshotPlayer(p) });
    io.to(code).emit('lobby', room.getLobbyState());
  });

  socket.on('practice', ({ name }) => {
    leaveCurrent();
    const code = makeCode();
    const room = new Room(code);
    room.practice = true;
    rooms.set(code, room);
    const p = room.addPlayer(socket, name, COLORS[0]);
    room.addBot('Bot Viper', COLORS[1]);
    room.addBot('Bot Ghost', COLORS[2]);
    roomCode = code;
    socket.join(code);
    socket.emit('joined', { code, id: socket.id, you: snapshotPlayer(p), practice: true });
    p.ready = true;
    room.maybeStart();
    io.to(code).emit('lobby', room.getLobbyState());
    io.to(code).emit('start', room.getState());
  });

  socket.on('join', ({ code, name }) => {
    leaveCurrent();
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('error_msg', 'Room not found');
      return;
    }
    if (room.started) {
      socket.emit('error_msg', 'Game already started');
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      socket.emit('error_msg', 'Room full (max 3)');
      return;
    }
    const color = COLORS[room.players.size % COLORS.length];
    const p = room.addPlayer(socket, name, color);
    if (!p) {
      socket.emit('error_msg', 'Could not join');
      return;
    }
    roomCode = code;
    socket.join(code);
    socket.emit('joined', { code, id: socket.id, you: snapshotPlayer(p) });
    io.to(code).emit('lobby', room.getLobbyState());
  });

  socket.on('ready', (ready) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !!ready;
    room.maybeStart();
    io.to(roomCode).emit('lobby', room.getLobbyState());
    if (room.started) {
      io.to(roomCode).emit('start', room.getState());
    }
  });

  socket.on('set_limit', (n) => {
    const room = rooms.get(roomCode);
    if (!room || room.started) return;
    const host = [...room.players.keys()][0];
    if (socket.id !== host) return;
    room.killLimit = Math.max(3, Math.min(30, parseInt(n, 10) || 10));
    io.to(roomCode).emit('lobby', room.getLobbyState());
  });

  socket.on('input', (inp) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.input = {
      f: inp.f ? 1 : 0,
      b: inp.b ? 1 : 0,
      l: inp.l ? 1 : 0,
      r: inp.r ? 1 : 0,
      jump: inp.jump ? 1 : 0,
      fire: inp.fire ? 1 : 0,
      reload: inp.reload ? 1 : 0,
      yaw: typeof inp.yaw === 'number' ? inp.yaw : p.yaw,
      pitch: typeof inp.pitch === 'number' ? inp.pitch : p.pitch,
    };
  });

  socket.on('restart', () => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.started = false;
    room.finished = false;
    room.winner = null;
    for (const p of room.players.values()) {
      p.ready = !!p.bot;
      p.kills = 0;
      p.deaths = 0;
      p.hp = MAX_HP;
      p.dead = false;
      p.alive = true;
    }
    io.to(roomCode).emit('lobby', room.getLobbyState());
    if (room.practice) {
      const me = room.players.get(socket.id);
      if (me) me.ready = true;
      room.maybeStart();
      io.to(roomCode).emit('start', room.getState());
    }
  });

  socket.on('disconnect', () => {
    leaveCurrent();
  });

  function leaveCurrent() {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    const code = roomCode;
    roomCode = null;
    if (!room) return;
    room.removePlayer(socket.id);
    socket.leave(code);
    if ([...room.players.values()].every((p) => p.bot)) {
      rooms.delete(code);
    } else {
      io.to(code).emit('lobby', room.getLobbyState());
      if (room.started && room.players.size < 2) {
        room.finished = true;
        room.winner = [...room.players.keys()][0];
      }
    }
  }
});

function snapshotPlayer(p) {
  return { id: p.id, name: p.name, color: p.color };
}

setInterval(() => {
  const dt = TICK_MS / 1000;
  for (const room of rooms.values()) {
    if (!room.started) continue;
    room.tick(dt);
    io.to(room.code).emit('state', room.getState());
  }
}, TICK_MS);

// Cleanup empty rooms occasionally
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.players.size === 0) rooms.delete(code);
  }
}, 60000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Family FPS listening on http://0.0.0.0:${PORT}`);
});
