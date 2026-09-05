import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { getConfigDb } from './config-db.js';
import { materializeSkills } from './materialize.js';
import { skillsCacheDir } from './paths.js';
import {
  addSkillSource,
  deleteSkillFile,
  getSkill,
  getSkillFile,
  importSkillDir,
  listSkillFiles,
  listSkillSources,
  listSkills,
  parseSkillDescription,
  putSkillFile,
  removeSkill,
} from './skills.js';
import { withTempHome } from './testing.js';

const home = withTempHome('bearclaw-skills-');
after(() => home.dispose());

const SKILL_MD = `---
name: render
description: Renders a thing
---

# Render
`;

// A source tree with one executable, one nested asset, and two entries the
// walker must ignore.
function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bearclaw-skillsrc-'));
  const skill = path.join(dir, 'render');
  fs.mkdirSync(path.join(skill, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), SKILL_MD);
  fs.writeFileSync(path.join(skill, 'render.sh'), '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(skill, 'render.sh'), 0o755);
  fs.writeFileSync(
    path.join(skill, 'assets', 'template.html'),
    '<p>hello</p>\n',
  );
  fs.mkdirSync(path.join(skill, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(skill, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(skill, '.hidden'), 'nope');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(skill, 'link.txt'));
  return dir;
}

let sourceRoot = '';

beforeEach(() => {
  getConfigDb().exec('DELETE FROM skills; DELETE FROM skill_sources;');
  fs.rmSync(skillsCacheDir(), { recursive: true, force: true });
  if (sourceRoot) fs.rmSync(sourceRoot, { recursive: true, force: true });
  sourceRoot = fixture();
});

after(() => {
  if (sourceRoot) fs.rmSync(sourceRoot, { recursive: true, force: true });
});

test('importSkillDir stores files with their modes and skips dot entries', () => {
  const src = path.join(sourceRoot, 'render');
  const result = importSkillDir(src, 'render', path.join(src, 'SKILL.md'));
  assert.equal(result.files, 3);

  const skill = getSkill('render');
  assert.equal(skill?.description, 'Renders a thing');
  assert.equal(skill?.sourcePath, path.join(src, 'SKILL.md'));

  const files = listSkillFiles('render');
  assert.deepEqual(
    files.map((f) => f.relpath),
    ['SKILL.md', 'assets/template.html', 'render.sh'],
  );
  assert.equal(files.find((f) => f.relpath === 'render.sh')?.mode, 0o755);
  assert.equal(files.find((f) => f.relpath === 'SKILL.md')?.mode, 0o644);
  assert.equal(
    getSkillFile('render', 'assets/template.html')?.content.toString('utf-8'),
    '<p>hello</p>\n',
  );
});

test('the mirror reproduces the source tree byte for byte and mode for mode', () => {
  const src = path.join(sourceRoot, 'render');
  importSkillDir(src, 'render');
  const mirror = path.join(skillsCacheDir(), 'render');

  for (const rel of ['SKILL.md', 'render.sh', 'assets/template.html']) {
    const original = fs.readFileSync(path.join(src, ...rel.split('/')));
    const copy = fs.readFileSync(path.join(mirror, ...rel.split('/')));
    assert.ok(original.equals(copy), `${rel} content differs`);
    assert.equal(
      fs.statSync(path.join(mirror, ...rel.split('/'))).mode & 0o777,
      fs.statSync(path.join(src, ...rel.split('/'))).mode & 0o777,
      `${rel} mode differs`,
    );
  }
  assert.equal(fs.existsSync(path.join(mirror, '.claude')), false);
  assert.equal(fs.existsSync(path.join(mirror, '.hidden')), false);
  assert.equal(fs.existsSync(path.join(mirror, 'link.txt')), false);
});

test('a re-import replaces the previous file set', () => {
  const src = path.join(sourceRoot, 'render');
  importSkillDir(src, 'render');
  putSkillFile('render', 'extra.md', 'temporary');
  assert.equal(listSkillFiles('render').length, 4);

  importSkillDir(src, 'render');
  assert.equal(listSkillFiles('render').length, 3);
  assert.equal(
    fs.existsSync(path.join(skillsCacheDir(), 'render', 'extra.md')),
    false,
  );
});

test('putSkillFile and deleteSkillFile keep the mirror in step', () => {
  importSkillDir(path.join(sourceRoot, 'render'), 'render');
  putSkillFile('render', 'notes/README.md', '# notes\n');
  assert.equal(
    fs.readFileSync(
      path.join(skillsCacheDir(), 'render', 'notes', 'README.md'),
      'utf-8',
    ),
    '# notes\n',
  );

  putSkillFile('render', 'SKILL.md', '---\ndescription: Changed\n---\n');
  assert.equal(getSkill('render')?.description, 'Changed');

  deleteSkillFile('render', 'notes/README.md');
  assert.equal(
    fs.existsSync(path.join(skillsCacheDir(), 'render', 'notes', 'README.md')),
    false,
  );
  assert.throws(
    () => deleteSkillFile('render', 'notes/README.md'),
    /file not found/,
  );
});

test('relpaths that could escape the mirror are rejected', () => {
  importSkillDir(path.join(sourceRoot, 'render'), 'render');
  for (const bad of ['../x', 'a/../../b', '/abs/x', '', './x', 'a\\b']) {
    assert.throws(() => putSkillFile('render', bad, 'x'), /invalid path/);
  }
  assert.throws(
    () => putSkillFile('../evil', 'SKILL.md', 'x'),
    /invalid skill name/,
  );
});

test('removeSkill prunes rows and the mirror', () => {
  importSkillDir(path.join(sourceRoot, 'render'), 'render');
  removeSkill('render');
  assert.equal(getSkill('render'), undefined);
  assert.equal(listSkillFiles('render').length, 0);
  assert.equal(fs.existsSync(path.join(skillsCacheDir(), 'render')), false);
  assert.equal(fs.existsSync(skillsCacheDir()), true);
});

test('with no skills the mirror is an empty directory', () => {
  materializeSkills();
  assert.deepEqual(fs.readdirSync(skillsCacheDir()), []);
  assert.equal(listSkills().length, 0);
});

test('skill sources round trip', () => {
  addSkillSource('/tmp/skills-a');
  addSkillSource('/tmp/skills-a');
  addSkillSource('/tmp/skills-b');
  assert.deepEqual(listSkillSources(), ['/tmp/skills-a', '/tmp/skills-b']);
});

test('parseSkillDescription prefers the frontmatter description', () => {
  assert.equal(parseSkillDescription(SKILL_MD), 'Renders a thing');
  assert.equal(
    parseSkillDescription('---\n---\n\nJust a line\n'),
    'Just a line',
  );
  assert.equal(parseSkillDescription(''), '');
});

test('importSkillDir refuses a directory with no SKILL.md', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bearclaw-noskill-'));
  assert.throws(() => importSkillDir(empty, 'nope'), /no SKILL\.md/);
  fs.rmSync(empty, { recursive: true, force: true });
});
