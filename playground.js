// The page: a menu bar over two file panes and an output pane, on the
// functions the compiled script exports as `lcd` (see playground.ml).
//
// `lcd` is a plain global object (loaded by playground.bc.js) and every
// function on it is safe to call directly -- from the console, from a
// <script>, or from a browser-automation/agent tool's JS-eval action --
// without touching the DOM or the menus below. This is the whole surface:
//
//   lcd.run(programText, inputText) -> {ok, text}
//     Runs the interpreter: `inputText` is newline-delimited JSON (lines
//     starting with `#` are comments, blank lines ignored), `text` is the
//     newline-delimited JSON the run produced (prints, global reads,
//     generated/output events). This is what the Run button calls.
//
//   lcd.check(programText) -> {ok, text}
//     Type-checks only; `text` is "program.lcd: ok" on success or the
//     error report.
//
//   lcd.elab(programText) -> {ok, text}
//     The type-checked program printed back as Lucid Lite source.
//
//   lcd.manifest(programText) -> {ok, text}
//     `text` is a JSON topology: nodes, their ports (external/linked, with
//     port numbers), links between nodes, and the event->tag table.
//
//   lcd.flows(programText) -> {ok, text}
//     The link protocol check's report (which events cross which links).
//
//   lcd.compile(programText, node) -> {ok, text}
//     The program after inlining, printed back as source: with `node` (a
//     name from lcd.nodes(...)) that node's program, with null the whole
//     program. This is the "inline" view under Analyze.
//
//   lcd.c(programText, node, driver) -> {ok, text, files}
//     Compiles `node` to a standalone C program with the named driver:
//     "rawsock" (raw sockets, what the menu offers), "lpcap" (pcap files
//     in and out), or "dpdk". `text` is the C files of the bundle one
//     after another, `files` every file of it as {name, text}:
//     lucidprog.c, the extern modules' sources and generated headers,
//     lucid_rt.h, makefile -- what `lcd c -o dir` writes.
//
//   lcd.lucid(programText, node, target) -> {ok, text}
//     Lowers `node` to the hardware-targetable Lucid subset for the named
//     target ("tofino", "c", or "switch"; an unknown name means "switch").
//     Fails with {ok: false} if the node uses a construct outside that
//     subset (e.g. generate_port) -- a real semantic check, not a stub.
//
//   lcd.ir(programText, node, flatten) -> {ok, text}
//     Dumps `node`'s IR (null: every leaf's, one after another);
//     `flatten` (bool) selects the flattened form (nested events as
//     variants) vs. the nested one.
//
//   lcd.nodes(programText) -> string[]
//     The leaf node names of a multi-node program: [] for a single-node
//     program (pass null as `node` to the functions above in that case),
//     and also [] when the program does not compile.
//
//   lcd.examples() -> {name, text}[]
//     The files of the repository's programs/examples/ directory at build
//     time, its index.txt (the sections of the examples menu) among
//     them. The page lists the live examples/ directory beside it when
//     it can (see "the examples" below) and falls back to these.
//
//   lcd.stdlib() -> {name, text}[]
//     The built-in library files (programs/stdlib/ at build time), which
//     a program includes as `include <name>;`; a quoted include names a
//     file beside the program (an open tab, here). The "libraries"
//     section of the examples menu shows them.
//
//   lcd.highlight(lang, text) -> string (HTML)
//     Syntax-highlights `text` as `lang` ("lcd" | "lucid" | "json" | "c" |
//     "js");
//     used for the editor overlays and the output pane, not needed for
//     driving the compiler itself.
//
//   lcd.addFile(name, text) -> void
//     Adds a file beside the program, by base name: an included library,
//     or an extern module's source (`extern "f.js";` or `extern "f.c";`
//     in the program). Call it before compiling a program that names
//     `name`. Only JavaScript modules run in the page; a C module's
//     source is read by lcd.c and copied into its output. The page does
//     this for every open file before each compiler call.
//
//   lcd.readme() -> string
//     The page's readme (About > readme opens it as a tab).
//
//   lcd.version() -> string
//
// Every compiler call returns {ok, text}: on failure `ok` is false and
// `text` is the error report (what the output pane shows in red).
//
// The page holds a set of open files, shown as tabs in two panes (a tab
// can be dragged to the other pane), and two selectors beside Run that
// pick the program (which Analyze and Compile use too) and the input
// among them. Results go to the output pane's "output" tab, except
// Compile > c, which opens one closable tab per generated C file. It is
// driven through `window.playground` (defined below, next to the panes):
//
//   playground.files() -> string[]
//     The names of the open files, in the order they were opened.
//   playground.open(name, text) -> void
//     Opens a file as a tab (in the pane its kind usually goes to: .lcd
//     left, .in right, others the focused pane) and shows it; an open
//     file of that name gets the new text instead, or with no text is
//     just shown. The name's extension gives its kind: .lcd a program,
//     .in/.jsonl/.json an input, .js/.c/.h an extern module's source
//     (also readable by the compiler).
//   playground.read(name) -> string | undefined
//   playground.close(name) -> bool
//   playground.panes() -> [{tabs, shown}, {tabs, shown}]
//     The two panes, left then right: each one's tabs in order and the
//     name of the file its editor shows (null when it has none).
//   playground.show(name) -> bool
//     Brings the file's tab to the front of its pane, so its editor
//     shows it (and makes that pane the focused one); false if the file
//     is not open.
//   playground.move(name, pane) -> void
//     Moves the file's tab to pane 0 (left) or 1 (right) and shows it.
//   playground.select(program, input) -> void
//   playground.selection() -> {program, input}
//     The two selectors beside Run: the open program and input they use
//     (input "" means none). `select` skips an argument that is
//     undefined or not an open file of that kind.
//   playground.getProgram() -> string
//   playground.setProgram(text) -> void
//   playground.getInput() -> string
//   playground.setInput(text) -> void
//     The text of the selected program / input; the setters write into
//     that file (opening program.lcd / input.in when none is selected).
//   playground.outputs() -> string[]
//     The output pane's tabs: "output" (always there) and, after
//     Compile > c, one per generated file, named as the compiler would
//     write it (lucidprog.c, Acl.h; a/lucidprog.c per node of a
//     multi-node program).
//   playground.getResult(name?) -> {ok, text}
//     A result in the output pane: the tab named `name`, or the active
//     one, as the compiler call returned it (before highlighting).
//   playground.closeOutput(name) -> bool
//     Closes a generated file's tab ("output" cannot be closed).
//   playground.command(id) -> bool
//     Runs the menu entry with that id (the ids are listed with the menus
//     at the end of this file, e.g. "analyze-typecheck", "compile-c",
//     "example-ping-lcd"), or "run", as if it had been clicked; false if
//     there is no such entry.
//   playground.theme(mode?) -> "light" | "dark"
//     The page's colours; with `mode` ("light" or "dark") sets them, as
//     the two buttons at the right of the bar do. Dark unless this
//     browser remembers a choice.
//   playground.ready -> Promise
//     Resolves once the examples are listed and the first one is open;
//     a script that starts right after the page does should await it.
const $ = id => document.getElementById(id);

