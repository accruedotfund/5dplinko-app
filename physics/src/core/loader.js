// ─────────────────────────────────────────────────────────────────────────────
// loader.js — the boot screen, driven by manifest `config.loader`. boot.js calls
// initLoader(config.loader, config); it (re)builds #pf-boot's content for the
// chosen preset (ONE set of elements via replaceChildren → never a doubled bar),
// drives progress + cycling stages, and finalizes when the entry dismisses
// #pf-boot (watches for `.is-done`). The entry HTML's #pf-boot is just an empty
// shell — its design comes from here, so it's all data.
//
//   config.loader = {
//     preset?: 'classic' | 'bar-bottom' | 'number',   // default 'classic'
//     brand?: string,            // headline (default: existing boot brand → appName)
//     color?|accent?: string,    // accent (local --pf-accent: % number, fill, brand)
//     textColor?, muted?: string,// brand/status/number text + sublabels (ANY preset)
//     stages?: ['Loading…', 'Ready'],                  // status text (see duration)
//     duration?: 25,             // hold the boot ~25s (values <100 = SECONDS); also
//                                //   paces the fill + spreads stages across it.
//     suffix?: '%', fillMs?: 1400, stageMs?: 700, minMs?,  // fine overrides (ms)
//     background?: '<css color|gradient>'        // ANY preset, OR a media object:
//               | { type:'image'|'gif'|'video'|'parallax', src?, srcs?, pixelated? },
//     canvas?|draw?: (g, w, h, t, p) => {},      // procedural canvas BEHIND content
//                                                // (rAF; t=seconds, p=progress 0..1)
//   }
//
//   `duration` gates boot()'s resolution (initLoader returns a promise boot awaits),
//   so the screen genuinely stays up that long even when the app is ready instantly.
//
//   classic    — centered brand + a CSS shimmer bar + status (NOT JS-driven).
//   bar-bottom — full-screen background + stages line + a progress bar pinned
//                to the BOTTOM of the screen.
//   number     — a big counting % (in `color`) + an optional stage sublabel.
// ─────────────────────────────────────────────────────────────────────────────

import { h } from './dom.js';

