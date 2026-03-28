/**
 * Seed histórico de tênis a partir dos CSVs do Jeff Sackmann
 * https://github.com/JeffSackmann/tennis_atp
 * https://github.com/JeffSackmann/tennis_wta
 *
 * Uso:
 *   1. Clone os repositórios ou baixe os CSVs desejados
 *   2. node scripts/seed-tennis.js --dir ./data/tennis_atp --years 2020,2021,2022,2023,2024
 *
 * Arquivos esperados (padrão Sackmann):
 *   atp_matches_2024.csv  ou  wta_matches_2024.csv
 *
 * Colunas usadas:
 *   tourney_date, tourney_name, surface, round,
 *   winner_name, winner_rank, winner_ioc,
 *   loser_name,  loser_rank,  loser_ioc,
 *   score, minutes
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');
const initDatabase = require('../lib/database');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v || true]; })
);

const DIR   = args.dir   || path.join(__dirname, '..', 'data', 'tennis');
const YEARS = args.years ? String(args.years).split(',').map(Number) : [2022, 2023, 2024];
const DRY   = args.dry   === true || args.dry === 'true';

if (!fs.existsSync(DIR)) {
  console.error(`❌ Diretório não encontrado: ${DIR}`);
  console.error('   Baixe os CSVs do Sackmann e passe --dir=<caminho>');
  process.exit(1);
}

const { db } = initDatabase();

// Garantir tabela de resultados
db.exec(`
  CREATE TABLE IF NOT EXISTS match_results (
    match_id TEXT,
    game TEXT,
    team1 TEXT,
    team2 TEXT,
    winner TEXT,
    final_score TEXT,
    league TEXT,
    resolved_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (match_id, game)
  );
  CREATE TABLE IF NOT EXISTS athletes (
    id TEXT PRIMARY KEY,
    sport TEXT NOT NULL,
    name TEXT NOT NULL,
    nickname TEXT,
    stats JSON,
    url TEXT,
    last_scraped TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mr_team1 ON match_results(team1);
  CREATE INDEX IF NOT EXISTS idx_mr_team2 ON match_results(team2);
  CREATE INDEX IF NOT EXISTS idx_athletes_tennis ON athletes(sport, name);
`);

const upsertResult = db.prepare(`
  INSERT OR REPLACE INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertAthlete = db.prepare(`
  INSERT INTO athletes (id, sport, name, stats, last_scraped)
  VALUES (?, 'tennis', ?, '{}', datetime('now'))
  ON CONFLICT(id) DO UPDATE SET last_scraped = datetime('now')
`);

function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    // Handle quoted fields with commas
    const fields = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    fields.push(cur.trim());
    return Object.fromEntries(headers.map((h, i) => [h, fields[i] || '']));
  });
}

function surfaceFromSackmann(s) {
  if (!s) return 'hard';
  const lower = s.toLowerCase();
  if (lower === 'clay') return 'clay';
  if (lower === 'grass') return 'grass';
  return 'hard'; // Hard, Carpet, etc.
}

function athleteId(name) {
  return 'tennis_p_' + String(name).toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
}

let totalInserted = 0;
let totalSkipped  = 0;
const athletesSeen = new Set();

const insertMany = db.transaction((rows) => {
  for (const row of rows) {
    upsertResult.run(
      row.match_id, row.surface,
      row.winner, row.loser,
      row.winner,
      row.score,
      row.tournament,
      row.date + 'T00:00:00Z'
    );
    totalInserted++;

    // Seed athletes
    if (!athletesSeen.has(row.winner)) {
      athletesSeen.add(row.winner);
      upsertAthlete.run(athleteId(row.winner), row.winner);
    }
    if (!athletesSeen.has(row.loser)) {
      athletesSeen.add(row.loser);
      upsertAthlete.run(athleteId(row.loser), row.loser);
    }
  }
});

function processFile(filePath, pattern) {
  if (!fs.existsSync(filePath)) return;

  console.log(`📂 Lendo ${pattern}...`);
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(text);
  console.log(`   ${rows.length} linhas lidas`);

  const batch = [];
  for (const row of rows) {
    if (!row.winner_name || !row.loser_name || !row.score) { totalSkipped++; continue; }
    if (!row.tourney_date || row.tourney_date.length < 8)  { totalSkipped++; continue; }

    const dateStr = `${row.tourney_date.slice(0,4)}-${row.tourney_date.slice(4,6)}-${row.tourney_date.slice(6,8)}`;
    const surface = surfaceFromSackmann(row.surface);
    const matchId = `sackmann_${row.tourney_id || row.tourney_name}_${row.round}_${athleteId(row.winner_name)}_${athleteId(row.loser_name)}`.slice(0, 120);

    batch.push({
      match_id: matchId, surface,
      winner: row.winner_name, loser: row.loser_name,
      score: row.score, tournament: row.tourney_name, date: dateStr
    });
  }

  if (!DRY) {
    insertMany(batch);
    console.log(`   ✅ ${batch.length} resultados inseridos`);
  } else {
    console.log(`   [DRY] ${batch.length} resultados seriam inseridos`);
  }
}

for (const year of YEARS) {
  for (const pattern of [
    `atp_matches_${year}.csv`,
    `wta_matches_${year}.csv`,
    `atp_matches_qual_chall_${year}.csv`,
    `wta_matches_qual_chall_${year}.csv`,
    `atp_matches_futures_${year}.csv`,
  ]) {
    const filePath = path.join(DIR, pattern);
    if (!fs.existsSync(filePath)) {
      // Only warn for main tour files; silently skip chall/futures if missing
      if (!pattern.includes('qual_chall') && !pattern.includes('futures')) {
        console.log(`⚠️  Não encontrado: ${pattern} — pulando`);
      }
      continue;
    }

    processFile(filePath, pattern);
  }
}

console.log(`\n📊 Seed concluído:`);
console.log(`   Inseridos:  ${totalInserted}`);
console.log(`   Pulados:    ${totalSkipped}`);
console.log(`   Atletas:    ${athletesSeen.size}`);

db.close();