// ---- the output pane: results in tabs ----
// The tabs are {name, r, lang, what, fixed}: "output", which every
// command but Compile > c writes into and which cannot be closed, and
// after Compile > c one closable tab per generated file, named as the
// compiler would write it. `what` describes the result (shown at the
// right of the strip); the active tab is kept across updates when it is
// still there.
const OUTPUT = "output";
let results = [{ name: OUTPUT, r: { ok: true, text: "" }, lang: null, what: "", fixed: true }], active = OUTPUT;
// a result into the "output" tab, shown
function show(r, lang, what) {
  results[0] = { name: OUTPUT, r, lang, what: what || "", fixed: true };
  active = OUTPUT;
  render();
}
// generated files as tabs ({name, r, lang, what}), replacing the last
// compile's; the first is shown
function showFiles(fs) {
  results = [results[0], ...fs.map(f => ({ ...f, fixed: false }))];
  active = fs.length ? fs[0].name : OUTPUT;
  render();
}
function closeResult(name) {
  const i = results.findIndex(x => x.name === name && !x.fixed);
  if (i < 0) return false;
  results.splice(i, 1);
  if (active === name) active = (results[i] || results[i - 1]).name;
  render();
  return true;
}
function render() {
  const t = results.find(x => x.name === active) || results[0];
  const o = $("output");
  if (t.r.ok && t.lang) o.innerHTML = lcd.highlight(t.lang, t.r.text); else o.textContent = t.r.text;
  o.className = t.r.ok ? "" : "err";
  $("output-title").textContent = t.what;
  $("tabstrip").replaceChildren(...results.map(x => {
    const d = document.createElement("span");
    d.className = "tab" + (x === t ? " active" : "");
    d.dataset.output = x.name;
    const l = document.createElement("span"); l.textContent = x.name; d.appendChild(l);
    if (!x.fixed) {
      const c = document.createElement("button"); c.className = "close"; c.textContent = "\u00d7"; c.title = `close ${x.name}`;
      c.onclick = e => { e.stopPropagation(); closeResult(x.name); };
      d.appendChild(c);
    }
    d.onclick = () => { active = x.name; render(); };
    return d;
  }));
  layoutTabs();
}
// hide the tabs past the strip's width, keeping the active one in view
let hiddenTabs = [];
function layoutTabs() {
  const tabs = [...$("tabstrip").children];
  tabs.forEach(t => t.classList.remove("hidden"));
  const widths = tabs.map(t => t.offsetWidth);
  const total = widths.reduce((a, b) => a + b, 0);
  const strip = $("tabstrip").clientWidth;
  hiddenTabs = [];
  if (total > strip) {
    const room = strip - 30;
    const act = tabs.findIndex(t => t.classList.contains("active"));
    let used = act >= 0 ? widths[act] : 0, full = false;
    tabs.forEach((t, i) => {
      if (i === act) return;
      if (!full && used + widths[i] <= room) used += widths[i]; else { full = true; t.classList.add("hidden"); hiddenTabs.push(t.dataset.output); }
    });
  }
  $("tabmore").classList.toggle("shown", hiddenTabs.length > 0);
}
window.addEventListener("resize", layoutTabs);

