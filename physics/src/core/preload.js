// ─────────────────────────────────────────────────────────────────────────────
// preload.js — first-class asset preloading / prewarming.
//
// Warm sprites + dmis + audio + video BEFORE the scene reveals (during the boot
// loader) so nothing pops in / stutters on first use. Routed by kind:
//   .dmi   → the dmi parse cache (later component load is instant)
//   image  → Image() + decode()                  (pixels ready, not just fetched)
//   audio  → the app's Web Audio decode cache via opts.audio (playback-ready
//            AudioBuffer); fallback = <audio preload="auto"> + the HTTP cache
//   video  → <video preload="auto" muted> warmed to `loadeddata` (no black flash)
//   other  → a plain fetch (warms the HTTP cache)
// EVERY failure is swallowed — a missing/slow asset must never block boot.
//
//   boot wiring:  preloadAssets([ ...collectAssets(manifest), ...config.preload ],
//                               { audio: (u) => sound.ensureBuffer(u) })
//   manifest API: config.preload = ['assets/img/bg.png', 'assets/audio/x.mp3', …]
//                 (explicit list; dmi/audio/video are ALSO auto-discovered)
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: format parsers (dmi.js, gl/gltf.js) are DYNAMIC-imported inside their warmers
// (not static), so a build with no .dmi / no model assets can drop those core files
// entirely — pf-build prunes the unreached parser (the import() literal never runs unless
// an asset of that type is actually preloaded). Keep them lazy.

