// ---------------------------------------------------------------------------
// Fire of the Blaze - a top-down arena shooter where live Blaze chat/follow/sub/vote
// events are the game master. See README.md for how the Blaze API wires in.
// ---------------------------------------------------------------------------

const loginScreen = document.getElementById('login-screen');
const startScreen = document.getElementById('start-screen');
const howtoScreen = document.getElementById('howto-screen');
const gameScreen = document.getElementById('game-screen');
const gameOverScreen = document.getElementById('gameover-screen');
const pauseScreen = document.getElementById('pause-screen');
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const ticker = document.getElementById('ticker');
const connectionPill = document.getElementById('connection-pill');

let me = null; // { displayName, username, avatarUrl }

async function boot() {
  const res = await fetch('/api/me');
  const data = await res.json();
  if (data.loggedIn) {
    me = data;
    showStartScreen();
  } else {
    loginScreen.classList.remove('hidden');
  }
}
boot();

function showStartScreen() {
  loginScreen.classList.add('hidden');
  document.getElementById('start-avatar').src = me.avatarUrl || '';
  document.getElementById('start-name').textContent = me.displayName || me.username;
  startScreen.classList.remove('hidden');
}
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

// On mobile, claim the full physical screen (no address bar / home-indicator
// strip) so the arena actually fills a landscape phone edge to edge.
function goFullscreenOnMobile() {
  if (!isTouchDevice) return;
  const el = document.documentElement;
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (request) {
    try {
      const result = request.call(el);
      if (result && result.catch) result.catch(() => {});
    } catch {}
  }
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').catch(() => {});
  }
}
document.addEventListener('fullscreenchange', resizeCanvas);
document.addEventListener('webkitfullscreenchange', resizeCanvas);

// The controls/chat-effects explainer is shown once, the first time a
// session presses Play - every later restart (from game over, or the pause
// menu) skips straight into a fresh run.
let hasSeenHowToPlay = false;

document.getElementById('play-btn').addEventListener('click', () => {
  if (hasSeenHowToPlay) {
    goFullscreenOnMobile();
    startGame();
    return;
  }
  startScreen.classList.add('hidden');
  howtoScreen.classList.remove('hidden');
});

document.getElementById('howto-start-btn').addEventListener('click', () => {
  hasSeenHowToPlay = true;
  howtoScreen.classList.add('hidden');
  goFullscreenOnMobile();
  startGame();
});

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

const state = {
  player: { x: 0, y: 0, r: 16, hp: 100, maxHp: 100, speed: 260, shielded: false, shieldUntil: 0, facingLeft: false, kx: 0, ky: 0, vx: 0, vy: 0, gunAngle: 0, dotUntil: 0, dotDps: 0, chillUntil: 0, chillMul: 1 },
  bullets: [],
  enemyProjectiles: [],
  enemies: [],
  allies: [],
  particles: [],
  obstacles: [],
  hazards: [],
  score: 0,
  keys: {},
  mouse: { x: 0, y: 0, down: false },
  lastShot: 0,
  running: false,
  paused: false,
  slowUntil: 0,
  spawnTimer: 0,
  walkFrame: 0,
  walkTimer: 0,
  shake: { x: 0, y: 0, t: 0 },
  hitstop: 0,
  wave: 1,
  waveTime: 0,
  waveBanner: { text: '', elapsed: 0, duration: 2.0, active: false },
  spawnPausedUntil: 0,
  weaponPickups: [],
  pickupSpawnTimer: 10,
  weapon: 'default',
  weaponUntil: 0,
  beamLine: null,
  beamCooldown: 0,
  flameCone: null,
  healthPickups: [],
  healthSchedule: [],
  shieldAbility: { cooldownUntil: 0 },
  bgTier: 1,
  bgTransition: null,
  lastMoveAngle: 0,
  joystick: { active: false, dx: 0, dy: 0 },
  speechBubbles: [],
  killStreak: 0,
};

const SHIELD_ABILITY_DURATION = 2000;
const SHIELD_ABILITY_COOLDOWN = 12000;

// Small blocky pixel-heart icon for health pickups - a different silhouette
// from the weapon diamonds so the two pickup types are distinguishable at a
// glance even before checking color.
const HEALTH_ICON = [
  '.##.##.',
  '#######',
  '#######',
  '.#####.',
  '..###..',
  '...#...',
];

// ---------------------------------------------------------------------------
// Weapons - the default gun plus ten timed pickups. Every pickup clearly
// out-DPSes or out-powers the default gun in some dimension (raw damage,
// fire rate, piercing, area, or a status effect) so grabbing one actually
// feels like a power spike, not a sidegrade.
// ---------------------------------------------------------------------------

const WEAPON_DEFS = {
  default: { color: '#F0B90B', fireRate: 160, damage: 1, mode: 'single' },
  spread: { color: '#38e8d4', fireRate: 190, damage: 1.1, mode: 'spread' },
  rapid: { color: '#ffb020', fireRate: 55, damage: 0.75, mode: 'single' },
  electric: { color: '#4dd8ff', fireRate: 0, damage: 1.2, mode: 'beam' },
  ricochet: { color: '#ff3d7f', fireRate: 200, damage: 1.4, mode: 'ricochet' },
  shotgun: { color: '#ff5a1a', fireRate: 380, damage: 1.3, mode: 'shotgun' },
  rocket: { color: '#ff1f3d', fireRate: 900, damage: 4, mode: 'rocket' },
  flamethrower: { color: '#ffcf3d', fireRate: 0, damage: 0.8, mode: 'flame' },
  // Ice bolt - modest direct damage, but chills the enemy on hit (see
  // b.freeze handling below), sapping its speed for a couple seconds so
  // its power is crowd control rather than raw DPS.
  ice: { color: '#8fe0ff', fireRate: 260, damage: 1.1, mode: 'ice' },
  // Poison dart - weak on impact but tags the enemy with a damage-over-time
  // tick (b.poison), so its power is "keeps dealing damage after you move on".
  poison: { color: '#7cff3d', fireRate: 300, damage: 0.6, mode: 'poison' },
  // Laser - a near-instant hitscan-style bolt (very high speed, short life)
  // that pierces every enemy in its path, trading fire rate for a huge
  // single-press hit against a lined-up crowd.
  laser: { color: '#ff4dff', fireRate: 480, damage: 3, mode: 'laser' },
};
const PICKUP_WEAPON_TYPES = ['spread', 'rapid', 'electric', 'ricochet', 'shotgun', 'rocket', 'flamethrower', 'ice', 'poison', 'laser'];
const WEAPON_DURATION_MS = 15000;

const WAVE_DURATION = 30;
// Hard ceiling on concurrent enemies - see the guard at the top of
// spawnEnemy(). Generous relative to normal play (typical fights run well
// under this) but stops a chat-spam burst (a pile of !spawn messages, a huge
// vote horde, chained boss waves) from growing state.enemies without bound
// and tanking the frame rate.
const MAX_ENEMIES = 60;

function currentSpawnInterval() {
  let base = Math.max(0.7, 2.2 - (state.wave - 1) * 0.12);
  // From wave 10, enemies also arrive noticeably faster on top of the
  // existing per-wave creep - part of the harder late-game curve.
  if (state.wave >= 10) base = Math.max(0.45, base - 0.35 - (state.wave - 10) * 0.01);
  // Danger waves trade crowd size for individual toughness - fewer enemies
  // incoming overall, so it reads as "one bad enemy" rather than a mob.
  return isDangerWave(state.wave) ? base + 0.6 : base;
}

function spawnWaveBossPack() {
  const bossCount = Math.random() < 0.5 ? 1 : 2;
  for (let i = 0; i < bossCount; i++) spawnEnemy(true);
  for (let i = 0; i < 3; i++) spawnEnemy();
  triggerShake(10);
}

function advanceWave() {
  state.wave += 1;
  state.waveTime = 0;
  const danger = isDangerWave(state.wave);
  state.waveBanner = {
    text: danger ? `DANGER - WAVE ${state.wave}` : `WAVE ${state.wave}`,
    elapsed: 0,
    duration: 2.0,
    active: true,
    danger,
  };
  state.spawnPausedUntil = performance.now() + 2000;
  if (state.wave % 5 === 0) spawnWaveBossPack();
  scheduleHealthPickups();
  checkBackgroundTier();
  updateHud();
}

// A new visual tier every 4 waves (tier 4 repeats for all later waves).
// Starts a cross-fade rather than snapping the palette instantly.
function checkBackgroundTier() {
  const target = Math.min(BACKGROUND_TIERS.length, Math.ceil(state.wave / 4));
  if (target !== state.bgTier) {
    state.bgTransition = { from: state.bgTier, to: target, elapsed: 0, duration: 2.0 };
    state.bgTier = target;
  }
}

// Two health pickups per wave, one dropped somewhere in the first half of
// the 30s wave and one somewhere in the second half.
function scheduleHealthPickups() {
  state.healthSchedule = [
    { time: Math.random() * (WAVE_DURATION / 2), spawned: false },
    { time: WAVE_DURATION / 2 + Math.random() * (WAVE_DURATION / 2), spawned: false },
  ];
}

function spawnHealthPickup() {
  let x, y, attempts = 0;
  do {
    x = 60 + Math.random() * (canvas.width - 120);
    y = 100 + Math.random() * (canvas.height - 200);
    attempts++;
  } while (insideObstacle(x, y) && attempts < 20);
  state.healthPickups.push({ x, y, expiresAt: performance.now() + 25000 });
}

function waveBannerAlpha() {
  const b = state.waveBanner;
  if (!b.active) return 0;
  const fade = 0.4;
  if (b.elapsed < fade) return b.elapsed / fade;
  if (b.elapsed > b.duration - fade) return Math.max(0, (b.duration - b.elapsed) / fade);
  return 1;
}

function triggerShake(amount) {
  state.shake.t = Math.max(state.shake.t, amount);
}

function triggerHitstop(ms) {
  state.hitstop = Math.max(state.hitstop, ms);
  console.log('[hitstop] triggered', ms, 'ms (total now', state.hitstop.toFixed(0) + 'ms)');
}

function resetState() {
  state.paused = false;
  pauseScreen.classList.add('hidden');
  document.getElementById('pause-btn').innerHTML = '&#9208;';
  // Make sure no leftover dialogue from a previous run bleeds into this one.
  GameAudio.stopAllVoiceLines();
  state.player = { x: canvas.width / 2, y: canvas.height / 2, r: 16, hp: 100, maxHp: 100, speed: 260, shielded: false, shieldUntil: 0, facingLeft: false, kx: 0, ky: 0, vx: 0, vy: 0, gunAngle: 0, dotUntil: 0, dotDps: 0, chillUntil: 0, chillMul: 1 };
  state.bullets = [];
  state.enemyProjectiles = [];
  state.enemies = [];
  state.allies = [];
  state.particles = [];
  state.hazards = [];
  state.score = 0;
  state.spawnTimer = 0;
  state.slowUntil = 0;
  state.walkFrame = 0;
  state.walkTimer = 0;
  state.shake = { x: 0, y: 0, t: 0 };
  state.hitstop = 0;
  state.wave = 1;
  state.waveTime = 0;
  state.waveBanner = { text: '', elapsed: 0, duration: 2.0, active: false };
  state.spawnPausedUntil = 0;
  state.weaponPickups = [];
  state.pickupSpawnTimer = 12 + Math.random() * 6;
  state.weapon = 'default';
  state.weaponUntil = 0;
  state.beamLine = null;
  state.beamCooldown = 0;
  state.flameCone = null;
  state.healthPickups = [];
  scheduleHealthPickups();
  state.shieldAbility = { cooldownUntil: 0 };
  state.bgTier = 1;
  state.bgTransition = null;
  state.lastMoveAngle = 0;
  state.joystick = { active: false, dx: 0, dy: 0 };
  state.speechBubbles = [];
  state.killStreak = 0;
  lastLineIndex = {};
  lastSpeechBubbleAt = 0;
  seedObstacles();
  updateHud();
}

function startGame() {
  loginScreen.classList.add('hidden');
  startScreen.classList.add('hidden');
  gameOverScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  GameAudio.resume();
  GameAudio.preloadVoiceLines(allDialogueAudioUrls());

  document.getElementById('avatar').src = me.avatarUrl || '';
  document.getElementById('display-name').textContent = me.displayName || me.username;

  resizeCanvas();
  resetState();
  connectBlazeSocket();
  state.running = true;
  requestAnimationFrame(loop);
}

