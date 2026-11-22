import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { config } from '../config.ts';
import { ACTOR_SECONDS_METRIC } from '../costs/prom.ts';

// OTLP metrics → collector → Prometheus. The fleet-labelled counter is what the
// costs dashboard groups actor seconds by (org/project/user/agent/tier).
const exporter = new OTLPMetricExporter({ url: `${config.otlpEndpoint}/v1/metrics` });
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 15000 });
const provider = new MeterProvider({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'fleet-bff' }),
  readers: [reader],
});
const meter = provider.getMeter('fleet.metering');
const actorSeconds = meter.createCounter(ACTOR_SECONDS_METRIC, {
  description: 'Cumulative actor compute seconds, fleet-labelled',
});

export interface ActorAttrs {
  fleet_org_id: string;
  project_id: string;
  user_id: string;
  agent_id: string;
  tier: string;
  [key: string]: string;
}

export function recordActorSeconds(attrs: ActorAttrs, seconds: number): void {
  if (seconds > 0) actorSeconds.add(seconds, attrs);
}

export async function shutdownMetrics(): Promise<void> {
  await provider.shutdown();
}