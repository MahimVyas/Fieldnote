const $ = (s) => document.querySelector(s);
/* Static hosts (GitHub Pages, file://) have no API backend. Detect it
   synchronously so not a single failing request ever hits the console. */
const DEMO = /(^|\.)github\.io$/.test(location.hostname) || location.protocol === 'file:';
const DEMO_MESSAGE = 'Static preview only — run npm start locally for full research.';

/* ── Browser library cache: briefs survive server restarts and data loss ── */
const LIBRARY_CACHE_KEY = 'fieldnote.library.v1';
const LIBRARY_CACHE_MAX = 20;
function readCache() { try { return JSON.parse(localStorage.getItem(LIBRARY_CACHE_KEY)) || []; } catch { return []; } }
function writeCache(projects) {
  const items = projects.slice(0, LIBRARY_CACHE_MAX);
  try { localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(items)); }
  catch { try { localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(items.slice(0, 10))); } catch {} }
}
function cacheProject(project) {
  if (!project || !project.id) return;
  const items = readCache().filter(p => p.id !== project.id);
  items.unshift(project); writeCache(items);
}
function uncacheProject(id) { writeCache(readCache().filter(p => p.id !== id)); }
function mergedLibrary(serverProjects) {
  const seen = new Set(serverProjects.map(p => p.id));
  return [...serverProjects, ...readCache().filter(p => !seen.has(p.id)).map(p => ({ ...p, _localOnly: true }))];
}
function projectToMarkdown(p) {
  const b = p.brief || {}; const sources = p.sources || [];
  const lines = [`# ${p.question}`, '', `*Fieldnote evidence brief · ${p.created_at || ''} · ${sources.length} sources · synthesis: ${b.synthesis || 'template'}${b.grade ? ` · grade: ${b.grade.label} (${b.grade.score}/100)` : ''}*`, '', '## Summary', '', b.opening || '', '', '## Key findings', ''];
  (b.findings || []).forEach((f, i) => lines.push(`${i + 1}. ${f}`));
  if (b.takeaways && b.takeaways.length) { lines.push('', '## Key takeaways', ''); b.takeaways.forEach((t, i) => lines.push(`${i + 1}. ${t}`)); }
  lines.push('', '## Evidence', '');
  (b.evidence_map || []).forEach(s => lines.push(`- [${s.title}](${s.url || ''}) — ${s.source_type} (${s.reliability})${s.open_access_url ? ` · [open access](${s.open_access_url})` : ''}`));
  if (b.faq && b.faq.length) { lines.push('', '## Study questions', ''); b.faq.forEach((f, i) => lines.push(`${i + 1}. **${f.q}**`, `   ${f.a}`)); }
  lines.push('', '## Research gaps', '');
  (b.research_gaps || []).forEach((g, i) => lines.push(`${i + 1}. ${g}`));
  lines.push('', '## All sources', '');
  sources.forEach(s => lines.push(`- [${s.title}](${s.url || ''}) — ${s.publisher || s.source_type} (${s.source_type}, ${s.reliability})`));
  lines.push('', '## Caveat', '', b.caveat || '');
  return lines.join('\n');
}
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type }); const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}
let toastTimer = 0;
const toast = (message) => { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200); };
const promptEl = $('#prompt');
function autogrow() { promptEl.style.height = 'auto'; promptEl.style.height = Math.min(promptEl.scrollHeight, 160) + 'px'; }
promptEl.addEventListener('input', autogrow); autogrow();
const SAMPLE_QUESTIONS = [
  'How is AI changing the future of independent education?',
  'What does research say about spaced repetition and long-term retention?',
  'Are community-owned social networks viable alternatives to ad-funded platforms?',
  'What is the evidence from universal basic income pilots?',
  'How do cities reduce traffic fatalities without banning cars?',
  'Does intermittent fasting improve metabolic health?',
  'What are the strongest arguments for and against degrowth economics?',
  'How does sleep affect memory consolidation in adults?',
  'What makes remote teams perform as well as co-located ones?',
  'Is nuclear power essential for deep decarbonization?',
  'How do recommendation algorithms shape political polarization?',
  'Which interventions actually reduce plastic waste?'
];
promptEl.value = SAMPLE_QUESTIONS[Math.floor(Math.random() * SAMPLE_QUESTIONS.length)];
autogrow();
window.addEventListener('load', autogrow);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(autogrow);

function paintTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  const toggle = $('#themeToggle');
  toggle.setAttribute('aria-pressed', String(dark));
  toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  toggle.querySelector('.theme-icon').innerHTML = icon(dark ? 'sun' : 'moon');
  const meta = $('#themeColor');
  if (meta) meta.content = dark ? '#131210' : '#f5f1e8';
}
$('#themeToggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('fieldnote-theme', next); } catch {}
  paintTheme(next);
});
paintTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
let depth = 'Thorough';
let visibleProgress = 8;
let runStartedAtClient = 0;
let elapsedTimer = 0;

function fmtTime(s) { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function expectedDuration() {
  try {
    const history = JSON.parse(localStorage.getItem('fieldnote.durations') || '[]');
    if (history.length) return history.reduce((a, b) => a + b, 0) / history.length / 1000;
  } catch {}
  return depth === 'Quick' ? 20 : 45;
}
function recordDuration() {
  try {
    const history = JSON.parse(localStorage.getItem('fieldnote.durations') || '[]');
    history.unshift(Date.now() - runStartedAtClient);
    localStorage.setItem('fieldnote.durations', JSON.stringify(history.slice(0, 10)));
  } catch {}
}
function updateElapsed() {
  const el = $('#loadingElapsed'); if (!el || !runActive) return;
  const elapsed = (Date.now() - runStartedAtClient) / 1000;
  const remaining = expectedDuration() - elapsed;
  el.textContent = remaining > 1 ? `${fmtTime(elapsed)} elapsed · ≈${fmtTime(remaining)} left` : `${fmtTime(elapsed)} elapsed · finishing up`;
}

function setResultProgress(percent, label, step) {
  visibleProgress = Math.max(visibleProgress, Math.min(100, Math.round(percent)));
  $('#loadingFill').style.width = `${visibleProgress}%`;
  $('#loadingPercent').textContent = `${visibleProgress}%`;
  $('#loadingLabel').textContent = label;
  document.querySelectorAll('.loading-steps span').forEach(item => item.classList.toggle('active', item.dataset.step === step));
}
function showResultLoading() {
  visibleProgress = 8;
  const box = $('#resultsLoading'); box.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('open')));
  setResultProgress(8, 'Planner is mapping the research question', 'plan');
  setTimeout(() => $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}
