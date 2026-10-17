import { App, Notice } from "obsidian";
import { LLMSettings, Message, embed } from "./llm";

interface Chunk { text: string; vec: number[] }
interface Index { model: string; files: Record<string, { mtime: number; chunks: Chunk[] }> }

const CHUNK_CHARS = 1200;
const BATCH = 16;

function chunkText(title: string, body: string): string[] {
  const chunks: string[] = [];
  let cur = "";
  const flush = () => { if (cur.trim()) chunks.push(`${title}\n${cur.trim()}`); cur = ""; };
  for (const para of body.split(/\n{2,}/)) {
    // A single huge paragraph is hard-split so no chunk exceeds the embedding model's input.
    for (let i = 0; i < para.length; i += CHUNK_CHARS * 2) {
      const piece = para.slice(i, i + CHUNK_CHARS * 2);
      if (cur.length + piece.length > CHUNK_CHARS) flush();
      cur += piece + "\n\n";
    }
  }
  flush();
  return chunks;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na * nb) || 1);
};

// Embedding index of the vault, stored beside the plugin and refreshed by modification time.
export class VaultSearch {
  private index: Index | null = null;
  private path: string;

  constructor(private app: App, private s: LLMSettings, dir: string) {
    this.path = `${dir}/index.json`;
  }

  private async load(): Promise<Index> {
    if (this.index) return this.index;
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(this.path)) this.index = JSON.parse(await adapter.read(this.path));
    } catch { /* corrupt index: rebuild */ }
    if (!this.index || this.index.model !== this.s.embedModel) this.index = { model: this.s.embedModel, files: {} };
    return this.index;
  }

  async reset() {
    this.index = { model: this.s.embedModel, files: {} };
    await this.update();
  }

  async update() {
    const index = await this.load();
    const files = this.app.vault.getMarkdownFiles();
    const paths = new Set(files.map((f) => f.path));
    for (const p of Object.keys(index.files)) if (!paths.has(p)) delete index.files[p];
    const stale = files.filter((f) => index.files[f.path]?.mtime !== f.stat.mtime);
    if (!stale.length) return;

    const progress = new Notice(`Indexing 0/${stale.length} notes…`, 0);
    try {
      for (const [i, f] of stale.entries()) {
        progress.setMessage(`Indexing ${i + 1}/${stale.length} notes…`);
        const texts = chunkText(f.basename, await this.app.vault.cachedRead(f));
        const chunks: Chunk[] = [];
        for (let b = 0; b < texts.length; b += BATCH) {
          const batch = texts.slice(b, b + BATCH);
          const vecs = await embed(this.s, batch.map((t) => "search_document: " + t));
          batch.forEach((text, j) => chunks.push({ text, vec: vecs[j].map((v) => Math.round(v * 1e5) / 1e5) }));
        }
        index.files[f.path] = { mtime: f.stat.mtime, chunks };
      }
    } finally {
      progress.hide();
      await this.app.vault.adapter.write(this.path, JSON.stringify(index));
    }
  }

  async search(query: string, k = 6): Promise<{ path: string; text: string }[]> {
    await this.update();
    const [q] = await embed(this.s, ["search_query: " + query]);
    const scored = Object.entries((await this.load()).files).flatMap(([path, f]) =>
      f.chunks.map((c) => ({ path, text: c.text, score: cosine(q, c.vec) })),
    );
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }
}

export async function askVault(search: VaultSearch, question: string): Promise<Message[]> {
  const hits = await search.search(question);
  if (!hits.length) throw new Error("The vault has no indexed notes.");
  const sources = hits.map((h) => `--- [[${h.path.replace(/\.md$/, "").split("/").pop()}]]\n${h.text}`).join("\n\n");
  return [
    { role: "system", content: "Answer the question using only the note excerpts below. Cite the notes you used as [[wikilinks]]. If the excerpts do not contain the answer, say so.\n\n" + sources },
    { role: "user", content: question },
  ];
}

export async function digestMessages(app: App, days: number): Promise<Message[]> {
  const since = Date.now() - days * 864e5;
  const recent = app.vault.getMarkdownFiles()
    .filter((f) => f.stat.mtime > since)
    .sort((a, b) => b.stat.mtime - a.stat.mtime);
  if (!recent.length) throw new Error("No notes were edited in that period.");

  let notes = "";
  for (const f of recent) {
    if (notes.length > 24000) break;
    notes += `## [[${f.basename}]]\n${(await app.vault.cachedRead(f)).slice(0, 1500)}\n\n`;
  }
  return [
    { role: "system", content: "Write a digest of the user's recently edited notes: group them by theme, use short bullet points, and reference each note as a [[wikilink]]. Reply with only the digest in markdown." },
    { role: "user", content: notes },
  ];
}
