import {
  A2AClient,
  type A2AClientOptions,
  type A2AMessage,
  type A2ASendMessageConfiguration,
  type A2AStreamEvent,
  type A2ATask,
} from '@assistant-ui/react-a2a';

// Mirrors MODEL_METADATA_KEY in packages/shared/src/a2a.ts. An A2A Message has no
// field for "which model", so the choice rides on message metadata and the facade
// consumes it before kagent ever sees it. If the two spellings drift, the facade
// silently falls back to the default model instead of failing loudly.
const MODEL_METADATA_KEY = 'fleet.dev/model';

// Mirrors a2aFacadeBase() in packages/shared/src/a2a.ts. The project scope has to
// live inside baseUrl because the client derives the agent-card URL from baseUrl
// alone — basePath and tenant are not applied to discovery.
export function facadeBase(orgId: string, projectId: string): string {
  return `${window.location.origin.replace(/\/+$/, '')}/api/a2a/orgs/${orgId}/projects/${projectId}`;
}

export interface FleetClientOptions extends A2AClientOptions {
  /** Read at send time, so changing the model selector never rebuilds the client. */
  model: () => string | undefined;
}

// The library calls streamMessage(message, configuration, metadata, signal) with
// metadata deliberately empty, so per-message metadata is the only place this
// client can put the model without touching the library.
export class FleetA2AClient extends A2AClient {
  private readonly model: () => string | undefined;

  constructor(options: FleetClientOptions) {
    // headers pass through for callers outside the browser (the live gate has no
    // cookie jar, so it must name the session cookie itself).
    super(options);
    this.model = options.model;
  }

  private withModel(message: A2AMessage): A2AMessage {
    const model = this.model();
    if (!model) return message;
    return { ...message, metadata: { ...message.metadata, [MODEL_METADATA_KEY]: model } };
  }

  override sendMessage(
    message: A2AMessage,
    configuration?: A2ASendMessageConfiguration,
    metadata?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<A2ATask | A2AMessage> {
    return super.sendMessage(this.withModel(message), configuration, metadata, signal);
  }

  override streamMessage(
    message: A2AMessage,
    configuration?: A2ASendMessageConfiguration,
    metadata?: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<A2AStreamEvent> {
    return super.streamMessage(this.withModel(message), configuration, metadata, signal);
  }
}
