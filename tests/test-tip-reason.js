/**
 * Tests for lib/tip-reason — buildTipReason + esportsFactors + tennisFactors.
 */

const { buildTipReason, esportsFactors, tennisFactors } = require('../lib/tip-reason');

module.exports = function runTests(t) {
  t.test('buildTipReason: empty ctx → string vazia', () => {
    t.assert(buildTipReason() === '');
    t.assert(buildTipReason({}) === '');
    t.assert(buildTipReason({ pickTeam: '' }) === '');
  });

  t.test('buildTipReason: headline com modelP + implied + EV', () => {
    const r = buildTipReason({
      sport: 'lol',
      pickTeam: 'T1',
      modelPPick: 0.58,
      impliedP: 0.52,
      evPct: 11.5,
    });
    t.assert(r.includes('T1'), `missing pickTeam: ${r}`);
    t.assert(r.includes('58%'), 'missing modelP');
    t.assert(r.includes('52%'), 'missing implied');
    t.assert(r.includes('+11.5%') || r.includes('+11.5'), `missing EV: ${r}`);
  });

  t.test('buildTipReason: factors agregados', () => {
    const r = buildTipReason({
      pickTeam: 'A',
      modelPPick: 0.55,
      factors: [
        { label: 'Elo', value: '1500/1450' },
        { label: 'Form', value: '4-1 vs 2-3' },
      ],
    });
    t.assert(r.includes('Elo 1500/1450'));
    t.assert(r.includes('Form 4-1 vs 2-3'));
  });

  t.test('buildTipReason: respeita 160 char limit', () => {
    const r = buildTipReason({
      pickTeam: 'A',
      modelPPick: 0.50,
      factors: Array.from({ length: 10 }, (_, i) => ({
        label: `Long Factor Label ${i}`,
        value: `valor extenso com muito texto pra forçar overflow ${i}`,
      })),
    });
    t.assert(r.length <= 160, `len=${r.length}`);
  });

  t.test('esportsFactors: monta elo + form + h2h', () => {
    const out = esportsFactors({
      elo: { elo1: 1500, elo2: 1450 },
      form1: { wins: 4, losses: 1 },
      form2: { wins: 2, losses: 3 },
      h2h: { t1Wins: 3, t2Wins: 1, totalMatches: 4 },
    });
    t.assert(out.length === 3, `got ${out.length}`);
    t.assert(out[0].label === 'Elo');
    t.assert(out[0].value.includes('1500'));
    t.assert(out[1].label === 'Form');
    t.assert(out[2].label === 'H2H');
  });

  t.test('esportsFactors: ignora factor sem dados', () => {
    const out = esportsFactors({
      elo: { elo1: null, elo2: null },
      form1: { wins: 0, losses: 0 },
      form2: { wins: 0, losses: 0 },
      h2h: { totalMatches: 1 }, // <2 ignora
    });
    t.assert(out.length === 0, `got ${out.length}`);
  });

  t.test('esportsFactors: sideHint truncado', () => {
    const out = esportsFactors({
      sideHint: 'X'.repeat(100),
    });
    t.assert(out[0]?.value?.length <= 30, `value len=${out[0]?.value?.length}`);
  });

  t.test('tennisFactors: surface + elo + rank', () => {
    const out = tennisFactors({
      surface: 'hard',
      elo: { elo1: 1800, elo2: 1750 },
      rank1: 5, rank2: 12,
    });
    t.assert(out.find(f => f.label === 'Surf'));
    t.assert(out.find(f => f.label === 'Elo'));
    t.assert(out.find(f => f.label === 'Rank' && f.value.includes('#5')));
  });
};
