import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CONTEXT_TEMPLATES,
  IDENTITY_TEMPLATE,
  TEMPLATES_DIR,
  loadContextTemplate,
  loadTemplate,
  substitute,
} from './templates.js';

describe('templates', () => {
  it('resolves the templates directory from this module', () => {
    assert.ok(fs.existsSync(TEMPLATES_DIR), TEMPLATES_DIR);
  });

  it('loads all five starter documents', () => {
    const loaded = [
      ...CONTEXT_TEMPLATES.map((name) =>
        loadContextTemplate(name, { ASSISTANT_NAME: 'Rue' }),
      ),
      loadTemplate(IDENTITY_TEMPLATE, { ASSISTANT_NAME: 'Rue' }),
    ];
    assert.equal(loaded.length, 5);
    for (const text of loaded) {
      assert.ok(text.trim().startsWith('#'));
      assert.equal(text.includes('{{'), false);
    }
  });

  it('substitutes the assistant name where it appears', () => {
    const identity = loadTemplate(IDENTITY_TEMPLATE, {
      ASSISTANT_NAME: 'Rue',
    });
    assert.ok(identity.includes('Rue'));
    assert.ok(
      loadContextTemplate('USER.md', { ASSISTANT_NAME: 'Rue' }).includes('Rue'),
    );
  });

  it('leaves unknown placeholders alone', () => {
    assert.equal(substitute('{{A}} {{B}}', { A: 'x' }), 'x {{B}}');
  });

  it('every placeholder in the shipped templates is one setup fills in', () => {
    const files = [
      ...CONTEXT_TEMPLATES.map((n) => path.join('context', n)),
      IDENTITY_TEMPLATE,
    ];
    for (const rel of files) {
      const raw = fs.readFileSync(path.join(TEMPLATES_DIR, rel), 'utf-8');
      for (const match of raw.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) {
        assert.equal(match[1], 'ASSISTANT_NAME', `${rel}: ${match[0]}`);
      }
    }
  });
});
