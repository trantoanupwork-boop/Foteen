// Forteen online: phòng 4 người, máy chủ giữ luật và xáo bài (không máy khách nào thấy bài người khác).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TL } = require('./engine.js');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const TURN_MS = +process.env.TURN_MS || 120000, READY_MS = +process.env.READY_MS || 10000, ROOM_IDLE_MS = 3 * 60 * 60 * 1000;
const KINDS = ['slap', 'hammer', 'egg', 'kiss'];
const ROOMS = new Map();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!ROOMS.has(c)) return c;
  }
}
function newRoom() {
  const code = makeCode();
  const room = { code, seats: [null, null, null, null], phase: 'lobby', mode: 'het', roundNo: 0,
    gm: null, deadline: 0, turnTO: null, rdy: null, rdyTO: null, clients: new Set(), chatTimes: [], last: Date.now() };
  ROOMS.set(code, room);
  return room;
}
function seatOf(room, tok) { return room.seats.findIndex(s => s && s.token === tok); }
function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max); }

// ----- Hiển thị theo góc nhìn từng người: mình luôn là ghế 0 -----
function viewFor(room, real) {
  const me = real;
  const v = { real: me, phase: room.phase, mode: room.mode, roundNo: room.roundNo,
    seats: [0, 1, 2, 3].map(k => {
      const s = room.seats[(me + k) % 4];
      return s ? { name: s.name, av: s.av, ready: !!s.ready, online: s.clients.size > 0 } : null;
    }),
    left: Math.max(0, room.deadline - Date.now()) };
  const m = r => (r - me + 4) % 4;
  if (room.gm) {
    const gm = room.gm;
    v.tg = {
      players: [0, 1, 2, 3].map(k => {
        const real2 = (me + k) % 4, p = gm.players[real2];
        return { seat: k, name: p.name, bot: false, out: p.out, place: p.place,
          hand: real2 === me ? p.hand : p.hand.map(() => ({ id: -1, r: 0, s: 0 })) };
      }),
      turn: gm.turn === null ? null : m(gm.turn),
      top: gm.top ? { combo: gm.top.combo, seat: m(gm.top.seat) } : null,
      passed: Object.keys(gm.passed).filter(k => gm.passed[k]).reduce((o, k) => { o[m(+k)] = true; return o; }, {}),
      first: gm.first,
      finished: gm.finished.map(m),
      cuts: gm.cuts.map(c => ({ cutter: m(c.cutter), victim: m(c.victim), cards: c.cards })),
      over: gm.over, mode: gm.mode,
      trang: (gm.trang === undefined || gm.trang === null) ? null : m(gm.trang)
    };
  }
  if (room.rdy) v.rdy = { ready: [0, 1, 2, 3].map(k => !!room.rdy.ready[(me + k) % 4]), left: Math.max(0, room.rdy.deadline - Date.now()) };
  return v;
}
function send(client, event, data) {
  try { client.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) {}
}
function broadcastView(room) {
  room.last = Date.now();
  room.clients.forEach(c => send(c, 'view', viewFor(room, c.seat)));
}
function broadcast(room, event, data) { room.clients.forEach(c => send(c, event, data)); }

// ----- Luật chơi trên máy chủ -----
function startGame(room) {
  clearTimeout(room.rdyTO); room.rdyTO = null; room.rdy = null;
  room.phase = 'play';
  room.roundNo++;
  room.gm = TL.newGame(room.mode, room.seats.map(s => s.name));
  afterMove(room);
}
function afterMove(room) {
  clearTimeout(room.turnTO); room.turnTO = null;
  const gm = room.gm;
  if (gm.over) {
    room.phase = 'ready';
    room.rdy = { ready: [false, false, false, false], deadline: Date.now() + READY_MS };
    room.deadline = room.rdy.deadline;
    room.rdyTO = setTimeout(() => startGame(room), READY_MS);
  } else if (gm.turn !== null) {
    room.deadline = Date.now() + TURN_MS;
    room.turnTO = setTimeout(() => autoTurn(room), TURN_MS);
  }
  broadcastView(room);
}
function autoTurn(room) {
  const gm = room.gm;
  if (!gm || gm.over || gm.turn === null) return;
  const seat = gm.turn;
  const ids = TL.botMove(gm, seat);
  let err = ids ? TL.play(gm, seat, ids) : TL.pass(gm, seat);
  if (err) TL.pass(gm, seat);
  afterMove(room);
}
function allSeated(room) { return room.seats.every(Boolean); }
function maybeStartLobby(room) {
  if (room.phase === 'lobby' && allSeated(room) && room.seats.every(s => s.ready)) startGame(room);
}

