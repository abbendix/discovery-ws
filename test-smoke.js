#!/usr/bin/env node
'use strict';
/* Smoke test for server.js. Built-ins only. Run: node test-smoke.js
 * Starts the server on a random port with a temp DATA_DIR, exercises the API, restarts it, cleans up. */
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-smoke-'));
let child = null;
let base = '';
let passed = 0;

function startServer() {
  return new Promise((resolve, reject) => {
    child = fork(path.join(__dirname, 'server.js'), [], { env: { ...process.env, PORT: '0', DATA_DIR: tmp }, silent: true });
    const t = setTimeout(() => reject(new Error('server start timeout')), 10000);
    child.once('message', (m) => { if (m && m.ready) { clearTimeout(t); base = 'http://127.0.0.1:' + m.port; resolve(); } });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error('server exited early: ' + c)); });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }, 3000).unref();
  });
}

async function api(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
function ok(name) { passed++; console.log('  ok  ' + name); }
async function expectStatus(name, promise, status, code) {
  const r = await promise;
  assert.strictEqual(r.status, status, name + ': expected ' + status + ' got ' + r.status + ' ' + r.text.slice(0, 200));
  if (code) assert.strictEqual(r.json.error.code, code, name + ': error code');
  ok(name);
  return r;
}

/** Minimal SSE reader built on fetch streaming. */
async function openSse(p, token) {
  const ctrl = new AbortController();
  const res = await fetch(base + p + '?token=' + token, { signal: ctrl.signal });
  assert.strictEqual(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
  const events = []; const waiters = [];
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block); const da = /^data: (.*)$/m.exec(block);
          if (ev && da) { const e = { event: ev[1], data: JSON.parse(da[1]) }; events.push(e); waiters.slice().forEach((w) => w(e)); }
        }
      }
    } catch (e) { /* aborted */ }
  })();
  return {
    events,
    waitFor: (pred, ms = 4000) => new Promise((resolve, reject) => {
      const hit = events.find(pred); if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error('SSE wait timeout')), ms);
      const w = (e) => { if (pred(e)) { clearTimeout(t); waiters.splice(waiters.indexOf(w), 1); resolve(e); } };
      waiters.push(w);
    }),
    close: () => ctrl.abort(),
  };
}

