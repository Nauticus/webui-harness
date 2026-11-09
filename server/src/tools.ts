import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';

/**
 * Tool sandbox: all file operations and shell commands for a turn are confined
 * to the session's working directory, so the agent cannot touch anything else.
 */
export const DEFAULT_WORKSPACE = path.resolve(
  process.env.AGENT_WORKSPACE_DIR ?? path.join(process.cwd(), 'workspace')
);

function safePath(workspace: string, p: string, extraReadRoots: string[] = []): string {
  const abs = path.resolve(workspace, p);
  const inside = (root: string) => {
    const r = path.resolve(root);
    return abs === r || abs.startsWith(r + path.sep);
  };
  if (!inside(workspace) && !extraReadRoots.some(inside)) {
    throw new Error(`path escapes working directory: ${p}`);
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

export type ShellName = 'bash' | 'powershell';

/**
 * Which grammar the model must write. Distinct from `name`: `sh` is not bash,
 * and telling the model "bash" while spawning `sh` is how `[[ ]]`, arrays and
 * `shopt` start appearing in commands that then fail with a syntax error.
 */
export type ShellDialect = 'bash' | 'posix' | 'powershell';

/** Filesystem probes, injectable so `shellFor` is testable on any host. */
export interface ShellProbe {
  isFile(p: string): boolean;
  isExecutable(p: string): boolean;
  /** Absolute path of `name` on PATH, or undefined. */
  which(name: string): string | undefined;
}

/** PATH lookup that works whatever the host's casing conventions are. */
function pathValue(): string {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
  return key ? process.env[key] ?? '' : '';
}

const defaultProbe: ShellProbe = {
  isFile(p) {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  isExecutable(p) {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  which(name) {
    const win = process.platform === 'win32';
    const p = win ? path.win32 : path.posix;
    for (const dir of pathValue().split(p.delimiter)) {
      if (!dir) continue;
      const candidate = p.resolve(dir, name);
      if (defaultProbe.isFile(candidate) && defaultProbe.isExecutable(candidate)) return candidate;
    }
    return undefined;
  },
};

export interface Shell {
  name: ShellName;
  file: string;
  argv: string[];
  dialect: ShellDialect;
  /** How the tool description names it to the model. */
  blurb: string;
}

/**
 * The shell a command runs in.
 *
 * Decided from the platform, in one place, because three things have to agree
 * on the answer: the syntax the model writes (the tool description names the
 * shell), the process that actually executes it, and the grammar the client
 * colours the command line with. Guessing per-call — or assuming bash everywhere
 * — is what makes a Windows host either run the wrong language or render a right
 * one as the wrong one.
 *
 * `-NoProfile` keeps a user's profile script from printing into the output and
 * from slowing every call down; `-NonInteractive` makes a prompt a failure
 * rather than a hang until the timeout.
 *
 * On Unix the executable is resolved rather than trusted to PATH, because a
 * slim container with no bash would otherwise fail every single tool call with
 * an ENOENT the model cannot interpret: `AGENT_SHELL_PATH` (absolute, must
 * exist — a typo is a startup error, not a silent fallback) then `/bin/bash`,
 * then `bash` on PATH, then `/bin/sh`, which still runs commands but only in
 * POSIX syntax.
 *
 * On Windows PowerShell 7 is preferred over the Windows PowerShell 5.1 that
 * ships in System32, and the two are not the same language: 7 has `&&` and `||`
 * pipeline chaining, 5.1 treats them as errors, so a model that wrote 7 syntax
 * against 5.1 would fail on the obvious command. The 5.1 path is still the
 * fallback, because it is the one install guaranteed to exist.
 */
export function shellFor(
  platform: NodeJS.Platform = process.platform,
  probe: ShellProbe = defaultProbe,
  env: NodeJS.ProcessEnv = process.env
): Shell {
  if (platform === 'win32') {
    const win = path.win32;
    const override = env.AGENT_SHELL_PATH;
    if (override !== undefined && override !== '') {
      if (!win.isAbsolute(override)) {
        throw new Error(`AGENT_SHELL_PATH must be an absolute path, got: ${override}`);
      }
      const ext = win.extname(override).toLowerCase();
      if ((ext !== '.exe' && ext !== '.com') || !probe.isFile(override)) {
        throw new Error(`AGENT_SHELL_PATH is not an executable file: ${override}`);
      }
      return {
        name: 'powershell',
        file: override,
        argv: ['-NoProfile', '-NonInteractive', '-Command'],
        dialect: 'powershell',
        blurb: `${win.basename(override, ext)} -Command`,
      };
    }

    const candidates = [
      probe.which('pwsh.exe'),
      env.ProgramFiles ? win.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe') : undefined,
      probe.which('powershell.exe'),
      env.SystemRoot
        ? win.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : undefined,
    ];
    const file = candidates.find((c) => c !== undefined && probe.isFile(c)) ?? 'powershell.exe';
    return {
      name: 'powershell',
      file,
      argv: ['-NoProfile', '-NonInteractive', '-Command'],
      dialect: 'powershell',
      blurb: `${win.basename(file, '.exe')} -Command`,
    };
  }

  const override = env.AGENT_SHELL_PATH;
  if (override !== undefined && override !== '') {
    if (!path.posix.isAbsolute(override)) {
      throw new Error(`AGENT_SHELL_PATH must be an absolute path, got: ${override}`);
    }
    if (!probe.isFile(override) || !probe.isExecutable(override)) {
      throw new Error(`AGENT_SHELL_PATH is not an executable file: ${override}`);
    }
    return {
      name: 'bash',
      file: override,
      argv: ['-c'],
      dialect: path.posix.basename(override) === 'bash' ? 'bash' : 'posix',
      blurb: `${path.posix.basename(override)} -c`,
    };
  }

  for (const candidate of ['/bin/bash', probe.which('bash')]) {
    if (candidate && probe.isFile(candidate) && probe.isExecutable(candidate)) {
      return { name: 'bash', file: candidate, argv: ['-c'], dialect: 'bash', blurb: 'bash -c' };
    }
  }
  return { name: 'bash', file: '/bin/sh', argv: ['-c'], dialect: 'posix', blurb: 'sh -c' };
}

/** This machine's shell, resolved once at module load. */
export const SHELL = shellFor();

export const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        `Run a shell command in the workspace sandbox (${SHELL.blurb}). Output is truncated to 12000 chars.`,
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
      description:
        'Read a text file from the workspace (or an approved skill directory). Path relative to workspace root.',
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
      description:
        'Create a new file (or fully overwrite an existing one) in the workspace. Parent dirs are created. ' +
        'For changes to an existing file, prefer edit_file — it only sends the changed part.',
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
      name: 'edit_file',
      description:
        'Edit an existing file with exact text replacement. Each edit replaces oldText with newText. ' +
        'Every oldText must be a non-empty, verbatim copy of the file content. ' +
        'Without replaceAll each oldText must match exactly ONCE in the file — include enough surrounding ' +
        'context to make it unique. Multiple edits are applied top-to-bottom in one atomic operation: ' +
        'if any edit fails, the file is left untouched. Use write_file for new files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          edits: {
            type: 'array',
            description: 'One or more targeted replacements',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', description: 'Exact text to find (must be non-empty)' },
                newText: { type: 'string', description: 'Replacement text (may be empty to delete)' },
                replaceAll: {
                  type: 'boolean',
                  description: 'When true, replace every occurrence instead of requiring a unique match',
                },
              },
              required: ['oldText', 'newText'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List directory entries in the workspace (or an approved skill directory).',
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
const MAX_EDIT_FILE_BYTES = 1_500_000; // ~1.5MB: beyond this, diffs are not worth generating
const truncate = (s: string) =>
  s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n...[truncated ${s.length - MAX_OUTPUT} chars]` : s;

/**
 * Tool outcome: `output` goes to the LLM, `diff` (unified) is shown in the UI +
 * stored in history. `ok: false` marks a failure — the UI must not have to
 * guess it from the wording of `output` (it used to sniff `startsWith('error')`,
 * which broke the moment a message said anything else).
 */
export interface ToolResult {
  output: string;
  ok?: boolean;
  diff?: string;
  /** Which shell actually ran a `bash` call, so the UI can read it correctly. */
  shell?: ShellName;
}

/** One place that builds a failure, so `ok` can never be forgotten. */
function fail(message: string): ToolResult {
  return { output: `error: ${message}`, ok: false };
}

interface Edit {
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

/** Count non-overlapping occurrences of needle in hay (O(hay)). */
function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) return count;
    count++;
    from = i + needle.length;
  }
}

/**
 * Validate and apply all edits against a scratch copy. All-or-nothing:
 * returns the new content only if every edit matches its uniqueness rule.
 */
function applyEdits(
  content: string,
  edits: Edit[]
): { next: string; replacements: number } | { error: string } {
  let next = content;
  let replacements = 0;
  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText, replaceAll } = edits[i]!;
    const count = countOccurrences(next, oldText);
    if (count === 0) {
      return { error: `edit ${i + 1}: oldText not found — re-read the file and copy the exact text` };
    }
    if (!replaceAll && count > 1) {
      return {
        error: `edit ${i + 1}: oldText matches ${count} places — make it unique (add surrounding context) or set replaceAll`,
      };
    }
    next = replaceAll ? next.split(oldText).join(newText) : next.replace(oldText, newText);
    replacements += replaceAll ? count : 1;
  }
  return { next, replacements };
}

/** Unified diff, capped. Returns undefined for identical or oversized content. */
function fileDiff(rel: string, before: string, after: string): string | undefined {
  if (before === after) return undefined;
  try {
    return truncate(createTwoFilesPatch(rel, rel, before, after, '', '', { context: 3 }));
  } catch {
    return undefined; // diff blew up on a huge file — skip, the summary still goes out
  }
}

/** One-sided "new file" diff (no algorithm needed): + lines, capped. */
function newFileDiff(rel: string, content: string): string {
  const lines = content.split('\n');
  const head = lines.map((l) => `+${l}`).join('\n');
  return truncate(
    `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${head}`
  );
}

/** Atomic write: temp file + rename so a crash never leaves a partial file. */
async function atomicWrite(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

function runBash(
  command: string,
  timeoutSec: number,
  workspace: string,
  signal?: AbortSignal
): Promise<{ text: string; failed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(SHELL.file, [...SHELL.argv, command], {
      cwd: workspace,
      env: {
        ...process.env,
        // Process markers, so anything the command starts (build scripts, a
        // nested agent) can tell it was launched here rather than from a
        // terminal — and where the writable sandbox is.
        WEBUI_H_AGENT: '1',
        WEBUI_H_WORKSPACE: workspace,
      },
    });
    let out = '';
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (suffix?: string, failed = false) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const text = suffix ? `${out ? out + '\n' : ''}${suffix}` : out || '(no output)';
      resolve({ text: truncate(text), failed });
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      finish('[stopped by user]', true);
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(`[timed out after ${timeoutSec}s]`, true);
    }, Math.min(timeoutSec, 120) * 1000);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    // The exit code used to be dropped, so a failing command looked exactly
    // like a silent success (`false`, `grep` with no match). Report it.
    child.on('close', (code) =>
      finish(code ? `${out}${out ? '\n' : ''}[exit code ${code}]` : undefined, code !== 0)
    );
    child.on('error', (err) => finish(`${SHELL.name} error: ${String(err)}`, true));
  });
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
  signal?: AbortSignal,
  /** Extra directories readable by read_file/list_dir (skill directories).
   *  Writes and edits stay strictly inside the workspace. */
  extraReadRoots: string[] = []
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'bash': {
        const command = String(args.command ?? '');
        if (!command.trim()) return fail('empty command');
        const timeout = Number.isFinite(Number(args.timeout)) ? Number(args.timeout) : 30;
        const run = await runBash(command, timeout, workspace, signal);
        return run.failed ? { output: run.text, ok: false, shell: SHELL.name } : { output: run.text, shell: SHELL.name };
      }
      case 'read_file': {
        const abs = safePath(workspace, String(args.path ?? ''), extraReadRoots);
        const raw = await fs.readFile(abs, 'utf8');
        const lines = raw.split('\n');
        const offset = Math.max(1, Number(args.offset ?? 1));
        const limit = Math.min(Number(args.limit ?? 400), 2000);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const header =
          offset > 1 || slice.length < lines.length ? `[lines ${offset}-${offset + slice.length - 1} of ${lines.length}] ` : '';
        return { output: header + slice.join('\n') };
      }
      case 'write_file': {
        const abs = safePath(workspace, String(args.path ?? ''));
        const rel = path.relative(workspace, abs);
        const content = String(args.content ?? '');
        let before: string | undefined;
        try {
          before = await fs.readFile(abs, 'utf8');
        } catch {
          before = undefined; // new file
        }
        if (before !== undefined && before.includes('\u0000')) {
          return fail(`${rel} looks binary; refusing to overwrite it`);
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await atomicWrite(abs, content);
        const diff = before === undefined ? newFileDiff(rel, content) : fileDiff(rel, before, content);
        const summary =
          before === undefined
            ? `created ${rel} (${content.split('\n').length} lines, ${content.length} chars)`
            : `overwrote ${rel} (${content.length} chars)`;
        // For a full overwrite the model just wrote every byte — echo only a short
        // diff summary into the LLM context, never the whole file back.
        const output =
          before !== undefined && diff
            ? `${summary}\n${diff.length > 4000 ? `unified diff (truncated):\n${diff.slice(0, 4000)}...` : `unified diff:\n${diff}`}`
            : summary;
        return { output, diff };
      }
      case 'edit_file': {
        const abs = safePath(workspace, String(args.path ?? ''));
        const rel = path.relative(workspace, abs);
        const rawEdits = Array.isArray(args.edits) ? (args.edits as object[]) : [];
        if (rawEdits.length === 0) return fail('edits must contain at least one replacement');
        const edits: Edit[] = rawEdits.map((e) => ({
          oldText: String((e as { oldText?: unknown }).oldText ?? ''),
          newText: String((e as { newText?: unknown }).newText ?? ''),
          replaceAll: (e as { replaceAll?: unknown }).replaceAll === true,
        }));
        for (let i = 0; i < edits.length; i++) {
          if (edits[i]!.oldText === '') {
            return fail(`edit ${i + 1}: oldText must be non-empty`);
          }
        }
        let before: string;
        try {
          before = await fs.readFile(abs, 'utf8');
        } catch {
          return fail(`${rel} does not exist — use write_file to create it`);
        }
        if (before.includes('\u0000')) {
          return fail(`${rel} looks binary; refusing to edit it`);
        }
        if (before.length > MAX_EDIT_FILE_BYTES) {
          return fail(`${rel} is too large to edit (${before.length} bytes)`);
        }
        const applied = applyEdits(before, edits);
        if ('error' in applied) return fail(applied.error);
        if (applied.next === before) {
          return { output: `no change: every edit replaced text with identical text` };
        }
        const diff = fileDiff(rel, before, applied.next);
        await atomicWrite(abs, applied.next);
        const plus = applied.next.split('\n').length - before.split('\n').length;
        const summary = `edited ${rel} (${applied.replacements} replacement${applied.replacements === 1 ? '' : 's'})`;
        // The diff doubles as the model's self-check that the change landed as intended.
        return { output: diff ? `${summary}\n${diff}` : summary, diff };
      }
      case 'list_dir': {
        const abs = safePath(workspace, String(args.path ?? '.'), extraReadRoots);
        const entries = await fs.readdir(abs, { withFileTypes: true });
        if (entries.length === 0) return { output: '(empty)' };
        return {
          output: entries.map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`).join('\n'),
        };
      }
      default:
        return fail(`unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err));
  }
}
