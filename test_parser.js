/**
 * test_parser.js — Testa o parser de odds OddsPapi v4 e o matching de times
 * Usa payload real capturado da API (sem rede necessária)
 */

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Payload real capturado da OddsPapi v4 (LCK — tournamentId=2454)
const payload = [
  {
    "fixtureId": "id1800245470264392",
    "participant1Id": 340968, "participant2Id": 587561,
    "sportId": 18, "tournamentId": 2454,
    "startTime": "2026-04-02T08:00:00.000Z",
    "bookmakerOdds": {
      "1xbet": {
        "bookmakerIsActive": true,
        "bookmakerFixtureId": "316247084",
        "fixturePath": "https://1xbet.com/line/esport-league-of-legends/1721744-e/316247084-dplus-kia-ns-redforce",
        "markets": {
          "183": { "outcomes": { "183": { "players": { "0": { "active": true, "price": 1.31 } } } }, "bookmakerMarketId": "1" },
          "185": { "outcomes": { "185": { "players": { "0": { "active": true, "price": 3.375 } } } }, "bookmakerMarketId": "1" }
        }
      }
    }
  },
  {
    "fixtureId": "id1800245470264394",
    "participant1Id": 240610, "participant2Id": 240620,
    "sportId": 18, "tournamentId": 2454,
    "startTime": "2026-04-02T10:00:00.000Z",
    "bookmakerOdds": {
      "1xbet": {
        "bookmakerIsActive": true,
        "bookmakerFixtureId": "316249552",
        "fixturePath": "https://1xbet.com/line/esport-league-of-legends/1721744-e/316249552-drx-dn-soopers",
        "markets": {
          "183": { "outcomes": { "183": { "players": { "0": { "active": true, "price": 2.307 } } } }, "bookmakerMarketId": "1" },
          "185": { "outcomes": { "185": { "players": { "0": { "active": true, "price": 1.6 } } } }, "bookmakerMarketId": "1" }
        }
      }
    }
  },
  {
    "fixtureId": "id1800245470264424",
    "participant1Id": 240610, "participant2Id": 340968,
    "sportId": 18, "tournamentId": 2454,
    "startTime": "2026-04-04T10:00:00.000Z",
    "bookmakerOdds": {
      "1xbet": {
        "bookmakerIsActive": true,
        "bookmakerFixtureId": "316249556",
        "fixturePath": "https://1xbet.com/line/esport-league-of-legends/1721744-e/316249556-drx-dplus-kia",
        "markets": {
          "183": { "outcomes": { "183": { "players": { "0": { "active": true, "price": 3.47 } } } }, "bookmakerMarketId": "1" },
          "185": { "outcomes": { "185": { "players": { "0": { "active": true, "price": 1.296 } } } }, "bookmakerMarketId": "1" }
        }
      }
    }
  }
];

// ── Parser idêntico ao server.js ──
function extractPrice(outcome) {
  if (!outcome) return null;
  const p = parseFloat(outcome.price);
  if (!isNaN(p) && p > 1) return p;
  const players = outcome.players || {};
  for (const pd of Object.values(players)) {
    const pp = parseFloat(pd?.price);
    if (!isNaN(pp) && pp > 1) return pp;
  }
  return null;
}

const oddsCache = {};

