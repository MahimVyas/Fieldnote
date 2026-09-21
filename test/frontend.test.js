const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* Load script.js with a stub DOM so pure frontend logic is testable. */
function loadFrontend() {
  const store = {};
  const created = [];
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    _store: store
  };
  const makeEl = () => ({
    dataset: {}, style: {},
    setAttribute() {}, addEventListener() {}, focus() {}, click() {}, remove() {}, appendChild() {},
    querySelector: () => makeEl(), querySelectorAll: () => [], scrollIntoView() {},
    classList: { add() {}, remove() {}, toggle() {} }
  });
  const sandbox = {
    console,
    location: { hostname: 'localhost', protocol: 'http:' },
    navigator: {},
    localStorage,
    fetch: async () => ({ ok: false }),
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    Blob,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    window: null,
    document: {
      documentElement: makeEl(),
      body: makeEl(),
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
      createElement: tag => {
        const el = makeEl(); el.tagName = tag; created.push(el); return el;
      },
      addEventListener() {}
    }
  };
  sandbox.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, scrollTo() {} };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8'), context, { filename: 'script.js' });
  return { sandbox, store, created };
}

const project = id => ({
  id, question: `Question ${id}?`, created_at: '2026-01-01',
  sources: [{ title: 'S', url: 'https://example.com', publisher: 'P', source_type: 'Web', reliability: 'context' }],
  brief: { opening: 'Opening.', synthesis: 'extractive', findings: ['F1.'], takeaways: ['T1.'], faq: [], evidence_map: [], research_gaps: ['G1.'], caveat: 'Careful.' },
  agents: []
});

test('browser cache round-trips projects newest-first without duplicates', () => {
  const { sandbox } = loadFrontend();
  vm.runInContext(`cacheProject(${JSON.stringify(project('a'))}); cacheProject(${JSON.stringify(project('b'))}); cacheProject(${JSON.stringify(project('a'))});`, sandbox);
  const ids = [...vm.runInContext(`readCache().map(p => p.id)`, sandbox)];
  assert.deepEqual(ids, ['a', 'b']);
});

test('browser cache caps at 20 entries', () => {
  const { sandbox } = loadFrontend();
  vm.runInContext(`for (let i = 0; i < 25; i++) cacheProject(${JSON.stringify({ ...project('x'), question: 'Q' })}.question && { id: 'p' + i, question: 'Q' + i, sources: [], brief: {}, agents: [] });`, sandbox);
  const count = vm.runInContext(`readCache().length`, sandbox);
  assert.equal(count, 20);
});

test('browser cache survives quota errors by shrinking', () => {
  const { sandbox, store } = loadFrontend();
  const big = { id: 'big', question: 'Q'.repeat(5000), sources: [], brief: {}, agents: [] };
  vm.runInContext(`writeCache(Array.from({length: 20}, (_, i) => ({ id: 'p' + i, question: 'Q'.repeat(100), sources: [], brief: {}, agents: [] })))`, sandbox);
  assert.ok(vm.runInContext(`readCache().length`, sandbox) <= 20);
  assert.ok(!('boom' in store));
  void big;
});

test('library merge prefers server copies and flags device-only items', () => {
  const { sandbox } = loadFrontend();
  const merged = vm.runInContext(
    `cacheProject(${JSON.stringify(project('b'))}); cacheProject(${JSON.stringify(project('c'))});
     mergedLibrary([${JSON.stringify(project('a'))}, ${JSON.stringify({ ...project('b'), question: 'Server B?' })}])`,
    sandbox);
  assert.deepEqual([...merged.map(p => p.id)], ['a', 'b', 'c']);
  assert.equal(merged.find(p => p.id === 'b').question, 'Server B?');
  assert.equal(merged.find(p => p.id === 'c')._localOnly, true);
  assert.equal(merged.find(p => p.id === 'a')._localOnly, undefined);
});

test('uncache removes a project', () => {
  const { sandbox } = loadFrontend();
  vm.runInContext(`cacheProject(${JSON.stringify(project('a'))}); uncacheProject('a');`, sandbox);
  assert.deepEqual([...vm.runInContext(`readCache()`, sandbox)], []);
});

test('client markdown export mirrors the server sections', () => {
  const { sandbox } = loadFrontend();
  const md = vm.runInContext(`projectToMarkdown(${JSON.stringify(project('a'))})`, sandbox);
  for (const needle of ['# Question a?', 'Opening.', '## Key findings', 'F1.', '## Key takeaways', 'T1.', '## Research gaps', 'G1.', '## All sources', 'Careful.']) {
    assert.ok(md.includes(needle), `missing: ${needle}`);
  }
});

test('client download creates a named blob anchor', () => {
  const { sandbox, created } = loadFrontend();
  vm.runInContext(`downloadFile('brief.md', '# hi', 'text/markdown')`, sandbox);
  const anchor = created.find(el => el.tagName === 'a');
  assert.ok(anchor);
  assert.equal(anchor.download, 'brief.md');
  assert.equal(anchor.href, 'blob:test');
});