function syncResultProgress(run) {
  const complete = run.agents.filter(agent => agent.status === 'completed' || agent.status === 'failed').length;
  const running = run.agents.filter(agent => agent.status === 'running').length;
  const found = run.agents.reduce((n, agent) => n + (agent.sources_found || 0), 0);
  const agentsEl = $('#loadingAgents'); if (agentsEl) agentsEl.textContent = `${running} of ${run.agents.length} agents working`;
  const sourcesEl = $('#loadingSources'); if (sourcesEl) sourcesEl.textContent = `${found} sources found so far`;
  const gatherProgress = 18 + ((complete + (running * .48)) / Math.max(run.agents.length, 1)) * 58;
  if (complete < run.agents.length) return setResultProgress(gatherProgress, `${complete} of ${run.agents.length} specialist agents have reported back`, 'gather');
  setResultProgress(82, 'Evidence reviewer is ranking and deduplicating sources', 'review');
}
function finishResultLoading(success) {
  setResultProgress(100, success ? 'Your evidence brief is ready' : 'Research run needs attention', 'brief');
  const box = $('#resultsLoading');
  setTimeout(() => box.classList.remove('open'), 650);
  setTimeout(() => { box.hidden = true; }, 1250);
}

document.querySelectorAll('.nav-link').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach(b => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
  button.classList.add('active'); button.setAttribute('aria-current', 'page');
  ['research', 'stack', 'library'].forEach(view => $('#'+view+'View').hidden = button.dataset.view !== view);
  if (button.dataset.view === 'library') loadLibrary();
  setNav(false);
  window.scrollTo({ top: 0 });
  const heading = { research: '#researchView .hero h1', stack: '#stackView .stack-hero h1', library: '#libraryView .library h1' }[button.dataset.view];
  const target = heading && $(heading); if (target) target.focus({ preventScroll: true });
}));
function setNav(open) {
  document.body.classList.toggle('nav-open', open);
  const toggle = $('#menuToggle'); if (!toggle) return;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}