const DMI_RE   = /\.dmi(\?|#|$)/i;
const IMG_RE   = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i;
const AUDIO_RE = /\.(mp3|ogg|wav|m4a|aac|flac|opus)(\?|#|$)/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i;
// auto-discovered media (decode/parse/buffer-heavy → pop in without a prewarm).
// Images are NOT auto-discovered (browser-cached on mount, often numerous) — list
// them in config.preload; the router below still warms them properly when listed.
const MEDIA_RE = /\.(dmi|glb|gltf|bin|mp3|ogg|wav|m4a|aac|flac|opus|mp4|webm|mov|m4v|ogv)(\?|#|$)/i;

/**
 * Warm a list of asset URLs concurrently. Resolves (never rejects) once all settle.
 * @param urls  string[]  asset URLs
 * @param opts  { onProgress?(fraction,done,total), audio?(url)=>Promise }  — or a
 *              bare onProgress function (back-compat).
 */
export function preloadAssets(urls, opts = {}) {
  const onProgress = typeof opts === 'function' ? opts : opts.onProgress;
  const audioWarm = typeof opts === 'object' ? opts.audio : null;
  const list = [...new Set((urls || []).filter((u) => typeof u === 'string' && u))];
  if (!list.length) return Promise.resolve();
  let done = 0;
  const step = () => { done++; if (onProgress) { try { onProgress(done / list.length, done, list.length); } catch (e) { /* ignore */ } } };
  return Promise.all(list.map((u) => warmOne(u, audioWarm).then(step, step))).then(() => undefined);
}

const MODEL_RE = /\.(glb|gltf)(\?|#|$)/i;

function warmOne(url, audioWarm) {
  if (DMI_RE.test(url)) return warmDmi(url);
  if (MODEL_RE.test(url)) return warmModel(url);   // FULL parse + texture decode (cached for gl-scene)
  if (IMG_RE.test(url)) return warmImage(url);
  if (AUDIO_RE.test(url)) return warmAudio(url, audioWarm);
  if (VIDEO_RE.test(url)) return warmMediaEl('video', url);
  return fetch(url).then((r) => r.blob()).catch(() => undefined); // generic: warm the HTTP cache
}

// glb/gltf: dynamic-import the parser (keeps the gl module lazy — preload.js stays light)
// and FULLY load the model — parse geometry + decode textures into gltf.js's caches. No GL
// context needed (that's the upload step, done later by gl-scene from the cached SceneGraph).
// So the boot loader's % accounts for model loading, and gl-scene mounts to instant cache hits.
let _dmiMod = null;
function warmDmi(url) {
  return (async () => {
    try { if (!_dmiMod) _dmiMod = import('./dmi.js'); await (await _dmiMod).preloadDMI([url]); }
    catch (e) { /* missing/bad dmi shouldn't block boot */ }
  })();
}

let _gltfMod = null;
function warmModel(url) {
  return (async () => {
    try {
      if (!_gltfMod) _gltfMod = import('./gl/gltf.js');
      const m = await _gltfMod;
      await (/\.glb(\?|#|$)/i.test(url) ? m.loadGLB(url) : m.loadGLTF(url));
    } catch (e) { /* gl-scene surfaces real load errors; don't block boot on a bad model */ }
  })();
}

function warmImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const done = () => resolve();
    img.onload = () => { (img.decode ? img.decode() : Promise.resolve()).then(done, done); };
    img.onerror = done;
    img.src = url;
  });
}

// Best: decode into the app's Web Audio buffer cache (sound.ensureBuffer) so the clip
// is PLAYBACK-READY (decodeAudioData works even while the context is suspended at boot).
// Fallback (no audio warmer / a decode failure): an <audio> element + the HTTP cache.
function warmAudio(url, audioWarm) {
  if (audioWarm) {
    try { return Promise.resolve(audioWarm(url)).catch(() => warmMediaEl('audio', url)); }
    catch (e) { /* fall through to the element */ }
  }
  return warmMediaEl('audio', url);
}

// Warm a detached <audio>/<video> to first-frame/playable, then release it (the HTTP
// cache + decoded header survive). Resolves on loadeddata|canplaythrough|error.
function warmMediaEl(tag, url) {
  if (typeof document === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const el = document.createElement(tag);
    el.preload = 'auto';
    if (tag === 'video') { el.muted = true; el.playsInline = true; }
    let settled = false;
    const done = () => {
      if (settled) return; settled = true;
      el.removeEventListener('loadeddata', done); el.removeEventListener('canplaythrough', done); el.removeEventListener('error', done);
      try { el.removeAttribute('src'); el.load(); } catch (e) { /* release the buffer */ }
      resolve();
    };
    el.addEventListener('loadeddata', done, { once: true });     // enough decoded to start
    el.addEventListener('canplaythrough', done, { once: true });
    el.addEventListener('error', done, { once: true });
    el.src = url;
    try { el.load(); } catch (e) { done(); }
  });
}

/**
 * Recursively collect every preload-worthy MEDIA asset (.dmi / audio / video) a
 * manifest references via `src` or `sources[].src`, anywhere. Requires a path-like
 * src (contains '/') so bare sound-map names (handled by initSound) aren't double-
 * loaded. Plain-data walk; functions skipped, a WeakSet guards against cycles.
 */
export function collectAssets(node, out = [], seen = new WeakSet()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    // string elements that look like media paths (covers `src:{$seq:[...]}`, `sources`,
    // any array of model/texture/audio URLs) — not just `node.src`
    for (const v of node) {
      if (typeof v === 'string') { if (v.includes('/') && MEDIA_RE.test(v)) out.push(v); }
      else collectAssets(v, out, seen);
    }
    return out;
  }
  if (typeof node.src === 'string' && node.src.includes('/') && MEDIA_RE.test(node.src)) out.push(node.src);
  for (const k in node) { const v = node[k]; if (v && typeof v === 'object') collectAssets(v, out, seen); }
  return out;
}

/**
 * Recursively collect every component `type` a manifest USES (layout/components/defs,
 * nested). Boot maps these to registry factories and prewarms the lazy ones' modules
 * (the pixel-art engine etc.) so they're parsed before the component mounts.
 */
export function collectTypes(node, out = new Set(), seen = new WeakSet()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { for (const v of node) collectTypes(v, out, seen); return out; }
  if (typeof node.type === 'string') out.add(node.type);
  for (const k in node) { const v = node[k]; if (v && typeof v === 'object') collectTypes(v, out, seen); }
  return out;
}
