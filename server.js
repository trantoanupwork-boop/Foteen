// Forteen online: phòng tối đa 4 người, máy chủ giữ luật và xáo bài (máy khách không thấy bài người khác).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TL } = require('./engine.js');
const { makeFairRng, newFair, sha256hex } = require('./fair.js');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
// Mất kết nối quá lâu khi đang chơi thì người đó bị loại khỏi ván (không có AI tiếp quản)
const DISCONNECT_MS = +process.env.DISCONNECT_MS || 60000;
// Thời gian suy nghĩ tối đa cho mỗi lượt đánh; hết giờ thì người đó bị loại khỏi ván
const TURN_MS = +process.env.TURN_MS || 60000;
// Giữ lá cuối cùng trên bàn trước khi hiện kết quả ván
const FINAL_TRICK_MS = +process.env.FINAL_TRICK_MS || 1600;
const READY_MS = +process.env.READY_MS || 10000;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;
const KINDS = ['slap', 'hammer', 'egg', 'kiss'];
// Vị trí hiển thị trên bàn theo số người chơi (0 = mình, luôn ở dưới)
const POS = { 2: [0, 2], 3: [0, 1, 3], 4: [0, 1, 2, 3] };
const ROOMS = new Map();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!ROOMS.has(c)) return c;
  }
}
function newRoom(mode) {
  const code = makeCode();
  const room = { code, seats: [null, null, null, null], phase: 'lobby', mode: mode === 'dem' ? 'dem' : 'het', roundNo: 0,
    gm: null, order: null, deadline: 0, turnTO: null, rdy: null, rdyTO: null,
    clients: new Set(), chatTimes: [], last: Date.now(), offTO: [null, null, null, null], lastWinner: null, host: null };
  ROOMS.set(code, room);
  return room;
}
function seatOf(room, tok) { return room.seats.findIndex(s => s && s.token === tok); }
// Chủ phòng: người vào đầu tiên. Nếu chủ rời ghế thì chuyển cho người có ghế kế tiếp.
function ensureHost(room) {
  if (room.host == null || !room.seats[room.host]) room.host = room.seats.findIndex(s => s);
  if (room.host < 0) room.host = null;
}
// Nhân vật hợp lệ: có các bộ phận cơ bản (da và áo luôn có)
function isAv(a) { return !!(a && typeof a === 'object' && a.skin && a.shirt); }
function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max); }
function canStart(room) {
  const seated = room.seats.filter(Boolean);
  return seated.length >= 2 && room.seats.every(s => !s || s.ready);
}

// Ghế hiển thị (4 ô) nhìn từ người "me" (dùng ghế thật). Lobby: theo thứ tự ghế thật. Đang chơi: theo thứ tự người trong ván.
function slotsFor(room, me) {
  if (!room.gm) return [0, 1, 2, 3].map(k => (me + k) % 4);
  const order = room.order, N = order.length, meE = order.indexOf(me);
  const slots = [null, null, null, null];
  if (meE < 0) return slots;
  for (let j = 0; j < N; j++) slots[POS[N][(j - meE + N) % N]] = order[j];
  return slots;
}
function slotOfReal(room, me, real) { return slotsFor(room, me).indexOf(real); }
function seatInfo(s) { return s ? { name: s.name, av: s.av, ready: !!s.ready, online: s.clients.size > 0 } : null; }