async function main() {
  console.log('Smoke test, temp data dir: ' + tmp);
  await startServer();

  /* --- basics --- */
  const seed = await expectStatus('GET /api/seed', api('GET', '/api/seed'), 200);
  assert.strictEqual(seed.json.entryPoints.length, 9);
  assert.ok(seed.json.stages.some((s) => s.id === 'entry-vote'));
  const idx = await expectStatus('static index.html', api('GET', '/'), 200);
  assert.ok(idx.text.includes('<html'));
  const disc = await expectStatus('discovery prototype served', api('GET', '/discovery/pick-up-where-you-left-off.html'), 200);
  assert.ok(disc.text.includes('<html'));
  await expectStatus('discovery route is fixed (no other files)', api('GET', '/discovery/../server.js'), 404);
  const trav = await api('GET', '/..%2fserver.js');
  assert.ok(trav.status === 403 || trav.status === 404, 'path traversal blocked');
  ok('path traversal blocked');
  assert.ok(idx.headers.get('content-security-policy').includes("default-src 'self'"));
  ok('CSP header present');

  /* --- create session --- */
  const cr = await expectStatus('create session', api('POST', '/api/sessions', null, { title: 'Smoke <b>test</b> session', dotsPerParticipant: 3, facilitatorName: 'Fay' }), 201);
  const id = cr.json.id; const pin = cr.json.facilitatorPin; const fTok = cr.json.token;
  assert.ok(/^[A-Z0-9]{6}$/.test(id)); assert.ok(/^\d{6}$/.test(pin));
  assert.ok(!cr.json.title.includes('<'), 'title sanitised');
  ok('session id + PIN shape, title sanitised');
  const P = '/api/sessions/' + id;

  await expectStatus('join with wrong PIN rejected', api('POST', P + '/join', null, { name: 'Mallory', pin: '000000' }), 403, 'bad_pin');
  await expectStatus('join needs a name', api('POST', P + '/join', null, { name: '  ' }), 400, 'name_required');
  const a = (await expectStatus('join Alice', api('POST', P + '/join', null, { name: 'Alice' }), 200)).json;
  const b = (await expectStatus('join Bob', api('POST', P + '/join', null, { name: 'Bob' }), 200)).json;
  const co = (await expectStatus('join with PIN becomes facilitator', api('POST', P + '/join', null, { name: 'Co', pin }), 200)).json;
  assert.strictEqual(co.participant.isFacilitator, true); assert.strictEqual(a.participant.isFacilitator, false);
  const aT = a.token; const bT = b.token;

  /* --- SSE --- */
  const sse = await openSse(P + '/events', bT);
  await sse.waitFor((e) => e.event === 'state');
  ok('SSE hello + initial state');

  /* --- concurrent notes and dots --- */
  const addNote = (tok, col, text, stage = 'entry-map') => api('POST', P + '/notes', tok, { stage, column: col, category: 'idea', text });
  const results = await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => addNote(aT, 'A', 'Alice note ' + i)),
    ...Array.from({ length: 10 }, (_, i) => addNote(bT, 'C', 'Bob note ' + i)),
  ]);
  assert.ok(results.every((r) => r.status === 201), 'all concurrent notes created');
  ok('20 concurrent notes from 2 participants');
  await sse.waitFor((e) => e.event === 'state' && e.data.notes.filter((n) => n.stage === 'entry-map').length === 20);
  ok('SSE pushed live state with all notes');

  const html = await addNote(aT, 'A', '<script>alert(1)</script>Hello', 'entry-map');
  assert.ok(!html.json.note.text.includes('<') && html.json.note.text.includes('Hello'));
  ok('HTML stripped from note text');
  await expectStatus('unknown column rejected', addNote(aT, 'ZZ', 'x'), 400, 'bad_column');
  await expectStatus('no token rejected', addNote(null, 'A', 'x'), 401);
  await expectStatus('oversize body rejected', api('POST', P + '/notes', aT, { stage: 'entry-map', column: 'A', text: 'x'.repeat(70000) }), 413);
  const longNote = await addNote(aT, 'A', 'y'.repeat(5000));
  assert.ok(longNote.json.note.text.length <= 400); ok('note length capped');

  let state = (await api('GET', P + '/state', aT)).json;
  const aliceNote = state.notes.find((n) => n.text === 'Alice note 0');
  const bobNote = state.notes.find((n) => n.text === 'Bob note 0');
  assert.ok(aliceNote.mine && !bobNote.mine);

  /* own-note permissions, move */
  await expectStatus('cannot edit others notes', api('PATCH', P + '/notes/' + aliceNote.id, bT, { text: 'hijack' }), 403, 'forbidden');
  await expectStatus('cannot delete others notes', api('DELETE', P + '/notes/' + aliceNote.id, bT), 403, 'forbidden');
  await expectStatus('edit own note', api('PATCH', P + '/notes/' + aliceNote.id, aT, { text: 'Alice edited', category: 'concern' }), 200);
  await expectStatus('drag-drop move to column D index 0', api('PATCH', P + '/notes/' + aliceNote.id, aT, { column: 'D', index: 0 }), 200);
  state = (await api('GET', P + '/state', aT)).json;
  const moved = state.notes.find((n) => n.id === aliceNote.id);
  assert.strictEqual(moved.column, 'D'); assert.strictEqual(moved.order, 1); assert.strictEqual(moved.text, 'Alice edited'); assert.strictEqual(moved.category, 'concern');
  ok('move persisted (column/order/text/category)');

  /* dots: concurrency + limit */
  const dotRes = await Promise.all([
    api('POST', P + '/votes', aT, { targetType: 'entry', targetId: 'G' }),
    api('POST', P + '/votes', bT, { targetType: 'entry', targetId: 'G' }),
    api('POST', P + '/votes', aT, { targetType: 'entry', targetId: 'H' }),
    api('POST', P + '/votes', bT, { targetType: 'entry', targetId: 'A' }),
    api('POST', P + '/votes', aT, { targetType: 'entry', targetId: 'G' }),
    api('POST', P + '/votes', bT, { targetType: 'entry', targetId: 'G' }),
  ]);
  assert.ok(dotRes.every((r) => r.status === 200)); ok('6 concurrent dots from 2 participants');
  // limit is 3 each; both are now at 3
  await expectStatus('4th dot rejected server-side (Alice)', api('POST', P + '/votes', aT, { targetType: 'entry', targetId: 'C' }), 409, 'no_dots_left');
  // fire many in parallel for Bob after freeing one
  await expectStatus('remove own dot', api('DELETE', P + '/votes', bT, { targetType: 'entry', targetId: 'A' }), 200);
  const burst = await Promise.all(Array.from({ length: 8 }, () => api('POST', P + '/votes', bT, { targetType: 'entry', targetId: 'F' })));
  assert.strictEqual(burst.filter((r) => r.status === 200).length, 1, 'exactly one burst dot allowed');
  assert.strictEqual(burst.filter((r) => r.status === 409).length, 7);
  ok('parallel burst cannot exceed limit');
  await expectStatus('cannot remove a dot you do not have', api('DELETE', P + '/votes', aT, { targetType: 'entry', targetId: 'F' }), 404);
  // note dots in assumptions stage have their own budget
  state = (await api('GET', P + '/state', aT)).json;
  const seedNote = state.notes.find((n) => n.stage === 'assumptions');
  assert.ok(seedNote, 'prefilled assumptions exist');
  await expectStatus('note dot uses separate stage budget', api('POST', P + '/votes', aT, { targetType: 'note', targetId: seedNote.id }), 200);
  await expectStatus('dots not allowed on non-votable stage notes', (async () => {
    const n = await addNote(aT, 'seen', 'warm', 'warmup'); return api('POST', P + '/votes', aT, { targetType: 'note', targetId: n.json.note.id });
  })(), 400, 'not_votable');

  /* hidden votes until reveal */
  state = (await api('GET', P + '/state', bT)).json;
  assert.strictEqual(state.entries.find((e) => e.id === 'G').votes.total, null);
  assert.strictEqual(state.entries.find((e) => e.id === 'G').votes.mine, 2);
  ok('vote totals hidden from participants until reveal');
  const facState = (await api('GET', P + '/state', fTok)).json;
  assert.strictEqual(facState.entries.find((e) => e.id === 'G').votes.total, 4);
  ok('facilitator sees totals (G = 4 dots)');

  /* lock voting */
  await expectStatus('non-facilitator cannot lock', api('POST', P + '/voting', aT, { locked: true }), 403, 'forbidden');
  await expectStatus('facilitator locks voting', api('POST', P + '/voting', fTok, { locked: true }), 200);
  await expectStatus('dot rejected while locked', api('POST', P + '/votes', aT, { targetType: 'entry', targetId: 'C' }), 423, 'voting_locked');
  await expectStatus('facilitator unlocks voting', api('POST', P + '/voting', fTok, { locked: false }), 200);

  /* 2x2 */
  await expectStatus('Alice places G', api('PUT', P + '/placements/G', aT, { x: 20, y: 80 }), 200);
  await expectStatus('Bob places G', api('PUT', P + '/placements/G', bT, { x: 40, y: 60 }), 200);
  await expectStatus('invalid placement rejected', api('PUT', P + '/placements/G', bT, { x: 'a', y: 1 }), 400);
  const facS2 = (await api('GET', P + '/state', fTok)).json.entries.find((e) => e.id === 'G').placement;
  assert.deepStrictEqual(facS2.avg, { x: 30, y: 70, n: 2 }); assert.strictEqual(facS2.quadrant, 'quick-win');
  ok('server computes 2x2 average + quadrant');

  /* facilitator-only matrix */
  const facOnly = [
    ['POST', '/reveal', { revealed: true }], ['POST', '/settings', { anonymous: true }], ['POST', '/stage', { stage: 'next' }],
    ['POST', '/timer', { action: 'start', seconds: 60 }], ['POST', '/timer', { action: 'stop' }], ['POST', '/clear', { stage: 'all' }],
    ['PUT', '/recommendation', { mvp: ['G'] }], ['POST', '/export', {}], ['GET', '/export.md'], ['GET', '/export.csv'], ['GET', '/export.json'], ['DELETE', '', undefined],
  ];
  for (const [m, p, body] of facOnly) {
    const r = await api(m, P + p, aT, body);
    assert.strictEqual(r.status, 403, m + ' ' + p + ' should be 403 for participant, got ' + r.status);
    const r2 = await api(m, P + p, null, body);
    assert.strictEqual(r2.status, 401, m + ' ' + p + ' should be 401 without token, got ' + r2.status);
  }
  ok('all facilitator-only actions reject participants (403) and anonymous callers (401)');
  state = (await api('GET', P + '/state', fTok)).json;
  assert.strictEqual(state.notes.length >= 20, true, 'rejected clear did nothing');

  /* facilitator actions */
  await expectStatus('reveal votes', api('POST', P + '/reveal', fTok, { revealed: true }), 200);
  state = (await api('GET', P + '/state', bT)).json;
  assert.strictEqual(state.entries.find((e) => e.id === 'G').votes.total, 4);
  assert.strictEqual(state.wrapup.topVoted[0].id, 'G');
  ok('participants see totals + topVoted after reveal');
  await expectStatus('timer start', api('POST', P + '/timer', fTok, { action: 'start', seconds: 90 }), 200);
  state = (await api('GET', P + '/state', aT)).json;
  assert.ok(state.timer.running && state.timer.remainingMs > 80000 && state.timer.remainingMs <= 90000);
  await expectStatus('timer stop', api('POST', P + '/timer', fTok, { action: 'stop' }), 200);
  await expectStatus('advance stage', api('POST', P + '/stage', fTok, { stage: 'next' }), 200);
  assert.strictEqual((await api('GET', P + '/state', aT)).json.stage, 'entry-map');
  await expectStatus('settings: dots per participant 4', api('POST', P + '/settings', fTok, { dotsPerParticipant: 4 }), 200);
  await expectStatus('anonymous mode on', api('POST', P + '/settings', fTok, { anonymous: true }), 200);
  state = (await api('GET', P + '/state', bT)).json;
  assert.ok(state.notes.filter((n) => !n.seed).every((n) => n.authorName === null && n.authorId === null));
  assert.ok(state.notes.find((n) => n.text === 'Bob note 0').mine === true);
  ok('anonymous mode hides authors but keeps "mine"');
  await expectStatus('anonymous off again', api('POST', P + '/settings', fTok, { anonymous: false }), 200);

  /* questions, decisions, next steps, recommendation */
  const q = (await expectStatus('add question', api('POST', P + '/questions', aT, { kind: 'question', text: 'Who owns checkout resume?', owner: 'Heads of Product' }), 201)).json.item;
  await expectStatus('add decision', api('POST', P + '/questions', bT, { kind: 'decision', text: 'MVP stays account-exclusive', owner: 'Account Core PM', status: 'decided', decision: 'Yes, guests are post-MVP' }), 201);
  await expectStatus('other participant cannot edit question', api('PATCH', P + '/questions/' + q.id, bT, { status: 'decided' }), 403);
  await expectStatus('author can set status', api('PATCH', P + '/questions/' + q.id, aT, { status: 'discussing' }), 200);
  await expectStatus('bad status rejected', api('PATCH', P + '/questions/' + q.id, aT, { status: 'nope' }), 400);
  await expectStatus('add next step', api('POST', P + '/nextsteps', aT, { text: 'A/B test header eye', owner: 'Account Core PM', type: 'experiment', due: '2026-09-30' }), 201);
  await expectStatus('facilitator sets recommendation', api('PUT', P + '/recommendation', fTok, { mvp: ['G', 'H', 'ZZ'], postMvp: ['I', 'G'], rationale: 'Deck scope first' }), 200);
  state = (await api('GET', P + '/state', aT)).json;
  assert.deepStrictEqual(state.wrapup.recommendation.mvp, ['G', 'H']); assert.deepStrictEqual(state.wrapup.recommendation.postMvp, ['I']);
  ok('recommendation validated server-side');

  /* read-only + list */
  const list = await expectStatus('list sessions', api('GET', '/api/sessions'), 200);
  assert.ok(list.json.sessions.some((s) => s.id === id));
  const ro = await expectStatus('read-only view without token', api('GET', P + '/readonly'), 200);
  assert.strictEqual(ro.json.readOnly, true); assert.strictEqual(ro.json.me, null);
  await expectStatus('read-only cannot mutate', api('POST', P + '/notes', null, { stage: 'entry-map', column: 'A', text: 'x' }), 401);

  /* persistence on disk */
  const file = path.join(tmp, 'session-' + id + '.json');
  assert.ok(fs.existsSync(file), 'session file exists');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(disk.notes.length >= 22 && disk.votes.length === 7 && disk.placements.length === 2);
  assert.ok(!fs.readdirSync(tmp).some((f) => f.endsWith('.tmp')), 'no tmp files left behind');
  assert.ok(!JSON.stringify(disk).includes(pin) && !JSON.stringify(disk).includes(aT), 'no plaintext PIN/token on disk');
  ok('data persisted atomically on disk (no tmp files, no plaintext secrets)');

  /* exports */
  const md = await expectStatus('Markdown export', api('GET', P + '/export.md?token=' + fTok), 200);
  for (const needle of ['## Top voted entry points', 'myTUI dashboard module', '## 2x2 prioritisation', 'quick-win', '## Open questions', 'Who owns checkout resume', '## Decisions', 'MVP stays account-exclusive', '## MVP vs post-MVP recommendation', 'A/B test header eye', 'Alice edited'])
    assert.ok(md.text.includes(needle), 'markdown contains: ' + needle);
  assert.ok(!['Mor' + 'pho', 'Coding' + 'Aces', 'Code' + 'Artisans'].some((w) => md.text.includes(w)));
  ok('Markdown content ok');
  const pm = await expectStatus('POST /export saves to data/exports', api('POST', P + '/export', fTok, {}), 200);
  assert.ok(fs.existsSync(path.join(tmp, 'exports', pm.json.file)));
  await expectStatus('download saved export', api('GET', pm.json.downloadUrl + '?token=' + fTok), 200);
  const csvN = await expectStatus('CSV notes export', api('GET', P + '/export.csv?token=' + fTok), 200);
  assert.ok(csvN.text.includes('"note_id","stage","column","category","text","author","dots"') && csvN.text.includes('Bob note 3') && csvN.text.includes('Alice'));
  const csvV = await expectStatus('CSV votes export', api('GET', P + '/export.csv?kind=votes&token=' + fTok), 200);
  assert.ok(csvV.text.includes('myTUI dashboard module') && csvV.text.includes('Bob'));
  assert.strictEqual(csvV.text.trim().split('\r\n').length - 1, state.counts.votes, 'one CSV row per dot');
  const js = await expectStatus('JSON export', api('GET', P + '/export.json?token=' + fTok), 200);
  assert.ok(!js.text.includes('tokenHash') && JSON.parse(js.text).id === id);
  ok('CSV and JSON content ok');

  /* restart -> restore */
  const before = (await api('GET', P + '/state', fTok)).json;
  sse.close();
  await stopServer();
  await startServer();
  const after = (await api('GET', P + '/state', fTok)).json;
  assert.strictEqual(after.id, id);
  assert.strictEqual(after.notes.length, before.notes.length);
  assert.strictEqual(after.counts.votes, before.counts.votes);
  assert.deepStrictEqual(after.entries.find((e) => e.id === 'G'), before.entries.find((e) => e.id === 'G'));
  assert.deepStrictEqual(after.wrapup.recommendation, before.wrapup.recommendation);
  assert.strictEqual(after.stage, before.stage);
  ok('state fully restored after server restart');
  const rej = await expectStatus('old participant token still valid after restart', api('POST', P + '/join', null, { token: aT, name: 'ignored' }), 200);
  assert.strictEqual(rej.json.participant.name, 'Alice');
  // limit was raised to 4 before restart; Alice has 3 entry dots: one more is fine, the next is rejected
  await expectStatus('settings (4 dots) restored: 4th dot ok', api('POST', P + '/votes', aT, { targetType: 'entry', targetId: 'C' }), 200);
  await expectStatus('vote limit still enforced after restart', api('POST', P + '/votes', aT, { targetType: 'entry', targetId: 'C' }), 409, 'no_dots_left');
  const hl = await api('GET', '/api/sessions');
  assert.ok(hl.json.sessions.some((s) => s.id === id)); ok('past session listed after restart');

  /* delete */
  await expectStatus('facilitator deletes session', api('DELETE', P, fTok), 200);
  assert.ok(!fs.existsSync(file), 'session file removed');
  assert.ok(!fs.readdirSync(path.join(tmp, 'exports')).some((f) => f.startsWith('session-' + id + '-')), 'exports removed');
  await expectStatus('deleted session is 404', api('GET', P + '/state', fTok), 404);
  ok('delete removes data + exports');

  console.log('\nAll ' + passed + ' checks passed.');
}

main().then(async () => { await stopServer(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); })
  .catch(async (e) => { console.error('\nFAILED:', e && e.stack || e); try { await stopServer(); } catch (x) { /* ignore */ } fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
