// ============================================================
// Model Aliases — tier names that track the latest model
// ============================================================
// Colonies should say what *tier* of intelligence they need, not
// pin a dated snapshot that goes stale. Aliases resolve to the
// current model ID for that family at call time, so upgrading
// the framework (or setting an env var) moves every colony forward
// without touching colony code.
//
//   'fable'  → most capable widely released model
//   'opus'   → frontier reasoning / agentic work
//   'sonnet' → balanced default
//   'haiku'  → fast and cheap
//
// Resolution order for an alias:
//   1. setModelAliases() overrides (programmatic)
//   2. MANDIBLE_MODEL_<ALIAS> env var (e.g. MANDIBLE_MODEL_OPUS)
//   3. Built-in table below
//
// Anything that isn't a known alias passes through unchanged, so
// full model IDs, Bedrock IDs, and third-party models still work.
// ============================================================

/** Built-in alias → model ID table. Update here when new models ship. */
export const MODEL_ALIASES = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
} as const;

export type ModelAlias = keyof typeof MODEL_ALIASES;

/** Default model tier used by providers when none is specified. */
export const DEFAULT_MODEL_ALIAS: ModelAlias = 'sonnet';

const overrides = new Map<string, string>();

/**
 * Programmatically override one or more aliases for this process.
 * Useful for tests, or for pinning a tier to a specific snapshot.
 *
 * @example
 *   setModelAliases({ opus: 'claude-opus-4-8' });
 */
export function setModelAliases(aliases: Partial<Record<ModelAlias, string>>): void {
  for (const [alias, id] of Object.entries(aliases)) {
    if (id) overrides.set(alias, id);
    else overrides.delete(alias);
  }
}

/** Clear all programmatic overrides. */
export function resetModelAliases(): void {
  overrides.clear();
}

/** True if the given string is a known alias. */
export function isModelAlias(value: string): value is ModelAlias {
  return Object.prototype.hasOwnProperty.call(MODEL_ALIASES, value);
}

/**
 * Resolve a model alias (or full ID) to a concrete model ID.
 * Non-alias inputs pass through untouched.
 */
export function resolveModel(nameOrAlias: string): string {
  if (!isModelAlias(nameOrAlias)) return nameOrAlias;

  const override = overrides.get(nameOrAlias);
  if (override) return override;

  const envKey = `MANDIBLE_MODEL_${nameOrAlias.toUpperCase()}`;
  const envValue = typeof process !== 'undefined' ? process.env?.[envKey] : undefined;
  if (envValue) return envValue;

  return MODEL_ALIASES[nameOrAlias];
}

/**
 * Snapshot of the currently effective alias table (after overrides).
 * Handy for logging what a colony will actually call.
 */
export function currentModelAliases(): Record<ModelAlias, string> {
  const out = {} as Record<ModelAlias, string>;
  for (const alias of Object.keys(MODEL_ALIASES) as ModelAlias[]) {
    out[alias] = resolveModel(alias);
  }
  return out;
}
