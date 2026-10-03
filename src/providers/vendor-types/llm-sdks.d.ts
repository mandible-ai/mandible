// Minimal type stubs for optional LLM SDK peer dependencies.

declare module '@anthropic-ai/sdk' {
  export default class Anthropic {
    messages: {
      create(options: {
        model: string;
        max_tokens: number;
        temperature?: number;
        system?: string;
        messages: Array<{ role: string; content: string }>;
      }): Promise<{
        content: Array<{ type: string; text?: string }>;
        usage?: {
          input_tokens: number;
          output_tokens: number;
          cache_read_input_tokens?: number | null;
          cache_creation_input_tokens?: number | null;
        };
      }>;
    };
  }
}

declare module 'openai' {
  export default class OpenAI {
    chat: {
      completions: {
        create(options: {
          model: string;
          messages: any[];
          max_tokens?: number;
          temperature?: number;
          response_format?: { type: string };
        }): Promise<{
          choices: Array<{ message: { content: string } }>;
          usage?: {
            prompt_tokens: number;
            completion_tokens: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
        }>;
      };
    };
  }
}

declare module 'ai' {
  export function generateObject(options: {
    model: any;
    schema: any;
    prompt: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ object: any; usage?: any }>;

  export function generateText(options: {
    model: any;
    prompt: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; usage?: any }>;
}

declare module '@ai-sdk/anthropic' {
  export function anthropic(model: string): any;
}

declare module '@ai-sdk/openai' {
  export function openai(model: string): any;
  export function createOpenAI(options: { baseURL?: string; apiKey?: string }): (model: string) => any;
}

declare module '@ai-sdk/google' {
  export function google(model: string): any;
  export function createGoogleGenerativeAI(options: { apiKey?: string }): (model: string) => any;
}
