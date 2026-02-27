// ============================================================
// Runtime Event System — Structured events for observability
// ============================================================
// Every step of the stigmergy loop emits a typed event.
// The dashboard subscribes to these via WebSocket.
// ============================================================

export type RuntimeEventType =
  | 'colony:started'
  | 'colony:stopped'
  | 'signal:sensed'
  | 'signal:matched'
  | 'signal:claimed'
  | 'signal:claim_failed'
  | 'action:started'
  | 'action:completed'
  | 'action:failed'
  | 'signal:deposited'
  | 'signal:withdrawn'
  | 'decay:sweep'
  | 'claim:released'
  | 'environment:snapshot'
  | 'colony:scaled';

export interface RuntimeEventData {
  type: RuntimeEventType;
  colony: string;
  timestamp: number;
  signalId?: string;
  signalType?: string;
  rule?: string;
  duration?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type RuntimeEventCallback = (event: RuntimeEventData) => void;

export class EventBus {
  private listeners = new Set<RuntimeEventCallback>();
  private typeListeners = new Map<RuntimeEventType, Set<RuntimeEventCallback>>();

  emit(event: RuntimeEventData): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* never crash the runtime */ }
    }
    const typed = this.typeListeners.get(event.type);
    if (typed) {
      for (const listener of typed) {
        try { listener(event); } catch { /* never crash the runtime */ }
      }
    }
  }

  on(callback: RuntimeEventCallback): () => void;
  on(type: RuntimeEventType, callback: RuntimeEventCallback): () => void;
  on(
    typeOrCallback: RuntimeEventType | RuntimeEventCallback,
    maybeCallback?: RuntimeEventCallback
  ): () => void {
    if (typeof typeOrCallback === 'function') {
      this.listeners.add(typeOrCallback);
      return () => { this.listeners.delete(typeOrCallback); };
    }
    const type = typeOrCallback;
    const callback = maybeCallback!;
    if (!this.typeListeners.has(type)) {
      this.typeListeners.set(type, new Set());
    }
    this.typeListeners.get(type)!.add(callback);
    return () => { this.typeListeners.get(type)?.delete(callback); };
  }

  removeAll(): void {
    this.listeners.clear();
    this.typeListeners.clear();
  }
}
