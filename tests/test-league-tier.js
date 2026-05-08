/**
 * Tests for lib/league-tier — resolver de tier centralizado.
 *
 * Garante que getLeagueTier cobre os casos críticos usados por classifiers
 * inline em bot.js (isLolTier1, isCsTier1) e scripts/backtest-v2.js.
 *
 * Quando tech debt do tier-classifier-unification for resolvido, esses
 * classifiers inline devem ser substituídos por chamadas a getLeagueTier
 * — esses tests servem de safety net pra garantir comportamento consistente.
 */

const { getLeagueTier, getLeagueTierKey } = require('../lib/league-tier');

module.exports = function runTests(t) {
  // ── Esports ──
  t.test('esports tier 1: LCK/LEC/LCS/LPL/Worlds/MSI', () => {
    t.assert(getLeagueTier('lol', 'LCK Spring 2026') === 1, 'LCK');
    t.assert(getLeagueTier('lol', 'LEC Winter') === 1, 'LEC');
    t.assert(getLeagueTier('lol', 'LCS') === 1, 'LCS');
    t.assert(getLeagueTier('lol', 'LPL Spring') === 1, 'LPL');
    t.assert(getLeagueTier('lol', 'Worlds 2026') === 1, 'Worlds');
    t.assert(getLeagueTier('lol', 'MSI 2026') === 1, 'MSI');
  });

  t.test('esports tier 2: regional + secundário', () => {
    t.assert(getLeagueTier('lol', 'CBLOL Split 1') === 2, 'CBLOL');
    t.assert(getLeagueTier('lol', 'LLA Apertura') === 2, 'LLA');
    t.assert(getLeagueTier('lol', 'PCS Spring') === 2, 'PCS');
    t.assert(getLeagueTier('lol', 'VCS') === 2, 'VCS');
  });

  t.test('esports tier 3: obscuro', () => {
    t.assert(getLeagueTier('lol', 'Random Amateur League XYZ') === 3, 'unknown');
    t.assert(getLeagueTier('lol', '') === 3, 'empty');
  });

  t.test('CS2: IEM Katowice + Major + ESL Pro são tier 1/2', () => {
    t.assert(getLeagueTier('cs', 'IEM Katowice 2026') === 1, 'IEM Katowice');
    t.assert(getLeagueTier('cs', 'PGL Major Copenhagen') === 1, 'PGL Major');
    t.assert(getLeagueTier('cs', 'BLAST Premier Spring') === 1, 'BLAST Premier');
    t.assert(getLeagueTier('cs2', 'ESL Pro League S20') === 2, 'ESL Pro = tier2');
    t.assert(getLeagueTier('cs', 'ESL Challenger Europe') === 2, 'ESL Challenger has "challengers" → tier2');
  });

  t.test('valorant: VCT Champions tier 1, Game Changers tier 2', () => {
    t.assert(getLeagueTier('valorant', 'VCT Masters Madrid') === 1, 'VCT Masters');
    t.assert(getLeagueTier('valorant', 'Valorant Champions') === 1, 'Valorant Champions');
    t.assert(getLeagueTier('valorant', 'Game Changers Championship') === 2, 'Game Changers');
  });

  t.test('dota2: TI/Major tier 1, DPC tier 2', () => {
    t.assert(getLeagueTier('dota2', 'The International 2025') === 1, 'TI');
    t.assert(getLeagueTier('dota2', 'Riyadh Masters') === 1, 'Riyadh');
    t.assert(getLeagueTier('dota2', 'DPC Western Europe') === 2, 'DPC');
  });

  // ── Tennis ──
  t.test('tennis tier 1: Grand Slams + Masters 1000', () => {
    t.assert(getLeagueTier('tennis', 'Wimbledon Singles') === 1);
    t.assert(getLeagueTier('tennis', 'US Open') === 1);
    t.assert(getLeagueTier('tennis', 'Australian Open') === 1);
    t.assert(getLeagueTier('tennis', 'Roland Garros') === 1);
    t.assert(getLeagueTier('tennis', 'ATP 1000 Indian Wells') === 1);
    t.assert(getLeagueTier('tennis', 'Madrid Open') === 1);
  });

  t.test('tennis tier 2: ATP/WTA 250-500 main tour', () => {
    t.assert(getLeagueTier('tennis', 'ATP 250 Buenos Aires') === 2);
    t.assert(getLeagueTier('tennis', 'WTA 500 Adelaide') === 2);
  });

  t.test('tennis tier 3: Challenger + ITF', () => {
    t.assert(getLeagueTier('tennis', 'ATP Challenger Lille') === 3);
    t.assert(getLeagueTier('tennis', 'ITF M25 Antalya') === 3);
  });

  // ── Football ──
  t.test('football tier 1: top-5 europeu + champions league', () => {
    t.assert(getLeagueTier('football', 'Premier League') === 1);
    t.assert(getLeagueTier('football', 'La Liga') === 1);
    t.assert(getLeagueTier('football', 'Bundesliga') === 1);
    t.assert(getLeagueTier('football', 'Serie A') === 1);
    t.assert(getLeagueTier('football', 'Ligue 1') === 1);
    t.assert(getLeagueTier('football', 'Champions League') === 1);
    t.assert(getLeagueTier('football', 'Brasileirão A') === 1);
  });

  t.test('football tier 2: segundas divisões + ligas secundárias', () => {
    t.assert(getLeagueTier('football', 'Championship') === 2, 'EFL Championship');
    t.assert(getLeagueTier('football', 'Bundesliga 2') === 2);
    t.assert(getLeagueTier('football', 'MLS') === 2);
    t.assert(getLeagueTier('football', 'Eredivisie') === 2);
  });

  // ── Basket ──
  t.test('basket tier 1: NBA + EuroLeague', () => {
    t.assert(getLeagueTier('basket', 'NBA Regular Season') === 1);
    t.assert(getLeagueTier('basket', 'EuroLeague Top 16') === 1);
    t.assert(getLeagueTier('basket', 'WNBA') === 1);
  });

  t.test('basket tier 2: ACB + EuroCup + NBB', () => {
    t.assert(getLeagueTier('basket', 'ACB Liga Endesa') === 2);
    t.assert(getLeagueTier('basket', 'EuroCup') === 2);
    t.assert(getLeagueTier('basket', 'NBB Brasileiro') === 2);
  });

  // ── MMA ──
  t.test('mma tier 1: UFC + PFL Championship + Bellator', () => {
    t.assert(getLeagueTier('mma', 'UFC 311') === 1);
    t.assert(getLeagueTier('mma', 'UFC Fight Night') === 1);
    t.assert(getLeagueTier('mma', 'Bellator 305') === 1);
    t.assert(getLeagueTier('mma', 'PFL Championship') === 1);
  });

  t.test('mma tier 2: regional', () => {
    t.assert(getLeagueTier('mma', 'LFA 200') === 2);
    t.assert(getLeagueTier('mma', 'Cage Warriors 175') === 2);
  });

  // ── Edge cases ──
  t.test('sport unknown → tier 3 default', () => {
    t.assert(getLeagueTier('darts', 'PDC World Championship') === 3, 'darts não suportado');
    t.assert(getLeagueTier('snooker', 'World Championship') === 3, 'snooker não suportado');
  });

  t.test('league null/undefined/empty → tier 3', () => {
    t.assert(getLeagueTier('lol', null) === 3);
    t.assert(getLeagueTier('lol', undefined) === 3);
    t.assert(getLeagueTier('lol', '') === 3);
  });

  t.test('getLeagueTierKey retorna string format', () => {
    t.assert(getLeagueTierKey('lol', 'LCK') === 'tier1');
    t.assert(getLeagueTierKey('lol', 'CBLOL') === 'tier2');
    t.assert(getLeagueTierKey('lol', 'random') === 'tier3');
  });

  t.test('case insensitive', () => {
    t.assert(getLeagueTier('lol', 'lck spring') === 1, 'lowercase');
    t.assert(getLeagueTier('lol', 'LCK SPRING') === 1, 'uppercase');
    t.assert(getLeagueTier('lol', 'Lck Spring') === 1, 'mixed');
  });

  t.test('cs2 alias resolve igual a cs', () => {
    const a = getLeagueTier('cs', 'IEM Katowice 2026');
    const b = getLeagueTier('cs2', 'IEM Katowice 2026');
    t.assert(a === b, `cs(${a}) e cs2(${b}) deveriam ser iguais`);
  });
};
