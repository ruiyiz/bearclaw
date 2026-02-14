#!/usr/bin/env node
import { program } from 'commander';
import { render } from 'ink';
import React from 'react';

import { App } from './app.js';

program
  .name('nanoclaw')
  .description('NanoClaw management TUI')
  .version('1.0.0')
  .action(() => {
    render(React.createElement(App), { exitOnCtrlC: false });
  });

program.parse();
