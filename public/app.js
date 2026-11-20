/* Workshop app: "Pick it up where you left off". Vanilla JS, no build step, no third-party code.
 * All user-supplied text is rendered with textContent (via h()). innerHTML is never used with data.
 * Two backends behind one api(method, subPath, body) function:
 *   online  -> the Node server REST API + SSE (see server.js)
 *   offline -> Local engine on localStorage (single user, not shared)
 */
(function () {
'use strict';
const SEED = window.PU_SEED || { stages: [], entryPoints: [], categories: [], experiments: [], nextSteps: {}, kpis: {}, evidence: [], assumptions: [], risks: [], openQuestions: [], states: [], problem: { problems: [], objectives: [] } };
const DISCOVERY_URL = '/discovery/pick-up-where-you-left-off.html';
const CAT = Object.fromEntries(SEED.categories.map((c) => [c.id, c]));
const ENTRY = Object.fromEntries(SEED.entryPoints.map((e) => [e.id, e]));
const STATUSES = ['open', 'discussing', 'decided', 'parked'];
const STEP_TYPES = ['experiment', 'action', 'research'];
const QUADS = [
  { id: 'quick-win', label: 'Quick win', desc: 'high value, low effort', x: 25, y: 75 },
  { id: 'big-bet', label: 'Big bet', desc: 'high value, high effort', x: 75, y: 75 },
  { id: 'fill-in', label: 'Fill-in', desc: 'lower value, low effort', x: 25, y: 25 },
  { id: 'reconsider', label: 'Reconsider', desc: 'lower value, high effort', x: 75, y: 25 },
];
const QLABEL = Object.fromEntries(QUADS.map((q) => [q.id, q.label]));
const ACTIVITY = { 'note.add': 'added a note', 'note.edit': 'edited a note', 'note.move': 'moved a note', 'note.delete': 'deleted a note', 'vote.add': 'placed a dot', 'vote.remove': 'removed a dot',
  'placement.set': 'placed an entry point on the 2x2', 'placement.remove': 'removed a 2x2 placement', 'stage.change': 'changed the stage', 'timer.start': 'started the timer', 'timer.stop': 'stopped the timer',
  'votes.reveal': 'changed vote visibility', 'voting.lock': 'changed voting lock', 'question.add': 'added a question or decision', 'nextstep.add': 'added a next step' };

/* ------------------------------------------------------------------ helpers */
let uidN = 0;
const uid = (p) => (p || 'u') + (++uidN);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected' || k === 'draggable') el[k] = v;
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}
const $ = (s, r) => (r || document).querySelector(s);
function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function mount(host, ...kids) { clearEl(host); kids.forEach((k) => k && host.appendChild(k)); }
function clean(v, max, multi) {
  if (typeof v !== 'string') return '';
  let s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
  s = multi ? s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max);
}
const short = (t, n) => (t.length > n ? t.slice(0, n - 1) + '\u2026' : t);
function toast(msg, isErr) {
  const t = h('div', { class: 'toast' + (isErr ? ' err' : ''), text: msg });
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3500);
}
function announce(msg) { const a = $('#announcer'); a.textContent = ''; setTimeout(() => { a.textContent = msg; }, 30); }
const fmtTime = (ms) => { const s = Math.ceil(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const fmtDate = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
};
const ids = () => store.get('pu.ids', {});
const rememberId = (id, rec) => { const m = ids(); m[id] = rec; store.set('pu.ids', m); };
const forgetId = (id) => { const m = ids(); delete m[id]; store.set('pu.ids', m); };
function parseRoom(input) {
  const s = String(input || '').trim();
  const m = /\/s\/([A-Za-z0-9]{4,12})/.exec(s) || /^([A-Za-z0-9]{4,12})$/.exec(s);
  return m ? m[1].toUpperCase() : '';
}
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ------------------------------------------------------------------ state */
const S = {
  mode: null, // 'online' | 'offline'
  screen: 'landing', serverUp: null, id: null, token: null, readOnly: false,
  view: null, viewStage: null, lastStage: null, connected: false, offset: 0, sse: null,
  activity: [], lastRemaining: null, announcedExpiry: null, dirty: false, dragId: null, pointerDrag: false,
  pin: null, joinInfo: null, sessionsList: null,
  ui: { drafts: {}, openAdd: null, editNote: null, editQ: null, editStep: null, drawer: {}, matrixSel: null, showAvg: true },
};

/* ------------------------------------------------------------------ API layer */
async function req(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  let res;
  try { res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); } catch (e) { const er = new Error('Cannot reach the server.'); er.code = 'network'; throw er; }
  const type = res.headers.get('content-type') || '';
  if (!res.ok) {
    let er = new Error('Request failed (' + res.status + ')');
    if (type.includes('json')) { try { const j = await res.json(); if (j.error) { er = new Error(j.error.message || j.error.code); er.code = j.error.code; } } catch (e) { /* ignore */ } }
    er.status = res.status; throw er;
  }
  if (res.status === 204) return {};
  return type.includes('json') ? res.json() : res;
}
function api(method, sub, body) {
  if (S.mode === 'offline') return Local.handle(method, sub, body);
  return req(method, '/api/sessions/' + S.id + sub, body);
}
const FRIENDLY = { no_dots_left: 'No dots left. Remove one first to move it.', voting_locked: 'Voting is locked by the facilitator.', forbidden: 'Only the facilitator can do that.',
  unauthorized: 'Your session has expired. Rejoin the room.', rate_limited: 'Too many requests. Wait a moment.', network: 'Cannot reach the server.' };
async function act(method, sub, body) {
  try {
    const r = await api(method, sub, body);
    if (S.mode === 'online' && !S.connected) await refreshState();
    return r;
  } catch (e) {
    toast(FRIENDLY[e.code] || e.message || 'Something went wrong.', true);
    if (S.mode === 'online') refreshState();
    return null;
  }
}
async function refreshState() {
  try {
    const v = await req('GET', '/api/sessions/' + S.id + (S.readOnly ? '/readonly' : '/state'));
    setView(v);
  } catch (e) { /* connection state shown elsewhere */ }
}

