// Token Launch Radar model (radar-3): one sealed DefiLlama snapshot in, one ranked board out.
//
// radar-3 replaces radar-2's hand-set factors with two fitted models, each term kept or dropped
// by two held-out tests run on the snapshot itself, and it prices a launch the way the snapshot's
// own record supports:
//
//   launch value   what a token would be worth if this protocol issued one. A curve is fitted on
//                  the snapshot's traded tokens (the comps: a recorded cap above $0, a TVL, a
//                  listing date, exchange books left out): ln cap = a + b x ln(TVL / $100M),
//                  plus one offset per category, shrunk toward the curve by a pseudo-count the
//                  leave-one-out test chooses. Growth, age and chain count were each tested as
//                  extra terms and are used only if both tests keep them (on this snapshot the
//                  value tests keep none of them; the ladder is printed in the dashboard).
//   token odds     the chance a protocol that has run this long with no token records one in
//                  the next 24 months, from the peers' record: a logistic fit on every dated
//                  protocol (age, size, and its category's token share) gives G(a), the share
//                  of peers recording a token by age a, and the odds are the conditional
//                  [G(a + 2y) - G(a)] / [1 - G(a)]. Scored by Brier, ten-fold and walk-forward,
//                  against the base rate, and printed.
//   implied value  launch value x token odds. Every figure carries the range the held-out
//                  residuals support: P25-P75 and P10-P90 conformal bands on the launch value,
//                  with their measured coverage of real caps printed beside them.
//   verdict        each row is farmed on paper at a stated scenario (a deposit sized to the
//                  protocol, a 7% drop share, 12 weeks): drop = implied x share x deposit /
//                  (TVL + deposit), charged the plan's own fees and a 2%-a-year capital charge.
//                  FARM nets more than a 4% T-bill and $25 an hour; MARGINAL nets above zero;
//                  SKIP loses money. The reader can move the scenario; the model does not move.
//
// Held-out protocol, identical for every candidate: leave-one-out over the comps, and
// walk-forward (protocols listed earlier price those listed later, expanding window). A term
// is kept only when it lowers the miss in both tests by at least 0.3%. The miss is the median
// absolute log error, printed as a xfactor. Everything is a pure function of the snapshot:
// same snapshot in, same board out, byte for byte.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label, named in the dashboard and in every board row's breakdown. */
export const MODEL_VERSION = 'radar-3';

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const TVL_REF = 100_000_000;
const SHRINK_GRID = [8, 16, 32, 64];
const KEEP_MARGIN = 0.997; // a term must beat the current model by 0.3% in both tests
const WF_MIN_TRAIN = 25; // walk-forward starts once this many earlier comps exist
const ODDS_WF_START = 120; // walk-forward for the odds fit starts here, refit every 20
const ODDS_HORIZON_YEARS = 2; // the odds look 24 months ahead
const BOOTSTRAP_REFITS = 200;
const BOOTSTRAP_SEED = 0x5eed1234;
const DROP_SHARE = 0.07;
const HORIZON_WEEKS = 12;
const CAPITAL_CHARGE = 0.02; // a year
const TBILL_RATE = 0.04; // a year
const FARM_HOUR_BAR = 25; // dollars an hour

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A whole day count from listing to the snapshot's date, clamped at zero; null when unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function quantile(sortedAsc: number[], f: number): number {
  return sortedAsc[clamp(Math.floor(f * sortedAsc.length), 0, sortedAsc.length - 1)]!;
}

/** A deterministic PRNG (mulberry32) so the bootstrap refits are the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Least squares by the normal equations, solved with Gauss-Jordan and partial pivoting. */
function ols(X: number[][], y: number[]): number[] {
  const k = X[0]!.length;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      b[a] += X[i]![a]! * y[i]!;
      for (let c = 0; c < k; c++) A[a]![c] += X[i]![a]! * X[i]![c]!;
    }
  }
  for (let a = 0; a < k; a++) A[a]![a] += 1e-9;
  for (let col = 0, row = 0; col < k && row < k; col++, row++) {
    let piv = row;
    for (let r = row + 1; r < k; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    const tmpA = A[row]!; A[row] = A[piv]!; A[piv] = tmpA;
    const tmpB = b[row]!; b[row] = b[piv]!; b[piv] = tmpB;
    const d = A[row]![col]!;
    for (let r = 0; r < k; r++) {
      if (r === row) continue;
      const f = A[r]![col]! / d;
      for (let c = col; c < k; c++) A[r]![c] -= f * A[row]![c]!;
      b[r] -= f * b[row]!;
    }
  }
  return b.map((v, i) => v / A[i]![i]!);
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const PRODUCT_CATEGORIES: ReadonlySet<string> = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whether a protocol is one the board may rank: pre-token, and not a product of a traded asset. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name) || WRAPPED_WORD.test(p.name) || EXCHANGE_NAME.test(p.name)) return false;
  return true;
}

/** A priced comparable: a recorded cap above $0, a TVL, a listing date, and not an exchange book. */
export function isComp(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX' && p.listed_at !== null;
}

/** The accounting group a protocol falls into: every protocol of the snapshot in exactly one. */
export function accountGroup(p: SnapshotProtocol, watch: ReadonlySet<string>): string {
  if (!isPreToken(p)) return isComp(p) ? 'comp' : 'token-unpriced';
  if (isRankable(p)) return watch.has(p.slug) ? 'ranked-watchlist' : 'ranked-early';
  if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'out-bridge';
  if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC') return 'out-staking';
  if (p.category === 'CEX' || EXCHANGE_NAME.test(p.name)) return 'out-exchange';
  return 'out-versioned';
}

// ---------------------------------------------------------------- the launch-value fit

type LaunchTerm = 'growth' | 'age' | 'chains';
const LAUNCH_TERMS: readonly LaunchTerm[] = ['growth', 'age', 'chains'];
export const LAUNCH_TERM_LABEL: Record<LaunchTerm, string> = {
  growth: '+ 7-day TVL growth',
  age: '+ age, years listed',
  chains: '+ chain count, ln',
};

