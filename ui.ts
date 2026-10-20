import { App, FuzzySuggestModal, ItemView, MarkdownRenderer, MarkdownView, Modal, Notice, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { LLMSettings, Message, PROVIDERS, listModels, streamChat, ToolCall, StreamChunk } from "./llm";
import type { VaultSearch } from "./vault";
import { TOOL_SPECS, executeTool, applyWrites, diffLines, PendingWrite } from "./tools";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Picker<T> extends FuzzySuggestModal<T> {
  constructor(
    app: App,
    private choices: T[],
    private label: (t: T) => string,
    placeholder: string,
    private onPick: (t: T) => void,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getItems() { return this.choices; }
  getItemText(t: T) { return this.label(t); }
  onChooseItem(t: T) { this.onPick(t); }
}

export class PromptModal extends Modal {
  constructor(app: App, private title: string, private onSubmit: (text: string) => void) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    const input = contentEl.createEl("textarea");
    input.rows = 4;
    input.style.width = "100%";
    input.placeholder = "Type your question (Ctrl+Enter to submit)";
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      this.close();
      this.onSubmit(text);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
    });
    const ok = contentEl.createEl("button", { text: "Ask", cls: "mod-cta" });
    ok.onclick = submit;
    input.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class ResultModal extends Modal {
  private abort = new AbortController();
  private text = "";
  private out!: HTMLElement;
  private accept!: HTMLButtonElement;
  private copy!: HTMLButtonElement;

  constructor(
    app: App,
    private settings: LLMSettings,
    private title: string,
    private messages: Message[],
    private acceptLabel: string,
    private onAccept: (text: string) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    this.out = contentEl.createDiv({ cls: "lai-out" });

    const buttons = contentEl.createDiv({ cls: "lai-buttons" });
    buttons.createEl("button", { text: "Regenerate" }).onclick = () => void this.generate();
    this.copy = buttons.createEl("button", { text: "Copy" });
    this.copy.onclick = () => {
      void navigator.clipboard.writeText(this.text);
      new Notice("Copied.");
    };
    this.accept = buttons.createEl("button", { text: this.acceptLabel, cls: "mod-cta" });
    this.accept.onclick = () => {
      this.onAccept(this.text);
      this.close();
    };
    buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();

    void this.generate();
  }

  private async generate() {
    this.abort.abort();
    const signal = (this.abort = new AbortController()).signal;
    this.text = "";
    this.accept.disabled = this.copy.disabled = true;
    this.out.removeClass("is-error");
    this.out.setText("Waiting for model…");
    try {
      for await (const chunk of streamChat(this.settings, this.messages, signal)) {
        if (chunk.content) { this.text += chunk.content; this.out.setText(this.text); this.out.scrollTop = this.out.scrollHeight; }
      }
      this.text = this.text.trim();
      if (!this.text) throw new Error("Model returned no text.");
      this.out.setText(this.text);
      this.accept.disabled = this.copy.disabled = false;
    } catch (e) {
      if (!signal.aborted) {
        this.out.setText(`Error: ${errText(e)}`);
        this.out.addClass("is-error");
      }
    }
  }

  onClose() {
    this.abort.abort();
    this.contentEl.empty();
  }
}

export class DiffModal extends Modal {
  constructor(app: App, private title: string, private before: string, private after: string, private onApply: (apply: boolean) => void) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    const pre = contentEl.createEl("pre", { cls: "lai-diff" });
    for (const l of diffLines(this.before, this.after)) {
      if (l.op === "same") continue;
      pre.createDiv({ cls: `lai-diff-${l.op}`, text: (l.op === "add" ? "+ " : "- ") + l.text });
    }
    const buttons = contentEl.createDiv({ cls: "lai-review-actions" });
    buttons.createEl("button", { text: "Apply", cls: "mod-cta" }).onclick = () => { this.close(); this.onApply(true); };
    buttons.createEl("button", { text: "Cancel" }).onclick = () => { this.close(); this.onApply(false); };
  }
  onClose() { this.contentEl.empty(); }
}

export const CHAT_VIEW = "loom-chat";

// What the chat needs from the plugin: live settings plus a persisted conversation.
export interface ChatHost {
  settings: LLMSettings;
  history: Message[];
  search: (q: string) => Promise<{ path: string; text: string }[]>;
  save(): Promise<void>;
}

