#!/usr/bin/env node
// ---------------------------------------------------------------------------
// One-time voice generation script - NOT part of the live server.
//
// Reads DIALOGUE and PLAYER_LINES straight out of public/game.js (so this
// can never drift out of sync with the actual in-game text), calls the
// ElevenLabs text-to-speech API once per line, then pitch-shifts the result
// via ffmpeg (classic "tape speed" asetrate trick - the same technique behind
// chipmunk/deep-monster voices) so every line lands as an obviously toony,
// non-realistic character voice instead of a naturalistic human recording.
// Run manually:
//
//   node scripts/generate-voices.js
//
// Re-running is safe/cheap: existing files are skipped unless --force is
// passed, so editing one line and re-running only regenerates that file.
// ---------------------------------------------------------------------------

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const API_KEY = process.env.ELEVENLABS_API_KEY;
const GAME_JS_PATH = path.join(__dirname, '..', 'public', 'game.js');
const OUT_DIR = path.join(__dirname, '..', 'public', 'audio');
const TMP_RAW = path.join(OUT_DIR, '.tmp-raw.mp3');
const FORCE = process.argv.includes('--force');

const DELAY_MS = 400; // courtesy delay between API calls
const MODEL_ID = 'eleven_multilingual_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';

// One ElevenLabs premade voice per character (the account's free-tier default
// voices - the more characterful "shared library" voices like a witch/goblin/
// monster require a paid ElevenLabs plan for API access, so instead each of
// these gets pitch-shifted via ffmpeg below to land squarely in toony,
// non-realistic territory - the same "tape speed" trick behind classic
// chipmunk/deep-monster cartoon voices):
//   chaser  -> Callum  (N2lVS1w4EtoT3dr4eOWO) - "Husky Trickster", pitched down -> gruff goblin-ish
//   swarmer -> Laura   (FGY2WhTYpPnrIDTdsKH5) - "Enthusiast, Quirky", pitched way up -> squeaky critter
//   sniper  -> River   (SAz9YHcvj6GT2YYXdXww) - "Relaxed, Neutral", pitched down -> cold, hollow
//   dasher  -> Liam    (TX3LPaxmHKxFdv7VOQHJ) - "Energetic", pitched up -> frantic, chipmunk-ish
//   boss    -> Adam    (pNInz6obpgDQGcFmaJgB) - "Dominant, Firm", pitched way down -> deep monster/"granny villain" growl
//   player  -> Charlie (IKne3meq5aSn9XLyUdCD) - "Confident, Energetic", pitched slightly up -> bright cartoon hero
//   grunt   -> Harry   (SOYHLrjzK2X1ezoPC6cr) - "Fierce Warrior", pitched slightly up + wavery -> all bark, dies in one hit
//   brute   -> Brian   (nPczCjzI2devNBz1zQrb) - "Deep, Resonant", pitched down + steady -> heavy, deliberate weapons threat
const VOICES = {
  chaser: { id: 'N2lVS1w4EtoT3dr4eOWO', pitchFactor: 0.88, settings: { stability: 0.3, similarity_boost: 0.8, style: 0.7, speed: 1.05 } },
  swarmer: { id: 'FGY2WhTYpPnrIDTdsKH5', pitchFactor: 1.4, settings: { stability: 0.25, similarity_boost: 0.75, style: 0.8, speed: 1.15 } },
  sniper: { id: 'SAz9YHcvj6GT2YYXdXww', pitchFactor: 0.82, settings: { stability: 0.7, similarity_boost: 0.8, style: 0.2, speed: 0.9 } },
  dasher: { id: 'TX3LPaxmHKxFdv7VOQHJ', pitchFactor: 1.22, settings: { stability: 0.25, similarity_boost: 0.75, style: 0.85, speed: 1.2 } },
  boss: { id: 'pNInz6obpgDQGcFmaJgB', pitchFactor: 0.72, settings: { stability: 0.6, similarity_boost: 0.85, style: 0.6, speed: 0.85 } },
  player: { id: 'IKne3meq5aSn9XLyUdCD', pitchFactor: 1.1, settings: { stability: 0.45, similarity_boost: 0.8, style: 0.55, speed: 1.05 } },
  grunt: { id: 'SOYHLrjzK2X1ezoPC6cr', pitchFactor: 1.08, settings: { stability: 0.2, similarity_boost: 0.7, style: 0.65, speed: 1.1 } },
  brute: { id: 'nPczCjzI2devNBz1zQrb', pitchFactor: 0.78, settings: { stability: 0.55, similarity_boost: 0.85, style: 0.5, speed: 0.85 } },
};

// The classic "tape speed" pitch-shift: resampling at a different rate
// changes both pitch and tempo together (raising pitch also speeds it up,
// lowering it also slows it down) - exactly how chipmunk and deep-monster
// cartoon voices are traditionally made, which reads as far more "toony"
// than a formant-corrected pitch-only shift would.
function pitchShift(inputPath, outputPath, factor) {
  const nativeRate = 44100;
  const shiftedRate = Math.round(nativeRate * factor);
  execFileSync('ffmpeg', [
    '-y', '-i', inputPath,
    '-filter:a', `asetrate=${shiftedRate},aresample=${nativeRate}`,
    '-b:a', '128k',
    outputPath,
  ], { stdio: 'pipe' });
}

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
  fs.writeFileSync(TMP_RAW, buffer);
  pitchShift(TMP_RAW, path.join(OUT_DIR, job.file), job.voice.pitchFactor);
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

  fs.rmSync(TMP_RAW, { force: true });

  console.log('\n--- Summary ---');
  console.log(`Generated: ${generated}`);
  console.log(`Skipped (already existed): ${skipped}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  - ${f.file}: ${f.error}`));
  }
}

main();
