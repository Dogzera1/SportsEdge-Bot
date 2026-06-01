'use strict';
/**
 * Builds lib/lol-champion-tags.json from Riot Data Dragon champion.json.
 * Display-only artifact (comp-style heuristic). No npm dep, no DB.
 *
 * Usage: node scripts/build-lol-champion-tags.js <path-to-champion.json>
 * (download champion.json once via PowerShell — see plan Task 1 Step 5.)
 */
const fs = require('fs');
const path = require('path');
const { normalizeChampion } = require('../lib/lol-champions');

function buildTagsArtifact(ddragon) {
  const out = {};
  const data = (ddragon && ddragon.data) || {};
  for (const champ of Object.values(data)) {
    if (!champ || !champ.id) continue;
    const key = normalizeChampion(champ.id);
    if (!key) continue;
    const info = champ.info || {};
    out[key] = {
      tags: Array.isArray(champ.tags) ? champ.tags.slice() : [],
      info: {
        attack: Number(info.attack) || 0,
        defense: Number(info.defense) || 0,
        magic: Number(info.magic) || 0,
        difficulty: Number(info.difficulty) || 0,
      },
    };
  }
  return out;
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input) { console.error('usage: node scripts/build-lol-champion-tags.js <champion.json>'); process.exit(1); }
  const dd = JSON.parse(fs.readFileSync(input, 'utf8'));
  const art = buildTagsArtifact(dd);
  const dest = path.join(__dirname, '..', 'lib', 'lol-champion-tags.json');
  const sorted = {};
  for (const k of Object.keys(art).sort()) sorted[k] = art[k];
  fs.writeFileSync(dest, JSON.stringify(sorted, null, 0));
  console.log(`wrote ${dest} (${Object.keys(sorted).length} champions)`);
}

module.exports = { buildTagsArtifact };