function togglePause() {
  if (!state.running) return;
  state.paused = !state.paused;
  document.getElementById('pause-btn').innerHTML = state.paused ? '&#9654;' : '&#9208;';
  if (state.paused) {
    state.mouse.down = false;
    GameAudio.stopBeamHum();
    GameAudio.stopFlameHiss();
    pauseScreen.classList.remove('hidden');
  } else {
    pauseScreen.classList.add('hidden');
  }
}

function quitToMenu() {
  state.running = false;
  state.paused = false;
  GameAudio.stopBeamHum();
  GameAudio.stopFlameHiss();
  GameAudio.stopAllVoiceLines();
  // Nothing is watching the arena anymore - drop the live Blaze connection
  // instead of leaving chat events free to keep mutating hidden game state
  // (and an idle Blaze events subscription alive) until the player starts a
  // new game and connectBlazeSocket() silently replaces it.
  if (blazeSocket) {
    blazeSocket.disconnect();
    blazeSocket = null;
  }
  pauseScreen.classList.add('hidden');
  gameScreen.classList.add('hidden');
  showStartScreen();
}

document.getElementById('pause-btn').addEventListener('click', togglePause);
document.getElementById('resume-btn').addEventListener('click', togglePause);
document.getElementById('quit-btn').addEventListener('click', quitToMenu);
// resetState() (called at the top of startGame()) already unpauses and
// hides the pause overlay, so restarting from the pause menu is just
// startGame() - identical to the "Run it back" button on the game-over screen.
document.getElementById('pause-restart-btn').addEventListener('click', startGame);
document.getElementById('pause-mute-btn').addEventListener('click', () => updateMuteButtons(GameAudio.toggleMute()));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key.toLowerCase() === 'p') togglePause();
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => (state.keys[e.key.toLowerCase()] = true));
window.addEventListener('keyup', (e) => (state.keys[e.key.toLowerCase()] = false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift' && !e.repeat) tryActivateShieldAbility();
});
canvas.addEventListener('mousemove', (e) => {
  state.mouse.x = e.clientX;
  state.mouse.y = e.clientY;
});
canvas.addEventListener('mousedown', () => (state.mouse.down = true));
window.addEventListener('mouseup', () => (state.mouse.down = false));

// Mobile: D-pad buttons just toggle the same state.keys flags WASD does,
// and the shoot button toggles the same state.mouse.down flag the mouse
// does - both reuse all the existing movement/firing logic untouched.
function bindHoldButton(el, onStart, onEnd) {
  const start = (e) => { e.preventDefault(); onStart(); el.classList.add('active'); };
  const end = (e) => { e.preventDefault(); onEnd(); el.classList.remove('active'); };
  el.addEventListener('touchstart', start, { passive: false });
  el.addEventListener('touchend', end, { passive: false });
  el.addEventListener('touchcancel', end, { passive: false });
}

// Draggable virtual joystick for movement - smooth 360-degree analog input
// (partial tilt = partial speed) instead of the 8-way snap of a D-pad.
// Tracks a specific touch identifier so it doesn't get confused by the
// shoot/shield buttons being pressed with another finger at the same time.
function setupJoystick() {
  const base = document.getElementById('joystick-base');
  const knob = document.getElementById('joystick-knob');
  let maxRadius = 45;
  let touchId = null;
  let originX = 0, originY = 0;

  function updateKnob(clientX, clientY) {
    let dx = clientX - originX;
    let dy = clientY - originY;
    const d = Math.hypot(dx, dy);
    if (d > maxRadius) {
      dx = (dx / d) * maxRadius;
      dy = (dy / d) * maxRadius;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    state.joystick.active = true;
    state.joystick.dx = dx / maxRadius;
    state.joystick.dy = dy / maxRadius;
  }

  function resetKnob() {
    knob.style.transform = 'translate(0px, 0px)';
    knob.classList.remove('active');
    state.joystick.active = false;
    state.joystick.dx = 0;
    state.joystick.dy = 0;
    touchId = null;
  }

  base.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    touchId = touch.identifier;
    const rect = base.getBoundingClientRect();
    originX = rect.left + rect.width / 2;
    originY = rect.top + rect.height / 2;
    maxRadius = rect.width / 2 - 6;
    knob.classList.add('active');
    updateKnob(touch.clientX, touch.clientY);
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (touchId === null) return;
    for (const touch of e.changedTouches) {
      if (touch.identifier === touchId) {
        e.preventDefault();
        updateKnob(touch.clientX, touch.clientY);
      }
    }
  }, { passive: false });

  function endTouch(e) {
    for (const touch of e.changedTouches) {
      if (touch.identifier === touchId) resetKnob();
    }
  }
  window.addEventListener('touchend', endTouch);
  window.addEventListener('touchcancel', endTouch);
}

function setupMobileControls() {
  if (!isTouchDevice) return;
  document.getElementById('mobile-controls').classList.remove('hidden');
  setupJoystick();
  bindHoldButton(document.getElementById('shoot-btn'), () => (state.mouse.down = true), () => (state.mouse.down = false));

  const shieldBtn = document.getElementById('shield-btn');
  shieldBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    tryActivateShieldAbility();
  }, { passive: false });
}
setupMobileControls();

// ---------------------------------------------------------------------------
// Blaze live socket - relayed through our own server (see server.js)
// ---------------------------------------------------------------------------

let blazeSocket = null;

function connectBlazeSocket() {
  if (blazeSocket) blazeSocket.disconnect();
  const socket = (blazeSocket = io());

  socket.on('blaze:ready', () => {
    connectionPill.textContent = 'live · connected to Blaze chat';
    connectionPill.classList.add('live');
  });

  socket.on('blaze:error', (msg) => {
    connectionPill.textContent = msg;
  });

  socket.on('blaze:event', ({ type, payload }) => {
    handleBlazeEvent(type, payload);
  });
}

function handleBlazeEvent(type, payload) {
  switch (type) {
    case 'channel.chat.message': {
      const text = (payload.message || '').trim().toLowerCase();
      const name = payload.sender?.displayName || 'viewer';
      if (text.startsWith('!spawn')) {
        spawnEnemy();
        pushTicker(name, 'threw in another enemy', true);
      } else if (text.startsWith('!heal')) {
        state.player.hp = Math.min(state.player.maxHp, state.player.hp + 20);
        pushTicker(name, 'healed you +20 HP', true);
        updateHud();
      } else if (text.startsWith('!shield')) {
        applyShield(3000);
        pushTicker(name, 'granted 3s shield', true);
      } else if (text.startsWith('!slow')) {
        state.slowUntil = performance.now() + 5000;
        pushTicker(name, 'slowed every enemy', true);
      } else if (text.startsWith('!testtip')) {
        // TEST-ONLY DEBUG SHORTCUT: simulates a channel.thanks (tip) event
        // locally, since real on-chain tips are hard to trigger on demand
        // while developing. Consider removing this chat command before a
        // real public launch so viewers can't fake tip tiers for free.
        const amount = Number(text.split(' ')[1]) || 25;
        handleTip(name, amount);
      } else {
        pushTicker(name, payload.message);
      }
      break;
    }
    case 'channel.thanks': {
      const name = payload.sender?.displayName || 'a viewer';
      const amount = Number(payload.amount) || 0;
      handleTip(name, amount);
      break;
    }
    case 'channel.follow': {
      const name = payload.follower?.displayName || 'a new viewer';
      spawnAlly();
      pushTicker(name, 'followed - ally deployed!', true);
      break;
    }
    case 'channel.subscribe': {
      const name = payload.subscriber?.displayName || 'a viewer';
      triggerBossWave();
      pushTicker(name, 'subscribed - boss wave incoming!', true);
      break;
    }
    case 'channel.subscription.gift': {
      const name = payload.sender?.displayName || 'a viewer';
      triggerBossWave();
      pushTicker(name, `gifted ${payload.giftCount || ''} subs - boss wave!`, true);
      break;
    }
    case 'channel.vote': {
      const name = payload.voter?.displayName || 'a viewer';
      const amount = payload.amount || 1;
      const count = Math.min(12, Math.max(1, Math.round(amount / 5)));
      for (let i = 0; i < count; i++) spawnEnemy();
      triggerShake(6 + count);
      pushTicker(name, `voted ${amount} - horde of ${count} summoned`, true);
      break;
    }
  }
}

// Tip tiers - Blaze's channel.thanks docs don't specify a currency/unit for
// `amount` (their own example payload just uses "100"), so these thresholds
// are a starting guess: small < 50, medium 50-199, large 200+. Adjust once
// you know what a typical real tip amount looks like on your channel.
const TIP_TIER_MEDIUM = 50;
const TIP_TIER_LARGE = 200;

function handleTip(name, amount) {
  if (amount >= TIP_TIER_LARGE) {
    triggerBossWave();
    state.waveBanner = { text: `MEGA TIP - ${name}!`, elapsed: 0, duration: 2.6, active: true };
    pushTicker(name, `tipped ${amount} - MEGA TIP! Boss wave!`, true);
  } else if (amount >= TIP_TIER_MEDIUM) {
    state.weapon = 'electric';
    state.weaponUntil = performance.now() + WEAPON_DURATION_MS;
    pushTicker(name, `tipped ${amount} - electric gun unlocked for 15s!`, true);
  } else {
    spawnEnemy(false, 'loot');
    pushTicker(name, `tipped ${amount} - bonus loot enemy incoming!`, true);
  }
}