/* ------------------------------------------------------------------ Local (offline) engine */
const Local = {
  KEY: 'pu.offline.v1', s: null,
  load() { this.s = store.get(this.KEY, null); return this.s; },
  save() { this.s.rev++; store.set(this.KEY, this.s); },
  init(name, title) {
    const t = Date.now();
    const s = { rev: 0, title: clean(title, 120) || 'Pick it up where you left off: offline demo', name: clean(name, 40) || 'You', createdAt: t,
      settings: { dotsPerParticipant: 5, anonymous: false, votingLocked: false, votesRevealed: true }, stage: SEED.stages[0].id,
      timer: { running: false, durationSec: 0, endsAt: null }, notes: [], votes: [], placements: [], questions: [], nextSteps: [], recommendation: { mvp: [], postMvp: [], rationale: '' } };
    const order = {};
    const add = (stage, column, category, text) => { const k = stage + '|' + column; order[k] = (order[k] || 0) + 1; s.notes.push({ id: 'n' + Math.random().toString(36).slice(2, 9), stage, column, order: order[k], category, text, seed: true, mine: false, createdAt: t, updatedAt: t }); };
    SEED.assumptions.forEach((a) => add('assumptions', a.column, 'assumption', a.id + ' (' + a.type + '): ' + a.text));
    SEED.risks.forEach((r) => add('assumptions', r.column, 'concern', r.title + ': ' + r.text));
    SEED.openQuestions.forEach((q) => s.questions.push({ id: 'q' + q.id, kind: 'question', text: q.id + ': ' + q.text, owner: q.owner, status: 'open', decision: '', gate: q.gate, seed: true, mine: false, createdAt: t, updatedAt: t }));
    this.s = s; this.save();
  },
  stage(id) { return SEED.stages.find((x) => x.id === id); },
  err(status, code, message) { const e = new Error(message || code); e.status = status; e.code = code; return e; },
  used(stageId) { return this.s.votes.filter((v) => v.stage === stageId).length; },
  view() {
    const s = this.s; const anon = s.settings.anonymous; const now = Date.now();
    const cnt = {}; const mine = {};
    s.votes.forEach((v) => { const k = v.targetType + ':' + v.targetId; cnt[k] = (cnt[k] || 0) + 1; });
    s.votes.forEach((v) => { const k = v.targetType + ':' + v.targetId; mine[k] = (mine[k] || 0) + 1; });
    const entries = SEED.entryPoints.map((e) => {
      const pl = s.placements.filter((p) => p.entryId === e.id);
      const avg = pl.length ? { x: Math.round(pl.reduce((a, p) => a + p.x, 0) / pl.length * 10) / 10, y: Math.round(pl.reduce((a, p) => a + p.y, 0) / pl.length * 10) / 10, n: pl.length } : null;
      const quad = avg ? (avg.y >= 50 ? (avg.x < 50 ? 'quick-win' : 'big-bet') : (avg.x < 50 ? 'fill-in' : 'reconsider')) : null;
      return { id: e.id, votes: { total: cnt['entry:' + e.id] || 0, mine: mine['entry:' + e.id] || 0 }, placement: { mine: pl[0] ? { x: pl[0].x, y: pl[0].y } : null, avg, quadrant: quad, all: pl.map((p) => ({ x: p.x, y: p.y })) } };
    });
    const remaining = {}; const used = {};
    SEED.stages.forEach((st) => { if (st.votable || st.id === 'entry-vote') { used[st.id] = this.used(st.id); remaining[st.id] = Math.max(0, s.settings.dotsPerParticipant - used[st.id]); } });
    const tm = s.timer; const rem = tm.running && tm.endsAt ? Math.max(0, tm.endsAt - now) : 0;
    const top = entries.filter((e) => e.votes.total > 0).sort((a, b) => b.votes.total - a.votes.total).map((e) => ({ id: e.id, votes: e.votes.total, avgX: e.placement.avg && e.placement.avg.x, avgY: e.placement.avg && e.placement.avg.y, quadrant: e.placement.quadrant }));
    return { rev: s.rev, serverTime: now, id: 'OFFLINE', title: s.title, createdAt: s.createdAt, updatedAt: now, readOnly: false,
      me: { id: 'local', name: s.name, isFacilitator: true }, settings: { ...s.settings }, stage: s.stage, stageIndex: SEED.stages.findIndex((x) => x.id === s.stage), stages: SEED.stages,
      timer: { running: tm.running, durationSec: tm.durationSec, endsAt: tm.endsAt, remainingMs: rem, expired: !!(tm.running && tm.endsAt && tm.endsAt <= now) },
      participants: [{ id: 'local', name: s.name, isFacilitator: true, online: true }],
      notes: s.notes.slice().sort((a, b) => a.order - b.order).map((n) => ({ id: n.id, stage: n.stage, column: n.column, order: n.order, category: n.category, text: n.text, seed: !!n.seed,
        authorId: n.seed || anon ? null : 'local', authorName: n.seed ? 'Discovery pack' : (anon ? null : s.name), mine: !n.seed, votes: { total: cnt['note:' + n.id] || 0, mine: mine['note:' + n.id] || 0 }, createdAt: n.createdAt, updatedAt: n.updatedAt })),
      entries, dots: { perParticipant: s.settings.dotsPerParticipant, used, remaining },
      questions: s.questions.map((q) => ({ ...q, authorId: null, authorName: q.seed ? 'Discovery pack' : (anon ? null : s.name), mine: !q.seed })),
      wrapup: { topVoted: top, recommendation: s.recommendation, nextSteps: s.nextSteps.map((n) => ({ ...n, authorId: null, authorName: anon ? null : s.name, mine: true })) },
      counts: { participants: 1, online: 1, notes: s.notes.length, votes: s.votes.length } };
  },
  emit(type) { this.save(); S.activity.unshift('You ' + (ACTIVITY[type] || type)); S.activity.length = Math.min(S.activity.length, 8); setView(this.view()); },
  async handle(method, sub, body) {
    const s = this.s; body = body || {};
    let m;
    const stageOk = (id) => { if (!this.stage(id)) throw this.err(400, 'bad_stage', 'Unknown stage'); return this.stage(id); };
    const reorder = (stage, column) => { s.notes.filter((n) => n.stage === stage && n.column === column).sort((a, b) => a.order - b.order).forEach((n, i) => { n.order = i + 1; }); };
    if (method === 'GET' && (sub === '/state' || sub === '/readonly')) return this.view();
    if (method === 'POST' && sub === '/notes') {
      const st = stageOk(body.stage);
      if (st.type !== 'board' || !st.columns.some((c) => c.id === body.column)) throw this.err(400, 'bad_column', 'Unknown column');
      const text = clean(body.text, 400, true); if (!text) throw this.err(400, 'empty', 'Write something first');
      const maxO = Math.max(0, ...s.notes.filter((n) => n.stage === body.stage && n.column === body.column).map((n) => n.order));
      s.notes.push({ id: 'n' + Math.random().toString(36).slice(2, 9), stage: body.stage, column: body.column, order: maxO + 1, category: CAT[body.category] ? body.category : 'idea', text, createdAt: Date.now(), updatedAt: Date.now() });
      return this.emit('note.add'), {};
    }
    if ((m = /^\/notes\/([^/]+)$/.exec(sub))) {
      const n = s.notes.find((x) => x.id === m[1]); if (!n) throw this.err(404, 'not_found', 'Note not found');
      if (method === 'DELETE') { s.notes = s.notes.filter((x) => x !== n); s.votes = s.votes.filter((v) => !(v.targetType === 'note' && v.targetId === n.id)); return this.emit('note.delete'), {}; }
      if (method === 'PATCH') {
        if (body.text !== undefined) { const t = clean(body.text, 400, true); if (!t) throw this.err(400, 'empty', 'Text is empty'); n.text = t; }
        if (body.category && CAT[body.category]) n.category = body.category;
        let moved = false;
        if (body.column && body.column !== n.column) { if (!this.stage(n.stage).columns.some((c) => c.id === body.column)) throw this.err(400, 'bad_column', 'Unknown column'); const old = n.column; n.column = body.column; moved = true; reorder(n.stage, old); }
        if (moved || body.index !== undefined) {
          const peers = s.notes.filter((x) => x.stage === n.stage && x.column === n.column && x !== n).sort((a, b) => a.order - b.order);
          const idx = Math.max(0, Math.min(peers.length, Number(body.index === undefined ? peers.length : body.index)));
          peers.splice(idx, 0, n); peers.forEach((x, i) => { x.order = i + 1; });
        }
        n.updatedAt = Date.now();
        return this.emit(moved || body.index !== undefined ? 'note.move' : 'note.edit'), {};
      }
    }
    if (method === 'POST' && sub === '/votes') {
      if (s.settings.votingLocked) throw this.err(423, 'voting_locked', 'Voting is locked');
      let stage;
      if (body.targetType === 'entry') { if (!ENTRY[body.targetId]) throw this.err(404, 'not_found', 'Entry not found'); stage = 'entry-vote'; }
      else { const n = s.notes.find((x) => x.id === body.targetId); if (!n) throw this.err(404, 'not_found', 'Note not found'); if (!this.stage(n.stage).votable) throw this.err(400, 'not_votable', 'Not votable'); stage = n.stage; }
      if (this.used(stage) >= s.settings.dotsPerParticipant) throw this.err(409, 'no_dots_left', 'No dots left');
      s.votes.push({ targetType: body.targetType, targetId: body.targetId, stage });
      return this.emit('vote.add'), {};
    }
    if (method === 'DELETE' && sub === '/votes') {
      if (s.settings.votingLocked) throw this.err(423, 'voting_locked', 'Voting is locked');
      let i = -1; s.votes.forEach((v, k) => { if (v.targetType === body.targetType && v.targetId === body.targetId) i = k; });
      if (i < 0) throw this.err(404, 'not_found', 'No dot to remove');
      s.votes.splice(i, 1); return this.emit('vote.remove'), {};
    }
    if ((m = /^\/placements\/([A-Z])$/.exec(sub))) {
      if (!ENTRY[m[1]]) throw this.err(404, 'not_found', 'Entry not found');
      s.placements = s.placements.filter((p) => p.entryId !== m[1]);
      if (method === 'PUT') { const x = Math.min(100, Math.max(0, Number(body.x))); const y = Math.min(100, Math.max(0, Number(body.y))); if (!Number.isFinite(x) || !Number.isFinite(y)) throw this.err(400, 'bad_xy', 'x and y must be numbers'); s.placements.push({ entryId: m[1], x, y }); }
      return this.emit(method === 'PUT' ? 'placement.set' : 'placement.remove'), {};
    }
    if (method === 'POST' && (sub === '/questions' || sub === '/nextsteps')) {
      const text = clean(body.text, 400); if (!text) throw this.err(400, 'empty', 'Text is empty');
      if (sub === '/questions') s.questions.push({ id: 'q' + Math.random().toString(36).slice(2, 9), kind: body.kind === 'decision' ? 'decision' : 'question', text, owner: clean(body.owner, 60), status: STATUSES.includes(body.status) ? body.status : 'open', decision: clean(body.decision, 400), gate: '', createdAt: Date.now(), updatedAt: Date.now() });
      else s.nextSteps.push({ id: 's' + Math.random().toString(36).slice(2, 9), text, owner: clean(body.owner, 60), type: STEP_TYPES.includes(body.type) ? body.type : 'action', due: clean(body.due, 30), createdAt: Date.now() });
      return this.emit(sub === '/questions' ? 'question.add' : 'nextstep.add'), {};
    }
    if ((m = /^\/(questions|nextsteps)\/([^/]+)$/.exec(sub))) {
      const list = m[1] === 'questions' ? s.questions : s.nextSteps; const it = list.find((x) => x.id === m[2]); if (!it) throw this.err(404, 'not_found', 'Not found');
      if (method === 'DELETE') { list.splice(list.indexOf(it), 1); return this.emit('question.add'), {}; }
      if (method === 'PATCH') {
        if (body.text !== undefined) it.text = clean(body.text, 400) || it.text;
        if (body.owner !== undefined) it.owner = clean(body.owner, 60);
        if (body.decision !== undefined) it.decision = clean(body.decision, 400);
        if (body.due !== undefined) it.due = clean(body.due, 30);
        if (body.status && STATUSES.includes(body.status)) it.status = body.status;
        if (body.kind && ['question', 'decision'].includes(body.kind)) it.kind = body.kind;
        if (body.type && STEP_TYPES.includes(body.type)) it.type = body.type;
        return this.emit('question.add'), {};
      }
    }
    if (method === 'POST' && sub === '/voting') { s.settings.votingLocked = !!body.locked; return this.emit('voting.lock'), {}; }
    if (method === 'POST' && sub === '/reveal') { s.settings.votesRevealed = !!body.revealed; return this.emit('votes.reveal'), {}; }
    if (method === 'POST' && sub === '/settings') {
      if (body.anonymous !== undefined) s.settings.anonymous = !!body.anonymous;
      if (body.dotsPerParticipant !== undefined) s.settings.dotsPerParticipant = Math.round(Math.min(50, Math.max(1, Number(body.dotsPerParticipant) || 5)));
      if (body.title !== undefined) s.title = clean(body.title, 120) || s.title;
      return this.emit('settings'), {};
    }
    if (method === 'POST' && sub === '/stage') {
      const i = SEED.stages.findIndex((x) => x.id === s.stage);
      const t = body.stage === 'next' ? SEED.stages[Math.min(SEED.stages.length - 1, i + 1)].id : body.stage === 'prev' ? SEED.stages[Math.max(0, i - 1)].id : body.stage;
      stageOk(t); s.stage = t; return this.emit('stage.change'), {};
    }
    if (method === 'POST' && sub === '/timer') {
      if (body.action === 'start') { const sec = Math.round(Math.min(7200, Math.max(5, Number(body.seconds) || 300))); s.timer = { running: true, durationSec: sec, endsAt: Date.now() + sec * 1000 }; return this.emit('timer.start'), {}; }
      s.timer = { running: false, durationSec: 0, endsAt: null }; return this.emit('timer.stop'), {};
    }
    if (method === 'POST' && sub === '/clear') {
      const all = body.stage === 'all'; if (!all) stageOk(body.stage);
      const gone = new Set(s.notes.filter((n) => all || n.stage === body.stage).map((n) => n.id));
      s.notes = s.notes.filter((n) => !gone.has(n.id));
      s.votes = s.votes.filter((v) => !(all || v.stage === body.stage || (v.targetType === 'note' && gone.has(v.targetId))));
      if (all || body.stage === 'prioritise') s.placements = [];
      if (all || body.stage === 'questions') s.questions = [];
      if (all || body.stage === 'wrapup') { s.nextSteps = []; s.recommendation = { mvp: [], postMvp: [], rationale: '' }; }
      return this.emit('clear'), {};
    }
    if (method === 'PUT' && sub === '/recommendation') {
      const ok = (a) => (Array.isArray(a) ? a.filter((x) => ENTRY[x]) : []);
      s.recommendation = { mvp: ok(body.mvp), postMvp: ok(body.postMvp), rationale: clean(body.rationale, 800, true) };
      return this.emit('recommendation'), {};
    }
    throw this.err(404, 'not_found', 'Not supported offline');
  },
};

