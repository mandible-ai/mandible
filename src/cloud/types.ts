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
}

export interface Project {
  id: string;
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
}

export interface DeployColonyConfig {
  name: string;
  image?: string;
  sensors: Array<{ query: { type?: string | string[]; unclaimed?: boolean; minConcentration?: number; tags?: string[] }; pollInterval?: number }>;
  claimStrategy: string;
  concurrency: number;
  config?: Record<string, unknown>;
  resources?: HostResources;
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
  prefix: string;
  project: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface CreateApiKeyResponse {
  id: string;
  key: string;
  prefix: string;
}

export interface ApiError {
  code: string;
  message: string;
}