function launchFeatures(p: SnapshotProtocol, asOf: string, terms: readonly LaunchTerm[]): number[] {
  const f = [1, Math.log(p.tvl_usd / TVL_REF)];
  for (const t of terms) {
    if (t === 'growth') f.push(clamp(p.change_7d ?? 0, -50, 100) / 100);
    else if (t === 'age') f.push(Math.log(1 + (ageDays(asOf, p.listed_at) ?? 0) / 365.25));
    else f.push(Math.log(Math.max(1, p.chains.length)));
  }
  return f;
}

interface LaunchFit {
  beta: number[];
  catOff: Map<string, number>;
  catN: Map<string, number>;
  shrink: number;
  terms: readonly LaunchTerm[];
}

function fitLaunch(train: SnapshotProtocol[], asOf: string, terms: readonly LaunchTerm[], shrink: number): LaunchFit {
  const X = train.map((p) => launchFeatures(p, asOf, terms));
  const y = train.map((p) => Math.log(p.mcap_usd!));
  const beta = ols(X, y);
  const resid = new Map<string, number[]>();
  train.forEach((p, i) => {
    const r = y[i]! - X[i]!.reduce((a, v, j) => a + v * beta[j]!, 0);
    const key = p.category ?? 'Uncategorised';
    const list = resid.get(key);
    if (list === undefined) resid.set(key, [r]);
    else list.push(r);
  });
  const catOff = new Map<string, number>();
  const catN = new Map<string, number>();
  for (const [key, list] of resid) {
    catOff.set(key, (list.length / (list.length + shrink)) * (list.reduce((a, v) => a + v, 0) / list.length));
    catN.set(key, list.length);
  }
  return { beta, catOff, catN, shrink, terms };
}

function predictLaunch(fit: LaunchFit, p: SnapshotProtocol, asOf: string): number {
  const x = launchFeatures(p, asOf, fit.terms);
  const base = x.reduce((a, v, j) => a + v * fit.beta[j]!, 0);
  return Math.exp(base + (fit.catOff.get(p.category ?? 'Uncategorised') ?? 0));
}

/** The held-out misses of one launch specification: leave-one-out and walk-forward x-factors. */
function evalLaunch(comps: SnapshotProtocol[], asOf: string, terms: readonly LaunchTerm[], shrink: number): { loo: number; wf: number; looErrs: number[] } {
  const looErrs: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    looErrs.push(Math.log(predictLaunch(fitLaunch(train, asOf, terms, shrink), comps[i]!, asOf) / comps[i]!.mcap_usd!));
  }
  const sorted = [...comps].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const wfErrs: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const train = sorted.slice(0, i);
    if (train.length < WF_MIN_TRAIN) continue;
    wfErrs.push(Math.log(predictLaunch(fitLaunch(train, asOf, terms, shrink), sorted[i]!, asOf) / sorted[i]!.mcap_usd!));
  }
  const miss = (errs: number[]): number => Math.exp(median(errs.map(Math.abs)));
  return { loo: miss(looErrs), wf: miss(wfErrs), looErrs };
}

/** The flat baseline every ladder starts from: one geometric-median multiple for the whole market. */
function evalFlat(comps: SnapshotProtocol[]): { loo: number; wf: number } {
  const mult = (train: SnapshotProtocol[]): number => Math.exp(median(train.map((p) => Math.log(p.mcap_usd! / p.tvl_usd))));
  const looErrs = comps.map((c, i) => Math.log((c.tvl_usd * mult(comps.filter((_, j) => j !== i))) / c.mcap_usd!));
  const sorted = [...comps].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const wfErrs: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const train = sorted.slice(0, i);
    if (train.length < WF_MIN_TRAIN) continue;
    wfErrs.push(Math.log((sorted[i]!.tvl_usd * mult(train)) / sorted[i]!.mcap_usd!));
  }
  const miss = (errs: number[]): number => Math.exp(median(errs.map(Math.abs)));
  return { loo: miss(looErrs), wf: miss(wfErrs) };
}

export interface LadderRow {
  label: string;
  first: number; // leave-one-out (value) or ten-fold (odds)
  second: number; // walk-forward
  verdict: string; // 'baseline' | 'kept' | 'tested, not kept'
}

/** Fit the launch model, choosing the shrinkage by leave-one-out and each term by both tests. */
function selectLaunchModel(comps: SnapshotProtocol[], asOf: string): { fit: LaunchFit; ladder: LadderRow[]; looErrs: number[]; loo: number; wf: number } {
  const ladder: LadderRow[] = [];
  const flat = evalFlat(comps);
  ladder.push({ label: 'flat median multiple of TVL', first: round2(flat.loo), second: round2(flat.wf), verdict: 'baseline' });
  const curve = evalLaunch(comps, asOf, [], 0);
  ladder.push({ label: '+ size curve, ln TVL', first: round2(curve.loo), second: round2(curve.wf), verdict: 'kept' });
  let bestShrink = SHRINK_GRID[1]!;
  let best = evalLaunch(comps, asOf, [], bestShrink);
  for (const m of SHRINK_GRID) {
    const e = evalLaunch(comps, asOf, [], m);
    if (e.loo < best.loo) { best = e; bestShrink = m; }
  }
  ladder.push({ label: `+ category effect, shrunk by ${bestShrink} pseudo-observations`, first: round2(best.loo), second: round2(best.wf), verdict: 'kept' });
  let terms: LaunchTerm[] = [];
  let current = best;
  for (const t of LAUNCH_TERMS) {
    const e = evalLaunch(comps, asOf, [...terms, t], bestShrink);
    const keep = e.loo < current.loo * KEEP_MARGIN && e.wf < current.wf * KEEP_MARGIN;
    ladder.push({ label: LAUNCH_TERM_LABEL[t], first: round2(e.loo), second: round2(e.wf), verdict: keep ? 'kept' : 'tested, not kept' });
    if (keep) { terms = [...terms, t]; current = e; }
  }
  return { fit: fitLaunch(comps, asOf, terms, bestShrink), ladder, looErrs: current.looErrs, loo: current.loo, wf: current.wf };
}

// ---------------------------------------------------------------- the token-odds fit

