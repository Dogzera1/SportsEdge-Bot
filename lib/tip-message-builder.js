/**
 * tip-message-builder.js — Helper unificado para formatar mensagens de tip real
 * (Telegram DM). Substitui 13 templates inline duplicados em bot.js.
 *
 * Princípios:
 *  - Números (odd/ev/stake/minTake) saem EXATAMENTE como recebidos (não converte/arredonda)
 *  - Linhas opcionais omitem completamente quando campo é falsy (sem "undefined")
 *  - Slang tipster vem de lib/tipster-slang.js (determinístico por seed)
 *  - Footer preserva +18 + responsabilidade (regulatório)
 *  - Cross-sport por construção (P5)
 */

const { pickSlang } = require('./tipster-slang');

// Mapa sport → { icon, label }. lol/cs/dota2/valorant usam gameIcon dinâmico
// quando passado em opts.sportIconOverride.
const SPORT_META = {
  tennis:      { icon: '🎾', label: 'TÊNIS' },
  football:    { icon: '⚽', label: 'FUTEBOL' },
  basket:      { icon: '🏀', label: 'BASKET' },
  mma:         { icon: '🥊', label: 'MMA' },
  darts:       { icon: '🎯', label: 'DARTS' },
  snooker:     { icon: '🎱', label: 'SNOOKER' },
  tabletennis: { icon: '🏓', label: 'TT' },
  lol:         { icon: '🎮', label: 'LOL' },
  cs:          { icon: '🔫', label: 'CS' },
  cs2:         { icon: '🔫', label: 'CS' },
  dota2:       { icon: '🛡️', label: 'DOTA2' },
  valorant:    { icon: '🎯', label: 'VALORANT' },
};

const CONF_EMOJI = { ALTA: '🟢', 'MÉDIA': '🟡', MEDIA: '🟡', BAIXA: '🔴' };

function _confKey(conf) {
  const c = String(conf || '').toUpperCase().replace('MÉDIA', 'MEDIA');
  if (c === 'ALTA') return 'alta';
  if (c === 'MEDIA') return 'media';
  if (c === 'BAIXA') return 'baixa';
  return 'media';
}

/**
 * buildTipMessage(opts) → string Telegram-ready (markdown).
 *
 * opts: {
 *   sport, marketType, match{team1,team2,league}, pick, odd, ev, stake, conf, isLive,
 *   minTake?, reason?, lineShopText?, extraNotes?[], matchTime?, liveScoreLine?,
 *   imminentNote?, kellyLabel?, sportIconOverride?, sportLabelOverride?, seed?,
 *   extraInfoOnEvLine?
 * }
 */
