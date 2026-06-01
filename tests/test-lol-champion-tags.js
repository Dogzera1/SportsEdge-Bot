'use strict';
const assert = require('assert');
const { buildTagsArtifact } = require('../scripts/build-lol-champion-tags');

module.exports = function(t) {
  t.test('maps ddragon data to normalized champ keys with tags+info', () => {
    const dd = { data: {
      Aatrox: { id: 'Aatrox', tags: ['Fighter', 'Tank'], info: { attack: 8, defense: 4, magic: 3, difficulty: 4 } },
      MonkeyKing: { id: 'MonkeyKing', tags: ['Fighter'], info: { attack: 7, defense: 5, magic: 2, difficulty: 3 } },
    }};
    const art = buildTagsArtifact(dd);
    assert.deepStrictEqual(art.aatrox.tags, ['Fighter', 'Tank'], 'aatrox tags');
    assert.strictEqual(art.aatrox.info.attack, 8, 'aatrox attack');
    // normalizeChampion folds MonkeyKing -> wukong (alias in lib/lol-champions.js)
    assert.ok(art.wukong, 'MonkeyKing folds to wukong key');
    assert.strictEqual(art.wukong.tags[0], 'Fighter', 'wukong tag');
  });

  t.test('skips entries without id', () => {
    const art = buildTagsArtifact({ data: { Bad: { tags: ['Mage'] } } });
    assert.strictEqual(Object.keys(art).length, 0, 'no id -> skipped');
  });
};
