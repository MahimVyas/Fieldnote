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

/* ── Web Scout: Wikipedia + SearXNG ──────────────────────────────── */
async function webScout(question) {
  const results = [];
  try {
    const data = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${query(question)}&format=json&origin=*`);
    (data.query?.search || []).slice(0, 10).forEach(item => {
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
      const data = await fetchJson(`${base}/search.json?q=${query(question)}&format=json&categories=general&number=8`);
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
  return results.map(r => ({ ...r, relevance: relevance(question, r) }))
    .filter(r => r.relevance.score > 0).sort((a, b) => b.relevance.score - a.relevance.score).slice(0, 8);
}

/* ── Paper Trail: Crossref + Semantic Scholar + arXiv ───────────── */
async function paperTrail(question) {
  const results = [];
  /* Crossref */
  try {
    const data = await fetchJson(`https://api.crossref.org/works?query=${query(question)}&rows=10&select=title,URL,abstract,published-print,published-online,DOI,container-title,type,is-referenced-by-count`);
    (data.message?.items || []).filter(item => item.title?.[0]).forEach(item => {
      const date = item['published-print']?.['date-parts']?.[0] || item['published-online']?.['date-parts']?.[0];
      results.push(source({ title: clean(item.title[0]), url: item.URL || `https://doi.org/${item.DOI}`, source_type: 'Paper', excerpt: excerpt(item.abstract) || 'Scholarly record returned by Crossref.', published_at: date ? date.join('-') : null, publisher: clean(item['container-title']?.[0]) || 'Crossref', reliability: item.type === 'journal-article' ? 'scholarly' : 'record', citations: Number(item['is-referenced-by-count'] || 0) }));
    });
  } catch {}
  /* Semantic Scholar */
  try {
    const data = await fetchJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${query(question)}&limit=8&fields=title,abstract,url,year,venue,citationCount,publicationTypes`);
    (data.data || []).forEach(item => {
      results.push(source({ title: clean(item.title), url: item.url, source_type: 'Paper', excerpt: excerpt(item.abstract) || 'Scholarly record returned by Semantic Scholar.', published_at: item.year ? String(item.year) : null, publisher: clean(item.venue) || 'Semantic Scholar', reliability: item.publicationTypes?.includes('JournalArticle') ? 'scholarly' : 'record', citations: Number(item.citationCount || 0) }));
    });
  } catch {}
  /* arXiv */
  try {
    const data = await fetchJson(`https://export.arxiv.org/api/query?search_query=all:${query(question)}&start=0&max_results=10&sortBy=relevance&sortOrder=descending`);
    const entries = [...data.feed.entry || []];
    entries.forEach(entry => {
      const title = clean(entry.title?.[0] || '');
      const abs = clean(entry.summary?.[0] || '');
      const arxivId = (entry.id?.[0] || '').replace(/^http:\/\/arxiv\.org\/abs\//, '').replace(/^https:\/\/arxiv\.org\/abs\//, '');
      const link = entry.link?.find(l => l.$.rel === 'alternate')?.$.href || `https://arxiv.org/abs/${arxivId}`;
      const pubDate = entry.published?.[0]?.replace(/T.*$/, '') || null;
      if (!title) return;
      results.push(source({ title, url: link, source_type: 'Paper', excerpt: abs || 'Scholarly record returned by arXiv.', published_at: pubDate, publisher: 'arXiv', reliability: 'scholarly', citations: 0 }));
    });
  } catch {}
  return results.map(r => ({ ...r, relevance: relevance(question, r) }))
    .filter(r => r.relevance.score > 0).sort((a, b) => b.relevance.score - a.relevance.score || b.citations - a.citations).slice(0, 10);
}

/* ── Video Listener: real YouTube search ────────────────────────── */
async function videoListener(question) {
  try {
    const html = await (await fetch(`https://www.youtube.com/results?search_query=${query(question)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }, signal: AbortSignal.timeout(9000) })).text();
    const ids = [...new Set(html.match(/\/watch\?v=([A-Za-z0-9_-]{11})/g)?.map(m => m.replace('/watch?v=', '')) || [])];
    if (!ids.length) return [];
    return ids.slice(0, 5).map(id => source({
      title: `YouTube video ${id}`, url: `https://www.youtube.com/watch?v=${id}`,
      source_type: 'Video', excerpt: 'A YouTube search result. Review the video, creator, date, and available transcript before citing it.',
      published_at: null, publisher: 'YouTube', reliability: 'discovery'
    }));
  } catch { return []; }
}

