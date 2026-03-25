// ============================================================
// withStructuredOutput — Multi-provider structured output
// ============================================================
// Calls an LLM, validates the response against a schema, and
// routes the result to different signal types based on content.
//
// This is the medium-weight provider — use it for colonies that
// need LLM judgment but not full tool-use loops (Critics,
// Classifiers, Routers).
//
// Provider-agnostic: works with Anthropic, OpenAI, or any custom
// LLM function. Pass `provider` to select, or pass a function
// directly for custom providers.
//
// Usage:
//   colony('critic')
//     .do('review', withStructuredOutput({
//       model: 'claude-sonnet-4-5-20250929',
//       provider: 'anthropic',
//       schema: z.object({
//         approved: z.boolean(),
//         feedback: z.string(),
//         severity: z.enum(['minor', 'major', 'blocking']),
//       }),
//       prompt: (signal) => `Review this code:\n${signal.payload.code}`,
//       route: (result) => result.approved
//         ? { type: 'review:approved', payload: result }
//         : { type: 'review:changes-needed', payload: result },
//     }))
//     .build();
// ============================================================

import type { Signal, ActionContext } from '../core/types.js';
import type {
  StructuredOutputConfig,
  ActionHandler,
  SignalDeposit,
  LLMCallFunction,
  BedrockConfig,
} from './types.js';

/**
 * Creates an action handler that calls an LLM for structured output
 * and routes the result to appropriate signal types.
 */
export function withStructuredOutput<
  T = Record<string, unknown>,
  R = Record<string, unknown>
>(
  config: StructuredOutputConfig<T, R>
): ActionHandler<T> {
  const {
    model,
    provider = 'anthropic',
    prompt,
    systemPrompt,
    schema,
    maxTokens = 4096,
    temperature = 0,
    route,
    autoWithdraw = true,
    bedrockConfig,
  } = config;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    // 1. Resolve the prompt
    const resolvedPrompt = typeof prompt === 'function'
      ? await prompt(signal)
      : prompt;

    // 2. Build the full prompt with schema instructions
    const fullPrompt = schema
      ? `${resolvedPrompt}\n\nRespond with valid JSON matching this schema:\n${schemaToString(schema)}`
      : resolvedPrompt;

    // 3. Call the LLM
    let result: R;

    if (typeof provider === 'function') {
      // Custom provider function
      result = await (provider as LLMCallFunction<R>)(fullPrompt, {
        systemPrompt,
        maxTokens,
        temperature,
      });
    } else {
      result = await callProvider(provider, model, fullPrompt, {
        systemPrompt,
        maxTokens,
        temperature,
        schema,
        bedrockConfig,
      });
    }

    // 4. Validate against schema if provided
    if (schema && typeof schema.parse === 'function') {
      try {
        result = schema.parse(result);
      } catch (err: any) {
        ctx.log(`Schema validation failed: ${err.message}`, 'error');
        throw new Error(`Structured output validation failed: ${err.message}`);
      }
    }

    // 5. Route to signal deposits
    const deposits = resolveRoute(route, result, signal);
    for (const deposit of deposits) {
      await ctx.deposit(deposit.type, deposit.payload ?? (result as any), {
        causedBy: [signal.id],
        tags: deposit.tags,
        ttl: deposit.ttl,
      });
    }

    // 6. Withdraw
    if (autoWithdraw) {
      await ctx.withdraw(signal.id);
    }

    ctx.log(`Structured output completed. Deposited ${deposits.length} signal(s).`);
  };
}

// ----------------------------------------------------------
// Provider implementations
// ----------------------------------------------------------

async function callProvider<R>(
  provider: 'anthropic' | 'bedrock' | 'openai' | 'vercel-ai',
  model: string,
  prompt: string,
  options: {
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    schema?: any;
    bedrockConfig?: BedrockConfig;
  }
): Promise<R> {
  switch (provider) {
    case 'anthropic':
      return callAnthropic(model, prompt, options);
    case 'bedrock':
      return callBedrock(model, prompt, options);
    case 'openai':
      return callOpenAI(model, prompt, options);
    case 'vercel-ai':
      return callVercelAI(model, prompt, options);
    default:
      throw new Error(`Unknown provider: ${provider}. Use 'anthropic', 'bedrock', 'openai', 'vercel-ai', or pass a custom function.`);
  }
}

async function callAnthropic<R>(
  model: string,
  prompt: string,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number }
): Promise<R> {
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

    // Extract text and parse as JSON
    const text = response.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');

    return parseJsonResponse<R>(text);
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

async function callBedrock<R>(
  model: string,
  prompt: string,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number; bedrockConfig?: BedrockConfig }
): Promise<R> {
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

    const text = response.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');

    return parseJsonResponse<R>(text);
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

async function callOpenAI<R>(
  model: string,
  prompt: string,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number; schema?: any }
): Promise<R> {
  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();

    const messages: any[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    // Use structured output if schema is available and model supports it
    const response = await client.chat.completions.create({
      model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0,
      response_format: { type: 'json_object' },
    });

    const text = response.choices[0]?.message?.content ?? '{}';
    return parseJsonResponse<R>(text);
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

async function callVercelAI<R>(
  model: string,
  prompt: string,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number; schema?: any }
): Promise<R> {
  try {
    const { generateObject, generateText } = await import('ai');

    // If we have a Zod schema, use generateObject for validated structured output
    if (options.schema) {
      // Vercel AI SDK needs a model instance, not a string.
      // The caller should configure the model provider externally.
      // For now, try to auto-detect based on model name.
      const modelInstance = await resolveVercelModel(model);

      const { object } = await generateObject({
        model: modelInstance,
        schema: options.schema,
        prompt,
        ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      });

      return object as R;
    }

    // Fallback to text generation + JSON parse
    const modelInstance = await resolveVercelModel(model);
    const { text } = await generateText({
      model: modelInstance,
      prompt,
      ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    });

    return parseJsonResponse<R>(text);
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

function parseJsonResponse<R>(text: string): R {
  // Try to extract JSON from the response (handles markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const jsonStr = (jsonMatch[1] ?? text).trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `Failed to parse LLM response as JSON.\nResponse:\n${text.slice(0, 500)}`
    );
  }
}

function schemaToString(schema: any): string {
  // If it's a Zod schema, try to get its description
  if (typeof schema.describe === 'function') {
    return JSON.stringify(schema.describe(), null, 2);
  }
  // If it has a shape (Zod object), describe the shape
  if (schema._def?.shape) {
    const shape: Record<string, string> = {};
    for (const [key, val] of Object.entries(schema._def.shape())) {
      shape[key] = describeZodType(val);
    }
    return JSON.stringify(shape, null, 2);
  }
  return String(schema);
}

function describeZodType(zodType: any): string {
  const def = zodType?._def;
  if (!def) return 'unknown';

  switch (def.typeName) {
    case 'ZodString': return 'string';
    case 'ZodNumber': return 'number';
    case 'ZodBoolean': return 'boolean';
    case 'ZodEnum': return `enum(${def.values.join(' | ')})`;
    case 'ZodArray': return `array<${describeZodType(def.type)}>`;
    case 'ZodOptional': return `${describeZodType(def.innerType)}?`;
    default: return def.typeName ?? 'unknown';
  }
}

function resolveRoute<T, R>(
  route: StructuredOutputConfig<T, R>['route'],
  result: R,
  signal: Signal<T>
): SignalDeposit[] {
  if (typeof route === 'string') {
    return [{ type: route, payload: result as any }];
  }

  const mapped = route(result, signal);
  return Array.isArray(mapped) ? mapped : [mapped];
}