type OddsTerm = 'growth' | 'chains';
const ODDS_TERMS: readonly OddsTerm[] = ['growth', 'chains'];
export const ODDS_TERM_LABEL: Record<OddsTerm, string> = { growth: '+ 7-day TVL growth', chains: '+ chain count, ln' };

interface OddsFit {
  w: number[];
  b: number;
  mean: number[];
  sd: number[];
  terms: readonly OddsTerm[];
  catShare: Map<string, number>;
  globalShare: number;
}

function categoryShares(pop: SnapshotProtocol[]): { catShare: Map<string, number>; globalShare: number } {
  const globalShare = pop.filter((p) => !isPreToken(p)).length / pop.length;
  const byCat = new Map<string, SnapshotProtocol[]>();
  for (const p of pop) {
    const key = p.category ?? 'Uncategorised';
    const list = byCat.get(key);
    if (list === undefined) byCat.set(key, [p]);
    else list.push(p);
  }
  const catShare = new Map<string, number>();
  for (const [key, list] of byCat) {
    catShare.set(key, (list.filter((p) => !isPreToken(p)).length + 20 * globalShare) / (list.length + 20));
  }
  return { catShare, globalShare };
}

function oddsFeatures(p: SnapshotProtocol, asOf: string, catShare: Map<string, number>, globalShare: number, terms: readonly OddsTerm[], ageYears?: number): number[] {
  const age = ageYears ?? (ageDays(asOf, p.listed_at) ?? 0) / 365.25;
  const f = [Math.log(1 + age), Math.log(p.tvl_usd / TVL_REF), catShare.get(p.category ?? 'Uncategorised') ?? globalShare];
  for (const t of terms) {
    if (t === 'growth') f.push(clamp(p.change_7d ?? 0, -50, 100) / 100);
    else f.push(Math.log(Math.max(1, p.chains.length)));
  }
  return f;
}

/** Logistic regression by fixed-iteration gradient descent on standardised features: deterministic. */
function fitLogit(train: SnapshotProtocol[], asOf: string, catShare: Map<string, number>, globalShare: number, terms: readonly OddsTerm[]): OddsFit {
  const X = train.map((p) => oddsFeatures(p, asOf, catShare, globalShare, terms));
  const y = train.map((p) => (isPreToken(p) ? 0 : 1));
  const k = X[0]!.length;
  const mean = new Array<number>(k).fill(0);
  const sd = new Array<number>(k).fill(1);
  for (let j = 0; j < k; j++) {
    mean[j] = X.reduce((a, r) => a + r[j]!, 0) / X.length;
    const v = X.reduce((a, r) => a + (r[j]! - mean[j]!) ** 2, 0) / X.length;
    sd[j] = Math.sqrt(v) || 1;
  }
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]!) / sd[j]!));
  const pos = y.reduce((a, v) => a + v, 0);
  let b = Math.log((pos + 1) / (y.length - pos + 1));
  const w = new Array<number>(k).fill(0);
  for (let it = 0; it < 800; it++) {
    const gw = new Array<number>(k).fill(0);
    let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      const z = Z[i]!.reduce((a, v, j) => a + v * w[j]!, b);
      const d = 1 / (1 + Math.exp(-z)) - y[i]!;
      gb += d;
      for (let j = 0; j < k; j++) gw[j] += d * Z[i]![j]!;
    }
    for (let j = 0; j < k; j++) w[j] -= 0.1 * (gw[j]! / Z.length + 1e-4 * w[j]!);
    b -= 0.1 * (gb / Z.length);
  }
  return { w, b, mean, sd, terms, catShare, globalShare };
}

function predictShare(fit: OddsFit, p: SnapshotProtocol, asOf: string, ageYears?: number): number {
  const f = oddsFeatures(p, asOf, fit.catShare, fit.globalShare, fit.terms, ageYears);
  const z = f.reduce((a, v, j) => a + ((v - fit.mean[j]!) / fit.sd[j]!) * fit.w[j]!, fit.b);
  return 1 / (1 + Math.exp(-z));
}

/** The odds of a token within the horizon, given none by the protocol's current age. */
function oddsWithin(fit: OddsFit, p: SnapshotProtocol, asOf: string, ageYears: number): { odds: number; shareNow: number; shareLater: number } {
  const shareNow = predictShare(fit, p, asOf, ageYears);
  const shareLater = predictShare(fit, p, asOf, ageYears + ODDS_HORIZON_YEARS);
  const odds = clamp((shareLater - shareNow) / Math.max(1e-9, 1 - shareNow), 0.01, 0.97);
  return { odds, shareNow, shareLater };
}

function evalOdds(pop: SnapshotProtocol[], asOf: string, catShare: Map<string, number>, globalShare: number, terms: readonly OddsTerm[]): { tenfold: number; wf: number } {
  const idx = [...pop.keys()].sort((a, b) => (pop[a]!.slug < pop[b]!.slug ? -1 : 1));
  let brier = 0;
  for (let fold = 0; fold < 10; fold++) {
    const test = idx.filter((_, i) => i % 10 === fold);
    const train = idx.filter((_, i) => i % 10 !== fold).map((i) => pop[i]!);
    const fit = fitLogit(train, asOf, catShare, globalShare, terms);
    for (const i of test) brier += (predictShare(fit, pop[i]!, asOf) - (isPreToken(pop[i]!) ? 0 : 1)) ** 2;
  }
  const sorted = [...pop].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  let wb = 0;
  let wn = 0;
  for (let start = ODDS_WF_START; start < sorted.length; start += 20) {
    const fit = fitLogit(sorted.slice(0, start), asOf, catShare, globalShare, terms);
    for (let i = start; i < Math.min(start + 20, sorted.length); i++) {
      wb += (predictShare(fit, sorted[i]!, asOf) - (isPreToken(sorted[i]!) ? 0 : 1)) ** 2;
      wn++;
    }
  }
  return { tenfold: brier / pop.length, wf: wb / wn };
}

