// ============================================================
// withSkill — Skill-based colony provider
// ============================================================
// Skills are markdown files that inject domain knowledge into an
// agent's context. They teach the model *how* to use tools
// effectively for a specific domain, without requiring custom
// tool implementations.
//
// A skill is a directory with a SKILL.md file:
//
//   skills/
//     code-review/
//       SKILL.md          ← instructions, output format, examples
//       schema.ts         ← optional Zod schema
//     security-audit/
//       SKILL.md
//     go-conventions/
//       SKILL.md
//
// withSkill loads the skill markdown, composes it into a system
// prompt, and delegates to withToolLoop (for agentic work) or
// vllmStructuredProvider (when a schema is present).
//
// Usage:
//   colony('reviewer')
//     .sense('pr:needs-review')
//     .do('review', withSkill({
//       endpoint: 'http://localhost:8001',
//       skills: ['code-review', 'security-audit'],
//       skillsDir: './skills',
//       tools: [fileReadTool, grepTool, bashTool],
//       prompt: (signal) => `Review PR #${signal.payload.pr}`,
//       output: (result) => ({ type: 'review:done', payload: result }),
//     }))
//
// Why skills > custom tools for many SDLC tasks:
//   - A "code review" skill teaches the model to use file_read +
//     grep effectively for reviews — no custom review_code tool needed
//   - Skills are just markdown — version-controlled, composable, swappable
//   - The same skill works with any model (no tool-schema changes)
//   - Multiple skills compose naturally (review + security + go-conventions)
// ============================================================

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Signal, ActionContext } from '../core/types.js';
import type { ActionHandler, OutputMapping, ContextAssemblyConfig } from './types.js';
import type { ToolDefinition, ToolLoopConfig, ToolLoopResult } from './tool-loop.js';

// ----------------------------------------------------------
// Skill types
// ----------------------------------------------------------

/**
 * A loaded skill — resolved from disk at init time.
 */
export interface Skill {
  /** Skill name (directory name). */
  name: string;

  /** Raw markdown content from SKILL.md. */
  content: string;

  /** Path the skill was loaded from. */
  path: string;

  /**
   * Optional metadata parsed from YAML frontmatter.
   * Supports: model, tools, maxTurns, tags.
   */
  meta?: SkillMeta;
}

/**
 * Optional YAML frontmatter in SKILL.md.
 *
 * ---
 * model: Qwen3-Coder-Next
 * tools: [file_read, grep, bash]
 * maxTurns: 25
 * tags: [review, security]
 * ---
 */
export interface SkillMeta {
  /** Recommended model for this skill. */
  model?: string;

  /** Tool names this skill expects to be available. */
  tools?: string[];

  /** Recommended max turns when using this skill. */
  maxTurns?: number;

  /** Skill tags for filtering/discovery. */
  tags?: string[];

  /** Any additional frontmatter fields. */
  [key: string]: unknown;
}

// ----------------------------------------------------------
// Configuration
// ----------------------------------------------------------

export interface SkillConfig<T = Record<string, unknown>> {
  /** vLLM endpoint. */
  endpoint: string;

  /** Model name. Skills can recommend a model via frontmatter. */
  model?: string;

  /** Optional API key for vLLM. */
  apiKey?: string;

  /**
   * Skills to load. Each entry can be:
   * - A skill name (resolved from skillsDir)
   * - An absolute path to a SKILL.md
   * - A pre-loaded Skill object
   */
  skills: Array<string | Skill>;

  /**
   * Directory containing skill folders. Default: './skills'.
   * Each skill is a directory with a SKILL.md file inside.
   */
  skillsDir?: string;

  /**
   * Tools available to the agent. Skills may recommend tools via
   * frontmatter, but this list takes precedence.
   * If not provided, defaults to all built-in tools.
   */
  tools?: ToolDefinition[];

  /** Build the prompt from the signal. */
  prompt: string | ((signal: Signal<T>) => string | Promise<string>);

  /**
   * Additional system prompt to prepend before skills.
   * Use for colony-specific instructions that aren't part of any skill.
   */
  systemPrompt?: string;

