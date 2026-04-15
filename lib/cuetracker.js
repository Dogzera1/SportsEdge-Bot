/**
 * cuetracker.js — Scraper minimal do CueTracker.net para enrichment de snooker.
 *
 * CueTracker NÃO tem API oficial — scraping HTML puro.
 * Padrão URL: https://cuetracker.net/players/<slug>
 * Slug: nome em lowercase com hifens ("Judd Trump" → "judd-trump")
 *
 * Extrai stats da temporada atual:
 *   - wins / losses / winRate (padrão HTML: "Won:</span> 44 (73.33%)")
 *   - centuries (padrão: aparece em lista "Centuries: N")
 *
 * Cache agressivo (6h) para minimizar requests — stats mudam lentamente.
 */
'use strict';

const { cachedHttpGet, log } = require('./utils');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9'
};

function _toSlug(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // remove acentos
    .replace(/[^a-z0-9\s-]/g, '')                        // remove pontuação
    .replace(/\s+/g, '-')                                // espaços → hífen
    .replace(/-+/g, '-')                                 // colapsa múltiplos hífens
    .replace(/^-|-$/g, '');                              // trim hífens
}

async function _fetchHtml(url) {
  const r = await cachedHttpGet(url, {
    provider: 'cuetracker',
    ttlMs: 6 * 60 * 60 * 1000, // 6h
    headers: HEADERS,
    cacheKey: `cuetracker:${url}`
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  return String(r.body || '');
}

/**
 * Busca stats de um jogador pelo nome. Retorna null se não achar slug válido.
 * @returns {{ wins, losses, winRate, centuries } | null}
 */
async function getPlayerStats(name) {
  const slug = _toSlug(name);
  if (!slug || slug.length < 3) return null;

  const url = `https://cuetracker.net/players/${slug}`;
  const html = await _fetchHtml(url);
  if (!html) return null;

  // Heurística: primeira ocorrência de "Won:</span> N (XX.XX%)" é da temporada atual
  // (a página mostra temporada atual em destaque, histórico depois)
  const winMatch = html.match(/Won:\s*<\/span>\s*(\d+)\s*\(([\d.]+)%\)/);
  if (!winMatch) return null;

  const wins = parseInt(winMatch[1], 10);
  const winRate = parseFloat(winMatch[2]);

  const lossMatch = html.match(/Lost:\s*<\/span>\s*(\d+)/);
  const losses = lossMatch ? parseInt(lossMatch[1], 10) : 0;

  // Centuries: extrai da primeira linha "Centuries" seguida de número
  // Padrão variável no HTML; usa heurística permissiva
  let centuries = null;
  const centMatch = html.match(/Centuries[^<]*<[^>]*>\s*(\d+)\s*</);
  if (centMatch) centuries = parseInt(centMatch[1], 10);

  return {
    wins,
    losses,
    winRate,
    centuries,
    totalMatches: wins + losses,
  };
}

/**
 * Busca head-to-head entre dois jogadores.
 * URL: https://cuetracker.net/head-to-head/<slug1>/<slug2>
 *
 * @returns {{ p1Wins, p2Wins, totalMatches, p1FramesWon, p2FramesWon } | null}
 */
async function getHeadToHead(name1, name2) {
  const s1 = _toSlug(name1);
  const s2 = _toSlug(name2);
  if (!s1 || !s2 || s1.length < 3 || s2.length < 3) return null;

  const url = `https://cuetracker.net/head-to-head/${s1}/${s2}`;
  const html = await _fetchHtml(url);
  if (!html) return null;

  // A página tem várias tabelas; a tabela de H2H real por round tem cabeçalho
  // "Round | Played | <Player1> | <Player2>" e cada linha é "<b>Round</b> | n | p1Wins | p2Wins".
  // Soma todas as linhas pra obter H2H total.
  // (A tabela de "Comparison" no topo mostra stats de carreira, não H2H — cuidado.)
  const tables = html.match(/<table[^>]*>[\s\S]{0,80000}?<\/table>/g) || [];
  let p1Wins = 0, p2Wins = 0;
  for (const t of tables) {
    // Filtra: header deve conter "Round" e "Played"
    if (!/<th[^>]*>\s*Round\s*<\/th>/i.test(t)) continue;
    if (!/<th[^>]*>\s*Played\s*<\/th>/i.test(t)) continue;
    const rowRe = /<tr[^>]*>([\s\S]{0,600}?)<\/tr>/g;
    let match;
    while ((match = rowRe.exec(t)) !== null) {
      const tds = [...match[1].matchAll(/<td[^>]*>\s*([\s\S]{0,80}?)\s*<\/td>/g)].map(m => m[1]);
      // tds: [<b>Round</b>, played, p1, p2]
      if (tds.length < 4) continue;
      const n1 = parseInt(String(tds[2]).replace(/[^\d]/g, ''), 10);
      const n2 = parseInt(String(tds[3]).replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n1)) p1Wins += n1;
      if (Number.isFinite(n2)) p2Wins += n2;
    }
    break; // usou a primeira tabela válida
  }
  const totalMatches = p1Wins + p2Wins;
  if (totalMatches < 1) return null;

  return {
    p1Wins, p2Wins,
    totalMatches,
  };
}

module.exports = { getPlayerStats, getHeadToHead, _toSlug };
