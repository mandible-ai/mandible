// PURPOSE: Wraps Factory's `droid exec` headless CLI as a Mandible action provider
// PURPOSE: Spawns droid, parses its stream-json events, deposits the result as signals
// ============================================================
// withDroid — Subprocess wrapper for Factory.ai droids
// ============================================================
// Factory's droid is a terminal coding agent in the same family as
// Claude Code and qwen-code. `droid exec` is its non-interactive
// mode: one prompt in, the agent reads/edits/runs until done, and
// a structured event stream comes out.
//
// Three things matter for unattended runs:
//   1. Autonomy. `droid exec` is read-only unless told otherwise,
//      and a denied operation fails the tool call rather than
//      waiting for approval. The default here is 'medium' (edits,
//      local git, installs, builds — no push). Pick the lowest
//      level the colony needs; 'high' allows `git push`.
//   2. Models (BYOK). Droid can run Factory-hosted models with a
//      FACTORY_API_KEY, or bring-your-own models declared as
//      `customModels` in a runtime settings file. `byok` writes that
//      file for the run (passed via `--settings`, merged for this
//      process only — ~/.factory is never touched). Inside a
//      Mandible zone the default is `byok: 'gateway'`: droid talks
//      to the platform model gateway with the zone's metered key,
//      no Factory key is needed, and every call is metered.
//   3. Egress. With BYOK, droid needs nothing from Factory, so the
//      run is air-gapped by default (FACTORY_AIRGAP_ENABLED=1): no
//      calls to api.factory.ai or telemetry.factory.ai, and the only
//      network destination is the model endpoint.
//
// Prerequisites:
//   npm install -g @factory/cli     # provides the `droid` binary
//
// Usage:
//   import { withDroid } from '@mandible-ai/mandible/providers';
//
//   colony('reviewers')
//     .sense('pr:needs-review', { unclaimed: true })
//     .do('review', withDroid({
//       model: 'sonnet',
//       autonomy: 'read-only',
//       prompt: (signal) => `Review PR #${signal.payload.pr} for security issues.`,
//       workingDirectory: '/workspace/repo',
//       tools: { only: ['Read', 'LS', 'Grep', 'Glob'] },
//       output: (result, signal) => ({
//         type: result.success ? 'review:done' : 'review:failed',
//         payload: { pr: signal.payload.pr, review: result.text },
//       }),
//     }))
//     .build();
// ============================================================

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Signal, ActionContext } from '../core/types.js';
import type { ActionHandler, OutputMapping, SignalDeposit } from './types.js';
import { resolveModel, DEFAULT_MODEL_ALIAS } from './models.js';
import { resolveGatewayGroup } from './llm.js';

// ----------------------------------------------------------
// Configuration
// ----------------------------------------------------------

/**
 * What the droid may do without asking. Maps to `--auto`:
 *   'read-only' → no flag (read files, git status/log/diff)
 *   'low'       → `--auto low`    (file edits outside system dirs)
 *   'medium'    → `--auto medium` (+ installs, builds, local git, curl to known APIs)
 *   'high'      → `--auto high`   (+ git push, untrusted code, deploys)
 *   'unsafe'    → `--skip-permissions-unsafe` (no checks at all)
 */
export type DroidAutonomy = 'read-only' | 'low' | 'medium' | 'high' | 'unsafe';

/** BYOK wire protocol droid speaks to the model endpoint. */
export type DroidByokProvider =
  | 'anthropic'
  | 'openai'
  | 'generic-chat-completion-api'
  | 'bedrock-converse';

/**
 * A bring-your-own model endpoint. Written into the run's settings
 * file as a droid `customModels` entry and selected automatically.
 */
export interface DroidByokModel {
  /**
   * Wire protocol: 'anthropic' for Claude, 'openai' for OpenAI's
   * Responses API models, 'generic-chat-completion-api' for any
   * other OpenAI-compatible endpoint (vLLM, LiteLLM, Ollama).
   */
  provider: DroidByokProvider;

