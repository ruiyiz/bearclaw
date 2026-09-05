import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  StartableChannel,
  TelegramChannel,
  startTelegramChannel,
} from './telegram.js';

function stubChannel(connect: () => Promise<void>): StartableChannel & {
  disconnects: number;
} {
  return {
    disconnects: 0,
    connect,
    async disconnect() {
      this.disconnects++;
    },
  };
}

test('a channel that connects is reported as started', async () => {
  const channel = stubChannel(async () => {});
  assert.equal(await startTelegramChannel(channel), true);
  assert.equal(channel.disconnects, 0);
});

test('a failed start is swallowed so the boot continues', async () => {
  // What a wrong TELEGRAM_BOT_TOKEN looks like: grammY answers getMe with 401
  // and rejects the start.
  const channel = stubChannel(async () => {
    throw new Error('401: Unauthorized');
  });
  assert.equal(await startTelegramChannel(channel, ['pool-token']), false);
  // Torn down rather than left half-wired, and the pool was never touched.
  assert.equal(channel.disconnects, 1);
});

test('a failed start survives a failing disconnect', async () => {
  const channel: StartableChannel = {
    async connect() {
      throw new Error('401: Unauthorized');
    },
    async disconnect() {
      throw new Error('bot is not running');
    },
  };
  assert.equal(await startTelegramChannel(channel), false);
});

test('an unusable token rejects connect instead of crashing the process', async () => {
  // grammY refuses the empty token in its constructor, which is the one bad
  // token that needs no network to reject. The guard has to catch it.
  const telegram = new TelegramChannel('', {
    onMessage: async () => {},
    onChatMetadata: () => {},
    registeredAgents: () => ({}),
  });
  await assert.rejects(() => telegram.connect());
  assert.equal(telegram.isConnected(), false);
  assert.equal(await startTelegramChannel(telegram), false);
});
