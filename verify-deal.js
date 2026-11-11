// Kiểm chứng ván đấu: node verify-deal.js <commit> <reveal> <N> [tên1 tên2 ...]
// In ra 13 lá của từng ghế (ghế theo thứ tự đã chia) và xác nhận SHA-256(reveal) khớp commit.
const { TL } = require('./engine.js');
const { makeFairRng, sha256hex } = require('./fair.js');
const [commit, reveal, nStr, ...names] = process.argv.slice(2);
if (!commit || !reveal || !nStr) { console.log('Dùng: node verify-deal.js <commit> <reveal> <N> [tên...]'); process.exit(1); }
const secret = Buffer.from(reveal, 'hex');
const ok = sha256hex(secret) === commit;
console.log('Khớp commit:', ok ? 'CÓ' : 'KHÔNG');
if (!ok) process.exit(2);
const N = +nStr;
const list = names.length ? names : Array.from({ length: N }, (_, i) => 'Ghế ' + (i + 1));
const g = TL.newGame('het', list, undefined, makeFairRng(secret));
g.players.forEach(p => console.log(p.name + ':', p.hand.map(c => TL.cardName(c)).join(' ')));
