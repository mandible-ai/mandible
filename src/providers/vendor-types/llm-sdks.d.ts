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
      }): Promise<{ content: Array<{ type: string; text?: string }> }>;
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
        }): Promise<{ choices: Array<{ message: { content: string } }> }>;
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
  }): Promise<{ object: any }>;

  export function generateText(options: {
    model: any;
    prompt: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string }>;
}

declare module '@ai-sdk/anthropic' {
  export function anthropic(model: string): any;
}

declare module '@ai-sdk/openai' {
  export function openai(model: string): any;
}

declare module '@ai-sdk/google' {
  export function google(model: string): any;
}
