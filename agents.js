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

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Fieldnote/1.0 (+local research workbench)' }, signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`Upstream service returned ${response.status}`);
  return response.json();
}
function source(input) {
  return { id: `${input.source_type}:${input.url || input.title}`.toLowerCase(), reliability: input.reliability || 'context', ...input };
}

async function webScout(question) {
  const data = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${query(question)}&format=json&origin=*`);
  return (data.query?.search || []).slice(0, 10).map(item => {
    const candidate = source({
    title: clean(item.title), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
    source_type: 'Web', excerpt: excerpt(item.snippet), published_at: null, publisher: 'Wikipedia', reliability: 'context'
    }); return { ...candidate, relevance: relevance(question, candidate) };
  }).filter(item => item.relevance.score > 0).sort((a, b) => b.relevance.score - a.relevance.score).slice(0, 6);
}
async function paperTrail(question) {
  const data = await fetchJson(`https://api.crossref.org/works?query=${query(question)}&rows=10&select=title,URL,abstract,published-print,published-online,DOI,container-title,type,is-referenced-by-count`);
  const crossref = (data.message?.items || []).filter(item => item.title?.[0]).map(item => {
    const date = item['published-print']?.['date-parts']?.[0] || item['published-online']?.['date-parts']?.[0];
    const candidate = source({ title: clean(item.title[0]), url: item.URL || `https://doi.org/${item.DOI}`, source_type: 'Paper', excerpt: excerpt(item.abstract) || 'Scholarly record returned by Crossref.', published_at: date ? date.join('-') : null, publisher: clean(item['container-title']?.[0]) || 'Crossref', reliability: item.type === 'journal-article' ? 'scholarly' : 'record', citations: Number(item['is-referenced-by-count'] || 0) });
    return { ...candidate, relevance: relevance(question, candidate) };
  });
  const semantic = await fetchJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${query(question)}&limit=8&fields=title,abstract,url,year,venue,citationCount,publicationTypes`).then(data => (data.data || []).map(item => {
    const candidate = source({ title: clean(item.title), url: item.url, source_type: 'Paper', excerpt: excerpt(item.abstract) || 'Scholarly record returned by Semantic Scholar.', published_at: item.year ? String(item.year) : null, publisher: clean(item.venue) || 'Semantic Scholar', reliability: item.publicationTypes?.includes('JournalArticle') ? 'scholarly' : 'record', citations: Number(item.citationCount || 0) });
    return { ...candidate, relevance: relevance(question, candidate) };
  })).catch(() => []);
  return [...crossref, ...semantic].filter(item => item.relevance.score > 0).sort((a, b) => b.relevance.score - a.relevance.score || b.citations - a.citations).slice(0, 10);
}
async function videoListener(question) {
  return [source({ title: `YouTube research: ${clean(question)}`, url: `https://www.youtube.com/results?search_query=${query(question)}`, source_type: 'Video', excerpt: 'A current YouTube search query. Review the video, creator, date, and available transcript before citing it.', published_at: null, publisher: 'YouTube', reliability: 'discovery' })];
}
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

function plan(question, enabled) {
  const registry = { Web: ['web-scout', webScout], Papers: ['paper-trail', paperTrail], YouTube: ['video-listener', videoListener], Documents: ['document-reader', documentReader] };
  return enabled.filter(name => registry[name]).map(name => ({ name: registry[name][0], source: name, execute: registry[name][1], question }));
}
function reviewEvidence(rawSources) {
  const seen = new Set();
  return rawSources.filter(item => {
    const key = (item.url || item.title).toLowerCase().replace(/\W/g, ''); if (!key || seen.has(key)) return false; seen.add(key); return true;
  }).sort((a, b) => {
    const rank = { scholarly: 4, private: 3, context: 2, record: 2, discovery: 1 }; return (b.relevance?.score || 0) - (a.relevance?.score || 0) || (rank[b.reliability] || 0) - (rank[a.reliability] || 0) || (b.citations || 0) - (a.citations || 0);
  });
}
function writeBrief(question, sources) {
  const papers = sources.filter(item => item.source_type === 'Paper'); const docs = sources.filter(item => item.source_type === 'Document');
  const byType = type => sources.filter(item => item.source_type === type).length;
  const topEvidence = sources.slice(0, 5).map(item => ({ title: item.title, source_type: item.source_type, reliability: item.reliability, relevance: item.relevance?.score || null, excerpt: item.excerpt, url: item.url }));
  return {
    opening: `This evidence brief contains ${sources.length} reviewed sources for “${question}.” Sources are ranked for review; no conclusion is presented without a traceable source.`,
    findings: [papers.length ? `${papers.length} scholarly records were retrieved. Begin with “${papers[0].title}”; assess study design, population, publication venue, and date before using it as evidence.` : 'No scholarly records were returned. Refine the terms or add a specialist literature source before drawing a research conclusion.', docs.length ? `${docs.length} matching private documents were found. They remain local to this deployment and should be compared with independent sources.` : 'No matching private documents were included in this run.', 'Use the linked evidence to distinguish discovery material from context, private material, and scholarly work.'],
    caveat: 'Retrieval is fallible and incomplete. Confirm authorship, date, methods, jurisdiction, and the original claim before publishing or making a decision.',
    coverage: { total: sources.length, papers: byType('Paper'), web: byType('Web'), videos: byType('Video'), documents: byType('Document'), search_terms: tokens(question) },
    evidence_map: topEvidence,
    research_gaps: [papers.length < 3 ? 'The scholarly coverage is thin. Narrow the question, add field-specific terms, or review disciplinary databases.' : 'Scholarly records are available, but abstracts and methodology should be read before treating any result as conclusive.', docs.length ? 'Private documents were located; identify which claims need independent corroboration.' : 'No local context was included. Add internal notes, policies, or prior research when relevant.', 'This run has not assessed study quality, conflicts of interest, or whether sources disagree; those require source-level review.']
  };
}

module.exports = { plan, reviewEvidence, writeBrief, documentReader };
