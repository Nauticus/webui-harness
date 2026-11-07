# Weblisan

A local AI agent harness: a web app with chat + persistent sessions, backed by a
real server-side agent loop (LLM with tool calling: shell + file tools sandboxed
to a workspace directory).

## Stack

- **TypeScript** everywhere
- **Server**: Node.js + Fastify, SSE streaming, `better-sqlite3` (in-memory DB for sessions/messages)
- **Client**: React + Vite
- **Agent**: any OpenAI-compatible chat API with tool calling (OpenAI, OpenRouter, Ollama, …)
- **Per-session configuration**: each session has its own working directory (agent sandbox root) and model
- No auth — intended for local use only

## Quick start

```bash
cp .env.example .env   # set OPENAI_API_KEY (and optionally BASE_URL / MODEL)
npm install
npm run dev
```

- Web UI: http://localhost:5173 (Vite dev server, proxies `/api` to the server)
- API: http://localhost:3001

### Production-style run

```bash
npm run build   # builds client/dist
npm start       # Fastify serves the API + the built client on :3001
```

## Per-session configuration

Each session stores its own settings, editable via the ⚙ button in the chat header
(or via the API when creating/patching a session):

- **Working dir (`cwd`)** — the directory the agent's shell/file tools are confined to.
  Empty = server default (`AGENT_WORKSPACE_DIR`). Absolute, must exist; the UI has a
  directory browser backed by `GET /api/dirs`.
- **Model (`model`)** — the model id sent to the LLM for every turn of the session.
  Empty = server default (`OPENAI_MODEL`). The UI's dropdown is populated from the
  backend's `/models` endpoint (`GET /api/models`) with free-typed input as fallback.

The system prompt tells the agent its working directory, and tool paths are resolved
and confined to it.

## Configuration (env)

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | – | API key for the chat backend |
| `OPENAI_BASE_URL` | OpenAI | Any OpenAI-compatible endpoint (e.g. `http://localhost:11434/v1` for Ollama) |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model id passed to the backend |
| `AGENT_WORKSPACE_DIR` | `./workspace` (relative to server cwd) | Sandbox dir for the agent's shell/file tools |
| `PORT` | `3001` | API port |

## How it works

```
Browser (React)
   │  POST /api/sessions/:id/messages
   ▼
Fastify ──▶ Agent loop (server/src/agent.ts)
   │            │  stream: LLM → tool calls → run tools → LLM → … (max 12 steps)
   │            ▼
   │        Tools (server/src/tools.ts): bash, read_file, write_file, list_dir
   │            (all confined to AGENT_WORKSPACE_DIR)
   │
   └── SSE stream back to the browser:
        message.delta / tool.round / tool.start / tool.result /
        message.complete / error / done

SQLite (in-memory): sessions + every message incl. tool calls & results,
so switching sessions reloads full history and the LLM sees full context.
```

Note: the SQLite database is in-memory, so sessions are lost when the server
restarts. Swap `new Database(':memory:')` in `server/src/db.ts` for
`new Database('weblisan.db')` to persist on disk.

## API

- `GET /api/health`
- `GET /api/sessions` — list sessions
- `POST /api/sessions` — create session `{ title?, cwd?, model? }`
- `PATCH /api/sessions/:id` — update session `{ title?, cwd?, model? }`
- `DELETE /api/sessions/:id`
- `GET /api/sessions/:id` — session (incl. `cwd`/`model`) + full message history
- `GET /api/models` — model ids from the backend (static fallback list)
- `GET /api/dirs?path=/abs/path` — directory browser data `{ path, parent, dirs[] }`
- `POST /api/sessions/:id/messages` — `{ content }`, responds with an SSE stream

## Project layout

```
server/
  src/index.ts   Fastify app, routes, SSE, static serving
  src/agent.ts   Agent loop (tool-calling, streaming, step budget)
  src/tools.ts   Sandboxed tools (bash, read_file, write_file, list_dir)
  src/db.ts      SQLite (in-memory) schema + CRUD
  workspace/     Agent sandbox (created at startup, gitignored)
client/
  src/App.tsx    Chat UI: session sidebar, streaming messages, tool cards
  src/api.ts     API client + SSE reader
  src/styles.css
```

## Ideas for next steps

- Abort button for in-flight turns (pass an `AbortController` through `fetch` + `runAgentTurn`)
- Edit tool (in-place replacement) + grep/glob tools
- Token/step budget display, per-session model override
- Disk-persistent SQLite, session export
- Auth (e.g. a shared password) if you ever expose it beyond localhost
