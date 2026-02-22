// PURPOSE: Tests for cloud deployment types (ColonyModuleRef, DeployRequest, BundleUploadInfo).
// PURPOSE: Verifies type contracts between SDK and API.

import { describe, it, expect } from 'vitest';
import type {
  ColonyModuleRef,
  DeployRequest,
  DeployColonyConfig,
  BundleUploadInfo,
} from '../../src/cloud/types.js';

describe('cloud types', () => {
  it('ColonyModuleRef has required fields', () => {
    const ref: ColonyModuleRef = {
      module: './scout.ts',
      export: 'configureScout',
      args: ['/tmp/repo'],
    };
    expect(ref.module).toBe('./scout.ts');
    expect(ref.export).toBe('configureScout');
    expect(ref.args).toEqual(['/tmp/repo']);
  });

  it('ColonyModuleRef allows omitting args', () => {
    const ref: ColonyModuleRef = {
      module: './worker.ts',
      export: 'configureWorker',
    };
    expect(ref.args).toBeUndefined();
  });

  it('DeployRequest includes bundle fields', () => {
    const req: DeployRequest = {
      colonies: [{
        name: 'scout',
        sensors: [{ query: { type: 'scan:trigger' } }],
        claimStrategy: 'exclusive',
        concurrency: 1,
        moduleRef: { export: 'configureScout', args: ['/repo'] },
      }],
      bundleS3Key: 'bundles/proj123/1234.mjs',
      bundleHash: 'abc123def456',
    };
    expect(req.bundleS3Key).toBe('bundles/proj123/1234.mjs');
    expect(req.bundleHash).toBe('abc123def456');
    expect(req.colonies[0].moduleRef?.export).toBe('configureScout');
  });

  it('DeployRequest allows omitting bundle fields', () => {
    const req: DeployRequest = {
      colonies: [{
        name: 'worker',
        sensors: [],
        claimStrategy: 'exclusive',
        concurrency: 1,
      }],
    };
    expect(req.bundleS3Key).toBeUndefined();
    expect(req.bundleHash).toBeUndefined();
  });

  it('BundleUploadInfo shape', () => {
    const info: BundleUploadInfo = {
      url: 'https://s3.amazonaws.com/bucket/key?presigned=true',
      s3Key: 'bundles/proj123/1234.mjs',
    };
    expect(info.url).toContain('s3.amazonaws.com');
    expect(info.s3Key).toMatch(/^bundles\//);
  });
});