$('#menuToggle').addEventListener('click', event => { event.stopPropagation(); setNav(!document.body.classList.contains('nav-open')); });
document.addEventListener('click', event => {
  if (document.body.classList.contains('nav-open') && !event.target.closest('header')) setNav(false);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') setNav(false); });
document.querySelectorAll('.source-toggle').forEach(label => label.addEventListener('click', () => setTimeout(() => { label.classList.toggle('checked', label.querySelector('input').checked); updateDockMeta(); })));

function setRunning(running) {
  const button = $('#runResearch'); button.disabled = false;
  button.innerHTML = running ? `Stop <span>${icon('stop')}</span>` : `Research <span>${icon('send')}</span>`;
  button.classList.toggle('is-stop', running);
  document.querySelectorAll('.agent-card.active-agent').forEach(card => card.classList.toggle('is-working', running));
}
let runActive = false;
let cancelRequested = false;
let activeRunId = null;
let runStartedAt = 0;
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }
function icon(name) { return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`; }
async function apiFetch(url, opts) {
  let response;
  try { response = await fetch(url, opts); }
  catch { throw new Error('Cannot reach the local server. Start it with npm start and reload the page.'); }
  return response;
}
async function readJsonSafe(response) {
  try { return await response.json(); }
  catch { throw new Error('The server answered unreadably — is the Fieldnote backend running here?'); }
}
function oaBadge(source) {
  return source.open_access_url ? `<a class="oa-badge" href="${escapeHtml(source.open_access_url)}" target="_blank" rel="noopener noreferrer">${icon('file')} Open access</a>` : '';
}
function oaChip(source) {
  return source.open_access_url ? `<span class="oa-badge" data-href="${escapeHtml(source.open_access_url)}" role="link" tabindex="0">${icon('file')} Open access</span>` : '';
}
document.addEventListener('click', event => {
  const chip = event.target.closest ? event.target.closest('.oa-badge[data-href]') : null;
  if (!chip) return; event.preventDefault(); event.stopPropagation();
  window.open(chip.dataset.href, '_blank', 'noopener');
});
document.addEventListener('keydown', event => {
  const chip = event.target && event.target.classList && event.target.classList.contains('oa-badge') ? event.target : null;
  if (!chip || !chip.dataset.href || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault(); window.open(chip.dataset.href, '_blank', 'noopener');
});
function sourceHtml(source) {
  const type = source.source_type.toLowerCase(); const date = source.published_at ? ` · ${source.published_at}` : '';
  const score = source.relevance?.score ? ` · ${source.relevance.score}% match` : ''; const body = `<span class="source-type ${type}-type">${source.source_type.toUpperCase()}</span><div><b>${escapeHtml(source.title)}</b><small>${escapeHtml(source.publisher || source.source_type)}${date}${score} · ${escapeHtml(source.reliability || 'unrated')}</small><p class="source-excerpt">${escapeHtml(source.excerpt || 'No excerpt available.')}</p>${oaChip(source)}</div><em>${source.url ? icon('send') : 'local'}</em>`;
  return source.url ? `<a href="${source.url}" target="_blank" rel="noopener noreferrer" class="source">${body}</a>` : `<div class="source source-local">${body}</div>`;
}
function updateAgents(agents) {
  const ui = {
    'web-scout': { count: '#webCount', card: '.agent-card:nth-child(1)', verb: 'SEARCHING' },
    'video-listener': { count: '#videoCount', card: '.agent-card:nth-child(2)', verb: 'WATCHING' },
    'paper-trail': { count: '#paperCount', card: '.agent-card:nth-child(3)', verb: 'READING' },
    'document-reader': { count: '#docCount', card: '.agent-card:nth-child(4)', verb: 'SCANNING' }
  };
  const seen = new Set();
  agents.forEach(agent => {
    const entry = ui[agent.name]; if (!entry) return; seen.add(agent.name);
    const card = document.querySelector(entry.card); if (!card) return;
    const track = card.querySelector('.progress'); const bar = card.querySelector('.progress i');
    const state = card.querySelector('.agent-state'); const count = $(entry.count);
    card.classList.toggle('is-working', agent.status === 'running');
    if (track) { track.classList.toggle('running', agent.status === 'running'); track.classList.toggle('failed', agent.status === 'failed'); }
    if (bar && agent.status !== 'running') bar.style.width = (agent.status === 'completed' || agent.status === 'failed') ? '100%' : '0%';
    if (state) {
      state.textContent = agent.status === 'running' ? entry.verb : agent.status === 'completed' ? 'DONE' : agent.status === 'failed' ? 'FAILED' : agent.status === 'queued' ? 'QUEUED' : state.textContent;
      state.classList.toggle('muted', agent.status !== 'running');
    }
    let label;
    if (agent.status === 'completed') label = agent.name === 'document-reader' ? `${agent.sources_found} documents matched` : agent.name === 'video-listener' ? `${agent.sources_found} videos found` : agent.name === 'paper-trail' ? `${agent.sources_found} papers indexed` : `${agent.sources_found} sources found`;
    else if (agent.status === 'failed') label = `Failed: ${String(agent.error || 'Could not reach source').slice(0, 64)}`;
    else if (agent.status === 'running') label = 'Working…';
    else label = agent.name === 'document-reader' ? 'Private context on hold' : 'Standing by…';
    if (count) { count.textContent = label; count.title = agent.error || ''; }
  });
  Object.entries(ui).forEach(([name, entry]) => {
    if (seen.has(name)) return;
    const card = document.querySelector(entry.card); if (!card) return;
    const track = card.querySelector('.progress'); const bar = card.querySelector('.progress i');
    const state = card.querySelector('.agent-state'); const count = $(entry.count);
    card.classList.remove('is-working');
    if (track) track.classList.remove('running', 'failed');
    if (bar) bar.style.width = '0%';
    if (state) { state.textContent = name === 'document-reader' ? 'ON HOLD' : 'READY'; state.classList.add('muted'); }
    if (count) { count.textContent = name === 'document-reader' ? 'Private context on hold' : 'Standing by…'; count.title = ''; }
  });
}
function citeYear(s) { const m = String(s.published_at || '').match(/\d{4}/); return m ? m[0] : 'n.d.'; }
function citeAPA(s) {
  return `${s.publisher || s.source_type}. (${citeYear(s)}). ${s.title}. Retrieved from ${s.url || 'private document'}`;
}
function citeBibTeX(s) {
  const key = `fieldnote${citeYear(s)}${String(s.title || 'untitled').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 3).join('')}`;
  return `@misc{${key},\n  title = {${s.title || 'Untitled'}},\n  author = {${s.publisher || s.source_type}},\n  year = {${citeYear(s)}},\n  url = {${s.url || ''}}\n}`;
}
async function copyCitation(item, format) {
  if (!item) return;
  try { await navigator.clipboard.writeText(format === 'bib' ? citeBibTeX(item) : citeAPA(item)); toast(`${format === 'bib' ? 'BibTeX' : 'APA'} citation copied.`); }
  catch { toast('Could not copy the citation.'); }
}
function evidenceArticle(item, index) {
  return `<article><span>${String(index + 1).padStart(2, '0')}</span><div><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.source_type)} · ${escapeHtml(item.reliability)}${item.relevance ? ` · ${item.relevance}% match` : ''}</small><p>${escapeHtml(item.excerpt || 'No excerpt available.')}</p>${oaBadge(item)}<span class="cite-row"><button class="cite-btn" data-cite="apa" data-ev="${index}" title="Copy APA citation">${icon('file')} APA</button><button class="cite-btn" data-cite="bib" data-ev="${index}" title="Copy BibTeX entry">${icon('code')} BibTeX</button></span></div></article>`;
}
function renderEvidenceList(items) {
  lastEvidenceRendered = items;
  const box = $('#evidenceArticles'); if (!box) return;
  box.innerHTML = items.length ? items.map(evidenceArticle).join('') : '<p class="evidence-empty">No evidence of this type in this run.</p>';
  const count = $('#evidenceCount');
  if (count) count.textContent = `Showing ${items.length} of ${currentEvidence.length}`;
}
function yearOf(item) { const m = String(item.published_at || '').match(/\d{4}/); return m ? Number(m[0]) : 0; }
function applyEvidenceView() {
  const filter = $('#evidenceFilter'); const sort = $('#evidenceSort');
  const type = filter ? filter.value : 'all'; const mode = sort ? sort.value : 'relevance';
  let items = type === 'all' ? [...currentEvidence] : currentEvidence.filter(i => i.source_type === type);
  if (mode === 'cited') items.sort((a, b) => (b.citations || 0) - (a.citations || 0));
  else if (mode === 'newest') items.sort((a, b) => yearOf(b) - yearOf(a));
  renderEvidenceList(items);
}
let currentProject = null;
let currentEvidence = [];
let lastEvidenceRendered = [];
function renderProject(project) {
  currentProject = project;
  currentEvidence = project.brief.evidence_map || [];
  const sources = project.sources || []; const byType = type => sources.filter(s => s.source_type === type).length;
  $('#statusText').textContent = `${sources.length} sources collected`;
  $('#webCount').textContent = `${byType('Web')} sources found`; $('#videoCount').textContent = `${byType('Video')} video query ready`; $('#paperCount').textContent = `${byType('Paper')} papers indexed`; const docCount = $('#docCount'); if (docCount) docCount.textContent = `${byType('Document')} documents matched`;
  $('.results h2').textContent = project.question;
  const gradeDescriptions = ['Thin evidence — treat any conclusion as preliminary.', 'A useful starting point with clear gaps to close.', 'Broad, well-matched evidence worth trusting with checks.', 'Deep, diverse, well-matched evidence across source types.'];
  document.querySelector('.results-head .eyebrow').innerHTML = `<i></i> EVIDENCE BRIEF${project.brief.grade ? ` <span class="grade-wrap"><button class="grade g${project.brief.grade.tier}" id="gradePill" aria-expanded="false" aria-label="Why this grade?">${escapeHtml(project.brief.grade.label)} · ${project.brief.grade.score}</button><span class="grade-burst" aria-hidden="true">${'<svg class="icon" aria-hidden="true"><use href="#i-spark"/></svg>'.repeat(6)}</span><span class="grade-pop" hidden><span class="grade-desc">${escapeHtml(gradeDescriptions[project.brief.grade.tier] || '')}</span>${project.brief.grade.factors.map(f => `<span class="grade-bar"><span>${escapeHtml(f.name)}</span><span class="grade-track"><i style="width:${Math.round((f.points / f.max) * 100)}%"></i></span><b>${f.points}/${f.max}</b></span>`).join('')}</span></span>` : ''}`;
  const gradePill = project.brief.grade ? $('#gradePill') : null;
  if (gradePill && gradePill.parentElement) {
    gradePill.addEventListener('click', () => {
      const pop = gradePill.parentElement.querySelector('.grade-pop'); if (!pop) return;
      const open = pop.hidden;
      document.querySelectorAll('.grade-pop').forEach(el => { el.hidden = true; });
      pop.hidden = !open;
      gradePill.setAttribute('aria-expanded', String(open));
    });
    const wrap = gradePill.parentElement;
    wrap.classList.add('burst');
    setTimeout(() => wrap.classList.remove('burst'), 1300);
  }
  document.querySelector('.summary-card').innerHTML = `<p class="summary-lead">${escapeHtml(project.brief.opening)}</p>${project.brief.findings.map((finding, index) => `<div class="takeaway"><span>0${index + 1}</span><p>${escapeHtml(finding)}</p></div>`).join('')}<p class="brief-caveat">${escapeHtml(project.brief.caveat)}</p>`;
  const synthNote = project.brief.synthesis === 'llm' ? `AI-synthesized${project.brief.engine === 'ollama' ? ' locally' : project.brief.engine === 'openrouter' ? ' with OpenRouter' : ' with a free model'} · citations checked` : project.brief.synthesis === 'extractive' ? 'Auto-summarized from retrieved excerpts' : 'Template summary · AI synthesis unavailable';
  document.querySelector('.summary-card').insertAdjacentHTML('afterbegin', `<p class="synth-note">${escapeHtml(synthNote)}</p>`);
  document.querySelector('.sources-panel').innerHTML = `<div class="panel-title"><span>Evidence collected</span><b>${sources.length} sources</b></div>${sources.slice(0, 6).map(sourceHtml).join('')}<button class="all-sources" id="allSources">View all ${sources.length} sources <span>${icon('arrow-right')}</span></button>`;
  $('#allSources').addEventListener('click', () => { document.querySelector('.sources-panel').innerHTML = `<div class="panel-title"><span>All evidence</span><b>${sources.length} sources</b></div>${sources.map(sourceHtml).join('')}`; });
  document.querySelector('.report-details')?.remove();
  const coverage = project.brief.coverage || {}; const evidence = project.brief.evidence_map || []; const gaps = project.brief.research_gaps || [];
  document.querySelector('.finding-layout').insertAdjacentHTML('afterend', `<section class="report-details"><div class="report-heading"><div><div class="eyebrow"><i></i> RESEARCH NOTES</div><h3>Evidence map & coverage</h3></div><p>Review source excerpts before adopting a claim. Match scores reflect term overlap, not factual correctness.</p><button class="mini-button" id="detailsToggle" aria-expanded="true">Hide details</button></div><div class="rep-sec"><h4>Coverage</h4></div><div class="coverage-grid"><div><b>${coverage.papers || 0}</b><span>scholarly records</span></div><div><b>${coverage.web || 0}</b><span>web references</span></div><div><b>${coverage.documents || 0}</b><span>private documents</span></div><div><b>${coverage.videos || 0}</b><span>video leads</span></div></div>${(project.brief.takeaways?.length || project.brief.faq?.length) ? `<div class="rep-sec"><h4>Key takeaways</h4></div><div class="takeaway-rows">${(project.brief.takeaways || []).map((t, i) => `<div class="takeaway"><span>${String(i + 1).padStart(2, '0')}</span><p>${escapeHtml(t)}</p></div>`).join('')}</div><div class="rep-sec"><h4>Self-test questions</h4></div><div class="faq-list">${(project.brief.faq || []).map(f => `<details><summary>${escapeHtml(f.q)}</summary><p>${escapeHtml(f.a)}</p></details>`).join('') || '<p>Enable AI synthesis for generated study questions.</p>'}</div>` : ''}<div class="rep-sec"><h4>Most relevant evidence</h4><div class="evidence-tools"><span id="evidenceCount"></span><select id="evidenceFilter" aria-label="Filter evidence by source type"><option value="all">All evidence</option><option value="Paper">Papers</option><option value="Web">Web</option><option value="Video">Videos</option><option value="Document">Documents</option></select><select id="evidenceSort" aria-label="Sort evidence"><option value="relevance">Top relevance</option><option value="newest">Newest first</option><option value="cited">Most cited</option></select></div></div><div class="evidence-articles" id="evidenceArticles"></div><div class="rep-sec"><h4>Open questions</h4></div><div class="gap-list"><h4>What this run cannot answer yet</h4>${gaps.map((gap, index) => `<p>${escapeHtml(gap)}<button class="gap-dig" data-gap="${index}">Dig deeper <span>${icon('arrow-right')}</span></button></p>`).join('')}<h4>Search scope</h4><p>${(coverage.search_terms || []).map(escapeHtml).join(' · ') || 'No extracted terms'}</p></div></section>`);
  document.querySelectorAll('.gap-dig').forEach(button => button.addEventListener('click', () => digDeeper(Number(button.dataset.gap))));
  document.querySelectorAll('.cite-btn').forEach(button => button.addEventListener('click', () => copyCitation(lastEvidenceRendered[Number(button.dataset.ev)], button.dataset.cite)));
  const detailsToggle = $('#detailsToggle');
  if (detailsToggle) detailsToggle.addEventListener('click', () => {
    const section = document.querySelector('.report-details'); if (!section) return;
    const collapsed = section.classList.toggle('collapsed');
    detailsToggle.textContent = collapsed ? 'Show details' : 'Hide details';
    detailsToggle.setAttribute('aria-expanded', String(!collapsed));
  });
  renderEvidenceList(currentEvidence);
  const filter = $('#evidenceFilter');
  if (filter) filter.addEventListener('change', applyEvidenceView);
  const sort = $('#evidenceSort');
  if (sort) sort.addEventListener('change', applyEvidenceView);
  if (project.errors?.length) toast(`Partial result: ${project.errors[0]}`);
  document.body.classList.remove('working'); document.body.classList.add('has-results');
  try { history.replaceState(null, '', `#/p/${project.id}`); } catch {}
  renderChips(project);
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  queueLift();
}