const NOTE_CHARS = 20000;

export class ChatView extends ItemView {
  private abort: AbortController | null = null;
  private attached: TFile[] = [];
  private includeCurrent = true;
  private log!: HTMLElement;
  private send!: HTMLButtonElement;
  private input!: HTMLTextAreaElement;
  private chips!: HTMLElement;
  // The chat panel steals focus, so remember the last note editor the user was in.
  private lastNote: MarkdownView | null = null;

  constructor(leaf: WorkspaceLeaf, private host: ChatHost) {
    super(leaf);
  }

  getViewType() { return CHAT_VIEW; }
  getDisplayText() { return "Loom chat"; }
  getIcon() { return "message-square"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("lai-chat");

    const header = root.createDiv({ cls: "lai-header" });
    header.createSpan({ cls: "lai-title", text: "Loom" });
    const models = header.createEl("select");
    void this.fillModels(models);
    models.onchange = () => {
      this.host.settings.model = models.value;
      (this.host.settings.modelByEndpoint ??= {})[this.host.settings.endpoint] = models.value;
      void this.host.save();
    };
    header.createEl("button", { text: "Save", attr: { "aria-label": "Save chat as a note" } }).onclick = () => void this.saveAsNote();
    header.createEl("button", { text: "New", attr: { "aria-label": "Start a new chat" } }).onclick = () => this.reset();

    this.chips = root.createDiv({ cls: "lai-ctx" });
    this.renderChips();

    this.log = root.createDiv({ cls: "lai-log" });

    const composer = root.createDiv({ cls: "lai-composer" });
    this.input = composer.createEl("textarea", { attr: { placeholder: "Message… (Enter to send, Shift+Enter for newline)" } });
    const actions = composer.createDiv({ cls: "lai-actions" });
    this.send = actions.createEl("button", { text: "Send", cls: "mod-cta" });
    this.send.onclick = () => (this.abort ? this.abort.abort() : void this.submit());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.abort) void this.submit();
      }
    });

    const track = (view: unknown) => { if (view instanceof MarkdownView) this.lastNote = view; };
    track(this.app.workspace.getActiveViewOfType(MarkdownView));
    this.app.workspace.iterateAllLeaves((l) => { if (!this.lastNote) track(l.view); });
    this.registerEvent(this.app.workspace.on("active-leaf-change", (l) => track(l?.view)));

    await this.renderHistory();
  }

  async onClose() {
    this.abort?.abort();
  }

  private async fillModels(select: HTMLSelectElement) {
    const current = this.host.settings.model;
    const models = (await listModels(this.host.settings)) ?? [];
    if (!models.includes(current)) models.unshift(current);
    for (const m of models) select.createEl("option", { text: m, value: m });
    select.value = current;
  }

  private renderChips() {
    this.chips.empty();
    const current = this.chips.createSpan({ cls: "lai-chip" + (this.includeCurrent ? " is-on" : ""), text: "Current note" });
    current.onclick = () => {
      this.includeCurrent = !this.includeCurrent;
      this.renderChips();
    };
    for (const f of this.attached) {
      const chip = this.chips.createSpan({ cls: "lai-chip is-on", text: `${f.basename} ✕` });
      chip.onclick = () => {
        this.attached = this.attached.filter((a) => a !== f);
        this.renderChips();
      };
    }
    this.chips.createSpan({ cls: "lai-chip", text: "+ Note" }).onclick = () =>
      new Picker(this.app, this.app.vault.getMarkdownFiles(), (f) => f.path, "Attach a note…", (f) => {
        if (!this.attached.includes(f)) this.attached.push(f);
        this.renderChips();
      }).open();
  }

  private reset() {
    this.abort?.abort();
    this.host.history.length = 0;
    void this.host.save();
    void this.renderHistory();
  }

  private async renderHistory() {
    this.log.empty();
    const { history } = this.host;
    if (!history.length) {
      const empty = this.log.createDiv({ cls: "lai-empty" });
      empty.createEl("h3", { text: "Chat with your model" });
      empty.createDiv({ text: "Attach notes with the chips above, or just ask anything." });
      return;
    }
    for (const [i, m] of history.entries()) {
      const body = this.bubble(m.role as "user" | "assistant", m.content, i === history.length - 1 && m.role === "assistant");
      if (m.role === "assistant") await this.renderMarkdown(body, m.content);
    }
  }

  // Builds one message row; assistant rows get Copy / Insert (and Regenerate when last).
  private bubble(role: "user" | "assistant", text: string, last = false, stats = "") {
    this.log.querySelector(".lai-empty")?.remove();
    const row = this.log.createDiv({ cls: `lai-msg is-${role}` });
    const body = row.createDiv({ cls: "lai-body", text });
    const meta = row.createDiv({ cls: "lai-meta" });
    if (role === "assistant") {
      const get = () => body.dataset.text ?? text;
      meta.createEl("button", { text: "Copy" }).onclick = () => {
        void navigator.clipboard.writeText(get());
        new Notice("Copied.");
      };
      meta.createEl("button", { text: "Insert into note" }).onclick = () => {
        const view = this.lastNote;
        if (!view?.file) return void new Notice("Open a note in the editor first.");
        view.editor.replaceSelection(get());
        new Notice(`Inserted into ${view.file.basename}.`);
      };
      if (last) meta.createEl("button", { text: "Regenerate" }).onclick = () => this.regenerate();
      if (stats) meta.createSpan({ text: stats });
    }
    this.log.scrollTop = this.log.scrollHeight;
    return body;
  }

  private async renderMarkdown(body: HTMLElement, text: string) {
    body.dataset.text = text;
    body.empty();
    body.removeClass("is-streaming");
    await MarkdownRenderer.render(this.app, text, body, this.app.workspace.getActiveFile()?.path ?? "", this);
  }

  private regenerate() {
    const { history } = this.host;
    if (this.abort || history.at(-1)?.role !== "assistant") return;
    history.pop();
    const question = history.pop()!.content;
    void this.renderHistory().then(() => this.submit(question));
  }

  private async context(): Promise<string> {
    const files = [...this.attached];
    const active = this.includeCurrent ? this.app.workspace.getActiveFile() : null;
    if (active && !files.includes(active)) files.unshift(active);
    let out = "";
    for (const f of files) {
      out += `\n\nNote "${f.basename}":\n${(await this.app.vault.cachedRead(f)).slice(0, NOTE_CHARS)}`;
    }
    return out;
  }

  private async submit(text?: string) {
    const question = (text ?? this.input.value).trim();
    if (!question || this.abort) return;
    this.input.value = "";

    const { history, settings, search } = this.host;
    const pending: PendingWrite[] = [];

    const system = (settings.systemPrompt || "You are a helpful assistant inside Obsidian.")
      + (await this.context())
      + (await this.relatedContext(question));

    const userMsg: Message = { role: "user", content: question };
    this.bubble("user", question);
    const body = this.bubble("assistant", "");
    body.addClasses(["is-streaming", "lai-typing"]);

    const ctrl = (this.abort = new AbortController());
    this.send.setText("Stop");
    const t0 = Date.now();
    let tokens = 0;
    let answer = "";

    const messages: Message[] = [{ role: "system", content: system }, ...history, userMsg];
    try {
      for (let turn = 0; turn < 8; turn++) {
        const toolCalls: ToolCall[] = [];
        answer = "";
        for await (const chunk of streamChat(settings, messages, ctrl.signal, TOOL_SPECS)) {
          if (chunk.content) {
            answer += chunk.content;
            tokens++;
            body.setText(answer);
            this.log.scrollTop = this.log.scrollHeight;
          }
          if (chunk.toolCalls) toolCalls.push(...chunk.toolCalls);
        }
        if (!toolCalls.length) break;
        messages.push({ role: "assistant", content: answer || "", tool_calls: toolCalls });
        for (const call of toolCalls) {
          const result = await executeTool(this.app, search, call, (w) => pending.push(w));
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        body.setText(toolCalls.length === 1 ? `…${toolCalls[0].function.name}…` : `…${toolCalls.length} tool calls…`);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        body.addClass("is-error");
        body.setText(`Error: ${errText(e)}`);
      }
    }
    this.abort = null;
    this.send.setText("Send");
    body.removeClass("lai-typing");
    if (!answer.trim()) {
      if (!body.hasClass("is-error")) body.parentElement?.remove();
      return;
    }
    history.push(userMsg, { role: "assistant", content: answer });
    void this.host.save();
    await this.renderHistory();
    const secs = (Date.now() - t0) / 1000;
    this.log.querySelector(".lai-msg:last-child .lai-meta")?.createSpan({ text: `${tokens} tokens · ${(tokens / secs).toFixed(1)} tok/s` });
    this.renderReview(pending);
  }

  // Feature 2: prepend the most relevant note excerpts to the chat context.
  private async relatedContext(question: string): Promise<string> {
    try {
      const hits = await this.host.search(question);
      if (!hits.length) return "";
      const active = this.includeCurrent ? this.app.workspace.getActiveFile() : null;
      const seen = new Set([...(active ? [active.path] : []), ...this.attached.map((f) => f.path)].map((p) => p.toLowerCase()));
      const top = hits.filter((h) => !seen.has(h.path.toLowerCase())).slice(0, 3);
      if (!top.length) return "";
      return "\n\nNotes that may be relevant (excerpts):\n" + top.map((h) => `- [[${h.path.replace(/\.md$/, "")}]]\n${h.text}`).join("\n\n");
    } catch {
      return ""; // no embedding server, or search failed — degrade gracefully
    }
  }

  // Render queued write changes as a diff with Apply / Discard buttons.
  private renderReview(writes: PendingWrite[]) {
    if (!writes.length) return;
    const box = this.log.createDiv({ cls: "lai-review" });
    box.createDiv({ cls: "lai-review-title", text: `Review ${writes.length} change${writes.length === 1 ? "" : "s"} before writing` });
    for (const w of writes) {
      const item = box.createDiv({ cls: "lai-review-item" });
      item.createDiv({ cls: "lai-review-path", text: `${w.kind === "create" ? "Create" : "Update"} ${w.path}` });
      const lines = diffLines(w.previous, w.content);
      const pre = item.createEl("pre", { cls: "lai-diff" });
      if (lines.length > 400) {
        const add = lines.filter((l) => l.op === "add").length;
        const del = lines.filter((l) => l.op === "del").length;
        pre.createDiv({ text: `Large change: ${del} lines removed, ${add} lines added.` });
      } else {
        for (const l of lines) {
          if (l.op === "same") continue;
          pre.createDiv({ cls: `lai-diff-${l.op}`, text: (l.op === "add" ? "+ " : "- ") + l.text });
        }
      }
    }
    const actions = box.createDiv({ cls: "lai-review-actions" });
    actions.createEl("button", { text: "Apply", cls: "mod-cta" }).onclick = () => {
      void applyWrites(this.app, writes).then(() => {
        box.remove();
        new Notice(`Wrote ${writes.length} note${writes.length === 1 ? "" : "s"}.`);
      });
    };
    actions.createEl("button", { text: "Discard" }).onclick = () => box.remove();
  }

  private async saveAsNote() {
    const { history } = this.host;
    if (!history.length) return void new Notice("Nothing to save.");
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
    const body = history.map((m) => `**${m.role === "user" ? "You" : "AI"}:**\n\n${m.content}`).join("\n\n---\n\n");
    const file = await this.app.vault.create(`Chat ${stamp}.md`, body + "\n");
    void this.app.workspace.getLeaf("tab").openFile(file);
  }
}

