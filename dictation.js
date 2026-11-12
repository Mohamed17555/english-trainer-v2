/* ============================================================
   Subtitle Shadowing + Dictation  —  Vanilla JS (بدون أي framework)

   يُحمَّل بعد السكربت الرئيسي للموقع، ويستخدم دوال الموقع الموجودة:
   $, esc, norm, toast, save, load, gain, bump, twice, clip, fmtT, ytId,
   parseTranscript, ytEnsure, saveMistake, TABS, openTab, stopAll

   الأقسام:
     1) تنظيف الكابشن وتقسيمه إلى جمل
     2) مقارنة الإجابة وتوليد التلميحات
     3) مشغّل الوسائط (YouTubeAdapter) — معزول ليسهل إضافة فيديو/صوت مرفوع لاحقًا
     4) جلب الكابشن (خادم اختياري / لصق / ملف)
     5) التخزين
     6) واجهة التمرين
   ============================================================ */
(function () {
'use strict';

const KEY = 'english_dictation';
const MAX_PRACTICES = 30;
const MAX_SENTENCES = 600;
const MAXW = 16, SOFT = 9;           // حدود طول الجملة بالكلمات
const NO_CAPTIONS_MSG = 'لا توجد ترجمة متزامنة لهذا الفيديو. اختر فيديو يحتوي على كابشن إنجليزي.';

/* ============================================================
   1) تنظيف الكابشن وتقسيمه
   ============================================================ */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEnt(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    const r = ENT[e.toLowerCase()];
    return r === undefined ? m : r;
  });
}
const SOUND = /\b(?:music|applause|laughter|laughs|laughing|cheering|cheers|sighs|coughs|silence|inaudible|crowd)\b/i;