function updateDockMeta() {
  const el = $('#dockMeta'); if (!el) return;
  const sources = [...document.querySelectorAll('.source-toggle input:checked')].map(input => input.dataset.source);
  el.innerHTML = `${escapeHtml(sources.join(' · ') || 'No sources')} · ${escapeHtml(depth)} <span>edit ⌄</span>`;
}
function lockPrompt(locked) {
  ['#prompt', '#depthButton', '#micButton', '#dockMeta'].forEach(s => { const el = $(s); if (el) el.disabled = locked; });
  document.querySelectorAll('.source-toggle input').forEach(input => { input.disabled = locked; });
}
async function startRun(question, sources) {
  if (DEMO) return toast(DEMO_MESSAGE);
  if (!question) return toast('Add a question to begin your research.'); if (!sources.length) return toast('Select at least one online source.');
  if (!navigator.onLine) return toast('You appear to be offline. Web and paper sources need a connection.');
  updateDockMeta();
  try { localStorage.setItem('fieldnote.seen', '1'); } catch {}
  const hint = $('#firstHint'); if (hint) hint.hidden = true;
  const chips = $('#followChips'); if (chips) chips.hidden = true;
  document.body.classList.add('working'); document.body.classList.remove('has-results', 'dock-expanded');
  queueLift(); requestAnimationFrame(queueLift); setTimeout(queueLift, 650);
  runActive = true; cancelRequested = false; activeRunId = null;
  runStartedAt = Date.now(); runStartedAtClient = Date.now();
  clearInterval(elapsedTimer); updateElapsed();
  elapsedTimer = setInterval(updateElapsed, 1000);
  lockPrompt(true);
  setRunning(true); $('#statusText').textContent = 'Agents are retrieving evidence'; $('#workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    showResultLoading();
    const response = await apiFetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, sources, depth }) });
    let run = await readJsonSafe(response); if (!response.ok) throw new Error(run.error || 'Research could not be started.');
    activeRunId = run.id;
    while (run.status === 'queued' || run.status === 'running') {
      if (cancelRequested) break;
      updateAgents(run.agents); syncResultProgress(run); await new Promise(resolve => setTimeout(resolve, 1000)); const progress = await apiFetch(`/api/runs/${run.id}`); run = await readJsonSafe(progress);
    }
    if (cancelRequested) {
      try { await fetch(`/api/runs/${run.id}`, { method: 'DELETE' }); } catch {}
      finishResultLoading(false); $('#statusText').textContent = 'Run cancelled'; document.body.classList.remove('working'); toast('Run cancelled.');
      return;
    }
    updateAgents(run.agents); if (run.status !== 'completed') throw new Error(run.error || 'Research could not be completed.'); finishResultLoading(true); renderProject(run.result); cacheProject(run.result); recordDuration(); refreshLibraryCount(); loadConversations(); toast('Evidence brief saved to your library.');
  } catch (error) { finishResultLoading(false); $('#statusText').textContent = 'Research needs attention'; document.body.classList.remove('working'); toast(error.message); }
  finally { runActive = false; activeRunId = null; clearInterval(elapsedTimer); lockPrompt(false); setRunning(false); }
}

