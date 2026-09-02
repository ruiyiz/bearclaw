import type { Executor } from '../runtime.js';
import type { NodeType } from '../schema.js';
import { agentExecutor } from './agent.js';
import { httpExecutor } from './http.js';
import {
  conditionExecutor,
  delayExecutor,
  emitExecutor,
  switchExecutor,
  templateExecutor,
  transformExecutor,
} from './pure.js';
import { sendExecutor } from './send.js';
import { shellExecutor } from './shell.js';
import { humanExecutor, waitEventExecutor } from './waits.js';

export const executors: Record<NodeType, Executor> = {
  agent: agentExecutor,
  shell: shellExecutor,
  http: httpExecutor,
  template: templateExecutor,
  transform: transformExecutor,
  condition: conditionExecutor,
  switch: switchExecutor,
  send: sendExecutor,
  human: humanExecutor,
  wait_event: waitEventExecutor,
  emit: emitExecutor,
  delay: delayExecutor,
};
