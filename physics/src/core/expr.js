// ─────────────────────────────────────────────────────────────────────────────
// core/expr.js — the manifest EXPRESSION language (Construct-3 style). A tiny,
// SAFE (no eval/Function), compiled-once expression evaluator so event sheets can
// write `max(0, enemyHp - (10 + combo*2))` instead of nested `$op` JSON trees.
//
//   compileExpr('score > 10 && lives != 0')  →  (scope) => boolean   (cached)
//   evalExpr('clamp(hp + heal, 0, 100)', scope)  →  value
//
// GRAMMAR (precedence low→high):  ?:  ||  &&  ==/!=  </<=/>/>=  +/-  */÷/%  unary !/-
//   literals:  1  2.5  'str'  "str"  true  false  null  [a, b, …]
//   calls:     fn(a, b)          — stdlib below; unknown fn → warn + undefined
//   idents:    dotted paths, resolved against the scope in this order:
//     · locals            (loop vars: item/index/loopindex · let-vars · fn params · dt)
//     · payload.x / config.x / wallet.x   (also legacy $payload.x / $config.x forms)
//     · time              (seconds since rules.start)
//     · store path        (scope.state('a.b.c') — bare identifiers read the store)
//     · flags             (manifest.flags)
//   Unknown identifiers resolve to undefined (comparisons behave sanely, no throw).
//
// STDLIB: abs ceil floor round trunc sqrt pow sign min max clamp lerp random(a?,b?)
//   randint(a,b) pick(…) distance(x1,y1,x2,y2) angle(x1,y1,x2,y2)° len str num int
//   contains(coll,v) indexof(coll,v) lower upper trim replace(s,a,b) substr(s,i,n?)
//   split(s,sep) join(arr,sep) floor2? — all pure; random uses Math.random.
//
// Used by core/rules.js (condition strings + values) and core/expand.js ({$expr:'…'},
// where static expansion supplies locals {i, i1, n, item}). Zero imports, DOM-free.
// ─────────────────────────────────────────────────────────────────────────────

const pathGet = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// ── stdlib ───────────────────────────────────────────────────────────────────
const FNS = {
  abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round, trunc: Math.trunc,
  sqrt: Math.sqrt, pow: Math.pow, sign: Math.sign,
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  lerp: (a, b, t) => a + (b - a) * t,
  random: (a, b) => (a === undefined ? Math.random() : b === undefined ? Math.random() * a : a + Math.random() * (b - a)),
  randint: (a, b) => a + Math.floor(Math.random() * (b - a + 1)),
  pick: (...a) => a[Math.floor(Math.random() * a.length)],
  distance: (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1),
  angle: (x1, y1, x2, y2) => (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI,
  len: (v) => (v == null ? 0 : typeof v === 'string' || Array.isArray(v) ? v.length : (typeof v === 'object' ? Object.keys(v).length : 0)),
  str: (v) => String(v ?? ''), num: (v) => Number(v) || 0, int: (v) => Math.trunc(Number(v) || 0),
  contains: (coll, v) => (Array.isArray(coll) || typeof coll === 'string' ? coll.includes(v) : (coll && typeof coll === 'object' ? v in coll : false)),
  indexof: (coll, v) => (Array.isArray(coll) || typeof coll === 'string' ? coll.indexOf(v) : -1),
  lower: (s) => String(s ?? '').toLowerCase(), upper: (s) => String(s ?? '').toUpperCase(),
  trim: (s) => String(s ?? '').trim(),
  replace: (s, a, b) => String(s ?? '').split(a).join(b),
  substr: (s, i, n) => String(s ?? '').substr(i, n),
  split: (s, sep) => String(s ?? '').split(sep),
  join: (arr, sep) => (Array.isArray(arr) ? arr.join(sep ?? ',') : String(arr ?? '')),
};

// ── identifier resolution — the PLAN is built at COMPILE time (prefix routing,
// path splitting), so per-eval work is just a locals check + the resolved read.
const walk = (o, parts) => { for (const k of parts) { if (o == null) return undefined; o = o[k]; } return o; };
function compileIdent(name) {
  const head = name.split('.', 1)[0];
  const rest = name.length > head.length ? name.slice(head.length + 1).split('.') : null;
  const n = name[0] === '$' ? name.slice(1) : name;       // legacy $state.x / $payload.x forms
  let core;
  if (n === 'payload') core = (s) => s.payload;
  else if (n === 'wallet') core = (s) => s.wallet;
  else if (n === 'time') core = (s) => (typeof s.time === 'function' ? s.time() : undefined);
  else if (n.startsWith('state.')) { const p = n.slice(6); core = (s) => (s.state ? s.state(p) : undefined); }
  else if (n.startsWith('payload.')) { const parts = n.slice(8).split('.'); core = (s) => walk(s.payload, parts); }
  else if (n.startsWith('config.')) { const parts = n.slice(7).split('.'); core = (s) => walk(s.config, parts); }
  else if (n.startsWith('wallet.')) { const parts = n.slice(7).split('.'); core = (s) => walk(s.wallet, parts); }
  else {                                                  // bare identifier = store path, then flags
    core = (s) => {
      let v = s.state ? s.state(n) : undefined;
      if (v === undefined && s.flags && n in s.flags) v = s.flags[n];
      return v;
    };
  }
  return (s) => {
    if (!s) return undefined;
    const L = s.locals;                                   // locals shadow everything (loop vars, let, params)
    if (L && head in L) return rest ? walk(L[head], rest) : L[head];
    return core(s);
  };
}

// ── tokenizer ────────────────────────────────────────────────────────────────
const PUNCT = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', ',', '?', ':', '[', ']'];
function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      toks.push({ t: 'num', v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1, out = '';
      while (j < n && src[j] !== c) { out += src[j] === '\\' ? src[++j] : src[j]; j++; }
      toks.push({ t: 'str', v: out }); i = j + 1; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$.]/.test(src[j])) j++;
      let w = src.slice(i, j);
      while (w.endsWith('.')) { w = w.slice(0, -1); j--; }   // trailing dot isn't part of the path
      toks.push({ t: 'id', v: w }); i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (PUNCT.includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if (PUNCT.includes(c)) { toks.push({ t: 'op', v: c }); i += 1; continue; }
    throw new Error(`expr: unexpected '${c}' at ${i} in "${src}"`);
  }
  return toks;
}