/** ينظّف نص كابشن واحد: أكواد التنسيق، الكيانات، [Music]، علامات المتحدث... */
function cleanCue(raw) {
  let t = String(raw || '').replace(/<[^>]*>/g, ' ').replace(/\{\\[^}]*\}/g, ' ');
  t = decodeEnt(t).replace(/[\u00a0\u200b\ufeff]/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\(([^)]{1,30})\)/g, (m, a) => (SOUND.test(a) ? ' ' : m))
    .replace(/[♪♫♬]+/g, ' ')
    .replace(/>>+/g, ' ')
    .replace(/^\s*[-–—]\s+/, '')
    .replace(/^[A-Z][A-Z .'-]{1,24}:\s+/, '')
    .replace(/\s+/g, ' ').trim();
  return t;
}

const ABBR = /^(?:mr|mrs|ms|dr|prof|st|vs|etc|e\.g|i\.e|no|jr|sr|inc|ltd|u\.s|a\.m|p\.m)\.$/i;
const wkey = w => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * cues: [{s,e,t}] بالثواني  →  { sentences:[{s,e,t}], info }
 * - يحذف التكرار (الكابشن الآلي المتدحرج يكرر السطر السابق)
 * - يوزّع زمن كل كابشن على كلماته ثم يقطّع عند نهاية الجملة أو الوقفة الطويلة
 */
function buildSentences(rawCues) {
  const cues = rawCues
    .filter(c => c && c.s != null && isFinite(c.s))
    .map(c => ({ s: +c.s, e: c.e == null ? null : +c.e, t: cleanCue(c.t) }))
    .filter(c => c.t)
    .sort((a, b) => a.s - b.s);

  // أوقات النهاية: إن غابت نأخذ بداية الكابشن التالي، ونقصّ الفراغات الصامتة الطويلة
  cues.forEach((c, i) => {
    const nx = cues[i + 1];
    let e = (c.e != null && c.e > c.s) ? c.e : (nx && nx.s > c.s ? nx.s : c.s + 4);
    const est = Math.max(1.2, c.t.length / 12);
    if (e - c.s > est * 2.5 + 2) e = c.s + est * 1.6 + 0.5;
    c.e = e;
  });

  // حذف التداخل بين كابشن وآخر (آخر k كلمات من السابق = أول k كلمات من الحالي)
  let tail = [], total = 0, removed = 0, withPunct = 0;
  const kept = [];
  for (const c of cues) {
    const ws = c.t.split(' ').filter(Boolean);
    const ks = ws.map(wkey);
    total += ws.length;
    if (/[.!?]/.test(c.t)) withPunct++;
    let k = Math.min(tail.length, ks.length);
    for (; k >= 2; k--) if (tail.slice(-k).every((x, j) => x === ks[j])) break;
    if (k < 2) k = 0;
    const nw = ws.slice(k);
    removed += k;
    if (!nw.length) continue;
    kept.push({ s: c.s, e: c.e, words: nw });
    tail = tail.concat(nw.map(wkey)).slice(-40);
  }

  // خط زمني للكلمات (توزيع تقريبي حسب عدد الحروف)
  const W = [];
  kept.forEach(c => {
    const L = c.words.reduce((a, w) => a + w.length + 1, 0);
    let acc = 0;
    c.words.forEach(w => {
      const a = c.s + (acc / L) * (c.e - c.s);
      acc += w.length + 1;
      W.push({ w, s: a, e: c.s + (acc / L) * (c.e - c.s) });
    });
  });

  // تقطيع إلى جمل
  const groups = [];
  let cur = [];
  const flush = () => { if (cur.length) { groups.push(cur); cur = []; } };
  W.forEach(x => {
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = x.s - prev.e;
      if (gap > 1.2 || (gap > 0.6 && cur.length >= 6)) flush();
    }
    cur.push(x);
    const end = /[.!?…]["')\]”’]*$/.test(x.w) && !ABBR.test(x.w) && !/^[A-Z]\.$/.test(x.w);
    const soft = /[,;:—–]["')\]”’]*$/.test(x.w);
    if (end || cur.length >= MAXW || (soft && cur.length >= SOFT) || (cur.length >= SOFT && x.e - cur[0].s > 9)) flush();
  });
  flush();

  // دمج الجمل القصيرة جدًا (أقل من 3 كلمات) مع الجارة
  const sents = [];
  const lastE = g => g[g.length - 1].e;
  groups.forEach(g => {
    const last = sents[sents.length - 1];
    if (last && last.length < 3 && g[0].s - lastE(last) < 1.5 && last.length + g.length <= MAXW + 4) last.push(...g);
    else sents.push(g);
  });
  if (sents.length > 1) {
    const l = sents[sents.length - 1], p = sents[sents.length - 2];
    if (l.length < 3 && l[0].s - lastE(p) < 1.5) { p.push(...l); sents.pop(); }
  }

  const sentences = sents.map((g, i) => {
    const nx = sents[i + 1];
    const s = Math.max(0, g[0].s - 0.1);
    let e = lastE(g) + 0.35;
    if (nx) e = Math.min(e, Math.max(lastE(g), nx[0].s + 0.1));
    return { s: +s.toFixed(2), e: +Math.max(e, s + 0.8).toFixed(2), t: g.map(x => x.w).join(' ') };
  }).filter(x => /[\p{L}\p{N}]/u.test(x.t));

  const punctRatio = cues.length ? withPunct / cues.length : 1;
  return {
    sentences,
    info: {
      total, removed,
      looksAuto: total > 0 && (removed / total > 0.25 || (total >= 40 && punctRatio < 0.05)),
      latin: latinRatio(cues.map(c => c.t).join(' '))
    }
  };
}
function latinRatio(s) {
  const letters = s.match(/\p{L}/gu) || [];
  if (!letters.length) return 1;
  return letters.filter(c => /[A-Za-z]/.test(c)).length / letters.length;
}

/* ============================================================
   2) المقارنة والتلميحات
   ============================================================ */
// صيغ مختصرة بدون فاصلة علوية يُقبل كتابتها (dont = don't)
const FIX = { dont: "don't", doesnt: "doesn't", didnt: "didn't", cant: "can't", wont: "won't", isnt: "isn't", arent: "aren't", wasnt: "wasn't", werent: "weren't", havent: "haven't", hasnt: "hasn't", couldnt: "couldn't", wouldnt: "wouldn't", shouldnt: "shouldn't", im: "i'm", ive: "i've", youre: "you're", theyre: "they're", weve: "we've", youve: "you've", theyve: "they've" };

/** يحوّل النص إلى كلمات مقارنة: يتجاهل حالة الأحرف والترقيم والمسافات، ويقبل don't = do not و 5 = five */
function tokens(s) {
  const t = String(s || '').toLowerCase().replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/).map(w => w.replace(/^'+|'+$/g, '')).filter(Boolean)
    .map(w => FIX[w] || w).join(' ');
  return norm(t).split(' ').filter(Boolean);
}
function lev(a, b) {
  let p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return p[b.length];
}
// يحلّ مقطعًا من الأخطاء المتجاورة: كلمات كتبها المستخدم (ex) مقابل كلمات ناقصة (ms)
function resolveRun(ex, ms) {
  if (ex.length === ms.length) return ex.map((w, i) => ({ k: 'wrong', typed: w, exp: ms[i] }));
  const pairs = new Map();
  let from = 0;
  ex.forEach((w, i) => {
    let best = -1, bd = 99;
    for (let k = from; k < ms.length; k++) { const d = lev(w, ms[k]); if (d < bd) { bd = d; best = k; } }
    if (best >= 0 && bd <= Math.max(1, Math.floor(Math.max(w.length, ms[best].length) * 0.4))) { pairs.set(i, best); from = best + 1; }
  });
  const res = [];
  let ti = 0;
  ex.forEach((w, i) => {
    if (pairs.has(i)) {
      const k = pairs.get(i);
      for (; ti < k; ti++) res.push({ k: 'miss', exp: ms[ti] });
      res.push({ k: 'wrong', typed: w, exp: ms[k] });
      ti = k + 1;
    } else res.push({ k: 'extra', typed: w });
  });
  for (; ti < ms.length; ti++) res.push({ k: 'miss', exp: ms[ti] });
  return res;
}
/** مقارنة LCS بين كلمات المستخدم والنص الأصلي → مصفوفة {k:'ok'|'wrong'|'miss'|'extra'} */
function compare(user, target) {
  const a = tokens(user), b = tokens(target);
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const ops = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { ops.unshift({ k: 'ok', w: b[j - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { ops.unshift({ k: 'miss', exp: b[j - 1] }); j--; }
    else { ops.unshift({ k: 'extra', typed: a[i - 1] }); i--; }
  }
  const out = [];
  for (let n = 0; n < ops.length;) {
    if (ops[n].k === 'ok') { out.push(ops[n++]); continue; }
    const ex = [], ms = [];
    while (n < ops.length && ops[n].k !== 'ok') { (ops[n].k === 'extra' ? ex : ms).push(ops[n].k === 'extra' ? ops[n].typed : ops[n].exp); n++; }
    out.push(...resolveRun(ex, ms));
  }
  return { T: out, total: b.length };
}
function tally(T) {
  const c = { ok: 0, wrong: 0, miss: 0, extra: 0 };
  T.forEach(x => c[x.k]++);
  c.errors = c.wrong + c.miss + c.extra;
  c.acc = Math.round(c.ok / Math.max(1, c.ok + c.errors) * 100);
  return c;
}
/** تلميح حروف: 1 = عدد الحروف، 2 = أول حرف، 3 = أول حرف + حروف متبادلة + الأخير */
function blank(word, lv) {
  const n = word.length;
  if (lv <= 1) return '_'.repeat(n);
  if (lv === 2) return word[0] + '_'.repeat(Math.max(0, n - 1));
  return [...word].map((ch, i) => (i === 0 || i === n - 1 || i % 2 === 0) ? ch : '_').join('');
}
/** lv 1..3 تلميحات تدريجية، lv >= 4 الإجابة كاملة مع التصحيح */
function renderTokens(T, lv) {
  const full = lv >= 4;
  const sp = (c, h) => `<span class="dt-w ${c}">${h}</span>`;
  return T.map(x => {
    if (x.k === 'ok') return sp('dt-ok', esc(x.w));
    if (x.k === 'extra') return sp('dt-extra', esc(x.typed));
    if (x.k === 'wrong') return full ? sp('dt-bad', `<s>${esc(x.typed)}</s>`) + sp('dt-fix', esc(x.exp)) : sp('dt-bad', esc(x.typed)) + sp('dt-blank', blank(x.exp, lv));
    return full ? sp('dt-miss', esc(x.exp)) : sp('dt-blank', blank(x.exp, lv));
  }).join(' ');
}

/* ============================================================
   3) مشغّل الوسائط — YouTubeAdapter
   واجهة بسيطة: ready / cue / playRange / toggle / stop / setRate / playing
   لدعم فيديو مرفوع أو ملف صوتي لاحقًا، اكتب adapter آخر بنفس الدوال
   (مثلاً حول <video> أو <audio>) وبدّل المتغير Media أدناه.
   ============================================================ */
const YT_ERR = { 2: 'رابط غير صالح', 5: 'خطأ في المشغّل', 100: 'الفيديو غير متاح أو خاص', 101: 'صاحب الفيديو منع تشغيله داخل المواقع الأخرى', 150: 'صاحب الفيديو منع تشغيله داخل المواقع الأخرى', 153: 'يوتيوب لا يسمح بالتشغيل من ملف محلي (file://)، شغّل الموقع عبر https أو خادم محلي' };
const YouTubeAdapter = {
  yt: null, ok: false, starting: false, waiters: [], vid: null, run: null, hooks: {},
  ready(id) {
    if (this.ok) return Promise.resolve();
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('تعذّر تحميل مشغّل يوتيوب. تحقق من الإنترنت ثم أعد تحميل الصفحة.')), 15000);
      this.waiters.push(() => { clearTimeout(to); res(); });
      if (this.starting) return;
      this.starting = true;
      ytEnsure(() => {
        try {
          const pv = { playsinline: 1, rel: 0, iv_load_policy: 3, cc_load_policy: 0, modestbranding: 1 };
          if (/^https?:/.test(location.protocol)) pv.origin = location.origin;
          this.yt = new YT.Player('dtp', {
            videoId: id, host: 'https://www.youtube-nocookie.com', playerVars: pv,
            events: {
              onReady: () => { this.ok = true; this.vid = id; setInterval(() => this._tick(), 80); this.waiters.splice(0).forEach(f => f()); },
              onStateChange: e => this._state(e.data),
              onError: e => this.hooks.onError && this.hooks.onError(YT_ERR[e.data] || ('خطأ ' + e.data))
            }
          });
        } catch (err) { this.starting = false; clearTimeout(to); rej(err); }
      });
    });
  },
  cue(id) { if (this.ok && this.vid !== id) { try { this.yt.cueVideoById(id); } catch (e) {} this.vid = id; } this.run = null; },
  setRate(r) { try { this.yt.setPlaybackRate(r); } catch (e) {} },
  _st() { try { return this.yt.getPlayerState(); } catch (e) { return -1; } },
  playing() { const s = this._st(); return s === 1 || s === 3; },
  hasRun() { return !!this.run; },
  noCaptions() { try { this.yt.unloadModule('captions'); } catch (e) {} try { this.yt.unloadModule('cc'); } catch (e) {} },
  /** يشغّل من s إلى e ثم يتوقف تلقائيًا ويستدعي hooks.onRangeEnd */
  playRange(s, e, rate, noCaps) {
    if (!this.ok) return false;
    try {
      if (noCaps) this.noCaptions();
      this.yt.setPlaybackRate(rate); this.yt.seekTo(s, true); this.yt.playVideo();
    } catch (err) { return false; }
    this.run = { e, grace: Date.now() + 450 };   // مهلة قصيرة: قد يرجع getCurrentTime بالوقت القديم لحظة القفز
    clearTimeout(this.wd);
    this.wd = setTimeout(() => { if (this.run && !this.playing() && this.hooks.onBlocked) this.hooks.onBlocked(); }, 1800);
    return true;
  },
  toggle() { try { this.playing() ? this.yt.pauseVideo() : this.yt.playVideo(); } catch (e) {} },
  stop() { this.run = null; clearTimeout(this.wd); try { if (this.ok) this.yt.pauseVideo(); } catch (e) {} },
  _tick() {
    const r = this.run;
    if (!r || Date.now() < r.grace) return;
    let t; try { t = this.yt.getCurrentTime(); } catch (e) { return; }
    if (t >= r.e) this._end();
  },
  _end() { this.run = null; clearTimeout(this.wd); try { this.yt.pauseVideo(); } catch (e) {} this.hooks.onRangeEnd && this.hooks.onRangeEnd(); },
  _state(s) {
    this.hooks.onState && this.hooks.onState(s === 1 || s === 3);
    if (s === 0 && this.run) this._end();
  }
};
const Media = YouTubeAdapter;