  /** Endpoint base URL, e.g. 'http://localhost:8001/v1'. */
  baseUrl: string;

  /**
   * Model id sent to the endpoint. Defaults to the resolved `model`
   * option, so aliases like 'sonnet' still work.
   */
  model?: string;

  /** API key for the endpoint. Omit for keyless endpoints. */
  apiKey?: string;

  /** Extra HTTP headers sent with every model request. */
  headers?: Record<string, string>;

  /** Output token cap per model response. */
  maxOutputTokens?: number;

  /** Context window override, in tokens. */
  maxContextLimit?: number;
}

export interface DroidConfig<T = Record<string, unknown>> {
  /** Build the prompt from the incoming signal. */
  prompt: string | ((signal: Signal<T>) => string | Promise<string>);

  /**
   * Working directory for the droid session.
   * Can be static or derived from the signal.
   */
  workingDirectory?: string | ((signal: Signal<T>) => string);

  /**
   * Model tier alias ('opus', 'sonnet', ...) or a model id. With a
   * Factory-hosted model this is passed to `-m`; with BYOK it is the
   * model requested from the endpoint. Can be derived from the signal.
   * Default: 'sonnet'.
   */
  model?: string | ((signal: Signal<T>) => string);

  /**
   * Where the model runs.
   *   'gateway' — the Mandible model gateway (OPENAI_BASE_URL /
   *               OPENAI_API_KEY, injected inside zones). The model
   *               name resolves to the zone's gateway model group.
   *   object    — any other endpoint (see DroidByokModel).
   *   false     — Factory-hosted models; needs FACTORY_API_KEY.
   *
   * Default: 'gateway' when the gateway env vars are present,
   * otherwise false.
   */
  byok?: 'gateway' | DroidByokModel | false;

  /**
   * Block all calls to Factory's own services (FACTORY_AIRGAP_ENABLED).
   * Only valid with BYOK. Default: true with BYOK, false otherwise.
   */
  airgap?: boolean;

  /** Factory API key for hosted models. Default: FACTORY_API_KEY from the environment. */
  apiKey?: string;

  /** What the droid may do without asking. Default: 'medium'. */
  autonomy?: DroidAutonomy;

  /** Reasoning effort, e.g. 'low' | 'medium' | 'high'. Levels vary per model. */
  reasoningEffort?: string;

  /**
   * Tool selection. Tool ids are droid's own ('Read', 'LS', 'Grep',
   * 'Glob', 'Edit', 'Create', 'Execute', 'FetchUrl', ...) or
   * `MCP:<server>[/<tool>]` selectors.
   *   only   → `--only-tools` (an allowlist; prefer this for review colonies)
   *   add    → `--add-tools`
   *   remove → `--remove-tools`
   */
  tools?: { only?: string[]; add?: string[]; remove?: string[] };

  /** Append instructions to droid's system prompt. */
  appendSystemPrompt?: string;

  /**
   * Start in spec mode: the droid plans before it edits. Pass an
   * object to run the planning phase on a different model.
   */
  spec?: boolean | { model?: string; reasoningEffort?: string };

  /**
   * Continue an existing droid session (`--session-id`). Sessions
   * live under the droid home directory, so the run that continues
   * one must share it (see `factoryHome`).
   */
  sessionId?: string | ((signal: Signal<T>) => string | undefined);

  /**
   * Extra runtime settings merged for this run only (the same file
   * `byok` writes). Use for settings withDroid has no option for.
   */
  settings?: Record<string, unknown>;

  /**
   * Override droid's home directory (FACTORY_HOME_OVERRIDE). Sessions,
   * logs and personal custom droids live under it. Default: unset,
   * which uses the user's home.
   */
  factoryHome?: string;

  /** Hard subprocess kill in ms. Default: 600_000 (10 min). */
  timeout?: number;

  /** Additional environment variables for the subprocess. */
  env?: Record<string, string>;

  /** Path to the droid binary. Default: 'droid' (from PATH). */
  binary?: string;

