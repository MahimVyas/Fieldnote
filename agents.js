const fs = require('node:fs/promises');
const path = require('node:path');

const clean = value => String(value || '')
  .replace(/<[^>]+>/g, '').replace(/&#0*39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
  .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ').trim();
const excerpt = value => clean(value).slice(0, 900);
const query = value => encodeURIComponent(clean(value).slice(0, 240));
const stopWords = new Set(['about', 'after', 'affect', 'does', 'effect', 'effects', 'from', 'have', 'how', 'into', 'learning', 'outcome', 'outcomes', 'that', 'the', 'their', 'what', 'with']);
const tokens = value => clean(value).toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1 && !stopWords.has(word));
function relevance(question, candidate) {
  const terms = tokens(question); const body = `${candidate.title || ''} ${candidate.excerpt || ''}`.toLowerCase();
  const matches = terms.filter(term => body.includes(term));
  return { score: terms.length ? Math.round((matches.length / terms.length) * 100) : 0, terms: matches };
}

async function fetchJson(url, opts = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Fieldnote/1.0 (+local research workbench)' }, signal: AbortSignal.timeout(9000), ...opts });
  if (!response.ok) throw new Error(`Upstream service returned ${response.status}`);
  return response.json();
}
function source(input) {
  return { id: `${input.source_type}:${input.url || input.title}`.toLowerCase(), reliability: input.reliability || 'context', ...input };
}

