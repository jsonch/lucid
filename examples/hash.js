// The extern module `hashes` of hash.lcd. A CommonJS module: the export is
// a factory taking the node's name and returning the functions, so the
// state below is this node's. Integers arrive as numbers (decimal strings
// past 2^53), records as objects, vectors as arrays; results go back the
// same way.
module.exports = function (node) {
  const noted = new Set();
  return {
    mix(x, y) { return ((x * 31) ^ y) >>> 0; },
    swap(p) { return { a: p.b, b: p.a }; },
    sum(xs) { return xs.reduce((s, x) => s + x, 0); },
    halves(v) { const n = BigInt(v); return [Number(n >> 32n), Number(n & 0xffffffffn)]; },
    seen(x) { const was = noted.has(x); noted.add(x); return was; },
  };
};
