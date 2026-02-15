#!/usr/bin/env node
import { program } from 'commander';
import { render } from 'ink';
import React from 'react';

import { App } from './app.js';

program
  .name('nanoclaw')
  .description('NanoClaw — personal Claude assistant')
  .version('1.0.0');

program
  .command('tui')
  .description('Open the management TUI')
  .action(() => {
    const instance = render(React.createElement(App), { exitOnCtrlC: false });
    instance.waitUntilExit().then(() => {
      process.stdout.write('\x1B[2J\x1B[H');
    });
  });

program.parse();
