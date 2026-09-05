import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  LAUNCH_AGENT_LABELS,
  machineEnv,
  renderPlist,
  writeLaunchAgents,
} from './plist.js';
import { PROJECT_ROOT } from './templates.js';

const VARS = {
  NODE_PATH: '/opt/homebrew/bin/node',
  PROJECT_ROOT: '/Users/someone/bearclaw',
  HOME: '/Users/someone',
};

const tmpDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bearclaw-plist-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('renderPlist', () => {
  it('leaves no placeholders in either template', () => {
    for (const label of LAUNCH_AGENT_LABELS) {
      const template = fs.readFileSync(
        path.join(PROJECT_ROOT, 'launchd', `${label}.plist`),
        'utf-8',
      );
      const out = renderPlist(template, VARS);
      assert.equal(
        out.includes('{{'),
        false,
        `${label} still has placeholders`,
      );
      assert.ok(out.includes(VARS.NODE_PATH));
      assert.ok(out.includes(`${VARS.PROJECT_ROOT}/logs/`));
    }
  });

  it('never sets ASSISTANT_NAME, which would override the database', () => {
    for (const label of LAUNCH_AGENT_LABELS) {
      const template = fs.readFileSync(
        path.join(PROJECT_ROOT, 'launchd', `${label}.plist`),
        'utf-8',
      );
      assert.equal(template.includes('ASSISTANT_NAME'), false);
      assert.equal(
        renderPlist(template, VARS).includes('ASSISTANT_NAME'),
        false,
      );
    }
  });

  it('injects extra environment entries into the dict', () => {
    const template = fs.readFileSync(
      path.join(PROJECT_ROOT, 'launchd', 'com.bearclaw.plist'),
      'utf-8',
    );
    const out = renderPlist(template, {
      ...VARS,
      extraEnv: { BEARCLAW_HOME: '/srv/bearclaw' },
    });
    assert.ok(out.includes('<key>BEARCLAW_HOME</key>'));
    assert.ok(out.includes('<string>/srv/bearclaw</string>'));
    assert.ok(
      out.indexOf('BEARCLAW_HOME') > out.indexOf('EnvironmentVariables'),
    );
    assert.ok(out.indexOf('BEARCLAW_HOME') < out.indexOf('StandardOutPath'));
  });
});

describe('machineEnv', () => {
  it('is empty for the default home', () => {
    const previous = process.env.BEARCLAW_HOME;
    delete process.env.BEARCLAW_HOME;
    try {
      assert.deepEqual(machineEnv('/Users/someone'), {});
      process.env.BEARCLAW_HOME = '/Users/someone/.bearclaw';
      assert.deepEqual(machineEnv('/Users/someone'), {});
    } finally {
      if (previous === undefined) delete process.env.BEARCLAW_HOME;
      else process.env.BEARCLAW_HOME = previous;
    }
  });

  it('carries a custom home', () => {
    const previous = process.env.BEARCLAW_HOME;
    process.env.BEARCLAW_HOME = '/srv/bearclaw';
    try {
      assert.deepEqual(machineEnv('/Users/someone'), {
        BEARCLAW_HOME: '/srv/bearclaw',
      });
    } finally {
      if (previous === undefined) delete process.env.BEARCLAW_HOME;
      else process.env.BEARCLAW_HOME = previous;
    }
  });
});

describe('writeLaunchAgents', () => {
  it('writes both plists into the target directory', () => {
    const target = tempDir();
    const agents = writeLaunchAgents({
      targetDir: target,
      nodePath: VARS.NODE_PATH,
      home: VARS.HOME,
      extraEnv: {},
    });
    assert.equal(agents.length, 2);
    for (const agent of agents) {
      const text = fs.readFileSync(agent.target, 'utf-8');
      assert.equal(text.includes('{{'), false);
      assert.ok(text.includes(`<string>${agent.label}</string>`));
    }
  });
});
