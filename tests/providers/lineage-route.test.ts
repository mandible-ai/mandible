// PURPOSE: Tests for byLineage — routing driven by trails of past outcomes
// PURPOSE: Uses a real FilesystemEnvironment because lineage lives in the environment

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FilesystemEnvironment } from '../../src/environments/filesystem/adapter.js';
import { withModelRouter, byLineage, byTag } from '../../src/providers/model-router.js';
import type { Signal, ActionContext } from '../../src/core/types.js';

let env: FilesystemEnvironment;
let root: string;

beforeEach(() => {
  root = join(tmpdir(), `mandible-lineage-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  env = new FilesystemEnvironment({ root, name: 'lineage-test' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeCtx(): ActionContext {
  return {
    colony: 'test',
    deposit: vi.fn().mockResolvedValue({} as Signal),
    withdraw: vi.fn().mockResolvedValue(undefined),
    enrich: (id, changes) => env.update(id, { meta: { tags: changes.tags }, payload: changes.payload }),
    release: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    heartbeat: vi.fn().mockResolvedValue(undefined),
  };
}

const ok = () => vi.fn().mockResolvedValue(undefined);

describe('byLineage', () => {
  it('routes up when an ancestor matches the query', async () => {
    // task v1 → artifact → review:changes-needed → task v2
    const v1 = await env.deposit({ type: 'task:ready', payload: { n: 1 }, meta: { deposited_by: 'seed' } });
    const artifact = await env.deposit({ type: 'artifact:shaped', payload: {}, meta: { deposited_by: 'shaper', caused_by: [v1.id] } });
    const review = await env.deposit({ type: 'review:changes-needed', payload: {}, meta: { deposited_by: 'critic', caused_by: [artifact.id] } });
    const v2 = await env.deposit({ type: 'task:ready', payload: { n: 2 }, meta: { deposited_by: 'critic', caused_by: [review.id] } });

    const strong = ok(); const normal = ok();
    const router = withModelRouter({
      routes: [byLineage({ environment: env, type: 'review:changes-needed' }, strong)],
      fallback: normal,
    });

    await router(v2, makeCtx());
    expect(strong).toHaveBeenCalledOnce();
    expect(normal).not.toHaveBeenCalled();

    // A fresh task with no such history takes the normal path
    const fresh = await env.deposit({ type: 'task:ready', payload: {}, meta: { deposited_by: 'seed' } });
    await router(fresh, makeCtx());
    expect(normal).toHaveBeenCalledOnce();
  });

  it('respects depth', async () => {
    const a = await env.deposit({ type: 'review:changes-needed', payload: {}, meta: { deposited_by: 'x' } });
    const b = await env.deposit({ type: 'mid', payload: {}, meta: { deposited_by: 'x', caused_by: [a.id] } });
    const c = await env.deposit({ type: 'mid', payload: {}, meta: { deposited_by: 'x', caused_by: [b.id] } });
    const leaf = await env.deposit({ type: 'task:ready', payload: {}, meta: { deposited_by: 'x', caused_by: [c.id] } });

    const shallow = byLineage({ environment: env, type: 'review:changes-needed', depth: 2 }, ok());
    const deep = byLineage({ environment: env, type: 'review:changes-needed', depth: 3 }, ok());

    expect(await shallow.match(leaf)).toBe(false);
    expect(await deep.match(leaf)).toBe(true);
  });

  it('sees withdrawn ancestors', async () => {
    const review = await env.deposit({ type: 'review:changes-needed', payload: {}, meta: { deposited_by: 'critic' } });
    const task = await env.deposit({ type: 'task:ready', payload: {}, meta: { deposited_by: 'critic', caused_by: [review.id] } });
    await env.withdraw(review.id);

    const route = byLineage({ environment: env, type: 'review:*' }, ok());
    expect(await route.match(task)).toBe(true);
  });

  it('can match ancestors by tags and filter', async () => {
    const parent = await env.deposit({ type: 'artifact:shaped', payload: { model: 'claude-haiku-4-5' }, meta: { deposited_by: 'x', tags: ['route:tag:complexity:low'] } });
    const task = await env.deposit({ type: 'task:ready', payload: {}, meta: { deposited_by: 'x', caused_by: [parent.id] } });

    expect(await byLineage({ environment: env, tags: ['route:tag:complexity:low'] }, ok()).match(task)).toBe(true);
    expect(await byLineage({ environment: env, filter: (a) => a.payload.model === 'claude-haiku-4-5' }, ok()).match(task)).toBe(true);
    expect(await byLineage({ environment: env, tags: ['nope'] }, ok()).match(task)).toBe(false);
  });

  it('composes with tag routes in declaration order', async () => {
    const review = await env.deposit({ type: 'review:changes-needed', payload: {}, meta: { deposited_by: 'critic' } });
    const task = await env.deposit({ type: 'task:ready', payload: {}, meta: { deposited_by: 'critic', caused_by: [review.id], tags: ['complexity:low'] } });

    const strong = ok(); const cheap = ok();
    const router = withModelRouter({
      routes: [
        byLineage({ environment: env, type: 'review:changes-needed' }, strong), // history beats label
        byTag('complexity:low', cheap),
      ],
      fallback: ok(),
    });

    await router(task, makeCtx());
    expect(strong).toHaveBeenCalledOnce();
    expect(cheap).not.toHaveBeenCalled();
  });
});