function evalOddsBase(pop: SnapshotProtocol[]): { tenfold: number; wf: number } {
  const idx = [...pop.keys()].sort((a, b) => (pop[a]!.slug < pop[b]!.slug ? -1 : 1));
  let brier = 0;
  for (let fold = 0; fold < 10; fold++) {
    const test = idx.filter((_, i) => i % 10 === fold);
    const train = idx.filter((_, i) => i % 10 !== fold).map((i) => pop[i]!);
    const share = train.filter((p) => !isPreToken(p)).length / train.length;
    for (const i of test) brier += (share - (isPreToken(pop[i]!) ? 0 : 1)) ** 2;
  }
  const sorted = [...pop].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  let wb = 0;
  let wn = 0;
  for (let start = ODDS_WF_START; start < sorted.length; start += 20) {
    const share = sorted.slice(0, start).filter((p) => !isPreToken(p)).length / start;
    for (let i = start; i < Math.min(start + 20, sorted.length); i++) {
      wb += (share - (isPreToken(sorted[i]!) ? 0 : 1)) ** 2;
      wn++;
    }
  }
  return { tenfold: brier / pop.length, wf: wb / wn };
}

/** Fit the odds model on every dated protocol, testing each extra term by both Brier tests. */
function selectOddsModel(pop: SnapshotProtocol[], asOf: string): { fit: OddsFit; ladder: LadderRow[]; tenfold: number; wf: number; baseTenfold: number; baseWf: number } {
  const { catShare, globalShare } = categoryShares(pop);
  const ladder: LadderRow[] = [];
  const base = evalOddsBase(pop);
  ladder.push({ label: 'base rate of peers', first: round4(base.tenfold), second: round4(base.wf), verdict: 'baseline' });
  let terms: OddsTerm[] = [];
  let current = evalOdds(pop, asOf, catShare, globalShare, terms);
  ladder.push({ label: 'age, size and category share', first: round4(current.tenfold), second: round4(current.wf), verdict: 'kept' });
  for (const t of ODDS_TERMS) {
    const e = evalOdds(pop, asOf, catShare, globalShare, [...terms, t]);
    const keep = e.tenfold < current.tenfold * KEEP_MARGIN && e.wf < current.wf * KEEP_MARGIN;
    ladder.push({ label: ODDS_TERM_LABEL[t], first: round4(e.tenfold), second: round4(e.wf), verdict: keep ? 'kept' : 'tested, not kept' });
    if (keep) { terms = [...terms, t]; current = e; }
  }
  return { fit: fitLogit(pop, asOf, catShare, globalShare, terms), ladder, tenfold: current.tenfold, wf: current.wf, baseTenfold: base.tenfold, baseWf: base.wf };
}

// ---------------------------------------------------------------- farm plans and verdicts
//
// A farm plan is nine tagged steps. Each step carries its own dollar cost and hands-on minutes,
// split into a fixed part (paid once) and a weekly part (paid every week of the horizon), so the
// dashboard can re-price the plan at any horizon the reader picks. The plan's actions come from
// the protocol's category, its wallet and gas from its first chain, its size from the scenario
// deposit. The board's farm_steps strings are these steps rendered at the default scenario.

export interface PlanStep {
  tag: string;
  text: string;
  cost_fixed: number;
  cost_weekly: number;
  minutes_fixed: number;
  minutes_weekly: number;
}

/** A tiny stable hash of a slug, for deterministic phrasing choices. */
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(options: readonly T[], seed: number, salt: number): T {
  return options[(seed + salt) % options.length]!;
}