/* ------------------------------------------------------------------ exports (offline, client-side) */
const csvCell = (v) => { let t = String(v == null ? '' : v); if (/^[=+\-@]/.test(t)) t = "'" + t; return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
const csvRow = (a) => a.map(csvCell).join(',');
function localCsv(v, kind) {
  const rows = [];
  if (kind === 'votes') { rows.push(csvRow(['stage', 'target', 'label', 'dots'])); v.entries.forEach((e) => rows.push(csvRow(['entry-vote', e.id, ENTRY[e.id].name, e.votes.total]))); v.notes.forEach((n) => { if (n.votes.total) rows.push(csvRow([n.stage, n.id, n.text, n.votes.total])); }); }
  else if (kind === 'placements') { rows.push(csvRow(['entry', 'name', 'effort_x', 'value_y', 'quadrant'])); v.entries.forEach((e) => { if (e.placement.avg) rows.push(csvRow([e.id, ENTRY[e.id].name, e.placement.avg.x, e.placement.avg.y, e.placement.quadrant])); }); }
  else { rows.push(csvRow(['id', 'stage', 'column', 'category', 'text', 'author', 'dots', 'created'])); v.notes.forEach((n) => rows.push(csvRow([n.id, n.stage, n.column, n.category, n.text, n.authorName || '', n.votes.total || 0, new Date(n.createdAt).toISOString()]))); }
  return '\uFEFF' + rows.join('\r\n') + '\r\n';
}
function localMarkdown(v) {
  const L = ['# ' + v.title, '', '_Offline demo export, ' + new Date().toISOString() + '_', ''];
  v.stages.forEach((st) => {
    L.push('## ' + st.title, '');
    if (st.type === 'board') st.columns.forEach((c) => { const ns = v.notes.filter((n) => n.stage === st.id && n.column === c.id); if (ns.length) { L.push('### ' + c.title); ns.forEach((n) => L.push('- [' + n.category + '] ' + n.text.replace(/\n/g, ' ') + (n.votes.total ? ' (' + n.votes.total + ' dots)' : ''))); L.push(''); } });
    if (st.id === 'entry-vote') { v.entries.slice().sort((a, b) => b.votes.total - a.votes.total).forEach((e) => L.push('- ' + e.id + ' ' + ENTRY[e.id].name + ': ' + e.votes.total + ' dots')); L.push(''); }
    if (st.id === 'prioritise') { v.entries.forEach((e) => { if (e.placement.avg) L.push('- ' + e.id + ' ' + ENTRY[e.id].name + ': effort ' + e.placement.avg.x + ', value ' + e.placement.avg.y + ' (' + QLABEL[e.placement.quadrant] + ')'); }); L.push(''); }
    if (st.id === 'questions') { v.questions.forEach((q) => L.push('- [' + q.kind + ', ' + q.status + '] ' + q.text + (q.owner ? ' (owner: ' + q.owner + ')' : '') + (q.decision ? ' Decision: ' + q.decision : ''))); L.push(''); }
    if (st.id === 'wrapup') { const r = v.wrapup.recommendation; L.push('MVP: ' + (r.mvp.join(', ') || 'none'), 'Post-MVP: ' + (r.postMvp.join(', ') || 'none'), 'Rationale: ' + (r.rationale || ''), '', 'Next steps:'); v.wrapup.nextSteps.forEach((n) => L.push('- [' + n.type + '] ' + n.text + ' (owner: ' + (n.owner || 'TBD') + (n.due ? ', due ' + n.due : '') + ')')); L.push(''); }
  });
  return L.join('\n');
}
async function doExport(kind) {
  const base = 'pickup-' + (S.id || 'session');
  try {
    if (S.mode === 'offline') {
      const v = S.view;
      if (kind === 'md') download(new Blob([localMarkdown(v)], { type: 'text/markdown' }), base + '.md');
      else if (kind === 'json') download(new Blob([JSON.stringify(Local.s, null, 2)], { type: 'application/json' }), base + '.json');
      else download(new Blob([localCsv(v, kind)], { type: 'text/csv' }), base + '-' + kind + '.csv');
    } else {
      const path = kind === 'md' ? '/export.md' : kind === 'json' ? '/export.json' : '/export.csv?kind=' + kind;
      const res = await req('GET', '/api/sessions/' + S.id + path);
      const blob = await res.blob();
      download(blob, base + (kind === 'md' ? '.md' : kind === 'json' ? '.json' : '-' + kind + '.csv'));
    }
    toast('Export downloaded.');
  } catch (e) { toast(FRIENDLY[e.code] || e.message, true); }
}

/* ------------------------------------------------------------------ view / SSE */
function setView(v) {
  S.offset = (v.serverTime || Date.now()) - Date.now();
  const prev = S.view;
  if (prev && v.stage !== prev.stage) { S.viewStage = null; const st = v.stages.find((x) => x.id === v.stage); announce('Stage changed to ' + (st ? st.title : v.stage)); }
  const rem = v.dots && v.dots.remaining ? v.dots.remaining[curStageOf(v)] : undefined;
  if (rem !== undefined && S.lastRemaining !== null && rem !== S.lastRemaining) announce('Dots left: ' + rem + ' of ' + v.dots.perParticipant);
  S.lastRemaining = rem === undefined ? null : rem;
  if (prev && prev.settings.votingLocked !== v.settings.votingLocked) announce(v.settings.votingLocked ? 'Voting is now locked' : 'Voting is open');
  S.view = v;
  render();
}
const curStageOf = (v) => S.viewStage || v.stage;
function openSSE() {
  closeSSE();
  if (S.mode !== 'online' || S.readOnly) return;
  const es = new EventSource('/api/sessions/' + S.id + '/events?token=' + encodeURIComponent(S.token));
  S.sse = es;
  es.addEventListener('hello', () => { S.connected = true; renderTop(); });
  es.addEventListener('state', (e) => { S.connected = true; setView(JSON.parse(e.data)); });
  es.addEventListener('activity', (e) => { const a = JSON.parse(e.data); S.activity.unshift((a.by || 'Someone') + ' ' + (ACTIVITY[a.type] || a.type)); S.activity.length = Math.min(S.activity.length, 8); });
  es.addEventListener('deleted', () => { if (S.deleting) return; toast('This session was deleted by the facilitator.', true); leave(); });
  es.onopen = () => { S.connected = true; renderTop(); };
  es.onerror = () => { S.connected = false; renderTop(); };
}
function closeSSE() { if (S.sse) { S.sse.close(); S.sse = null; } S.connected = false; }

/* ------------------------------------------------------------------ navigation */
function setPath(p) { if (location.protocol.startsWith('http')) { try { history.pushState({}, '', p); } catch (e) { /* ignore */ } } }
function resetSessionState() { closeSSE(); Object.assign(S, { id: null, token: null, readOnly: false, view: null, viewStage: null, activity: [], lastRemaining: null, pin: null }); S.ui.openAdd = null; S.ui.editNote = null; S.ui.editQ = null; S.ui.editStep = null; S.ui.drafts = {}; }
function leave() { const wasOnline = S.mode === 'online'; resetSessionState(); S.mode = null; S.screen = 'landing'; setPath('/'); if (wasOnline) loadSessionsList(); checkServer(); render(); }
async function enter(id, token, readOnly) {
  resetSessionState(); S.mode = 'online'; S.id = id; S.token = token || null; S.readOnly = !!readOnly; S.screen = 'session';
  try {
    const v = await req('GET', '/api/sessions/' + id + (readOnly ? '/readonly' : '/state'));
    setPath('/s/' + id);
    setView(v); openSSE();
    $('#main').focus();
  } catch (e) { toast(e.message, true); S.screen = 'landing'; resetSessionState(); render(); }
}
function enterOffline(name, resume) {
  resetSessionState();
  if (!resume || !Local.load()) Local.init(name, '');
  S.mode = 'offline'; S.id = 'OFFLINE'; S.screen = 'session'; S.connected = true;
  setView(Local.view());
}
async function checkServer() {
  try { const r = await fetch('/api/health', { cache: 'no-store' }); S.serverUp = r.ok; } catch (e) { S.serverUp = false; }
  if (S.screen === 'landing' || S.screen === 'join') { if (S.serverUp) loadSessionsList(); render(); }
}
async function loadSessionsList() {
  try { const r = await req('GET', '/api/sessions'); S.sessionsList = r.sessions || []; } catch (e) { S.sessionsList = null; }
  if (S.screen === 'landing') render();
}
async function route() {
  const m = /^\/s\/([A-Za-z0-9]{4,12})\/?$/.exec(location.pathname);
  if (!m) { S.screen = 'landing'; render(); checkServer(); return; }
  const id = m[1].toUpperCase();
  const saved = ids()[id];
  try {
    const info = await req('GET', '/api/sessions/' + id);
    S.serverUp = true;
    if (saved && saved.token) {
      try { const j = await req('POST', '/api/sessions/' + id + '/join', { name: saved.name, token: saved.token }); rememberId(id, { token: j.token, name: j.participant.name, facilitator: j.participant.isFacilitator }); await enter(id, j.token, false); return; } catch (e) { forgetId(id); }
    }
    S.joinInfo = { id, title: info.title }; S.screen = 'join'; render();
  } catch (e) {
    S.serverUp = e.code === 'network' ? false : true;
    S.joinInfo = { id, title: null, missing: e.code !== 'network' }; S.screen = 'join'; render();
  }
}

/* ------------------------------------------------------------------ rendering core */
let raf = 0;
function render() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; doRender(); }); }
function doRender() {
  const ae = document.activeElement;
  if (S.pointerDrag || S.dragId || S.selOpen) { S.dirty = true; return; }
  S.dirty = false;
  let fid = null; let selS = 0; let selE = 0;
  if (ae && ae.dataset && ae.dataset.fid) { fid = ae.dataset.fid; try { selS = ae.selectionStart; selE = ae.selectionEnd; } catch (e) { /* not text */ } }
  const scrollY = window.scrollY;
  const boardScroll = $('.board') ? $('.board').scrollLeft : 0;
  renderTop(); renderBanners(); renderStagebar();
  const app = $('#app');
  if (S.screen === 'landing') mount(app, landingView());
  else if (S.screen === 'created') mount(app, createdView());
  else if (S.screen === 'join') mount(app, joinView());
  else if (S.screen === 'session' && S.view) mount(app, sessionView());
  else mount(app, h('p', { text: 'Loading\u2026' }));
  if ($('.board')) $('.board').scrollLeft = boardScroll;
  window.scrollTo(0, scrollY);
  if (fid) { const el = document.querySelector('[data-fid="' + fid.replace(/"/g, '\\"') + '"]'); if (el) { el.focus({ preventScroll: true }); try { if (selS != null) el.setSelectionRange(selS, selE); } catch (e) { /* ignore */ } } }
}
document.addEventListener('mousedown', (e) => { S.selOpen = !!(e.target && e.target.tagName === 'SELECT'); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') S.selOpen = false; }, true);
document.addEventListener('focusout', () => { S.selOpen = false; if (S.dirty) setTimeout(() => { if (S.dirty) render(); }, 0); });
document.addEventListener('change', () => { S.selOpen = false; if (S.dirty) setTimeout(() => { if (S.dirty) doRender(); }, 0); });

function bindDraft(el, fid, initial) {
  el.dataset.fid = fid;
  const d = S.ui.drafts[fid];
  el.value = d !== undefined ? d : (initial || '');
  el.addEventListener('input', () => { S.ui.drafts[fid] = el.value; });
  return el;
}
function labeled(label, control, help) {
  const id = uid('f'); control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), control, help ? h('div', { class: 'help', text: help }) : null);
}
const optionEls = (opts, sel) => opts.map((o) => h('option', { value: o.value, text: o.label, selected: o.value === sel }));

/* ------------------------------------------------------------------ top bar / banners / stage bar */
let timerEl = null;
function renderTop() {
  const host = $('#topbar');
  const v = S.view; const inSession = S.screen === 'session' && v;
  const kids = [h('span', { class: 'brand-logo', role: 'img', 'aria-label': 'TUI' }),
    h('div', { class: 'title' }, h('span', { class: 'kicker', text: 'Customer Account \u00B7 Product + Design workshop' }), h('span', { text: inSession ? v.title : 'Pick it up where you left off' }))];
  if (inSession) {
    kids.push(h('span', { class: 'pill', text: S.mode === 'offline' ? 'Offline demo' : 'Room ' + v.id }));
    kids.push(h('span', { class: 'pill', text: v.readOnly ? 'Read-only' : (v.me && v.me.isFacilitator ? 'Facilitator: ' + v.me.name : 'Participant: ' + (v.me ? v.me.name : '')) }));
    if (S.mode === 'online' && !S.readOnly) kids.push(h('span', { class: 'pill ' + (S.connected ? 'ok' : 'warn'), role: 'status', text: S.connected ? 'Live' : 'Reconnecting\u2026' }));
    kids.push(h('span', { class: 'pill', text: v.counts.online + ' online / ' + v.counts.participants + ' joined' }));
    timerEl = h('span', { class: 'timer', 'aria-label': 'Timer', hidden: true });
    kids.push(timerEl);
  } else timerEl = null;
  kids.push(h('a', { class: 'btn ghost sm', href: DISCOVERY_URL, target: '_blank', rel: 'noopener', text: 'Discovery prototype (new tab)' }));
  if (S.screen !== 'landing') kids.push(h('button', { class: 'btn ghost sm', type: 'button', text: inSession ? 'Leave session' : 'Back', on: { click: leave } }));
  mount(host, ...kids);
  tickTimer();
}
function tickTimer() {
  const v = S.view;
  if (!timerEl || !v) return;
  const t = v.timer;
  if (!t.running) { timerEl.hidden = true; return; }
  const left = t.endsAt - (Date.now() + S.offset);
  timerEl.hidden = false;
  if (left <= 0) {
    timerEl.textContent = 'Time is up'; timerEl.className = 'timer done';
    if (S.announcedExpiry !== t.endsAt) { S.announcedExpiry = t.endsAt; announce('Time is up'); }
  } else { timerEl.textContent = fmtTime(left); timerEl.className = 'timer' + (left < 30000 ? ' low' : ''); }
}
setInterval(tickTimer, 500);
function renderBanners() {
  const host = $('#banners'); const kids = [];
  if (S.mode === 'offline' && S.screen === 'session') kids.push(h('div', { class: 'banner-offline', role: 'note' }, h('div', { class: 'wrap', text: 'Offline demo mode (single user, localStorage, not shared). Nothing here is sent to a server or visible to other people.' })));
  if (S.screen === 'session' && S.readOnly) kids.push(h('div', { class: 'banner-ro' }, h('div', { class: 'wrap row' }, h('span', { text: 'You are viewing an archived session read-only. ' }), h('button', { class: 'btn sec sm', type: 'button', text: 'Refresh', on: { click: refreshState } }))));
  mount(host, ...kids);
}
function renderStagebar() {
  const host = $('#stagebar-host');
  const v = S.view;
  if (S.screen !== 'session' || !v) { mount(host); return; }
  const cur = curStageOf(v);
  const items = v.stages.map((st, i) => h('li', null, h('button', { type: 'button', 'aria-current': st.id === v.stage ? 'step' : null, class: st.id === cur && cur !== v.stage ? 'viewing' : '',
    title: st.id === v.stage ? 'Current session stage' : 'View this stage', on: { click: () => { S.viewStage = st.id === v.stage ? null : st.id; render(); } } },
    (i + 1) + '. ' + st.title + (st.id === v.stage ? ' (now)' : ''))));
  mount(host, h('nav', { class: 'stagebar', 'aria-label': 'Workshop stages' }, h('div', { class: 'wrap' }, h('ol', null, items))));
}

/* ------------------------------------------------------------------ landing */
function landingView() {
  const wrap = h('div');
  wrap.appendChild(h('div', { class: 'hero' }, h('h1', { text: 'Pick it up where you left off' }),
    h('p', { text: 'A live workshop board for Product and Design. Map entry points, dot-vote, place them on a 2x2, test assumptions and agree next steps. No accounts: pick a name and join.' })));
  if (S.serverUp === false) {
    wrap.appendChild(h('div', { class: 'notice warn', role: 'alert' }, h('strong', { text: 'The workshop server is not reachable. ' }),
      'Shared sessions need the server (node server.js). You can still try the board in offline demo mode below. ',
      h('button', { class: 'btn sec sm', type: 'button', text: 'Retry connection', on: { click: checkServer } })));
  }
  const grid = h('div', { class: 'grid2' });
  /* create */
  const f = h('form', { class: 'card', 'aria-labelledby': 'h-create', on: { submit: onCreate } }, h('h2', { id: 'h-create', text: 'Facilitator: create a session' }));
  f.appendChild(labeled('Session title', bindDraft(h('input', { type: 'text', maxlength: 120, autocomplete: 'off' }), 'c:title', '')));
  f.appendChild(labeled('Your name', bindDraft(h('input', { type: 'text', maxlength: 40, autocomplete: 'name' }), 'c:name', '')));
  f.appendChild(labeled('Dots per participant (per voting stage)', bindDraft(h('input', { type: 'number', min: 1, max: 50 }), 'c:dots', '5')));
  const an = h('input', { type: 'checkbox', id: 'c-anon' }); an.dataset.fid = 'c:anon'; an.checked = S.ui.drafts['c:anon'] === true; an.addEventListener('change', () => { S.ui.drafts['c:anon'] = an.checked; });
  f.appendChild(h('div', { class: 'field' }, an, h('label', { for: 'c-anon', style: 'display:inline', text: 'Anonymous mode (hide who wrote what)' })));
  const pf = h('input', { type: 'checkbox', id: 'c-pre' }); pf.dataset.fid = 'c:pre'; pf.checked = S.ui.drafts['c:pre'] !== false; pf.addEventListener('change', () => { S.ui.drafts['c:pre'] = pf.checked; });
  f.appendChild(h('div', { class: 'field' }, pf, h('label', { for: 'c-pre', style: 'display:inline', text: 'Pre-fill assumptions, risks and open questions from the discovery pack' })));
  f.appendChild(h('button', { class: 'btn', type: 'submit', text: 'Create session', disabled: S.serverUp === false }));
  grid.appendChild(f);
  /* join */
  const j = h('form', { class: 'card', 'aria-labelledby': 'h-join', on: { submit: onJoinLanding } }, h('h2', { id: 'h-join', text: 'Join a session' }));
  j.appendChild(labeled('Room code or join link', bindDraft(h('input', { type: 'text', maxlength: 200, autocomplete: 'off', autocapitalize: 'characters' }), 'j:room', ''), 'For example K7M2QX, or the full link your facilitator shared.'));
  j.appendChild(labeled('Your display name', bindDraft(h('input', { type: 'text', maxlength: 40, autocomplete: 'name' }), 'j:name', '')));
  j.appendChild(labeled('Facilitator PIN (optional)', bindDraft(h('input', { type: 'password', maxlength: 12, autocomplete: 'off', inputmode: 'numeric' }), 'j:pin', ''), 'Only needed to join as a co-facilitator.'));
  j.appendChild(h('button', { class: 'btn', type: 'submit', text: 'Join', disabled: S.serverUp === false }));
  grid.appendChild(j);
  wrap.appendChild(grid);
  /* past sessions */
  const past = h('section', { class: 'card', style: 'margin-top:1.25rem', 'aria-labelledby': 'h-past' }, h('h2', { id: 'h-past', text: 'Past and running sessions' }));
  if (S.serverUp === false) past.appendChild(h('p', { text: 'Not available while the server is unreachable.' }));
  else if (S.sessionsList === null) past.appendChild(h('p', { text: 'Loading\u2026' }));
  else if (!S.sessionsList.length) past.appendChild(h('p', { text: 'No sessions yet.' }));
  else {
    const saved = ids();
    past.appendChild(h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('caption', { class: 'sr-only', text: 'Sessions on this server' }),
      h('thead', null, h('tr', null, ['Title', 'Room', 'Stage', 'People', 'Notes', 'Last activity', 'Actions'].map((x) => h('th', { scope: 'col', text: x })))),
      h('tbody', null, S.sessionsList.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((s) => h('tr', null,
        h('td', { text: s.title }), h('td', { text: s.id }), h('td', { text: (SEED.stages.find((x) => x.id === s.stage) || { title: s.stage }).title }), h('td', { text: String(s.participants) }), h('td', { text: String(s.notes) }), h('td', { text: fmtDate(s.updatedAt) }),
        h('td', null, h('div', { class: 'row' },
          saved[s.id] ? h('button', { class: 'btn sm', type: 'button', text: 'Rejoin as ' + saved[s.id].name, on: { click: () => rejoin(s.id) } }) : null,
          h('button', { class: 'btn sec sm', type: 'button', 'aria-label': 'Open ' + s.title + ' read-only', text: 'Open read-only', on: { click: () => enter(s.id, null, true) } })))))))));
  }
  wrap.appendChild(past);
  /* offline */
  const off = h('section', { class: 'card', style: 'margin-top:1.25rem', 'aria-labelledby': 'h-off' }, h('h2', { id: 'h-off', text: 'Offline demo mode' }),
    h('p', { text: 'Offline demo mode (single user, localStorage, not shared). Use it to try the boards without a server. Data stays in this browser only.' }));
  const has = !!store.get(Local.KEY, null);
  off.appendChild(labeled('Your name', bindDraft(h('input', { type: 'text', maxlength: 40 }), 'o:name', '')));
  off.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn sec', type: 'button', text: 'Start offline demo', on: { click: () => { if (has && !confirm('Start a new offline demo? This replaces the existing offline data in this browser.')) return; enterOffline(S.ui.drafts['o:name'] || 'You', false); } } }),
    has ? h('button', { class: 'btn sec', type: 'button', text: 'Resume offline demo', on: { click: () => enterOffline('', true) } }) : null));
  wrap.appendChild(off);
  wrap.appendChild(h('p', { class: 'help', style: 'margin-top:1rem' }, 'Background: ', h('a', { href: DISCOVERY_URL, target: '_blank', rel: 'noopener', text: 'discovery prototype (opens in a new tab)' }), '.'));
  return wrap;
}
async function onCreate(e) {
  e.preventDefault();
  const d = S.ui.drafts;
  try {
    const r = await req('POST', '/api/sessions', { title: d['c:title'] || '', facilitatorName: d['c:name'] || 'Facilitator', dotsPerParticipant: Number(d['c:dots']) || 5, anonymous: d['c:anon'] === true, prefill: d['c:pre'] !== false });
    rememberId(r.id, { token: r.token, name: r.participant.name, facilitator: true });
    S.pin = { id: r.id, pin: r.facilitatorPin, token: r.token, title: r.title };
    S.screen = 'created'; render();
  } catch (er) { toast(FRIENDLY[er.code] || er.message, true); }
}
function createdView() {
  const p = S.pin; const link = location.protocol.startsWith('http') ? location.origin + '/s/' + p.id : '/s/' + p.id;
  return h('div', { class: 'card' }, h('h2', { text: 'Session created: ' + p.title }),
    h('p', null, 'Room code: ', h('strong', { text: p.id })),
    h('div', { class: 'field' }, h('label', { for: 'jl', text: 'Join link for participants' }), h('input', { type: 'text', id: 'jl', readonly: true, value: link, on: { focus: (e) => e.target.select() } })),
    h('div', { class: 'row' }, h('button', { class: 'btn sec', type: 'button', text: 'Copy join link', on: { click: () => copyText(link) } })),
    h('div', { class: 'pin-box', role: 'alert' }, h('h3', { text: 'Facilitator PIN (shown only once)' }), h('div', { class: 'pin', text: p.pin }),
      h('p', { text: 'Store it somewhere safe. A co-facilitator needs it to join with full controls. You are already signed in as facilitator in this browser.' })),
    h('p', null, h('button', { class: 'btn', type: 'button', text: 'Open the board', on: { click: () => { const t = S.pin; S.pin = null; enter(t.id, t.token, false); } } })));
}
function copyText(t) { if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('Copied.'), () => toast('Copy failed. Select the text and copy it manually.', true)); else toast('Select the text and copy it manually.', true); }
async function onJoinLanding(e) {
  e.preventDefault();
  const d = S.ui.drafts; const id = parseRoom(d['j:room']);
  if (!id) { toast('Enter a room code or join link.', true); return; }
  await doJoin(id, d['j:name'], d['j:pin']);
}
async function doJoin(id, name, pin) {
  if (!clean(name || '', 40)) { toast('Please enter a display name.', true); return; }
  try {
    const saved = ids()[id];
    const j = await req('POST', '/api/sessions/' + id + '/join', { name, pin: pin || undefined, token: saved && saved.token && !pin ? saved.token : undefined });
    rememberId(id, { token: j.token, name: j.participant.name, facilitator: j.participant.isFacilitator });
    await enter(id, j.token, false);
  } catch (er) { toast(er.status === 404 ? 'Room not found.' : er.status === 403 || er.status === 401 ? 'That PIN is not correct.' : (er.message || 'Could not join.'), true); }
}
async function rejoin(id) { const s = ids()[id]; if (s) await doJoin(id, s.name, ''); }
function joinView() {
  const info = S.joinInfo || {};
  if (info.missing) return h('div', { class: 'card' }, h('h2', { text: 'Room not found' }), h('p', { text: 'Check the code, or ask the facilitator for a new link.' }), h('button', { class: 'btn', type: 'button', text: 'Back to start', on: { click: leave } }));
  if (S.serverUp === false) return h('div', { class: 'card' }, h('h2', { text: 'Server not reachable' }), h('p', { text: 'Cannot load room ' + (info.id || '') + '.' }),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', text: 'Retry', on: { click: route } }), h('button', { class: 'btn sec', type: 'button', text: 'Offline demo mode (single user, not shared)', on: { click: leave } })));
  const f = h('form', { class: 'card', 'aria-labelledby': 'h-j2', on: { submit: (e) => { e.preventDefault(); doJoin(info.id, S.ui.drafts['jj:name'], S.ui.drafts['jj:pin']); } } },
    h('h2', { id: 'h-j2', text: 'Join: ' + (info.title || info.id) }), h('p', { text: 'Room ' + info.id }));
  f.appendChild(labeled('Your display name', bindDraft(h('input', { type: 'text', maxlength: 40, autocomplete: 'name' }), 'jj:name', '')));
  f.appendChild(labeled('Facilitator PIN (optional)', bindDraft(h('input', { type: 'password', maxlength: 12, autocomplete: 'off' }), 'jj:pin', '')));
  f.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit', text: 'Join' }), h('button', { class: 'btn sec', type: 'button', text: 'Open read-only', on: { click: () => enter(info.id, null, true) } })));
  return f;
}

/* ------------------------------------------------------------------ session view */
function sessionView() {
  const v = S.view; const cur = curStageOf(v); const st = v.stages.find((x) => x.id === cur);
  const fac = !!(v.me && v.me.isFacilitator); const ro = v.readOnly;
  const main = h('div');
  if (fac && !ro) main.appendChild(facPanel(v));
  const head = h('div', { class: 'stage-head' }, h('div', null, h('h2', { id: 'stage-h', text: st.title }), h('p', { class: 'goal', text: st.goal + ' (about ' + st.minutes + ' min)' })));
  const rem = v.dots.remaining[cur];
  if (rem !== undefined && !ro) head.appendChild(h('div', { class: 'dots-counter' + (rem === 0 ? ' zero' : ''), 'aria-hidden': 'true', text: 'Dots left: ' + rem + ' of ' + v.dots.perParticipant }),
    h('span', { class: 'sr-only', text: 'Dots left: ' + rem + ' of ' + v.dots.perParticipant }));
  main.appendChild(head);
  if (cur !== v.stage) {
    const cs = v.stages.find((x) => x.id === v.stage);
    main.appendChild(h('div', { class: 'notice', role: 'status' }, 'You are looking at a different stage than the session. The session is on "' + cs.title + '". ',
      h('button', { class: 'btn sec sm', type: 'button', text: 'Go to current stage', on: { click: () => { S.viewStage = null; render(); } } }), ' ',
      fac && !ro ? h('button', { class: 'btn sm', type: 'button', text: 'Move the session here', on: { click: () => act('POST', '/stage', { stage: cur }) } }) : null));
  }
  if (v.settings.votingLocked && st.votable) main.appendChild(h('div', { class: 'notice warn', role: 'status', text: 'Voting is locked by the facilitator.' }));
  if (v.settings.anonymous) main.appendChild(h('div', { class: 'help', text: 'Anonymous mode is on: authors are hidden.' }));
  main.appendChild(contextDrawer(cur));
  if (st.type === 'board') main.appendChild(boardView(v, st));
  else if (st.type === 'vote') main.appendChild(voteView(v, st));
  else if (st.type === 'matrix') main.appendChild(matrixView(v));
  else if (st.type === 'qa') main.appendChild(qaView(v));
  else if (st.type === 'wrapup') main.appendChild(wrapView(v));
  if (st.votable && !fac && !v.settings.votesRevealed && !ro) main.appendChild(h('p', { class: 'help', text: 'Dot totals stay hidden until the facilitator reveals them. You always see your own dots.' }));
  const aside = h('aside', { class: 'card people', 'aria-label': 'People and activity' }, h('h3', { text: 'People' }),
    h('ul', null, v.participants.map((p) => h('li', { class: p.online ? 'on' : 'off' }, (p.online ? 'Online: ' : 'Offline: ') + p.name + (p.isFacilitator ? ' (facilitator)' : '')))),
    h('h3', { style: 'margin-top:1rem', text: 'Recent activity' }), S.activity.length ? h('ul', { class: 'log', role: 'log', 'aria-live': 'off' }, S.activity.map((a) => h('li', { text: a }))) : h('p', { class: 'help', text: 'Nothing yet.' }));
  return h('div', { class: 'side' }, main, aside);
}

/* facilitator panel */
function facPanel(v) {
  const idx = v.stageIndex;
  const det = h('details', { class: 'fac', open: S.ui.facOpen !== false ? true : null, on: { toggle: (e) => { S.ui.facOpen = e.target.open; } } }, h('summary', { text: 'Facilitator controls' }));
  const g = h('div', { class: 'grp' });
  const fs = (legend, ...kids) => h('fieldset', null, h('legend', { text: legend }), h('div', { class: 'row' }, kids));
  const btn = (text, fn, cls, dis) => h('button', { class: 'btn sm ' + (cls || 'sec'), type: 'button', text, disabled: dis, on: { click: fn } });
  g.appendChild(fs('Stage', btn('Previous', () => act('POST', '/stage', { stage: 'prev' }), 'sec', idx <= 0), btn('Next stage', () => act('POST', '/stage', { stage: 'next' }), '', idx >= v.stages.length - 1)));
  g.appendChild(fs('Voting', btn(v.settings.votingLocked ? 'Unlock voting' : 'Lock voting', () => act('POST', '/voting', { locked: !v.settings.votingLocked }), v.settings.votingLocked ? 'on' : 'sec'),
    btn(v.settings.votesRevealed ? 'Hide results' : 'Reveal results', () => act('POST', '/reveal', { revealed: !v.settings.votesRevealed }), v.settings.votesRevealed ? 'on' : 'sec')));
  const mins = bindDraft(h('input', { type: 'number', min: 1, max: 120, 'aria-label': 'Timer minutes' }), 'fac:mins', '5');
  g.appendChild(fs('Timer', mins, h('span', { text: 'min' }), btn('Start', () => act('POST', '/timer', { action: 'start', seconds: Math.round((Number(mins.value) || 5) * 60) }), ''), btn('Stop', () => act('POST', '/timer', { action: 'stop' }))));
  const an = h('input', { type: 'checkbox', id: 'fac-anon', checked: v.settings.anonymous, on: { change: (e) => act('POST', '/settings', { anonymous: e.target.checked }) } });
  const dots = bindDraft(h('input', { type: 'number', min: 1, max: 50, 'aria-label': 'Dots per participant' }), 'fac:dots', String(v.settings.dotsPerParticipant));
  g.appendChild(fs('Settings', h('span', null, an, h('label', { for: 'fac-anon', style: 'display:inline', text: 'Anonymous mode' })), dots, btn('Set dots', () => act('POST', '/settings', { dotsPerParticipant: Number(dots.value) || 5 }))));
  const title = bindDraft(h('input', { type: 'text', maxlength: 120, 'aria-label': 'Session title', style: 'min-width:14rem' }), 'fac:title', v.title);
  g.appendChild(fs('Title', title, btn('Save', () => act('POST', '/settings', { title: title.value }))));
  g.appendChild(fs('Export', btn('Markdown', () => doExport('md')), btn('CSV notes', () => doExport('notes')), btn('CSV votes', () => doExport('votes')), btn('CSV 2x2', () => doExport('placements')), btn('JSON', () => doExport('json'))));
  g.appendChild(fs('Clear and delete', btn('Clear this stage', () => { const c = curStageOf(v); if (confirm('Clear all notes, dots and placements in this stage? This cannot be undone.')) act('POST', '/clear', { stage: c }); }, 'danger'),
    btn('Clear all stages', () => { if (confirm('Clear ALL boards, dots, placements, questions and next steps? This cannot be undone.')) act('POST', '/clear', { stage: 'all' }); }, 'danger'),
    S.mode === 'online' ? btn('Delete session data', async () => { if (confirm('Permanently delete this session and its saved exports from the server? Export first if you need the results.')) { S.deleting = true; const r = await act('DELETE', ''); S.deleting = false; if (r) { forgetId(S.id); toast('Session deleted.'); leave(); } } }, 'danger')
      : btn('Delete offline data', () => { if (confirm('Delete the offline demo data from this browser?')) { try { localStorage.removeItem(Local.KEY); } catch (e) { /* ignore */ } toast('Offline data deleted.'); leave(); } }, 'danger')));
  if (S.mode === 'online') { const link = location.origin + '/s/' + v.id; g.appendChild(fs('Share', h('span', { text: 'Room ' + v.id }), btn('Copy join link', () => copyText(link)))); }
  det.appendChild(g);
  return det;
}

/* context drawer */
function ul(items) { return h('ul', null, items.map((i) => h('li', { text: i }))); }
function tbl(head, rows) { return h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, head.map((x) => h('th', { scope: 'col', text: x })))), h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', { text: c }))))))); }
const sec = (title, body) => h('div', null, h('h4', { text: title }), body);
function contextDrawer(stageId) {
  const P = SEED.problem; const kids = [];
  const entryRows = SEED.entryPoints.map((e) => [e.id + '. ' + e.name, e.scope === 'mvp' ? 'MVP' : e.scope === 'post' ? 'Post-MVP' : 'Proposed', e.what]);
  if (stageId === 'warmup') kids.push(sec('Why we are here', h('p', { text: P.summary })), sec('Problems', ul(P.problems)), sec('Objectives', ul(P.objectives)), sec('What we know (evidence)', tbl(['Insight', 'Source', 'Confidence'], SEED.evidence.map((x) => [x.insight, x.source, x.confidence]))));
  else if (stageId === 'entry-map') kids.push(sec('Entry points A to I', tbl(['Entry point', 'Scope', 'What it does'], entryRows)), sec('Customer states to keep in mind', tbl(['State', 'Header', 'In-flow', 'Dashboard', 'mySearches'], SEED.states.map((s) => [s.state, s.header, s.inFlow, s.dashboard, s.mySearches]))));
  else if (stageId === 'entry-vote') kids.push(sec('Entry points at a glance', tbl(['Entry point', 'Scope', 'Priority', 'Effort', 'Confidence'], SEED.entryPoints.map((e) => [e.id + '. ' + e.name, e.scope === 'mvp' ? 'MVP' : e.scope === 'post' ? 'Post-MVP' : 'Proposed', e.prio, e.effort, e.confidence]))), sec('What to measure', ul(SEED.kpis.perEntryPoint || [])));
  else if (stageId === 'prioritise') kids.push(sec('Discovery pack view (starting point, not the answer)', tbl(['Entry point', 'Pack priority', 'Pack effort', 'Confidence', 'Note'], SEED.entryPoints.map((e) => [e.id + '. ' + e.name, e.prio, e.effort, e.confidence, e.note]))),
    sec('Axes', h('p', { text: 'Horizontal: effort from low (left) to high (right). Vertical: customer and business value from low (bottom) to high (top).' })));
  else if (stageId === 'assumptions') kids.push(sec('Assumptions from the discovery pack', tbl(['ID', 'Type', 'Assumption', 'How to test'], SEED.assumptions.map((a) => [a.id, a.type, a.text, a.test]))), sec('Risks', tbl(['Risk', 'Source', 'Detail'], SEED.risks.map((r) => [r.title, r.source, r.text]))));
  else if (stageId === 'questions') kids.push(sec('Open questions from the pack', tbl(['Question', 'Suggested owner', 'Decision gate'], SEED.openQuestions.map((q) => [q.id + ': ' + q.text, q.owner, q.gate]))));
  else if (stageId === 'wrapup') kids.push(sec('Suggested experiments', tbl(['Experiment', 'Metric', 'Entry point'], SEED.experiments.map((x) => [x.name, x.metric, x.entry]))), sec('Pack roadmap: now', ul(SEED.nextSteps.now || [])), sec('Next', ul(SEED.nextSteps.next || [])), sec('Later', ul(SEED.nextSteps.later || [])), sec('Research', ul(SEED.nextSteps.research || [])),
    sec('KPIs and guardrails', h('div', null, h('p', { text: 'Deck KPIs: ' + (SEED.kpis.deck || []).join(', ') }), h('p', { text: 'Guardrails: ' + (SEED.kpis.guardrails || []).join(', ') }))));
  const open = S.ui.drawer[stageId] !== undefined ? S.ui.drawer[stageId] : stageId === 'warmup';
  const d = h('details', { class: 'drawer', open: open ? true : null, on: { toggle: (e) => { S.ui.drawer[stageId] = e.target.open; } } },
    h('summary', { text: 'Context from the discovery prototype' }), h('div', { class: 'inner' }, kids, h('p', { class: 'help' }, 'Full detail: ', h('a', { href: DISCOVERY_URL, target: '_blank', rel: 'noopener', text: 'discovery prototype (new tab)' }))));
  return d;
}

