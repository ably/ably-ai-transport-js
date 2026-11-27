/**
 * Usage reporting: tells Ably which adaptor and which release of this SDK an
 * agent runs, through the Ably-Agent string that Ably's analytics already
 * count.
 *
 * An adaptor only publishes, appends and updates, and a publish does not
 * attach the channel, so an agent sends no attach that could carry the
 * string. Instead, on its first write the adaptor adds its agents to the
 * channel's client options and sends one `/time` request, which carries the
 * client's Ably-Agent header. The agents stay on the client, so its later
 * requests and connections carry them too, and a client that already carries
 * them sends no second request.
 *
 * This reads `client`, an ably-js internal, off the channel. A channel
 * without a client that looks like ably-js's (a test double, a wrapper) is
 * written to as usual and nothing is reported.
 */

import { type Logger } from '../../logger.js';
import { errorMessage } from '../../utils.js';
import { VERSION } from '../../version.js';
import type { ChannelWriter } from './message-stream.js';

/** The Ably-Agent identifier of this SDK, as registered in ably-common's `agents.json`. */
export const SDK_AGENT = 'ai-transport-js';

/** The part of an ably-js client the report uses. */
interface AgentClient {
  options: { agents?: Record<string, string | boolean | undefined> };
  time(): Promise<number>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * The ably-js client behind a channel, if the channel has one.
 * @param channel - The channel the adaptor writes to.
 * @returns The client, or `undefined` when the channel has none that looks like ably-js's.
 */
const clientOf = (channel: ChannelWriter): AgentClient | undefined => {
  // CAST: `client` is an ably-js internal the public channel type does not name; its shape is checked below.
  const client = (channel as { client?: unknown }).client;
  if (!isObject(client) || typeof client.time !== 'function' || !isObject(client.options)) return undefined;
  const { agents } = client.options;
  if (agents !== undefined && !isObject(agents)) return undefined;
  // CAST: checked above: `time` is a function, and `options.agents` is absent or an object.
  return client as unknown as AgentClient;
};

/**
 * Send one `/time` request carrying the agents. Best-effort: a failed request
 * is logged and dropped, since it affects nothing the agent writes.
 * @param client - The client.
 * @param logger - The adaptor's logger.
 */
const sendTime = async (client: AgentClient, logger: Logger): Promise<void> => {
  try {
    await client.time();
    logger.debug('reportUsage(); reported');
  } catch (error) {
    logger.warn('reportUsage(); time request failed', { error: errorMessage(error) });
  }
};

/**
 * Add this SDK's agent and the adaptor's to the channel's client, and send
 * the `/time` request that reports them, unless the client already carries
 * both.
 * @param channel - The channel the adaptor writes to.
 * @param adaptorAgent - The adaptor's Ably-Agent identifier.
 * @param logger - The adaptor's logger.
 */
const reportUsage = (channel: ChannelWriter, adaptorAgent: string, logger: Logger): void => {
  logger.trace('reportUsage();', { adaptorAgent });
  const client = clientOf(channel);
  if (client === undefined) {
    logger.debug('reportUsage(); the channel has no client to report through');
    return;
  }
  const agents = client.options.agents ?? {};
  if (agents[SDK_AGENT] === VERSION && adaptorAgent in agents) {
    logger.debug('reportUsage(); the client already carries the agents');
    return;
  }
  client.options.agents = { ...agents, [SDK_AGENT]: VERSION, [adaptorAgent]: undefined };
  // Fire-and-forget: the write that triggered the report must not wait on an
  // extra HTTP request, and sendTime logs its own failure.
  void sendTime(client, logger);
};

/**
 * Wrap a channel so the first write through it reports usage once.
 * @param channel - The channel the adaptor writes to.
 * @param adaptorAgent - The adaptor's Ably-Agent identifier.
 * @param logger - The adaptor's logger.
 * @returns A channel that writes through to `channel`.
 */
export const withUsageReport = (channel: ChannelWriter, adaptorAgent: string, logger: Logger): ChannelWriter => {
  let reported = false;
  const reportOnce = (): void => {
    if (reported) return;
    reported = true;
    reportUsage(channel, adaptorAgent, logger);
  };
  return {
    publish: async (message) => {
      reportOnce();
      return channel.publish(message);
    },
    appendMessage: async (message) => {
      reportOnce();
      return channel.appendMessage(message);
    },
    updateMessage: async (message) => {
      reportOnce();
      return channel.updateMessage(message);
    },
    ...(channel.getMessage === undefined ? {} : { getMessage: channel.getMessage.bind(channel) }),
  };
};
