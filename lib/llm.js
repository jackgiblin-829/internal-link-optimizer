import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// Provider is chosen by LLM_PROVIDER, else auto-detected from whichever key is
// present (OpenAI wins if both are set). Swap providers by editing .env only.
export const provider = (
  process.env.LLM_PROVIDER ||
  (process.env.OPENAI_API_KEY ? "openai" : "anthropic")
).toLowerCase();

const DEFAULTS = {
  anthropic: { light: "claude-sonnet-5", heavy: "claude-opus-5" },
  openai: { light: "gpt-4o-mini", heavy: "gpt-4o" },
};

export const MODELS = {
  light: process.env.MODEL_LIGHT || DEFAULTS[provider].light,
  heavy: process.env.MODEL_HEAVY || DEFAULTS[provider].heavy,
};

const client =
  provider === "openai"
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function keyName() {
  return provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

export function hasKey() {
  return provider === "openai"
    ? Boolean(process.env.OPENAI_API_KEY)
    : Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Single-shot text completion, provider-agnostic. Returns the text output.
 */
export async function complete({
  model,
  system = "",
  prompt,
  temperature = 0.3,
  maxTokens = 8000,
}) {
  if (provider === "openai") {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });
    const res = await client.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    });
    return (res.choices?.[0]?.message?.content || "").trim();
  }

  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: prompt }],
  });
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
