'use strict';

/**
 * market-tips-shadow.js — logging estruturado de market tips detectadas (sem DM).
 *
 * Uso:
 *   const { logShadowTip, settleShadowTips, getShadowStats } = require('./market-tips-shadow');
 *
 *   logShadowTip(db, { sport, match, bestOf, tip, stake });
 *   settleShadowTips(db);  // cron: cruza com match_results
 *   getShadowStats(db, { sport, days }); // agregação pra report
 *
 * Dedup: mesmo (match_key, market, line, side) não é re-logado em <12h.
 * Settlement: pra match_winner/handicap, cruza winner de match_results.
 *   Totais/TB/Aces precisam de metadata adicional (final_score parsing).
 */

const { log } = require('./utils');

function _norm(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); }
// _normStrict: agressivo pra dedup. Tira espaço/hífen/dot/apóstrofo (chars que
// scanner pode ou não emitir per-cycle). NÃO tira acentos — SQLite não tem NFD,
// então strip JS-only causa mismatch JS↔DB. Acento variations são raros e tratados
// por _lastName em paths tennis-specific. Antes só removia espaço+hífen, faltava
// dot/apóstrofo → "N. Basilashvili" ≠ "NBasilashvili" gerando dupes.
function _normStrict(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-.']/g, '');
}
// Normaliza nome tennis tirando acentos + extraindo último token (apelido).
// Pinnacle usa "N. Basilashvili", Sackmann/ESPN usam "Nikoloz Basilashvili" —
// last-name é a única parte comum e suficiente pra disambiguate em 99% dos matches.
function _lastName(s) {
  const clean = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')                     // mantém letras/espaço/apóstrofos/hífen
    .replace(/\s+/g, ' ')
    .trim();
  const toks = clean.split(' ').filter(w => w.length >= 2); // descarta iniciais ("n.", "a")
  return toks.length ? toks[toks.length - 1] : clean;
}
// 2026-04-28: extrai inicial do firstName pra disambiguar Cerundolo F. vs J.M.,
// Auger-Aliassime vs Aliassime, Ferreira R. vs T. Quando lastName collide e
// ambos os nomes têm primeiro token ≥2 chars, comparamos inicial.
function _firstInitial(s) {
  const clean = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // "N. Basilashvili" → "n"; "Nikoloz Basilashvili" → "n"
  const first = clean.split(' ')[0] || '';
  return first.charAt(0) || '';
}
// Normaliza league: remove tier keywords + pontuação pra comparar "ATP Madrid" vs "Mutua Madrid Open"
function _normLeague(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(atp|wta|itf|challenger|masters|1000|500|250|grand slam|main draw|qualifying|qualif|open|cup|trophy|international)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// League overlap: true se ≥1 token significativo (≥4 chars) é comum entre os dois.
// "madrid" ↔ "madrid open" ✅; "madrid" ↔ "rome" ❌; "" ↔ x → false (força tiebreak normal).
function _leagueOverlap(a, b) {
  if (!a || !b) return false;
  const tA = a.split(' ').filter(w => w.length >= 4);
  const tB = new Set(b.split(' ').filter(w => w.length >= 4));
  return tA.some(w => tB.has(w));
}

function _matchKey(match) {
  const a = _norm(match.team1), b = _norm(match.team2);
  const t = match.time || match.start_time || '';
  return `${a}|${b}|${(t || '').slice(0, 10)}`;
}

/**
 * Parse esports final_score (formato "Bo3 2-1") com validação anti-kills.
 *
 * Sources como OpenDota populam final_score com RADIANT_SCORE-DIRE_SCORE (kills)
 * em vez de maps, causando rows tipo "Bo3 40-27". Essa função rejeita scores
 * que violam maxMaps = ceil(bestOf/2) por side, total ≤ bestOf.
 *
 * @returns {{ winnerMaps, loserMaps, bestOf } | null}
 */
function _parseEsportsMapScore(finalScore) {
  const s = String(finalScore || '');
  if (!s) return null;
  const boMatch = s.match(/\bBo(\d+)/i);
  const bestOf = boMatch ? parseInt(boMatch[1], 10) : null;
  const scoreMatch = s.match(/(\d+)\s*[-x]\s*(\d+)/);
  if (!scoreMatch) return null;
  const a = parseInt(scoreMatch[1], 10);
  const b = parseInt(scoreMatch[2], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  // Validação: se bestOf conhecido, scores devem caber no range de maps.
  // Bo-odd (Bo1/Bo3/Bo5): first-to-ceil(N/2), max=ceil(N/2).
  // Bo-even (Bo2): all games played, max=N (ex: Bo2 2-0 é válido).
  if (bestOf != null && bestOf > 0) {
    const maxPerSide = (bestOf % 2 === 0) ? bestOf : Math.ceil(bestOf / 2);
    const total = a + b;
    if (Math.max(a, b) > maxPerSide || total > bestOf || total < 1) return null;
  } else {
    // Sem Bo prefix, aceita apenas se ambos ≤ 3 (cobre Bo1-Bo5)
    if (a > 3 || b > 3) return null;
  }

  // Winner determinado por quem tem mais — bate com match_results.winner por convenção.
  const winnerMaps = Math.max(a, b);
  const loserMaps = Math.min(a, b);
  return { winnerMaps, loserMaps, bestOf };
}

/**
 * MAP{N}_WINNER settler via sweep detection.
 *
 * Para mercados MAP1_WINNER / MAP2_WINNER / etc, precisa-se do vencedor do mapa
 * específico. final_score só dá o placar agregado da série (ex: "Bo3 2-0").
 * Quando a série é sweep (loser=0 maps), o vencedor da série venceu TODOS os
 * mapas → MAP_N_winner = series winner para qualquer N ≤ winnerMaps.
 * Para não-sweeps (ex: Bo3 2-1), MAP_N_winner é indeterminável só pelo placar.
 *
 * @param {number} mapN — número do mapa (1, 2, 3, ...)
 * @param {string} finalScore — ex: "Bo3 2-0"
 * @param {boolean} pickIsSeriesWinner — true se a tip é no vencedor da série
 * @returns {{ result: 'win'|'loss', reason: string } | { result: null, reason: string }}
 *   result=null = não settable (precisa per-map data); chamador deve skip ou void após N dias.
 */
function settleMapWinnerFromSweep(mapN, finalScore, pickIsSeriesWinner) {
  const parsed = _parseEsportsMapScore(finalScore);
  if (!parsed) return { result: null, reason: 'unparseable_score' };
  const n = parseInt(mapN, 10);
  if (!Number.isFinite(n) || n < 1) return { result: null, reason: 'invalid_map_n' };
  // Sweep: vencedor levou todos os mapas. MAP{N} winner = series winner pra
  // qualquer N ≤ winnerMaps. Mapas após o sweep não foram disputados (void).
  if (parsed.loserMaps === 0) {
    if (n > parsed.winnerMaps) return { result: 'void', reason: 'map_not_played' };
    return { result: pickIsSeriesWinner ? 'win' : 'loss', reason: 'sweep' };
  }
  return { result: null, reason: 'non_sweep_needs_per_map_data' };
}

/**
 * Parse score string completo de tennis. Ex: "6-4 7-6(5) 4-6 6-3 RET"
 * Retorna estrutura com sets + totais.
 *
 * @param {string} finalScore
 * @param {boolean} winnerIsT1 — se team1 venceu a partida (pra orientar sets per team)
 * @returns {{ sets: [{t1, t2, tb}], totalGames: number, setCount: number,
 *             hasTiebreak: boolean, t1Sets: number, t2Sets: number } | null}
 */
function parseTennisScore(finalScore, winnerIsT1) {
  const s = String(finalScore || '');
  if (!s) return null;
  // Regex pra cada set: "6-4", "7-6(5)", "0-6" etc. Aceita espaço OU começo de string.
  const setRegex = /\b(\d+)-(\d+)(?:\s*\((\d+)\))?/g;
  const sets = [];
  let m;
  while ((m = setRegex.exec(s)) !== null) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    // Filter: scoreline válido só tem números até 7. Scores tipo "27-25" não existem em tênis moderno.
    if (a > 20 || b > 20) continue;
    // Exclui o caso de "Bo3 2-1" onde 2-1 é série, não set
    if (a <= 3 && b <= 3 && sets.length === 0 && /^\s*bo\d/i.test(s)) continue;
    sets.push({ t1: a, t2: b, tb: m[3] != null });
  }
  if (!sets.length) return null;

  const totalGames = sets.reduce((sum, st) => sum + st.t1 + st.t2, 0);
  const hasTiebreak = sets.some(st => st.tb);

  // Conta sets: cada set tem winner (quem chegou a 6+ primeiro, ou 7-6 via TB).
  // Aqui orientação é T1 = primeiro número do score (convenção).
  let t1Sets = 0, t2Sets = 0;
  for (const st of sets) {
    if (st.t1 > st.t2) t1Sets++;
    else if (st.t2 > st.t1) t2Sets++;
  }

  return {
    sets, totalGames, setCount: sets.length, hasTiebreak,
    t1Sets, t2Sets,
  };
}

/**
 * @param {object} db
 * @param {object} args
 * @param {string} args.sport — 'lol' | 'dota2' | 'cs2' | 'valorant' | 'tennis'
 * @param {object} args.match — { team1, team2, league, time?, ... }
 * @param {number} args.bestOf
 * @param {object} args.tip   — { market, line, side, pModel, pImplied, odd, ev, label }
 * @param {number} [args.stakeUnits] — opcional
 * @param {object} [args.meta] — qualquer extra JSON-serializable
 */
// Cache se a coluna is_live existe (legacy DB sem migration 054).
let _hasIsLiveCol = null;
// Cache se a coluna model_version existe (legacy DB sem migration 055).
let _hasModelVersionCol = null;

// Fractional Kelly default pra shadow quando caller não passa stakeUnits.
// Mesma fórmula de lib/market-tip-processor.js (kellyStakeForMarket) com params
// equivalentes — bankroll=100u, frac=0.10, cap 2u. Motivo de inline: evitar dep
// circular e manter logShadowTip self-contained. Override via env MARKET_TIP_*.
function _defaultKellyStake(tip) {
  const p = tip?.pModel;
  const o = tip?.odd;
  if (!Number.isFinite(p) || !Number.isFinite(o) || p <= 0 || o <= 1) return null;
  const b = o - 1;
  const fullKelly = (p * b - (1 - p)) / b;
  if (fullKelly <= 0) return null;
  const fracEnv = parseFloat(process.env.MARKET_TIP_KELLY_FRAC);
  const frac = Number.isFinite(fracEnv) && fracEnv > 0 && fracEnv <= 1 ? fracEnv : 0.10;
  const capEnv = parseFloat(process.env.MARKET_TIP_MAX_STAKE_UNITS);
  const cap = Number.isFinite(capEnv) && capEnv > 0 ? capEnv : 2;
  let units = fullKelly * frac * 100;
  if (units > cap) units = cap;
  // Arredondamento granular: 0.25u (passos comuns em betting display).
  // Min 0.5u — abaixo não vale apostar (var alta vs ganho marginal).
  const STEP = 0.25, MIN = 0.5;
  units = Math.round(units / STEP) * STEP;
  if (units < MIN) units = MIN;
  return +units.toFixed(2);
}

function logShadowTip(db, args) {
  try {
    const { sport, match, bestOf, tip, meta = null, isLive = false } = args;
    let { stakeUnits = null } = args;
    if (!db || !match || !tip) return false;

    // Odd floor gate (default 1.4). Tips de odd baixa têm edge matemático
    // mas var alta + stake alta Kelly — leak em caso de regression.
    // Override via MT_MIN_ODD env.
    const minOdd = parseFloat(process.env.MT_MIN_ODD || '1.4');
    if (tip.odd != null && Number(tip.odd) > 0 && Number(tip.odd) < minOdd) {
      log('INFO', 'MT-ODD-GATE', `skip ${sport} ${match.team1} vs ${match.team2} ${tip.market}/${tip.side ?? '?'}: odd ${tip.odd} < ${minOdd}`);
      return false;
    }

    // Backfill Kelly stake quando caller não passou — sem isso o ROI fica flat 1u
    // e perdemos visibilidade de stake-weighted performance.
    if (stakeUnits == null) stakeUnits = _defaultKellyStake(tip);
    const isLiveFlag = isLive ? 1 : 0;
    const matchKey = _matchKey(match);

    // Match-level dedup: 1 tip ativa por (sport, team1, team2) — todos mercados juntos.
    // Over/under maps + handicap + totais no mesmo jogo são CORRELACIONADAS; apostar em
    // múltiplas quebra a premise de Kelly independence e infla exposure. Se nova tip
    // tem EV > existing, UPGRADE (substitui tudo). Senão skip.
    //
    // BUG FIX 2026-04-26: query order-invariant ((t1=A AND t2=B) OR (t1=B AND t2=A))
    // cobria scanner cycles que emitiam mesmo match com team1/team2 swapped (live vs
    // pre, fonte alternativa). Sem isso row "A vs B" não dedupava com row "B vs A".
    // Match expression do SQL replicada em todas queries de dedup pra consistência.
    const t1n = _normStrict(match.team1), t2n = _normStrict(match.team2);
    // SQL chain espelhando _normStrict: strip space + hyphen + dot + apóstrofo.
    const T1 = "lower(REPLACE(REPLACE(REPLACE(REPLACE(team1,' ',''),'-',''),'.',''),'''',''))";
    const T2 = "lower(REPLACE(REPLACE(REPLACE(REPLACE(team2,' ',''),'-',''),'.',''),'''',''))";
    const existingMatch = db.prepare(`
      SELECT id, market, side, line, odd, p_model, ev_pct
      FROM market_tips_shadow
      WHERE sport = ?
        AND ((${T1} = ? AND ${T2} = ?)
          OR (${T1} = ? AND ${T2} = ?))
        AND created_at >= datetime('now', '-24 hours')
        AND result IS NULL
      ORDER BY ev_pct DESC
      LIMIT 1
    `).get(sport, t1n, t2n, t2n, t1n);
    if (existingMatch) {
      const existingEv = Number(existingMatch.ev_pct) || 0;
      const newEv = Number(tip.ev) || 0;
      if (newEv > existingEv) {
        // UPGRADE: nova tip tem EV maior → substitui market/side/line/odd/p_model/ev
        db.prepare(`
          UPDATE market_tips_shadow
          SET market = ?, side = ?, line = ?, odd = ?, p_model = ?, p_implied = ?, ev_pct = ?, label = ?,
              close_captured_at = datetime('now')
          WHERE id = ?
        `).run(
          tip.market, tip.side ?? null, tip.line ?? null,
          tip.odd ?? null, tip.pModel ?? null, tip.pImplied ?? null,
          tip.ev ?? null, tip.label ?? null, existingMatch.id
        );
        log('INFO', 'MT-MATCH-UPGRADE', `${sport} ${match.team1} vs ${match.team2}: ${existingMatch.market}/${existingMatch.side} EV=${existingEv.toFixed(1)}% → ${tip.market}/${tip.side ?? '?'} EV=${newEv.toFixed(1)}%`);
      } else {
        log('INFO', 'MT-MATCH-SKIP', `${sport} ${match.team1} vs ${match.team2}: ja existe tip ${existingMatch.market}/${existingMatch.side} EV=${existingEv.toFixed(1)}% >= nova ${tip.market}/${tip.side ?? '?'} EV=${newEv.toFixed(1)}%`);
      }
      return false;
    }

    // Legacy: dedup por (market, side) preservado como fallback defensivo — deveria
    // ser redundante pelo match-level acima mas mantém safety net. Mesmo norm SQL
    // + order-invariant que match-level pra evitar drift.
    const existing = db.prepare(`
      SELECT id, odd, line, p_model, ev_pct FROM market_tips_shadow
      WHERE sport = ?
        AND ((${T1} = ? AND ${T2} = ?)
          OR (${T1} = ? AND ${T2} = ?))
        AND market = ? AND side IS ?
        AND created_at >= datetime('now', '-24 hours')
        AND result IS NULL
      ORDER BY p_model DESC
      LIMIT 1
    `).get(sport, t1n, t2n, t2n, t1n, tip.market, tip.side ?? null);
    if (existing) {
      // Se nova tip tem p_model MAIOR (linha mais conservadora surgiu), update a
      // existing com nova line/odd/p_model/ev — substitui a "linha oficial" da tip.
      if ((tip.pModel || 0) > (existing.p_model || 0)) {
        db.prepare(`
          UPDATE market_tips_shadow
          SET line = ?, odd = ?, p_model = ?, p_implied = ?, ev_pct = ?, label = ?,
              close_captured_at = datetime('now')
          WHERE id = ?
        `).run(
          tip.line ?? null,
          tip.odd ?? null,
          tip.pModel ?? null,
          tip.pImplied ?? null,
          tip.ev ?? null,
          tip.label ?? null,
          existing.id
        );
        log('INFO', 'MT-UPGRADE', `${args.sport}/${tip.market}|${tip.side} ${match.team1} vs ${match.team2}: line ${existing.line} (p=${existing.p_model?.toFixed(3)}) → line ${tip.line} (p=${tip.pModel?.toFixed(3)})`);
      } else if (tip.odd && existing.odd && existing.odd > 0 && Math.abs(tip.odd - existing.odd) > 0.005 && tip.line === existing.line) {
        // Mesma line, odd diferente — update close_odd pra CLV tracking
        const openOdd = existing.odd;
        const closeOdd = tip.odd;
        const clvPct = (openOdd / closeOdd - 1) * 100;
        db.prepare(`
          UPDATE market_tips_shadow
          SET close_odd = ?, clv_pct = ?, close_captured_at = datetime('now')
          WHERE id = ?
        `).run(closeOdd, +clvPct.toFixed(2), existing.id);
        const sign = clvPct >= 0 ? '+' : '';
        log('INFO', 'MT-CLV', `${args.sport}/${tip.market} ${match.team1} vs ${match.team2}: open=${openOdd} → close=${closeOdd} CLV=${sign}${clvPct.toFixed(1)}%`);
      }
      return false;
    }

    // Detecta colunas opcionais (is_live da migration 054, model_version da 055).
    // Cache no module pra não pagar PRAGMA por chamada.
    if (_hasIsLiveCol === null) {
      try {
        const cols = db.prepare("PRAGMA table_info(market_tips_shadow)").all();
        const names = new Set(cols.map(c => c.name));
        _hasIsLiveCol = names.has('is_live');
        _hasModelVersionCol = names.has('model_version');
      } catch (_) { _hasIsLiveCol = false; _hasModelVersionCol = false; }
    }
    // model_version — stamp default pós-fix 2026-04-23 (games vs sets handicap).
    // Override via env MARKET_TIP_MODEL_VERSION pra marcar fixes futuros.
    const modelVersion = process.env.MARKET_TIP_MODEL_VERSION || 'v2_virtual_matchup_fix';

    if (_hasIsLiveCol && _hasModelVersionCol) {
      db.prepare(`
        INSERT INTO market_tips_shadow
          (sport, match_key, team1, team2, league, best_of,
           market, line, side, label, p_model, p_implied, odd, ev_pct, stake_units,
           meta_json, is_live, model_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sport, matchKey,
        match.team1 || null, match.team2 || null, match.league || null, bestOf || null,
        tip.market, tip.line ?? null, tip.side ?? null, tip.label || null,
        tip.pModel ?? null, tip.pImplied ?? null, tip.odd, tip.ev, stakeUnits,
        meta ? JSON.stringify(meta) : null, isLiveFlag, modelVersion,
      );
    } else if (_hasIsLiveCol) {
      db.prepare(`
        INSERT INTO market_tips_shadow
          (sport, match_key, team1, team2, league, best_of,
           market, line, side, label, p_model, p_implied, odd, ev_pct, stake_units,
           meta_json, is_live)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sport, matchKey,
        match.team1 || null, match.team2 || null, match.league || null, bestOf || null,
        tip.market, tip.line ?? null, tip.side ?? null, tip.label || null,
        tip.pModel ?? null, tip.pImplied ?? null, tip.odd, tip.ev, stakeUnits,
        meta ? JSON.stringify(meta) : null, isLiveFlag,
      );
    } else {
      db.prepare(`
        INSERT INTO market_tips_shadow
          (sport, match_key, team1, team2, league, best_of,
           market, line, side, label, p_model, p_implied, odd, ev_pct, stake_units,
           meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sport, matchKey,
        match.team1 || null, match.team2 || null, match.league || null, bestOf || null,
        tip.market, tip.line ?? null, tip.side ?? null, tip.label || null,
        tip.pModel ?? null, tip.pImplied ?? null, tip.odd, tip.ev, stakeUnits,
        meta ? JSON.stringify(meta) : null,
      );
    }
    return true;
  } catch (e) {
    log('WARN', 'MT-SHADOW', `log err (${args?.sport}/${args?.tip?.market}): ${e.message}`);
    return false;
  }
}

/**
 * Settle shadow tips pendentes. Cruza com match_results por (team1, team2, data).
 * Só trata market_winner/handicap de sets/maps (requer só winner). Totals, aces, TB ficam
 * como unsettled (requer parsing adicional do final_score).
 *
 * @returns {{ settled: number, skipped: number }}
 */
function settleShadowTips(db, opts = {}) {
  const _t0 = Date.now();
  let settled = 0, skipped = 0;
  // 2026-05-02: opts.force=true bypassa o cooldown 30min in-memory pra
  // tips "evento anterior do par". Útil em /admin/settle-market-tips-shadow
  // pós-deploy ou quando match_results foi sync'd recente.
  const _bypassCooldown = !!opts.force;

  // Cleanup batch atômica via db.transaction — reduz fsync overhead (4
  // UPDATEs separados → 1 commit) e impede que múltiplas chamadas
  // concorrentes (settle cron + admin trigger) executem cleanup em sequência
  // entrelaçada. better-sqlite3 transaction serializa writes locais; +
  // busy_timeout WAL gerencia race entre processos. Fail-soft: erro
  // dentro da transaction faz rollback dos 4, mas log é capturado.
  try {
    const cleanupTx = db.transaction(() => {
      // Cleanup #1: markets sem settlement handler — viram void após 3d.
      // 2026-05-01: 14d→3d. Tips destes mercados nunca settlam (sem data ingerida)
      // e ficam logando MT-SHADOW-MATCH todo ciclo (1500+ logs em 7d) porque match
      // é encontrado mas routing cai em else skip. Void mais cedo limpa backlog.
      // mapWinner permanece em handler dedicado (sweep settle), removido daqui.
      const v1 = db.prepare(`
        UPDATE market_tips_shadow
        SET result = 'void', settled_at = datetime('now'), profit_units = 0
        WHERE result IS NULL
          AND market IN ('totalAces', 'correctScore', 'totalKills', 'duration', 'firstBlood', 'totalDoubleFaults', 'doubleChance', 'btts')
          AND created_at <= datetime('now', '-3 days')
      `).run();
      if (v1.changes > 0) log('INFO', 'MT-SHADOW', `voided ${v1.changes} ghost rows (unhandled markets >3d)`);

      // Cleanup #1c: mapWinner não-sweep — handler resolve sweeps via final_score
      // mas non-sweeps precisam per-map data (não disponível). Void após 7d.
      const v1c = db.prepare(`
        UPDATE market_tips_shadow
        SET result = 'void', settled_at = datetime('now'), profit_units = 0
        WHERE result IS NULL
          AND market = 'mapWinner'
          AND created_at <= datetime('now', '-7 days')
      `).run();
      if (v1c.changes > 0) log('INFO', 'MT-SHADOW', `voided ${v1c.changes} mapWinner rows (non-sweep precisa per-map data >7d)`);

      // Cleanup #1b: total_kills_mapN — scanner LoL kills (bot.js:6194) salva como
      // 'total_kills_map1/2/3' (snake_case + suffix), fora do IN list acima. Sem
      // handler dedicado nem sync de kills/map em match_results, void após 3d (mais
      // agressivo: tip pré-jogo perde valor de calibração rápido).
      const v1b = db.prepare(`
        UPDATE market_tips_shadow
        SET result = 'void', settled_at = datetime('now'), profit_units = 0
        WHERE result IS NULL
          AND market LIKE 'total_kills_%'
          AND created_at <= datetime('now', '-3 days')
      `).run();
      if (v1b.changes > 0) log('INFO', 'MT-SHADOW', `voided ${v1b.changes} total_kills_mapN rows (no kills sync handler >3d)`);

      // Cleanup #2: handicap/total esports onde match_result foi achado MAS
      // final_score está vazio. Sync (gol.gg/OE/HLTV/OpenDota) populou winner sem
      // score → impossível liquidar, pendência eterna. Void após 7d (mais agressivo
      // que #1 porque sample já provou que sync não vai re-popular).
      const v2 = db.prepare(`
        UPDATE market_tips_shadow
        SET result = 'void', settled_at = datetime('now'), profit_units = 0
        WHERE result IS NULL
          AND market IN ('handicap', 'total')
          AND sport IN ('lol', 'dota2', 'cs2', 'valorant')
          AND created_at <= datetime('now', '-7 days')
          AND EXISTS (
            SELECT 1 FROM match_results mr
            WHERE mr.game = market_tips_shadow.sport
              AND ((lower(mr.team1) = lower(market_tips_shadow.team1) AND lower(mr.team2) = lower(market_tips_shadow.team2))
                OR (lower(mr.team1) = lower(market_tips_shadow.team2) AND lower(mr.team2) = lower(market_tips_shadow.team1)))
              AND mr.winner IS NOT NULL AND mr.winner != ''
              AND (mr.final_score IS NULL OR mr.final_score = '')
              AND mr.resolved_at >= datetime(market_tips_shadow.created_at, '-24 hours')
              AND mr.resolved_at <= datetime(market_tips_shadow.created_at, '+7 days')
          )
      `).run();
      if (v2.changes > 0) log('INFO', 'MT-SHADOW', `voided ${v2.changes} esports rows (match found but final_score empty >7d — sync gap)`);

      // Cleanup #3: handled markets sem match_result correspondente após 14d.
      // Sync já teve chance — se não puxou em 14d, não vai puxar mais. Void pra
      // limpar backlog e não contaminar shadow stats com pending eterno.
      const v3 = db.prepare(`
        UPDATE market_tips_shadow
        SET result = 'void', settled_at = datetime('now'), profit_units = 0
        WHERE result IS NULL
          AND market IN ('matchWinner', 'handicap', 'total', 'handicapSets', 'handicapGames', 'totalGames', 'tiebreakMatch', 'draw', 'totals')
          AND created_at <= datetime('now', '-14 days')
          AND NOT EXISTS (
            SELECT 1 FROM match_results mr
            WHERE mr.game = market_tips_shadow.sport
              AND ((lower(mr.team1) = lower(market_tips_shadow.team1) AND lower(mr.team2) = lower(market_tips_shadow.team2))
                OR (lower(mr.team1) = lower(market_tips_shadow.team2) AND lower(mr.team2) = lower(market_tips_shadow.team1)))
              AND mr.winner IS NOT NULL AND mr.winner != ''
              AND mr.resolved_at >= datetime(market_tips_shadow.created_at, '-24 hours')
              AND mr.resolved_at <= datetime(market_tips_shadow.created_at, '+10 days')
          )
      `).run();
      if (v3.changes > 0) log('INFO', 'MT-SHADOW', `voided ${v3.changes} rows (no match_result found >14d — sync gap)`);
    });
    cleanupTx();
  } catch (e) {
    log('WARN', 'MT-SHADOW', `cleanup transaction rollback: ${e.message}`);
  }

  // BUG FIX 2026-04-23: LIMIT 200 era engolido pelas 778+ tips com final_score=''
  // (sync gap legacy) → settled:0/skipped:200, tips resolvíveis recentes nunca
  // chegavam. Bump pra 1000 elimina starvation. Subquery exclui tips conhecidamente
  // irrecuperáveis (final_score IS NULL/'' OR sem match_result válido) pra que o
  // cron foque nas que têm chance real de liquidar.
  const pending = db.prepare(`
    SELECT id, sport, team1, team2, league, market, line, side, odd, stake_units, created_at, close_odd
    FROM market_tips_shadow
    WHERE result IS NULL
      AND created_at >= datetime('now', '-30 days')
      AND created_at <= datetime('now', '-2 hours')
    ORDER BY created_at ASC
    LIMIT 1000
  `).all();

  // Threshold inline pra zombie void (tip pending sem chance real de settle).
  // Mesmos defaults do auto-void cron diário (bot.js runAutoVoidStuck).
  const ZOMBIE_THRESHOLDS_H = {
    lol: 12, cs2: 12, valorant: 12, dota2: 12,
    tennis: 36, football: 24,
  };
  const _now = Date.now();
  const _isZombie = (t) => {
    const h = ZOMBIE_THRESHOLDS_H[t.sport];
    if (!h) return false;
    const ageH = (_now - new Date(t.created_at).getTime()) / 3600000;
    return ageH >= h;
  };
  const _zombieVoid = (t, reason) => {
    try {
      db.prepare(`UPDATE market_tips_shadow
        SET result = 'void', settled_at = datetime('now'), profit_units = 0
        WHERE id = ? AND result IS NULL`).run(t.id);
      log('INFO', 'MT-SHADOW', `tip#${t.id} ${t.team1} vs ${t.team2}: void (zombie ${reason}, age >${ZOMBIE_THRESHOLDS_H[t.sport]}h)`);
      settled++;
      return true;
    } catch (_) { skipped++; return false; }
  };

  // 2026-05-02: skip-cache para tips que repetidamente caem em "all candidates
  // resolved before tip created_at" — sem isso, cada cycle re-querya 10+ tips
  // tennis e loga a mesma DEBUG line. Cooldown 30min: bem abaixo do threshold
  // zombie (36h tennis) e re-tenta caso novo match_result apareça via sync.
  global._mtStuckSkip = global._mtStuckSkip || new Map();
  const _stuckSkipMs = 30 * 60 * 1000;

  for (const t of pending) {
    try {
      const _stuckUntil = global._mtStuckSkip.get(t.id);
      if (_stuckUntil && _stuckUntil > _now && !_bypassCooldown) {
        // Cooldown ativo — skip silencioso. Reprocessa quando expirar OU quando
        // outro caller (ex: forceSettle) limpar a entrada.
        skipped++;
        continue;
      }
      if (_bypassCooldown && _stuckUntil) {
        // Bypass: limpa entrada também pra próximo cycle re-avaliar a partir do zero.
        global._mtStuckSkip.delete(t.id);
      }
      // Busca match_results por (team1, team2) na janela do created_at.
      // Tennis usa janela ampla (±10 dias) porque Sackmann armazena tourney_date
      // (início da semana do torneio), não match date — matches Sex/Sáb ficam 3-5
      // dias após tourney_date. Esports usam ±48h.
      // 2026-04-28: CS2 match_results.game vem como 'cs' (PandaScore upsert) OU
      // 'cs2' (HLTV sync) — settle CS2 só achava HLTV rows, ignorando PS. Agora
      // aceita ambos via array. Demais sports usam single value.
      const gameMap = { lol: ['lol'], dota2: ['dota2'], cs2: ['cs','cs2'], valorant: ['valorant'], tennis: ['tennis'], football: ['football'] };
      const games = gameMap[t.sport];
      if (!games) { skipped++; continue; }
      const gamePlaceholders = games.map(() => '?').join(',');
      const n1 = _norm(t.team1), n2 = _norm(t.team2);
      // Janela temporal por sport. Esports ampliada pra -24h/+7d porque scanner
      // de mercado loga tips pré-jogo e match pode ocorrer vários dias depois
      // (torneios corridos, tiers 2-3 com agendamento irregular).
      const windowBefore = t.sport === 'tennis' ? '-10 days'
                         : t.sport === 'football' ? '-48 hours'
                         : '-24 hours';
      const windowAfter = t.sport === 'tennis' ? '+10 days'
                        : t.sport === 'football' ? '+72 hours'
                        : '+7 days';
      // Retorna múltiplas candidates pra pegar a row com score parseável.
      // Rationale: temos rows OpenDota (kills-based) + PandaScore (map-based) pro
      // mesmo match; preferimos a que tem final_score válido pra handicap/total.
      let candidates = db.prepare(`
        SELECT winner, final_score, resolved_at, match_id, team1, team2, league
        FROM match_results
        WHERE game IN (${gamePlaceholders})
          AND ((lower(team1) = ? AND lower(team2) = ?) OR (lower(team1) = ? AND lower(team2) = ?))
          AND resolved_at >= datetime(?, ?)
          AND resolved_at <= datetime(?, ?)
          AND winner IS NOT NULL AND winner != ''
        ORDER BY ABS(julianday(resolved_at) - julianday(?)) ASC
        LIMIT 10
      `).all(...games, n1, n2, n2, n1, t.created_at, windowBefore, t.created_at, windowAfter, t.created_at);

      // Fallback fuzzy LIKE pra football: nomes Pinnacle ("Córdoba") ≠ Sofascore
      // ("CF Córdoba"). Sem este fallback settle silenciosamente falha em 100%.
      if (!candidates.length && t.sport === 'football') {
        const l1 = `%${n1}%`, l2 = `%${n2}%`;
        candidates = db.prepare(`
          SELECT winner, final_score, resolved_at, match_id, league
          FROM match_results
          WHERE game IN (${gamePlaceholders})
            AND ((lower(team1) LIKE ? AND lower(team2) LIKE ?) OR (lower(team1) LIKE ? AND lower(team2) LIKE ?))
            AND resolved_at >= datetime(?, ?)
            AND resolved_at <= datetime(?, ?)
            AND winner IS NOT NULL AND winner != ''
          ORDER BY ABS(julianday(resolved_at) - julianday(?)) ASC
          LIMIT 10
        `).all(...games, l1, l2, l2, l1, t.created_at, windowBefore, t.created_at, windowAfter, t.created_at);
      }

      // Fallback last-name pra tennis: Pinnacle ("N. Basilashvili") ≠
      // Sackmann/ESPN ("Nikoloz Basilashvili"). Match pelo sobrenome do tip_team
      // garante cobertura. Ordena por proximidade temporal pra desambiguar quando
      // dois jogadores diferentes compartilham sobrenome.
      if (!candidates.length && t.sport === 'tennis') {
        const ln1 = _lastName(t.team1), ln2 = _lastName(t.team2);
        if (ln1 && ln2 && ln1.length >= 3 && ln2.length >= 3) {
          const l1 = `%${ln1}%`, l2 = `%${ln2}%`;
          candidates = db.prepare(`
            SELECT winner, final_score, resolved_at, match_id, team1, team2, league
            FROM match_results
            WHERE game IN (${gamePlaceholders})
              AND ((lower(team1) LIKE ? AND lower(team2) LIKE ?) OR (lower(team1) LIKE ? AND lower(team2) LIKE ?))
              AND resolved_at >= datetime(?, ?)
              AND resolved_at <= datetime(?, ?)
              AND winner IS NOT NULL AND winner != ''
            ORDER BY ABS(julianday(resolved_at) - julianday(?)) ASC
            LIMIT 10
          `).all(...games, l1, l2, l2, l1, t.created_at, windowBefore, t.created_at, windowAfter, t.created_at);
          // 2026-04-28: filtro extra com inicial do firstName quando ambos têm.
          // Cerundolo F. vs Cerundolo J.M. — last-name colidia, agora exigem
          // inicial de prenome (quando disponível) match também.
          const fi1 = _firstInitial(t.team1), fi2 = _firstInitial(t.team2);
          if (candidates.length > 1 && fi1 && fi2) {
            const _matchInitial = (cTeam, tTeam, cInit, tInit) => {
              const cFi = _firstInitial(cTeam);
              return !cFi || cFi === tInit; // se candidate sem inicial, aceita
            };
            const filtered = candidates.filter(c => {
              const okA = _matchInitial(c.team1, t.team1, '', fi1) && _matchInitial(c.team2, t.team2, '', fi2);
              const okB = _matchInitial(c.team1, t.team2, '', fi2) && _matchInitial(c.team2, t.team1, '', fi1);
              return okA || okB;
            });
            if (filtered.length) candidates = filtered;
          }
        }
      }

      // Fallback final: esports também usa fuzzy LIKE (pode ter sufixos "Gaming",
      // "Esports", "Academy" diferindo entre Pinnacle e gol.gg/PandaScore).
      if (!candidates.length && ['lol','dota2','cs2','valorant'].includes(t.sport)) {
        const l1 = `%${n1}%`, l2 = `%${n2}%`;
        candidates = db.prepare(`
          SELECT winner, final_score, resolved_at, match_id, team1, team2, league
          FROM match_results
          WHERE game IN (${gamePlaceholders})
            AND ((lower(team1) LIKE ? AND lower(team2) LIKE ?) OR (lower(team1) LIKE ? AND lower(team2) LIKE ?))
            AND resolved_at >= datetime(?, ?)
            AND resolved_at <= datetime(?, ?)
            AND winner IS NOT NULL AND winner != ''
          ORDER BY ABS(julianday(resolved_at) - julianday(?)) ASC
          LIMIT 10
        `).all(...games, l1, l2, l2, l1, t.created_at, windowBefore, t.created_at, windowAfter, t.created_at);
      }

      if (!candidates.length) {
        if (_isZombie(t)) { _zombieVoid(t, 'no_match_results'); continue; }
        skipped++; continue;
      }

      // Tiebreak por league: mesmos 2 jogadores podem se enfrentar em torneios
      // consecutivos (Djokovic/Alcaraz Madrid→Rome). Quando múltiplos candidates,
      // prefere o que tem league overlap com a tip — evita settlement no torneio errado.
      // BUG FIX 2026-04-26 (Cerundolo×Darderi R3 Madrid liquidado com Estoril W16):
      // mesmo com 1 candidate, se tip tem league explícita E nenhum candidate dá
      // overlap → skip. Senão Sackmann tourney_date semana anterior (mesmo par
      // jogou outra final) liquida tip futura. Só pra tennis (onde Sackmann tem
      // tourney_date amplo); outros sports continuam aceitando 1-candidate sem league.
      const tipLeagueN = _normLeague(t.league || '');
      let filtered = candidates;
      if (tipLeagueN) {
        const leagueMatches = candidates.filter(c => _leagueOverlap(tipLeagueN, _normLeague(c.league || '')));
        if (leagueMatches.length) {
          filtered = leagueMatches;
        } else if (t.sport === 'tennis') {
          // Tennis-only strict: tip tem league explícita + ZERO candidates com overlap
          // → normalmente skip. Bug histórico (Cerundolo×Darderi Madrid R3 liquidada
          // antes do match com Estoril W16 sem league) — só skipava quando every()
          // candidate tinha league populada.
          //
          // FORCE-SETTLE 2026-04-28: quando tip está zombie (≥36h) E há candidato
          // com score parseável pro mesmo par, aceita SEM exigir league overlap.
          // Sackmann frequentemente normaliza tourney name diferente do scanner
          // (ex: "ATP Madrid" vs "ATP Mutua Madrid Open"). Após threshold, melhor
          // settle com data disponível do que void / pending eterno.
          if (_isZombie(t) && candidates.some(c => parseTennisScore(c.final_score) != null)) {
            log('INFO', 'MT-SHADOW', `tip#${t.id} ${t.team1} vs ${t.team2}: zombie force-settle (sem league overlap, age >${ZOMBIE_THRESHOLDS_H[t.sport]}h)`);
            filtered = candidates; // bypass league overlap, mantém todos candidatos
          } else {
            skipped++;
            continue;
          }
        }
      }
      // ── GUARDRAIL UNIVERSAL: candidate.resolved_at deve ser ≥ tip.created_at - 30min ──
      //
      // Logica: match real RESOLVE depois da tip (pre-game) ou simultâneo (live
      // tip placed perto do final do match). Buffer de 30min cobre clock drift
      // entre sistemas (Sackmann/ESPN/HLTV vs server time) sem permitir matches
      // de eventos passados. Sem buffer = false-negative em live tips de fim
      // de match; com buffer >30min = false-positive (eventos do mesmo dia).
      //
      // BUG FIX 2026-04-27 #2 (Blockx×Auger-Aliassime tip 562 settled antes do
      // match acontecer apesar do guardrail de 6h): 6h era frouxo — match
      // earlier no dia (R1/qualifier/doubles) entre players com last-name
      // similar passava o filter. 30min é o sweet spot empírico:
      //   - Pre-match tip @ 12:57 → match scheduled 14:00 → resolved 16:00 ✓
      //   - Live tip @ 13:00 mid-match → match ends 14:00 ✓
      //   - Match anterior do par mesmo dia (R1 às 11:00) → BLOCKED ✓
      //
      // BUG FIX 2026-04-27 #1 (Etcheverry×Fils Madrid R16 settled R$+1.16 em 29min):
      // antes só tennis tinha 5-day check; outros sports caíam no SQL window
      // (-24h esports/-48h football) e pegavam partida do dia anterior.
      if (filtered.length) {
        const tipTs = new Date(t.created_at).getTime();
        // Buffer 5min cobre clock drift Sackmann/ESPN/HLTV vs server time mas
        // bloqueia agressivamente partidas ANTERIORES do mesmo par no mesmo dia
        // (R1/R2 da manhã com R3 à tarde, esports back-to-back, etc).
        // BUG FIX 2026-04-27 #3: 30min ainda permitia false-match — Atmane×Zverev
        // R3 settled antes do match acontecer porque R1/R2 desse par no dia
        // resolveram <30min antes da tip. 5min é o sweet spot empírico p/ tennis.
        // 2026-04-28: esports/MMA usa janela 30min — tips live emitidas 4-15min
        // antes do final do mapa CS/LoL eram bloqueadas (resolved_at PandaScore
        // = mid-game commit) com guard 5min. Tennis collision risk vs esports
        // late-live tip — janela maior só onde collision não acontece.
        const guardMs = (t.sport === 'tennis')
          ? 5 * 60 * 1000
          : 30 * 60 * 1000;
        const within = filtered.filter(c => {
          const cTs = new Date(c.resolved_at).getTime();
          return Number.isFinite(cTs) && (cTs >= tipTs - guardMs);
        });
        if (!within.length) {
          // Caso típico: scanner emitiu tip APÓS match resolve (live cycle late
          // ou cache stale) → all candidates resolved before tip created_at.
          // Guardrail original bloqueia pra prevenir false-match em FRESH tips
          // (R1 vs R2 mesmo dia). Mas em tips ZOMBIE (≥threshold) que têm
          // candidato com score parseável, a única alternativa é settle ou
          // void. Settle com partial score é mais informativo.
          //
          // FORCE-SETTLE 2026-04-28: aceita candidato fora 5min se score
          // parseável + tip zombie. Apenas void se NENHUM candidate tem score.
          const hasParseable = filtered.some(c =>
            (t.sport === 'tennis' && parseTennisScore(c.final_score) != null) ||
            (t.sport !== 'tennis' && _parseEsportsMapScore(c.final_score) != null));
          // 2026-05-02: pre-zombie acceptance pra scanner-lag. Quando tip é
          // emitida APÓS match já resolved (cache stale / live cycle late),
          // o match REAL é candidate.resolved_at < tip.created_at por minutos
          // a 2h. Caso típico: tennis tips ID 1738/1739/1748/1749/1750 — tip
          // ~25-2h após match terminou. Antes só zombie (≥36h tennis) acceitava;
          // agora aceita >=2h tip age + name+league já matched + score parseável.
          // Risco: false-match em rounds anteriores do mesmo par (raro: round
          // anterior + same league + score parseável = match real, não R1/R2).
          // Opt-out: MT_PRE_ZOMBIE_FORCE_SETTLE_DISABLED=true.
          const tipAgeH = (_now - new Date(t.created_at).getTime()) / 3600000;
          const _preZombieMinH = parseFloat(process.env.MT_PRE_ZOMBIE_MIN_HOURS || '2');
          const _preZombieOff = /^(1|true|yes)$/i.test(String(process.env.MT_PRE_ZOMBIE_FORCE_SETTLE_DISABLED || ''));
          const preZombieOk = !_preZombieOff && hasParseable && tipAgeH >= _preZombieMinH;
          if (_isZombie(t) && hasParseable) {
            log('INFO', 'MT-SHADOW', `tip#${t.id} ${t.team1} vs ${t.team2}: zombie force-settle (resolved before tip, age >${ZOMBIE_THRESHOLDS_H[t.sport]}h)`);
            // segue com filtered (não restringe pra within=[])
          } else if (preZombieOk) {
            log('INFO', 'MT-SHADOW', `tip#${t.id} ${t.team1} vs ${t.team2}: pre-zombie force-settle (resolved before tip, age=${tipAgeH.toFixed(1)}h ≥${_preZombieMinH}h, score parseável)`);
            // segue com filtered (não restringe pra within=[])
          } else if (_isZombie(t)) {
            // Zombie sem score parseável → void (nada pra settle)
            _zombieVoid(t, 'all_resolved_before_tip_no_score');
            continue;
          } else {
            // Marca tip pra skip silencioso por 30min — evita re-query a cada cycle.
            global._mtStuckSkip.set(t.id, _now + _stuckSkipMs);
            log('DEBUG', 'MT-SHADOW',
              `${t.sport} ${t.team1} vs ${t.team2}: all candidates resolved >${Math.round(guardMs/60000)}min before tip created_at — skip (evento anterior do par; cooldown 30min)`);
            skipped++;
            continue;
          }
        } else {
          filtered = within;
        }
      }

      // Pra markets que dependem de score parseável, prefere row com score válido.
      // Esports handicap/total: needs _parseEsportsMapScore != null.
      // Tennis handicapSets/totalGames/tiebreakMatch: needs parseTennisScore != null.
      // BUG FIX 2026-04-23: se filtered (post-league) não tem parseable mas full
      // candidates set tem, usa o parseable mesmo sem league match. League filter
      // descartava o único candidate com score (ex: Bilibili vs Invictus — match
      // achado em LPL com Bo3 1-2 mas filter pegou Esports World Cup com '').
      const needsMapScore = (t.market === 'handicap' || t.market === 'handicapSets' || t.market === 'total')
        && t.sport !== 'tennis';
      const needsTennisScore = t.sport === 'tennis' &&
        (t.market === 'handicapSets' || t.market === 'handicapGames' || t.market === 'totalGames' || t.market === 'tiebreakMatch' || t.market === 'handicap');
      let mr = filtered[0];
      if (needsMapScore) {
        const parseable = filtered.find(c => _parseEsportsMapScore(c.final_score) != null);
        if (parseable) mr = parseable;
        else {
          const fallback = candidates.find(c => _parseEsportsMapScore(c.final_score) != null);
          if (fallback) mr = fallback;
        }
      } else if (needsTennisScore) {
        const parseable = filtered.find(c => parseTennisScore(c.final_score) != null);
        if (parseable) mr = parseable;
        else {
          const fallback = candidates.find(c => parseTennisScore(c.final_score) != null);
          if (fallback) mr = fallback;
        }
      }

      // Walkover/retirement/forfeit: match não foi jogado normalmente. Tips de
      // games/sets/totals dependem de score real, não fazem sentido em walkover.
      // Void imediato evita tips ficarem stuck pending até auto-void-stuck (36h).
      // Tennis specific — esports/football raramente tem walkover.
      if (t.sport === 'tennis' && mr.final_score &&
          /\b(walkover|w\/o|retired|retirement|abandoned|cancelled|canceled|disqualifi)\b/i.test(String(mr.final_score))) {
        try {
          db.prepare(`UPDATE market_tips_shadow
            SET result = 'void', settled_at = datetime('now'), profit_units = 0
            WHERE id = ? AND result IS NULL`).run(t.id);
          log('INFO', 'MT-SHADOW', `tip#${t.id} ${t.team1} vs ${t.team2}: void (walkover/retired) — score='${mr.final_score}'`);
          settled++;
          continue;
        } catch (e) { skipped++; continue; }
      }

      // 2026-05-01: skip silently markets sem handler antes de logar MATCH.
      // Antes: tip#1152 dota2 totalKills/duration logava MT-SHADOW-MATCH em todo
      // ciclo (3× em 2min) porque settle handler caía em else genérico → skipped.
      // Cleanup #1 voida em 14d (ou v1b 3d pra total_kills_*); até lá, skip mudo.
      const _UNHANDLED_MARKETS_FOR_LOG = new Set([
        'totalKills', 'duration', 'totalAces', 'correctScore', 'firstBlood',
        'totalDoubleFaults', 'doubleChance', 'btts',
      ]);
      const _isPerMapKills = /^total_kills_(map\d+|\d+)$/i.test(String(t.market || ''));
      if (_UNHANDLED_MARKETS_FOR_LOG.has(t.market) || _isPerMapKills) {
        skipped++; continue;
      }

      // Log diagnóstico: qual match_results row vai liquidar essa tip. Ajuda
      // detectar match-mismatch (R1 vs R3, doubles vs singles, etc).
      log('INFO', 'MT-SHADOW-MATCH',
        `${t.sport} tip#${t.id} ${t.team1} vs ${t.team2} (created ${t.created_at}) → match_results id=${mr.match_id || '?'} league='${mr.league || ''}' winner='${mr.winner}' resolved=${mr.resolved_at} score='${mr.final_score || ''}'`);

      // Evaluate result por market type
      let result = null;
      // BUG FIX 2026-04-27 #3: separar 2 conceitos antes acoplados em winnerIs1:
      //   (A) mrT1IsShadowT1 — orientation: mr.team1 é o mesmo atleta de shadow.team1?
      //       Determina se parsed.t1/.t2 (que seguem mr.team1/mr.team2) precisam
      //       ser swapped pra alinhar com shadow.team1/team2.
      //   (B) winnerIs1 — outcome: shadow.team1 venceu?
      //       Usado pra mercados ML / draw onde só importa quem ganhou.
      //
      // Bug do Atmane vs Zverev (tip 559 -3.5): sofa row tinha team1=Atmane (=shadow.team1),
      // Zverev (away) venceu por 4 games. winnerIs1=false (Atmane perdeu) FAZIA swap
      // erroneamente — invertia placar (gamesT1=13, gamesT2=9 → margem Atmane=+4 que
      // virou margem Zverev=−4 com sinal trocado), virando -3.5 cover em LOSS errado.
      const nw = _norm(mr.winner);
      let winnerIs1;
      let mrT1IsShadowT1; // orientation flag
      if (t.sport === 'tennis') {
        const winLn = _lastName(mr.winner);
        const t1Ln = _lastName(t.team1);
        const mrT1Ln = _lastName(mr.team1 || '');
        winnerIs1 = !!(winLn && t1Ln && winLn === t1Ln);
        mrT1IsShadowT1 = !!(mrT1Ln && t1Ln && mrT1Ln === t1Ln);
      } else if (['lol','dota2','cs2','valorant'].includes(t.sport)) {
        winnerIs1 = nw === n1 || (nw && n1 && (nw.includes(n1) || n1.includes(nw)));
        const mrT1n = _norm(mr.team1 || '');
        mrT1IsShadowT1 = mrT1n === n1 || (mrT1n && n1 && (mrT1n.includes(n1) || n1.includes(mrT1n)));
      } else {
        winnerIs1 = nw === n1;
        mrT1IsShadowT1 = _norm(mr.team1 || '') === n1;
      }

      if (t.market === 'handicapGames') {
        // Tennis GAMES handicap (match-level games margin).
        // Pinnacle period=0 "spread" em tennis é GAMES handicap. Conta soma de
        // games por player no final_score "6-4 6-3" → margin +5.
        const parsed = parseTennisScore(mr.final_score);
        if (!parsed) { skipped++; continue; }
        let gamesT1 = 0, gamesT2 = 0;
        for (const st of parsed.sets) { gamesT1 += st.t1; gamesT2 += st.t2; }
        // BUG FIX 2026-04-30: ESPN/Sofascore guardam final_score em **winner-first**
        // (positional t1 = winner). Antes só swap baseado em mrT1IsShadowT1 — quando
        // mr.team1 ≠ winner, margin ficava invertida. Sintoma: Cobolli vs Zverev,
        // score "6-1 6-4" (Zverev won), shadow handicapGames Zverev -2.5 settled
        // como LOSS quando devia ser WIN.
        // Fix: alinhar pelo winner. Se positional t1 ganhou (mais games)
        // E winnerIs1 (shadow.team1 é winner) → sem swap (positional t1 = shadow.team1).
        // Senão swap.
        const positionalT1Won = gamesT1 > gamesT2;
        if (positionalT1Won !== winnerIs1) { [gamesT1, gamesT2] = [gamesT2, gamesT1]; }
        const margin = gamesT1 - gamesT2; // shadow.team1 margin
        const sideIsT1 = t.side === 'team1' || t.side === 'home';
        const covers = sideIsT1 ? (margin + t.line > 0) : (-margin + t.line > 0);
        result = covers ? 'win' : 'loss';
      } else if (t.market === 'handicap' || t.market === 'handicapSets') {
        // Handicap de SETS (esports maps OR tennis sets).
        // Esports: final_score "Bo3 2-1". Tennis: série de sets "6-4 7-6(5) ..."
        let team1Sets, team2Sets;
        let actualBoFromScore = null;
        if (t.sport === 'tennis') {
          const parsed = parseTennisScore(mr.final_score);
          if (!parsed) { skipped++; continue; }
          team1Sets = parsed.t1Sets;
          team2Sets = parsed.t2Sets;
          // Mesmo bug do handicapGames: alinhar por winner, não por mr.team1.
          const posT1Won = team1Sets > team2Sets;
          if (posT1Won !== winnerIs1) { [team1Sets, team2Sets] = [team2Sets, team1Sets]; }
        } else {
          const parsedMaps = _parseEsportsMapScore(mr.final_score);
          if (!parsedMaps) { skipped++; continue; }
          team1Sets = winnerIs1 ? parsedMaps.winnerMaps : parsedMaps.loserMaps;
          team2Sets = winnerIs1 ? parsedMaps.loserMaps : parsedMaps.winnerMaps;
          actualBoFromScore = parsedMaps.bestOf;
        }
        // BUG FIX 2026-04-26 (esports handicap): Pinnacle às vezes priça linha pra
        // Bo5 mas série real foi Bo3 → linha pode ficar fora do range possível
        // (deterministicamente cover ou fail). Livro voida nesse cenário.
        // Detect: maxMargin = ceil(bo/2) — Bo3=2, Bo5=3, Bo7=4. Line trivial se
        // |line| >= maxMargin + 0.5. Tambem: shadow.best_of != actual bestOf = void.
        const sideIsT1 = t.side === 'team1' || t.side === 'home';
        if (t.sport !== 'tennis' && Number.isFinite(t.line)) {
          const bo = actualBoFromScore || t.best_of || null;
          if (bo && bo > 0) {
            // bestOf mismatch: scanner priçou com bo=X, real foi bo=Y → void
            if (t.best_of && actualBoFromScore && t.best_of !== actualBoFromScore) {
              log('INFO', 'MT-SHADOW',
                `void ${t.market} ${t.team1} vs ${t.team2}: scanner Bo${t.best_of} ≠ real Bo${actualBoFromScore}`);
              result = 'void';
            }
            if (!result) {
              const maxMargin = Math.ceil(bo / 2);
              if (Math.abs(t.line) > maxMargin) {
                log('INFO', 'MT-SHADOW',
                  `void ${t.market} ${t.team1} vs ${t.team2}: line=${t.line} fora do range Bo${bo} (max margin ±${maxMargin})`);
                result = 'void';
              }
            }
          }
        }
        if (!result) {
          const team1Diff = team1Sets - team2Sets;
          const covers = sideIsT1 ? (team1Diff + t.line > 0) : (-team1Diff + t.line > 0);
          result = covers ? 'win' : 'loss';
        }
      } else if (t.market === 'total') {
        // Total de MAPS em esports (Bo3 "2-1" → total 3)
        const parsedMaps = _parseEsportsMapScore(mr.final_score);
        if (!parsedMaps) { skipped++; continue; }
        const totalMaps = parsedMaps.winnerMaps + parsedMaps.loserMaps;
        // BUG FIX 2026-04-26: Pinnacle ocasionalmente lista linha pra Bo5 mas
        // série real foi Bo3 (caso CCT Global Finals: HEROIC vs Monte tip
        // "Under 4.5 maps" liquidada como win, mas Bo3 max=3 → under trivial).
        // Voids quando: (a) shadow.best_of != actual bestOf, OU (b) line fora
        // do range possível pro bestOf real (over OU under deterministicamente
        // verdadeiro).
        const bo = parsedMaps.bestOf || t.best_of || null;
        if (bo && bo > 0 && Number.isFinite(t.line)) {
          // bestOf mismatch (scanner priçou Bo X, real foi Bo Y)
          if (t.best_of && parsedMaps.bestOf && t.best_of !== parsedMaps.bestOf) {
            log('INFO', 'MT-SHADOW',
              `void total ${t.team1} vs ${t.team2}: scanner Bo${t.best_of} ≠ real Bo${parsedMaps.bestOf}`);
            result = 'void';
          }
          if (!result) {
            const minTotal = Math.ceil(bo / 2);   // Bo3=2, Bo5=3, Bo1=1
            const maxTotal = bo;                  // Bo3=3, Bo5=5, Bo1=1
            if (t.line >= maxTotal || t.line < minTotal) {
              log('INFO', 'MT-SHADOW',
                `void total ${t.team1} vs ${t.team2}: line=${t.line} fora do range Bo${bo} (totais possíveis ${minTotal}-${maxTotal})`);
              result = 'void';
            }
          }
        }
        if (!result) {
          const over = totalMaps > t.line;
          result = (t.side === 'over') === over ? 'win' : 'loss';
        }
      } else if (t.market === 'totalGames') {
        // Tennis total de GAMES (soma todos os sets)
        const parsed = parseTennisScore(mr.final_score);
        if (!parsed) { skipped++; continue; }
        const over = parsed.totalGames > t.line;
        result = (t.side === 'over') === over ? 'win' : 'loss';
      } else if (t.market === 'tiebreakMatch') {
        // Tennis: TB yes/no baseado em se algum set foi 7-6
        const parsed = parseTennisScore(mr.final_score);
        if (!parsed) { skipped++; continue; }
        const wasTB = parsed.hasTiebreak;
        result = (t.side === 'yes') === wasTB ? 'win' : 'loss';
      } else if (t.market === 'draw' && t.sport === 'football') {
        // Football 1X2_D (empate). winner === 'Draw' quando não houve vencedor.
        const isDraw = /^draw$/i.test(String(mr.winner || '').trim());
        result = isDraw ? 'win' : 'loss';
      } else if (t.market === 'totals' && t.sport === 'football') {
        // Football OVER_2.5 / UNDER_2.5. final_score "H-A" (ex: "2-1").
        const m = String(mr.final_score || '').match(/^\s*(\d+)\s*[-–]\s*(\d+)/);
        if (!m) { skipped++; continue; }
        const totalGoals = parseInt(m[1], 10) + parseInt(m[2], 10);
        const line = Number(t.line) || 2.5;
        const over = totalGoals > line;
        result = (t.side === 'over') === over ? 'win' : 'loss';
      } else if (
        ['lol','dota2','cs2','valorant'].includes(t.sport) &&
        /^map(\d+)?winner$/i.test(String(t.market || ''))
      ) {
        // MAP{N}_WINNER settler via sweep detection. shadowRow.market pode ser
        // 'mapWinner' (legacy, assume map1) ou 'map1Winner'/'map2Winner'/etc.
        // Non-sweep deixa skipped — precisa per-map data (não disponível em
        // match_results.final_score). Cleanup #2 voida após 7d se persistir.
        const mapMatch = String(t.market).match(/^map(\d+)/i);
        const mapN = mapMatch && mapMatch[1] ? parseInt(mapMatch[1], 10) : 1;
        // side='team1'/'home' → tip é no shadow.team1; precisamos saber se
        // shadow.team1 é o series winner (winnerIs1 já calculado acima).
        const sideIsT1 = t.side === 'team1' || t.side === 'home';
        const pickIsSeriesWinner = sideIsT1 ? winnerIs1 : !winnerIs1;
        const r = settleMapWinnerFromSweep(mapN, mr.final_score, pickIsSeriesWinner);
        if (r.result == null) {
          log('DEBUG', 'MT-SHADOW', `mapWinner skip ${t.team1} vs ${t.team2}: ${r.reason} (score='${mr.final_score}')`);
          skipped++; continue;
        }
        result = r.result;
      } else {
        // correctScore / totalAces / props — settlement requer dados extras (aces/score
        // parseado) não ingeridos. Cleanup acima marca result='void' após 14d.
        skipped++;
        continue;
      }

      const profit = result === 'win'
        ? ((t.stake_units || 1) * (t.odd - 1))
        : result === 'void' ? 0
        : -(t.stake_units || 1);

      // Forensic log unificado pra TODOS os markets — mesma camada do propagator.
      // Permite auditoria forense de qualquer settlement decision sem precisar
      // re-executar o cálculo. Inclui: market, side, line, mr_id, score, mrT1IsShadow,
      // result final, profit. Cobre handicap/total/totalGames/tiebreak/draw/totals.
      log('INFO', 'MT-SETTLE-FORENSIC',
        `shadow#${t.id} ${t.sport}/${t.market}/${t.side ?? '-'} line=${t.line ?? '-'} ` +
        `mr=${mr.match_id} score='${mr.final_score || ''}' mrT1IsShadow=${mrT1IsShadowT1} ` +
        `winner='${mr.winner}' → ${result} profit_u=${profit.toFixed(2)} odd=${t.odd}`);

      db.prepare(`
        UPDATE market_tips_shadow SET result = ?, settled_at = datetime('now'), profit_units = ?
        WHERE id = ?
      `).run(result, profit, t.id);
      // Fallback CLV: se mercado nunca moveu (close_odd nunca foi capturado),
      // grava close_odd = open_odd no settle. CLV=0% é dado válido ("market
      // estável") em vez de NULL ("desconhecido"). Resolve gap em football onde
      // BR books pre-match raramente movem ≥0.005.
      if (t.close_odd == null && Number.isFinite(Number(t.odd)) && Number(t.odd) > 1) {
        try {
          db.prepare(`
            UPDATE market_tips_shadow
            SET close_odd = ?, clv_pct = 0, close_captured_at = datetime('now')
            WHERE id = ? AND close_odd IS NULL
          `).run(Number(t.odd), t.id);
        } catch (_) { /* non-blocking */ }
      }
      settled++;

      // Propaga resultado pra tips "regular" se foi promovido (recordMarketTipAsRegular).
      // Match-id sintético = `${match.id}::mt::${market}::${side}` (legacy: também aceita
      // matches por team1/team2+market_type+sport+pending). Atualiza result + odds settle.
      try {
        const _propagateMtResultToTips = require('./mt-result-propagator');
        _propagateMtResultToTips(db, t, result, profit);
      } catch (_) { /* propagator opcional, não bloqueia settle */ }
    } catch (e) {
      log('DEBUG', 'MT-SHADOW', `settle err id=${t.id}: ${e.message}`);
      skipped++;
    }
  }
  // Metrics: timing total + counters de outcomes — visibilidade via /health/metrics.
  try {
    const m = require('./metrics');
    const dt = Date.now() - _t0;
    m.timing('settle_shadow_ms', dt);
    if (settled > 0) m.incr('settle_shadow_settled', null, settled);
    if (skipped > 0) m.incr('settle_shadow_skipped', null, skipped);
  } catch (_) {}
  return { settled, skipped };
}

/**
 * Stats agregados pra report. Agrupa por (sport, market).
 */
function getShadowStats(db, opts = {}) {
  const days = opts.days ?? 30;
  const sport = opts.sport || null;
  const groupBySide = !!opts.bySide;
  const groupByLeague = !!opts.byLeague;
  const filter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  const groupCols = ['sport', 'market'];
  if (groupBySide) groupCols.push('side');
  if (groupByLeague) groupCols.push('league');
  const groupClause = groupCols.join(', ');
  const extraSelect = (groupBySide ? ', side' : '') + (groupByLeague ? ', league' : '');
  const leagueFilter = groupByLeague ? `AND league IS NOT NULL AND TRIM(league) != ''` : '';
  const rows = db.prepare(`
    SELECT sport, market${extraSelect},
      COUNT(*) AS n,
      SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result IN ('win','loss') THEN 1 ELSE 0 END) AS settled,
      AVG(ev_pct) AS avg_ev,
      SUM(COALESCE(profit_units, 0)) AS total_profit,
      SUM(CASE WHEN result IN ('win','loss') THEN COALESCE(stake_units, 1) ELSE 0 END) AS total_stake,
      SUM(CASE WHEN clv_pct IS NOT NULL THEN 1 ELSE 0 END) AS clv_n,
      AVG(clv_pct) AS avg_clv,
      SUM(CASE WHEN clv_pct > 0 THEN 1 ELSE 0 END) AS clv_positive
    FROM market_tips_shadow
    WHERE created_at >= datetime('now', '-${days} days')
      ${filter}
      ${leagueFilter}
    GROUP BY ${groupClause}
    ORDER BY n DESC
  `).all();
  return rows.map(r => ({
    sport: r.sport,
    market: r.market,
    ...(groupBySide ? { side: r.side } : {}),
    ...(groupByLeague ? { league: r.league } : {}),
    n: r.n,
    settled: r.settled,
    hitRate: r.settled > 0 ? +(r.wins / r.settled * 100).toFixed(1) : null,
    avgEv: +(r.avg_ev || 0).toFixed(2),
    totalProfit: +r.total_profit.toFixed(2),
    roiPct: r.total_stake > 0 ? +(r.total_profit / r.total_stake * 100).toFixed(2) : null,
    clvN: r.clv_n || 0,
    avgClv: r.clv_n > 0 ? +(r.avg_clv || 0).toFixed(2) : null,
    clvPositivePct: r.clv_n > 0 ? +((r.clv_positive / r.clv_n) * 100).toFixed(1) : null,
  }));
}

/**
 * Check se há tip shadow registrada com admin DM enviado nas últimas `hoursAgo` horas
 * pra esta combinação de (match_key, market, line, side). Backstop persistente
 * pro dedup in-memory que se perde em restart.
 *
 * @returns {boolean}
 */
function wasAdminDmSentRecently(db, { sport, match, market, line, side, hoursAgo = 24 }) {
  try {
    if (!db || !match) return false;
    if (!sport && match.sport) sport = match.sport;
    const t1n = _normStrict(match.team1), t2n = _normStrict(match.team2);
    if (!t1n || !t2n) return false;
    // 2026-04-28: opt-in pra incluir line no dedup. Default off (mantém PK existente
    // que ignora line — comentário migration 062 explica). Quando MT_DEDUP_INCLUDE_LINE=true,
    // exige match exato em (market, side, line) — útil quando markets estáveis com lines
    // múltiplas independentes (ex: tennis totalGames 22.5 vs 24.5 são tips distintas).
    const _includeLine = /^(1|true|yes)$/i.test(String(process.env.MT_DEDUP_INCLUDE_LINE || ''));
    const _lineCheck = (_includeLine && line != null && Number.isFinite(Number(line)))
      ? ` AND ABS(COALESCE(last_line, 99999) - ?) < 0.01`
      : '';
    const _lineParam = _includeLine && line != null ? [Number(line)] : [];
    // Primary: tabela dedicada market_tip_dm_sent (migration 062). Independente de
    // shadow lifecycle (UPGRADE, result settlement, void) que falhava em zerar
    // dedup. Order-invariant via OR.
    try {
      const row = db.prepare(`
        SELECT 1 FROM market_tip_dm_sent
        WHERE sport = ?
          AND ((team1_norm = ? AND team2_norm = ?) OR (team1_norm = ? AND team2_norm = ?))
          AND market = ? AND side IS ?${_lineCheck}
          AND last_dm_at >= datetime('now', ?)
        LIMIT 1
      `).get(sport || 'lol', t1n, t2n, t2n, t1n, market, side ?? null, ..._lineParam, `-${hoursAgo} hours`);
      if (row) return true;
    } catch (eDed) {
      // Tabela não existe (migration 062 ainda não rodou) — segue pro fallback.
      if (!/no such table/i.test(eDed.message)) {
        log('DEBUG', 'MT-SHADOW', `dmCheck dedicated err: ${eDed.message}`);
      }
    }
    // Fallback legacy: lê admin_dm_sent_at do shadow. Mantido pra cobrir ambiente
    // pré-062 ou se a tabela dedicada perder rows.
    const sportFilter = sport ? `AND sport = ?` : '';
    const T1 = "lower(REPLACE(REPLACE(REPLACE(REPLACE(team1,' ',''),'-',''),'.',''),'''',''))";
    const T2 = "lower(REPLACE(REPLACE(REPLACE(REPLACE(team2,' ',''),'-',''),'.',''),'''',''))";
    const args = sport
      ? [t1n, t2n, t2n, t1n, market, side ?? null, sport, `-${hoursAgo} hours`]
      : [t1n, t2n, t2n, t1n, market, side ?? null, `-${hoursAgo} hours`];
    const row = db.prepare(`
      SELECT id FROM market_tips_shadow
      WHERE ((${T1} = ? AND ${T2} = ?) OR (${T1} = ? AND ${T2} = ?))
        AND market = ? AND side IS ?
        ${sportFilter}
        AND admin_dm_sent_at IS NOT NULL
        AND admin_dm_sent_at >= datetime('now', ?)
      LIMIT 1
    `).get(...args);
    return !!row;
  } catch (e) {
    log('DEBUG', 'MT-SHADOW', `dmCheck err: ${e.message}`);
    return false;
  }
}

/**
 * Marca que admin DM foi enviado pra este tip. Atualiza a row mais recente
 * (última 12h) com timestamp atual. Mesma chave que logShadowTip/wasAdminDmSentRecently.
 */
function markAdminDmSent(db, { sport, match, market, line, side, odd, ev }) {
  try {
    if (!db || !match) return false;
    if (!sport && match.sport) sport = match.sport;
    const t1n = _normStrict(match.team1), t2n = _normStrict(match.team2);
    if (!t1n || !t2n) return false;
    // Primary: upsert na tabela dedicada (migration 062). Source-of-truth pro dedup.
    try {
      db.prepare(`
        INSERT INTO market_tip_dm_sent
          (sport, team1_norm, team2_norm, market, side, last_dm_at, last_line, last_odd, last_ev_pct)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
        ON CONFLICT (sport, team1_norm, team2_norm, market, side) DO UPDATE SET
          last_dm_at = excluded.last_dm_at,
          last_line = excluded.last_line,
          last_odd = excluded.last_odd,
          last_ev_pct = excluded.last_ev_pct
      `).run(
        sport || 'lol', t1n, t2n, market, side ?? null,
        line ?? null, odd ?? null, ev ?? null,
      );
    } catch (eDed) {
      if (!/no such table/i.test(eDed.message)) {
        log('DEBUG', 'MT-SHADOW', `markDm dedicated err: ${eDed.message}`);
      }
    }
    // Mantém escrita no shadow row pra UI/audit/visibility (admin_dm_sent_at
    // continua sendo consultado em /admin/mt-recompute-stakes, etc).
    const sportFilter = sport ? `AND sport = ?` : '';
    const T1 = "lower(REPLACE(REPLACE(REPLACE(REPLACE(team1,' ',''),'-',''),'.',''),'''',''))";
    const T2 = "lower(REPLACE(REPLACE(REPLACE(REPLACE(team2,' ',''),'-',''),'.',''),'''',''))";
    const args = sport
      ? [t1n, t2n, t2n, t1n, market, side ?? null, sport]
      : [t1n, t2n, t2n, t1n, market, side ?? null];
    const res = db.prepare(`
      UPDATE market_tips_shadow
      SET admin_dm_sent_at = datetime('now')
      WHERE id = (
        SELECT id FROM market_tips_shadow
        WHERE ((${T1} = ? AND ${T2} = ?) OR (${T1} = ? AND ${T2} = ?))
          AND market = ? AND side IS ?
          ${sportFilter}
          AND created_at >= datetime('now', '-12 hours')
        ORDER BY created_at DESC
        LIMIT 1
      )
    `).run(...args);
    return res.changes > 0;
  } catch (e) {
    log('DEBUG', 'MT-SHADOW', `markDm err: ${e.message}`);
    return false;
  }
}

module.exports = { logShadowTip, settleShadowTips, getShadowStats, parseTennisScore, settleMapWinnerFromSweep, wasAdminDmSentRecently, markAdminDmSent };
