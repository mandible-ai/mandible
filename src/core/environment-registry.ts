// PURPOSE: Global registry for environment serialization/deserialization.
// PURPOSE: Environments self-register at import time; hosts and colony-runner use the registry to reconstruct.

import type { Environment, EnvironmentConfig, SerializableEnvironment } from './types.js';

type EnvironmentDeserializer = (config: EnvironmentConfig) => Environment;

const registry = new Map<string, EnvironmentDeserializer>();

/**
 * Register a deserializer for an environment type.
 * Called at module scope by each environment adapter (self-registration).
 */
export function registerEnvironment(type: string, deserializer: EnvironmentDeserializer): void {
  registry.set(type, deserializer);
}

/**
 * Reconstruct an Environment from a serialized config.
 * Throws with a helpful message if the type is not registered.
 */
export function deserializeEnvironment(config: EnvironmentConfig): Environment {
  const deserializer = registry.get(config.type);
  if (!deserializer) {
    const registered = Array.from(registry.keys());
    throw new Error(
      `Unknown environment type "${config.type}". ` +
      `Registered types: [${registered.join(', ')}]. ` +
      `Make sure the environment module is imported so it can self-register.`,
    );
  }
  return deserializer(config);
}

/**
 * Runtime type guard: checks whether an Environment implements SerializableEnvironment.
 */
export function isSerializableEnvironment(env: Environment): env is SerializableEnvironment {
  return 'serialize' in env && typeof (env as SerializableEnvironment).serialize === 'function';
}
