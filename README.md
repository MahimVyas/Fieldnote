# Fieldnote

[![CI](https://github.com/fieldnote/fieldnote/actions/workflows/ci.yml/badge.svg)](https://github.com/fieldnote/fieldnote/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)

**Fieldnote is a local-first, multi-agent evidence research workbench.** Ask a
research question; a small team of specialist agents gathers evidence across
the web, scholarly literature, YouTube, and your private files — then returns
a traceable, caveated evidence brief. It runs with Node alone: no API key and
no `npm install` required.

## Contents

- [Features](#features)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Project structure](#project-structure)
- [Deployment](#deployment)
- [Development](#development)
- [Security notes](#security-notes)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Four specialist agents** — Web Scout (Wikipedia + optional SearXNG),
  Paper Trail (Crossref + Semantic Scholar + arXiv + OpenAlex, including
  open-access PDF links), Video Listener (live YouTube search), and Document
  Reader (local `.md`/`.txt` files) run independently and in parallel. **Thorough** depth adds full
  article extracts, a second query-expansion round, and higher result caps;
  **Quick** stays fast with single-round snippets.
- **Evidence reviewer** — deduplicates sources and ranks them by relevance,
  reliability, and citation count before anything is presented.
- **Traceable briefs** — every brief carries source excerpts, relevance
  signals, reliability labels, coverage metrics, an evidence map, and research
  gaps. Synthesis runs OpenRouter → local Ollama → extractive fallback, with
  citation reachability validation on the AI paths. AI briefs add key
  takeaways and self-test Q&A.
- **Take it with you** — export any brief as Markdown or JSON, copy it to the
  clipboard, or print it, straight from the results header.
- **Async runs with live progress** — `POST /api/runs` returns `202`
  immediately; poll `GET /api/runs/:id` for per-agent status.
- **Local-first library** — research is saved to `data/research.json` and
  mirrored into browser storage, so past briefs survive server restarts and
  stay openable, exportable, and deletable even when the server is down.
- **Production hygiene** — structured access logs with request IDs, rate
  limiting, atomic persistence, security headers (incl. CSP), health endpoint
  with version, graceful shutdown, non-root Docker image with `HEALTHCHECK`.
- **Polished UI** — dark mode with system-preference detection, responsive
  layout, keyboard-accessible controls, reduced-motion support, printable
  briefs, and a live service-status footer. The prompt lives in an always-on
  bottom chat bar; home shows your past research as pick-up-where-you-left-off
  conversations. While a run is in flight the page enters a quiet working
  mode: hero and agent cards collapse into a sticky status strip, and only
  progress plus results stay on screen. `⌘↵` starts a run.

## Quickstart

Requires Node.js 20 or later.

```bash
npm start
```

Open `http://localhost:3000`, type a question, choose your sources, and press
**Research**.

With Docker Compose (persists data in a named volume):

```bash
docker compose up --build
```

> **GitHub Pages preview:** the workflow in `.github/workflows/pages.yml`
> publishes the UI as a static preview. Research runs, the library, and
> exports need the Node server, so on Pages the app switches to a silent
> demo mode (no API calls, no console errors) instead.

Optional integrations via environment variables (see [Configuration](#configuration)):

```bash
FIELDNOTE_SEARX_URL=https://searx.be npm start          # open-web results
FIELDNOTE_OLLAMA_URL=http://localhost:11434 npm start  # LLM-written briefs
```

## How it works

```
Question → Planner → ┌─────────────┐
                     │ Web Scout    │──┐
                     │ Paper Trail  │──┤
                     │ Video List.  │──┼→ Evidence reviewer → Brief writer → Library
                     │ Doc Reader   │──┘
                     └─────────────┘
```

1. **Planner** (`plan()` in `agents.js`) translates the enabled sources into
   specialist tasks.
2. **Agents** execute concurrently. Web and paper agents query public APIs;
   the video agent parses live YouTube search results; the document agent
   scores local files by term overlap. On Thorough depth, the web agent
   upgrades snippets to full article introductions and the paper agent fires
   a second round with query terms expanded from round-one titles.
3. **Evidence reviewer** (`reviewEvidence()`) deduplicates by URL/title and
   sorts by relevance score, reliability tier
   (`scholarly > private > context/record > discovery`), then citations.
4. **Brief writer** (`writeBrief()`) asks local Ollama for a structured brief
   over reachability-checked citations; when Ollama is unavailable it falls
   back to extractive summarization — top-scoring sentences quoted verbatim
   from the retrieved excerpts, each traced to its source. The brief header
   always shows which synthesis produced it.
5. The run result is persisted atomically to `data/research.json` and served
   back to the UI, which renders the summary, evidence map, and coverage.
   Every research gap carries a **Dig deeper** button that starts a focused
   follow-up run over the same sources.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port to listen on. |
| `FIELDNOTE_DATA_PATH` | `data/research.json` | JSON file for the research archive. |
| `FIELDNOTE_DOCUMENTS_PATH` | `documents/` | Directory scanned for `.md`/`.txt` files. |
| `FIELDNOTE_SEARX_URL` | _(empty)_ | Base URL of a SearXNG instance for open-web results. |
| `FIELDNOTE_OLLAMA_URL` | `http://localhost:11434` | Ollama server for LLM brief synthesis. Unreachable → template fallback. |
| `FIELDNOTE_OPENROUTER_API_KEY` | _(empty)_ | OpenRouter key for cloud AI synthesis (takes priority). Keep in local `.env`, never committed. |
| `FIELDNOTE_OPENROUTER_MODEL` | `openai/gpt-4o-mini` | Model used for OpenRouter synthesis and study aids. Free `:free` models work but carry a 50 req/day limit. |
| `NODE_ENV` | _(empty)_ | Set to `production` in the container. |

Copy `.env.example` to `.env` for local customization. Private documents stay
on disk: the static file server refuses to serve `data/` and `documents/`.

## API reference

| Method & path | Description | Success |
|---|---|---|
| `GET /api/health` | Liveness, version, uptime, active-run count | `200` |
| `POST /api/runs` | Start a run: `{ question, sources, depth }` | `202` |
| `GET /api/runs/:id` | Run status, per-agent progress, final result | `200` |
| `GET /api/projects` | Saved research archive | `200` |
| `GET /api/projects/:id/export?format=md` | Download brief as Markdown (`format=json` for JSON) | `200` |
| `DELETE /api/projects/:id` | Delete a saved brief | `204` |

Errors are JSON: `{ "error": "message" }`. `POST /api/runs` validates input
(question length 4–1000 chars, at least one of `Web`, `Papers`, `YouTube`,
`Documents`) and is rate-limited to 20 requests/minute per IP.

Example:

```bash
curl -X POST http://localhost:3000/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"question":"How does spaced repetition affect retention?","sources":["Web","Papers"],"depth":"Thorough"}'
```

## Project structure

```
├── server.js          # HTTP server, routing, rate limiting, persistence
├── agents.js          # planner, agents, reviewer, brief writer, validators
├── index.html         # UI markup
├── style.css          # theme (light/dark), layout, print styles
├── script.js          # UI logic, polling, library management
├── favicon.svg        # app icon
├── test/              # node:test suites (offline, deterministic)
├── documents/         # local research material (.md/.txt, gitignored content)
├── data/              # runtime archive (gitignored)
├── Dockerfile         # non-root production image with HEALTHCHECK
└── docker-compose.yml # one-command deployment with persistent volume
```

## Deployment

```bash
docker build -t fieldnote .
docker run --rm -p 3000:3000 -v fieldnote-data:/var/lib/fieldnote fieldnote
```

For an internet-facing or multi-user deployment, put the service behind a
TLS-terminating reverse proxy with authentication, replace the file store and
in-memory run state with Postgres plus a durable queue, and centralize
logs/metrics/error reporting.

## Development

```bash
npm run dev    # watch mode
npm test       # unit tests (no network or Ollama required)
npm run check  # syntax check all JS entry points
```

CI (`.github/workflows/ci.yml`) runs checks and tests on Node 20/22/24 and
builds the Docker image on every push and pull request.

## Security notes

- Security response headers on every response, including a
  Content-Security-Policy scoped to self, inline UI code, and Google Fonts.
- Request bodies capped at 32 KB; questions capped at 1000 chars.
- Atomic writes (`tmp` + rename, mode `0600`) for the research archive.
- Path-traversal guards on the static file server; `data/` and `documents/`
  are never served.
- Outbound fetches carry 5–9 s timeouts so a slow upstream cannot stall a run.

## Contributing

Issues and pull requests are welcome. Please run `npm run check` and
`npm test` before submitting, and keep new agent connectors offline-testable.

## License

MIT — see [LICENSE](LICENSE).
