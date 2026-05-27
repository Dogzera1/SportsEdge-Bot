'use strict';

// 2026-05-08: settle de tips MT-promoted tennis (handicapGames/totalGames/
// tiebreakMatch/handicapSets) que ficaram órfãs porque o pipeline ML em bot.js
// skipa match_id contendo '::mt::' esperando o propagator de market_tips_shadow,
// mas o shadow correspondente pode estar com side oposto (ex: tip home +5.5,
// shadow away -6.5) — propagator nunca casa o suffix.
//
// Diagnóstico (2026-05-08): tip 1514 Altmaier vs Zverev R2 ficou pending 2 dias
// apesar do match estar settled em match_results — bug arquitetural identificado.
//
// Esta lib decoda o match_id e computa o result diretamente do final_score,
// reaproveitando parseTennisScore de market-tips-shadow.js (mesma lógica usada
// pra settlement de shadow rows).

const { parseTennisScore } = require('./market-tips-shadow');

// match_id format: "tennis_pin_<id>::mt::<market>::<side>::ln<P|N><line>"
// Exemplos:
//   tennis_pin_1630148398::mt::handicapGames::home::lnP5.5
//   tennis_pin_1630148386::mt::handicapGames::away::lnN2.5
//   tennis_pin_xxxxx::mt::totalGames::over::lnP22.5
function decodeMtMatchId(matchId) {
  const s = String(matchId || '');
  const idx = s.indexOf('::mt::');
  if (idx < 0) return null;
  const parts = s.slice(idx + 6).split('::');
  if (parts.length < 2) return null;
  const market = parts[0] || null;
  const side = parts[1] || null;
  let line = null;
  if (parts[2]) {
    const m = parts[2].match(/^ln(P|N)?(\d+(?:\.\d+)?)$/);
    if (m) {
      const sign = m[1] === 'N' ? -1 : 1;
      line = sign * parseFloat(m[2]);
    }
  }
  return { market, side, line };
}

// Compute MT result given decoded params + match outcome.
// winnerIs1 = winner is positional team1 (tip.participant1).
// Returns 'win' | 'loss' | 'void' | null (null when impossível parse).
//
// 2026-05-27 walkover/retire guard:
//   Mercados MT tennis (handicapGames/totalGames/tiebreakMatch/handicapSets) são
//   VOID quando a partida não foi completada (RET/W.O./abandoned/disqualified).
//   Pinnacle/Betano/Bet365/etc reembolsam stake — handicap/totals só "stand"
//   se ambos os players completaram a partida. Sem essa guard, parseTennisScore
//   parseava os games até o RET (ex: "6-4 2-1 RET" → 2 sets parsed) e settlava
//   win/loss matematicamente, divergindo do livro.
//   Caso real: Baptiste (RET) vs Wang R2 RG 2026 → HG Wang +1.5/+3.5 marcadas
//   WIN apesar do livro voidar. Mirror do _walkoverRe em server.js:11120 (ML
//   settle path) e market-tips-shadow.js:1307 (shadow path).
// Note: alternatives ordenadas LONGEST-FIRST pra `\b...\b` matchear corretamente.
// "retired" precisa vir antes de "ret" senão engine tenta `\bret\b` e falha em
// "retired" (boundary entre t-i fail) sem backtrack pra alternative mais longa.
// Codebase tem 3 regexes paralelas (server.js:11120 + :22110 + market-tips-shadow.js:1307)
// com cobertura inconsistente — esta é a versão mais inclusiva.
const _MT_WALKOVER_RE = /\b(retired|retirement|retire|retir|ret|w\.?o\.?|walkover|wo|abandoned|cancell?ed|no\s*contest|w\/o|wd\b|withdrew|disqualif|\bdq\b|\bnc\b|overturned|forfeit|forfeited)\b/i;

