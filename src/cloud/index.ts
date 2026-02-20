export { RemoteEnvironment } from '../environments/remote/index.js';
export type { RemoteEnvConfig } from '../environments/remote/index.js';
export { MandibleCloudClient, MandibleCloudError } from './client.js';
// CloudHost lives in @mandible-ai/cloud (mandible-cloud repo)
export type {
  CloudConfig,
  Project,
  CreateProjectRequest,
  DeployRequest,
  DeployColonyConfig,
  DeployResult,
  DeployedColony,
  ZoneState,
  ZoneStatus,
  ZoneMetrics,
  ZoneResources,
  ColonyStatus,
  ApiKey,
  CreateApiKeyResponse,
  ApiError,
} from './types.js';
