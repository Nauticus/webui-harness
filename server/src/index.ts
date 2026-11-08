import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as db from './db';
import * as history from './history';
import { runAgentTurn, contextUsage, type StoredToolCall, DEFAULT_MODEL } from './agent';
import {
  compactionThreshold,
  compactMessages,
  estimateTokens,
  estimateContextTokens,
  findCutPoint,
  KEEP_RECENT_TOKENS,
  latestCompactionSeq,
  summaryAsMessage,
  toLlmMessages,
  type CompactableMessage,
  type CompactResult,
  type UsageInfo,
} from './compaction';
import { detectModels, groupModels } from './providers';
import { isReasoningEffort, type ReasoningEffort } from './reasoning';
import { listSkills, expandSkillInvocation } from './skills';
import { DEFAULT_WORKSPACE } from './tools';

const PORT = Number(process.env.PORT ?? 3001);

fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true });

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

function validateCwd(cwd: unknown): string | undefined {
  if (cwd === undefined) return undefined;
  if (typeof cwd !== 'string') {
    throw Object.assign(new Error('cwd must be an absolute path or empty for the default'), {
      statusCode: 400,
    });
  }
  const trimmed = cwd.trim();
  if (trimmed === '') return ''; // server default
  if (!path.isAbsolute(trimmed)) {
    throw Object.assign(new Error('cwd must be an absolute path'), { statusCode: 400 });
  }
  const resolved = path.resolve(trimmed);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw Object.assign(new Error(`cwd does not exist: ${resolved}`), { statusCode: 400 });
  }
  if (!stat.isDirectory()) {
    throw Object.assign(new Error(`cwd is not a directory: ${resolved}`), { statusCode: 400 });
  }
  return resolved;
}

function validateModel(model: unknown): string | undefined {
  if (model === undefined) return undefined;
  if (typeof model !== 'string') {
    throw Object.assign(new Error('model must be a string (empty for the default)'), {
      statusCode: 400,
    });
  }
  const trimmed = model.trim();
  if (trimmed === '') return ''; // server default
  if (trimmed.length > 120) {
    throw Object.assign(new Error('model must be at most 120 chars'), { statusCode: 400 });
  }
  return trimmed;
}

/** Accepts a reasoning effort body field; undefined = not sent, bad value -> 400. */
function validateEffort(effort: unknown): ReasoningEffort | undefined {
  if (effort === undefined) return undefined;
  if (!isReasoningEffort(effort)) {
    throw Object.assign(
      new Error(`reasoningEffort must be one of: auto (''), low, medium, high, xhigh`),
      { statusCode: 400 }
    );
  }
  return effort;
}

function validateProviderId(providerId: unknown): string | undefined {
  if (providerId === undefined) return undefined;
  if (typeof providerId !== 'string') {
    throw Object.assign(new Error('providerId must be a string (empty for the default)'), {
      statusCode: 400,
    });
  }
  const trimmed = providerId.trim();
  if (trimmed === '') return '';
  if (!db.getProvider(trimmed)) {
    throw Object.assign(new Error('unknown provider'), { statusCode: 400 });
  }
  return trimmed;
}

/** Public shape of a provider row: models parsed (normalized), is_default boolean, key masked. */
function publicProvider(row: db.ProviderRow): Record<string, unknown> {
  const models = db.parseProviderModels(row.models);
  return {
    ...row,
    is_default: Boolean(row.is_default),
    models, // detected models with per-model context windows
    model_groups: groupModels(models), // aliases/snapshots collapsed into base models
    api_key: row.api_key ? '•••' : '',
  };
}


app.get('/api/health', async () => ({ ok: true, defaultWorkspace: DEFAULT_WORKSPACE }));

/* ---------- providers ---------- */

const KEY_MASK = '•••';

app.get('/api/providers', async () => db.listProviders().map(publicProvider));