function projectSources(project) {
  const sources = [...new Set((project.agents || []).map(a => a.source).filter(s => ['Web', 'Papers', 'YouTube', 'Documents'].includes(s)))];
  return sources.length ? sources : ['Web', 'Papers'];
}
function digDeeper(gapIndex) {
  if (!currentProject) return;
  const gap = (currentProject.brief.research_gaps || [])[gapIndex]; if (!gap) return;
  const question = `${gap} [Follow-up research on: ${currentProject.question}]`;
  $('#prompt').value = question;
  toast('Digging deeper into this gap…');
  startRun(question, projectSources(currentProject));
}

const FOLLOW_CHIPS = [
  ['Latest research', q => `${q} recent findings 2024 2025`],
  ['Opposing views', q => `${q} criticism debate counterarguments`],
  ['Narrower focus', q => `${q} systematic review meta-analysis`]
];
function renderChips(project) {
  const box = $('#followChips'); if (!box) return;
  box.innerHTML = FOLLOW_CHIPS.map((c, i) => `<button data-chip="${i}">${escapeHtml(c[0])}</button>`).join('');
  box.hidden = false;
  box.querySelectorAll('[data-chip]').forEach(b => b.addEventListener('click', () => {
    const q = FOLLOW_CHIPS[Number(b.dataset.chip)][1](project.question);
    $('#prompt').value = q; toast(`Following up: ${FOLLOW_CHIPS[Number(b.dataset.chip)][0]}…`);
    startRun(q, projectSources(project));
  }));
}

