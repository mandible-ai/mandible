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

/**
 * Creates an action handler that calls an LLM for plain text generation
 * and routes the result to appropriate signal types.
 *
 * Usage:
 *   colony('summarizer')
 *     .do('article:ready', withLLM({
 *       model: 'claude-sonnet-4-5-20250929',
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
    model,
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

  return async (signal: Signal<T>, ctx: ActionContext) => {
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
  provider: 'anthropic' | 'bedrock' | 'openai' | 'vercel-ai',
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
    default:
      throw new Error(`Unknown provider: ${provider}. Use 'anthropic', 'bedrock', 'openai', 'vercel-ai', or pass a custom function.`);
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
    const { google } = await import('@ai-sdk/google');
    return google(model.replace('google/', ''));
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
