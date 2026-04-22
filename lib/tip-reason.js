'use strict';

/**
 * Gerador determinístico de tipReason (explicação narrativa da tip na DM).
 *
 * Motivo: hoje o texto vem da IA (DeepSeek) via `iaResp.split('TIP_ML:')[0]`.
 * Isso cria dependência em API externa só pra UX da DM. Este módulo produz
 * uma frase equivalente usando só dados que já existem no pipeline.
 *
 * Uso:
 *   const reason = buildTipReason({
 *     sport: 'lol',
 *     pickTeam: 'T1',
 *     modelPPick: 0.58,
 *     impliedP: 0.52,
 *     evPct: 11.5,
 *     factors: [
 *       { label: 'Elo', value: '1420 vs 1380 (+40)' },
 *       { label: 'Form', value: 'T1 4V-1D vs GenG 3V-2D' },
 *     ],
 *   });
 *   → "Modelo T1 58% (implied 52%, +6pp edge, EV +11.5%) | Elo 1420 vs 1380 (+40) | Form T1 4V-1D vs GenG 3V-2D"
 *
 * Limite: 160 chars (coluna tip_reason no DB aceita, DM Telegram caps em ~180).
 */

const MAX_LEN = 160;

function clip(s, n = MAX_LEN) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1).trimEnd() + '…';
}

/**
 * @param {object} ctx
 * @param {string} ctx.sport
 * @param {string} ctx.pickTeam
 * @param {number} ctx.modelPPick — P do modelo pra pick (0-1)
 * @param {number} [ctx.impliedP] — P implícita dejuiced da odd (0-1)
 * @param {number} [ctx.evPct]
 * @param {Array<{label: string, value: string}>} [ctx.factors]
 * @param {string} [ctx.stage] — ex "LCK playoffs", "Bo5 final"
 * @returns {string}
 */
function buildTipReason(ctx) {
  if (!ctx || !ctx.pickTeam) return '';
  const parts = [];

  // Headline: pick + modelP
  const pModel = Number.isFinite(ctx.modelPPick) ? (ctx.modelPPick * 100) : null;
  if (pModel != null) {
    let head = `Modelo ${ctx.pickTeam} ${pModel.toFixed(0)}%`;
    if (Number.isFinite(ctx.impliedP)) {
      const impl = ctx.impliedP * 100;
      const edge = pModel - impl;
      head += ` (implied ${impl.toFixed(0)}%, ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pp`;
      if (Number.isFinite(ctx.evPct)) head += `, EV ${ctx.evPct >= 0 ? '+' : ''}${ctx.evPct.toFixed(1)}%`;
      head += ')';
    } else if (Number.isFinite(ctx.evPct)) {
      head += ` (EV ${ctx.evPct >= 0 ? '+' : ''}${ctx.evPct.toFixed(1)}%)`;
    }
    parts.push(head);
  }

  // Factors (top 2-3, não mais pra caber no limite)
  if (Array.isArray(ctx.factors) && ctx.factors.length) {
    const MAX_FACTORS = 3;
    for (const f of ctx.factors.slice(0, MAX_FACTORS)) {
      if (!f?.label || !f?.value) continue;
      parts.push(`${f.label} ${f.value}`);
    }
  }

  // Stage (liga/round)
  if (ctx.stage) parts.push(ctx.stage);

  return clip(parts.join(' | '));
}

/**
 * Extrai factors comuns de esports (LoL/Dota/CS/Val) a partir de um contexto enriquecido.
 * Passe o que tiver — factors ausentes são pulados.
 *
 * @param {object} ctx
 * @param {string} ctx.team1, ctx.team2
 * @param {object} [ctx.elo] — { elo1, elo2, games1, games2 }
 * @param {object} [ctx.form1] — { wins, losses } últimos N
 * @param {object} [ctx.form2]
 * @param {object} [ctx.h2h] — { t1Wins, t2Wins, totalMatches }
 * @param {string} [ctx.sideHint] — ex "Blue side 52.5% WR"
 * @param {number} [ctx.confidence] — 0-1
 */
function esportsFactors(ctx) {
  const out = [];
  if (ctx.elo && Number.isFinite(ctx.elo.elo1) && Number.isFinite(ctx.elo.elo2)) {
    const diff = ctx.elo.elo1 - ctx.elo.elo2;
    out.push({ label: 'Elo', value: `${ctx.elo.elo1}/${ctx.elo.elo2} (${diff >= 0 ? '+' : ''}${diff})` });
  }
  if (ctx.form1 && ctx.form2 && (ctx.form1.wins || ctx.form1.losses || ctx.form2.wins || ctx.form2.losses)) {
    out.push({
      label: 'Form',
      value: `${(ctx.form1.wins || 0)}V-${(ctx.form1.losses || 0)}D vs ${(ctx.form2.wins || 0)}V-${(ctx.form2.losses || 0)}D`,
    });
  }
  if (ctx.h2h?.totalMatches >= 2) {
    out.push({ label: 'H2H', value: `${ctx.h2h.t1Wins || 0}-${ctx.h2h.t2Wins || 0} (${ctx.h2h.totalMatches})` });
  }
  if (ctx.sideHint) out.push({ label: 'Side', value: String(ctx.sideHint).slice(0, 30) });
  return out;
}

/**
 * Factors pra tennis (surface, Elo, rank, fadiga).
 */
function tennisFactors(ctx) {
  const out = [];
  if (ctx.surface) out.push({ label: 'Surf', value: String(ctx.surface) });
  if (ctx.elo && Number.isFinite(ctx.elo.elo1) && Number.isFinite(ctx.elo.elo2)) {
    const diff = ctx.elo.elo1 - ctx.elo.elo2;
    out.push({ label: 'Elo', value: `${Math.round(ctx.elo.elo1)}/${Math.round(ctx.elo.elo2)} (${diff >= 0 ? '+' : ''}${Math.round(diff)})` });
  }
  if (Number.isFinite(ctx.rank1) && Number.isFinite(ctx.rank2)) {
    out.push({ label: 'Rank', value: `#${ctx.rank1} vs #${ctx.rank2}` });
  }
  if (ctx.fatigueDelta) out.push({ label: 'Fadiga', value: String(ctx.fatigueDelta) });
  return out;
}

module.exports = { buildTipReason, esportsFactors, tennisFactors };
