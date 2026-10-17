import * as http from "http";
import * as https from "https";
import type { IncomingMessage } from "http";
import { requestUrl } from "obsidian";

export interface LLMSettings {
  endpoint: string;
  // Bearer token for cloud providers; empty for local servers.
  apiKey: string;
  model: string;
  // Let the model reason before answering: better on hard questions, slower to first token.
  thinking: boolean;
  temperature: number;
  // Persona prepended to every chat conversation.
  systemPrompt: string;
  embedEndpoint: string;
  embedModel: string;
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

// Node http rather than fetch: the servers send no CORS headers for Obsidian's app:// origin.
function post(base: string, path: string, body: unknown, apiKey: string, signal?: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const url = new URL(base.replace(/\/+$/, "") + path);
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json", ...(apiKey && { Authorization: `Bearer ${apiKey}` }) }, signal },
      resolve,
    );
    req.on("error", (e: Error) =>
      reject(e.name === "AbortError" ? e : new Error(`Cannot reach the server at ${base}. Is it running?`)),
    );
    req.end(JSON.stringify(body));
  });
}

async function readAll(res: IncomingMessage): Promise<string> {
  res.setEncoding("utf8");
  let text = "";
  for await (const chunk of res) text += chunk;
  return text;
}

// OpenAI-compatible streaming. Reasoning tokens arrive in delta.reasoning_content and are
// ignored; only delta.content is the answer.
export async function* streamChat(s: LLMSettings, messages: Message[], signal: AbortSignal) {
  const res = await post(s.endpoint, "/v1/chat/completions", {
    model: s.model,
    stream: true,
    messages,
    temperature: s.temperature,
    // llama.cpp-style template switch; hosted APIs reject unknown fields, so only send it to http servers.
    ...(!s.endpoint.startsWith("https:") && { chat_template_kwargs: { enable_thinking: s.thinking } }),
  }, s.apiKey, signal);
  if (res.statusCode !== 200) throw new Error(`LLM server ${res.statusCode}: ${await readAll(res)}`);

  res.setEncoding("utf8");
  let buf = "";
  for await (const chunk of res) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      const msg = JSON.parse(data);
      if (msg.error) throw new Error(msg.error.message ?? String(msg.error));
      const text = msg.choices?.[0]?.delta?.content;
      if (text) yield text as string;
    }
  }
}

export async function embed(s: LLMSettings, inputs: string[]): Promise<number[][]> {
  const res = await post(s.embedEndpoint, "/v1/embeddings", { model: s.embedModel, input: inputs }, sameHost(s.endpoint, s.embedEndpoint) ? s.apiKey : "");
  const text = await readAll(res);
  if (res.statusCode !== 200) throw new Error(`Embedding server ${res.statusCode}: ${text}`);
  return JSON.parse(text).data.map((d: { embedding: number[] }) => d.embedding);
}

const sameHost = (a: string, b: string) => {
  try { return new URL(a).host === new URL(b).host; } catch { return false; }
};

export interface Provider {
  id: string;
  label: string;
  endpoint: string;
  embedEndpoint: string;
  embedModel: string;
}

// All speak the OpenAI-compatible API; presets just fill in the endpoints.
export const PROVIDERS: Provider[] = [
  { id: "llamacpp", label: "llama.cpp server", endpoint: "http://127.0.0.1:8080", embedEndpoint: "http://127.0.0.1:1234", embedModel: "text-embedding-nomic-embed-text-v1.5" },
  { id: "ollama", label: "Ollama", endpoint: "http://127.0.0.1:11434", embedEndpoint: "http://127.0.0.1:11434", embedModel: "nomic-embed-text" },
  { id: "lmstudio", label: "LM Studio", endpoint: "http://127.0.0.1:1234", embedEndpoint: "http://127.0.0.1:1234", embedModel: "text-embedding-nomic-embed-text-v1.5" },
  { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com", embedEndpoint: "https://api.openai.com", embedModel: "text-embedding-3-small" },
  { id: "openrouter", label: "OpenRouter", endpoint: "https://openrouter.ai/api", embedEndpoint: "https://openrouter.ai/api", embedModel: "openai/text-embedding-3-small" },
];

export async function listModels(s: Pick<LLMSettings, "endpoint" | "apiKey">): Promise<string[] | null> {
  try {
    const res = await requestUrl({
      url: `${s.endpoint.replace(/\/+$/, "")}/v1/models`,
      headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
      throw: false,
    });
    return res.status === 200 ? res.json.data.map((m: { id: string }) => m.id) : null;
  } catch {
    return null;
  }
}