const EVM_CHAINS: ReadonlySet<string> = new Set(['Ethereum', 'Arbitrum', 'Base', 'Optimism', 'Polygon', 'BSC', 'Avalanche', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Blast', 'Mode', 'Fantom', 'Gnosis', 'Celo', 'Moonbeam', 'Aurora', 'Fraxtal', 'Sonic', 'Berachain', 'Unichain', 'Ink', 'Soneium', 'Abstract', 'Corn', 'Plume', 'Hemi', 'World Chain', 'Zircuit', 'Taiko', 'Manta', 'Metis', 'Boba', 'Fuse', 'Kava', 'Cronos', 'Moonriver', 'Harmony', 'Astar', 'X Layer', 'Bob', 'Core', 'Bitlayer', 'Merlin', 'BSquared']);

/** What one transaction costs on a chain, in dollars: the plan's gas arithmetic. */
function txCost(chain: string): number {
  if (chain === 'Solana' || chain === 'Bittensor' || chain === 'Stellar') return 0.05;
  if (chain === 'Ethereum') return 3.2;
  if (chain === 'Bitcoin') return 2.0;
  if (EVM_CHAINS.has(chain)) return 0.15;
  return 0.8;
}

/** The deposit the default scenario farms with: 0.02% of TVL, held between $100 and $25,000. */
export function planDeposit(tvl: number): number {
  return Math.round(clamp(0.0002 * tvl, 100, 25_000));
}

/** The category's main action and its follow-up action, in words a farmer can follow. */
function actionsFor(p: SnapshotProtocol, chain: string, seed: number): [string, string, string] {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const second = p.chains.length > 1 ? p.chains[1]! : chain;
  if (c.includes('lend') || c.includes('cdp') || c.includes('uncollateralized')) {
    return ['Supply USDC to the busiest market and keep the supply position open', `Supply the deposit to ${name} on ${chain}; a supply position is the activity points programmes count first.`, 'Borrow about 30% against the supply and re-supply it once, then repay within the week so the loop reads as use, not leverage.'];
  }
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return ['Liquidity and swaps', `Add the deposit as liquidity to ${name}'s busiest stable or majors pool on ${chain} and keep the LP position open.`, `Route your weekly swaps through ${name} itself rather than an aggregator, so the volume is recorded on the protocol.`];
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options')) {
    return ['Margin and one hedged position', `Deposit the funds as margin on ${name} and open one small, hedged position you can hold for days.`, 'Place a second, different order type (a limit order or a vault deposit) so your activity is not one repeated trade.'];
  }
  if (c.includes('yield') || c.includes('farm') || c.includes('leveraged')) {
    return ['Vault deposit', `Deposit into ${name}'s main vault on ${chain} and keep the vault shares in the farm wallet.`, 'Compound the yield once a week by re-depositing it, which leaves a steady trail of on-chain interactions.'];
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('collateral')) {
    return ['Curated vault', `Deposit into a ${name} curated vault on ${chain}; pick the vault with the most depositors, not the highest rate.`, `Move a small part of the position to a second ${name} vault after two weeks, so you hold two distinct positions.`];
  }
  if (c.includes('restak') || c.includes('staking') || c.includes('basis')) {
    return ['Stake and hold the receipt', `Stake the deposit's worth of the underlying asset through ${name} on ${chain} and keep the receipt token in the farm wallet.`, `Use the receipt in one partner integration ${name} lists (a money market or a vault) to add a second layer of activity.`];
  }
  if (c.includes('rwa') || c.includes('stable') || c.includes('algo')) {
    return ['Mint and hold the asset', `Mint or deposit into ${name}'s yield-bearing asset on ${chain} and hold it rather than trading out.`, 'Make one redemption and one fresh mint a month apart, so both sides of the product appear in your history.'];
  }
  if (c.includes('prediction')) {
    return ['Small positions, held to settlement', 'Fund the account and take small positions in three different markets, sized so none can hurt.', 'Hold at least one position to settlement instead of closing early; settled positions are the record that counts.'];
  }
  if (c.includes('insurance')) {
    return ['Buy cover and keep it', `Buy cover from ${name} on ${chain} for an asset you actually hold, and keep the policy to expiry.`, 'Renew the cover once when it lapses, so the protocol records a returning customer, not a one-off.'];
  }
  if (c.includes('launchpad') || c.includes('index')) {
    return ['Commit to the next round', `Commit through ${name} on ${chain} in its next open round or index basket and hold what it allocates.`, 'Take part in the following round as well; two separate rounds read as a participant, not a passer-by.'];
  }
  if (c.includes('payments') || c.includes('card')) {
    return ['Activate and pay weekly', 'Activate the account with the deposit and route one real payment or card purchase a week through it.', 'Keep a balance between payments; an account that only passes through once is easy to filter out.'];
  }
  return ['Deposit and use the core action', `Deposit USDC into ${name} on ${chain} and keep the position open; idle balances earn nothing here.`, pick([`Repeat the core action on ${second} as well if ${name} runs there, so the farm is not a single-chain footprint.`, 'Add a second, smaller position a week later rather than one deposit and silence.', `Try the one feature of ${name} most users skip; varied usage is what survives a sybil screen.`], seed, 5)];
}

/** The nine steps of one protocol's farm plan, at the scenario deposit. */
export function farmPlan(p: SnapshotProtocol, deposit: number): { kind: string; steps: PlanStep[] } {
  const seed = hashOf(p.slug);
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const tx = txCost(chain);
  const [kind, core, deepen] = actionsFor(p, chain, seed);
  const walletKind =
    chain === 'Solana'
      ? 'a Solana wallet (Phantom or Solflare)'
      : chain === 'Bitcoin'
        ? 'a Bitcoin wallet with a separate receiving address'
        : EVM_CHAINS.has(chain)
          ? 'a fresh EVM wallet'
          : `a wallet that supports ${chain}`;
  const cadenceVerb = (p.category ?? '').toLowerCase().includes('lend')
    ? 'a small top-up deposit or a partial repay'
    : (p.category ?? '').toLowerCase().includes('dex')
      ? 'a swap in the pool you farm, however small'
      : 'one qualifying action (a top-up, a swap, a claim or a vote)';
  const exitMove = (p.category ?? '').toLowerCase().includes('lend') || (p.category ?? '').toLowerCase().includes('cdp')
    ? 'Repay any open borrow in full first, or the withdrawal will fail'
    : (p.category ?? '').toLowerCase().includes('staking') || (p.category ?? '').toLowerCase().includes('restak')
      ? 'Start the unstake early: the unbonding period runs whether or not a claim window is open when it ends'
      : 'Withdraw in two tranches a few days apart, so one failed transaction never strands the whole position';
  const steps: PlanStep[] = [
    { tag: 'SETUP', text: pick([`Create ${walletKind} dedicated to this farm and fund it from an exchange withdrawal, never from your main wallet.`, `Set up ${walletKind} used only for ${p.name}, so its activity is clean and its risk is capped at what you deposit.`, `Open ${walletKind} for this position alone and write its seed phrase on paper before you send it a cent.`], seed, 0), cost_fixed: 3.2, cost_weekly: 0, minutes_fixed: 10, minutes_weekly: 0 },
    { tag: 'VERIFY', text: `Reach ${p.name} from its DefiLlama page or its official accounts, bookmark the app and match the contract addresses against its docs. Never sign an approval from a link sent in a DM.`, cost_fixed: 0, cost_weekly: 0, minutes_fixed: 5, minutes_weekly: 0 },
    { tag: 'FUND', text: `Move $${deposit.toLocaleString('en-US')} of USDC to the farm wallet on ${chain} from an exchange that supports it, or bridge it from Ethereum with a large bridge that lists ${chain}. Start with a $100 test if this is your first position here, then send the rest.`, cost_fixed: 1.0, cost_weekly: 0, minutes_fixed: 10, minutes_weekly: 0 },
    { tag: 'RISK', text: `Read ${p.name}'s strategy and risk pages before the deposit lands: a vault or pool stacks other protocols beneath it, so any of them can fail. The deposit is the capital at risk; never loop it more than once.`, cost_fixed: 0, cost_weekly: 0, minutes_fixed: 10, minutes_weekly: 0 },
    { tag: 'CORE', text: core, cost_fixed: round2(2 * tx), cost_weekly: 0, minutes_fixed: 15, minutes_weekly: 0 },
    { tag: 'DEEPEN', text: deepen, cost_fixed: round2(tx), cost_weekly: 0, minutes_fixed: 10, minutes_weekly: 0 },
    { tag: 'CADENCE', text: `Touch the position once a week (${cadenceVerb}) so the wallet shows steady use rather than one deposit. ${p.change_7d !== null && p.change_7d >= 20 ? `${p.name}'s TVL is growing fast this week; momentum phases are when points snapshots are usually taken, so do not skip a week.` : p.change_7d !== null && p.change_7d <= -15 ? `TVL is shrinking this week, so keep the cadence but not the size, and re-check the position's health each time.` : 'A steady rhythm reads as a user; a burst reads as a script.'}`, cost_fixed: 0, cost_weekly: round2(tx), minutes_fixed: 0, minutes_weekly: 5 },
    { tag: 'WATCH', text: `Check ${p.name}'s announcements and TVL weekly. Exit early if TVL prints 30% below today's, if withdrawals pause, or if a token is recorded: claim only from a link ${p.name} itself publishes, and never pay anyone to claim for you.`, cost_fixed: 0, cost_weekly: 0, minutes_fixed: 0, minutes_weekly: 5 },
    { tag: 'EXIT', text: `${exitMove}. Keep a ledger from the first transaction: date, hash, asset, amount and dollar value of every top-up, claim and withdrawal; a claim may ask the wallet to prove its history.`, cost_fixed: round2(2 * tx), cost_weekly: 0, minutes_fixed: 20, minutes_weekly: 2 },
  ];
  return { kind, steps };
}

/** One step rendered as a board.json farm_steps string, at a stated horizon. */
function stepText(step: PlanStep, weeks: number): string {
  const cost = step.cost_fixed + step.cost_weekly * weeks;
  const minutes = step.minutes_fixed + step.minutes_weekly * weeks;
  const costText = cost <= 0 ? 'free' : `$${cost.toFixed(2)}`;
  const timeText = step.cost_weekly > 0 || step.minutes_weekly > 0 ? `${minutes} minutes over ${weeks} weeks` : `${minutes} minutes`;
  const s = `${step.text} Cost: ${costText}. Time: ${timeText}.`;
  return s.length > 600 ? `${s.slice(0, 596)}...` : s;
}

export interface Verdict {
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  deposit: number;
  drop: number;
  fees: number;
  charge: number;
  tbill: number;
  net: number;
  hours: number;
  per_hour: number;
}

/** The farm verdict of one row at a scenario: the arithmetic the dashboard re-runs live. */
export function verdictFor(implied: number, tvl: number, steps: PlanStep[], deposit: number, share: number, weeks: number): Verdict {
  const fees = steps.reduce((a, s) => a + s.cost_fixed + s.cost_weekly * weeks, 0);
  const minutes = steps.reduce((a, s) => a + s.minutes_fixed + s.minutes_weekly * weeks, 0);
  const hours = Math.max(minutes / 60, 0.05);
  const drop = (implied * share * deposit) / (tvl + deposit);
  const charge = CAPITAL_CHARGE * deposit * (weeks / 52);
  const tbill = TBILL_RATE * deposit * (weeks / 52);
  const net = drop - fees - charge;
  const perHour = net / hours;
  const verdict = net > 0 && perHour >= FARM_HOUR_BAR ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
  return { verdict, deposit, drop: round2(drop), fees: round2(fees), charge: round2(charge), tbill: round2(tbill), net: round2(net), hours: round2(hours), per_hour: round2(perHour) };
}

// ---------------------------------------------------------------- the board

/** One priced peer shown in a detail view: its real cap against the model's blind price of it. */
export interface PeerRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  blind_usd: number;
  miss: number; // actual / blind, as a xfactor
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  model: {
    version: string;
    launch_value_usd: number;
    token_odds: number;
    p25_usd: number;
    p75_usd: number;
    p10_usd: number;
    p90_usd: number;
    rank_lo: number;
    rank_hi: number;
    verdict: string;
    net_usd: number;
    net_per_hour: number;
  };
  farm_steps: string[];
}

