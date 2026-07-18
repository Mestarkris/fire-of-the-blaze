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

// Breaks text into lines no wider than maxWidth (word-wrap), since canvas
// text has no built-in wrapping. ctx.font must already be set before calling.
function wrapBubbleText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  words.forEach((word) => {
    const test = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(test).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  });
  if (current) lines.push(current);
  return lines;
}

// Pixel-style speech bubble with a downward-pointing tail, anchored above
// (x, y) - the tip of the tail sits at (x, y). Fades via `alpha`; bosses get
// a bigger, magenta-bordered variant so their lines read as more special.
function drawSpeechBubble(ctx, x, y, text, alpha, isBoss) {
  const fontSize = isBoss ? 11 : 8;
  ctx.save();
  ctx.font = `${fontSize}px 'Press Start 2P', monospace`;
  const maxWidth = isBoss ? 190 : 130;
  const lines = wrapBubbleText(ctx, text, maxWidth);
  const lineHeight = fontSize + 6;
  const padX = 10, padY = 7;
  const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const boxW = textWidth + padX * 2;
  const boxH = lines.length * lineHeight + padY * 2 - (lineHeight - fontSize);
  const boxX = x - boxW / 2;
  const boxY = y - boxH;
  const r = 4;

  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(11,12,15,0.88)';
  ctx.strokeStyle = isBoss ? '#ff3d7f' : '#2c303a';
  ctx.lineWidth = isBoss ? 2 : 1;

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
  lines.forEach((line, i) => {
    ctx.fillText(line, x, boxY + padY + lineHeight * i + fontSize / 2);
  });

  ctx.restore();
}
