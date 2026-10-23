/**
 * District Fire — client (Three.js + Socket.io)
 * Phone-first touch controls; desktop WASD + mouse fallback.
 */
import * as THREE from 'three';

const canvas = document.getElementById('game');
const lobbyEl = document.getElementById('lobby');
const lobbyRoom = document.getElementById('lobbyRoom');
const lobbyError = document.getElementById('lobbyError');
const hud = document.getElementById('hud');
const touchUI = document.getElementById('touchUI');
const nameInput = document.getElementById('nameInput');
const codeInput = document.getElementById('codeInput');
const playerList = document.getElementById('playerList');
const roomCodeEl = document.getElementById('roomCode');
const killLimitInput = document.getElementById('killLimit');

const savedName = localStorage.getItem('df_name') || '';
if (savedName) nameInput.value = savedName;

const socket = io({ transports: ['websocket', 'polling'] });

let myId = null;
let roomCode = null;
let inGame = false;
let latestState = null;
let isReady = false;
let isHost = false;

// ——— Input state ———
const input = {
  f: 0, b: 0, l: 0, r: 0,
  jump: 0, fire: 0, reload: 0,
  yaw: 0, pitch: 0,
};
let lookSens = 0.0045;

// ——— Three.js ———
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x87a0b5, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x87a0b5, 35, 95);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.08, 200);
camera.position.set(0, 1.55, 0);

const hemi = new THREE.HemisphereLight(0xb8c8d8, 0x3a3a3a, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 0.9);
sun.position.set(20, 40, 10);
scene.add(sun);
scene.add(new THREE.AmbientLight(0x404850, 0.35));

const playerMeshes = new Map(); // id -> { group, body, head, nameSprite }
const muzzleFlash = new THREE.PointLight(0xffaa55, 0, 8);
scene.add(muzzleFlash);
let muzzleUntil = 0;

const hitMarkers = [];

function mat(color, rough = 0.85) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.15 });
}

function box(w, h, d, color, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z);
  m.castShadow = false;
  scene.add(m);
  return m;
}

function buildArena() {
  // Ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 44),
    mat(0x4a4e52, 0.95)
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Grid lines for readability
  const grid = new THREE.GridHelper(44, 22, 0x3a3e42, 0x3a3e42);
  grid.position.y = 0.01;
  scene.add(grid);

  // Outer walls
  const wallC = 0x5c6166;
  box(44, 6, 1.5, wallC, 0, 3, -21.25);
  box(44, 6, 1.5, wallC, 0, 3, 21.25);
  box(1.5, 6, 44, wallC, -21.25, 3, 0);
  box(1.5, 6, 44, wallC, 21.25, 3, 0);

  // Buildings (match server SOLIDS centers/sizes)
  // [-16,0,-10,-8,5,-4] -> center (-12, 2.5, -7), size (8,5,6)
  box(8, 5, 6, 0x6a6e72, -12, 2.5, -7);
  // [6,0,4,14,4,12]
  box(8, 4, 8, 0x5e6368, 10, 2, 8);
  // [-4,0,8,2,3,14]
  box(6, 3, 6, 0x70757a, -1, 1.5, 11);
  // [8,0,-16,14,6,-8]
  box(6, 6, 8, 0x555a5f, 11, 3, -12);
  // [-14,0,6,-10,2.5,12]
  box(4, 2.5, 6, 0x686c70, -12, 1.25, 9);

  // Platforms
  box(6, 2.5, 4, 0x7a7e82, -7, 1.25, 0);   // [-10,-4] x [-2,2] h2.5
  box(6, 2, 6, 0x7a7e82, 5, 1, -5);         // [2,8] x [-8,-2]

  // Metal accents / ramps (visual wedges as thin boxes)
  box(4, 0.3, 6, 0x8a9096, -7, 1.3, -4);
  box(6, 0.3, 4, 0x8a9096, 2, 1.05, -5);

  // Cover crates
  box(4, 1.2, 4, 0x8b7355, 0, 0.6, -12);
  box(4, 1.2, 4, 0x6b6b6b, 12, 0.6, 0);
  box(4, 1.2, 4, 0x8b7355, -16, 0.6, 4);

  // Pillars for verticality cue
  box(1.2, 4, 1.2, 0x4d5155, -6, 2, 14);
  box(1.2, 4, 1.2, 0x4d5155, 6, 2, -18);

  // Sky-ish backdrop color already clear + fog
}

