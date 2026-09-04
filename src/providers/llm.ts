// PURPOSE: withLLM — Plain text LLM generation provider
// PURPOSE: Lightweight provider that calls an LLM and returns raw text, no schema validation

import type { Signal, ActionContext } from '../core/types.js';
import type {
  LLMConfig,
  ActionHandler,
  SignalDeposit,
  LLMCallFunction,
  BedrockConfig,
} from './types.js';
import { resolveModel } from './models.js';

/**
 * Creates an action handler that calls an LLM for plain text generation
 * and routes the result to appropriate signal types.
 *
 * Usage:
 *   colony('summarizer')
 *     .do('article:ready', withLLM({
 *       model: 'sonnet',          // alias → latest Sonnet; full IDs also accepted
 *       provider: 'anthropic',
 *       prompt: (signal) => `Summarize this article:\n${signal.payload.content}`,
 *       route: 'summary:ready',
 *     }))
 *     .build();
 */
export function withLLM<T = Record<string, unknown>>(
  config: LLMConfig<T>
): ActionHandler<T> {
  const {
    model: modelConfig,
    provider = 'anthropic',
    prompt,
    systemPrompt,
    maxTokens = 4096,
    temperature = 0,
    format,
    route,
    autoWithdraw = true,
    bedrockConfig,
  } = config;

  if (typeof modelConfig === 'function' && bedrockConfig?.model) {
    throw new Error(
      'withLLM: a dynamic `model` function cannot be combined with `bedrockConfig.model` ' +
      '(the static override would silently win). Return Bedrock model IDs from the function instead.'
    );
  }

  return async (signal: Signal<T>, ctx: ActionContext) => {
    // 0. Resolve the model (alias or full ID; static string or signal-driven function)
    const model = resolveModel(
      typeof modelConfig === 'function' ? modelConfig(signal) : modelConfig
    );

    // 1. Resolve the prompt
    let resolvedPrompt = typeof prompt === 'function'
      ? await prompt(signal)
      : prompt;

    // 1b. Append format instruction when format is set
    if (format === 'markdown') {
      resolvedPrompt += '\n\nRespond using well-structured markdown.';
    }

    // 2. Call the LLM
    let text: string;

    if (typeof provider === 'function') {
      text = await (provider as LLMCallFunction<string>)(resolvedPrompt, {
        systemPrompt,
        maxTokens,
        temperature,
      });
    } else {
      text = await callTextProvider(provider, model, resolvedPrompt, {
        systemPrompt,
        maxTokens,
        temperature,
        bedrockConfig,
      });
    }

    // 3. Route to signal deposits
    const defaultPayload = format && format !== 'text'
      ? { text, format }
      : { text };
    const deposits = resolveTextRoute(route, text, signal, defaultPayload);
    for (const deposit of deposits) {
      await ctx.deposit(deposit.type, deposit.payload ?? defaultPayload, {
        causedBy: [signal.id],
        tags: deposit.tags,
        ttl: deposit.ttl,
      });
    }

    // 4. Withdraw
    if (autoWithdraw) {
      await ctx.withdraw(signal.id);
    }

    ctx.log(`LLM text generation completed. Deposited ${deposits.length} signal(s).`);
  };
}

// ----------------------------------------------------------
// Provider implementations (text-only, no JSON parsing)
// ----------------------------------------------------------

async function callTextProvider(
  provider: 'anthropic' | 'bedrock' | 'openai' | 'vercel-ai' | 'gemini',
  model: string,
  prompt: string,
  options: {
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    bedrockConfig?: BedrockConfig;
  }
): Promise<string> {
  switch (provider) {
    case 'anthropic':
      return callAnthropicText(model, prompt, options);
    case 'bedrock':
      return callBedrockText(model, prompt, options);
    case 'openai':
      return callOpenAIText(model, prompt, options);
    case 'vercel-ai':
      return callVercelAIText(model, prompt, options);
    case 'gemini':
      return callGeminiText(model, prompt, options);
    default:
      throw new Error(`Unknown provider: ${provider}. Use 'anthropic', 'bedrock', 'openai', 'vercel-ai', 'gemini', or pass a custom function.`);
  }
}

async function callAnthropicText(
  model: string,
  prompt: string,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number }
): Promise<string> {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();

    const response = await client.messages.create({
      model,
      max_tokens: options.maxTokens ?? 4096,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');
  } catch (err: any) {
    if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'Anthropic provider requires @anthropic-ai/sdk. Install it:\n' +
        '  npm install @anthropic-ai/sdk'
      );
    }
    throw err;
  }
}

async function callBedrockText(
  model: string,
  prompt: string,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number; bedrockConfig?: BedrockConfig }
): Promise<string> {
  if (!options.bedrockConfig) {
    throw new Error(
      "Bedrock provider requires bedrockConfig. Pass { provider: 'bedrock', bedrockConfig: { region: '...' } }."
    );
  }

  try {
    // @ts-expect-error — optional peer dependency, may not be installed
    const { default: AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk');

    const clientOptions: Record<string, unknown> = {
      awsRegion: options.bedrockConfig.region,
    };
    if (options.bedrockConfig.accessKeyId) clientOptions.awsAccessKey = options.bedrockConfig.accessKeyId;
    if (options.bedrockConfig.secretAccessKey) clientOptions.awsSecretKey = options.bedrockConfig.secretAccessKey;
    if (options.bedrockConfig.sessionToken) clientOptions.awsSessionToken = options.bedrockConfig.sessionToken;
    if (options.bedrockConfig.profile) clientOptions.awsProfile = options.bedrockConfig.profile;

    const client = new AnthropicBedrock(clientOptions);

    const requestOptions: Record<string, unknown> = {
      model: options.bedrockConfig.model ?? model,
      max_tokens: options.maxTokens ?? 4096,
      messages: [{ role: 'user', content: prompt }],
    };
    if (options.temperature !== undefined) requestOptions.temperature = options.temperature;
    if (options.systemPrompt) requestOptions.system = options.systemPrompt;

    const response = await (client as any).messages.create(requestOptions);

    return response.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');
  } catch (err: any) {
    if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'Bedrock provider requires @anthropic-ai/bedrock-sdk. Install it:\n' +
        '  npm install @anthropic-ai/bedrock-sdk'
      );
    }
    throw err;
  }
}

