'use strict';

/**
 * market-tip-processor.js — processa tips detectadas pelos market scanners
 * (handicap, totals, aces etc) e formata pra DM admin.
 *
 * MVP: admin-only DM (não subscribers). Validação 1-2 semanas antes de escalar.
 *
 * Responsabilidades:
 *   - shouldSendMarketTip(tip, ctx): gate (EV mín, correlação com ML tip, dedup).
 *   - selectBestMarketTip(tips, mlDirection): escolhe 1 market tip complementar.
 *   - buildMarketTipDM(match, tip, stake, league): formata mensagem Telegram.
 *
 * Correlação — evita tip redundante com ML:
 *   ML team1 + Handicap -1.5 team1: CORRELATED (ambos exigem team1 forte) → penaliza
 *   ML team1 + Over 2.5 maps: INDEPENDENT (match longo ≠ team1 forte) → ok
 *   ML team1 + Under 2.5 maps: ANTI-CORRELATED (sweep mais provável se team1 MUITO forte) → ok
 *
 * Dedup: caller é responsável por tracking (match, market, line, side) chave.
 */

const DEFAULT_MIN_EV = 8;           // threshold EV pct — markets exigem mais que ML (baseline 4)
const DEFAULT_MIN_PMODEL = 0.55;    // só pick lado com ≥55% prob (evita extreme longshots)
const MAX_KELLY_FRAC = 0.10;        // Kelly 10% — conservador pra markets novos
// Cap hard de stake independente do Kelly. Motivo: quando pModel extremo (ex: 85%+
// em Markov R1 tennis onde histórico cross-player é magro), Kelly 0.10 frac ainda
// gera 4-5u (=4-5% da banca) numa tip de MVP em validação. Limita blow-up risk
// durante as primeiras semanas. Override: MARKET_TIP_MAX_STAKE_UNITS=N no .env.
const DEFAULT_MAX_STAKE_UNITS = 2;
// Ceiling de EV — tips com EV muito alto em markets (ex: >25%) tipicamente
// refletem overconfidence do modelo (Markov tennis R1 sem histórico, Poisson
// football com médias inflated). Dados shadow mostram: over 20+ EV ROI -8%
// vs over 15-20 EV ROI +17%. Override: MARKET_TIP_MAX_EV=N no .env.
const DEFAULT_MAX_EV = 25;

/**
 * Filtra um tip candidato. Retorna motivo se rejeitado.
 */
function shouldSendMarketTip(tip, ctx = {}) {
  const { minEv = DEFAULT_MIN_EV, minPmodel = DEFAULT_MIN_PMODEL, mlDirection = null, mlPick = null } = ctx;
  const maxEvEnv = parseFloat(process.env.MARKET_TIP_MAX_EV);
  const maxEv = Number.isFinite(maxEvEnv) && maxEvEnv > minEv ? maxEvEnv : DEFAULT_MAX_EV;

  if (!tip || !Number.isFinite(tip.ev) || tip.ev < minEv) {
    return { ok: false, reason: `EV ${tip?.ev?.toFixed(1) || '?'}% < ${minEv}%` };
  }
  if (tip.ev > maxEv) {
    return { ok: false, reason: `EV ${tip.ev.toFixed(1)}% > ${maxEv}% (suspeito — modelo overconfident)` };
  }
  if (!Number.isFinite(tip.pModel) || tip.pModel < minPmodel) {
    return { ok: false, reason: `pModel ${(tip?.pModel * 100)?.toFixed(1) || '?'}% < ${minPmodel * 100}%` };
  }

  // Correlação check: evita handicap do MESMO lado que ML pick
  // (redundante — se team1 já picked em ML, handicap -1.5 team1 adiciona ruído)
  if (tip.market === 'handicap' && mlDirection && mlPick) {
    // Scanner emite side='team1'|'team2' (pós-swap já reorientado).
    // Legacy fallback: 'home'→team1, 'away'→team2.
    const tipTeam = tip.side === 'team1' || tip.side === 'home' ? 'team1' : 'team2';
    if (tip.line < 0 && tipTeam === mlDirection) {
      return { ok: false, reason: `correlated com ML pick ${mlDirection} (handicap ${tip.line})` };
    }
  }
  return { ok: true, reason: null };
}

/**
 * De uma lista de tips sorted por EV desc, retorna o melhor que passa nos gates.
 */