function pushTicker(name, text, isEffect = false) {
  const el = document.createElement('span');
  el.className = 'ticker-item' + (isEffect ? ' effect' : '');
  el.innerHTML = `<b>${escapeHtml(name)}</b> ${escapeHtml(text || '')}`;
  ticker.prepend(el);
  while (ticker.children.length > 20) ticker.removeChild(ticker.lastChild);
  setTimeout(() => el.remove(), 9000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Entity spawning
// ---------------------------------------------------------------------------

// Enemy types are introduced gradually as waves progress, so the mix of
// threats grows alongside difficulty rather than dumping everything at once.
function pickEnemyType() {
  const pool = ['chaser', 'grunt'];
  if (state.wave >= 3) pool.push('swarmer');
  if (state.wave >= 4) pool.push('archer');
  if (state.wave >= 5) pool.push('sniper');
  if (state.wave >= 6) pool.push('brute', 'frost');
  if (state.wave >= 7) pool.push('toxic');
  if (state.wave >= 8) pool.push('dasher', 'stormcaller');
  if (state.wave >= 9) pool.push('acid');
  // From here on, the elemental "elites" keep joining the pool every wave -
  // this is what makes the game noticeably harder starting around wave 10,
  // on top of the raw hp/speed ramp in hardModeMultiplier().
  if (state.wave >= 10) pool.push('pyro');
  if (state.wave >= 11) pool.push('bomber');
  if (state.wave >= 12) pool.push('frostguard');
  if (state.wave >= 13) pool.push('plague');
  if (state.wave >= 14) pool.push('inferno');
  return pool[Math.floor(Math.random() * pool.length)];
}

// Every 3rd wave (skipping boss waves, which are already a spike) is a
// "danger wave" - fewer enemies come in (see currentSpawnInterval) but the
// ones that do are tougher, so the threat feels concentrated rather than
// just a bigger crowd. From wave 10 onward danger waves come around twice as
// often (every other wave) as part of the harder late-game curve.
function isDangerWave(wave) {
  if (wave % 5 === 0) return false;
  return wave >= 10 ? wave % 2 === 0 : wave % 3 === 0;
}

// From wave 10 the whole enemy roster (not just the elemental elites joining
// the pool) gets tankier and faster on top of the normal per-wave creep, so
// the game keeps escalating deep into a run instead of plateauing once every
// enemy type has unlocked.
function hardModeMultiplier(wave) {
  // Capped at 3x so this flattens out (~wave 31) instead of climbing forever
  // - weapon damage doesn't scale with wave, so an uncapped multiplier would
  // eventually make late waves mathematically unkillable, not just harder.
  return wave >= 10 ? Math.min(3, 1 + (wave - 9) * 0.09) : 1;
}

const ENEMY_ARCHETYPES = {
  chaser: { r: 14, hp: 2, speedRange: [90, 130], color: '#e94f6b', score: 10 },
  sniper: { r: 14, hp: 2, speedRange: [70, 90], color: '#8b5cf6', score: 20 },
  dasher: { r: 13, hp: 2, speedRange: [55, 70], color: '#ff8a3d', score: 20 },
  swarmer: { r: 8, hp: 1, speedRange: [150, 180], color: '#2dd4a8', score: 8 },
  boss: { r: 30, hp: 12, speedRange: [70, 70], color: '#ff3d7f', score: 50 },
  // Loot enemy - spawned only by small tips (never in the normal random pool),
  // one-hit-kill with a big score payout so grabbing it feels like a reward.
  loot: { r: 14, hp: 1, speedRange: [70, 100], color: '#fff6c8', score: 75 },
  // Grunt - weak fodder available from wave 1, dies in one hit like loot but
  // worth little score; gives the player easy, satisfying kills to mix in
  // with tougher enemies rather than every enemy being a real threat.
  grunt: { r: 12, hp: 1, speedRange: [70, 100], color: '#8a8f9a', score: 6 },
  // Brute - tanky, slow, and armed with the hardest-hitting ranged attack of
  // the original roster.
  brute: { r: 20, hp: 5, speedRange: [40, 55], color: '#8a0e0e', score: 35 },

  // ---- Elemental elites (see ELITE_ATTACK below for their weapons) --------
  // Six "light" elites: fast to kill individually but hit hard and fast.
  archer: { r: 13, hp: 3, speedRange: [85, 105], color: '#c8a25a', score: 22 },
  frost: { r: 14, hp: 4, speedRange: [70, 90], color: '#8fe0ff', score: 25 },
  toxic: { r: 14, hp: 4, speedRange: [65, 85], color: '#7cff3d', score: 25 },
  stormcaller: { r: 14, hp: 5, speedRange: [70, 90], color: '#4dd8ff', score: 28 },
  acid: { r: 14, hp: 4, speedRange: [70, 90], color: '#b6ff3d', score: 25 },
  pyro: { r: 15, hp: 5, speedRange: [70, 90], color: '#ff6a1a', score: 27 },
  // Four "heavy" elites: genuinely hard to kill (high hp, slow), lobbing
  // splash-damage grenades instead of single-target bolts.
  bomber: { r: 20, hp: 7, speedRange: [45, 55], color: '#ffb020', score: 36 },
  frostguard: { r: 22, hp: 9, speedRange: [35, 45], color: '#5fc4ff', score: 42 },
  plague: { r: 21, hp: 8, speedRange: [40, 50], color: '#4fdb3d', score: 40 },
  inferno: { r: 22, hp: 9, speedRange: [35, 45], color: '#ff3d1a', score: 46 },
};

// The set of enemy types rendered with the bulkier ELITE_HEAVY sprite and a
// larger on-screen size (see the `size` lookup in render()).
const HEAVY_ELITE_TYPES = new Set(['bomber', 'frostguard', 'plague', 'inferno']);

// Attack config for every elemental elite - one shared kiting-AI branch in
// the enemy update loop reads this table instead of hand-writing 10 nearly
// identical movement/attack blocks. `kind: 'bolt'` fires a straight shot that
// resolves on direct hit; `kind: 'grenade'` lobs a slower shot that detonates
// in a `splash` radius around the player when its short life runs out (it
// doesn't need to land a direct hit). `status: 'dot'` burns/poisons the
// player for `statusDps` over `statusDur` ms; `status: 'chill'` saps the
// player's top speed to `slowMul` for `statusDur` ms. `hazard: true` leaves
// a damaging ground zone at the impact point (see state.hazards).
const ELITE_ATTACK = {
  archer: { tanky: false, projSpeed: 480, projR: 4, cooldown: [0.9, 1.2], damage: 12, kind: 'bolt', color: '#c8a25a' },
  frost: { tanky: false, projSpeed: 260, projR: 6, cooldown: [1.8, 2.2], damage: 10, kind: 'bolt', color: '#8fe0ff', status: 'chill', statusDur: 2200, slowMul: 0.45 },
  toxic: { tanky: false, projSpeed: 220, projR: 7, cooldown: [2.2, 2.6], damage: 8, kind: 'bolt', color: '#7cff3d', status: 'dot', statusDur: 4000, statusDps: 3, hazard: true, hazardR: 55, hazardDur: 4000, life: 1.6 },
  stormcaller: { tanky: false, projSpeed: 300, projR: 6, cooldown: [2.0, 2.4], damage: 15, kind: 'bolt', color: '#4dd8ff', homing: 0.08 },
  acid: { tanky: false, projSpeed: 210, projR: 7, cooldown: [2.2, 2.6], damage: 10, kind: 'bolt', color: '#b6ff3d', hazard: true, hazardR: 65, hazardDur: 5000, life: 1.6 },
  pyro: { tanky: false, projSpeed: 230, projR: 7, cooldown: [2.0, 2.4], damage: 13, kind: 'bolt', color: '#ff6a1a', status: 'dot', statusDur: 3000, statusDps: 4 },
  bomber: { tanky: true, projSpeed: 130, projR: 8, cooldown: [2.6, 3.0], damage: 18, kind: 'grenade', color: '#ffb020', splash: 100 },
  frostguard: { tanky: true, projSpeed: 160, projR: 9, cooldown: [2.8, 3.2], damage: 16, kind: 'grenade', color: '#5fc4ff', splash: 90, status: 'chill', statusDur: 3200, slowMul: 0.35 },
  plague: { tanky: true, projSpeed: 150, projR: 9, cooldown: [3.0, 3.4], damage: 12, kind: 'grenade', color: '#4fdb3d', splash: 100, status: 'dot', statusDur: 5000, statusDps: 4, hazard: true, hazardR: 90, hazardDur: 6000 },
  inferno: { tanky: true, projSpeed: 150, projR: 9, cooldown: [2.6, 3.0], damage: 20, kind: 'grenade', color: '#ff3d1a', splash: 100, status: 'dot', statusDur: 4000, statusDps: 5 },
};

// ---------------------------------------------------------------------------
// Combat dialogue - short speech bubbles above enemies and the player.
// Enemy lines fire once on spawn and once on death; player lines fire on
// kills (occasionally), kill-streak milestones, and taking damage.
// ---------------------------------------------------------------------------

const DIALOGUE = {
  chaser: {
    aggro: ["You're already dead!", 'Rip him apart!', 'No escape this time!', 'Feel this!', 'Crush him now!'],
    death: ["This isn't over!", 'You got lucky!', "I'll be back for you!", 'Damn you!', 'Not like this!'],
  },
  sniper: {
    aggro: ['You\'re in my sights.', "One shot, that's all I need.", 'Run if you can.', 'I never miss.', 'Say goodbye.'],
    death: ['Impossible...', 'How did you find me?!', "This can't be happening!", "You'll regret this!", 'Damn my aim!'],
  },
  dasher: {
    aggro: ["You can't outrun me!", "I'll tear through you!", 'Too late to run!', 'Here I come, fast and furious!', "You won't see it coming!"],
    death: ['Too fast for my own good!', "This isn't the end!", "You'll pay for this!", 'Argh! Not now!', 'I almost had you!'],
  },
  swarmer: {
    aggro: ['Overwhelm him!', "We're endless!", "You can't fight us all!", 'Attack together!', 'Bring him down!'],
    death: ["There's more of us!", "You'll never survive this!", "We'll swarm you again!", 'Argh!', 'Not the last of us!'],
  },
  boss: {
    aggro: ['You dare challenge me?!', 'Prepare to be destroyed!', "I'll end you myself!", 'This is my domain!', 'You have no chance!'],
    death: ['Impossible! I am unstoppable!', "This isn't over, hero!", "You'll face my wrath again!", 'Curse you!', "I'll return stronger!"],
  },
  grunt: {
    aggro: ['I got this!', 'Charge!', "You're finished!", 'Get him!', 'For the swarm!'],
    death: ['Oof.', 'That hurt...', 'Not fair!', 'Ugh, really?', "Guess I'm done."],
  },
  brute: {
    aggro: ['Take this.', 'Nowhere to hide.', 'Feel my power.', "You're outgunned.", 'This ends fast.'],
    death: ['Not... possible...', 'I had more in me!', 'This weapon... failed me.', 'Ugh! Lucky shot!', "You'll need more than that."],
  },
  archer: {
    aggro: ["Nowhere to hide from my arrows!", 'Steady aim, steady kill.', "Let it fly!"],
    death: ['Bad... shot...', "My quiver's empty anyway.", 'Missed my mark...'],
  },
  frost: {
    aggro: ['Feel the freeze!', 'Cold enough for you?', "You'll slow down soon."],
    death: ["I'm... melting...", 'So cold...', 'Frozen out.'],
  },
  toxic: {
    aggro: ['Breathe this in.', 'Poison for everyone!', "You're already infected."],
    death: ['Toxic to the end...', 'Ugh... poisoned myself...', 'The spores... win...'],
  },
  stormcaller: {
    aggro: ['Feel the storm!', 'Lightning strikes twice.', 'Static in the air...'],
    death: ['Short circuit...', 'The storm fades...', "Shocking, isn't it..."],
  },
  acid: {
    aggro: ["This'll burn.", 'Dissolve where you stand.', 'Corrosion incoming!'],
    death: ['Eating through me too...', 'Acidic end...', 'Burned out...'],
  },
  pyro: {
    aggro: ['Burn, baby, burn!', 'Feel the heat!', "Light 'em up!"],
    death: ['Snuffed out...', 'My flame... dies...', 'Ashes to ashes...'],
  },
  bomber: {
    aggro: ['Fire in the hole!', 'Catch this!', 'Boom incoming!'],
    death: ['Duds happen...', 'Should\'ve ducked myself...', 'That backfired...'],
  },
  frostguard: {
    aggro: ['None shall pass.', 'The cold holds the line.', 'Stand and freeze.'],
    death: ['The wall... cracks...', 'Too cold to move...', 'Guard down...'],
  },
  plague: {
    aggro: ['Spread the sickness.', 'None escape the plague.', 'Rot take you.'],
    death: ['The plague... consumes me...', 'Sickly end...', 'Rotten luck...'],
  },
  inferno: {
    aggro: ['I am the inferno!', 'Everything burns before me.', 'Witness true fire!'],
    death: ['The inferno... dims...', 'Extinguished...', 'My fire... fades...'],
  },
};

const PLAYER_LINES = {
  general: [
    'Not today!', 'Stay down!', 'Too easy.', 'Next!', "That's what you get!",
    "Don't test me!", 'One less problem.', 'Move along!', 'Is that all?',
    'You never stood a chance.', 'Get wrecked!', 'End of the line.',
    "Should've stayed home.", 'Try harder.', 'Weak.',
  ],
  streak: [
    "I'm just getting started!", 'Someone stop me!',
    'They keep coming, I keep winning!', 'This is too easy!',
    'Unstoppable!', "You're all going down!",
  ],
  tougher: [
    'Nice try.', 'Not fast enough!', 'Missed your shot.', "Should've aimed better.",
  ],
  boss: [
    "That's how it's done!", "Domain's mine now!", 'You call that unstoppable?',
    'Nothing can stop me!', 'Game over for you!',
  ],
};

// Maps each dialogue line to its pre-generated ElevenLabs mp3 (see
// scripts/generate-voices.js), keyed by exact line text so pickLine/
// pickPlayerLine don't need to change - built once from the same DIALOGUE/
// PLAYER_LINES data the generation script reads, so filenames always match.
const ENEMY_AUDIO = {};
Object.entries(DIALOGUE).forEach(([type, moments]) => {
  ENEMY_AUDIO[type] = {};
  Object.entries(moments).forEach(([moment, lines]) => {
    ENEMY_AUDIO[type][moment] = {};
    lines.forEach((text, i) => {
      ENEMY_AUDIO[type][moment][text] = `/audio/${type}_${moment}_${i + 1}.mp3`;
    });
  });
});

const PLAYER_AUDIO = {};
Object.entries(PLAYER_LINES).forEach(([pool, lines]) => {
  PLAYER_AUDIO[pool] = {};
  lines.forEach((text, i) => {
    PLAYER_AUDIO[pool][text] = `/audio/player_${pool}_${i + 1}.mp3`;
  });
});

function allDialogueAudioUrls() {
  const urls = [];
  Object.values(ENEMY_AUDIO).forEach((moments) => {
    Object.values(moments).forEach((byText) => urls.push(...Object.values(byText)));
  });
  Object.values(PLAYER_AUDIO).forEach((byText) => urls.push(...Object.values(byText)));
  return urls;
}

const MAX_SPEECH_BUBBLES = 4;
const SPEECH_BUBBLE_STAGGER_MS = 350;
let lastSpeechBubbleAt = 0;
let lastLineIndex = {};

// Picks a random line from `pool`, avoiding an immediate repeat of the last
// line used for that same `key` (shared by both enemy DIALOGUE lookups and
// PLAYER_LINES pools so neither system repeats itself back-to-back).
function pickFromPool(pool, key) {
  if (!pool || pool.length === 0) return null;
  let idx = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && idx === lastLineIndex[key]) idx = (idx + 1) % pool.length;
  lastLineIndex[key] = idx;
  return pool[idx];
}

function pickLine(type, moment) {
  return pickFromPool(DIALOGUE[type]?.[moment], `${type}:${moment}`);
}

function pickPlayerLine(poolName) {
  return pickFromPool(PLAYER_LINES[poolName], `player:${poolName}`);
}

// entity needs x/y (read live if still around, frozen at last value once
// removed from its array - e.g. a dead enemy's bubble stays put automatically
// since nothing moves it anymore). Global-rate-limited and capped so a swarm
// wave doesn't turn into a wall of overlapping text.
function trySpawnSpeechBubble(entity, text, opts = {}) {
  if (!text) return false;
  const nowMs = performance.now();
  if (state.speechBubbles.length >= MAX_SPEECH_BUBBLES) return false;
  if (nowMs - lastSpeechBubbleAt < SPEECH_BUBBLE_STAGGER_MS) return false;
  lastSpeechBubbleAt = nowMs;

  // A bubble's font size never changes for its whole lifetime, so compute
  // the fit once here rather than every render() frame - fitBubbleFont does
  // a ctx.measureText search that isn't free to repeat 60x/sec per bubble.
  const maxWidth = opts.big ? 230 : 175;
  const baseSize = opts.big ? 12 : 9;
  const minSize = opts.big ? 8 : 6;
  const { fontSize, fontFamily } = fitBubbleFont(ctx, text, maxWidth, baseSize, minSize);

  state.speechBubbles.push({
    follow: entity,
    text,
    age: 0,
    duration: opts.duration || 1.8,
    big: !!opts.big,
    borderColor: opts.borderColor || '#2c303a',
    isPlayer: !!opts.isPlayer,
    fontSize,
    fontFamily,
  });

  // Every character speaks its line via a pre-generated ElevenLabs audio file.
  // Boss/player lines are high priority (always play, can exceed the
  // concurrency cap); regular enemy lines are the first dropped under load.
  const audioUrl = opts.isPlayer
    ? PLAYER_AUDIO[opts.playerPool]?.[text]
    : ENEMY_AUDIO[opts.enemyType]?.[opts.moment]?.[text];
  GameAudio.playVoiceLine(audioUrl, opts.isPlayer || opts.big);

  return true;
}

// Player lines never overlap - if one's already showing, skip this trigger
// rather than queueing it, so it can't pile up. Gold border distinguishes
// player chatter from enemy (gray) and boss (magenta) bubbles.
function tryPlayerLine(poolName, duration = 1.8) {
  if (state.speechBubbles.some((b) => b.isPlayer)) return false;
  const text = pickPlayerLine(poolName);
  if (!text) return false;
  return trySpawnSpeechBubble(state.player, text, { duration, isPlayer: true, borderColor: '#F0B90B', playerPool: poolName });
}

function onPlayerDamaged() {
  state.killStreak = 0;
  GameAudio.playPlayerHit();
}

function spawnEnemy(boss = false, forcedType = null) {
  // Every spawn path (passive timer, chat commands, votes, boss packs,
  // swarmer clusters) funnels through this one function, so gating here is
  // enough to enforce MAX_ENEMIES everywhere at once.
  if (state.enemies.length >= MAX_ENEMIES) return;

  const edge = Math.floor(Math.random() * 4);
  let x, y;
  if (edge === 0) { x = -30; y = Math.random() * canvas.height; }
  else if (edge === 1) { x = canvas.width + 30; y = Math.random() * canvas.height; }
  else if (edge === 2) { x = Math.random() * canvas.width; y = -30; }
  else { x = Math.random() * canvas.width; y = canvas.height + 30; }

  const type = boss ? 'boss' : (forcedType || pickEnemyType());
  const def = ENEMY_ARCHETYPES[type];
  // Capped so a long run doesn't eventually make every enemy literally
  // faster than the player can react to - growth flattens out around wave 21.
  const waveSpeedMul = Math.min(1.8, 1 + (state.wave - 1) * 0.04);
  // Danger waves buff regular wave enemies (not bosses, and not tip-reward
  // loot enemies) so the fewer spawns that do come in hit noticeably harder.
  const dangerBuffed = !boss && type !== 'loot' && isDangerWave(state.wave);
  // The wave-10+ hard-mode ramp applies to everything except loot (loot is a
  // tip reward and should stay a guaranteed one-hit kill).
  const hardMul = type === 'loot' ? 1 : hardModeMultiplier(state.wave);
  const hpMul = (dangerBuffed ? 1.6 : 1) * hardMul;
  const speedBuffMul = (dangerBuffed ? 1.15 : 1) * Math.min(1.3, hardMul);
  const speed = (def.speedRange[0] + Math.random() * (def.speedRange[1] - def.speedRange[0])) * waveSpeedMul * speedBuffMul;

  state.enemies.push({
    x, y,
    type,
    r: def.r,
    hp: Math.round(def.hp * hpMul),
    speed,
    boss,
    dangerBuffed,
    color: def.color,
    score: def.score,
    facingLeft: false,
    bobSeed: Math.random() * Math.PI * 2,
    hitFlash: 0,
    kx: 0,
    ky: 0,
    // sniper / brute
    strafeDir: Math.random() < 0.5 ? 1 : -1,
    fireCooldown: 1 + Math.random(),
    // dasher
    dashMode: 'wander',
    dashTimer: 1.5 + Math.random() * 1.5,
    dashAngle: 0,
    wanderAngle: Math.random() * Math.PI * 2,
    wanderTimer: 0,
  });
  const spawned = state.enemies[state.enemies.length - 1];
  trySpawnSpeechBubble(spawned, pickLine(type, 'aggro'), { big: boss, borderColor: boss ? '#ff3d7f' : '#2c303a', duration: boss ? 2.5 : 1.8, enemyType: type, moment: 'aggro' });
}

// Swarmers arrive in a cluster of 3-4 from the same edge point, not as
// lone spawns - that's what makes them read as a "swarm".
function spawnSwarmerCluster() {
  const edge = Math.floor(Math.random() * 4);
  let baseX, baseY;
  if (edge === 0) { baseX = -30; baseY = Math.random() * canvas.height; }
  else if (edge === 1) { baseX = canvas.width + 30; baseY = Math.random() * canvas.height; }
  else if (edge === 2) { baseX = Math.random() * canvas.width; baseY = -30; }
  else { baseX = Math.random() * canvas.width; baseY = canvas.height + 30; }

  const count = 3 + Math.floor(Math.random() * 2);
  for (let i = 0; i < count; i++) {
    const before = state.enemies.length;
    spawnEnemy(false, 'swarmer');
    // spawnEnemy() no-ops once MAX_ENEMIES is hit - bail rather than
    // reposition whatever unrelated enemy happens to be last in the array.
    if (state.enemies.length === before) break;
    const e = state.enemies[state.enemies.length - 1];
    e.x = baseX + (Math.random() - 0.5) * 40;
    e.y = baseY + (Math.random() - 0.5) * 40;
  }
}

function triggerBossWave() {
  spawnEnemy(true);
  for (let i = 0; i < 3; i++) spawnEnemy();
  triggerShake(10);
}

function spawnAlly() {
  const angle = Math.random() * Math.PI * 2;
  state.allies.push({
    x: state.player.x + Math.cos(angle) * 60,
    y: state.player.y + Math.sin(angle) * 60,
    r: 10,
    expiresAt: performance.now() + 10000,
    cooldown: 0,
    bobSeed: Math.random() * Math.PI * 2,
  });
}

// Diamond-shaped weapon pickups, capped and time-limited so an ignored
// pickup doesn't sit around forever and the array can't grow unbounded.
function spawnWeaponPickup() {
  if (state.weaponPickups.length >= 3) return;
  const type = PICKUP_WEAPON_TYPES[Math.floor(Math.random() * PICKUP_WEAPON_TYPES.length)];
  let x, y, attempts = 0;
  do {
    x = 60 + Math.random() * (canvas.width - 120);
    y = 100 + Math.random() * (canvas.height - 200);
    attempts++;
  } while (insideObstacle(x, y) && attempts < 20);
  state.weaponPickups.push({ x, y, type, expiresAt: performance.now() + 25000 });
}

// Electric weapon: a continuous beam instead of discrete bullets. Finds the
// nearest enemy the aim ray is actually pointing at (within a narrow
// perpendicular tolerance) and ticks damage into it while held.
function updateElectricBeam(dt) {
  const p = state.player;
  state.beamLine = null;
  if (!state.mouse.down) {
    GameAudio.stopBeamHum();
    return;
  }
  GameAudio.startBeamHum();

  const angle = getAimAngle();
  const maxRange = 480;
  let best = null;
  let bestDist = maxRange;
  state.enemies.forEach((e) => {
    if (e.hp <= 0) return;
    const dx = e.x - p.x, dy = e.y - p.y;
    const along = dx * Math.cos(angle) + dy * Math.sin(angle);
    if (along < 0 || along > maxRange) return;
    const perpX = dx - Math.cos(angle) * along;
    const perpY = dy - Math.sin(angle) * along;
    if (Math.hypot(perpX, perpY) < e.r + 10 && along < bestDist) {
      bestDist = along;
      best = e;
    }
  });

  const reach = best ? bestDist : maxRange;
  state.beamLine = {
    x1: p.x, y1: p.y,
    x2: p.x + Math.cos(angle) * reach,
    y2: p.y + Math.sin(angle) * reach,
    hit: !!best,
  };

  if (best) {
    state.beamCooldown -= dt;
    if (state.beamCooldown <= 0) {
      state.beamCooldown = 0.06;
      best.hp -= WEAPON_DEFS.electric.damage;
      best.hitFlash = 1;
      spawnParticles(best.x, best.y, '#4dd8ff');
      if (best.hp <= 0) {
        triggerShake(best.boss ? 8 : 2);
        triggerHitstop(60);
      }
    }
  }
}

// Flamethrower: a continuous cone (not a single-target line like the
// electric beam) that ticks damage into every enemy inside it at once -
// weaker per-hit than the beam, but devastating against a crowd.
function updateFlamethrower(dt) {
  const p = state.player;
  state.flameCone = null;
  if (!state.mouse.down) {
    GameAudio.stopFlameHiss();
    return;
  }
  GameAudio.startFlameHiss();

  const angle = getAimAngle();
  const range = 190;
  const halfAngle = 0.35;
  state.flameCone = { x: p.x, y: p.y, angle, range, halfAngle };

  state.beamCooldown -= dt;
  if (state.beamCooldown <= 0) {
    state.beamCooldown = 0.08;
    state.enemies.forEach((e) => {
      if (e.hp <= 0) return;
      const dx = e.x - p.x, dy = e.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > range + e.r) return;
      const angTo = Math.atan2(dy, dx);
      let diff = Math.abs(angTo - angle);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      if (diff > halfAngle) return;
      e.hp -= WEAPON_DEFS.flamethrower.damage;
      e.hitFlash = 1;
      spawnParticles(e.x, e.y, '#ff9d3d');
      applyKnockback(e, angTo, 20);
      if (e.hp <= 0) {
        triggerShake(e.boss ? 8 : 2);
        triggerHitstop(60);
      }
    });
  }
}

