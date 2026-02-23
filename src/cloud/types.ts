// ============================================================
// Mandible Cloud — API Types
// ============================================================
// TypeScript types for the Mandible Cloud REST API.
// These define the contract between the open-source CLI/client
// and the private Cloud API server.
// ============================================================

import type { HostResources } from '../core/types.js';
export type { HostResources } from '../core/types.js';

export interface CloudConfig {
  apiUrl: string;
  apiKey: string;
  project?: string;
  accountId?: string;
}

export interface Account {
  id: string;
  name: string;
  email?: string;
  createdAt: string;
}

export interface Project {
  id: string;
  accountId: string;
  name: string;
  signalServerUrl: string;
  createdAt: string;
  colonyCount: number;
}

export interface CreateProjectRequest {
  name: string;
}

export interface DeployRequest {
  colonies: DeployColonyConfig[];
  bundleS3Key?: string;
  bundleHash?: string;
}

export interface DeployColonyConfig {
  name: string;
  image?: string;
  sensors: Array<{ query: { type?: string | string[]; unclaimed?: boolean; minConcentration?: number; tags?: string[] }; pollInterval?: number }>;
  claimStrategy: string;
  concurrency: number;
  config?: Record<string, unknown>;
  resources?: HostResources;
  environmentConfig?: Record<string, unknown>;
  moduleRef?: { export: string; args?: unknown[] };
}

/**
 * Reference to a colony configurator module for cloud deployment.
 * Instead of passing a closure (which can't be serialized), pass a reference
 * to a module file, its exported function name, and optional arguments.
 *
 * For local host: the module is dynamically imported and called.
 * For cloud host: the module is bundled via esbuild and shipped to the zone.
 */
export interface ColonyModuleRef {
  /** Path to the module file (relative to cwd or absolute) */
  module: string;
  /** Name of the exported configurator function */
  export: string;
  /** Arguments to pass to the configurator function */
  args?: unknown[];
}



export interface DeployResult {
  projectId: string;
  colonies: DeployedColony[];
  signalServerUrl: string;
  dashboardUrl: string;
}

export interface DeployedColony {
  name: string;
  zoneId: string;
  zoneName: string;
  state: ZoneState;
  resources: HostResources;
  createdAt: string;
}

export type ZoneState =
  | 'creating'
  | 'created'
  | 'ready'
  | 'running'
  | 'exited'
  | 'destroying'
  | 'destroyed'
  | 'failed';

export interface ZoneStatus {
  zoneId: string;
  zoneName: string;
  colony: string;
  state: ZoneState;
  resources: HostResources;
  metrics?: ZoneMetrics;
  createdAt: string;
  uptimeSeconds: number;
}

export interface ZoneMetrics {
  cpuUsagePercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  signalsProcessed: number;
  signalsDeposited: number;
  errors: number;
}

export interface ColonyStatus {
  name: string;
  zone: ZoneStatus;
  runtimeStats: {
    signalsSensed: number;
    signalsClaimed: number;
    signalsProcessed: number;
    signalsDeposited: number;
    claimConflicts: number;
    errors: number;
    avgProcessingMs: number;
  };
}

export interface ApiKey {
  id: string;
  accountId: string;
  prefix: string;
  scopes: string[];
  projectIds?: string[];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

export interface CreateApiKeyResponse {
  id: string;
  key: string;
  prefix: string;
}

export interface BundleUploadInfo {
  /** Presigned S3 PUT URL for uploading the bundle */
  url: string;
  /** S3 key where the bundle will be stored */
  s3Key: string;
}

export interface ApiError {
  code: string;
  message: string;
}
