const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewEvidence, writeBrief } = require('../agents');

test('evidence reviewer removes duplicate URLs and ranks scholarly work first', () => {
  const sources = reviewEvidence([
    { title: 'Web result', url: 'https://example.com/a', source_type: 'Web', reliability: 'context' },
    { title: 'Duplicate', url: 'https://example.com/a', source_type: 'Web', reliability: 'context' },
    { title: 'Paper', url: 'https://doi.org/10/example', source_type: 'Paper', reliability: 'scholarly' }
  ]);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].title, 'Paper');
});

test('brief remains traceable and caveated', async () => {
  const brief = await writeBrief('test question', [{ title: 'Paper', source_type: 'Paper', reliability: 'scholarly' }]);
  assert.match(brief.opening, /reviewed sources/);
  assert.match(brief.caveat, /Confirm authorship/);
});
