// PURPOSE: Tests for MandibleCloudClient against the response shapes Mandible Cloud serves.
// PURPOSE: Verifies stop() destroys every colony in a project by its name.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MandibleCloudClient } from '../../src/cloud/client.js';

const API_URL = 'https://api.mandible.test';
const PROJECT = 'proj_abc123';

// One element of the server's zone list (internal/zones/orchestrator.go, `Zone`).
// Mandible Cloud serialises this same struct for both /zones and /colonies:
// the colony name is in `colony`, and there is no `name` field.
function serverZone(colony: string, state: string, n: number) {
  return {
    zoneId: `zone_${n}`,
    zoneName: `${PROJECT}-${colony}-${n}`,
    colony,
    project: PROJECT,
    state,
    resources: { cpus: 1, memoryMb: 512 },
    createdAt: '2026-10-03T12:00:00Z',
    uptimeSeconds: 42,
  };
}

type Call = { method: string; path: string };

let originalFetch: typeof globalThis.fetch;
let calls: Call[];

function stubServer(zones: ReturnType<typeof serverZone>[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).slice(API_URL.length);
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    if (method === 'GET' && (path === `/v1/projects/${PROJECT}/zones` || path === `/v1/projects/${PROJECT}/colonies`)) {
      return new Response(JSON.stringify(zones), { status: 200 });
    }
    const colony = path.match(new RegExp(`^/v1/projects/${PROJECT}/colonies/(.+)$`))?.[1];
    if (method === 'DELETE' && colony && zones.some(z => z.colony === colony && z.state !== 'destroyed' && z.state !== 'destroying')) {
      return new Response(null, { status: 204 });
    }
    return new Response(
      JSON.stringify({ code: 'NOT_FOUND', message: `no active zone found for colony "${colony}" in project "${PROJECT}"` }),
      { status: 404 },
    );
  }) as typeof globalThis.fetch;
}

const destroyed = () => calls.filter(c => c.method === 'DELETE').map(c => c.path);

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('MandibleCloudClient.stop', () => {
  const client = new MandibleCloudClient({ apiUrl: API_URL, apiKey: 'mk_test' });

  it('destroys every colony by name', async () => {
    stubServer([serverZone('scout', 'running', 1), serverZone('worker', 'running', 2), serverZone('reviewer', 'ready', 3)]);

    await client.stop(PROJECT);

    expect(destroyed()).toEqual([
      `/v1/projects/${PROJECT}/colonies/scout`,
      `/v1/projects/${PROJECT}/colonies/worker`,
      `/v1/projects/${PROJECT}/colonies/reviewer`,
    ]);
  });

  it('destroys a colony once when the list holds several zones for it', async () => {
    stubServer([serverZone('worker', 'failed', 1), serverZone('worker', 'running', 2)]);

    await client.stop(PROJECT);

    expect(destroyed()).toEqual([`/v1/projects/${PROJECT}/colonies/worker`]);
  });

  it('skips colonies whose zones are already destroyed or destroying', async () => {
    stubServer([serverZone('scout', 'destroyed', 1), serverZone('worker', 'destroying', 2), serverZone('reviewer', 'running', 3)]);

    await client.stop(PROJECT);

    expect(destroyed()).toEqual([`/v1/projects/${PROJECT}/colonies/reviewer`]);
  });

  it('uses the configured project when none is passed', async () => {
    stubServer([serverZone('scout', 'running', 1)]);

    await new MandibleCloudClient({ apiUrl: API_URL, apiKey: 'mk_test', project: PROJECT }).stop();

    expect(destroyed()).toEqual([`/v1/projects/${PROJECT}/colonies/scout`]);
  });
});
