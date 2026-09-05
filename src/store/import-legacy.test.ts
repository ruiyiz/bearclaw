import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { closeConfigDb, getConfigDb } from './config-db.js';
import { importLegacyFs, type ImportReport } from './import-legacy.js';
import { getSetting, isOnboarded, verifyPassword } from './settings.js';

delete process.env.BEARCLAW_PASSWORD;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bearclaw-legacy-'));
const retireHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bearclaw-retire-'));

after(() => {
  closeConfigDb();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(retireHome, { recursive: true, force: true });
});

function write(rel: string, body: string, mode?: number): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  if (mode !== undefined) fs.chmodSync(abs, mode);
}

const WORKFLOW = {
  name: 'Reminder',
  slug: 'reminder',
  owner: 'main',
  inputs: {
    type: 'object',
    required: ['text'],
    properties: { text: { type: 'string' } },
  },
  nodes: { deliver: { type: 'send', text: '{{inputs.text}}', to: 'primary' } },
  edges: [],
};

// A pre-migration ~/.bearclaw: .env, a flat registry, agent markdown next to a
// runtime JSON file, one skill with an executable script and a dot-directory to
// skip, the config/*.json family, workflows (one broken) and a 0-byte orphan db.
write(
  '.env',
  [
    '# comment',
    'BEARCLAW_PASSWORD=hunter2',
    'DEFAULT_MODEL=claude-sonnet-5',
    'ANTHROPIC_API_KEY=sk-test-1234',
    'ASSISTANT_NAME=Andy',
    'BEARCLAW_HOME=/somewhere/else',
    'BEARCLAW_WORKFLOWS_DIR=/somewhere/else/workflows',
  ].join('\n'),
);
write(
  'config/registered_agents.json',
  JSON.stringify({
    '4915@s.whatsapp.net': {
      name: 'Andy',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
      primary: true,
    },
    'web:coco': {
      name: 'Coco',
      folder: 'coco',
      trigger: '',
      added_at: '2026-02-01T00:00:00.000Z',
      heartbeat: { enabled: true, schedule: '0 9 * * *' },
    },
  }),
);
write('context/AGENTS.md', '# Agents\n');
write('context/USER.md', '# User\n');
write('context/notes.txt', 'not markdown\n');
write('agents/coco/IDENTITY.md', '# Coco\n');
write('agents/coco/HEARTBEAT.md', '# Heartbeat brief\n');
write('agents/coco/pipeline.json', '{"cursor":42}');
write(
  'skills/demo/SKILL.md',
  '---\nname: demo\ndescription: A demo skill\n---\n',
);
write('skills/demo/render.sh', '#!/bin/sh\necho hi\n', 0o755);
write('skills/demo/lib/helper.py', 'print("hi")\n', 0o644);
write('skills/demo/.claude/settings.local.json', '{}');
write('skills/.claude/settings.local.json', '{}');
write('skills/no-manifest/README.md', 'nothing here\n');
write(
  'config/mcp.json',
  JSON.stringify({
    mcpServers: {
      notion: {
        command: 'npx',
        args: ['-y', 'notion'],
        env: { T: '${NOTION_API_KEY}' },
      },
    },
  }),
);
write(
  'config/model-catalog.json',
  JSON.stringify({
    models: [{ alias: 'sonnet', id: 'sonnet', label: 'S', contextWindow: 1 }],
  }),
);
write('config/skill_sources.json', JSON.stringify(['/tmp/my-skills']));
write(
  'config/skill_install_meta.json',
  JSON.stringify({ demo: { sourcePath: '/tmp/my-skills/demo/SKILL.md' } }),
);
write('workflows/reminder.json', JSON.stringify(WORKFLOW));
write(
  'workflows/broken.json',
  JSON.stringify({ name: 'Broken', slug: 'broken' }),
);
write('messages.db', '');
write('.gitignore', 'var/\n');
fs.mkdirSync(path.join(home, '.git'), { recursive: true });

