#!/usr/bin/env node
// ============================================================
// mandible CLI — entry point
// ============================================================

import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case 'dev':
      await runDev(args.slice(1));
      break;
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;
    case '--version':
    case '-v':
      printVersion();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  console.log(`
  mandible — stigmergy framework for autonomous agent coordination

  Usage:
    mandible dev [config]    Start colonies + open dashboard

  Options:
    --port <number>          Dashboard port (default: 4040)
    --no-open                Don't auto-open the browser
    -h, --help               Show this help
    -v, --version            Show version
`);
}

function printVersion() {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = resolve(dirname(__filename), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    console.log(`mandible v${pkg.version}`);
  } catch {
    console.log('mandible v0.1.0');
  }
}

async function runDev(devArgs: string[]) {
  let configPath = 'mandible.config.ts';
  let port = 4040;
  let openBrowser = true;

  for (let i = 0; i < devArgs.length; i++) {
    const arg = devArgs[i];
    if (arg === '--port' && devArgs[i + 1]) {
      port = parseInt(devArgs[++i], 10);
    } else if (arg === '--no-open') {
      openBrowser = false;
    } else if (!arg.startsWith('-')) {
      configPath = arg;
    }
  }

  const resolved = resolve(process.cwd(), configPath);
  if (!existsSync(resolved)) {
    console.error(`Config file not found: ${resolved}`);
    console.error(`Create a mandible.config.ts or specify one: mandible dev ./my-config.ts`);
    process.exit(1);
  }

  console.log(`\n  mandible dev`);
  console.log(`  config: ${resolved}`);
  console.log(`  dashboard: http://localhost:${port}\n`);

  // Dynamic import the config file
  // For .ts files, try native import first (works under tsx/ts-node),
  // then fall back to jiti for compiled JS contexts.
  let config: any;
  const configUrl = pathToFileURL(resolved).href;
  try {
    const mod = await import(configUrl);
    config = mod.default ?? mod;
  } catch (nativeErr: any) {
    if (resolved.endsWith('.ts')) {
      // Native import failed on a .ts file — try jiti as fallback
      try {
        const { default: jiti } = await import('jiti');
        const loader = jiti(resolved, { interopDefault: true });
        config = loader(resolved);
      } catch {
        console.error(`Failed to load TypeScript config: ${resolved}`);
        console.error(`Run via tsx:   npx tsx src/cli/index.ts dev`);
        console.error(`Or install jiti: npm install -D jiti`);
        process.exit(1);
      }
    } else {
      console.error(`Failed to load config: ${nativeErr.message}`);
      process.exit(1);
    }
  }

  const { startDevServer } = await import('./server.js');
  await startDevServer(config, { port, open: openBrowser });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
