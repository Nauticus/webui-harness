# Weblisan

A local AI agent harness: a web app with chat + persistent sessions, backed by a
real server-side agent loop (LLM with tool calling: shell + file tools sandboxed
to a workspace directory).

## Stack

- **TypeScript** everywhere
- **Server**: Node.js + Fastify, SSE streaming, `better-sqlite3` (in-memory DB for sessions/messages)
- **Client**: React + Vite, styled with Tailwind CSS v4 (assistant messages rendered as markdown)
- **Agent**: any OpenAI-compatible chat API with tool calling (OpenAI, OpenRouter, Ollama, …)
- **Projects**: each project defines a working directory and preferred model (server defaults when left blank); sessions live under a project
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

## Projects

The top level of the UI is the **project**, shown as a tab in the header:

- Each project has a **name**, a **working dir** (`cwd`) — the directory the agent's
  shell/file tools are confined to — and a **preferred model**. Leaving either blank
  uses the server default (`AGENT_WORKSPACE_DIR` / `OPENAI_MODEL`).
- Creating your first project is the onboarding step; later projects are added with the
  `+` in the tab bar. Settings (rename, change dir/model, delete) are in the ⚙ dialog.
- Each project has its own **sessions**. The agent's working dir and model for a turn
  always come from the session's project, and the system prompt names the working dir.
- Deleting a project deletes all of its sessions (FK cascade).

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
   │  project tabs → sessions under the active project
   │  POST /api/sessions/:id/messages
   ▼
Fastify ──▶ Agent loop (server/src/agent.ts)  [cwd + model from the session's project]
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

Note: the SQLite database is in-memory, so projects and sessions are lost when the
server restarts. Swap `new Database(':memory:')` in `server/src/db.ts` for
`new Database('weblisan.db')` to persist on disk.

## API

- `GET /api/health`
- `GET /api/projects` — list projects
- `POST /api/projects` — create project `{ name?, cwd?, model? }` (blank cwd/model = server default)
- `PATCH /api/projects/:id` — update `{ name?, cwd?, model? }`
- `DELETE /api/projects/:id` — delete project and all its sessions
- `GET /api/sessions?projectId=<id>` — sessions of a project
- `POST /api/sessions` — create session `{ projectId, title? }`
- `DELETE /api/sessions/:id`
- `GET /api/sessions/:id` — session + full message history
- `GET /api/models` — model ids from the backend (static fallback list)
- `GET /api/dirs?path=/abs/path` — directory browser data `{ path, parent, dirs[] }`
- `POST /api/sessions/:id/messages` — `{ content }`, responds with an SSE stream (uses the project's cwd + model)

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