function handleAct(room, seat, msg) {
  switch (msg.type) {
    case 'play': {
      if (room.phase !== 'play' || !room.gm) return 'Chưa có ván đang chơi.';
      const ids = Array.isArray(msg.ids) ? msg.ids.map(Number).filter(Number.isInteger) : [];
      if (room.gm.turn !== seat) return 'Chưa đến lượt bạn.';
      const err = TL.play(room.gm, seat, ids);
      if (err) return err;
      afterMove(room); return null;
    }
    case 'pass': {
      if (room.phase !== 'play' || !room.gm) return 'Chưa có ván đang chơi.';
      const err = TL.pass(room.gm, seat);
      if (err) return err;
      afterMove(room); return null;
    }
    case 'ready': {
      const on = msg.on !== false;
      if (room.phase === 'lobby') {
        room.seats[seat].ready = on; broadcastView(room); maybeStartLobby(room); return null;
      }
      if (room.phase === 'ready' && room.rdy) {
        room.rdy.ready[seat] = true;
        if (room.rdy.ready.every(Boolean)) startGame(room); else broadcastView(room);
        return null;
      }
      return 'Chưa thể sẵn sàng lúc này.';
    }
    case 'chat': {
      const now = Date.now();
      room.chatTimes = room.chatTimes.filter(t => now - t < 5000);
      if (room.chatTimes.length >= 5) return 'Chat nhanh quá, đợi chút nhé.';
      room.chatTimes.push(now);
      const text = clean(msg.text, 120);
      if (!text) return null;
      broadcast(room, 'chat', { seat, name: room.seats[seat].name, text });
      return null;
    }
    case 'react': {
      if (!KINDS.includes(msg.kind)) return null;
      const to = Number(msg.to);
      if (!(to >= 0 && to <= 3)) return null;
      broadcast(room, 'react', { from: seat, to, kind: msg.kind });
      return null;
    }
    case 'leave': {
      if (room.phase === 'play') return 'Đang chơi, không thể rời ghế.';
      room.seats[seat] = null;
      room.phase = 'lobby'; room.rdy = null; clearTimeout(room.rdyTO);
      room.seats.forEach(s => { if (s) s.ready = false; });
      broadcastView(room);
      return null;
    }
  }
  return 'Hành động không hợp lệ.';
}

// ----- HTTP -----
function readBody(req, cb) {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 16384) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(data || '{}')); } catch (e) { cb(null); } });
}
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function getRoom(code) { return ROOMS.get(String(code || '').toUpperCase()) || null; }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return fs.createReadStream(path.join(PUB, 'index.html')).pipe(res);
  }
  if (req.method === 'POST' && url.pathname === '/api/room') {
    const room = newRoom();
    return json(res, 200, { code: room.code });
  }
  if (req.method === 'POST' && url.pathname === '/api/join') {
    return readBody(req, body => {
      if (!body) return json(res, 400, { error: 'Dữ liệu không hợp lệ.' });
      const room = getRoom(body.code);
      if (!room) return json(res, 404, { error: 'Không tìm thấy phòng này.' });
      let tok = clean(body.token, 64);
      let seat = tok ? seatOf(room, tok) : -1;
      if (seat < 0) {
        if (room.phase !== 'lobby') return json(res, 409, { error: 'Ván đang chơi, chờ ván sau nhé.' });
        seat = room.seats.findIndex(s => !s);
        if (seat < 0) return json(res, 409, { error: 'Phòng đã đủ 4 người.' });
        tok = crypto.randomBytes(16).toString('hex');
        const av = body.av && typeof body.av === 'object' ? body.av : {};
        room.seats[seat] = { token: tok, name: clean(body.name, 20) || 'Bạn', av: JSON.parse(JSON.stringify(av)).b ? av : {}, ready: false, clients: new Set() };
      } else if (body.name) {
        room.seats[seat].name = clean(body.name, 20) || room.seats[seat].name;
      }
      broadcastView(room);
      return json(res, 200, { token: tok, seat });
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    const room = getRoom(url.searchParams.get('code'));
    const seat = room ? seatOf(room, url.searchParams.get('token') || '') : -1;
    if (!room || seat < 0) return json(res, 403, { error: 'Không vào được phòng.' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const client = { res, seat };
    room.clients.add(client);
    room.seats[seat].clients = room.seats[seat].clients || new Set();
    room.seats[seat].clients.add(client);
    send(client, 'view', viewFor(room, seat));
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => {
      clearInterval(ping); room.clients.delete(client);
      if (room.seats[seat]) room.seats[seat].clients.delete(client);
      broadcastView(room);
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/act') {
    return readBody(req, body => {
      const room = body && getRoom(body.code);
      const seat = room ? seatOf(room, clean(body.token, 64)) : -1;
      if (!room || seat < 0) return json(res, 403, { error: 'Bạn không ở trong phòng này.' });
      const err = handleAct(room, seat, body);
      return json(res, 200, err ? { error: err } : { ok: true });
    });
  }
  res.writeHead(404); res.end('Not found');
});

// Dọn phòng bỏ không lâu
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of ROOMS) {
    if (room.clients.size === 0 && now - room.last > ROOM_IDLE_MS) {
      clearTimeout(room.turnTO); clearTimeout(room.rdyTO); ROOMS.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log('Forteen online on port ' + PORT));
