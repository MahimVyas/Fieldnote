const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

/* Force the template fallback so brief tests never depend on a local Ollama server. */
process.env.FIELDNOTE_OLLAMA_URL = 'http://127.0.0.1:1';

const { plan, reviewEvidence, writeBrief, validateCitations, documentReader, reconstructAbstract, extractiveFindings, expandQuery } = require('../agents');

test('planner maps every enabled source to a specialist agent', () => {
  const tasks = plan('test question', ['Web', 'Papers', 'YouTube', 'Documents']);
  assert.deepEqual(tasks.map(t => t.name).sort(), ['document-reader', 'paper-trail', 'video-listener', 'web-scout']);
  assert.ok(tasks.every(t => typeof t.execute === 'function' && t.question === 'test question'));
});

test('planner ignores unknown sources', () => {
  assert.deepEqual(plan('test question', ['Web', 'Bogus']).map(t => t.name), ['web-scout']);
  assert.deepEqual(plan('test question', []), []);
});

test('evidence reviewer removes duplicate URLs and ranks scholarly work first', () => {
  const sources = reviewEvidence([
    { title: 'Web result', url: 'https://example.com/a', source_type: 'Web', reliability: 'context' },
    { title: 'Duplicate', url: 'https://example.com/a/', source_type: 'Web', reliability: 'context' },
    { title: 'Paper', url: 'https://doi.org/10/example', source_type: 'Paper', reliability: 'scholarly' }
  ]);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].title, 'Paper');
});

test('evidence reviewer handles empty and title-only input', () => {
  assert.deepEqual(reviewEvidence([]), []);
  const sources = reviewEvidence([{ title: 'Untitled note', source_type: 'Document', reliability: 'private' }]);
  assert.equal(sources.length, 1);
});

test('brief remains traceable and caveated', async () => {
  const brief = await writeBrief('test question', [{ title: 'Paper', source_type: 'Paper', reliability: 'scholarly' }]);
  assert.match(brief.opening, /reviewed sources/);
  assert.match(brief.caveat, /Confirm authorship/);
  assert.equal(brief.findings.length, 3);
  assert.equal(brief.research_gaps.length, 3);
  assert.equal(brief.coverage.total, 1);
  assert.equal(brief.coverage.papers, 1);
  assert.ok(Array.isArray(brief.evidence_map));
});

test('brief reports thin scholarly coverage as a gap', async () => {
  const brief = await writeBrief('test question', [{ title: 'Blog', source_type: 'Web', reliability: 'context' }]);
  assert.match(brief.findings[0], /No scholarly records/);
  assert.match(brief.research_gaps[0], /thin/);
});

test('OpenAlex inverted index reconstructs to readable text', () => {
  assert.equal(reconstructAbstract({ quick: [0], brown: [1], fox: [2] }), 'quick brown fox');
  assert.equal(reconstructAbstract(null), '');
  assert.equal(reconstructAbstract({}), '');
});

test('extractive summarizer pulls traceable sentences from excerpts', () => {
  const sources = [
    { title: 'Spaced Repetition Study', source_type: 'Paper', reliability: 'scholarly', excerpt: 'Spaced repetition significantly improves long-term retention compared to massed practice. The experiment involved forty undergraduate students over twelve weeks of testing.' },
    { title: 'Learning Blog', source_type: 'Web', reliability: 'context', excerpt: 'Many learners report that spaced repetition feels harder at first. Over time, however, spaced repetition produces stronger recall than cramming sessions.' },
    { title: 'Placeholder', source_type: 'Paper', reliability: 'record', excerpt: 'Scholarly record returned by Crossref.' }
  ];
  const findings = extractiveFindings('spaced repetition retention recall', sources, 3);
  assert.equal(findings.length, 3);
  assert.ok(findings.every(f => f.includes('—')));
  assert.ok(findings.some(f => f.includes('Spaced Repetition Study')));
  assert.ok(!findings.some(f => f.includes('Placeholder')));
});

test('extractive summarizer skips placeholder excerpts', () => {
  assert.deepEqual(extractiveFindings('anything here', [{ title: 'P', excerpt: 'Scholarly record returned by arXiv.' }]), []);
});

test('query expansion adds salient title terms', () => {
  const sources = [{ title: 'Spaced repetition and retention intervals' }, { title: 'Retention intervals in classroom practice' }];
  const expanded = expandQuery('spaced repetition retention', sources);
  assert.ok(expanded.includes('intervals'));
  assert.deepEqual(expandQuery('spaced repetition', []), null);
});

test('brief with real excerpts uses extractive synthesis', async () => {
  const brief = await writeBrief('spaced repetition retention', [
    { title: 'Spaced Repetition Study', source_type: 'Paper', reliability: 'scholarly', relevance: { score: 80, terms: [] }, excerpt: 'Spaced repetition significantly improves long-term retention compared to massed practice in this study.' }
  ]);
  assert.equal(brief.synthesis, 'extractive');
  assert.ok(brief.findings[0].includes('—'));
});

test('evidence map preserves open-access URLs', async () => {
  const brief = await writeBrief('open access research', [
    { title: 'OA Paper', source_type: 'Paper', reliability: 'scholarly', url: 'https://doi.org/10/example', excerpt: 'Too short.' , open_access_url: 'https://example.org/paper.pdf' }
  ]);
  assert.equal(brief.evidence_map[0].open_access_url, 'https://example.org/paper.pdf');
});

test('document reader matches local files and ignores other extensions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldnote-docs-'));
  await fs.writeFile(path.join(dir, 'notes.md'), 'Independent education benefits from blended learning outcomes.');
  await fs.writeFile(path.join(dir, 'todo.txt'), 'Buy groceries and water the plants.');
  await fs.writeFile(path.join(dir, 'slides.pdf'), 'Independent education benefits from blended learning outcomes.');
  const results = await documentReader('blended learning outcomes in independent education', dir);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'notes.md');
  assert.equal(results[0].reliability, 'private');
  await fs.rm(dir, { recursive: true, force: true });
});

test('document reader returns empty for a missing directory', async () => {
  assert.deepEqual(await documentReader('anything', path.join(os.tmpdir(), 'fieldnote-nope-404')), []);
});

test('citation validator flags reachable and unreachable URLs', async () => {
  const server = http.createServer((req, res) => { res.writeHead(req.method === 'HEAD' ? 200 : 200); res.end(); });
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const results = await validateCitations([
    { title: 'Live', url: `http://127.0.0.1:${port}/ok`, source_type: 'Web' },
    { title: 'Dead', url: 'http://127.0.0.1:1/gone', source_type: 'Web' },
    { title: 'Local note', url: null, source_type: 'Document' }
  ]);
  await new Promise(resolve => server.close(resolve));
  assert.equal(results.find(r => r.title === 'Live').reachable, true);
  assert.equal(results.find(r => r.title === 'Dead').reachable, false);
  assert.equal(results.find(r => r.title === 'Local note').reachable, null);
});
