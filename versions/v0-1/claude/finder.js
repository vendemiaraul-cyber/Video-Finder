// Legacy copy: the Claude finder is switched off (it needed a paid Anthropic API key).
export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best results)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
];
export const DEFAULT_MODEL = MODELS[0]?.id;
export async function findWithClaude() {
  throw new Error("The Claude finder is switched off in this legacy version (it needed a paid Anthropic API key).");
}