function selectBestMarketTip(tips, ctx = {}) {
  if (!Array.isArray(tips) || !tips.length) return null;
  for (const t of tips) {
    const gate = shouldSendMarketTip(t, ctx);
    if (gate.ok) return { tip: t, reason: null };
  }
  return { tip: null, reason: 'no tip passed gates' };
}

/**
 * Snap stake em múltiplos de 0.5u (0.5 / 1.0 / 1.5 / 2.0 / ...).
 * Motivo: stakes tipo 1.28u ficam feios no DM e são ruído — usuário opera em
 * incrementos de meio unit. Stakes <0.5u são descartadas (edge fraco).
 */
function snapStakeUnits(units) {
  if (!Number.isFinite(units) || units < 0.5) return 0;
  return Math.round(units * 2) / 2;
}

/**
 * Kelly reduzido pra markets novos. 0.10 Kelly fracionário sobre a banca.
 * Retorna units (assumindo 100u banca), snap em 0.5u.
 */
function kellyStakeForMarket(pModel, odd, totalBankrollUnits = 100, kellyFrac = MAX_KELLY_FRAC, opts) {
  if (!Number.isFinite(pModel) || !Number.isFinite(odd) || pModel <= 0 || odd <= 1) return 0;
  // Kelly full = (p×(odd-1) - (1-p)) / (odd-1) = (p×odd - 1) / (odd - 1)
  const b = odd - 1;
  const q = 1 - pModel;
  const fullKelly = (pModel * b - q) / b;
  if (fullKelly <= 0) return 0;
  // 2026-05-01: EV→ROI calibration data-driven (lib/ev-calibration). Mesmo
  // path do _applyKelly em lib/utils.js — calibration sobrescreve throttle
  // hardcoded quando bucket (sport,EV) tem n>=10 settled.
  const evPct = (pModel * odd - 1) * 100;
  let evMult = 1;
  let calibHit = false;
  try {
    const evCalib = require('./ev-calibration');
    const m = evCalib.getEvCalibrationMult(opts && opts.sport, evPct);
    if (Number.isFinite(m) && m > 0 && m <= 1) {
      evMult = m;
      calibHit = true;
    }
  } catch (_) {}
  if (!calibHit && !/^(0|false|no)$/i.test(String(process.env.HIGH_EV_THROTTLE ?? ''))) {
    const trigger = parseFloat(process.env.HIGH_EV_THROTTLE_THRESHOLD ?? '8');
    const mult = parseFloat(process.env.HIGH_EV_THROTTLE_MULT ?? '0.6');
    if (Number.isFinite(evPct) && evPct > trigger
        && Number.isFinite(mult) && mult > 0 && mult <= 1) {
      evMult = mult;
    }
  }
  const fractional = fullKelly * kellyFrac * evMult;
  let units = fractional * totalBankrollUnits;
  // Cap hard — evita stake extremo em pModel ≥80% (ex: Markov tennis R1 overconfident).
  const capEnv = parseFloat(process.env.MARKET_TIP_MAX_STAKE_UNITS);
  const cap = Number.isFinite(capEnv) && capEnv > 0 ? capEnv : DEFAULT_MAX_STAKE_UNITS;
  if (units > cap) units = cap;
  return snapStakeUnits(units);
}

/**
 * Formata mensagem Telegram pra market tip.
 */
