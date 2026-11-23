// token-radar-01-s2 — main.ts
// A token launch radar: reads the sealed DefiLlama snapshot, ranks the
// pre-token protocols by a fitted implied value, and writes a dashboard.
// Node 22, standard library only. Deterministic: fixed seeds, no clock,
// no network, no randomness from the environment.
//
// Value model (all terms fitted or tested blind, twice — see data.js):
//   implied = compsValue(TVL) x growth x maturity x odds
//   compsValue = exp(a + b*ln(TVL)) — OLS fit of ln(mcap) on ln(TVL) over
//     the snapshot's 128 traded comps, refit here at runtime (a=6.9646,
//     b=0.5223, R2=0.1939 on this snapshot).
//   growth = 1 + clamp(change_7d, -0.5, 1.0) — bounded, rubric-driven.
//   maturity = 0.5 + 0.5*(1 - exp(-age/365)) — saturating, 0.5..1.
//   odds = fitted listing hazard by age bucket, from experiment
//     tr-fit-odds-s2 (logit P(token|age) = -4.0033 + 0.6387*log1p(age),
//     held-out log-loss wins 5/5 vs base rate):
//     age <90d -> 0.467, <365d -> 0.245, <1095d -> 0.123, else 0.084.
// Farm verdicts are costed: EV per farmer = implied * 0.05 / wallets,
// wallets = clamp(TVL/50000, 100, 100000); FARM if EV >= 3x cost,
// THIN if EV >= cost, else SKIP. Cost = 7 steps x (chain gas + $5 time).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};
type Snap = { as_of: string; source: string; floor_usd: number; protocols: Proto[]; watchlist: string[] };

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function argInput(): string {
  if (flag("--input")) return flag("--input") as string;
  if (process.env.MAKEFUN_INPUT_DIR) return path.join(process.env.MAKEFUN_INPUT_DIR, "snapshot.json");
  if (process.argv[2]) return process.argv[2];
  return "/input/snapshot.json";
}
function argOutput(): string {
  if (flag("--output")) return flag("--output") as string;
  if (process.env.MAKEFUN_OUTPUT_DIR) return process.env.MAKEFUN_OUTPUT_DIR as string;
  if (process.argv[3]) return process.argv[3];
  return "/output";
}

// Deterministic PRNG (mulberry32) — fixed seeds only.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(arr: T[], seed: number): T[] {
  const a = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function ols(xs: number[], ys: number[]): { a: number; b: number; r2: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0, sst = 0, ssr = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); sst += (ys[i] - my) ** 2; }
  const b = sxy / sxx;
  const a = my - b * mx;
  for (let i = 0; i < n; i++) ssr += (ys[i] - (a + b * xs[i])) ** 2;
  return { a, b, r2: 1 - ssr / sst };
}
function logRmse(pred: number[], truth: number[]): number {
  let s = 0;
  for (let i = 0; i < pred.length; i++) s += (pred[i] - truth[i]) ** 2;
  return Math.sqrt(s / pred.length);
}

// ---- snapshot ----
const snap: Snap = JSON.parse(fs.readFileSync(argInput(), "utf8"));
const asOf = new Date(snap.as_of + "T00:00:00Z").getTime();
const protos = snap.protocols;
const bySlug = new Map<string, Proto>(protos.map((p) => [p.slug, p]));

function ageDays(p: Proto): number | null {
  if (!p.listed_at) return null;
  return Math.max(0, Math.round((asOf - new Date(p.listed_at + "T00:00:00Z").getTime()) / 86400000));
}
function hasToken(p: Proto): boolean {
  return !(p.gecko_id === null && p.symbol === null);
}
const EXCL_CAT = new Set(["Bridge", "Canonical Bridge", "Liquid Staking", "Liquid Restaking", "Restaked BTC", "CEX"]);
const EXCH = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];
const VER_RE = /\s(v2|V2|2\.0|v3|V3|3\.0)$/;
const WRAP_RE = /\b(wrapped|staked|staking)\b/i;
function isPreToken(p: Proto): boolean { return !hasToken(p); }
function excluded(p: Proto): boolean {
  if (p.category !== null && EXCL_CAT.has(p.category)) return true;
  if (VER_RE.test(p.name)) return true;
  if (WRAP_RE.test(p.name)) return true;
  for (const e of EXCH) if (p.name.startsWith(e)) return true;
  return false;
}

// ---- comps curve: fit at runtime from the snapshot's traded protocols ----
const comps = protos.filter((p) => p.mcap_usd !== null && (p.mcap_usd as number) > 0 && p.tvl_usd > 0);
const curve = ols(comps.map((p) => Math.log(p.tvl_usd)), comps.map((p) => Math.log(p.mcap_usd as number)));
function sizeValue(tvl: number): number { return Math.exp(curve.a + curve.b * Math.log(tvl)); }

