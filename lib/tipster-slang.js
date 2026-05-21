/**
 * tipster-slang.js — Pools de frases pt-BR estilo tipster, seleção determinística.
 *
 * pickSlang(context, seed) hash-based pick → mesma seed sempre retorna mesma frase.
 *
 * "chumbo grosso" é reservado pra settle messages (loss context) — não aparece aqui.
 * Footers preservam +18 + responsabilidade (regulatório).
 */

const POOLS = {
  // Tagline do header (após "TIP {SPORT}" — varia por confiança)
  header_alta: [
    'STAKE CHEIA',
    'VALOR NA CARA',
    'OLHO ABERTO AQUI',
    'CLOSER DA RODADA',
    'LINHA PEDIU',
  ],
  header_media: [
    'OLHO VIVO NA LINHA',
    'MANDA COM CABEÇA',
    'LINHA FAZ SENTIDO',
    'VALOR NA LINHA',
  ],
  header_baixa: [
    'VAI DE SAFETY',
    'STAKE REDUZIDA',
    'RESPEITA A BANCA',
    'CAUTELA NA LINHA',
  ],
  header_live: [
    'LINHA FRESCA',
    'CASA AINDA NÃO MOVEU',
    'OLHO NA VIRADA',
    'AO VIVO — LINHA QUENTE',
  ],

  // Linha curta complementando "Confiança: ALTA/MÉDIA/BAIXA"
  conf_alta: [
    'valor batendo na cara',
    'linha pediu, banca aproveita',
    'tá maduro pra entrar',
    'olho fechado nessa linha',
  ],
  conf_media: [
    'bate, mas com fé',
    'linha tem sentido',
    'análise pediu, banca segura',
    'tá na média, mas vale o tiro',
  ],
  conf_baixa: [
    'vai de safety, stake reduzido',
    'respeita a banca, tiro pequeno',
    'cautela, mercado tá curioso',
    'stake leve, olho no resultado',
  ],

  // Footer — preserva +18 + responsabilidade (REGULATÓRIO obrigatório)
  footer: [
    'Forra é a que bate. Jogue com cabeça e respeite a banca. +18 — aposte com responsabilidade.',
    'Bilhete na mão, fé no processo. +18 — aposte com responsabilidade.',
    'Olho na linha, mão na banca. +18 — jogo responsável.',
    'Aposta é maratona, não tiro curto. +18 — aposte com responsabilidade.',
    'Linha aberta, banca protegida. +18 — jogo responsável.',
    'Tip é palpite, não garantia. +18 — aposte com responsabilidade.',
  ],

  // ── Settle (Fase 2A) — após resultado do jogo ──

  // Win: verde/verdão/forra — celebração leve, sem prometer
  result_win: [
    'VERDÃO!',
    'BATEU!',
    'É A QUE BATE.',
    'FORRA NA BANCA.',
    'VERDE NO PLACAR.',
    'LIMPOU!',
  ],

  // Loss: chumbo grosso (o ponto explícito do user). Sem culpabilização.
  result_loss: [
    'CHUMBO GROSSO.',
    'VERMELHÃO.',
    'BATEU CHUMBO.',
    'NÃO COLOU.',
    'FOI DO RED.',
    'CASA ABRAÇOU.',
  ],

  // Void: jogo cancelado / sem placar válido
  result_void: [
    'STAKE DEVOLVIDA.',
    'BANCA INTACTA.',
    'ANULADA — VOLTA NA PRÓXIMA.',
    'VOID, SEM PERDA.',
  ],

  // Push: empate técnico (ex: handicap exato)
  result_push: [
    'PUSH — STAKE VOLTOU.',
    'EMPATE TÉCNICO.',
    'NEUTRO, BANCA OK.',
  ],

  // Footer pra settle msgs — encoraja gestão de banca, preserva +18
  footer_settle: [
    'Banca primeiro, emoção depois. +18 — aposte com responsabilidade.',
    'Forra é maratona, não tiro curto. +18 — jogo responsável.',
    'Resultado passou, próxima linha tá vindo. +18 — aposte com responsabilidade.',
    'Banca aguenta, processo é o jogo. +18 — jogo responsável.',
    'Linha vem, linha vai — banca fica. +18 — aposte com responsabilidade.',
  ],
};

// FNV-1a 32-bit — hash determinístico simples, sem dep externa.
function _fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0; // unsigned
}

/**
 * pickSlang(context, seed, opts?) → string
 *
 * context: chave de POOLS (ex: 'header_alta', 'conf_baixa', 'footer')
 * seed: string usada como hash input (default '' → primeiro item do pool)
 * opts.exclude?: array de strings a remover do pool antes do pick (case-insensitive).
 *   Usado quando contexto do caller torna certa frase contraditória (ex: header BAIXA
 *   "STAKE REDUZIDA" quando o caller boostou a fração Kelly do segmento).
 *
 * Determinístico: mesmo (context, seed, exclude-set) sempre retorna mesma frase.
 * Safe: nunca throws — context desconhecido retorna '', seed undefined → ''.
 * Fallback: se exclude esvaziar o pool, ignora exclude e volta ao pool completo.
 */
function pickSlang(context, seed, opts) {
  const pool = POOLS[context];
  if (!Array.isArray(pool) || pool.length === 0) return '';
  let candidates = pool;
  if (opts && Array.isArray(opts.exclude) && opts.exclude.length) {
    const excludeSet = new Set(opts.exclude.map(s => String(s).toUpperCase()));
    const filtered = pool.filter(p => !excludeSet.has(String(p).toUpperCase()));
    if (filtered.length > 0) candidates = filtered;
  }
  const seedStr = String(seed == null ? '' : seed);
  const h = _fnv1a(`${seedStr}|${context}`);
  return candidates[h % candidates.length];
}

module.exports = { POOLS, pickSlang };
