/**
 * sync-form.js — Sincroniza histórico de partidas (form + H2H) via PandaScore
 * Uso: node sync-form.js [--force]
 * --force : re-sincroniza mesmo partidas já gravadas
 */
require('dotenv').config({ override: true });
const initDatabase = require('./lib/database');
const { safeParse } = require('./lib/utils');
const https = require('https');

const PANDASCORE_TOKEN = process.env.PANDASCORE_TOKEN || '';
if (!PANDASCORE_TOKEN) {
  console.error('ERRO: PANDASCORE_TOKEN não configurado no .env');
  process.exit(1);
}

const forceResync = process.argv.includes('--force');
const db = initDatabase();
const stmts = db.stmts;

function httpGet(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const p = new URL(targetUrl);
    const req = https.request({
      hostname: p.hostname,
      path: p.pathname + p.search,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', ...headers }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
  const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cutoffEnd = new Date().toISOString().slice(0, 10);

  console.log(`Sincronizando partidas de ${cutoff} até ${cutoffEnd} (forceResync=${forceResync})`);

  const MAX_PAGES = 4;
  const PER_PAGE = 100;
  const allMatches = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.pandascore.co/lol/matches?filter[status]=finished&sort=-begin_at&per_page=${PER_PAGE}&page=${page}&range[begin_at]=${cutoff},${cutoffEnd}`;
    console.log(`  → Página ${page}...`);
    const r = await httpGet(url, headers).catch(e => { console.error('  Erro:', e.message); return null; });
    if (!r || r.status !== 200) { console.log(`  Status ${r?.status} — parando`); break; }
    const batch = safeParse(r.body, []);
    if (!Array.isArray(batch) || batch.length === 0) { console.log('  Sem mais resultados'); break; }
    allMatches.push(...batch);
    console.log(`  Página ${page}: ${batch.length} partidas (total: ${allMatches.length})`);
    if (batch.length < PER_PAGE) break;
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nTotal coletado: ${allMatches.length} partidas`);

  let inserted = 0, skipped = 0;
  for (const m of allMatches) {
    const psId = `ps_${m.id}`;
    if (!forceResync && stmts.isMatchSynced.get(psId)) { skipped++; continue; }

    const t1 = m.opponents?.[0]?.opponent;
    const t2 = m.opponents?.[1]?.opponent;
    const winnerName = m.winner?.name || null;

    if (!t1 || !t2) { stmts.markMatchSynced.run(psId, 'lol'); continue; }

    if (winnerName) {
      stmts.upsertMatchResult.run(psId, 'lol', t1.name, t2.name, winnerName, '', m.league?.name || '');
      inserted++;
    }
    stmts.markMatchSynced.run(psId, 'lol');
  }

  console.log(`\nConcluído: ${inserted} partidas inseridas/atualizadas, ${skipped} já existiam`);

  // Resumo do banco
  const total = db.prepare('SELECT COUNT(*) as n FROM match_results').get();
  const byLeague = db.prepare('SELECT league, COUNT(*) as n FROM match_results GROUP BY league ORDER BY n DESC LIMIT 15').all();
  console.log(`\nTotal no banco: ${total.n} partidas`);
  console.log('Por liga:');
  byLeague.forEach(r => console.log(`  ${r.league}: ${r.n}`));
}

main().catch(e => { console.error('Erro fatal:', e); process.exit(1); });
