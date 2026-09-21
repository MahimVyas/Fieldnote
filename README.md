# Fieldnote

Fieldnote is a local-first, multi-agent evidence research workbench. It runs with Node alone—no API key or package install is required.

## Run it

```bash
npm start
```

Then open `http://localhost:3000`.

## What works now

- A **planner** translates enabled sources into specialist work.
- **Web Scout**, **Paper Trail**, **Video Listener**, and the optional **Document Reader** run independently and in parallel. Web Scout searches Wikipedia and an optional SearXNG instance. Paper Trail queries Crossref, Semantic Scholar, and arXiv. The Video Listener fetches real YouTube results. The document reader only scans local `.md` and `.txt` files from `FIELDNOTE_DOCUMENTS_PATH`.
- An **evidence reviewer** deduplicates and ranks sources before a **brief writer** produces a traceable, caveated evidence brief with source excerpts, relevance signals, reliability labels, coverage metrics, evidence map, and research gaps. When a local Ollama server is available, the brief is synthesized by the LLM with every citation validated for reachability.
- Runs are asynchronous: `POST /api/runs` returns immediately and `GET /api/runs/:id` provides live agent progress.
- Research is saved locally in `data/research.json`; the Library can reopen or delete saved briefs.
- The service includes input limits, request rate limiting, atomic persistence, safe static-file boundaries, security response headers, a health endpoint, and graceful shutdown.

## Operations

Run checks with `npm test`. For a container deployment:

```bash
docker build -t fieldnote .
docker run --rm -p 3000:3000 -v fieldnote-data:/var/lib/fieldnote fieldnote
```

Copy `.env.example` for environment-specific paths. Set `FIELDNOTE_SEARX_URL` to enable SearXNG results and `FIELDNOTE_OLLAMA_URL` for LLM-backed synthesis. Put private `.md` or `.txt` material in the configured documents directory; the static server deliberately never exposes that directory.

### API contract

- `GET /api/health` — liveness and active-run count
- `POST /api/runs` — start a run (`question`, `sources`, `depth`); returns `202`
- `GET /api/runs/:id` — queued/running/completed agent state and final result
- `GET /api/projects` and `DELETE /api/projects/:id` — research archive

## Boundaries and next increments

The current brief is synthesized locally when Ollama is available and falls back to a rule-based template otherwise. For an internet-facing or multi-user deployment, put the service behind TLS/reverse proxy and real identity/authentication, replace the file store and in-memory run state with Postgres plus a durable queue, centralize logs/metrics/error reporting, and restrict outbound retrieval. Future connectors include yt-dlp for YouTube transcripts, self-hosted SearXNG for private search, and an LLM-backed citation-validation layer that checks every source URL is reachable before inclusion.