buildArena();

function makeNameSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 8, 256, 48);
  ctx.font = 'bold 28px system-ui,sans-serif';
  ctx.fillStyle = color || '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  const matS = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const spr = new THREE.Sprite(matS);
  spr.scale.set(2.2, 0.55, 1);
  return spr;
}

// Lightweight low-poly soldier: head, helmet, torso + vest, arms, legs, rifle.
// Clothing in muted military/urban tones; team color shows on armband + helmet band + name.
const SKIN_TONES = [0xe0b896, 0xc68e66, 0x8d5a3b, 0xf1c9a5];
const OUTFITS = [
  { shirt: 0x5b6142, pants: 0x4a4f3a, vest: 0x3b3f2e, helmet: 0x4d5238 }, // olive drab
  { shirt: 0x6f6a5c, pants: 0x3e4247, vest: 0x2e3236, helmet: 0x3a3e42 }, // urban grey
  { shirt: 0x8a7a5a, pants: 0x6e6248, vest: 0x5a4f3a, helmet: 0x6b5f45 }, // desert tan
];
const sharedGeo = {
  head: new THREE.BoxGeometry(0.26, 0.28, 0.26),
  helmet: new THREE.BoxGeometry(0.3, 0.12, 0.3),
  torso: new THREE.BoxGeometry(0.46, 0.58, 0.26),
  vest: new THREE.BoxGeometry(0.5, 0.42, 0.3),
  upperArm: new THREE.BoxGeometry(0.13, 0.32, 0.13),
  foreArm: new THREE.BoxGeometry(0.12, 0.3, 0.12),
  leg: new THREE.BoxGeometry(0.17, 0.46, 0.17),
  shin: new THREE.BoxGeometry(0.16, 0.42, 0.16),
  boot: new THREE.BoxGeometry(0.17, 0.1, 0.26),
  rifle: new THREE.BoxGeometry(0.07, 0.1, 0.7),
  band: new THREE.BoxGeometry(0.14, 0.06, 0.14),
};
function hashStr(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

function ensurePlayerMesh(p) {
  let rec = playerMeshes.get(p.id);
  if (rec) {
    rec.nameSprite.material.map.dispose();
    scene.remove(rec.group);
    playerMeshes.delete(p.id);
  }
  const h = hashStr(p.id + p.name);
  const o = OUTFITS[h % OUTFITS.length];
  const skin = SKIN_TONES[(h >> 3) % SKIN_TONES.length];
  const team = new THREE.Color(p.color).getHex();
  const M = (c) => mat(c, 0.85);
  const part = (geo, color, x, y, z, parent) => {
    const m = new THREE.Mesh(geo, M(color)); m.position.set(x, y, z); parent.add(m); return m;
  };
  const group = new THREE.Group();
  const body = new THREE.Group(); // rotates with yaw
  group.add(body);
  // Legs (pivot at hip)
  const mkLeg = (side) => {
    const hip = new THREE.Group(); hip.position.set(0.12 * side, 0.92, 0); body.add(hip);
    part(sharedGeo.leg, o.pants, 0, -0.23, 0, hip);
    const knee = new THREE.Group(); knee.position.set(0, -0.46, 0); hip.add(knee);
    part(sharedGeo.shin, o.pants, 0, -0.21, 0, knee);
    part(sharedGeo.boot, 0x1e1e1e, 0, -0.42, -0.04, knee);
    return { hip, knee };
  };
  const legL = mkLeg(-1), legR = mkLeg(1);
  // Torso
  const torso = part(sharedGeo.torso, o.shirt, 0, 1.21, 0, body);
  part(sharedGeo.vest, o.vest, 0, 1.25, 0, body);
  // Head
  part(sharedGeo.head, skin, 0, 1.66, 0, body);
  part(sharedGeo.helmet, o.helmet, 0, 1.83, 0, body);
  // Arms holding rifle (pivot at shoulder), forward is -Z
  const mkArm = (side, fwd) => {
    const sh = new THREE.Group(); sh.position.set(0.3 * side, 1.44, 0); body.add(sh);
    part(sharedGeo.upperArm, o.shirt, 0, -0.15, 0, sh);
    const el = new THREE.Group(); el.position.set(0, -0.3, 0); sh.add(el);
    part(sharedGeo.foreArm, skin, 0, -0.14, 0, el);
    sh.rotation.x = fwd; el.rotation.x = 0.9; sh.rotation.z = -0.25 * side;
    return { sh, el };
  };
  const armL = mkArm(-1, 0.9), armR = mkArm(1, 0.4);
  // Team armband on right arm
  part(sharedGeo.band, team, 0, -0.08, 0, armR.sh);
  const rifle = part(sharedGeo.rifle, 0x222222, 0.1, 1.22, -0.38, body);
  const nameSprite = makeNameSprite(p.name, p.color);
  nameSprite.position.y = 2.15;
  group.add(nameSprite);
  scene.add(group);
  rec = { group, body, legL, legR, armL, torso, rifle, nameSprite, color: p.color, phase: 0, lx: p.x, lz: p.z, speed: 0 };
  playerMeshes.set(p.id, rec);
  return rec;
}

function animateWalk(rec, dt) {
  const s = rec.speed;
  const amt = Math.min(1, s / 6);
  rec.phase += dt * (4 + s * 1.1);
  const sw = Math.sin(rec.phase) * 0.7 * amt;
  rec.legL.hip.rotation.x = sw;
  rec.legR.hip.rotation.x = -sw;
  rec.legL.knee.rotation.x = Math.max(0, -Math.sin(rec.phase)) * 0.9 * amt;
  rec.legR.knee.rotation.x = Math.max(0, Math.sin(rec.phase)) * 0.9 * amt;
  rec.body.position.y = Math.abs(Math.cos(rec.phase)) * 0.05 * amt;
}

function syncPlayers(players) {
  const seen = new Set();
  const now = performance.now();
  for (const p of players) {
    seen.add(p.id);
    if (p.id === myId) continue;
    let rec = playerMeshes.get(p.id);
    if (!rec || rec.color !== p.color) rec = ensurePlayerMesh(p);
    rec.group.visible = !p.dead;
    const dt = rec.lt ? Math.min(0.1, (now - rec.lt) / 1000) : 0.016;
    rec.lt = now;
    if (rec.lastStateT !== latestState.t) {
      const st = latestState.t, sdt = rec.lastStateT ? Math.max(0.02, (st - rec.lastStateT) / 1000) : 0.04;
      const inst = Math.hypot(p.x - rec.lx, p.z - rec.lz) / sdt;
      rec.speed = rec.speed * 0.6 + (inst < 30 ? inst : 0) * 0.4;
      rec.lx = p.x; rec.lz = p.z; rec.lastStateT = st;
    }
    rec.group.position.set(p.x, p.y, p.z);
    rec.body.rotation.y = p.yaw;
    animateWalk(rec, dt);
  }
  for (const [id, rec] of playerMeshes) {
    if (!seen.has(id) || id === myId) {
      scene.remove(rec.group);
      playerMeshes.delete(id);
    }
  }
}

// ——— Lobby ———
function showError(msg) {
  lobbyError.textContent = msg || '';
}

document.getElementById('btnCreate').onclick = () => {
  const name = (nameInput.value || 'Player').trim().slice(0, 12);
  localStorage.setItem('df_name', name);
  showError('');
  socket.emit('create', { name });
};

document.getElementById('btnPractice').onclick = () => {
  const name = (nameInput.value || 'Player').trim().slice(0, 12);
  localStorage.setItem('df_name', name);
  showError('');
  socket.emit('practice', { name });
};

document.getElementById('btnJoin').onclick = () => {
  const name = (nameInput.value || 'Player').trim().slice(0, 12);
  const code = (codeInput.value || '').trim().toUpperCase();
  localStorage.setItem('df_name', name);
  showError('');
  socket.emit('join', { code, name });
};

document.getElementById('btnReady').onclick = () => {
  isReady = !isReady;
  socket.emit('ready', isReady);
  document.getElementById('btnReady').textContent = isReady ? 'Unready' : 'Ready';
};

killLimitInput.onchange = () => {
  if (isHost) socket.emit('set_limit', killLimitInput.value);
};

document.getElementById('btnRestart').onclick = () => {
  socket.emit('restart');
  document.getElementById('winnerMsg').classList.add('hidden');
  hud.classList.add('hidden');
  touchUI.classList.add('hidden');
  lobbyEl.classList.remove('hidden');
  lobbyRoom.classList.remove('hidden');
  inGame = false;
  isReady = false;
  document.getElementById('btnReady').textContent = 'Ready';
};

socket.on('error_msg', (m) => showError(m));

socket.on('joined', ({ code, id }) => {
  myId = id;
  roomCode = code;
  roomCodeEl.textContent = code;
  lobbyRoom.classList.remove('hidden');
});

socket.on('lobby', (lobby) => {
  roomCode = lobby.code;
  roomCodeEl.textContent = lobby.code;
  killLimitInput.value = lobby.killLimit;
  const ids = lobby.players.map((p) => p.id);
  isHost = ids[0] === myId;
  killLimitInput.disabled = !isHost;
  playerList.innerHTML = '';
  for (const p of lobby.players) {
    const li = document.createElement('li');
    li.style.borderLeftColor = p.color;
    li.innerHTML = `<span>${escapeHtml(p.name)}${p.id === myId ? ' (you)' : ''}</span>` +
      (p.ready ? '<span class="ready-tag">READY</span>' : '<span></span>');
    playerList.appendChild(li);
  }
  if (!lobby.started) {
    lobbyEl.classList.remove('hidden');
    lobbyRoom.classList.remove('hidden');
    hud.classList.add('hidden');
    touchUI.classList.add('hidden');
    inGame = false;
  }
});

socket.on('start', (state) => {
  latestState = state;
  inGame = true;
  lobbyEl.classList.add('hidden');
  hud.classList.remove('hidden');
  touchUI.classList.remove('hidden');
  document.getElementById('winnerMsg').classList.add('hidden');
  const me = state.players.find((p) => p.id === myId);
  if (me) {
    input.yaw = me.yaw;
    input.pitch = me.pitch || 0;
  }
});

socket.on('state', (state) => {
  latestState = state;
  if (!inGame && state.started) {
    inGame = true;
    lobbyEl.classList.add('hidden');
    hud.classList.remove('hidden');
    touchUI.classList.remove('hidden');
  }
  handleEvents(state.events || []);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const killFeed = document.getElementById('killFeed');
function handleEvents(events) {
  for (const e of events) {
    if (e.type === 'kill') {
      const killer = latestState?.players.find((p) => p.id === e.killer);
      const victim = latestState?.players.find((p) => p.id === e.victim);
      const div = document.createElement('div');
      div.textContent = `${killer?.name || '?'} ${e.headshot ? '⊗' : '→'} ${victim?.name || '?'}`;
      killFeed.prepend(div);
      setTimeout(() => div.remove(), 3500);
      while (killFeed.children.length > 5) killFeed.lastChild.remove();
    }
    if (e.type === 'hit' && e.from === myId) {
      flashHitMarker(e.headshot);
      muzzleUntil = performance.now() + 40;
    }
    if ((e.type === 'shot' || e.type === 'hit') && e.from === myId) {
      muzzleUntil = performance.now() + 50;
    }
  }
}

function flashHitMarker(hs) {
  const el = document.getElementById('crosshair');
  el.style.borderColor = hs ? '#f85149' : '#3fb950';
  setTimeout(() => { el.style.borderColor = 'rgba(255,255,255,0.85)'; }, 80);
}

// ——— Touch controls ———
const joyBase = document.getElementById('joyBase');
const joyKnob = document.getElementById('joyKnob');
const joyZone = document.getElementById('joyZone');
const lookZone = document.getElementById('lookZone');
let joyTouchId = null;
let lookTouchId = null;
let lookLastX = 0, lookLastY = 0;
const JOY_R = 40;

function setJoy(dx, dy) {
  const len = Math.hypot(dx, dy) || 1;
  const cl = Math.min(len, JOY_R);
  const nx = (dx / len) * cl;
  const ny = (dy / len) * cl;
  joyKnob.style.transform = `translate(${nx}px, ${ny}px)`;
  const ax = nx / JOY_R;
  const ay = ny / JOY_R;
  input.f = ay < -0.25 ? 1 : 0;
  input.b = ay > 0.25 ? 1 : 0;
  input.l = ax < -0.25 ? 1 : 0;
  input.r = ax > 0.25 ? 1 : 0;
}

function resetJoy() {
  joyKnob.style.transform = 'translate(0,0)';
  input.f = input.b = input.l = input.r = 0;
}

joyZone.addEventListener('touchstart', (ev) => {
  for (const t of ev.changedTouches) {
    if (joyTouchId == null) {
      joyTouchId = t.identifier;
      const rect = joyBase.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      setJoy(t.clientX - cx, t.clientY - cy);
    }
  }
  ev.preventDefault();
}, { passive: false });

joyZone.addEventListener('touchmove', (ev) => {
  for (const t of ev.changedTouches) {
    if (t.identifier === joyTouchId) {
      const rect = joyBase.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      setJoy(t.clientX - cx, t.clientY - cy);
    }
  }
  ev.preventDefault();
}, { passive: false });

joyZone.addEventListener('touchend', (ev) => {
  for (const t of ev.changedTouches) {
    if (t.identifier === joyTouchId) {
      joyTouchId = null;
      resetJoy();
    }
  }
}, { passive: false });
joyZone.addEventListener('touchcancel', (ev) => {
  joyTouchId = null;
  resetJoy();
});

lookZone.addEventListener('touchstart', (ev) => {
  for (const t of ev.changedTouches) {
    if (lookTouchId == null) {
      lookTouchId = t.identifier;
      lookLastX = t.clientX;
      lookLastY = t.clientY;
    }
  }
  ev.preventDefault();
}, { passive: false });

lookZone.addEventListener('touchmove', (ev) => {
  for (const t of ev.changedTouches) {
    if (t.identifier === lookTouchId) {
      const dx = t.clientX - lookLastX;
      const dy = t.clientY - lookLastY;
      lookLastX = t.clientX;
      lookLastY = t.clientY;
      input.yaw -= dx * lookSens; // drag right = turn right (three.js: +yaw is left)
      input.pitch -= dy * lookSens;
      input.pitch = Math.max(-1.4, Math.min(1.4, input.pitch));
    }
  }
  ev.preventDefault();
}, { passive: false });

lookZone.addEventListener('touchend', (ev) => {
  for (const t of ev.changedTouches) {
    if (t.identifier === lookTouchId) lookTouchId = null;
  }
}, { passive: false });
lookZone.addEventListener('touchcancel', () => { lookTouchId = null; });

function bindHold(btn, key) {
  const down = (ev) => {
    ev.preventDefault();
    input[key] = 1;
    btn.classList.add('active');
  };
  const up = (ev) => {
    ev.preventDefault();
    input[key] = 0;
    btn.classList.remove('active');
  };
  btn.addEventListener('touchstart', down, { passive: false });
  btn.addEventListener('touchend', up, { passive: false });
  btn.addEventListener('touchcancel', up, { passive: false });
  btn.addEventListener('mousedown', down);
  btn.addEventListener('mouseup', up);
  btn.addEventListener('mouseleave', up);
}
bindHold(document.getElementById('btnFire'), 'fire');
bindHold(document.getElementById('btnJump'), 'jump');
bindHold(document.getElementById('btnReload'), 'reload');

// Desktop fallback
const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyR') input.reload = 1;
  if (e.code === 'Space') { input.jump = 1; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'KeyR') input.reload = 0;
  if (e.code === 'Space') input.jump = 0;
});

canvas.addEventListener('click', () => {
  if (inGame && !('ontouchstart' in window)) canvas.requestPointerLock();
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  input.yaw -= e.movementX * 0.0025;
  input.pitch -= e.movementY * 0.0025;
  input.pitch = Math.max(-1.4, Math.min(1.4, input.pitch));
});
document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement === canvas && e.button === 0) input.fire = 1;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) input.fire = 0;
});