  /** Map the result to signal deposits. Defaults to depositing the raw result. */
  output?: OutputMapping<T>;

  /** Whether to auto-withdraw the triggering signal. Default: true. */
  autoWithdraw?: boolean;

  /** Observability hook — raw stdout chunks as they arrive. */
  onOutput?: (chunk: string) => void;

  /** Observability hook — parsed stream-json events as they arrive. */
  onMessage?: (message: DroidMessage) => void;
}

// ----------------------------------------------------------
// Result types
// ----------------------------------------------------------

/**
 * One event from `droid exec -o stream-json`. Observed types:
 * 'system' (subtype 'init'), 'message', 'tool_call', 'tool_result',
 * 'error' and the terminal 'completion'.
 */
export interface DroidMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  /** 'system' init: the model the session runs with. */
  model?: string;
  /** 'message': 'user' | 'assistant'. */
  role?: string;
  /** 'message': the message text. */
  text?: string;
  /** 'tool_call' / 'tool_result': the tool that ran. */
  toolName?: string;
  toolId?: string;
  parameters?: Record<string, unknown>;
  isError?: boolean;
  /** 'error': where the error came from and what it was. */
  source?: string;
  message?: string;
  /** 'completion': the final answer and run totals. */
  finalText?: string;
  numTurns?: number;
  durationMs?: number;
  usage?: Partial<DroidUsage>;
  [key: string]: unknown;
}

export interface DroidUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Factory credits spent. Zero for BYOK runs. */
  factory_credits: number;
}

/** Why the session ended — branch on this when mapping to signals. */
export type DroidStopReason = 'success' | 'error' | 'interrupted' | 'timeout' | 'spawn-failed';

export interface DroidResult {
  /** The agent's final answer, or the first error message on failure. */
  text: string;

  /** Raw stdout, untouched. */
  stdout: string;

  /** stderr output. */
  stderr: string;

  /** Process exit code. droid uses 0 for success and 1 for any failure. */
  exitCode: number;

  /** Why the session ended. */
  stopReason: DroidStopReason;

  /** Wall-clock duration in ms. */
  durationMs: number;

  /** Whether the session completed cleanly. */
  success: boolean;

  /** Whether the hard `timeout` killed the subprocess. */
  timedOut: boolean;

  /** Session id — reusable with `sessionId` to continue the session. */
  sessionId?: string;

  /** Model the session ran with (a `custom:` id for BYOK runs). */
  model?: string;

  /** Agent turns in the session. */
  numTurns: number;

  /** Token usage for the run. Zeroed when unavailable. */
  usage: DroidUsage;

  /** Number of tool calls the agent made. */
  toolCalls: number;

  /** Error messages the session reported, in order. */
  errors: string[];

  /** All parsed stream-json events. */
  messages: DroidMessage[];
}

// ----------------------------------------------------------
// Provider factory
// ----------------------------------------------------------

/** The id withDroid gives its BYOK model in the run's settings file. */
export const DROID_BYOK_MODEL_ID = 'custom:mandible-byok';

/** Env var that carries the BYOK endpoint key into the droid subprocess. */
const BYOK_KEY_ENV = 'MANDIBLE_DROID_BYOK_KEY';

/**
 * Creates an action handler that runs a headless droid session
 * (`droid exec`). The subprocess does its own tool execution.
 */
