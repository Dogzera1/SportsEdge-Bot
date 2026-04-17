// Recalcula EV matemático e aplica TODOS os novos gates server-side
// pra cada tip flaggeada. Mostra verdict.
const fs = require('fs');

const MAX_EV = {
  esports: 25, tennis: 25, mma: 20, darts: 20, snooker: 20,
  cs: 25, valorant: 25, tabletennis: 30, football: 15,
};

// IDs flaggeadas
const TARGETS = [
  { id: 272, sport: 'esports' },
  { id: 283, sport: 'esports' },
  { id: 281, sport: 'esports' },
  { id: 280, sport: 'cs' },
  { id: 282, sport: 'tennis' },
  { id: 284, sport: 'tennis' },
  { id: 228, sport: 'tennis' },
  { id: 260, sport: 'darts' },
  { id: 194, sport: 'mma' },
];

// Carrega todos arquivos pend_*.json e indexa por id
const byId = {};
for (const sp of ['esports', 'tennis', 'mma', 'darts', 'cs', 'snooker', 'valorant', 'tabletennis', 'football']) {
  try {
    const arr = JSON.parse(fs.readFileSync(`pend_${sp}.json`, 'utf8'));
    for (const t of arr) byId[t.id] = t;
  } catch (_) {}
}

console.log('ID  | Sport   | Pick                      | Odd  | P_orig | EV_calc | EV_rep | Gate verdict');
console.log('----+---------+---------------------------+------+--------+---------+--------+---------------');

for (const { id, sport } of TARGETS) {
  const t = byId[id];
  if (!t) { console.log(`#${id} NOT FOUND`); continue; }
  const odd = Number(t.odds);
  const p = Number(t.model_p_pick);
  const evCalc = (p * odd - 1) * 100;
  const evRep = Number(t.ev);
  const conf = String(t.confidence || '').toUpperCase();

  const reasons = [];
  // Gate 1: MAX_EV por sport
  if (evCalc > (MAX_EV[sport] ?? 25)) reasons.push(`ev>${MAX_EV[sport]}%cap`);
  // Gate 2: conf BAIXA + EV>15
  if (conf === 'BAIXA' && evCalc > 15) reasons.push('baixa+ev>15');

  const verdict = reasons.length ? `🚫 BLOCK (${reasons.join(', ')})` : '✅ PASS';

  console.log(`#${String(id).padEnd(3)} | ${sport.padEnd(7)} | ${String(t.tip_participant).slice(0,25).padEnd(25)} | ${String(odd).padEnd(4)} | ${(p*100).toFixed(1).padStart(5)}% | ${evCalc.toFixed(1).padStart(6)}% | ${evRep.toFixed(1).padStart(5)}% | ${verdict}`);
}
