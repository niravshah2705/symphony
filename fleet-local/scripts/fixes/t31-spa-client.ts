// T-31 gate 8: drive the A2A library client itself — FleetA2AClient, on top of
// @assistant-ui/react-a2a's A2AClient — against the live facade.
//
// The browser no longer uses it (that leg speaks AG-UI now, see
// apps/spa/src/agui); what this gate still proves is the facade's northbound
// contract, which is the same A2A the harness speaks. curl proves the facade
// speaks A2A; this proves a real A2A client and the facade agree, which is the
// half that a hand-written reader could not cover:
//   - the library's strict agent-card parser accepts our rewrite
//   - its SSE decoder yields typed events from our relayed frames (so the run
//     does not die with "stream ended without any events")
//   - the model rides on message.metadata through the library's own call path
//     (it passes metadata = void 0, so nothing else could carry it)
//
// The shell gate reads the printed key=value lines and does the DB assertion.
// Auth is a Cookie header because node has no cookie jar; the browser sends the
// same cookie itself.
import { FleetA2AClient } from './FleetA2AClient.ts';

const [baseUrl, token, model, text] = process.argv.slice(2);
if (!baseUrl || !token || !model || !text) {
  console.error('usage: t31-spa-client.ts <facadeBaseUrl> <sessionToken> <modelId> <text>');
  process.exit(2);
}

const client = new FleetA2AClient({ baseUrl, headers: { Cookie: `_fleet_sess=${token}` }, model: () => model });

const card = await client.getAgentCard();
const iface = card.supportedInterfaces?.[0]?.url ?? card.url ?? '';
console.log(`card_name=${card.name}`);
console.log(`card_skills=${card.skills?.length ?? 0}`);
console.log(`card_streaming=${card.capabilities?.streaming === true}`);
console.log(`iface=${iface}`);

// A2AStreamEvent is a discriminated union: {type:"task", task} |
// {type:"message", message} | {type:"statusUpdate", event} |
// {type:"artifactUpdate", event}. Answer text can ride on any of them, so all
// four are read — the point is what the CLIENT ends up able to show.
type Text = { text?: string };
type Carrier = { parts?: Text[] };
type Msg = (Carrier & { role?: string }) | undefined;
type Payload = {
  task?: {
    id?: string;
    contextId?: string;
    status?: { state?: string; message?: Msg };
    artifacts?: { parts?: Text[] }[];
  };
  message?: Msg;
  event?: {
    taskId?: string;
    contextId?: string;
    status?: { state?: string; message?: Msg };
    artifact?: { parts?: Text[] };
  };
};

const textOf = (carrier: Carrier | undefined): string =>
  (carrier?.parts ?? []).map((p) => p.text ?? '').join('');

let events = 0;
let contextId = '';
let taskId = '';
let state = '';
let answer = '';
const kinds = new Set<string>();
// The library's own A2A role spelling is lowercase ("user"); toWireMessage maps
// it to the wire's ROLE_USER and anything else to ROLE_UNSPECIFIED. Passing the
// proto spelling here would test a request the browser can never make.
for await (const event of client.streamMessage(
  { role: 'user', parts: [{ kind: 'text', text }] },
  undefined,
  undefined,
  AbortSignal.timeout(240_000),
)) {
  events += 1;
  const e = event as { type?: string } & Payload;
  kinds.add(e.type ?? 'unknown');
  contextId ||= e.task?.contextId ?? e.event?.contextId ?? '';
  taskId ||= e.task?.id ?? e.event?.taskId ?? '';
  state = e.task?.status?.state ?? e.event?.status?.state ?? state;
  answer += textOf(e.event?.artifact);
  for (const artifact of e.task?.artifacts ?? []) answer += textOf(artifact);
  answer += textOf(e.message) + textOf(e.task?.status?.message) + textOf(e.event?.status?.message);
}
console.log(`events=${events}`);
console.log(`kinds=${[...kinds].join(',')}`);
console.log(`context=${contextId}`);
console.log(`task=${taskId}`);
console.log(`state=${state}`);
console.log(`answer_len=${answer.length}`);
console.log(`answer=${answer.slice(0, 120).replace(/\s+/g, ' ').trim()}`);
if (events === 0 || !contextId) {
  console.error(`the client saw no usable events (state=${state || 'none'})`);
  process.exit(1);
}
