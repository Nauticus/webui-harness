import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate HOME before skills.ts is loaded (its global dir derives from HOME),
// give each test run its own project workspace, and disable the discovery
// cache so file changes between tests are always visible.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-h-skills-home-'));
process.env.WEBUI_H_SKILLS_TTL = '0';
const HOME = process.env.HOME!;
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-h-skills-ws-'));

// Dynamic import: skills.ts derives its global dir from HOME at load time,
// so it must load AFTER the env setup above.
const { listSkills, parseSkillInvocation, expandSkillInvocation, skillBody } =
  await import('../src/skills');
import type { Skill } from '../src/skills';
const { runTool } = await import('../src/tools');

function writeSkill(
  root: string,
  name: string,
  fm: { description?: string; 'disable-model-invocation'?: string } = { description: `desc of ${name}` }
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  const fmLines = Object.entries(fm)
    .map(([k, v]) => (k === 'description' ? `description: ${v}` : `${k}: ${v}`))
    .join('\n');
  fs.writeFileSync(file, `---\n${fmLines}\n---\n\n# ${name}\n\nDo ${name} things.\n`);
  return file;
}

const globalRoot = path.join(HOME, '.agents', 'skills');
const projectRoot = path.join(ws, '.agents', 'skills');

test('discovery: finds global and project skills with sources', () => {
  fs.rmSync(globalRoot, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
  writeSkill(globalRoot, 'alpha');
  writeSkill(projectRoot, 'beta');
  const skills = listSkills(ws);
  assert.deepEqual(
    skills.map((s) => s.name).sort(),
    ['alpha', 'beta']
  );
  assert.equal(skills.find((s) => s.name === 'alpha')!.source, 'global');
  assert.equal(skills.find((s) => s.name === 'beta')!.source, 'project');
});

test('discovery: name collision keeps global first (like pi)', () => {
  fs.rmSync(globalRoot, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
  const gFile = writeSkill(globalRoot, 'dup');
  writeSkill(projectRoot, 'dup');
  const skills = listSkills(ws);
  assert.equal(skills.filter((s) => s.name === 'dup').length, 1);
  assert.equal(skills.find((s) => s.name === 'dup')!.filePath, gFile);
});

test('discovery: missing description is skipped with a warning', () => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  writeSkill(projectRoot, 'no-desc', {});
  const skill = writeSkill(projectRoot, 'fine');
  const skills = listSkills(ws);
  assert.ok(!skills.some((s) => s.name === 'no-desc'));
  assert.ok(skills.some((s) => s.name === 'fine'));
  assert.equal(skills.find((s) => s.name === 'fine')!.filePath, skill);
});

test('discovery: disable-model-invocation is parsed from frontmatter', () => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  writeSkill(projectRoot, 'manual', { description: 'manual only', 'disable-model-invocation': 'true' });
  const skills = listSkills(ws);
  assert.equal(skills.find((s) => s.name === 'manual')!.disableModelInvocation, true);
});

test('discovery: standalone .md under the root is a skill named by its filename', () => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'quick-tips.md'),
    '---\ndescription: quick tips\n---\n\nbody\n'
  );
  const skills = listSkills(ws);
  assert.ok(skills.some((sk) => sk.name === 'quick-tips'));
});

test('discovery: nested skill directories are found (depth-limited)', () => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(projectRoot, 'pack', 'nested'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'pack', 'nested', 'SKILL.md'),
    '---\nname: nested-skill\ndescription: found deep\n---\n\nbody\n'
  );
  const skills = listSkills(ws);
  assert.ok(skills.some((s) => s.name === 'nested-skill'));
});

test('parseSkillInvocation: recognizes /skill:name [task]', () => {
  assert.deepEqual(parseSkillInvocation('/skill:word-count the file README.md'), {
    name: 'word-count',
    task: 'the file README.md',
  });
  assert.deepEqual(parseSkillInvocation('/skill:alpha'), { name: 'alpha', task: '' });
  assert.equal(parseSkillInvocation('hello /skill:alpha'), null);
  assert.equal(parseSkillInvocation('/skill:Alpha'), null);
  assert.equal(parseSkillInvocation('/other'), null);
});

test('expandSkillInvocation: non-invocation passes through', () => {
  const skills: Skill[] = [];
  assert.deepEqual(expandSkillInvocation('just a message', skills), { kind: 'not-invocation' });
});

test('expandSkillInvocation: unknown skill is reported', () => {
  const inv = expandSkillInvocation('/skill:nope do it', []);
  assert.deepEqual(inv, { kind: 'not-found', name: 'nope' });
});

test('expandSkillInvocation: expands to instructions + task, frontmatter stripped', () => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  const file = writeSkill(projectRoot, 'expand-me', { description: 'test' });
  const skills = listSkills(ws);
  const inv = expandSkillInvocation('/skill:expand-me do the thing', skills);
  assert.equal(inv.kind, 'expanded');
  if (inv.kind !== 'expanded') return;
  assert.ok(inv.text.includes('Use the skill "expand-me"'));
  assert.ok(inv.text.includes('# expand-me'));
  assert.ok(inv.text.includes('Task:\ndo the thing'));
  assert.ok(!inv.text.includes('description:')); // frontmatter is stripped
  assert.equal(inv.skill.filePath, file);
});

test('skillBody: strips the frontmatter block', () => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  const file = writeSkill(projectRoot, 'body-skill');
  assert.ok(!skillBody(file).startsWith('---'));
  assert.match(skillBody(file), /# body-skill/);
});

test('runTool: read_file allows skill directories outside the workspace', async () => {
  fs.rmSync(globalRoot, { recursive: true, force: true });
  const file = writeSkill(globalRoot, 'sandbox-skill');
  const skills = listSkills(ws);
  // Read via absolute path from OUTSIDE the workspace (the model gets the
  // absolute filePath from the system prompt).
  const res = await runTool(
    'read_file',
    { path: file },
    ws,
    undefined,
    skills.map((s) => s.dir)
  );
  assert.ok(res.output.includes('# sandbox-skill'));
});

test('runTool: list_dir works on skill directories too', async () => {
  fs.rmSync(globalRoot, { recursive: true, force: true });
  const dir = path.join(globalRoot, 'listy');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: listy\ndescription: lists things\n---\n\nbody\n'
  );
  const skills = listSkills(ws);
  const res = await runTool(
    'list_dir',
    { path: dir },
    ws,
    undefined,
    skills.map((s) => s.dir)
  );
  assert.match(res.output, /SKILL\.md/);
  assert.match(res.output, /scripts/);
});

test('runTool: paths outside workspace and outside skills are still refused', async () => {
  // runTool reports errors as output, never throws.
  const r1 = await runTool('read_file', { path: '/etc/hostname' }, ws);
  assert.match(r1.output, /^error: path escapes working directory/);
  const r2 = await runTool('write_file', { path: '/tmp/elsewhere.txt', content: 'x' }, ws);
  assert.match(r2.output, /^error: path escapes working directory/);
  // Even with extra read roots, writes never leave the workspace.
  fs.rmSync(globalRoot, { recursive: true, force: true });
  const dir = path.join(globalRoot, 'w-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: w-skill\ndescription: x\n---\n\nbody\n');
  const r3 = await runTool(
    'write_file',
    { path: path.join(dir, 'evil.txt'), content: 'x' },
    ws,
    undefined,
    [dir]
  );
  assert.match(r3.output, /^error: path escapes working directory/);
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')));
});