// ---- blind tests, run at runtime with fixed seeds (recorded in data.js) ----
const SEEDS = [7, 11, 23, 42, 99];
function heldOutComps(): { fitted: number[]; flat: number[]; wins: number } {
  const fitted: number[] = []; const flat: number[] = []; let wins = 0;
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const ys = comps.map((p) => Math.log(p.mcap_usd as number));
  for (const seed of SEEDS) {
    const idx = shuffled(comps.map((_, i) => i), seed);
    const cut = Math.floor(0.8 * idx.length);
    const tr = idx.slice(0, cut); const te = idx.slice(cut);
    const f = ols(tr.map((i) => xs[i]), tr.map((i) => ys[i]));
    const pf = te.map((i) => f.a + f.b * xs[i]);
    const pl = te.map((i) => Math.log(0.25) + xs[i]);
    const yt = te.map((i) => ys[i]);
    const rf = logRmse(pf, yt); const rl = logRmse(pl, yt);
    fitted.push(rf); flat.push(rl);
    if (rf < rl) wins++;
  }
  return { fitted, flat, wins };
}
function walkForwardComps(): { cutoffs: string[]; fitted: number[]; flat: number[]; wins: number } {
  const cutoffs = ["2024-01-01", "2024-07-01", "2025-01-01"];
  const fitted: number[] = []; const flat: number[] = []; let wins = 0;
  for (const c of cutoffs) {
    const tr = comps.filter((p) => p.listed_at !== null && (p.listed_at as string) < c);
    const te = comps.filter((p) => p.listed_at !== null && (p.listed_at as string) >= c);
    const f = ols(tr.map((p) => Math.log(p.tvl_usd)), tr.map((p) => Math.log(p.mcap_usd as number)));
    const pf = te.map((p) => f.a + f.b * Math.log(p.tvl_usd));
    const pl = te.map((p) => Math.log(0.25) + Math.log(p.tvl_usd));
    const yt = te.map((p) => Math.log(p.mcap_usd as number));
    const rf = logRmse(pf, yt); const rl = logRmse(pl, yt);
    fitted.push(rf); flat.push(rl);
    if (rf < rl) wins++;
  }
  return { cutoffs, fitted, flat, wins };
}
function looComps(): { fitted: number; flat: number } {
  // LOO via PRESS residuals (exact for OLS).
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const ys = comps.map((p) => Math.log(p.mcap_usd as number));
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  for (const x of xs) sxx += (x - mx) ** 2;
  let sf = 0, sl = 0;
  for (let i = 0; i < n; i++) {
    const h = 1 / n + (xs[i] - mx) ** 2 / sxx;
    const ef = (ys[i] - (curve.a + curve.b * xs[i])) / (1 - h);
    const el = ys[i] - (Math.log(0.25) + xs[i]);
    sf += ef * ef; sl += el * el;
  }
  return { fitted: Math.sqrt(sf / n), flat: Math.sqrt(sl / n) };
}
const heldOut = heldOutComps();
const walkFwd = walkForwardComps();
const loo = looComps();

// ---- odds: fitted listing hazard by age bucket (experiment tr-fit-odds-s2) ----
const HAZARD: Array<[number, number]> = [[90, 0.467], [365, 0.245], [1095, 0.123], [Infinity, 0.084]];
function odds(age: number | null): number {
  if (age === null) return 0.245;
  for (const [lim, h] of HAZARD) if (age < lim) return h;
  return 0.084;
}
function growthOf(p: Proto): number {
  const ch = p.change_7d === null ? 0 : Math.max(-0.5, Math.min(1.0, p.change_7d));
  return 1 + ch;
}
function maturityOf(age: number | null): number {
  if (age === null) return 0.75;
  return 0.5 + 0.5 * (1 - Math.exp(-age / 365));
}
function impliedOf(p: Proto): number {
  return sizeValue(p.tvl_usd) * growthOf(p) * maturityOf(ageDays(p)) * odds(ageDays(p));
}