// First-run / reconnect wizard: pick a provider, test the connection, choose a model.
export class SetupModal extends Modal {
  constructor(app: App, private current: LLMSettings, private onSave: (patch: Partial<LLMSettings>) => void) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    const draft = { ...this.current };
    let models: string[] = [];
    contentEl.createEl("h3", { text: "Connect to a model" });
    contentEl.createEl("p", {
      text: "Any OpenAI-compatible server works. Pick a preset, test the connection, then choose a model.",
      cls: "setting-item-description",
    });

    let endpoint: HTMLInputElement;
    let providerNote: HTMLElement;
    new Setting(contentEl).setName("Provider").addDropdown((d) => {
      PROVIDERS.forEach((p) => d.addOption(p.id, p.label));
      d.addOption("custom", "Custom");
      d.setValue(PROVIDERS.find((p) => p.endpoint === draft.endpoint)?.id ?? "custom");
      d.onChange((id) => {
        const p = PROVIDERS.find((x) => x.id === id);
        if (!p) return;
        Object.assign(draft, { endpoint: p.endpoint, embedEndpoint: p.embedEndpoint, embedModel: p.embedModel });
        endpoint.value = p.endpoint;
        providerNote.setText(p.note ?? "");
      });
    });
    providerNote = contentEl.createEl("p", { cls: "setting-item-description" });
    new Setting(contentEl).setName("Endpoint").addText((t) => {
      endpoint = t.inputEl;
      t.setValue(draft.endpoint).onChange((v) => (draft.endpoint = v.trim()));
    });
    new Setting(contentEl)
      .setName("API key")
      .setDesc("Only needed for hosted providers. Stored in this plugin's data file.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(draft.apiKey).onChange((v) => (draft.apiKey = v.trim()));
      });

    const modelSetting = new Setting(contentEl).setName("Model").setDesc("Press Test connection to load models.");
    const setStatus = (text: string, state: "ok" | "error" | "" = "") => {
      modelSetting.setDesc(text);
      modelSetting.descEl.removeClasses(["lai-ok", "lai-error"]);
      if (state) modelSetting.descEl.addClass(`lai-${state}`);
    };
    const save = contentEl.createEl("button", { text: "Save", cls: "mod-cta" });
    save.disabled = true;
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Test connection").onClick(async () => {
        setStatus("Connecting…");
        const found = await listModels(draft);
        if (!found?.length) {
          setStatus("✗ Could not reach the server (check the endpoint, API key and that it is running).", "error");
          save.disabled = true;
          return;
        }
        models = found;
        if (!models.includes(draft.model)) draft.model = models[0];
        setStatus(`✓ Connected. ${models.length} model${models.length === 1 ? "" : "s"} found.`, "ok");
        modelSetting.controlEl.empty();
        modelSetting.addDropdown((d) => {
          models.forEach((m) => d.addOption(m, m));
          d.setValue(draft.model).onChange((v) => (draft.model = v));
        });
        save.disabled = false;
      }),
    );
    contentEl.appendChild(save);
    save.onclick = () => {
      const { endpoint: e, apiKey, model, embedEndpoint, embedModel } = draft;
      this.onSave({ endpoint: e, apiKey, model, embedEndpoint, embedModel });
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

export const RELATED_VIEW = "loom-related";

// Side panel listing notes similar to the one you are editing.
export class RelatedView extends ItemView {
  private timer = 0;
  private seq = 0;
  private shown = "";
  private list!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private search: VaultSearch) {
    super(leaf);
  }

  getViewType() { return RELATED_VIEW; }
  getDisplayText() { return "Related notes"; }
  getIcon() { return "network"; }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("lai-related");
    const header = this.contentEl.createDiv({ cls: "lai-header" });
    header.createSpan({ cls: "lai-title", text: "Related notes" });
    header.createEl("button", { text: "Refresh" }).onclick = () => void this.refresh(true);
    this.list = this.contentEl.createDiv({ cls: "lai-log" });

    const schedule = () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.refresh(), 700);
    };
    this.registerEvent(this.app.workspace.on("file-open", schedule));
    this.registerEvent(this.app.vault.on("modify", (f) => { if (f === this.app.workspace.getActiveFile()) this.shown = ""; }));
    schedule();
  }

  async onClose() {
    window.clearTimeout(this.timer);
  }

  private async refresh(force = false) {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;
    if (!force && file.path === this.shown) return;
    const seq = ++this.seq;
    this.list.empty();
    this.list.createDiv({ cls: "lai-empty", text: "Finding related notes…" });
    try {
      const hits = await this.search.related(file);
      if (seq !== this.seq) return;
      this.shown = file.path;
      this.list.empty();
      if (!hits.length) this.list.createDiv({ cls: "lai-empty", text: "No related notes found." });
      for (const h of hits) {
        const item = this.list.createDiv({ cls: "lai-related-item" });
        const name = h.path.replace(/\.md$/, "");
        item.createDiv({ cls: "lai-related-name", text: name.split("/").pop() });
        item.createDiv({ cls: "lai-related-meta", text: `${Math.round(h.score * 100)}% match · ${name}` });
        item.onclick = (e) => void this.app.workspace.openLinkText(h.path, "", e.ctrlKey || e.metaKey);
      }
    } catch (e) {
      if (seq === this.seq) {
        this.list.empty();
        this.list.createDiv({ cls: "lai-empty", text: `Error: ${errText(e)}` });
      }
    }
  }
}