// ---- the files and the panes ----
// An open file is {name, text, lang, kind} plus where its reader was
// (scroll, selection), kept while another tab is shown. Its kind comes
// from the extension and decides which Run selector lists it and which
// pane it opens in. Each pane has a tab strip and one editor (a
// transparent textarea over the highlighted text), showing its active
// tab; switching tabs swaps the editor's contents.
const files = new Map();
const extOf = name => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
const kindOf = name => { const e = extOf(name); return e === "lcd" ? "program" : ["in", "jsonl", "json"].includes(e) ? "input" : ["js", "c", "h"].includes(e) ? "extern" : "other"; };
const langOf = name => ({ lcd: "lcd", in: "json", jsonl: "json", json: "json", c: "c", h: "c", js: "js" })[extOf(name)] || "text";
const TAB_TYPE = "application/x-lucid-tab";

const panes = ["pane-0", "pane-1"].map(id => ({ id, tabs: [], active: null }));
let focused = panes[0];                       // the pane whose file the File menu acts on
const ta = p => $(`${p.id}-ta`), pre = p => $(`${p.id}-hl`);
const paint = p => { const f = files.get(p.active); pre(p).innerHTML = f ? lcd.highlight(f.lang, ta(p).value) : ""; };
const syncScroll = p => { pre(p).scrollTop = ta(p).scrollTop; pre(p).scrollLeft = ta(p).scrollLeft; };
const paneOf = name => panes.find(p => p.tabs.includes(name));

