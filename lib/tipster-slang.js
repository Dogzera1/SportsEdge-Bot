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
 * pickSlang(context, seed) → string
 *
 * context: chave de POOLS (ex: 'header_alta', 'conf_baixa', 'footer')
 * seed: string usada como hash input (default '' → primeiro item do pool)
 *
 * Determinístico: mesmo (context, seed) sempre retorna mesma frase.
 * Safe: nunca throws — context desconhecido retorna '', seed undefined → ''.
 */
function pickSlang(context, seed) {
  const pool = POOLS[context];
  if (!Array.isArray(pool) || pool.length === 0) return '';
  const seedStr = String(seed == null ? '' : seed);
  const h = _fnv1a(`${seedStr}|${context}`);
  return pool[h % pool.length];
}

module.exports = { POOLS, pickSlang };