function buildMarketTipDM({ match, tip, stake, league, sport, isLive = false, markets = null }) {
  const emoji = { handicap: '🎯', total: '📊', totalGames: '📊', handicapSets: '🎯', handicapGames: '🎯',
    tiebreakMatch: '⚡', totalAces: '🔥', totalSets: '📏', draw: '🤝', totals: '📊' }[tip.market] || '💹';
  const sportLabel = { lol: 'LoL', dota2: 'Dota 2', cs2: 'CS2', tennis: 'Tennis', football: 'Futebol' }[sport] || sport;
  // LIVE tag explícito — caller decide via `isLive`. Garante que receptor
  // saiba que mercado é in-play (odds movem rapidamente, exec-risk maior).
  const liveTag = isLive ? ' 🔴 *LIVE*' : '';

  const pImpliedStr = tip.pImplied ? `${(tip.pImplied * 100).toFixed(1)}%` : '?';
  const pModelStr = `${(tip.pModel * 100).toFixed(1)}%`;

  // Resolve nome real do pick + contexto home/away. Substitui strings genéricas
  // "team1/team2/home/away" nos labels do scanner por nomes reais do match.
  const side = String(tip.side || '').toLowerCase();
  const isTeam1 = side === 'team1' || side === 'home' || side === 'h';
  const isTeam2 = side === 'team2' || side === 'away' || side === 'a';
  const pickName = isTeam1 ? match.team1 : isTeam2 ? match.team2 : null;
  const sideTag = isTeam1 ? ' (home)' : isTeam2 ? ' (away)' : '';

  // Formata label humano por market. Sempre inclui pick name + contexto home/away
  // quando aplicável. Mantém line no caso de handicap/totals.
  let prettyLabel;
  if (tip.market === 'handicap' || tip.market === 'handicapSets' || tip.market === 'handicapGames') {
    const lineStr = Number.isFinite(tip.line) ? `${tip.line >= 0 ? '+' : ''}${tip.line}` : '';
    const mktWord = tip.market === 'handicapSets' ? 'sets'
                  : tip.market === 'handicapGames' ? 'games'
                  : 'maps';
    prettyLabel = `${pickName || 'team?'}${sideTag} handicap ${lineStr} ${mktWord}`;
  } else if (tip.market === 'total' || tip.market === 'totals' || tip.market === 'totalGames') {
    const unit = tip.market === 'totalGames' ? 'games' : tip.market === 'total' ? 'maps' : 'gols';
    const dir = side === 'over' ? 'Over' : side === 'under' ? 'Under' : 'Total';
    prettyLabel = `${dir} ${tip.line} ${unit}`;
  } else if (tip.market === 'draw') {
    prettyLabel = `Empate (1X2 D) — ${match.team1} × ${match.team2}`;
  } else if (tip.market === 'tiebreakMatch') {
    prettyLabel = side === 'yes' ? 'Tiebreak SIM no match' : 'Tiebreak NÃO no match';
  } else if (tip.market === 'totalAces') {
    const dir = side === 'over' ? 'Over' : 'Under';
    prettyLabel = `${dir} ${tip.line} aces totais`;
  } else {
    prettyLabel = tip.label || `${tip.market} ${side}`;
  }

  // Linha separada com pick destacado quando aplicável (home/away clarity).
  const pickLine = pickName
    ? `🎯 Pick: *${pickName}*${sideTag}\n`
    : (side === 'over' || side === 'under')
      ? `🎯 Pick: *${side === 'over' ? 'OVER' : 'UNDER'}* (total do match)\n`
      : side === 'd' || tip.market === 'draw' ? `🎯 Pick: *EMPATE*\n`
      : '';

  // Alternativas Pinnacle: quando o caller passa `markets` (objeto raw do
  // /odds-markets), lista todas as linhas disponíveis pro market do tip.
  // Motivo (audit 2026-04-26): user reportou tip @ 1.46 em handicap -3.5 mas
  // site Pinnacle só mostrava -4.5 como principal — -3.5 existe como alternativa.
  // Listar todas evita confusão "isso é bug?".
  let altLines = '';
  try {
    if (markets && (tip.market === 'handicapGames' || tip.market === 'handicap')) {
      const arr = markets.gamesHandicaps || markets.handicaps || [];
      const sameSide = arr.filter(h => Number.isFinite(h.line));
      if (sameSide.length >= 2) {
        const oddKey = isTeam1 ? 'oddsHome' : 'oddsAway';
        const sorted = [...sameSide].sort((a, b) => a.line - b.line);
        const rows = sorted.map(h => {
          const o = parseFloat(h[oddKey]);
          if (!Number.isFinite(o)) return null;
          const sign = h.line >= 0 ? '+' : '';
          const isSelected = Math.abs(h.line - tip.line) < 0.01;
          return `  ${isSelected ? '→' : ' '} ${sign}${h.line} @ ${o.toFixed(3)}${isSelected ? ' ← seu pick' : ''}`;
        }).filter(Boolean);
        if (rows.length >= 2) altLines = `\n*Linhas Pinnacle (${pickName || 'pick'}):*\n${rows.join('\n')}\n`;
      }
    } else if (markets && (tip.market === 'totalGames' || tip.market === 'total' || tip.market === 'totals')) {
      const arr = markets.gamesTotals || markets.totals || [];
      const sameSide = arr.filter(t => Number.isFinite(t.line));
      if (sameSide.length >= 2) {
        const oddKey = side === 'over' ? 'oddsOver' : 'oddsUnder';
        const sorted = [...sameSide].sort((a, b) => a.line - b.line);
        const rows = sorted.map(t => {
          const o = parseFloat(t[oddKey]);
          if (!Number.isFinite(o)) return null;
          const isSelected = Math.abs(t.line - tip.line) < 0.01;
          const dir = side === 'over' ? 'O' : 'U';
          return `  ${isSelected ? '→' : ' '} ${dir} ${t.line} @ ${o.toFixed(3)}${isSelected ? ' ← seu pick' : ''}`;
        }).filter(Boolean);
        if (rows.length >= 2) altLines = `\n*Linhas Pinnacle (${side}):*\n${rows.join('\n')}\n`;
      }
    }
  } catch (_) {}

  // Horário do match (BRT). Sem isso fica difícil distinguir tips do mesmo
  // par em janelas próximas (R1 vs R3, dia diferente, etc).
  let timeLine = '';
  try {
    if (match?.time) {
      const dt = new Date(match.time);
      if (!isNaN(dt.getTime())) {
        const fmt = dt.toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          day: '2-digit', month: '2-digit',
          hour: '2-digit', minute: '2-digit',
        });
        timeLine = `🕐 ${fmt} (BRT)\n`;
      }
    }
  } catch (_) { /* ignore */ }

  return `${emoji} *MARKET TIP* — ${sportLabel}${liveTag}\n\n` +
    `⚔️ *${match.team1}* (home) vs *${match.team2}* (away)\n` +
    `📋 ${league || match.league || '-'}\n` +
    timeLine + `\n` +
    pickLine +
    `*${prettyLabel}* @ *${tip.odd.toFixed(2)}*\n\n` +
    `📈 EV: *+${tip.ev.toFixed(1)}%*\n` +
    `🎲 P modelo: ${pModelStr} (implícita: ${pImpliedStr})\n` +
    `💰 Stake: *${stake}u* (Kelly 0.10 fracionário)\n` +
    altLines +
    `\n_Market scanner (admin-only MVP). Validação 1-2 semanas antes de liberar pra subscribers._`;
}

