// PURPOSE: Integration test for octo-sts token exchange with GitHubEnvironment
// PURPOSE: Run with: OIDC_TOKEN=<your-google-id-token> npx tsx examples/test-sts-exchange.ts

import { GitHubEnvironment } from '../src/environments/github/index.js';

const OWNER = 'sparrowlabsdev';
const REPO = 'golem-test';

// STS identity — must match .github/chainguard/{identity}.sts.yaml in the target repo
// Use 'mandible-colony' for GitHub Actions OIDC, 'mandible-colony-google' for Google OIDC
const IDENTITY = process.env.STS_IDENTITY ?? 'mandible-colony-google';

async function main() {
  console.log(`\n--- octo-sts integration test ---`);
  console.log(`Target: ${OWNER}/${REPO}`);
  console.log(`Identity: ${IDENTITY}`);
  console.log(`OIDC source: ${process.env.OIDC_TOKEN ? 'OIDC_TOKEN env var' : 'auto-discover'}\n`);

  const env = new GitHubEnvironment({
    owner: OWNER,
    repo: REPO,
    sts: { identity: IDENTITY },
  });

  console.log('Syncing from GitHub via STS token exchange...');
  await env.sync();

  const signals = await env.snapshot();
  console.log(`Observed ${signals.length} signals:\n`);
  for (const s of signals.slice(0, 10)) {
    console.log(`  [${s.type}] ${s.id}`);
    console.log(`    concentration: ${s.meta.concentration.toFixed(3)}`);
    console.log(`    tags: ${s.meta.tags?.join(', ') || '(none)'}`);
    console.log();
  }

  if (signals.length === 0) {
    console.error('FAIL: Expected at least 1 signal from golem-test issues');
    process.exit(1);
  }

  console.log(`PASS: STS exchange worked — ${signals.length} signals observed via short-lived token`);
}

main().catch((err) => {
  console.error('FAIL:', err.message ?? err);
  process.exit(1);
});
