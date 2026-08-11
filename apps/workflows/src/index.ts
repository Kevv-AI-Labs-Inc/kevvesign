import { app, type HttpHandler } from '@azure/functions';
import * as df from 'durable-functions';
import type { OrchestrationHandler } from 'durable-functions';

interface WorkflowInput {
  schemaVersion: 1;
  envelopeId: string;
  workspaceId: string;
  expiresAt: string;
  reminderInstants: string[];
}

interface WorkflowSignal {
  kind: 'approval.completed' | 'recipient.completed' | 'envelope.voided' | 'envelope.declined';
  recipientId?: string;
  allRequiredRecipientsComplete?: boolean;
}

const orchestrator: OrchestrationHandler = function* (context) {
  const input = context.df.getInput<WorkflowInput>();
  if (!input || input.schemaVersion !== 1) throw new Error('Unsupported workflow input.');

  yield context.df.callActivity('recordWorkflowStarted', {
    envelopeId: input.envelopeId,
    workspaceId: input.workspaceId,
  });

  for (const reminderAt of input.reminderInstants) {
    const deadline = new Date(reminderAt);
    if (deadline <= context.df.currentUtcDateTime) continue;
    const reminderTimer = context.df.createTimer(deadline);
    const signalTask = context.df.waitForExternalEvent('envelope-signal');
    const winner = yield context.df.Task.any([reminderTimer, signalTask]);
    if (winner === signalTask) {
      reminderTimer.cancel();
      const signal = signalTask.result as WorkflowSignal;
      if (['envelope.voided', 'envelope.declined'].includes(signal.kind)) return signal.kind;
      if (signal.allRequiredRecipientsComplete) {
        yield context.df.callActivity('enqueueFinalization', input);
        return 'finalization-enqueued';
      }
    } else {
      yield context.df.callActivity('dispatchDueReminders', input);
    }
  }

  const expiration = new Date(input.expiresAt);
  const expirationTimer = context.df.createTimer(expiration);
  while (true) {
    const signalTask = context.df.waitForExternalEvent('envelope-signal');
    const winner = yield context.df.Task.any([expirationTimer, signalTask]);
    if (winner === expirationTimer) {
      yield context.df.callActivity('expireEnvelope', input);
      return 'expired';
    }
    const signal = signalTask.result as WorkflowSignal;
    if (['envelope.voided', 'envelope.declined'].includes(signal.kind)) {
      expirationTimer.cancel();
      return signal.kind;
    }
    if (signal.allRequiredRecipientsComplete) {
      expirationTimer.cancel();
      yield context.df.callActivity('enqueueFinalization', input);
      return 'finalization-enqueued';
    }
  }
};

df.app.orchestration('envelopeWorkflow', orchestrator);

for (const name of [
  'recordWorkflowStarted',
  'dispatchDueReminders',
  'enqueueFinalization',
  'expireEnvelope',
]) {
  df.app.activity(name, {
    handler: async (input: unknown, context) => {
      context.log(`${name} command accepted`, { correlationId: context.invocationId });
      return { accepted: true, input };
    },
  });
}

const startWorkflow: HttpHandler = async (request, invocation) => {
  const input = (await request.json()) as WorkflowInput;
  const client = df.getClient(invocation);
  const instanceId = `envelope:${input.envelopeId}:v${input.schemaVersion}`;
  const existing = await client.getStatus(instanceId);
  if (!existing) await client.startNew('envelopeWorkflow', { instanceId, input });
  return {
    status: 202,
    jsonBody: {
      instanceId,
      statusQueryGetUri: `/runtime/webhooks/durabletask/instances/${instanceId}`,
    },
  };
};

app.http('startEnvelopeWorkflow', {
  route: 'internal/workflows/envelopes',
  methods: ['POST'],
  authLevel: 'function',
  handler: startWorkflow,
});

app.http('signalEnvelopeWorkflow', {
  route: 'internal/workflows/envelopes/{envelopeId}/signals',
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, invocation) => {
    const envelopeId = request.params.envelopeId;
    const signal = (await request.json()) as WorkflowSignal;
    const client = df.getClient(invocation);
    await client.raiseEvent(`envelope:${envelopeId}:v1`, 'envelope-signal', signal);
    return { status: 202, jsonBody: { accepted: true } };
  },
});