async function routeHash() {
  if (DEMO) return;
  const m = (location.hash || '').match(/^#\/p\/([0-9a-f-]+)/i);
  if (!m) return;
  try {
    const r = await fetch(`/api/projects/${m[1]}`); if (!r.ok) return;
    const p = await r.json();
    $('.nav-link[data-view="research"]').click(); $('#prompt').value = p.question; renderProject(p);
  } catch {}
}
window.addEventListener('hashchange', routeHash);
routeHash();

$('#runResearch').addEventListener('click', async () => {
  if (runActive) {
    if (Date.now() - runStartedAt < 800) return;
    cancelRequested = true; toast('Cancelling run…'); return;
  }
  const question = $('#prompt').value.trim(); const sources = [...document.querySelectorAll('.source-toggle input:checked')].map(input => input.dataset.source);
  startRun(question, sources);
});
$('#newResearch').addEventListener('click', () => { document.body.classList.remove('working', 'has-results', 'dock-expanded'); try { history.replaceState(null, '', location.pathname); } catch {} $('.nav-link[data-view="research"]').click(); $('#prompt').value = ''; $('#prompt').focus(); window.scrollTo({ top: 80, behavior: 'smooth' }); });
$('#connectDocs').addEventListener('click', () => toast('Document ingestion is the next local connector to configure. Private files stay on your machine.'));
$('#openBrief').addEventListener('click', () => { const summary = document.querySelector('.summary-card'); if (!summary) return; summary.scrollIntoView({ behavior: 'smooth', block: 'center' }); summary.classList.remove('flash'); void summary.offsetWidth; summary.classList.add('flash'); setTimeout(() => summary.classList.remove('flash'), 1300); });
function exportFilename(format) { return currentProject ? `fieldnote-${currentProject.id.slice(0, 8)}.${format}` : null; }
function guardExport() { if (DEMO) { toast(DEMO_MESSAGE); return false; } if (!currentProject) { toast('Run a research question first.'); return false; } return true; }
$('#expMd').addEventListener('click', () => { if (guardExport()) downloadFile(exportFilename('md'), projectToMarkdown(currentProject), 'text/markdown'); });
$('#expJson').addEventListener('click', () => { if (guardExport()) downloadFile(exportFilename('json'), JSON.stringify(currentProject, null, 2), 'application/json'); });
$('#expPrint').addEventListener('click', () => window.print());
$('#expCopy').addEventListener('click', async () => {
  if (!guardExport()) return;
  try { await navigator.clipboard.writeText(projectToMarkdown(currentProject)); toast('Brief copied to clipboard.'); }
  catch { toast('Could not copy. Try the Markdown download instead.'); }
});
$('#expLink').addEventListener('click', async () => {
  if (!guardExport()) return;
  try { await navigator.clipboard.writeText(`${location.origin}${location.pathname}#/p/${currentProject.id}`); toast('Link to this brief copied.'); }
  catch { toast('Could not copy the link.'); }
});
$('#depthButton').addEventListener('click', () => { depth = depth === 'Thorough' ? 'Quick' : 'Thorough'; $('#depthButton').innerHTML = `${depth} <b>${icon('chevron-down')}</b>`; updateDockMeta(); toast(`Research depth set to ${depth}.`); });
$('#dockMeta').addEventListener('click', () => document.body.classList.toggle('dock-expanded'));
$('#prompt').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); $('#runResearch').click(); }
});
if (window.matchMedia('(pointer:fine)').matches) $('#prompt').focus({ preventScroll: true });
function liftDock() {
  const bar = document.querySelector('.search-card'); const foot = document.querySelector('footer');
  if (!bar || !foot) return;
  const gap = window.innerWidth <= 760 ? 28 : 16;
  const lift = Math.max(0, window.innerHeight - 12 - foot.getBoundingClientRect().top + gap);
  bar.style.transform = lift ? `translateY(${-lift}px)` : '';
  const results = document.querySelector('.results');
  if (results && bar.offsetHeight) results.style.paddingBottom = `${Math.ceil(bar.offsetHeight + 28)}px`;
}
let liftQueued = false;
let lastScrollY = 0;
function updateHeaderVisibility() {
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  const menuOpen = document.body.classList.contains('nav-open');
  if (!menuOpen && y > 140 && y > lastScrollY + 4) document.body.classList.add('nav-hidden');
  else if (y < lastScrollY - 4 || y <= 140) document.body.classList.remove('nav-hidden');
  lastScrollY = y;
}
function queueLift() { if (liftQueued) return; liftQueued = true; requestAnimationFrame(() => { liftQueued = false; liftDock(); updateHeaderVisibility(); updateReadProgress(); }); }
function updateReadProgress() {
  const bar = $('#readProgress'); if (!bar) return;
  const h = document.documentElement;
  const max = (h.scrollHeight || 0) - (h.clientHeight || 0);
  const p = max > 0 ? ((h.scrollTop || 0) / max) : 0;
  const fill = bar.querySelector('i');
  if (fill && isFinite(p)) fill.style.width = `${Math.round(p * 100)}%`;
}
window.addEventListener('scroll', queueLift, { passive: true });
window.addEventListener('resize', queueLift);
window.addEventListener('load', queueLift);
queueLift();

async function refreshLibraryCount() {
  if (DEMO) return;
  try {
    const response = await fetch('/api/projects'); if (!response.ok) return;
    const projects = await response.json();
    document.querySelectorAll('.count').forEach(el => el.textContent = projects.length);
  } catch {}
}
refreshLibraryCount();
updateDockMeta();

async function loadConversations() {
  const section = $('#conversations'); const list = $('#conversationList'); if (!section || !list) return;
  if (DEMO) { section.hidden = true; return; }
  try {
    const response = await fetch('/api/projects'); if (!response.ok) throw new Error('unavailable');
    const projects = mergedLibrary(await response.json());
    document.querySelectorAll('.count').forEach(el => el.textContent = projects.length);
    if (!projects.length) { section.hidden = true; return; }
    section.hidden = false;
    list.innerHTML = projects.slice(0, 6).map(p => `<article class="conversation-card"><button data-open="${p.id}"><b>${escapeHtml(p.question)}</b><span>${p.sources.length} sources · ${new Date(p.created_at).toLocaleDateString()}${p.brief && p.brief.synthesis === 'llm' ? ' · AI summary' : ''}${p.brief && p.brief.grade ? ` · ${escapeHtml(p.brief.grade.label)}` : ''}${p._localOnly ? ' · this device' : ''}</span></button><button class="delete-project" data-delete="${p.id}" aria-label="Delete research">${icon('trash')}</button></article>`).join('');
    list.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => { const p = projects.find(item => item.id === button.dataset.open); if (!p) return; $('#prompt').value = p.question; renderProject(p); }));
    list.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => { try { await fetch(`/api/projects/${button.dataset.delete}`, { method: 'DELETE' }); } catch {} uncacheProject(button.dataset.delete); loadConversations(); }));
  } catch {
    const cached = readCache();
    if (!cached.length) { section.hidden = true; return; }
    section.hidden = false;
    list.innerHTML = cached.slice(0, 6).map(p => `<article class="conversation-card"><button data-open="${p.id}"><b>${escapeHtml(p.question)}</b><span>${p.sources.length} sources · ${new Date(p.created_at).toLocaleDateString()} · this device</span></button><button class="delete-project" data-delete="${p.id}" aria-label="Delete research">${icon('trash')}</button></article>`).join('');
    list.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => { const p = cached.find(item => item.id === button.dataset.open); if (!p) return; $('#prompt').value = p.question; renderProject(p); }));
    list.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', () => { uncacheProject(button.dataset.delete); loadConversations(); }));
  }
}
loadConversations();

