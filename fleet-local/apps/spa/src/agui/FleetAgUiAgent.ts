import { HttpAgent, type RunAgentInput, type RunAgentParameters } from '@ag-ui/client';

// Mirrors AGUI_MODEL_PROP in packages/shared/src/agui.ts. RunAgentInput has no
// per-message metadata field, so the model choice rides on forwardedProps and the
// facade reads it from there. If the two spellings drift, the facade silently
// uses the catalog default instead of failing loudly.
const MODEL_PROP = 'fleet.dev/model';

// Mirrors aguiRunPath() in packages/shared/src/agui.ts. The project scope lives
// inside the URL so that identity never comes from a handle the client chose.
export function aguiRunUrl(orgId: string, projectId: string): string {
  return `${window.location.origin.replace(/\/+$/, '')}/api/agui/orgs/${orgId}/projects/${projectId}/agent`;
}

export interface FleetAgentOptions {
  orgId: string;
  projectId: string;
  /** THIS conversation's AG-UI thread handle, minted by the app and never reused. */
  threadId: string;
  /** Read at run time, so changing the model selector never rebuilds the agent. */
  model: () => string | undefined;
}

// The adapter assembles `forwardedProps` from the model context alone
// (`AgUiThreadController.buildRunInput`: callSettings, config, runConfig.custom),
// and `@assistant-ui/react` 0.15 exposes no model-context registration path to an
// app that does not run its own model adapter. It does, however, run the input
// through this very agent instance — `runAgentInstance = this.agent`, no clone —
// so `prepareRunAgentInput` is the one seam where the app can add its own prop
// without touching the library.
export class FleetAgUiAgent extends HttpAgent {
  private readonly readModel: () => string | undefined;

  constructor(options: FleetAgentOptions) {
    super({
      // HttpAgent sends Accept: text/event-stream and cookies by default, which is
      // what the BFF run endpoint needs; nothing here has to be configured.
      url: aguiRunUrl(options.orgId, options.projectId),
      threadId: options.threadId,
    });
    this.readModel = options.model;
  }

  override prepareRunAgentInput(parameters?: RunAgentParameters): RunAgentInput {
    const input = super.prepareRunAgentInput(parameters);
    const model = this.readModel();
    if (!model) return input;
    return { ...input, forwardedProps: { ...input.forwardedProps, [MODEL_PROP]: model } };
  }
}