/* ---- board ---- */
function colNotes(v, st, colId) { return v.notes.filter((n) => n.stage === st.id && n.column === colId).sort((a, b) => a.order - b.order); }
function boardView(v, st) {
  const board = h('div', { class: 'board', role: 'group', 'aria-labelledby': 'stage-h' });
  st.columns.forEach((c) => board.appendChild(columnView(v, st, c)));
  return board;
}
function columnView(v, st, c) {
  const ro = v.readOnly; const fac = !!(v.me && v.me.isFacilitator);
  const notes = colNotes(v, st, c.id);
  const hid = 'ch-' + st.id + '-' + c.id;
  const list = h('div', { class: 'notes', role: 'list', 'aria-label': 'Notes in ' + c.title });
  notes.forEach((n, i) => list.appendChild(noteCard(v, st, c, n, i, notes.length)));
  if (!notes.length) list.appendChild(h('p', { class: 'help', text: 'No notes yet.' }));
  const col = h('section', { class: 'col', 'aria-labelledby': hid, 'data-col': c.id }, h('h3', { id: hid, text: (st.id === 'entry-map' ? c.id + '. ' : '') + c.title }), c.hint ? h('div', { class: 'hint', text: c.hint }) : null, list);
  if (!ro) {
    const key = st.id + ':' + c.id;
    if (S.ui.openAdd === key) col.appendChild(addForm(st, c, key));
    else col.appendChild(h('button', { class: 'btn sec sm', type: 'button', text: '+ Add note', 'aria-label': 'Add a note to ' + c.title, 'data-fid': 'addbtn:' + key, on: { click: () => { S.ui.openAdd = key; render(); setTimeout(() => { const t = document.querySelector('[data-fid="add:' + key + '"]'); if (t) t.focus(); }, 60); } } }));
    list.addEventListener('dragover', (e) => { if (!S.dragId) return; e.preventDefault(); col.classList.add('over'); });
    list.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
    list.addEventListener('drop', (e) => {
      e.preventDefault(); col.classList.remove('over');
      const id = S.dragId; S.dragId = null; if (!id) return;
      let index = 0;
      Array.from(list.querySelectorAll('.note')).forEach((el) => { if (el.dataset.id === id) return; const r = el.getBoundingClientRect(); if (e.clientY > r.top + r.height / 2) index++; });
      act('PATCH', '/notes/' + id, { column: c.id, index }).then(() => { S.dirty = false; render(); });
    });
  }
  void fac;
  return col;
}
function catPicker(key, selected) {
  const name = uid('cat');
  const fs = h('fieldset', { class: 'cats' }, h('legend', { text: 'Category (colour and label)' }));
  SEED.categories.forEach((c) => {
    const inp = h('input', { type: 'radio', name, value: c.id, checked: c.id === selected }); inp.dataset.fid = 'catr:' + key + ':' + c.id;
    inp.addEventListener('change', () => { S.ui.drafts['cat:' + key] = c.id; });
    fs.appendChild(h('label', { class: 'cat-' + c.id }, inp, h('span', { text: c.label })));
  });
  return fs;
}
function addForm(st, c, key) {
  const cat = S.ui.drafts['cat:' + key] || 'idea';
  const ta = bindDraft(h('textarea', { maxlength: 400, rows: 3 }), 'add:' + key, '');
  const submit = async () => {
    const text = clean(ta.value, 400, true); if (!text) { toast('Write something first.', true); return; }
    const r = await act('POST', '/notes', { stage: st.id, column: c.id, category: S.ui.drafts['cat:' + key] || 'idea', text });
    if (r) { S.ui.drafts['add:' + key] = ''; ta.value = ''; render(); }
  };
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); } });
  return h('div', { class: 'addform' }, labeled('New note in ' + c.title, ta, 'Ctrl+Enter to add. Up to 400 characters.'), catPicker(key, cat),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', text: 'Add note', on: { click: submit } }), h('button', { class: 'btn sec sm', type: 'button', text: 'Close', on: { click: () => { S.ui.openAdd = null; render(); } } })));
}
function noteCard(v, st, col, n, pos, total) {
  const ro = v.readOnly; const fac = !!(v.me && v.me.isFacilitator);
  const can = !ro && (n.mine || fac);
  const cat = CAT[n.category] || CAT.idea;
  const el = h('div', { class: 'note cat-' + cat.id + (n.mine ? ' mine' : ''), role: 'listitem', 'data-id': n.id, draggable: can && S.ui.editNote !== n.id ? true : null });
  if (can) {
    el.addEventListener('dragstart', (e) => { S.dragId = n.id; el.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', n.id); e.dataTransfer.effectAllowed = 'move'; } catch (er) { /* ignore */ } });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); S.dragId = null; if (S.dirty) render(); });
  }
  if (S.ui.editNote === n.id) {
    const ta = bindDraft(h('textarea', { maxlength: 400, rows: 3 }), 'edit:' + n.id, n.text);
    const kk = 'e' + n.id;
    const save = async () => { const r = await act('PATCH', '/notes/' + n.id, { text: ta.value, category: S.ui.drafts['cat:' + kk] || n.category }); if (r) { S.ui.editNote = null; delete S.ui.drafts['edit:' + n.id]; render(); } };
    el.appendChild(labeled('Edit note', ta));
    el.appendChild(catPicker(kk, S.ui.drafts['cat:' + kk] || n.category));
    el.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', text: 'Save', on: { click: save } }), h('button', { class: 'btn sec sm', type: 'button', text: 'Cancel', on: { click: () => { S.ui.editNote = null; delete S.ui.drafts['edit:' + n.id]; render(); } } })));
    return el;
  }
  el.appendChild(h('div', { class: 'cat', text: cat.label }));
  el.appendChild(h('div', { class: 'txt', text: n.text }));
  el.appendChild(h('div', { class: 'by', text: n.seed ? 'From the discovery pack' : (n.authorName ? 'By ' + n.authorName : (n.mine ? 'By you' : '')) }));
  const acts = h('div', { class: 'acts' });
  const label = short(n.text, 40);
  if (st.votable) {
    const tot = n.votes.total;
    acts.appendChild(h('span', { class: 'dotcount' + (tot == null ? ' hid' : ''), text: (tot == null ? 'Total hidden' : tot + (tot === 1 ? ' dot' : ' dots')) + (n.votes.mine ? ' (yours: ' + n.votes.mine + ')' : '') }));
    if (!ro) {
      acts.appendChild(h('button', { class: 'btn sm', type: 'button', text: '+ Dot', 'aria-label': 'Add a dot to note: ' + label, 'data-fid': 'dotp:' + n.id, on: { click: () => act('POST', '/votes', { targetType: 'note', targetId: n.id }) } }));
      acts.appendChild(h('button', { class: 'btn sm', type: 'button', text: '\u2212 Dot', 'aria-label': 'Remove one of your dots from note: ' + label, disabled: !n.votes.mine, 'data-fid': 'dotm:' + n.id, on: { click: () => act('DELETE', '/votes', { targetType: 'note', targetId: n.id }) } }));
    }
  }
  if (can) {
    acts.appendChild(h('button', { class: 'btn sm', type: 'button', text: 'Edit', 'aria-label': 'Edit note: ' + label, on: { click: () => { S.ui.editNote = n.id; render(); setTimeout(() => { const t = document.querySelector('[data-fid="edit:' + n.id + '"]'); if (t) t.focus(); }, 60); } } }));
    acts.appendChild(h('button', { class: 'btn sm danger', type: 'button', text: 'Delete', 'aria-label': 'Delete note: ' + label, on: { click: () => { if (confirm('Delete this note?')) act('DELETE', '/notes/' + n.id); } } }));
    const sel = h('select', { 'aria-label': 'Move note to another column: ' + label, 'data-fid': 'mv:' + n.id, on: { change: (e) => { const c = e.target.value; if (c !== col.id) act('PATCH', '/notes/' + n.id, { column: c, index: 0 }).then(() => { S.dirty = false; render(); }); } } },
      optionEls(st.columns.map((c) => ({ value: c.id, label: (st.id === 'entry-map' ? c.id + '. ' : '') + short(c.title, 28) })), col.id));
    sel.style.cssText = 'width:auto; min-height:1.9rem; padding:.1rem .4rem; font-size:.8125rem;';
    acts.appendChild(sel);
    acts.appendChild(h('button', { class: 'btn sm', type: 'button', text: '\u2191', 'aria-label': 'Move note up: ' + label, disabled: pos === 0, on: { click: () => act('PATCH', '/notes/' + n.id, { index: pos - 1 }) } }));
    acts.appendChild(h('button', { class: 'btn sm', type: 'button', text: '\u2193', 'aria-label': 'Move note down: ' + label, disabled: pos >= total - 1, on: { click: () => act('PATCH', '/notes/' + n.id, { index: pos + 1 }) } }));
  }
  el.appendChild(acts);
  return el;
}

/* ---- dot voting on entries ---- */
function voteView(v) {
  const ro = v.readOnly; const rem = v.dots.remaining['entry-vote'];
  const wrap = h('div');
  const grid = h('div', { class: 'entries' });
  v.entries.forEach((e) => {
    const ep = ENTRY[e.id]; const mine = e.votes.mine; const tot = e.votes.total;
    const card = h('article', { class: 'entry', 'aria-labelledby': 'eh-' + e.id },
      h('h3', { id: 'eh-' + e.id }, h('span', { class: 'letter', 'aria-hidden': 'true', text: e.id }), ep.name),
      h('div', { class: 'row' }, h('span', { class: 'tag ' + (ep.scope === 'mvp' ? 'mvp' : ep.scope === 'post' ? 'post' : ''), text: ep.scope === 'mvp' ? 'MVP scope' : ep.scope === 'post' ? 'Post-MVP' : 'Proposed' }), h('span', { class: 'tag', text: 'Effort ' + ep.effort })),
      h('p', { text: ep.what }),
      h('div', { class: 'dotsline', 'aria-hidden': 'true', text: '\u25CF'.repeat(mine) }),
      h('div', { class: 'help', text: 'Your dots: ' + mine + (tot == null ? '. Total hidden until reveal.' : '. Total: ' + tot + '.') }));
    if (!ro) card.appendChild(h('div', { class: 'row' },
      h('button', { class: 'btn sm', type: 'button', text: '+ Add dot', 'aria-label': 'Add a dot to ' + ep.name, 'data-fid': 'ep:' + e.id, on: { click: () => act('POST', '/votes', { targetType: 'entry', targetId: e.id }) } }),
      h('button', { class: 'btn sec sm', type: 'button', text: '\u2212 Remove dot', 'aria-label': 'Remove one of your dots from ' + ep.name, disabled: !mine, 'data-fid': 'em:' + e.id, on: { click: () => act('DELETE', '/votes', { targetType: 'entry', targetId: e.id }) } })));
    grid.appendChild(card);
  });
  if (!ro && rem === 0) wrap.appendChild(h('div', { class: 'notice', role: 'note', text: 'You have used all your dots. Remove one to place it elsewhere.' }));
  wrap.appendChild(grid);
  return wrap;
}

/* ---- 2x2 ---- */
function matrixView(v) {
  const ro = v.readOnly;
  const wrap = h('div');
  const anyAvg = v.entries.some((e) => e.placement.avg);
  const plot = h('div', { class: 'plot', role: 'group', 'aria-label': 'Impact against effort grid. Use the table below the grid for a keyboard alternative.' });
  plot.appendChild(h('div', { class: 'q tl', text: 'Quick win' })); plot.appendChild(h('div', { class: 'q tr', text: 'Big bet' }));
  plot.appendChild(h('div', { class: 'q bl', text: 'Fill-in' })); plot.appendChild(h('div', { class: 'q br', text: 'Reconsider' }));
  const showAvg = anyAvg && S.ui.showAvg;
  if (showAvg) v.entries.forEach((e) => { (e.placement.all || []).forEach((p) => plot.appendChild(h('div', { class: 'spot', style: 'left:' + p.x + '%; top:' + (100 - p.y) + '%' }))); });
  if (showAvg) v.entries.forEach((e) => { const a = e.placement.avg; if (a) plot.appendChild(h('div', { class: 'avg', style: 'left:' + a.x + '%; top:' + (100 - a.y) + '%', title: e.id + ' group average (' + a.n + ')' }, h('span', { text: e.id }))); });
  const tray = h('div', { class: 'tray', role: 'group', 'aria-label': 'Entry points not placed yet' });
  const mkChip = (e) => {
    const m = e.placement.mine; const sel = S.ui.matrixSel === e.id;
    const c = h('button', { class: 'chip' + (sel ? ' sel' : ''), type: 'button', 'data-fid': 'chip:' + e.id, 'aria-pressed': sel ? 'true' : 'false', disabled: ro,
      'aria-label': 'Entry point ' + e.id + ': ' + ENTRY[e.id].name + (m ? '. Your placement: effort ' + Math.round(m.x) + ', value ' + Math.round(m.y) + '.' : '. Not placed.') + ' Arrow keys move it.', text: e.id });
    if (m) c.style.cssText = 'left:' + m.x + '%; top:' + (100 - m.y) + '%';
    if (!ro) {
      c.addEventListener('keydown', (ev) => {
        const step = ev.shiftKey ? 10 : 5; const cur = e.placement.mine || { x: 50, y: 50 };
        let { x, y } = cur;
        if (ev.key === 'ArrowLeft') x -= step; else if (ev.key === 'ArrowRight') x += step; else if (ev.key === 'ArrowUp') y += step; else if (ev.key === 'ArrowDown') y -= step; else return;
        ev.preventDefault(); S.ui.matrixSel = e.id;
        act('PUT', '/placements/' + e.id, { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) });
      });
      c.addEventListener('pointerdown', (ev) => startChipDrag(ev, c, e, plot));
    }
    return c;
  };
  v.entries.forEach((e) => { const chip = mkChip(e); (e.placement.mine ? plot : tray).appendChild(chip); });
  const left = h('div', null, h('div', { class: 'axis-y-label', text: '\u2191 Value (low to high)' }), plot, h('div', { class: 'axis-x-label', text: 'Effort (low to high) \u2192' }));
  const side = h('div', { class: 'card' }, h('h3', { text: 'Your entry points' }),
    ro ? null : h('p', { class: 'help', text: 'Drag a circle onto the grid, or focus it and use the arrow keys (Shift for bigger steps). Or use the quadrant menus in the table.' }),
    h('p', { class: 'help', text: 'Not placed yet:' }), tray);
  if (anyAvg) {
    const cb = h('input', { type: 'checkbox', id: 'show-avg', checked: S.ui.showAvg, on: { change: (e) => { S.ui.showAvg = e.target.checked; render(); } } });
    side.appendChild(h('div', { class: 'field', style: 'margin-top:1rem' }, cb, h('label', { for: 'show-avg', style: 'display:inline', text: 'Show group results (diamonds = average, dots = each placement)' })));
  } else side.appendChild(h('p', { class: 'help', style: 'margin-top:1rem', text: v.me && v.me.isFacilitator ? 'No placements yet.' : 'Group results appear after the facilitator reveals them.' }));
  wrap.appendChild(h('div', { class: 'matrix-wrap' }, left, side));
  /* accessible table */
  const rows = v.entries.map((e) => {
    const m = e.placement.mine; const a = e.placement.avg;
    const selId = 'q-' + e.id;
    const q = h('select', { id: selId, 'aria-label': 'Place ' + ENTRY[e.id].name + ' in a quadrant', disabled: ro, 'data-fid': 'qsel:' + e.id, on: { change: (ev) => { const qq = QUADS.find((x) => x.id === ev.target.value); if (qq) act('PUT', '/placements/' + e.id, { x: qq.x, y: qq.y }).then(() => { S.dirty = false; render(); }); } } },
      h('option', { value: '', text: 'Choose\u2026' }), QUADS.map((x) => h('option', { value: x.id, text: x.label + ' (' + x.desc + ')' })));
    const mq = m ? (m.y >= 50 ? (m.x < 50 ? 'quick-win' : 'big-bet') : (m.x < 50 ? 'fill-in' : 'reconsider')) : '';
    q.value = mq;
    return h('tr', null, h('th', { scope: 'row', text: e.id + '. ' + ENTRY[e.id].name }), h('td', { text: m ? 'Effort ' + Math.round(m.x) + ', value ' + Math.round(m.y) : 'Not placed' }), h('td', null, q),
      h('td', null, ro || !m ? null : h('button', { class: 'btn sec sm', type: 'button', text: 'Remove', 'aria-label': 'Remove my placement for ' + ENTRY[e.id].name, on: { click: () => act('DELETE', '/placements/' + e.id) } })),
      h('td', { text: a ? 'Effort ' + a.x + ', value ' + a.y + ' (' + QLABEL[e.placement.quadrant] + ', n=' + a.n + ')' : 'Hidden or none' }));
  });
  wrap.appendChild(h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', { text: 'Placements as a table' }), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('caption', { class: 'sr-only', text: '2x2 placements per entry point' }),
    h('thead', null, h('tr', null, ['Entry point', 'My placement', 'Quadrant', 'Clear', 'Group average'].map((x) => h('th', { scope: 'col', text: x })))), h('tbody', null, rows)))));
  return wrap;
}
function startChipDrag(ev, chip, entry, plot) {
  if (ev.button !== undefined && ev.button !== 0) return;
  const sx = ev.clientX; const sy = ev.clientY; let moved = false;
  const pid = ev.pointerId;
  try { chip.setPointerCapture(pid); } catch (e) { /* ignore */ }
  const move = (e) => {
    if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;
    if (!moved) { moved = true; S.pointerDrag = true; chip.style.position = 'fixed'; chip.style.transform = 'translate(-50%,-50%)'; chip.style.zIndex = 100; }
    chip.style.left = e.clientX + 'px'; chip.style.top = e.clientY + 'px';
  };
  const up = (e) => {
    chip.removeEventListener('pointermove', move); chip.removeEventListener('pointerup', up); chip.removeEventListener('pointercancel', up);
    try { chip.releasePointerCapture(pid); } catch (er) { /* ignore */ }
    if (!moved) { S.ui.matrixSel = entry.id; return; }
    S.pointerDrag = false;
    const r = plot.getBoundingClientRect();
    if (e.type === 'pointerup' && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      const x = Math.round(((e.clientX - r.left) / r.width) * 1000) / 10; const y = Math.round((100 - ((e.clientY - r.top) / r.height) * 100) * 10) / 10;
      S.ui.matrixSel = entry.id;
      act('PUT', '/placements/' + entry.id, { x, y }).then(() => doRender());
    } else doRender();
  };
  chip.addEventListener('pointermove', move); chip.addEventListener('pointerup', up); chip.addEventListener('pointercancel', up);
}