export function withDroid<T = Record<string, unknown>>(
  config: DroidConfig<T>
): ActionHandler<T> {
  const {
    prompt,
    workingDirectory,
    model: modelConfig = DEFAULT_MODEL_ALIAS,
    byok: byokConfig,
    airgap: airgapConfig,
    apiKey,
    autonomy = 'medium',
    reasoningEffort,
    tools,
    appendSystemPrompt,
    spec,
    sessionId: sessionIdConfig,
    settings: extraSettings,
    factoryHome,
    timeout = 600_000,
    env: extraEnv = {},
    binary = 'droid',
    output,
    autoWithdraw = true,
    onOutput,
    onMessage,
  } = config;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    const resolvedPrompt = typeof prompt === 'function'
      ? await prompt(signal)
      : prompt;

    const cwd = typeof workingDirectory === 'function'
      ? workingDirectory(signal)
      : workingDirectory ?? process.cwd();

    const resolvedModel = resolveModel(
      typeof modelConfig === 'function' ? modelConfig(signal) : modelConfig
    );

    const sessionId = typeof sessionIdConfig === 'function'
      ? sessionIdConfig(signal)
      : sessionIdConfig;

    const byok = resolveByok(byokConfig, resolvedModel);
    const airgap = airgapConfig ?? byok !== undefined;
    if (airgap && !byok) {
      throw new Error(
        'withDroid: `airgap` blocks Factory-hosted models; configure `byok` ' +
        '(or run inside a zone with the model gateway) to use it.'
      );
    }

    const settings: Record<string, unknown> = { ...extraSettings };
    if (byok) {
      settings.customModels = [
        ...(Array.isArray(extraSettings?.customModels) ? extraSettings.customModels : []),
        byokEntry(byok),
      ];
    }

    const processEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      FACTORY_DROID_AUTO_UPDATE_ENABLED: '0',  // never self-update mid-colony
      ...(airgap ? { FACTORY_AIRGAP_ENABLED: '1' } : {}),
      ...(apiKey ? { FACTORY_API_KEY: apiKey } : {}),
      ...(factoryHome ? { FACTORY_HOME_OVERRIDE: factoryHome } : {}),
      ...(byok?.apiKey ? { [BYOK_KEY_ENV]: byok.apiKey } : {}),
      ...extraEnv,
    };

    // Runtime settings for this run only; removed as soon as it ends.
    let settingsDir: string | undefined;
    let settingsPath: string | undefined;
    if (Object.keys(settings).length > 0) {
      settingsDir = await mkdtemp(join(tmpdir(), 'mandible-droid-'));
      settingsPath = join(settingsDir, 'settings.json');
      await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    }

    const args = buildDroidArgs({
      prompt: resolvedPrompt,
      model: byok ? DROID_BYOK_MODEL_ID : resolvedModel,
      cwd,
      autonomy,
      reasoningEffort,
      tools,
      appendSystemPrompt,
      spec,
      sessionId,
      settingsPath,
    });

    ctx.log(
      `Starting droid session in ${cwd} ` +
      `(${byok ? `byok ${byok.model} @ ${byok.baseUrl}` : resolvedModel}, autonomy ${autonomy})`
    );

    let result: DroidResult;
    try {
      result = await runDroid({ binary, args, cwd, env: processEnv, timeout, onOutput, onMessage });
    } finally {
      if (settingsDir) await rm(settingsDir, { recursive: true, force: true });
    }

    ctx.log(
      result.success
        ? `droid completed in ${result.durationMs}ms (${result.toolCalls} tool calls, ${result.usage.output_tokens} output tokens)`
        : `droid ended: ${result.stopReason} (exit ${result.exitCode}, ${result.durationMs}ms)${result.errors.length ? ` — ${result.errors[0]}` : ''}`
    );

    if (output) {
      const deposits = resolveOutput(output, result, signal);
      for (const deposit of deposits) {
        await ctx.deposit(deposit.type, deposit.payload ?? (result as any), {
          causedBy: [signal.id],
          tags: deposit.tags,
          ttl: deposit.ttl,
        });
      }
    } else {
      await ctx.deposit('droid:completed', result as any, {
        causedBy: [signal.id],
      });
    }

    if (autoWithdraw) {
      await ctx.withdraw(signal.id);
    }
  };
}

// ----------------------------------------------------------
// BYOK resolution
// ----------------------------------------------------------

type ResolvedByok = DroidByokModel & { model: string };

