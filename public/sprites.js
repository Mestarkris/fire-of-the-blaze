// ---------------------------------------------------------------------------
// Pixel-art sprite system for Fire of the Blaze.
// Sprites are hand-authored as small character grids (one char = one pixel),
// pre-rendered once to offscreen canvases at PIXEL_SCALE, then blitted with
// image smoothing disabled so everything stays crisp and blocky - genuine
// retro-arcade rendering with zero external image assets to manage.
// ---------------------------------------------------------------------------

const PIXEL_SCALE = 6; // on-screen px per sprite pixel

const PALETTES = {
  player: { '#': '#12100a', A: '#F0B90B', B: '#c99408', C: '#38e8d4' },
  enemy: { '#': '#3a0f18', A: '#e94f6b', B: '#a3324a', C: '#F0B90B' },
  boss: { '#': '#3a0a1c', A: '#ff3d7f', B: '#b32359', C: '#fff2a8' },
  ally: { '#': '#0b2f2a', A: '#38e8d4', B: '#1f9e8c', C: '#e8fffb' },
  sniper: { '#': '#241033', A: '#8b5cf6', B: '#5b3a99', C: '#e0d4ff' },
  dasher: { '#': '#331a05', A: '#ff8a3d', B: '#b35a1f', C: '#ffe0b0' },
  swarmer: { '#': '#0a2e28', A: '#2dd4a8', B: '#1a8a6b', C: '#c8fff0' },
  // Loot enemy (spawned by small tips) - same silhouette as the base enemy
  // but a bright gold-white palette so it reads as a juicy bonus target.
  loot: { '#': '#4a3a00', A: '#fff6c8', B: '#ffcf3d', C: '#ffffff' },
  // Grunt - dim, washed-out fodder that dies in one hit; reads as visibly
  // weaker than the chaser at a glance, not just numerically.
  grunt: { '#': '#1a1c20', A: '#8a8f9a', B: '#5a5f6a', C: '#c8ccd4' },
  // Brute - tanky ranged attacker, dark blood-red and rendered larger than
  // regular enemies so it reads as the most dangerous non-boss threat.
  brute: { '#': '#2a0505', A: '#8a0e0e', B: '#500808', C: '#ff4d4d' },

  // Elemental elites - all ten share one of two silhouettes (ELITE_LIGHT or
  // ELITE_HEAVY, see below) and are distinguished from each other purely by
  // palette, matching this file's existing convention (grunt/loot/brute all
  // reuse the base ENEMY shape too).
  archer: { '#': '#241a0a', A: '#c8a25a', B: '#8a6a35', C: '#f0dca0' },
  frost: { '#': '#032733', A: '#8fe0ff', B: '#3d9fc2', C: '#e0faff' },
  toxic: { '#': '#0f2408', A: '#7cff3d', B: '#4a9e22', C: '#d4ffb0' },
  stormcaller: { '#': '#050e33', A: '#4dd8ff', B: '#2c7ea3', C: '#dff7ff' },
  acid: { '#': '#1c2400', A: '#b6ff3d', B: '#7a9e22', C: '#eaffb0' },
  pyro: { '#': '#3a1200', A: '#ff6a1a', B: '#b3410f', C: '#ffd9a0' },
  bomber: { '#': '#331a00', A: '#ffb020', B: '#a3690f', C: '#ffe0a0' },
  frostguard: { '#': '#021a24', A: '#5fc4ff', B: '#1f6f96', C: '#c8f0ff' },
  plague: { '#': '#0a1f05', A: '#4fdb3d', B: '#2c8a1e', C: '#a0ff8a' },
  inferno: { '#': '#4a0800', A: '#ff3d1a', B: '#8a1400', C: '#ffb066' },
};

// Player, frame 1 (legs together) - 10x10
const PLAYER_F1 = [
  '..######..',
  '.#AAAAAA#.',
  '#AABBBBAA#',
  '#ABBCCBBA#',
  '#ABBCCBBA#',
  '#AABBBBAA#',
  '.#AAAAAA#.',
  '..#AAAA#..',
  '..#A##A#..',
  '..##..##..',
];

// Player, frame 2 (legs stepping) - same silhouette, feet offset
const PLAYER_F2 = [
  '..######..',
  '.#AAAAAA#.',
  '#AABBBBAA#',
  '#ABBCCBBA#',
  '#ABBCCBBA#',
  '#AABBBBAA#',
  '.#AAAAAA#.',
  '..#AAAA#..',
  '..##A#A##.',
  '.##....##.',
];

const ENEMY = [
  '..####..',
  '.#AAAA#.',
  '#ABBBBA#',
  '#ABCCBA#',
  '#ABBBBA#',
  '.#AAAA#.',
  '..#AA#..',
  '.##..##.',
];

