import {
  App,
  Editor,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { ASK_NOTE, Action, BUILTIN, LANGUAGES, RULES, translateTo } from "./actions";
import { LLMSettings, Message, listModels, streamChat } from "./llm";
import { CHAT_VIEW, ChatView, Picker, PromptModal, ResultModal } from "./ui";
import { VaultSearch, askVault, digestMessages } from "./vault";

interface Settings extends LLMSettings {
  // Stream results straight into the note instead of previewing them in a modal (undo with Ctrl+Z).
  applyDirectly: boolean;
  customActions: string;
  // Persisted chat-panel conversation.
  chat: Message[];
}

const DEFAULTS: Settings = {
  endpoint: "http://127.0.0.1:8080",
  model: "qwen3.8-27b-ridge",
  thinking: false,
  temperature: 0.7,
  systemPrompt: "You are a helpful, concise assistant inside the user's Obsidian vault. Use markdown and [[wikilinks]] where useful.",
  embedEndpoint: "http://127.0.0.1:1234",
  embedModel: "text-embedding-nomic-embed-text-v1.5",
  applyDirectly: false,
  customActions: "",
  chat: [],
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default class LocalAIPlugin extends Plugin {
  settings!: Settings;
  private search!: VaultSearch;
  private streaming: AbortController | null = null;

  async onload() {
    this.settings = { ...DEFAULTS, ...(await this.loadData()) };
    this.search = new VaultSearch(this.app, this.settings, this.manifest.dir!);
    this.addSettingTab(new SettingsTab(this.app, this));
    this.registerView(CHAT_VIEW, (leaf) =>
      new ChatView(leaf, {
        settings: this.settings,
        history: this.settings.chat,
        save: () => this.saveData(this.settings),
      }));
    this.addRibbonIcon("message-square", "Local AI chat", () => void this.openChat());
    this.initStatusBar();

    for (const action of BUILTIN) {
      this.addCommand({ id: action.id, name: action.name, editorCallback: (editor) => this.run(editor, action) });
    }
    this.addCommand({
      id: "pick",
      name: "Run action…",
      editorCallback: (editor) => this.pickAction(editor),
    });
    this.addCommand({
      id: "translate",
      name: "Translate…",
      editorCallback: (editor) =>
        new Picker(this.app, LANGUAGES, (l) => l, "Translate to…", (l) => this.run(editor, translateTo(l))).open(),
    });
    this.addCommand({
      id: "ask-note",
      name: ASK_NOTE.name,
      editorCallback: (editor) =>
        new PromptModal(this.app, ASK_NOTE.name, (q) => this.run(editor, ASK_NOTE, q)).open(),
    });
    this.addCommand({
      id: "stop",
      name: "Stop generation",
      callback: () => this.streaming?.abort(),
    });
    this.addCommand({ id: "chat", name: "Open chat", callback: () => void this.openChat() });
    this.addCommand({
      id: "ask-vault",
      name: "Ask your vault",
      callback: () => new PromptModal(this.app, "Ask your vault", (q) => void this.askVault(q)).open(),
    });
    this.addCommand({
      id: "reindex",
      name: "Rebuild vault index",
      callback: () => this.search.reset().then(() => new Notice("Vault index rebuilt."), (e) => new Notice(errText(e))),
    });
    this.addCommand({
      id: "digest",
      name: "Digest recent notes…",
      callback: () =>
        new Picker(this.app, [1, 7], (d) => (d === 1 ? "Last day" : "Last 7 days"), "Digest period…",
          (d) => void this.digest(d)).open(),
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) =>
        menu.addItem((item) =>
          item.setTitle("Local AI: run action…").setIcon("sparkles").onClick(() => this.pickAction(editor)),
        ),
      ),
    );
  }

  // Status bar: server health + active model; click to switch model.
  private initStatusBar() {
    const el = this.addStatusBarItem();
    el.addClass("lai-status");
    const refresh = async () => {
      const up = (await listModels(this.settings.endpoint)) !== null;
      el.empty();
      el.createSpan({ cls: "lai-dot", text: "●" });
      el.appendText(` ${this.settings.model}`);
      el.toggleClass("is-up", up);
      el.toggleClass("is-down", !up);
      el.setAttribute("aria-label", up ? "Local AI server is up. Click to switch model." : "Local AI server unreachable.");
    };
    el.onclick = async () => {
      const models = await listModels(this.settings.endpoint);
      if (!models) return void new Notice("Local AI server unreachable.");
      new Picker(this.app, models, (m) => m, "Switch model…", async (m) => {
        this.settings.model = m;
        await this.saveData(this.settings);
        void refresh();
      }).open();
    };
    void refresh();
    this.registerInterval(window.setInterval(refresh, 30000));
  }

  onunload() {
    this.streaming?.abort();
  }

  // Custom actions live in settings as "Name: instruction" lines, so edits apply without a reload.
  private allActions(): Action[] {
    const custom = this.settings.customActions
      .split("\n")
      .map((l) => l.match(/^\s*([^:]+):\s*(.+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m): Action => ({
        id: `custom-${m[1].trim()}`,
        name: m[1].trim(),
        mode: "replace",
        system: m[2].trim() + RULES,
      }));
    return [...BUILTIN, ...custom];
  }

  private pickAction(editor: Editor) {
    new Picker(this.app, this.allActions(), (a) => a.name, "Run AI action…", (a) => this.run(editor, a)).open();
  }

  private async openChat() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CHAT_VIEW)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: CHAT_VIEW, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  private async askVault(question: string) {
    const notice = new Notice("Searching vault…", 0);
    try {
      const messages = await askVault(this.search, question);
      notice.hide();
      const editor = this.app.workspace.activeEditor?.editor;
      new ResultModal(this.app, this.settings, "Ask your vault", messages,
        editor ? "Insert at cursor" : "Copy",
        (text) => {
          if (editor) editor.replaceSelection(text);
          else void navigator.clipboard.writeText(text);
        }).open();
    } catch (e) {
      notice.hide();
      new Notice(`Vault search failed: ${errText(e)}`);
    }
  }

  private async digest(days: number) {
    try {
      const messages = await digestMessages(this.app, days);
      new ResultModal(this.app, this.settings, "Digest", messages, "Save as note", async (text) => {
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
        const file = await this.app.vault.create(`Digest ${stamp}.md`, text + "\n");
        void this.app.workspace.getLeaf(false).openFile(file as TFile);
      }).open();
    } catch (e) {
      new Notice(errText(e));
    }
  }

  // With nothing selected the whole note is the input (and, for "replace", the target).
  private run(editor: Editor, action: Action, question?: string) {
    const selection = editor.getSelection();
    const input = selection || editor.getValue();
    if (!input.trim()) {
      new Notice("Nothing to process.");
      return;
    }
    const from = selection ? editor.getCursor("from") : { line: 0, ch: 0 };
    const to = selection ? editor.getCursor("to") : editor.offsetToPos(editor.getValue().length);

    const system = typeof action.system === "function" ? action.system(this.app) : action.system;
    const messages: Message[] = question !== undefined
      ? [{ role: "system", content: `${system}\n\nNote:\n${input}` }, { role: "user", content: question }]
      : [{ role: "system", content: system }, { role: "user", content: input }];

    const format = (text: string) => {
      const out = action.wrap ? action.wrap(text) : text;
      return action.mode === "replace" ? out : "\n\n" + out + "\n";
    };
    const start = action.mode === "replace" ? from : to;

    if (this.settings.applyDirectly) {
      void this.stream(editor, messages, editor.posToOffset(start), editor.posToOffset(to), format);
      return;
    }
    new ResultModal(this.app, this.settings, action.name, messages,
      action.mode === "replace" ? "Replace" : "Insert below",
      (text) => editor.replaceRange(format(text), start, to)).open();
  }

  // Rewrites the region [start, end) on every chunk; nothing is touched until the first token arrives.
  private async stream(
    editor: Editor,
    messages: Message[],
    start: number,
    end: number,
    format: (text: string) => string,
  ) {
    this.streaming?.abort();
    const ctrl = (this.streaming = new AbortController());
    const notice = new Notice("Generating… (command: Stop generation; Ctrl+Z undoes)", 0);
    let text = "";
    try {
      for await (const chunk of streamChat(this.settings, messages, ctrl.signal)) {
        text += chunk;
        const out = format(text.trim());
        editor.replaceRange(out, editor.offsetToPos(start), editor.offsetToPos(end));
        end = start + out.length;
      }
    } catch (e) {
      if (!ctrl.signal.aborted) new Notice(`Error: ${errText(e)}`);
    } finally {
      notice.hide();
      if (this.streaming === ctrl) this.streaming = null;
    }
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: LocalAIPlugin) {
    super(app, plugin);
  }

  async display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveData(s);
    containerEl.empty();

    new Setting(containerEl)
      .setName("LLM endpoint")
      .setDesc("OpenAI-compatible server (llama.cpp ridge).")
      .addText((t) => t.setValue(s.endpoint).onChange(async (v) => { s.endpoint = v.trim(); await save(); }))
      .addButton((b) => b.setButtonText("Refresh models").onClick(() => this.display()));

    const models = (await listModels(s.endpoint)) ?? [];

    const model = new Setting(containerEl).setName("Model");
    if (models.length) {
      if (!models.includes(s.model)) models.unshift(s.model);
      model.addDropdown((d) => {
        models.forEach((m) => d.addOption(m, m));
        d.setValue(s.model).onChange(async (v) => { s.model = v; await save(); });
      });
    } else {
      model.setDesc("Could not list models from the server; enter a name manually.");
      model.addText((t) => t.setValue(s.model).onChange(async (v) => { s.model = v.trim(); await save(); }));
    }

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Lower is more precise, higher is more creative.")
      .addSlider((sl) => sl.setLimits(0, 1.5, 0.05).setValue(s.temperature).setDynamicTooltip()
        .onChange(async (v) => { s.temperature = v; await save(); }));

    new Setting(containerEl)
      .setName("Chat persona")
      .setDesc("System prompt for the chat panel.")
      .addTextArea((t) => {
        t.setValue(s.systemPrompt).onChange(async (v) => { s.systemPrompt = v; await save(); });
        t.inputEl.rows = 4;
        t.inputEl.addClass("lai-wide");
      });

    new Setting(containerEl)
      .setName("Thinking")
      .setDesc("Let the model reason before answering. Better on hard questions, but much slower to start.")
      .addToggle((t) => t.setValue(s.thinking).onChange(async (v) => { s.thinking = v; await save(); }));

    new Setting(containerEl)
      .setName("Apply results directly")
      .setDesc("Stream results into the note without a preview window. Ctrl+Z undoes them.")
      .addToggle((t) => t.setValue(s.applyDirectly).onChange(async (v) => { s.applyDirectly = v; await save(); }));

    new Setting(containerEl)
      .setName("Embedding endpoint")
      .setDesc("Used by \"Ask your vault\".")
      .addText((t) => t.setValue(s.embedEndpoint).onChange(async (v) => { s.embedEndpoint = v.trim(); await save(); }));

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc("Changing it rebuilds the vault index on the next search.")
      .addText((t) => t.setValue(s.embedModel).onChange(async (v) => { s.embedModel = v.trim(); await save(); }));

    new Setting(containerEl)
      .setName("Custom actions")
      .setDesc('One per line, as "Name: instruction". They appear under the "Run action…" command.')
      .addTextArea((t) => {
        t.setPlaceholder("Explain like I'm five: Explain the text in very simple terms.")
          .setValue(s.customActions)
          .onChange(async (v) => { s.customActions = v; await save(); });
        t.inputEl.rows = 6;
        t.inputEl.addClass("lai-wide");
      });
  }
}
