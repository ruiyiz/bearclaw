import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';

const { closeConfigDb, initConfigDb } = await import('../store/config-db.js');
initConfigDb(':memory:');
const { deleteMcpServer, putMcpServer, setMcpServerEnabled } =
  await import('../store/mcp.js');
const { loadUserMcpServers } = await import('./mcp-config.js');

after(() => closeConfigDb());

test('no rows means no servers', () => {
  assert.deepEqual(loadUserMcpServers(), {});
});

test('enabled rows become mcpServers entries', () => {
  putMcpServer('notes', { command: 'notes-mcp', args: ['--stdio'] });
  putMcpServer('remote', { url: 'https://example.test/mcp' });
  assert.deepEqual(loadUserMcpServers(), {
    notes: { command: 'notes-mcp', args: ['--stdio'] },
    remote: { url: 'https://example.test/mcp' },
  });
  deleteMcpServer('notes');
  deleteMcpServer('remote');
});

test('${VAR} placeholders expand from the environment', () => {
  process.env.MCP_TEST_TOKEN = 's3cret';
  putMcpServer('tokened', {
    command: 'x',
    env: { TOKEN: '${MCP_TEST_TOKEN}' },
    args: ['--who', 'Bearer ${MCP_TEST_TOKEN}'],
  });
  assert.deepEqual(loadUserMcpServers().tokened, {
    command: 'x',
    env: { TOKEN: 's3cret' },
    args: ['--who', 'Bearer s3cret'],
  });

  // A placeholder with no env var expands to the empty string rather than
  // failing the whole load.
  delete process.env.MCP_TEST_TOKEN;
  assert.deepEqual(loadUserMcpServers().tokened, {
    command: 'x',
    env: { TOKEN: '' },
    args: ['--who', 'Bearer '],
  });
  deleteMcpServer('tokened');
});

test('disabled rows are skipped', () => {
  putMcpServer('on', { command: 'on' });
  putMcpServer('off', { command: 'off' }, { enabled: false });
  assert.deepEqual(Object.keys(loadUserMcpServers()), ['on']);

  setMcpServerEnabled('on', false);
  setMcpServerEnabled('off', true);
  assert.deepEqual(Object.keys(loadUserMcpServers()), ['off']);
});