const ALLY = [
  '..####..',
  '.######.',
  '#AAAAAA#',
  '#ABBBBA#',
  '.######.',
  '..#AA#..',
  '.#....#.',
  '........',
];

// Sniper - taller diamond silhouette suggesting a scope, distinct from the
// squarer chaser even before color.
const SNIPER = [
  '...##...',
  '..#AA#..',
  '.#ABBA#.',
  '#ABCCBA#',
  '#ABCCBA#',
  '.#ABBA#.',
  '..#AA#..',
  '.##..##.',
];

// Dasher - spiky "wings" top and bottom to read as fast/aggressive.
const DASHER = [
  '.#....#.',
  '.##..##.',
  '#ABBBBA#',
  '#ABCCBA#',
  '#ABBBBA#',
  '.##BB##.',
  '..#BB#..',
  '.#....#.',
];

// Swarmer - small round blob, rendered much smaller than the other enemies
// so its "weak but numerous" identity reads immediately.
const SWARMER = [
  '.####.',
  '#AABA#',
  '#ABBA#',
  '#ABBA#',
  '#AABA#',
  '.####.',
];

// Elite light - compact spiky orb silhouette for the six faster/glassier
// elemental ranged attackers (archer, frost, toxic, stormcaller, acid, pyro).
// Distinct from the squarer base ENEMY shape so they read as a new threat
// category before the player even clocks their color.
const ELITE_LIGHT = [
  '.#.##.#.',
  '##ABBA##',
  '#ABCCBA#',
  '#ABCCBA#',
  '##ABBA##',
  '.#.##.#.',
];

// Elite heavy - bulkier armored silhouette for the four tanky elemental
// grenadiers (bomber, frostguard, plague, inferno).
const ELITE_HEAVY = [
  '.######.',
  '#AAAAAA#',
  '#ABBBBA#',
  '#ABCCBA#',
  '#ABCCBA#',
  '#ABBBBA#',
  '#AAAAAA#',
  '##....##',
];

const BOSS = [
  '...####...',
  '..#AAAAAA#',
  '.#AABBBBAA',
  '#AABBCCBBA',
  '#AABCCCCBA',
  '#AABBCCBBA',
  '.#AABBBBAA',
  '..#AAAAAA#',
  '...#AAAA#.',
  '...#A##A#.',
  '..##....##',
  '.##......#',
].map((row) => (row.length < 11 ? row.padEnd(11, '.') : row));

function renderSpriteToCanvas(grid, palette) {
  const w = grid[0].length;
  const h = grid.length;
  const off = document.createElement('canvas');
  off.width = w * PIXEL_SCALE;
  off.height = h * PIXEL_SCALE;
  const octx = off.getContext('2d');
  octx.imageSmoothingEnabled = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = grid[y][x];
      if (ch === '.' ) continue;
      octx.fillStyle = palette[ch] || '#ff00ff';
      octx.fillRect(x * PIXEL_SCALE, y * PIXEL_SCALE, PIXEL_SCALE, PIXEL_SCALE);
    }
  }
  return off;
}

const SPRITES = {
  playerF1: renderSpriteToCanvas(PLAYER_F1, PALETTES.player),
  playerF2: renderSpriteToCanvas(PLAYER_F2, PALETTES.player),
  enemy: renderSpriteToCanvas(ENEMY, PALETTES.enemy),
  boss: renderSpriteToCanvas(BOSS, PALETTES.boss),
  ally: renderSpriteToCanvas(ALLY, PALETTES.ally),
  sniper: renderSpriteToCanvas(SNIPER, PALETTES.sniper),
  dasher: renderSpriteToCanvas(DASHER, PALETTES.dasher),
  swarmer: renderSpriteToCanvas(SWARMER, PALETTES.swarmer),
  loot: renderSpriteToCanvas(ENEMY, PALETTES.loot),
  grunt: renderSpriteToCanvas(ENEMY, PALETTES.grunt),
  brute: renderSpriteToCanvas(ENEMY, PALETTES.brute),
  archer: renderSpriteToCanvas(ELITE_LIGHT, PALETTES.archer),
  frost: renderSpriteToCanvas(ELITE_LIGHT, PALETTES.frost),
  toxic: renderSpriteToCanvas(ELITE_LIGHT, PALETTES.toxic),
  stormcaller: renderSpriteToCanvas(ELITE_LIGHT, PALETTES.stormcaller),
  acid: renderSpriteToCanvas(ELITE_LIGHT, PALETTES.acid),
  pyro: renderSpriteToCanvas(ELITE_LIGHT, PALETTES.pyro),
  bomber: renderSpriteToCanvas(ELITE_HEAVY, PALETTES.bomber),
  frostguard: renderSpriteToCanvas(ELITE_HEAVY, PALETTES.frostguard),
  plague: renderSpriteToCanvas(ELITE_HEAVY, PALETTES.plague),
  inferno: renderSpriteToCanvas(ELITE_HEAVY, PALETTES.inferno),
};

