// Token Launch Radar model (radar-2): one sealed DefiLlama snapshot in, one ranked board out.
//
// The question the board answers: if a pre-token protocol's record stayed as it is, what would a
// token be worth? The model never guesses from a name. It prices every protocol off the snapshot's
// own market: the protocols whose tokens already trade.
//
//   comparables   every protocol with a recorded market cap and a positive TVL gives one observed
//                 multiple, mcap / tvl. The market's centre is the median of those multiples in
//                 log space (a geometric median), so one 400x outlier cannot drag it.
//   category      a category's own median multiple, shrunk toward the global centre by its sample
//                 size: logM = (n x logM_cat + K x logM_global) / (n + K), K = SHRINK_K. A category
//                 with two thin observations mostly inherits the market; one with fifteen speaks
//                 for itself. The result is clipped to [MULT_FLOOR, MULT_CAP].
//   growth        7-day TVL growth, clamped, moves the price a little: a protocol gaining users is
//                 worth more than one bleeding them, but one week is not a trend.
//   age           a protocol that has run longer with no token has a longer record to price: the
//                 age factor rises with days since listing and flattens after four years.
//   reach         each chain past the first adds a little: multi-chain deployment is distribution
//                 a token launch can price, capped so chain count alone cannot carry a row.
//
//   implied = round( tvl x category_multiple x growth_factor x age_factor x reach_factor )
//
// The board ranks pre-token protocols only. A protocol counts as pre-token when its record carries
// no token (no market cap, no CoinGecko id, no symbol). Off the board, by the same product rule the
// house's watchlist uses: exchange books (category CEX), versioned pools of another protocol, names
// carrying a whole word wrapped/staked/staking or an exchange's name, and the product categories
// Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking and Restaked BTC — those are claims on
// assets that already trade, not launches still to come. Live-token protocols are not ranked; the
// dashboard sets them aside with the market caps the snapshot records, which is also where the
// model's multiples come from, so a reader can check the model against the market it learned from.

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

/** The model's constants, stated in the dashboard so a reader can re-run the arithmetic. */
export interface ModelConstants {
  shrink_k: number;
  mult_floor: number;
  mult_cap: number;
  growth_weight: number;
  growth_floor_pct: number;
  growth_cap_pct: number;
  age_floor: number;
  age_range: number;
  age_days_cap: number;
  unknown_age_factor: number;
  reach_per_chain: number;
  reach_chain_cap: number;
}

export const MODEL: ModelConstants = {
  shrink_k: 5,
  mult_floor: 0.02,
  mult_cap: 3,
  growth_weight: 0.3,
  growth_floor_pct: -50,
  growth_cap_pct: 100,
  age_floor: 0.78,
  age_range: 0.4,
  age_days_cap: 1460,
  unknown_age_factor: 0.92,
  reach_per_chain: 0.03,
  reach_chain_cap: 10,
};

/** The model's version label, named in the dashboard and in every board row's breakdown. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard's comparison view carries, by market cap. */
export const LIVE_ROWS = 36;

