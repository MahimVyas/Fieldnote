const $ = (s) => document.querySelector(s);
const toast = (message) => { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 3200); };

function paintTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  const toggle = $('#themeToggle');
  toggle.setAttribute('aria-pressed', String(dark));
  toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  toggle.querySelector('.theme-icon').textContent = dark ? '☀' : '☾';
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
  visibleProgress = 8; $('#resultsLoading').hidden = false;
  setResultProgress(8, 'Planner is mapping the research question', 'plan');
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  setTimeout(() => { $('#resultsLoading').hidden = true; }, 520);
}

document.querySelectorAll('.nav-link').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
  button.classList.add('active');
  ['research', 'stack', 'library'].forEach(view => $('#'+view+'View').hidden = button.dataset.view !== view);
  if (button.dataset.view === 'library') loadLibrary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}));
document.querySelectorAll('.source-toggle').forEach(label => label.addEventListener('click', () => setTimeout(() => label.classList.toggle('checked', label.querySelector('input').checked))));

function setRunning(running) {
  const button = $('#runResearch'); button.disabled = running;
  button.innerHTML = running ? 'Researching <span>…</span>' : 'Research <span>↗</span>';
  document.querySelectorAll('.agent-card.active-agent').forEach(card => card.classList.toggle('is-working', running));
}
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }
function oaBadge(source) {
  return source.open_access_url ? `<a class="oa-badge" href="${escapeHtml(source.open_access_url)}" target="_blank" rel="noopener noreferrer">Open access ↗</a>` : '';
}
function oaChip(source) {
  return source.open_access_url ? `<span class="oa-badge" data-href="${escapeHtml(source.open_access_url)}" role="link" tabindex="0">Open access ↗</span>` : '';
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
  const score = source.relevance?.score ? ` · ${source.relevance.score}% match` : ''; const body = `<span class="source-type ${type}-type">${source.source_type.toUpperCase()}</span><div><b>${escapeHtml(source.title)}</b><small>${escapeHtml(source.publisher || source.source_type)}${date}${score} · ${escapeHtml(source.reliability || 'unrated')}</small><p class="source-excerpt">${escapeHtml(source.excerpt || 'No excerpt available.')}</p>${oaChip(source)}</div><em>${source.url ? '↗' : 'local'}</em>`;
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
  document.querySelector('.summary-card').innerHTML = `<p class="summary-lead">${escapeHtml(project.brief.opening)}</p>${project.brief.findings.map((finding, index) => `<div class="takeaway"><span>0${index + 1}</span><p>${escapeHtml(finding)}</p></div>`).join('')}<p class="brief-caveat">${escapeHtml(project.brief.caveat)}</p>`;
  const synthNote = project.brief.synthesis === 'llm' ? 'AI-synthesized with a local model · citations checked' : project.brief.synthesis === 'extractive' ? 'Auto-summarized from retrieved excerpts' : 'Template summary · enable Ollama for AI synthesis';
  document.querySelector('.summary-card').insertAdjacentHTML('afterbegin', `<p class="synth-note">${escapeHtml(synthNote)}</p>`);
  document.querySelector('.sources-panel').innerHTML = `<div class="panel-title"><span>Evidence collected</span><b>${sources.length} sources</b></div>${sources.slice(0, 6).map(sourceHtml).join('')}<button class="all-sources" id="allSources">View all ${sources.length} sources <span>→</span></button>`;
  $('#allSources').addEventListener('click', () => { document.querySelector('.sources-panel').innerHTML = `<div class="panel-title"><span>All evidence</span><b>${sources.length} sources</b></div>${sources.map(sourceHtml).join('')}`; });
  document.querySelector('.report-details')?.remove();
  const coverage = project.brief.coverage || {}; const evidence = project.brief.evidence_map || []; const gaps = project.brief.research_gaps || [];
  document.querySelector('.finding-layout').insertAdjacentHTML('afterend', `<section class="report-details"><div class="report-heading"><div><div class="eyebrow"><i></i> RESEARCH NOTES</div><h3>Evidence map & coverage</h3></div><p>Review source excerpts before adopting a claim. Match scores reflect term overlap, not factual correctness.</p></div><div class="coverage-grid"><div><b>${coverage.papers || 0}</b><span>scholarly records</span></div><div><b>${coverage.web || 0}</b><span>web references</span></div><div><b>${coverage.documents || 0}</b><span>private documents</span></div><div><b>${coverage.videos || 0}</b><span>video leads</span></div></div><div class="evidence-map"><div><h4>Most relevant evidence</h4>${evidence.map((item, index) => `<article><span>${String(index + 1).padStart(2, '0')}</span><div><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.source_type)} · ${escapeHtml(item.reliability)}${item.relevance ? ` · ${item.relevance}% match` : ''}</small><p>${escapeHtml(item.excerpt || 'No excerpt available.')}</p>${oaBadge(item)}</div></article>`).join('')}</div><div class="gap-list"><h4>What this run cannot answer yet</h4>${gaps.map((gap, index) => `<p>${escapeHtml(gap)}<button class="gap-dig" data-gap="${index}">Dig deeper <span>→</span></button></p>`).join('')}<h4>Search scope</h4><p>${(coverage.search_terms || []).map(escapeHtml).join(' · ') || 'No extracted terms'}</p></div></div></section>`);
  document.querySelectorAll('.gap-dig').forEach(button => button.addEventListener('click', () => digDeeper(Number(button.dataset.gap))));
  if (project.errors?.length) toast(`Partial result: ${project.errors[0]}`);
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function startRun(question, sources) {
  if (!question) return toast('Add a question to begin your research.'); if (!sources.length) return toast('Select at least one online source.');
  if (!navigator.onLine) return toast('You appear to be offline. Web and paper sources need a connection.');
  setRunning(true); $('#statusText').textContent = 'Agents are retrieving evidence'; $('#workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    showResultLoading();
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, sources, depth }) });
    let run = await response.json(); if (!response.ok) throw new Error(run.error || 'Research could not be started.');
    while (run.status === 'queued' || run.status === 'running') { updateAgents(run.agents); syncResultProgress(run); await new Promise(resolve => setTimeout(resolve, 700)); const progress = await fetch(`/api/runs/${run.id}`); run = await progress.json(); }
    updateAgents(run.agents); if (run.status !== 'completed') throw new Error(run.error || 'Research could not be completed.'); finishResultLoading(true); renderProject(run.result); refreshLibraryCount(); toast('Evidence brief saved to your library.');
  } catch (error) { finishResultLoading(false); $('#statusText').textContent = 'Research needs attention'; toast(error.message); }
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
$('#newResearch').addEventListener('click', () => { $('.nav-link[data-view="research"]').click(); $('#prompt').value = ''; $('#prompt').focus(); window.scrollTo({ top: 80, behavior: 'smooth' }); });
$('#connectDocs').addEventListener('click', () => toast('Document ingestion is the next local connector to configure. Private files stay on your machine.'));
$('#openBrief').addEventListener('click', () => $('#results').scrollIntoView({ behavior: 'smooth' }));
$('#depthButton').addEventListener('click', () => { depth = depth === 'Thorough' ? 'Quick' : 'Thorough'; $('#depthButton').innerHTML = `${depth} <b>⌄</b>`; toast(`Research depth set to ${depth}.`); });

