#!/usr/bin/env node
'use strict';

/**
 * scripts/audit-match-results.js
 *
 * Audita match_results pra detectar problemas de data quality:
 *   - final_score com Bo-score inconsistente (Bo3 2-0 etiquetado como Bo1 etc.)
 *   - final_score com números incompatíveis com maps (ex: kills-based OpenDota)
 *   - rows sem winner, sem team1/team2, sem resolved_at
 *   - rows com final_score = 'Final'/'Retired'/'Walkover' (tennis pending enrichment)
 *
 * Uso:
 *   node scripts/audit-match-results.js
 *   node scripts/audit-match-results.js --game dota2
 *   node scripts/audit-match-results.js --fix              # tenta corrigir Bo labels via max
 *   node scripts/audit-match-results.js --json             # output JSON pra CI
 */

require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const argv = process.argv.slice(2);
const argVal = (n, d) => {
  const i = argv.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
};
const GAME = argVal('game', null);
const FIX = argv.includes('--fix');
const JSON_OUT = argv.includes('--json');

function correctBoFromMax(maxScore) {
  return maxScore >= 4 ? 7 : maxScore >= 3 ? 5 : maxScore >= 2 ? 3 : 1;
}

function isValidEsportsMapScore(bo, a, b) {
  if (bo == null) return false;
  const maxPerSide = (bo % 2 === 0) ? bo : Math.ceil(bo / 2);
  return Math.max(a, b) <= maxPerSide && (a + b) <= bo && (a + b) >= 1;
}

function main() {
  const { db } = initDatabase(DB_PATH);
  const gameFilter = GAME ? `AND game = '${GAME.replace(/'/g, "''")}'` : '';
  const rows = db.prepare(`
    SELECT match_id, game, team1, team2, winner, final_score, resolved_at
    FROM match_results
    WHERE 1=1 ${gameFilter}
  `).all();

  const bySourceGame = new Map(); // `${pfx}|${game}` → { total, issues: {...} }
  const issues = {
    missingFields: [],
    badBoLabel: [],
    invalidMapScore: [],
    tennisNoScore: [],
  };

  for (const r of rows) {
    const pfx = String(r.match_id || '').split('_')[0] || 'unknown';
    const sourceKey = `${pfx}|${r.game}`;
    if (!bySourceGame.has(sourceKey)) {
      bySourceGame.set(sourceKey, {
        source: pfx, game: r.game, total: 0,
        missingFields: 0, badBoLabel: 0, invalidMapScore: 0, tennisNoScore: 0,
      });
    }
    const bucket = bySourceGame.get(sourceKey);
    bucket.total++;

    if (!r.team1 || !r.team2 || !r.winner || !r.resolved_at) {
      bucket.missingFields++;
      issues.missingFields.push(r);
      continue;
    }

    if (r.game === 'tennis') {
      if (r.final_score === 'Final' || r.final_score === 'Retired' || r.final_score === 'Walkover' || !r.final_score) {
        bucket.tennisNoScore++;
      }
      continue;
    }

    // Esports: Bo parse
    const m = String(r.final_score || '').match(/Bo(\d+)\s+(\d+)-(\d+)/);
    if (!m) continue;
    const labeledBo = parseInt(m[1], 10);
    const a = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    const maxScore = Math.max(a, b);
    const correctBo = correctBoFromMax(maxScore);

    const valid = isValidEsportsMapScore(labeledBo, a, b);
    const maxPerSideLabeled = (labeledBo % 2 === 0) ? labeledBo : Math.ceil(labeledBo / 2);

    if (!valid && maxScore > maxPerSideLabeled) {
      // Score IMPOSSIBLE para o labeled Bo (ex: Bo1 2-0 — Bo1 max=1, mas score=2).
      // Normalmente indica mislabel corrigível via max.
      bucket.badBoLabel++;
      if (issues.badBoLabel.length < 20) issues.badBoLabel.push({ match_id: r.match_id, final_score: r.final_score, suggestedBo: correctBo });
    } else if (!valid) {
      // Score inválido mesmo ajustando Bo: kills-based ou outros bugs.
      bucket.invalidMapScore++;
      if (issues.invalidMapScore.length < 20) issues.invalidMapScore.push({ match_id: r.match_id, final_score: r.final_score });
    }
  }

  const sources = [...bySourceGame.values()].sort((a, b) => b.total - a.total);

  if (JSON_OUT) {
    console.log(JSON.stringify({ sources, issuesSample: issues }, null, 2));
    return;
  }

  console.log('\n── match_results data quality audit ──\n');
  const hdr = 'Source    | Game     | Total   | Missing | BadBo  | InvalidMap | TennisNoScore';
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const s of sources) {
    const src = s.source.padEnd(9);
    const g = s.game.padEnd(8);
    const pct = (v) => s.total ? (v / s.total * 100).toFixed(1) + '%' : '-';
    console.log(
      `${src} | ${g} | ${String(s.total).padStart(7)} | ` +
      `${String(s.missingFields).padStart(7)} | ${String(s.badBoLabel).padStart(6)} | ` +
      `${String(s.invalidMapScore).padStart(10)} | ${String(s.tennisNoScore).padStart(13)}`
    );
  }

  // Sample issues
  if (issues.invalidMapScore.length) {
    console.log('\n── Sample invalid map scores (up to 20) ──');
    for (const r of issues.invalidMapScore.slice(0, 10)) {
      console.log(`  ${r.match_id}: ${r.final_score}`);
    }
  }
  if (issues.badBoLabel.length) {
    console.log('\n── Sample Bo-label mismatches (suggested correction) ──');
    for (const r of issues.badBoLabel.slice(0, 10)) {
      console.log(`  ${r.match_id}: ${r.final_score} → suggest Bo${r.suggestedBo}`);
    }
  }

  if (FIX) {
    const update = db.prepare(`UPDATE match_results SET final_score = ? WHERE match_id = ?`);
    let fixed = 0;
    const tx = db.transaction(() => {
      for (const r of issues.badBoLabel) {
        const parts = r.final_score.match(/Bo(\d+)\s+(\d+)-(\d+)/);
        if (!parts) continue;
        const a = parseInt(parts[2], 10), b = parseInt(parts[3], 10);
        const newBo = correctBoFromMax(Math.max(a, b));
        update.run(`Bo${newBo} ${a}-${b}`, r.match_id);
        fixed++;
      }
    });
    tx();
    console.log(`\n── Fix applied: ${fixed} rows rewritten ──`);
  }
}

main();