function buildTipMessage(opts) {
  const o = opts || {};
  const meta = SPORT_META[o.sport] || { icon: '💰', label: String(o.sport || 'TIP').toUpperCase() };
  const icon = o.sportIconOverride || meta.icon;
  const label = o.sportLabelOverride || meta.label;
  const seed = String(o.seed || (o.match && (o.match.id || `${o.match.team1}|${o.match.team2}`)) || '');
  const confKey = _confKey(o.conf);

  // Header — varia por confiança e live state.
  // stakeBoosted=true: caller sinaliza que a fração Kelly foi inflada pra esse
  // segmento (ex: tennis HG gold segment ATP 250+EV≥15 boost 0.10→0.15). Nesse caso
  // filtra frases que afirmam "STAKE REDUZIDA" pra evitar mismatch semântico entre
  // header e stake real. Outras frases BAIXA (VAI DE SAFETY, RESPEITA A BANCA,
  // CAUTELA NA LINHA) continuam válidas — tom cauteloso pra pModel < 0.55 OK.
  const headerCtx = o.isLive ? 'header_live' : `header_${confKey}`;
  const headerExclude = (o.stakeBoosted && confKey === 'baixa') ? ['STAKE REDUZIDA'] : null;
  const headerTagline = pickSlang(headerCtx, seed, headerExclude ? { exclude: headerExclude } : undefined);
  const liveFlag = o.isLive ? ' (AO VIVO 🔴)' : '';
  const headerLine = headerTagline
    ? `${icon} 💰 *TIP ${label} — ${headerTagline}*${liveFlag}`
    : `${icon} 💰 *TIP ${label}*${liveFlag}`;

  const lines = [headerLine];

  // Match + league
  if (o.match && o.match.team1 && o.match.team2) {
    lines.push(`*${o.match.team1}* vs *${o.match.team2}*`);
  }
  if (o.match && o.match.league) {
    lines.push(`📋 ${o.match.league}`);
  }
  if (o.matchTime) {
    lines.push(`🕐 ${o.matchTime} (BRT)`);
  }
  if (o.liveScoreLine) {
    // liveScoreLine já vem com prefixo emoji e quebra de linha em alguns callers
    lines.push(String(o.liveScoreLine).replace(/\n$/, ''));
  }

  // Extra notes (sport-specific: surface tennis, format Bo1, org MMA)
  if (Array.isArray(o.extraNotes)) {
    for (const note of o.extraNotes) {
      if (note != null && String(note).trim()) lines.push(String(note));
    }
  }

  lines.push(''); // espaço visual

  // Por quê
  if (o.reason) {
    lines.push(`🧠 Por quê: _${o.reason}_`);
    lines.push('');
  }

  // Aposta — pick + odd. Pick já encoda o mercado (ex: "OVER 2.5", "Celtics -3.5").
  // marketType fica disponível em opts para callers que queiram usar em outro lugar.
  // pickPreFormatted=true quando caller já passa markdown (ex: football marketLabel
  // com "*${team1}*" embedded) — builder NÃO adiciona asteriscos extras.
  const pickRendered = o.pickPreFormatted ? String(o.pick) : `*${o.pick}*`;
  lines.push(`🎯 Aposta: ${pickRendered} @ *${o.odd}*`);

  if (o.minTake) {
    lines.push(`📉 Odd mínima: *${o.minTake}*`);
  }
  if (o.lineShopText) {
    // lineShopText já vem formatado (com emojis + newlines). Strip trailing newline.
    lines.push(String(o.lineShopText).replace(/\n$/, ''));
  }

  // EV + opcional info extra (ex: De-juice X%)
  const evExtra = o.extraInfoOnEvLine ? ` | ${o.extraInfoOnEvLine}` : '';
  lines.push(`📈 EV: *+${o.ev}%*${evExtra}`);

  // Stake + kelly label
  const kellyExtra = o.kellyLabel ? ` _(${o.kellyLabel})_` : '';
  lines.push(`💵 Stake: *${o.stake}*${kellyExtra}`);

  // Confiança + slang flair (linha opcional — MT path passa undefined p/ omitir).
  // Aplica mesmo filtro stakeBoosted no pool conf_baixa pra excluir frases que
  // afirmam "stake reduzido" literal — coerência com header.
  if (o.conf) {
    const confEmoji = CONF_EMOJI[String(o.conf || '').toUpperCase()] || '🟡';
    const confExclude = (o.stakeBoosted && confKey === 'baixa')
      ? ['vai de safety, stake reduzido', 'stake leve, olho no resultado']
      : null;
    const confSlang = pickSlang(`conf_${confKey}`, seed, confExclude ? { exclude: confExclude } : undefined);
    const confFlair = confSlang ? ` — _${confSlang}_` : '';
    lines.push(`${confEmoji} Confiança: *${o.conf}*${confFlair}`);
  }

  // Imminent note
  if (o.imminentNote) {
    lines.push('');
    lines.push(String(o.imminentNote).replace(/\n$/, ''));
  }

  // Footer
  lines.push('');
  const footerSlang = pickSlang('footer', seed) || 'Aposte com responsabilidade. +18.';
  lines.push(`⚠️ _${footerSlang}_`);

  return lines.join('\n');
}

module.exports = { buildTipMessage, SPORT_META, CONF_EMOJI };
