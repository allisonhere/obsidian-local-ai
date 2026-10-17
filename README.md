# Local AI Assistant for Obsidian

Summarize, rewrite, translate, chat with, and search your notes using a local OpenAI-compatible LLM server (built for llama.cpp).

## Features
- Editor actions: summarize, fix grammar, rewrite, continue, action items, titles, tags, link suggestions, translate, ask about this note, plus custom actions
- Chat side panel with attachable notes, persistent history, and model switcher
- "Ask your vault": semantic search over your notes using an embeddings server
- Digest of recently edited notes
- Status bar server indicator

## Build
```
npm install
npm run build
```
Link this folder to `<vault>/.obsidian/plugins/local-ai-assistant`, then enable it in Obsidian.

## Setup
Set the LLM endpoint (default `http://127.0.0.1:8080`) and embedding endpoint (default `http://127.0.0.1:1234`) in the plugin settings.
