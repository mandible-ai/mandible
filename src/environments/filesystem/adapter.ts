// ============================================================
// Filesystem Environment Adapter
// ============================================================
// Maps the stigmergy Environment interface to a filesystem.
//
// Structure:
//   {root}/
//     signals/
//       {signal-id}.json    — active signals
//     withdrawn/
//       {signal-id}.json    — withdrawn signals (history)
//     claims/
//       {signal-id}.lock    — claim locks (atomic via rename)
//
// This is intentionally transparent — you can `ls` the signals
// directory and see exactly what the colony state looks like.
// The filesystem IS the environment. Observability is free.
// ============================================================

import { readdir, readFile, writeFile, rename, unlink, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { watch } from 'node:fs';
import type {
  Signal, SignalQuery, Subscription, DecayResult, SignalMeta,
  EnvironmentConfig, SerializableEnvironment,
} from '../../core/types.js';
import { registerEnvironment } from '../../core/environment-registry.js';
import {
  createSignal, matchesQuery, decayConcentration, isExpired, isClaimExpired
} from '../../core/signal.js';
import { validateSignalInput } from '../../core/validation.js';

export interface FilesystemEnvConfig {
  /** Root directory for this environment */
  root: string;
  /** Human-readable name */
  name?: string;
}

export class FilesystemEnvironment implements SerializableEnvironment {
  readonly name: string;
  private root: string;
  private signalsDir: string;
  private withdrawnDir: string;
  private claimsDir: string;
  private initialized = false;

  constructor(config: FilesystemEnvConfig) {
    this.name = config.name ?? `fs:${config.root}`;
    this.root = config.root;
    this.signalsDir = join(config.root, 'signals');
    this.withdrawnDir = join(config.root, 'withdrawn');
    this.claimsDir = join(config.root, 'claims');
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.signalsDir, { recursive: true });
    await mkdir(this.withdrawnDir, { recursive: true });
    await mkdir(this.claimsDir, { recursive: true });
    this.initialized = true;
  }

  // ----------------------------------------------------------
  // Core operations
  // ----------------------------------------------------------

  async observe(query: SignalQuery): Promise<Signal[]> {
    await this.ensureInit();
    const signals = await this.readAllSignals();
    let matched = signals.filter(s => matchesQuery(s, query));

    // Apply limit
    if (query.limit) {
      matched = matched.slice(0, query.limit);
    }

    return matched;
  }

  async deposit(
    input: Omit<Signal, 'id' | 'meta'> & { meta?: Partial<SignalMeta> }
  ): Promise<Signal> {
    await this.ensureInit();
    validateSignalInput(input);

    const signal = createSignal(input.type, input.payload, {
      deposited_by: input.meta?.deposited_by,
      ttl: input.meta?.ttl,
      tags: input.meta?.tags,
      caused_by: input.meta?.caused_by,
      concentration: input.meta?.concentration,
    });

    const filePath = join(this.signalsDir, `${signal.id}.json`);
    await writeFile(filePath, JSON.stringify(signal, null, 2), 'utf-8');

    return signal;
  }

  async withdraw(signalId: string): Promise<void> {
    await this.ensureInit();
    const srcPath = join(this.signalsDir, `${signalId}.json`);
    const dstPath = join(this.withdrawnDir, `${signalId}.json`);

    try {
      // Move to withdrawn (preserves history)
      await rename(srcPath, dstPath);
    } catch {
      // Signal may already be withdrawn or not exist
    }

    // Also clean up any claim
    try {
      await unlink(join(this.claimsDir, `${signalId}.lock`));
    } catch {
      // No claim to clean up
    }
  }

  async claim(
    signalId: string,
    claimant: string,
    leaseDuration: number = 60_000
  ): Promise<boolean> {
    await this.ensureInit();

    const lockPath = join(this.claimsDir, `${signalId}.lock`);
    const tempPath = join(this.claimsDir, `${signalId}.${claimant}.tmp`);

    try {
      // Write our claim to a temp file first
      const claimData = {
        claimant,
        claimed_at: Date.now(),
        lease_duration: leaseDuration,
      };
      await writeFile(tempPath, JSON.stringify(claimData), { flag: 'wx' });

      // Atomic rename — if the lock file already exists, someone else claimed it
      // Check if lock already exists
      if (existsSync(lockPath)) {
        // Check if existing claim is expired
        const existingClaim = JSON.parse(await readFile(lockPath, 'utf-8'));
        const isLeaseExpired = Date.now() - existingClaim.claimed_at > existingClaim.lease_duration;

        if (!isLeaseExpired) {
          // Claim is still active — we lose
          await unlink(tempPath);
          return false;
        }
        // Expired claim — we can take over
        await unlink(lockPath);
      }

      await rename(tempPath, lockPath);

      // Update the signal's meta
      const signalPath = join(this.signalsDir, `${signalId}.json`);
      try {
        const raw = await readFile(signalPath, 'utf-8');
        const signal: Signal = JSON.parse(raw);
        signal.meta.claimed_by = claimant;
        signal.meta.claimed_at = Date.now();
        signal.meta.claim_lease = leaseDuration;
        await writeFile(signalPath, JSON.stringify(signal, null, 2));
      } catch {
        // Signal may have been withdrawn while we were claiming
      }

      return true;
    } catch {
      // Clean up temp file on any error
      try { await unlink(tempPath); } catch { /* ignore */ }
      return false;
    }
  }

  async release(signalId: string): Promise<void> {
    await this.ensureInit();

    // Remove the lock file
    try {
      await unlink(join(this.claimsDir, `${signalId}.lock`));
    } catch { /* no claim to release */ }

    // Update signal meta
    const signalPath = join(this.signalsDir, `${signalId}.json`);
    try {
      const raw = await readFile(signalPath, 'utf-8');
      const signal: Signal = JSON.parse(raw);
      signal.meta.claimed_by = undefined;
      signal.meta.claimed_at = undefined;
      signal.meta.claim_lease = undefined;
      await writeFile(signalPath, JSON.stringify(signal, null, 2));
    } catch { /* signal may not exist */ }
  }

  watch(query: SignalQuery, callback: (signal: Signal) => void): Subscription {
    const seen = new Set<string>();
    let active = true;
    let watcher: ReturnType<typeof watch> | undefined;

    // Ensure directory exists then set up watch
    const setup = async () => {
      await this.ensureInit();

      // Initial scan for existing signals
      const signals = await this.observe(query);
      for (const signal of signals) {
        if (!active) return;
        seen.add(signal.id);
        callback(signal);
      }

      if (!active) return;

      // Watch for new signal files
      watcher = watch(this.signalsDir, async (eventType, filename) => {
        if (!active || !filename?.endsWith('.json')) return;

        const signalId = filename.replace('.json', '');
        if (seen.has(signalId)) return;

        try {
          const raw = await readFile(join(this.signalsDir, filename), 'utf-8');
          const signal: Signal = JSON.parse(raw);

          if (matchesQuery(signal, query)) {
            seen.add(signal.id);
            callback(signal);
          }
        } catch {
          // File may have been withdrawn already — that's fine
        }
      });
    };

    setup();

    return {
      unsubscribe() {
        active = false;
        watcher?.close();
      }
    };
  }

  async history(
    query: SignalQuery & { includeWithdrawn?: boolean }
  ): Promise<Signal[]> {
    await this.ensureInit();

    const active = await this.readAllSignals();
    let all = active;

    if (query.includeWithdrawn) {
      const withdrawn = await this.readDir(this.withdrawnDir);
      all = [...active, ...withdrawn];
    }

    let matched = all.filter(s => matchesQuery(s, query));
    if (query.limit) matched = matched.slice(0, query.limit);

    return matched;
  }

  async decay(): Promise<DecayResult> {
    await this.ensureInit();
    const now = Date.now();
    const result: DecayResult = { decayed: 0, evaporated: 0, claimsReleased: 0 };

    const signals = await this.readAllSignals();

    for (const signal of signals) {
      let changed = false;

      // Check TTL expiration
      if (isExpired(signal, now)) {
        await this.withdraw(signal.id);
        result.evaporated++;
        continue;
      }

      // Check claim lease expiration
      if (isClaimExpired(signal, now)) {
        await this.release(signal.id);
        signal.meta.claimed_by = undefined;
        signal.meta.claimed_at = undefined;
        signal.meta.claim_lease = undefined;
        result.claimsReleased++;
        changed = true;
      }

      // Apply concentration decay (default: 1% per second)
      const decayRate = 0.01;
      const newConc = decayConcentration(signal, decayRate, now);

      if (newConc < 0.05) {
        // Below floor — evaporate
        await this.withdraw(signal.id);
        result.evaporated++;
        continue;
      }

      if (Math.abs(newConc - signal.meta.concentration) > 0.001) {
        signal.meta.concentration = newConc;
        changed = true;
        result.decayed++;
      }

      if (changed) {
        const filePath = join(this.signalsDir, `${signal.id}.json`);
        await writeFile(filePath, JSON.stringify(signal, null, 2));
      }
    }

    return result;
  }

  async snapshot(): Promise<Signal[]> {
    await this.ensureInit();
    return this.readAllSignals();
  }

  // ----------------------------------------------------------
  // Serialization
  // ----------------------------------------------------------

  serialize(): EnvironmentConfig {
    return { type: 'filesystem', name: this.name, root: this.root };
  }

  // ----------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------

  private async readAllSignals(): Promise<Signal[]> {
    return this.readDir(this.signalsDir);
  }

  private async readDir(dir: string): Promise<Signal[]> {
    try {
      const files = await readdir(dir);
      const signals: Signal[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(dir, file), 'utf-8');
          signals.push(JSON.parse(raw));
        } catch {
          // Corrupted or in-flight file — skip
        }
      }

      return signals;
    } catch {
      return [];
    }
  }

}

// Self-register for deserialization
registerEnvironment('filesystem', (c) => new FilesystemEnvironment({
  root: (c.root as string) ?? '/tmp/mandible-signals',
  name: c.name,
}));
