import type { OnboardingStepId } from '@fleet-local/shared';
import type { StepExecutor } from '../machine.ts';
import { orgStep } from './org.ts';
import { namespaceStep } from './namespace.ts';
import { projectStep } from './project.ts';
import { flexpriceStep } from './flexprice.ts';
import { keyStep } from './key.ts';
import { workflowStep } from './workflow.ts';
import { agentStep } from './agent.ts';
import { attachStep } from './attach.ts';
import { limitsStep } from './limits.ts';

export const executors: Record<OnboardingStepId, StepExecutor> = {
  org: orgStep,
  namespace: namespaceStep,
  project: projectStep,
  flexprice: flexpriceStep,
  key: keyStep,
  workflow: workflowStep,
  agent: agentStep,
  attach: attachStep,
  limits: limitsStep,
};