/**
 * settle-message-builder.js — Helper unificado para formatar mensagens de tip
 * settled (win/loss/void/push) enviadas via Telegram.
 *
 * Substitui o template inline em bot.js notifySettledTips (linha ~5169).
 *
 * Princípios:
 *  - Números (odd/profit/stake) saem EXATAMENTE como recebidos (formatBR R$X,XX)
 *  - Slang de resultado vem de lib/tipster-slang.js (determinístico por seed)
 *  - "chumbo grosso" aparece em loss context (Fase 2 — explicit user request)
 *  - Footer preserva +18 + responsabilidade (regulatório)
 *  - Cross-sport por construção (P5)
 */

const { pickSlang } = require('./tipster-slang');
const { SPORT_META } = require('./tip-message-builder');

// Label e emoji por resultado
const RESULT_META = {
  win:  { label: 'VITÓRIA', emoji: '✅', slangContext: 'result_win'  },
  loss: { label: 'DERROTA', emoji: '❌', slangContext: 'result_loss' },
  void: { label: 'VOID',    emoji: '⚪', slangContext: 'result_void' },
  push: { label: 'PUSH',    emoji: '🟦', slangContext: 'result_push' },
};

/**
 * Formata número em R$ brasileiro (vírgula decimal, sem símbolo de unidade).
 *  formatBR(12.75) → "12,75"
 *  formatBR(-15)   → "-15,00"
 */
function _formatBR(n) {
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2).replace('.', ',');
}

/**
 * buildSettleMessage(opts) → string Telegram-ready (markdown).
 *
 * opts: {
 *   sport, result, match{team1,team2,league}, pick, marketType?,
 *   odd?, profit?, stake?, isLive?, seed?, sportIconOverride?
 * }
 */
function buildSettleMessage(opts) {
  const o = opts || {};
  const result = String(o.result || '').toLowerCase();
  const rmeta = RESULT_META[result] || { label: result.toUpperCase(), emoji: '▫️', slangContext: null };
  const sportMeta = SPORT_META[o.sport] || { icon: '📌', label: String(o.sport || '').toUpperCase() };
  const icon = o.sportIconOverride || sportMeta.icon;
  const seed = String(o.seed || (o.match && (o.match.id || `${o.match.team1}|${o.match.team2}`)) || '');

  const slangCtx = rmeta.slangContext;
  const resultSlang = slangCtx ? pickSlang(slangCtx, seed) : '';
  const liveTag = o.isLive ? ' 🔴 LIVE' : '';

  // Header: "🎾 ✅ VERDÃO! *VITÓRIA* 🔴 LIVE"
  const headerParts = [icon, rmeta.emoji];
  if (resultSlang) headerParts.push(resultSlang);
  headerParts.push(`*${rmeta.label}*`);
  const header = headerParts.join(' ') + liveTag;

  const lines = [header];

  // Matchup + league
  if (o.match && o.match.team1 && o.match.team2) {
    lines.push(`*${o.match.team1}* vs *${o.match.team2}*`);
  }
  if (o.match && o.match.league) {
    lines.push(`📋 ${o.match.league}`);
  }

  // Pick + odd
  if (o.pick) {
    const mkt = String(o.marketType || 'ML').toUpperCase();
    const marketSuffix = (mkt && mkt !== 'ML') ? ` (${mkt})` : '';
    const oddStr = (Number.isFinite(o.odd) && Number(o.odd) > 0)
      ? ` @ ${Number(o.odd).toFixed(2)}`
      : '';
    lines.push(`🎯 Aposta: *${o.pick}*${marketSuffix}${oddStr}`);
  }

  lines.push(''); // espaço

  // Profit line (varia por resultado)
  if (result === 'void' || result === 'push') {
    if (Number.isFinite(o.stake) && Number(o.stake) > 0) {
      const stakeBr = _formatBR(Number(o.stake));
      lines.push(`↩️ Stake devolvida: *R$${stakeBr}*`);
    } else {
      lines.push(`↩️ Stake devolvida`);
    }
  } else if (Number.isFinite(o.profit)) {
    const p = Number(o.profit);
    const sign = p >= 0 ? '+' : '-';
    const profitAbs = _formatBR(Math.abs(p));
    const stakeStr = (Number.isFinite(o.stake) && Number(o.stake) > 0)
      ? ` _(stake R$${_formatBR(Number(o.stake))})_`
      : '';
    lines.push(`💰 P/L: *${sign}R$${profitAbs}*${stakeStr}`);
  }

  // Footer com +18
  const footerSlang = pickSlang('footer_settle', seed)
    || 'Aposte com responsabilidade. +18.';
  lines.push(`⚡ _${footerSlang}_`);

  return lines.join('\n').replace(/\n\n\n+/g, '\n\n'); // collapse triple newlines
}

module.exports = { buildSettleMessage, RESULT_META };
