'use strict';
module.exports = function (t) {
  const { buildCsExplainPrompt, parseCsExplain } = require('../lib/cs-match-explain');

  t.test('cs-explain: prompt inclui times, prob e instrução de não alterar', () => {
    const pred = { probTeam1: 0.62, label: 'lean', components: { elo: { ratingTeam1: 1700, ratingTeam2: 1600 } } };
    const s = buildCsExplainPrompt({ pred, teams: { team1: 'FaZe', team2: 'NAVI' }, fairOdds: { team1: 1.61, team2: 2.63 }, edge: 0.05 });
    t.assert(s.includes('FaZe') && s.includes('NAVI'), 'times ausentes no prompt');
    t.assert(s.includes('62%'), 'prob ausente');
    t.assert(/NÃO o altere|não altere/i.test(s), 'falta instrução de preservar o prob');
    t.assert(s.includes('overview') && s.includes('verdict'), 'schema JSON ausente');
  });

  t.test('cs-explain: parse extrai os campos do JSON', () => {
    const out = parseCsExplain('lixo {"overview":"a","matchupRead":"b","verdict":"c"} fim');
    t.assert(out && out.overview === 'a' && out.matchupRead === 'b' && out.verdict === 'c', 'parse falhou');
  });

  t.test('cs-explain: parse de texto sem JSON → null', () => {
    t.assert(parseCsExplain('sem json aqui') === null, 'deveria ser null');
  });
};
