import { useRef, useState } from 'react';
import type { AssistantRuntime } from '@assistant-ui/react';
import { useA2ARuntime } from '@assistant-ui/react-a2a';
import { FleetA2AClient, facadeBase } from './FleetA2AClient';

export interface FleetA2AOptions {
  orgId: string;
  projectId: string;
  /** Identifies THIS conversation to the runtime: a new value rebuilds the client,
   *  which is what clears the transcript and drops the old context id. */
  conversationKey: string;
  /** The A2A context id to resume, if this conversation already has one. */
  contextId?: string;
  model: string;
  onError: (error: Error) => void;
}

// useA2ARuntime rebuilds its controller whenever the client object identity
// changes, and the controller holds the transcript. A client constructed inline
// is therefore a new conversation on every render: the messages never settle.
// The client is pinned here by conversationKey instead, exactly as the library
// pins its own internally-created client.
export function useFleetA2A(options: FleetA2AOptions): AssistantRuntime {
  const { orgId, projectId, conversationKey, contextId } = options;

  const modelRef = useRef(options.model);
  modelRef.current = options.model;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;

  const baseUrl = facadeBase(orgId, projectId);
  const key = `${orgId}:${projectId}:${conversationKey}`;
  const create = () => new FleetA2AClient({ baseUrl, model: () => modelRef.current || undefined });

  const [pinned, setPinned] = useState(() => ({ key, client: create() }));
  let current = pinned;
  if (pinned.key !== key) {
    current = { key, client: create() };
    setPinned(current);
  }

  return useA2ARuntime({
    client: current.client,
    contextId,
    onError: (error) => onErrorRef.current(error),
  });
}
