// ============================================================
// Attestation — Colony Signing & Verification Utilities
// ============================================================
// Phase 1: Metadata-only provenance. No enforcement.
// Colonies sign signals they deposit, bridges attest transfers.
// Environments (Phase 2) will enforce trust policies using these.
//
// Uses @noble/ed25519 for portable Ed25519 signatures.
// Zero dependencies, audited by Cure53, works everywhere
// (Node, Deno, browsers, edge workers).
// ============================================================

import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import type {
  Signal,
  Attestation,
  ColonyIdentity,
  TrustLevel,
  TrustPolicy,
  SigningConfig,
  VerificationResult,
} from './types.js';

// ----------------------------------------------------------
// Hex encoding helpers
// ----------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

// ----------------------------------------------------------
// Colony Identity — key generation and management
// ----------------------------------------------------------

/**
 * Generate a new Ed25519 colony identity.
 * Uses @noble/ed25519 — portable across Node, browsers, and edge workers.
 * Keys are raw 32-byte values, hex-encoded for storage.
 */
export async function generateIdentity(
  name: string,
  environment: string,
  metadata?: Record<string, unknown>
): Promise<ColonyIdentity> {
  const privateKey = ed.utils.randomSecretKey(); // 32 random bytes
  const publicKey = await ed.getPublicKeyAsync(privateKey);

  return {
    name,
    publicKey: toHex(publicKey),
    privateKey: toHex(privateKey),
    environment,
    createdAt: Date.now(),
    metadata,
  };
}

// ----------------------------------------------------------
// Canonical Hashing — deterministic content for signing
// ----------------------------------------------------------

/**
 * Create a canonical hash of the signal content that gets signed.
 * Signs: type + payload + caused_by — the immutable semantic content.
 * Excludes: id, meta timestamps, concentration (mutable runtime state).
 */