/* ── Helpers for deep research ──────────────────────────────────── */
function reconstructAbstract(inverted) {
  if (!inverted || typeof inverted !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(inverted)) for (const pos of positions) words[pos] = word;
  return words.filter(Boolean).join(' ');
}
function splitSentences(text) {
  return clean(text).split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/).map(s => s.trim()).filter(s => s.length >= 40 && s.length <= 320);
}
const PLACEHOLDER_EXCERPT = /^(Scholarly record returned by|A current YouTube search|A YouTube search result)/;
function extractiveFindings(question, sources, count = 3) {
  const terms = tokens(question); const weight = { scholarly: 3, private: 2, record: 1.5, context: 1, discovery: 0.5 };
  const candidates = [];
  for (const s of sources) {
    if (!s.excerpt || PLACEHOLDER_EXCERPT.test(s.excerpt)) continue;
    for (const sentence of splitSentences(s.excerpt)) {
      const lower = sentence.toLowerCase();
      const hits = terms.filter(t => lower.includes(t)).length;
      if (!hits) continue;
      candidates.push({ sentence, title: s.title, score: hits * (weight[s.reliability] || 1) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked = []; const seen = new Set();
  for (const c of candidates) {
    const key = c.sentence.toLowerCase().replace(/\W/g, '').slice(0, 60);
    if (seen.has(key)) continue; seen.add(key); picked.push(`“${c.sentence}” — ${c.title}`);
    if (picked.length >= count) break;
  }
  return picked;
}
function expandQuery(question, sources) {
  const qterms = new Set(tokens(question)); const freq = new Map();
  for (const s of sources) for (const w of clean(s.title).toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length > 3 && !qterms.has(w) && !stopWords.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  const extra = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
  return extra.length ? `${clean(question)} ${extra.join(' ')}` : null;
}
async function fetchWikipediaExtracts(titles) {
  try {
    const data = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&exsectionformat=plain&titles=${titles.map(t => encodeURIComponent(t)).join('|')}&format=json&origin=*`);
    const out = new Map();
    for (const page of Object.values(data.query?.pages || {})) if (page.title && page.extract) out.set(page.title, clean(page.extract).slice(0, 900));
    return out;
  } catch { return new Map(); }
}
async function fetchOpenAlex(question, limit) {
  try {
    const data = await fetchJson(`https://api.openalex.org/works?search=${query(question)}&per-page=${limit}&select=id,doi,title,abstract_inverted_index,publication_year,cited_by_count,primary_location,best_oa_location`);
    return (data.results || []).map(item => source({
      title: clean(item.title), url: item.doi || item.primary_location?.landing_page_url, source_type: 'Paper',
      excerpt: reconstructAbstract(item.abstract_inverted_index).slice(0, 900) || 'Scholarly record returned by OpenAlex.',
      published_at: item.publication_year ? String(item.publication_year) : null,
      publisher: clean(item.primary_location?.source?.display_name) || 'OpenAlex', reliability: 'scholarly', citations: Number(item.cited_by_count || 0),
      open_access_url: item.best_oa_location?.pdf_url || item.best_oa_location?.landing_page_url || null
    }));
  } catch { return []; }
}

/* ── Web Scout: Wikipedia + SearXNG ──────────────────────────────── */
async function webScout(question, opts = {}) {
  const deep = (opts.depth || 'Thorough') === 'Thorough';
  const results = [];
  try {
    const data = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${query(question)}&format=json&origin=*`);
    (data.query?.search || []).slice(0, deep ? 10 : 6).forEach(item => {
      results.push(source({
        title: clean(item.title), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
        source_type: 'Web', excerpt: excerpt(item.snippet), published_at: null, publisher: 'Wikipedia', reliability: 'context'
      }));
    });
  } catch {}
  /* Add SearXNG results if configured */
  const searxUrl = process.env.FIELDNOTE_SEARX_URL;
  if (searxUrl) {
    try {
      const base = searxUrl.endsWith('/') ? searxUrl.slice(0, -1) : searxUrl;
      const data = await fetchJson(`${base}/search.json?q=${query(question)}&format=json&categories=general&number=${deep ? 8 : 5}`);
      (data.results || []).forEach(item => {
        const url = item.url || item.link;
        if (!url || results.find(r => r.url === url)) return;
        results.push(source({
          title: clean(item.title), url, source_type: 'Web',
          excerpt: clean(item.content || item.description || '').slice(0, 420),
          published_at: null, publisher: new URL(url).hostname || 'Search', reliability: 'context'
        }));
      });
    } catch {}
  }
  /* Deep mode: replace snippets with full article introductions */
  if (deep && results.length) {
    const extracts = await fetchWikipediaExtracts(results.filter(r => r.publisher === 'Wikipedia').slice(0, 5).map(r => r.title));
    results.forEach(r => { const full = extracts.get(r.title); if (full) r.excerpt = full; });
  }
  return results.map(r => ({ ...r, relevance: relevance(question, r) }))
    .filter(r => r.relevance.score > 0).sort((a, b) => b.relevance.score - a.relevance.score).slice(0, deep ? 8 : 5);
}

/* ── Paper Trail: Crossref + Semantic Scholar + arXiv + OpenAlex ── */
async function fetchCrossref(question, rows) {
  try {
    const data = await fetchJson(`https://api.crossref.org/works?query=${query(question)}&rows=${rows}&select=title,URL,abstract,published-print,published-online,DOI,container-title,type,is-referenced-by-count`);
    return (data.message?.items || []).filter(item => item.title?.[0]).map(item => {
      const date = item['published-print']?.['date-parts']?.[0] || item['published-online']?.['date-parts']?.[0];
      return source({ title: clean(item.title[0]), url: item.URL || `https://doi.org/${item.DOI}`, source_type: 'Paper', excerpt: excerpt(item.abstract) || 'Scholarly record returned by Crossref.', published_at: date ? date.join('-') : null, publisher: clean(item['container-title']?.[0]) || 'Crossref', reliability: item.type === 'journal-article' ? 'scholarly' : 'record', citations: Number(item['is-referenced-by-count'] || 0) });
    });
  } catch { return []; }
}
async function fetchSemanticScholar(question, limit) {
  try {
    const data = await fetchJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${query(question)}&limit=${limit}&fields=title,abstract,url,year,venue,citationCount,publicationTypes`);
    return (data.data || []).map(item => source({ title: clean(item.title), url: item.url, source_type: 'Paper', excerpt: excerpt(item.abstract) || 'Scholarly record returned by Semantic Scholar.', published_at: item.year ? String(item.year) : null, publisher: clean(item.venue) || 'Semantic Scholar', reliability: item.publicationTypes?.includes('JournalArticle') ? 'scholarly' : 'record', citations: Number(item.citationCount || 0) }));
  } catch { return []; }
}
async function fetchArxiv(question, limit) {
  try {
    const data = await fetchJson(`https://export.arxiv.org/api/query?search_query=all:${query(question)}&start=0&max_results=${limit}&sortBy=relevance&sortOrder=descending`);
    return [...data.feed.entry || []].map(entry => {
      const title = clean(entry.title?.[0] || '');
      const abs = clean(entry.summary?.[0] || '');
      const arxivId = (entry.id?.[0] || '').replace(/^http:\/\/arxiv\.org\/abs\//, '').replace(/^https:\/\/arxiv\.org\/abs\//, '');
      if (!title) return null;
      return source({ title, url: entry.link?.find(l => l.$.rel === 'alternate')?.$.href || `https://arxiv.org/abs/${arxivId}`, source_type: 'Paper', excerpt: abs || 'Scholarly record returned by arXiv.', published_at: entry.published?.[0]?.replace(/T.*$/, '') || null, publisher: 'arXiv', reliability: 'scholarly', citations: 0 });
    }).filter(Boolean);
  } catch { return []; }
}
async function paperTrail(question, opts = {}) {
  const deep = (opts.depth || 'Thorough') === 'Thorough';
  const first = [
    ...await fetchCrossref(question, deep ? 10 : 8),
    ...await fetchSemanticScholar(question, deep ? 8 : 5),
    ...await fetchArxiv(question, deep ? 10 : 5)
  ];
  let results = first;
  if (deep) {
    results = [...results, ...await fetchOpenAlex(question, 10)];
    /* Second round: expand the query with salient terms from round one */
    const expanded = expandQuery(question, results);
    if (expanded) results = [...results, ...await fetchCrossref(expanded, 5), ...await fetchArxiv(expanded, 5)];
  }
  return results.map(r => ({ ...r, relevance: relevance(question, r) }))
    .filter(r => r.relevance.score > 0).sort((a, b) => b.relevance.score - a.relevance.score || b.citations - a.citations).slice(0, deep ? 14 : 6);
}

/* ── Video Listener: real YouTube search ────────────────────────── */
async function videoListener(question, opts = {}) {
  const deep = (opts.depth || 'Thorough') === 'Thorough';
  try {
    const html = await (await fetch(`https://www.youtube.com/results?search_query=${query(question)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }, signal: AbortSignal.timeout(9000) })).text();
    const ids = [...new Set(html.match(/\/watch\?v=([A-Za-z0-9_-]{11})/g)?.map(m => m.replace('/watch?v=', '')) || [])];
    if (!ids.length) return [];
    return ids.slice(0, deep ? 5 : 3).map(id => source({
      title: `YouTube video ${id}`, url: `https://www.youtube.com/watch?v=${id}`,
      source_type: 'Video', excerpt: 'A YouTube search result. Review the video, creator, date, and available transcript before citing it.',
      published_at: null, publisher: 'YouTube', reliability: 'discovery'
    }));
  } catch { return []; }
}

/* ── Document Reader ────────────────────────────────────────────── */
async function documentReader(question, opts = {}) {
  const documentsPath = typeof opts === 'string' ? opts : opts.documentsPath;
  const deep = typeof opts === 'string' || (opts.depth || 'Thorough') === 'Thorough';
  let files;
  try { files = await fs.readdir(documentsPath, { withFileTypes: true }); } catch { return []; }
  const terms = tokens(question); const results = [];
  for (const entry of files.filter(item => item.isFile() && /\.(md|txt)$/i.test(item.name)).slice(0, 100)) {
    const filePath = path.join(documentsPath, entry.name); const body = await fs.readFile(filePath, 'utf8').catch(() => '');
    const normalized = clean(body); const score = terms.reduce((count, term) => count + (normalized.toLowerCase().match(new RegExp(`\\b${term}\\b`, 'g')) || []).length, 0);
    if (score) results.push(source({ title: entry.name, url: null, source_type: 'Document', excerpt: normalized.slice(0, 420), published_at: null, publisher: 'Private document', reliability: 'private', score }));
  }
  return results.sort((a, b) => b.score - a.score).slice(0, deep ? 8 : 4);
}

/* ── Plan ───────────────────────────────────────────────────────── */
function plan(question, enabled) {
  const registry = { Web: ['web-scout', webScout], Papers: ['paper-trail', paperTrail], YouTube: ['video-listener', videoListener], Documents: ['document-reader', documentReader] };
  return enabled.filter(name => registry[name]).map(name => ({ name: registry[name][0], source: name, execute: registry[name][1], question }));
}

/* ── Review Evidence ────────────────────────────────────────────── */
function reviewEvidence(rawSources) {
  const seen = new Set();
  return rawSources.filter(item => {
    const key = (item.url || item.title).toLowerCase().replace(/\W/g, ''); if (!key || seen.has(key)) return false; seen.add(key); return true;
  }).sort((a, b) => {
    const rank = { scholarly: 4, private: 3, context: 2, record: 2, discovery: 1 }; return (b.relevance?.score || 0) - (a.relevance?.score || 0) || (rank[b.reliability] || 0) - (rank[a.reliability] || 0) || (b.citations || 0) - (a.citations || 0);
  });
}

/* ── Citation validator ─────────────────────────────────────────── */
async function validateCitations(sources) {
  const promises = sources.map(async (s) => {
    if (!s.url) return { ...s, reachable: null };
    try { const r = await fetch(s.url, { method: 'HEAD', signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Fieldnote/1.0' } }); return { ...s, reachable: r.ok }; } catch { return { ...s, reachable: false }; }
  });
  return Promise.all(promises);
}

/* ── LLM synthesis layer (OpenRouter → Ollama → extractive) ─────── */
const AI_BRIEF_FIELDS = `Return ONLY a valid JSON object with exactly these fields:
- "opening": one sentence summarizing what was found and how many sources of each type
- "findings": array of 3 short bullet strings, each a key insight traced to a specific source
- "takeaways": array of up to 5 one-sentence practical takeaways for someone studying this topic
- "faq": array of up to 5 objects {"q": "study question", "a": "answer grounded in the sources"} a learner could use for self-testing
- "caveat": one sentence about limitations
- "evidence_map": array of up to 5 objects: {title, source_type, reliability, relevance, excerpt, url}
- "research_gaps": array of 3 strings describing what remains unanswered

Do not add any commentary outside the JSON object.`;
function extractJson(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('No JSON in response');
  let depth = 0; let inString = false; let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) return JSON.parse(text.slice(start, i + 1)); }
  }
  throw new Error('Unbalanced JSON in response');
}
function parseAiBrief(raw, question, sources, engine, extra = {}) {
  const parsed = extractJson(raw);
  if (!parsed.opening || !Array.isArray(parsed.findings) || !Array.isArray(parsed.research_gaps)) throw new Error('Invalid brief structure');
  const byType = type => sources.filter(s => s.source_type === type).length;
  return { ...parsed,
    synthesis: 'llm', engine,
    takeaways: Array.isArray(parsed.takeaways) ? parsed.takeaways.slice(0, 5) : [],
    faq: (Array.isArray(parsed.faq) ? parsed.faq : []).filter(f => f && f.q && f.a).slice(0, 5),
    coverage: { total: sources.length, papers: byType('Paper'), web: byType('Web'), videos: byType('Video'), documents: byType('Document'), search_terms: tokens(question) },
    evidence_map: parsed.evidence_map || sources.slice(0, 5).map(s => ({ title: s.title, source_type: s.source_type, reliability: s.reliability, relevance: s.relevance?.score || null, excerpt: s.excerpt, url: s.url, open_access_url: s.open_access_url || null })),
    research_gaps: parsed.research_gaps || ['This run has not assessed study quality, conflicts of interest, or whether sources disagree; those require source-level review.'],
    synthesized: true, ...extra };
}
async function synthesizeWithPollinations(question, sources) {
  /* Keyless free fallback: only public excerpts ever leave the machine. */
  const validated = await validateCitations(sources.slice(0, 10));
  const reachable = validated.filter(v => v.reachable).slice(0, 10);
  const top = reachable.slice(0, 6).map(s => `[${s.source_type}] ${s.title} (${s.reliability})${s.excerpt ? ' — ' + s.excerpt.slice(0, 220) : ''}${s.url ? ' — ' + s.url : ''}`).join('\n');
  const prompt = [`You are an evidence reviewer producing NotebookLM-style study material. Read these sources and produce a traceable, caveated evidence brief plus study aids. Do not fabricate or infer anything beyond what the sources state.`, ``, `Question: ${question}`, ``, `Sources (${sources.length} total, ${reachable.length} reachable):\n${top}`, ``, AI_BRIEF_FIELDS].join('\n');
  const models = ['openai'];
  let lastError = null;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch('https://text.pollinations.ai/openai', {
          method: 'POST', signal: AbortSignal.timeout(60000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, temperature: 0.2, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
        });
        if (!response.ok) throw new Error(`Pollinations returned ${response.status}`);
        const data = await response.json();
        const raw = data.choices?.[0]?.message?.content || '';
        return parseAiBrief(raw, question, sources, 'pollinations', { model, citations_validated: reachable.length, citations_unreachable: validated.length - reachable.length });
      } catch (error) { lastError = error; }
    }
  }
  console.error(`Pollinations synthesis failed: ${lastError ? lastError.message : 'unknown'}`);
  return null;
}
async function synthesizeWithOpenRouter(question, sources) {
  const apiKey = process.env.FIELDNOTE_OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const model = process.env.FIELDNOTE_OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const validated = await validateCitations(sources.slice(0, 10));
  const reachable = validated.filter(v => v.reachable).slice(0, 10);
  const top = reachable.slice(0, 6).map(s => `[${s.source_type}] ${s.title} (${s.reliability})${s.excerpt ? ' — ' + s.excerpt.slice(0, 220) : ''}${s.url ? ' — ' + s.url : ''}`).join('\n');
  const prompt = [`You are an evidence reviewer producing NotebookLM-style study material. Read these sources and produce a traceable, caveated evidence brief plus study aids. Do not fabricate or infer anything beyond what the sources state.`, ``, `Question: ${question}`, ``, `Sources (${sources.length} total, ${reachable.length} reachable):\n${top}`, ``, AI_BRIEF_FIELDS].join('\n');
  try {
    const waits = [0, 8000, 20000];
    let response = null; let lastStatus = 0;
    for (const wait of waits) {
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(60000),
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Fieldnote' },
        body: JSON.stringify({ model, temperature: 0.2, max_tokens: 2500, messages: [{ role: 'user', content: prompt }] })
      });
      lastStatus = response.status;
      if (response.status !== 429) break;
    }
    if (!response.ok) throw new Error(`OpenRouter returned ${lastStatus}`);
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    return parseAiBrief(raw, question, sources, 'openrouter', { model, citations_validated: reachable.length, citations_unreachable: validated.length - reachable.length });
  } catch (error) { console.error(`OpenRouter synthesis failed: ${error.message}`); return null; }
}
async function synthesizeBrief(question, sources) {
  const ollamaUrl = process.env.FIELDNOTE_OLLAMA_URL || 'http://localhost:11434';
  /* Validate that each source URL is reachable */
  const validated = await validateCitations(sources.slice(0, 10));
  const reachable = validated.filter(v => v.reachable).slice(0, 10);
  const unreachable = validated.filter(v => !v.reachable);
  const top = reachable.map(s => `[${s.source_type}] ${s.title} (${s.reliability}, reachable: ${s.reachable})${s.url ? ' — '+s.url : ''}`).join('\n');
  const prompt = [
    `You are an evidence reviewer. Read these sources and produce a traceable, caveated evidence brief. Do not fabricate or infer anything beyond what the sources state.`,
    ``,
    `Question: ${question}`,
    ``,
    `Sources (${sources.length} total, ${reachable.length} reachable, ${unreachable.length} unreachable — show these as flagged):\n${top}`,
    ``,
    AI_BRIEF_FIELDS
  ].join('\n');
  try {
    const data = await fetchJson(`${ollamaUrl}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'llama3.1', prompt, stream: false }) });
    const parsed = extractJson(data.response || '');
    if (!parsed.opening || !Array.isArray(parsed.findings) || !Array.isArray(parsed.research_gaps)) throw new Error('Invalid brief structure');
    const papers = sources.filter(s => s.source_type === 'Paper'); const docs = sources.filter(s => s.source_type === 'Document');
    const byType = type => sources.filter(s => s.source_type === type).length;
    return { ...parsed, synthesis: 'llm', engine: 'ollama', takeaways: Array.isArray(parsed.takeaways) ? parsed.takeaways.slice(0, 5) : [], faq: (Array.isArray(parsed.faq) ? parsed.faq : []).filter(f => f && f.q && f.a).slice(0, 5), coverage: { total: sources.length, papers: byType('Paper'), web: byType('Web'), videos: byType('Video'), documents: byType('Document'), search_terms: tokens(question) }, evidence_map: parsed.evidence_map || sources.slice(0, 5).map(s => ({ title: s.title, source_type: s.source_type, reliability: s.reliability, relevance: s.relevance?.score || null, excerpt: s.excerpt, url: s.url, open_access_url: s.open_access_url || null })), research_gaps: parsed.research_gaps || ['This run has not assessed study quality, conflicts of interest, or whether sources disagree; those require source-level review.'], synthesized: true, citations_validated: reachable.length, citations_unreachable: unreachable.length };
  } catch { return null; }
}

/* ── Write Brief ────────────────────────────────────────────────── */
async function writeBrief(question, sources) {  const papers = sources.filter(item => item.source_type === 'Paper'); const docs = sources.filter(item => item.source_type === 'Document');
  const byType = type => sources.filter(item => item.source_type === type).length;
  const topEvidence = sources.slice(0, 5).map(item => ({ title: item.title, source_type: item.source_type, reliability: item.reliability, relevance: item.relevance?.score || null, excerpt: item.excerpt, url: item.url, open_access_url: item.open_access_url || null }));
  const extracted = extractiveFindings(question, sources, 3);
  const contextLine = docs.length ? `${docs.length} matching private documents were found. They remain local to this deployment and should be compared with independent sources.` : papers.length ? `${papers.length} scholarly records were retrieved. Begin with “${papers[0].title}”; assess study design, population, publication venue, and date before using it as evidence.` : 'No scholarly records were returned. Refine the terms or add a specialist literature source before drawing a research conclusion.';
  const fallback = {
    opening: `This evidence brief contains ${sources.length} reviewed sources for “${question}.” Sources are ranked for review; no conclusion is presented without a traceable source.`,
    findings: extracted.length ? [...extracted.slice(0, 2), contextLine] : [papers.length ? `${papers.length} scholarly records were retrieved. Begin with “${papers[0].title}”; assess study design, population, publication venue, and date before using it as evidence.` : 'No scholarly records were returned. Refine the terms or add a specialist literature source before drawing a research conclusion.', docs.length ? `${docs.length} matching private documents were found. They remain local to this deployment and should be compared with independent sources.` : 'No matching private documents were included in this run.', 'Use the linked evidence to distinguish discovery material from context, private material, and scholarly work.'],
    caveat: 'Retrieval is fallible and incomplete. Confirm authorship, date, methods, jurisdiction, and the original claim before publishing or making a decision.',
    synthesis: extracted.length ? 'extractive' : 'template',
    takeaways: extracted.length ? extracted.slice(0, 5) : [],
    faq: [],
    coverage: { total: sources.length, papers: byType('Paper'), web: byType('Web'), videos: byType('Video'), documents: byType('Document'), search_terms: tokens(question) },
    evidence_map: topEvidence,
    research_gaps: [papers.length < 3 ? 'The scholarly coverage is thin. Narrow the question, add field-specific terms, or review disciplinary databases.' : 'Scholarly records are available, but abstracts and methodology should be read before treating any result as conclusive.', docs.length ? 'Private documents were located; identify which claims need independent corroboration.' : 'No local context was included. Add internal notes, policies, or prior research when relevant.', 'This run has not assessed study quality, conflicts of interest, or whether sources disagree; those require source-level review.']
  };
  const aiOff = process.env.FIELDNOTE_AI === 'off';
  const llm = aiOff ? null : (await synthesizeWithOpenRouter(question, sources)) || await synthesizeBrief(question, sources) || await synthesizeWithPollinations(question, sources);
  return llm || fallback;
}

function briefToMarkdown(project) {
  const brief = project.brief || {}; const sources = project.sources || [];
  const line = items => (items || []).map((item, i) => typeof item === 'string' ? `${i + 1}. ${item}` : `${i + 1}. **${item.q}**\n   ${item.a}`).join('\n');
  const evidence = (brief.evidence_map || []).map(s => `- [${s.title}](${s.url || ''}) — ${s.publisher || s.source_type}${s.published_at ? `, ${s.published_at}` : ''} (${s.reliability}${s.relevance ? `, ${s.relevance}% match` : ''})${s.open_access_url ? ` · [open access](${s.open_access_url})` : ''}\n  > ${(s.excerpt || '').slice(0, 280)}`).join('\n');
  const all = sources.map(s => `- [${s.title}](${s.url || ''}) — ${s.publisher || s.source_type} (${s.source_type}, ${s.reliability})${s.open_access_url ? ` · [open access](${s.open_access_url})` : ''}`).join('\n');
  return [`# ${project.question}`, ``, `*Fieldnote evidence brief · ${project.created_at || ''} · ${sources.length} sources · synthesis: ${brief.synthesis || 'template'}${brief.engine ? ` (${brief.engine})` : ''}*`, ``, `## Summary`, ``, brief.opening || '', ``, `## Key findings`, ``, line(brief.findings), ``, ...(brief.takeaways?.length ? [`## Key takeaways`, ``, line(brief.takeaways), ``] : []), `## Evidence`, ``, evidence || '_No evidence map._', ``, ...(brief.faq?.length ? [`## Study questions`, ``, line(brief.faq), ``] : []), `## Research gaps`, ``, line(brief.research_gaps), ``, `## All sources`, ``, all || '_None._', ``, `## Caveat`, ``, brief.caveat || '', ``].join('\n');
}

module.exports = { plan, reviewEvidence, writeBrief, briefToMarkdown, validateCitations, documentReader, reconstructAbstract, extractiveFindings, expandQuery, extractJson };