app.post('/api/providers', async (req, reply) => {
  const body = (req.body ?? {}) as {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    isDefault?: boolean;
    defaultModel?: string;
    defaultReasoningEffort?: string;
  };
  try {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return reply.code(400).send({ error: 'provider name is required' });
    }
    if (body.defaultReasoningEffort !== undefined && !isReasoningEffort(body.defaultReasoningEffort)) {
      return reply.code(400).send({ error: 'defaultReasoningEffort must be one of "", low, medium, high, xhigh' });
    }
    const row = db.createProvider({
      name: body.name,
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '',
      apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : '',
      isDefault: body.isDefault === true,
      defaultModel: typeof body.defaultModel === 'string' ? body.defaultModel.trim() : '',
      defaultReasoningEffort: body.defaultReasoningEffort ?? '',
    });
    const detected = await detectModels({ baseUrl: row.base_url, apiKey: row.api_key });
    db.setProviderModels(row.id, detected);
    const provider = db.listProviders().find((p) => p.id === row.id);
    reply.code(201).send(publicProvider(provider!));
  } catch (err) {
    reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
      error: String((err as Error).message),
    });
  }
});

app.patch('/api/providers/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    isDefault?: boolean;
    modelContextWindows?: Record<string, number | null>;
    defaultModel?: string;
    defaultReasoningEffort?: string;
  };
  const current = db.getProvider(id);
  if (!current) return reply.code(404).send({ error: 'provider not found' });
  if (body.modelContextWindows !== undefined) {
    if (typeof body.modelContextWindows !== 'object' || body.modelContextWindows === null || Array.isArray(body.modelContextWindows)) {
      return reply.code(400).send({ error: 'modelContextWindows must be an object' });
    }
    for (const [mid, w] of Object.entries(body.modelContextWindows)) {
      if (w !== null && (typeof w !== 'number' || !Number.isFinite(w) || w <= 0)) {
        return reply.code(400).send({ error: `modelContextWindows["${mid}"] must be a positive number or null` });
      }
    }
  }
  if (body.defaultModel !== undefined && typeof body.defaultModel !== 'string') {
    return reply.code(400).send({ error: 'defaultModel must be a string (empty for the default)' });
  }
  if (body.defaultReasoningEffort !== undefined && !isReasoningEffort(body.defaultReasoningEffort)) {
    return reply.code(400).send({ error: 'defaultReasoningEffort must be one of "", low, medium, high, xhigh' });
  }
  try {
    const changedUrl = typeof body.baseUrl === 'string' && body.baseUrl.trim() !== current.base_url;
    const changedKey =
      typeof body.apiKey === 'string' && body.apiKey !== KEY_MASK && body.apiKey.trim() !== current.api_key;
    const row = db.updateProvider(id, {
      name: body.name,
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : undefined,
      apiKey:
        typeof body.apiKey === 'string' && body.apiKey !== KEY_MASK ? body.apiKey.trim() : undefined,
      isDefault: typeof body.isDefault === 'boolean' ? body.isDefault : undefined,
      defaultModel:
        typeof body.defaultModel === 'string' ? body.defaultModel.trim() : undefined,
      defaultReasoningEffort: body.defaultReasoningEffort,
    });
    if (changedUrl || changedKey) {
      const updated = db.getProvider(id)!;
      const detected = await detectModels({ baseUrl: updated.base_url, apiKey: updated.api_key });
      db.setProviderModels(id, detected);
    }
    if (body.modelContextWindows !== undefined) {
      db.setModelContextWindows(id, body.modelContextWindows);
    }
    const provider = db.listProviders().find((p) => p.id === id);
    reply.send(publicProvider(provider!));
  } catch (err) {
    reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
      error: String((err as Error).message),
    });
  }
});

app.post('/api/providers/:id/detect', async (req, reply) => {
  const { id } = req.params as { id: string };
  const row = db.getProvider(id);
  if (!row) return reply.code(404).send({ error: 'provider not found' });
  const detected = await detectModels({ baseUrl: row.base_url, apiKey: row.api_key });
  db.setProviderModels(id, detected);
  const provider = db.listProviders().find((p) => p.id === id);
  reply.send(publicProvider(provider!));
});

app.delete('/api/providers/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const row = db.getProvider(id);
  if (!row) return reply.code(404).send({ error: 'provider not found' });
  const usage = db.listProviders().find((p) => p.id === id)?.used_by ?? 0;
  if (usage > 0) {
    return reply.code(409).send({ error: `provider is used by ${usage} project(s)` });
  }
  db.deleteProvider(id);
  reply.code(204).send();
});

/* ---------- projects ---------- */

app.get('/api/projects', async () => db.listProjects());

