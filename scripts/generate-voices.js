#!/usr/bin/env node
// ---------------------------------------------------------------------------
// One-time voice generation script - NOT part of the live server.
//
// Reads DIALOGUE and PLAYER_LINES straight out of public/game.js (so this
// can never drift out of sync with the actual in-game text) and calls the
// ElevenLabs text-to-speech API once per line, saving each result as an mp3
// in public/audio/. Run manually:
//
//   node scripts/generate-voices.js
//
// Re-running is safe/cheap: existing files are skipped unless --force is
// passed, so editing one line and re-running only regenerates that file.
// ---------------------------------------------------------------------------

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ELEVENLABS_API_KEY;
const GAME_JS_PATH = path.join(__dirname, '..', 'public', 'game.js');
const OUT_DIR = path.join(__dirname, '..', 'public', 'audio');
const FORCE = process.argv.includes('--force');

const DELAY_MS = 400; // courtesy delay between API calls
const MODEL_ID = 'eleven_multilingual_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';

// One ElevenLabs premade voice per character, picked from the account's
// available voice library (fetched via GET /v2/voices) to match each
// personality described in the task:
//   chaser  -> Callum  (N2lVS1w4EtoT3dr4eOWO) - "Husky Trickster", gruff/aggressive
//   swarmer -> Laura   (FGY2WhTYpPnrIDTdsKH5) - "Enthusiast, Quirky Attitude", higher/quick
//   sniper  -> River   (SAz9YHcvj6GT2YYXdXww) - "Relaxed, Neutral, Informative", cold/controlled
//   dasher  -> Liam    (TX3LPaxmHKxFdv7VOQHJ) - "Energetic, Social Media Creator", fast-talking
//   boss    -> Adam    (pNInz6obpgDQGcFmaJgB) - "Dominant, Firm", deep/menacing
//   player  -> Charlie (IKne3meq5aSn9XLyUdCD) - "Deep, Confident, Energetic", distinct from all enemies
const VOICES = {
  chaser: { id: 'N2lVS1w4EtoT3dr4eOWO', settings: { stability: 0.35, similarity_boost: 0.8, style: 0.6, speed: 1.05 } },
  swarmer: { id: 'FGY2WhTYpPnrIDTdsKH5', settings: { stability: 0.3, similarity_boost: 0.75, style: 0.7, speed: 1.15 } },
  sniper: { id: 'SAz9YHcvj6GT2YYXdXww', settings: { stability: 0.75, similarity_boost: 0.8, style: 0.15, speed: 0.9 } },
  dasher: { id: 'TX3LPaxmHKxFdv7VOQHJ', settings: { stability: 0.3, similarity_boost: 0.75, style: 0.75, speed: 1.2 } },
  boss: { id: 'pNInz6obpgDQGcFmaJgB', settings: { stability: 0.65, similarity_boost: 0.85, style: 0.5, speed: 0.85 } },
  player: { id: 'IKne3meq5aSn9XLyUdCD', settings: { stability: 0.5, similarity_boost: 0.8, style: 0.45, speed: 1.05 } },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Extracts `const NAME = { ... };` verbatim out of game.js by brace-matching
// (regex alone can't reliably find the matching closing brace of a nested
// object), then safely evaluates just that object literal - it's plain
// string arrays with no external references, so this is safe here even
// though eval-ing arbitrary text normally wouldn't be.
function extractConst(source, name) {
  const marker = `const ${name} = {`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`Could not find "${marker}" in game.js`);
  const braceStart = start + marker.length - 1;
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`Could not find matching closing brace for ${name}`);
  const literal = source.slice(braceStart, end);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${literal});`)();
}

function buildJobs() {
  const source = fs.readFileSync(GAME_JS_PATH, 'utf8');
  const DIALOGUE = extractConst(source, 'DIALOGUE');
  const PLAYER_LINES = extractConst(source, 'PLAYER_LINES');

  const jobs = [];

  Object.entries(DIALOGUE).forEach(([type, moments]) => {
    Object.entries(moments).forEach(([moment, lines]) => {
      lines.forEach((text, i) => {
        jobs.push({
          file: `${type}_${moment}_${i + 1}.mp3`,
          text,
          voice: VOICES[type],
        });
      });
    });
  });

  Object.entries(PLAYER_LINES).forEach(([pool, lines]) => {
    lines.forEach((text, i) => {
      jobs.push({
        file: `player_${pool}_${i + 1}.mp3`,
        text,
        voice: VOICES.player,
      });
    });
  });

  return jobs;
}

async function generateOne(job) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${job.voice.id}?output_format=${OUTPUT_FORMAT}`, {
    method: 'POST',
    headers: {
      'xi-api-key': API_KEY,
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: job.text,
      model_id: MODEL_ID,
      voice_settings: job.voice.settings,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(OUT_DIR, job.file), buffer);
}

async function main() {
  if (!API_KEY) {
    console.error('Missing ELEVENLABS_API_KEY in .env - see .env.example.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const jobs = buildJobs();
  console.log(`Found ${jobs.length} dialogue lines to generate.\n`);

  const failed = [];
  let generated = 0;
  let skipped = 0;

  for (const job of jobs) {
    const outPath = path.join(OUT_DIR, job.file);
    if (!FORCE && fs.existsSync(outPath)) {
      skipped++;
      console.log(`Skipping ${job.file} (already exists)`);
      continue;
    }

    try {
      await generateOne(job);
      generated++;
      console.log(`Generated ${job.file}`);
    } catch (err) {
      console.warn(`First attempt failed for ${job.file}: ${err.message} - retrying once...`);
      await sleep(DELAY_MS);
      try {
        await generateOne(job);
        generated++;
        console.log(`Generated ${job.file} (on retry)`);
      } catch (err2) {
        console.warn(`Skipping ${job.file} after retry also failed: ${err2.message}`);
        failed.push({ file: job.file, error: err2.message });
      }
    }

    await sleep(DELAY_MS);
  }

  console.log('\n--- Summary ---');
  console.log(`Generated: ${generated}`);
  console.log(`Skipped (already existed): ${skipped}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  - ${f.file}: ${f.error}`));
  }
}

main();