function viewFor(room, me) {
  const slots = slotsFor(room, me);
  const v = { real: me, phase: room.phase, mode: room.mode, roundNo: room.roundNo, isHost: me === room.host, hostSlot: room.host == null ? -1 : slots.indexOf(room.host),
    seats: slots.map(r => (r == null ? null : seatInfo(room.seats[r]))),
    canStart: room.phase === 'lobby' && canStart(room),
    left: Math.max(0, room.deadline - Date.now()), turnUntil: (room.phase === 'play' && room.gm && !room.gm.over && !room.hold) ? room.deadline : 0, serverNow: Date.now() };
  if (room.gm) {
    const gm = room.gm, N = room.order.length, meE = room.order.indexOf(me);
    const hold = !!room.hold; // đang giữ lá cuối: coi như chưa kết thúc, không có lượt
    const shownTop = hold ? gm.lastPlay : gm.top;
    const P = j => POS[N][(j - meE + N) % N];
    const m = j => P(j);
    const players = [0, 1, 2, 3].map(p => ({ seat: p, name: '', bot: false, out: true, place: 0, hand: [], absent: true }));
    gm.players.forEach((p, j) => {
      players[P(j)] = { seat: P(j), name: p.name, bot: false, out: p.out, place: p.place,
        hand: (j === meE || gm.over) ? p.hand : p.hand.map(() => ({ id: -1, r: 0, s: 0 })) };
    });
    v.tg = {
      players,
      turn: hold || gm.turn === null ? null : m(gm.turn),
      top: shownTop ? { combo: shownTop.combo, seat: m(shownTop.seat) } : null,
      passed: Object.keys(gm.passed).filter(k => gm.passed[k]).reduce((o, k) => { o[m(+k)] = true; return o; }, {}),
      first: gm.first,
      finished: gm.finished.map(m),
      cuts: gm.cuts.map(c => ({ cutter: m(c.cutter), victim: m(c.victim), cards: c.cards })),
      over: gm.over && !hold, hold: hold, trangType: gm.trangType || null, mode: gm.mode,
      trang: gm.trang == null ? null : m(gm.trang),
      fair: { gameId: room.fair.gameId, commit: room.fair.commit, reveal: room.fair.reveal }
    };
  }
  if (room.rdy) v.rdy = { ready: slots.map(r => (r == null ? false : !!(room.seats[r] && room.seats[r].clients.size > 0))), left: Math.max(0, room.rdy.deadline - Date.now()), until: room.rdy.deadline, now: Date.now() };
  return v;
}
function send(client, event, data) {
  try { client.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) {}
}
function broadcastView(room) {
  room.last = Date.now();
  room.clients.forEach(c => send(c, 'view', viewFor(room, c.seat)));
}
// Sự kiện (chat, cảm xúc): mỗi người nhận ghế theo góc nhìn của chính họ
function broadcastEvent(room, event, build) {
  room.clients.forEach(c => send(c, event, build(c.seat)));
}

// ----- Luật chơi trên máy chủ -----
// Thắng trắng (khi chia bài): mọi người xem toàn bộ bài 3 giây trước khi sang bước chuẩn bị ván mới
const TRANG_MS = 3000;

// Bắt đầu ván: chỉ chia một lần cho mỗi ván; thứ tự ván = những ghế đang có người
function startGame(room) {
  if (room.phase === 'play') return;
  clearTimeout(room.rdyTO); room.rdyTO = null; room.rdy = null;
  room.order = [0, 1, 2, 3].filter(i => room.seats[i]);
  if (room.order.length < 2) { // không đủ người (có thể do rời bàn lúc đếm ngược): về sảnh
    room.phase = 'lobby'; room.gm = null; room.order = null;
    broadcastView(room); return;
  }
  room.phase = 'play';
  room.hold = false; room.finalShown = false;
  room.roundNo++;
  room.fair = newFair();
  console.log(`[fair] phòng ${room.code} ván ${room.fair.gameId} commit ${room.fair.commit}`);
  const lead = room.lastWinner == null ? -1 : room.order.indexOf(room.lastWinner);
  room.gm = TL.newGame(room.mode, room.order.map(r => room.seats[r].name), lead, makeFairRng(room.fair.secret));
  afterMove(room);
}
function afterMove(room) {
  const gm = room.gm;
  clearTimeout(room.turnTO); room.turnTO = null;
  if (gm.over && !room.finalShown) {
    room.finalShown = true;
    // Giữ hiển thị một lúc trước khi sang kết quả: lá cuối (ván thường) hoặc bài các người (thắng trắng)
    const ms = gm.lastPlay ? FINAL_TRICK_MS : (gm.trang != null ? TRANG_MS : 0);
    if (ms) {
      room.hold = true; room.deadline = 0;
      broadcastView(room);
      room.holdTO = setTimeout(() => { room.hold = false; afterMove(room); }, ms);
      return;
    }
  }
  if (gm.over) {
    room.offTO.forEach((t, i) => { clearTimeout(t); room.offTO[i] = null; });
    room.lastWinner = room.order[gm.finished[0]];
    room.fair.reveal = room.fair.secret.toString('hex');
    console.log(`[fair] phòng ${room.code} ván ${room.fair.gameId} reveal ${room.fair.reveal} (kiểm: ${sha256hex(room.fair.secret) === room.fair.commit})`);
    room.deadline = 0;
    if (room.seats.filter(Boolean).length >= 2) {
      // Tự động: đếm ngược READY_MS (mặc định 10 giây) rồi chia ván mới, không cần bấm gì
      room.phase = 'ready';
      room.rdy = { ready: [true, true, true, true], deadline: Date.now() + READY_MS };
      room.deadline = room.rdy.deadline;
      room.rdyTO = setTimeout(() => startGame(room), READY_MS);
    } else { // còn dưới 2 người: về sảnh chờ
      room.phase = 'lobby'; room.rdy = null; // giữ kết quả ván vừa xong để người còn lại vẫn xem được
      room.seats.forEach(s => { if (s) s.ready = false; });
    }
  } else if (gm.turn !== null) { // đồng hồ lượt: hết giờ thì loại người đang có lượt
    room.deadline = Date.now() + TURN_MS;
    room.turnTO = setTimeout(() => turnTimeout(room), TURN_MS);
  } else {
    room.deadline = 0;
  }
  broadcastView(room);
}