/** The dashboard's full view of one board row. */
export interface RadarRow extends BoardRow {
  curve_base_usd: number; // the fitted curve's cap at this TVL before the category offset
  category_factor: number;
  category_comps: number;
  share_now: number;
  share_later: number;
  age_known: boolean;
  deposit: number;
  drop_usd: number;
  fees_usd: number;
  charge_usd: number;
  tbill_usd: number;
  hours: number;
  plan_kind: string;
  plan_steps: PlanStep[];
  peers: PeerRow[];
  moves: { tvl_down: number; tvl_up: number; six_months: number; no_category: number };
}

/** A traded comparable for the dashboard's traded view: real cap, fitted price, blind price. */
export interface CompRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  fitted_usd: number;
  blind_usd: number;
  miss: number;
}

/** One accounting group: its label and how many of the snapshot's protocols fall in it. */
export interface AccountStat {
  key: string;
  label: string;
  count: number;
}

export const ACCOUNT_LABELS: Record<string, string> = {
  'ranked-watchlist': 'Ranked · watchlist',
  'ranked-early': 'Ranked · early, below the floor',
  comp: 'Token trades · priced comp',
  'token-unpriced': 'Token recorded · no usable cap',
  'out-bridge': 'Out · bridge',
  'out-staking': 'Out · liquid staking',
  'out-exchange': 'Out · exchange',
  'out-versioned': 'Out · versioned or wrapped',
};

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  floor_usd: number;
  model_version: string;
  comps: number;
  odds_population: number;
  curve: { intercept: number; slope: number; slope_se: number; at_100m_usd: number; shrink: number; terms_kept: string[] };
  odds: { tenfold: number; wf: number; base_tenfold: number; base_wf: number; horizon_years: number };
  launch: { loo: number; wf: number };
  bands: { q10: number; q25: number; q75: number; q90: number; cover50: number; cover80: number; within3: number };
  launch_ladder: LadderRow[];
  odds_ladder: LadderRow[];
  categories: { category: string; comps: number; factor: number }[];
  accounting: AccountStat[];
  totals: { implied_usd: number; checksum: string };
  scenario: { drop_share: number; weeks: number; hour_bar: number; tbill_rate: number; capital_charge: number };
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  verdict_counts: { FARM: number; MARGINAL: number; SKIP: number };
  rows: RadarRow[];
  live: CompRow[];
}