/* ============================================================
   4) جلب الكابشن
   ============================================================ */
/** يطلب الكابشن من خادم صغير (انظر captions-server.js). يعيد {cues,kind,lang,title} أو {err,message} */
async function fetchFromServer(id) {
  const ep = (DB.cfg.endpoint || '').trim();
  if (!ep) return { err: 'noserver' };
  const url = ep + (ep.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(id) + '&lang=en';
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const ct = r.headers.get('content-type') || '';
    if (/json/.test(ct)) {
      const j = await r.json();
      if (!r.ok || j.ok === false) return { err: j.error || ('http' + r.status), message: j.message };
      if (j.lang && !/^en/i.test(j.lang)) return { err: 'not_english' };
      const cues = (j.cues || []).map(c => ({ s: +c.s, e: c.e == null ? null : +c.e, t: String(c.t || '') }));
      return { cues, kind: j.kind || 'unknown', translated: !!j.translated, title: j.title };
    }
    if (!r.ok) return { err: 'http' + r.status };
    return { cues: parseTranscript(await r.text(), false), kind: 'unknown' };
  } catch (e) {
    return { err: e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(to); }
}
async function fetchTitle(id) {
  try {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 5000);
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id), { signal: ac.signal });
    if (r.ok) return clip((await r.json()).title, 120);
  } catch (e) {}
  return '';
}