// Hết thời gian suy nghĩ của lượt: người đang có lượt bị loại khỏi ván (máy không đánh thay)
// Hết giờ: nếu đang có bài trên bàn thì tự bỏ lượt. Nếu đang mở bàn (không được bỏ lượt)
// thì tự đánh bộ nhỏ nhất theo luật (ván đầu là 3 bích). Chỉ khi không có nước hợp lệ mới loại khỏi ván.
function turnTimeout(room) {
  const gm = room.gm;
  if (room.phase !== 'play' || !gm || gm.over || gm.turn === null || !room.order) return;
  if (gm.top) {
    TL.pass(gm, gm.turn);
    afterMove(room);
    return;
  }
  const ids = TL.botMove(gm, gm.turn);
  if (ids && !TL.play(gm, gm.turn, ids)) { afterMove(room); return; }
  dropFromGame(room, room.order[gm.turn], 'timeout');
}

// Tách ghế khỏi bàn: cắt ghế (không vào lại được) và báo người đó rời bàn
function detachSeat(room, seat, reason) {
  room.seats[seat] = null;
  ensureHost(room);
  clearTimeout(room.offTO[seat]); room.offTO[seat] = null;
  room.clients.forEach(c => {
    if (c.seat !== seat) return;
    send(c, 'out', { reason });
    room.clients.delete(c);
    try { c.res.end(); } catch (e) {}
  });
}
// Rời bàn giữa ván: loại người đó, xóa bài còn trên tay
function dropFromGame(room, seat, reason) {
  if (room.phase !== 'play' || !room.gm || !room.order || !room.order.includes(seat)) return false;
  if (!TL.removePlayer(room.gm, room.order.indexOf(seat))) return false;
  if (room.gm.over) room.finalShown = true; // ván kết thúc vì người rời bàn: không có lá cuối để giữ
  detachSeat(room, seat, reason);
  afterMove(room);
  return true;
}
// Rời bàn lúc đếm ngược ván mới: ván kế tiếp sẽ chia theo danh sách người còn lại
function leaveReady(room, seat) {
  if (room.phase !== 'ready' || !room.order || !room.order.includes(seat)) return false;
  detachSeat(room, seat, 'leave');
  broadcastView(room);
  return true;
}

