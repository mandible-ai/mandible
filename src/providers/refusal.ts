// ============================================================
// Refusal — model refusals as a first-class outcome
// ============================================================
// Frontier models ship safety classifiers, and benign work can
// occasionally trip them. A refusal is not a defect: retrying it
// in a loop wastes budget, and conflating it with an error hides
// what happened from whoever reviews the run.
//
// Providers throw RefusalError when the model declines
// (Anthropic/Bedrock stop_reason 'refusal', OpenAI-format
// finish_reason 'content_filter'). Colonies can either let it
// propagate — it is distinguishable from every other failure via
// isRefusal() — or configure refusalRoute on the provider to turn
// the refusal into a signal other colonies can react to.
// ============================================================

/** Thrown when the model refuses the task rather than failing at it. */
export class RefusalError extends Error {
  /** Discriminant that survives serialization boundaries. */
  readonly refusal = true as const;

  constructor(
    /** The provider's stated reason, or the refusal text if any. */
    public readonly reason: string,
    /** Which provider surfaced the refusal ('anthropic', 'bedrock', 'openai', 'vllm'). */
    public readonly provider: string,
  ) {
    super(`Model refused: ${reason}`);
    this.name = 'RefusalError';
  }
}

/** True when an unknown error is a model refusal. */
export function isRefusal(err: unknown): err is RefusalError {
  if (err instanceof RefusalError) return true;
  return typeof err === 'object' && err !== null && (err as { refusal?: unknown }).refusal === true;
}
