'use strict';

// Asking Claude, wherever it can help: a line to say what you want and a button, then what it said, with
// a way to take it back. Claude only suggests (the server's ai.js): what it says fills in the same fields
// you would, for you to check before anything is filed or changed. Shown only when the server has it.
// Loaded after common.js and icons.js.
const WBClaude = (() => {
  const { el } = WB;

  const on = () => !!(WB.info() && WB.info().ai);
  // "claude-haiku-5-5" -> "Claude Haiku"
  const modelName = () => {
    const m = /claude-([a-z]+)/.exec((WB.info().ai || {}).model || '');
    return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)}` : 'Claude';
  };

  // `ask(instruction)` asks and uses the answer, returning what to say of it ({ text, undo? }); it throws
  // to say what went wrong. `placeholder` says what may be asked here.
  function box({ placeholder, ask, cls = '' }) {
    const input = el('textarea', { rows: '1', placeholder, spellcheck: 'true', 'aria-label': `Tell ${modelName()} what these are` });
    const go = el('button', { type: 'button', class: 'btn small primary', text: 'Suggest' });
    const said = el('span', { class: 'ai-said', role: 'status' });
    const undoBtn = el('button', { type: 'button', class: 'linkbtn', text: 'Undo', hidden: true });
    let undo = null;
    let busy = false;
    const grow = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    };
    const paint = (text, kind = '') => {
      said.textContent = text;
      said.className = `ai-said${kind ? ` ${kind}` : ''}`;
      undoBtn.hidden = !undo;
    };
    async function run() {
      if (busy) return;
      busy = true;
      go.disabled = true;
      node.classList.add('busy');
      undo = null;
      paint(`${modelName()} is thinking…`);
      try {
        const out = await ask(input.value.trim());
        undo = out.undo || null;
        paint(out.text, 'ok');
      } catch (err) {
        paint(err.message || 'Something went wrong', 'bad');
      } finally {
        busy = false;
        go.disabled = false;
        node.classList.remove('busy');
      }
    }
    go.addEventListener('click', run);
    input.addEventListener('input', grow);
    // Enter asks; Shift+Enter is a new line.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        run();
      }
    });
    undoBtn.addEventListener('click', () => {
      if (!undo) return;
      const u = undo;
      undo = null;
      u();
      paint('Put back as it was');
    });
    const node = el('div', { class: `ai-box ${cls}`.trim() },
      el('span', { class: 'ai-ic', html: WB.icon('sparkle', 16), title: `Suggested by ${modelName()}. Only file names and this project's names are sent` }),
      input, go,
      el('div', { class: 'ai-foot' }, said, undoBtn));
    return { node, input, focus: () => input.focus() };
  }

  // The little mark on what Claude filled in: its reason, on hover.
  const mark = (reason, fits = true) => el('span', {
    class: `ai-mark${fits ? '' : ' warn'}`, html: WB.icon('sparkle', 12),
    title: `${modelName()}: ${reason || 'suggested'}${fits ? '' : ' (not the usual shape of a name: check it)'}`,
  });

  return { on, modelName, box, mark };
})();
