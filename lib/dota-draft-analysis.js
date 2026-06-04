'use strict';
/**
 * dota-draft-analysis.js — Display-only orchestrator for the Dota Lab "Analisar draft".
 * Combines meta draft strength + counter edge + per-player hero WR + composition.
 * No stake/EV/bet. Shared by /api/dota-draft-analyze and /api/dota-draft-explain.
 */
const { getDraftMatchupFactor, getDraftComposition } = require('./dota-hero-features');
const { getMatchupEdge, resolveHeroId } = require('./dota-hero-matchups');
const { resolveProPlayer, getPlayerHeroStats } = require('./dota-player-heroes');

async function computeDotaDraftAnalysis(db, { blue = [], red = [], players = {} } = {}, { fetcher } = {}) {
  const heroNameById = new Map();
  try { for (const r of db.prepare('SELECT hero_id, localized_name FROM dota_hero_stats').all()) heroNameById.set(r.hero_id, r.localized_name); } catch (_) {}
  const nameOf = (id) => heroNameById.get(id) || ('#' + id);

  const draftStrength = getDraftMatchupFactor(db, blue, red); // {factor,blueWR,redWR,detail} | null
  const matchupEdge = getMatchupEdge(db, blue, red);
  matchupEdge.pairs = matchupEdge.pairs.map(p => ({ ...p, blueName: nameOf(p.blue), redName: nameOf(p.red) }));
  const composition = { blue: getDraftComposition(db, blue), red: getDraftComposition(db, red) };

  async function sidePlayers(heroes, nicks) {
    const out = [];
    const list = Array.isArray(nicks) ? nicks : [];
    for (let i = 0; i < heroes.length; i++) {
      const nick = String(list[i] || '').trim();
      if (!nick) continue;
      const pro = resolveProPlayer(db, nick);
      if (!pro) { out.push({ nick, resolved: false }); continue; }
      let onHero = null, top = [];
      try {
        const hs = await getPlayerHeroStats(db, pro.account_id, fetcher ? { fetcher } : {});
        const hid = resolveHeroId(db, heroes[i]);
        if (hid) { const f = hs.find(x => x.hero_id === hid); if (f) onHero = { wr: f.wr, games: f.games }; }
        top = hs.slice(0, 3).map(x => ({ hero: nameOf(x.hero_id), wr: x.wr, games: x.games }));
      } catch (_) { /* display-only: a fetch failure leaves this player without data */ }
      out.push({ nick, resolved: true, player: pro.name, team: pro.team_name, hero: heroes[i], onHero, top });
    }
    return out;
  }
  const playerHeroes = { blue: await sidePlayers(blue, players.blue), red: await sidePlayers(red, players.red) };

  return { draftStrength, matchupEdge, playerHeroes, composition };
}
module.exports = { computeDotaDraftAnalysis };
