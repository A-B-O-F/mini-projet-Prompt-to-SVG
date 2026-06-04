import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;
const OLLAMA_BASE = 'http://localhost:11434';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, 'public')));

// List available Ollama models
app.get('/api/models', async (req, res) => {
  try {
    const response = await fetch(`${OLLAMA_BASE}/api/tags`);
    const data = await response.json();
    const models = data.models?.map(m => m.name) ?? [];
    res.json({ models });
  } catch {
    res.status(503).json({ error: 'Impossible de contacter Ollama. Assurez-vous qu\'Ollama est lancé.' });
  }
});

function extractSVG(text) {
  // Try markdown code block first (```svg or ```xml or ```)
  const fenced = text.match(/```(?:svg|xml|html)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = fenced[1].trim();
    if (inner.startsWith('<svg')) return inner;
  }
  // Direct SVG tag
  const direct = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (direct) return direct[0].trim();

  return null;
}

const OLLAMA_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

// onChunk(token, count, accumulated) is called for every Ollama token
async function callOllama(model, prompt, signal, onChunk) {
  const start = Date.now();
  // Always enforce a 3-minute ceiling, combined with any caller-provided signal
  const effectiveSignal = AbortSignal.any(
    [signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS)].filter(Boolean)
  );
  const response = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: effectiveSignal,
    body: JSON.stringify({
      model,
      prompt,
      stream: true,
      options: { temperature: 0.6, num_predict: 2048 }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama: ${response.status} – ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buf = '';
  let tokenCount = 0;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.response) {
          fullText += obj.response;
          tokenCount++;
          onChunk?.(obj.response, tokenCount, fullText);
        }
        if (obj.done) { await reader.cancel(); break outer; }
      } catch { /* malformed line */ }
    }
  }

  return { text: fullText, elapsed: Date.now() - start, tokens: tokenCount };
}

function buildGenerationPrompt(description) {
  return `Generate a valid SVG image for the following description: "${description}"

STRICT RULES:
- Output ONLY the raw SVG code
- The response MUST start with <svg and end with </svg>
- Use viewBox="0 0 100 100" by default
- Keep shapes simple, clean and recognizable
- Do NOT include any explanation, markdown code fences, or extra text
- Do NOT wrap in \`\`\` or any other markup

<svg`;
}

function buildVariantPrompt(svg, changes) {
  return `Here is an existing SVG:
${svg}

Apply the following modifications: ${changes}

STRICT RULES:
- Output ONLY the modified SVG code
- The response MUST start with <svg and end with </svg>
- Preserve the same viewBox and overall structure
- Only apply the requested changes
- Do NOT include any explanation, markdown, or code fences

<svg`;
}

// Generate SVG — SSE with per-token progress events
app.post('/api/generate', async (req, res) => {
  const { prompt, model } = req.body;
  if (!prompt?.trim() || !model?.trim()) {
    return res.status(400).json({ error: 'Les champs "prompt" et "model" sont requis.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const send = obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  try {
    let pending = 0;
    const { text, elapsed, tokens } = await callOllama(
      model, buildGenerationPrompt(prompt), controller.signal,
      (_tok, count, accumulated) => {
        pending++;
        if (pending >= 3) {   // throttle: one SSE event every 3 tokens
          pending = 0;
          send({ type: 'progress', tokens: count, partial: accumulated });
        }
      }
    );

    const svg = extractSVG(text) ?? extractSVG('<svg' + text);
    send({ type: 'done', svg, elapsed, tokens, raw: svg ? undefined : text });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      send({ type: 'error', error: 'Délai dépassé (3 min). Essayez un modèle plus léger.' });
    } else if (err.name !== 'AbortError') {
      send({ type: 'error', error: err.message });
    }
  }

  if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
});

// Generate a variant of an existing SVG
app.post('/api/variant', async (req, res) => {
  const { svg, model, changes } = req.body;
  if (!svg?.trim() || !model?.trim() || !changes?.trim()) {
    return res.status(400).json({ error: 'Les champs "svg", "model" et "changes" sont requis.' });
  }

  try {
    const { text, elapsed } = await callOllama(model, buildVariantPrompt(svg, changes));
    const newSvg = extractSVG(text) ?? extractSVG('<svg' + text);

    if (!newSvg) {
      return res.json({ svg: null, raw: text, elapsed, error: 'Aucun SVG détecté dans la réponse.' });
    }
    res.json({ svg: newSvg, elapsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Compare multiple models — sequential, SSE streaming, cancellable
app.post('/api/compare', async (req, res) => {
  const { prompt, models } = req.body;
  if (!prompt?.trim() || !Array.isArray(models) || models.length === 0) {
    return res.status(400).json({ error: 'Les champs "prompt" et "models" sont requis.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Abort everything if the browser closes/refreshes
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const send = obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const generationPrompt = buildGenerationPrompt(prompt);

  for (const model of models) {
    if (controller.signal.aborted) break;
    send({ type: 'start', model });
    try {
      let pending = 0;
      const { text, elapsed, tokens } = await callOllama(
        model, generationPrompt, controller.signal,
        (_tok, count) => {
          pending++;
          if (pending >= 5) { pending = 0; send({ type: 'progress', model, tokens: count }); }
        }
      );
      const svg = extractSVG(text) ?? extractSVG('<svg' + text);
      send({ type: 'result', model, svg, elapsed, tokens });
    } catch (err) {
      if (err.name === 'AbortError') break;
      send({ type: 'result', model, svg: null, elapsed: 0, tokens: 0, error: err.message });
    }
  }

  if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
});

app.listen(PORT, () => {
  console.log(`\n  Prompt → SVG  running at  http://localhost:${PORT}\n`);
});