/* ============================================================
   5) التخزين (localStorage)
   ============================================================ */
function freshDB() { return { v: 1, cfg: { endpoint: '', mode: 'dictation', rate: 1, auto: true, showText: true, mask: true }, last: null, practices: {} }; }
let DB = (function () {
  const d = load(KEY, null), f = freshDB();
  if (!d || typeof d !== 'object') return f;
  d.cfg = Object.assign(f.cfg, d.cfg || {});
  if (!d.practices || typeof d.practices !== 'object') d.practices = {};
  return Object.assign(f, d);
})();
function persist() {
  const ids = Object.keys(DB.practices);
  if (ids.length > MAX_PRACTICES) ids.sort((a, b) => (DB.practices[a].updated || 0) - (DB.practices[b].updated || 0)).slice(0, ids.length - MAX_PRACTICES).forEach(i => delete DB.practices[i]);
  return save(KEY, DB);
}
function sanitizePractice(p) {
  if (!p || typeof p !== 'object' || !ytId(p.id) || !Array.isArray(p.segs)) return null;
  const num = v => (isFinite(+v) ? +v : 0);
  const segs = p.segs.slice(0, MAX_SENTENCES).map(x => ({ s: num(x && x.s), e: num(x && x.e), t: clip(x && x.t, 500) })).filter(x => x.t && x.e > x.s);
  if (!segs.length) return null;
  const prog = {};
  Object.keys(p.prog || {}).forEach(k => {
    const o = p.prog[k], i = +k;
    if (i >= 0 && i < segs.length && o) prog[i] = { a: Math.max(0, num(o.a) | 0), st: ['done', 'skipped', 'revealed'].includes(o.st) ? o.st : 'new', best: Math.min(100, Math.max(0, num(o.best))) };
  });
  const t = p.tot || {};
  return {
    id: p.id, title: clip(p.title, 120) || p.id, segs, prog,
    kind: ['manual', 'asr', 'unknown'].includes(p.kind) ? p.kind : 'unknown', warn: clip(p.warn, 400),
    mode: p.mode === 'shadowing' ? 'shadowing' : 'dictation',
    cur: Math.min(segs.length - 1, Math.max(0, num(p.cur) | 0)),
    tot: { cw: Math.max(0, num(t.cw)), er: Math.max(0, num(t.er)), aw: Math.max(0, num(t.aw)) },
    created: num(p.created) || Date.now(), updated: num(p.updated) || Date.now()
  };
}

/* ============================================================
   6) واجهة التمرين
   ============================================================ */
let cur = null;          // التمرين الحالي
let advTimer = null;     // مؤقت الانتقال التلقائي

const prog = i => (cur.prog[i] || (cur.prog[i] = { a: 0, st: 'new', best: 0 }));
const stOf = i => (cur.prog[i] ? cur.prog[i].st : 'new');
const isOpen = i => { const s = stOf(i); return s === 'new' || s === 'skipped'; };
const mode = () => cur.mode;
const show = (id, on) => $(id).classList.toggle('hidden', !on);

function setMsg(html, type) {
  const m = $('dtMsg');
  m.className = 'dt-msg' + (type ? ' ' + type : '');
  m.innerHTML = html;
}

/* ---------- إنشاء تمرين ---------- */
async function startFromUrl() {
  const id = ytId($('dtUrl').value);
  if (!id) { setMsg('الرابط غير صالح. ألصق رابط يوتيوب كاملًا مثل https://www.youtube.com/watch?v=XXXXXXXXXXX', 'bad'); return; }
  if (DB.practices[id]) { setMsg('وجدت تمرينًا محفوظًا لهذا الفيديو، سأفتحه ويكمل من حيث توقفت.', 'ok'); openPractice(id); return; }
  show('dtManual', false);
  if (!(DB.cfg.endpoint || '').trim()) { manualFallback('لم يتم ضبط خادم لجلب الكابشن تلقائيًا (اختياري). استخدم الطريقة اليدوية أدناه.'); return; }
  setMsg('جارٍ جلب الترجمة من الخادم…');
  $('dtLoad').disabled = true;
  const r = await fetchFromServer(id);
  $('dtLoad').disabled = false;
  if (r.err) {
    const why = {
      no_captions: NO_CAPTIONS_MSG,
      not_english: 'الترجمة المتوفرة ليست إنجليزية. اختر فيديو يحتوي على كابشن إنجليزي.',
      network: 'تعذّر الاتصال بخادم الكابشن (الخادم متوقف أو يوجد حظر CORS).',
      timeout: 'انتهت مهلة خادم الكابشن.'
    }[r.err] || ('فشل جلب الترجمة: ' + (r.message || r.err));
    if (r.err === 'no_captions' || r.err === 'not_english') { show('dtManual', true); setMsg(esc(why) + '<br>يمكنك مع ذلك لصق نص إنجليزي بأوقاته يدويًا أدناه.', 'bad'); }
    else manualFallback(why);
    return;
  }
  const kind = r.translated ? 'unknown' : (r.kind === 'asr' ? 'asr' : (r.kind === 'manual' ? 'manual' : 'unknown'));
  await createPractice(id, r.title, r.cues, { kind, translated: r.translated });
}
function manualFallback(why) {
  show('dtManual', true);
  setMsg(esc(why) + '<br>الصق نص الفيديو بأوقاته (أو ارفع ملف SRT/VTT) في الصندوق أدناه ثم اضغط «ابدأ التمرين».', 'bad');
}

