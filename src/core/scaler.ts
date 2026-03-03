// PURPOSE: Dynamic concurrency scaler — adjusts agent concurrency based on signal pressure
// PURPOSE: Standalone class with its own lifecycle (timer, cooldown, idle tracking)

import type { Environment, SensorConfig, AutoScalePolicy } from './types.js';
import type { RuntimeEventData, RuntimeEventCallback } from './events.js';

export interface ColonyScalerOptions {
  min: number;
  max: number;
  target: number;
  policy: AutoScalePolicy;
  environment: Environment;
  sensors: SensorConfig[];
  getActiveCount: () => number;
  onScale: (newConcurrency: number) => void;
  onEvent: RuntimeEventCallback;
  colonyName?: string;
}

const DEFAULT_SCALE_UP_THRESHOLD = 5;
const DEFAULT_SCALE_DOWN_AFTER_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 10_000;

export class ColonyScaler {
  private readonly min: number;
  private readonly max: number;
  private readonly scaleUpThreshold: number;
  private readonly scaleDownAfterMs: number;
  private readonly cooldownMs: number;
  private readonly environment: Environment;
  private readonly sensors: SensorConfig[];
  private readonly getActiveCount: () => number;
  private readonly onScale: (newConcurrency: number) => void;
  private readonly onEvent: RuntimeEventCallback;
  private readonly colonyName: string;

  private currentConcurrency: number;
  private lastScaleTime = 0;
  private idleSince: number | null = null;
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: ColonyScalerOptions) {
    this.min = options.min;
    this.max = options.max;
    this.currentConcurrency = options.target;
    this.scaleUpThreshold = options.policy.scaleUpThreshold ?? DEFAULT_SCALE_UP_THRESHOLD;
    this.scaleDownAfterMs = options.policy.scaleDownAfterMs ?? DEFAULT_SCALE_DOWN_AFTER_MS;
    this.cooldownMs = options.policy.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.environment = options.environment;
    this.sensors = options.sensors;
    this.getActiveCount = options.getActiveCount;
    this.onScale = options.onScale;
    this.onEvent = options.onEvent;
    this.colonyName = options.colonyName ?? 'unknown';
  }

  async start(): Promise<void> {
    // Immediate first evaluation
    await this.evaluate();

    // Recurring evaluations on cooldown interval
    this.timer = setInterval(() => {
      this.evaluate().catch(() => { /* swallow — evaluate already handles errors */ });
    }, this.cooldownMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async evaluate(): Promise<void> {
    const now = Date.now();

    // Enforce cooldown
    if (this.lastScaleTime > 0 && (now - this.lastScaleTime) < this.cooldownMs) {
      return;
    }

    // Measure queue depth across all sensors
    let queueDepth = 0;
    try {
      for (const sensor of this.sensors) {
        const signals = await this.environment.observe(sensor.query);
        queueDepth += signals.length;
      }
    } catch {
      // observe() failed — skip this evaluation, never crash
      return;
    }

    const activeCount = this.getActiveCount();
    const isIdle = activeCount === 0 && queueDepth === 0;

    // Track idle state
    if (isIdle) {
      if (this.idleSince === null) {
        this.idleSince = now;
      }
    } else {
      this.idleSince = null;
    }

    // Scale-up: queue depth >= threshold AND below max
    if (queueDepth >= this.scaleUpThreshold && this.currentConcurrency < this.max) {
      const newConcurrency = this.currentConcurrency + 1;
      this.applyScale(newConcurrency, 'scale_up', queueDepth);
      return;
    }

    // Scale-down: idle for >= scaleDownAfterMs AND above min
    if (
      isIdle &&
      this.idleSince !== null &&
      (now - this.idleSince) >= this.scaleDownAfterMs &&
      this.currentConcurrency > this.min
    ) {
      const newConcurrency = this.currentConcurrency - 1;
      this.applyScale(newConcurrency, 'scale_down', queueDepth);
      return;
    }
  }

  private applyScale(newConcurrency: number, reason: string, queueDepth: number): void {
    const from = this.currentConcurrency;
    this.currentConcurrency = newConcurrency;
    this.lastScaleTime = Date.now();
    this.onScale(newConcurrency);

    const event: RuntimeEventData = {
      type: 'colony:scaled',
      colony: this.colonyName,
      timestamp: Date.now(),
      metadata: { from, to: newConcurrency, reason, queueDepth },
    };
    try { this.onEvent(event); } catch { /* never crash */ }
  }
}
