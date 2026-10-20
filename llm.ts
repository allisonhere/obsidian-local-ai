import * as http from "http";
import * as https from "https";
import type { IncomingMessage } from "http";
import { requestUrl } from "obsidian";

export interface LLMSettings {
  endpoint: string;
  // Bearer token for cloud providers; empty for local servers.
  apiKey: string;
  model: string;
  // Endpoint → last model chosen, so switching providers restores the right model.
  modelByEndpoint?: Record<string, string>;
  // Let the model reason before answering: better on hard questions, slower to first token.
  thinking: boolean;
  temperature: number;
  // Persona prepended to every chat conversation.
  systemPrompt: string;
  embedEndpoint: string;
  embedModel: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface StreamChunk {
  content?: string;        // one content delta
  toolCalls?: ToolCall[];  // assembled tool calls, emitted once at end of stream
  finishReason?: string;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
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
export async function* streamChat(s: LLMSettings, messages: Message[], signal: AbortSignal, tools?: ToolSpec[]): AsyncGenerator<StreamChunk> {
  const res = await post(s.endpoint, "/v1/chat/completions", {
    model: s.model,
    stream: true,
    messages,
    temperature: s.temperature,
    ...(tools && tools.length && { tools, tool_choice: "auto" }),
    // llama.cpp-style template switch; hosted APIs reject unknown fields, so only send it to http servers.
    ...(!s.endpoint.startsWith("https:") && { chat_template_kwargs: { enable_thinking: s.thinking } }),
  }, s.apiKey, signal);
  if (res.statusCode !== 200) throw new Error(`LLM server ${res.statusCode}: ${await readAll(res)}`);

  res.setEncoding("utf8");
  let buf = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string | undefined;
  for await (const chunk of res) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const msg = JSON.parse(data);
      if (msg.error) throw new Error(msg.error.message ?? String(msg.error));
      const choice = msg.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const text = choice?.delta?.content;
      if (text) yield { content: text as string };
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const idx = tc.index;
        let acc = calls.get(idx);
        if (!acc) { acc = { id: tc.id ?? "", name: "", args: "" }; calls.set(idx, acc); }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }
  }
  if (calls.size) {
    const toolCalls: ToolCall[] = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.args },
    }));
    yield { toolCalls, finishReason };
  } else if (finishReason) {
    yield { finishReason };
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
  note?: string;
}

// Hosted chat-only providers have no embeddings API, so "Ask your vault" keeps using a local embedding server.
const LOCAL_EMBED = { embedEndpoint: "http://127.0.0.1:1234", embedModel: "text-embedding-nomic-embed-text-v1.5" };

// All speak the OpenAI-compatible API; presets just fill in the endpoints.
export const PROVIDERS: Provider[] = [
  { id: "llamacpp", label: "llama.cpp server", endpoint: "http://127.0.0.1:8080", embedEndpoint: "http://127.0.0.1:1234", embedModel: "text-embedding-nomic-embed-text-v1.5" },
  { id: "ollama", label: "Ollama", endpoint: "http://127.0.0.1:11434", embedEndpoint: "http://127.0.0.1:11434", embedModel: "nomic-embed-text" },
  { id: "lmstudio", label: "LM Studio", endpoint: "http://127.0.0.1:1234", embedEndpoint: "http://127.0.0.1:1234", embedModel: "text-embedding-nomic-embed-text-v1.5" },
  { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com", embedEndpoint: "https://api.openai.com", embedModel: "text-embedding-3-small" },
  { id: "openrouter", label: "OpenRouter", endpoint: "https://openrouter.ai/api", embedEndpoint: "https://openrouter.ai/api", embedModel: "openai/text-embedding-3-small" },
  { id: "anthropic", label: "Anthropic (Claude)", endpoint: "https://api.anthropic.com", ...LOCAL_EMBED, note: "Models like claude-sonnet-5-5. No embeddings API; uses the local embedding server." },
  { id: "deepseek", label: "DeepSeek", endpoint: "https://api.deepseek.com", ...LOCAL_EMBED, note: "Models: deepseek-chat, deepseek-reasoner. No embeddings API." },
  { id: "xai", label: "xAI (Grok)", endpoint: "https://api.x.ai", ...LOCAL_EMBED, note: "Grok models. No embeddings API." },
  { id: "groq", label: "Groq", endpoint: "https://api.groq.com/openai", ...LOCAL_EMBED, note: "Fast hosted open models. No embeddings API." },
  { id: "mistral", label: "Mistral", endpoint: "https://api.mistral.ai", embedEndpoint: "https://api.mistral.ai", embedModel: "mistral-embed" },
  { id: "together", label: "Together AI", endpoint: "https://api.together.xyz", embedEndpoint: "https://api.together.xyz", embedModel: "togethercomputer/m2-bert-80M-8k-retrieval" },
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