/** One scored protocol: the protocol, its implied value, and every factor that produced it. */
export interface Scored {
  protocol: SnapshotProtocol;
  implied: number;
  category_multiple: number;
  comparables: number;
  growth_pct: number;
  growth_factor: number;
  age_days: number | null;
  age_factor: number;
  reach_factor: number;
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
    category_multiple: number;
    category_comparables: number;
    growth_factor: number;
    age_factor: number;
    reach_factor: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one board row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  category_multiple: number;
  category_comparables: number;
  growth_factor: number;
  age_factor: number;
  reach_factor: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the dashboard shows the market's own figures. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

/** One category's place in the model: its shrunk multiple and the sample behind it. */
export interface CategoryStat {
  category: string;
  comparables: number;
  multiple: number;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_multiple: number;
  comparables: number;
  categories: CategoryStat[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from listing to the snapshot's date, clamped at zero; null when unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers, in the list's own order statistics. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The model's market: the global multiple and every category's shrunk multiple, derived from the
 * protocols whose tokens already trade. Pure function of the snapshot, so the dashboard's figures
 * and the board's are the same numbers.
 */
export function marketModel(snapshot: Snapshot, model: ModelConstants = MODEL): { global: number; comparables: number; byCategory: Map<string, { multiple: number; n: number }> } {
  const ratios: number[] = [];
  const perCategory = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const logRatio = Math.log(p.mcap_usd / p.tvl_usd);
    ratios.push(logRatio);
    const key = p.category ?? 'Uncategorised';
    const list = perCategory.get(key);
    if (list === undefined) perCategory.set(key, [logRatio]);
    else list.push(logRatio);
  }
  if (ratios.length === 0) throw new SnapshotError('the snapshot records no tokenised protocol to learn a multiple from');
  const globalLog = median(ratios);
  const byCategory = new Map<string, { multiple: number; n: number }>();
  for (const [key, list] of perCategory) {
    const catLog = median(list);
    const shrunk = (list.length * catLog + model.shrink_k * globalLog) / (list.length + model.shrink_k);
    const multiple = Math.min(model.mult_cap, Math.max(model.mult_floor, Math.exp(shrunk)));
    byCategory.set(key, { multiple, n: list.length });
  }
  return { global: Math.exp(globalLog), comparables: ratios.length, byCategory };
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

/** Score one protocol under the market model: every factor, stated. */
export function score(protocol: SnapshotProtocol, asOf: string, market: ReturnType<typeof marketModel>, model: ModelConstants = MODEL): Scored {
  const cat = market.byCategory.get(protocol.category ?? 'Uncategorised');
  const categoryMultiple = cat?.multiple ?? Math.min(model.mult_cap, Math.max(model.mult_floor, market.global));
  const growthPct = Math.min(model.growth_cap_pct, Math.max(model.growth_floor_pct, protocol.change_7d ?? 0));
  const growthFactor = 1 + (growthPct / 100) * model.growth_weight;
  const age = ageDays(asOf, protocol.listed_at);
  const ageFactor = age === null ? model.unknown_age_factor : model.age_floor + (Math.min(age, model.age_days_cap) / model.age_days_cap) * model.age_range;
  const reachFactor = 1 + model.reach_per_chain * Math.min(Math.max(protocol.chains.length - 1, 0), model.reach_chain_cap);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * categoryMultiple * growthFactor * ageFactor * reachFactor));
  return {
    protocol,
    implied,
    category_multiple: categoryMultiple,
    comparables: cat?.n ?? 0,
    growth_pct: growthPct,
    growth_factor: growthFactor,
    age_days: age,
    age_factor: ageFactor,
    reach_factor: reachFactor,
  };
}

/** The board: every rankable pre-token protocol, watchlist first-class, ranked by implied value. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const market = marketModel(snapshot, model);
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => isRankable(p) || watch.has(p.slug));
  const scored = chosen.map((p) => score(p, snapshot.as_of, market, model));
  scored.sort((a, b) => b.implied - a.implied || b.protocol.tvl_usd - a.protocol.tvl_usd || (a.protocol.slug < b.protocol.slug ? -1 : 1));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.protocol.slug,
    name: s.protocol.name,
    category: s.protocol.category,
    chains: s.protocol.chains,
    tvl_usd: s.protocol.tvl_usd,
    change_7d: s.protocol.change_7d,
    listed_at: s.protocol.listed_at,
    age_days: s.age_days,
    on_watchlist: watch.has(s.protocol.slug),
    implied_value_usd: s.implied,
    model: {
      version: MODEL_VERSION,
      category_multiple: round4(s.category_multiple),
      category_comparables: s.comparables,
      growth_factor: round4(s.growth_factor),
      age_factor: round4(s.age_factor),
      reach_factor: round4(s.reach_factor),
    },
    farm_steps: farmSteps(s.protocol, s.age_days),
  }));
}

// ---------------------------------------------------------------- farm plans
//
// A farm plan is six steps, each one string: the action, then "Cost: ..." and "Time: ...". The plan
// is derived from the protocol's own record — its category picks the actions, its chains pick the
// wallet and the venue, its TVL picks the capital tier, its age picks the hold, its 7-day growth
// picks the cadence — and a stable hash of the slug picks among phrasings, so two protocols rarely
// read alike and no protocol is ever special-cased by name.

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

/** Capital one farm position needs, from the protocol's own TVL tier. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 2_000_000_000) return 500;
  if (p.tvl_usd >= 500_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

const EVM_CHAINS: ReadonlySet<string> = new Set(['Ethereum', 'Arbitrum', 'Base', 'Optimism', 'Polygon', 'BSC', 'Avalanche', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Blast', 'Mode', 'Fantom', 'Gnosis', 'Celo', 'Moonbeam', 'Aurora', 'Fraxtal', 'Sonic', 'Berachain', 'Unichain', 'Ink', 'Soneium', 'Abstract', 'Corn', 'Plume', 'Hemi', 'World Chain', 'Zircuit', 'Taiko', 'Manta', 'Metis', 'Boba', 'Fuse', 'Kava', 'Cronos', 'Moonriver', 'Harmony', 'Astar', 'X Layer', 'Bob', 'Core', 'Bitlayer', 'Merlin', 'BSquared']);

/** The wallet line for a protocol whose first chain is `chain`. */
function walletStep(p: SnapshotProtocol, chain: string, seed: number): string {
  const kind =
    chain === 'Solana'
      ? 'a Solana wallet (Phantom or Solflare)'
      : chain === 'Bitcoin'
        ? 'a Bitcoin wallet with a separate receiving address'
        : EVM_CHAINS.has(chain)
          ? 'a fresh EVM wallet'
          : `a wallet that supports ${chain}`;
  const text = pick(
    [
      `Create ${kind} dedicated to this farm and fund it from an exchange withdrawal, never from your main wallet.`,
      `Set up ${kind} used only for ${p.name}, so its activity is clean and its risk is capped at what you deposit.`,
      `Open ${kind} for this position alone and write its seed phrase on paper before you send it a cent.`,
    ],
    seed,
    0,
  );
  return `${text} Cost: under $3 in withdrawal and gas fees. Time: 10 minutes.`;
}

/** The category's main action and its follow-up action, in words a farmer can follow. */
function actionsFor(p: SnapshotProtocol, capital: number, chain: string, seed: number): [string, string] {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const second = p.chains.length > 1 ? p.chains[1]! : chain;
  if (c.includes('lend') || c.includes('cdp') || c.includes('uncollateralized')) {
    return [
      `Supply $${capital} of USDC to ${name} on ${chain}; a supply position is the activity points programmes count first.`,
      `Borrow about 30% against the supply and re-supply it once, then repay within the week so the loop reads as use, not leverage.`,
    ];
  }
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return [
      `Add $${capital} of liquidity to ${name}'s busiest stable or majors pool on ${chain} and keep the LP position open.`,
      `Route your weekly swaps through ${name} itself rather than an aggregator, so the volume is recorded on the protocol.`,
    ];
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options')) {
    return [
      `Deposit $${capital} of USDC as margin on ${name} and open one small, hedged position you can hold for days.`,
      `Place a second, different order type (a limit order or a vault deposit) so your activity is not one repeated trade.`,
    ];
  }
  if (c.includes('yield') || c.includes('farm') || c.includes('leveraged')) {
    return [
      `Deposit $${capital} into ${name}'s main vault on ${chain} and keep the vault shares in the farm wallet.`,
      `Compound the yield once a week by re-depositing it, which leaves a steady trail of on-chain interactions.`,
    ];
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('collateral')) {
    return [
      `Deposit $${capital} into a ${name} curated vault on ${chain}; pick the vault with the most depositors, not the highest rate.`,
      `Move a small part of the position to a second ${name} vault after two weeks, so you hold two distinct positions.`,
    ];
  }
  if (c.includes('restak') || c.includes('staking') || c.includes('basis')) {
    return [
      `Stake $${capital} of the underlying asset through ${name} on ${chain} and keep the receipt token in the farm wallet.`,
      `Use the receipt in one partner integration ${name} lists (a money market or a vault) to add a second layer of activity.`,
    ];
  }
  if (c.includes('rwa') || c.includes('stable') || c.includes('algo')) {
    return [
      `Mint or deposit $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it rather than trading out.`,
      `Make one redemption and one fresh mint a month apart, so both sides of the product appear in your history.`,
    ];
  }
  if (c.includes('prediction')) {
    return [
      `Fund $${capital} and take small positions in three different markets on ${name}, sized so none can hurt.`,
      `Hold at least one position to settlement instead of closing early; settled positions are the record that counts.`,
    ];
  }
  if (c.includes('insurance')) {
    return [
      `Buy $${capital} of cover from ${name} on ${chain} for an asset you actually hold, and keep the policy to expiry.`,
      `Renew the cover once when it lapses, so the protocol records a returning customer, not a one-off.`,
    ];
  }
  if (c.includes('launchpad') || c.includes('index')) {
    return [
      `Commit $${capital} through ${name} on ${chain} in its next open round or index basket and hold what it allocates.`,
      `Take part in the following round as well; two separate rounds read as a participant, not a passer-by.`,
    ];
  }
  if (c.includes('payments') || c.includes('card')) {
    return [
      `Activate ${name} with $${capital} and route one real payment or card purchase a week through it.`,
      `Keep a balance on ${name} between payments; an account that only passes through once is easy to filter out.`,
    ];
  }
  if (c.includes('privacy') || c.includes('ai') || c.includes('chain')) {
    return [
      `Run $${capital} of genuine activity through ${name} on ${chain}: its core action, done properly, twice in the first week.`,
      `Use one advanced feature of ${name} (not the default path) so your usage matches a real user's, not a script's.`,
    ];
  }
  return [
    `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open; idle balances earn nothing here.`,
    pick(
      [
        `Repeat the core action on ${second} as well if ${name} runs there, so the farm is not a single-chain footprint.`,
        `Add a second, smaller position a week later rather than one deposit and silence.`,
        `Try the one feature of ${name} most users skip; varied usage is what survives a sybil screen.`,
      ],
      seed,
      5,
    ),
  ];
}

