import type { FlowView } from "./flow-view.ts";

/**
 * The read-only page `canon config --flow` writes to .canon/flow.html (BR-2541, D-140): the flow view embedded as
 * JSON and drawn by a small inline script, in Chinese as the owner asked (D-140). It loads nothing from the network,
 * so it opens offline from the file.
 */
export function flowPage(flow: FlowView): string {
  // reason: `<` escaped so no value in the data can close the script element it is embedded in (BR-2541)
  const data = JSON.stringify(flow).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>canon 流程图</title>
<style>
${STYLE}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>canon 流程图</h1>
    <p class="sub">从会话开始到 main 被验收的每一步，以及控制这一步的 <code>canon/config.yaml</code> 配置项。点一个步骤，右侧显示它的配置项、当前值和怎么关。</p>
    <div class="bar" id="stats"></div>
    <div class="bar">
      <div class="legend">
        <span class="chip k-required">必需 · 不能关</span>
        <span class="chip k-optional">可选 · 能关</span>
        <span class="chip k-tunable">可调</span>
        <span class="chip k-builtin">内置 · 没有配置能关掉</span>
        <span class="chip s-on">运行</span>
        <span class="chip s-off">没开</span>
        <span class="key set">本项目写了</span>
      </div>
      <label class="toggle"><input type="checkbox" id="only-set"> 只看本项目写了配置的步骤</label>
    </div>
  </header>
  <div class="grid">
    <div class="flow" id="flow"></div>
    <aside id="panel" aria-live="polite"></aside>
  </div>
  <p class="foot">这个页面只读。改配置要编辑 <code>canon/config.yaml</code>，再像别的改动一样走合入。页面显示的是运行 <code>canon config --flow</code> 那一刻的 <code id="src"></code>，配置改了要重新运行。配置项的说明是 canon 自带的英文原文。</p>
</div>
<script id="data" type="application/json">${data}</script>
<script>
${SCRIPT}
</script>
</body>
</html>
`;
}

const STYLE = `
:root {
  --bg: #f6f7f9; --surface: #ffffff; --surface-2: #eef0f4; --line: #d9dde5;
  --fg: #1b2230; --muted: #5d6677; --accent: #2f5bd3; --accent-soft: #e3eafb;
  --req: #b4352b; --req-soft: #f8e4e1; --opt: #8a5f00; --opt-soft: #f7edd3;
  --tune: #4b5a73; --tune-soft: #e6eaf1; --on: #1f7a4d; --on-soft: #dcf0e5; --off: #7a8190;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12151c; --surface: #1a1f29; --surface-2: #222835; --line: #2f3646;
    --fg: #e4e8f0; --muted: #98a1b3; --accent: #7d9cf0; --accent-soft: #23305a;
    --req: #f08a7e; --req-soft: #3d221f; --opt: #e3b553; --opt-soft: #3a2f15;
    --tune: #a9b6cc; --tune-soft: #262d3b; --on: #5fcf94; --on-soft: #183326; --off: #6b7385;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 var(--sans); }
.wrap { max-width: 1240px; margin: 0 auto; padding: 28px 16px 56px; }
h1, h2, h3 { margin: 0; text-wrap: balance; }
h1 { font-size: 1.6rem; font-weight: 650; }
.sub { color: var(--muted); margin: 6px 0 0; max-width: 72ch; }
code { font-family: var(--mono); font-size: 0.86em; }
header { display: flex; flex-direction: column; gap: 14px; margin-bottom: 22px; }
.bar { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; }
.stat { display: flex; align-items: baseline; gap: 6px; font-variant-numeric: tabular-nums; }
.stat b { font-size: 1.1rem; }
.stat span { color: var(--muted); font-size: 0.85rem; }
.legend { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: inline-flex; align-items: center; border-radius: 4px; padding: 1px 7px; font-size: 0.76rem; font-weight: 500; white-space: nowrap; }
.k-required { background: var(--req-soft); color: var(--req); }
.k-optional { background: var(--opt-soft); color: var(--opt); }
.k-tunable { background: var(--tune-soft); color: var(--tune); }
.k-builtin { background: var(--surface-2); color: var(--muted); border: 1px dashed var(--line); }
.s-on { background: var(--on-soft); color: var(--on); }
.s-off { background: var(--surface-2); color: var(--off); }
.toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--muted); font-size: 0.86rem; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 420px); gap: 24px; align-items: start; }
@media (max-width: 900px) { .grid { grid-template-columns: minmax(0, 1fr); } }
.stage { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 14px; }
.rail { display: flex; flex-direction: column; align-items: center; }
.num { width: 30px; height: 30px; border-radius: 50%; border: 2px solid var(--accent); color: var(--accent); background: var(--surface); display: grid; place-items: center; font-weight: 650; font-variant-numeric: tabular-nums; flex: none; }
.line { flex: 1; width: 2px; background: var(--line); min-height: 18px; }
.stage:last-child .line { display: none; }
.stage-body { padding-bottom: 22px; min-width: 0; }
.stage-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 3px 0 10px; }
.stage-head h2 { font-size: 1.05rem; font-weight: 650; }
.stage-head code { color: var(--muted); }
.steps { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.step { text-align: left; font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.step:hover { border-color: var(--accent); }
.step:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.step[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.step.idle { background: var(--surface-2); }
.step.idle .step-title { color: var(--muted); }
.step-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.step-title { font-weight: 600; font-size: 0.93rem; }
.keys { display: flex; flex-wrap: wrap; gap: 4px; }
.key { font-family: var(--mono); font-size: 0.72rem; padding: 0 5px; border-radius: 3px; background: var(--surface-2); color: var(--muted); }
.key.set { background: var(--accent-soft); color: var(--accent); }
.hidden { display: none; }
aside { position: sticky; top: 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; max-height: calc(100vh - 32px); overflow: auto; min-width: 0; }
@media (max-width: 900px) { aside { position: static; max-height: none; } }
aside h3 { font-size: 1.1rem; font-weight: 650; }
.panel-head { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.desc { color: var(--muted); margin: 0; font-size: 0.88rem; }
.kcard { border-top: 1px solid var(--line); padding: 12px 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.kname { font-family: var(--mono); font-weight: 500; font-size: 0.88rem; }
.vals { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; font-size: 0.83rem; margin: 0; }
.vals dt { color: var(--muted); }
.vals dd { margin: 0; font-family: var(--mono); font-size: 0.8rem; overflow-wrap: anywhere; }
.how { font-size: 0.82rem; }
.doc { color: var(--muted); font-size: 0.8rem; margin: 0; }
.yaml { display: flex; gap: 6px; align-items: stretch; }
.yaml pre { flex: 1; margin: 0; background: var(--surface-2); border-radius: 5px; padding: 6px 8px; font-family: var(--mono); font-size: 0.76rem; overflow-x: auto; min-width: 0; }
.copy { font: inherit; font-size: 0.76rem; border: 1px solid var(--line); background: var(--surface); color: var(--fg); border-radius: 5px; padding: 0 9px; cursor: pointer; }
.copy:hover { border-color: var(--accent); color: var(--accent); }
.foot { margin-top: 26px; color: var(--muted); font-size: 0.82rem; max-width: 80ch; }
`;

const SCRIPT = `
(() => {
  const F = JSON.parse(document.getElementById("data").textContent);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const shown = (k) => (k.set ? JSON.stringify(k.value) : k.default === null ? "（没写）" : JSON.stringify(k.default) + "（默认）");
  const steps = F.stages.flatMap((s) => s.steps);
  // reason: a mapping key shows once per entry (hooks.before_land, ...), but it is one key of canon/config.yaml (BR-2540)
  const keys = new Map(steps.flatMap((s) => s.keys).map((k) => [k.key.split(".")[0], k]));
  document.getElementById("src").textContent = F.config;
  document.getElementById("stats").innerHTML = [
    [steps.length, "个步骤"], [steps.filter((s) => !s.runs).length, "个没开"], [keys.size, "个配置项"],
    [new Set(steps.flatMap((s) => s.keys).filter((k) => k.set).map((k) => k.key.split(".")[0])).size, "个本项目写了"],
  ].map(([n, l]) => '<div class="stat"><b>' + n + "</b><span>" + l + "</span></div>").join("");

  const flow = document.getElementById("flow");
  flow.innerHTML = F.stages.map((stage, i) =>
    '<section class="stage"><div class="rail"><div class="num">' + (i + 1) + '</div><div class="line"></div></div>' +
    '<div class="stage-body"><div class="stage-head"><h2>' + esc(stage.title) + "</h2><code>" + esc(stage.command) + "</code></div>" +
    '<div class="steps">' + stage.steps.map((s) =>
      '<button class="step' + (s.runs ? "" : " idle") + '" data-id="' + s.id + '" data-set="' + s.keys.some((k) => k.set) + '" aria-pressed="false">' +
      '<div class="step-top"><span class="step-title">' + esc(s.title) + '</span><span class="chip ' + (s.runs ? "s-on" : "s-off") + '">' + (s.runs ? "运行" : "没开") + "</span></div>" +
      (s.builtin ? '<span class="chip k-builtin">内置 · ' + esc(s.builtin) + "</span>" : "") +
      '<div class="keys">' + s.keys.map((k) => '<span class="key' + (k.set ? " set" : "") + '">' + esc(k.key) + "</span>").join("") + "</div></button>"
    ).join("") + "</div></div></section>"
  ).join("");

  const yaml = (k) => {
    const v = k.set ? k.value : k.default;
    const text = v === null ? "" : JSON.stringify(v);
    const dot = k.key.indexOf(".");
    return dot < 0 ? k.key + ": " + text : k.key.slice(0, dot) + ":\\n  " + k.key.slice(dot + 1) + ": " + (text || '"<命令>"');
  };
  const how = (k) => (k.role === "required" ? "<b>不能关：</b>" + esc(k.why) : k.role === "optional" ? "<b>怎么关：</b>" + esc(k.off) : "");
  const card = (k) => {
    const y = yaml(k);
    return '<div class="kcard"><div class="row"><span class="kname">' + esc(k.key) + '</span><span class="chip k-' + k.role + '">' + ({ required: "必需", optional: "可选", tunable: "可调" })[k.role] + "</span>" +
      (k.set ? '<span class="key set">本项目写了</span>' : "") + "</div>" +
      '<dl class="vals"><dt>当前</dt><dd>' + esc(shown(k)) + "</dd>" + (k.set && k.default !== null ? "<dt>默认</dt><dd>" + esc(JSON.stringify(k.default)) + "</dd>" : "") + "</dl>" +
      (how(k) ? '<div class="how">' + how(k) + "</div>" : "") +
      '<p class="doc">' + esc(k.doc) + "</p>" +
      '<div class="yaml"><pre>' + esc(y) + '</pre><button class="copy" type="button">复制</button></div></div>';
  };
  const panel = document.getElementById("panel");
  const show = (id) => {
    const s = steps.find((x) => x.id === id);
    flow.querySelectorAll(".step").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === id)));
    panel.innerHTML = '<div class="panel-head"><h3>' + esc(s.title) + '</h3><div class="row"><span class="chip ' + (s.runs ? "s-on" : "s-off") + '">' + (s.runs ? "运行" : "没开") + "</span>" +
      (s.builtin ? '<span class="chip k-builtin">内置，支撑 ' + esc(s.builtin) + "</span>" : "") + "</div>" +
      (s.runs ? "" : '<p class="desc">没开的原因：' + esc(s.idle) + "</p>") + '<p class="desc">' + esc(s.about) + "</p></div>" + s.keys.map(card).join("");
  };
  flow.addEventListener("click", (e) => { const b = e.target.closest(".step"); if (b) show(b.dataset.id); });
  panel.addEventListener("click", async (e) => {
    const b = e.target.closest(".copy");
    if (!b) return;
    const pre = b.previousElementSibling;
    try { await navigator.clipboard.writeText(pre.textContent); b.textContent = "已复制"; }
    catch { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); b.textContent = "已选中"; }
    setTimeout(() => { b.textContent = "复制"; }, 1500);
  });
  document.getElementById("only-set").addEventListener("change", (e) => {
    flow.querySelectorAll(".step").forEach((b) => b.classList.toggle("hidden", e.target.checked && b.dataset.set !== "true"));
  });
  show(steps[0].id);
})();
`;
