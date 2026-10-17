import type { App } from "obsidian";

export interface Action {
  id: string;
  name: string;
  system: string | ((app: App) => string);
  // replace: swap the selection (or the whole note when nothing is selected); below: insert after it
  mode: "replace" | "below";
  wrap?: (text: string) => string;
}

export const RULES =
  " Reply with only the result, no preamble or commentary. Keep the input's language, markdown formatting and [[wikilinks]].";

const callout = (text: string) =>
  "> [!summary]\n" + text.trim().split("\n").map((l) => "> " + l).join("\n");

export const BUILTIN: Action[] = [
  { id: "summarize", name: "Summarize", mode: "below", wrap: callout,
    system: "Summarize the text concisely in a few bullet points." + RULES },
  { id: "grammar", name: "Fix grammar and spelling", mode: "replace",
    system: "Fix grammar, spelling and punctuation. Do not change wording, tone or meaning beyond that." + RULES },
  { id: "shorter", name: "Rewrite shorter", mode: "replace",
    system: "Rewrite the text to be shorter while keeping the meaning." + RULES },
  { id: "formal", name: "Rewrite more formal", mode: "replace",
    system: "Rewrite the text in a more formal, professional tone." + RULES },
  { id: "casual", name: "Rewrite more casual", mode: "replace",
    system: "Rewrite the text in a more casual, conversational tone." + RULES },
  { id: "continue", name: "Continue writing", mode: "below",
    system: "Continue the text naturally in the same voice and style. Write only the continuation." + RULES },
  { id: "actions", name: "Extract action items", mode: "below",
    system: "Extract action items as a markdown task list using '- [ ] '. If there are none, say so in one line." + RULES },
  { id: "title", name: "Suggest titles", mode: "below",
    system: "Suggest 5 concise titles for this note as a numbered list." + RULES },
  { id: "tags", name: "Suggest tags", mode: "below",
    system: (app) => {
      // getTags is not in the public typings but is stable and returns { "#tag": count }.
      const existing = Object.keys((app.metadataCache as unknown as { getTags?: () => object }).getTags?.() ?? {});
      return "Suggest up to 5 tags for this note as one line of #hashtags separated by spaces. " +
        (existing.length ? "Prefer these existing tags when they fit: " + existing.slice(0, 200).join(" ") + ". " : "") +
        RULES;
    } },
  { id: "links", name: "Suggest links to other notes", mode: "below",
    system: (app) =>
      "Pick up to 8 notes from the list that this text should link to. Reply with a markdown bullet list of [[wikilinks]] using only titles from the list." +
      RULES + "\n\nNotes:\n" + app.vault.getMarkdownFiles().filter((f) => f !== app.workspace.getActiveFile()).slice(0, 800).map((f) => f.basename).join("\n") },
];

// Template variables available in custom actions and prompt-library notes.
export function expandVars(text: string, vars: Record<string, string>) {
  let usedInput = false;
  const out = text.replace(/\{\{(selection|note|title|date)\}\}/g, (_, k: string) => {
    if (k === "selection" || k === "note") usedInput = true;
    return vars[k];
  });
  return { text: out, usedInput };
}

export const ASK_NOTE: Action = {
  id: "ask", name: "Ask about this note", mode: "below",
  system: "Answer the user's question using only the note below. Be concise. Keep [[wikilinks]] and markdown formatting.",
};

export const LANGUAGES = [
  "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch",
  "Russian", "Chinese", "Japanese", "Korean", "Arabic", "Hindi",
];

export const translateTo = (lang: string): Action => ({
  id: `translate-${lang}`, name: `Translate to ${lang}`, mode: "replace",
  system: `Translate the text to ${lang}.` + RULES,
});
