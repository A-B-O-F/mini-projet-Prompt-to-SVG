/* ===================================================
   Prompt → SVG  |  Frontend Logic
   =================================================== */

// ── State ────────────────────────────────────────────
let currentSVG = '';
let currentMode = 'simple'; // 'simple' | 'compare'
let allModels = [];
let selectedModel = '';
let genController = null;     // AbortController for current generate/variant
let compareController = null; // AbortController for current compare

// ── DOM refs ─────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Init ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadModels();
  bindEvents();
});

async function loadModels() {
  try {
    const { models } = await api('/api/models');
    allModels = models;

    // Simple mode — button group
    const group = $('modelBtns');
    if (!models.length) {
      group.innerHTML = '<span class="model-loading">Aucun modèle trouvé</span>';
      return;
    }
    group.innerHTML = models.map((m, i) => `
      <button type="button"
        class="model-btn${i === 0 ? ' active' : ''}"
        data-model="${m}"
        onclick="selectModel(this)">
        ${m}
      </button>
    `).join('');
    selectedModel = models[0];

    // Compare mode — checkboxes (unchanged)
    $('modelCheckboxes').innerHTML = models.map(m => `
      <label class="checkbox-label" id="lbl-${CSS.escape(m)}">
        <input type="checkbox" value="${m}" onchange="toggleCheckbox(this)">
        ${m}
      </label>
    `).join('');
  } catch {
    $('modelBtns').innerHTML = '<span class="model-loading model-loading--error">Ollama introuvable</span>';
    showError('Impossible de contacter Ollama. Lancez Ollama et rechargez la page.', '');
  }
}

function selectModel(btn) {
  document.querySelectorAll('#modelBtns .model-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  selectedModel = btn.dataset.model;
}

function toggleCheckbox(input) {
  const lbl = input.closest('.checkbox-label');
  lbl.classList.toggle('checked', input.checked);
}

function bindEvents() {
  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  $('generateBtn').addEventListener('click', onGenerate);
  $('compareBtn').addEventListener('click', onCompare);
  $('variantToggleBtn').addEventListener('click', toggleVariantPanel);
  $('applyVariantBtn').addEventListener('click', onVariant);

  // Enter key on main prompt triggers generate/compare
  $('prompt').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      currentMode === 'simple' ? onGenerate() : onCompare();
    }
  });

  // Enter key on variant input
  $('variantPrompt').addEventListener('keydown', e => {
    if (e.key === 'Enter') onVariant();
  });
}

// ── Mode switching ────────────────────────────────────
function switchMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

  $('simpleControls').classList.toggle('hidden', mode !== 'simple');
  $('compareControls').classList.toggle('hidden', mode !== 'compare');
  $('simpleResult').classList.add('hidden');
  $('compareResult').classList.add('hidden');
  $('variantPanel').classList.add('hidden');
}

// ── Generate (simple mode) — SSE streaming ───────────
async function onGenerate() {
  const prompt = $('prompt').value.trim();
  const model  = selectedModel;
  if (!prompt) return alert('Veuillez entrer une description.');
  if (!model)  return alert('Aucun modèle disponible.');

  setLoading(true);
  hideError();
  startProgress(model);
  $('simpleResult').classList.remove('hidden');
  $('resultGrid').classList.add('hidden');

  genController = new AbortController();
  const t0 = Date.now();
  const timer = setInterval(() => setElapsed(Date.now() - t0), 100);

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model }),
      signal: genController.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') break;

        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'progress') {
            setTokens(evt.tokens);
            appendLog(evt.partial);
          } else if (evt.type === 'done') {
            finalizeProgress(evt.tokens, evt.elapsed);
            if (evt.svg) {
              displayResult(evt.svg, model, evt.elapsed);
              $('variantToggleBtn').disabled = false;
            } else {
              showError('Aucun SVG détecté dans la réponse.', evt.raw ?? '');
            }
          } else if (evt.type === 'error') {
            showError(evt.error, '');
          }
        } catch { /* skip malformed */ }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') showError(err.message, '');
  } finally {
    clearInterval(timer);
    setLoading(false);
    genController = null;
  }
}

function cancelGenerate() {
  genController?.abort();
  // UI reset is handled by setLoading(false) in the finally block above
}

// ── Variant ───────────────────────────────────────────
function toggleVariantPanel() {
  const panel = $('variantPanel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    $('variantPrompt').focus();
  }
}