/** How long to hold, from the protocol's age: a longer record earns a shorter qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 540) return 45;
  return 30;
}

/** The weekly-cadence step: what to repeat, shaped by the category and by this week's growth. */
function cadenceStep(p: SnapshotProtocol, seed: number): string {
  const c = (p.category ?? '').toLowerCase();
  const verb = c.includes('lend')
    ? 'a small top-up deposit or a partial repay'
    : c.includes('dex')
      ? 'a swap in the pool you farm, however small'
      : c.includes('derivative') || c.includes('perpetual')
        ? 'one small trade, even a hedge adjustment'
        : c.includes('prediction')
          ? 'one position in a new market'
          : c.includes('staking') || c.includes('restak')
            ? 'a claim-and-restake of the rewards'
            : 'one qualifying action (a deposit, a swap, a vote or a claim)';
  if (p.change_7d !== null && p.change_7d >= 20) {
    return `Act twice a week while ${p.name} is growing this fast (${verb}); momentum phases are when points snapshots are usually taken.`;
  }
  if (p.change_7d !== null && p.change_7d <= -15) {
    return `${pick(['TVL is shrinking this week, so keep the cadence but not the size', 'With TVL down this week, repeat the action without adding capital'], seed, 7)}: ${verb}, once a week, and re-check the position's health each time.`;
  }
  return `${pick(
    [
      `Make ${verb} every week so no week in your history is empty`,
      `Repeat ${verb} weekly; a steady rhythm reads as a user, a burst reads as a script`,
      `Once a week, do ${verb} again and note it in the farm diary`,
    ],
    seed,
    7,
  )}.`;
}

