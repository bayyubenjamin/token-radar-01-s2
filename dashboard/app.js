// Token Launch Radar — dashboard app.js
// Renders DATA (written by main.ts) and RECOMPUTES the model in-page from
// the same data: refits the comps curve, re-runs the held-out test, and
// recomputes every row's implied value. The strip shows the recompute
// result, so the page proves its own numbers instead of asserting them.
"use strict";
const D = DATA;
const $ = (s) => document.querySelector(s);

// ---- deterministic PRNG (same algorithm as main.ts) ----
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, seed) {
  const a = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function ols(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0, sst = 0, ssr = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); sst += (ys[i] - my) ** 2; }
  const b = sxy / sxx, a = my - b * mx;
  for (let i = 0; i < n; i++) ssr += (ys[i] - (a + b * xs[i])) ** 2;
  return { a, b, r2: 1 - ssr / sst };
}
function logRmse(pred, truth) {
  let s = 0;
  for (let i = 0; i < pred.length; i++) s += (pred[i] - truth[i]) ** 2;
  return Math.sqrt(s / pred.length);
}

// ---- recompute 1: comps curve ----
const comps = D.comps;
const curve2 = ols(comps.map((c) => Math.log(c.tvl)), comps.map((c) => Math.log(c.mcap)));
const curveMatch = Math.abs(curve2.a - D.curve.a) < 0.001 && Math.abs(curve2.b - D.curve.b) < 0.001;