/** A short stable checksum of the board's rows, printed here and recomputed by the dashboard. */
export function boardChecksum(rows: { slug: string; rank: number; implied_value_usd: number }[]): string {
  let h = 2166136261;
  const text = rows.map((r) => `${r.rank}:${r.slug}:${r.implied_value_usd}`).join('|');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface ScoredRow {
  p: SnapshotProtocol;
  launch: number;
  odds: number;
  shareNow: number;
  shareLater: number;
  ageYears: number;
  ageKnown: boolean;
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const asOf = snapshot.as_of;
  const watch = new Set(snapshot.watchlist);
  const comps = snapshot.protocols.filter(isComp);
  if (comps.length < 30) throw new SnapshotError('the snapshot records too few priced tokens to fit a curve on');
  const pop = snapshot.protocols.filter((p) => p.listed_at !== null);
  const launch = selectLaunchModel(comps, asOf);
  const oddsModel = selectOddsModel(pop, asOf);
  const fit = launch.fit;
  const oddsFit = oddsModel.fit;

  // conformal bands from the launch model's leave-one-out residuals
  const sortedErrs = [...launch.looErrs].sort((a, b) => a - b);
  const bands = {
    q10: quantile(sortedErrs, 0.1),
    q25: quantile(sortedErrs, 0.25),
    q75: quantile(sortedErrs, 0.75),
    q90: quantile(sortedErrs, 0.9),
  };
  const inBand = (lo: number, hi: number): number => launch.looErrs.filter((e) => e >= lo && e <= hi).length / launch.looErrs.length;
  const cover50 = inBand(bands.q25, bands.q75);
  const cover80 = inBand(bands.q10, bands.q90);
  const within3 = launch.looErrs.filter((e) => Math.abs(e) <= Math.log(3)).length / launch.looErrs.length;

  // blind (leave-one-out) prices of every comp, for the peers table and the traded view
  const blind = new Map<string, number>();
  comps.forEach((c, i) => {
    const train = comps.filter((_, j) => j !== i);
    blind.set(c.slug, predictLaunch(fitLaunch(train, asOf, fit.terms, fit.shrink), c, asOf));
  });

  // the median age of the dated board protocols prices the odds of the undated ones
  const dated = snapshot.protocols.filter((p) => isRankable(p) && p.listed_at !== null);
  const medianAgeYears = median(dated.map((p) => (ageDays(asOf, p.listed_at) ?? 0) / 365.25));

  const chosen = snapshot.protocols.filter((p) => isRankable(p) || watch.has(p.slug));
  const scored: ScoredRow[] = chosen.map((p) => {
    const days = ageDays(asOf, p.listed_at);
    const ageYears = days === null ? medianAgeYears : days / 365.25;
    const o = oddsWithin(oddsFit, p, asOf, ageYears);
    return { p, launch: predictLaunch(fit, p, asOf), odds: o.odds, shareNow: o.shareNow, shareLater: o.shareLater, ageYears, ageKnown: days !== null };
  });
  const impliedOf = (s: ScoredRow): number => Math.max(1, Math.round(s.launch * s.odds));
  scored.sort((a, b) => impliedOf(b) - impliedOf(a) || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));

  // bootstrap rank ranges: refit the launch curve on resampled comps, reprice, re-rank
  const rankSamples = new Map<string, number[]>();
  scored.forEach((s) => rankSamples.set(s.p.slug, []));
  const rng = mulberry32(BOOTSTRAP_SEED);
  const betaSamples: number[][] = [];
  for (let r = 0; r < BOOTSTRAP_REFITS; r++) {
    const sample: SnapshotProtocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rng() * comps.length)]!);
    const refit = fitLaunch(sample, asOf, fit.terms, fit.shrink);
    betaSamples.push(refit.beta);
    const priced = scored.map((s) => ({ slug: s.p.slug, v: predictLaunch(refit, s.p, asOf) * s.odds, tvl: s.p.tvl_usd }));
    priced.sort((a, b) => b.v - a.v || b.tvl - a.tvl || (a.slug < b.slug ? -1 : 1));
    priced.forEach((row, i) => rankSamples.get(row.slug)!.push(i + 1));
  }
  const betaSe = (j: number): number => {
    const vals = betaSamples.map((b) => b[j]!);
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    return Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
  };

  const peersOf = (p: SnapshotProtocol): PeerRow[] => {
    const sameCat = comps.filter((c) => (c.category ?? 'Uncategorised') === (p.category ?? 'Uncategorised'));
    const pool = sameCat.length >= 3 ? sameCat : comps;
    return [...pool]
      .sort((a, b) => Math.abs(Math.log(a.tvl_usd / p.tvl_usd)) - Math.abs(Math.log(b.tvl_usd / p.tvl_usd)) || (a.slug < b.slug ? -1 : 1))
      .slice(0, 8)
      .map((c) => ({ slug: c.slug, name: c.name, category: c.category, tvl_usd: c.tvl_usd, mcap_usd: c.mcap_usd!, blind_usd: Math.round(blind.get(c.slug)!), miss: round2(c.mcap_usd! / blind.get(c.slug)!) }));
  };

  const verdictCounts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  const rows: RadarRow[] = scored.map((s, i) => {
    const p = s.p;
    const implied = impliedOf(s);
    // The plan's deposit: the smallest of the candidate sizes, up to $25,000, at which the
    // plan pays its costs and the $25-an-hour bar; if none reaches it, the largest is used
    // and the verdict says so. A $25,000 cap keeps the scenario one a reader could run.
    const candidates = [...new Set([planDeposit(p.tvl_usd), 5000, 10000, 15000, 20000, 25000])].sort((a, b) => a - b);
    let plan = farmPlan(p, candidates[candidates.length - 1]!);
    let v = verdictFor(implied, p.tvl_usd, plan.steps, candidates[candidates.length - 1]!, DROP_SHARE, HORIZON_WEEKS);
    for (const d of candidates) {
      const candidatePlan = farmPlan(p, d);
      const candidateVerdict = verdictFor(implied, p.tvl_usd, candidatePlan.steps, d, DROP_SHARE, HORIZON_WEEKS);
      plan = candidatePlan;
      v = candidateVerdict;
      if (v.verdict === 'FARM') break;
    }
    verdictCounts[v.verdict]++;
    const ranks = [...rankSamples.get(p.slug)!].sort((a, b) => a - b);
    const catKey = p.category ?? 'Uncategorised';
    const x = launchFeatures(p, asOf, fit.terms);
    const curveOnly = Math.exp(x.reduce((a, val, j) => a + val * fit.beta[j]!, 0));
    // What moves the value: the same fitted objects, re-read on a changed record.
    const launchAtTvl = (tvl: number): number => {
      const xx = [...x];
      xx[1] = Math.log(tvl / TVL_REF);
      return Math.exp(xx.reduce((a, val, j) => a + val * fit.beta[j]!, 0) + (fit.catOff.get(catKey) ?? 0));
    };
    const oddsLater = oddsWithin(oddsFit, p, asOf, s.ageYears + 0.5);
    const moves = {
      tvl_down: Math.round(launchAtTvl(p.tvl_usd * 0.7) * s.odds),
      tvl_up: Math.round(launchAtTvl(p.tvl_usd * 1.3) * s.odds),
      six_months: Math.round(s.launch * oddsLater.odds),
      no_category: Math.round(curveOnly * s.odds),
    };
    const base: BoardRow = {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: ageDays(asOf, p.listed_at),
      on_watchlist: watch.has(p.slug),
      implied_value_usd: implied,
      model: {
        version: MODEL_VERSION,
        launch_value_usd: Math.round(s.launch),
        token_odds: round4(s.odds),
        p25_usd: Math.round(s.launch * Math.exp(bands.q25) * s.odds),
        p75_usd: Math.round(s.launch * Math.exp(bands.q75) * s.odds),
        p10_usd: Math.round(s.launch * Math.exp(bands.q10) * s.odds),
        p90_usd: Math.round(s.launch * Math.exp(bands.q90) * s.odds),
        rank_lo: quantile(ranks, 0.05),
        rank_hi: quantile(ranks, 0.95),
        verdict: v.verdict,
        net_usd: v.net,
        net_per_hour: v.per_hour,
      },
      farm_steps: plan.steps.map((step) => stepText(step, HORIZON_WEEKS)),
    };
    return {
      ...base,
      curve_base_usd: Math.round(curveOnly),
      category_factor: round4(Math.exp(fit.catOff.get(catKey) ?? 0)),
      category_comps: fit.catN.get(catKey) ?? 0,
      share_now: round4(s.shareNow),
      share_later: round4(s.shareLater),
      age_known: s.ageKnown,
      deposit: v.deposit,
      drop_usd: v.drop,
      fees_usd: v.fees,
      charge_usd: v.charge,
      tbill_usd: v.tbill,
      hours: v.hours,
      plan_kind: plan.kind,
      plan_steps: plan.steps,
      peers: peersOf(p),
      moves,
    };
  });

  const board: BoardRow[] = rows.map(({ curve_base_usd, category_factor, category_comps, share_now, share_later, age_known, deposit, drop_usd, fees_usd, charge_usd, tbill_usd, hours, plan_kind, plan_steps, peers, moves, ...rest }) => rest);

  const accountingMap = new Map<string, number>();
  for (const p of snapshot.protocols) {
    const g = accountGroup(p, watch);
    accountingMap.set(g, (accountingMap.get(g) ?? 0) + 1);
  }
  const accounting: AccountStat[] = Object.keys(ACCOUNT_LABELS).map((key) => ({ key, label: ACCOUNT_LABELS[key]!, count: accountingMap.get(key) ?? 0 }));

  const categories = [...fit.catOff.entries()]
    .map(([category, off]) => ({ category, comps: fit.catN.get(category) ?? 0, factor: round4(Math.exp(off)) }))
    .sort((a, b) => b.comps - a.comps || (a.category < b.category ? -1 : 1));

  const live: CompRow[] = [...comps]
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
    .slice(0, 48)
    .map((c) => ({
      slug: c.slug,
      name: c.name,
      category: c.category,
      tvl_usd: c.tvl_usd,
      mcap_usd: c.mcap_usd!,
      fitted_usd: Math.round(predictLaunch(fit, c, asOf)),
      blind_usd: Math.round(blind.get(c.slug)!),
      miss: round2(c.mcap_usd! / blind.get(c.slug)!),
    }));

  const radar: RadarData = {
    as_of: asOf,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    comps: comps.length,
    odds_population: pop.length,
    curve: {
      intercept: round4(fit.beta[0]!),
      slope: round4(fit.beta[1]!),
      slope_se: round4(betaSe(1)),
      at_100m_usd: Math.round(Math.exp(fit.beta[0]!)),
      shrink: fit.shrink,
      terms_kept: fit.terms.map((t) => LAUNCH_TERM_LABEL[t]),
    },
    odds: { tenfold: round4(oddsModel.tenfold), wf: round4(oddsModel.wf), base_tenfold: round4(oddsModel.baseTenfold), base_wf: round4(oddsModel.baseWf), horizon_years: ODDS_HORIZON_YEARS },
    launch: { loo: round2(launch.loo), wf: round2(launch.wf) },
    bands: { q10: round4(Math.exp(bands.q10)), q25: round4(Math.exp(bands.q25)), q75: round4(Math.exp(bands.q75)), q90: round4(Math.exp(bands.q90)), cover50: round4(cover50), cover80: round4(cover80), within3: round4(within3) },
    launch_ladder: launch.ladder,
    odds_ladder: oddsModel.ladder,
    categories,
    accounting,
    totals: { implied_usd: rows.reduce((a, r) => a + r.implied_value_usd, 0), checksum: boardChecksum(rows) },
    scenario: { drop_share: DROP_SHARE, weeks: HORIZON_WEEKS, hour_bar: FARM_HOUR_BAR, tbill_rate: TBILL_RATE, capital_charge: CAPITAL_CHARGE },
    watchlist_size: snapshot.watchlist.length,
    board_size: rows.length,
    early_size: rows.filter((r) => !watch.has(r.slug)).length,
    live_size: live.length,
    verdict_counts: verdictCounts,
    rows,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears twice on the board';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
