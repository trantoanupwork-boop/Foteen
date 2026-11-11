// Chia bài công bằng có thể kiểm chứng (commit–reveal).
// Máy chủ: sinh secret 256-bit ngẫu nhiên, công bố commit = SHA-256(secret) khi chia bài,
// xáo bài bằng Fisher–Yates với bộ sinh số HMAC-SHA256 (counter mode) khóa bằng secret.
// Sau ván: tiết lộ secret để người chơi kiểm tra SHA-256(secret) = commit và chạy lại được đúng bộ bài đã chia.
const crypto = require('crypto');

function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// rng(n) trả về số nguyên đều trong [0, n) (loại bỏ thiên lệch bằng rejection sampling)
function makeFairRng(secret) {
  let ctr = 0, buf = Buffer.alloc(0), off = 0;
  const next32 = () => {
    if (off + 4 > buf.length) {
      buf = crypto.createHmac('sha256', secret).update(String(ctr++)).digest();
      off = 0;
    }
    const v = buf.readUInt32BE(off); off += 4; return v;
  };
  return function (n) {
    const max = 0x100000000 - (0x100000000 % n);
    let x;
    do { x = next32(); } while (x >= max);
    return x % n;
  };
}

function newFair() {
  const secret = crypto.randomBytes(32);
  return { secret, commit: sha256hex(secret), gameId: crypto.randomBytes(6).toString('hex'), reveal: null };
}

module.exports = { makeFairRng, newFair, sha256hex };