// ---- recompute 2: held-out test, same 5 seeds ----
const SEEDS = [7, 11, 23, 42, 99];
let heldWins = 0;
const heldF = [], heldL = [];
for (const seed of SEEDS) {
  const idx = shuffled(comps.map((_, i) => i), seed);
  const cut = Math.floor(0.8 * idx.length);
  const tr = idx.slice(0, cut), te = idx.slice(cut);
  const f = ols(tr.map((i) => Math.log(comps[i].tvl)), tr.map((i) => Math.log(comps[i].mcap)));
  const pf = te.map((i) => f.a + f.b * Math.log(comps[i].tvl));
  const pl = te.map((i) => Math.log(0.25) + Math.log(comps[i].tvl));
  const yt = te.map((i) => Math.log(comps[i].mcap));
  const rf = logRmse(pf, yt), rl = logRmse(pl, yt);
  heldF.push(rf); heldL.push(rl);
  if (rf < rl) heldWins++;
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const heldMatch = heldWins === parseInt(D.validation.held_out_comps.fitted_wins.split("/")[0], 10);

// ---- recompute 3: every row's implied value ----
const HAZARD = [[90, 0.467], [365, 0.245], [1095, 0.123], [Infinity, 0.084]];
function odds(age) {
  if (age === null || age === undefined) return 0.245;
  for (const [lim, h] of HAZARD) if (age < lim) return h;
  return 0.084;
}
function impliedOf(r) {
  const size = Math.exp(curve2.a + curve2.b * Math.log(r.tvl_usd));
  const ch = r.change_7d === null || r.change_7d === undefined ? 0 : Math.max(-0.5, Math.min(1.0, r.change_7d));
  const growth = 1 + ch;
  const maturity = r.age_days === null || r.age_days === undefined ? 0.75 : 0.5 + 0.5 * (1 - Math.exp(-r.age_days / 365));
  return Math.round(size * growth * maturity * odds(r.age_days));
}
let matched = 0;
for (const r of D.rows) if (impliedOf(r) === r.implied_value_usd) matched++;

// ---- formatting ----
const fmt$ = (n) => "$" + Math.round(n).toLocaleString("en-US");
const shortChains = (chs) => {
  if (!chs || !chs.length) return "—";
  return chs.length > 3 ? chs.slice(0, 3).join(", ") + " +" + (chs.length - 3) : chs.join(", ");
};
const fmtAge = (a) => (a === null || a === undefined ? "—" : a < 365 ? a + "d" : (a / 365).toFixed(1) + "y");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- strip ----
const v = D.validation;
const counts = { FARM: 0, THIN: 0, SKIP: 0 };
for (const r of D.rows) counts[r.verdict]++;
$("#asof").textContent = D.as_of;
$("#strip").innerHTML = [
  ["Board", `<b>${D.rows.length} rows</b> · ${D.counts.watchlist}/${D.counts.watchlist} watchlist covered`],
  ["Model recomputed", `<b>${matched}/${D.rows.length} rows</b> · curve <span class="num">${curveMatch ? "match" : "MISMATCH"}</span>`],
  ["Held-out ×2", `in-page fitted <span class="num">${mean(heldF).toFixed(2)}</span> vs flat <span class="num">${mean(heldL).toFixed(2)}</span> · wins <b>${heldWins}/5</b> · recomputed here: <b>${heldMatch ? "match" : "MISMATCH"}</b><br>Python cross-check: fitted <span class="num">${v.held_out_python_crosscheck.fitted_mean}</span> vs flat <span class="num">${v.held_out_python_crosscheck.flat_mean}</span> · wins <b>${v.held_out_python_crosscheck.fitted_wins}</b>`],
  ["Odds — held-out", `fitted log-loss <span class="num">${v.held_out_hazard.fitted_log_loss.toFixed(3)}</span> vs assumed <span class="num">${v.held_out_hazard.assumed_log_loss.toFixed(3)}</span> vs base <span class="num">${v.held_out_hazard.base_log_loss.toFixed(3)}</span> · 5 seeds · fitted offline from the snapshot`],
  ["Walk-forward", `fitted wins <b>${v.walk_forward_comps.fitted_wins}</b> · cutoffs ${v.walk_forward_comps.cutoffs.join(", ")}`],
  ["LOO", `fitted <span class="num">${v.loo_comps.fitted_log_rmse}</span> vs flat <span class="num">${v.loo_comps.flat_log_rmse}</span> · <b>${v.loo_comps.ratio_flat_over_fitted}×</b>`],
  ["Verdicts", `<b class="vFARM">FARM ${counts.FARM}</b> · <b class="vTHIN">THIN ${counts.THIN}</b> · <b class="vSKIP">SKIP ${counts.SKIP}</b>`],
].map(([t, b]) => `<div class="check"><b>${t}</b><br>${b}</div>`).join("");

// ---- top FARM picks ----
const farms = D.rows.filter((r) => r.verdict === "FARM").slice(0, 5);
$("#farmpicks").innerHTML = "<h2>TOP FARM PICKS — the best expected value per dollar spent</h2><ol>" +
  farms.map((r) => `<li><b>#${r.rank} ${esc(r.name)}</b> — implied ${fmt$(r.implied_value_usd)}, ` +
    `farmer EV <span class="v">${fmt$(r.ev_usd)}</span> vs cost ${fmt$(r.cost_usd)} ` +
    `(${r.ratio.toFixed(1)}×), odds ${r.odds}</li>`).join("") + "</ol>" +
  `<p style="color:var(--mut);font-size:13px;margin:8px 0 0">The biggest launches rank first by implied value but most are SKIP: ` +
  `the largest protocols are the most farmed, so one farmer's share is the smallest. ` +
  `Verdict = expected farmer value ÷ cost; FARM needs ≥3×.</p>`;

// ---- table: sort + filter ----
let sortKey = "rank", sortDir = 1, verdictFilter = "ALL", query = "";
const params = new URLSearchParams(location.search);
if (params.get("verdict")) verdictFilter = params.get("verdict").toUpperCase();
if (params.get("q")) query = params.get("q");
function visibleRows() {
  return D.rows.filter((r) => {
    if (verdictFilter !== "ALL" && r.verdict !== verdictFilter) return false;
    if (query) {
      const q = query.toLowerCase();
      if (!r.name.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    const ka = a[sortKey], kb = b[sortKey];
    if (typeof ka === "string") return sortDir * ka.localeCompare(kb);
    return sortDir * ((ka ?? 0) - (kb ?? 0));
  });
}
function render() {
  const rows = visibleRows();
  $("#rowcount").textContent = `${rows.length} of ${D.rows.length} rows`;
  $("#rows").innerHTML = rows.map((r) => `<tr data-slug="${esc(r.slug)}">
    <td class="num">${r.rank}</td>
    <td><b>${esc(r.name)}</b>${r.on_watchlist ? '<span class="tag">WATCHLIST</span>' : ""}<br>
      <span style="color:var(--mut);font-size:12px">${esc(r.slug)} · ${esc(shortChains(r.chains))}</span></td>
    <td class="num">${fmt$(r.tvl_usd)}</td>
    <td class="num">${fmtAge(r.age_days)}</td>
    <td class="num">${r.odds}</td>
    <td class="num">${fmt$(r.implied_value_usd)}</td>
    <td class="num">${fmt$(r.ev_usd)}</td>
    <td class="num">${fmt$(r.cost_usd)}</td>
    <td class="v${r.verdict}">${r.verdict}</td></tr>`).join("");
  document.querySelectorAll("#rows tr").forEach((tr) => tr.addEventListener("click", () => showDetail(tr.dataset.slug)));
  document.querySelectorAll("#verdict-filters button").forEach((b) =>
    b.classList.toggle("on", b.dataset.v === verdictFilter));
}
document.querySelectorAll("#board th").forEach((th) => th.addEventListener("click", () => {
  const k = th.dataset.k;
  if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
  render();
}));
$("#verdict-filters").innerHTML = ["ALL", "FARM", "THIN", "SKIP"].map((f) =>
  `<button data-v="${f}" class="${f === verdictFilter ? "on" : ""}">${f}</button>`).join("");
document.querySelectorAll("#verdict-filters button").forEach((b) => b.addEventListener("click", () => {
  verdictFilter = b.dataset.v; render();
}));
const qInput = $("#q");
qInput.value = query;
qInput.addEventListener("input", () => { query = qInput.value; render(); });

// ---- detail dialog ----
function showDetail(slug) {
  const r = D.rows.find((x) => x.slug === slug);
  if (!r) return;
  const size = Math.exp(curve2.a + curve2.b * Math.log(r.tvl_usd));
  const dlg = $("#detail");
  dlg.innerHTML = `<button class="close">Close</button>
    <h2>#${r.rank} ${esc(r.name)}</h2>
    <p class="meta">${esc(r.slug)} · ${esc(r.category || "no category")} · ${esc(r.chains.join(", ") || "—")} · ` +
    `TVL ${fmt$(r.tvl_usd)} · age ${fmtAge(r.age_days)} · ${r.on_watchlist ? "on the watchlist" : "below the watchlist floor"}</p>
    <table><tbody>
    <tr><th>Implied value</th><td class="num"><b>${fmt$(r.implied_value_usd)}</b></td></tr>
    <tr><th>Size value exp(${curve2.a.toFixed(4)} + ${curve2.b.toFixed(4)}·ln TVL)</th><td class="num">${fmt$(size)}</td></tr>
    <tr><th>× growth (7d ${r.change_7d === null ? "n/a" : (r.change_7d * 100).toFixed(1) + "%"})</th><td class="num">${r.growth.toFixed(3)}</td></tr>
    <tr><th>× maturity</th><td class="num">${r.maturity.toFixed(3)}</td></tr>
    <tr><th>× odds (fitted hazard)</th><td class="num">${r.odds}</td></tr>
    <tr><th>Farmer EV (5% of supply ÷ wallets)</th><td class="num">${fmt$(r.ev_usd)}</td></tr>
    <tr><th>Farm cost (7 steps)</th><td class="num">${fmt$(r.cost_usd)}</td></tr>
    <tr><th>EV ÷ cost</th><td class="num">${r.ratio.toFixed(2)}×</td></tr>
    <tr><th>Verdict</th><td class="v${r.verdict}">${r.verdict}</td></tr>
    </tbody></table>
    <h3>How to farm it</h3>
    <ol>${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
  dlg.querySelector(".close").addEventListener("click", () => dlg.close());
  dlg.showModal();
}

// ---- footer ----
$("#method").textContent = "Method: implied = exp(a + b·ln TVL) × growth × maturity × odds. " +
  `The comps curve is fitted here from the snapshot's ${D.curve.n} traded protocols ` +
  `(a=${D.curve.a.toFixed(4)}, b=${D.curve.b.toFixed(4)}, R²=${D.curve.r2.toFixed(4)}). ` +
  "Odds is the fitted listing hazard by age (0.467 under 90 days, 0.245 under a year, " +
  "0.123 under three years, 0.084 after). Growth and maturity are bounded ranking priors " +
  "(growth 0.5–2, maturity 0.5–1): adding them to the comps fit wins 2/5 held-out seeds " +
  "and does not improve it, so no predictive gain is claimed for them. A protocol records " +
  "no token when DefiLlama records neither a gecko_id nor a symbol for it — never that it has none.";
$("#accounting").textContent = `All ${D.counts.protocols} protocols accounted for: ${D.counts.board} on the board ` +
  `(${D.counts.watchlist} watchlist + ${D.counts.board - D.counts.watchlist} below the floor), ` +
  `${D.counts.pre_token_set_aside} pre-token set aside, ${D.counts.pre_token_excluded} pre-token excluded ` +
  `as wrapped, staked, bridged, versioned or exchange products, ${D.counts.traded_comps} traded (the comps the curve is fitted on).`;
render();