// Rocket splash damage - hits every enemy within radius of the impact,
// separate from (and in addition to) the direct hit already applied to
// whichever enemy the rocket collided with.
function explodeAt(x, y, radius, damage) {
  spawnParticles(x, y, '#ff6a1a');
  spawnParticles(x, y, '#ffcf6a');
  triggerShake(10);
  triggerHitstop(70);
  state.enemies.forEach((e) => {
    if (e.hp <= 0) return;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < radius + e.r) {
      e.hp -= damage;
      e.hitFlash = 1;
      applyKnockback(e, Math.atan2(e.y - y, e.x - x), e.boss ? 90 : 180);
      if (e.hp <= 0) triggerShake(e.boss ? 8 : 2);
    }
  });
}

function updateWeaponHud() {
  const badge = document.getElementById('weapon-badge');
  if (state.weapon === 'default') {
    badge.classList.add('hidden');
    return;
  }
  badge.classList.remove('hidden');
  const def = WEAPON_DEFS[state.weapon];
  document.getElementById('weapon-name').textContent = state.weapon.toUpperCase();
  badge.style.borderColor = def.color;
  badge.style.color = def.color;
  const remaining = Math.max(0, state.weaponUntil - performance.now());
  document.getElementById('weapon-bar').style.width = Math.min(100, (remaining / WEAPON_DURATION_MS) * 100) + '%';
}

// Timestamp-based instead of a single setTimeout so the chat !shield command
// and the player's own shield ability can't cut each other's duration short -
// each just extends state.player.shieldUntil, and update() derives the
// visible `shielded` flag from it every frame.
function applyShield(ms) {
  const p = state.player;
  p.shieldUntil = Math.max(p.shieldUntil || 0, performance.now() + ms);
}

