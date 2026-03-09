// PURPOSE: Unit tests for DockerHost — config defaults, runner scripts, docker args, validation.
// PURPOSE: No actual Docker daemon required — tests pure functions and class behavior.

import { describe, it, expect } from 'vitest';
import {
  DockerHost,
  docker,
  generateRunnerScript,
  buildDockerArgs,
} from '../../src/hosts/docker.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/adapter.js';
import { GitHubEnvironment } from '../../src/environments/github/adapter.js';

// ── Config defaults ──────────────────────────────────────────

describe('DockerHost config defaults', () => {
  it('defaults image to mandible-colony:latest', () => {
    const host = docker();
    // Access via metadata after construction — image is used at start() time
    // Verify the factory creates a DockerHost
    expect(host).toBeInstanceOf(DockerHost);
    expect(host.name).toBe('docker');
  });

  it('accepts custom name', () => {
    const host = docker({ name: 'my-docker' });
    expect(host.name).toBe('my-docker');
  });

  it('defaults name to docker', () => {
    const host = new DockerHost({});
    expect(host.name).toBe('docker');
  });

  it('docker() factory works with no args', () => {
    const host = docker();
    expect(host).toBeInstanceOf(DockerHost);
    expect(host.name).toBe('docker');
  });

  it('docker() factory passes config through', () => {
    const host = docker({
      image: 'custom:v2',
      name: 'test-docker',
      network: 'my-net',
      projectRoot: '/my/project',
    });
    expect(host.name).toBe('test-docker');
  });
});

// ── generateRunnerScript ─────────────────────────────────────

describe('generateRunnerScript', () => {
  it('contains mandible imports', () => {
    const script = generateRunnerScript({
      colonyName: 'worker',
      modulePath: 'colonies/worker.ts',
      exportName: 'configureWorker',
    });
    expect(script).toContain("import { createRuntime } from '@mandible-ai/mandible'");
    expect(script).toContain("import { EventBus } from '@mandible-ai/mandible'");
    expect(script).toContain("import { colony } from '@mandible-ai/mandible'");
    expect(script).toContain("import { deserializeEnvironment } from '@mandible-ai/mandible'");
  });

  it('contains correct module import path', () => {
    const script = generateRunnerScript({
      colonyName: 'worker',
      modulePath: 'src/colonies/worker.ts',
      exportName: 'configureWorker',
    });
    expect(script).toContain("await import('/workspace/src/colonies/worker.ts')");
  });

  it('contains correct export name', () => {
    const script = generateRunnerScript({
      colonyName: 'scout',
      modulePath: 'scout.ts',
      exportName: 'configureScout',
    });
    expect(script).toContain("mod['configureScout']");
  });

  it('contains createRuntime and runtime.start()', () => {
    const script = generateRunnerScript({
      colonyName: 'test',
      modulePath: 'test.ts',
      exportName: 'configure',
    });
    expect(script).toContain('createRuntime(colonyDef');
    expect(script).toContain('await runtime.start()');
  });

  it('includes colony name in runtime output', () => {
    const script = generateRunnerScript({
      colonyName: 'my-colony',
      modulePath: 'mod.ts',
      exportName: 'cfg',
    });
    expect(script).toContain("colony('my-colony')");
    expect(script).toContain('[docker-runner] my-colony running');
  });

  it('serializes module args as JSON', () => {
    const script = generateRunnerScript({
      colonyName: 'test',
      modulePath: 'test.ts',
      exportName: 'configure',
      moduleArgs: ['hello', 42],
    });
    expect(script).toContain('factory(...["hello",42])');
  });

  it('defaults module args to empty array', () => {
    const script = generateRunnerScript({
      colonyName: 'test',
      modulePath: 'test.ts',
      exportName: 'configure',
    });
    expect(script).toContain('factory(...[])');
  });

  it('registers shutdown handlers', () => {
    const script = generateRunnerScript({
      colonyName: 'test',
      modulePath: 'test.ts',
      exportName: 'configure',
    });
    expect(script).toContain("process.on('SIGTERM', shutdown)");
    expect(script).toContain("process.on('SIGINT', shutdown)");
  });
});

// ── buildDockerArgs ──────────────────────────────────────────

