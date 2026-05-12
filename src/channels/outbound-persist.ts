import {
  deleteMessageById,
  storeMessage,
  updateMessageContent,
} from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  MediaOptions,
  MediaSource,
  MediaType,
  RegisteredAgent,
} from '../types.js';

// Persist agent-originated outbound messages back to the `messages` table so
// the channel log is symmetric with inbound. Wraps a Channel's send/edit/
// delete/sendMedia/sendAsAgent methods; the wrapped channel still does its
// transport work first, then we mirror the result into SQLite.
//
// `is_from_me=1` marks the row as agent-side. Persistence failures are logged
// but never swallowed; we never throw from the wrapper since the message was
// already delivered to the remote channel.

type AgentNameLookup = (jid: string) => string;

const MEDIA_TYPE_TAG: Record<MediaType, string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
};

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function buildMediaContent(
  type: MediaType,
  source: MediaSource,
  options?: MediaOptions,
): string | null {
  const tag = MEDIA_TYPE_TAG[type];
  const captionPart = options?.caption ? ` ${options.caption}` : '';
  // Prefer an explicit URL/path; fall back to file name; skip silently when
  // neither is present (no useful tag content to record).
  const ref = source.url || options?.fileName || null;
  if (!ref) return null;
  return `[${tag}: ${ref}]${captionPart}`;
}

export function attachOutboundPersistence(
  ch: Channel,
  getRegisteredAgents: () => Record<string, RegisteredAgent>,
): void {
  const channelName = ch.name;

  const agentNameFor: AgentNameLookup = (jid) => {
    const reg = getRegisteredAgents()[jid];
    return reg?.name || jid;
  };

  const dbId = (jid: string, nativeId: number | string): string =>
    `${channelName}-out-${jid}-${nativeId}`;

  const randomId = (): string =>
    `${channelName}-out-${Date.now()}-${randomSuffix()}`;

  const persist = (
    id: string,
    jid: string,
    content: string,
    senderName: string,
  ): void => {
    try {
      storeMessage(
        {
          id,
          chat_jid: jid,
          sender: jid,
          sender_name: senderName,
          content,
          timestamp: new Date().toISOString(),
        },
        1,
      );
    } catch (err) {
      logger.warn(
        { err, jid, channel: channelName },
        'outbound persist failed',
      );
    }
  };

  const origSendMessage = ch.sendMessage.bind(ch);
  ch.sendMessage = async (jid, text) => {
    await origSendMessage(jid, text);
    persist(randomId(), jid, text, agentNameFor(jid));
  };

  if (ch.sendMessageWithId) {
    const orig = ch.sendMessageWithId.bind(ch);
    ch.sendMessageWithId = async (jid, text) => {
      const nativeId = await orig(jid, text);
      persist(dbId(jid, nativeId), jid, text, agentNameFor(jid));
      return nativeId;
    };
  }

  if (ch.editMessage) {
    const orig = ch.editMessage.bind(ch);
    ch.editMessage = async (jid, nativeId, text) => {
      await orig(jid, nativeId, text);
      try {
        updateMessageContent(dbId(jid, nativeId), jid, text);
      } catch (err) {
        logger.warn(
          { err, jid, channel: channelName },
          'outbound edit persist failed',
        );
      }
    };
  }

  if (ch.deleteMessage) {
    const orig = ch.deleteMessage.bind(ch);
    ch.deleteMessage = async (jid, nativeId) => {
      await orig(jid, nativeId);
      try {
        deleteMessageById(dbId(jid, nativeId), jid);
      } catch (err) {
        logger.warn(
          { err, jid, channel: channelName },
          'outbound delete persist failed',
        );
      }
    };
  }

  if (ch.sendMedia) {
    const orig = ch.sendMedia.bind(ch);
    ch.sendMedia = async (jid, type, source, options) => {
      await orig(jid, type, source, options);
      const content = buildMediaContent(type, source, options);
      if (content) persist(randomId(), jid, content, agentNameFor(jid));
    };
  }

  if (ch.sendAsAgent) {
    const orig = ch.sendAsAgent.bind(ch);
    ch.sendAsAgent = async (jid, text, agentName, agentFolder) => {
      await orig(jid, text, agentName, agentFolder);
      persist(randomId(), jid, text, agentName);
    };
  }

  if (ch.sendMediaAsAgent) {
    const orig = ch.sendMediaAsAgent.bind(ch);
    ch.sendMediaAsAgent = async (
      jid,
      type,
      source,
      options,
      agentName,
      agentFolder,
    ) => {
      await orig(jid, type, source, options, agentName, agentFolder);
      const content = buildMediaContent(type, source, options);
      if (content) persist(randomId(), jid, content, agentName);
    };
  }
}
