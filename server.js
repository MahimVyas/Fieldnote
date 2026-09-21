const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { plan, reviewEvidence, writeBrief, briefToMarkdown } = require('./agents');
const { version } = require('./package.json');

/* Load local .env (no dependencies): real environment always wins. */
try {
  const envText = require('node:fs').readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envText.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env) && !line.trim().startsWith('#')) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}

const root = __dirname;
const startedAt = Date.now();
const config = Object.freeze({ port: Number(process.env.PORT || 3000), dataPath: process.env.FIELDNOTE_DATA_PATH || path.join(root, 'data', 'research.json'), documentsPath: process.env.FIELDNOTE_DOCUMENTS_PATH || path.join(root, 'documents'), maxQuestionLength: 1000, maxSavedProjects: 500, rateWindowMs: 60_000, rateLimit: 20 });
const runs = new Map(); const rateBuckets = new Map();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };
/* Only these files are ever served. Everything else (server.js, agents.js,
   package.json, .env, data/, documents/) returns 404. WHATWG URLs normalize
   dot segments before we see them, so a blocklist cannot protect us. */
const publicFiles = new Set(['index.html', 'script.js', 'style.css', 'favicon.svg', 'robots.txt', 'sitemap.xml']);
const csp = "default-src 'self'; base-uri 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'";

