// Scienceum notebook — frontend logic.
// Talks to the Rust `eval_cell` / `reset_kernel` commands, which relay to the
// Python SymbolicKernel sidecar. Results come back as LaTeX (rendered with
// KaTeX), inline plot images, or caret-annotated errors.

const invoke = window.__TAURI__?.core?.invoke;

const notebook = document.getElementById("notebook");
const statusEl = document.getElementById("status");

let cells = [];
let nextId = 1;

const SEED = [
  "f(x) := x^2 + 1",
  "diff(f(x), x)",
  "A = [1, 2; 3, 4]",
  "det(A)",
  "inv(A)",
  "solve(x^2 - 2, x)",
  "plot(sin(x), cos(x), (x, -pi, pi))",
];

// ---- model ---------------------------------------------------------------
function makeCell(code = "") {
  return { id: nextId++, code, busy: false, result: null };
}

function addCell(afterId = null, code = "") {
  const cell = makeCell(code);
  if (afterId == null) {
    cells.push(cell);
  } else {
    const i = cells.findIndex((c) => c.id === afterId);
    cells.splice(i + 1, 0, cell);
  }
  render();
  focusCell(cell.id);
  return cell;
}

function deleteCell(id) {
  if (cells.length === 1) {
    cells[0].code = "";
    cells[0].result = null;
  } else {
    cells = cells.filter((c) => c.id !== id);
  }
  render();
}

// ---- evaluation ----------------------------------------------------------
async function runCell(id) {
  const cell = cells.find((c) => c.id === id);
  if (!cell || !invoke) {
    if (!invoke) setStatus("error", "no kernel bridge (open inside the app)");
    return;
  }
  cell.busy = true;
  updateCell(cell);
  try {
    const res = await invoke("eval_cell", { src: cell.code });
    cell.result = res;
  } catch (e) {
    cell.result = { ok: false, error: String(e) };
  }
  cell.busy = false;
  updateCell(cell);
}

async function runAll() {
  for (const c of cells) {
    // Sequential: the kernel is stateful, order matters (like Pluto).
    await runCell(c.id);
  }
}

async function resetKernel() {
  if (!invoke) return;
  try {
    await invoke("reset_kernel");
    for (const c of cells) c.result = null;
    render();
    setStatus("ready", "kernel ready · environment cleared");
  } catch (e) {
    setStatus("error", String(e));
  }
}

// ---- rendering -----------------------------------------------------------
function render() {
  notebook.innerHTML = "";
  cells.forEach((cell) => {
    notebook.appendChild(renderCell(cell));
    const add = document.createElement("button");
    add.className = "add-between";
    add.textContent = "+";
    add.title = "add cell below";
    add.onclick = () => addCell(cell.id);
    notebook.appendChild(add);
  });

  // A persistent, full-width control to append a new cell at the end.
  const addCellBtn = document.createElement("button");
  addCellBtn.className = "add-cell";
  addCellBtn.textContent = "+ Add cell";
  addCellBtn.title = "add a new cell at the end (Ctrl+Shift+Enter)";
  addCellBtn.onclick = () => addCell(null);
  notebook.appendChild(addCellBtn);
}

function renderCell(cell) {
  const el = document.createElement("section");
  el.className = "cell";
  el.dataset.id = cell.id;

  const out = document.createElement("div");
  out.className = "output";
  el.appendChild(out);

  const tools = document.createElement("div");
  tools.className = "cell-tools";
  const addBtn = button("+", "add cell below", () => addCell(cell.id));
  const delBtn = button("✕", "delete cell", () => deleteCell(cell.id));
  delBtn.classList.add("del");
  tools.append(addBtn, delBtn);
  el.appendChild(tools);

  const row = document.createElement("div");
  row.className = "editor-row";

  const run = document.createElement("button");
  run.className = "run";
  run.title = "run cell";
  run.textContent = "▷";
  run.onclick = () => runCell(cell.id);

  const ta = document.createElement("textarea");
  ta.className = "editor";
  ta.spellcheck = false;
  ta.value = cell.code;
  ta.rows = 1;
  ta.placeholder = "type an expression…  e.g.  diff(x^3, x)";
  ta.addEventListener("input", () => {
    cell.code = ta.value;
    autosize(ta);
  });
  ta.addEventListener("keydown", (ev) => onEditorKey(ev, cell));

  row.append(run, ta);
  el.append(row);

  paintOutput(out, cell);
  requestAnimationFrame(() => autosize(ta));
  el.classList.toggle("ok", cell.result?.ok === true);
  el.classList.toggle("bad", cell.result?.ok === false);
  return el;
}

