import { useRef, useState } from 'react';
import { useAgUiRuntime, type AgUiAssistantRuntime } from '@assistant-ui/react-ag-ui';
import { FleetAgUiAgent } from './FleetAgUiAgent';

export interface FleetAgUiOptions {
  orgId: string;
  projectId: string;
  /**
   * THIS conversation's thread handle. On this wire it is the only conversation
   * identity the client owns — kagent's context id stays behind the facade — so
   * the BFF resolves a session by it (sessions.thread_id), and a new chat must
   * mean a new value rather than a reset one.
   */
  threadId: string;
  model: string;
  onError: (error: Error) => void;
}

export function newThreadId(): string {
  return globalThis.crypto.randomUUID();
}

// The runtime is built for ONE conversation. useAgUiRuntime creates its thread
// controller on the first render and never rebuilds it: changing the `agent`
// option rebinds the agent but leaves the transcript in place. So the caller
// mounts this hook from a subtree keyed by the conversation (see Thread.tsx),
// which is what makes "New chat" and "resume" start from an empty transcript
// instead of the previous one.
export function useFleetAgUi(options: FleetAgUiOptions): AgUiAssistantRuntime {
  const { orgId, projectId, threadId } = options;

  // Read at run time, so the model selector never rebuilds the agent — the
  // controller holds the agent identity it was given, and a new one mid-run
  // would silently be the start of a different conversation.
  const modelRef = useRef(options.model);
  modelRef.current = options.model;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;

  const [agent] = useState(
    () => new FleetAgUiAgent({ orgId, projectId, threadId, model: () => modelRef.current || undefined }),
  );

  return useAgUiRuntime({
    agent,
    // What the run endpoint said before it sent a single event: an expired
    // session, an unknown model, a run input it refused to parse.
    onError: (error) => onErrorRef.current(error),
  });
}
