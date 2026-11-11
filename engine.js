var Phom;
// Phỏm miền Nam — engine thuần (không DOM). Dùng được trong trình duyệt và Node.
// Quy ước: r = 0..12 (A,2,...,K), s = 0..3 (♣ ♦ ♥ ♠), id = r*4 + s.
// Điểm: A = 1, 2..10 theo số, J=11, Q=12, K=13.
(function (root) {
  var SUITS = ['♣', '♦', '♥', '♠'];
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  function makeDeck() {
    var d = [];
    for (var r = 0; r < 13; r++) for (var s = 0; s < 4; s++) d.push({ id: r * 4 + s, r: r, s: s });
    return d;
  }
  function pts(c) { return c.r === 0 ? 1 : c.r + 1; }
  function label(c) { return RANKS[c.r] + SUITS[c.s]; }

  // Xáo bằng bộ sinh số ngẫu nhiên mật mã. rng(n) trả số nguyên trong [0, n).
  function cryptoRng(n) {
    var c = (typeof crypto !== 'undefined') ? crypto : require('crypto').webcrypto;
    var max = 0x100000000 - (0x100000000 % n), x;
    do { x = c.getRandomValues(new Uint32Array(1))[0]; } while (x >= max);
    return x % n;
  }
  function shuffle(arr, rng) {
    rng = rng || cryptoRng;
    for (var i = arr.length - 1; i > 0; i--) {
      var j = rng(i + 1), t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // Phỏm hợp lệ: từ 3 lá trở lên cùng số (khác chất), hoặc từ 3 lá trở lên cùng chất liên tiếp (A thấp nhất, không vòng).
  function isMeld(cards) {
    var n = cards.length;
    if (n < 3) return false;
    var sameRank = cards.every(function (c) { return c.r === cards[0].r; });
    if (sameRank) {
      var suits = {};
      for (var i = 0; i < n; i++) { if (suits[cards[i].s]) return false; suits[cards[i].s] = 1; }
      return n <= 4;
    }
    var sameSuit = cards.every(function (c) { return c.s === cards[0].s; });
    if (!sameSuit) return false;
    var rs = cards.map(function (c) { return c.r; }).sort(function (a, b) { return a - b; });
    for (var k = 1; k < rs.length; k++) if (rs[k] !== rs[k - 1] + 1) return false;
    return true;
  }

  // Tìm cách xếp tay bài thành phỏm sao cho tổng điểm lá rác nhỏ nhất.
  // Trả về {dead: [lá rác], deadPts, melds: [[...],...]}.
  function bestMelds(cards) {
    var memo = {};
    function key(list) { return list.map(function (c) { return c.id; }).join(','); }
    function rec(list) {
      if (!list.length) return { dead: [], deadPts: 0, melds: [] };
      var k = key(list);
      if (memo[k]) return memo[k];
      var first = list[0], rest = list.slice(1);
      // Phương án 1: lá đầu là rác
      var best = rec(rest);
      var cand = { dead: [first].concat(best.dead), deadPts: pts(first) + best.deadPts, melds: best.melds };
      var bestRes = cand;
      // Phương án 2: lá đầu nằm trong một phỏm (duyệt mọi tổ hợp con của phần còn lại)
      var m = rest.length;
      for (var mask = 1; mask < (1 << m); mask++) {
        var group = [first], left = [];
        for (var i = 0; i < m; i++) { if (mask & (1 << i)) group.push(rest[i]); else left.push(rest[i]); }
        if (group.length < 3 || !isMeld(group)) continue;
        var sub = rec(left);
        var res = { dead: sub.dead, deadPts: sub.deadPts, melds: [group].concat(sub.melds) };
        if (res.deadPts < bestRes.deadPts || (res.deadPts === bestRes.deadPts && res.dead.length < bestRes.dead.length)) bestRes = res;
      }
      memo[k] = bestRes;
      return bestRes;
    }
    // Sắp theo id để khóa memo ổn định
    var sorted = cards.slice().sort(function (a, b) { return a.id - b.id; });
    return rec(sorted);
  }

  function canWin(cards) { return bestMelds(cards).dead.length === 0; }

  // ---- Trạng thái ván ----
  // players: [{name, hand:[], laid:[[...]], out:false}]
  // Ghế 0 đi đầu với 10 lá, các ghế khác 9 lá.
  function newGame(names, opts) {
    opts = opts || {};
    var n = names.length;
    if (n < 2 || n > 4) throw new Error('Phỏm cần 2 đến 4 người');
    var deck = shuffle(makeDeck(), opts.rng);
    var players = names.map(function (nm, i) {
      return { seat: i, name: nm, hand: [], laid: [], out: false };
    });
    var cnt = [10].concat(new Array(n - 1).fill(9));
    for (var p = 0; p < n; p++) {
      for (var k = 0; k < cnt[p]; k++) players[p].hand.push(deck.pop());
    }
    return {
      players: players,
      n: n,
      stock: deck,            // cuối mảng là lá trên cùng
      discard: [],            // cuối mảng là lá đánh ra gần nhất
      turn: 0,
      phase: 'discard',       // ghế đầu phải đánh luôn (10 lá)
      turns: 0,               // số lượt đã đi, để tính vòng
      maxRounds: opts.maxRounds || 4,
      lastDiscardSeat: null,
      ate: false,             // lá đơn vừa bị ăn
      ateGroup: false,        // bộ 3 lá vừa bị ăn (để tính ù đền)
      groupOpen: null,        // {cards, by} bộ vừa được đánh ra, còn chờ người kế tiếp ăn
      over: false,
      result: null
    };
  }

  function nextSeat(g, seat) {
    var s = seat;
    for (var i = 0; i < g.n; i++) {
      s = (s + 1) % g.n;
      if (!g.players[s].out) return s;
    }
    return seat;
  }
  function roundNo(g) { return Math.floor(g.turns / g.n) + 1; }

  function findCard(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }

  // Ăn lá đánh ra: chỉ người kế tiếp được ăn, và lá ăn phải tạo phỏm với 2 lá trong tay.
  // ids: 2 lá trong tay cùng với lá trên cùng của bàn tạo thành một phỏm.
  function eat(g, seat, ids) {
    if (g.over) return 'Ván đã kết thúc';
    if (g.phase !== 'draw') return 'Chưa đến lượt bốc/ăn';
    if (seat !== g.turn) return 'Chưa đến lượt bạn';
    if (seat !== nextSeat(g, g.lastDiscardSeat)) return 'Chỉ người kế tiếp được ăn';
    if (!g.discard.length) return 'Bàn không có lá để ăn';
    if (g.groupOpen) return 'Bộ vừa đánh ra chỉ ăn được cả bộ';
    var top = g.discard[g.discard.length - 1];
    if (!ids || ids.length !== 2) return 'Chọn đúng 2 lá trong tay để ăn';
    var p = g.players[seat], cards = [];
    for (var i = 0; i < ids.length; i++) {
      var idx = findCard(p.hand, ids[i]);
      if (idx < 0) return 'Lá không có trong tay';
      cards.push(p.hand[idx]);
    }
    var group = [top].concat(cards);
    if (!isMeld(group)) return 'Ba lá này không tạo thành phỏm';
    g.discard.pop();
    ids.forEach(function (id) { p.hand.splice(findCard(p.hand, id), 1); });
    p.laid.push(group);
    g.ate = true;
    g.ateGroup = false;
    g.groupOpen = null;
    g.lastEatSeat = seat;
    g.eatenFrom = g.lastDiscardSeat;
    g.lastEatCard = top;
    (g.eatLog = g.eatLog || []).push(seat);
    g.phase = 'discard';
    if (canWin(p.hand)) return winNow(g, seat);
    return null;
  }

  // Bốc từ chồng úp (khi không ăn).
  function draw(g, seat) {
    if (g.over) return 'Ván đã kết thúc';
    if (g.phase !== 'draw') return 'Chưa đến lượt bốc';
    if (seat !== g.turn) return 'Chưa đến lượt bạn';
    if (!g.stock.length) { return endByExhaust(g); }
    g.players[seat].hand.push(g.stock.pop());
    g.groupOpen = null;
    g.ateGroup = false;
    g.phase = 'discard';
    if (canWin(g.players[seat].hand)) return winNow(g, seat);
    return null;
  }

  // Đánh một lá. Nếu lá đánh ra là lá cuối (sau khi đánh tay còn đủ phỏm) thì ù.
  function discard(g, seat, id) {
    if (g.over) return 'Ván đã kết thúc';
    if (g.phase !== 'discard') return 'Hãy bốc hoặc ăn trước';
    if (seat !== g.turn) return 'Chưa đến lượt bạn';
    var p = g.players[seat], idx = findCard(p.hand, id);
    if (idx < 0) return 'Lá không có trong tay';
    var card = p.hand.splice(idx, 1)[0];
    g.discard.push(card);
    g.lastDiscardSeat = seat;
    g.lastDiscardCard = card;
    g.turns++;
    // Ù khi tay còn lại toàn phỏm
    if (canWin(p.hand)) {
      return finish(g, { type: 'u', winner: seat });
    }
    g.ate = false;
    g.ateGroup = false;
    g.groupOpen = null;
    g.turn = nextSeat(g, seat);
    g.phase = 'draw';
    if (roundNo(g) > g.maxRounds) return endByRounds(g);
    return null;
  }

  // Đánh cả bộ (3 lá trở lên tạo thành phỏm) trong một lượt. Người kế tiếp có thể ăn cả bộ.
  function discardMeld(g, seat, ids) {
    if (g.over) return 'Ván đã kết thúc';
    if (g.phase !== 'discard') return 'Hãy bốc hoặc ăn trước';
    if (seat !== g.turn) return 'Chưa đến lượt bạn';
    if (!ids || ids.length < 3) return 'Bộ đánh ra phải từ 3 lá';
    var p = g.players[seat], cards = [];
    for (var i = 0; i < ids.length; i++) {
      var idx = findCard(p.hand, ids[i]);
      if (idx < 0) return 'Lá không có trong tay';
      cards.push(p.hand[idx]);
    }
    if (!isMeld(cards)) return 'Các lá này không tạo thành phỏm';
    ids.forEach(function (id) { p.hand.splice(findCard(p.hand, id), 1); });
    cards.forEach(function (c) { g.discard.push(c); });
    g.groupOpen = { cards: cards, by: seat };
    g.lastDiscardSeat = seat;
    g.lastDiscardCard = cards[cards.length - 1];
    g.turns++;
    g.ate = false;
    g.ateGroup = false;
    if (canWin(p.hand)) return finish(g, { type: 'u', winner: seat });
    g.turn = nextSeat(g, seat);
    g.phase = 'draw';
    if (roundNo(g) > g.maxRounds) return endByRounds(g);
    return null;
  }

  // Ăn cả bộ vừa được đánh ra. Chỉ người kế tiếp được ăn.
  function eatGroup(g, seat) {
    if (g.over) return 'Ván đã kết thúc';
    if (!g.groupOpen) return 'Không có bộ nào để ăn';
    if (g.phase !== 'draw') return 'Chưa đến lượt ăn';
    if (seat !== g.turn) return 'Chưa đến lượt bạn';
    var grp = g.groupOpen;
    if (seat !== nextSeat(g, grp.by)) return 'Chỉ người kế tiếp được ăn';
    var k = grp.cards.length;
    g.discard.splice(g.discard.length - k, k);
    g.players[seat].laid.push(grp.cards.slice());
    g.ate = false;
    g.ateGroup = true;
    g.eatenFrom = grp.by;
    (g.eatLog = g.eatLog || []).push(seat);
    g.groupOpen = null;
    g.phase = 'discard';
    if (canWin(g.players[seat].hand)) return winNow(g, seat);
    return null;
  }

  // Ù tự động: ván kết thúc ngay khi tay bài xếp hết thành phỏm.
  // Nếu người ù vừa ăn cả bộ của người khác thì là ù đền.
  function winNow(g, seat) {
    if (g.ateGroup && g.eatenFrom !== null && g.eatenFrom !== undefined && g.eatenFrom !== seat) {
      return finish(g, { type: 'uden', winner: seat, payer: g.eatenFrom });
    }
    return finish(g, { type: 'u', winner: seat });
  }

  // Hạ phỏm: đặt các bộ hợp lệ từ tay xuống bàn cho mọi người cùng thấy. Chỉ khi đã bốc/ăn.
  // groups: mảng các mảng id lá.
  function lay(g, seat, groups) {
    if (g.over) return 'Ván đã kết thúc';
    if (g.phase !== 'discard') return 'Hạ bộ sau khi bốc hoặc ăn';
    if (seat !== g.turn) return 'Chưa đến lượt bạn';
    if (!groups || !groups.length) return 'Chọn bộ cần hạ';
    var p = g.players[seat], seen = {}, built = [];
    for (var gi = 0; gi < groups.length; gi++) {
      var cards = [];
      for (var k = 0; k < groups[gi].length; k++) {
        var id = groups[gi][k];
        if (seen[id]) return 'Một lá không thể dùng hai lần';
        var idx = findCard(p.hand, id);
        if (idx < 0) return 'Lá không có trong tay';
        seen[id] = true;
        cards.push(p.hand[idx]);
      }
      if (!isMeld(cards)) return 'Bộ đã chọn không hợp lệ';
      built.push(cards);
    }
    built.forEach(function (cards) {
      cards.forEach(function (c) { p.hand.splice(findCard(p.hand, c.id), 1); });
      p.laid.push(cards);
    });
    if (canWin(p.hand)) return winNow(g, seat);
    return null;
  }

  // Gửi bài: đưa một lá rác từ tay vào phỏm đã hạ của người khác (nối hợp lệ).
  // target: ghế có phỏm; gi: chỉ số phỏm trong p.laid của người đó.
  function sendCard(g, seat, id, target, gi) {
    if (g.over) return 'Ván đã kết thúc';
    if (g.phase !== 'discard') return 'Gửi bài sau khi bốc hoặc ăn';
    if (seat !== g.turn) return 'Chưa đến lượt bạn';
    var p = g.players[seat];
    if (!p.laid.length) return 'Phải hạ phỏm trước khi gửi bài';
    if (target === seat) return 'Chỉ gửi bài vào phỏm của người khác';
    var tp = g.players[target];
    if (!tp || !tp.laid[gi]) return 'Phỏm không tồn tại';
    var idx = findCard(p.hand, id);
    if (idx < 0) return 'Lá không có trong tay';
    var card = p.hand[idx];
    if (!isMeld(tp.laid[gi].concat([card]))) return 'Lá này không nối được phỏm đó';
    p.hand.splice(idx, 1);
    tp.laid[gi].push(card);
    if (canWin(p.hand)) return winNow(g, seat);
    return null;
  }

  // Ù khi ăn cả bộ của người khác để hoàn tất tay: người đánh bộ đó là ù đền.
  // Ăn lá đơn rồi ù thì không tính ù đền.
  function declareWin(g, seat) {
    if (g.over) return 'Ván đã kết thúc';
    if (seat !== g.turn) return 'Chưa đến lượt bạn';
    if (g.phase !== 'draw' && g.phase !== 'discard') return 'Không thể ù lúc này';
    var p = g.players[seat];
    if (!canWin(p.hand)) return 'Tay bài chưa xếp đủ phỏm';
    return winNow(g, seat);
  }

  function endByRounds(g) { return finish(g, { type: 'hetvong' }); }
  function endByExhaust(g) { return finish(g, { type: 'hetbai' }); }

  // Tính kết quả. Ù: người ù nhận từ tất cả người còn lại (sổ tính). Không ù: xếp theo điểm rác.
  function finish(g, info) {
    g.over = true;
    var res = { type: info.type, winner: info.winner === undefined ? null : info.winner, ranks: {}, uden: null, lines: [] };
    if (info.type === 'uden') res.uden = info.payer;
    if (info.type === 'u' || info.type === 'uden') {
      res.ranks[info.winner] = 'u';
      res.lines.push(g.players[info.winner].name + (info.type === 'uden' ? ' ù đền' : ' ù'));
    } else {
      // Không ù: điểm rác từng người
      var scored = g.players.map(function (p) {
        var bm = bestMelds(p.hand);
        var hasMeld = p.laid.length > 0 || bm.melds.length > 0;
        var total = bm.deadPts;
        return { seat: p.seat, points: total, moc: !hasMeld, lastTurn: g.discard.length ? 0 : 0 };
      });
      // Móm (không có phỏm nào) thì cháy
      var contenders = scored.filter(function (x) { return !x.moc; }).sort(function (a, b) {
        if (a.points !== b.points) return a.points - b.points;
        return a.seat - b.seat;
      });
      var labels = ['nhat', 'nhi', 'ba', 'bet'];
      contenders.forEach(function (x, i) { res.ranks[x.seat] = labels[i] || 'bet'; });
      scored.filter(function (x) { return x.moc; }).forEach(function (x) { res.ranks[x.seat] = 'chay'; });
      res.winner = contenders.length ? contenders[0].seat : null;
      res.points = scored.reduce(function (o, x) { o[x.seat] = x.points; return o; }, {});
      res.lines.push(info.type === 'hetvong' ? 'Hết 4 vòng, không ai ù' : 'Hết bài trong bộ, không ai ù');
    }
    g.result = res;
    return null;
  }

  // Bot đơn giản: ăn nếu được, không thì bốc; đánh lá rác có điểm cao nhất.
  function botTurn(g) {
    var seat = g.turn, p = g.players[seat];
    if (g.over) return;
    if (g.phase === 'draw') {
      var ate = false;
      if (g.groupOpen && seat === nextSeat(g, g.groupOpen.by)) { eatGroup(g, seat); ate = true; }
      if (!ate && g.discard.length && seat === nextSeat(g, g.lastDiscardSeat)) {
        var top = g.discard[g.discard.length - 1];
        var hand = p.hand;
        for (var i = 0; i < hand.length && !ate; i++) for (var j = i + 1; j < hand.length && !ate; j++) {
          if (isMeld([top, hand[i], hand[j]])) { eat(g, seat, [hand[i].id, hand[j].id]); ate = true; }
        }
      }
      if (!ate) draw(g, seat);
      if (g.over) return;
    }
    if (g.phase === 'discard') {
      if (canWin(p.hand)) { winNow(g, seat); return; }
      var bm = bestMelds(p.hand);
      if (bm.melds.length) { lay(g, seat, bm.melds.map(function (m) { return m.map(function (c) { return c.id; }); })); if (g.over) return; }
      bm = bestMelds(p.hand);
      var pick = bm.dead.length ? bm.dead[bm.dead.length - 1] : p.hand[p.hand.length - 1];
      discard(g, seat, pick.id);
    }
  }

  var api = {
    SUITS: SUITS, RANKS: RANKS, makeDeck: makeDeck, pts: pts, label: label,
    shuffle: shuffle, cryptoRng: cryptoRng, isMeld: isMeld, bestMelds: bestMelds, canWin: canWin,
    newGame: newGame, eat: eat, eatGroup: eatGroup, draw: draw, discard: discard, discardMeld: discardMeld, declareWin: declareWin, lay: lay, sendCard: sendCard,
    botTurn: botTurn, nextSeat: nextSeat, roundNo: roundNo
  };
  Phom = api;
})(typeof self !== 'undefined' ? self : this);

var TL = (function () {
var RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
var SUITS = ['♣', '♦', '♥', '♠'];
var NAMES = ['Bạn', 'An', 'Bình', 'Chi'];
var PLACE = ['Nhất', 'Nhì', 'Ba', 'Bét'];
var TYPE_LABEL = { single: 'lá lẻ', pair: 'đôi', triple: 'ba lá', quad: 'tứ quý', seq: 'sảnh', pairseq: 'đôi thông' };

var SUIT_RANK = [1, 2, 3, 0]; // chỉ số chất gốc: 0 ♣ tép, 1 ♦ rô, 2 ♥ cơ, 3 ♠ bích. Thứ tự tăng dần: bích < tép < rô < cơ
function str(c) { return c.r * 4 + SUIT_RANK[c.s]; }
function isRed(c) { return c.s === 1 || c.s === 2; }
function cardName(c) { return RANKS[c.r] + SUITS[c.s]; }
function shuffle(a) {
  for (var i = a.length - 1; i > 0; i--) { var j = Phom.cryptoRng(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function makeDeck() {
  var d = [], id = 0;
  for (var r = 0; r < 13; r++) for (var s = 0; s < 4; s++) d.push({ r: r, s: s, id: id++ });
  return d;
}

function detect(cards) {
  var n = cards.length;
  if (!n) return null;
  var sorted = cards.slice().sort(function (a, b) { return str(a) - str(b); });
  var byR = {};
  sorted.forEach(function (c) { (byR[c.r] = byR[c.r] || []).push(c); });
  var ranks = Object.keys(byR).map(Number).sort(function (a, b) { return a - b; });
  var top = str(sorted[n - 1]);
  if (ranks.length === 1) {
    var t = { 1: 'single', 2: 'pair', 3: 'triple', 4: 'quad' }[n];
    return t ? { type: t, len: n, top: top, cards: sorted } : null;
  }
  for (var i = 1; i < ranks.length; i++) if (ranks[i] !== ranks[i - 1] + 1) return null;
  if (ranks[ranks.length - 1] === 12) return null;
  if (n === ranks.length) return n >= 3 ? { type: 'seq', len: n, top: top, cards: sorted } : null;
  var allPairs = ranks.every(function (r) { return byR[r].length === 2; });
  if (allPairs && ranks.length >= 3) return { type: 'pairseq', len: ranks.length, top: top, cards: sorted };
  return null;
}

function isHeoCombo(c) {
  return (c.type === 'single' || c.type === 'pair') && c.cards.every(function (x) { return x.r === 12; });
}
function isChatHeo(c, t) {
  if (!t || !isHeoCombo(t)) return false;
  if (c.type === 'quad') return true;
  if (c.type === 'pairseq') return c.len >= 4 || (c.len >= 3 && t.type === 'single');
  return false;
}
function beats(c, t) {
  if (!t) return true;
  if (isChatHeo(c, t)) return true;
  return c.type === t.type && c.len === t.len && c.top > t.top;
}

function newGame(mode, names) {
  var deck = shuffle(makeDeck());
  var N = (names && names.length) || 4;
  var players = [];
  for (var i = 0; i < N; i++) players.push({ seat: i, name: (names && names[i]) || ('Ghế ' + (i + 1)), bot: i > 0, hand: [], out: false, place: 0 });
  var per = Math.floor(52 / N);
  for (var k = 0; k < per * N; k++) players[k % N].hand.push(deck[k]);
  players.forEach(function (p) { p.hand.sort(function (a, b) { return str(a) - str(b); }); });
  var starter = 0;
  players.forEach(function (p) {
    if (p.hand.some(function (c) { return c.r === 0 && c.s === 3; })) starter = p.seat;
  });
  var g = { players: players, turn: starter, top: null, passed: {}, first: true, finished: [], cuts: [], over: false, mode: mode || 'het' };
  // Thắng trắng: chia bài có tứ quý 2 thì thắng ngay, ván kết thúc trước khi ai đánh
  players.forEach(function (p) {
    if (p.hand.filter(function (c) { return c.r === 12; }).length === 4) {
      g.trang = p.seat; g.over = true; g.finished = [p.seat]; g.turn = null; g.top = null; p.place = 1;
    }
  });
  return g;
}

function nextActive(gm, seat) {
  var N = gm.players.length;
  for (var i = 1; i <= N; i++) { var s = (seat + i) % N; if (!gm.players[s].out) return s; }
  return seat;
}
function nextTurn(gm, seat) {
  var N = gm.players.length;
  for (var i = 1; i <= N; i++) {
    var s = (seat + i) % N, p = gm.players[s];
    if (p.out || gm.passed[s]) continue;
    if (gm.top && s === gm.top.seat) continue;
    return s;
  }
  return seat;
}
function advance(gm, seat) {
  var active = gm.players.filter(function (p) { return !p.out; });
  if (gm.mode === 'dem' && gm.finished.length >= 1) {
    var base = gm.finished.length;
    active.slice().sort(function (a, b) { return a.hand.length - b.hand.length; }).forEach(function (p, i) {
      p.place = base + i + 1;
      gm.finished.push(p.seat);
    });
    gm.over = true; gm.top = null; gm.turn = null;
    return;
  }
  if (gm.finished.length >= gm.players.length - 1) {
    var last = active[0];
    if (last) { last.place = gm.players.length; gm.finished.push(last.seat); }
    gm.over = true; gm.top = null; gm.turn = null;
    return;
  }
  if (gm.top) {
    var others = active.filter(function (p) { return p.seat !== gm.top.seat; });
    if (others.every(function (p) { return gm.passed[p.seat]; })) {
      var leader = gm.players[gm.top.seat].out ? nextActive(gm, gm.top.seat) : gm.top.seat;
      gm.top = null; gm.passed = {}; gm.turn = leader;
      return;
    }
  }
  gm.turn = nextTurn(gm, seat);
}

function play(gm, seat, ids) {
  if (gm.over) return 'Ván đã kết thúc.';
  if (gm.turn !== seat) return 'Chưa đến lượt bạn.';
  var p = gm.players[seat];
  var cards = p.hand.filter(function (c) { return ids.indexOf(c.id) >= 0; });
  if (!cards.length || cards.length !== ids.length) return 'Lá bài không hợp lệ.';
  var c = detect(cards);
  if (!c) return 'Đó không phải bộ hợp lệ.';
  if (gm.first && !cards.some(function (x) { return x.r === 0 && x.s === 3; })) return 'Ván đầu phải có 3 bích ♠.';
  if (!beats(c, gm.top ? gm.top.combo : null)) return 'Bộ này không đè được bàn.';
  if (gm.top && gm.top.seat !== seat && isChatHeo(c, gm.top.combo)) {
    gm.cuts.push({ cutter: seat, victim: gm.top.seat, cards: gm.top.combo.cards.slice() });
  }
  p.hand = p.hand.filter(function (x) { return ids.indexOf(x.id) < 0; });
  gm.first = false;
  gm.top = { combo: c, seat: seat };
  if (!p.hand.length) { p.out = true; p.place = gm.finished.length + 1; gm.finished.push(seat); }
  advance(gm, seat);
  return null;
}

function pass(gm, seat) {
  if (gm.over) return 'Ván đã kết thúc.';
  if (gm.turn !== seat) return 'Chưa đến lượt bạn.';
  if (!gm.top) return 'Bạn mở bàn nên không được bỏ lượt.';
  gm.passed[seat] = true;
  advance(gm, seat);
  return null;
}

function candidates(hand, top, first) {
  var out = [], byR = {};
  hand.forEach(function (c) { (byR[c.r] = byR[c.r] || []).push(c); });
  function add(cards) {
    var c = detect(cards);
    if (!c || !beats(c, top)) return;
    if (first && !cards.some(function (x) { return x.r === 0 && x.s === 3; })) return;
    out.push(c);
  }
  hand.forEach(function (c) { add([c]); });
  Object.keys(byR).forEach(function (r) {
    var cs = byR[r];
    for (var k = 2; k <= cs.length; k++) add(cs.slice(0, k));
  });
  for (var s = 0; s <= 11; s++) {
    for (var e = s + 2; e <= 11; e++) {
      var ok = true;
      for (var r = s; r <= e; r++) if (!byR[r]) { ok = false; break; }
      if (!ok) break;
      var base = [];
      for (r = s; r < e; r++) base.push(byR[r][0]);
      byR[e].forEach(function (tc) { add(base.concat([tc])); });
      var pb = [], pok = true;
      for (r = s; r < e; r++) {
        if (byR[r].length < 2) { pok = false; break; }
        pb.push(byR[r][0], byR[r][1]);
      }
      if (pok && byR[e].length >= 2) {
        var tcs = byR[e];
        for (var i = 0; i < tcs.length; i++) for (var j = i + 1; j < tcs.length; j++) add(pb.concat([tcs[i], tcs[j]]));
      }
    }
  }
  out.sort(function (a, b) {
    if (!top) return a.len !== b.len ? a.len - b.len : a.top - b.top;
    var ca = (a.type === top.type && a.len === top.len) ? 0 : 1;
    var cb = (b.type === top.type && b.len === top.len) ? 0 : 1;
    return ca !== cb ? ca - cb : a.top - b.top;
  });
  return out;
}

function botMove(gm, seat) {
  var cands = candidates(gm.players[seat].hand, gm.top ? gm.top.combo : null, gm.first);
  if (!cands.length) return null;
  return cands[0].cards.map(function (c) { return c.id; });
}

function settle(gm, rates) {
  var nets = {}, lines = [], winner = gm.finished[0];
  gm.players.forEach(function (p) { nets[p.seat] = 0; });
  if (gm.trang !== undefined && gm.trang !== null) {
    gm.players.forEach(function (p) {
      if (p.seat === gm.trang) return;
      nets[p.seat] -= rates.trang; nets[gm.trang] += rates.trang;
      lines.push(p.name + ' trả ' + gm.players[gm.trang].name + ' ' + rates.trang + 'k (thắng trắng)');
    });
    return { nets: nets, lines: lines, winner: gm.trang };
  }
  gm.players.forEach(function (p) {
    if (p.seat === winner || !p.hand.length) return;
    var amt = p.hand.length * rates.la;
    nets[p.seat] -= amt; nets[winner] += amt;
    lines.push(p.name + ' còn ' + p.hand.length + ' lá, trả ' + gm.players[winner].name + ' ' + amt + 'k');
  });
  gm.cuts.forEach(function (ct) {
    var amt = 0;
    ct.cards.forEach(function (c) { amt += isRed(c) ? rates.heodo : rates.heoden; });
    nets[ct.victim] -= amt; nets[ct.cutter] += amt;
    lines.push(gm.players[ct.cutter].name + ' chặt ' + ct.cards.map(cardName).join(' ') + ' của ' + gm.players[ct.victim].name + ': ' + amt + 'k');
  });
  return { nets: nets, lines: lines, winner: winner };
}

return { newGame: newGame, play: play, pass: pass, botMove: botMove, candidates: candidates, settle: settle, detect: detect, beats: beats, RANKS: RANKS, SUITS: SUITS, isRed: isRed, cardName: cardName, TYPE_LABEL: TYPE_LABEL, PLACE: PLACE };
})();
module.exports = { Phom: Phom, TL: TL };