function log(status, req, started, requestId, error) {
  const elapsed = Date.now() - started;
  const detail = error ? ` error="${String(error.message || error).slice(0, 160)}"` : '';
  console.log(`${req.method} ${new URL(req.url, 'http://localhost').pathname} ${status} ${elapsed}ms id=${requestId}${detail}`);
}
function send(res, req, started, requestId, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
  const headers = { 'Content-Type': type, 'Cache-Control': type.includes('html') ? 'no-cache' : 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': csp, 'X-Request-Id': requestId, ...extraHeaders };
  res.writeHead(status, headers); res.end(status === 204 ? undefined : type.includes('json') ? JSON.stringify(body) : body);
  log(status, req, started, requestId);
}
function rateLimited(req) { const now = Date.now(); const key = req.socket.remoteAddress || 'unknown'; const active = (rateBuckets.get(key) || []).filter(time => time > now - config.rateWindowMs); active.push(now); rateBuckets.set(key, active); return active.length > config.rateLimit; }
async function readProjects() { try { return JSON.parse(await fs.readFile(config.dataPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
async function writeProjects(projects) { await fs.mkdir(path.dirname(config.dataPath), { recursive: true }); const temporary = `${config.dataPath}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temporary, JSON.stringify(projects, null, 2), { mode: 0o600 }); await fs.rename(temporary, config.dataPath); }
async function readJson(req) { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 32_000) throw new Error('Request body is too large.'); } try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('Request body must be valid JSON.'); } }
function publicRun(run) { const { question, depth, agents, status, started_at, completed_at, result, error } = run; return { id: run.id, question, depth, agents, status, started_at, completed_at, result, error }; }

async function executeRun(run) {
  run.status = 'running'; run.agents.forEach(agent => agent.status = 'queued');
  const jobs = run.plan.map(async (task, index) => {
    const agent = run.agents[index]; agent.status = 'running'; agent.started_at = new Date().toISOString();
    try { const sources = await task.execute(task.question, { depth: run.depth, documentsPath: config.documentsPath }); agent.status = 'completed'; agent.sources_found = sources.length; agent.completed_at = new Date().toISOString(); return sources; }
    catch (error) { agent.status = 'failed'; agent.error = error.message; agent.completed_at = new Date().toISOString(); return []; }
  });
  const sources = reviewEvidence((await Promise.all(jobs)).flat());
  if (!sources.length) { run.status = 'failed'; run.error = 'No sources could be retrieved. Check your connection or revise the question.'; run.completed_at = new Date().toISOString(); return; }
  const project = { id: run.id, question: run.question, depth: run.depth, sources, brief: await writeBrief(run.question, sources), agents: run.agents, errors: run.agents.filter(agent => agent.status === 'failed').map(agent => `${agent.name}: ${agent.error}`), created_at: run.started_at };
  const projects = await readProjects(); projects.unshift(project); await writeProjects(projects.slice(0, config.maxSavedProjects)); run.result = project; run.status = 'completed'; run.completed_at = new Date().toISOString();
}
async function createRun(input) {
  const question = String(input.question || '').replace(/\s+/g, ' ').trim();
  if (question.length < 4) throw new Error('Please enter a more specific research question.'); if (question.length > config.maxQuestionLength) throw new Error('Question is too long.');
  const enabled = (Array.isArray(input.sources) ? input.sources : []).filter(source => ['Web', 'Papers', 'YouTube', 'Documents'].includes(source)); if (!enabled.length) throw new Error('Choose at least one research source.');
  const tasks = plan(question, enabled); const run = { id: crypto.randomUUID(), question, depth: input.depth === 'Quick' ? 'Quick' : 'Thorough', plan: tasks, agents: tasks.map(task => ({ name: task.name, source: task.source, status: 'queued', sources_found: 0 })), status: 'queued', started_at: new Date().toISOString() };
  runs.set(run.id, run); void executeRun(run).catch(error => { run.status = 'failed'; run.error = 'Research run failed unexpectedly.'; run.completed_at = new Date().toISOString(); console.error(error); }); return publicRun(run);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now(); const requestId = crypto.randomUUID();
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/favicon.ico') return send(res, req, started, requestId, 200, await fs.readFile(path.join(root, 'favicon.svg')), types['.svg']);
    if (req.method !== 'GET' && url.pathname.startsWith('/api/') && rateLimited(req)) return send(res, req, started, requestId, 429, { error: 'Too many requests. Please retry in a minute.' });
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, req, started, requestId, 200, { status: 'ok', service: 'fieldnote', version, uptime_seconds: Math.floor((Date.now() - startedAt) / 1000), active_runs: [...runs.values()].filter(run => run.status === 'running' || run.status === 'queued').length });
    if (req.method === 'GET' && url.pathname === '/api/projects') return send(res, req, started, requestId, 200, await readProjects());
    if (req.method === 'POST' && url.pathname === '/api/runs') return send(res, req, started, requestId, 202, await createRun(await readJson(req)));
    if (req.method === 'GET' && /^\/api\/runs\/[0-9a-f-]+$/i.test(url.pathname)) { const run = runs.get(url.pathname.split('/').pop()); return run ? send(res, req, started, requestId, 200, publicRun(run)) : send(res, req, started, requestId, 404, { error: 'Research run not found.' }); }
    if (req.method === 'DELETE' && /^\/api\/projects\/[0-9a-f-]+$/i.test(url.pathname)) { const id = url.pathname.split('/').pop(); await writeProjects((await readProjects()).filter(project => project.id !== id)); return send(res, req, started, requestId, 204, ''); }
    if (req.method === 'GET' && /^\/api\/projects\/[0-9a-f-]+\/export$/i.test(url.pathname)) {
      const id = url.pathname.split('/')[3]; const project = (await readProjects()).find(p => p.id === id);
      if (!project) return send(res, req, started, requestId, 404, { error: 'Research not found.' });
      const format = url.searchParams.get('format') === 'json' ? 'json' : 'md';
      const filename = `fieldnote-${id.slice(0, 8)}.${format}`;
      const isJson = format === 'json';
      const body = isJson ? project : briefToMarkdown(project);
      return send(res, req, started, requestId, 200, body, isJson ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8', { 'Content-Disposition': `attachment; filename="${filename}"` });
    }
    if (req.method !== 'GET') return send(res, req, started, requestId, 405, { error: 'Method not allowed.' });
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!publicFiles.has(file)) return send(res, req, started, requestId, 404, { error: 'Not found.' });
    return send(res, req, started, requestId, 200, await fs.readFile(path.join(root, file)), types[path.extname(file)] || 'application/octet-stream');
  } catch (error) { const status = error.code === 'ENOENT' ? 404 : 400; const message = error.code === 'ENOENT' ? 'Not found.' : (error.message || 'Unexpected server error.'); return send(res, req, started, requestId, status, { error: message }); }
});
server.listen(config.port, () => console.log(`Fieldnote v${version} is running at http://localhost:${config.port}`));
function shutdown(signal) { console.log(`Received ${signal}; closing server.`); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); }
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', error => console.error(`Unhandled rejection: ${error && error.stack ? error.stack : error}`));