app.post('/api/projects', async (req, reply) => {
  const body = (req.body ?? {}) as {
    name?: string;
    cwd?: string;
    providerId?: string;
    model?: string;
  };
  try {
    const project = db.createProject({
      name: body.name?.trim() || undefined,
      cwd: validateCwd(body.cwd),
      providerId: validateProviderId(body.providerId),
      model: validateModel(body.model),
    });
    reply.code(201).send(project);
  } catch (err) {
    reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
      error: String((err as Error).message),
    });
  }
});

app.patch('/api/projects/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!db.getProject(id)) return reply.code(404).send({ error: 'project not found' });
  const body = (req.body ?? {}) as {
    name?: string;
    cwd?: string;
    providerId?: string;
    model?: string;
  };
  try {
    const project = db.updateProject(id, {
      name: body.name?.trim() || undefined,
      cwd: validateCwd(body.cwd),
      providerId: validateProviderId(body.providerId),
      model: validateModel(body.model),
    });
    reply.send(project);
  } catch (err) {
    reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
      error: String((err as Error).message),
    });
  }
});

app.delete('/api/projects/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!db.getProject(id)) return reply.code(404).send({ error: 'project not found' });
  await history.deleteProjectHistory(id);
  db.deleteProject(id);
  reply.code(204).send();
});

/* ---------- sessions (scoped to a project) ---------- */

app.get('/api/sessions', async (req, reply) => {
  const raw = typeof req.query === 'string' ? undefined : (req.query as { projectId?: string }).projectId;
  if (!raw) return reply.code(400).send({ error: 'projectId is required' });
  if (!db.getProject(raw)) return reply.code(404).send({ error: 'project not found' });
  reply.send(db.listSessions(raw));
});

app.post('/api/sessions', async (req, reply) => {
  const body = (req.body ?? {}) as { projectId?: string; title?: string; model?: string; reasoningEffort?: string };
  if (!body.projectId) return reply.code(400).send({ error: 'projectId is required' });
  try {
    const session = db.createSession(body.projectId, {
      title: body.title,
      model: validateModel(body.model),
      reasoningEffort: validateEffort(body.reasoningEffort) ?? '',
    });
    reply.code(201).send(session);
  } catch (err) {
    reply.code((err as { statusCode?: number }).statusCode ?? 404).send({
      error: String((err as Error).message),
    });
  }
});

app.patch('/api/sessions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!db.getSession(id)) return reply.code(404).send({ error: 'session not found' });
  const body = (req.body ?? {}) as { model?: string; reasoningEffort?: string };
  const model = validateModel(body.model);
  if (model !== undefined) db.setSessionModel(id, model);
  const effort = validateEffort(body.reasoningEffort);
  if (effort !== undefined) db.setSessionReasoningEffort(id, effort);
  reply.send(db.getSession(id));
});

app.delete('/api/sessions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const session = db.getSession(id);
  if (!session) return reply.code(404).send({ error: 'session not found' });
  await history.deleteSessionHistory(id, session.project_id);
  db.deleteSession(id);
  reply.code(204).send();
});

/** List subdirectories of a path (for the cwd browser). */
app.get('/api/dirs', async (req, reply) => {
  const raw = typeof req.query === 'string' ? undefined : (req.query as { path?: string }).path;
  const requested = raw && raw.trim() ? raw.trim() : os.homedir();
  if (!path.isAbsolute(requested)) {
    return reply.code(400).send({ error: 'path must be absolute' });
  }
  const resolved = path.resolve(requested);
  try {
    const entries = await fsp.readdir(resolved, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    reply.send({ path: resolved, parent: path.dirname(resolved), dirs });
  } catch {
    reply.code(400).send({ error: `cannot read directory: ${resolved}` });
  }
});

app.get('/api/skills', async (req, reply) => {
  const { projectId } = req.query as { projectId?: string };
  // Skills are global + per-project; with a project, include its own dir too.
  const workspace = projectId ? db.getProject(projectId)?.cwd || DEFAULT_WORKSPACE : DEFAULT_WORKSPACE;
  reply.send({ skills: listSkills(workspace) });
});

app.get('/api/sessions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const session = db.getSession(id);
  if (!session) return reply.code(404).send({ error: 'session not found' });
  const messages = await history.readHistory(id, session.project_id);
  // Last-known context usage, recomputed from the stored history so the
  // progress bar shows on load — not only during a live turn. Resolved
  // exactly like a turn would (session -> project -> provider -> env).
  let context: { tokens: number; window: number; threshold: number } | null = null;
  if (messages.length > 0) {
    const project = db.getProject(session.project_id);
    const settings = project ? resolveTurnSettings(session, project) : null;
    if (settings && project) {
      context = contextUsage(
        toLlmMessages(messages),
        project.cwd || DEFAULT_WORKSPACE,
        settings.contextWindow,
        listSkills(project.cwd || DEFAULT_WORKSPACE),
        latestCompactionSeq(messages)
      );
    }
  }
  // Same shape as the legacy DB rows so the client contract is unchanged.
  reply.send({
    session,
    context,
    messages: messages.map((m) => ({
      id: m.seq,
      session_id: id,
      seq: m.seq,
      role: m.role,
      content: m.content,
      meta: m.meta ? JSON.stringify(m.meta) : null,
    })),
  });
});

