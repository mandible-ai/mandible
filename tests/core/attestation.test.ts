// PURPOSE: Tests for Ed25519 attestation, signing, and verification
// PURPOSE: Covers identity, signing, verification, attestation chains, trust levels, policy constraints

import { describe, it, expect, beforeAll } from 'vitest';
import {
  generateIdentity,
  canonicalHash,
  attestationHash,
  signSignal,
  createSigner,
  verifySignature,
  verifyAttestationChain,
  verifySignal,
  createAttestation,
  prepareForBridge,
} from '../../src/core/attestation.js';
import { createSignal } from '../../src/core/signal.js';
import type { Signal, ColonyIdentity, TrustPolicy, Attestation } from '../../src/core/types.js';

// ── Shared fixtures ─────────────────────────────────────────

let shaperIdentity: ColonyIdentity;
let criticIdentity: ColonyIdentity;
let bridgeIdentity: ColonyIdentity;

beforeAll(async () => {
  shaperIdentity = await generateIdentity('shaper', 'local');
  criticIdentity = await generateIdentity('critic', 'local');
  bridgeIdentity = await generateIdentity('github-bridge', 'bridge');
});

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  const base = createSignal('task:ready', { name: 'test' }, { deposited_by: 'shaper' });
  return { ...base, ...overrides, meta: { ...base.meta, ...overrides.meta } };
}

// ── generateIdentity ────────────────────────────────────────

