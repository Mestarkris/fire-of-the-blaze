// ---------------------------------------------------------------------------
// Procedural sound engine (Web Audio API) - no audio files to load, everything
// below is synthesized so gunshots and the background loop ship with zero
// asset weight and zero licensing to worry about.
// ---------------------------------------------------------------------------

const GameAudio = (() => {
  let ctx = null;
  let masterGain, sfxGain, musicGain;
  let noiseBuffer = null;
  let muted = false;
  let musicPlaying = false;

  const NOTE_SEMITONES = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 };
  function freq(note, octave) {
    const semis = NOTE_SEMITONES[note] + (octave - 4) * 12;
    return 440 * Math.pow(2, semis / 12);
  }

  function ensureCtx() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 0.9;
    masterGain.connect(ctx.destination);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.8;
    sfxGain.connect(masterGain);

    musicGain = ctx.createGain();
    musicGain.gain.value = 0.3;
    musicGain.connect(masterGain);

    const len = ctx.sampleRate; // 1s of white noise, reused/sliced everywhere
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  function resume() {
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    startMusic();
  }

  ['pointerdown', 'keydown', 'touchstart'].forEach((evt) =>
    window.addEventListener(evt, resume, { once: true })
  );

  function toggleMute() {
    muted = !muted;
    if (masterGain) masterGain.gain.value = muted ? 0 : 0.9;
    if (muted) {
      activeVoiceNodes.forEach((n) => n.pause());
      activeVoiceNodes.clear();
    }
    return muted;
  }

  function noiseBurst(dest, time, duration, startGain, filterType, filterFreq) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(startGain, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + duration);
    let node = src;
    if (filterType) {
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = filterFreq;
      node.connect(f);
      node = f;
    }
    node.connect(g).connect(dest);
    src.start(time);
    src.stop(time + duration + 0.02);
  }

  // ---- gunshots ----------------------------------------------------------
  function playShot(kind) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const big = kind === 'rocket';
    const punchy = kind === 'shotgun';

    const osc = ctx.createOscillator();
    osc.type = big ? 'sawtooth' : 'square';
    const startFreq = big ? 220 : punchy ? 950 : 1100;
    const endFreq = big ? 55 : punchy ? 240 : 260;
    const dur = big ? 0.26 : punchy ? 0.12 : 0.09;
    osc.frequency.setValueAtTime(startFreq, t);
    osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(big ? 0.8 : punchy ? 0.65 : 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    osc.connect(g).connect(sfxGain);
    osc.start(t);
    osc.stop(t + dur + 0.02);

    noiseBurst(sfxGain, t, big ? 0.24 : punchy ? 0.09 : 0.045, big ? 0.7 : punchy ? 0.5 : 0.3);
  }

  // ---- continuous weapon sounds (electric beam / flamethrower) ----------
  let beamOsc = null, beamGain = null;
  function startBeamHum() {
    if (!ctx || beamOsc) return;
    beamOsc = ctx.createOscillator();
    beamOsc.type = 'sawtooth';
    beamOsc.frequency.value = 180;
    beamGain = ctx.createGain();
    beamGain.gain.value = 0;
    beamGain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 0.05);
    beamOsc.connect(beamGain).connect(sfxGain);
    beamOsc.start();
  }
  function stopBeamHum() {
    if (!beamOsc) return;
    const t = ctx.currentTime;
    beamGain.gain.linearRampToValueAtTime(0, t + 0.08);
    beamOsc.stop(t + 0.1);
    beamOsc = null;
    beamGain = null;
  }

  let flameSrc = null, flameGain = null;
  function startFlameHiss() {
    if (!ctx || flameSrc) return;
    flameSrc = ctx.createBufferSource();
    flameSrc.buffer = noiseBuffer;
    flameSrc.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500;
    flameGain = ctx.createGain();
    flameGain.gain.value = 0;
    flameGain.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 0.05);
    flameSrc.connect(filter).connect(flameGain).connect(sfxGain);
    flameSrc.start();
  }
  function stopFlameHiss() {
    if (!flameSrc) return;
    const t = ctx.currentTime;
    flameGain.gain.linearRampToValueAtTime(0, t + 0.08);
    flameSrc.stop(t + 0.1);
    flameSrc = null;
    flameGain = null;
  }

  // ---- pre-generated ElevenLabs voice line playback -----------------------
  // Real human-sounding audio files (see scripts/generate-voices.js), one per
  // dialogue line, preloaded once at game start and played via HTMLAudioElement
  // - up to a few can genuinely overlap now (unlike the single-utterance-at-a-
  // time SpeechSynthesis approach this replaced).
  const voiceCache = {}; // url -> preloaded Audio element (template, never played directly)
  const activeVoiceNodes = new Set(); // currently-playing clones, tracked so mute can stop them
  const MAX_CONCURRENT_VOICE = 4;
  let voiceVolume = 0.8;

  function preloadVoiceLines(urls) {
    urls.forEach((url) => {
      if (voiceCache[url]) return;
      const audio = new Audio(url);
      audio.preload = 'auto';
      audio.volume = voiceVolume;
      voiceCache[url] = audio;
    });
  }

  // isHighPriority (boss/player) lines always play, even over the concurrency
  // cap - only regular enemy lines get dropped under load. Missing/failed
  // files fail silently since the caller's speech bubble already shows the
  // text regardless of whether audio plays.
  function playVoiceLine(url, isHighPriority) {
    if (!url || muted) return;
    if (!isHighPriority && activeVoiceNodes.size >= MAX_CONCURRENT_VOICE) return;

    const template = voiceCache[url];
    const node = template ? template.cloneNode(true) : new Audio(url);
    node.volume = voiceVolume;
    activeVoiceNodes.add(node);
    const release = () => activeVoiceNodes.delete(node);
    node.addEventListener('ended', release, { once: true });
    node.addEventListener('error', release, { once: true });
    node.play().catch(release); // e.g. file missing or a stray autoplay block
  }

  // ---- background music ---------------------------------------------------
  // Driving 4-bar minor-key arpeggio loop (Am - F - C - G), scheduled ahead
  // of time per the standard Web Audio lookahead-scheduler pattern so timing
  // stays sample-accurate regardless of setTimeout jitter.
  const BPM = 132;
  const stepSec = 60 / BPM / 4; // 16th notes
  const CHORDS = [
    { bass: ['A', 2], arp: [['A', 4], ['C', 5], ['E', 5], ['C', 5]] },
    { bass: ['F', 2], arp: [['F', 4], ['A', 4], ['C', 5], ['A', 4]] },
    { bass: ['C', 3], arp: [['C', 4], ['E', 4], ['G', 4], ['E', 4]] },
    { bass: ['G', 2], arp: [['G', 3], ['B', 3], ['D', 4], ['B', 3]] },
  ];
  let currentBar = 0, currentStep = 0, nextNoteTime = 0, schedulerTimer = null;
  const lookaheadMs = 25;
  const scheduleAheadSec = 0.12;

  function playBassNote(noteOct, time) {
    const dur = stepSec * 8 * 0.92;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq(noteOct[0], noteOct[1]), time);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.5, time + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(g).connect(musicGain);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  }

  function playArpNote(noteOct, time) {
    const dur = stepSec * 0.85;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq(noteOct[0], noteOct[1]), time);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.2, time + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(g).connect(musicGain);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  }

  function playHat(time) {
    noiseBurst(musicGain, time, 0.03, 0.05, 'highpass', 6000);
  }

  function scheduleStep(barIdx, stepIdx, time) {
    const chord = CHORDS[barIdx % CHORDS.length];
    if (stepIdx === 0 || stepIdx === 8) playBassNote(chord.bass, time);
    playArpNote(chord.arp[stepIdx % chord.arp.length], time);
    if (stepIdx % 2 === 1) playHat(time);
  }

  function scheduler() {
    while (nextNoteTime < ctx.currentTime + scheduleAheadSec) {
      scheduleStep(currentBar, currentStep, nextNoteTime);
      nextNoteTime += stepSec;
      currentStep++;
      if (currentStep === 16) {
        currentStep = 0;
        currentBar++;
      }
    }
    schedulerTimer = setTimeout(scheduler, lookaheadMs);
  }

  function startMusic() {
    if (musicPlaying || !ctx) return;
    musicPlaying = true;
    currentBar = 0;
    currentStep = 0;
    nextNoteTime = ctx.currentTime + 0.05;
    scheduler();
  }

  return {
    resume,
    toggleMute,
    playShot,
    startBeamHum,
    stopBeamHum,
    startFlameHiss,
    stopFlameHiss,
    preloadVoiceLines,
    playVoiceLine,
  };
})();

window.GameAudio = GameAudio;
