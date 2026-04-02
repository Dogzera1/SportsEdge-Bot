/**
 * diag_odds.js — Diagnóstico completo do pipeline de odds
 * Testa: API key, endpoint, parsing, matching
 * Uso: node diag_odds.js
 */
require('dotenv').config({ override: true });
const https = require('https');

// Aceita múltiplos nomes de variável (igual ao server.js)
const API_KEY = process.env.ODDS_API_KEY
  || process.env.ODDSPAPI_KEY
  || process.env.ODDS_PAPI_KEY
  || process.env.ESPORTS_ODDS_KEY;

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

if (!API_KEY) {
  console.error('');
  console.error('❌ CHAVE DA ODDSPAPI NÃO ENCONTRADA!');
  console.error('');
  console.error('   Adicione ao seu .env uma das seguintes variáveis:');
  console.error('   ODDS_API_KEY=sua_chave_aqui');
  console.error('   ou ODDSPAPI_KEY=sua_chave_aqui');
  console.error('');
  console.error('   Variáveis encontradas no .env:');
  const defined = ['ODDS_API_KEY','ODDSPAPI_KEY','ODDS_PAPI_KEY','ESPORTS_ODDS_KEY','THE_ODDS_API_KEY','API_SPORTS_KEY']
    .map(k => `   ${k}: ${process.env[k] ? '✅ DEFINIDA' : '❌ ausente'}`);
  defined.forEach(l => console.error(l));
  process.exit(1);
}

console.log('✅ Chave OddsPapi detectada:', API_KEY.slice(0, 6) + '...' + API_KEY.slice(-3));

// Torneios ativos de LoL
const TIDS = [2450, 2452, 2454, 26590, 26698, 33814, 36997, 39009, 39985,
              45589, 45623, 45985, 46117, 46119, 47864, 50242, 50586];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function extractPrice(outcome) {
  if (!outcome) return null;
  const p = parseFloat(outcome.price);
  if (!isNaN(p) && p > 1) return p;
  const players = outcome.players || {};
  for (const playerData of Object.values(players)) {
    const pp = parseFloat(playerData?.price);
    if (!isNaN(pp) && pp > 1) return pp;
  }
  return null;
}

(async () => {
  const url = `https://api.oddspapi.io/v4/odds-by-tournaments?bookmaker=1xbet&tournamentIds=${TIDS.join(',')}&oddsFormat=decimal&apiKey=${API_KEY}`;
  console.log('\n🔍 Chamando API:', url.replace(API_KEY, API_KEY.slice(0,6)+'...'));

  let r;
  try {
    r = await httpGet(url);
  } catch(e) {
    console.error('❌ Erro de rede:', e.message);
    process.exit(1);
  }

  console.log('📡 Status HTTP:', r.status);
  console.log('📦 Primeiros 300 chars da resposta:');
  console.log(r.body.slice(0, 300));

  if (r.status !== 200) {
    console.error('❌ Status não-200. Verifique a chave API e o plano da OddsPapi.');
    process.exit(1);
  }

  let raw;
  try { raw = JSON.parse(r.body); }
  catch(e) { console.error('❌ Resposta não é JSON válido:', e.message); process.exit(1); }

  // Detecta estrutura
  let fixtures = [];
  if (Array.isArray(raw)) {
    if (raw.length > 0 && raw[0]?.fixtures) {
      console.log('\n📂 Estrutura: agrupada por torneio');
      fixtures = raw.flatMap(t => t.fixtures || []);
    } else {
      console.log('\n📋 Estrutura: array plano de fixtures');
      fixtures = raw;
    }
  } else if (Array.isArray(raw?.data)) {
    console.log('\n📋 Estrutura: { data: [...] }');
    fixtures = raw.data;
  } else {
    console.error('❌ Estrutura desconhecida:', JSON.stringify(raw).slice(0, 100));
    process.exit(1);
  }

  console.log(`\n🏆 Total de fixtures recebidos: ${fixtures.length}`);
  if (fixtures.length === 0) {
    console.warn('⚠️  Nenhum fixture retornado. Torneios sem odds disponíveis?');
    process.exit(0);
  }

  // Processa e mostra
  let count = 0;
  const cache = {};

  for (const f of fixtures) {
    if (!f.bookmakerOdds) continue;
    const bkData = f.bookmakerOdds['1xbet'] || f.bookmakerOdds['1xBet'] || Object.values(f.bookmakerOdds)[0];
    if (!bkData || !bkData.bookmakerIsActive) continue;

    const fixturePath = bkData.fixturePath || '';
    const lastSeg = fixturePath.split('/').pop() || '';
    const bkFid = bkData.bookmakerFixtureId || '';
    const teamsSlug = bkFid ? lastSeg.replace(new RegExp(`^${bkFid}-`), '') : lastSeg.replace(/^\d+-/, '');
    if (!teamsSlug) continue;

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

    const key = `esports_${f.fixtureId || norm(teamsSlug)}`;
    cache[key] = {
      t1: validMarkets[0].price.toFixed(2),
      t2: validMarkets[1].price.toFixed(2),
      combinedSlug: norm(teamsSlug),
      fixturePath,
    };
    count++;
  }

  console.log(`\n✅ Fixtures com odds parsadas: ${count}/${fixtures.length}`);
  console.log('\nAmostra (primeiros 5):');
  const sample = Object.values(cache).slice(0, 5);
  for (const v of sample) {
    console.log(`  slug: ${v.combinedSlug.padEnd(30)} | t1=${v.t1} | t2=${v.t2}`);
  }

  // Testa matching com nomes reais de times
  const testMatches = [
    ['Cloud9', 'Lyon Gaming'],
    ['Team Liquid', 'FlyQuest'],
    ['Sentinels', 'Disguised'],
    ['T1', 'Gen.G'],
    ['Faker', 'Gumayusi'],
  ];

  const anyMatch = (variants, slug) => [...variants].some(v => v.length >= 2 && slug.includes(v));
  const expand = n => new Set([n]);

  console.log('\n🔎 Teste de matching de nomes:');
  for (const [t1, t2] of testMatches) {
    const nt1 = norm(t1), nt2 = norm(t2);
    let found = null;
    for (const v of Object.values(cache)) {
      if (v.combinedSlug.includes(nt1) && v.combinedSlug.includes(nt2)) {
        found = v;
        break;
      }
    }
    console.log(`  ${t1} vs ${t2}: ${found ? `✅ ${found.t1} x ${found.t2}` : '❌ não encontrado'}`);
  }

  if (count === 0) {
    console.log('\n⚠️  Nenhuma odd parsada. Verifique se o bookmaker "1xbet" está disponível no seu plano.');
    console.log('   Bookmakers disponíveis nas fixtures:');
    const bks = new Set();
    fixtures.slice(0, 5).forEach(f => { if (f.bookmakerOdds) Object.keys(f.bookmakerOdds).forEach(b => bks.add(b)); });
    console.log('  ', [...bks].join(', '));
  }
})();
