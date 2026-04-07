/**
 * lib/news.js — Busca notícias recentes via Google News RSS (sem API key)
 * Usado para injetar contexto de lesões, suspensões, escalações no prompt da IA.
 */
const { httpGet, log } = require('./utils');

const NEWS_CACHE = new Map(); // cacheKey → { ts, text }
const NEWS_TTL = 45 * 60 * 1000; // 45 minutos

const SPORT_CONFIG = {
  football: {
    hl: 'pt', gl: 'BR', ceid: 'BR:pt',
    extra: 'lesão suspensão escalação desfalque'
  },
  mma: {
    hl: 'en', gl: 'US', ceid: 'US:en',
    extra: 'injury withdrawal weight cut cancelled'
  },
  tennis: {
    hl: 'en', gl: 'US', ceid: 'US:en',
    extra: 'injury withdrawal retired WTA ATP'
  },
  esports: {
    hl: 'en', gl: 'US', ceid: 'US:en',
    extra: 'League of Legends LoL roster transfer substitution ban'
  }
};

function buildUrl(sport, name1, name2) {
  const cfg = SPORT_CONFIG[sport] || SPORT_CONFIG.mma;
  const q = encodeURIComponent(`${name1} ${name2} ${cfg.extra}`);
  return `https://news.google.com/rss/search?q=${q}&hl=${cfg.hl}&gl=${cfg.gl}&ceid=${cfg.ceid}`;
}

function parseRssItems(xml) {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const items = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null && items.length < 5) {
    const block = m[1];
    const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) ||
                   /<title>(.*?)<\/title>/.exec(block))?.[1]?.trim();
    if (!title || title === 'Google News') continue;
    const pubStr = /<pubDate>(.*?)<\/pubDate>/.exec(block)?.[1]?.trim();
    if (pubStr) {
      const pub = new Date(pubStr).getTime();
      if (!isNaN(pub) && pub < cutoff) continue; // mais de 48h → ignora
    }
    items.push(
      title
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
    );
  }
  return items;
}

/**
 * Busca notícias sobre a partida e retorna bloco formatado para o prompt.
 * Retorna string vazia se não encontrar nada ou em caso de erro.
 *
 * @param {string} sport  - 'football' | 'mma' | 'tennis' | 'esports'
 * @param {string} name1  - time/atleta 1
 * @param {string} name2  - time/atleta 2
 * @returns {Promise<string>}
 */
async function fetchMatchNews(sport, name1, name2) {
  const cacheKey = `${sport}::${name1.toLowerCase()}::${name2.toLowerCase()}`;
  const cached = NEWS_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < NEWS_TTL) {
    return cached.text;
  }

  try {
    const url = buildUrl(sport, name1, name2);
    const resp = await httpGet(url, { 'Accept': 'application/rss+xml, text/xml' });
    if (resp.status !== 200) {
      NEWS_CACHE.set(cacheKey, { ts: Date.now(), text: '' });
      return '';
    }
    const items = parseRssItems(resp.body);
    const text = items.length
      ? `NOTÍCIAS RECENTES (Google News, 48h):\n${items.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
      : '';
    NEWS_CACHE.set(cacheKey, { ts: Date.now(), text });
    if (text) log('INFO', 'NEWS', `${sport} ${name1}/${name2}: ${items.length} notícia(s) encontrada(s)`);
    return text;
  } catch (e) {
    log('WARN', 'NEWS', `Falha ao buscar notícias (${sport} ${name1}/${name2}): ${e.message}`);
    NEWS_CACHE.set(cacheKey, { ts: Date.now(), text: '' }); // cache falha para não spammar
    return '';
  }
}

module.exports = { fetchMatchNews };