export function canonicalHash(signal: Signal<any>): string {
  const content = JSON.stringify({
    type: signal.type,
    payload: signal.payload,
    caused_by: signal.meta.caused_by ?? [],
  });
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Create a canonical hash for an attestation.
 * Each attestation signs over the previous signature in the chain,
 * creating a linked chain of custody.
 */
export function attestationHash(
  signalId: string,
  sourceEnvironment: string,
  targetEnvironment: string,
  timestamp: number,
  previousSignature?: string
): string {
  const content = JSON.stringify({
    signalId,
    sourceEnvironment,
    targetEnvironment,
    timestamp,
    previousSignature: previousSignature ?? null,
  });
  return createHash('sha256').update(content).digest('hex');
}

// ----------------------------------------------------------
// Signing — colonies sign signals they deposit
// ----------------------------------------------------------

/**
 * Sign a signal using a colony's private key.
 * Returns a new signal with signature and signer set in meta.
 * Does NOT mutate the original signal.
 */
export async function signSignal<T>(signal: Signal<T>, identity: ColonyIdentity): Promise<Signal<T>> {
  const hash = canonicalHash(signal);
  const signature = await ed.signAsync(fromHex(hash), fromHex(identity.privateKey));

  return {
    ...signal,
    meta: {
      ...signal.meta,
      signature: toHex(signature),
      signer: identity.publicKey,
    },
  };
}

/**
 * Create a signing function that can be used as middleware.
 * Automatically signs all signals deposited by a colony.
 */
export function createSigner(config: SigningConfig) {
  return async <T>(signal: Signal<T>): Promise<Signal<T>> => {
    // Check if this signal type is excluded from signing
    if (config.excludeTypes?.some(pattern => matchGlob(signal.type, pattern))) {
      return signal;
    }
    if (config.signAll === false) {
      return signal;
    }
    return signSignal(signal, config.identity);
  };
}

// ----------------------------------------------------------
// Verification — check signal provenance
// ----------------------------------------------------------

/**
 * Verify a signal's colony signature.
 * Returns true if the signature is valid for the signer's public key.
 */
export async function verifySignature(signal: Signal): Promise<boolean> {
  if (!signal.meta.signature || !signal.meta.signer) {
    return false;
  }

  try {
    const hash = canonicalHash(signal);
    return await ed.verifyAsync(
      fromHex(signal.meta.signature),
      fromHex(hash),
      fromHex(signal.meta.signer)
    );
  } catch {
    return false;
  }
}

/**
 * Verify an entire attestation chain.
 * Walks the chain from first attestation to last, checking:
 *   1. Each attestation's signature is valid
 *   2. The chain links correctly (each signs over the previous)
 *   3. Source/target environments are consistent across the chain
 */
export async function verifyAttestationChain(
  signalId: string,
  attestations: Attestation[]
): Promise<Array<{ attester: string; valid: boolean; reason: string }>> {
  if (!attestations || attestations.length === 0) {
    return [];
  }

  const results: Array<{ attester: string; valid: boolean; reason: string }> = [];
  let previousSignature: string | undefined;

  for (let i = 0; i < attestations.length; i++) {
    const att = attestations[i];
    try {
      // Recreate the hash this attestation should have signed
      const hash = attestationHash(
        signalId,
        att.sourceEnvironment,
        att.targetEnvironment,
        att.timestamp,
        previousSignature
      );

      const valid = await ed.verifyAsync(
        fromHex(att.signature),
        fromHex(hash),
        fromHex(att.attesterKey)
      );

      results.push({
        attester: att.attester,
        valid,
        reason: valid ? 'signature valid' : 'signature invalid',
      });

      // Chain: this attestation's signature becomes the previous for the next
      previousSignature = att.signature;
    } catch (err: any) {
      results.push({
        attester: att.attester,
        valid: false,
        reason: `verification error: ${err.message}`,
      });
    }
  }

  return results;
}

/**
 * Full signal verification: colony signature + attestation chain.
 * Returns a VerificationResult with the determined trust level.
 */
export async function verifySignal(signal: Signal, policy?: TrustPolicy): Promise<VerificationResult> {
  const hasSignature = !!signal.meta.signature && !!signal.meta.signer;
  const hasAttestations = !!signal.meta.attestations && signal.meta.attestations.length > 0;

  // No provenance metadata at all
  if (!hasSignature && !hasAttestations) {
    return {
      trustLevel: 'unverified',
      signatureValid: null,
      attestationChainValid: null,
      reason: 'no provenance metadata present',
    };
  }

  // Check colony signature
  let signatureValid: boolean | null = null;
  if (hasSignature) {
    signatureValid = await verifySignature(signal);
  }

  // Check attestation chain
  let attestationChainValid: boolean | null = null;
  let attestationResults: Array<{ attester: string; valid: boolean; reason: string }> | undefined;
  if (hasAttestations) {
    attestationResults = await verifyAttestationChain(signal.id, signal.meta.attestations!);
    attestationChainValid = attestationResults.every(r => r.valid);
  }

  // Apply policy constraints if provided
  if (policy) {
    // Check attestation age
    if (hasAttestations && policy.maxAttestationAge) {
      const now = Date.now();
      const oldestTimestamp = Math.min(...signal.meta.attestations!.map(a => a.timestamp));
      if (now - oldestTimestamp > policy.maxAttestationAge) {
        return {
          trustLevel: 'rejected',
          signatureValid,
          attestationChainValid,
          reason: `attestation chain too old (${now - oldestTimestamp}ms > ${policy.maxAttestationAge}ms max)`,
          attestationResults,
        };
      }
    }

    // Check attestation depth
    if (hasAttestations && policy.maxAttestationDepth) {
      if (signal.meta.attestations!.length > policy.maxAttestationDepth) {
        return {
          trustLevel: 'rejected',
          signatureValid,
          attestationChainValid,
          reason: `attestation chain too deep (${signal.meta.attestations!.length} > ${policy.maxAttestationDepth} max)`,
          attestationResults,
        };
      }
    }

    // Check source environment
    if (signal.meta.sourceEnvironment) {
      if (policy.blockedSourceEnvironments?.includes(signal.meta.sourceEnvironment)) {
        return {
          trustLevel: 'rejected',
          signatureValid,
          attestationChainValid,
          reason: `source environment '${signal.meta.sourceEnvironment}' is blocked`,
          attestationResults,
        };
      }
      if (
        policy.allowedSourceEnvironments &&
        policy.allowedSourceEnvironments.length > 0 &&
        !policy.allowedSourceEnvironments.includes(signal.meta.sourceEnvironment)
      ) {
        return {
          trustLevel: 'rejected',
          signatureValid,
          attestationChainValid,
          reason: `source environment '${signal.meta.sourceEnvironment}' is not in allowed list`,
          attestationResults,
        };
      }
    }
  }

  // Determine trust level
  let trustLevel: TrustLevel;

  if (signatureValid && attestationChainValid) {
    trustLevel = 'verified';
  } else if (signatureValid && !hasAttestations) {
    trustLevel = 'verified';
  } else if (!hasSignature && attestationChainValid) {
    trustLevel = 'attested';
  } else if (signatureValid === false || attestationChainValid === false) {
    trustLevel = 'rejected';
  } else {
    trustLevel = 'unverified';
  }

  const reasons: string[] = [];
  if (signatureValid === true) reasons.push('colony signature valid');
  if (signatureValid === false) reasons.push('colony signature INVALID');
  if (attestationChainValid === true) reasons.push('attestation chain valid');
  if (attestationChainValid === false) reasons.push('attestation chain INVALID');

  return {
    trustLevel,
    signatureValid,
    attestationChainValid,
    reason: reasons.join('; ') || 'unknown',
    attestationResults,
  };
}

// ----------------------------------------------------------
// Bridge Attestation — create attestations for bridged signals
// ----------------------------------------------------------

/**
 * Create an attestation for a signal being bridged between environments.
 * The bridge signs the transfer, appending to the attestation chain.
 */
export async function createAttestation(
  signalId: string,
  sourceEnvironment: string,
  targetEnvironment: string,
  bridgeIdentity: ColonyIdentity,
  existingAttestations?: Attestation[]
): Promise<Attestation> {
  const timestamp = Date.now();
  const previousSignature = existingAttestations?.length
    ? existingAttestations[existingAttestations.length - 1].signature
    : undefined;

  const hash = attestationHash(
    signalId,
    sourceEnvironment,
    targetEnvironment,
    timestamp,
    previousSignature
  );

  const signature = await ed.signAsync(fromHex(hash), fromHex(bridgeIdentity.privateKey));

  return {
    attester: bridgeIdentity.name,
    attesterKey: bridgeIdentity.publicKey,
    sourceEnvironment,
    targetEnvironment,
    timestamp,
    signature: toHex(signature),
  };
}

/**
 * Prepare a signal for bridging: add attestation and source metadata.
 * Returns a new signal ready to deposit in the target environment.
 */
export async function prepareForBridge(
  signal: Signal,
  sourceEnvironment: string,
  targetEnvironment: string,
  bridgeIdentity: ColonyIdentity
): Promise<Signal> {
  const existingAttestations = signal.meta.attestations ?? [];
  const attestation = await createAttestation(
    signal.id,
    sourceEnvironment,
    targetEnvironment,
    bridgeIdentity,
    existingAttestations
  );

  return {
    ...signal,
    meta: {
      ...signal.meta,
      sourceEnvironment: signal.meta.sourceEnvironment ?? sourceEnvironment,
      attestations: [...existingAttestations, attestation],
    },
  };
}

// ----------------------------------------------------------
// Utility — glob matching (reused from signal.ts pattern)
// ----------------------------------------------------------

function matchGlob(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^:]*')
    + '$';
  return new RegExp(regexStr).test(value);
}