// ── Pratt parser → closure tree ──────────────────────────────────────────────
const BINPREC = { '||': 2, '&&': 3, '==': 4, '!=': 4, '<': 5, '<=': 5, '>': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7 };
const BINOP = {
  '||': (a, b, s) => a(s) || b(s), '&&': (a, b, s) => a(s) && b(s),
  '==': (a, b, s) => a(s) === b(s), '!=': (a, b, s) => a(s) !== b(s),
  '<': (a, b, s) => a(s) < b(s), '<=': (a, b, s) => a(s) <= b(s),
  '>': (a, b, s) => a(s) > b(s), '>=': (a, b, s) => a(s) >= b(s),
  '+': (a, b, s) => a(s) + b(s), '-': (a, b, s) => a(s) - b(s),
  '*': (a, b, s) => a(s) * b(s), '/': (a, b, s) => a(s) / b(s),
  '%': (a, b, s) => { const x = a(s), y = b(s); return ((x % y) + y) % y; },
};
function parse(toks, src) {
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => toks[p] && toks[p].t === 'op' && toks[p].v === v;
  const eat = (v) => { if (!isOp(v)) throw new Error(`expr: expected '${v}' in "${src}"`); p++; };

  function primary() {
    const tk = toks[p];
    if (!tk) throw new Error(`expr: unexpected end of "${src}"`);
    if (tk.t === 'num' || tk.t === 'str') { p++; const v = tk.v; return () => v; }
    if (tk.t === 'op' && tk.v === '(') { p++; const e = ternary(); eat(')'); return e; }
    if (tk.t === 'op' && tk.v === '[') {
      p++;
      const items = [];
      if (!isOp(']')) { items.push(ternary()); while (isOp(',')) { p++; items.push(ternary()); } }
      eat(']');
      return (s) => items.map((f) => f(s));
    }
    if (tk.t === 'op' && tk.v === '!') { p++; const e = unaryTarget(); return (s) => !truthyVal(e(s)); }
    if (tk.t === 'op' && tk.v === '-') { p++; const e = unaryTarget(); return (s) => -e(s); }
    if (tk.t === 'id') {
      p++;
      const name = tk.v;
      if (name === 'true') return () => true;
      if (name === 'false') return () => false;
      if (name === 'null') return () => null;
      if (isOp('(')) {                                     // function call
        p++;
        const args = [];
        if (!isOp(')')) { args.push(ternary()); while (isOp(',')) { p++; args.push(ternary()); } }
        eat(')');
        const fn = FNS[name];
        if (!fn) { console.warn(`[expr] unknown function "${name}" in "${src}"`); return () => undefined; }
        return (s) => fn(...args.map((f) => f(s)));
      }
      return compileIdent(name);
    }
    throw new Error(`expr: unexpected '${tk.v}' in "${src}"`);
  }
  const unaryTarget = () => primary();                     // unary binds tightest (so -7 % 3 wraps to 2)

  function binary(minPrec, left) {
    for (;;) {
      const tk = peek();
      if (!tk || tk.t !== 'op') return left;
      const prec = BINPREC[tk.v];
      if (prec === undefined || prec < minPrec) return left;
      p++;
      let right = primary();
      for (;;) {
        const nx = peek();
        const nprec = nx && nx.t === 'op' ? BINPREC[nx.v] : undefined;
        if (nprec === undefined || nprec <= prec) break;
        right = binary(nprec, right);
      }
      const op = BINOP[tk.v];
      const L = left, R = right;
      left = (s) => op(L, R, s);
    }
  }
  function ternary() {
    const cond = binary(1, primary());
    if (isOp('?')) {
      p++;
      const a = ternary(); eat(':');
      const b = ternary();
      return (s) => (truthyVal(cond(s)) ? a(s) : b(s));
    }
    return cond;
  }

  const root = ternary();
  if (p < toks.length) throw new Error(`expr: trailing '${toks[p].v}' in "${src}"`);
  return root;
}

// [] and {} count as falsy — matches rules.js's condition truthiness
export function truthyVal(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return !!v;
}

// ── public API — compile-once cache ──────────────────────────────────────────
const cache = new Map();
export function compileExpr(src) {
  let fn = cache.get(src);
  if (fn) return fn;
  try {
    fn = parse(tokenize(src), src);
  } catch (e) {
    console.warn('[expr]', e.message);
    fn = () => undefined;
  }
  cache.set(src, fn);
  return fn;
}
export const evalExpr = (src, scope) => compileExpr(src)(scope);

// does this string LOOK like an expression (vs a plain flag/topic name)?
// identifier-ish strings are handled identically either way; this is only used
// where a string could ambiguously be a topic (actions), never for conditions.
export const looksLikeExpr = (s) => /[()!<>=+\-*/%?[\]&|'"]|\s/.test(s);
