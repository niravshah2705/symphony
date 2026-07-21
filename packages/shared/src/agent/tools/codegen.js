'use strict';

const fs = require('fs');
const { execTool, resolveWorkdir, commandExists, platformCmd, defineTool } = require('./exec');

/**
 * Codegen tool — generate client/server code from an OpenAPI spec by delegating
 * to OpenAPI Generator (the `openapi-generator-cli` binary if present, otherwise
 * the `@openapitools/openapi-generator-cli` npx package). No templating logic is
 * re-implemented here. Requires a JDK (OpenAPI Generator runs on the JVM).
 */

const GENERATOR_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Resolve the OpenAPI Generator invocation available on this host. */
async function pickOpenapiGenerator() {
  if (await commandExists('openapi-generator-cli', 'version')) return { command: 'openapi-generator-cli', prefix: [] };
  if (await commandExists('openapi-generator', 'version')) return { command: 'openapi-generator', prefix: [] };
  return { command: platformCmd('npx'), prefix: ['--yes', '@openapitools/openapi-generator-cli'], hint: 'Install openapi-generator-cli, or allow npx to fetch @openapitools/openapi-generator-cli (needs a JDK).' };
}

const openapiGenerateTool = defineTool(
  {
    name: 'openapi_generate',
    description:
      'Generate client or server code from an OpenAPI/Swagger spec using OpenAPI Generator. Pass the spec path, ' +
      'a generator name (e.g. typescript-axios, python, go, spring), and an output directory. Requires a JDK.',
    schema: (z) =>
      z.object({
        spec: z.string().describe('workspace-relative path to the OpenAPI spec (yaml/json)'),
        generator: z.string().describe('OpenAPI Generator name, e.g. "typescript-axios", "python", "go"'),
        output: z.string().describe('workspace-relative output directory'),
      }),
  },
  async (input, ctx) => {
    const specPath = resolveWorkdir(ctx, input.spec);
    if (!fs.existsSync(specPath)) return `❌ openapi_generate: spec not found at "${input.spec}".`;
    if (!GENERATOR_RE.test(String(input.generator || ''))) throw new Error(`invalid generator name: "${input.generator}"`);
    resolveWorkdir(ctx, input.output); // assert output stays inside the workspace
    const gen = await pickOpenapiGenerator();
    const args = [...gen.prefix, 'generate', '-i', input.spec, '-g', input.generator, '-o', input.output];
    return execTool({ ctx, label: `openapi generate (${input.generator})`, command: gen.command, args, notFoundHint: gen.hint });
  }
);

const FACTORIES = Object.freeze({ openapi_generate: openapiGenerateTool });

module.exports = { FACTORIES, pickOpenapiGenerator, GENERATOR_RE };