async function createPractice(id, title, cues, meta) {
  meta = meta || {};
  if (!cues || !cues.length) { setMsg(esc(NO_CAPTIONS_MSG), 'bad'); return; }
  if (!cues.some(c => c.s != null)) {
    setMsg('النص لا يحتوي على أوقات، والتمرين يحتاجها ليعرف أين تبدأ وتنتهي كل جملة. أضف الوقت في بداية كل سطر هكذا:<br><span dir="ltr">0:05 Hello, how are you?</span><br>أو استخدم ملف SRT/VTT.', 'bad');
    show('dtManual', true); return;
  }
  const { sentences, info } = buildSentences(cues);
  if (!sentences.length) { setMsg('لم أجد جملًا صالحة في هذا النص.', 'bad'); show('dtManual', true); return; }
  if (info.latin < 0.6) { setMsg('هذا النص لا يبدو إنجليزيًا. هذه الميزة مخصصة للإنجليزية.', 'bad'); show('dtManual', true); return; }
  let segs = sentences;
  if (segs.length > MAX_SENTENCES) { segs = segs.slice(0, MAX_SENTENCES); toast(`تم اقتصار التمرين على أول ${MAX_SENTENCES} جملة`, 'info'); }

  let warn = '';
  if (meta.translated) warn = '⚠️ هذه الترجمة مترجمة آليًا وليست الكلام الأصلي، قد تكون الجمل مختلفة عما تسمعه. يُفضَّل فيديو بكابشن إنجليزي أصلي.';
  else if (meta.kind === 'asr') warn = '⚠️ هذه ترجمة مولّدة آليًا من يوتيوب (ASR): قد تحتوي أخطاء في بعض الكلمات والأسماء وعلامات الترقيم. إن بدت لك كلمة غير منطقية فقد يكون الخطأ من الترجمة وليس منك.';
  else if (info.looksAuto) warn = '⚠️ يبدو أن هذا النص مولّد آليًا (بدون علامات ترقيم أو فيه تكرار). قد تكون حدود الجمل والكلمات غير دقيقة.';

  const t = clip($('dtTitleIn').value, 120) || clip(title, 120) || (await fetchTitle(id)) || id;
  DB.practices[id] = {
    id, title: t, segs, prog: {}, kind: meta.kind || 'unknown', warn,
    mode: DB.cfg.mode, cur: 0, tot: { cw: 0, er: 0, aw: 0 }, created: Date.now(), updated: Date.now()
  };
  if (!persist()) return;
  setMsg(`تم تجهيز ${segs.length} جملة ✔`, 'ok');
  openPractice(id);
}

function buildFromManual() {
  const id = ytId($('dtUrl').value);
  if (!id) { setMsg('ألصق رابط يوتيوب صالحًا في الحقل بالأعلى أولًا.', 'bad'); $('dtUrl').focus(); return; }
  const raw = $('dtRaw').value.trim();
  if (!raw) { setMsg('ألصق نص الترجمة بأوقاته أو ارفع ملف SRT/VTT.', 'bad'); return; }
  if (DB.practices[id] && !twice('dtover', 'يوجد تمرين محفوظ لهذا الفيديو. اضغط مرة أخرى خلال 3 ثوانٍ لاستبداله (سيُصفَّر تقدمه)')) return;
  createPractice(id, '', parseTranscript(raw, false), { kind: 'manual' });
}

/* ---------- القائمة الجانبية: التمارين المحفوظة ---------- */
function pct(p) {
  const n = p.segs.length; let h = 0;
  for (let i = 0; i < n; i++) if (p.prog[i] && p.prog[i].st !== 'new') h++;
  return Math.round(h / n * 100);
}
function renderRecent() {
  const list = Object.values(DB.practices).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  $('dtRecent').innerHTML = list.length ? list.map(p => `<div class="dt-item"><div class="dt-info"><b>${esc(p.title)}</b><span>${p.segs.length} جملة · تقدم ${pct(p)}%</span></div><button data-open="${esc(p.id)}">فتح</button><button class="ghost" data-del="${esc(p.id)}" aria-label="حذف التمرين">🗑</button></div>`).join('') : '<div class="dt-note">لا توجد تمارين محفوظة بعد.</div>';
}