/* ---- open questions and decisions ---- */
function qaView(v) {
  const ro = v.readOnly; const fac = !!(v.me && v.me.isFacilitator);
  const wrap = h('div');
  if (!ro) {
    const text = bindDraft(h('textarea', { maxlength: 400, rows: 2 }), 'q:text', '');
    const owner = bindDraft(h('input', { type: 'text', maxlength: 60 }), 'q:owner', '');
    const kind = bindDraft(h('select', null, optionEls([{ value: 'question', label: 'Open question' }, { value: 'decision', label: 'Decision' }], 'question')), 'q:kind', 'question');
    const status = bindDraft(h('select', null, optionEls(STATUSES.map((s) => ({ value: s, label: s })), 'open')), 'q:status', 'open');
    const submit = async (e) => { e.preventDefault(); if (!clean(text.value, 400)) { toast('Write the question or decision first.', true); return; } const r = await act('POST', '/questions', { kind: kind.value, text: text.value, owner: owner.value, status: status.value }); if (r) { ['q:text', 'q:owner'].forEach((k) => { S.ui.drafts[k] = ''; }); render(); } };
    wrap.appendChild(h('form', { class: 'card', style: 'margin-bottom:1rem', on: { submit } }, h('h3', { text: 'Add a question or decision' }),
      h('div', { class: 'row grow' }, labeled('Type', kind), labeled('Owner', owner), labeled('Status', status)), labeled('Text', text), h('button', { class: 'btn sm', type: 'submit', text: 'Add' })));
  }
  const list = h('ul', { class: 'list' });
  v.questions.forEach((q) => {
    const can = !ro && (q.mine || fac);
    const li = h('li', { class: 'item' });
    if (S.ui.editQ === q.id) {
      const fid = 'qe:' + q.id + ':';
      const text = bindDraft(h('textarea', { maxlength: 400, rows: 2 }), fid + 'text', q.text);
      const owner = bindDraft(h('input', { type: 'text', maxlength: 60 }), fid + 'owner', q.owner);
      const dec = bindDraft(h('textarea', { maxlength: 400, rows: 2 }), fid + 'dec', q.decision);
      const status = bindDraft(h('select', null, optionEls(STATUSES.map((s) => ({ value: s, label: s })), q.status)), fid + 'st', q.status);
      const kind = bindDraft(h('select', null, optionEls([{ value: 'question', label: 'Open question' }, { value: 'decision', label: 'Decision' }], q.kind)), fid + 'kind', q.kind);
      li.appendChild(labeled('Text', text)); li.appendChild(h('div', { class: 'row grow' }, labeled('Type', kind), labeled('Owner', owner), labeled('Status', status))); li.appendChild(labeled('Decision / outcome', dec));
      li.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', text: 'Save', on: { click: async () => { const r = await act('PATCH', '/questions/' + q.id, { text: text.value, owner: owner.value, decision: dec.value, status: status.value, kind: kind.value }); if (r) { S.ui.editQ = null; render(); } } } }),
        h('button', { class: 'btn sec sm', type: 'button', text: 'Cancel', on: { click: () => { S.ui.editQ = null; render(); } } })));
    } else {
      li.appendChild(h('div', { class: 'row' }, h('span', { class: 'tag ' + (q.kind === 'decision' ? 'mvp' : 'info'), text: q.kind === 'decision' ? 'Decision' : 'Question' }), h('span', { class: 'tag ' + (q.status === 'decided' ? 'mvp' : q.status === 'parked' ? '' : 'post'), text: 'Status: ' + q.status })));
      li.appendChild(h('p', { text: q.text }));
      li.appendChild(h('div', { class: 'meta', text: 'Owner: ' + (q.owner || 'not assigned') + (q.gate ? ' \u00B7 Gate: ' + q.gate : '') + (q.decision ? ' \u00B7 Outcome: ' + q.decision : '') + (q.authorName ? ' \u00B7 Added by ' + q.authorName : '') }));
      if (can) {
        const st = h('select', { 'aria-label': 'Status for: ' + short(q.text, 40), 'data-fid': 'qs:' + q.id, on: { change: (e) => act('PATCH', '/questions/' + q.id, { status: e.target.value }).then(() => { S.dirty = false; render(); }) } }, optionEls(STATUSES.map((s) => ({ value: s, label: s })), q.status));
        st.style.cssText = 'width:auto; min-height:2rem; padding:.1rem .4rem;';
        li.appendChild(h('div', { class: 'row', style: 'margin-top:.5rem' }, st, h('button', { class: 'btn sm', type: 'button', text: 'Edit', 'aria-label': 'Edit: ' + short(q.text, 40), on: { click: () => { S.ui.editQ = q.id; render(); } } }),
          h('button', { class: 'btn sm danger', type: 'button', text: 'Delete', 'aria-label': 'Delete: ' + short(q.text, 40), on: { click: () => { if (confirm('Delete this item?')) act('DELETE', '/questions/' + q.id); } } })));
      }
    }
    list.appendChild(li);
  });
  if (!v.questions.length) list.appendChild(h('li', { class: 'help', text: 'Nothing logged yet.' }));
  wrap.appendChild(list);
  return wrap;
}