let clearArmed = false; let clearTimer = 0;
$('#clearLibrary').addEventListener('click', async () => {
  const btn = $('#clearLibrary'); if (!btn || btn.hidden || btn.disabled) return;
  if (!clearArmed) {
    clearArmed = true; btn.classList.add('armed'); btn.textContent = 'Sure? Click again';
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { clearArmed = false; btn.classList.remove('armed'); btn.innerHTML = `${icon('trash')} Delete all`; }, 3000);
    return;
  }
  clearTimeout(clearTimer); clearArmed = false; btn.classList.remove('armed'); btn.disabled = true;
  const items = [...document.querySelectorAll('.library-list .library-item')];
  const ids = items.map(el => el.querySelector('[data-delete]')?.dataset.delete).filter(Boolean);
  items.forEach((el, i) => { el.style.transitionDelay = `${i * 70}ms`; el.classList.add('deleting'); });
  setTimeout(async () => {
    for (const id of ids) { try { await fetch(`/api/projects/${id}`, { method: 'DELETE' }); } catch {} uncacheProject(id); }
    btn.disabled = false; btn.innerHTML = `${icon('trash')} Delete all`;
    loadLibrary(); loadConversations(); toast('Library cleared.');
  }, items.length * 70 + 450);
});

async function loadLibrary() {  const list = $('.library-list'); if (DEMO) { list.innerHTML = '<div><b>Static preview.</b><span>Your library lives on the local server — run npm start to browse it.</span></div>'; return; } list.innerHTML = '<span class="visually-hidden">Loading saved research…</span><div aria-hidden="true"><div class="skel" style="height:58px"></div></div><div aria-hidden="true"><div class="skel" style="height:58px"></div></div><div aria-hidden="true"><div class="skel" style="height:58px"></div></div>';
  try {
    const response = await fetch('/api/projects'); const projects = mergedLibrary(await response.json()); renderLibraryList(projects);
  } catch {
    const cached = readCache();
    if (cached.length) renderLibraryList(cached.map(p => ({ ...p, _localOnly: true })));
    else list.innerHTML = DEMO ? '<div><b>Static preview.</b><span>Your library lives on the local server — run npm start to browse it.</span></div>' : '<div><b>Library unavailable.</b><span>Start the local server and try again.</span></div>';
  }
}
function renderLibraryList(projects, remember = true) {
  const list = $('.library-list'); if (!list) return;
  if (remember) lastLibrary = projects;
  const clearBtn = $('#clearLibrary'); if (clearBtn) clearBtn.hidden = !projects.length;
  renderStats(projects);
  document.querySelectorAll('.count').forEach(el => el.textContent = projects.length);
  list.innerHTML = projects.length ? projects.map((p, i) => `<div class="library-item"><span class="lib-index">${String(i + 1).padStart(2, '0')}</span><button data-open="${p.id}"><b>${escapeHtml(p.question)}</b><span>${p.sources.length} sources · ${new Date(p.created_at).toLocaleDateString()}${p.brief && p.brief.grade ? ` · ${escapeHtml(p.brief.grade.label)}` : ''}${p._localOnly ? ' · this device' : ''}</span></button><button class="compare-toggle${compareSet.has(p.id) ? ' on' : ''}" data-compare="${p.id}" aria-pressed="${compareSet.has(p.id)}" title="Select to compare">vs</button><button class="delete-project" data-delete="${p.id}" aria-label="Delete research">${icon('trash')}</button></div>`).join('') : '<div><b>No saved research yet.</b><span>Run a question to create your first evidence brief.</span></div>';
  list.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => { const p = projects.find(item => item.id === button.dataset.open); $('.nav-link[data-view="research"]').click(); $('#prompt').value = p.question; renderProject(p); }));
  list.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => { try { await fetch(`/api/projects/${button.dataset.delete}`, { method: 'DELETE' }); } catch {} uncacheProject(button.dataset.delete); compareSet.delete(button.dataset.delete); loadLibrary(); loadConversations(); }));
  list.querySelectorAll('[data-compare]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.compare;
    if (compareSet.has(id)) compareSet.delete(id); else if (compareSet.size < 2) compareSet.add(id); else toast('Compare holds two briefs — deselect one first.');
    renderLibraryList(lastLibrary);
    if (compareSet.size === 2) openCompare();
  }));
  const compareBtn = $('#compareOpen');
  if (compareBtn) compareBtn.hidden = compareSet.size !== 2;
}
let lastLibrary = [];
const compareSet = new Set();
function renderStats(projects) {
  const strip = $('#statsStrip'); if (!strip) return;
  if (!projects.length) { strip.hidden = true; return; }
  let sources = 0, papers = 0, oa = 0;
  projects.forEach(p => (p.sources || []).forEach(s => { sources++; if (s.source_type === 'Paper') papers++; if (s.open_access_url) oa++; }));
  strip.hidden = false;
  strip.innerHTML = `<span><b>${projects.length}</b> briefs</span><span><b>${sources}</b> sources</span><span><b>${papers}</b> papers</span><span><b>${oa}</b> open access</span>`;
}
$('#libSearch').addEventListener('input', e => {
  const q = e.target.value.toLowerCase().trim();
  renderLibraryList(q ? lastLibrary.filter(p => p.question.toLowerCase().includes(q)) : lastLibrary, false);
});
function compareRow(p) {
  const b = p.brief || {}; const c = b.coverage || {};
  return `<div><h4>${escapeHtml(p.question)}</h4><p class="compare-meta">${p.sources.length} sources · ${b.synthesis || 'template'}${p._localOnly ? ' · this device' : ''}</p><div class="compare-counts"><span><b>${c.papers || 0}</b>papers</span><span><b>${c.web || 0}</b>web</span><span><b>${c.videos || 0}</b>video</span><span><b>${c.documents || 0}</b>docs</span></div><h5>Findings</h5>${(b.findings || []).map(f => `<p>${escapeHtml(f)}</p>`).join('')}<h5>Gaps</h5>${(b.research_gaps || []).map(g => `<p>${escapeHtml(g)}</p>`).join('')}</div>`;
}
function openCompare() {
  const pair = [...compareSet].map(id => lastLibrary.find(p => p.id === id)).filter(Boolean);
  if (pair.length !== 2) return;
  const grid = $('#compareGrid'); const back = $('#compareBackdrop'); if (!grid || !back) return;
  grid.innerHTML = pair.map(compareRow).join('');
  back.hidden = false;
}
function closeCompare() { const back = $('#compareBackdrop'); if (back) back.hidden = true; }
$('#compareOpen').addEventListener('click', openCompare);
$('#compareClose').addEventListener('click', closeCompare);
$('#compareBackdrop').addEventListener('click', e => { if (e.target.id === 'compareBackdrop') closeCompare(); });

/* ── Offline shell ── */
if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing; if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) toast('Update ready — reload to apply it.');
        });
      });
    }).catch(() => {});
  });
}

