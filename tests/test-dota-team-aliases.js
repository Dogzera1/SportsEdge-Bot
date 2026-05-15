/**
 * Dota team alias expansion — TDD coverage
 *
 * Audit 2026-05-15: "PlayTime vs BB Team" Pinnacle não casava "BetBoom Team"
 * OpenDota porque "bbteam" not includes "betboomteam" em /opendota-live.
 */

const { expandAlias } = require('../lib/dota-team-aliases');

module.exports = function(t) {
  t.test('expandAlias: BB → BetBoom Team (case observado prod)', () => {
    t.assert(expandAlias('BB Team') === 'betboom team', `expected betboom team, got ${expandAlias('BB Team')}`);
    t.assert(expandAlias('BB') === 'betboom team', 'BB short form');
    t.assert(expandAlias('bbteam') === 'betboom team', 'no space variant');
    t.assert(expandAlias('BetBoom') === 'betboom team', 'BetBoom without Team');
  });

  t.test('expandAlias: NaVi → Natus Vincere', () => {
    t.assert(expandAlias('NaVi') === 'natus vincere', 'NaVi');
    t.assert(expandAlias("na'vi") === 'natus vincere', "na'vi quoted");
  });

  t.test('expandAlias: 9P/9Pandas variants', () => {
    t.assert(expandAlias('9P') === '9pandas', '9P short');
    t.assert(expandAlias('9 Pandas') === '9pandas', '9 Pandas spaced');
  });

  t.test('expandAlias: unknown name returns lowercased input', () => {
    t.assert(expandAlias('Liquid Death') === 'liquid death', 'unknown lowercased');
    t.assert(expandAlias('REKONIX') === 'rekonix', 'unknown REKONIX');
  });

  t.test('expandAlias: empty input safe', () => {
    t.assert(expandAlias('') === '', 'empty string');
    t.assert(expandAlias(null) === '', 'null safe');
    t.assert(expandAlias(undefined) === '', 'undefined safe');
  });

  t.test('expandAlias: trim whitespace', () => {
    t.assert(expandAlias('  BB Team  ') === 'betboom team', 'trimmed');
    t.assert(expandAlias('NaVi\n') === 'natus vincere', 'trailing newline');
  });

  t.test('expandAlias: case insensitive', () => {
    t.assert(expandAlias('navi') === 'natus vincere', 'lowercase');
    t.assert(expandAlias('NAVI') === 'natus vincere', 'uppercase');
    t.assert(expandAlias('Navi') === 'natus vincere', 'mixed case');
  });

  t.test('post-expand normName matches canonical', () => {
    // Simula o que /opendota-live faz após expand
    const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const nameMatches = (a, b) => a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));

    // Pré-fix: BB Team não casava
    const preFix = nameMatches(normName('BB Team'), normName('BetBoom Team'));
    t.assert(preFix === false, 'sanity: pré-fix BB Team não casava');

    // Pós-fix: expand BB Team → betboom team → normName → matches
    const postFix = nameMatches(normName(expandAlias('BB Team')), normName('BetBoom Team'));
    t.assert(postFix === true, `pós-fix esperado true, got ${postFix}`);
  });
};
