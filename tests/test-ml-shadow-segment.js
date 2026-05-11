'use strict';

/**
 * tests/test-ml-shadow-segment.js
 *
 * Smoke test pra classificador map vs série usado no /ml-shadow-by-sport.
 * Espelha a lógica embutida em server.js (linha ~26720). Se mudar lá, mudar
 * aqui. Cobertura: identificação correta do segment baseado em sport +
 * match_id, fallback pra null em sports não-esports, regex case-insensitive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ESPORTS_SET = new Set(['lol', 'dota2', 'cs', 'cs2', 'valorant']);
const segmentOf = (sport, matchId) => {
  if (!ESPORTS_SET.has(sport)) return null;
  // _MAP\d+ estrito — espelha server.js _segmentOf
  return matchId && /_MAP\d+/i.test(String(matchId)) ? 'map' : 'series';
};

test('esports series tip → segment=series', () => {
  assert.equal(segmentOf('lol', 'lol_115548668059589336'), 'series');
  assert.equal(segmentOf('cs', 'cs_99999'), 'series');
  assert.equal(segmentOf('valorant', 'val_88888'), 'series');
  assert.equal(segmentOf('dota2', 'ps_1416676'), 'series');
});

test('esports map tip (suffix _MAP{N}) → segment=map', () => {
  assert.equal(segmentOf('dota2', 'dota2_ps_1416676_MAP1'), 'map');
  assert.equal(segmentOf('dota2', 'dota2_ps_1416676_MAP2'), 'map');
  assert.equal(segmentOf('cs', 'cs_match_xyz_MAP3'), 'map');
  assert.equal(segmentOf('valorant', 'val_match_zzz_MAP1'), 'map');
});

test('regex case-insensitive — _map também classifica', () => {
  assert.equal(segmentOf('cs', 'cs_match_99_map2'), 'map');
});

test('non-esports sports → segment=null (sem chip)', () => {
  assert.equal(segmentOf('tennis', 'tennis_atp_madrid_round32'), null);
  assert.equal(segmentOf('football', 'fb_prem_001'), null);
  assert.equal(segmentOf('basket', 'nba_lal_bos'), null);
  assert.equal(segmentOf('mma', 'ufc_300_main'), null);
});

test('match_id null/undefined em esports → segment=series (fallback)', () => {
  assert.equal(segmentOf('lol', null), 'series');
  assert.equal(segmentOf('lol', ''), 'series');
  assert.equal(segmentOf('lol', undefined), 'series');
});

test('regex estrito \\d+ — _MAP sem dígito ou _MAPLE não vira mapa', () => {
  assert.equal(segmentOf('lol', 'lol_115548668_MAPLE'), 'series');
  assert.equal(segmentOf('lol', 'lol_x_MAP_y'), 'series');
  assert.equal(segmentOf('cs', 'cs_match_xyz_MAP'), 'series'); // sem digit
});

test('match_id real prod (CS shadow tip) → segment correto', () => {
  // Sample real do snapshot prod 2026-05-10 — tips-history sport=cs
  // limit=200 include_shadow=1 retornou _MAP em 20/44 tips.
  assert.equal(segmentOf('cs', 'ps_1234_MAP1'), 'map');
  assert.equal(segmentOf('cs', 'ps_1234'), 'series');
});