function resolveByok(
  byok: DroidConfig['byok'],
  model: string,
): ResolvedByok | undefined {
  const gatewayAvailable = Boolean(process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY);
  const choice = byok ?? (gatewayAvailable ? 'gateway' : false);
  if (choice === false) return undefined;

  if (choice === 'gateway') {
    if (!gatewayAvailable) {
      throw new Error(
        "withDroid: byok 'gateway' needs the Mandible model gateway " +
        '(OPENAI_BASE_URL + OPENAI_API_KEY, injected inside zones).'
      );
    }
    // LiteLLM fronts every provider over chat completions, and the
    // zone key only reaches its own model groups.
    return {
      provider: 'generic-chat-completion-api',
      baseUrl: process.env.OPENAI_BASE_URL as string,
      apiKey: process.env.OPENAI_API_KEY,
      model: resolveGatewayGroup(model),
    };
  }

  return { ...choice, model: choice.model ? resolveModel(choice.model) : model };
}

function byokEntry(byok: ResolvedByok): Record<string, unknown> {
  return {
    id: DROID_BYOK_MODEL_ID,
    displayName: 'mandible-byok',
    model: byok.model,
    provider: byok.provider,
    baseUrl: byok.baseUrl,
    // droid expands ${VAR} in apiKey, so the key itself stays in the
    // subprocess environment and never reaches the settings file.
    ...(byok.apiKey ? { apiKey: `\${${BYOK_KEY_ENV}}` } : {}),
    ...(byok.headers ? { extraHeaders: byok.headers } : {}),
    ...(byok.maxOutputTokens ? { maxOutputTokens: byok.maxOutputTokens } : {}),
    ...(byok.maxContextLimit ? { maxContextLimit: byok.maxContextLimit } : {}),
  };
}

// ----------------------------------------------------------
// argv construction
// ----------------------------------------------------------

interface DroidArgsInput {
  prompt: string;
  model: string;
  cwd: string;
  autonomy: DroidAutonomy;
  reasoningEffort?: string;
  tools?: DroidConfig['tools'];
  appendSystemPrompt?: string;
  spec?: DroidConfig['spec'];
  sessionId?: string;
  settingsPath?: string;
}

function buildDroidArgs(input: DroidArgsInput): string[] {
  const args: string[] = [
    'exec',
    '--output-format', 'stream-json',
    '--model', input.model,
    '--cwd', input.cwd,
  ];

  if (input.autonomy === 'unsafe') {
    args.push('--skip-permissions-unsafe');
  } else if (input.autonomy !== 'read-only') {
    args.push('--auto', input.autonomy);
  }
  if (input.reasoningEffort) {
    args.push('--reasoning-effort', input.reasoningEffort);
  }
  if (input.tools?.only?.length) {
    args.push('--only-tools', input.tools.only.join(','));
  }
  if (input.tools?.add?.length) {
    args.push('--add-tools', input.tools.add.join(','));
  }
  if (input.tools?.remove?.length) {
    args.push('--remove-tools', input.tools.remove.join(','));
  }
  if (input.appendSystemPrompt) {
    args.push('--append-system-prompt', input.appendSystemPrompt);
  }
  if (input.spec) {
    args.push('--use-spec');
    if (typeof input.spec === 'object') {
      if (input.spec.model) args.push('--spec-model', resolveModel(input.spec.model));
      if (input.spec.reasoningEffort) args.push('--spec-reasoning-effort', input.spec.reasoningEffort);
    }
  }
  if (input.sessionId) {
    args.push('--session-id', input.sessionId);
  }
  if (input.settingsPath) {
    args.push('--settings', input.settingsPath);
  }

  // `--` keeps a prompt that starts with '-' from parsing as a flag.
  args.push('--', input.prompt);
  return args;
}

// ----------------------------------------------------------
// Subprocess management
// ----------------------------------------------------------

interface RunInput {
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  onOutput?: (chunk: string) => void;
  onMessage?: (message: DroidMessage) => void;
}

