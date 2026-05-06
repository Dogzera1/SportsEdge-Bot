/**
 * test_v4.js — Testa a API OddsPapi v4 com o endpoint real usado pelo sistema
 * Uso: node test_v4.js
 */
const https = require('https');
require('dotenv').config();

const apiKey = process.env.ODDS_API_KEY
  || process.env.ODDSPAPI_KEY
  || process.env.ODDS_PAPI_KEY
  || process.env.ESPORTS_ODDS_KEY;

if (!apiKey) {
  console.log('❌ Nenhuma chave OddsPapi encontrada. Configure ODDS_API_KEY no .env');
  process.exit(1);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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

(async () => {
  console.log('\n════════════════════════════════════════════');
  console.log('  TEST 1 — Busca de Torneios Ativos (sportId=18)');
  console.log('════════════════════════════════════════════');

  const tidRes = await httpGet(`https://api.oddspapi.io/v4/tournaments?sportId=18&apiKey=${apiKey}`);
  console.log(`Status: ${tidRes.status}`);

  if (tidRes.status !== 200) {
    console.log('❌ Falhou:', tidRes.body.slice(0, 300));
    process.exit(1);
  }

  let tids = [];
  try {
    const raw = JSON.parse(tidRes.body);
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw.data) ? raw.data : []);
    tids = list
      .filter(t => (t.futureFixtures || 0) + (t.upcomingFixtures || 0) + (t.liveFixtures || 0) > 0)
      .map(t => t.tournamentId || t.id)
      .filter(Boolean);
    console.log(`✅ ${tids.length} torneios ativos encontrados`);
    if (list.length > 0) {
      console.log('Exemplo de torneio:', JSON.stringify(list[0], null, 2).slice(0, 300));
    }
  } catch(e) {
    console.log('❌ Parse error:', e.message);
    process.exit(1);
  }

  if (!tids.length) {
    console.log('⚠️  Nenhum torneio ativo — usando fallback LOL_ACTIVE_TIDS');
    tids = [2450, 2452, 2454]; // LCS, LEC, LCK
  }

  console.log('\n════════════════════════════════════════════');
  console.log('  TEST 2 — Busca de Odds por Torneio (endpoint real do sistema)');
  console.log('════════════════════════════════════════════');

  // Usa o primeiro lote (até 3 IDs) como o sistema faria
  const batch = tids.slice(0, 3);
  console.log(`Buscando odds para torneios: [${batch.join(',')}]`);

  const oddsRes = await httpGet(
    `https://api.oddspapi.io/v4/odds-by-tournaments?bookmaker=1xbet&tournamentIds=${batch.join(',')}&oddsFormat=decimal&apiKey=${apiKey}`
  );
  console.log(`Status: ${oddsRes.status}`);

  if (oddsRes.status !== 200) {
    console.log('❌ Falhou:', oddsRes.body.slice(0, 300));
    process.exit(1);
  }

  let fixtures = [];
  try {
    const raw = JSON.parse(oddsRes.body);
    fixtures = Array.isArray(raw) ? raw : (Array.isArray(raw.data) ? raw.data : []);
    console.log(`✅ ${fixtures.length} fixtures recebidos`);
  } catch(e) {
    console.log('❌ Parse error:', e.message);
    process.exit(1);
  }

  // ── Parse idêntico ao server.js ──
  const oddsCache = {};
  let parsed = 0;

  for (const f of fixtures) {
    if (!f.bookmakerOdds) continue;
    const bkData = f.bookmakerOdds['1xbet'] || f.bookmakerOdds['1xBet'] || Object.values(f.bookmakerOdds)[0];
    if (!bkData || !bkData.bookmakerIsActive) continue;

    let p1Name = f.participant1Name || '', p2Name = f.participant2Name || '', combinedSlug = '';
    if (!p1Name || !p2Name) {
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
    }
    if (!combinedSlug && p1Name && p2Name) combinedSlug = `${p1Name}-${p2Name}`;
    if (!combinedSlug && !p1Name) continue;

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

    const margin = ((1/validMarkets[0].price + 1/validMarkets[1].price - 1) * 100).toFixed(1);
    const fp1 = (1/validMarkets[0].price / (1/validMarkets[0].price + 1/validMarkets[1].price) * 100).toFixed(1);
    const fp2 = (1/validMarkets[1].price / (1/validMarkets[0].price + 1/validMarkets[1].price) * 100).toFixed(1);

    oddsCache[`esports_${f.fixtureId}`] = {
      t1: validMarkets[0].price.toFixed(2),
      t2: validMarkets[1].price.toFixed(2),
      t1Name: p1Name,
      t2Name: p2Name,
      combinedSlug,
      margin,
      fp1, fp2
    };
    parsed++;
  }

  console.log(`✅ ${parsed}/${fixtures.length} fixtures com odds válidas\n`);

  console.log('\n════════════════════════════════════════════');
  console.log('  TEST 3 — Odds Parseadas (amostra)');
  console.log('════════════════════════════════════════════');

  const sample = Object.values(oddsCache).slice(0, 8);
  if (!sample.length) {
    console.log('⚠️  Nenhuma odd parseada — pode não haver jogos neste lote hoje');
  }
  for (const v of sample) {
    console.log(`  ${v.t1Name} vs ${v.t2Name}`);
    console.log(`  Odds: ${v.t1} / ${v.t2} | Margem: ${v.margin}% | De-juiced: ${v.fp1}% / ${v.fp2}%`);
  }

  console.log('\n════════════════════════════════════════════');
  console.log('  RESULTADO FINAL');
  console.log('════════════════════════════════════════════');
  console.log(`Torneios ativos: ${tids.length > 0 ? `✅ ${tids.length} encontrados` : '❌ nenhum'}`);
  console.log(`Odds fetchadas: ${fixtures.length > 0 ? `✅ ${fixtures.length} fixtures` : '⚠️  0 fixtures (sem jogos hoje no lote?)'}`);
  console.log(`Odds parseadas: ${parsed > 0 ? `✅ ${parsed} com t1/t2 válidos` : '⚠️  0 parseadas'}`);
  console.log(`API key: ✅ válida (${apiKey.slice(0, 8)}...)`);
})();