function handleAct(room, seat, msg) {
  switch (msg.type) {
    case 'start': {
      if (room.phase !== 'lobby') return 'Đang có ván chơi.';
      if (seat !== room.host) return 'Chỉ chủ phòng mới bấm Bắt đầu được.';
      if (!canStart(room)) return 'Cần ít nhất 2 người, và tất cả phải bấm Sẵn sàng.';
      startGame(room); return null;
    }
    case 'play':
    case 'pass': {
      const ej = room.order ? room.order.indexOf(seat) : -1;
      if (room.phase !== 'play' || !room.gm || ej < 0) return 'Chưa có ván đang chơi.';
      if (room.gm.turn !== ej) return 'Chưa đến lượt bạn.';
      let err;
      if (msg.type === 'pass') err = TL.pass(room.gm, ej);
      else {
        const ids = Array.isArray(msg.ids) ? msg.ids.map(Number).filter(Number.isInteger) : [];
        err = TL.play(room.gm, ej, ids);
      }
      if (err) return err;
      afterMove(room); return null;
    }
    case 'ready': {
      const on = msg.on !== false;
      if (room.phase === 'lobby') { room.seats[seat].ready = on; broadcastView(room); return null; }
      if (room.phase === 'ready') return null; // ván mới tự bắt đầu sau đếm ngược, không cần bấm
      return 'Chưa thể sẵn sàng lúc này.';
    }
    case 'chat': {
      const now = Date.now();
      room.chatTimes = room.chatTimes.filter(t => now - t < 5000);
      if (room.chatTimes.length >= 5) return 'Chat nhanh quá, đợi chút nhé.';
      room.chatTimes.push(now);
      const text = clean(msg.text, 120);
      if (!text) return null;
      const name = room.seats[seat].name;
      broadcastEvent(room, 'chat', me => ({ seat: slotOfReal(room, me, seat), name, text }));
      return null;
    }
    case 'react': {
      if (!KINDS.includes(msg.kind)) return null;
      const toReal = slotsFor(room, seat)[Number(msg.to)];
      if (toReal == null) return null;
      const kind = msg.kind;
      broadcastEvent(room, 'react', me => ({ from: slotOfReal(room, me, seat), to: slotOfReal(room, me, toReal), kind }));
      return null;
    }
    case 'mode': { // chủ phòng chọn chế độ trong sảnh; ván đang chơi không đổi được
      if (room.phase !== 'lobby') return 'Chỉ đổi chế độ khi đang ở sảnh.';
      if (seat !== room.host) return 'Chỉ chủ phòng mới đổi được chế độ.';
      room.mode = msg.mode === 'dem' ? 'dem' : 'het';
      broadcastView(room); return null;
    }
    case 'leave': {
      if (room.phase === 'play') { dropFromGame(room, seat, 'leave'); return null; }
      if (room.phase === 'ready') { leaveReady(room, seat); return null; }
      if (room.phase !== 'lobby') return 'Đang chơi, không thể rời ghế.';
      room.seats[seat] = null;
      ensureHost(room);
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
    const file = [path.join(PUB, 'index.html'), path.join(__dirname, 'index.html')].find(f => fs.existsSync(f));
    if (!file) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Thieu file public/index.html tren server. Kiem tra cau truc thu muc khi tai len GitHub.');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    const stream = fs.createReadStream(file);
    stream.on('error', () => { try { res.end(); } catch (e) {} });
    return stream.pipe(res);
  }
  if (req.method === 'POST' && url.pathname === '/api/room') {
    return readBody(req, body => json(res, 200, { code: newRoom(body && body.mode).code }));
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
        const av = isAv(body.av) ? body.av : {};
        room.seats[seat] = { token: tok, name: clean(body.name, 20) || 'Bạn', av, ready: false, clients: new Set() };
      } else {
        if (body.name) room.seats[seat].name = clean(body.name, 20) || room.seats[seat].name;
        // Vào lại phòng: cập nhật nhân vật hiện tại của máy này
        if (isAv(body.av)) room.seats[seat].av = body.av;
      }
      ensureHost(room);
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
    clearTimeout(room.offTO[seat]); room.offTO[seat] = null;
    room.clients.add(client);
    room.seats[seat].clients.add(client);
    send(client, 'view', viewFor(room, seat));
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      room.clients.delete(client);
      if (room.seats[seat]) room.seats[seat].clients.delete(client);
      // Đang chơi và ghế này không còn kết nối nào: sau DISCONNECT_MS thì loại khỏi ván
      if (room.seats[seat] && room.seats[seat].clients.size === 0 && room.phase === 'play') {
        clearTimeout(room.offTO[seat]);
        room.offTO[seat] = setTimeout(() => {
          room.offTO[seat] = null;
          if (room.seats[seat] && room.seats[seat].clients.size === 0) dropFromGame(room, seat, 'disconnect');
        }, DISCONNECT_MS);
      }
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

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of ROOMS) {
    if (room.clients.size === 0 && now - room.last > ROOM_IDLE_MS) {
      clearTimeout(room.turnTO); clearTimeout(room.rdyTO); ROOMS.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

process.on('uncaughtException', e => console.error('Loi:', e && e.message));
server.listen(PORT, () => console.log('Forteen online on port ' + PORT));
