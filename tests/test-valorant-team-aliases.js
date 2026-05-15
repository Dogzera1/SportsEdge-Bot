/**
 * Valorant team alias expansion — TDD coverage
 *
 * Audit 2026-05-15: /live-snapshot mostrou duplicate ("Vitality vs FUT"
 * + "FUT Esports vs Team Vitality") indicando dedup gap quando sources
 * usam canonical vs abbreviation.
 */

const { expandAlias } = require('../lib/valorant-team-aliases');

module.exports = function(t) {
  t.test('expandAlias: Vitality → Team Vitality (case observado prod)', () => {
    t.assert(expandAlias('Vitality') === 'team vitality', `got ${expandAlias('Vitality')}`);
    t.assert(expandAlias('VIT') === 'team vitality', 'VIT abbr');
    t.assert(expandAlias('Team Vitality') === 'team vitality', 'lowercased canonical');
  });

  t.test('expandAlias: FUT → FUT Esports', () => {
    t.assert(expandAlias('FUT') === 'fut esports', 'FUT abbr');
    t.assert(expandAlias('FUT Esports') === 'fut esports', 'canonical lowercased');
  });

  t.test('expandAlias: FaZe variants', () => {
    t.assert(expandAlias('FaZe') === 'faze clan', 'FaZe alone');
    t.assert(expandAlias('FaZe Clan') === 'faze clan', 'canonical');
  });

  t.test('expandAlias: tier 1 teams (Fnatic/Heretics/Gen.G)', () => {
    t.assert(expandAlias('FNC') === 'fnatic', 'FNC abbr');
    t.assert(expandAlias('TH') === 'team heretics', 'TH abbr');
    t.assert(expandAlias('Gen.G') === 'gen.g esports', 'Gen.G abbr');
    t.assert(expandAlias('GenG') === 'gen.g esports', 'GenG no dot');
  });

  t.test('expandAlias: Americas (100T/C9/SEN/NRG/G2)', () => {
    t.assert(expandAlias('100T') === '100 thieves', '100T');
    t.assert(expandAlias('C9') === 'cloud9', 'C9');
    t.assert(expandAlias('SEN') === 'sentinels', 'SEN');
    t.assert(expandAlias('NRG') === 'nrg esports', 'NRG');
    t.assert(expandAlias('G2') === 'g2 esports', 'G2');
  });

  t.test('expandAlias: Karmine variants', () => {
    t.assert(expandAlias('KC') === 'karmine corp', 'KC');
    t.assert(expandAlias('Karmine') === 'karmine corp', 'Karmine');
  });

  t.test('expandAlias: unknown name returns lowercased input', () => {
    t.assert(expandAlias('Random Team XYZ') === 'random team xyz', 'unknown');
    t.assert(expandAlias('Solo Esports') === 'solo esports', 'unknown lowercase');
  });

  t.test('expandAlias: empty/null safe', () => {
    t.assert(expandAlias('') === '', 'empty');
    t.assert(expandAlias(null) === '', 'null');
    t.assert(expandAlias(undefined) === '', 'undefined');
  });

  t.test('expandAlias: case insensitive + trim', () => {
    t.assert(expandAlias('vitality') === 'team vitality', 'lowercase');
    t.assert(expandAlias('VITALITY') === 'team vitality', 'uppercase');
    t.assert(expandAlias('  Vitality  ') === 'team vitality', 'trimmed');
  });

  t.test('post-expand normName resolve case observed prod', () => {
    // Simula VLR _namesMatch após expand
    const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const nameMatches = (a, b) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));

    // Pré-fix: "Vitality" vs "Team Vitality" — includes funciona já (vitality em teamvitality)
    const aPre = nameMatches(normName('Vitality'), normName('Team Vitality'));
    t.assert(aPre === true, 'sanity: includes funciona pra Vitality');

    // Mas KC vs Karmine Corp NÃO casa por includes (sem chars compartilhados)
    const bPre = nameMatches(normName('KC'), normName('Karmine Corp'));
    t.assert(bPre === false, 'sanity: KC não casa Karmine Corp por includes');

    // Pós-fix: expand KC → karmine corp
    const bPost = nameMatches(normName(expandAlias('KC')), normName('Karmine Corp'));
    t.assert(bPost === true, 'pós-fix: KC expand → karmine corp casa');
  });
};
