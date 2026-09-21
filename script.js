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
  const lines = [`# ${p.question}`, '', `*Fieldnote evidence brief · ${p.created_at || ''} · ${sources.length} sources · synthesis: ${b.synthesis || 'template'}*`, '', '## Summary', '', b.opening || '', '', '## Key findings', ''];
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
  const button = $('#runResearch'); button.disabled = running;
  button.innerHTML = running ? `Researching ${icon('spark')}` : `Research <span>${icon('send')}</span>`;
  document.querySelectorAll('.agent-card.active-agent').forEach(card => card.classList.toggle('is-working', running));
}
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }
function icon(name) { return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`; }
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
  const mapping = { 'web-scout': ['#webCount', '.agent-card:nth-child(1)'], 'video-listener': ['#videoCount', '.agent-card:nth-child(2)'], 'paper-trail': ['#paperCount', '.agent-card:nth-child(3)'], 'document-reader': ['#docCount', '.agent-card:nth-child(4)'] };
  agents.forEach(agent => { const entry = mapping[agent.name]; if (!entry) return; $(entry[0]).textContent = agent.name === 'document-reader' ? (agent.status === 'completed' ? `${agent.sources_found} documents matched` : agent.status === 'failed' ? 'No documents matched' : agent.status === 'running' ? 'Reading local files…' : 'Private context on hold') : agent.status === 'completed' ? `${agent.sources_found} sources found` : agent.status === 'failed' ? 'Could not reach source' : 'Working…'; document.querySelector(entry[1]).classList.toggle('is-working', agent.status === 'running'); });
}
let currentProject = null;
function renderProject(project) {
  currentProject = project;
  const sources = project.sources || []; const byType = type => sources.filter(s => s.source_type === type).length;
  $('#statusText').textContent = `${sources.length} sources collected`;
  $('#webCount').textContent = `${byType('Web')} sources found`; $('#videoCount').textContent = `${byType('Video')} video query ready`; $('#paperCount').textContent = `${byType('Paper')} papers indexed`; const docCount = $('#docCount'); if (docCount) docCount.textContent = `${byType('Document')} documents matched`;
  $('.results h2').textContent = project.question;
  document.querySelector('.results-head .eyebrow').innerHTML = '<i></i> EVIDENCE BRIEF';
  document.querySelector('.summary-card').innerHTML = `<p class="summary-lead">${escapeHtml(project.brief.opening)}</p>${project.brief.findings.map((finding, index) => `<div class="takeaway"><span>0${index + 1}</span><p>${escapeHtml(finding)}</p></div>`).join('')}<p class="brief-caveat">${escapeHtml(project.brief.caveat)}</p>`;
  const synthNote = project.brief.synthesis === 'llm' ? 'AI-synthesized with a local model · citations checked' : project.brief.synthesis === 'extractive' ? 'Auto-summarized from retrieved excerpts' : 'Template summary · enable Ollama for AI synthesis';
  document.querySelector('.summary-card').insertAdjacentHTML('afterbegin', `<p class="synth-note">${escapeHtml(synthNote)}</p>`);
  document.querySelector('.sources-panel').innerHTML = `<div class="panel-title"><span>Evidence collected</span><b>${sources.length} sources</b></div>${sources.slice(0, 6).map(sourceHtml).join('')}<button class="all-sources" id="allSources">View all ${sources.length} sources <span>${icon('arrow-right')}</span></button>`;
  $('#allSources').addEventListener('click', () => { document.querySelector('.sources-panel').innerHTML = `<div class="panel-title"><span>All evidence</span><b>${sources.length} sources</b></div>${sources.map(sourceHtml).join('')}`; });
  document.querySelector('.report-details')?.remove();
  const coverage = project.brief.coverage || {}; const evidence = project.brief.evidence_map || []; const gaps = project.brief.research_gaps || [];
  document.querySelector('.finding-layout').insertAdjacentHTML('afterend', `<section class="report-details"><div class="report-heading"><div><div class="eyebrow"><i></i> RESEARCH NOTES</div><h3>Evidence map & coverage</h3></div><p>Review source excerpts before adopting a claim. Match scores reflect term overlap, not factual correctness.</p></div><div class="coverage-grid"><div><b>${coverage.papers || 0}</b><span>scholarly records</span></div><div><b>${coverage.web || 0}</b><span>web references</span></div><div><b>${coverage.documents || 0}</b><span>private documents</span></div><div><b>${coverage.videos || 0}</b><span>video leads</span></div></div>${(project.brief.takeaways?.length || project.brief.faq?.length) ? `<div class="study-block"><div><h4>Key takeaways</h4>${(project.brief.takeaways || []).map(t => `<p>${escapeHtml(t)}</p>`).join('') || '<p>No takeaways extracted.</p>'}</div><div><h4>Self-test questions</h4>${(project.brief.faq || []).map(f => `<details><summary>${escapeHtml(f.q)}</summary><p>${escapeHtml(f.a)}</p></details>`).join('') || '<p>Enable AI synthesis for generated study questions.</p>'}</div></div>` : ''}<div class="evidence-map"><div><h4>Most relevant evidence</h4>${evidence.map((item, index) => `<article><span>${String(index + 1).padStart(2, '0')}</span><div><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.source_type)} · ${escapeHtml(item.reliability)}${item.relevance ? ` · ${item.relevance}% match` : ''}</small><p>${escapeHtml(item.excerpt || 'No excerpt available.')}</p>${oaBadge(item)}</div></article>`).join('')}</div><div class="gap-list"><h4>What this run cannot answer yet</h4>${gaps.map((gap, index) => `<p>${escapeHtml(gap)}<button class="gap-dig" data-gap="${index}">Dig deeper <span>${icon('arrow-right')}</span></button></p>`).join('')}<h4>Search scope</h4><p>${(coverage.search_terms || []).map(escapeHtml).join(' · ') || 'No extracted terms'}</p></div></div></section>`);
  document.querySelectorAll('.gap-dig').forEach(button => button.addEventListener('click', () => digDeeper(Number(button.dataset.gap))));
  if (project.errors?.length) toast(`Partial result: ${project.errors[0]}`);
  document.body.classList.remove('working'); document.body.classList.add('has-results');
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  queueLift();
}

function updateDockMeta() {
  const el = $('#dockMeta'); if (!el) return;
  const sources = [...document.querySelectorAll('.source-toggle input:checked')].map(input => input.dataset.source);
  el.innerHTML = `${escapeHtml(sources.join(' · ') || 'No sources')} · ${escapeHtml(depth)} <span>edit ⌄</span>`;
}
async function startRun(question, sources) {
  if (DEMO) return toast(DEMO_MESSAGE);
  if (!question) return toast('Add a question to begin your research.'); if (!sources.length) return toast('Select at least one online source.');
  if (!navigator.onLine) return toast('You appear to be offline. Web and paper sources need a connection.');
  updateDockMeta();
  document.body.classList.add('working'); document.body.classList.remove('has-results', 'dock-expanded');
  setRunning(true); $('#statusText').textContent = 'Agents are retrieving evidence'; $('#workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    showResultLoading();
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, sources, depth }) });
    let run = await response.json(); if (!response.ok) throw new Error(run.error || 'Research could not be started.');
    while (run.status === 'queued' || run.status === 'running') { updateAgents(run.agents); syncResultProgress(run); await new Promise(resolve => setTimeout(resolve, 1000)); const progress = await fetch(`/api/runs/${run.id}`); run = await progress.json(); }
    updateAgents(run.agents); if (run.status !== 'completed') throw new Error(run.error || 'Research could not be completed.'); finishResultLoading(true); renderProject(run.result); cacheProject(run.result); refreshLibraryCount(); loadConversations(); toast('Evidence brief saved to your library.');
  } catch (error) { finishResultLoading(false); $('#statusText').textContent = 'Research needs attention'; document.body.classList.remove('working'); toast(error.message); }
  finally { setRunning(false); }
}

function digDeeper(gapIndex) {
  if (!currentProject) return;
  const gap = (currentProject.brief.research_gaps || [])[gapIndex]; if (!gap) return;
  const sources = [...new Set((currentProject.agents || []).map(a => a.source).filter(s => ['Web', 'Papers', 'YouTube', 'Documents'].includes(s)))];
  const question = `${gap} [Follow-up research on: ${currentProject.question}]`;
  $('#prompt').value = question;
  toast('Digging deeper into this gap…');
  startRun(question, sources.length ? sources : ['Web', 'Papers']);
}

$('#runResearch').addEventListener('click', async () => {
  const question = $('#prompt').value.trim(); const sources = [...document.querySelectorAll('.source-toggle input:checked')].map(input => input.dataset.source);
  startRun(question, sources);
});
$('#newResearch').addEventListener('click', () => { document.body.classList.remove('working', 'has-results', 'dock-expanded'); $('.nav-link[data-view="research"]').click(); $('#prompt').value = ''; $('#prompt').focus(); window.scrollTo({ top: 80, behavior: 'smooth' }); });
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
}
let liftQueued = false;
function queueLift() { if (liftQueued) return; liftQueued = true; requestAnimationFrame(() => { liftQueued = false; liftDock(); }); }
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
    list.innerHTML = projects.slice(0, 6).map(p => `<article class="conversation-card"><button data-open="${p.id}"><b>${escapeHtml(p.question)}</b><span>${p.sources.length} sources · ${new Date(p.created_at).toLocaleDateString()}${p.brief && p.brief.synthesis === 'llm' ? ' · AI summary' : ''}${p._localOnly ? ' · this device' : ''}</span></button><button class="delete-project" data-delete="${p.id}" aria-label="Delete research">${icon('trash')}</button></article>`).join('');
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
function renderLibraryList(projects) {
  const list = $('.library-list'); if (!list) return;
  const clearBtn = $('#clearLibrary'); if (clearBtn) clearBtn.hidden = !projects.length;
  document.querySelectorAll('.count').forEach(el => el.textContent = projects.length);
  list.innerHTML = projects.length ? projects.map(p => `<div class="library-item"><button data-open="${p.id}"><b>${escapeHtml(p.question)}</b><span>${p.sources.length} sources · ${new Date(p.created_at).toLocaleDateString()}${p._localOnly ? ' · this device' : ''}</span></button><button class="delete-project" data-delete="${p.id}" aria-label="Delete research">${icon('trash')}</button></div>`).join('') : '<div><b>No saved research yet.</b><span>Run a question to create your first evidence brief.</span></div>';
  list.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => { const p = projects.find(item => item.id === button.dataset.open); $('.nav-link[data-view="research"]').click(); $('#prompt').value = p.question; renderProject(p); }));
  list.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => { try { await fetch(`/api/projects/${button.dataset.delete}`, { method: 'DELETE' }); } catch {} uncacheProject(button.dataset.delete); loadLibrary(); loadConversations(); }));
}

(async function serviceStatus() {
  const dot = $('#footDot'); const text = $('#footText'); if (!dot || !text) return;
  if (DEMO) { text.textContent = 'static preview — run npm start locally for full research'; return; }
  try {
    const response = await fetch('/api/health'); if (!response.ok) throw new Error('unhealthy');
    const health = await response.json();
    document.querySelector('.foot-status').classList.add('online');
    text.textContent = `local service online · v${health.version || '?'} · ${health.active_runs || 0} active runs`;
  } catch { text.textContent = 'local service unreachable — start it with npm start'; }
})();
