// ============================================================
// Mandible Cloud — API Client
// ============================================================
// HTTP client for the Mandible Cloud REST API.
// Handles project management, colony deployment, zone status.
// ============================================================

import type {
  CloudConfig,
  Project,
  CreateProjectRequest,
  DeployRequest,
  DeployResult,
  ColonyStatus,
  ZoneStatus,
  ApiKey,
  CreateApiKeyResponse,
  ApiError,
} from './types.js';

export class MandibleCloudError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = 'MandibleCloudError';
  }
}

export class MandibleCloudClient {
  private apiUrl: string;
  private apiKey: string;
  private project?: string;

  constructor(config: CloudConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.project = config.project;
  }

  // ----------------------------------------------------------
  // Projects
  // ----------------------------------------------------------

  async createProject(req: CreateProjectRequest): Promise<Project> {
    return this.post('/v1/projects', req);
  }

  async getProject(id?: string): Promise<Project> {
    return this.get(`/v1/projects/${id ?? this.requireProject()}`);
  }

  async listProjects(): Promise<Project[]> {
    return this.get('/v1/projects');
  }

  async deleteProject(id?: string): Promise<void> {
    return this.del(`/v1/projects/${id ?? this.requireProject()}`);
  }

  // ----------------------------------------------------------
  // Deploy / Colonies
  // ----------------------------------------------------------

  async deploy(req: DeployRequest, projectId?: string): Promise<DeployResult> {
    return this.post(`/v1/projects/${projectId ?? this.requireProject()}/deploy`, req);
  }

  async listColonies(projectId?: string): Promise<ColonyStatus[]> {
    return this.get(`/v1/projects/${projectId ?? this.requireProject()}/colonies`);
  }

  async destroyColony(colonyName: string, projectId?: string): Promise<void> {
    return this.del(`/v1/projects/${projectId ?? this.requireProject()}/colonies/${colonyName}`);
  }

  async stop(projectId?: string): Promise<void> {
    const colonies = await this.listColonies(projectId);
    for (const colony of colonies) {
      await this.destroyColony(colony.name, projectId);
    }
  }

  // ----------------------------------------------------------
  // Zones
  // ----------------------------------------------------------

  async listZones(projectId?: string): Promise<ZoneStatus[]> {
    return this.get(`/v1/projects/${projectId ?? this.requireProject()}/zones`);
  }

  async getZone(zoneId: string, projectId?: string): Promise<ZoneStatus> {
    return this.get(`/v1/projects/${projectId ?? this.requireProject()}/zones/${zoneId}`);
  }

  // ----------------------------------------------------------
  // API Keys
  // ----------------------------------------------------------

  async createApiKey(projectId?: string): Promise<CreateApiKeyResponse> {
    return this.post(`/v1/auth/keys`, { project: projectId ?? this.requireProject() });
  }

  async revokeApiKey(keyId: string): Promise<void> {
    return this.del(`/v1/auth/keys/${keyId}`);
  }

  // ----------------------------------------------------------
  // HTTP helpers
  // ----------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    return this.fetch(path, { method: 'GET' });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async del<T>(path: string): Promise<T> {
    return this.fetch(path, { method: 'DELETE' });
  }

  private async fetch<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const response = await globalThis.fetch(url, {
      ...init,
      headers: {
        ...init.headers as Record<string, string>,
        'Authorization': `Bearer ${this.apiKey}`,
        'User-Agent': 'mandible-sdk/0.1.0',
      },
    });

    if (!response.ok) {
      let error: ApiError;
      try {
        error = await response.json() as ApiError;
      } catch {
        error = { code: 'UNKNOWN', message: response.statusText };
      }
      throw new MandibleCloudError(error.code, error.message, response.status);
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private requireProject(): string {
    if (!this.project) {
      throw new Error('No project specified. Pass project to constructor or method.');
    }
    return this.project;
  }
}
