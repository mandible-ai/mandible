// ============================================================
// Remote Environment — WebSocket Protocol Types
// ============================================================
// Defines the contract between the RemoteEnvironment client
// (open source, runs on developer machines and in colony zones)
// and any compatible signal server implementation.
//
// This protocol is intentionally simple: request-response with
// correlation IDs, plus server-pushed subscription messages.
// ============================================================

import type { Signal, SignalQuery, SignalMeta, DecayResult } from '../../core/types.js';
import type { RuntimeEventData } from '../../core/events.js';

// ----------------------------------------------------------
// Client → Server messages
// ----------------------------------------------------------

export type ClientMessage =
  | ObserveRequest
  | DepositRequest
  | WithdrawRequest
  | ClaimRequest
  | ReleaseRequest
  | SubscribeRequest
  | UnsubscribeRequest
  | SnapshotRequest
  | HistoryRequest
  | DecayRequest
  | AuthRequest
  | EventForward;

export interface ObserveRequest {
  type: 'observe';
  id: string;
  query: SerializableSignalQuery;
}

export interface DepositRequest {
  type: 'deposit';
  id: string;
  signal: {
    type: string;
    payload: Record<string, unknown>;
    meta?: Partial<SerializableSignalMeta>;
  };
}

export interface WithdrawRequest {
  type: 'withdraw';
  id: string;
  signalId: string;
}

export interface ClaimRequest {
  type: 'claim';
  id: string;
  signalId: string;
  claimant: string;
  leaseDuration?: number;
}

export interface ReleaseRequest {
  type: 'release';
  id: string;
  signalId: string;
}

export interface SubscribeRequest {
  type: 'subscribe';
  id: string;
  query: SerializableSignalQuery;
}

export interface UnsubscribeRequest {
  type: 'unsubscribe';
  id: string;
  subscriptionId: string;
}

export interface SnapshotRequest {
  type: 'snapshot';
  id: string;
}

export interface HistoryRequest {
  type: 'history';
  id: string;
  query: SerializableSignalQuery & { includeWithdrawn?: boolean };
}

export interface DecayRequest {
  type: 'decay';
  id: string;
}

export interface AuthRequest {
  type: 'auth';
  apiKey: string;
  colony?: string;
  publicKey?: string;
  project: string;
}

export interface EventForward {
  type: 'event';
  data: RuntimeEventData;
}

// ----------------------------------------------------------
// Server → Client messages
// ----------------------------------------------------------

export interface EventRelayMessage {
  type: 'event';
  data: import('../../core/events.js').RuntimeEventData;
}

export type ServerMessage =
  | ResultMessage
  | ErrorMessage
  | SignalPush
  | AuthenticatedMessage
  | EventRelayMessage;

export interface ResultMessage {
  type: 'result';
  id: string;
  data: unknown;
}

export interface ErrorMessage {
  type: 'error';
  id: string;
  code: string;
  message: string;
}

export interface SignalPush {
  type: 'signal';
  subscriptionId: string;
  signal: Signal;
}

export interface AuthenticatedMessage {
  type: 'authenticated';
  project: string;
  environment: string;
}

// ----------------------------------------------------------
// Serializable variants (no functions, safe for JSON)
// ----------------------------------------------------------

export interface SerializableSignalQuery {
  type?: string | string[];
  minConcentration?: number;
  unclaimed?: boolean;
  tags?: string[];
  after?: number;
  limit?: number;
  // Note: `filter` function cannot be serialized — server-side filtering
  // must use the declarative fields above.
}

export interface SerializableSignalMeta {
  deposited_by: string;
  concentration?: number;
  ttl?: number;
  tags?: string[];
  caused_by?: string[];
  signature?: string;
  signer?: string;
}

// ----------------------------------------------------------
// Protocol error codes
// ----------------------------------------------------------

export const ErrorCodes = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  SIGNAL_NOT_FOUND: 'SIGNAL_NOT_FOUND',
  CLAIM_FAILED: 'CLAIM_FAILED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;