// remember where the pane's file was being read, before another is shown
function stash(p) {
  const f = files.get(p.active), t = ta(p);
  if (!f) return;
  f.scrollTop = t.scrollTop; f.scrollLeft = t.scrollLeft; f.selStart = t.selectionStart; f.selEnd = t.selectionEnd;
}
function showFile(p, name) {
  stash(p);
  p.active = name;
  const f = files.get(name), t = ta(p);
  $(p.id).classList.toggle("hasfile", !!f);
  t.value = f ? f.text : "";
  if (f) { t.scrollTop = f.scrollTop || 0; t.scrollLeft = f.scrollLeft || 0; t.setSelectionRange(f.selStart || 0, f.selEnd || 0); }
  paint(p); syncScroll(p); renderTabs(p);
}
function renderTabs(p) {
  $(`${p.id}-tabs`).replaceChildren(...p.tabs.map(name => {
    const d = document.createElement("span");
    d.className = "ftab" + (name === p.active ? " active" : "");
    d.dataset.file = name;
    d.draggable = true;
    d.title = "click to show, double-click to rename, drag to the other pane";
    const l = document.createElement("span"); l.textContent = name; d.appendChild(l);
    const x = document.createElement("button"); x.className = "close"; x.textContent = "×"; x.title = `close ${name}`;
    x.onclick = e => { e.stopPropagation(); askClose(x, () => closeFile(name)); };
    d.appendChild(x);
    d.onclick = () => { focused = p; showFile(p, name); };
    d.ondblclick = () => renameFile(name);
    d.ondragstart = e => { e.dataTransfer.setData(TAB_TYPE, name); e.dataTransfer.setData("text/plain", name); e.dataTransfer.effectAllowed = "move"; };
    return d;
  }));
}
// open [name] as a tab in [pane] (or its kind's usual one) and show it; an
// open file of that name gets [text] instead
function openFile(name, text, pane) {
  name = name.split("/").pop();
  let f = files.get(name);
  if (f) {
    if (text !== undefined && text !== f.text) { f.text = text; f.scrollTop = f.scrollLeft = f.selStart = f.selEnd = 0; }
  } else {
    f = { name, text: text || "", lang: langOf(name), kind: kindOf(name) };
    files.set(name, f);
    (pane || (f.kind === "input" ? panes[1] : f.kind === "program" ? panes[0] : focused)).tabs.push(name);
  }
  const p = paneOf(name);
  if (p.active === name) p.active = null;                 // so showFile does not stash the old text over the new
  showFile(p, name);
  refreshRun();
  return f;
}
function closeFile(name) {
  const f = files.get(name);
  if (!f) return false;
  const p = paneOf(name), i = p.tabs.indexOf(name);
  p.tabs.splice(i, 1);
  files.delete(name);
  if (p.active === name) { p.active = null; showFile(p, p.tabs[Math.min(i, p.tabs.length - 1)] || null); } else renderTabs(p);
  refreshRun();
  return true;
}
function moveFile(name, to) {
  const from = paneOf(name);
  if (!from || from === to) return;
  const i = from.tabs.indexOf(name);
  from.tabs.splice(i, 1);
  if (from.active === name) { stash(from); from.active = null; showFile(from, from.tabs[Math.min(i, from.tabs.length - 1)] || null); } else renderTabs(from);
  to.tabs.push(name);
  focused = to;
  showFile(to, name);
}
// the tab element showing [name], if any
const tabOf = name => panes.flatMap(p => [...$(`${p.id}-tabs`).children]).find(t => t.dataset.file === name);
// a slim "yes / no / confirm close?" under [el], yes right under the x
// that was clicked; one at a time, gone on a click elsewhere or Escape
let confirmBox = null;
function dismissConfirm() { if (confirmBox) { confirmBox.remove(); confirmBox = null; } }
function askClose(el, onYes) {
  dismissConfirm();
  const box = document.createElement("div");
  box.className = "confirm";
  box.onclick = e => e.stopPropagation();
  const yes = document.createElement("button"); yes.textContent = "yes"; yes.onclick = () => { dismissConfirm(); onYes(); }; box.appendChild(yes);
  const no = document.createElement("button"); no.textContent = "no"; no.onclick = dismissConfirm; box.appendChild(no);
  const t = document.createElement("span"); t.textContent = "confirm close?"; box.appendChild(t);
  const r = el.getBoundingClientRect();
  box.style.left = `${Math.max(0, Math.min(r.left, window.innerWidth - 200))}px`;
  box.style.top = `${r.bottom + 2}px`;
  document.body.appendChild(box);
  confirmBox = box;
  yes.focus();
}
function renameFile(old) {
  const name = (prompt(`rename ${old} to`, old) || "").trim().split("/").pop();
  if (!name || name === old) return;
  if (files.has(name)) { alert(`${name} is already open`); return; }
  const f = files.get(old), p = paneOf(old);
  files.delete(old);
  f.name = name; f.lang = langOf(name); f.kind = kindOf(name);
  files.set(name, f);
  p.tabs[p.tabs.indexOf(old)] = name;
  for (const kind of ["program", "input"]) if (selects[kind].value === old) selects[kind].dataset.keep = name;
  if (p.active === old) { p.active = name; paint(p); }
  renderTabs(p);
  refreshRun();
}
for (const p of panes) {
  const t = ta(p), sec = $(p.id);
  t.addEventListener("input", () => { const f = files.get(p.active); if (f) f.text = t.value; paint(p); });
  t.addEventListener("scroll", () => syncScroll(p));
  t.addEventListener("focus", () => { focused = p; });
  // a tab from the other pane, or files from the desktop, dropped on the pane
  const carries = e => e.dataTransfer.types.includes(TAB_TYPE) || e.dataTransfer.types.includes("Files");
  sec.ondragover = e => { if (carries(e)) { e.preventDefault(); sec.classList.add("over"); } };
  sec.ondragleave = () => sec.classList.remove("over");
  sec.ondrop = e => {
    if (!carries(e)) return;
    e.preventDefault(); sec.classList.remove("over");
    const name = e.dataTransfer.getData(TAB_TYPE);
    if (name) { if (files.has(name)) moveFile(name, p); return; }
    for (const f of e.dataTransfer.files) f.text().then(text => openFile(f.name, text, p));
  };
  renderTabs(p);
}

