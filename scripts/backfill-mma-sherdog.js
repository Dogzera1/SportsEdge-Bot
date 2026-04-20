#!/usr/bin/env node
// Backfill MMA regional fighters via Sherdog fight history — parseia tabela de lutas
// da página do fighter e insere rows em match_results (game='mma') pra que o trained
// model / elo map tenham dados desses fighters.
//
// Uso:
//   node scripts/backfill-mma-sherdog.js --urls="https://sherdog.com/fighter/Gina-Carano-44,..."
//   node scripts/backfill-mma-sherdog.js --url="https://sherdog.com/fighter/Gina-Carano-44"
//
// IMPORTANTE: Sherdog fightfinder search NÃO funciona confiável (retorna fighters aleatórios).
// Tapology search bloqueia scraping (Cloudflare 403). Por isso este script exige URLs diretas
// Sherdog (fighter slug), que são estáveis e parseáveis.
//
// Fluxo recomendado:
//   1. Rodar mma-coverage-report → ver quais fighters faltam
//   2. Achar URLs Sherdog manualmente (search no Google "site:sherdog.com fighter NAME")
//   3. Passar URLs pra este script via --urls
//
// Idempotente: dedup por match_id determinístico.
// Rate-limit: 2s entre fighters.

const path = require('path');
const Database = require('better-sqlite3');
const https = require('https');

const argv = require('minimist')(process.argv.slice(2));
const verbose = !!argv.verbose;
const dryRun = !!argv['dry-run'];
const serverUrl = argv.server || process.env.MMA_REPORT_SERVER || '';

function log(...a) { if (verbose) console.error('[backfill-mma]', ...a); }

function httpGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, opts).then(resolve, reject);
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function fetchJson(url) {
  const http = url.startsWith('https') ? https : require('http');
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 15000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, '')).trim().replace(/\s+/g, ' ');
}

async function findSherdogProfile(name) {
  const url = `https://www.sherdog.com/stats/fightfinder?SearchTxt=${encodeURIComponent(name.trim())}`;
  const r = await httpGet(url).catch(() => null);
  if (!r || r.status !== 200 || !r.body) return null;
  // Pega primeiro link de fighter
  const m = r.body.match(/href="(\/fighter\/[^"]+)"/i);
  if (!m) return null;
  return `https://www.sherdog.com${m[1]}`;
}

