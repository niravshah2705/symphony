import test from 'node:test';
import assert from 'node:assert/strict';

import { mintedStreamContextQuerySuffix } from './stream-context.mjs';

test('SSE query uses the authoritative context returned by token minting', () => {
  assert.equal(
    mintedStreamContextQuerySuffix({
      token: 'opaque',
      organizationId: 'org-minted',
      projectId: 'project-minted',
    }),
    '&organizationId=org-minted&projectId=project-minted'
  );
});

test('SSE query drops malformed minted context ids', () => {
  assert.equal(
    mintedStreamContextQuerySuffix({
      organizationId: 'org/escape',
      projectId: 'project?escape',
    }),
    ''
  );
});