// ---- the Run selectors: which open program and input the commands use ----
// Rebuilt when files open, close or are renamed; the selection stays
// when its file is still open, else the first of that kind. The input
// can also be none, a choice that is kept too.
const selects = { program: $("run-program"), input: $("run-input") };
function refreshRun() {
  for (const kind of ["program", "input"]) {
    const s = selects[kind], was = s.dataset.keep || s.value;
    delete s.dataset.keep;
    const names = [...files.keys()].filter(n => files.get(n).kind === kind);
    const option = (v, l) => { const o = document.createElement("option"); o.value = v; o.textContent = l; return o; };
    s.replaceChildren(...names.map(n => option(n, n)), ...(kind === "input" ? [option("", "(no input)")] : []));
    // "(no input)" chosen while there were inputs stays chosen as files come and go
    const keep = names.includes(was) || (kind === "input" && was === "" && s.dataset.had === "1");
    s.value = keep ? was : names[0] || "";
    s.dataset.had = names.length ? "1" : "0";
  }
}
const selectedText = kind => (files.get(selects[kind].value) || { text: "" }).text;
// the selected program's text; every open file is put beside it first, so
// includes and extern sources resolve
const program = () => { for (const f of files.values()) lcd.addFile(f.name, f.text); return selectedText("program"); };
const input = () => selectedText("input");
// a command on the program: an error in the pane when none is selected
const act = f => () => (selects.program.value ? f() : show({ ok: false, text: "no program is open: File > open, or new program" }));

// ---- scripting the page ----
// Exposed for the same reason `lcd` is: so a script (devtools console, an
// external driver, a browser-automation/agent tool's JS-eval action) can
// open files, pick the pair to run, run a command, and read the result
// without simulating keystrokes or clicking through the DOM.
function findEntry(items, id) {
  for (const e of items) {
    if (e === "-") continue;
    if (e.id === id) return e;
    if (e.items) { const f = findEntry(e.items(), id); if (f) return f; }
  }
  return null;
}
window.playground = {
  files: () => [...files.keys()],
  open: (name, text) => { openFile(name, text); },
  read: name => (files.get(name) || {}).text,
  close: name => closeFile(name),
  panes: () => panes.map(p => ({ tabs: [...p.tabs], shown: p.active })),
  show: name => { const p = paneOf(name); if (!p) return false; focused = p; showFile(p, name); return true; },
  move: (name, pane) => moveFile(name, panes[pane]),
  select: (p, i) => {
    if (p !== undefined && files.has(p) && files.get(p).kind === "program") selects.program.value = p;
    if (i !== undefined && (i === "" || (files.has(i) && files.get(i).kind === "input"))) selects.input.value = i;
  },
  selection: () => ({ program: selects.program.value, input: selects.input.value }),
  getProgram: () => selectedText("program"),
  setProgram: text => { const n = selects.program.value || "program.lcd"; openFile(n, text, panes[0]); selects.program.value = n; },
  getInput: () => selectedText("input"),
  setInput: text => { const n = selects.input.value || "input.in"; openFile(n, text, panes[1]); selects.input.value = n; },
  outputs: () => results.map(x => x.name),
  getResult: name => { const t = results.find(x => x.name === (name === undefined ? active : name)); return t ? t.r : { ok: false, text: `no output tab ${name}` }; },
  closeOutput: name => closeResult(name),
  theme: mode => { if (mode) setTheme(mode); return document.body.classList.contains("dark") ? "dark" : "light"; },
  command: id => {
    if (actions[id]) { actions[id](); return true; }
    for (const m of Object.values(menus)) {
      const e = findEntry(m(), id);
      if (e && e.action) { e.action(); return true; }
    }
    return false;
  },
};

// ---- light and dark ----
// the two buttons at the right of the bar; dark by default, the choice
// kept in this browser (when it can be)
function setTheme(mode) {
  document.body.classList.toggle("dark", mode === "dark");
  for (const b of document.querySelectorAll("button[data-theme]")) b.classList.toggle("on", b.dataset.theme === mode);
  try { localStorage.setItem("theme", mode); } catch (e) { /* no storage here */ }
}
document.querySelectorAll("button[data-theme]").forEach(b => { b.onclick = () => setTheme(b.dataset.theme); });
{ let mode = "dark"; try { mode = localStorage.getItem("theme") || "dark"; } catch (e) { /* no storage here */ } setTheme(mode); }