async function refreshLibraryCount() {
  try {
    const response = await fetch('/api/projects'); if (!response.ok) return;
    const projects = await response.json();
    document.querySelectorAll('.count').forEach(el => el.textContent = projects.length);
  } catch {}
}
refreshLibraryCount();

async function loadLibrary() {  const list = $('.library-list'); list.innerHTML = '<div><b>Loading saved research…</b></div>';
  try {
    const response = await fetch('/api/projects'); const projects = await response.json(); document.querySelectorAll('.count').forEach(el => el.textContent = projects.length);
    list.innerHTML = projects.length ? projects.map(p => `<div class="library-item"><button data-open="${p.id}"><b>${escapeHtml(p.question)}</b><span>${p.sources.length} sources · ${new Date(p.created_at).toLocaleDateString()}</span></button><button class="delete-project" data-delete="${p.id}" aria-label="Delete research">×</button></div>`).join('') : '<div><b>No saved research yet.</b><span>Run a question to create your first evidence brief.</span></div>';
    list.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => { const p = projects.find(item => item.id === button.dataset.open); $('.nav-link[data-view="research"]').click(); $('#prompt').value = p.question; renderProject(p); }));
    list.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => { await fetch(`/api/projects/${button.dataset.delete}`, { method: 'DELETE' }); loadLibrary(); }));
  } catch { list.innerHTML = '<div><b>Library unavailable.</b><span>Start the local server and try again.</span></div>'; }
}

(async function serviceStatus() {
  const dot = $('#footDot'); const text = $('#footText'); if (!dot || !text) return;
  try {
    const response = await fetch('/api/health'); if (!response.ok) throw new Error('unhealthy');
    const health = await response.json();
    document.querySelector('.foot-status').classList.add('online');
    text.textContent = `local service online · v${health.version || '?'} · ${health.active_runs || 0} active runs`;
  } catch { text.textContent = 'local service unreachable — start it with npm start'; }
})();