// Heurística estrutural pra detectar match incompleto quando a data source NÃO
// inclui o token "RET"/"walkover" no final_score (caso real: ESPN/Sofascore às
// vezes só registra o placar parcial — ex: "5-4" pra match retirado mid-set 1).
// Em tênis ANY format (Bo3/Bo5), o vencedor PRECISA ter no MÍNIMO 2 sets completos
// pra a partida ter sido decidida normalmente. Se winner_completed_sets < 2, o
// match não foi legitimamente concluído → walkover/retire implícito → void.
//
// Set completo (regras tennis): max>=6 E (diff>=2 OU 7-6 tiebreak), OU super-TB
// 10-pt (mixed/doubles Slam: max>=10 diff>=2 no último set após 2 sets normais).
function _appearsIncompleteTennisMatch(finalScore) {
  if (!finalScore) return false;
  const s = String(finalScore);
  const setRe = /\b(\d+)-(\d+)(?:\s*\((\d+)\))?/g;
  const sets = [];
  let m;
  while ((m = setRe.exec(s)) !== null) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a > 20 || b > 20) continue;
    sets.push({ t1: a, t2: b, tb: m[3] != null });
  }
  if (sets.length === 0) return false; // sem placar parseável — outro path decide
  let t1Sets = 0, t2Sets = 0;
  for (let i = 0; i < sets.length; i++) {
    const st = sets[i];
    const max = Math.max(st.t1, st.t2);
    const min = Math.min(st.t1, st.t2);
    const isLast = i === sets.length - 1;
    const isSuperTB = isLast && max >= 10 && (max - min) >= 2 && i >= 2;
    const isComplete = isSuperTB || (max >= 6 && ((max - min) >= 2 || (max === 7 && min === 6)));
    if (isComplete) {
      if (st.t1 > st.t2) t1Sets++;
      else if (st.t2 > st.t1) t2Sets++;
    }
  }
  const winnerSets = Math.max(t1Sets, t2Sets);
  return winnerSets < 2;
}

function computeMtResultFromScore({ market, side, line, finalScore, winnerIs1 }) {
  if (!market || !side) return null;

  // Walkover/retire → void. Cobre todos os 4 mercados MT abaixo (handicapGames,
  // totalGames, tiebreakMatch, handicapSets) em ponto único. 2 detecções:
  //   1. Token explícito (RET/W.O./retired/walkover/etc)
  //   2. Estrutural: winner com <2 sets completos = match incompleto silencioso
  if (finalScore) {
    if (_MT_WALKOVER_RE.test(String(finalScore))) return 'void';
    if (_appearsIncompleteTennisMatch(finalScore)) return 'void';
  }

  if (market === 'handicapGames') {
    const parsed = parseTennisScore(finalScore);
    if (!parsed) return null;
    let gamesT1 = 0, gamesT2 = 0;
    for (const st of parsed.sets) { gamesT1 += st.t1; gamesT2 += st.t2; }
    // Alinha pelo winner (final_score é winner-first em ESPN/Sofascore).
    const positionalT1Won = gamesT1 > gamesT2;
    if (positionalT1Won !== winnerIs1) [gamesT1, gamesT2] = [gamesT2, gamesT1];
    const margin = gamesT1 - gamesT2;
    const sideIsT1 = side === 'team1' || side === 'home';
    const ln = Number(line);
    if (!Number.isFinite(ln)) return null;
    const adjMargin = sideIsT1 ? (margin + ln) : (-margin + ln);
    return adjMargin === 0 ? 'void' : (adjMargin > 0 ? 'win' : 'loss');
  }

  if (market === 'totalGames') {
    const parsed = parseTennisScore(finalScore);
    if (!parsed) return null;
    const ln = Number(line);
    if (!Number.isFinite(ln)) return null;
    if (parsed.totalGames === ln) return 'void';
    const over = parsed.totalGames > ln;
    return (side === 'over') === over ? 'win' : 'loss';
  }

  if (market === 'tiebreakMatch') {
    const parsed = parseTennisScore(finalScore);
    if (!parsed) return null;
    return (side === 'yes') === parsed.hasTiebreak ? 'win' : 'loss';
  }

  if (market === 'handicapSets') {
    const parsed = parseTennisScore(finalScore);
    if (!parsed) return null;
    let setsT1 = parsed.t1Sets, setsT2 = parsed.t2Sets;
    const positionalT1Won = setsT1 > setsT2;
    if (positionalT1Won !== winnerIs1) [setsT1, setsT2] = [setsT2, setsT1];
    const margin = setsT1 - setsT2;
    const sideIsT1 = side === 'team1' || side === 'home';
    const ln = Number(line);
    if (!Number.isFinite(ln)) return null;
    const adjMargin = sideIsT1 ? (margin + ln) : (-margin + ln);
    return adjMargin === 0 ? 'void' : (adjMargin > 0 ? 'win' : 'loss');
  }

  return null;
}

module.exports = { decodeMtMatchId, computeMtResultFromScore };
module.exports._MT_WALKOVER_RE = _MT_WALKOVER_RE;
module.exports._appearsIncompleteTennisMatch = _appearsIncompleteTennisMatch;