async function onVariant() {
  if (!currentSVG) return alert('Générez d\'abord un SVG.');
  const changes = $('variantPrompt').value.trim();
  const model   = selectedModel;
  if (!changes) return alert('Décrivez les modifications à apporter.');

  setLoading(true, 'Génération de la variante…');
  hideError();

  try {
    const data = await api('/api/variant', { svg: currentSVG, model, changes });
    if (data.error || !data.svg) {
      showError(data.error ?? 'Aucun SVG dans la réponse.', data.raw ?? '');
    } else {
      displayResult(data.svg, model, data.elapsed);
    }
  } catch (err) {
    showError(err.message, '');
  } finally {
    setLoading(false);
  }
}

// ── Compare (compare mode) — sequential SSE ──────────
async function onCompare() {
  const prompt = $('prompt').value.trim();
  const models = [...document.querySelectorAll('#modelCheckboxes input:checked')].map(i => i.value);

  if (!prompt)           return alert('Veuillez entrer une description.');
  if (!models.length)    return alert('Sélectionnez au moins un modèle.');

  // Show section + loading bar
  $('compareResult').classList.remove('hidden');
  const loadingBar = $('compareLoadingBar');
  loadingBar.classList.remove('hidden');
  setCompareStatus(`Modèle 1 / ${models.length} en cours…`);

  // Build skeleton grid immediately so user sees all slots
  const container = $('compareGrid');
  container.innerHTML = '';
  container.classList.remove('hidden');

  const grid = document.createElement('div');
  grid.className = 'compare-grid-inner';
  container.appendChild(grid);

  const cardMap = {};
  models.forEach((model, i) => {
    const card = makeSkeletonCard(model, i, models.length);
    grid.appendChild(card);
    cardMap[model] = card;
  });

  compareController = new AbortController();

  try {
    const response = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, models }),
      signal: compareController.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = 0;

    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by \n\n
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') break;

        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'start') {
            activateSkeletonCard(cardMap[evt.model]);
          } else if (evt.type === 'progress') {
            updateCardTokens(cardMap[evt.model], evt.tokens);
          } else if (evt.type === 'result') {
            done++;
            fillCompareCard(cardMap[evt.model], evt);
            setCompareStatus(
              done < models.length
                ? `Modèle ${done + 1} / ${models.length} en cours…`
                : `${models.length} / ${models.length} terminés !`
            );
          }
        } catch { /* malformed JSON — skip */ }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      grid.innerHTML = `<div class="panel error-panel">
        <strong class="error-title">⚠ ERREUR !</strong>
        <p>${err.message}</p>
      </div>`;
    }
  } finally {
    loadingBar.classList.add('hidden');
    compareController = null;
  }
}

function cancelCompare() {
  compareController?.abort();
}

function setCompareStatus(text) {
  const span = $('compareLoadingBar')?.querySelector('.compare-status-text');
  if (span) span.textContent = text;
}

// Skeleton card shown before a model starts
function makeSkeletonCard(model, index, total) {
  const card = document.createElement('div');
  card.className = 'compare-card compare-card--waiting';
  card.innerHTML = `
    <div class="compare-header">
      <span class="compare-model-name">${model}</span>
      <span class="compare-queue-num">${index + 1} / ${total}</span>
    </div>
    <div class="compare-preview">
      <div class="skeleton-body">
        <div class="skeleton-spinner"></div>
        <span class="skeleton-label">En attente…</span>
      </div>
    </div>
  `;
  return card;
}

// Mark a card as the currently running one
function activateSkeletonCard(card) {
  if (!card) return;
  card.classList.replace('compare-card--waiting', 'compare-card--active');
  const label = card.querySelector('.skeleton-label');
  if (label) label.textContent = 'Génération…';
  // Inject token counter into the card header
  const header = card.querySelector('.compare-header');
  if (header && !header.querySelector('.card-token-count')) {
    const ctr = document.createElement('span');
    ctr.className = 'card-token-count';
    ctr.textContent = '0 tok';
    header.appendChild(ctr);
  }
}

function updateCardTokens(card, tokens) {
  if (!card) return;
  const ctr = card.querySelector('.card-token-count');
  if (ctr) ctr.textContent = `${tokens} tok`;
}

