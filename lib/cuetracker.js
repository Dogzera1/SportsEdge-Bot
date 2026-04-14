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

module.exports = { getPlayerStats, _toSlug };