/* ---------- فتح تمرين ---------- */
function openPractice(id) {
  const p = DB.practices[id];
  if (!p) return;
  cur = p; DB.last = id;
  persist();
  show('dtSetup', false); show('dtPractice', true);
  $('dtTitle').textContent = p.title;
  const w = $('dtWarn'); w.textContent = p.warn || ''; w.classList.toggle('hidden', !p.warn);
  $('dtRate').value = String(DB.cfg.rate); $('dtAuto').checked = !!DB.cfg.auto;
  $('dtVidMsg').innerHTML = '';
  Media.hooks = { onRangeEnd, onState, onBlocked: () => toast('اضغط ▶ لبدء التشغيل (المتصفح منع التشغيل التلقائي)', 'info'), onError: msg => { $('dtVidMsg').innerHTML = `تعذّر تشغيل الفيديو: ${esc(msg)}. <a class="chip" href="https://www.youtube.com/watch?v=${esc(p.id)}" target="_blank" rel="noopener">▶ فتح في يوتيوب</a>`; } };
  applyMode();
  goTo(p.cur || 0, { autoplay: false });
  Media.ready(p.id).then(() => { Media.cue(p.id); Media.setRate(+DB.cfg.rate); if (cur && cur.mode === 'dictation') Media.noCaptions(); })
    .catch(e => { $('dtVidMsg').textContent = e.message; });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function closePractice() {
  Media.stop(); clearTimeout(advTimer);
  cur = null; show('dtPractice', false); show('dtSetup', true); renderRecent();
}

/* ---------- الوضع ---------- */
function applyMode() {
  const d = mode() === 'dictation';
  $('dtModeD').classList.toggle('on', d); $('dtModeS').classList.toggle('on', !d);
  $('dtModeD').setAttribute('aria-pressed', d); $('dtModeS').setAttribute('aria-pressed', !d);
  show('dtTextToggle', !d);
  show('dtMaskBtn', d);
  $('dtMask').classList.toggle('on', d && !!DB.cfg.mask);
  $('dtMaskBtn').textContent = DB.cfg.mask ? 'إظهار شريط الفيديو السفلي' : 'إخفاء ترجمة يوتيوب (حاجب)';
  $('dtNote').textContent = d
    ? 'وضع الإملاء: النص مخفي تمامًا حتى تجيب. يغطي شريط أسود أسفل الفيديو ترجمة يوتيوب إن ظهرت.'
    : 'وضع الشادوينج: النص ظاهر كتلميح (يمكنك إخفاؤه). استمع للجملة ورددها ثم اكتبها.';
  if (d && Media.ok) Media.noCaptions();
}
function setMode(m) {
  if (!cur || cur.mode === m) return;
  cur.mode = m; DB.cfg.mode = m; cur.updated = Date.now(); persist();
  applyMode(); renderAll();
}

/* ---------- التنقل ---------- */
function goTo(i, o) {
  if (!cur) return;
  i = Math.max(0, Math.min(cur.segs.length - 1, i));
  clearTimeout(advTimer); Media.stop();
  cur.cur = i; cur.updated = Date.now(); persist();
  $('dtInput').value = '';
  renderAll();
  const s = stOf(i);
  setResult(`<div class="dt-head">اضغط ▶ لسماع الجملة ثم اكتب ما سمعته واضغط <b>Enter</b>.${s === 'done' ? '<br>✅ هذه الجملة مكتملة، يمكنك إعادة التمرن عليها.' : s === 'revealed' ? '<br>👁 تم كشف إجابتها سابقًا.' : s === 'skipped' ? '<br>⏭ تم تخطيها سابقًا.' : ''}</div>`);
  if (o && o.autoplay) playSentence(i);
}
const next = auto => { if (!cur) return; if (cur.cur >= cur.segs.length - 1) { allDoneCheck(true); return; } goTo(cur.cur + 1, { autoplay: auto !== false }); };
const prev = () => { if (cur && cur.cur > 0) goTo(cur.cur - 1, { autoplay: true }); else toast('هذه أول جملة', 'info'); };

/* ---------- التشغيل ---------- */
function playSentence(i) {
  const sg = cur.segs[i];
  clearTimeout(advTimer);
  Media.ready(cur.id).then(() => {
    Media.cue(cur.id);
    if (!Media.playRange(sg.s, sg.e, +DB.cfg.rate, mode() === 'dictation')) toast('المشغّل غير جاهز بعد، حاول مرة أخرى', 'info');
  }).catch(e => { $('dtVidMsg').textContent = e.message; });
}
function onRangeEnd() { updPlayBtn(false); $('dtInput').focus({ preventScroll: true }); }
function onState(playing) { updPlayBtn(playing); }
function updPlayBtn(p) { $('dtPlay').textContent = p ? '⏸ إيقاف' : '▶ تشغيل'; }
function togglePlay() {
  if (!cur) return;
  if (Media.playing()) Media.toggle();
  else if (Media.hasRun()) Media.toggle();
  else playSentence(cur.cur);
}

/* ---------- التحقق ---------- */
function setResult(html) { $('dtResult').innerHTML = html; }
function check() {
  if (!cur) return;
  const i = cur.cur, sg = cur.segs[i], typed = $('dtInput').value.replace(/\s+/g, ' ').trim();
  if (!typed) { toast('اكتب ما سمعته أولًا', 'info'); $('dtInput').focus(); return; }
  clearTimeout(advTimer);
  const { T } = compare(typed, sg.t), c = tally(T), pr = prog(i), wasOpen = isOpen(i);
  pr.a++; pr.best = Math.max(pr.best || 0, c.acc);
  cur.tot.cw += c.ok; cur.tot.er += c.errors; cur.tot.aw += c.ok + c.errors;
  cur.updated = Date.now();

  if (c.errors === 0) {
    let msg = '';
    if (wasOpen && pr.st !== 'revealed') {
      pr.st = 'done';
      const xp = pr.a === 1 ? 10 : 5;
      gain(xp); bump('video');
      msg = ` +${xp} نقطة`;
    }
    setResult(`<div class="dt-head">✅ <b class="ok">صحيح!</b> المحاولة ${pr.a}${msg}</div><div class="dt-res">${renderTokens(T, 4)}</div>`);
    persist(); renderAll();
    if (!allDoneCheck(false)) {
      if (i >= cur.segs.length - 1) allDoneCheck(true);
      else if ($('dtAuto').checked) advTimer = setTimeout(() => goTo(i + 1, { autoplay: true }), 1400);
    }
    return;
  }

  // خطأ: تلميحات تدريجية
  const lv = wasOpen ? Math.min(pr.a, 4) : 4;
  if (wasOpen && lv >= 4) pr.st = 'revealed';
  if (pr.a === 1) {
    const words = T.filter(x => x.k === 'wrong' || x.k === 'miss').map(x => x.exp);
    saveMistake(typed, sg.t, 'video', words, '');
  }
  const bits = [`✔ ${c.ok} كلمة صحيحة من ${c.ok + c.wrong + c.miss}`];
  if (c.wrong) bits.push(`${c.wrong} خاطئة`);
  if (c.miss) bits.push(`${c.miss} ناقصة`);
  if (c.extra) bits.push(`${c.extra} زائدة`);
  const hintTxt = {
    1: 'تلميح 1: الشرطات تمثّل عدد حروف الكلمة المطلوبة.',
    2: 'تلميح 2: أول حرف من كل كلمة ناقصة أو خاطئة.',
    3: 'تلميح 3: بعض حروف الكلمة. المحاولة القادمة ستكشف الإجابة كاملة.',
    4: 'هذه هي الإجابة الصحيحة مع التصحيح. اسمع الجملة مرة أخرى وانتبه للفرق.'
  }[lv];
  setResult(`<div class="dt-head">❌ المحاولة ${pr.a} · دقة هذه المحاولة <b>${c.acc}%</b><br>${bits.join(' · ')}</div>
    <div class="dt-res">${renderTokens(T, lv)}</div>
    <div class="dt-hintbox">${hintTxt}</div>
    ${lv >= 4 ? `<div class="dt-full"><span class="ok">${esc(sg.t)}</span></div>` : ''}
    <div class="dt-legend"><span class="ok">أخضر</span> صحيح · <span class="bad">أحمر</span> خاطئ · <span class="miss">أصفر</span> ناقص · <span>رمادي مشطوب</span> زائد</div>`);
  persist(); renderAll();
  allDoneCheck(false);
}

function reveal() {
  if (!cur) return;
  const i = cur.cur, sg = cur.segs[i], pr = prog(i);
  if (isOpen(i)) pr.st = 'revealed';
  cur.updated = Date.now();
  const typed = $('dtInput').value.trim();
  let body = `<div class="dt-full" style="border:0;padding:0;margin:0"><span class="ok">${esc(sg.t)}</span></div>`;
  if (typed) { const { T } = compare(typed, sg.t); body = `<div class="dt-res">${renderTokens(T, 4)}</div>` + body.replace('margin:0', 'margin-top:8px'); }
  setResult(`<div class="dt-head">👁 الإجابة الصحيحة:</div>${body}`);
  persist(); renderAll(); allDoneCheck(false);
}
function skip() {
  if (!cur) return;
  const i = cur.cur, pr = prog(i);
  if (pr.st === 'new') pr.st = 'skipped';
  cur.updated = Date.now(); persist(); renderAll();
  if (!allDoneCheck(false) && i < cur.segs.length - 1) goTo(i + 1, { autoplay: true });
  else if (i >= cur.segs.length - 1) allDoneCheck(true);
}
function restart() { if (cur) goTo(0, { autoplay: true }); }
function resetProgress() {
  if (!cur || !twice('dtreset', 'اضغط مرة أخرى خلال 3 ثوانٍ لتصفير تقدم هذا التمرين')) return;
  cur.prog = {}; cur.tot = { cw: 0, er: 0, aw: 0 }; cur.cur = 0; persist();
  goTo(0, { autoplay: false }); toast('تم تصفير التقدم', 'ok');
}

/** هل عولجت كل الجمل؟ (مكتملة/متخطاة/مكشوفة). show=true يعرض ملخصًا */
function allDoneCheck(showSummary) {
  const n = cur.segs.length;
  let handled = 0;
  for (let i = 0; i < n; i++) if (stOf(i) !== 'new') handled++;
  const all = handled === n;
  if (all || showSummary) {
    const s = summary();
    if (all) { clearTimeout(advTimer); Media.stop(); }
    $('dtResult').insertAdjacentHTML('beforeend', `<div class="dt-hintbox" style="border-color:var(--green)">${all ? '🎉 <b>أنهيت التمرين!</b>' : 'وصلت لآخر جملة.'} مكتملة ${s.done}/${n} · الدقة ${s.acc} · متخطاة ${s.skipped}. ${s.open ? `بقيت ${s.open} جملة لم تعالجها.` : ''}</div>`);
    if (all && !cur._celebrated) { cur._celebrated = true; toast('🎉 أنهيت التمرين!', 'ok'); }
  }
  return all;
}

/* ---------- الرسم ---------- */
function summary() {
  const n = cur.segs.length;
  let done = 0, skipped = 0, rev = 0;
  for (let i = 0; i < n; i++) { const s = stOf(i); if (s === 'done') done++; else if (s === 'skipped') skipped++; else if (s === 'revealed') rev++; }
  const t = cur.tot;
  return { done, skipped, rev, open: n - done - skipped - rev, acc: t.aw ? Math.round(t.cw / t.aw * 100) + '%' : '—', n };
}
function textVisible(i) {
  if (mode() === 'shadowing') return !!DB.cfg.showText;
  const s = stOf(i);
  return s === 'done' || s === 'revealed';
}
function renderAll() {
  if (!cur) return;
  const i = cur.cur, n = cur.segs.length, sg = cur.segs[i], pr = cur.prog[i] || { a: 0, st: 'new' }, s = summary();
  $('dtPos').textContent = `الجملة ${i + 1} من ${n}`;
  $('dtAtt').innerHTML = `<span>المحاولات: ${pr.a}</span><span>${fmtT(sg.s)}</span>`;
  $('dtBarI').style.width = Math.round((s.done + s.skipped + s.rev) / n * 100) + '%';
  const box = $('dtSent');
  if (textVisible(i)) { box.className = 'dt-sent'; box.textContent = sg.t; }
  else { box.className = 'dt-sent dt-hiddenline'; box.textContent = mode() === 'dictation' ? '🎧 استمع للجملة ثم اكتب ما سمعته' : '🙈 النص مخفي (اضغط «إظهار النص» لتلميح)'; }
  $('dtTextToggle').textContent = DB.cfg.showText ? 'إخفاء النص' : 'إظهار النص';
  $('dtStats').innerHTML = [
    ['الجمل المكتملة', `${s.done}/${n}`], ['الدقة', s.acc], ['كلمات صحيحة', cur.tot.cw],
    ['الأخطاء', cur.tot.er], ['محاولات هذه الجملة', pr.a], ['متخطاة', s.skipped]
  ].map(([a, b]) => `<div class="stat"><b>${b}</b><span>${a}</span></div>`).join('');
  renderList();
}
function renderList() {
  const box = $('dtList'), top = box.scrollTop;
  const icon = { new: '⬜', done: '✅', skipped: '⏭', revealed: '👁' };
  box.innerHTML = cur.segs.map((sg, i) => {
    const st = stOf(i), a = cur.prog[i] ? cur.prog[i].a : 0, vis = textVisible(i);
    const txt = vis ? esc(sg.t) : `<span class="dt-dots">••• ${sg.t.split(/\s+/).length} كلمة</span>`;
    return `<div class="line dt-row ${st}${i === cur.cur ? ' active' : ''}" data-i="${i}" role="button" tabindex="0"><div class="lt"><span class="ln">${icon[st]} ${i + 1}</span><span class="tx">${txt}</span></div><div class="dt-sub">${fmtT(sg.s)}${a ? ` · محاولات: ${a}` : ''}</div></div>`;
  }).join('');
  box.scrollTop = top;
  const act = box.querySelector('.line.active');
  if (act) { const r = act.getBoundingClientRect(), b = box.getBoundingClientRect(); if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += (r.top - b.top) - b.height / 3; }
}

/* ---------- ربط الأحداث ---------- */
$('dtLoad').onclick = startFromUrl;
$('dtUrl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); startFromUrl(); } });
$('dtShowManual').onclick = () => { show('dtManual', true); $('dtRaw').focus(); };
$('dtFileBtn').onclick = () => $('dtFile').click();
$('dtFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { $('dtRaw').value = await f.text(); toast('تم تحميل الملف. اضغط «ابدأ التمرين»', 'ok'); } catch (err) { toast('تعذّر قراءة الملف', 'err'); }
};
$('dtBuild').onclick = buildFromManual;
$('dtSaveEp').onclick = () => {
  const v = $('dtEndpoint').value.trim();
  if (v && !/^(https?:\/\/|\/)/i.test(v)) { toast('عنوان الخادم يجب أن يبدأ بـ http:// أو https:// أو /', 'err'); return; }
  DB.cfg.endpoint = v; persist(); toast(v ? 'تم حفظ عنوان الخادم' : 'تم إلغاء الخادم', 'ok');
};
$('dtRecent').onclick = e => {
  const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]');
  if (o) { openPractice(o.dataset.open); return; }
  if (d) {
    if (!twice('dtdel' + d.dataset.del, 'اضغط مرة أخرى خلال 3 ثوانٍ لحذف التمرين وتقدمه')) return;
    delete DB.practices[d.dataset.del]; persist(); renderRecent(); toast('تم الحذف', 'ok');
  }
};
$('dtBack').onclick = closePractice;
$('dtModeD').onclick = () => setMode('dictation');
$('dtModeS').onclick = () => setMode('shadowing');
$('dtTextToggle').onclick = () => { DB.cfg.showText = !DB.cfg.showText; persist(); renderAll(); };
$('dtMaskBtn').onclick = () => { DB.cfg.mask = !DB.cfg.mask; persist(); applyMode(); };
$('dtRate').onchange = e => { DB.cfg.rate = +e.target.value; persist(); Media.setRate(DB.cfg.rate); };
$('dtAuto').onchange = e => { DB.cfg.auto = e.target.checked; persist(); };
$('dtCheck').onclick = check;
$('dtPlay').onclick = togglePlay;
$('dtReplay').onclick = () => { if (cur) playSentence(cur.cur); };
$('dtPrev').onclick = prev;
$('dtNext').onclick = () => next(true);
$('dtRestart').onclick = restart;
$('dtReveal').onclick = reveal;
$('dtSkip').onclick = skip;
$('dtReset').onclick = resetProgress;
$('dtInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); check(); } });
// بعض كيبوردات الجوال تُدخل سطرًا جديدًا بدل keydown: نعتبره Enter
$('dtInput').addEventListener('input', e => { const t = e.target; if (t.value.includes('\n')) { t.value = t.value.replace(/\n+/g, ' ').trimStart(); check(); } });
$('dtList').addEventListener('click', e => { const r = e.target.closest('.line[data-i]'); if (r) goTo(+r.dataset.i, { autoplay: true }); });
$('dtList').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const r = e.target.closest('.line[data-i]'); if (r) { e.preventDefault(); goTo(+r.dataset.i, { autoplay: true }); } } });

/* ---------- التكامل مع بقية الموقع ---------- */
if (!TABS.includes('dictate')) TABS.push('dictate');
const baseStopAll = window.stopAll;
window.stopAll = function () { baseStopAll.apply(this, arguments); Media.stop(); clearTimeout(advTimer); };   // إيقاف الفيديو عند تغيير التبويب
const baseOpenTab = window.openTab;
window.openTab = function (t) { baseOpenTab.apply(this, arguments); if (t === 'dictate') onShow(); };
function onShow() { if (!cur) renderRecent(); }

$('dtEndpoint').value = DB.cfg.endpoint || '';
renderRecent();

/* واجهة عامة صغيرة (للنسخ الاحتياطي وللاختبار) */
window.Dictation = {
  exportData: () => DB,
  importData(o) {
    if (!o || typeof o !== 'object' || !o.practices) return;
    Object.keys(o.practices).forEach(k => {
      const p = sanitizePractice(o.practices[k]);
      if (p && (!DB.practices[p.id] || (DB.practices[p.id].updated || 0) < p.updated)) DB.practices[p.id] = p;
    });
    persist(); renderRecent();
  },
  _t: { buildSentences, compare, tally, tokens, cleanCue, blank, renderTokens }
};
})();