describe('generateIdentity', () => {
  it('produces a valid keypair with expected fields', async () => {
    const id = await generateIdentity('colony-a', 'env-local');

    expect(id.name).toBe('colony-a');
    expect(id.environment).toBe('env-local');
    expect(id.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(id.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(id.createdAt).toBeGreaterThan(0);
  });

  it('generates unique keypairs each call', async () => {
    const a = await generateIdentity('a', 'env');
    const b = await generateIdentity('b', 'env');
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it('stores optional metadata', async () => {
    const id = await generateIdentity('a', 'env', { version: '1.0' });
    expect(id.metadata).toEqual({ version: '1.0' });
  });

  it('leaves metadata undefined when not provided', async () => {
    const id = await generateIdentity('a', 'env');
    expect(id.metadata).toBeUndefined();
  });
});

// ── canonicalHash ───────────────────────────────────────────

describe('canonicalHash', () => {
  it('produces a hex-encoded sha256 hash', () => {
    const s = makeSignal();
    const hash = canonicalHash(s);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes type + payload + caused_by', () => {
    const a = makeSignal({ type: 'task:ready', payload: { x: 1 } });
    const b = makeSignal({ type: 'task:ready', payload: { x: 1 } });
    // Same semantic content → same hash (even if ids differ)
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it('changes when type differs', () => {
    const a = makeSignal({ type: 'task:ready' });
    const b = makeSignal({ type: 'task:done' });
    expect(canonicalHash(a)).not.toBe(canonicalHash(b));
  });

  it('changes when payload differs', () => {
    const a = makeSignal({ payload: { x: 1 } });
    const b = makeSignal({ payload: { x: 2 } });
    expect(canonicalHash(a)).not.toBe(canonicalHash(b));
  });

  it('changes when caused_by differs', () => {
    const a = makeSignal({ meta: { caused_by: ['sig_1'] } });
    const b = makeSignal({ meta: { caused_by: ['sig_2'] } });
    expect(canonicalHash(a)).not.toBe(canonicalHash(b));
  });

  it('ignores mutable meta fields (id, concentration, timestamps)', () => {
    const a = makeSignal({ id: 'sig_aaa', meta: { concentration: 1.0, deposited_at: 1000 } });
    const b = makeSignal({ id: 'sig_bbb', meta: { concentration: 0.5, deposited_at: 9999 } });
    // Same type, payload, and caused_by → same hash
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it('treats missing caused_by as empty array', () => {
    const a = makeSignal();
    const b = makeSignal({ meta: { caused_by: [] } });
    // Both should hash caused_by as []
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });
});

// ── attestationHash ─────────────────────────────────────────

describe('attestationHash', () => {
  it('produces a hex-encoded sha256 hash', () => {
    const hash = attestationHash('sig_1', 'env-a', 'env-b', 1000);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any input differs', () => {
    const base = attestationHash('sig_1', 'env-a', 'env-b', 1000);
    expect(attestationHash('sig_2', 'env-a', 'env-b', 1000)).not.toBe(base);
    expect(attestationHash('sig_1', 'env-X', 'env-b', 1000)).not.toBe(base);
    expect(attestationHash('sig_1', 'env-a', 'env-X', 1000)).not.toBe(base);
    expect(attestationHash('sig_1', 'env-a', 'env-b', 9999)).not.toBe(base);
  });

  it('changes when previousSignature differs', () => {
    const without = attestationHash('sig_1', 'a', 'b', 1000);
    const with1 = attestationHash('sig_1', 'a', 'b', 1000, 'prev_sig_1');
    const with2 = attestationHash('sig_1', 'a', 'b', 1000, 'prev_sig_2');
    expect(without).not.toBe(with1);
    expect(with1).not.toBe(with2);
  });

  it('treats missing previousSignature as null', () => {
    const a = attestationHash('sig_1', 'a', 'b', 1000);
    const b = attestationHash('sig_1', 'a', 'b', 1000, undefined);
    expect(a).toBe(b);
  });
});

// ── signSignal / verifySignature ────────────────────────────

describe('signSignal + verifySignature', () => {
  it('signs a signal and verification succeeds', async () => {
    const signal = makeSignal();
    const signed = await signSignal(signal, shaperIdentity);

    expect(signed.meta.signature).toBeDefined();
    expect(signed.meta.signer).toBe(shaperIdentity.publicKey);
    expect(await verifySignature(signed)).toBe(true);
  });

  it('does not mutate the original signal', async () => {
    const signal = makeSignal();
    const originalSig = signal.meta.signature;
    await signSignal(signal, shaperIdentity);
    expect(signal.meta.signature).toBe(originalSig);
  });

  it('preserves all original signal fields', async () => {
    const signal = makeSignal({
      type: 'task:ready',
      payload: { name: 'auth' },
      meta: { tags: ['urgent'], ttl: 5000 },
    });
    const signed = await signSignal(signal, shaperIdentity);

    expect(signed.type).toBe('task:ready');
    expect(signed.payload).toEqual({ name: 'auth' });
    expect(signed.meta.tags).toEqual(['urgent']);
    expect(signed.meta.ttl).toBe(5000);
  });

  it('rejects when payload is tampered', async () => {
    const signal = makeSignal({ payload: { name: 'original' } });
    const signed = await signSignal(signal, shaperIdentity);

    const tampered = {
      ...signed,
      payload: { name: 'tampered' },
    };
    expect(await verifySignature(tampered)).toBe(false);
  });

  it('rejects when type is tampered', async () => {
    const signal = makeSignal({ type: 'task:ready' });
    const signed = await signSignal(signal, shaperIdentity);

    const tampered = { ...signed, type: 'task:evil' };
    expect(await verifySignature(tampered)).toBe(false);
  });

  it('rejects when signature is from a different colony', async () => {
    const signal = makeSignal();
    const signed = await signSignal(signal, shaperIdentity);

    // Replace signer with critic's key (signature won't match)
    const swapped = {
      ...signed,
      meta: { ...signed.meta, signer: criticIdentity.publicKey },
    };
    expect(await verifySignature(swapped)).toBe(false);
  });

  it('returns false for unsigned signal', async () => {
    const signal = makeSignal();
    expect(await verifySignature(signal)).toBe(false);
  });

  it('returns false when signature is missing but signer is present', async () => {
    const signal = makeSignal({ meta: { signer: shaperIdentity.publicKey } });
    expect(await verifySignature(signal)).toBe(false);
  });

  it('returns false for corrupted signature hex', async () => {
    const signal = makeSignal();
    const signed = await signSignal(signal, shaperIdentity);
    const corrupted = {
      ...signed,
      meta: { ...signed.meta, signature: 'not_valid_hex_at_all' },
    };
    expect(await verifySignature(corrupted)).toBe(false);
  });
});

// ── createSigner ────────────────────────────────────────────

describe('createSigner', () => {
  it('signs all signals by default', async () => {
    const signer = createSigner({ identity: shaperIdentity });
    const signal = makeSignal();
    const signed = await signer(signal);

    expect(signed.meta.signature).toBeDefined();
    expect(await verifySignature(signed)).toBe(true);
  });

  it('skips signing when signAll is false', async () => {
    const signer = createSigner({ identity: shaperIdentity, signAll: false });
    const signal = makeSignal();
    const result = await signer(signal);

    expect(result.meta.signature).toBeUndefined();
  });

  it('excludes signal types matching excludeTypes patterns', async () => {
    const signer = createSigner({
      identity: shaperIdentity,
      excludeTypes: ['debug:*'],
    });

    const debug = makeSignal({ type: 'debug:trace' });
    const task = makeSignal({ type: 'task:ready' });

    expect((await signer(debug)).meta.signature).toBeUndefined();
    expect((await signer(task)).meta.signature).toBeDefined();
  });

  it('excludes exact type match', async () => {
    const signer = createSigner({
      identity: shaperIdentity,
      excludeTypes: ['health:ping'],
    });

    const ping = makeSignal({ type: 'health:ping' });
    expect((await signer(ping)).meta.signature).toBeUndefined();
  });
});

// ── createAttestation ───────────────────────────────────────

describe('createAttestation', () => {
  it('creates an attestation with expected fields', async () => {
    const att = await createAttestation(
      'sig_test',
      'env-github',
      'env-local',
      bridgeIdentity,
    );

    expect(att.attester).toBe('github-bridge');
    expect(att.attesterKey).toBe(bridgeIdentity.publicKey);
    expect(att.sourceEnvironment).toBe('env-github');
    expect(att.targetEnvironment).toBe('env-local');
    expect(att.timestamp).toBeGreaterThan(0);
    expect(att.signature).toMatch(/^[0-9a-f]+$/);
  });

  it('chains attestations by signing over the previous signature', async () => {
    const first = await createAttestation(
      'sig_test',
      'env-a',
      'env-b',
      bridgeIdentity,
    );

    const second = await createAttestation(
      'sig_test',
      'env-b',
      'env-c',
      bridgeIdentity,
      [first],
    );

    // Second attestation's hash includes the first's signature
    // so the two signatures must differ
    expect(second.signature).not.toBe(first.signature);
  });
});

// ── verifyAttestationChain ──────────────────────────────────

describe('verifyAttestationChain', () => {
  it('returns empty for no attestations', async () => {
    expect(await verifyAttestationChain('sig_1', [])).toEqual([]);
  });

  it('validates a single-hop chain', async () => {
    const att = await createAttestation('sig_1', 'env-a', 'env-b', bridgeIdentity);
    const results = await verifyAttestationChain('sig_1', [att]);

    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(true);
    expect(results[0].attester).toBe('github-bridge');
  });

  it('validates a multi-hop chain', async () => {
    const hop1 = await createAttestation('sig_1', 'env-a', 'env-b', bridgeIdentity);
    const hop2 = await createAttestation('sig_1', 'env-b', 'env-c', bridgeIdentity, [hop1]);

    const results = await verifyAttestationChain('sig_1', [hop1, hop2]);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.valid)).toBe(true);
  });

  it('rejects a chain with a tampered attestation', async () => {
    const att = await createAttestation('sig_1', 'env-a', 'env-b', bridgeIdentity);

    const tampered: Attestation = {
      ...att,
      sourceEnvironment: 'env-EVIL', // tamper the source
    };

    const results = await verifyAttestationChain('sig_1', [tampered]);
    expect(results[0].valid).toBe(false);
  });

  it('rejects when signalId changes', async () => {
    const att = await createAttestation('sig_1', 'env-a', 'env-b', bridgeIdentity);

    // Verify against a different signal ID
    const results = await verifyAttestationChain('sig_DIFFERENT', [att]);
    expect(results[0].valid).toBe(false);
  });

  it('handles corrupted signature gracefully', async () => {
    const att = await createAttestation('sig_1', 'env-a', 'env-b', bridgeIdentity);
    const corrupted: Attestation = { ...att, signature: 'badhex' };

    const results = await verifyAttestationChain('sig_1', [corrupted]);
    expect(results[0].valid).toBe(false);
    expect(results[0].reason).toContain('verification error');
  });
});

// ── prepareForBridge ────────────────────────────────────────

describe('prepareForBridge', () => {
  it('adds attestation and source environment', async () => {
    const signal = makeSignal();
    const bridged = await prepareForBridge(signal, 'env-github', 'env-local', bridgeIdentity);

    expect(bridged.meta.sourceEnvironment).toBe('env-github');
    expect(bridged.meta.attestations).toHaveLength(1);
    expect(bridged.meta.attestations![0].attester).toBe('github-bridge');
  });

  it('does not mutate the original signal', async () => {
    const signal = makeSignal();
    await prepareForBridge(signal, 'env-a', 'env-b', bridgeIdentity);
    expect(signal.meta.attestations).toBeUndefined();
    expect(signal.meta.sourceEnvironment).toBeUndefined();
  });

  it('appends to existing attestation chain', async () => {
    const signal = makeSignal();
    const firstBridge = await prepareForBridge(signal, 'env-a', 'env-b', bridgeIdentity);
    const secondBridge = await prepareForBridge(firstBridge, 'env-b', 'env-c', bridgeIdentity);

    expect(secondBridge.meta.attestations).toHaveLength(2);
  });

  it('preserves original sourceEnvironment on multi-hop', async () => {
    const signal = makeSignal();
    const firstBridge = await prepareForBridge(signal, 'env-origin', 'env-mid', bridgeIdentity);
    const secondBridge = await prepareForBridge(firstBridge, 'env-mid', 'env-final', bridgeIdentity);

    // sourceEnvironment should still be 'env-origin' (first hop)
    expect(secondBridge.meta.sourceEnvironment).toBe('env-origin');
  });

  it('produces a verifiable attestation chain', async () => {
    const signal = makeSignal();
    const bridged = await prepareForBridge(signal, 'env-a', 'env-b', bridgeIdentity);

    const results = await verifyAttestationChain(signal.id, bridged.meta.attestations!);
    expect(results.every(r => r.valid)).toBe(true);
  });
});

// ── verifySignal — trust level determination ────────────────

describe('verifySignal — trust levels', () => {
  it('returns unverified for signal with no provenance', async () => {
    const signal = makeSignal();
    const result = await verifySignal(signal);

    expect(result.trustLevel).toBe('unverified');
    expect(result.signatureValid).toBeNull();
    expect(result.attestationChainValid).toBeNull();
  });

  it('returns verified for valid colony signature (no attestations)', async () => {
    const signal = makeSignal();
    const signed = await signSignal(signal, shaperIdentity);

    const result = await verifySignal(signed);
    expect(result.trustLevel).toBe('verified');
    expect(result.signatureValid).toBe(true);
    expect(result.attestationChainValid).toBeNull();
  });

  it('returns verified for valid signature + valid attestation chain', async () => {
    const signal = makeSignal();
    const signed = await signSignal(signal, shaperIdentity);
    const bridged = await prepareForBridge(signed, 'env-a', 'env-b', bridgeIdentity);

    const result = await verifySignal(bridged);
    expect(result.trustLevel).toBe('verified');
    expect(result.signatureValid).toBe(true);
    expect(result.attestationChainValid).toBe(true);
  });

  it('returns attested for valid attestation chain but no colony signature', async () => {
    const signal = makeSignal();
    const bridged = await prepareForBridge(signal, 'env-a', 'env-b', bridgeIdentity);

    const result = await verifySignal(bridged);
    expect(result.trustLevel).toBe('attested');
    expect(result.signatureValid).toBeNull();
    expect(result.attestationChainValid).toBe(true);
  });

  it('returns rejected for invalid colony signature', async () => {
    const signal = makeSignal();
    const signed = await signSignal(signal, shaperIdentity);
    const tampered = { ...signed, payload: { name: 'tampered' } };

    const result = await verifySignal(tampered);
    expect(result.trustLevel).toBe('rejected');
    expect(result.signatureValid).toBe(false);
  });

  it('returns rejected for invalid attestation chain', async () => {
    const signal = makeSignal();
    const bridged = await prepareForBridge(signal, 'env-a', 'env-b', bridgeIdentity);

    // Tamper with attestation
    bridged.meta.attestations![0] = {
      ...bridged.meta.attestations![0],
      sourceEnvironment: 'env-EVIL',
    };

    const result = await verifySignal(bridged);
    expect(result.trustLevel).toBe('rejected');
    expect(result.attestationChainValid).toBe(false);
  });

  it('includes attestation results in output', async () => {
    const signal = makeSignal();
    const bridged = await prepareForBridge(signal, 'env-a', 'env-b', bridgeIdentity);

    const result = await verifySignal(bridged);
    expect(result.attestationResults).toHaveLength(1);
    expect(result.attestationResults![0].attester).toBe('github-bridge');
    expect(result.attestationResults![0].valid).toBe(true);
  });
});

// ── verifySignal — policy constraints ───────────────────────

describe('verifySignal — policy constraints', () => {
  const basePolicy: TrustPolicy = {
    name: 'test-policy',
    defaultTrust: 'unverified',
    minimumTrust: 'attested',
    trustedColonies: [],
    trustedBridges: [],
    quarantineRejected: true,
  };

  it('rejects attestation chain that exceeds maxAttestationAge', async () => {
    const signal = makeSignal();
    const bridged = await prepareForBridge(signal, 'env-a', 'env-b', bridgeIdentity);

    // Force an old timestamp
    bridged.meta.attestations![0] = {
      ...bridged.meta.attestations![0],
      timestamp: Date.now() - 999_999,
    };

    // Re-sign so the chain is cryptographically valid but old
    // (we can't re-sign easily, so just test the policy check with the tampered timestamp)
    const result = await verifySignal(bridged, {
      ...basePolicy,
      maxAttestationAge: 1000,
    });

    expect(result.trustLevel).toBe('rejected');
    expect(result.reason).toContain('too old');
  });

  it('rejects attestation chain that exceeds maxAttestationDepth', async () => {
    const signal = makeSignal();
    const hop1 = await prepareForBridge(signal, 'env-a', 'env-b', bridgeIdentity);
    const hop2 = await prepareForBridge(hop1, 'env-b', 'env-c', bridgeIdentity);

    const result = await verifySignal(hop2, {
      ...basePolicy,
      maxAttestationDepth: 1, // only 1 hop allowed, we have 2
    });

    expect(result.trustLevel).toBe('rejected');
    expect(result.reason).toContain('too deep');
  });

  it('rejects signal from blocked source environment', async () => {
    const signal = makeSignal();
    const bridged = await prepareForBridge(signal, 'env-untrusted', 'env-local', bridgeIdentity);

    const result = await verifySignal(bridged, {
      ...basePolicy,
      blockedSourceEnvironments: ['env-untrusted'],
    });

    expect(result.trustLevel).toBe('rejected');
    expect(result.reason).toContain('blocked');
  });

  it('rejects signal from source environment not in allowed list', async () => {
    const signal = makeSignal();
    const bridged = await prepareForBridge(signal, 'env-unknown', 'env-local', bridgeIdentity);

    const result = await verifySignal(bridged, {
      ...basePolicy,
      allowedSourceEnvironments: ['env-trusted-a', 'env-trusted-b'],
    });

    expect(result.trustLevel).toBe('rejected');
    expect(result.reason).toContain('not in allowed list');
  });

  it('accepts signal from source environment in allowed list', async () => {
    const signal = makeSignal();
    const bridged = await prepareForBridge(signal, 'env-trusted-a', 'env-local', bridgeIdentity);

    const result = await verifySignal(bridged, {
      ...basePolicy,
      allowedSourceEnvironments: ['env-trusted-a', 'env-trusted-b'],
    });

    // Should be attested (no colony signature, valid attestation)
    expect(result.trustLevel).toBe('attested');
  });

  it('does not apply policy checks when no policy provided', async () => {
    const signal = makeSignal();
    const bridged = await prepareForBridge(signal, 'env-untrusted', 'env-local', bridgeIdentity);

    const result = await verifySignal(bridged);
    expect(result.trustLevel).toBe('attested'); // no policy → no rejection
  });
});