/** The exit step: how this kind of position actually unwinds, and the claim discipline. */
function exitStep(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  const unwind = c.includes('lend') || c.includes('cdp')
    ? `repay any open borrow in full before you withdraw the collateral, or the withdrawal will fail`
    : c.includes('dex') || c.includes('liquidity')
      ? `remove the liquidity in one transaction and swap the proceeds back to a stable asset the same day`
      : c.includes('staking') || c.includes('restak')
        ? `start the unstake early: the unbonding period runs whether or not a claim window is open when it ends`
        : c.includes('derivative') || c.includes('perpetual')
          ? `close every open position and let the margin settle before you withdraw it`
          : c.includes('prediction')
            ? `let open positions settle rather than selling them back at a discount in the final week`
            : `withdraw in two tranches a few days apart, so one failed transaction never strands the whole position`;
  return `When you exit, ${unwind}. Claim any reward only from the link ${p.name} itself publishes, and log every transaction hash first. Cost: nothing to check, and never pay anyone to claim for you. Time: 15 minutes.`;
}

/** The six steps of one protocol's farm plan. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const seed = hashOf(p.slug);
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const [main, follow] = actionsFor(p, capital, chain, seed);
  const gas = chain === 'Solana' || chain === 'Base' || chain === 'Arbitrum' ? 'about $1' : 'about $4';
  const watch = pick(
    [
      `check ${p.name}'s own announcements weekly for a points or rewards page`,
      `watch ${p.name}'s governance forum and announcement channel weekly; a points page there is the signal to stay`,
      `re-read ${p.name}'s docs once a month for a new rewards or loyalty programme`,
    ],
    seed,
    11,
  );
  const steps = [
    walletStep(p, chain, seed),
    `${main} Cost: $${capital} of capital plus ${gas} of gas. Time: 15 minutes to set up.`,
    `${follow} Cost: ${gas} of gas, no new capital. Time: 10 minutes.`,
    `${cadenceStep(p, seed)} Cost: about $2 of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days, and ${watch}. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    exitStep(p),
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

/** The live-token protocols, by market cap, with the multiple the market actually pays. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const market = marketModel(snapshot, model);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watch = new Set(snapshot.watchlist);
  const categories: CategoryStat[] = [...market.byCategory.entries()]
    .map(([category, v]) => ({ category, comparables: v.n, multiple: round4(v.multiple) }))
    .sort((a, b) => b.comparables - a.comparables || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    global_multiple: round4(market.global),
    comparables: market.comparables,
    categories,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watch.has(r.slug)).length,
    live_size: live.length,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      age_days: r.age_days,
      on_watchlist: r.on_watchlist,
      implied_value_usd: r.implied_value_usd,
      category_multiple: r.model.category_multiple,
      category_comparables: r.model.category_comparables,
      growth_factor: r.model.growth_factor,
      age_factor: r.model.age_factor,
      reach_factor: r.model.reach_factor,
      farm_steps: r.farm_steps,
    })),
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
