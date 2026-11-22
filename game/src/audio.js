// All sound is synthesised with the WebAudio API: no files, no network. One audio context is
// created on the first key press or click (browsers require a gesture), and every effect is a
// short-lived oscillator or noise burst. The engine is a continuous sawtooth pair whose pitch
// tracks the car's speed; the siren is a two-tone square wave while police are chasing.

const SILENT = {
  unlock() {},
  setMuted() {},
  muted() { return true; },
  engine() {},
  siren() {},
  blip() {},
  crash() {},
  jingle() {},
  sting() {},
  click() {},
  skid() {},
};

export function createAudio() {
  let ctx = null;
  let master = null;
  let engineGain = null;
  let engineOsc = null;
  let engineSub = null;
  let sirenGain = null;
  let sirenOsc = null;
  let noiseBuffer = null;
  let isMuted = false;
  let engineLevel = 0;
  let sirenLevel = 0;
  let sirenPhase = 0;

  function noise() {
    if (!noiseBuffer || !ctx) return null;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    return src;
  }

  function unlock() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = isMuted ? 0 : 0.75;
    master.connect(ctx.destination);

    noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.7), ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

    // Engine: two detuned saws through a lowpass, gain 0 until a car is being driven.
    engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 780;
    engineOsc = ctx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 62;
    engineSub = ctx.createOscillator();
    engineSub.type = 'square';
    engineSub.frequency.value = 31;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.35;
    engineOsc.connect(engineFilter);
    engineSub.connect(subGain).connect(engineFilter);
    engineFilter.connect(engineGain).connect(master);
    engineOsc.start();
    engineSub.start();

    // Siren: a square wave whose pitch is swept by hand in update().
    sirenGain = ctx.createGain();
    sirenGain.gain.value = 0;
    sirenOsc = ctx.createOscillator();
    sirenOsc.type = 'square';
    sirenOsc.frequency.value = 720;
    const sirenFilter = ctx.createBiquadFilter();
    sirenFilter.type = 'bandpass';
    sirenFilter.frequency.value = 900;
    sirenFilter.Q.value = 1.2;
    sirenOsc.connect(sirenFilter).connect(sirenGain).connect(master);
    sirenOsc.start();
  }

  function setMuted(value) {
    isMuted = value;
    if (master && ctx) master.gain.setTargetAtTime(isMuted ? 0 : 0.75, ctx.currentTime, 0.05);
  }

  /** Engine load 0..1 with the pitch key; call every frame with the current driving state. */
  function engine(active, speedRatio) {
    if (!ctx) return;
    const target = active ? 0.14 + speedRatio * 0.1 : 0;
    engineLevel += (target - engineLevel) * 0.12;
    engineGain.gain.setTargetAtTime(engineLevel, ctx.currentTime, 0.06);
    if (active) {
      const base = 55 + speedRatio * 150;
      engineOsc.frequency.setTargetAtTime(base, ctx.currentTime, 0.08);
      engineSub.frequency.setTargetAtTime(base * 0.5, ctx.currentTime, 0.08);
    }
  }

  /** Siren 0..1: two-tone sweep, louder the closer the nearest unit. */
  function siren(level, dt) {
    if (!ctx) return;
    sirenLevel += (level - sirenLevel) * 0.1;
    sirenGain.gain.setTargetAtTime(sirenLevel * 0.1, ctx.currentTime, 0.08);
    if (sirenLevel > 0.005) {
      sirenPhase = (sirenPhase + dt * 0.85) % 1;
      const tri = sirenPhase < 0.5 ? sirenPhase * 2 : 2 - sirenPhase * 2;
      sirenOsc.frequency.setTargetAtTime(520 + tri * 420, ctx.currentTime, 0.02);
    }
  }

  function tone(freq, duration, type, volume, when, slideTo) {
    if (!ctx) return;
    const start = ctx.currentTime + (when ?? 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type ?? 'square';
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume ?? 0.2, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }

  function burst(duration, volume, frequency, q) {
    if (!ctx) return;
    const src = noise();
    if (!src) return;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = frequency ?? 700;
    filter.Q.value = q ?? 0.8;
    const gain = ctx.createGain();
    const start = ctx.currentTime;
    gain.gain.setValueAtTime(volume ?? 0.3, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    src.connect(filter).connect(gain).connect(master);
    src.start(start);
    src.stop(start + duration + 0.02);
  }

  return {
    unlock,
    setMuted,
    muted: () => isMuted,
    engine,
    siren,
    blip() {
      tone(880, 0.09, 'triangle', 0.16);
      tone(1320, 0.1, 'triangle', 0.12, 0.06);
    },
    crash(intensity) {
      const level = Math.min(0.5, 0.12 + (intensity ?? 0.4) * 0.4);
      burst(0.26, level, 420, 0.6);
      tone(80, 0.18, 'sine', level * 0.7, 0, 45);
    },
    skid() {
      burst(0.14, 0.05, 2400, 2.5);
    },
    jingle() {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      for (let i = 0; i < notes.length; i += 1) tone(notes[i], 0.22, 'triangle', 0.14, i * 0.09);
    },
    sting() {
      tone(220, 0.5, 'sawtooth', 0.2, 0, 90);
      tone(165, 0.7, 'square', 0.12, 0.08, 70);
      burst(0.4, 0.2, 320, 0.7);
    },
    click() {
      tone(420, 0.05, 'square', 0.07);
    },
  };
}

export const silentAudio = SILENT;
