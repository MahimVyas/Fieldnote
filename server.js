const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { plan, reviewEvidence, writeBrief } = require('./agents');

const root = __dirname;
const config = Object.freeze({ port: Number(process.env.PORT || 3000), dataPath: process.env.FIELDNOTE_DATA_PATH || path.join(root, 'data', 'research.json'), documentsPath: process.env.FIELDNOTE_DOCUMENTS_PATH || path.join(root, 'documents'), maxQuestionLength: 1000, maxSavedProjects: 500, rateWindowMs: 60_000, rateLimit: 20 });
const runs = new Map(); const rateBuckets = new Map();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const headers = { 'Content-Type': type, 'Cache-Control': type.includes('html') ? 'no-cache' : 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
  res.writeHead(status, headers); res.end(status === 204 ? undefined : type.includes('json') ? JSON.stringify(body) : body);
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
    try { const sources = task.source === 'Documents' ? await task.execute(task.question, config.documentsPath) : await task.execute(task.question); agent.status = 'completed'; agent.sources_found = sources.length; agent.completed_at = new Date().toISOString(); return sources; }
    catch (error) { agent.status = 'failed'; agent.error = error.message; agent.completed_at = new Date().toISOString(); return []; }
  });
  const sources = reviewEvidence((await Promise.all(jobs)).flat());
  if (!sources.length) { run.status = 'failed'; run.error = 'No sources could be retrieved. Check your connection or revise the question.'; run.completed_at = new Date().toISOString(); return; }
  const project = { id: run.id, question: run.question, depth: run.depth, sources, brief: writeBrief(run.question, sources), agents: run.agents, errors: run.agents.filter(agent => agent.status === 'failed').map(agent => `${agent.name}: ${agent.error}`), created_at: run.started_at };
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
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/') && rateLimited(req)) return send(res, 429, { error: 'Too many requests. Please retry in a minute.' });
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { status: 'ok', service: 'fieldnote', active_runs: [...runs.values()].filter(run => run.status === 'running' || run.status === 'queued').length });
    if (req.method === 'GET' && url.pathname === '/api/projects') return send(res, 200, await readProjects());
    if (req.method === 'POST' && url.pathname === '/api/runs') return send(res, 202, await createRun(await readJson(req)));
    if (req.method === 'GET' && /^\/api\/runs\/[0-9a-f-]+$/i.test(url.pathname)) { const run = runs.get(url.pathname.split('/').pop()); return run ? send(res, 200, publicRun(run)) : send(res, 404, { error: 'Research run not found.' }); }
    if (req.method === 'DELETE' && /^\/api\/projects\/[0-9a-f-]+$/i.test(url.pathname)) { const id = url.pathname.split('/').pop(); await writeProjects((await readProjects()).filter(project => project.id !== id)); return send(res, 204, ''); }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''); const target = path.resolve(root, file);
    if (!target.startsWith(root + path.sep) || target.includes(`${path.sep}data${path.sep}`) || target.includes(`${path.sep}documents${path.sep}`)) return send(res, 403, { error: 'Forbidden.' });
    return send(res, 200, await fs.readFile(target), types[path.extname(target)] || 'application/octet-stream');
  } catch (error) { send(res, error.code === 'ENOENT' ? 404 : 400, { error: error.message || 'Unexpected server error.' }); }
});
server.listen(config.port, () => console.log(`Fieldnote is running at http://localhost:${config.port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
