// Regressão: pre-settle de série NBA (best-of-7) por name-match ignorando o
// ESPN match_id per-game. Bug recorrente (2026-05-09, 05-12, 06-09).
//
// Caso 2026-06-09: tips ML shadow dos games 4/5 das finais NY×SA settladas
// LOSS contra o game 3 (resolveu 29min APÓS a emissão das tips → derrotou o
// guard forward-only). /admin/run-settle + runSettleSweep casavam por nome+
// janela; o fix exige match_id ESPN exato (basket_espn_/espn_basket_), espelho
// do guard _isAuthoritativeEspnId de /basket-result.
const Database = require('better-sqlite3');

// Replica a DECISÃO do settler: dado um tip basket + estado de match_results,
// retorna o match_results row que o settler usaria (ou null = pending).
function pickSettleRow(db, tip, { winLo, winHi }) {
  const _norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const isAuthBasketEspn = tip.sport === 'basket'
    && /^(basket_espn_|espn_basket_)/.test(String(tip.match_id || ''));
  if (isAuthBasketEspn) {
    const bid = String(tip.match_id);
    const alt = bid.startsWith('basket_espn_')
      ? bid.replace(/^basket_espn_/, 'espn_basket_')
      : bid.replace(/^espn_basket_/, 'basket_espn_');
    return db.prepare(`
      SELECT match_id, winner FROM match_results
      WHERE match_id IN (?, ?) AND game = 'basket'
        AND winner IS NOT NULL AND winner != '' LIMIT 1
    `).get(bid, alt) || null;
  }
  // Tentativa 1: match_id EXATO (hardening exact-id-first; mirror run-settle/sweep).
  const game = tip.game || (tip.sport === 'basket' ? 'basket' : tip.sport);
  const exact = db.prepare(`
    SELECT match_id, winner FROM match_results
    WHERE match_id = ? AND game = ? AND winner IS NOT NULL AND winner != '' LIMIT 1
  `).get(String(tip.match_id || ''), game);
  if (exact) return exact;
  // Tentativa 2: name + janela (ignora match_id) — fallback, vulnerável em série.
  const n1 = _norm(tip.participant1), n2 = _norm(tip.participant2);
  return db.prepare(`
    SELECT match_id, winner FROM match_results
    WHERE game = ? AND winner IS NOT NULL AND winner != ''
      AND resolved_at >= ? AND resolved_at <= ?
      AND ((lower(replace(replace(replace(team1,' ',''),'-',''),'.','')) = ? AND lower(replace(replace(replace(team2,' ',''),'-',''),'.','')) = ?)
        OR (lower(replace(replace(replace(team1,' ',''),'-',''),'.','')) = ? AND lower(replace(replace(replace(team2,' ',''),'-',''),'.','')) = ?))
    ORDER BY resolved_at DESC LIMIT 1
  `).get(game, winLo, winHi, n1, n2, n2, n1) || null;
}

function seedDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE match_results (
    match_id TEXT, game TEXT, team1 TEXT, team2 TEXT,
    winner TEXT, final_score TEXT, resolved_at TEXT, league TEXT)`);
  // Game 3 jogado (SAS venceu); games 4/5 ainda NÃO em match_results.
  db.prepare(`INSERT INTO match_results VALUES (?,?,?,?,?,?,?,?)`).run(
    'espn_basket_401859965', 'basket', 'New York Knicks', 'San Antonio Spurs',
    'San Antonio Spurs', '111-115', '2026-06-09 00:30', 'nba');
  return db;
}

const WIN = { winLo: '2026-06-05 00:00:00', winHi: '2026-06-15 00:00:00' };
const tipGame4 = {
  sport: 'basket', match_id: 'basket_espn_401859966',
  participant1: 'New York Knicks', participant2: 'San Antonio Spurs',
  tip_participant: 'New York Knicks', sent_at: '2026-06-09 00:01:17',
};

module.exports = function (t) {
  // 1) O bug: name-match (sem guard) casa o game 3 para a tip do game 4.
  t.test('name-match (legacy) casa game ANTERIOR da série (reproduz o bug)', () => {
    const db = seedDb();
    const legacyTip = { ...tipGame4, match_id: 'basket_pin_999' }; // pin → path name
    const row = pickSettleRow(db, legacyTip, WIN);
    t.assert(row && row.match_id === 'espn_basket_401859965',
      `esperava casar game 3 via nome, veio ${row && row.match_id}`);
    db.close();
  });

  // 2) O fix: ESPN id autoritativo NÃO casa por nome → pending até o game jogar.
  t.test('ESPN id autoritativo: game futuro sem id exato fica PENDING', () => {
    const db = seedDb();
    const row = pickSettleRow(db, tipGame4, WIN);
    t.assert(row === null, `esperava null (pending), veio ${row && row.match_id}`);
    db.close();
  });

  // 3) Quando o game 4 realmente joga, settla pelo jogo CERTO.
  t.test('ESPN id autoritativo: após o game jogar, settla pelo id exato', () => {
    const db = seedDb();
    db.prepare(`INSERT INTO match_results VALUES (?,?,?,?,?,?,?,?)`).run(
      'espn_basket_401859966', 'basket', 'New York Knicks', 'San Antonio Spurs',
      'New York Knicks', '120-110', '2026-06-11 00:30', 'nba');
    const row = pickSettleRow(db, tipGame4, WIN);
    t.assert(row && row.match_id === 'espn_basket_401859966' && row.winner === 'New York Knicks',
      `esperava casar o game 4 exato, veio ${row && row.match_id}/${row && row.winner}`);
    db.close();
  });

  // 4) Guard cobre o prefixo invertido (tips: basket_espn_; match_results: espn_basket_).
  t.test('guard resolve prefixo invertido basket_espn_ ↔ espn_basket_', () => {
    const db = seedDb();
    db.prepare(`INSERT INTO match_results VALUES (?,?,?,?,?,?,?,?)`).run(
      'espn_basket_401859966', 'basket', 'New York Knicks', 'San Antonio Spurs',
      'New York Knicks', '120-110', '2026-06-11 00:30', 'nba');
    // tip grava basket_espn_; match_results grava espn_basket_ → deve casar.
    const row = pickSettleRow(db, tipGame4, WIN);
    t.assert(row && row.winner === 'New York Knicks', 'prefixo invertido não resolveu');
    db.close();
  });

  // 5) Guard é scoped: tip não-basket não é afetada (continua via path legacy).
  t.test('guard scoped: sport != basket não entra no path exact-id', () => {
    const db = seedDb();
    const nonBasket = { ...tipGame4, sport: 'football', match_id: 'basket_espn_401859966' };
    const isAuth = nonBasket.sport === 'basket'
      && /^(basket_espn_|espn_basket_)/.test(nonBasket.match_id);
    t.assert(isAuth === false, 'football não deveria ativar o guard basket');
    db.close();
  });

  // 6) Hardening exact-id-first (lol/dota2/football/tennis): o match_id exato vence
  //    o name-match quando o jogo da PRÓPRIA tip já está resolvido em match_results,
  //    mesmo havendo outro jogo dos mesmos times mais "próximo"/recente na janela.
  t.test('exact-id-first: settla pelo próprio match_id, não por outro jogo dos mesmos times', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE match_results (
      match_id TEXT, game TEXT, team1 TEXT, team2 TEXT,
      winner TEXT, final_score TEXT, resolved_at TEXT, league TEXT)`);
    // Jogo da tip (Gen.G venceu) + OUTRO jogo dos mesmos times mais recente (T1 venceu).
    db.prepare(`INSERT INTO match_results VALUES (?,?,?,?,?,?,?,?)`).run(
      'lol_OWN', 'lol', 'Gen.G', 'T1', 'Gen.G', '1-0', '2026-06-08 12:00', 'LCK');
    db.prepare(`INSERT INTO match_results VALUES (?,?,?,?,?,?,?,?)`).run(
      'lol_OTHER', 'lol', 'Gen.G', 'T1', 'T1', '0-1', '2026-06-10 12:00', 'LCK');
    const tip = {
      sport: 'lol', game: 'lol', match_id: 'lol_OWN',
      participant1: 'Gen.G', participant2: 'T1', tip_participant: 'Gen.G',
      sent_at: '2026-06-08 11:00:00',
    };
    const row = pickSettleRow(db, tip, { winLo: '2026-06-05 00:00:00', winHi: '2026-06-15 00:00:00' });
    t.assert(row && row.match_id === 'lol_OWN' && row.winner === 'Gen.G',
      `esperava settlar pelo lol_OWN (Gen.G), veio ${row && row.match_id}/${row && row.winner}`);
    db.close();
  });

  // 7) Forward-guard football (/football-result + runSettleSweep): tip de uma partida
  //    NÃO casa com partida ANTERIOR dos mesmos times (caso real #3386 Santos×Coritiba:
  //    tip de 05-17 settlava win contra o jogo de 05-13). Janela passou de -4d → -30min.
  t.test('forward-guard football: não settla contra partida anterior dos mesmos times', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE match_results (
      match_id TEXT, game TEXT, team1 TEXT, team2 TEXT,
      winner TEXT, final_score TEXT, resolved_at TEXT, league TEXT)`);
    // Só a partida ANTERIOR (05-13, Santos venceu, mando invertido) está ingerida;
    // a partida da tip (05-17) ainda não foi sincronizada no momento do settle.
    db.prepare(`INSERT INTO match_results VALUES (?,?,?,?,?,?,?,?)`).run(
      'sofa_OLD', 'football', 'Coritiba', 'Santos', 'Santos', '0-1', '2026-05-13 22:30:00', 'BR');
    const sentAt = '2026-05-17 14:05:34';
    const fwd = (lo) => db.prepare(`
      SELECT match_id, winner FROM match_results
      WHERE game = 'football'
        AND ((lower(team1) LIKE lower(?) AND lower(team2) LIKE lower(?))
          OR (lower(team1) LIKE lower(?) AND lower(team2) LIKE lower(?)))
        AND resolved_at BETWEEN datetime(?, ?) AND datetime(?, '+6 days')
      ORDER BY resolved_at DESC LIMIT 1
    `).get('%Santos%', '%Coritiba%', '%Coritiba%', '%Santos%', sentAt, lo, sentAt) || null;
    // Janela ANTIGA -4d casava o jogo de 05-13 (o bug → win indevido).
    const old = fwd('-4 days');
    t.assert(old && old.match_id === 'sofa_OLD', 'sanity: janela -4d reproduz o bug (casa 05-13)');
    // Forward-guard -30min EXCLUI o jogo de 05-13 → pending (correto; settla depois no jogo certo).
    const guarded = fwd('-30 minutes');
    t.assert(guarded === null, `forward-guard deveria deixar pending, veio ${guarded && guarded.match_id}`);
    db.close();
  });

  // 8) Forward-guard football: settla pela partida CERTA quando ela já está ingerida.
  t.test('forward-guard football: settla pela partida da tip quando ingerida', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE match_results (
      match_id TEXT, game TEXT, team1 TEXT, team2 TEXT,
      winner TEXT, final_score TEXT, resolved_at TEXT, league TEXT)`);
    db.prepare(`INSERT INTO match_results VALUES (?,?,?,?,?,?,?,?)`).run(
      'sofa_OLD', 'football', 'Coritiba', 'Santos', 'Santos', '0-1', '2026-05-13 22:30:00', 'BR');
    db.prepare(`INSERT INTO match_results VALUES (?,?,?,?,?,?,?,?)`).run(
      'sofa_OWN', 'football', 'Santos', 'Coritiba', 'Coritiba', '0-1', '2026-05-17 14:00:00', 'BR');
    const sentAt = '2026-05-17 14:05:34';
    const guarded = db.prepare(`
      SELECT match_id, winner FROM match_results
      WHERE game = 'football'
        AND ((lower(team1) LIKE lower(?) AND lower(team2) LIKE lower(?))
          OR (lower(team1) LIKE lower(?) AND lower(team2) LIKE lower(?)))
        AND resolved_at BETWEEN datetime(?, '-30 minutes') AND datetime(?, '+6 days')
      ORDER BY resolved_at DESC LIMIT 1
    `).get('%Santos%', '%Coritiba%', '%Coritiba%', '%Santos%', sentAt, sentAt) || null;
    t.assert(guarded && guarded.match_id === 'sofa_OWN' && guarded.winner === 'Coritiba',
      `esperava casar a partida da tip (Coritiba), veio ${guarded && guarded.match_id}/${guarded && guarded.winner}`);
    db.close();
  });
};