/**
 * Builds Pinnacle event URL pra abrir o match diretamente no site.
 * Requer match.id no formato {sport}_pin_{numericId} (Pinnacle source).
 * Pra outros sources (Sofascore, ESPN) retorna null — fallback search URL.
 */
function buildPinnacleMatchUrl({ match, sport }) {
  if (!match) return null;
  const id = String(match.id || '');
  // Extract numeric Pinnacle event ID. Formato típico: tennis_pin_1629401554.
  const numMatch = id.match(/(?:^|_)(\d{6,})/);
  const eventId = numMatch ? numMatch[1] : null;
  // Mapeia sport pra path Pinnacle. Pinnacle usa "esports" pra todos LoL/Dota/CS/Val.
  const sportPath = {
    tennis: 'tennis',
    lol: 'esports', dota2: 'esports', cs2: 'esports', valorant: 'esports',
    football: 'soccer', mma: 'mma',
  }[sport] || 'sports';
  if (eventId) {
    return `https://www.pinnacle.com/en/${sportPath}/matchups/${eventId}/`;
  }
  // Fallback: pesquisa por team name (não pre-fill mas ajuda achar)
  const q = encodeURIComponent(`${match.team1 || ''} ${match.team2 || ''}`.trim());
  return q ? `https://www.pinnacle.com/en/search/?query=${q}` : null;
}

/**
 * Constrói reply_markup Telegram com botão "Abrir Pinnacle".
 * User clica → Pinnacle abre página do match → seleciona market manualmente.
 * Não pre-fill stake (Pinnacle não suporta), mas economiza navegação.
 */
function buildMarketTipReplyMarkup({ match, sport }) {
  const url = buildPinnacleMatchUrl({ match, sport });
  if (!url) return null;
  return {
    inline_keyboard: [[
      { text: '🎯 Abrir no Pinnacle', url },
    ]],
  };
}

module.exports = {
  shouldSendMarketTip,
  selectBestMarketTip,
  kellyStakeForMarket,
  snapStakeUnits,
  buildMarketTipDM,
  buildPinnacleMatchUrl,
  buildMarketTipReplyMarkup,
  DEFAULT_MIN_EV,
  DEFAULT_MIN_PMODEL,
  MAX_KELLY_FRAC,
  DEFAULT_MAX_STAKE_UNITS,
  DEFAULT_MAX_EV,
};
