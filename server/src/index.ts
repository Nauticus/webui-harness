import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db';
import { runAgentTurn, type LlmMessage, type StoredToolCall } from './agent';
import { WORKSPACE } from './tools';

const PORT = Number(process.env.PORT ?? 3001);

fs.mkdirSync(WORKSPACE, { recursive: true });

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

function toLlmMessages(rows: db.MessageRow[]): LlmMessage[] {
  return rows.map((r) => {
    let meta: { tool_calls?: StoredToolCall[]; tool_call_id?: string; name?: string } = {};
    if (r.meta) {
      try {
        meta = JSON.parse(r.meta);
      } catch {
        meta = {};
      }
    }
    return {
      role: r.role as LlmMessage['role'],
      content: r.content,
      ...(meta.tool_calls ? { tool_calls: meta.tool_calls } : {}),
      ...(meta.tool_call_id ? { tool_call_id: meta.tool_call_id } : {}),
      ...(meta.name ? { name: meta.name } : {}),
    };
  });
}

app.get('/api/health', async () => ({ ok: true, workspace: WORKSPACE }));

app.get('/api/sessions', async () => db.listSessions());

app.post('/api/sessions', async (req, reply) => {
  const body = (req.body ?? {}) as { title?: string };
  const session = db.createSession(body.title?.trim() || 'New session');
  reply.code(201).send(session);
});

app.delete('/api/sessions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!db.getSession(id)) return reply.code(404).send({ error: 'session not found' });
  db.deleteSession(id);
  reply.code(204).send();
});

app.get('/api/sessions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const session = db.getSession(id);
  if (!session) return reply.code(404).send({ error: 'session not found' });
  reply.send({ session, messages: db.getMessages(id) });
});

/**
 * Run one agent turn and stream progress as Server-Sent Events:
 *   message.delta  -> text chunks of the assistant reply
 *   tool.round     -> assistant text + tool calls for this LLM step
 *   tool.start     -> a tool invocation begins (name + args)
 *   tool.result    -> tool finished (truncated output)
 *   message.complete / error -> terminal events
 *   done           -> final event, stream closes
 */
app.post('/api/sessions/:id/messages', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { content?: string };
  if (!body.content?.trim()) return reply.code(400).send({ error: 'content is required' });

  const session = db.getSession(id);
  if (!session) return reply.code(404).send({ error: 'session not found' });

  db.appendMessage(id, { role: 'user', content: body.content.trim() });
  if (session.title === 'New session') {
    db.setSessionTitle(id, body.content.trim().slice(0, 48));
  }

  // Take over the raw response for SSE (Fastify's reply.send would buffer it).
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.hijack();
  const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);

  let finalContent = '';
  const toolArgs = new Map<string, { name: string; args: unknown }>();
  try {
    const history = toLlmMessages(db.getMessages(id));
    for await (const ev of runAgentTurn({ messages: history })) {
      send(ev);
      switch (ev.type) {
        case 'message.complete':
          finalContent = ev.content;
          break;
        case 'tool.round':
          db.appendMessage(id, {
            role: 'assistant',
            content: ev.content,
            meta: { tool_calls: ev.toolCalls },
          });
          break;
        case 'tool.start':
          toolArgs.set(ev.id, { name: ev.name, args: ev.args });
          break;
        case 'tool.result': {
          const start = toolArgs.get(ev.id);
          db.appendMessage(id, {
            role: 'tool',
            content: ev.result,
            meta: { tool_call_id: ev.id, name: ev.name, args: start?.args },
          });
          break;
        }
        default:
          break;
      }
    }
    if (finalContent) db.appendMessage(id, { role: 'assistant', content: finalContent });
    send({ type: 'done' });
  } catch (err) {
    app.log.error(err);
    send({ type: 'error', message: String(err instanceof Error ? err.message : err) });
  } finally {
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

await app.listen({ port: PORT, host: '127.0.0.1' });
