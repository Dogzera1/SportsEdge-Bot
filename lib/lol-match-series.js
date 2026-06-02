'use strict';
/**
 * lol-match-series.js — convert a per-game win prob into a best-of-N series win prob.
 * Side-neutralized: `p` is P(team wins ONE game) with the blue/red advantage averaged
 * out (in a series both teams play both sides), so games are treated as i.i.d. with
 * constant p and P(series) is the binomial "first to ⌈bestOf/2⌉ wins". Display-only.
 */

function _binom(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return r;
}

// P(team wins a best-of-`bestOf` series) given per-game win prob `p`.
// bestOf 1 -> p; 3 -> p²(3−2p); 5 -> p³(6p²−15p+10); general odd N via negative binomial.
function seriesProb(p, bestOf) {
  const n = Math.max(1, Math.floor(Number(bestOf) || 1));
  if (n <= 1) return p;
  const need = Math.ceil(n / 2);
  let sum = 0;
  for (let k = 0; k < need; k++) {
    sum += _binom(need - 1 + k, k) * Math.pow(p, need) * Math.pow(1 - p, k);
  }
  return Math.max(0, Math.min(1, sum));
}

module.exports = { seriesProb };
