// Minimal type stubs for optional peer dependencies.
// These allow the project to type-check without installing the SDKs.
// Real types come from the packages themselves when installed.

declare module '@anthropic-ai/claude-code' {
  export function query(options: {
    prompt: string;
    options?: {
      model?: string;
      maxTokens?: number;
      systemPrompt?: string;
      allowedTools?: string[];
      cwd?: string;
    };
  }): Promise<any[]>;
}