export function initLoader(opts = {}, config = {}) {
  const host = document.getElementById('pf-boot');
  if (!host) return Promise.resolve();
  const preset = opts.preset || 'classic';
  // ── full theming (applies to EVERY preset) ──────────────────────────────────
  //   color/accent → loader accent (% number, fill, brand underline)
  //   textColor    → brand/status/number text;  muted → sublabels
  //   background   → a CSS color/gradient STRING, or a media OBJECT
  //                  ({type:'image'|'gif'|'video'|'parallax', src|srcs}) behind it
  if (opts.color || opts.accent) host.style.setProperty('--pf-accent', opts.accent || opts.color);
  if (opts.textColor) { host.style.setProperty('--pf-text', opts.textColor); host.style.color = opts.textColor; }
  if (opts.muted) host.style.setProperty('--pf-muted', opts.muted);
  if (typeof opts.background === 'string') host.style.background = opts.background;
  const brand = opts.brand || host.querySelector('[data-role="boot-brand"]')?.textContent || config.appName || '';
  const stages = opts.stages && opts.stages.length ? opts.stages.slice() : null;

  // Duration knobs (friendly: values < 100 are read as SECONDS, e.g. 25 → 25000ms).
  //  • duration → how long the boot is held up before it's allowed to dismiss
  //    (gates boot() via the returned promise) AND the default faux-progress pace.
  //  • fillMs   → override just the progress pacing; stageMs → stage cadence.
  const toMs = (v) => (v == null ? null : v < 100 ? v * 1000 : v);
  const durationMs = toMs(opts.duration);
  const minMs = durationMs || toMs(opts.minMs) || 0; // hold floor (0 → entry's own floor governs)
  const fillMs = toMs(opts.fillMs) || durationMs || 1400;

  host.classList.add(`pf-boot--${preset}`);

  let fillEl = null, numEl = null, statusEl = null; // only fillEl/numEl are JS-driven

  // ── classic: if the entry HTML already painted a classic boot, ADOPT it in
  // place. Rebuilding it (replaceChildren) would re-instantiate `.pf-boot__fill`
  // and restart its one-shot CSS fill animation → the bar appears to load twice
  // (100 → 0 → 100). Classic isn't JS-driven, so the static markup is canonical.
  if (preset === 'classic' && host.querySelector('.pf-boot__fill')) {
    statusEl = host.querySelector('[data-role="boot-status"]');
    if (statusEl && stages) statusEl.textContent = stages[0];
    if (brand) { const b = host.querySelector('[data-role="boot-brand"]'); if (b) b.textContent = brand; }
  } else if (preset === 'classic') {
    host.replaceChildren();
    const inner = h('div', { class: 'pf-boot__inner', 'data-role': 'boot-inner' });
    if (brand) inner.append(h('div', { class: 'pf-boot__brand', 'data-role': 'boot-brand' }, brand));
    inner.append(h('div', { class: 'pf-boot__bar', 'data-role': 'boot-bar' }, h('span', { class: 'pf-boot__fill' }))); // CSS shimmer, NOT driven
    statusEl = h('div', { class: 'pf-boot__status', 'data-role': 'boot-status' }, stages ? stages[0] : 'booting…');
    inner.append(statusEl);
    host.append(inner);
  } else if (preset === 'bar-bottom') {
    host.replaceChildren(); // single set of elements → no doubled bar
    if (opts.background && typeof opts.background === 'object') host.append(buildBg(opts.background));
    host.append(h('div', { class: 'pf-boot__scrim', 'data-role': 'scrim' }));
    const center = h('div', { class: 'pf-bootb__center', 'data-role': 'boot-inner' });
    if (brand) center.append(h('div', { class: 'pf-bootb__brand', 'data-role': 'boot-brand' }, brand));
    statusEl = h('div', { class: 'pf-bootb__stage', 'data-role': 'boot-status' }, stages ? stages[0] : 'loading…');
    center.append(statusEl);
    host.append(center);
    const bar = h('div', { class: 'pf-bootb__bar', 'data-role': 'boot-bar' });
    fillEl = h('span', { class: 'pf-bootb__fill' });
    bar.append(fillEl);
    host.append(bar);
  } else if (preset === 'number') {
    host.replaceChildren();
    const center = h('div', { class: 'pf-bootn__center', 'data-role': 'boot-inner' });
    numEl = h('div', { class: 'pf-bootn__num', 'data-role': 'boot-num' }, '0');
    center.append(numEl);
    statusEl = h('div', { class: 'pf-bootn__stage', 'data-role': 'boot-status' }, stages ? stages[0] : '');
    center.append(statusEl);
    host.append(center);
  }

  // media background (image/gif/video/parallax) for classic + number too —
  // bar-bottom builds its own above. Placed BEHIND the content, with a scrim.
  if (opts.background && typeof opts.background === 'object' && preset !== 'bar-bottom') {
    host.prepend(h('div', { class: 'pf-boot__scrim', 'data-role': 'scrim' }));
    host.prepend(buildBg(opts.background));
  }

  // ── drive progress (presets only) + cycle stages ──
  let timers = [];
  let p = 0, shown = 0;
  let realConnected = false, realP = 0;   // a REAL progress source (boot's preloader)
  const t0 = performance.now();
  const suffix = opts.suffix || '';
  const render = () => {
    if (fillEl) fillEl.style.width = `${(p * 100).toFixed(0)}%`;
    if (numEl) numEl.textContent = `${Math.round(p * 100)}${suffix}`;
  };
  render();
  // setProgress(fraction 0..1) — connect REAL loading progress (preload + module
  // prewarm). Once connected the bar EASES toward the real value (capped <100% until
  // finish()); monotonic so it never jumps backward. Until/unless connected, the timed
  // faux climb stands (loaders without a preload source are unchanged).
  const setProgress = (f) => { if (typeof f === 'number' && f >= 0) { realConnected = true; realP = Math.max(realP, Math.min(1, f)); } };
  if (fillEl || numEl) {
    timers.push(setInterval(() => {
      const target = realConnected
        ? Math.min(0.96, realP)                                        // real loading (eased)
        : Math.min(0.92, (performance.now() - t0) / fillMs * 0.92);    // faux fallback
      shown += (target - shown) * 0.18;                               // smooth (no jumps)
      p = shown; render();
    }, 60));
  }
  if (stages && statusEl) {
    let i = 0;
    // With an explicit duration, spread the stages evenly across it and REST on
    // the last (reads as real progress). Otherwise cycle on the short default.
    const stageMs = toMs(opts.stageMs) || (durationMs ? Math.max(600, Math.floor(durationMs / stages.length)) : 700);
    const cycle = !durationMs;
    timers.push(setInterval(() => {
      if (cycle) i = (i + 1) % stages.length;
      else if (i < stages.length - 1) i++;
      statusEl.textContent = stages[i];
    }, stageMs));
  }

  // procedural HTML-<canvas> animation (any preset): opts.draw = (g, w, h, t, p) => {}.
  // A full-screen <canvas> behind the content, rAF-driven — t = seconds elapsed,
  // p = progress 0..1. Use plain math/tweens, OR import engine fns into the
  // manifest (oscillate/procgen/pixelart) and call them here. (`canvas` is a
  // deprecated alias for `draw` — kept working so older loader manifests don't break.)
  let canvasRaf = 0, canvasFit = null;
  const drawFn = typeof opts.draw === 'function' ? opts.draw : (typeof opts.canvas === 'function' ? opts.canvas : null);
  if (drawFn) {
    const cv = h('canvas', { class: 'pf-boot__canvas', 'data-role': 'boot-canvas' });
    host.prepend(cv); // behind the brand/number/status content
    const g = cv.getContext('2d');
    const dpr = () => Math.min(2, window.devicePixelRatio || 1);
    canvasFit = () => { const r = host.getBoundingClientRect(); const d = dpr(); cv.width = Math.max(1, Math.round((r.width || window.innerWidth) * d)); cv.height = Math.max(1, Math.round((r.height || window.innerHeight) * d)); g.setTransform(d, 0, 0, d, 0, 0); };
    canvasFit(); window.addEventListener('resize', canvasFit);
    const tick = () => { const t = (performance.now() - t0) / 1000, w = cv.width / dpr(), hh = cv.height / dpr(); g.clearRect(0, 0, w, hh); try { drawFn(g, w, hh, t, p); } catch (e) { /* ignore a bad frame */ } canvasRaf = requestAnimationFrame(tick); };
    canvasRaf = requestAnimationFrame(tick);
  }

  let finished = false;
  const stopCanvas = () => { cancelAnimationFrame(canvasRaf); if (canvasFit) window.removeEventListener('resize', canvasFit); };
  const finish = () => {
    if (finished) return; finished = true;
    timers.forEach(clearInterval); timers = [];
    obs.disconnect();
    if (stages && statusEl) statusEl.textContent = stages[stages.length - 1];

    // Anything that shows progress — the bar/number AND the procedural canvas
    // (which reads `p` each frame) — must VISIBLY reach 100% before the screen
    // fades. So we cancel the entry's instant fade, TWEEN p → 1 (count-up / fill
    // / canvas bar all complete together — the canvas rAF keeps running so it
    // isn't frozen mid-fill), hold a beat on 100%, then fade + stop the canvas.
    const driven = fillEl || numEl || drawFn;
    if (!driven) { p = 1; render(); stopCanvas(); return; } // classic: immediate fade stands
    host.classList.remove('is-done');
    const p0 = p, t1 = performance.now(), tweenMs = 420, holdMs = 300;
    const ct = setInterval(() => {
      const k = Math.min(1, (performance.now() - t1) / tweenMs);
      p = p0 + (1 - p0) * k; render();
      if (k >= 1) { clearInterval(ct); setTimeout(() => { host.classList.add('is-done'); stopCanvas(); }, holdMs); }
    }, 24);
    timers.push(ct);
  };

  const obs = new MutationObserver(() => {
    if (host.classList.contains('is-done')) finish();
  });
  obs.observe(host, { attributes: true, attributeFilter: ['class'] });

  // Hold the boot up for at least `minMs` — boot() awaits this before resolving,
  // so a `duration: 25` loader genuinely stays up ~25s even when the app is
  // ready instantly. minMs == 0 resolves immediately (the entry's own 900ms
  // Promise.all floor then governs, preserving the original default feel).
  // The returned hold gates boot()'s resolution (minMs). `setProgress` is attached so
  // boot can drive the REAL % — it's still a thenable, so `await loaderHold` is unchanged.
  const hold = new Promise((resolve) => { if (minMs > 0) setTimeout(resolve, minMs); else resolve(); });
  hold.setProgress = setProgress;
  return hold;
}

function buildBg(bg) {
  const wrap = h('div', { class: 'pf-boot__bg', 'data-role': 'bg' });
  const type = bg.type || (bg.srcs ? 'parallax' : 'image');
  if (type === 'video') {
    const v = h('video', { class: 'pf-boot__bgmedia', 'data-role': 'bgmedia', src: bg.src, poster: bg.poster || null, playsinline: '', loop: '', preload: 'auto', autoplay: '' });
    v.muted = true; try { v.play(); } catch { /* */ }
    wrap.append(v);
  } else if (type === 'parallax' && bg.srcs) {
    wrap.classList.add('pf-boot__bg--parallax');
    bg.srcs.forEach((s) => wrap.append(h('img', { class: ['pf-boot__bgmedia', 'pf-boot__bglayer', bg.pixelated && 'pf-media--pixel'], 'data-role': 'bglayer', src: typeof s === 'string' ? s : s.src, alt: '' })));
  } else {
    wrap.append(h('img', { class: ['pf-boot__bgmedia', bg.pixelated && 'pf-media--pixel'], 'data-role': 'bgmedia', src: bg.src, alt: '' }));
  }
  return wrap;
}
