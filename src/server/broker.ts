import { EventEmitter } from 'node:events';

// Web channel broker — fan-out of channel outbound events to SSE subscribers.
// Events are JSON-serializable so the HTTP layer can stream them verbatim.
export type WebOutboundEvent =
  | { type: 'message'; jid: string; id: number; text: string; ts: number }
  | {
      type: 'user';
      jid: string;
      text: string;
      ts: number;
      clientId?: string;
    }
  | { type: 'edit'; jid: string; id: number; text: string; ts: number }
  | { type: 'delete'; jid: string; id: number }
  | { type: 'typing'; jid: string; isTyping: boolean }
  | { type: 'activity'; jid: string; label: string | null }
  | {
      type: 'media';
      jid: string;
      id: number;
      mediaType: string;
      caption?: string;
      dataUrl?: string;
      url?: string;
      ts: number;
    };

// Workflow module events. Same broker, separate topic, so the web UI holds one
// SSE connection per module rather than one per run.
export type WorkflowStreamEvent =
  | {
      type: 'run.status';
      runId: string;
      slug: string;
      status: string;
      ts: number;
    }
  | {
      type: 'step.status';
      runId: string;
      slug: string;
      nodeId: string;
      status: string;
      port?: string | null;
      ts: number;
    }
  | {
      type: 'wait.opened';
      runId: string;
      slug: string;
      nodeId: string;
      waitId: string;
      ts: number;
    }
  | {
      type: 'wait.resolved';
      runId: string;
      slug: string;
      nodeId: string;
      waitId: string;
      via: string;
      ts: number;
    }
  | { type: 'workflow.changed'; slug: string; ts: number };

class Broker extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  publish(jid: string, evt: WebOutboundEvent): void {
    this.emit(`out:${jid}`, evt);
    this.emit('out:*', evt);
  }

  publishWorkflow(evt: WorkflowStreamEvent): void {
    this.emit('wf:*', evt);
  }
}

export const webBroker = new Broker();
