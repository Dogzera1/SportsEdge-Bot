const { buildWrTable, buildMatchupMatrix, buildSynergyMatrix, fitLogistic, sigmoid } = require('../lib/lol-draft-train');

const rows = [
  { gameid: 'g1', side: 'Blue', position: 'top', champion: 'Aatrox', result: 1, patch: '14.1' },
  { gameid: 'g1', side: 'Red',  position: 'top', champion: 'Darius', result: 0, patch: '14.1' },
  { gameid: 'g2', side: 'Blue', position: 'top', champion: 'Aatrox', result: 1, patch: '14.1' },
  { gameid: 'g2', side: 'Red',  position: 'top', champion: 'Darius', result: 0, patch: '14.1' },
];

module.exports = function (t) {
  t.test('buildWrTable counts wins/total per champion+role', () => {
    const wr = buildWrTable(rows);
    t.assert(wr['aatrox|top'].wins === 2 && wr['aatrox|top'].n === 2, 'aatrox 2/2');
    t.assert(wr['darius|top'].wins === 0 && wr['darius|top'].n === 2, 'darius 0/2');
  });
  t.test('buildMatchupMatrix records lane head-to-head (blue perspective)', () => {
    const m = buildMatchupMatrix(rows);
    const cell = m['top']['aatrox']['darius'];
    t.assert(cell.wins === 2 && cell.n === 2, `aatrox>darius top 2/2, got ${JSON.stringify(cell)}`);
  });
  t.test('buildSynergyMatrix records same-side pairs', () => {
    const r2 = [
      { gameid: 'x', side: 'Blue', position: 'top', champion: 'Ornn', result: 1, patch: '14.1' },
      { gameid: 'x', side: 'Blue', position: 'mid', champion: 'Orianna', result: 1, patch: '14.1' },
    ];
    const s = buildSynergyMatrix(r2);
    t.assert(s['orianna|ornn'].wins === 1 && s['orianna|ornn'].n === 1, 'sorted-key pair 1/1');
  });
  t.test('fitLogistic learns separable signal; sigmoid bounded', () => {
    t.assert(sigmoid(0) === 0.5, 'sigmoid(0)=0.5');
    t.assert(sigmoid(100) > 0.99 && sigmoid(-100) < 0.01, 'sigmoid bounds');
    const samples = [];
    for (let i = 0; i < 200; i++) {
      const pos = i % 2 === 0;
      samples.push({ x: [pos ? 1 : -1, 0, 0, 0], y: pos ? 1 : 0 });
    }
    const w = fitLogistic(samples, { epochs: 400, lr: 0.3, l2: 0.0001 });
    t.assert(w.length === 5, 'bias + 4 features');
    const pPos = sigmoid(w[0] + w[1] * 1);
    const pNeg = sigmoid(w[0] + w[1] * -1);
    t.assert(pPos > 0.8 && pNeg < 0.2, `learned: pPos=${pPos.toFixed(2)} pNeg=${pNeg.toFixed(2)}`);
  });
};