function runDroid(input: RunInput): Promise<DroidResult> {
  const { binary, args, cwd, env, timeout, onOutput, onMessage } = input;

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    // stream-json arrives line-delimited and may split mid-line
    // across chunks, so events are assembled from a line buffer.
    const messages: DroidMessage[] = [];
    let lineBuffer = '';
    const takeLine = (line: string) => {
      const message = parseLine(line);
      if (!message) return;
      messages.push(message);
      onMessage?.(message);
    };

    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5000);
    }, timeout);

    const clearTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      onOutput?.(chunk);

      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) takeLine(line);
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      takeLine(lineBuffer);

      resolve(buildResult({
        stdout,
        stderr,
        exitCode: code ?? (timedOut ? 124 : 1),
        timedOut,
        messages,
        durationMs: Date.now() - startTime,
      }));
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(buildResult({
        stdout: '',
        stderr: [
          `Failed to spawn ${binary}: ${err.message}.`,
          '',
          'Ensure the droid CLI is installed:',
          '  npm install -g @factory/cli',
          '',
          'Or point at it directly:',
          "  withDroid({ binary: '/path/to/droid', ... })",
        ].join('\n'),
        exitCode: 127,
        timedOut: false,
        messages: [],
        durationMs: Date.now() - startTime,
        spawnFailed: true,
      }));
    });
  });
}

// ----------------------------------------------------------
// Event parsing
// ----------------------------------------------------------

function parseLine(line: string): DroidMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string'
      ? parsed
      : undefined;
  } catch {
    return undefined;  // interleaved non-JSON output is not fatal
  }
}

interface RawRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  messages: DroidMessage[];
  durationMs: number;
  spawnFailed?: boolean;
}

function buildResult(raw: RawRun): DroidResult {
  const completion = findLast(raw.messages, (m) => m.type === 'completion');
  const errors = raw.messages
    .filter((m) => m.type === 'error' && typeof m.message === 'string')
    .map((m) => m.message as string);
  const stopReason = stopReasonFor(raw, completion !== undefined);
  const lastAssistant = findLast(raw.messages, (m) => m.type === 'message' && m.role === 'assistant');

  return {
    text: completion?.finalText
      ?? lastAssistant?.text
      ?? errors[0]  // the root cause; later errors are droid's own wrap-up
      ?? (raw.stdout.trim() || raw.stderr.trim()),
    stdout: raw.stdout,
    stderr: raw.stderr.trim(),
    exitCode: raw.exitCode,
    stopReason,
    durationMs: raw.durationMs,
    success: stopReason === 'success',
    timedOut: raw.timedOut,
    sessionId: raw.messages.find((m) => m.session_id)?.session_id,
    model: raw.messages.find((m) => m.type === 'system' && m.model)?.model,
    numTurns: completion?.numTurns ?? 0,
    usage: normalizeUsage(completion?.usage),
    toolCalls: raw.messages.filter((m) => m.type === 'tool_call').length,
    errors,
    messages: raw.messages,
  };
}

function findLast<V>(items: V[], predicate: (item: V) => boolean): V | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return items[i];
  }
  return undefined;
}

function stopReasonFor(raw: RawRun, completed: boolean): DroidStopReason {
  if (raw.spawnFailed) return 'spawn-failed';
  if (raw.timedOut) return 'timeout';
  if (raw.exitCode === 130) return 'interrupted';
  return raw.exitCode === 0 && completed ? 'success' : 'error';
}

function normalizeUsage(usage: Partial<DroidUsage> | undefined): DroidUsage {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    factory_credits: usage?.factory_credits ?? 0,
  };
}

// ----------------------------------------------------------
// Output mapping
// ----------------------------------------------------------

function resolveOutput<T>(
  output: OutputMapping<T>,
  result: DroidResult,
  signal: Signal<T>,
): SignalDeposit[] {
  if (typeof output === 'function') {
    const mapped = output(result, signal);
    return Array.isArray(mapped) ? mapped : [mapped];
  }
  return [{
    type: output.type,
    payload: result as any,
    tags: output.tags,
    ttl: output.ttl,
  }];
}
