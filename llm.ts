import * as http from "http";
import * as https from "https";
import type { IncomingMessage } from "http";
import { requestUrl } from "obsidian";

export interface LLMSettings {
  endpoint: string;
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
function post(base: string, path: string, body: unknown, signal?: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const url = new URL(base.replace(/\/+$/, "") + path);
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, signal },
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
    chat_template_kwargs: { enable_thinking: s.thinking },
  }, signal);
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
  const res = await post(s.embedEndpoint, "/v1/embeddings", { model: s.embedModel, input: inputs });
  const text = await readAll(res);
  if (res.statusCode !== 200) throw new Error(`Embedding server ${res.statusCode}: ${text}`);
  return JSON.parse(text).data.map((d: { embedding: number[] }) => d.embedding);
}

export async function listModels(endpoint: string): Promise<string[] | null> {
  try {
    const res = await requestUrl({ url: `${endpoint.replace(/\/+$/, "")}/v1/models`, throw: false });
    return res.status === 200 ? res.json.data.map((m: { id: string }) => m.id) : null;
  } catch {
    return null;
  }
}