// Draw a sprite centered at (x, y), optionally flipped horizontally,
// scaled to roughly `targetWidth` px wide on screen.
function drawSprite(ctx, sprite, x, y, targetWidth, flip = false) {
  const scale = targetWidth / sprite.width;
  const w = sprite.width * scale;
  const h = sprite.height * scale;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(x, y);
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
  ctx.restore();
}

// Small pixelated gun that rotates to point at a target angle.
function drawGun(ctx, x, y, angle, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = '#12100a';
  ctx.fillRect(4, -3, 16, 6);
  ctx.fillStyle = color;
  ctx.fillRect(6, -2, 12, 4);
  ctx.restore();
}

// Finds a font size (and, as a last resort, a narrower fallback family) that
// fits `text` on a single line within maxWidth, shrinking rather than
// truncating. ctx.font is left set to the winning size/family on return.
function fitBubbleFont(ctx, text, maxWidth, baseSize, minSize) {
  let fontFamily = "'Press Start 2P', monospace";
  for (let size = baseSize; size >= minSize; size--) {
    ctx.font = `${size}px ${fontFamily}`;
    if (ctx.measureText(text).width <= maxWidth) return { fontSize: size, fontFamily };
  }
  // Still too wide even at the blocky pixel font's smallest readable size -
  // a compact sans-serif packs the same characters into less width.
  fontFamily = "'JetBrains Mono', monospace";
  for (let size = baseSize; size >= minSize - 2; size--) {
    ctx.font = `${size}px ${fontFamily}`;
    if (ctx.measureText(text).width <= maxWidth) return { fontSize: size, fontFamily };
  }
  const fontSize = minSize - 2;
  ctx.font = `${fontSize}px ${fontFamily}`;
  return { fontSize, fontFamily };
}

// Pixel-style speech bubble with a downward-pointing tail, anchored above
// (x, y) - the tip of the tail sits at (x, y). Fades via `alpha`. `big`
// (enemy boss lines) gets a larger box; `borderColor` lets callers distinguish
// enemy (gray), boss (magenta), and player (gold) bubbles independently.
// fontSize/fontFamily can be pre-computed once (see trySpawnSpeechBubble in
// game.js) and passed straight through, skipping fitBubbleFont's
// ctx.measureText search - it produces the same result every call for a
// given (text, big) pair, so there's no reason to redo it every frame.
function drawSpeechBubble(ctx, x, y, text, alpha, { big = false, borderColor = '#2c303a', fontSize, fontFamily } = {}) {
  ctx.save();
  if (fontSize && fontFamily) {
    ctx.font = `${fontSize}px ${fontFamily}`;
  } else {
    const maxWidth = big ? 230 : 175;
    const baseSize = big ? 12 : 9;
    const minSize = big ? 8 : 6;
    ({ fontSize, fontFamily } = fitBubbleFont(ctx, text, maxWidth, baseSize, minSize));
  }
  const padX = 10, padY = 7;
  const textWidth = ctx.measureText(text).width;
  const boxW = textWidth + padX * 2;
  const boxH = fontSize + padY * 2;
  const boxX = x - boxW / 2;
  const boxY = y - boxH;
  const r = 4;

  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(11,12,15,0.88)';
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = big ? 2 : 1;

  ctx.beginPath();
  ctx.moveTo(boxX + r, boxY);
  ctx.lineTo(boxX + boxW - r, boxY);
  ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + r, r);
  ctx.lineTo(boxX + boxW, boxY + boxH - r);
  ctx.arcTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH, r);
  ctx.lineTo(boxX + r, boxY + boxH);
  ctx.arcTo(boxX, boxY + boxH, boxX, boxY + boxH - r, r);
  ctx.lineTo(boxX, boxY + r);
  ctx.arcTo(boxX, boxY, boxX + r, boxY, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x - 5, boxY + boxH);
  ctx.lineTo(x + 5, boxY + boxH);
  ctx.lineTo(x, boxY + boxH + 6);
  ctx.closePath();
  ctx.fillStyle = 'rgba(11,12,15,0.88)';
  ctx.fill();

  ctx.fillStyle = '#eef0f3';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, boxY + boxH / 2);

  ctx.restore();
}
