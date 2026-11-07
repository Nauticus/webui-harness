import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Tool sandbox: all file operations and shell commands are confined to a
 * single workspace directory so the agent cannot touch the rest of the box.
 */
export const WORKSPACE = path.resolve(
  process.env.AGENT_WORKSPACE_DIR ?? path.join(process.cwd(), 'workspace')
);

function safePath(p: string): string {
  const abs = path.resolve(WORKSPACE, p);
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return abs;
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command in the workspace sandbox (bash -c). Output is truncated to 12000 chars.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          timeout: { type: 'number', description: 'Timeout in seconds (default 30)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the workspace. Path relative to workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          offset: { type: 'number', description: 'Line number to start from (1-indexed)' },
          limit: { type: 'number', description: 'Max lines to read (default 400)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write (create or overwrite) a file in the workspace. Parent dirs are created.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List directory entries in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: workspace root)' },
        },
      },
    },
  },
];

const MAX_OUTPUT = 12000;
const truncate = (s: string) =>
  s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n...[truncated ${s.length - MAX_OUTPUT} chars]` : s;

function runBash(command: string, timeoutSec: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd: WORKSPACE,
      env: { ...process.env },
    });
    let out = '';
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      resolve(truncate(out || '(no output)'));
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(truncate(`${out}\n[timed out after ${timeoutSec}s]`));
    }, Math.min(timeoutSec, 120) * 1000);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', finish);
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve(`bash error: ${String(err)}`);
    });
  });
}

export async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'bash': {
        const command = String(args.command ?? '');
        if (!command.trim()) return 'error: empty command';
        const timeout = Number.isFinite(Number(args.timeout)) ? Number(args.timeout) : 30;
        return await runBash(command, timeout);
      }
      case 'read_file': {
        const abs = safePath(String(args.path ?? ''));
        const raw = await fs.readFile(abs, 'utf8');
        const lines = raw.split('\n');
        const offset = Math.max(1, Number(args.offset ?? 1));
        const limit = Math.min(Number(args.limit ?? 400), 2000);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const header =
          offset > 1 || slice.length < lines.length ? `[lines ${offset}-${offset + slice.length - 1} of ${lines.length}] ` : '';
        return header + slice.join('\n');
      }
      case 'write_file': {
        const abs = safePath(String(args.path ?? ''));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, String(args.content ?? ''), 'utf8');
        return `wrote ${String(args.content ?? '').length} chars to ${path.relative(WORKSPACE, abs)}`;
      }
      case 'list_dir': {
        const abs = safePath(String(args.path ?? '.'));
        const entries = await fs.readdir(abs, { withFileTypes: true });
        if (entries.length === 0) return '(empty)';
        return entries
          .map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`)
          .join('\n');
      }
      default:
        return `unknown tool: ${name}`;
    }
  } catch (err) {
    return `error: ${String(err instanceof Error ? err.message : err)}`;
  }
}
