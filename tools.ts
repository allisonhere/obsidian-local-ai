import { App, TFile } from "obsidian";
import type { ToolCall, ToolSpec } from "./llm";

// A write queued for user review; nothing touches the vault until applyWrites.
export interface PendingWrite {
  kind: "create" | "overwrite";
  path: string;
  content: string;
  previous: string; // "" for create
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "search_vault",
      description: "Search the user's notes and return the most relevant excerpts with their note paths.",
      parameters: { type: "object", properties: { query: { type: "string", description: "What to search for" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description: "Read a note by its path or basename.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Note path like 'Folder/Name.md' or just 'Name'" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new note. The change is shown for review before it is written.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string", description: "Full markdown body" } }, required: ["path", "content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "overwrite_note",
      description: "Replace the entire content of an existing note. The change is shown for review before it is written.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string", description: "Full new markdown body" } }, required: ["path", "content"] },
    },
  },
];

// Find a note by path, or by basename (with or without .md) as a fallback.
export function findNote(app: App, path: string): TFile | null {
  const f = app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) return f;
  const p = path.replace(/\.md$/i, "").toLowerCase();
  const want = (x: string) => x.replace(/\.md$/i, "").toLowerCase() === p;
  return app.vault.getMarkdownFiles().find((f) => want(f.path) || want(f.basename)) ?? null;
}

// Run one tool call. Read tools execute now; write tools are queued for review.
export async function executeTool(
  app: App,
  search: (q: string) => Promise<{ path: string; text: string }[]>,
  call: ToolCall,
  queueWrite: (w: PendingWrite) => void,
): Promise<string> {
  const args = JSON.parse(call.function.arguments || "{}");
  switch (call.function.name) {
    case "search_vault": {
      const hits = await search(String(args.query ?? ""));
      if (!hits.length) return "No matching notes found.";
      return hits.map((h) => `- [[${h.path.replace(/\.md$/, "")}]]\n${h.text}`).join("\n\n");
    }
    case "read_note": {
      const file = findNote(app, String(args.path ?? ""));
      if (!file) return `No note found matching "${String(args.path ?? "")}".`;
      return (await app.vault.cachedRead(file)).slice(0, 20000);
    }
    case "create_note": {
      const path = String(args.path ?? "").trim();
      const content = String(args.content ?? "");
      if (!path || !content) return "create_note needs a path and content.";
      queueWrite({ kind: "create", path, content, previous: "" });
      return `Queued to create "${path}" (${content.length} chars). Shown for review before writing.`;
    }
    case "overwrite_note": {
      const path = String(args.path ?? "").trim();
      const content = String(args.content ?? "");
      const file = findNote(app, path);
      if (!file) return `No note found matching "${path}". Use create_note for new notes.`;
      queueWrite({ kind: "overwrite", path: file.path, content, previous: await app.vault.cachedRead(file) });
      return `Queued to update "${file.path}". Shown for review before writing.`;
    }
    default:
      return `Unknown tool "${call.function.name}".`;
  }
}

// Ensure every parent folder of `path` exists so vault.create succeeds.
async function ensureParent(app: App, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
  }
}

// Write the queued changes. Called only after the user clicks Apply.
export async function applyWrites(app: App, writes: PendingWrite[]): Promise<void> {
  for (const w of writes) {
    const existing = app.vault.getAbstractFileByPath(w.path);
    if (w.kind === "create" || !(existing instanceof TFile)) {
      await ensureParent(app, w.path);
      await app.vault.create(w.path, w.content);
    } else {
      await app.vault.modify(existing, w.content);
    }
  }
}

export type DiffLine = { op: "same" | "add" | "del"; text: string };

// Line-level LCS diff. Falls back to a coarse result when either side is very large.
export function diffLines(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  if (A.length * B.length > 2_000_000) {
    return [
      ...A.map((text): DiffLine => ({ op: "del", text })),
      ...B.map((text): DiffLine => ({ op: "add", text })),
    ];
  }
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: "same", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: "del", text: A[i] }); i++; }
    else { out.push({ op: "add", text: B[j] }); j++; }
  }
  while (i < n) out.push({ op: "del", text: A[i++] });
  while (j < m) out.push({ op: "add", text: B[j++] });
  return out;
}
