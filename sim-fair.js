// Mô phỏng chia bài thật: node sim-fair.js <số ván> <số người>
// Dùng đúng TL.newGame + makeFairRng (đường chạy thật của máy chủ), mỗi ván một secret mới.
const { TL } = require('./engine.js');
const { makeFairRng, newFair } = require('./fair.js');
const RUNS = +process.argv[2] || 1000000, N = +process.argv[3] || 4;
const names = Array.from({ length: N }, (_, i) => 'P' + i);
const DEALT = N * 13;
const seatCard = new Float64Array(N * 52);  // ván có lá id nằm ở ghế si
const seat2 = new Float64Array(N * 5);      // ván ghế si có k quân 2 (k = 0..4)
const seatHas2 = new Float64Array(N);       // ván ghế si có >= 1 quân 2
const seatQuad = new Float64Array(N);       // ván ghế si có tứ quý (4 lá cùng số)
let dup = 0, lost = 0, badSize = 0, badId = 0;
let prev = null, n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
const t0 = Date.now();
for (let t = 0; t < RUNS; t++) {
  const f = newFair();
  const g = TL.newGame('het', names, undefined, makeFairRng(f.secret));
  const seen = new Uint8Array(52); let total = 0;
  g.players.forEach((p, si) => {
    if (p.hand.length !== 13) badSize++;
    const byR = new Uint8Array(13); let twos = 0;
    p.hand.forEach(c => {
      const id = c.r * 4 + c.s;
      if (!(id >= 0 && id < 52)) { badId++; return; }
      if (seen[id]) dup++;
      seen[id] = 1; total++;
      seatCard[si * 52 + id]++;
      byR[c.r]++;
      if (c.r === 12) twos++;
    });
    if (twos > 0) seatHas2[si]++;
    if (byR.some(x => x === 4)) seatQuad[si]++;
    seat2[si * 5 + Math.min(twos, 4)]++;
    if (si === 0) {                       // tương quan giữa hai ván liên tiếp (ghế 0)
      if (prev !== null) { n++; sx += prev; sy += twos; sxy += prev * twos; sxx += prev * prev; syy += twos * twos; }
      prev = twos;
    }
  });
  if (total !== DEALT) lost++;
}
// ---- thống kê
const C = (a, b) => { let x = 1; for (let i = 0; i < b; i++) x = x * (a - i) / (i + 1); return x; };
const pHas2 = 1 - C(48, 13) / C(52, 13);
const pQuad = 13 * C(48, 9) / C(52, 13);
const pTwo = k => C(4, k) * C(48, 13 - k) / C(52, 13);
const z = (o, e, p) => (o - e) / Math.sqrt(e * (1 - p));
// lá x ghế: mỗi lá rơi vào ghế với xác suất 1/4 (13/52) ở mọi N
const eCell = RUNS / 4;
let chiCell = 0;
for (let i = 0; i < N * 52; i++) chiCell += (seatCard[i] - eCell) ** 2 / eCell;
const dfCell = 52 * (N === 4 ? 3 : N);
const zCell = (chiCell - dfCell) / Math.sqrt(2 * dfCell);
let worstZ2 = 0, worstZq = 0, worstZh = 0;
const perSeat = [];
for (let si = 0; si < N; si++) {
  let chi = 0;
  for (let k = 0; k <= 4; k++) { const e = RUNS * pTwo(k); if (e > 0) chi += (seat2[si * 5 + k] - e) ** 2 / e; }
  const zh = z(seatHas2[si], RUNS * pHas2, pHas2), zq = z(seatQuad[si], RUNS * pQuad, pQuad);
  worstZh = Math.max(worstZh, Math.abs(zh)); worstZq = Math.max(worstZq, Math.abs(zq));
  perSeat.push({ ghe: si, chi2_quan2_df4: +chi.toFixed(2), tyle_co_quan2: +(seatHas2[si] / RUNS).toFixed(5), z_co_quan2: +zh.toFixed(2),
    tyle_tu_quy: +(seatQuad[si] / RUNS).toFixed(6), z_tu_quy: +zq.toFixed(2) });
}
const rho = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
console.log(JSON.stringify({
  so_van: RUNS, so_nguoi: N, thoi_gian_s: +((Date.now() - t0) / 1000).toFixed(1),
  trung_la: dup, mat_la: lost, sai_so_luong_la: badSize, id_khong_hop_le: badId,
  chi2_la_theo_ghe: +chiCell.toFixed(1), bac_tu_do: dfCell, z_chi2_la_theo_ghe: +zCell.toFixed(2),
  ghe: perSeat,
  max_abs_z_co_quan2: +worstZh.toFixed(2), max_abs_z_tu_quy: +worstZq.toFixed(2),
  tuong_quan_lag1_quan2_ghe0: +rho.toFixed(5), so_cap_lag1: n
}, null, 1));