/**
 * Run one agent turn and stream progress as Server-Sent Events:
 *   thinking.delta -> reasoning tokens from thinking-capable models (streamed)
 *   message.delta  -> text chunks of the assistant reply
 *   tool.round     -> assistant text + tool calls for this LLM step (+ reasoning)
 *   tool.start     -> a tool invocation begins (name + args)
 *   tool.result    -> tool finished (truncated output, ok: false on failure)
 *   message.complete / error -> terminal events (complete carries reasoning)
 *   done           -> final event, stream closes
 */

/**
 * Active turns by session id. Stop has two paths: closing the stream
 * (works with a direct connection) and this explicit map (works when a
 * dev proxy between client and server swallows the client disconnect).
 */
/**
 * Provider, model and effort for a session. Resolved in one place so a normal
 * turn, a manual compaction and the context readout cannot disagree about which
 * model would be talking: session -> project -> provider's chosen default ->
 * first detected model -> env fallback; effort: session ('' = auto) -> provider
 * default. `null` when no provider is configured at all.
 */
function resolveTurnSettings(session: db.SessionRow, project: db.ProjectRow) {
  const providers = db.listProviders();
  const provider =
    (project.provider_id ? providers.find((p) => p.id === project.provider_id) : undefined) ??
    providers.find((p) => p.is_default === 1);
  if (!provider) return null;
  const providerModels = db.parseProviderModels(provider.models);
  const model =
    session.model ||
    project.model ||
    provider.default_model ||
    providerModels[0]?.id ||
    process.env.OPENAI_MODEL ||
    'gpt-4o-mini';
  return {
    provider,
    providerCreds: { baseUrl: provider.base_url, apiKey: provider.api_key },
    model,
    effort: session.reasoning_effort || provider.default_reasoning_effort,
    // From provider config; unknown -> compaction's env/default.
    contextWindow: providerModels.find((m) => m.id === model)?.contextWindow,
  };
}

const activeTurns = new Map<string, AbortController>();

/** Explicit stop for the session's active turn (independent of connection state). */
app.post('/api/sessions/:id/stop', async (req, reply) => {
  const { id } = req.params as { id: string };
  const stop = activeTurns.get(id);
  if (!stop) return reply.send({ stopped: false });
  stop.abort();
  return reply.send({ stopped: true });
});

/**
 * Compact a session's context now instead of waiting for the next turn to trip
 * the threshold. Streams exactly the events a pre-turn compaction streams, so
 * the transcript shows the same card with the same progress, then the updated
 * context readout. Nothing else happens: no model turn, no new message.
 *
 * The summarizer is a real model call, so it is interruptible through the same
 * /stop endpoint as a turn.
 */