let report: ImportReport;

test('dry run reports without writing', () => {
  const dry = importLegacyFs({ home, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.settings.includes('DEFAULT_MODEL'));
  assert.equal(dry.workflows.length, 1);
  const count = getConfigDb()
    .prepare('SELECT count(*) AS n FROM settings')
    .get() as { n: number };
  assert.equal(count.n, 0);
});

test('import fills every table', () => {
  report = importLegacyFs({ home });
  const db = getConfigDb();

  // Settings: .env minus the location vars and the password.
  assert.deepEqual(report.skippedSettings.sort(), [
    'BEARCLAW_HOME',
    'BEARCLAW_WORKFLOWS_DIR',
  ]);
  assert.deepEqual(report.settings.sort(), [
    'ANTHROPIC_API_KEY',
    'ASSISTANT_NAME',
    'DEFAULT_MODEL',
  ]);
  assert.equal(getSetting('DEFAULT_MODEL'), 'claude-sonnet-5');
  assert.equal(getSetting('BEARCLAW_HOME'), undefined);
  const apiKey = db
    .prepare('SELECT secret FROM settings WHERE key = ?')
    .get('ANTHROPIC_API_KEY') as { secret: number };
  assert.equal(apiKey.secret, 1);

  // Password came from .env and is stored as a hash.
  assert.equal(report.passwordSet, true);
  assert.equal(verifyPassword('hunter2'), true);
  assert.equal(verifyPassword('nope'), false);

  // Registry: flat entries were nested by folder.
  assert.deepEqual(report.agents.sort(), ['coco', 'main']);
  const coco = db
    .prepare('SELECT name, channels, heartbeat FROM agents WHERE folder = ?')
    .get('coco') as { name: string; channels: string; heartbeat: string };
  assert.equal(coco.name, 'Coco');
  assert.deepEqual(Object.keys(JSON.parse(coco.channels)), ['web']);
  assert.equal(JSON.parse(coco.heartbeat).schedule, '0 9 * * *');

  // Context: shared markdown plus per-agent markdown, no .txt.
  assert.deepEqual(report.contextFiles.sort(), [
    'agent:coco/HEARTBEAT.md',
    'agent:coco/IDENTITY.md',
    'shared:AGENTS.md',
    'shared:USER.md',
  ]);
  const shared = db
    .prepare(
      "SELECT content FROM context_files WHERE scope = 'shared' AND name = 'AGENTS.md'",
    )
    .get() as { content: string };
  assert.equal(shared.content, '# Agents\n');

  // Skills: dot-entries skipped, modes preserved, source_path from the meta file.
  assert.deepEqual(
    report.skills.map((s) => s.name),
    ['demo'],
  );
  assert.ok(report.errors.some((e) => e.source === 'skills/no-manifest'));
  const files = db
    .prepare(
      'SELECT relpath, mode FROM skill_files WHERE skill = ? ORDER BY relpath',
    )
    .all('demo') as { relpath: string; mode: number }[];
  assert.deepEqual(
    files.map((f) => f.relpath),
    ['SKILL.md', 'lib/helper.py', 'render.sh'],
  );
  assert.equal(files.find((f) => f.relpath === 'render.sh')!.mode, 0o755);
  assert.equal(files.find((f) => f.relpath === 'SKILL.md')!.mode & 0o111, 0);
  const skill = db
    .prepare('SELECT description, source_path FROM skills WHERE name = ?')
    .get('demo') as { description: string; source_path: string };
  assert.equal(skill.description, 'A demo skill');
  assert.equal(skill.source_path, '/tmp/my-skills/demo/SKILL.md');
  assert.deepEqual(report.skillSources, ['/tmp/my-skills']);

  // MCP servers keep ${VAR} verbatim; catalog stored whole.
  assert.deepEqual(report.mcpServers, ['notion']);
  const mcp = db
    .prepare('SELECT config, enabled FROM mcp_servers WHERE name = ?')
    .get('notion') as { config: string; enabled: number };
  assert.equal(mcp.enabled, 1);
  assert.equal(JSON.parse(mcp.config).env.T, '${NOTION_API_KEY}');
  assert.equal(report.modelCatalog, true);

  // Workflows: the valid one lands, the broken one is reported.
  assert.deepEqual(report.workflows, ['reminder']);
  assert.ok(report.errors.some((e) => e.source === 'workflows/broken.json'));
  const wf = db
    .prepare('SELECT definition FROM workflow_definitions WHERE slug = ?')
    .get('reminder') as { definition: string };
  assert.equal(JSON.parse(wf.definition).name, 'Reminder');

  // Detection covers the git repo and the 0-byte orphan.
  for (const rel of ['.env', '.git', '.gitignore', 'messages.db', 'skills']) {
    assert.ok(report.detected.includes(rel), rel);
  }

  // Model + password + Claude auth were all present.
  assert.equal(report.onboarded, true);
  assert.equal(isOnboarded(), true);
});

test('keep-files leaves the tree alone but still reports the moves', () => {
  assert.equal(report.keepFiles, true);
  assert.equal(report.legacyDir, null);
  assert.deepEqual(
    report.movedRuntimeFiles.map((m) => path.basename(m.from)),
    ['pipeline.json'],
  );
  assert.ok(fs.existsSync(path.join(home, 'agents', 'coco', 'pipeline.json')));
  assert.ok(fs.existsSync(path.join(home, '.env')));
  assert.ok(fs.existsSync(path.join(home, '.git')));
});

test('a second run imports nothing', () => {
  const again = importLegacyFs({ home });
  assert.deepEqual(again.settings, []);
  assert.deepEqual(again.agents, []);
  assert.deepEqual(again.contextFiles, []);
  assert.deepEqual(again.skills, []);
  assert.deepEqual(again.skillSources, []);
  assert.deepEqual(again.mcpServers, []);
  assert.deepEqual(again.workflows, []);
  assert.equal(again.modelCatalog, false);
  assert.equal(again.passwordSet, false);
});

// Runs last: it repoints the shared connection at a second temp home.
test('without keep-files the legacy tree is moved aside, never deleted', () => {
  fs.mkdirSync(path.join(retireHome, 'agents', 'coco'), { recursive: true });
  fs.writeFileSync(path.join(retireHome, '.env'), 'ASSISTANT_NAME=Andy\n');
  fs.writeFileSync(
    path.join(retireHome, 'agents', 'coco', 'IDENTITY.md'),
    '# Coco\n',
  );
  fs.writeFileSync(
    path.join(retireHome, 'agents', 'coco', 'pipeline.json'),
    '{"cursor":1}',
  );
  fs.mkdirSync(path.join(retireHome, '.git'), { recursive: true });

  const moved = importLegacyFs({ home: retireHome, keepFiles: false });
  assert.ok(moved.legacyDir);
  assert.equal(path.basename(moved.legacyDir!).startsWith('legacy-'), true);

  // Runtime state landed under var/, the rest under legacy-*, nothing removed.
  assert.ok(
    fs.existsSync(
      path.join(retireHome, 'var', 'agents', 'coco', 'pipeline.json'),
    ),
  );
  assert.ok(!fs.existsSync(path.join(retireHome, '.env')));
  assert.ok(!fs.existsSync(path.join(retireHome, 'agents')));
  assert.ok(fs.existsSync(path.join(moved.legacyDir!, '.env')));
  assert.ok(fs.existsSync(path.join(moved.legacyDir!, '.git')));
  assert.ok(
    fs.existsSync(path.join(moved.legacyDir!, 'agents', 'coco', 'IDENTITY.md')),
  );
  assert.equal(getSetting('bearclaw.legacy_dir'), moved.legacyDir);
});