function tryActivateShieldAbility() {
  const now = performance.now();
  if (now < state.shieldAbility.cooldownUntil) return;
  applyShield(SHIELD_ABILITY_DURATION);
  state.shieldAbility.cooldownUntil = now + SHIELD_ABILITY_COOLDOWN;
}

function updateShieldHud() {
  const badge = document.getElementById('shield-badge');
  const shieldBtn = document.getElementById('shield-btn');
  const remaining = state.shieldAbility.cooldownUntil - performance.now();
  const ready = remaining <= 0;

  badge.textContent = ready ? 'SHIELD READY' : 'SHIELD ' + Math.ceil(remaining / 1000) + 's';
  badge.classList.toggle('ready', ready);
  badge.classList.toggle('cooldown', !ready);

  if (isTouchDevice) {
    shieldBtn.classList.toggle('ready', ready);
    shieldBtn.classList.toggle('cooldown', !ready);
  }
}

// ---------------------------------------------------------------------------
// Knockback - a lightweight impulse-and-decay physics response (no real
// physics engine needed for this).
// ---------------------------------------------------------------------------

function applyKnockback(entity, angle, force) {
  entity.kx += Math.cos(angle) * force;
  entity.ky += Math.sin(angle) * force;
}

function decayKnockback(entity, dt) {
  entity.x += entity.kx * dt;
  entity.y += entity.ky * dt;
  entity.kx *= 0.88;
  entity.ky *= 0.88;
  if (Math.abs(entity.kx) < 1) entity.kx = 0;
  if (Math.abs(entity.ky) < 1) entity.ky = 0;
}