// ---- the splitters: drag to resize the left pane and the top row ----
// [size] reads the pointer into a pixel size for [target]'s [prop]
function splitter(gutter, target, prop, size) {
  const g = $(gutter);
  g.onpointerdown = e => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    g.classList.add("dragging");
    document.body.classList.add("resizing");
    document.body.style.cursor = getComputedStyle(g).cursor;
    g.onpointermove = ev => { $(target).style[prop] = `${size(ev)}px`; layoutTabs(); };
    g.onpointerup = () => {
      g.onpointermove = g.onpointerup = null;
      g.classList.remove("dragging");
      document.body.classList.remove("resizing");
      document.body.style.cursor = "";
    };
  };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
splitter("split-v", "pane-0", "flexBasis", e => clamp(e.clientX - $("top").getBoundingClientRect().left, 150, window.innerWidth - 150));
splitter("split-h", "top", "height", e => clamp(e.clientY - $("top").getBoundingClientRect().top, 80, window.innerHeight - 150));

// ---- the menus ----
// A menu is a list of entries rebuilt each time it opens: {label, action,
// key?} runs something, {label, items} pops out a submenu (a function
// returning entries, called when the menu opens), "-" is a separator,
// {head} a label over the entries that follow (the examples' sections). An
// entry also carries a stable {id}, put on its <button> -- every entry
// below has one, so a script can find/click a specific command (e.g.
// "compile-tofino", "analyze-topology", "example-nodes-lcd") instead of
// clicking by label or pixel position. The buttons only exist in the DOM
// while their menu is open (a submenu's once its parent has been opened),
// same as for a person clicking through; playground.command(id) runs an
// entry without opening anything.
const menus = {};
function entry(e) {
  if (e === "-") { const d = document.createElement("div"); d.className = "sep"; return d; }
  if (e.head !== undefined) { const d = document.createElement("div"); d.className = "head"; d.textContent = e.head; return d; }
  const d = document.createElement("div");
  d.className = "entry";
  const b = document.createElement("button");
  b.textContent = e.label;
  if (e.id) b.id = e.id;
  d.appendChild(b);
  if (e.items) {
    const a = document.createElement("span"); a.className = "arrow"; a.textContent = "▸"; b.appendChild(a);
    const sub = document.createElement("div"); sub.className = "items";
    sub.replaceChildren(...e.items().map(entry));
    d.appendChild(sub);
    const open = () => { for (const s of d.parentElement.children) s.classList.remove("open"); d.classList.add("open"); };
    b.onmouseenter = open;
    b.onclick = ev => { ev.stopPropagation(); open(); };
  } else {
    if (e.key) { const k = document.createElement("span"); k.className = "key"; k.textContent = e.key; b.appendChild(k); }
    b.onmouseenter = () => { for (const s of d.parentElement.children) s.classList.remove("open"); };
    b.onclick = () => { closeMenus(); e.action(); };
  }
  return d;
}
function closeMenus() { document.querySelectorAll(".open").forEach(m => m.classList.remove("open")); }
function openMenu(btn) {
  closeMenus(); dismissConfirm();
  $(`menu-${btn.dataset.menu}`).replaceChildren(...menus[btn.dataset.menu]().map(entry));
  btn.parentElement.classList.add("open");
}
document.querySelectorAll(".menu > button[data-menu]").forEach(btn => {
  btn.onclick = e => { e.stopPropagation(); if (btn.parentElement.classList.contains("open")) closeMenus(); else openMenu(btn); };
  btn.onmouseenter = () => { if (document.querySelector(".menu.open")) openMenu(btn); };
});
// a title that is a command, not a menu
const actions = {};
document.querySelectorAll(".menu > button[data-action]").forEach(btn => {
  btn.onclick = e => { e.stopPropagation(); closeMenus(); actions[btn.dataset.action](); };
  btn.onmouseenter = closeMenus;
});
document.addEventListener("click", () => { closeMenus(); dismissConfirm(); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { closeMenus(); dismissConfirm(); }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); actions.run(); }
});

