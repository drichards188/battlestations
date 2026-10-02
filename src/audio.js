// Fully procedural audio: every sound here is synthesized with WebAudio.
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
    this.musicVolume = 0.5;
    this.muted = false;
    this.nextBird = 0;
    this.nextCricket = 0;
    this.nextChord = 0;
    this.nextNote = 0;
    this.chordIndex = 0;
    this.state = { day: 1, night: 0, rain: 0, wind: 1, water: 0, underwater: false, activated: 0, dread: 0 };
  }

  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(this.muffle).connect(comp).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(3.2, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.9;
    this.reverbSend.connect(this.reverb).connect(this.master);

    this.amb = ctx.createGain();
    this.amb.connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = this.musicVolume * 0.5;
    this.music.connect(this.master);
    this.musicVerb = ctx.createGain();
    this.musicVerb.gain.value = 0.7;
    this.music.connect(this.musicVerb).connect(this.reverbSend);

    this.white = this.noiseBuffer('white');
    this.brown = this.noiseBuffer('brown');

    // wind
    this.windSrc = this.loop(this.brown);
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter).connect(this.windGain).connect(this.amb);

    // rain: hiss plus a low body
    this.rainSrc = this.loop(this.white);
    const rhp = ctx.createBiquadFilter();
    rhp.type = 'highpass';
    rhp.frequency.value = 900;
    const rlp = ctx.createBiquadFilter();
    rlp.type = 'lowpass';
    rlp.frequency.value = 7500;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.rainSrc.connect(rhp).connect(rlp).connect(this.rainGain).connect(this.amb);
    this.rainLowSrc = this.loop(this.brown);
    const rl2 = ctx.createBiquadFilter();
    rl2.type = 'lowpass';
    rl2.frequency.value = 350;
    this.rainLowGain = ctx.createGain();
    this.rainLowGain.gain.value = 0;
    this.rainLowSrc.connect(rl2).connect(this.rainLowGain).connect(this.amb);

    // water lapping at the shore
    this.waterSrc = this.loop(this.brown);
    this.waterFilter = ctx.createBiquadFilter();
    this.waterFilter.type = 'lowpass';
    this.waterFilter.frequency.value = 600;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    this.waterSrc.connect(this.waterFilter).connect(this.waterGain).connect(this.amb);

    // crystal hum, positioned at the monument
    this.hum = ctx.createGain();
    this.hum.gain.value = 0.18;
    const humLp = ctx.createBiquadFilter();
    humLp.type = 'lowpass';
    humLp.frequency.value = 900;
    this.humPanner = this.panner(4, 1.1);
    for (const [f, g] of [[110, 0.5], [165.2, 0.3], [220.6, 0.25], [330.1, 0.1]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.1 + Math.random() * 0.2;
      const lg = ctx.createGain();
      lg.gain.value = g * 0.4;
      lfo.connect(lg).connect(og.gain);
      o.connect(og).connect(humLp);
      o.start();
      lfo.start();
    }
    humLp.connect(this.hum).connect(this.humPanner).connect(this.amb);
    this.humPanner.connect(this.reverbSend);

    // dread: a low, beating drone and breathy whispers while shades close in
    this.dread = ctx.createGain();
    this.dread.gain.value = 0;
    this.dread.connect(this.amb);
    this.dread.connect(this.reverbSend);
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 320;
    dlp.connect(this.dread);
    for (const f of [41.2, 43.65, 61.7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = 0.25;
      o.connect(og).connect(dlp);
      o.start();
    }
    this.whisperSrc = this.loop(this.white);
    const wbp = ctx.createBiquadFilter();
    wbp.type = 'bandpass';
    wbp.frequency.value = 1400;
    wbp.Q.value = 3;
    const wlfo = ctx.createOscillator();
    wlfo.frequency.value = 0.7;
    const wlg = ctx.createGain();
    wlg.gain.value = 700;
    wlfo.connect(wlg).connect(wbp.frequency);
    wlfo.start();
    const wg = ctx.createGain();
    wg.gain.value = 0.18;
    this.whisperSrc.connect(wbp).connect(wg).connect(this.dread);
  }

  noiseBuffer(type) {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (type === 'brown') {
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.5;
        } else d[i] = w;
      }
    }
    return buf;
  }

  impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  loop(buffer) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.loopStart = Math.random();
    s.start(0, Math.random() * 3);
    return s;
  }

  panner(ref = 5, rolloff = 1) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = 10000;
    return p;
  }

  setPannerPos(p, x, y, z) {
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else p.setPosition(x, y, z);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }

  setMusicVolume(v) {
    this.musicVolume = v;
    if (this.music) this.music.gain.value = v * 0.5;
  }

  toggleMute() {
    this.muted = !this.muted;
    this.setVolume(this.volume);
    return this.muted;
  }

  // ------------------------------------------------------------------ one-shots

  noiseBurst({ dur = 0.08, freq = 1500, q = 0.8, type = 'bandpass', gain = 0.3, dest = this.sfx, at = 0, attack = 0.005 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t0, Math.random() * 3);
    src.stop(t0 + dur + 0.05);
    return { f, g, t0 };
  }

  footstep(surface, intensity = 1) {
    if (!this.ctx) return;
    const v = 0.5 + Math.random() * 0.3;
    if (surface === 'stone') {
      this.noiseBurst({ dur: 0.07, freq: 380 + Math.random() * 120, q: 1.2, gain: 0.35 * intensity * v });
      this.noiseBurst({ dur: 0.03, freq: 3200, q: 2, gain: 0.08 * intensity * v });
    } else if (surface === 'water') {
      const b = this.noiseBurst({ dur: 0.3, freq: 700, q: 0.6, type: 'lowpass', gain: 0.35 * intensity * v, attack: 0.03 });
      b.f.frequency.exponentialRampToValueAtTime(250, b.t0 + 0.3);
    } else {
      // grass swish plus a soft thump
      this.noiseBurst({ dur: 0.12, freq: 2200 + Math.random() * 1500, q: 0.5, gain: 0.12 * intensity * v, attack: 0.02 });
      this.noiseBurst({ dur: 0.08, freq: 160, q: 0.7, type: 'lowpass', gain: 0.4 * intensity * v });
    }
  }

  land(strength) {
    if (!this.ctx) return;
    this.noiseBurst({ dur: 0.18, freq: 120, q: 0.7, type: 'lowpass', gain: 0.6 * strength });
    this.noiseBurst({ dur: 0.1, freq: 1800, q: 0.6, gain: 0.12 * strength });
  }

  splash() {
    if (!this.ctx) return;
    const b = this.noiseBurst({ dur: 0.7, freq: 1600, q: 0.4, type: 'lowpass', gain: 0.5, attack: 0.01 });
    b.f.frequency.exponentialRampToValueAtTime(300, b.t0 + 0.7);
  }

  bell(note, at = 0, gain = 0.2, dest = this.sfx, len = 2.2) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + at;
    const f = midi(note);
    for (const [ratio, amp] of [[1, 1], [2.756, 0.35], [5.404, 0.15], [0.5, 0.25]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain * amp, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + len / ratio + 0.2);
      o.connect(g);
      g.connect(dest);
      g.connect(this.reverbSend);
      o.start(t0);
      o.stop(t0 + len + 0.5);
    }
  }

  pickup(count) {
    if (!this.ctx) return;
    const base = 72 + [0, 2, 4, 7, 9, 12, 14][Math.min(count - 1, 6)];
    [0, 4, 7, 12].forEach((s, i) => this.bell(base + s, i * 0.09, 0.14));
    const w = this.noiseBurst({ dur: 1.2, freq: 600, q: 1.5, gain: 0.12, attack: 0.3 });
    w.f.frequency.exponentialRampToValueAtTime(5000, w.t0 + 1.1);
  }

  deliver() {
    if (!this.ctx) return;
    this.bell(55, 0, 0.18, this.sfx, 4);
    this.bell(62, 0.05, 0.1, this.sfx, 4);
  }

  finale() {
    if (!this.ctx) return;
    const chord = [50, 57, 62, 66, 69, 74, 78, 81];
    chord.forEach((n, i) => this.bell(n, i * 0.12, 0.12, this.sfx, 6));
    this.pad([50, 57, 62, 66, 69], 14, 0.09);
    const b = this.noiseBurst({ dur: 5, freq: 200, q: 0.5, gain: 0.35, attack: 1.5 });
    b.f.frequency.exponentialRampToValueAtTime(3000, b.t0 + 4);
  }

  orbThrow() {
    if (!this.ctx) return;
    const w = this.noiseBurst({ dur: 0.35, freq: 900, q: 1.2, gain: 0.14, attack: 0.04 });
    w.f.frequency.exponentialRampToValueAtTime(3500, w.t0 + 0.3);
    this.bell(86, 0.02, 0.05, this.sfx, 1.2);
  }

  orbBounce(k, dist) {
    if (!this.ctx) return;
    const near = Math.max(0, 1 - dist / 60);
    if (near <= 0) return;
    this.bell(88 + Math.floor(Math.random() * 3) * 2, 0, 0.035 * k * near, this.sfx, 0.7);
    this.noiseBurst({ dur: 0.05, freq: 300, q: 0.8, type: 'lowpass', gain: 0.25 * k * near });
  }

  shadeHit() {
    if (!this.ctx) return;
    this.noiseBurst({ dur: 0.5, freq: 140, q: 0.6, type: 'lowpass', gain: 0.8, attack: 0.01 });
    const s = this.noiseBurst({ dur: 1.1, freq: 2600, q: 2, gain: 0.18, attack: 0.02 });
    s.f.frequency.exponentialRampToValueAtTime(400, s.t0 + 1);
    [37, 38, 44].forEach((n, i) => this.bell(n, i * 0.02, 0.09, this.sfx, 2.5));
  }

  banish() {
    if (!this.ctx) return;
    const s = this.noiseBurst({ dur: 0.9, freq: 300, q: 1.5, gain: 0.22, attack: 0.25 });
    s.f.frequency.exponentialRampToValueAtTime(6000, s.t0 + 0.8);
    [81, 88, 93].forEach((n, i) => this.bell(n, 0.25 + i * 0.07, 0.07, this.sfx, 2));
  }

  fallDark() {
    if (!this.ctx) return;
    const r = this.noiseBurst({ dur: 3, freq: 400, q: 0.5, type: 'lowpass', gain: 0.9, attack: 0.05 });
    r.f.frequency.exponentialRampToValueAtTime(40, r.t0 + 2.8);
    [26, 33, 38].forEach((n, i) => this.bell(n, i * 0.05, 0.15, this.sfx, 5));
  }

  thunder(dist) {
    if (!this.ctx) return;
    const delay = Math.min(dist / 343, 3.5);
    const near = Math.max(0, 1 - dist / 900);
    if (near > 0.3) this.noiseBurst({ dur: 0.35, freq: 2500, q: 0.4, type: 'highpass', gain: 0.4 * near, at: delay });
    const r = this.noiseBurst({ dur: 5.5, freq: 180, q: 0.5, type: 'lowpass', gain: 0.9 * (0.4 + near), at: delay + 0.05, attack: 0.15 });
    r.f.frequency.setValueAtTime(400, r.t0);
    r.f.frequency.exponentialRampToValueAtTime(60, r.t0 + 5);
  }

  birdCall() {
    const ctx = this.ctx;
    const p = this.panner(8, 1);
    const a = Math.random() * Math.PI * 2, r = 15 + Math.random() * 40;
    const l = this.listenerPos || { x: 0, y: 0, z: 0 };
    this.setPannerPos(p, l.x + Math.cos(a) * r, l.y + 4 + Math.random() * 10, l.z + Math.sin(a) * r);
    p.connect(this.amb);
    p.connect(this.reverbSend);
    const t0 = ctx.currentTime + 0.05;
    const kind = Math.floor(Math.random() * 3);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(p);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.connect(g);
    let end = t0;
    if (kind === 0) {
      // repeated rising whistle
      const reps = 2 + Math.floor(Math.random() * 3);
      const f0 = 2200 + Math.random() * 1200;
      for (let i = 0; i < reps; i++) {
        const s = t0 + i * 0.22;
        o.frequency.setValueAtTime(f0, s);
        o.frequency.exponentialRampToValueAtTime(f0 * 1.45, s + 0.12);
        g.gain.setValueAtTime(0, s);
        g.gain.linearRampToValueAtTime(0.06, s + 0.02);
        g.gain.linearRampToValueAtTime(0, s + 0.14);
        end = s + 0.2;
      }
    } else if (kind === 1) {
      // trill via frequency modulation
      const m = ctx.createOscillator();
      m.frequency.value = 28 + Math.random() * 20;
      const mg = ctx.createGain();
      mg.gain.value = 500;
      m.connect(mg).connect(o.frequency);
      o.frequency.value = 3600 + Math.random() * 800;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.04, t0 + 0.05);
      g.gain.linearRampToValueAtTime(0, t0 + 0.6);
      m.start(t0);
      m.stop(t0 + 0.7);
      end = t0 + 0.65;
    } else {
      // two-note "tee-too"
      const f0 = 3000 + Math.random() * 800;
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.setValueAtTime(f0 * 0.75, t0 + 0.2);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.05, t0 + 0.02);
      g.gain.linearRampToValueAtTime(0.02, t0 + 0.18);
      g.gain.linearRampToValueAtTime(0.05, t0 + 0.22);
      g.gain.linearRampToValueAtTime(0, t0 + 0.42);
      end = t0 + 0.45;
    }
    o.start(t0);
    o.stop(end + 0.05);
  }

  cricket() {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.02;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 2 - 1;
    pan.connect(this.amb);
    const o = ctx.createOscillator();
    o.frequency.value = 4300 + Math.random() * 700;
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(g).connect(pan);
    const vol = 0.012 + Math.random() * 0.02;
    for (let i = 0; i < 3; i++) {
      const s = t0 + i * 0.05;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(vol, s + 0.008);
      g.gain.linearRampToValueAtTime(0, s + 0.03);
    }
    o.start(t0);
    o.stop(t0 + 0.2);
  }

  // ------------------------------------------------------------------ music

  pad(notes, dur, gain = 0.05) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.05;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, t0);
    lp.frequency.linearRampToValueAtTime(1300, t0 + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(600, t0 + dur);
    lp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + dur * 0.35);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    lp.connect(g).connect(this.music);
    for (const n of notes) {
      for (const det of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midi(n);
        o.detune.value = det;
        const og = ctx.createGain();
        og.gain.value = 0.18 / notes.length;
        o.connect(og).connect(lp);
        o.start(t0);
        o.stop(t0 + dur + 0.1);
      }
    }
  }

  updateMusic() {
    const now = this.ctx.currentTime;
    // D major / B minor ambient progression
    const chords = [
      [38, 50, 57, 62, 66, 69],
      [45, 52, 57, 61, 64, 71],
      [47, 50, 54, 59, 62, 66],
      [43, 50, 55, 59, 62, 69],
    ];
    if (now >= this.nextChord) {
      const c = chords[this.chordIndex % chords.length];
      this.pad(c, 13, 0.05 + this.state.activated * 0.03);
      this.chordIndex++;
      this.nextChord = now + 9.5;
    }
    if (now >= this.nextNote) {
      const scale = [62, 64, 66, 69, 71, 74, 76, 78, 81];
      const n = scale[Math.floor(Math.random() * scale.length)];
      this.bell(n, 0, 0.035 + Math.random() * 0.02, this.music, 3);
      if (Math.random() < 0.3) this.bell(n + (Math.random() < 0.5 ? 3 : 5), 0.3, 0.025, this.music, 3);
      this.nextNote = now + 2.5 + Math.random() * 5;
    }
  }

  // ------------------------------------------------------------------ per frame

  update(dt, camera, s, humPos) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    Object.assign(this.state, s);
    const st = this.state;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const L = ctx.listener;
    const p = camera.position;
    this.listenerPos = p;
    const f = camera.getWorldDirection(this._fwd || (this._fwd = p.clone()));
    if (L.positionX) {
      L.positionX.value = p.x;
      L.positionY.value = p.y;
      L.positionZ.value = p.z;
      L.forwardX.value = f.x;
      L.forwardY.value = f.y;
      L.forwardZ.value = f.z;
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    } else {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }
    if (humPos) this.setPannerPos(this.humPanner, humPos.x, humPos.y, humPos.z);
    this.hum.gain.setTargetAtTime(0.16 + st.activated * 0.3, now, 0.5);

    const gust = 0.5 + 0.5 * Math.sin(now * 0.31) * Math.sin(now * 0.17 + 1);
    const alt = Math.min(Math.max((p.y - 20) / 100, 0), 1);
    this.windGain.gain.setTargetAtTime((0.05 + 0.07 * st.wind * gust) * (1 + alt * 1.5) * (st.underwater ? 0.1 : 1), now, 0.3);
    this.windFilter.frequency.setTargetAtTime(250 + gust * 500 * st.wind + alt * 300, now, 0.3);
    this.rainGain.gain.setTargetAtTime(st.rain * 0.22, now, 0.5);
    this.rainLowGain.gain.setTargetAtTime(st.rain * 0.25, now, 0.5);
    const lap = 0.5 + 0.5 * Math.sin(now * 0.9) * Math.sin(now * 0.37);
    this.waterGain.gain.setTargetAtTime(st.water * 0.25 * (0.4 + 0.6 * lap), now, 0.2);
    this.muffle.frequency.setTargetAtTime(st.underwater ? 450 : 20000, now, 0.1);
    this.dread.gain.setTargetAtTime(st.dread * st.dread * 0.35, now, 0.4);

    if (st.day > 0.3 && st.rain < 0.3 && now > this.nextBird) {
      this.birdCall();
      this.nextBird = now + 1.5 + Math.random() * 5 / st.day;
    }
    if (st.night > 0.4 && st.rain < 0.3 && now > this.nextCricket) {
      this.cricket();
      this.nextCricket = now + 0.08 + Math.random() * 0.5;
    }
    if (this.musicVolume > 0) this.updateMusic();
  }
}
