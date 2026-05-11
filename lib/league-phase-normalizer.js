'use strict';

/**
 * league-phase-normalizer.js — strip sufixo de round/fase de event_name pra
 * agrupar cards do mesmo torneio. Ex: "ATP Rome - R1" → "ATP Rome".
 *
 * Cobre: R\d (R1-R128), Q\d* (Q/Q1/Q2), QF/SF/F, Final[s], Quarter|Semifinal[s],
 * Round of N, Round/Matchday/Week/Day/Stage N, Group X, Regular Season,
 * Playoffs, Knockout, Bracket, Main Draw, Doubles, Qualifiers.
 *
 * Loop até estabilizar pra cobrir sufixos compostos ("ATP Rome - SF - Day 2").
 *
 * Uso:
 *   const { stripPhase, splitNameAndPhase } = require('./league-phase-normalizer');
 *   stripPhase('ATP Rome - QF') // 'ATP Rome'
 *   splitNameAndPhase('ATP Rome - QF') // { base: 'ATP Rome', phase: 'QF' }
 */

const _PHASE_RE = new RegExp(
  '\\s*-\\s*(' +
    'R\\d{1,3}|Q\\d{0,2}|QF|SF|F|' +
    '(?:Quarter|Semi)?[Ff]inal[s]?|' +
    'Round\\s+of\\s+\\d+|Round\\s+\\d+|' +
    'Qualifiers?|Qualifying|' +
    '(?:Matchday|Week|Day|Stage|Phase)\\s+\\d+|' +
    'Group\\s+[A-Z0-9]+|' +
    'Regular\\s+Season|Play-?offs?|Group\\s+Stage|Knockout|Bracket|' +
    'Main\\s+Draw|Doubles?' +
  ')\\s*$',
  'i'
);

function stripPhase(name) {
  if (!name) return '';
  let prev, cur = String(name).trim();
  do { prev = cur; cur = cur.replace(_PHASE_RE, '').trim(); } while (cur !== prev);
  return cur || name;
}

function splitNameAndPhase(name) {
  const base = stripPhase(name);
  if (!base || base === name) return { base: name || '', phase: '' };
  const phase = String(name).slice(base.length).replace(/^\s*-\s*/, '').trim();
  return { base, phase };
}

module.exports = { stripPhase, splitNameAndPhase };