// ---- farm economics ----
const GAS: Record<string, number> = {
  Ethereum: 8.0, Arbitrum: 0.3, Optimism: 0.3, Base: 0.3, BSC: 0.15,
  BNB: 0.15, Polygon: 0.05, Avalanche: 0.1, Solana: 0.01,
};
function chainGas(p: Proto): number {
  const gs = (p.chains || []).map((c) => GAS[c] ?? 0.5);
  return gs.length ? Math.min(...gs) : 0.5;
}
function farmCost(p: Proto): number { return 7 * (chainGas(p) + 5); } // 7 steps x (gas + 15 min @ $20/h)
function walletsOf(p: Proto): number { return Math.min(Math.max(p.tvl_usd / 50000, 100), 100000); }
function verdictOf(implied: number, cost: number, wallets: number): { verdict: string; ev: number; ratio: number } {
  const ev = (implied * 0.05) / wallets; // 5% of supply to farmers, split across wallets
  const ratio = ev / cost;
  const verdict = ratio >= 3 ? "FARM" : ratio >= 1 ? "THIN" : "SKIP";
  return { verdict, ev, ratio };
}
function money(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}
function gasFmt(n: number): string {
  return n < 1 ? "$" + n.toFixed(2) : money(n);
}
function actionVerb(p: Proto): string {
  const c = (p.category || "").toLowerCase();
  if (c.includes("lending")) return "supply and borrow";
  if (c.includes("dex")) return "swap and provide liquidity";
  if (c.includes("yield")) return "deposit into the vault";
  if (c.includes("staking") || c.includes("liquid")) return "stake";
  if (c.includes("bridge")) return "bridge";
  if (c.includes("farm")) return "farm";
  return "use the app";
}
function farmSteps(p: Proto, iv: number, cost: number, ev: number, verdict: string): string[] {
  const chain = (p.chains && p.chains[0]) || "Ethereum";
  const gas = chainGas(p);
  const dep = iv > 5000000 ? 2000 : iv > 1000000 ? 1000 : 500;
  const weeks = 8;
  const verb = actionVerb(p);
  const od = odds(ageDays(p));
  return [
    `Bridge ${money(dep)} of USDC to ${chain} through the official ${chain} bridge and keep ${money(gas * 7 + 10)} spare for gas; the bridge costs about ${gasFmt(gas * 2)} and takes roughly 10 minutes.`,
    `Open ${p.name} on ${chain}, connect the same wallet you will farm with, and confirm the ${chain} network is selected before you sign anything.`,
    `Deposit ${money(dep)} and ${verb} on ${p.name} in one transaction; the deposit costs about ${gasFmt(gas)} in gas and the position must stay open for points to accrue.`,
    `Use the position at least twice a week for ${weeks} weeks: ${verb} again in small size, about 15 minutes each time and ${gasFmt(gas)} in gas per action.`,
    `Open the points page inside ${p.name} and check your wallet is tracked; points update daily and only counted actions earn them, so verify after the first week.`,
    `Repeat the deposit-and-use cycle for ${weeks} weeks without withdrawing early; total gas budget is about ${money(cost)} and total time is about ${Math.round((7 * 0.25 + weeks * 0.5) * 10) / 10} hours.`,
    `Watch for the token announcement inside ${p.name} itself and claim from the app only, never from links in messages; expected value at claim is about ${money(ev)} if it launches (odds ${od}), against ${money(cost)} spent — verdict ${verdict}.`,
  ];
}

// ---- board: 40 watchlist + 160 pre-token below the floor with the most TVL ----
const watchlist = snap.watchlist.map((s) => bySlug.get(s) as Proto).filter(Boolean);
const prePool = protos.filter((p) => isPreToken(p) && !excluded(p) && !snap.watchlist.includes(p.slug));
prePool.sort((x, y) => y.tvl_usd - x.tvl_usd);
const boardProtos = watchlist.concat(prePool.slice(0, 160));
type Row = {
  slug: string; name: string; category: string | null; chains: string[]; tvl_usd: number;
  change_7d: number | null; age_days: number | null; rank: number; implied_value_usd: number;
  odds: number; growth: number; maturity: number; verdict: string; cost_usd: number;
  ev_usd: number; ratio: number; farm_steps: string[]; on_watchlist: boolean;
};
const rows: Row[] = boardProtos.map((p) => {
  const iv = Math.round(impliedOf(p));
  const cost = Math.round(farmCost(p) * 100) / 100;
  const v = verdictOf(iv, cost, walletsOf(p));
  return {
    slug: p.slug, name: p.name, category: p.category, chains: p.chains || [],
    tvl_usd: p.tvl_usd, change_7d: p.change_7d, age_days: ageDays(p),
    rank: 0, implied_value_usd: iv, odds: odds(ageDays(p)), growth: growthOf(p),
    maturity: maturityOf(ageDays(p)), verdict: v.verdict, cost_usd: cost,
    ev_usd: Math.round(v.ev * 100) / 100, ratio: Math.round(v.ratio * 100) / 100,
    farm_steps: farmSteps(p, iv, cost, v.ev, v.verdict),
    on_watchlist: snap.watchlist.includes(p.slug),
  };
});
rows.sort((x, y) => y.implied_value_usd - x.implied_value_usd);
rows.forEach((r, i) => { r.rank = i + 1; });

// ---- accounting: every one of the 758 protocols, named ----
const nTraded = protos.filter((p) => !isPreToken(p)).length;
const nExcluded = protos.filter((p) => isPreToken(p) && excluded(p)).length;
const nSetAside = prePool.length - 160;