function updateCell(cell) {
  const el = notebook.querySelector(`.cell[data-id="${cell.id}"]`);
  if (!el) return render();
  paintOutput(el.querySelector(".output"), cell);
  el.classList.toggle("ok", cell.result?.ok === true);
  el.classList.toggle("bad", cell.result?.ok === false);
}

function paintOutput(out, cell) {
  out.innerHTML = "";
  if (cell.busy) {
    out.innerHTML = '<span class="placeholder">evaluating…</span>';
    return;
  }
  const r = cell.result;
  if (!r) return; // never run -> output hides (CSS :empty)

  if (r.ok === false) {
    const box = document.createElement("div");
    box.className = "error";
    box.innerHTML = `<div class="msg"></div>`;
    box.querySelector(".msg").textContent = r.error || "error";
    if (r.detail) {
      const pre = document.createElement("pre");
      pre.textContent = r.detail;
      box.appendChild(pre);
    }
    out.appendChild(box);
    return;
  }

  if (r.kind === "plot" && r.image) {
    const img = document.createElement("img");
    img.alt = "plot";
    img.src = "data:image/png;base64," + r.image;
    out.appendChild(img);
    return;
  }

  if (r.kind === "empty") return;

  if (r.latex && window.katex) {
    try {
      const span = document.createElement("span");
      window.katex.render(r.latex, span, { throwOnError: false, displayMode: false });
      out.appendChild(span);
      return;
    } catch (_) { /* fall through to text */ }
  }
  const pre = document.createElement("div");
  pre.className = "text-result";
  pre.textContent = r.text ?? "";
  out.appendChild(pre);
}

// ---- editor behaviour ----------------------------------------------------
function onEditorKey(ev, cell) {
  if (ev.key === "Enter" && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    runCell(cell.id);
    if (ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
      const i = cells.findIndex((c) => c.id === cell.id);
      if (i === cells.length - 1) addCell(cell.id);
      else focusCell(cells[i + 1].id);
    }
  }
}

function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

function focusCell(id) {
  requestAnimationFrame(() => {
    const ta = notebook.querySelector(`.cell[data-id="${id}"] .editor`);
    if (ta) { ta.focus(); ta.selectionStart = ta.value.length; }
  });
}

function button(label, title, onClick) {
  const b = document.createElement("button");
  b.textContent = label; b.title = title; b.onclick = onClick;
  return b;
}

function setStatus(cls, text) {
  statusEl.className = "status " + cls;
  statusEl.innerHTML = `<i></i>${text}`;
}

// ---- boot ----------------------------------------------------------------
document.getElementById("run-all").onclick = runAll;
document.getElementById("reset").onclick = resetKernel;
document.getElementById("add-cell").onclick = () => addCell(null);

// Ctrl/Cmd+Shift+Enter from anywhere appends a fresh cell at the end.
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.shiftKey && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    addCell(null);
  }
});

SEED.forEach((code) => cells.push(makeCell(code)));
render();

async function probe() {
  if (!invoke) {
    setStatus("error", "kernel bridge unavailable");
    return;
  }
  try {
    await invoke("eval_cell", { src: "" }); // warms up the sidecar
    setStatus("ready", "kernel ready");
  } catch (e) {
    setStatus("error", "kernel failed to start");
  }
}
probe();
