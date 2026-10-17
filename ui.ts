import { App, FuzzySuggestModal, ItemView, MarkdownRenderer, MarkdownView, Modal, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { LLMSettings, Message, listModels, streamChat } from "./llm";

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
        this.text += chunk;
        this.out.setText(this.text);
        this.out.scrollTop = this.out.scrollHeight;
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

export const CHAT_VIEW = "local-ai-chat";

// What the chat needs from the plugin: live settings plus a persisted conversation.
export interface ChatHost {
  settings: LLMSettings;
  history: Message[];
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
  getDisplayText() { return "Local AI chat"; }
  getIcon() { return "message-square"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("lai-chat");

    const header = root.createDiv({ cls: "lai-header" });
    header.createSpan({ cls: "lai-title", text: "Local AI" });
    const models = header.createEl("select");
    void this.fillModels(models);
    models.onchange = () => {
      this.host.settings.model = models.value;
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
    const models = (await listModels(this.host.settings.endpoint)) ?? [];
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
      empty.createEl("h3", { text: "Chat with your local model" });
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

    const { history, settings } = this.host;
    const system = (settings.systemPrompt || "You are a helpful assistant inside Obsidian.") + (await this.context());
    const userMsg: Message = { role: "user", content: question };
    this.bubble("user", question);
    const body = this.bubble("assistant", "");
    body.addClasses(["is-streaming", "lai-typing"]);

    const ctrl = (this.abort = new AbortController());
    this.send.setText("Stop");
    const t0 = Date.now();
    let tokens = 0;
    let answer = "";
    try {
      for await (const chunk of streamChat(settings, [{ role: "system", content: system }, ...history, userMsg], ctrl.signal)) {
        answer += chunk;
        tokens++;
        body.setText(answer);
        this.log.scrollTop = this.log.scrollHeight;
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