app.post('/api/sessions/:id/compact', async (req, reply) => {
  const { id } = req.params as { id: string };
  const session = db.getSession(id);
  if (!session) return reply.code(404).send({ error: 'session not found' });
  const project = db.getProject(session.project_id);
  if (!project) return reply.code(404).send({ error: 'project not found' });
  // A turn owns the context while it runs — compacting underneath one would
  // rewrite the history it is reading.
  if (activeTurns.has(id)) {
    return reply.code(409).send({ error: 'a turn is running in this session' });
  }
  const settings = resolveTurnSettings(session, project);
  if (!settings) {
    return reply
      .code(400)
      .send({ error: 'no providers configured — add one with POST /api/providers' });
  }
  const { providerCreds, model, effort, contextWindow } = settings;
  const workspace = project.cwd || DEFAULT_WORKSPACE;
  const skills = listSkills(workspace);

  const historyRows = await history.readHistory(id, session.project_id);
  const messages = toLlmMessages(historyRows);
  const staleBefore = latestCompactionSeq(historyRows);
  // Say so before opening the stream rather than after a summarizer call: with
  // nothing older than the ~KEEP_RECENT_TOKENS window there is no half to
  // summarize, and compactMessages would throw for exactly that reason.
  if (findCutPoint(messages).cut <= 0) {
    return reply.code(400).send({
      error: `nothing to compact yet — compaction keeps the most recent ~${Math.round(
        KEEP_RECENT_TOKENS / 1000
      )}k tokens verbatim`,
    });
  }
  const tokensBefore = estimateContextTokens(messages, staleBefore);

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.hijack();
  const stop = new AbortController();
  reply.raw.on('close', () => stop.abort());
  activeTurns.set(id, stop);
  const send = (data: unknown) => {
    if (reply.raw.destroyed) return;
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    send({ type: 'compaction.start', tokensBefore });
    const it = compactMessages({
      messages,
      provider: providerCreds,
      model,
      reasoningEffort: effort,
      signal: stop.signal,
    });
    let last = 0;
    let step = await it.next();
    while (!step.done) {
      const now = Date.now();
      if (now - last >= 250) {
        send({ type: 'compaction.progress', tokensOut: Math.ceil(step.value.length / 4) });
        last = now;
      }
      step = await it.next();
    }
    const c = step.value;
    const kept = [
      { ...summaryAsMessage(c.summary), fileLists: c.fileLists },
      ...messages.slice(c.firstKeptIndex),
    ];
    const tokensAfter = estimateContextTokens(kept, Number.MAX_SAFE_INTEGER);
    await history.appendRecord(id, session.project_id, {
      role: 'compaction',
      content: c.summary,
      meta: {
        firstKeptSeq: c.firstKeptSeq,
        tokensBefore: c.tokensBefore,
        tokensAfter,
        fileLists: c.fileLists,
      },
    });
    send({
      type: 'compaction',
      summary: c.summary,
      firstKeptSeq: c.firstKeptSeq,
      tokensBefore: c.tokensBefore,
      tokensAfter,
      fileLists: c.fileLists,
    });
    send({ type: 'context', ...contextUsage(kept, workspace, contextWindow, skills, Number.MAX_SAFE_INTEGER) });
  } catch (err) {
    send({ type: 'error', message: String(err instanceof Error ? err.message : err) });
  } finally {
    activeTurns.delete(id);
    reply.raw.end();
  }
});
app.post('/api/sessions/:id/messages', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { content?: string };
  if (!body.content?.trim()) return reply.code(400).send({ error: 'content is required' });

  const session = db.getSession(id);
  if (!session) return reply.code(404).send({ error: 'session not found' });
  const project = db.getProject(session.project_id);
  if (!project) return reply.code(404).send({ error: 'project not found' });
  const workspace = project.cwd || DEFAULT_WORKSPACE;

  // Skills visible to this workspace (global + project), used for the
  // system prompt, the sandbox read-roots, and /skill:name invocations.
  const skills = listSkills(workspace);
  const content = body.content.trim();
  // Explicit invocation (/skill:name [task]): reject unknown skills up front
  // so the client gets a plain error; the raw text expands to instructions
  // below once the history row is read back.
  const invocation = expandSkillInvocation(content, skills);
  if (invocation.kind === 'not-found') {
    const available = skills.map((s) => s.name).join(', ');
    return reply.code(400).send({
      error: `unknown skill "${invocation.name}"${available ? ` — available: ${available}` : ' (no skills installed)'}`,
    });
  }
  // A skill invocation titles the session by its task, not the command line.
  const titleSource =
    invocation.kind === 'expanded' && invocation.skill && invocation.skill.name
      ? content.replace(/^\/skill:[a-z0-9-]+[ \t]*/, '').slice(0, 48)
      : content.slice(0, 48);

  const settings = resolveTurnSettings(session, project);
  if (!settings) {
    return reply
      .code(400)
      .send({ error: 'no providers configured — add one with POST /api/providers' });
  }
  const { providerCreds, model, effort, contextWindow } = settings;

  await history.appendRecord(id, session.project_id, { role: 'user', content: body.content.trim() });
  if (session.title === 'New session') {
    db.setSessionTitle(id, titleSource);
  }

  // Take over the raw response for SSE (Fastify's reply.send would buffer it).
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.hijack();
  // The user can stop the turn at any time by closing the stream (stop
  // button / navigating away): that aborts the agent loop server-side too.
  const stop = new AbortController();
  reply.raw.on('close', () => stop.abort());
  activeTurns.set(id, stop);
  const send = (data: unknown) => {
    if (reply.raw.destroyed) return; // client already gone (stopped)
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let finalContent = '';
  let finalReasoning = '';
  let finalUsage: UsageInfo | undefined;
  const toolArgs = new Map<string, { name: string; args: unknown }>();
  try {
    const historyRows = await history.readHistory(id, session.project_id);
    let messages = toLlmMessages(historyRows);
    // Pi's staleness guard: usage anchors persisted at or before the latest
    // compaction record reflect the pre-compaction context. After a
    // successful pre-turn compaction the new record's seq is the boundary.
    let staleBefore = latestCompactionSeq(historyRows);
    // Materialize an explicit /skill:name invocation: history keeps the
    // compact command text (nice on reload); the model gets instructions.
    if (invocation.kind === 'expanded') {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === 'user') {
          m.content = invocation.text;
          break;
        }
      }
    }
    // Pre-turn compaction: the context may have grown past the threshold in
    // an earlier turn. Non-fatal — on failure the full context is sent.
    if (estimateContextTokens(messages, staleBefore) > compactionThreshold(contextWindow)) {
      let c: CompactResult | undefined;
      try {
        send({ type: 'compaction.start', tokensBefore: estimateContextTokens(messages) });
        const it = compactMessages({
          messages,
          provider: providerCreds,
          model: model || DEFAULT_MODEL(),
          reasoningEffort: effort,
          signal: stop.signal,
        });
        let last = 0;
        let step = await it.next();
        while (!step.done) {
          const now = Date.now();
          if (now - last >= 250) {
            send({ type: 'compaction.progress', tokensOut: Math.ceil(step.value.length / 4) });
            last = now;
          }
          step = await it.next();
        }
        c = step.value;
      } catch (err) {
        app.log.warn(`pre-turn compaction failed: ${String(err)}`);
      }
      if (c) {
        messages = [{ ...summaryAsMessage(c.summary), fileLists: c.fileLists }, ...messages.slice(c.firstKeptIndex)];
        // Every seq'd message in the rebuilt array predates the compaction
        // record, so the boundary is past all of them (pi's pattern).
        const tokensAfter = estimateContextTokens(messages, Number.MAX_SAFE_INTEGER);
        staleBefore = await history.appendRecord(id, session.project_id, {
          role: 'compaction',
          content: c.summary,
          meta: {
            firstKeptSeq: c.firstKeptSeq,
            tokensBefore: c.tokensBefore,
            tokensAfter,
            fileLists: c.fileLists,
          },
        });
        send({
          type: 'compaction',
          summary: c.summary,
          firstKeptSeq: c.firstKeptSeq,
          tokensBefore: c.tokensBefore,
          tokensAfter,
          fileLists: c.fileLists,
        });
      }
    }
    for await (const ev of runAgentTurn({ messages, workspace, model, provider: providerCreds, contextWindow, reasoningEffort: effort, skills, signal: stop.signal, staleUsageBeforeSeq: staleBefore })) {
      send(ev);
      switch (ev.type) {
        case 'message.complete':
          finalContent = ev.content;
          if (ev.reasoning) finalReasoning = ev.reasoning;
          finalUsage = ev.usage;
          break;
        case 'message.stopped':
          // Partial text from a stopped turn: persist it so the session
          // keeps it across reloads (flagged for the UI).
          if (ev.content) {
            await history.appendRecord(id, session.project_id, {
              role: 'assistant',
              content: ev.content,
              meta: { stopped: true, ...(ev.reasoning ? { reasoning: ev.reasoning } : {}) },
            });
          }
          break;
        case 'tool.round':
          await history.appendRecord(id, session.project_id, {
            role: 'assistant',
            content: ev.content,
            meta: { tool_calls: ev.toolCalls, ...(ev.reasoning ? { reasoning: ev.reasoning } : {}), ...(ev.usage ? { usage: ev.usage } : {}) },
          });
          break;
        case 'tool.start':
          toolArgs.set(ev.id, { name: ev.name, args: ev.args });
          break;
        case 'tool.result': {
          const start = toolArgs.get(ev.id);
          await history.appendRecord(id, session.project_id, {
            role: 'tool',
            content: ev.result,
            meta: {
              tool_call_id: ev.id,
              name: ev.name,
              args: start?.args,
              ...(ev.ok === false ? { ok: false } : {}),
              ...(ev.diff ? { diff: ev.diff } : {}),
            },
          });
          break;
        }
        case 'compaction':
          await history.appendRecord(id, session.project_id, {
            role: 'compaction',
            content: ev.summary,
            meta: {
              firstKeptSeq: ev.firstKeptSeq,
              tokensBefore: ev.tokensBefore,
              tokensAfter: ev.tokensAfter,
              fileLists: ev.fileLists,
            },
          });
          break;
        default:
          break;
      }
    }
    if (finalContent) {
      await history.appendRecord(id, session.project_id, {
        role: 'assistant',
        content: finalContent,
        ...(finalReasoning || finalUsage
          ? {
              meta: {
                ...(finalReasoning ? { reasoning: finalReasoning } : {}),
                ...(finalUsage ? { usage: finalUsage } : {}),
              },
            }
          : {}),
      });
    }
    send({ type: 'done' });
  } catch (err) {
    app.log.error(err);
    send({ type: 'error', message: String(err instanceof Error ? err.message : err) });
  } finally {
    activeTurns.delete(id);
    reply.raw.end();
  }
});

