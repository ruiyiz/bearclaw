import { EventEmitter } from 'node:events';

// Web channel broker — fan-out of channel outbound events to SSE subscribers.
// Events are JSON-serializable so the HTTP layer can stream them verbatim.
export type WebOutboundEvent =
  | { type: 'message'; jid: string; id: number; text: string }
  | { type: 'edit'; jid: string; id: number; text: string }
  | { type: 'delete'; jid: string; id: number }
  | { type: 'typing'; jid: string; isTyping: boolean }
  | {
      type: 'media';
      jid: string;
      id: number;
      mediaType: string;
      caption?: string;
      dataUrl?: string;
      url?: string;
    };

class Broker extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  publish(jid: string, evt: WebOutboundEvent): void {
    this.emit(`out:${jid}`, evt);
    this.emit('out:*', evt);
  }
}

export const webBroker = new Broker();