for (const f of payload) {
  if (!f.bookmakerOdds) continue;
  const bkData = f.bookmakerOdds['1xbet'] || f.bookmakerOdds['1xBet'] || Object.values(f.bookmakerOdds)[0];
  if (!bkData || !bkData.bookmakerIsActive) continue;

  // Extrai nomes do fixturePath (idêntico ao server.js)
  let p1Name = '', p2Name = '', combinedSlug = '';
  const fixturePath = bkData.fixturePath || '';
  if (fixturePath) {
    const lastSeg = fixturePath.split('/').pop() || '';
    const bkFid = bkData.bookmakerFixtureId || '';
    const teamsSlug = bkFid
      ? lastSeg.replace(new RegExp(`^${bkFid}-`), '')
      : lastSeg.replace(/^\d+-/, '');
    if (teamsSlug) {
      combinedSlug = teamsSlug;
      const parts = teamsSlug.split('-');
      if (parts.length >= 2) {
        const mid = Math.ceil(parts.length / 2);
        p1Name = parts.slice(0, mid).join('-');
        p2Name = parts.slice(mid).join('-');
      }
    }
  }

  // Extrai odds via marketId (menor ID = t1, maior = t2)
  const markets = bkData.markets || {};
  const validMarkets = Object.entries(markets)
    .map(([mid, mData]) => {
      const outcomes = Object.values(mData.outcomes || {});
      if (outcomes.length !== 1) return null;
      const price = extractPrice(outcomes[0]);
      if (!price) return null;
      return { marketId: parseInt(mid) || 0, price };
    })
    .filter(Boolean)
    .sort((a, b) => a.marketId - b.marketId);

  if (validMarkets.length < 2) continue;

  const key = `esports_${f.fixtureId}`;
  oddsCache[key] = {
    t1: validMarkets[0].price.toFixed(2),
    t2: validMarkets[1].price.toFixed(2),
    bookmaker: '1xBet',
    t1Name: p1Name,
    t2Name: p2Name,
    combinedSlug,
    fixtureId: f.fixtureId
  };
}

console.log('\n════════════════════════════════════════');
console.log('  TEST 1 — Parser de Fixtures OddsPapi');
console.log('════════════════════════════════════════');
const entries = Object.entries(oddsCache);
console.log(`✅ ${entries.length}/${payload.length} fixtures parseados\n`);
for (const [k, v] of entries) {
  const margin = ((1/parseFloat(v.t1) + 1/parseFloat(v.t2) - 1) * 100).toFixed(1);
  const fp1 = (1/parseFloat(v.t1) / (1/parseFloat(v.t1)+1/parseFloat(v.t2)) * 100).toFixed(1);
  const fp2 = (1/parseFloat(v.t2) / (1/parseFloat(v.t1)+1/parseFloat(v.t2)) * 100).toFixed(1);
  console.log(`  ${v.t1Name} vs ${v.t2Name}`);
  console.log(`  Odds: ${v.t1} / ${v.t2} | Margem 1xBet: ${margin}% | De-juiced: ${fp1}% / ${fp2}%`);
  console.log(`  Slug: ${v.combinedSlug}\n`);
}

// ── Matching idêntico ao server.js ──
const TEAM_ALIASES = {
  'geng': ['gen', 'gengaming'], 't1': ['skt', 'sktelecom'],
  'bnkfearx': ['fearx', 'bnk'], 'dplus': ['dkia', 'dkplus', 'dplusgaming'],
  'drx': ['dragonx'], 'dnsoopers': ['dns', 'soopers', 'dnsoopers'],
  'nsredforce': ['ns', 'nsred', 'redforce']
};

function findOdds(sport, t1, t2) {
  const nt1 = norm(t1), nt2 = norm(t2);
  const aliases = (n) => {
    const a = [n];
    for (const [key, vals] of Object.entries(TEAM_ALIASES)) {
      if (n.includes(key) || key.includes(n)) { a.push(key, ...vals); }
      for (const v of vals) { if (n.includes(v) || v.includes(n)) { a.push(key, ...vals); } }
    }
    return [...new Set(a)];
  };
  const a1 = aliases(nt1), a2 = aliases(nt2);

  for (const [, val] of Object.entries(oddsCache)) {
    if (!val.combinedSlug && (!val.t1Name || !val.t2Name)) continue;
    const slug = norm(val.combinedSlug || `${val.t1Name}-${val.t2Name}`);
    const vt1 = norm(val.t1Name), vt2 = norm(val.t2Name);

    const matchFwd = a1.some(a => slug.includes(a) || vt1.includes(a) || a.includes(vt1)) &&
                     a2.some(a => slug.includes(a) || vt2.includes(a) || a.includes(vt2));
    const matchInv = a2.some(a => slug.includes(a) || vt1.includes(a) || a.includes(vt1)) &&
                     a1.some(a => slug.includes(a) || vt2.includes(a) || a.includes(vt2));

    if (matchFwd) return { t1: val.t1, t2: val.t2, bookmaker: val.bookmaker, matched: `${vt1} vs ${vt2}` };
    if (matchInv) return { t1: val.t2, t2: val.t1, bookmaker: val.bookmaker, matched: `${vt1} vs ${vt2} (invertido)` };
  }
  return null;
}

