import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Agent Skills (agentskills.io spec): a skill is a directory containing
 * SKILL.md — frontmatter (name, description) plus instructions, with
 * optional bundled scripts/references/assets. Progressive disclosure:
 * only name + description + path are advertised in the system prompt;
 * the model reads SKILL.md when a task matches.
 *
 * Locations (portable standard):
 *   global   ~/.agents/skills
 *   project  <workspace>/.agents/skills
 */
export interface Skill {
  name: string;
  description: string;
  /** Skill directory (absolute) — the root for relative paths in SKILL.md. */
  dir: string;
  /** Absolute path to SKILL.md. */
  filePath: string;
  source: 'global' | 'project';
  /** Frontmatter disable-model-invocation: only explicit /skill:name use. */
  disableModelInvocation: boolean;
}

const GLOBAL_DIR = path.join(os.homedir(), '.agents', 'skills');
const projectSkillsDir = (workspace: string) => path.join(workspace, '.agents', 'skills');

/** Name per the Agent Skills spec: lowercase, numbers, hyphens. */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LEN = 64;
const MAX_DESC_LEN = 1024;
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

/**
 * Discovery cache. Pi scans once at startup and on /reload; a Weblisan
 * server is long-lived with projects added at runtime, so this refreshes
 * per workspace on a short TTL instead — new/edited skills take effect
 * within a minute with no manual reload, and consecutive turns are free.
 * Override with WEBLISAN_SKILLS_TTL (ms; 0 = always rescan, used in tests).
 */
const TTL_MS = Number(process.env.WEBLISAN_SKILLS_TTL ?? 60_000);
const cache = new Map<string, { at: number; skills: Skill[] }>();

/** Minimal YAML frontmatter: top-level `key: value` lines between --- markers. */
function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) continue; // nested/indented YAML is not part of the fields we use
    let value = kv[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[kv[1]!.toLowerCase()] = value;
  }
  return out;
}

/** Strip the frontmatter block; the body is what the model follows. */
export function skillBody(filePath: string): string {
  const text = fs.readFileSync(filePath, 'utf8');
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

function makeSkill(filePath: string, source: Skill['source'], fallbackName?: string): Skill | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  const fm = parseFrontmatter(text);
  const dir = path.dirname(filePath);
  const name = (fm.name ?? fallbackName ?? path.basename(dir)).toLowerCase();
  const description = (fm.description ?? '').trim();
  if (!NAME_RE.test(name) || name.length > MAX_NAME_LEN) {
    console.warn(`[skills] skipping ${filePath}: invalid name "${name}"`);
    return undefined;
  }
  if (!description) {
    console.warn(`[skills] skipping ${filePath}: missing description (required for routing)`);
    return undefined;
  }
  if (description.length > MAX_DESC_LEN) {
    console.warn(`[skills] ${filePath}: description truncated to ${MAX_DESC_LEN} chars`);
  }
  return {
    name,
    description: description.slice(0, MAX_DESC_LEN),
    dir,
    filePath,
    source,
    disableModelInvocation: fm['disable-model-invocation'] === 'true',
  };
}

/** Scan a skills root: every subdirectory with SKILL.md, recursively
 *  (depth-limited), plus standalone .md files directly under the root. */
function scanDir(root: string, source: Skill['source'], depth: number): Skill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // root missing — no skills here
  }
  const out: Skill[] = [];
  // Inside a skill directory, .md files are the skill's own reference
  // content, not standalone skills.
  const isSkillDir = entries.some(
    (e) => e.isFile() && (e.name === 'SKILL.md' || e.name === 'skill.md')
  );
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile()) {
      if (e.name.endsWith('.md') && !isSkillDir) {
        const skill = makeSkill(full, source, path.basename(e.name, '.md'));
        if (skill) out.push(skill);
      }
      continue;
    }
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    for (const candidate of ['SKILL.md', 'skill.md']) {
      const skill = makeSkill(path.join(full, candidate), source);
      if (skill) {
        out.push(skill);
        break;
      }
    }
    if (depth < MAX_DEPTH) out.push(...scanDir(full, source, depth + 1));
  }
  return out;
}

/** All skills visible to a workspace: global first, then project. Name
 *  collisions keep the first discovered (global beats project), like pi. */
export function listSkills(workspace: string): Skill[] {
  const key = path.resolve(workspace);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.skills;
  const byName = new Map<string, Skill>();
  const found = [
    ...scanDir(GLOBAL_DIR, 'global', 0),
    ...scanDir(projectSkillsDir(key), 'project', 0),
  ];
  for (const skill of found) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  cache.set(key, { at: Date.now(), skills });
  return skills;
}

export const INVOCATION_RE = /^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?:[ \t]+([\s\S]*?))?[ \t]*$/;

/** A user message that explicitly invokes a skill: `/skill:name [task]`. */
export function parseSkillInvocation(content: string): { name: string; task: string } | null {
  const m = INVOCATION_RE.exec(content.trim());
  if (!m) return null;
  return { name: m[1]!, task: (m[2] ?? '').trim() };
}

export type SkillInvocation =
  | { kind: 'not-invocation' }
  | { kind: 'not-found'; name: string }
  | { kind: 'expanded'; skill: Skill; text: string };

/**
 * Expand an explicit invocation into the instruction block the model
 * receives (pi's /skill:name behavior: loaded instructions plus the task
 * appended as the user request). History keeps the raw `/skill:name …`
 * text; this materializes it per turn, so replays stay compact.
 */
export function expandSkillInvocation(content: string, skills: Skill[]): SkillInvocation {
  const invocation = parseSkillInvocation(content);
  if (!invocation) return { kind: 'not-invocation' };
  const skill = skills.find((s) => s.name === invocation.name);
  if (!skill) return { kind: 'not-found', name: invocation.name };
  const body = skillBody(skill.filePath);
  const text = invocation.task
    ? `Use the skill "${skill.name}". Follow its instructions below; paths relative to the skill directory (${skill.dir}) resolve against it.\n\n${body}\n\nTask:\n${invocation.task}`
    : `Use the skill "${skill.name}". Follow its instructions below; paths relative to the skill directory (${skill.dir}) resolve against it.\n\n${body}`;
  return { kind: 'expanded', skill, text };
}
