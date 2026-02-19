// PURPOSE: Minimal type stubs for the Claude Agent SDK optional peer dependency.
// Real types come from the package itself when installed.

declare module '@anthropic-ai/claude-agent-sdk' {
  export interface SDKMessage {
    type: 'assistant' | 'user' | 'result' | 'system' | 'stream_event';
    uuid?: string;
    session_id?: string;
    [key: string]: unknown;
  }

  export interface SDKResultMessage extends SDKMessage {
    type: 'result';
    subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd';
    result?: string;
    errors?: string[];
    is_error: boolean;
    duration_ms: number;
    total_cost_usd: number;
    num_turns: number;
    usage: {
      input_tokens: number | null;
      output_tokens: number | null;
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    };
  }

  export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

  export interface QueryOptions {
    model?: string;
    systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
    cwd?: string;
    permissionMode?: PermissionMode;
    allowDangerouslySkipPermissions?: boolean;
    allowedTools?: string[];
    disallowedTools?: string[];
    maxTurns?: number;
    maxBudgetUsd?: number;
    env?: Record<string, string>;
    tools?: string[] | { type: 'preset'; preset: 'claude_code' };
    abortController?: AbortController;
    [key: string]: unknown;
  }

  export interface Query extends AsyncGenerator<SDKMessage, void> {
    interrupt(): Promise<void>;
  }

  export function query(params: {
    prompt: string;
    options?: QueryOptions;
  }): Query;
}