  /** Maximum conversation turns. Skills can recommend via frontmatter. */
  maxTurns?: number;

  /** Token budget. */
  maxBudget?: { tokens: number };

  /** Request timeout per LLM call in ms. */
  timeoutMs?: number;

  /** Working directory for tools. */
  workingDirectory?: string | ((signal: Signal<T>) => string);

  /** Context assembly config — enrich prompts from signal lineage. */
  context?: ContextAssemblyConfig;

  /** Observability hooks. */
  onToolCall?: ToolLoopConfig<T>['onToolCall'];
  onTurn?: ToolLoopConfig<T>['onTurn'];

  /** Map output to signal deposits. */
  output?: OutputMapping<T>;

  /** Auto-withdraw triggering signal. Default: true. */
  autoWithdraw?: boolean;
}

// ----------------------------------------------------------
// Provider factory
// ----------------------------------------------------------

/**
 * Creates an action handler powered by loaded skills.
 *
 * Skills are loaded once at creation time (not per-signal).
 * The loaded skill content is composed into a system prompt
 * and passed to withToolLoop for execution.
 */
export function withSkill<T = Record<string, unknown>>(
  config: SkillConfig<T>
): ActionHandler<T> {
  const {
    endpoint,
    model,
    apiKey,
    skills: skillRefs,
    skillsDir = './skills',
    tools,
    prompt,
    systemPrompt,
    maxTurns,
    maxBudget,
    timeoutMs,
    workingDirectory,
    onToolCall,
    onTurn,
    output,
    autoWithdraw = true,
  } = config;

  // Lazy-load skills on first invocation, then cache
  let resolvedSkills: Skill[] | null = null;
  let composedSystemPrompt: string | null = null;
  let resolvedMaxTurns: number | undefined = maxTurns;
  let resolvedModel: string | undefined = model;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    // Load skills once
    if (!resolvedSkills) {
      resolvedSkills = await loadSkills(skillRefs, skillsDir);
      composedSystemPrompt = composeSystemPrompt(systemPrompt, resolvedSkills);

      // Apply skill metadata defaults (config values take precedence)
      for (const skill of resolvedSkills) {
        if (skill.meta?.model && !resolvedModel) resolvedModel = skill.meta.model;
        if (skill.meta?.maxTurns && !resolvedMaxTurns) resolvedMaxTurns = skill.meta.maxTurns;
      }

      ctx.log(`Loaded ${resolvedSkills.length} skill(s): ${resolvedSkills.map(s => s.name).join(', ')}`);
    }

    // Resolve tools — use config tools, or import defaults
    const resolvedTools = tools ?? await getDefaultTools();

    // Warn if skills expect tools that aren't available
    const availableToolNames = new Set(resolvedTools.map(t => t.function.name));
    for (const skill of resolvedSkills) {
      if (skill.meta?.tools) {
        const missing = skill.meta.tools.filter(t => !availableToolNames.has(t));
        if (missing.length > 0) {
          ctx.log(`Warning: skill "${skill.name}" expects tools [${missing.join(', ')}] which are not available`);
        }
      }
    }

    // Delegate to withToolLoop
    const { withToolLoop } = await import('./tool-loop.js');
    const handler = withToolLoop<T>({
      endpoint,
      model: resolvedModel,
      apiKey,
      prompt,
      systemPrompt: composedSystemPrompt!,
      tools: resolvedTools,
      maxTurns: resolvedMaxTurns,
      maxBudget,
      timeoutMs,
      workingDirectory,
      onToolCall,
      onTurn,
      output,
      autoWithdraw,
    });

    return handler(signal, ctx);
  };
}

// ----------------------------------------------------------
// Skill loading
// ----------------------------------------------------------

/**
 * Load skill references into Skill objects.
 * Handles: pre-loaded Skill objects, absolute paths, and name-based resolution.
 */
