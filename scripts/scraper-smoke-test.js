/**
 * scraper-smoke-test.js — smoke test diário pra detectar schema drift em scrapers
 * HTML-embedded. Sites externos mudam markup sem aviso → return zero silencioso.
 *
 * Cobertura: scrapers ATIVOS no pipeline. Inputs estáveis (entidades persistentes).
 *   - cuetracker:  Judd Trump (top snooker, slug estável)
 *   - vlr.gg:      /matches/results page 1 (lista sempre populada)
 *   - hltv:        findTeamId('FaZe') — top CS team, sempre indexado
 *
 * Excluídos (dormentes/deprecated):
 *   - understat-scraper:    site virou SPA (substituído por football-data.co.uk CSV)
 *   - tennis-abstract-scraper: tabela tennis_player_serve_stats nunca lida no pipeline
 *   - golgg/thespike: precisam IDs voláteis (seriesId, team-by-season)
 *
 * Uso:
 *   - CLI: node scripts/scraper-smoke-test.js
 *   - Programático: const { runScraperSmokeTests } = require('./scripts/scraper-smoke-test');
 *
 * Métricas emitidas:
 *   - gauge scraper_smoke_last_ok_ts (tags: name)
 *   - gauge scraper_smoke_last_fail_ts (tags: name)
 *   - counter scraper_smoke_call (tags: name, status=ok|fail)
 */
'use strict';

const cuetracker = require('../lib/cuetracker');
const vlr = require('../lib/vlr');
const hltv = require('../lib/hltv');

const SUITES = [
  {
    name: 'cuetracker',
    test: async () => {
      const r = await cuetracker.getPlayerStats('Judd Trump');
      const items = r ? (r.totalMatches || 0) : 0;
      return { ok: r != null && items > 0, items, reason: r ? null : 'null_return' };
    },
  },
  {
    name: 'vlr',
    test: async () => {
      const ids = await vlr.fetchResults(1).catch(() => []);
      const items = Array.isArray(ids) ? ids.length : 0;
      return { ok: items > 0, items, reason: items === 0 ? 'empty_results' : null };
    },
  },
  {
    name: 'hltv',
    test: async () => {
      // HLTV requer HLTV_PROXY_BASE (Cloudflare bloqueia direct). Skip se não configurado
      // (local dev sem proxy é estado válido — Railway prod tem proxy).
      if (!hltv._enabled()) return { ok: true, items: 0, reason: 'skipped_no_proxy', skipped: true };
      const r = await hltv.findTeamId('FaZe').catch(() => null);
      const items = r?.teamId ? 1 : 0;
      return { ok: items > 0, items, reason: r?.teamId ? null : 'team_not_found' };
    },
  },
];

async function runScraperSmokeTests() {
  const results = [];
  let metrics = null;
  try { metrics = require('../lib/metrics'); } catch (_) {}

  for (const s of SUITES) {
    const t0 = Date.now();
    let r;
    try {
      r = await s.test();
    } catch (e) {
      r = { ok: false, items: 0, reason: e?.message || 'throw' };
    }
    const latencyMs = Date.now() - t0;
    const entry = { name: s.name, ok: r.ok, items: r.items, latency_ms: latencyMs, reason: r.reason };
    results.push(entry);

    if (metrics) {
      try {
        if (r.ok) metrics.gauge('scraper_smoke_last_ok_ts', Date.now(), { name: s.name });
        else metrics.gauge('scraper_smoke_last_fail_ts', Date.now(), { name: s.name });
        metrics.incr('scraper_smoke_call', { name: s.name, status: r.ok ? 'ok' : 'fail' });
      } catch (_) {}
    }
  }

  const failed = results.filter(r => !r.ok);
  return {
    ok: failed.length === 0,
    total: results.length,
    failed: failed.length,
    results,
  };
}

module.exports = { runScraperSmokeTests };

// CLI mode
if (require.main === module) {
  runScraperSmokeTests().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }).catch(e => {
    console.error('FATAL:', e.message);
    process.exit(2);
  });
}