/* ---- wrap-up ---- */
function wrapView(v) {
  const ro = v.readOnly; const fac = !!(v.me && v.me.isFacilitator);
  const wrap = h('div', { class: 'grid2' });
  /* top voted */
  const top = h('section', { class: 'card', 'aria-labelledby': 'w-top' }, h('h3', { id: 'w-top', text: 'Top-voted entry points' }));
  if (v.wrapup.topVoted.length) top.appendChild(h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Entry point', 'Dots', 'Effort (avg)', 'Value (avg)', 'Quadrant'].map((x) => h('th', { scope: 'col', text: x })))),
    h('tbody', null, v.wrapup.topVoted.map((t) => h('tr', null, h('th', { scope: 'row', text: t.id + '. ' + ENTRY[t.id].name }), h('td', { text: String(t.votes) }), h('td', { text: t.avgX == null ? '-' : String(t.avgX) }), h('td', { text: t.avgY == null ? '-' : String(t.avgY) }), h('td', { text: t.quadrant ? QLABEL[t.quadrant] : '-' })))))));
  else top.appendChild(h('p', { text: fac ? 'No dots on entry points yet.' : 'Results appear when the facilitator reveals them, or when no dots have been placed yet.' }));
  wrap.appendChild(top);
  /* recommendation */
  const rec = v.wrapup.recommendation;
  const recCard = h('section', { class: 'card', 'aria-labelledby': 'w-rec' }, h('h3', { id: 'w-rec', text: 'MVP versus post-MVP recommendation' }));
  if (fac && !ro) {
    const sels = SEED.entryPoints.map((e) => {
      const cur = rec.mvp.includes(e.id) ? 'mvp' : rec.postMvp.includes(e.id) ? 'post' : 'none';
      const s = bindDraft(h('select', null, optionEls([{ value: 'none', label: 'Undecided' }, { value: 'mvp', label: 'MVP' }, { value: 'post', label: 'Post-MVP' }], cur)), 'rec:' + e.id, cur);
      return { e, s };
    });
    sels.forEach(({ e, s }) => recCard.appendChild(labeled(e.id + '. ' + e.name, s)));
    const rat = bindDraft(h('textarea', { maxlength: 800, rows: 3 }), 'rec:rationale', rec.rationale);
    recCard.appendChild(labeled('Rationale', rat));
    recCard.appendChild(h('button', { class: 'btn sm', type: 'button', text: 'Save recommendation', on: { click: async () => {
      const mvp = sels.filter((x) => x.s.value === 'mvp').map((x) => x.e.id); const postMvp = sels.filter((x) => x.s.value === 'post').map((x) => x.e.id);
      const r = await act('PUT', '/recommendation', { mvp, postMvp, rationale: rat.value }); if (r) { toast('Recommendation saved.'); Object.keys(S.ui.drafts).filter((k) => k.startsWith('rec:')).forEach((k) => delete S.ui.drafts[k]); render(); } } } }));
  } else {
    const name = (id) => id + '. ' + ENTRY[id].name;
    recCard.appendChild(h('h4', { text: 'MVP' })); recCard.appendChild(rec.mvp.length ? ul(rec.mvp.map(name)) : h('p', { class: 'help', text: 'Not decided yet.' }));
    recCard.appendChild(h('h4', { text: 'Post-MVP' })); recCard.appendChild(rec.postMvp.length ? ul(rec.postMvp.map(name)) : h('p', { class: 'help', text: 'Not decided yet.' }));
    if (rec.rationale) recCard.appendChild(h('p', { text: 'Rationale: ' + rec.rationale }));
  }
  wrap.appendChild(recCard);
  /* next steps */
  const ns = h('section', { class: 'card', style: 'grid-column:1/-1', 'aria-labelledby': 'w-ns' }, h('h3', { id: 'w-ns', text: 'Next steps and experiments' }));
  if (!ro) {
    const text = bindDraft(h('textarea', { maxlength: 400, rows: 2 }), 'ns:text', '');
    const owner = bindDraft(h('input', { type: 'text', maxlength: 60 }), 'ns:owner', '');
    const type = bindDraft(h('select', null, optionEls(STEP_TYPES.map((t) => ({ value: t, label: t })), 'action')), 'ns:type', 'action');
    const due = bindDraft(h('input', { type: 'text', maxlength: 30, placeholder: 'e.g. end of June' }), 'ns:due', '');
    const submit = async (e) => { e.preventDefault(); if (!clean(text.value, 400)) { toast('Describe the next step first.', true); return; } const r = await act('POST', '/nextsteps', { text: text.value, owner: owner.value, type: type.value, due: due.value }); if (r) { ['ns:text', 'ns:owner', 'ns:due'].forEach((k) => { S.ui.drafts[k] = ''; }); render(); } };
    ns.appendChild(h('form', { on: { submit } }, labeled('What will we do?', text), h('div', { class: 'row grow' }, labeled('Owner', owner), labeled('Type', type), labeled('Due', due)),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'submit', text: 'Add next step' }))));
    ns.appendChild(h('div', { class: 'help', text: 'Start from a suggested experiment:' }));
    ns.appendChild(h('div', { class: 'row', style: 'margin:.4rem 0 1rem' }, SEED.experiments.map((x) => h('button', { class: 'btn sec sm', type: 'button', text: x.name, on: { click: () => { S.ui.drafts['ns:text'] = x.name + ' (metric: ' + x.metric + ')'; S.ui.drafts['ns:type'] = 'experiment'; render(); } } }))));
  }
  const list = h('ul', { class: 'list' });
  v.wrapup.nextSteps.forEach((n) => {
    const can = !ro && (n.mine || fac); const li = h('li', { class: 'item' });
    if (S.ui.editStep === n.id) {
      const fid = 'se:' + n.id + ':';
      const text = bindDraft(h('textarea', { maxlength: 400, rows: 2 }), fid + 't', n.text);
      const owner = bindDraft(h('input', { type: 'text', maxlength: 60 }), fid + 'o', n.owner);
      const type = bindDraft(h('select', null, optionEls(STEP_TYPES.map((t) => ({ value: t, label: t })), n.type)), fid + 'ty', n.type);
      const due = bindDraft(h('input', { type: 'text', maxlength: 30 }), fid + 'd', n.due);
      li.appendChild(labeled('Text', text)); li.appendChild(h('div', { class: 'row grow' }, labeled('Owner', owner), labeled('Type', type), labeled('Due', due)));
      li.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', text: 'Save', on: { click: async () => { const r = await act('PATCH', '/nextsteps/' + n.id, { text: text.value, owner: owner.value, type: type.value, due: due.value }); if (r) { S.ui.editStep = null; render(); } } } }),
        h('button', { class: 'btn sec sm', type: 'button', text: 'Cancel', on: { click: () => { S.ui.editStep = null; render(); } } })));
    } else {
      li.appendChild(h('div', { class: 'row' }, h('span', { class: 'tag info', text: n.type }), h('span', { text: n.text })));
      li.appendChild(h('div', { class: 'meta', text: 'Owner: ' + (n.owner || 'TBD') + (n.due ? ' \u00B7 Due: ' + n.due : '') + (n.authorName ? ' \u00B7 Added by ' + n.authorName : '') }));
      if (can) li.appendChild(h('div', { class: 'row', style: 'margin-top:.4rem' }, h('button', { class: 'btn sm', type: 'button', text: 'Edit', 'aria-label': 'Edit next step: ' + short(n.text, 40), on: { click: () => { S.ui.editStep = n.id; render(); } } }),
        h('button', { class: 'btn sm danger', type: 'button', text: 'Delete', 'aria-label': 'Delete next step: ' + short(n.text, 40), on: { click: () => { if (confirm('Delete this next step?')) act('DELETE', '/nextsteps/' + n.id); } } })));
    }
    list.appendChild(li);
  });
  if (!v.wrapup.nextSteps.length) list.appendChild(h('li', { class: 'help', text: 'No next steps yet.' }));
  ns.appendChild(list);
  wrap.appendChild(ns);
  return wrap;
}

/* ------------------------------------------------------------------ boot */
window.addEventListener('popstate', () => { if (S.screen !== 'session' || S.mode === 'online') { resetSessionState(); S.mode = null; route(); } });
window.addEventListener('online', () => { if (S.mode === 'online') refreshState(); });
window.addEventListener('error', (e) => { const m = e && e.message; if (m && !/ResizeObserver/.test(m)) toast('Unexpected error: ' + m, true); });
route();
})();