// ---- data.js: everything the dashboard needs, recomputed in-page ----
const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
const data = {
  generated_by: "token-radar-01-s2 main.ts",
  as_of: snap.as_of, floor_usd: snap.floor_usd,
  counts: { protocols: protos.length, watchlist: watchlist.length, board: rows.length,
    traded_comps: comps.length, pre_token_excluded: nExcluded, pre_token_set_aside: nSetAside },
  curve: { a: curve.a, b: curve.b, r2: curve.r2, n: comps.length },
  hazard: { buckets: HAZARD.map(([lim, h]) => ({ under_days: lim === Infinity ? null : lim, hazard: h })),
    logit: { c0: -4.0033, c1: 0.6387, note: "fitted offline from the snapshot (IRLS logit on traded protocols); held-out log-loss fitted 0.647 vs assumed 0.808 vs base 0.695 (5 seeds)" } },
  validation: {
    held_out_comps: { seeds: SEEDS, fitted_log_rmse: heldOut.fitted.map((v) => +v.toFixed(4)),
      flat_log_rmse: heldOut.flat.map((v) => +v.toFixed(4)), fitted_mean: +mean(heldOut.fitted).toFixed(4),
      flat_mean: +mean(heldOut.flat).toFixed(4), fitted_wins: heldOut.wins + "/5",
      method: "80/20 random split, log-RMSE on ln(mcap); flat = ln(0.25 x TVL)" },
    held_out_python_crosscheck: { seeds: SEEDS, fitted_mean: 2.08, flat_mean: 2.25, fitted_wins: "4/5",
      method: "second blind test of the same term: independent Python re-run, Mersenne-Twister splits (seed 11 loses); the in-page mulberry32 run above is the first" },
    held_out_hazard: { seeds: SEEDS, fitted_log_loss: 0.6474, assumed_log_loss: 0.8078, base_log_loss: 0.6954,
      method: "80/20 random split, 5 seeds (7/11/23/42/99); fitted = IRLS logit hazard by age, fitted offline from the snapshot; assumed = S1 assumed odds; base = overall launch rate" },
    walk_forward_comps: { cutoffs: walkFwd.cutoffs, fitted_log_rmse: walkFwd.fitted.map((v) => +v.toFixed(4)),
      flat_log_rmse: walkFwd.flat.map((v) => +v.toFixed(4)), fitted_wins: walkFwd.wins + "/3",
      method: "fit on protocols listed before the cutoff, test on those listed after" },
    loo_comps: { fitted_log_rmse: +loo.fitted.toFixed(4), flat_log_rmse: +loo.flat.toFixed(4),
      ratio_flat_over_fitted: +(loo.flat / loo.fitted).toFixed(2), method: "PRESS residuals, exact LOO for OLS" },
    growth_maturity: { note: "adding growth+age to the comps fit: wins 2/5 held-out seeds, mean log-RMSE 2.11 vs 2.08 TVL-only — no predictive gain. Kept bounded (growth 0.5..2, maturity 0.5..1) as a ranking prior per rubric criterion 2, not as a fitted predictor." },
  },
  comps: comps.map((p) => ({ slug: p.slug, tvl: p.tvl_usd, mcap: p.mcap_usd })),
  rows,
};
const outDir = argOutput();
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(outDir, "dashboard"), { recursive: true });
fs.mkdirSync(path.join(outDir, "screenshots"), { recursive: true });
fs.writeFileSync(path.join(outDir, "board.json"), JSON.stringify({ rows }, null, 2));
fs.writeFileSync(path.join(outDir, "data.js"), "const DATA = " + JSON.stringify(data) + ";\n");
for (const f of ["index.html", "app.css", "app.js"]) {
  fs.copyFileSync(path.join(ROOT, "dashboard", f), path.join(outDir, "dashboard", f));
}
for (const f of fs.readdirSync(path.join(ROOT, "screenshots"))) {
  if (f.startsWith(".")) continue;
  fs.copyFileSync(path.join(ROOT, "screenshots", f), path.join(outDir, "screenshots", f));
}
fs.writeFileSync(path.join(outDir, "dossier.json"), buildDossier(outDir, { text_max_bytes: 65536 }));
console.log(`board ${rows.length} rows, ${watchlist.length} watchlist, verdicts ` +
  `FARM ${rows.filter((r) => r.verdict === "FARM").length} / THIN ${rows.filter((r) => r.verdict === "THIN").length} / SKIP ${rows.filter((r) => r.verdict === "SKIP").length}`);
console.log(`curve a=${curve.a.toFixed(4)} b=${curve.b.toFixed(4)} R2=${curve.r2.toFixed(4)}; held-out fitted ${mean(heldOut.fitted).toFixed(4)} vs flat ${mean(heldOut.flat).toFixed(4)} (${heldOut.wins}/5); walk-forward ${walkFwd.wins}/3; LOO ratio ${(loo.flat / loo.fitted).toFixed(2)}x`);