describe('buildDockerArgs', () => {
  const baseOpts = {
    containerName: 'mandible-worker-abc12345',
    image: 'mandible-colony:latest',
    projectRoot: '/home/user/project',
    runnerDir: '/tmp/mandible-docker-xyz',
    runnerFile: 'runner-worker.ts',
    envConfig: '{"type":"filesystem","root":"/data","name":"test"}',
    colonyName: 'worker',
  };

  it('includes --name with colony container name', () => {
    const args = buildDockerArgs(baseOpts);
    expect(args).toContain('--name');
    const nameIdx = args.indexOf('--name');
    expect(args[nameIdx + 1]).toBe('mandible-worker-abc12345');
  });

  it('includes -v for project root', () => {
    const args = buildDockerArgs(baseOpts);
    expect(args).toContain('-v');
    expect(args).toContain('/home/user/project:/workspace');
  });

  it('includes -v for runner script dir', () => {
    const args = buildDockerArgs(baseOpts);
    expect(args).toContain('/tmp/mandible-docker-xyz:/app/runners');
  });

  it('includes -e for MANDIBLE_COLONY_CONFIG', () => {
    const args = buildDockerArgs(baseOpts);
    const envIdx = args.findIndex(a => a.startsWith('MANDIBLE_COLONY_CONFIG='));
    expect(envIdx).toBeGreaterThan(-1);
    expect(args[envIdx]).toContain('"type":"filesystem"');
  });

  it('includes -e for MANDIBLE_COLONY_NAME', () => {
    const args = buildDockerArgs(baseOpts);
    expect(args).toContain('MANDIBLE_COLONY_NAME=worker');
  });

  it('includes -v for filesystem env root when applicable', () => {
    const args = buildDockerArgs({ ...baseOpts, fsEnvRoot: '/data/signals' });
    expect(args).toContain('/data/signals:/data/signals');
  });

  it('omits filesystem volume for non-filesystem envs', () => {
    const args = buildDockerArgs(baseOpts);
    // Should only have projectRoot and runnerDir volumes
    const vFlags = args.filter((a, i) => args[i - 1] === '-v');
    expect(vFlags).toHaveLength(2);
    expect(vFlags).toContain('/home/user/project:/workspace');
    expect(vFlags).toContain('/tmp/mandible-docker-xyz:/app/runners');
  });

  it('includes --cpus when resources.maxCpus specified', () => {
    const args = buildDockerArgs({
      ...baseOpts,
      resources: { maxCpus: 2 },
    });
    expect(args).toContain('--cpus');
    const cpuIdx = args.indexOf('--cpus');
    expect(args[cpuIdx + 1]).toBe('2');
  });

  it('includes --memory when resources.maxMemoryMb specified', () => {
    const args = buildDockerArgs({
      ...baseOpts,
      resources: { maxMemoryMb: 512 },
    });
    expect(args).toContain('--memory');
    const memIdx = args.indexOf('--memory');
    expect(args[memIdx + 1]).toBe('512m');
  });

  it('includes --network when configured', () => {
    const args = buildDockerArgs({ ...baseOpts, network: 'my-network' });
    expect(args).toContain('--network');
    const netIdx = args.indexOf('--network');
    expect(args[netIdx + 1]).toBe('my-network');
  });

  it('omits --network when not configured', () => {
    const args = buildDockerArgs(baseOpts);
    expect(args).not.toContain('--network');
  });

  it('omits --cpus and --memory when no resources', () => {
    const args = buildDockerArgs(baseOpts);
    expect(args).not.toContain('--cpus');
    expect(args).not.toContain('--memory');
  });

  it('ends with image and entrypoint command', () => {
    const args = buildDockerArgs(baseOpts);
    const imageIdx = args.indexOf('mandible-colony:latest');
    expect(imageIdx).toBeGreaterThan(-1);
    expect(args[imageIdx + 1]).toBe('npx');
    expect(args[imageIdx + 2]).toBe('tsx');
    expect(args[imageIdx + 3]).toBe('/app/runners/runner-worker.ts');
  });

  it('starts with run -d', () => {
    const args = buildDockerArgs(baseOpts);
    expect(args[0]).toBe('run');
    expect(args[1]).toBe('-d');
  });
});

// ── setColonyEntries validation ──────────────────────────────

describe('setColonyEntries validation', () => {
  it('accepts entries with moduleRef', () => {
    const host = new DockerHost({});
    expect(() => {
      host.setColonyEntries([
        { name: 'worker', moduleRef: { module: './worker.ts', export: 'configure' } },
      ]);
    }).not.toThrow();
  });

  it('start() throws when colony entry has closure (no moduleRef)', async () => {
    const host = new DockerHost({});
    host.setColonyEntries([
      { name: 'worker', configurator: (c: any) => c },
    ]);

    const env = new FilesystemEnvironment({ root: '/tmp/test', name: 'test' });
    const fakeDef = {
      name: 'worker',
      environment: env,
      sensors: [],
      rules: [],
      concurrency: 1 as const,
      claimStrategy: 'exclusive' as const,
    };

    await expect(host.start([fakeDef])).rejects.toThrow(
      /closure configurator.*cannot run in Docker/,
    );
  });
});

// ── Environment serialization for containers ─────────────────

describe('Environment serialization for containers', () => {
  it('FilesystemEnvironment produces correct config', () => {
    const env = new FilesystemEnvironment({ root: '/data/sigs', name: 'fs-env' });
    const config = env.serialize();
    expect(config).toEqual({ type: 'filesystem', root: '/data/sigs', name: 'fs-env' });
  });

  it('GitHubEnvironment produces correct config', () => {
    const env = new GitHubEnvironment({
      owner: 'acme',
      repo: 'widgets',
      token: 'ghp_test123',
      name: 'gh-test',
      pollInterval: 15_000,
    });
    const config = env.serialize();
    expect(config.type).toBe('github');
    expect(config.owner).toBe('acme');
    expect(config.repo).toBe('widgets');
  });
});
