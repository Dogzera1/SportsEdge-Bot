/**
 * Tests pro Sprint 6 — lib/vlr._parseMapHeader + _parseAllMapHeaders pure parsers.
 *
 * Cobre:
 *   - Single map com winner + score
 *   - Bo3 com 2 maps played (parseAllMapHeaders)
 *   - Map sem winner (in-progress / not played)
 *   - Map name inválido (não é mapa Valorant conhecido)
 *   - Score capture (X-Y format)
 *   - HTML malformado/vazio
 */

const { _parseMapHeader, _parseAllMapHeaders } = require('../lib/vlr');

const MAP_HEADER_HAVEN_NAVI_WIN_HTML = `
<div class="vm-stats-game-header">
  <div class="team">
    <div class="team-name">NAVI</div>
    <div class="score mod-win">13</div>
  </div>
  <div class="map">
    <span>Haven<span class="picked">PICK</span></span>
  </div>
  <div class="team mod-right">
    <div class="team-name">Sentinels</div>
    <div class="score mod-lose">9</div>
  </div>
</div>
<div style="text-align: center">scoreboard</div>
`;

const MAP_HEADER_ASCENT_SEN_WIN_HTML = `
<div class="vm-stats-game-header">
  <div class="team">
    <div class="team-name">NAVI</div>
    <div class="score mod-lose">11</div>
  </div>
  <div class="map">
    <span>Ascent<span class="picked">PICK</span></span>
  </div>
  <div class="team mod-right">
    <div class="team-name">Sentinels</div>
    <div class="score mod-win">13</div>
  </div>
</div>
<div style="text-align: center">scoreboard</div>
`;

const BO3_FULL_HTML = MAP_HEADER_HAVEN_NAVI_WIN_HTML + MAP_HEADER_ASCENT_SEN_WIN_HTML + `
<div class="vm-stats-game-header">
  <div class="team">
    <div class="team-name">NAVI</div>
    <div class="score mod-win">13</div>
  </div>
  <div class="map">
    <span>Bind<span class="picked">PICK</span></span>
  </div>
  <div class="team mod-right">
    <div class="team-name">Sentinels</div>
    <div class="score mod-lose">7</div>
  </div>
</div>
<div style="text-align: center">scoreboard</div>
`;

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

test('parses single map header with winner and score', () => {
  const r = _parseMapHeader(MAP_HEADER_HAVEN_NAVI_WIN_HTML);
  assert(r !== null, 'should parse');
  assert(r.team1 === 'NAVI', `t1=${r.team1}`);
  assert(r.team2 === 'Sentinels', `t2=${r.team2}`);
  assert(r.mapName === 'Haven', `map=${r.mapName}`);
  assert(r.winner === 'NAVI', `winner=${r.winner}`);
  assert(r.score === '13-9', `score=${r.score}`);
});

test('parses map where team2 wins', () => {
  const r = _parseMapHeader(MAP_HEADER_ASCENT_SEN_WIN_HTML);
  assert(r !== null, 'should parse');
  assert(r.mapName === 'Ascent', `map=${r.mapName}`);
  assert(r.winner === 'Sentinels', `winner=${r.winner}`);
  assert(r.score === '11-13', `score=${r.score}`);
});

test('parses Bo3 full match (3 maps)', () => {
  const all = _parseAllMapHeaders(BO3_FULL_HTML);
  assert(all.length === 3, `expected 3 maps, got ${all.length}`);
  assert(all[0].mapName === 'Haven' && all[0].winner === 'NAVI', 'map1');
  assert(all[1].mapName === 'Ascent' && all[1].winner === 'Sentinels', 'map2');
  assert(all[2].mapName === 'Bind' && all[2].winner === 'NAVI', 'map3');
  assert(all[0].score === '13-9', `map1 score=${all[0].score}`);
  assert(all[1].score === '11-13', `map2 score=${all[1].score}`);
  assert(all[2].score === '13-7', `map3 score=${all[2].score}`);
});

test('returns null for empty/invalid HTML', () => {
  assert(_parseMapHeader('') === null, 'empty');
  assert(_parseMapHeader('<div>random</div>') === null, 'no header');
  assert(_parseAllMapHeaders('').length === 0, 'empty list');
});

test('returns null for unknown map name', () => {
  const badMap = MAP_HEADER_HAVEN_NAVI_WIN_HTML.replace('Haven', 'NonExistentMap');
  assert(_parseMapHeader(badMap) === null, 'unknown map rejected');
});

test('returns null when no winner (in-progress)', () => {
  const noWinner = MAP_HEADER_HAVEN_NAVI_WIN_HTML
    .replace('class="score mod-win"', 'class="score"')
    .replace('class="score mod-lose"', 'class="score"');
  const r = _parseMapHeader(noWinner);
  assert(r === null, `expected null, got ${JSON.stringify(r)}`);
});

// 2026-05-25 regression: VLR prod markup tem `class="score "` (trailing space)
// + `style="margin-right: 12px;"` attr. Audit live VLR 660380 capturava winner
// mas score=null → log mostrava "(?-?)". Fix em lib/vlr.js _parseMapHeader regex.
test('parses VLR live markup with trailing space + style attr', () => {
  const liveHtml = `
<div class="vm-stats-game-header">
  <div class="team">
    <div class="team-name">G2 Esports</div>
    <div class="score mod-win" style="margin-right: 12px;">13 </div>
  </div>
  <div class="map">
    <span>Ascent<span class="picked">PICK</span></span>
  </div>
  <div class="team mod-right">
    <div class="team-name">NRG</div>
    <div class="score " style="margin-left: 8px;">8</div>
  </div>
</div>
<div style="text-align: center">scoreboard</div>
`;
  const r = _parseMapHeader(liveHtml);
  assert(r !== null, 'should parse live markup');
  assert(r.winner === 'G2 Esports', `winner=${r.winner}`);
  assert(r.score === '13-8', `score=${r.score} (esperado 13-8, regex trailing-space fix)`);
});

let passed = 0, failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ✓ ${t.name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${t.name}: ${e.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
