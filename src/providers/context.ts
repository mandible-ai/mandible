// ============================================================
// Context Assembly — Building rich prompts from signal lineage
// ============================================================
// Agents work better with context. Instead of just passing the
// raw signal payload to an LLM, context assembly walks the
// causal chain and pulls in related signals to build a richer
// prompt.
//
// For a Critic reviewing an artifact, this means automatically
// including:
//   - The original task description (caused_by lineage)
//   - Previous review feedback (sibling signals)
//   - Related artifacts (signals with matching tags)
//
// This is what makes stigmergy-based agents smarter than
// simple reactive systems — they can see the full history
// of how a signal came to be, even though no agent explicitly
// passed that context.
//
// Usage:
//   const prompt = await assembleContext(signal, env, {
//     includeLineage: true,
//     lineageDepth: 3,
//     includeSiblings: true,
//     includeRelated: ['review:*'],
//   });
// ============================================================

import type { Signal, Environment } from '../core/types.js';
import type { ContextAssemblyConfig } from './types.js';

/**
 * Assemble rich context from the signal environment.
 * Returns a formatted string suitable for appending to an LLM prompt.
 */
export async function assembleContext(
  signal: Signal,
  env: Environment,
  config: ContextAssemblyConfig = {}
): Promise<string> {
  const sections: string[] = [];

  // Current signal
  sections.push(formatSignalSection('Current Signal', signal));

  // Causal lineage — walk up the caused_by chain
  if (config.includeLineage && signal.meta.caused_by?.length) {
    const lineage = await walkLineage(
      signal,
      env,
      config.lineageDepth ?? 3,
      0,
      new Set()
    );
    if (lineage.length > 0) {
      sections.push(
        '## Causal Lineage\n' +
        'These signals led to the current one:\n\n' +
        lineage.map((s, i) =>
          `${'  '.repeat(i)}→ [${s.type}] ${summarizePayload(s.payload)} ` +
          `(by: ${s.meta.deposited_by}, age: ${formatAge(s.meta.deposited_at)})`
        ).join('\n')
      );
    }
  }

  // Sibling signals — other signals caused by the same parent
  if (config.includeSiblings && signal.meta.caused_by?.length) {
    const siblings = await findSiblings(signal, env);
    if (siblings.length > 0) {
      sections.push(
        '## Related Signals (Same Origin)\n' +
        siblings.map(s =>
          `- [${s.type}] ${summarizePayload(s.payload)} ` +
          `(by: ${s.meta.deposited_by}, conc: ${s.meta.concentration.toFixed(2)})`
        ).join('\n')
      );
    }
  }

  // Related signals by type pattern
  if (config.includeRelated?.length) {
    for (const pattern of config.includeRelated) {
      const related = await env.observe({ type: pattern, limit: 10 });
      if (related.length > 0) {
        sections.push(
          `## Related: ${pattern}\n` +
          related.map(s =>
            `- [${s.type}] ${summarizePayload(s.payload)} ` +
            `(by: ${s.meta.deposited_by})`
          ).join('\n')
        );
      }
    }
  }

  // Custom context builder
  if (config.custom) {
    const custom = await config.custom(signal, env);
    if (custom) {
      sections.push(`## Additional Context\n${custom}`);
    }
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Build a complete prompt by combining a base prompt with assembled context.
 */
export function withContext(
  config: ContextAssemblyConfig
): (basePrompt: string, signal: Signal, env: Environment) => Promise<string> {
  return async (basePrompt: string, signal: Signal, env: Environment) => {
    const context = await assembleContext(signal, env, config);
    return `${basePrompt}\n\n---\n\n# Context from Environment\n\n${context}`;
  };
}

// ----------------------------------------------------------
// Lineage walking
// ----------------------------------------------------------

async function walkLineage(
  signal: Signal,
  env: Environment,
  maxDepth: number,
  depth: number = 0,
  visited: Set<string> = new Set()
): Promise<Signal[]> {
  if (depth >= maxDepth) return [];
  if (!signal.meta.caused_by?.length) return [];

  const lineage: Signal[] = [];

  for (const parentId of signal.meta.caused_by) {
    if (visited.has(parentId)) continue;
    visited.add(parentId);

    // Look in active signals first, then history
    let parent = (await env.observe({ filter: s => s.id === parentId, limit: 1 }))[0];
    if (!parent) {
      parent = (await env.history({ filter: s => s.id === parentId, includeWithdrawn: true, limit: 1 }))[0];
    }

    if (parent) {
      lineage.push(parent);
      // Recurse up the chain
      const ancestors = await walkLineage(parent, env, maxDepth, depth + 1, visited);
      lineage.push(...ancestors);
    }
  }

  return lineage;
}

// ----------------------------------------------------------
// Sibling discovery
// ----------------------------------------------------------

const SIBLING_LIMIT = 20;

async function findSiblings(signal: Signal, env: Environment): Promise<Signal[]> {
  if (!signal.meta.caused_by?.length) return [];

  const parentIds = new Set(signal.meta.caused_by);
  const isSibling = (s: Signal) =>
    s.id !== signal.id &&
    s.meta.caused_by?.some(id => parentIds.has(id)) === true;

  return env.observe({ filter: isSibling, limit: SIBLING_LIMIT });
}

// ----------------------------------------------------------
// Formatting helpers
// ----------------------------------------------------------

const MAX_PAYLOAD_LENGTH = 2000;

function formatSignalSection(title: string, signal: Signal): string {
  let payloadStr = JSON.stringify(signal.payload, null, 2);
  if (payloadStr.length > MAX_PAYLOAD_LENGTH) {
    payloadStr = payloadStr.slice(0, MAX_PAYLOAD_LENGTH) + '\n... (truncated)';
  }

  return [
    `## ${title}`,
    `- **Type:** ${signal.type}`,
    `- **ID:** ${signal.id}`,
    `- **Deposited by:** ${signal.meta.deposited_by}`,
    `- **Age:** ${formatAge(signal.meta.deposited_at)}`,
    `- **Concentration:** ${signal.meta.concentration.toFixed(2)}`,
    signal.meta.tags?.length ? `- **Tags:** ${signal.meta.tags.join(', ')}` : '',
    `- **Payload:**\n\`\`\`json\n${payloadStr}\n\`\`\``,
  ].filter(Boolean).join('\n');
}

function summarizePayload(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload);
  if (keys.length === 0) return '{}';

  // Show first meaningful value
  for (const key of ['name', 'task', 'description', 'text', 'message', 'code']) {
    if (payload[key] && typeof payload[key] === 'string') {
      const val = payload[key] as string;
      return val.length > 60 ? val.slice(0, 60) + '...' : val;
    }
  }

  return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', ...' : ''}}`;
}

function formatAge(depositedAt: number): string {
  const seconds = Math.floor((Date.now() - depositedAt) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