// Turns `current` toward `target` (radians) by at most `t` of the shortest
// angular distance between them - used for steering instead of snapping.
function lerpAngle(current, target, t) {
  let diff = ((target - current + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return current + diff * Math.min(1, t);
}

// ---------------------------------------------------------------------------
// Obstacles - static cover blocks scattered around the arena. Circles
// (player/enemies) are pushed out of them; bullets die on contact.
// ---------------------------------------------------------------------------

function seedObstacles() {
  state.obstacles = [];
  let attempts = 0;
  while (state.obstacles.length < 5 && attempts < 40) {
    attempts++;
    const hw = 24 + Math.random() * 20;
    const hh = 24 + Math.random() * 20;
    const x = hw + Math.random() * (canvas.width - hw * 2);
    const y = hh + Math.random() * (canvas.height - hh * 2);
    if (Math.hypot(x - canvas.width / 2, y - canvas.height / 2) < 160) continue;
    state.obstacles.push({ x, y, hw, hh });
  }
}

function resolveObstacleCollision(entity) {
  state.obstacles.forEach((o) => {
    const closestX = Math.max(o.x - o.hw, Math.min(entity.x, o.x + o.hw));
    const closestY = Math.max(o.y - o.hh, Math.min(entity.y, o.y + o.hh));
    const dx = entity.x - closestX;
    const dy = entity.y - closestY;
    const distSq = dx * dx + dy * dy;
    if (distSq < entity.r * entity.r) {
      const d = Math.sqrt(distSq) || 0.001;
      const overlap = entity.r - d;
      entity.x += (dx / d) * overlap;
      entity.y += (dy / d) * overlap;
    }
  });
}

function insideObstacle(x, y) {
  return state.obstacles.some((o) => x > o.x - o.hw && x < o.x + o.hw && y > o.y - o.hh && y < o.y + o.hh);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let lastTime = performance.now();

function loop(now) {
  if (!state.running) return;
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (!state.paused) update(dt, now);
  render();

  requestAnimationFrame(loop);
}

function update(dt, now) {
  const p = state.player;

  // Screen shake always advances, even through a hitstop freeze, so the
  // freeze-frame still reads as a visible impact rather than a stall.
  if (state.shake.t > 0) {
    state.shake.t = Math.max(0, state.shake.t - dt * 40);
    const s = state.shake.t;
    state.shake.x = (Math.random() * 2 - 1) * s * 0.3;
    state.shake.y = (Math.random() * 2 - 1) * s * 0.3;
  } else {
    state.shake.x = 0;
    state.shake.y = 0;
  }

  // Shield visibility is derived from shieldUntil every frame (see
  // applyShield) so the chat command and the Shift ability can coexist.
  p.shielded = now < p.shieldUntil;
  updateShieldHud();

  // The run's "story clock" - wave timer, wave-transition banner, background
  // tier cross-fade, and health-pickup scheduling - keeps advancing through a
  // hitstop freeze-frame. Only the physics/AI/combat-resolution below this
  // point actually pauses, so a flurry of kills (each triggering hitstop)
  // can't silently stretch out a wave's real duration.
  state.waveTime += dt;
  if (state.waveTime >= WAVE_DURATION) {
    advanceWave();
  }
  if (state.waveBanner.active) {
    state.waveBanner.elapsed += dt;
    if (state.waveBanner.elapsed >= state.waveBanner.duration) state.waveBanner.active = false;
  }
  if (state.bgTransition) {
    state.bgTransition.elapsed += dt;
    if (state.bgTransition.elapsed >= state.bgTransition.duration) state.bgTransition = null;
  }
  state.healthSchedule.forEach((entry) => {
    if (!entry.spawned && state.waveTime >= entry.time) {
      entry.spawned = true;
      spawnHealthPickup();
    }
  });

  // Speech bubbles are a cosmetic timer, not physics, so they age out even
  // through a hitstop freeze (their matching voice line keeps playing in
  // real time regardless). A bubble whose entity has since died just stops
  // moving - nothing mutates its x/y anymore - which is exactly the
  // "freeze in place" look we want once the entity's gone.
  state.speechBubbles.forEach((b) => { b.age += dt; });
  state.speechBubbles = state.speechBubbles.filter((b) => b.age < b.duration);

  // Hitstop: freeze movement/collision/AI for a few real milliseconds on an
  // impactful hit. Input keeps being captured by the listeners above (they
  // run independently of update()); render() still runs every frame via loop().
  if (state.hitstop > 0) {
    state.hitstop -= dt * 1000;
    return;
  }

  // Elemental status effects from elite enemy attacks/hazard zones - dot
  // ticks damage over time (fire/poison), chill saps top speed (ice).
  if (p.dotUntil && now < p.dotUntil) {
    p.hp -= (p.dotDps || 0) * dt;
    updateHud();
    if (Math.random() < 0.15) spawnParticles(p.x, p.y, '#7cff3d');
    if (p.hp <= 0) return gameOver();
  }
  const chillMul = now < (p.chillUntil || 0) ? (p.chillMul || 1) : 1;

  // Movement - momentum-based: accelerate toward input direction, cap at
  // top speed, and slide to a stop via friction when there's no input.
  // Joystick gives continuous analog direction+magnitude when active; keyboard
  // falls back to a normalized unit vector (so diagonals aren't faster).
  let moveX = 0, moveY = 0;
  if (state.joystick.active) {
    moveX = state.joystick.dx;
    moveY = state.joystick.dy;
  } else {
    let dx = 0, dy = 0;
    if (state.keys['w'] || state.keys['arrowup']) dy -= 1;
    if (state.keys['s'] || state.keys['arrowdown']) dy += 1;
    if (state.keys['a'] || state.keys['arrowleft']) dx -= 1;
    if (state.keys['d'] || state.keys['arrowright']) dx += 1;
    const len = Math.hypot(dx, dy) || 1;
    moveX = dx / len;
    moveY = dy / len;
  }
  const moving = moveX !== 0 || moveY !== 0;
  if (moving) state.lastMoveAngle = Math.atan2(moveY, moveX);

  // Momentum-based movement - accelerate toward input direction, cap at top
  // speed, and slide to a stop via friction when there's no input.
  const accel = 1800;
  if (moving) {
    p.vx += moveX * accel * dt;
    p.vy += moveY * accel * dt;
  } else {
    p.vx *= 0.85;
    p.vy *= 0.85;
    if (Math.abs(p.vx) < 1) p.vx = 0;
    if (Math.abs(p.vy) < 1) p.vy = 0;
  }
  const vlen = Math.hypot(p.vx, p.vy);
  const cappedSpeed = p.speed * chillMul;
  if (vlen > cappedSpeed) {
    p.vx = (p.vx / vlen) * cappedSpeed;
    p.vy = (p.vy / vlen) * cappedSpeed;
  }

  p.x += p.vx * dt;
  p.y += p.vy * dt;
  decayKnockback(p, dt);

  // Zero the velocity component pushing into a wall so it doesn't feel sticky.
  if (p.x < p.r || p.x > canvas.width - p.r) p.vx = 0;
  if (p.y < p.r || p.y > canvas.height - p.r) p.vy = 0;
  p.x = Math.max(p.r, Math.min(canvas.width - p.r, p.x));
  p.y = Math.max(p.r, Math.min(canvas.height - p.r, p.y));
  resolveObstacleCollision(p);

  const targetGunAngle = getAimAngle();
  p.facingLeft = Math.cos(targetGunAngle) < 0;
  p.gunAngle = lerpAngle(p.gunAngle, targetGunAngle, dt * 18);

  if (moving) {
    state.walkTimer += dt;
    if (state.walkTimer > 0.15) {
      state.walkTimer = 0;
      state.walkFrame = state.walkFrame === 0 ? 1 : 0;
    }
  } else {
    state.walkFrame = 0;
  }

  // Shooting - behavior depends on the currently active weapon
  const weaponDef = WEAPON_DEFS[state.weapon];
  if (weaponDef.mode === 'beam') {
    GameAudio.stopFlameHiss();
    updateElectricBeam(dt);
    state.flameCone = null;
  } else if (weaponDef.mode === 'flame') {
    GameAudio.stopBeamHum();
    updateFlamethrower(dt);
    state.beamLine = null;
  } else {
    GameAudio.stopBeamHum();
    GameAudio.stopFlameHiss();
    state.beamLine = null;
    state.flameCone = null;
    if (state.mouse.down && now - state.lastShot > weaponDef.fireRate) {
      state.lastShot = now;
      GameAudio.playShot(state.weapon);
      const angle = getAimAngle();
      if (weaponDef.mode === 'spread') {
        [-0.18, 0, 0.18].forEach((offset) => {
          const a = angle + offset;
          state.bullets.push({
            x: p.x, y: p.y, vx: Math.cos(a) * 620, vy: Math.sin(a) * 620,
            r: 4, life: 1.2, damage: weaponDef.damage, color: weaponDef.color,
          });
        });
      } else if (weaponDef.mode === 'shotgun') {
        [-0.4, -0.2, 0, 0.2, 0.4].forEach((offset) => {
          const a = angle + offset;
          state.bullets.push({
            x: p.x, y: p.y, vx: Math.cos(a) * 560, vy: Math.sin(a) * 560,
            r: 4, life: 0.35, damage: weaponDef.damage, color: weaponDef.color,
            knockbackMul: 1.6,
          });
        });
      } else if (weaponDef.mode === 'rocket') {
        state.bullets.push({
          x: p.x, y: p.y, vx: Math.cos(angle) * 420, vy: Math.sin(angle) * 420,
          r: 6, life: 1.6, damage: weaponDef.damage, color: weaponDef.color,
          explosive: true,
        });
      } else if (weaponDef.mode === 'ricochet') {
        state.bullets.push({
          x: p.x, y: p.y, vx: Math.cos(angle) * 620, vy: Math.sin(angle) * 620,
          r: 4, life: 2.5, damage: weaponDef.damage, color: weaponDef.color,
          bounces: 2, hitSet: new Set(),
        });
      } else if (weaponDef.mode === 'ice') {
        state.bullets.push({
          x: p.x, y: p.y, vx: Math.cos(angle) * 560, vy: Math.sin(angle) * 560,
          r: 4, life: 1.3, damage: weaponDef.damage, color: weaponDef.color,
          freeze: true,
        });
      } else if (weaponDef.mode === 'poison') {
        state.bullets.push({
          x: p.x, y: p.y, vx: Math.cos(angle) * 520, vy: Math.sin(angle) * 520,
          r: 4, life: 1.4, damage: weaponDef.damage, color: weaponDef.color,
          poison: true,
        });
      } else if (weaponDef.mode === 'laser') {
        state.bullets.push({
          x: p.x, y: p.y, vx: Math.cos(angle) * 2600, vy: Math.sin(angle) * 2600,
          r: 5, life: 0.4, damage: weaponDef.damage, color: weaponDef.color,
          hitSet: new Set(),
        });
      } else {
        state.bullets.push({
          x: p.x, y: p.y, vx: Math.cos(angle) * 620, vy: Math.sin(angle) * 620,
          r: 4, life: 1.2, damage: weaponDef.damage, color: weaponDef.color,
        });
      }
    }
  }

  // Weapon pickups - spawn, expire, collect
  state.pickupSpawnTimer -= dt;
  if (state.pickupSpawnTimer <= 0) {
    spawnWeaponPickup();
    state.pickupSpawnTimer = 12 + Math.random() * 6;
  }
  state.weaponPickups = state.weaponPickups.filter((wp) => {
    if (performance.now() > wp.expiresAt) return false;
    if (dist(wp, p) < p.r + 14) {
      state.weapon = wp.type;
      state.weaponUntil = performance.now() + WEAPON_DURATION_MS;
      pushTicker('Weapon', `switched to ${wp.type}`, true);
      return false;
    }
    return true;
  });
  if (state.weapon !== 'default' && performance.now() > state.weaponUntil) {
    state.weapon = 'default';
  }
  updateWeaponHud();

  // Bullets
  state.bullets.forEach((b) => {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.bounces > 0) {
      if (b.x < 0 || b.x > canvas.width) {
        b.vx = -b.vx;
        b.bounces--;
        b.x = Math.max(0, Math.min(canvas.width, b.x));
      }
      if (b.y < 0 || b.y > canvas.height) {
        b.vy = -b.vy;
        b.bounces--;
        b.y = Math.max(0, Math.min(canvas.height, b.y));
      }
    }
  });
  state.bullets = state.bullets.filter((b) => b.life > 0);

  // Health pickups - collection/expiry check. Scheduling (when a pickup is
  // due to appear) happens above, ungated; this is collision resolution, so
  // it stays gated behind hitstop like everything else in this section.
  state.healthPickups = state.healthPickups.filter((h) => {
    if (performance.now() > h.expiresAt) return false;
    if (dist(h, p) < p.r + 12) {
      p.hp = Math.min(p.maxHp, p.hp + 25);
      updateHud();
      pushTicker('Health', 'restored +25 HP', true);
      return false;
    }
    return true;
  });

  // Passive enemy spawn so the game has a baseline pace even in a quiet chat.
  // Paused briefly during the wave banner so the transition reads clearly.
  state.spawnTimer -= dt;
  if (state.spawnTimer <= 0 && now > state.spawnPausedUntil) {
    const type = pickEnemyType();
    if (type === 'swarmer') {
      spawnSwarmerCluster();
    } else {
      spawnEnemy(false, type);
    }
    state.spawnTimer = currentSpawnInterval();
  }

  const slowed = now < state.slowUntil;

  // Enemies - movement/attack AI branches per archetype; knockback,
  // obstacle collision, and contact damage stay shared across all of them.
  state.enemies.forEach((e) => {
    const idealAngle = Math.atan2(p.y - e.y, p.x - e.x);
    // Frozen (ice weapon) stacks on top of the chat !slow effect rather than
    // replacing it, so both sources of slow feel consistent with each other.
    const frozen = now < (e.frozenUntil || 0);
    const speedMul = (slowed ? 0.35 : 1) * (frozen ? 0.4 : 1);

    if (e.poisonUntil && now < e.poisonUntil && e.hp > 0) {
      e.hp -= (e.poisonDps || 1) * dt;
      if (Math.random() < 0.2) spawnParticles(e.x, e.y, '#7cff3d');
    }

    if (e.type === 'sniper') {
      const d = dist(e, p);
      let targetAngle;
      if (d < 250) targetAngle = idealAngle + Math.PI;
      else if (d > 300) targetAngle = idealAngle;
      else targetAngle = idealAngle + (Math.PI / 2) * e.strafeDir;
      if (e.heading === undefined) e.heading = targetAngle;
      e.heading = lerpAngle(e.heading, targetAngle, dt * 3);
      e.x += Math.cos(e.heading) * e.speed * speedMul * dt;
      e.y += Math.sin(e.heading) * e.speed * speedMul * dt;

      e.fireCooldown -= dt;
      if (e.fireCooldown <= 0 && d < 600) {
        e.fireCooldown = 2 + Math.random() * 0.4;
        state.enemyProjectiles.push({
          x: e.x, y: e.y,
          vx: Math.cos(idealAngle) * 180, vy: Math.sin(idealAngle) * 180,
          r: 5, life: 4,
        });
      }
    } else if (e.type === 'brute') {
      // Keeps its distance like a sniper but turns slower - a heavier,
      // more deliberate threat - and fires the hardest-hitting enemy shot
      // in the game on a slow cooldown.
      const d = dist(e, p);
      let targetAngle;
      if (d < 220) targetAngle = idealAngle + Math.PI;
      else if (d > 320) targetAngle = idealAngle;
      else targetAngle = idealAngle + (Math.PI / 2) * e.strafeDir;
      if (e.heading === undefined) e.heading = targetAngle;
      e.heading = lerpAngle(e.heading, targetAngle, dt * 1.6);
      e.x += Math.cos(e.heading) * e.speed * speedMul * dt;
      e.y += Math.sin(e.heading) * e.speed * speedMul * dt;

      e.fireCooldown -= dt;
      if (e.fireCooldown <= 0 && d < 560) {
        e.fireCooldown = 3 + Math.random() * 0.5;
        state.enemyProjectiles.push({
          x: e.x, y: e.y,
          vx: Math.cos(idealAngle) * 140, vy: Math.sin(idealAngle) * 140,
          r: 8, life: 5, damage: 20,
        });
      }
    } else if (e.type === 'dasher') {
      e.dashTimer -= dt;
      if (e.dashMode === 'wander') {
        e.wanderTimer -= dt;
        if (e.wanderTimer <= 0) {
          e.wanderAngle = Math.random() * Math.PI * 2;
          e.wanderTimer = 0.5 + Math.random() * 0.6;
        }
        e.x += Math.cos(e.wanderAngle) * e.speed * 0.5 * speedMul * dt;
        e.y += Math.sin(e.wanderAngle) * e.speed * 0.5 * speedMul * dt;
        if (e.dashTimer <= 0) {
          e.dashMode = 'telegraph';
          e.dashTimer = 0.5;
        }
      } else if (e.dashMode === 'telegraph') {
        if (e.dashTimer <= 0) {
          e.dashMode = 'dashing';
          e.dashAngle = idealAngle;
          e.dashTimer = 0.35;
        }
      } else if (e.dashMode === 'dashing') {
        e.x += Math.cos(e.dashAngle) * e.speed * 4 * speedMul * dt;
        e.y += Math.sin(e.dashAngle) * e.speed * 4 * speedMul * dt;
        if (e.dashTimer <= 0) {
          e.dashMode = 'wander';
          e.dashTimer = 2 + Math.random() * 2;
        }
      }
    } else if (ELITE_ATTACK[e.type]) {
      // Elemental elites - shared kiting AI (identical shape to sniper/brute
      // above) driven entirely by the ELITE_ATTACK config for this type, so
      // all 10 elemental enemies reuse one movement/attack block instead of
      // each needing its own hand-written branch.
      const cfg = ELITE_ATTACK[e.type];
      const d = dist(e, p);
      let targetAngle;
      if (d < 220) targetAngle = idealAngle + Math.PI;
      else if (d > 320) targetAngle = idealAngle;
      else targetAngle = idealAngle + (Math.PI / 2) * e.strafeDir;
      if (e.heading === undefined) e.heading = targetAngle;
      e.heading = lerpAngle(e.heading, targetAngle, dt * (cfg.tanky ? 1.6 : 3));
      e.x += Math.cos(e.heading) * e.speed * speedMul * dt;
      e.y += Math.sin(e.heading) * e.speed * speedMul * dt;

      e.fireCooldown -= dt;
      if (e.fireCooldown <= 0 && d < 600) {
        e.fireCooldown = cfg.cooldown[0] + Math.random() * (cfg.cooldown[1] - cfg.cooldown[0]);
        state.enemyProjectiles.push({
          x: e.x, y: e.y,
          vx: Math.cos(idealAngle) * cfg.projSpeed, vy: Math.sin(idealAngle) * cfg.projSpeed,
          r: cfg.projR, life: cfg.kind === 'grenade' ? 1.2 + Math.random() * 0.3 : (cfg.life || 5),
          damage: cfg.damage, color: cfg.color, kind: cfg.kind,
          status: cfg.status, statusDur: cfg.statusDur, statusDps: cfg.statusDps, slowMul: cfg.slowMul,
          hazard: cfg.hazard, hazardR: cfg.hazardR, hazardDur: cfg.hazardDur,
          splash: cfg.splash, homing: cfg.homing,
        });
      }
    } else {
      // chaser, swarmer, boss, grunt, loot - any type without a dedicated
      // branch above falls through to this default: direct homing chase.
      if (e.heading === undefined) e.heading = idealAngle;
      e.heading = lerpAngle(e.heading, idealAngle, dt * (e.boss ? 2.5 : 4.5));
      e.x += Math.cos(e.heading) * e.speed * speedMul * dt;
      e.y += Math.sin(e.heading) * e.speed * speedMul * dt;
    }

    decayKnockback(e, dt);
    resolveObstacleCollision(e);
    e.facingLeft = p.x < e.x;
    if (e.hitFlash > 0) e.hitFlash -= dt * 6;

    if (dist(e, p) < e.r + p.r) {
      if (!p.shielded) {
        p.hp -= e.boss ? 25 : 10;
        updateHud();
        onPlayerDamaged();
        spawnParticles(p.x, p.y, '#ff3d7f');
        triggerShake(e.boss ? 14 : 7);
        applyKnockback(p, Math.atan2(p.y - e.y, p.x - e.x), 200);
        triggerHitstop(90);
        if (p.hp <= 0) return gameOver();
      }
      e.hp = 0; // enemy also dies on contact
    }
  });

  // Enemy projectiles (sniper/brute shots plus the elemental elites' bolts
  // and grenades). Bolts resolve on a direct hit; grenades (pr.kind ===
  // 'grenade') instead detonate when their short life runs out and splash
  // anyone within pr.splash of wherever they land, hit or not.
  state.enemyProjectiles.forEach((pr) => {
    if (pr.homing) {
      const desired = Math.atan2(p.y - pr.y, p.x - pr.x);
      const cur = Math.atan2(pr.vy, pr.vx);
      const bent = lerpAngle(cur, desired, pr.homing);
      const spd = Math.hypot(pr.vx, pr.vy);
      pr.vx = Math.cos(bent) * spd;
      pr.vy = Math.sin(bent) * spd;
    }
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.life -= dt;
    if (insideObstacle(pr.x, pr.y)) pr.life = 0;

    const directHit = pr.life > 0 && dist(pr, p) < pr.r + p.r;
    const grenadeDetonate = pr.kind === 'grenade' && pr.life <= 0;
    // A hazard-carrying bolt (toxic/acid) still leaves its cloud/puddle
    // wherever it lands - obstacle collision or running out of range - even
    // on a miss; only the direct player-damage/status block below actually
    // requires a hit.
    const boltLanded = pr.hazard && pr.kind !== 'grenade' && pr.life <= 0;
    if (!directHit && !grenadeDetonate && !boltLanded) return;

    const inSplash = pr.splash ? dist(pr, p) < pr.splash + p.r : directHit;
    pr.life = 0;
    if (inSplash && !p.shielded) {
      p.hp -= pr.damage || 8;
      updateHud();
      onPlayerDamaged();
      spawnParticles(p.x, p.y, pr.color || (pr.damage ? '#ff4d4d' : '#8b5cf6'));
      triggerShake(pr.damage ? 10 : 6);
      applyKnockback(p, Math.atan2(pr.vy, pr.vx), pr.damage ? 200 : 120);
      triggerHitstop(pr.damage ? 100 : 70);
      if (pr.status === 'dot') {
        p.dotUntil = Math.max(p.dotUntil || 0, performance.now() + pr.statusDur);
        p.dotDps = pr.statusDps;
      } else if (pr.status === 'chill') {
        p.chillUntil = performance.now() + pr.statusDur;
        p.chillMul = pr.slowMul;
      }
      if (p.hp <= 0) return gameOver();
    }
    if (pr.hazard) {
      state.hazards.push({ x: pr.x, y: pr.y, r: pr.hazardR, expiresAt: performance.now() + pr.hazardDur, dps: pr.statusDps || 3, color: pr.color });
    }
    if (pr.kind === 'grenade') {
      spawnParticles(pr.x, pr.y, pr.color || '#ffb020');
      triggerShake(8);
    }
  });
  state.enemyProjectiles = state.enemyProjectiles.filter((pr) => pr.life > 0);

  // Ground hazard zones left by toxic/plague/acid attacks - tick damage into
  // the player while they stand inside, same shield-blocks-everything rule
  // as every other damage source.
  let hazardKilledPlayer = false;
  state.hazards = state.hazards.filter((hz) => {
    if (performance.now() > hz.expiresAt) return false;
    if (!p.shielded && dist(hz, p) < hz.r + p.r) {
      p.hp -= hz.dps * dt;
      updateHud();
      if (Math.random() < 0.12) spawnParticles(p.x, p.y, hz.color || '#7cff3d');
      if (p.hp <= 0) hazardKilledPlayer = true;
    }
    return true;
  });
  // Bail out immediately, same as the other two death paths above, so a
  // fatal hazard tick can't also take a bullet/contact hit later in this
  // same frame and process more damage against an already-dead player.
  if (hazardKilledPlayer) return gameOver();

  // Bullets vs obstacles
  state.bullets.forEach((b) => {
    if (b.life > 0 && insideObstacle(b.x, b.y)) {
      b.life = 0;
      spawnParticles(b.x, b.y, '#8a8f9a');
      if (b.explosive) explodeAt(b.x, b.y, 70, 2);
    }
  });

  // Bullet vs enemy - ricochet bullets (b.hitSet present) pierce through
  // multiple enemies instead of dying on the first hit, but can't hit the
  // same enemy twice; rockets (b.explosive) also splash nearby enemies.
  state.bullets.forEach((b) => {
    state.enemies.forEach((e) => {
      if (e.hp > 0 && b.life > 0 && dist(b, e) < b.r + e.r) {
        if (b.hitSet) {
          if (b.hitSet.has(e)) return;
          b.hitSet.add(e);
        } else {
          b.life = 0;
        }
        e.hp -= b.damage ?? 1;
        e.hitFlash = 1;
        spawnParticles(e.x, e.y, e.color);
        // Bosses are heavier - half the knockback impulse.
        applyKnockback(e, Math.atan2(b.vy, b.vx), (e.boss ? 100 : 200) * (b.knockbackMul || 1));
        if (e.boss) triggerHitstop(90);
        if (b.freeze) e.frozenUntil = performance.now() + 1200;
        if (b.poison) { e.poisonUntil = performance.now() + 2500; e.poisonDps = 1.2; }
        if (e.hp <= 0) {
          triggerShake(e.boss ? 8 : 2);
          triggerHitstop(60);
        }
        if (b.explosive) explodeAt(b.x, b.y, 70, 2);
      }
    });
  });

  // Allies auto-fire at nearest enemy
  const nowMs = performance.now();
  state.allies.forEach((a) => {
    a.cooldown -= dt;
    const target = nearest(a, state.enemies);
    if (target && a.cooldown <= 0) {
      a.cooldown = 0.4;
      const angle = Math.atan2(target.y - a.y, target.x - a.x);
      state.bullets.push({ x: a.x, y: a.y, vx: Math.cos(angle) * 500, vy: Math.sin(angle) * 500, r: 3, life: 1, ally: true });
    }
  });
  state.allies = state.allies.filter((a) => a.expiresAt > nowMs);

  // Cleanup dead enemies -> score
  const before = state.enemies.length;
  state.enemies = state.enemies.filter((e) => {
    if (e.hp > 0) return true;
    trySpawnSpeechBubble(e, pickLine(e.type, 'death'), { big: e.boss, borderColor: e.boss ? '#ff3d7f' : '#2c303a', duration: e.boss ? 2.5 : 1.8, enemyType: e.type, moment: 'death' });
    state.score += e.score;
    state.killStreak += 1;

    // Boss kills always get a guaranteed line - a bigger, rarer payoff moment
    // that outranks even a streak milestone landing on the same kill. Streak
    // milestones in turn outrank the regular per-type quip chance.
    if (e.boss) {
      tryPlayerLine('boss', 2.5);
    } else if (state.killStreak > 0 && state.killStreak % 10 === 0) {
      tryPlayerLine('streak');
    } else if (e.type === 'sniper' || e.type === 'dasher' || e.type === 'brute') {
      if (Math.random() < 0.25) tryPlayerLine('tougher');
    } else if (Math.random() < 0.25) {
      tryPlayerLine('general');
    }
    return false;
  });
  if (state.enemies.length !== before) updateHud();

  // Particles
  state.particles.forEach((pt) => { pt.life -= dt; pt.x += pt.vx * dt; pt.y += pt.vy * dt; });
  state.particles = state.particles.filter((pt) => pt.life > 0);
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function nearest(from, list) {
  let best = null, bestD = Infinity;
  for (const e of list) {
    const d = dist(from, e);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// Desktop aims wherever the mouse points, same as always. Touch devices
// have no pointer to aim with, so they auto-aim at the nearest live enemy
// instead, falling back to the direction the player last moved if none
// are around - the shoot button then just fires wherever this points.
function getAimAngle() {
  const p = state.player;
  if (!isTouchDevice) {
    return Math.atan2(state.mouse.y - p.y, state.mouse.x - p.x);
  }
  const target = nearest(p, state.enemies.filter((e) => e.hp > 0));
  if (target) return Math.atan2(target.y - p.y, target.x - p.x);
  return state.lastMoveAngle;
}

function spawnParticles(x, y, color) {
  for (let i = 0; i < 6; i++) {
    const angle = Math.random() * Math.PI * 2;
    state.particles.push({
      x, y, vx: Math.cos(angle) * 120, vy: Math.sin(angle) * 120,
      life: 0.35, color,
    });
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// War-torn backdrop - procedural, blocky pixel-art like the sprites, no image
// assets. The expensive part (trees/craters/wire) is baked once into an
// offscreen layer and only rebuilt when the canvas resizes; fog and the
// distant glow are cheap enough to redraw live every frame.

// Four visual tiers, one per 4-wave block (tier 4 repeats for all later
// waves). Only sky/ground/tree colors and fog tint shift between tiers -
// craters and wire stay the same everywhere, so the change reads as mood
// rather than a gimmick.
const BACKGROUND_TIERS = [
  { sky: ['#0e1b26', '#0a141c', '#050708'], ground: ['#0a0d0a', '#040504'], treeColors: ['#0d1720', '#0a1218', '#060b0f'], fogColor: '180,200,210' },
  { sky: ['#2a1710', '#1a0f0c', '#0d0705'], ground: ['#1a0e08', '#0d0503'], treeColors: ['#3a1a10', '#2a120c', '#1a0a06'], fogColor: '255,150,90' },
  { sky: ['#1a1e24', '#14181d', '#0a0c0e'], ground: ['#15171a', '#0a0b0d'], treeColors: ['#22262b', '#1a1d21', '#101214'], fogColor: '200,210,220' },
  { sky: ['#3a0808', '#240404', '#100202'], ground: ['#280505', '#140202'], treeColors: ['#4a0a0a', '#340606', '#1c0303'], fogColor: '255,60,40' },
];

let bgLayerCache = {};
let bgLayerW = 0, bgLayerH = 0;
let treeSeeds = [];
let craterSeeds = [];
let wireSeeds = [];

function seedBackground(w, h) {
  treeSeeds = [];
  const depthLayers = [
    { count: 5, minY: h * 0.15, maxY: h * 0.5, minScale: 0.5, maxScale: 0.8, alpha: 0.3 },
    { count: 6, minY: h * 0.32, maxY: h * 0.62, minScale: 0.7, maxScale: 1.1, alpha: 0.55 },
    { count: 5, minY: h * 0.5, maxY: h * 0.78, minScale: 1.0, maxScale: 1.6, alpha: 0.85 },
  ];
  depthLayers.forEach((layer, colorIdx) => {
    for (let i = 0; i < layer.count; i++) {
      treeSeeds.push({
        x: Math.random() * (w + 200) - 100,
        y: layer.minY + Math.random() * (layer.maxY - layer.minY),
        scale: layer.minScale + Math.random() * (layer.maxScale - layer.minScale),
        alpha: layer.alpha,
        colorIdx,
      });
    }
  });

  craterSeeds = [];
  for (let i = 0; i < 10; i++) {
    craterSeeds.push({ x: Math.random() * w, y: h * 0.74 + Math.random() * h * 0.24, r: 14 + Math.random() * 30 });
  }

  wireSeeds = [];
  for (let i = 0; i < 4; i++) {
    wireSeeds.push({
      x: Math.random() * w,
      y: h * 0.78 + Math.random() * h * 0.18,
      width: 60 + Math.random() * 100,
      posts: 3 + Math.floor(Math.random() * 3),
    });
  }
}

function drawTree(bctx, x, y, scale, alpha, color) {
  bctx.save();
  bctx.globalAlpha = alpha;
  bctx.fillStyle = color;
  bctx.translate(x, y);
  bctx.scale(scale, scale);
  bctx.fillRect(-6, -70, 12, 90);
  const branches = [
    [-6, -70, -40, -95, 8],
    [6, -60, 34, -88, 7],
    [-4, -40, -28, -58, 6],
    [4, -30, 26, -50, 6],
    [-2, -85, -18, -110, 5],
  ];
  branches.forEach(([x1, y1, x2, y2, w]) => {
    bctx.save();
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const len = Math.hypot(x2 - x1, y2 - y1);
    bctx.translate(x1, y1);
    bctx.rotate(angle);
    bctx.fillRect(0, -w / 2, len, w);
    bctx.restore();
  });
  bctx.restore();
}

function buildBackgroundLayer(w, h, tierIdx) {
  const tier = BACKGROUND_TIERS[tierIdx - 1];
  const layer = document.createElement('canvas');
  layer.width = w; layer.height = h;
  const bctx = layer.getContext('2d');

  const sky = bctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, tier.sky[0]);
  sky.addColorStop(0.55, tier.sky[1]);
  sky.addColorStop(1, tier.sky[2]);
  bctx.fillStyle = sky;
  bctx.fillRect(0, 0, w, h);

  const groundY = h * 0.72;
  const ground = bctx.createLinearGradient(0, groundY, 0, h);
  ground.addColorStop(0, tier.ground[0]);
  ground.addColorStop(1, tier.ground[1]);
  bctx.fillStyle = ground;
  bctx.fillRect(0, groundY, w, h - groundY);

  treeSeeds.forEach((t) => drawTree(bctx, t.x, t.y, t.scale, t.alpha, tier.treeColors[t.colorIdx]));

  craterSeeds.forEach((c) => {
    const grad = bctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.7, 'rgba(0,0,0,0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    bctx.fillStyle = grad;
    bctx.beginPath();
    bctx.ellipse(c.x, c.y, c.r, c.r * 0.45, 0, 0, Math.PI * 2);
    bctx.fill();
  });

  bctx.strokeStyle = 'rgba(20,22,24,0.9)';
  bctx.lineWidth = 2;
  wireSeeds.forEach((wire) => {
    bctx.beginPath();
    bctx.moveTo(wire.x, wire.y);
    bctx.lineTo(wire.x + wire.width, wire.y - 6);
    bctx.stroke();
    for (let i = 0; i <= wire.posts; i++) {
      const px = wire.x + (wire.width / wire.posts) * i;
      const py = wire.y - (6 * i) / wire.posts;
      bctx.beginPath();
      bctx.moveTo(px, py - 10);
      bctx.lineTo(px, py + 4);
      bctx.stroke();
      bctx.beginPath();
      bctx.moveTo(px - 4, py - 4);
      bctx.lineTo(px + 4, py - 8);
      bctx.moveTo(px - 4, py);
      bctx.lineTo(px + 4, py - 4);
      bctx.stroke();
    }
  });

  return layer;
}

function getBackgroundLayerForTier(tierIdx) {
  if (bgLayerW !== canvas.width || bgLayerH !== canvas.height) {
    bgLayerW = canvas.width;
    bgLayerH = canvas.height;
    seedBackground(bgLayerW, bgLayerH);
    bgLayerCache = {};
  }
  if (!bgLayerCache[tierIdx]) {
    bgLayerCache[tierIdx] = buildBackgroundLayer(bgLayerW, bgLayerH, tierIdx);
  }
  return bgLayerCache[tierIdx];
}

function drawFog(fctx, w, h, t, tierIdx) {
  const fogColor = BACKGROUND_TIERS[tierIdx - 1].fogColor;
  for (let i = 0; i < 3; i++) {
    const speed = 8 + i * 6;
    const y = h * (0.55 + i * 0.12);
    const offset = ((t * speed) % (w + 300)) - 150;
    const grad = fctx.createLinearGradient(offset - 150, 0, offset + 150, 0);
    grad.addColorStop(0, `rgba(${fogColor},0)`);
    grad.addColorStop(0.5, `rgba(${fogColor},${0.05 + i * 0.02})`);
    grad.addColorStop(1, `rgba(${fogColor},0)`);
    fctx.fillStyle = grad;
    fctx.fillRect(0, y - 30, w, 60);
  }
}

// Cross-fades from the previous tier's baked layer to the new one over
// state.bgTransition.duration seconds instead of snapping instantly.
function drawWarBackground(wctx, now) {
  if (state.bgTransition) {
    const t = Math.min(1, state.bgTransition.elapsed / state.bgTransition.duration);
    wctx.drawImage(getBackgroundLayerForTier(state.bgTransition.from), 0, 0);
    wctx.save();
    wctx.globalAlpha = t;
    wctx.drawImage(getBackgroundLayerForTier(state.bgTransition.to), 0, 0);
    wctx.restore();
  } else {
    wctx.drawImage(getBackgroundLayerForTier(state.bgTier), 0, 0);
  }
  drawFog(wctx, canvas.width, canvas.height, now, state.bgTier);
}

// Blocky sandbag/rubble texture for cover obstacles - a staggered grid of
// small shaded bricks instead of a flat rect, to match the pixel-art sprites.
const OBSTACLE_SHADES = ['#4a4a2e', '#3a3b26', '#2e301f'];
const OBSTACLE_BRICK = 10;

function drawObstacles() {
  state.obstacles.forEach((o) => {
    const left = o.x - o.hw;
    const top = o.y - o.hh;
    const w = o.hw * 2;
    const h = o.hh * 2;

    ctx.fillStyle = '#1c1e16';
    ctx.fillRect(left, top, w, h);

    const cols = Math.max(2, Math.round(w / OBSTACLE_BRICK));
    const rows = Math.max(2, Math.round(h / OBSTACLE_BRICK));
    const cw = w / cols;
    const rh = h / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = OBSTACLE_SHADES[(r + c) % OBSTACLE_SHADES.length];
        ctx.fillRect(left + c * cw + 1, top + r * rh + 1, cw - 2, rh - 2);
      }
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.strokeRect(left, top, w, h);
  });
}

function render() {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const now = performance.now() / 1000;

  ctx.save();
  ctx.translate(state.shake.x, state.shake.y);

  drawWarBackground(ctx, now);
  drawObstacles();

  // Ground hazard zones (toxic/plague/acid) - pulsing translucent pools.
  state.hazards.forEach((hz) => {
    ctx.save();
    ctx.globalAlpha = 0.28 + 0.1 * Math.sin(now * 6);
    ctx.fillStyle = hz.color || '#7cff3d';
    ctx.beginPath();
    ctx.ellipse(hz.x, hz.y, hz.r, hz.r * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // Allies (hover-bob + rotating turret)
  state.allies.forEach((a) => {
    const bob = Math.sin(now * 4 + a.bobSeed) * 3;
    drawSprite(ctx, SPRITES.ally, a.x, a.y + bob, 40);
    const target = nearest(a, state.enemies);
    if (target) {
      const angle = Math.atan2(target.y - (a.y + bob), target.x - a.x);
      drawGun(ctx, a.x, a.y + bob, angle, '#38e8d4');
    }
  });

  // Enemies (bob + facing + hit-flash + dasher telegraph pulse)
  state.enemies.forEach((e) => {
    const bob = Math.sin(now * 5 + e.bobSeed) * 2;
    const sprite = e.boss ? SPRITES.boss : (SPRITES[e.type] || SPRITES.enemy);
    let size = e.boss ? 76 : e.type === 'swarmer' ? 22 : e.type === 'brute' ? 54 : HEAVY_ELITE_TYPES.has(e.type) ? 52 : e.type === 'grunt' ? 32 : 40;
    if (e.type === 'dasher' && e.dashMode === 'telegraph') {
      const progress = 1 - Math.min(1, e.dashTimer / 0.5);
      size *= 1 - 0.35 * Math.sin(progress * Math.PI);
    }
    if (e.type === 'loot') {
      const pulse = 0.6 + 0.4 * Math.sin(now * 6);
      const glow = ctx.createRadialGradient(e.x, e.y + bob, 2, e.x, e.y + bob, size * 0.9);
      glow.addColorStop(0, `rgba(255,244,200,${0.5 * pulse})`);
      glow.addColorStop(1, 'rgba(255,244,200,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(e.x - size, e.y + bob - size, size * 2, size * 2);
    } else if (e.dangerBuffed) {
      // Danger-wave enemies get a pulsing red glow so the extra HP/speed is
      // visible at a glance, not just felt when it takes more hits to drop.
      const pulse = 0.5 + 0.35 * Math.sin(now * 7);
      const glow = ctx.createRadialGradient(e.x, e.y + bob, 2, e.x, e.y + bob, size * 0.85);
      glow.addColorStop(0, `rgba(255,45,45,${0.45 * pulse})`);
      glow.addColorStop(1, 'rgba(255,45,45,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(e.x - size, e.y + bob - size, size * 2, size * 2);
    }
    drawSprite(ctx, sprite, e.x, e.y + bob, size, e.facingLeft);
    if (e.hitFlash > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.6, e.hitFlash);
      ctx.globalCompositeOperation = 'lighter';
      drawSprite(ctx, sprite, e.x, e.y + bob, size, e.facingLeft);
      ctx.restore();
    }
    if (e.frozenUntil && performance.now() < e.frozenUntil) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#8fe0ff';
      ctx.beginPath();
      ctx.arc(e.x, e.y + bob, size * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  });

  // Sniper projectiles are small violet pixel bolts; brute projectiles are
  // bigger and blood-red so its heavy hit reads as more dangerous on sight.
  // Elemental elites carry their own pr.color, which takes priority.
  state.enemyProjectiles.forEach((pr) => {
    const color = pr.color || (pr.damage ? '#ff4d4d' : '#8b5cf6');
    const half = pr.r ? pr.r - 1 : pr.damage ? 5 : 3;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(pr.x - pr.vx * 0.015 - half, pr.y - pr.vy * 0.015 - half, half * 2, half * 2);
    ctx.globalAlpha = 1;
    ctx.fillRect(pr.x - half, pr.y - half, half * 2, half * 2);
  });

  // Bullets with a short pixel trail (rockets render larger, matching their hitbox)
  state.bullets.forEach((b) => {
    const color = b.ally ? '#38e8d4' : (b.color || '#F0B90B');
    const half = Math.max(3, b.r || 3);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(b.x - b.vx * 0.012 - half / 2, b.y - b.vy * 0.012 - half / 2, half, half);
    ctx.globalAlpha = 1;
    ctx.fillRect(b.x - half, b.y - half, half * 2, half * 2);
  });

  // Electric beam
  if (state.beamLine) {
    ctx.save();
    ctx.strokeStyle = state.beamLine.hit ? '#4dd8ff' : 'rgba(77,216,255,0.35)';
    ctx.lineWidth = state.beamLine.hit ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(state.beamLine.x1, state.beamLine.y1);
    ctx.lineTo(state.beamLine.x2, state.beamLine.y2);
    ctx.stroke();
    ctx.restore();
  }

  // Flamethrower cone
  if (state.flameCone) {
    const { x, y, angle, range, halfAngle } = state.flameCone;
    ctx.save();
    ctx.fillStyle = 'rgba(255,120,40,0.25)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, range, angle - halfAngle, angle + halfAngle);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Weapon pickups - pulsing diamonds matching the brand mark
  state.weaponPickups.forEach((wp) => {
    const color = WEAPON_DEFS[wp.type].color;
    const pulse = 0.5 + 0.5 * Math.sin(now * 4 + wp.x);
    const size = 12 + pulse * 3;
    ctx.save();
    ctx.translate(wp.x, wp.y);
    ctx.shadowColor = color;
    ctx.shadowBlur = 8 + pulse * 6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.7, 0);
    ctx.lineTo(0, size);
    ctx.lineTo(-size * 0.7, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  });

  // Health pickups - pulsing pixel hearts
  state.healthPickups.forEach((h) => {
    const pulse = 0.5 + 0.5 * Math.sin(now * 4 + h.x);
    const scale = 3 * (0.9 + pulse * 0.25);
    const w = HEALTH_ICON[0].length * scale;
    const hgt = HEALTH_ICON.length * scale;
    ctx.save();
    ctx.translate(h.x - w / 2, h.y - hgt / 2);
    ctx.shadowColor = '#F0B90B';
    ctx.shadowBlur = 6 + pulse * 6;
    ctx.fillStyle = '#F0B90B';
    HEALTH_ICON.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] === '#') ctx.fillRect(rx * scale, ry * scale, scale, scale);
      }
    });
    ctx.restore();
  });

  // Particles - chunky pixel shards
  state.particles.forEach((pt) => {
    ctx.globalAlpha = Math.max(0, pt.life / 0.35);
    ctx.fillStyle = pt.color;
    ctx.fillRect(pt.x - 2, pt.y - 2, 4, 4);
    ctx.globalAlpha = 1;
  });

  // Player
  const p = state.player;
  const frame = state.walkFrame === 0 ? SPRITES.playerF1 : SPRITES.playerF2;
  drawSprite(ctx, frame, p.x, p.y, 48, p.facingLeft);
  if (p.shielded) {
    ctx.strokeStyle = 'rgba(56,232,212,0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 10, 0, Math.PI * 2); ctx.stroke();
  }
  drawGun(ctx, p.x, p.y, p.gunAngle, p.shielded ? '#38e8d4' : '#F0B90B');

  // Speech bubbles - drawn last so they float above every sprite, enemy,
  // and effect already rendered this frame.
  state.speechBubbles.forEach((b) => {
    const t = b.age / b.duration;
    const alpha = t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.4);
    const floatUp = 10 * Math.min(1, t / 0.4) + 6 * t;
    const headR = b.follow.r || 16;
    drawSpeechBubble(ctx, b.follow.x, b.follow.y - headR - 10 - floatUp, b.text, alpha, { big: b.big, borderColor: b.borderColor, fontSize: b.fontSize, fontFamily: b.fontFamily });
  });

  ctx.restore();

  if (state.waveBanner.active) {
    const alpha = waveBannerAlpha();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = state.waveBanner.danger ? '700 28px "Press Start 2P", monospace' : '700 40px "Press Start 2P", monospace';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 6;
    ctx.strokeText(state.waveBanner.text, canvas.width / 2, canvas.height * 0.35);
    ctx.fillStyle = state.waveBanner.danger ? '#ff3d7f' : '#F0B90B';
    ctx.fillText(state.waveBanner.text, canvas.width / 2, canvas.height * 0.35);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// HUD + game over
// ---------------------------------------------------------------------------

function updateHud() {
  const p = state.player;
  const pct = Math.max(0, (p.hp / p.maxHp) * 100);
  document.getElementById('health-fill').style.width = pct + '%';
  document.getElementById('health-text').textContent = `${Math.max(0, Math.round(p.hp))} HP`;
  document.getElementById('score').textContent = state.score;
  document.getElementById('wave-badge').textContent = 'WAVE ' + state.wave;
}

async function gameOver() {
  state.running = false;
  GameAudio.stopBeamHum();
  GameAudio.stopFlameHiss();
  GameAudio.stopAllVoiceLines();
  GameAudio.playGameOver();
  gameScreen.classList.add('hidden');
  gameOverScreen.classList.remove('hidden');
  document.getElementById('final-score').textContent = `Score: ${state.score}`;

  try {
    const res = await fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ score: state.score }),
    });
    const { top10 } = await res.json();
    renderLeaderboard(top10);
  } catch {
    renderLeaderboard([]);
  }
}

function renderLeaderboard(entries) {
  const el = document.getElementById('leaderboard');
  el.innerHTML = '<div class="hud-label" style="margin-bottom:8px;">LEADERBOARD</div>';
  entries.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'lb-row' + (e.displayName === me?.displayName ? ' me' : '');
    row.innerHTML = `<span>${escapeHtml(e.displayName)}</span><span>${e.score}</span>`;
    el.appendChild(row);
  });
}

document.getElementById('restart-btn').addEventListener('click', startGame);

// Shared by the HUD mute button and the pause-menu mute button so either one
// toggling sound keeps both in sync, regardless of which was clicked.
function updateMuteButtons(muted) {
  document.getElementById('mute-btn').innerHTML = muted ? '&#128263;' : '&#128266;';
  document.getElementById('pause-mute-btn').textContent = muted ? 'Unmute Sound' : 'Mute Sound';
}

document.getElementById('mute-btn').addEventListener('click', () => updateMuteButtons(GameAudio.toggleMute()));