// ---- per-node views ----
// [f node] computes one result per leaf; a multi-node program's are
// joined in the output tab under a comment naming each node (a
// single-node program's is computed with node null).
function perNode(f, lang, what) {
  const nodes = lcd.nodes(program());
  if (nodes.length === 0) return show(f(null), lang, what);
  const rs = nodes.map(n => [n, f(n)]);
  show({ ok: rs.every(([, r]) => r.ok), text: rs.map(([n, r]) => `// ==== node ${n} ====\n${r.text}`).join("\n") }, lang, what);
}
// Compile > c: the generated files, one tab each, named as the compiler
// writes them, in a directory per node for a multi-node program (the
// layout scripts/shared_test.sh uses); the makefile and the user's own
// extern sources (open files) are left out
function compileC() {
  const nodes = lcd.nodes(program());
  const one = (n, dir) => {
    const what = `C (raw socket driver)${n ? ", node " + n : ""}`;
    const r = lcd.c(program(), n, "rawsock");
    if (!r.ok) return [{ name: `${dir}lucidprog.c`, r, lang: "c", what }];
    return r.files.filter(f => (f.name.endsWith(".c") || f.name.endsWith(".h")) && !files.has(f.name)).map(f => ({ name: dir + f.name, r: { ok: true, text: f.text }, lang: "c", what }));
  };
  showFiles(nodes.length === 0 ? one(null, "") : nodes.flatMap(n => one(n, `${n}/`)));
}

// ---- the examples: the files in examples/ beside the page ----
// examples/index.txt lays out the menu: a [section] label (programs,
// inputs, libraries, externs, tofino programs, or any other) and, under
// it, the files, one per line; `#` starts a comment. The page fetches
// the index and every file it names; when it cannot fetch (opened from
// disk), the same files built into the script are used, index.txt
// among them. Opening a program from the menu also opens the .in of the
// same name and the extern sources it names, when the examples have
// them, and selects the pair for Run; an input is selected too. The
// section labelled "libraries" holds the compiler's built-in library
// (lcd.stdlib(), included as `include <name>;`) after any files the
// index lists there, and its files are only opened.
let examples = { sections: [], text: new Map() };
function parseIndex(text) {
  const sections = [];
  let cur = null;
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^\[(.*)\]$/);
    if (m) { cur = { label: m[1].trim(), files: [] }; sections.push(cur); }
    else { if (!cur) { cur = { label: "examples", files: [] }; sections.push(cur); } cur.files.push(line); }
  }
  return sections;
}
// the examples from a list of {name, text} files, index.txt among them
function examplesOf(files) {
  const text = new Map(files.map(f => [f.name, f.text]));
  const index = text.get("index.txt");
  const sections = index !== undefined ? parseIndex(index) : [{ label: "examples", files: [...text.keys()].filter(n => n.endsWith(".lcd")) }];
  let libs = sections.find(s => s.label.toLowerCase() === "libraries");
  if (!libs) { libs = { label: "libraries", files: [] }; sections.push(libs); }
  for (const f of lcd.stdlib()) { if (!text.has(f.name)) text.set(f.name, f.text); if (!libs.files.includes(f.name)) libs.files.push(f.name); }
  return { sections, text };
}
async function fetchExamples() {
  const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.text(); };
  const index = await get("examples/index.txt");
  const names = [...new Set(parseIndex(index).flatMap(s => s.files))];
  const files = await Promise.all(names.map(async name => ({ name, text: await get(`examples/${name}`) })));
  return examplesOf([{ name: "index.txt", text: index }, ...files]);
}
// open an example: a program with its input and extern sources, selected
// for Run unless [select] is false (a library)
function load(name, select = true) {
  const text = examples.text.get(name);
  if (text === undefined) return;
  openFile(name, text);
  const kind = kindOf(name);
  if (!select) return;
  if (kind === "program") {
    for (const m of text.matchAll(/extern\s+"([^"]+)"/g)) if (examples.text.has(m[1]) && !files.has(m[1])) openFile(m[1], examples.text.get(m[1]));
    const inName = name.replace(/\.lcd$/, ".in");
    if (examples.text.has(inName)) { openFile(inName, examples.text.get(inName), panes[1]); selects.input.value = inName; }
    selects.program.value = name;
    show({ ok: true, text: "" });
  } else if (kind === "input") selects.input.value = name;
}
const exampleEntries = () => examples.sections.filter(s => s.files.length).flatMap(s => [{ head: s.label }, ...s.files.map(n => ({ id: `example-${slug(n)}`, label: n, action: () => load(n, s.label.toLowerCase() !== "libraries") }))]);

