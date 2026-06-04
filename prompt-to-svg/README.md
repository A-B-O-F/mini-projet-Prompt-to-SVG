# Prompt → SVG

Generate SVG icons and illustrations from a text description using local AI models — no internet, no external API, no asset hunting.

> Mini-project for the **FontIA** course · MMI 3rd year · Semester 6

---

## What it does

Type a description, pick a model, get an SVG. That's it.

- **Simple mode** — one prompt → one SVG, with real-time token streaming and a live terminal log
- **Compare mode** — same prompt sent to multiple models sequentially; results appear one by one as each finishes
- **Variant mode** — ask the AI to mutate the current SVG (change colors, stroke weight, style…)
- **Cancel / timeout** — abort at any time; hard 3-minute limit per generation

---

## Local AI models (via Ollama)

All inference runs locally through [Ollama](https://ollama.ai). No data leaves your machine.

| Model | Strength |
|---|---|
| `qwen2.5-coder:7b` | Best SVG structure, follows constraints reliably |
| `mistral:7b` | Fast, consistent, clean output |
| `qwen3.6:latest` | Strong reasoning, tends to be more verbose |
| `llama3:latest` | Good generalist fallback |

The compare mode is the main way to observe how different model architectures handle the same structured-code generation task.

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22 + Express 5 |
| Streaming | Server-Sent Events (SSE) — sequential in compare mode to avoid Ollama memory contention |
| Frontend | Vanilla JS · CSS (dark comic/manga theme · Bangers font) |
| AI runtime | Ollama `stream: true` with AbortController cancellation |

---

## Setup

```bash
# 1. Install and start Ollama, then pull at least one model
ollama pull qwen2.5-coder:7b
ollama pull mistral:7b

# 2. Install Node dependencies
npm install

# 3. Start
npm start
# → http://localhost:3000
```

Requires **Node.js ≥ 20** and **Ollama** running on `localhost:11434`.

---

## Built with AI assistance

The entire codebase — architecture, SSE streaming, CSS animations, prompt engineering, and debugging — was written with **[Claude Sonnet](https://claude.ai/code)** (Anthropic) as an interactive coding assistant inside VS Code via Claude Code.

The project itself is also *about* AI: it compares how local language models handle a constrained generation task (valid SVG code), making the tooling and the subject matter the same thing.

---

*Prompt → SVG · FontIA · MMI · 2025–2026*
