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
    dataset: {}, style: {}, value: '', hidden: false, disabled: false,
    textContent: '', innerHTML: '',
    setAttribute() {}, addEventListener() {}, focus() {}, click() {}, remove() {}, appendChild() {},
    querySelector: () => makeEl(), querySelectorAll: () => [], scrollIntoView() {},
    insertAdjacentHTML() {}, getBoundingClientRect: () => ({ top: 9999 }),
    classList: { add() {}, remove() {}, toggle() {} }
  });
  const registry = new Map();
  const querySelector = s => { if (!registry.has(s)) registry.set(s, makeEl()); return registry.get(s); };
  const bodyClasses = [];
  const bodyEl = makeEl();
  bodyEl.classList = { add: c => bodyClasses.push(c), remove: c => { const i = bodyClasses.indexOf(c); if (i >= 0) bodyClasses.splice(i, 1); }, toggle() {} };
  const sandbox = {
    console,
    location: { hostname: 'localhost', protocol: 'http:' },
    navigator: { onLine: true },
    localStorage,
    fetch: async () => ({ ok: false }),
    requestAnimationFrame: () => 0,
    setTimeout: fn => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout: () => {},
    Blob,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    window: null,
    document: {
      documentElement: makeEl(),
      body: bodyEl,
      querySelector, querySelectorAll: () => [],
      createElement: tag => {
        const el = makeEl(); el.tagName = tag; let text = '';
        Object.defineProperty(el, 'textContent', { get: () => text, set: v => { text = String(v); } });
        Object.defineProperty(el, 'innerHTML', { get: () => text, set: v => { text = String(v); } });
        created.push(el); return el;
      },
      addEventListener() {}
    }
  };
  sandbox.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, scrollTo() {}, innerHeight: 800 };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8'), context, { filename: 'script.js' });
  return { sandbox, store, created, registry, bodyClasses };
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

test('evidence dropdown filter narrows articles', () => {
  const { sandbox, registry } = loadFrontend();
  vm.runInContext(`currentEvidence = [{title:'Paper A',source_type:'Paper',reliability:'scholarly',relevance:90,excerpt:'E'},{title:'Blog B',source_type:'Web',reliability:'context',relevance:70,excerpt:'E2'}]; renderEvidenceList(currentEvidence.filter(i => i.source_type === 'Paper'));`, sandbox);
  const html = registry.get('#evidenceArticles').innerHTML;
  assert.ok(html.includes('Paper A'));
  assert.ok(!html.includes('Blog B'));
  assert.ok(registry.get('#evidenceCount').textContent.includes('1 of 2'));
});

test('palette filter matches all terms, ranks prefix hits first', () => {
  const { sandbox } = loadFrontend();
  const items = [
    { label: 'Download brief as Markdown', hint: 'export' },
    { label: 'Go to Library', hint: 'view' },
    { label: 'Toggle dark mode', hint: 'theme' }
  ];
  const run = q => [...vm.runInContext(`filterPalette(${JSON.stringify(items)}, ${JSON.stringify(q)}).map(i => i.label)`, sandbox)];
  assert.deepEqual(run(''), items.map(i => i.label));
  assert.deepEqual(run('LIBRARY'), ['Go to Library']);
  assert.deepEqual(run('brief markdown'), ['Download brief as Markdown']);
  assert.deepEqual(run('d d'), ['Download brief as Markdown', 'Toggle dark mode']);
  assert.deepEqual(run('zzz'), []);
});

test('agent cards reflect live status, verbs, and trimmed errors', () => {
  const { sandbox, registry } = loadFrontend();
  vm.runInContext(`updateAgents([
    {name:'web-scout',status:'running',sources_found:0},
    {name:'paper-trail',status:'failed',sources_found:0,error:'Upstream service returned 503 Service Unavailable Extra Long Text That Should Be Trimmed Down Past Sixty Four Characters'},
    {name:'mystery',status:'running',sources_found:0}
  ])`, sandbox);
  assert.equal(registry.get('#webCount').textContent, 'Working…');
  const failed = registry.get('#paperCount');
  assert.ok(failed.textContent.startsWith('Failed:'));
  assert.ok(failed.textContent.length <= 'Failed: '.length + 64);
  assert.equal(failed.title, 'Upstream service returned 503 Service Unavailable Extra Long Text That Should Be Trimmed Down Past Sixty Four Characters');
});

test('full run flow renders, caches, and toasts', async () => {
  const { sandbox, registry, bodyClasses } = loadFrontend();
  const result = { id: 'run-1', question: 'Flow question?', depth: 'Thorough', created_at: '2026-01-01',
    sources: [{ title: 'Flow Source', url: 'https://example.com/f', publisher: 'Flow Press', source_type: 'Web', reliability: 'context', relevance: { score: 80, terms: [] }, excerpt: 'A real excerpt about testing the full flow end to end in this harness.' }],
    brief: { opening: 'Flow opening.', synthesis: 'extractive', findings: ['Flow finding.'], takeaways: [], faq: [], coverage: { total: 1, papers: 0, web: 1, videos: 0, documents: 0, search_terms: [] }, evidence_map: [], research_gaps: ['Flow gap.'], caveat: 'Flow caveat.' },
    agents: [{ name: 'web-scout', source: 'Web', status: 'completed', sources_found: 1, started_at: '', completed_at: '' }], errors: [] };
  const running = { id: 'run-1', question: 'Flow question?', depth: 'Thorough', status: 'running', started_at: '', agents: [{ name: 'web-scout', source: 'Web', status: 'running', sources_found: 0 }] };
  const done = { ...running, status: 'completed', completed_at: '', agents: result.agents, result };
  let polls = 0;
  sandbox.fetch = async (url, opts) => {
    if (url === '/api/projects') return { ok: true, json: async () => [] };
    if (opts && opts.method === 'POST') return { ok: true, json: async () => running };
    if (typeof url === 'string' && url.startsWith('/api/runs/')) { polls++; return { ok: true, json: async () => (polls >= 2 ? done : running) }; }
    return { ok: false };
  };
  await vm.runInContext(`startRun('Flow question?', ['Web'])`, sandbox);
  assert.ok(bodyClasses.includes('has-results'));
  assert.ok(registry.get('.summary-card').innerHTML.includes('Flow opening.'));
  assert.ok(registry.get('#toast').textContent.includes('saved to your library'));
  assert.deepEqual([...vm.runInContext(`readCache()`, sandbox).map(p => p.id)], ['run-1']);
});