// Parseia tabela de Fight History do Sherdog
// Retorna array de { result: 'win'|'loss', opponent, event, date, method }
function parseFightHistory(html, fighterName) {
  if (!html) return [];
  const fights = [];
  // Sherdog tem 2 tabelas principais: "Pro" e "Amateur". A tabela Pro vem primeiro.
  // Busca todas as rows <tr class="..."> que contêm <span class="final_result">
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const row = m[1];
    if (!/class=["']final_result/i.test(row)) continue;
    const resultM = row.match(/<span[^>]*class=["']final_result[^"']*?\s+(win|loss|draw|nc)["']?[^>]*>([^<]+)<\/span>/i);
    if (!resultM) continue;
    const result = resultM[1].toLowerCase();
    // Opponent: <a href="/fighter/..."><span ...>Name</span></a>
    const oppM = row.match(/<a[^>]*href=["']\/fighter\/[^"']+["'][^>]*>\s*(?:<span[^>]*>)?([^<]+?)(?:<\/span>)?\s*<\/a>/i);
    const opponent = oppM ? stripTags(oppM[1]) : null;
    // Date: <span class="sub_line">YYYY-MM-DD</span> ou Month Day, Year
    const dateM = row.match(/<span[^>]*class=["']sub_line["'][^>]*>\s*([A-Z][a-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})\s*<\/span>/i);
    const dateRaw = dateM ? dateM[1] : null;
    // Event: <a href="/events/..."><span ...>Event Name</span></a>
    const eventM = row.match(/<a[^>]*href=["']\/events\/[^"']+["'][^>]*>\s*(?:<span[^>]*>)?([^<]+?)(?:<\/span>)?\s*<\/a>/i);
    const event = eventM ? stripTags(eventM[1]) : null;
    // Parse date → ISO
    let dateIso = null;
    if (dateRaw) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) dateIso = dateRaw;
      else {
        const d = new Date(dateRaw);
        if (!isNaN(d.getTime())) dateIso = d.toISOString().slice(0, 10);
      }
    }
    if (!opponent || !dateIso) continue;
    fights.push({ result, opponent, event: event || 'MMA', date: dateIso });
  }
  return fights;
}

function nameFromSherdogUrl(url) {
  const m = String(url).match(/\/fighter\/([^/?#]+)/);
  if (!m) return null;
  return m[1].replace(/-\d+$/, '').replace(/-/g, ' ');
}

async function processUrls(db, urls) {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO match_results
      (match_id, game, team1, team2, winner, league, resolved_at)
    VALUES (?, 'mma', ?, ?, ?, ?, ?)
  `);
  const stats = { fighters: 0, rows_inserted: 0, failed: [], parsed: [] };
  for (const url of urls) {
    stats.fighters++;
    const name = nameFromSherdogUrl(url);
    if (!name) { stats.failed.push({ url, reason: 'cant parse name from URL' }); continue; }
    log(`[${stats.fighters}/${urls.length}] ${name} (${url})`);
    const r = await httpGet(url).catch(() => null);
    if (!r || r.status !== 200) { stats.failed.push({ name, reason: `http ${r?.status}` }); continue; }
    const fights = parseFightHistory(r.body, name);
    if (!fights.length) { stats.failed.push({ name, reason: 'no fight history parsed' }); continue; }
    log(`  → ${fights.length} fights parsed`);
    stats.parsed.push({ name, fights: fights.length });
    let inserted = 0;
    for (const f of fights) {
      if (f.result !== 'win' && f.result !== 'loss') continue;
      const winner = f.result === 'win' ? name : f.opponent;
      const resolvedAt = `${f.date}T00:00:00.000Z`;
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const [a, b] = [norm(name), norm(f.opponent)].sort();
      const matchId = `sherdog_mma_${a}_${b}_${f.date}`;
      if (dryRun) { inserted++; continue; }
      try {
        const info = insertStmt.run(matchId, name, f.opponent, winner, f.event, resolvedAt);
        if (info.changes > 0) inserted++;
      } catch (e) { log(`  ! insert failed: ${e.message}`); }
    }
    stats.rows_inserted += inserted;
    await new Promise(r => setTimeout(r, 2000));
  }
  return stats;
}

async function processNames(db, names) {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO match_results
      (match_id, game, team1, team2, winner, league, resolved_at)
    VALUES (?, 'mma', ?, ?, ?, ?, ?)
  `);

  const stats = { fighters: 0, rows_inserted: 0, failed: [], no_profile: [] };
  for (const name of names) {
    stats.fighters++;
    log(`[${stats.fighters}/${names.length}] ${name}`);
    const profile = await findSherdogProfile(name);
    if (!profile) { stats.no_profile.push(name); continue; }
    const r = await httpGet(profile).catch(() => null);
    if (!r || r.status !== 200) { stats.failed.push({ name, reason: `http ${r?.status}` }); continue; }
    const fights = parseFightHistory(r.body, name);
    if (!fights.length) { stats.failed.push({ name, reason: 'no fight history parsed' }); continue; }
    log(`  → ${fights.length} fights parsed`);
    for (const f of fights) {
      if (f.result !== 'win' && f.result !== 'loss') continue;
      const [t1, t2] = [name, f.opponent];
      const winner = f.result === 'win' ? name : f.opponent;
      const resolvedAt = `${f.date}T00:00:00.000Z`;
      // match_id determinístico pra dedup: sherdog_<norm(a)>_<norm(b)>_<date> (ordenado)
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const [a, b] = [norm(t1), norm(t2)].sort();
      const matchId = `sherdog_mma_${a}_${b}_${f.date}`;
      if (dryRun) { stats.rows_inserted++; continue; }
      try {
        const info = insertStmt.run(matchId, t1, t2, winner, f.event, resolvedAt);
        if (info.changes > 0) stats.rows_inserted++;
      } catch (e) {
        log(`  ! insert failed: ${e.message}`);
      }
    }
    await new Promise(r => setTimeout(r, 2000)); // rate-limit
  }
  return stats;
}

(async () => {
  const urls = argv.url ? [String(argv.url)]
    : argv.urls ? String(argv.urls).split(',').map(s => s.trim()).filter(Boolean)
    : [];
  if (!urls.length) {
    console.error('Especifique --url=<sherdog_url> ou --urls="url1,url2,..."');
    console.error('Sherdog search quebrado; use URLs diretas (slug).');
    process.exit(1);
  }

  const dbPath = path.join(__dirname, '..', process.env.DB_PATH || 'sportsedge.db');
  const db = new Database(dbPath);
  console.error(`[backfill-mma] db=${dbPath} | urls=${urls.length} | dry_run=${dryRun}`);

  const tab = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='match_results'`).get();
  if (!tab) { console.error('match_results table não existe'); process.exit(1); }

  const stats = await processUrls(db, urls);
  console.log(JSON.stringify(stats, null, 2));
})();
