const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

/* Force deterministic offline briefs: no OpenRouter key here, Ollama pointed
   at a dead port, and AI providers disabled entirely. */
delete process.env.FIELDNOTE_OPENROUTER_API_KEY;
process.env.FIELDNOTE_OLLAMA_URL = 'http://127.0.0.1:1';
process.env.FIELDNOTE_AI = 'off';

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

test('research grade scores signals into four labeled tiers', () => {
  const { gradeResearch } = require('../agents');
  const empty = gradeResearch([]);
  assert.equal(empty.label, 'Limited');
  assert.equal(empty.score, 0);
  const rich = gradeResearch(Array.from({ length: 12 }, (_, i) => ({
    title: `Paper ${i} on spaced repetition retention effects studied deeply`,
    source_type: i % 4 === 0 ? 'Web' : i % 4 === 1 ? 'Video' : i % 4 === 2 ? 'Document' : 'Paper',
    reliability: 'scholarly', relevance: { score: 85, terms: [] },
    excerpt: 'Spaced repetition significantly improves long-term retention compared to massed practice in this extended longitudinal study of learners.'
  })));
  assert.equal(rich.label, 'Comprehensive');
  assert.ok(rich.score >= 80);
  assert.equal(rich.factors.reduce((n, f) => n + f.points, 0), rich.score);
  assert.deepEqual(rich.factors.map(f => f.max), [25, 25, 20, 15, 15]);
});

test('JSON extractor tolerates fences and trailing prose', () => {
  const { extractJson } = require('../agents');
  assert.deepEqual(extractJson('```json\n{"a": 1, "t": "x { y } \\"q\\""}\n```\nsome trailing [ prose'), { a: 1, t: 'x { y } "q"' });
  assert.throws(() => extractJson('no json here'), /No JSON/);
  assert.throws(() => extractJson('{"a": 1'), /Unbalanced/);
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

test('fallback brief carries takeaways and an empty faq', async () => {
  delete process.env.FIELDNOTE_OPENROUTER_API_KEY;
  const brief = await writeBrief('spaced repetition retention', [
    { title: 'Spaced Repetition Study', source_type: 'Paper', reliability: 'scholarly', excerpt: 'Spaced repetition significantly improves long-term retention compared to massed practice in this study.' }
  ]);
  assert.ok(Array.isArray(brief.takeaways) && brief.takeaways.length > 0);
  assert.deepEqual(brief.faq, []);
});

test('markdown export contains question, findings, sources, and gaps', async () => {
  const { briefToMarkdown } = require('../agents');
  const project = { question: 'Test question?', created_at: '2026-01-01', sources: [{ title: 'OA Paper', url: 'https://doi.org/10/e', publisher: 'X', source_type: 'Paper', reliability: 'scholarly', open_access_url: 'https://example.org/p.pdf' }], brief: { opening: 'Opening line.', synthesis: 'extractive', findings: ['Finding one.'], takeaways: ['Takeaway one.'], faq: [{ q: 'What?', a: 'This.' }], evidence_map: [{ title: 'OA Paper', url: 'https://doi.org/10/e', source_type: 'Paper', reliability: 'scholarly', relevance: 90, excerpt: 'Excerpt here.', open_access_url: 'https://example.org/p.pdf' }], research_gaps: ['Gap one.'], caveat: 'Be careful.' } };
  const md = briefToMarkdown(project);
  for (const needle of ['# Test question?', 'Opening line.', '## Key findings', 'Finding one.', '## Key takeaways', 'Takeaway one.', '## Study questions', 'What?', '## Research gaps', 'Gap one.', 'https://example.org/p.pdf', '## All sources', 'Be careful.']) assert.ok(md.includes(needle), `missing: ${needle}`);
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
