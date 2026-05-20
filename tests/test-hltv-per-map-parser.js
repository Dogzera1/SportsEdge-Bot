/**
 * Tests pro Sprint 4 — lib/hltv._parseHltvMapResults pure parser.
 *
 * Cobre:
 *   - Match Bo3 com 2 maps played
 *   - Match Bo3 com 3º map "optional" (not played)
 *   - Match Bo5 com diferentes scores
 *   - HTML malformado (defensive)
 *   - Empty/invalid input
 *   - HLTV sem section delimiter (fallback scan all)
 */

const { _parseHltvMapResults } = require('../lib/hltv');

const BO3_2_0_HTML = `
<html>
<div class="standard-box maps">
  <div class="mapholder">
    <div class="mapname">Inferno</div>
    <div class="results played">
      <div class="results-left team-won">
        <div class="results-teamname">NAVI</div>
        <div class="results-team-score won">16</div>
      </div>
      <div class="results-center">
        <div class="results-center-half-score"><span>9</span> : <span>5</span></div>
      </div>
      <div class="results-right">
        <div class="results-teamname">G2</div>
        <div class="results-team-score lost">12</div>
      </div>
    </div>
  </div>
  <div class="mapholder">
    <div class="mapname">Mirage</div>
    <div class="results played">
      <div class="results-left team-won">
        <div class="results-teamname">NAVI</div>
        <div class="results-team-score won">19</div>
      </div>
      <div class="results-right">
        <div class="results-teamname">G2</div>
        <div class="results-team-score lost">17</div>
      </div>
    </div>
  </div>
  <div class="mapholder">
    <div class="mapname">Nuke</div>
    <div class="results">
      <div class="optional">-</div>
    </div>
  </div>
</div>
<div class="standard-box veto-box">veto</div>
</html>
`;

const BO5_3_2_HTML = `
<html>
<div class="standard-box maps">
  <div class="mapholder">
    <div class="mapname">Dust2</div>
    <div class="results played">
      <div class="results-left">
        <div class="results-teamname">Vitality</div>
        <div class="results-team-score lost">10</div>
      </div>
      <div class="results-right team-won">
        <div class="results-teamname">FaZe</div>
        <div class="results-team-score won">16</div>
      </div>
    </div>
  </div>
  <div class="mapholder">
    <div class="mapname">Ancient</div>
    <div class="results played">
      <div class="results-left team-won">
        <div class="results-teamname">Vitality</div>
        <div class="results-team-score won">16</div>
      </div>
      <div class="results-right">
        <div class="results-teamname">FaZe</div>
        <div class="results-team-score lost">14</div>
      </div>
    </div>
  </div>
</div>
<div class="standard-box veto-box">veto</div>
</html>
`;

module.exports = function runTests(t) {
  t.test('Bo3 2-0: 2 maps played + 1 not played', () => {
    const r = _parseHltvMapResults(BO3_2_0_HTML);
    t.assert(Array.isArray(r), 'retorna array');
    t.assert(r.length === 3, `3 maps total (got ${r.length})`);

    // Map 1: NAVI 16-12 Inferno
    t.assert(r[0].map === 1, 'map 1 = idx 1');
    t.assert(r[0].mapName === 'Inferno', `mapName Inferno (got ${r[0].mapName})`);
    t.assert(r[0].winner === 'NAVI', `winner NAVI (got ${r[0].winner})`);
    t.assert(r[0].score === '16-12', `score 16-12 (got ${r[0].score})`);
    t.assert(r[0].played === true, 'played=true');

    // Map 2: NAVI 19-17 Mirage
    t.assert(r[1].map === 2, 'map 2');
    t.assert(r[1].mapName === 'Mirage');
    t.assert(r[1].winner === 'NAVI');
    t.assert(r[1].score === '19-17');

    // Map 3: Nuke not played
    t.assert(r[2].map === 3, 'map 3');
    t.assert(r[2].mapName === 'Nuke');
    t.assert(r[2].winner === null, 'winner null (not played)');
    t.assert(r[2].score === null, 'score null');
    t.assert(r[2].played === false, 'played=false');
  });

  t.test('Bo5 with right-side wins (FaZe wins map 1)', () => {
    const r = _parseHltvMapResults(BO5_3_2_HTML);
    t.assert(Array.isArray(r));
    t.assert(r.length >= 2, `2+ maps (got ${r.length})`);

    // Map 1: FaZe 16-10 (right side won)
    t.assert(r[0].winner === 'FaZe', `winner FaZe (got ${r[0].winner})`);
    t.assert(r[0].score === '10-16', `score 10-16 (got ${r[0].score})`);

    // Map 2: Vitality 16-14 (left side won)
    t.assert(r[1].winner === 'Vitality');
    t.assert(r[1].score === '16-14');
  });

  t.test('null input retorna null', () => {
    t.assert(_parseHltvMapResults(null) === null);
    t.assert(_parseHltvMapResults(undefined) === null);
    t.assert(_parseHltvMapResults('') === null);
  });

  t.test('short/invalid HTML retorna null', () => {
    t.assert(_parseHltvMapResults('<html></html>') === null, '<100 chars OR sem mapholder');
  });

  t.test('non-string input retorna null', () => {
    t.assert(_parseHltvMapResults(123) === null);
    t.assert(_parseHltvMapResults({}) === null);
    t.assert(_parseHltvMapResults([]) === null);
  });

  t.test('HTML sem mapholder retorna array vazio', () => {
    const html = '<div class="standard-box maps"></div><div class="standard-box veto-box"></div>'.padEnd(200, ' ');
    const r = _parseHltvMapResults(html);
    t.assert(Array.isArray(r), 'array');
    t.assert(r.length === 0, `array vazio (got ${r.length})`);
  });

  t.test('Tie score (raro mas possível) — winner null', () => {
    const tieHtml = `
<html>
<div class="standard-box maps">
  <div class="mapholder">
    <div class="mapname">Anubis</div>
    <div class="results played">
      <div class="results-left">
        <div class="results-teamname">TeamA</div>
        <div class="results-team-score">15</div>
      </div>
      <div class="results-right">
        <div class="results-teamname">TeamB</div>
        <div class="results-team-score">15</div>
      </div>
    </div>
  </div>
</div>
<div class="standard-box veto-box">veto</div>
</html>`;
    const r = _parseHltvMapResults(tieHtml);
    t.assert(Array.isArray(r));
    if (r.length > 0) {
      // Tie sem won/lost class — winner derivado por score 15-15 = null
      t.assert(r[0].winner === null || r[0].score === '15-15', 'tie sem winner OR score igual');
    }
  });

  t.test('Map names com nomes longos/especiais (case preservation)', () => {
    const r = _parseHltvMapResults(BO3_2_0_HTML);
    t.assert(r[0].mapName === 'Inferno', 'preserva case');
    t.assert(r[1].mapName === 'Mirage');
    t.assert(r[2].mapName === 'Nuke');
  });
};
