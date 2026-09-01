// PURPOSE: Token providers for GitHub API authentication
// PURPOSE: Static PAT wrapper and octo-sts OIDC→GitHub token exchange

import type { OctoStsConfig } from './types.js';

// ----------------------------------------------------------
// TokenProvider interface
// ----------------------------------------------------------

export interface TokenProvider {
  resolve(): Promise<string>;
}

// ----------------------------------------------------------
// StaticTokenProvider — wraps a plain PAT string
// ----------------------------------------------------------

export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async resolve(): Promise<string> { return this.token; }
}

// ----------------------------------------------------------
// EnvTokenProvider — reads GITHUB_TOKEN from env on every resolve
// ----------------------------------------------------------

/**
 * Env-sourced tokens are read lazily so rotation propagates: Mandible zones
 * replace env values at runtime when a declared secret rotates
 * (refreshSecretsIntoEnv), and a snapshot taken at construction would keep
 * serving the revoked value until restart.
 */
export class EnvTokenProvider implements TokenProvider {
  constructor(private readonly variable: string = 'GITHUB_TOKEN') {}
  async resolve(): Promise<string> { return process.env[this.variable] ?? ''; }
}

// ----------------------------------------------------------
// OctoStsTokenProvider — exchanges OIDC token for GitHub installation token
// ----------------------------------------------------------

const DEFAULT_STS_URL = 'https://octo-sts.dev';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;   // refresh 5 min before expiry
const DEFAULT_TTL_MS = 50 * 60 * 1000;      // assume 50 min if no expires_at

export class OctoStsTokenProvider implements TokenProvider {
  private readonly owner: string;
  private readonly repo: string;
  private readonly config: OctoStsConfig;
  private cachedToken: string | undefined;
  private expiresAt = 0;

  constructor(owner: string, repo: string, config: OctoStsConfig) {
    this.owner = owner;
    this.repo = repo;
    this.config = config;
  }

  async resolve(): Promise<string> {
    if (this.cachedToken && Date.now() < this.expiresAt - REFRESH_MARGIN_MS) {
      return this.cachedToken;
    }
    return this.exchange();
  }

  private async exchange(): Promise<string> {
    const oidcToken = await this.resolveOidcToken();
    const stsUrl = this.config.stsUrl ?? DEFAULT_STS_URL;
    const scope = `${this.owner}/${this.repo}`;
    const url = `${stsUrl}/sts/exchange?scope=${encodeURIComponent(scope)}&identity=${encodeURIComponent(this.config.identity)}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${oidcToken}`,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `octo-sts exchange failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const json = await response.json() as { token: string; expires_at?: string };
      this.cachedToken = json.token;
      this.expiresAt = json.expires_at
        ? new Date(json.expires_at).getTime()
        : Date.now() + DEFAULT_TTL_MS;
    } else {
      // Plain text response — just the token
      this.cachedToken = (await response.text()).trim();
      this.expiresAt = Date.now() + DEFAULT_TTL_MS;
    }

    return this.cachedToken;
  }

  private async resolveOidcToken(): Promise<string> {
    // 1. Explicit oidcToken (string or callback)
    if (this.config.oidcToken) {
      if (typeof this.config.oidcToken === 'function') {
        return await this.config.oidcToken();
      }
      return this.config.oidcToken;
    }

    // 2. OIDC_TOKEN env var
    const envToken = process.env.OIDC_TOKEN;
    if (envToken) return envToken;

    // 3. GitHub Actions OIDC provider
    const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (requestUrl && requestToken) {
      const response = await fetch(`${requestUrl}&audience=octo-sts.dev`, {
        headers: { 'Authorization': `Bearer ${requestToken}` },
      });
      if (!response.ok) {
        throw new Error(`GitHub Actions OIDC request failed: ${response.status} ${response.statusText}`);
      }
      const json = await response.json() as { value: string };
      return json.value;
    }

    throw new Error(
      'octo-sts: no OIDC token available. Provide one via:\n' +
      '  1. sts.oidcToken option (string or async callback)\n' +
      '  2. OIDC_TOKEN environment variable\n' +
      '  3. GitHub Actions OIDC (ACTIONS_ID_TOKEN_REQUEST_URL + ACTIONS_ID_TOKEN_REQUEST_TOKEN)'
    );
  }
}

// ----------------------------------------------------------
// Factory — picks the right provider from config
// ----------------------------------------------------------

export function createTokenProvider(config: {
  owner: string; repo: string; token?: string; sts?: OctoStsConfig;
}): TokenProvider | undefined {
  if (config.token && config.sts) {
    throw new Error('GitHubEnvironment: cannot specify both token and sts');
  }
  if (config.token) return new StaticTokenProvider(config.token);
  if (config.sts) return new OctoStsTokenProvider(config.owner, config.repo, config.sts);
  if (process.env.GITHUB_TOKEN) return new EnvTokenProvider('GITHUB_TOKEN');
  return undefined;
}