function applyKeyboard() {
  const usingKeys = keys.KeyW || keys.KeyS || keys.KeyA || keys.KeyD ||
    keys.ArrowUp || keys.ArrowDown || keys.ArrowLeft || keys.ArrowRight;
  if (!usingKeys) return; // leave joystick state alone
  input.f = (keys.KeyW || keys.ArrowUp) ? 1 : 0;
  input.b = (keys.KeyS || keys.ArrowDown) ? 1 : 0;
  input.l = (keys.KeyA || keys.ArrowLeft) ? 1 : 0;
  input.r = (keys.KeyD || keys.ArrowRight) ? 1 : 0;
}

// ——— Network send ———
setInterval(() => {
  if (!inGame) return;
  applyKeyboard();
  socket.emit('input', { ...input });
}, 50);

// ——— HUD ———
function updateHud(state) {
  const me = state.players.find((p) => p.id === myId);
  if (!me) return;
  const hpPct = Math.max(0, me.hp);
  const fill = document.getElementById('hpFill');
  fill.style.width = hpPct + '%';
  fill.style.background = hpPct > 50 ? '#3fb950' : hpPct > 25 ? '#d29922' : '#f85149';
  document.getElementById('ammo').textContent = me.reloading
    ? 'REL…'
    : `${me.ammo} | ${me.reserve}`;
  document.getElementById('scoreTiny').textContent = `K ${me.kills}/${state.killLimit}`;

  const sb = document.getElementById('scoreboard');
  const sorted = [...state.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  sb.innerHTML = sorted.map((p) =>
    `<div class="row"><span style="color:${p.color}">${escapeHtml(p.name)}</span><span>${p.kills}/${p.deaths}</span></div>`
  ).join('');

  const rm = document.getElementById('respawnMsg');
  if (me.dead) rm.classList.remove('hidden');
  else rm.classList.add('hidden');

  if (state.finished) {
    const w = state.players.find((p) => p.id === state.winner);
    const wm = document.getElementById('winnerMsg');
    document.getElementById('winnerText').textContent = `${w?.name || 'Someone'} wins!`;
    wm.classList.remove('hidden');
  }
}

// ——— Render loop ———
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 200));

function animate() {
  requestAnimationFrame(animate);
  if (latestState && inGame) {
    const me = latestState.players.find((p) => p.id === myId);
    if (me && !me.dead) {
      // Client camera from server pos + local look for responsiveness
      camera.position.set(me.x, me.y + 1.55, me.z);
      camera.rotation.order = 'YXZ';
      camera.rotation.y = input.yaw;
      camera.rotation.x = input.pitch;
      muzzleFlash.position.copy(camera.position);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      muzzleFlash.position.addScaledVector(dir, 0.5);
      muzzleFlash.intensity = performance.now() < muzzleUntil ? 2.5 : 0;
    } else if (me && me.dead) {
      camera.position.set(me.x, me.y + 4, me.z + 3);
      camera.lookAt(me.x, me.y, me.z);
    }
    syncPlayers(latestState.players);
    updateHud(latestState);
  }
  renderer.render(scene, camera);
}
animate();

// Prevent pinch-zoom / scroll
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.body.addEventListener('touchmove', (e) => {
  if (inGame) e.preventDefault();
}, { passive: false });

// Debug hook for automated control tests (read-only use)
window.__df = { camera, input, me: () => latestState?.players.find((p) => p.id === myId), state: () => latestState };