export async function loadSkills(
  refs: Array<string | Skill>,
  skillsDir: string
): Promise<Skill[]> {
  const skills: Skill[] = [];

  for (const ref of refs) {
    if (typeof ref === 'object' && ref.content) {
      // Pre-loaded skill
      skills.push(ref);
      continue;
    }

    const name = ref as string;

    // Try as absolute path first
    if (name.endsWith('.md') || name.includes('/SKILL')) {
      try {
        const content = await readFile(name, 'utf-8');
        const { meta, body } = parseFrontmatter(content);
        skills.push({
          name: name.split('/').slice(-2, -1)[0] ?? name,
          content: body,
          path: name,
          meta,
        });
        continue;
      } catch {
        // Fall through to directory resolution
      }
    }

    // Resolve from skillsDir
    const skillPath = resolve(skillsDir, name, 'SKILL.md');
    try {
      const content = await readFile(skillPath, 'utf-8');
      const { meta, body } = parseFrontmatter(content);
      skills.push({
        name,
        content: body,
        path: skillPath,
        meta,
      });
    } catch (err: any) {
      throw new Error(
        `Failed to load skill "${name}" from ${skillPath}: ${err.message}\n` +
        `Ensure the skill directory exists with a SKILL.md file.`
      );
    }
  }

  return skills;
}

/**
 * Load a single skill from a directory path.
 */
export async function loadSkill(skillDir: string): Promise<Skill> {
  const skillPath = join(skillDir, 'SKILL.md');
  const content = await readFile(skillPath, 'utf-8');
  const { meta, body } = parseFrontmatter(content);
  const name = skillDir.split('/').pop() ?? skillDir;
  return { name, content: body, path: skillPath, meta };
}

// ----------------------------------------------------------
// System prompt composition
// ----------------------------------------------------------

/**
 * Compose a system prompt from base instructions + loaded skills.
 *
 * Layout:
 *   [base system prompt]
 *   ---
 *   # Skills
 *   ## code-review
 *   [SKILL.md content]
 *   ## security-audit
 *   [SKILL.md content]
 */
function composeSystemPrompt(
  base: string | undefined,
  skills: Skill[]
): string {
  const sections: string[] = [];

  if (base) {
    sections.push(base);
  }

  if (skills.length > 0) {
    const skillSections = skills.map(skill => {
      return `## Skill: ${skill.name}\n\n${skill.content}`;
    });

    sections.push(
      '---\n\n# Skills\n\n' +
      'The following skills provide domain expertise for this task. ' +
      'Follow their instructions, output formats, and constraints.\n\n' +
      skillSections.join('\n\n---\n\n')
    );
  }

  return sections.join('\n\n');
}

// ----------------------------------------------------------
// Frontmatter parsing
// ----------------------------------------------------------

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Simple parser — handles key: value and key: [array] syntax.
 * No external YAML dependency needed.
 */
export function parseFrontmatter(content: string): { meta?: SkillMeta; body: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n?---\s*\n([\s\S]*)$/);
  if (!fmMatch) {
    return { body: content.trim() };
  }

  const [, fmBlock, body] = fmMatch;
  const meta: SkillMeta = {};

  for (const line of fmBlock.split('\n')) {
    const kvMatch = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!kvMatch) continue;

    const [, key, rawValue] = kvMatch;
    const value = rawValue.trim();

    // Parse arrays: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value.slice(1, -1).split(',').map(s => s.trim());
      continue;
    }

    // Parse numbers
    if (/^\d+$/.test(value)) {
      meta[key] = parseInt(value, 10);
      continue;
    }

    // Parse booleans
    if (value === 'true' || value === 'false') {
      meta[key] = value === 'true';
      continue;
    }

    // String
    meta[key] = value;
  }

  return { meta, body: body.trim() };
}

// ----------------------------------------------------------
// Default tools (lazy import)
// ----------------------------------------------------------

let cachedDefaultTools: ToolDefinition[] | null = null;

async function getDefaultTools(): Promise<ToolDefinition[]> {
  if (cachedDefaultTools) return cachedDefaultTools;

  const {
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    bashTool,
    globTool,
    grepTool,
    listDirTool,
  } = await import('./tool-loop.js');

  cachedDefaultTools = [
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    bashTool,
    globTool,
    grepTool,
    listDirTool,
  ];

  return cachedDefaultTools;
}
