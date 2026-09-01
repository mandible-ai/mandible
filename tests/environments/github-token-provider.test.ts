// PURPOSE: Tests for GitHub token provider (StaticTokenProvider, OctoStsTokenProvider, factory)
// PURPOSE: Validates OIDC discovery, STS exchange, caching, and error handling

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StaticTokenProvider,
  OctoStsTokenProvider,
  createTokenProvider,
} from '../../src/environments/github/token-provider.js';

// ----------------------------------------------------------
// StaticTokenProvider
// ----------------------------------------------------------

describe('StaticTokenProvider', () => {
  it('returns the token it was constructed with', async () => {
    const provider = new StaticTokenProvider('ghp_abc123');
    expect(await provider.resolve()).toBe('ghp_abc123');
  });

  it('returns the same token on repeated calls', async () => {
    const provider = new StaticTokenProvider('ghp_abc123');
    expect(await provider.resolve()).toBe('ghp_abc123');
    expect(await provider.resolve()).toBe('ghp_abc123');
  });
});

// ----------------------------------------------------------
// OctoStsTokenProvider
// ----------------------------------------------------------

describe('OctoStsTokenProvider', () => {
  const fetchSpy = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    fetchSpy.mockReset();
    // Clean env
    delete process.env.OIDC_TOKEN;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    delete process.env.OIDC_TOKEN;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  });

  function makeStsResponse(token: string, expiresAt?: string): Response {
    const body = expiresAt
      ? JSON.stringify({ token, expires_at: expiresAt })
      : token;
    const headers = expiresAt
      ? { 'content-type': 'application/json' }
      : { 'content-type': 'text/plain' };
    return new Response(body, { status: 200, headers });
  }

  it('exchanges OIDC token for GitHub token via STS endpoint', async () => {
    process.env.OIDC_TOKEN = 'oidc-jwt-token';
    fetchSpy.mockResolvedValueOnce(makeStsResponse('ghs_installed_token'));

    const provider = new OctoStsTokenProvider('my-org', 'my-repo', {
      identity: 'mandible-colony',
    });

    const token = await provider.resolve();
    expect(token).toBe('ghs_installed_token');

    // Verify the STS call
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('octo-sts.dev/sts/exchange');
    expect(String(url)).toContain('scope=my-org%2Fmy-repo');
    expect(String(url)).toContain('identity=mandible-colony');
    expect((init as RequestInit).headers).toEqual({
      'Authorization': 'Bearer oidc-jwt-token',
    });
  });

  it('uses custom stsUrl when provided', async () => {
    process.env.OIDC_TOKEN = 'oidc-token';
    fetchSpy.mockResolvedValueOnce(makeStsResponse('ghs_tok'));

    const provider = new OctoStsTokenProvider('org', 'repo', {
      identity: 'test',
      stsUrl: 'https://custom-sts.example.com',
    });

    await provider.resolve();
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('custom-sts.example.com/sts/exchange');
  });

  it('caches token across multiple resolve() calls', async () => {
    process.env.OIDC_TOKEN = 'oidc-token';
    fetchSpy.mockResolvedValueOnce(
      makeStsResponse('ghs_cached', new Date(Date.now() + 60 * 60 * 1000).toISOString())
    );

    const provider = new OctoStsTokenProvider('org', 'repo', { identity: 'test' });

    const t1 = await provider.resolve();
    const t2 = await provider.resolve();
    const t3 = await provider.resolve();

    expect(t1).toBe('ghs_cached');
    expect(t2).toBe('ghs_cached');
    expect(t3).toBe('ghs_cached');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Only one HTTP call
  });

  it('refreshes token when near expiry', async () => {
    process.env.OIDC_TOKEN = 'oidc-token';
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    fetchSpy.mockResolvedValueOnce(makeStsResponse('ghs_first', expiresAt));

    const provider = new OctoStsTokenProvider('org', 'repo', { identity: 'test' });

    const t1 = await provider.resolve();
    expect(t1).toBe('ghs_first');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance time to within refresh margin (5 min before expiry)
    const refreshExpiresAt = new Date(Date.now() + 56 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString();
    fetchSpy.mockResolvedValueOnce(makeStsResponse('ghs_refreshed', refreshExpiresAt));

    vi.advanceTimersByTime(56 * 60 * 1000); // 56 minutes forward — within 5-min margin

    const t2 = await provider.resolve();
    expect(t2).toBe('ghs_refreshed');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('discovers OIDC token from OIDC_TOKEN env var', async () => {
    process.env.OIDC_TOKEN = 'env-oidc-token';
    fetchSpy.mockResolvedValueOnce(makeStsResponse('ghs_tok'));

    const provider = new OctoStsTokenProvider('org', 'repo', { identity: 'test' });
    await provider.resolve();

    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toEqual({
      'Authorization': 'Bearer env-oidc-token',
    });
  });

  it('discovers OIDC token from GitHub Actions provider', async () => {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://actions-token.example.com/token?version=1';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'actions-bearer-token';

    // First call: GitHub Actions OIDC endpoint
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ value: 'actions-oidc-jwt' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    // Second call: STS exchange
    fetchSpy.mockResolvedValueOnce(makeStsResponse('ghs_from_actions'));

    const provider = new OctoStsTokenProvider('org', 'repo', { identity: 'test' });
    const token = await provider.resolve();

    expect(token).toBe('ghs_from_actions');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Verify OIDC call to GitHub Actions
    const [oidcUrl, oidcInit] = fetchSpy.mock.calls[0];
    expect(String(oidcUrl)).toContain('actions-token.example.com/token');
    expect(String(oidcUrl)).toContain('audience=octo-sts.dev');
    expect((oidcInit as RequestInit).headers).toEqual({
      'Authorization': 'Bearer actions-bearer-token',
    });

    // Verify STS exchange used the Actions OIDC token
    const [, stsInit] = fetchSpy.mock.calls[1];
    expect((stsInit as RequestInit).headers).toEqual({
      'Authorization': 'Bearer actions-oidc-jwt',
    });
  });

  it('uses explicit oidcToken string override', async () => {
    fetchSpy.mockResolvedValueOnce(makeStsResponse('ghs_tok'));

    const provider = new OctoStsTokenProvider('org', 'repo', {
      identity: 'test',
      oidcToken: 'explicit-oidc-string',
    });

    await provider.resolve();
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toEqual({
      'Authorization': 'Bearer explicit-oidc-string',
    });
  });

  it('uses explicit oidcToken async callback override', async () => {
    fetchSpy.mockResolvedValueOnce(makeStsResponse('ghs_tok'));

    const provider = new OctoStsTokenProvider('org', 'repo', {
      identity: 'test',
      oidcToken: async () => 'callback-oidc-token',
    });

    await provider.resolve();
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toEqual({
      'Authorization': 'Bearer callback-oidc-token',
    });
  });

  it('throws helpful error when no OIDC source is available', async () => {
    const provider = new OctoStsTokenProvider('org', 'repo', { identity: 'test' });

    await expect(provider.resolve()).rejects.toThrow('octo-sts: no OIDC token available');
    await expect(provider.resolve()).rejects.toThrow('OIDC_TOKEN');
    await expect(provider.resolve()).rejects.toThrow('ACTIONS_ID_TOKEN_REQUEST_URL');
  });

  it('throws on STS exchange failure (4xx)', async () => {
    process.env.OIDC_TOKEN = 'oidc-token';
    fetchSpy.mockResolvedValueOnce(
      new Response('forbidden', { status: 403, statusText: 'Forbidden' })
    );

    const provider = new OctoStsTokenProvider('org', 'repo', { identity: 'test' });
    await expect(provider.resolve()).rejects.toThrow('octo-sts exchange failed: 403 Forbidden');
  });

  it('throws on STS exchange failure (5xx)', async () => {
    process.env.OIDC_TOKEN = 'oidc-token';
    fetchSpy.mockResolvedValueOnce(
      new Response('internal error', { status: 500, statusText: 'Internal Server Error' })
    );

    const provider = new OctoStsTokenProvider('org', 'repo', { identity: 'test' });
    await expect(provider.resolve()).rejects.toThrow('octo-sts exchange failed: 500');
  });

  it('handles JSON response with expires_at', async () => {
    process.env.OIDC_TOKEN = 'oidc-token';
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    fetchSpy.mockResolvedValueOnce(makeStsResponse('ghs_with_expiry', expiresAt));

    const provider = new OctoStsTokenProvider('org', 'repo', { identity: 'test' });
    const token = await provider.resolve();
    expect(token).toBe('ghs_with_expiry');
  });

  it('handles plain text response', async () => {
    process.env.OIDC_TOKEN = 'oidc-token';
    fetchSpy.mockResolvedValueOnce(
      new Response('  ghs_plaintext_token  \n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    );

    const provider = new OctoStsTokenProvider('org', 'repo', { identity: 'test' });
    const token = await provider.resolve();
    expect(token).toBe('ghs_plaintext_token');
  });
});

// ----------------------------------------------------------
// createTokenProvider factory
// ----------------------------------------------------------

describe('createTokenProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = originalEnv.GITHUB_TOKEN;
  });

  it('returns StaticTokenProvider when token is provided', () => {
    const provider = createTokenProvider({
      owner: 'org', repo: 'repo', token: 'ghp_test',
    });
    expect(provider).toBeDefined();
    expect(provider!.constructor.name).toBe('StaticTokenProvider');
  });

  it('returns OctoStsTokenProvider when sts is provided', () => {
    const provider = createTokenProvider({
      owner: 'org', repo: 'repo', sts: { identity: 'test' },
    });
    expect(provider).toBeDefined();
    expect(provider!.constructor.name).toBe('OctoStsTokenProvider');
  });

  it('throws when both token and sts are provided', () => {
    expect(() => createTokenProvider({
      owner: 'org', repo: 'repo',
      token: 'ghp_test', sts: { identity: 'test' },
    })).toThrow('cannot specify both token and sts');
  });

  it('falls back to GITHUB_TOKEN env var', () => {
    process.env.GITHUB_TOKEN = 'ghp_env_token';
    const provider = createTokenProvider({ owner: 'org', repo: 'repo' });
    expect(provider).toBeDefined();
    // Env fallback is lazy so zone secret rotation propagates without restart.
    expect(provider!.constructor.name).toBe('EnvTokenProvider');
  });

  it('returns undefined when no token source is available', () => {
    const provider = createTokenProvider({ owner: 'org', repo: 'repo' });
    expect(provider).toBeUndefined();
  });
});

describe('env-sourced token rotation', () => {
  it('re-reads GITHUB_TOKEN from env on every resolve', async () => {
    // Zone secret rotation (refreshSecretsIntoEnv) replaces env values at
    // runtime; an env-sourced provider must serve the rotated token without
    // a colony restart.
    process.env.GITHUB_TOKEN = 'ghp_before_rotation';
    const provider = createTokenProvider({ owner: 'acme', repo: 'app' });
    expect(provider).toBeDefined();
    expect(await provider!.resolve()).toBe('ghp_before_rotation');

    process.env.GITHUB_TOKEN = 'ghp_after_rotation';
    expect(await provider!.resolve()).toBe('ghp_after_rotation');
    delete process.env.GITHUB_TOKEN;
  });

  it('an explicit config token stays pinned — rotation applies to env sourcing only', async () => {
    process.env.GITHUB_TOKEN = 'ghp_env';
    const provider = createTokenProvider({ owner: 'acme', repo: 'app', token: 'ghp_pinned' });
    process.env.GITHUB_TOKEN = 'ghp_env_rotated';
    expect(await provider!.resolve()).toBe('ghp_pinned');
    delete process.env.GITHUB_TOKEN;
  });
});
