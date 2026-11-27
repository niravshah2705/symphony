// The structured half of a paused run. When kagent pauses on input-required it
// attaches a typed payload (go/api/a2a/hitl.go): a set of tool calls awaiting a
// yes/no, or questions with fixed choices. The BFF carries that payload on the
// interrupt's metadata, so this card renders the decision the harness actually
// asked for instead of a textbox, and the answer goes back as the declared
// HITL extension the controller parses.

import { useState } from 'react';
import type { FC } from 'react';
import { useAgUiInterrupts, useAgUiSubmitInterruptResponses } from '@assistant-ui/react-ag-ui';

// Byte-identical to packages/shared/src/a2a.ts (the same local-spelling choice
// as FleetAgUiAgent.ts: the SPA does not import the shared package's .ts source).
const HITL_TYPE_TOOL_APPROVAL_REQUEST = 'tool_approval_request';
const HITL_TYPE_ASK_USER_REQUEST = 'ask_user_request';

interface HitlTool {
  id: string;
  call_id: string;
  name: string;
  args?: Record<string, unknown>;
}

interface HitlToolApprovalRequest {
  type: string;
  hint?: string;
  tools: HitlTool[];
  nested?: { tools: HitlTool[] };
}

interface HitlQuestion {
  question: string;
  choices: string[];
  multiple: boolean;
}

interface HitlAskUserRequest {
  type: string;
  id: string;
  questions: HitlQuestion[];
}

export interface HitlCardProps {
  onAnswerError?: (message: string) => void;
}

export const HitlCard: FC<HitlCardProps> = ({ onAnswerError }) => {
  const pending = useAgUiInterrupts()[0];
  const hitl = (pending?.metadata as { hitl?: Record<string, unknown> } | undefined)?.hitl;
  if (!pending || !hitl) return null;
  // Keyed by the interrupt so selections from a question that was already
  // answered can never ride into the next one.
  if (hitl.type === HITL_TYPE_TOOL_APPROVAL_REQUEST) {
    return <ToolApproval key={pending.id} request={hitl as unknown as HitlToolApprovalRequest} interruptId={pending.id} onAnswerError={onAnswerError} />;
  }
  if (hitl.type === HITL_TYPE_ASK_USER_REQUEST) {
    return <AskUser key={pending.id} request={hitl as unknown as HitlAskUserRequest} interruptId={pending.id} onAnswerError={onAnswerError} />;
  }
  return null;
};

type ErrorSink = { onAnswerError?: (message: string) => void };