// In production, serve the built React client if present.
const clientDist = path.resolve(process.cwd(), '..', 'client', 'dist');
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  const { default: fastifyStatic } = await import('@fastify/static');
  await app.register(fastifyStatic, { root: clientDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    reply.code(404).send({ error: 'not found' });
  });
}

// Ensure the history encryption key exists (auto-generated on first run) and
// fail fast when WEBLISAN_KEY is malformed.
history.resolveKey();

// One-time migration: legacy in-DB message history -> encrypted per-session files.
{
  const legacy = db.legacyHistoryRows();
  if (legacy.length > 0) {
    const bySession = new Map<string, { projectId: string; rows: db.LegacyMessageRow[] }>();
    for (const row of legacy) {
      const entry = bySession.get(row.session_id) ?? { projectId: row.project_id, rows: [] };
      entry.rows.push(row);
      bySession.set(row.session_id, entry);
    }
    for (const [sessionId, { projectId, rows }] of bySession) {
      await history.writeHistory(
        sessionId,
        projectId,
        rows.map((r) => ({
          role: r.role as 'user' | 'assistant' | 'tool',
          content: r.content,
          meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : undefined,
        }))
      );
    }
    db.dropLegacyMessages();
    app.log.info(`migrated ${legacy.length} legacy messages to encrypted history files`);
  }
}

await app.listen({ port: PORT, host: '127.0.0.1' });

// First run: import the .env OpenAI settings as the built-in default provider.
if (db.listProviders().length === 0 && process.env.OPENAI_API_KEY) {
  const name = 'default';
  const baseUrl = process.env.OPENAI_BASE_URL ?? '';
  const row = db.createProvider({ name, baseUrl, apiKey: process.env.OPENAI_API_KEY, isDefault: true });
  app.log.info(`imported env provider "${name}" (${baseUrl || 'openai.com'})`);
  void detectModels({ baseUrl, apiKey: row.api_key }).then((r) => {
    db.setProviderModels(row.id, r);
    if (r.models.length > 0) app.log.info(`detected ${r.models.length} models for "${name}"`);
    else app.log.warn(`model detection for "${name}" failed: ${r.error}`);
  });
}

// Exported so tests can start the server in-process (e.g. with msw mocking
// the provider) and close it again for a clean process exit.
export { app };