// Replace skeleton with real result
function fillCompareCard(card, item) {
  if (!card) return;
  card.classList.remove('compare-card--waiting', 'compare-card--active');
  if (item.error) card.classList.add('has-error');

  const elapsed = item.elapsed ? `⏱ ${(item.elapsed / 1000).toFixed(1)}s` : '—';
  const emptyPreview = `<span class="skeleton-label">AUCUN SVG</span>`;

  card.innerHTML = `
    <div class="compare-header">
      <span class="compare-model-name">${item.model}</span>
      <span class="compare-timing">${elapsed}</span>
    </div>
    <div class="compare-preview">${item.svg ?? emptyPreview}</div>
    ${item.error ? `<div class="compare-error">⚠ ${item.error}</div>` : ''}
    ${item.svg ? `
      <div class="compare-actions">
        <button type="button" class="compare-code-toggle" onclick="toggleCode(this)">Voir le code</button>
        <button type="button" class="btn btn-sm btn-outline" onclick="copyText(${JSON.stringify(item.svg)})">📋 Copier</button>
        <button type="button" class="btn btn-sm btn-use" onclick="useResult(${JSON.stringify(item.svg)}, ${JSON.stringify(item.model)})">✦ Utiliser</button>
      </div>
      <pre class="compare-code-block">${escHtml(item.svg)}</pre>
    ` : ''}
  `;
}

// ── Progress helpers (simple mode) ───────────────────
function startProgress(model) {
  $('genProgress').classList.remove('hidden');
  $('genModelTag').textContent = model;
  $('genTokens').textContent = '0 tokens';
  $('genElapsed').textContent = '0.0s';
  $('genLog').textContent = '';
  $('progressShimmer').classList.add('running');
}

function setTokens(n) {
  $('genTokens').textContent = `${n} tokens`;
}

function setElapsed(ms) {
  $('genElapsed').textContent = `${(ms / 1000).toFixed(1)}s`;
}

function appendLog(partial) {
  const log = $('genLog');
  // Keep only the last 400 chars for performance
  log.textContent = partial.length > 400 ? '…' + partial.slice(-400) : partial;
  log.scrollTop = log.scrollHeight;
}

function finalizeProgress(tokens, elapsed) {
  setTokens(tokens);
  setElapsed(elapsed);
  $('progressShimmer').classList.remove('running');
  $('progressShimmer').classList.add('done');
}

// ── Display helpers ───────────────────────────────────
function displayResult(svg, model, elapsed) {
  currentSVG = svg;

  $('svgPreview').innerHTML = svg;
  $('codeDisplay').textContent = formatSVG(svg);
  $('currentModelTag').textContent = model;
  $('timingBadge').textContent = `${(elapsed / 1000).toFixed(1)}s`;
  $('resultGrid').classList.remove('hidden');
  hideError();
}

function setLoading(on, label = 'Génération en cours…') {
  $('loadingBar').classList.toggle('hidden', !on);
  $('loadingLabel').textContent = label;
  $('generateBtn').disabled = on;
  $('applyVariantBtn').disabled = on;
}

function showError(msg, raw) {
  $('errorCard').classList.remove('hidden');
  $('errorMsg').textContent = msg;
  $('rawResponse').textContent = raw;
}

function hideError() {
  $('errorCard').classList.add('hidden');
}

// ── Code actions ──────────────────────────────────────
function copySVG() {
  copyText(currentSVG);
}

function copyText(text) {
  if (!text) return;
  navigator.clipboard.writeText(text)
    .then(() => flashMessage('Copié !'))
    .catch(() => flashMessage('Erreur de copie'));
}

function downloadSVG() {
  if (!currentSVG) return;
  const blob = new Blob([currentSVG], { type: 'image/svg+xml' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: 'generated.svg'
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

function toggleCode(btn) {
  const pre = btn.closest('.compare-card').querySelector('.compare-code-block');
  const visible = pre.classList.toggle('visible');
  btn.textContent = visible ? 'Masquer le code' : 'Voir le code';
}

function useResult(svg, model) {
  currentSVG = svg;
  $('currentModelTag').textContent = model;
  displayResult(svg, model, 0);
  $('timingBadge').textContent = '';
  $('variantToggleBtn').disabled = false;
  switchMode('simple');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Formatting ────────────────────────────────────────
function formatSVG(svg) {
  // Basic pretty-print: indent tags
  let indent = 0;
  return svg
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map(line => {
      line = line.trim();
      if (!line) return '';
      if (line.startsWith('</')) indent = Math.max(0, indent - 1);
      const out = '  '.repeat(indent) + line;
      if (!line.startsWith('</') && !line.endsWith('/>') && !line.startsWith('<!--')) indent++;
      return out;
    })
    .filter(Boolean)
    .join('\n');
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function flashMessage(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

// ── API helper ────────────────────────────────────────
async function api(endpoint, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(endpoint, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