async function callOpenAIText(
  model: string,
  prompt: string,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number }
): Promise<string> {
  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();

    const messages: any[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await client.chat.completions.create({
      model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0,
    });

    return response.choices[0]?.message?.content ?? '';
  } catch (err: any) {
    if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'OpenAI provider requires openai. Install it:\n' +
        '  npm install openai'
      );
    }
    throw err;
  }
}

/**
 * Resolve a bare model name to this zone's gateway model group. The zone key
 * is scoped to MANDIBLE_MODEL_GROUPS (injected at launch); tenant provider
 * credentials register project-scoped groups like "proj_x/gemini-3.7-flash",
 * so a colony can keep writing the bare model name and run unchanged whether
 * the group is platform-provided or BYO. Exact matches win; otherwise the
 * first group ending in "/<model>" is used; with no group list the name
 * passes through untouched.
 */
export function resolveGatewayGroup(model: string): string {
  const groups = (process.env.MANDIBLE_MODEL_GROUPS ?? '')
    .split(',').map((g) => g.trim()).filter(Boolean);
  if (groups.length === 0 || groups.includes(model)) return model;
  const scoped = groups.find((g) => g.endsWith('/' + model));
  return scoped ?? model;
}

/**
 * Gemini, gateway-first. Inside a Mandible zone the LiteLLM gateway fronts
 * Gemini over the OpenAI-compatible surface with the zone's metered key
 * (OPENAI_BASE_URL / OPENAI_API_KEY are injected at launch); the tenant's
 * real provider key never enters the zone. Outside a zone, talk to Google
 * directly with GEMINI_API_KEY.
 */
async function callGeminiText(
  model: string,
  prompt: string,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number }
): Promise<string> {
  const normalized = model.replace(/^(gemini|google)\//, '');
  if (process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY) {
    return callOpenAIText(resolveGatewayGroup(normalized), prompt, options);
  }

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Gemini provider needs GEMINI_API_KEY (direct access), or a Mandible ' +
      'model gateway (OPENAI_BASE_URL + OPENAI_API_KEY, injected inside zones).'
    );
  }
  try {
    const { generateText } = await import('ai');
    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    const google = createGoogleGenerativeAI({ apiKey });
    const { text } = await generateText({
      model: google(normalized),
      prompt,
      ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    });
    return text;
  } catch (err: any) {
    if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'Gemini provider requires ai and @ai-sdk/google. Install them:\n' +
        '  npm install ai @ai-sdk/google'
      );
    }
    throw err;
  }
}

async function callVercelAIText(
  model: string,
  prompt: string,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number }
): Promise<string> {
  try {
    const { generateText } = await import('ai');

    const modelInstance = await resolveVercelModel(model);

    const { text } = await generateText({
      model: modelInstance,
      prompt,
      ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    });

    return text;
  } catch (err: any) {
    if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'Vercel AI provider requires ai and a model provider. Install them:\n' +
        '  npm install ai @ai-sdk/anthropic\n' +
        '  # or: npm install ai @ai-sdk/openai'
      );
    }
    throw err;
  }
}

/**
 * Resolve a model string to a Vercel AI SDK model instance.
 * Auto-detects provider based on model name prefix.
 */
async function resolveVercelModel(model: string): Promise<any> {
  if (model.startsWith('claude') || model.startsWith('anthropic/')) {
    const { anthropic } = await import('@ai-sdk/anthropic');
    return anthropic(model.replace('anthropic/', ''));
  }

  if (model.startsWith('gpt') || model.startsWith('openai/')) {
    const { openai } = await import('@ai-sdk/openai');
    return openai(model.replace('openai/', ''));
  }

  if (model.startsWith('gemini') || model.startsWith('google/')) {
    const normalized = model.replace(/^(gemini|google)\//, '');
    if (process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY) {
      // Mandible zone: the model gateway fronts Gemini; route through it so
      // the call stays metered and the provider key stays out of the zone.
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({
        baseURL: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY,
      })(resolveGatewayGroup(normalized));
    }
    const { google } = await import('@ai-sdk/google');
    return google(normalized);
  }

  if (model.startsWith('glm') || model.startsWith('zai/')) {
    // @ts-expect-error — optional peer dependency, may not be installed
    const { createZhipu } = await import('zhipu-ai-provider');
    const zai = createZhipu({
      baseURL: process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/paas/v4',
      apiKey: process.env.ZAI_API_KEY,
    });
    return zai(model.replace('zai/', ''));
  }

  // Default to Anthropic
  const { anthropic } = await import('@ai-sdk/anthropic');
  return anthropic(model);
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

function resolveTextRoute<T>(
  route: LLMConfig<T>['route'],
  text: string,
  signal: Signal<T>,
  defaultPayload: Record<string, unknown>
): SignalDeposit[] {
  if (typeof route === 'string') {
    return [{ type: route, payload: defaultPayload }];
  }

  const mapped = route(text, signal);
  return Array.isArray(mapped) ? mapped : [mapped];
}
