import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  baseAddress,
  emailFolderJid,
  emailThreadJid,
  firstLineSubject,
  hasPlusTag,
  isEmailJid,
  mdToHtml,
  parseEmailJid,
} from './email.js';

test('email jid synthesis and parsing round-trip', () => {
  assert.equal(emailFolderJid('coco'), 'email:coco');
  assert.equal(emailThreadJid('coco', '19de41b'), 'email:coco:19de41b');
  assert.deepEqual(parseEmailJid('email:coco'), { folder: 'coco' });
  assert.deepEqual(parseEmailJid('email:coco:19de41b'), {
    folder: 'coco',
    threadId: '19de41b',
  });
  assert.ok(isEmailJid('email:coco:1'));
  assert.ok(!isEmailJid('web:coco:1'));
});

test('baseAddress strips the +tag, leaves untagged addresses alone', () => {
  assert.equal(
    baseAddress('ruiyizhang+coco@gmail.com'),
    'ruiyizhang@gmail.com',
  );
  assert.equal(baseAddress('plain@gmail.com'), 'plain@gmail.com');
});

test('hasPlusTag validates plus-addressing', () => {
  assert.ok(hasPlusTag('ruiyizhang+coco@gmail.com'));
  assert.ok(!hasPlusTag('plain@gmail.com'));
  assert.ok(!hasPlusTag('trailing+@gmail.com'));
});

test('firstLineSubject takes the first non-empty line, strips heading marks, truncates', () => {
  assert.equal(firstLineSubject('\n\n# Hello there\nbody'), 'Hello there');
  assert.equal(firstLineSubject('   \nplain line'), 'plain line');
  assert.equal(firstLineSubject(''), '(no subject)');
  const long = 'x'.repeat(200);
  const s = firstLineSubject(long);
  assert.equal(s.length, 118); // 117 chars + ellipsis
  assert.ok(s.endsWith('…'));
});

test('mdToHtml renders markdown synchronously to an HTML fragment', () => {
  const html = mdToHtml('**bold** and a [link](https://x.com)');
  assert.equal(typeof html, 'string');
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('href="https://x.com"'));
});
