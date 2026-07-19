// ─────────────────────────────────────────────────────────────────────────────
// sound.js — the audio engine. A small Web Audio mixer with HTMLAudio fallback.
//
// Capabilities (all data-driven via manifest.config.sound + the sound components):
//   • one-shot SFX            play(ref, opts?)        — buffer, re-triggerable
//   • looping SFX             loop(ref, opts?)        — buffer, returns a handle
//   • background music/tracks music(src, opts?)       — streamed, fades, multiple
//   • 3D / spatial audio      opts.spatial/position   — a PannerNode positions a
//                                                       sound from a SCREEN point
//                                                       (e.g. a thing on the canvas)
//   • independent levels      sfxBus / musicBus       — under one mute-able master
//
// Graph:  source → perShotGain → [panner|stereoPanner] → sfxBus  ┐
//         <audio> → mediaSource → trackGain ───────────→ musicBus ┤→ master → out
//
// WHY Web Audio over cloneNode(): the old impl cloned an <audio> per shot; a rapid
// emitter (the grid roll, ~25×/3s) allocated 25 media elements that lingered until
// GC → split-second main-thread stalls. AudioBufferSourceNodes are one-shots by
// design: cheap, self-releasing, spatializable. HTMLAudio remains as a FALLBACK
// (no Web Audio, or the brief window before a clip finishes decoding) and as the
// streaming source for long music tracks. .mp3 only (Safari can't decode Ogg).
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: true,
  basePath: './assets/audio/',
  volume: 0.4,        // SFX bus level
  musicVolume: 0.6,   // music bus level
  map: { click: 'click.mp3', success: 'success.mp3', error: 'error.mp3' },
  // how a SCREEN point maps into the 3D audio scene (listener at origin, facing −z)
  spatial: {
    panningModel: 'HRTF',   // 'HRTF' = rich (best on headphones) | 'equalpower' = cheap
    distanceModel: 'inverse',
    spreadX: 5,             // half-width of the audio field at the screen plane
    spreadY: 2.5,          // half-height
    depth: 4,              // listener↔screen distance (= refDistance: centre = full vol)
    rolloff: 0.6,          // how fast volume falls with distance
    maxDistance: 40,
  },
};

