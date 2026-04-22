'use strict';

/**
 * epoch.js — captura git SHA + snapshot de env vars/auto-tunes ativas
 * no momento do tip insert. Permite filtrar análises por regime.
 *
 * SHA é capturado uma vez na primeira chamada (cached).
 * gateState é re-computado a cada chamada (capturando estado dinâmico).
 */

let _SHA = null;

function getCodeSha() {
  if (_SHA !== null) return _SHA;
  try {
    _SHA = require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim() || '';
  } catch (_) { _SHA = ''; }
  return _SHA;
}

const RELEVANT_ENVS = [
  'ODDS_BUCKET_BLOCK', 'PRE_MATCH_EV_BONUS', 'MAX_STAKE_UNITS',
  'TENNIS_ISOTONIC_DISABLED', 'AI_DISABLED',
  'CS_PRE_MATCH_EV_BONUS', 'VALORANT_PRE_MATCH_EV_BONUS', 'LOL_PRE_MATCH_EV_BONUS',
  'DARTS_PRE_MATCH_EV_BONUS', 'DOTA2_PRE_MATCH_EV_BONUS',
  'TENNIS_PRE_MATCH_EV_BONUS', 'FOOTBALL_PRE_MATCH_EV_BONUS',
  'CS_MAX_STAKE_UNITS', 'LOL_MAX_STAKE_UNITS', 'TENNIS_MAX_STAKE_UNITS',
  'VALORANT_MAX_STAKE_UNITS', 'DOTA2_MAX_STAKE_UNITS',
  'CS_ODDS_BUCKET_BLOCK', 'LOL_ODDS_BUCKET_BLOCK', 'VALORANT_ODDS_BUCKET_BLOCK',
];

function captureGateState() {
  const env = {};
  for (const k of RELEVANT_ENVS) {
    const v = process.env[k];
    if (v != null && v !== '') env[k] = v;
  }
  let auto = {};
  try {
    const { getAll } = require('./gates-runtime-state');
    for (const [k, v] of getAll()) auto[k] = v.value;
  } catch (_) {}
  return JSON.stringify({ env, auto });
}

module.exports = { getCodeSha, captureGateState, RELEVANT_ENVS };