// ---- the actions ----
actions.run = act(() => show(lcd.run(program(), input()), "json", `run ${selects.program.value}${selects.input.value ? " with " + selects.input.value : ""}`));
// offer [blob] as a file to save (a blob URL and a link in the page: the
// `download` attribute on a plain URL is only a hint some browsers ignore)
function saveBlob(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const download = (name, text) => saveBlob(name, new Blob([text], { type: "text/plain" }));
// the node script beside the page; when it cannot be fetched (a page opened
// from disk), fall back to opening the link
function downloadLcdJs() {
  fetch("lcd.js").then(r => { if (!r.ok) throw new Error(r.statusText); return r.blob(); })
    .then(b => saveBlob("lcd.js", new Blob([b], { type: "application/octet-stream" })))
    .catch(() => { const a = document.createElement("a"); a.href = "lcd.js"; a.download = "lcd.js"; document.body.appendChild(a); a.click(); a.remove(); });
}
// files from the device, into the focused pane
const fileInput = $("open-file");
fileInput.onchange = () => { for (const f of fileInput.files) f.text().then(t => openFile(f.name, t, focused)); fileInput.value = ""; };
let untitled = 0;
const newFile = ext => { untitled++; openFile(`untitled${untitled}.${ext}`, "", focused); };
const activeFile = () => files.get(focused.active) || null;
// the output pane's active tab as a file to save: output.txt, or the
// generated file's name with its node's directory folded in (a-lucidprog.c)
const outputFileName = () => { const t = results.find(x => x.name === active) || results[0]; return t.name === OUTPUT ? "output.txt" : t.name.replace(/\//g, "-"); };

// a menu-entry id from free text: lowercase, non-alnum runs -> "-"
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

menus.file = () => [
  { id: "file-examples", label: "examples", items: exampleEntries },
  "-",
  { id: "file-new-program", label: "new program", action: () => newFile("lcd") },
  { id: "file-new-input", label: "new input", action: () => newFile("in") },
  { id: "file-open", label: "open file…", action: () => fileInput.click() },
  "-",
  { id: "file-save", label: activeFile() ? `save ${activeFile().name}` : "save", action: () => { const f = activeFile(); if (f) download(f.name, f.text); } },
  { id: "file-save-output", label: `save output as ${outputFileName()}`, action: () => download(outputFileName(), playground.getResult().text) },
  { id: "file-rename", label: "rename…", action: () => { const f = activeFile(); if (f) renameFile(f.name); } },
  { id: "file-close", label: activeFile() ? `close ${activeFile().name}` : "close", action: () => { const f = activeFile(); if (!f) return; const t = tabOf(f.name); if (t) askClose(t, () => closeFile(f.name)); else closeFile(f.name); } },
  "-",
  { id: "file-download-lcdjs", label: "download lcd.js", action: downloadLcdJs },
];
// About: the readme (readme.md beside the page, or the one built into the
// script) as a tab in the left pane, and the project's repository
const GITHUB = "https://github.com/princetonuniversity/lucid";
async function openReadme() {
  let text;
  try { const r = await fetch("readme.md"); if (!r.ok) throw new Error(r.statusText); text = await r.text(); } catch (e) { text = lcd.readme(); }
  openFile("readme.md", text, panes[0]);
}
menus.about = () => [
  { id: "about-readme", label: "readme", action: () => { openReadme(); } },
  { id: "about-github", label: "github", action: () => window.open(GITHUB, "_blank", "noopener") },
];
menus.analyze = () => [
  { id: "analyze-typecheck", label: "type check", action: act(() => show(lcd.check(program()), null, "type check")) },
  // the link protocol check (lcd.flows) is left out of the menu for now
  { id: "analyze-topology", label: "topology", action: act(() => show(lcd.manifest(program()), "json", "topology")) },
  "-",
  { id: "analyze-inline", label: "inline", action: act(() => show(lcd.compile(program(), null), "lcd", "inlined program")) },
];
menus.compile = () => [
  { id: "compile-c", label: "c", action: act(compileC) },
  { id: "compile-tofino", label: "lucid (tofino)", action: act(() => perNode(n => lcd.lucid(program(), n, "tofino"), "lucid", "Lucid (tofino)")) },
  { id: "compile-ir", label: "intermediate representation", action: act(() => perNode(n => lcd.ir(program(), n, false), "lcd", "intermediate representation")) },
  { id: "compile-flat-ir", label: "flattened ir", action: act(() => perNode(n => lcd.ir(program(), n, true), "lcd", "flattened IR (nested events as variants)")) },
];
menus.tabs = () => hiddenTabs.map(n => ({ id: `tab-${slug(n)}`, label: n, action: () => { active = n; render(); } }));

playground.ready = fetchExamples().then(es => { examples = es; }, () => { examples = examplesOf(lcd.examples()); }).then(() => {
  const first = examples.sections.find(s => s.files.length);
  if (first) load(first.files[0]);
  else { openFile("untitled1.lcd", "", panes[0]); openFile("untitled1.in", "", panes[1]); untitled = 1; }
});