function useSubmitGuard({ onAnswerError }: ErrorSink) {
  const submit = useAgUiSubmitInterruptResponses();
  return async (payload: unknown): Promise<boolean> => {
    try {
      await submit(payload as Parameters<typeof submit>[0]);
      return true;
    } catch (err) {
      onAnswerError?.(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
}

const ToolApproval: FC<{ request: HitlToolApprovalRequest; interruptId: string } & ErrorSink> = ({ request, interruptId, onAnswerError }) => {
  // A nested request (from a child agent) decides the child's tools, and kagent
  // validates the response against exactly that list (hitl.go ValidateToolApprovalResponse).
  const tools = request.nested?.tools ?? request.tools ?? [];
  const [decisions, setDecisions] = useState<(boolean | undefined)[]>(() => tools.map(() => undefined));
  const send = useSubmitGuard({ onAnswerError });
  const decided = decisions.every((decision) => decision !== undefined);

  async function respond(all: boolean) {
    const approvals = tools.map((tool, index) => ({
      id: tool.id,
      approved: decisions[index] ?? all,
    }));
    if (await send([{ interruptId, status: 'resolved', payload: { type: 'tool_approval_response', approvals } }])) {
      setDecisions(tools.map(() => undefined));
    }
  }

  return (
    <div className="aui-hitl-card" role="group" aria-label="Tool approval requested">
      <p className="aui-hitl-title">{request.hint || `Approve ${tools.length === 1 ? 'this tool call' : `${tools.length} tool calls`}?`}</p>
      {tools.map((tool, index) => (
        <div className="aui-hitl-tool" key={tool.id}>
          <span className="aui-hitl-tool-name">{tool.name}</span>
          {tool.args && Object.keys(tool.args).length > 0 ? (
            <code className="aui-hitl-tool-args">{JSON.stringify(tool.args)}</code>
          ) : null}
          <span className="aui-hitl-choices">
            <button type="button" className={`aui-button aui-button-outline${decisions[index] === true ? ' aui-hitl-on' : ''}`} aria-label={`Approve ${tool.name}`} onClick={() => setDecisions(decisions.map((d, i) => (i === index ? true : d)))}>
              Approve
            </button>
            <button type="button" className={`aui-button aui-button-outline${decisions[index] === false ? ' aui-hitl-off' : ''}`} aria-label={`Deny ${tool.name}`} onClick={() => setDecisions(decisions.map((d, i) => (i === index ? false : d)))}>
              Deny
            </button>
          </span>
        </div>
      ))}
      <div className="aui-hitl-actions">
        <button type="button" className="aui-button aui-button-primary" disabled={!decided} onClick={() => void respond(true)}>
          {decided ? 'Send decisions' : `Decide ${decisions.filter((d) => d !== undefined).length}/${tools.length}`}
        </button>
        <button type="button" className="aui-button aui-button-outline" onClick={() => void respond(false)}>
          Deny all
        </button>
        <Abandon interruptId={interruptId} onAnswerError={onAnswerError} />
      </div>
    </div>
  );
};

const AskUser: FC<{ request: HitlAskUserRequest; interruptId: string } & ErrorSink> = ({ request, interruptId, onAnswerError }) => {
  const [picked, setPicked] = useState<string[][]>(() => request.questions.map(() => []));
  const send = useSubmitGuard({ onAnswerError });
  const answered = picked.every((answers) => answers.length > 0);

  function toggle(qIndex: number, choice: string, multiple: boolean) {
    setPicked((prev) =>
      prev.map((answers, i) => {
        if (i !== qIndex) return answers;
        if (!multiple) return [choice];
        return answers.includes(choice) ? answers.filter((a) => a !== choice) : [...answers, choice];
      }),
    );
  }

  async function respond() {
    const answers = picked.map((selection) => ({ answer: selection }));
    if (await send([{ interruptId, status: 'resolved', payload: { type: 'ask_user_response', id: request.id, answers } }])) {
      setPicked(request.questions.map(() => []));
    }
  }

  return (
    <div className="aui-hitl-card" role="group" aria-label="The agent is asking">
      {request.questions.map((question, qIndex) => (
        <div className="aui-hitl-question" key={`${request.id}:${qIndex}`}>
          <p className="aui-hitl-title">{question.question}</p>
          <div className="aui-hitl-choices">
            {question.choices.map((choice) => (
              <button
                type="button"
                key={choice}
                className={`aui-button aui-button-outline${picked[qIndex]?.includes(choice) ? ' aui-hitl-on' : ''}`}
                onClick={() => toggle(qIndex, choice, question.multiple)}
              >
                {choice}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="aui-hitl-actions">
        <button type="button" className="aui-button aui-button-primary" disabled={!answered} onClick={() => void respond()}>
          Send answer
        </button>
        <Abandon interruptId={interruptId} onAnswerError={onAnswerError} />
      </div>
    </div>
  );
};

// "Cancel" on an AG-UI resume is an order, not text: the BFF turns it into a
// CancelTask on the paused A2A task, so the harness stops waiting.
const Abandon: FC<{ interruptId: string } & ErrorSink> = ({ interruptId, onAnswerError }) => {
  const send = useSubmitGuard({ onAnswerError });
  return (
    <button type="button" className="aui-button aui-button-outline" onClick={() => void send([{ interruptId, status: 'cancelled' }])}>
      Abandon task
    </button>
  );
};