/* ── Install prompt ── */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredPrompt = e;
  const btn = $('#installApp'); if (btn) btn.hidden = false;
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  const btn = $('#installApp'); if (btn) btn.hidden = true;
  try { localStorage.setItem('fieldnote.seen', '1'); } catch {}
});
$('#installApp').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  try { await deferredPrompt.userChoice; } catch {}
  deferredPrompt = null;
  $('#installApp').hidden = true;
});

/* ── First-run hint ── */
(function firstHint() {
  let seen = null;
  try { seen = localStorage.getItem('fieldnote.seen'); } catch {}
  if (seen || DEMO) return;
  setTimeout(() => {
    let stillFresh = true;
    try { stillFresh = !localStorage.getItem('fieldnote.seen'); } catch {}
    const hint = $('#firstHint');
    if (stillFresh && hint) hint.hidden = false;
  }, 900);
})();
$('#firstHint').addEventListener('click', () => {
  const hint = $('#firstHint'); if (hint) hint.hidden = true;
  try { localStorage.setItem('fieldnote.seen', '1'); } catch {}
});

/* ── Command palette (⌘K) ── */
function paletteItems(projects) {
  const items = [
    { label: 'New research', hint: 'prompt', run: () => $('#newResearch').click() },
    { label: 'Go to Research', hint: 'view', run: () => $('.nav-link[data-view="research"]').click() },
    { label: 'Go to Library', hint: 'view', run: () => $('.nav-link[data-view="library"]').click() },
    { label: 'Go to Tech stack', hint: 'view', run: () => $('.nav-link[data-view="stack"]').click() },
    { label: 'Toggle dark mode', hint: 'theme', run: () => $('#themeToggle').click() },
    { label: `Depth: switch to ${depth === 'Thorough' ? 'Quick' : 'Thorough'}`, hint: 'depth', run: () => $('#depthButton').click() }
  ];
  if (currentProject) {
    items.push({ label: 'Download brief as Markdown', hint: 'export', run: () => $('#expMd').click() });
    items.push({ label: 'Print brief', hint: 'export', run: () => $('#expPrint').click() });
  }
  projects.slice(0, 8).forEach(p => items.push({ label: p.question, hint: `${p.sources.length} sources`, run: () => { $('#prompt').value = p.question; renderProject(p); } }));
  return items;
}
function filterPalette(items, q) {
  const terms = String(q || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items.map(item => {
    const hay = `${item.label} ${item.hint || ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) { const at = hay.indexOf(t); if (at < 0) return null; score += at; }
    return { item, score };
  }).filter(Boolean).sort((a, b) => a.score - b.score).map(e => e.item);
}
let paletteCache = [];
let paletteActive = 0;
async function openPalette() {
  const backdrop = $('#paletteBackdrop'); const input = $('#paletteInput'); if (!backdrop || !input) return;
  let projects = [];
  try { const r = await fetch('/api/projects'); if (r.ok) projects = mergedLibrary(await r.json()); } catch {}
  if (!projects.length) projects = readCache();
  paletteCache = paletteItems(projects);
  paletteActive = 0;
  renderPalette('');
  backdrop.hidden = false; input.value = ''; input.focus();
}
function closePalette() { const b = $('#paletteBackdrop'); if (b) b.hidden = true; }
function renderPalette(q) {
  const list = $('#paletteList'); if (!list) return;
  const items = filterPalette(paletteCache, q).slice(0, 9);
  list.innerHTML = items.length ? items.map((item, i) => `<button role="option" data-pal="${i}" aria-selected="${i === paletteActive}"><b>${escapeHtml(item.label)}</b><span>${escapeHtml(item.hint || '')}</span></button>`).join('') : '<div class="palette-empty">No matches.</div>';
  list.querySelectorAll('[data-pal]').forEach(b => b.addEventListener('click', () => { const it = items[Number(b.dataset.pal)]; closePalette(); if (it) it.run(); }));
  highlightPalette();
}
function highlightPalette() {
  document.querySelectorAll('#paletteList [data-pal]').forEach((b, i) => b.classList.toggle('active', i === paletteActive));
}
$('#paletteInput').addEventListener('input', e => { paletteActive = 0; renderPalette(e.target.value); });
$('#paletteInput').addEventListener('keydown', e => {
  const items = filterPalette(paletteCache, e.target.value).slice(0, 9);
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteActive = Math.min(paletteActive + 1, items.length - 1); highlightPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteActive = Math.max(paletteActive - 1, 0); highlightPalette(); }
  else if (e.key === 'Enter') { const it = items[paletteActive]; closePalette(); if (it) it.run(); }
  else if (e.key === 'Escape') closePalette();
});
$('#paletteBackdrop').addEventListener('click', e => { if (e.target.id === 'paletteBackdrop') closePalette(); });
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#paletteBackdrop').hidden ? openPalette() : closePalette(); }
});

/* ── Voice input ── */
(function voice() {
  const btn = $('#micButton'); if (!btn) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  btn.hidden = false;
  const rec = new SR();
  rec.lang = (navigator.language || 'en-US'); rec.interimResults = false; rec.maxAlternatives = 1;
  rec.onresult = e => {
    const text = [...e.results].map(r => r[0].transcript).join(' ');
    const cur = $('#prompt').value.trim();
    $('#prompt').value = cur ? `${cur} ${text}` : text;
    autogrow(); $('#prompt').focus();
  };
  rec.onend = () => btn.classList.remove('recording');
  rec.onerror = () => { btn.classList.remove('recording'); toast('Microphone unavailable right now.'); };
  btn.addEventListener('click', () => { try { btn.classList.add('recording'); rec.start(); } catch { btn.classList.remove('recording'); } });
})();

if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
  document.querySelectorAll('.stack-grid article, .architecture>div').forEach(el => { el.classList.add('reveal'); io.observe(el); });
}
(async function serviceStatus() {  const dot = $('#footDot'); const text = $('#footText'); if (!dot || !text) return;
  if (DEMO) { text.textContent = 'static preview — run npm start locally for full research'; return; }
  try {
    const response = await fetch('/api/health'); if (!response.ok) throw new Error('unhealthy');
    const health = await response.json();
    document.querySelector('.foot-status').classList.add('online');
    text.textContent = `local service online · v${health.version || '?'} · AI ${health.ai || 'extractive'} · ${health.active_runs || 0} active runs`;
  } catch { text.textContent = 'local service unreachable — start it with npm start'; }
})();
