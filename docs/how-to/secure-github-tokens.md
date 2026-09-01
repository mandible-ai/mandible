# Secure GitHub Tokens with octo-sts

Mandible colonies that operate on GitHub repositories need API credentials. Long-lived Personal Access Tokens (PATs) are a security liability — if an agent leaks one into logs, conversation context, or a serialized config, anyone can use it indefinitely.

**octo-sts** eliminates this risk. It exchanges short-lived OIDC identity tokens for short-lived GitHub installation tokens. Even if leaked, they expire in minutes. No secrets to manage, rotate, or accidentally commit.

## One-time setup (5 minutes)

You do this once per GitHub organization. Every colony after that gets secure tokens automatically.

### Step 1: Install the octo-sts GitHub App

Go to [github.com/apps/octo-sts](https://github.com/apps/octo-sts) and install it on your organization. Grant it access to the repositories your colonies will operate on.

The app requests broad permissions because it can only mint tokens with permissions it has. It uses `contents: read` for reading trust policies and `checks: write` for validating them — all other permissions exist solely for producing scoped tokens.

### Step 2: Add a trust policy

Create a file in each target repository at `.github/chainguard/<identity>.sts.yaml`. The identity name is how colonies identify themselves when requesting tokens.

**For colonies running in GitHub Actions:**

```yaml
# .github/chainguard/mandible-colony.sts.yaml
issuer: https://token.actions.githubusercontent.com
subject_pattern: "repo:your-org/your-repo:.*"
permissions:
  contents: read
  issues: write
  pull_requests: write
```

**For colonies with Google Cloud identity (Edera zones, GCE, Cloud Run):**

```yaml
# .github/chainguard/mandible-colony-gcp.sts.yaml
issuer: https://accounts.google.com
subject_pattern: "[0-9]+"
permissions:
  contents: read
  issues: write
  pull_requests: write
```

That's it. No tokens to generate, no secrets to store.

## Using STS in your colony

Replace `token` with `sts` in your GitHubEnvironment config:

```typescript
import { GitHubEnvironment } from '@mandible-ai/mandible';

// Before: long-lived PAT (risky)
const env = new GitHubEnvironment({
  owner: 'your-org',
  repo: 'your-repo',
  token: process.env.GITHUB_TOKEN,  // ghp_... lives forever
});

// After: octo-sts (secure)
const env = new GitHubEnvironment({
  owner: 'your-org',
  repo: 'your-repo',
  sts: { identity: 'mandible-colony' },
});
```

The `identity` must match the filename of your trust policy (without the `.sts.yaml` extension).

### How the OIDC token is discovered

When `resolve()` is called, the token provider looks for an OIDC token in this order:

1. **Explicit override** — `sts.oidcToken` (string or async callback)
2. **`OIDC_TOKEN` env var** — set by your runtime or CI
3. **GitHub Actions OIDC** — automatic in workflows with `id-token: write` permission

Most runtimes provide OIDC tokens natively. You typically don't need to configure anything beyond `identity`.

### GitHub Actions example

```yaml
permissions:
  id-token: write  # Required for OIDC federation

steps:
  - uses: octo-sts/action@v1.0.0
    id: octo-sts
    with:
      scope: your-org/your-repo
      identity: mandible-colony

  - run: node run-colony.mjs
    env:
      # The action sets this automatically, but you can also
      # pass the token explicitly if you prefer:
      GITHUB_TOKEN: ${{ steps.octo-sts.outputs.token }}
```

Or skip the action entirely — mandible discovers the OIDC token from the Actions runtime:

```yaml
permissions:
  id-token: write

steps:
  - run: node run-colony.mjs
    # No token needed — GitHubEnvironment with sts: { identity: '...' }
    # auto-discovers the Actions OIDC token and exchanges it
```

## Token lifecycle

```
Colony starts
  → OctoStsTokenProvider.resolve()
    → Discovers OIDC token (env var, Actions runtime, or explicit)
    → GET https://octo-sts.dev/sts/exchange?scope=org/repo&identity=name
      Authorization: Bearer <OIDC token>
    → Returns: { token: "ghs_...", expiry: ... }
  → Token cached for ~55 minutes (refreshes 5 min before expiry)
  → GitHub API calls use short-lived ghs_... token
```

Tokens are:
- **Short-lived** — expire within 1 hour
- **Scoped** — only have the permissions specified in the trust policy
- **Cached** — one exchange per hour, not per API call
- **Never serialized** — `serialize()` omits tokens from the config; the OIDC discovery runs again on deserialization

## Trust policy reference

| Field | Description |
|-------|-------------|
| `issuer` | Exact match on OIDC token issuer |
| `issuer_pattern` | Regex match on issuer |
| `subject` | Exact match on token subject |
| `subject_pattern` | Regex match on subject |
| `claim_pattern` | Map of claim names to regex patterns |
| `audience` | Expected audience claim (defaults to `octo-sts.dev`) |
| `audience_pattern` | Regex match on audience |
| `permissions` | GitHub API permissions to grant (see [GitHub docs](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)) |

### Principle of least privilege

Only grant the permissions your colony actually needs:

```yaml
# Read-only colony (monitoring, reporting)
permissions:
  contents: read
  issues: read

# Worker colony (processes issues, creates PRs)
permissions:
  contents: write
  issues: write
  pull_requests: write

# Deployment colony
permissions:
  contents: read
  deployments: write
  environments: write
```

## Fallback chain

All three authentication methods still work. The first match wins:

1. `sts: { identity: '...' }` — octo-sts exchange (recommended)
2. `token: 'ghp_...'` — explicit PAT
3. `GITHUB_TOKEN` env var — implicit PAT

For local development, you can use a PAT for quick iteration and switch to STS for anything that runs unattended.

## Security properties

| Property | PAT | octo-sts |
|----------|-----|----------|
| Lifetime | Indefinite | ~1 hour |
| Scope | All repos the user can access | Single repo, explicit permissions |
| Revocation | Manual | Automatic on expiry |
| Leaked in logs | Full access until manually revoked | Useless within minutes |
| Serialized in config | Yes (if not careful) | Never — OIDC discovery at runtime |
| Rotation | Manual | Automatic |