export function initSound({ config = {}, bus }) {
  const cfg = {
    ...DEFAULTS, ...config,
    map: { ...DEFAULTS.map, ...(config.map || {}) },
    spatial: { ...DEFAULTS.spatial, ...(config.spatial || {}) },
  };
  let muted = cfg.enabled === false;
  const SP = cfg.spatial;

  // ── audio context + mixer buses ──────────────────────────────────────────────
  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = AC ? new AC() : null;
  let master = null, sfxBus = null, musicBus = null;
  if (actx) {
    master = actx.createGain(); master.gain.value = muted ? 0 : 1; master.connect(actx.destination);
    sfxBus = actx.createGain(); sfxBus.gain.value = cfg.volume; sfxBus.connect(master);
    musicBus = actx.createGain(); musicBus.gain.value = cfg.musicVolume; musicBus.connect(master);
    setListener(actx, 0, 0, 0); // origin, facing into the screen (−z), up +y
  }

  // ── buffer + fallback stores ─────────────────────────────────────────────────
  const bufByUrl = {};      // resolved url → decoded AudioBuffer
  const revByUrl = {};      // resolved url → REVERSED copy of that buffer (cached)
  const loadingByUrl = {};  // resolved url → Promise<AudioBuffer> (in-flight)
  const nameToUrl = {};     // mapped name → url

  // Play a buffer backwards. Web Audio has no negative playbackRate, so "reverse" =
  // a buffer whose samples are flipped per channel. Cached by url → computed once,
  // so playing one clip forward (zoom in) and reversed (zoom out) costs one reversal.
  function reversedBuffer(url, buf) {
    if (revByUrl[url]) return revByUrl[url];
    const rb = actx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const s = buf.getChannelData(ch), d = rb.getChannelData(ch);
      for (let i = 0, n = buf.length; i < n; i++) d[i] = s[n - 1 - i];
    }
    revByUrl[url] = rb;
    return rb;
  }
  const pool = {};          // mapped name → preloaded HTMLAudio (fallback)

  const url4 = (ref) => {
    if (!ref) return null;
    if (nameToUrl[ref]) return nameToUrl[ref];
    if (cfg.map[ref]) return cfg.basePath + cfg.map[ref];
    if (/^(\.|\/|https?:|data:)/.test(ref) || ref.includes('/') || /\.(mp3|wav|m4a|aac|ogg)$/i.test(ref)) return ref;
    return `${cfg.basePath}${ref}.mp3`; // bare token → an .mp3 under basePath (Safari = mp3)
  };

  function ensureBuffer(ref) {
    const url = url4(ref);
    if (!actx || !url) return Promise.reject(new Error('no audio context'));
    if (bufByUrl[url]) return Promise.resolve(bufByUrl[url]);
    if (loadingByUrl[url]) return loadingByUrl[url];
    const p = fetch(url)
      .then((r) => r.arrayBuffer())
      // PROMISE form (Safari 14.1+/all Chrome). The callback form ALSO returns a
      // promise in modern browsers; passing callbacks left it unhandled → an
      // "Unhandled rejection: Decoding failed" on every undecodable file. One chain.
      .then((ab) => actx.decodeAudioData(ab))
      .then((d) => { bufByUrl[url] = d; return d; });
    loadingByUrl[url] = p.catch((e) => { delete loadingByUrl[url]; throw e; });
    return loadingByUrl[url];
  }

  // preload mapped SFX: an HTMLAudio fallback each, and decode into a buffer.
  for (const [name, file] of Object.entries(cfg.map)) {
    const url = cfg.basePath + file;
    nameToUrl[name] = url;
    const a = new Audio(url); a.preload = 'auto'; a.volume = cfg.volume; pool[name] = a;
    if (actx) ensureBuffer(name).catch(() => {});
  }

  // AudioContext boots 'suspended' until a user gesture; resume on first interaction.
  function resume() { if (actx && actx.state === 'suspended') actx.resume().catch(() => {}); }

  // iOS WebKit gotcha: an AudioBufferSourceNode .start()ed while the context is
  // SUSPENDED is silently DROPPED — it stays mute even after a later resume(). (iPad
  // Safari AND Chrome are both WebKit, so both hit this.) So buffer loops must not
  // start until the context is genuinely 'running'. whenRunning() runs fn now if
  // already running (desktop / once unlocked → no behaviour change), else queues it
  // and flushes on the statechange → 'running' — which fires when the global
  // pointerdown handler below resumes the context inside the first user gesture (the
  // only moment iOS permits it).
  const resumeWaiters = [];
  function whenRunning(fn) {
    if (!actx || actx.state === 'running') { fn(); return; }
    resumeWaiters.push(fn);
    resume();
  }
  if (actx) actx.addEventListener('statechange', () => {
    if (actx.state === 'running' && resumeWaiters.length) {
      resumeWaiters.splice(0).forEach((fn) => { try { fn(); } catch (e) {} });
    }
  });

  // ── spatial helpers ──────────────────────────────────────────────────────────
  // a screen point (px) → a position in the audio scene relative to the listener
  function screenToAudio(sx, sy) {
    const nx = (sx / window.innerWidth) * 2 - 1;    // −1 left … 1 right
    const ny = (sy / window.innerHeight) * 2 - 1;   // −1 top … 1 bottom
    return { x: nx * SP.spreadX, y: -ny * SP.spreadY, z: -SP.depth }; // −z = in front
  }
  function makePanner(pt) {
    const p = actx.createPanner();
    p.panningModel = SP.panningModel; p.distanceModel = SP.distanceModel;
    p.refDistance = SP.depth; p.maxDistance = SP.maxDistance; p.rolloffFactor = SP.rolloff;
    // omnidirectional (no cone) so orientation never silences it
    try { p.coneInnerAngle = 360; p.coneOuterAngle = 360; p.coneOuterGain = 0; } catch (e) {}
    if (pt) setPos(p, pt.x, pt.y, pt.z);
    return p;
  }

  // build the output chain for a node: perShotGain → [panner|stereo] → sfxBus.
  // returns { gain, panner } so callers (loops) can keep tweaking volume/position.
  function makeOut(opts) {
    const gain = actx.createGain();
    gain.gain.value = opts.volume != null ? opts.volume : 1;
    let panner = null;
    if (opts.pos3d) {
      // WORLD-space 3D (gl-scene): meters, true 3D listener — no screen mapping
      panner = makePanner(null);
      panner.refDistance = opts.ref ?? 2;
      panner.rolloffFactor = opts.rolloff ?? 1;
      panner.maxDistance = opts.maxDistance ?? 90;
      setPos(panner, opts.pos3d[0], opts.pos3d[1], opts.pos3d[2]);
      gain.connect(panner); panner.connect(sfxBus);
    } else if (opts.spatial || opts.position) {
      panner = makePanner(opts.position ? screenToAudio(opts.position.x, opts.position.y) : null);
      gain.connect(panner); panner.connect(sfxBus);
    } else if (opts.pan != null && actx.createStereoPanner) {
      const sp = actx.createStereoPanner(); sp.pan.value = clamp(opts.pan, -1, 1);
      gain.connect(sp); sp.connect(sfxBus);
    } else {
      gain.connect(sfxBus);
    }
    return { gain, panner };
  }

  // ── one-shot SFX ───────────────────────────────────────────────────────────--
  function play(name, opts = {}) {
    if (muted) return;
    const url = url4(name);
    const buf = url && bufByUrl[url];
    if (actx && buf && actx.state === 'running') {
      const src = actx.createBufferSource();
      src.buffer = opts.reverse ? reversedBuffer(url, buf) : buf;
      if (opts.rate) src.playbackRate.value = opts.rate;
      if (opts.detune && src.detune) src.detune.value = opts.detune;
      const { gain, panner } = makeOut(opts);
      src.connect(gain);
      // GC hygiene: when the one-shot finishes (natural end OR scheduled stop),
      // disconnect its nodes from sfxBus. Without this every fire leaks a GainNode
      // (+panner) still wired to the bus — a real leak for frequent SFX (footsteps,
      // gunshots, blips). A non-looping source's onended always fires.
      src.onended = () => {
        try { src.disconnect(); } catch (e) {}
        try { gain.disconnect(); } catch (e) {}
        if (panner) { try { panner.disconnect(); } catch (e) {} }
      };
      src.start(0);
      // cap a one-shot to `duration` seconds (e.g. a 2s whir trimmed to match an instant
      // action) — schedule src.stop() with a short gain fade so it doesn't click.
      if (opts.duration > 0) {
        const end = actx.currentTime + opts.duration;
        const fade = Math.min(0.08, opts.duration * 0.25);
        try {
          gain.gain.setValueAtTime(gain.gain.value, Math.max(actx.currentTime, end - fade));
          gain.gain.linearRampToValueAtTime(0.0001, end);
        } catch (e) { /* ramp unsupported — hard stop */ }
        try { src.stop(end); } catch (e) {}
      }
      return;
    }
    // running but not decoded yet → decode then play once (no recursion loop)
    if (actx && actx.state === 'running' && url && !opts._retried) {
      ensureBuffer(name).then(() => play(name, { ...opts, _retried: true })).catch(() => htmlFallback(name, opts));
      return;
    }
    htmlFallback(name, opts);
  }
  function htmlFallback(name, opts) {
    const base = pool[name];
    const node = base ? base.cloneNode() : (url4(name) ? new Audio(url4(name)) : null);
    if (!node) return;
    node.volume = (opts.volume != null ? opts.volume : 1) * cfg.volume;
    if (opts.rate) node.playbackRate = opts.rate;
    node.play().catch(() => {});
  }

  // ── looping SFX (buffer) ─────────────────────────────────────────────────────
  const loops = new Set();
  function loop(name, opts = {}) {
    if (!actx) return htmlLoop(name, opts);
    const handle = { id: opts.id || name, kind: 'loop', _stopped: false, source: null, gain: null, panner: null };
    loops.add(handle);
    ensureBuffer(name).then((buf) => {
      if (handle._stopped) return;
      const src = actx.createBufferSource();
      src.buffer = opts.reverse ? reversedBuffer(url4(name), buf) : buf; src.loop = true;
      if (opts.rate) src.playbackRate.value = opts.rate;
      const { gain, panner } = makeOut({ ...opts, volume: 0 }); // start silent → fade in
      src.connect(gain);
      handle.source = src; handle.gain = gain; handle.panner = panner;
      // defer the actual start until the context is RUNNING (iOS: post-gesture) so the
      // source isn't started-while-suspended → silently dropped. Synchronous on desktop
      // / once unlocked. _stopped guard: a loop stopped before the first gesture never
      // starts.
      whenRunning(() => {
        if (handle._stopped) return;
        src.start(0);
        rampGain(gain.gain, opts.volume != null ? opts.volume : 1, opts.fadeIn || 0);
      });
    }).catch(() => { loops.delete(handle); });
    handle.stop = (fadeMs) => stopLoop(handle, fadeMs != null ? fadeMs : (opts.fadeOut || 0));
    handle.setVolume = (v) => { if (handle.gain) rampGain(handle.gain.gain, v, 40); };
    handle.setRate = (r) => { if (handle.source) handle.source.playbackRate.value = r; };
    handle.setPosition = (sx, sy) => { if (handle.panner) { const a = screenToAudio(sx, sy); setPos(handle.panner, a.x, a.y, a.z); } };
    return handle;
  }
  function stopLoop(handle, fadeMs) {
    if (handle._stopped) return; handle._stopped = true; loops.delete(handle);
    // disconnect source + gain + panner from sfxBus after stopping, else every
    // start/stop cycle (e.g. footstep walk↔run↔stop) orphans a silent GainNode
    // still wired to the bus → a slow leak over a play session.
    const cleanup = () => {
      try { handle.source && handle.source.disconnect(); } catch (e) {}
      try { handle.gain && handle.gain.disconnect(); } catch (e) {}
      try { handle.panner && handle.panner.disconnect(); } catch (e) {}
    };
    if (handle.gain && handle.source) {
      rampGain(handle.gain.gain, 0, fadeMs);
      const s = handle.source;
      setTimeout(() => { try { s.stop(); } catch (e) {} cleanup(); }, (fadeMs || 0) + 40);
    } else if (handle.source) { try { handle.source.stop(); } catch (e) {} cleanup(); }
    else { cleanup(); }
  }
  function htmlLoop(name, opts) {
    const base = pool[name];
    const el = base ? base.cloneNode() : new Audio(url4(name));
    el.loop = true; el.volume = (opts.volume != null ? opts.volume : 1) * cfg.volume; el.play().catch(() => {});
    return { id: opts.id || name, el, _stopped: false,
      stop() { if (this._stopped) return; this._stopped = true; el.pause(); },
      setVolume(v) { el.volume = v * cfg.volume; }, setRate(r) { el.playbackRate = r; }, setPosition() {} };
  }

  // ── background music / tracks (streamed HTMLAudio, routed for fade + mute) ─────
  const tracks = new Set();
  function music(src, opts = {}) {
    const url = url4(src);
    const el = new Audio(url); el.loop = opts.loop !== false; el.preload = 'auto';
    const target = opts.volume != null ? opts.volume : 1; // relative to musicBus
    let gain = null, routed = false;
    if (actx) {
      try {
        const mes = actx.createMediaElementSource(el);
        gain = actx.createGain(); gain.gain.value = 0; // fade up from silence
        mes.connect(gain).connect(musicBus);
        el.volume = 1; routed = true; // graph controls level now
      } catch (e) { routed = false; }
    }
    if (!routed) el.volume = 0;
    if (opts.rate) el.playbackRate = opts.rate;
    const handle = { id: opts.id || url, kind: 'music', el, gain, _stopped: false };
    tracks.add(handle);
    resume();
    // try to play; if autoplay-blocked, retry once on the next user gesture
    const tryPlay = () => el.play().catch(() => {
      const once = () => { document.removeEventListener('pointerdown', once, true); resume(); el.play().catch(() => {}); };
      document.addEventListener('pointerdown', once, true);
    });
    tryPlay();
    if (routed) rampGain(gain.gain, target, opts.fadeIn != null ? opts.fadeIn : 600);
    else fadeEl(el, target * cfg.musicVolume, opts.fadeIn != null ? opts.fadeIn : 600);
    handle.stop = (fadeMs) => stopTrack(handle, fadeMs != null ? fadeMs : (opts.fadeOut != null ? opts.fadeOut : 800));
    handle.setVolume = (v) => { if (gain) rampGain(gain.gain, v, 80); else fadeEl(el, v * cfg.musicVolume, 80); };
    handle.pause = () => el.pause();
    handle.resume = () => { resume(); el.play().catch(() => {}); };
    return handle;
  }
  function stopTrack(handle, fadeMs) {
    if (handle._stopped) return; handle._stopped = true; tracks.delete(handle);
    if (handle.gain) { rampGain(handle.gain.gain, 0, fadeMs); setTimeout(() => handle.el.pause(), (fadeMs || 0) + 50); }
    else fadeEl(handle.el, 0, fadeMs, () => handle.el.pause());
  }

  function stopAll(fadeMs) { [...loops].forEach((h) => stopLoop(h, fadeMs)); [...tracks].forEach((h) => stopTrack(h, fadeMs)); }

  // ── level + listener controls ────────────────────────────────────────────────
  function rampGain(param, to, ms) {
    if (!actx) return;
    const now = actx.currentTime, t = Math.max(0, (ms || 0) / 1000);
    try { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); param.linearRampToValueAtTime(to, now + t); }
    catch (e) { param.value = to; }
  }
  function fadeEl(el, to, ms, done) {
    const from = el.volume, steps = Math.max(1, Math.round((ms || 0) / 30));
    if (!ms) { el.volume = clamp(to, 0, 1); done?.(); return; }
    let i = 0;
    const iv = setInterval(() => { i++; el.volume = clamp(from + (to - from) * (i / steps), 0, 1); if (i >= steps) { clearInterval(iv); done?.(); } }, 30);
  }
  function setMasterVolume(v) { if (master && !muted) rampGain(master.gain, v, 80); }
  function setSfxVolume(v) { cfg.volume = v; if (sfxBus) rampGain(sfxBus.gain, v, 80); }
  function setMusicVolume(v) { cfg.musicVolume = v; if (musicBus) rampGain(musicBus.gain, v, 80); }
  function listenerAt(sx, sy) { if (actx) { const a = screenToAudio(sx, sy); setListener(actx, a.x, a.y, 0); } }

  // world-space listener for 3D scenes: position + facing (gl-scene camera)
  function listener3d(pos, fwd) {
    if (!actx) return;
    const L = actx.listener;
    setListener(actx, pos[0], pos[1], pos[2]);
    try {
      if (L.forwardX) {
        L.forwardX.value = fwd[0]; L.forwardY.value = fwd[1]; L.forwardZ.value = fwd[2];
        L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
      } else if (L.setOrientation) {
        L.setOrientation(fwd[0], fwd[1], fwd[2], 0, 1, 0);
      }
    } catch (e) {}
  }

  function mute() { muted = true; if (master) rampGain(master.gain, 0, 80); }
  function unmute() { muted = false; if (master) rampGain(master.gain, 1, 80); }

  // ── analyser tap (for audio-reactive visuals) ────────────────────────────────
  // Lazily create ONE AnalyserNode fed by the master bus. It only observes (no
  // output connected) so it never alters the sound. Returns null without Web Audio.
  let analyserNode = null;
  function analyser(opts = {}) {
    if (!actx || !master) return null;
    if (!analyserNode) {
      analyserNode = actx.createAnalyser();
      master.connect(analyserNode); // tap the post-mix signal
    }
    if (opts.fftSize) analyserNode.fftSize = opts.fftSize;
    if (opts.smoothing != null) analyserNode.smoothingTimeConstant = opts.smoothing;
    return analyserNode;
  }

  // ── default wiring (unchanged): buttons click; action bus → success/error ─────
  document.addEventListener('pointerdown', (e) => {
    resume(); // unlock/resume the AudioContext within a real user gesture
    if (e.target.closest('button, .pf-btn, .pf-social')) play('click');
  }, true);
  bus.on('action:done', () => play('success'));
  bus.on('action:error', () => play('error'));

  return {
    play, loop, music, stopAll, analyser,
    ensureBuffer, resume, listenerAt, listener3d,
    setMasterVolume, setSfxVolume, setMusicVolume,
    get context() { return actx; },
    mute, unmute,
    toggle() { muted ? unmute() : mute(); return !muted; },
    get muted() { return muted; },
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// PannerNode position — AudioParam form (modern) with a setPosition() fallback (old WebKit).
function setPos(node, x, y, z) {
  if (node.positionX) { node.positionX.value = x; node.positionY.value = y; node.positionZ.value = z; }
  else if (node.setPosition) node.setPosition(x, y, z);
}
// AudioListener position + orientation — same modern/legacy split.
function setListener(actx, x, y, z) {
  const l = actx.listener;
  if (l.positionX) {
    l.positionX.value = x; l.positionY.value = y; l.positionZ.value = z;
    if (l.forwardX) { l.forwardX.value = 0; l.forwardY.value = 0; l.forwardZ.value = -1; l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0; }
  } else {
    if (l.setPosition) l.setPosition(x, y, z);
    if (l.setOrientation) l.setOrientation(0, 0, -1, 0, 1, 0);
  }
}