console.log('════════════════════════════════════════');
console.log('  TEST 2 — Matching de Times');
console.log('════════════════════════════════════════');
const matchTests = [
  ['DRX', 'DN Soopers'],
  ['Dplus KIA', 'NS RedForce'],
  ['DRX', 'Dplus KIA'],
  ['T1', 'Gen.G'],          // não deve encontrar (não está no payload)
  ['drx', 'dnsoopers'],     // lowercase normalizado
];

for (const [a, b] of matchTests) {
  const result = findOdds('esports', a, b);
  if (result) {
    console.log(`✅ "${a}" vs "${b}" → t1=${result.t1} | t2=${result.t2} [${result.matched}]`);
  } else {
    console.log(`❌ "${a}" vs "${b}" → SEM MATCH (odds não encontradas)`);
  }
}

// ── TEST 3: Cálculo de EV simulado ──
console.log('\n════════════════════════════════════════');
console.log('  TEST 3 — Simulação de EV (como a IA veria)');
console.log('════════════════════════════════════════');

const scenarios = [
  { match: 'DRX vs DN Soopers', t1: 'DRX', t2: 'DN Soopers', estP1: 55 },  // IA estima 55% para DRX
  { match: 'Dplus KIA vs NS RedForce', t1: 'Dplus KIA', t2: 'NS RedForce', estP1: 80 }, // IA estima 80%
];

for (const s of scenarios) {
  const o = findOdds('esports', s.t1, s.t2);
  if (!o) { console.log(`❌ ${s.match} — sem odds`); continue; }
  const odd1 = parseFloat(o.t1), odd2 = parseFloat(o.t2);
  const implP1 = 1/odd1 / (1/odd1 + 1/odd2);
  const implP2 = 1 - implP1;
  const estP1 = s.estP1 / 100;
  const estP2 = 1 - estP1;
  const ev1 = ((estP1 * odd1) - 1) * 100;
  const ev2 = ((estP2 * odd2) - 1) * 100;
  const edge1 = (estP1 - implP1) * 100;
  const edge2 = (estP2 - implP2) * 100;
  const evThreshold = 2;
  const pinnacleMargin = 5;
  const hasTip1 = ev1 >= evThreshold && Math.abs(edge1) >= pinnacleMargin;
  const hasTip2 = ev2 >= evThreshold && Math.abs(edge2) >= pinnacleMargin;

  console.log(`\n  ${s.match}`);
  console.log(`  Odds 1xBet: ${o.t1} / ${o.t2}`);
  console.log(`  Prob implícita (de-juiced): ${(implP1*100).toFixed(1)}% / ${(implP2*100).toFixed(1)}%`);
  console.log(`  Estimativa IA: ${(estP1*100).toFixed(0)}% / ${(estP2*100).toFixed(0)}%`);
  console.log(`  Edge: ${edge1.toFixed(1)}pp / ${edge2.toFixed(1)}pp`);
  console.log(`  EV: ${ev1.toFixed(2)}% / ${ev2.toFixed(2)}%`);
  if (hasTip1) console.log(`  ✅ TIP: ${s.t1} @ ${o.t1} | EV: +${ev1.toFixed(2)}%`);
  else if (hasTip2) console.log(`  ✅ TIP: ${s.t2} @ ${o.t2} | EV: +${ev2.toFixed(2)}%`);
  else console.log(`  ❌ SEM EDGE (threshold: EV≥${evThreshold}% E edge≥${pinnacleMargin}pp)`);
}

console.log('\n════════════════════════════════════════');
console.log('  RESULTADO FINAL');
console.log('════════════════════════════════════════');
console.log(`Parser: ${entries.length === payload.length ? '✅ OK' : '❌ FALHOU'}`);
console.log(`Matching direto: ${findOdds('esports','DRX','DN Soopers') ? '✅ OK' : '❌ FALHOU'}`);
console.log(`Matching normalizado: ${findOdds('esports','drx','dnsoopers') ? '✅ OK' : '❌ FALHOU'}`);
console.log(`Sem match correto: ${!findOdds('esports','T1','Gen.G') ? '✅ OK (não encontrou o que não existe)' : '❌ FALHOU (falso positivo)'}`);
