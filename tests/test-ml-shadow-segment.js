'use strict';

/**
 * tests/test-ml-shadow-segment.js
 *
 * Smoke test pra classificador map vs série usado no /ml-shadow-by-sport.
 * Espelha a lógica embutida em server.js (linha ~26720). Se mudar lá, mudar
 * aqui. Cobertura: identificação correta do segment baseado em sport +
 * match_id, fallback pra null em sports não-esports, regex case-insensitive.
 *
 * 2026-05-18: migrado de node:test pra runner custom (tests/run.js).
 */

const ESPORTS_SET = new Set(['lol', 'dota2', 'cs', 'cs2', 'valorant']);
const segmentOf = (sport, matchId) => {
  if (!ESPORTS_SET.has(sport)) return null;
  // _MAP\d+ estrito — espelha server.js _segmentOf
  return matchId && /_MAP\d+/i.test(String(matchId)) ? 'map' : 'series';
};

const _mtMapRe = /(_map\d+|^map\d*winner$)/i;
const segmentOfMtMarket = (sport, market) => {
  if (!ESPORTS_SET.has(sport)) return null;
  return _mtMapRe.test(String(market || '')) ? 'map' : 'series';
};

module.exports = function(t) {
  t.test('esports series tip → segment=series', () => {
    t.assert(segmentOf('lol', 'lol_115548668059589336') === 'series', 'lol series');
    t.assert(segmentOf('cs', 'cs_99999') === 'series', 'cs series');
    t.assert(segmentOf('valorant', 'val_88888') === 'series', 'valorant series');
    t.assert(segmentOf('dota2', 'ps_1416676') === 'series', 'dota2 series');
  });

  t.test('esports map tip (suffix _MAP{N}) → segment=map', () => {
    t.assert(segmentOf('dota2', 'dota2_ps_1416676_MAP1') === 'map', 'dota2 MAP1');
    t.assert(segmentOf('dota2', 'dota2_ps_1416676_MAP2') === 'map', 'dota2 MAP2');
    t.assert(segmentOf('cs', 'cs_match_xyz_MAP3') === 'map', 'cs MAP3');
    t.assert(segmentOf('valorant', 'val_match_zzz_MAP1') === 'map', 'val MAP1');
  });

  t.test('regex case-insensitive — _map também classifica', () => {
    t.assert(segmentOf('cs', 'cs_match_99_map2') === 'map', 'lowercase _map2');
  });

  t.test('non-esports sports → segment=null (sem chip)', () => {
    t.assert(segmentOf('tennis', 'tennis_atp_madrid_round32') === null, 'tennis null');
    t.assert(segmentOf('football', 'fb_prem_001') === null, 'football null');
    t.assert(segmentOf('basket', 'nba_lal_bos') === null, 'basket null');
    t.assert(segmentOf('mma', 'ufc_300_main') === null, 'mma null');
  });

  t.test('match_id null/undefined em esports → segment=series (fallback)', () => {
    t.assert(segmentOf('lol', null) === 'series', 'null → series');
    t.assert(segmentOf('lol', '') === 'series', 'empty → series');
    t.assert(segmentOf('lol', undefined) === 'series', 'undefined → series');
  });

  t.test('regex estrito \\d+ — _MAP sem dígito ou _MAPLE não vira mapa', () => {
    t.assert(segmentOf('lol', 'lol_115548668_MAPLE') === 'series', '_MAPLE → series');
    t.assert(segmentOf('lol', 'lol_x_MAP_y') === 'series', '_MAP_ → series');
    t.assert(segmentOf('cs', 'cs_match_xyz_MAP') === 'series', '_MAP sem digit → series');
  });

  t.test('match_id real prod (CS shadow tip) → segment correto', () => {
    // Sample real do snapshot prod 2026-05-10 — tips-history sport=cs
    // limit=200 include_shadow=1 retornou _MAP em 20/44 tips.
    t.assert(segmentOf('cs', 'ps_1234_MAP1') === 'map', 'cs ps_1234_MAP1 → map');
    t.assert(segmentOf('cs', 'ps_1234') === 'series', 'cs ps_1234 → series');
  });

  // 2026-05-10: classifier de market name (MT shadow). Espelha:
  //   - frontend public/dashboard.html _mtMapRe + _mtSegBadge
  //   - backend server.js /market-tips-by-sport segmentExpr (CASE WHEN ... GLOB ...)
  t.test('MT shadow market classifier — markets reais prod LoL → map', () => {
    // Sample real prod 2026-05-10 LoL: total_kills_map1/2/3 são map-level
    t.assert(segmentOfMtMarket('lol', 'total_kills_map1') === 'map', 'total_kills_map1');
    t.assert(segmentOfMtMarket('lol', 'total_kills_map2') === 'map', 'total_kills_map2');
    t.assert(segmentOfMtMarket('lol', 'total_kills_map3') === 'map', 'total_kills_map3');
  });

  t.test('MT shadow market classifier — series-level markets', () => {
    t.assert(segmentOfMtMarket('lol', 'total') === 'series', 'lol total');
    t.assert(segmentOfMtMarket('lol', 'handicap') === 'series', 'lol handicap');
    t.assert(segmentOfMtMarket('cs', 'total') === 'series', 'cs total');
    t.assert(segmentOfMtMarket('cs', 'handicap') === 'series', 'cs handicap');
    t.assert(segmentOfMtMarket('dota2', 'totalKills') === 'series', 'dota2 totalKills');
    t.assert(segmentOfMtMarket('dota2', 'correctScore') === 'series', 'dota2 correctScore');
    t.assert(segmentOfMtMarket('valorant', 'firstBlood') === 'series', 'val firstBlood');
  });

  t.test('MT shadow market classifier — mapWinner / mapNwinner pattern', () => {
    t.assert(segmentOfMtMarket('dota2', 'mapWinner') === 'map', 'dota2 mapWinner');
    t.assert(segmentOfMtMarket('dota2', 'map1Winner') === 'map', 'dota2 map1Winner');
    t.assert(segmentOfMtMarket('dota2', 'map2Winner') === 'map', 'dota2 map2Winner');
    t.assert(segmentOfMtMarket('cs', 'map3winner') === 'map', 'cs map3winner');
  });

  t.test('MT shadow market classifier — non-esports → null', () => {
    t.assert(segmentOfMtMarket('tennis', 'handicapGames') === null, 'tennis null');
    t.assert(segmentOfMtMarket('football', 'over25') === null, 'football null');
  });
};