/* ── Document Reader ────────────────────────────────────────────── */
async function documentReader(question, documentsPath) {
  let files;
  try { files = await fs.readdir(documentsPath, { withFileTypes: true }); } catch { return []; }
  const terms = tokens(question); const results = [];
  for (const entry of files.filter(item => item.isFile() && /\.(md|txt)$/i.test(item.name)).slice(0, 100)) {
    const filePath = path.join(documentsPath, entry.name); const body = await fs.readFile(filePath, 'utf8').catch(() => '');
    const normalized = clean(body); const score = terms.reduce((count, term) => count + (normalized.toLowerCase().match(new RegExp(`\\b${term}\\b`, 'g')) || []).length, 0);
    if (score) results.push(source({ title: entry.name, url: null, source_type: 'Document', excerpt: normalized.slice(0, 420), published_at: null, publisher: 'Private document', reliability: 'private', score }));
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 8);
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

/* ── LLM synthesis layer (Ollama) ──────────────────────────────── */
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
    `Return ONLY a valid JSON object with exactly these fields:`,
    `- "opening": one sentence summarizing what was found and how many sources of each type`,
    `- "findings": array of 3 short bullet strings, each a key insight traced to a specific source`,
    `- "caveat": one sentence about limitations`,
    `- "evidence_map": array of up to 5 objects: {title, source_type, reliability, relevance, excerpt, url}`,
    `- "research_gaps": array of 3 strings describing what remains unanswered`,
    ``,
    `Do not add any commentary outside the JSON object.`
  ].join('\n');
  try {
    const data = await fetchJson(`${ollamaUrl}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'llama3.1', prompt, stream: false }) });
    const raw = data.response || '';
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}') + 1;
    if (start < 0 || end <= start) throw new Error('No JSON in response');
    const parsed = JSON.parse(raw.slice(start, end));
    if (!parsed.opening || !Array.isArray(parsed.findings) || !Array.isArray(parsed.research_gaps)) throw new Error('Invalid brief structure');
    const papers = sources.filter(s => s.source_type === 'Paper'); const docs = sources.filter(s => s.source_type === 'Document');
    const byType = type => sources.filter(s => s.source_type === type).length;
    return { ...parsed, coverage: { total: sources.length, papers: byType('Paper'), web: byType('Web'), videos: byType('Video'), documents: byType('Document'), search_terms: tokens(question) }, evidence_map: parsed.evidence_map || sources.slice(0, 5).map(s => ({ title: s.title, source_type: s.source_type, reliability: s.reliability, relevance: s.relevance?.score || null, excerpt: s.excerpt, url: s.url })), research_gaps: parsed.research_gaps || ['This run has not assessed study quality, conflicts of interest, or whether sources disagree; those require source-level review.'], synthesized: true, citations_validated: reachable.length, citations_unreachable: unreachable.length };
  } catch { return null; }
}

/* ── Write Brief ────────────────────────────────────────────────── */
async function writeBrief(question, sources) {
  const papers = sources.filter(item => item.source_type === 'Paper'); const docs = sources.filter(item => item.source_type === 'Document');
  const byType = type => sources.filter(item => item.source_type === type).length;
  const topEvidence = sources.slice(0, 5).map(item => ({ title: item.title, source_type: item.source_type, reliability: item.reliability, relevance: item.relevance?.score || null, excerpt: item.excerpt, url: item.url }));
  const fallback = {
    opening: `This evidence brief contains ${sources.length} reviewed sources for "${question}". Sources are ranked for review; no conclusion is presented without a traceable source.`,
    findings: [papers.length ? `${papers.length} scholarly records were retrieved. Begin with "${papers[0].title}"; assess study design, population, publication venue, and date before using it as evidence.` : 'No scholarly records were returned. Refine the terms or add a specialist literature source before drawing a research conclusion.', docs.length ? `${docs.length} matching private documents were found. They remain local to this deployment and should be compared with independent sources.` : 'No matching private documents were included in this run.', 'Use the linked evidence to distinguish discovery material from context, private material, and scholarly work.'],
    caveat: 'Retrieval is fallible and incomplete. Confirm authorship, date, methods, jurisdiction, and the original claim before publishing or making a decision.',
    coverage: { total: sources.length, papers: byType('Paper'), web: byType('Web'), videos: byType('Video'), documents: byType('Document'), search_terms: tokens(question) },
    evidence_map: topEvidence,
    research_gaps: [papers.length < 3 ? 'The scholarly coverage is thin. Narrow the question, add field-specific terms, or review disciplinary databases.' : 'Scholarly records are available, but abstracts and methodology should be read before treating any result as conclusive.', docs.length ? 'Private documents were located; identify which claims need independent corroboration.' : 'No local context was included. Add internal notes, policies, or prior research when relevant.', 'This run has not assessed study quality, conflicts of interest, or whether sources disagree; those require source-level review.']
  };
  const llm = await synthesizeBrief(question, sources);
  return llm || fallback;
}

module.exports = { plan, reviewEvidence, writeBrief, validateCitations, documentReader };
