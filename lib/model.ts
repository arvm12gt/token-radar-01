// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks the snapshot's watchlist plus every rankable pre-token protocol below the
// snapshot's floor (a protocol is pre-token when its record carries no market cap, no CoinGecko id
// and no symbol; rankable keeps the versioned-name duplicates of another protocol out, by
// DefiLlama's V2 / 2.0 name rule). Above the floor, the protocols the watchlist leaves out are
// wrapped, staked or bridged products of tokens that already trade — that separation is the
// snapshot's own watchlist rule — so they stand with the traded comparables, not on the ranked
// board; below the floor is the radar's hunting ground, and there it ranks every pre-token row.
//
// Implied value follows only from the snapshot's own figures, and every factor is fitted at runtime
// from the snapshot itself — no multiple is hardcoded and no protocol name is special-cased:
//
//   implied = max(1, round(TVL x categoryMultiple x momentum x maturity))
//
//   categoryMultiple: the protocols that already trade are the comparables. For the protocol's
//     category, take the median of mcap/TVL over its traded comparables (n of them) and shrink it
//     toward the global median G over all comparables: (n x median + 4 x G) / (n + 4), so a category
//     with two wild comparables cannot dominate the board. A category with no comparables uses G.
//     The result is clamped to [0.02, 3.0].
//   momentum = 1 when the snapshot reports no 7-day change, else
//     1 + clamp(change_7d, -50, 100)/100 x 0.6: a hot week lifts a row by at most 60%, a bad one
//     cuts it by at most 30%.
//   maturity = 0.55 + 0.45 x min(age_days, 1460)/1460, age counted from listed_at to the snapshot's
//     as_of (a protocol with no listed_at is assumed 730 days old): a protocol that has run four
//     years with no token is worth its full multiple, a new one a little over half.
//
// Every board row carries the fitted multiple, the number of comparables behind it and both
// multipliers, so a reader can re-derive each implied value from the row alone.

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

/** The model's constants, as the dashboard states them. The multiples themselves are fitted, never here. */
export interface ModelConstants {
  shrinkage_k: number;
  multiple_floor: number;
  multiple_cap: number;
  momentum_weight: number;
  momentum_floor_pct: number;
  momentum_cap_pct: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  shrinkage_k: 4,
  multiple_floor: 0.02,
  multiple_cap: 3.0,
  momentum_weight: 0.6,
  momentum_floor_pct: -50,
  momentum_cap_pct: 100,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 1460,
  unknown_age_days: 730,
};

/** The model's version label: the dashboard names it and the board's data carries it. */
export const MODEL_VERSION = 'radar-2';

/** One category's fitted multiple: the raw median of its comparables and the shrunk value in use. */
export interface CategoryCalibration {
  category: string;
  comps_n: number;
  median_multiple: number;
  used_multiple: number;
}

/** The runtime fit: the global median and every category's calibration. */
export interface MultipleFit {
  global_median: number;
  global_n: number;
  byCategory: Map<string, CategoryCalibration>;
  calibration: CategoryCalibration[];
}

/** The audit trail of one row's implied value: every factor that produced it. */
export interface ValueBreakdown {
  category_multiple: number;
  comps_n: number;
  momentum_multiplier: number;
  maturity_multiplier: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row, with the model's working shown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  implied_value_usd: number;
  model: ValueBreakdown;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own multiple, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number | null;
}

/** The dashboard's copy of one board row: the row whole, farm plan included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  on_watchlist: boolean;
  model: ValueBreakdown;
  farm_steps: string[];
}

/** Everything the dashboard needs: the board, the live comparables, and the fit behind the board. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: ModelConstants;
  calibration: CategoryCalibration[];
  counts: {
    protocols: number;
    watchlist: number;
    board: number;
    pre_token_total: number;
    pre_token_above_floor: number;
  };
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

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Fit the category multiples from the snapshot's own traded protocols. Comparables are the protocols
 * with a market cap and a TVL; each category's median mcap/TVL is shrunk toward the global median by
 * the shrinkage constant, then clamped, so thin categories borrow the market's centre instead of
 * their own noise.
 */
export function fitMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): MultipleFit {
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const globalMedian = comps.length > 0 ? median(comps.map((p) => p.mcap_usd! / p.tvl_usd)) : 1;
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    if (p.category === null) continue;
    const list = byCat.get(p.category) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCat.set(p.category, list);
  }
  const byCategory = new Map<string, CategoryCalibration>();
  for (const [category, values] of byCat) {
    const med = median(values);
    const used = clamp((values.length * med + model.shrinkage_k * globalMedian) / (values.length + model.shrinkage_k), model.multiple_floor, model.multiple_cap);
    byCategory.set(category, { category, comps_n: values.length, median_multiple: round4(med), used_multiple: round4(used) });
  }
  const rest = [...byCategory.values()].sort((a, b) => b.comps_n - a.comps_n || (a.category < b.category ? -1 : 1));
  const globalRow: CategoryCalibration = {
    category: 'ALL',
    comps_n: comps.length,
    median_multiple: round4(globalMedian),
    used_multiple: round4(clamp(globalMedian, model.multiple_floor, model.multiple_cap)),
  };
  return { global_median: globalMedian, global_n: comps.length, byCategory, calibration: [globalRow, ...rest] };
}

/** The multiple one category is scored with, and how many comparables stand behind it. */
export function multipleFor(fit: MultipleFit, category: string | null, model: ModelConstants = MODEL): { multiple: number; comps_n: number } {
  if (category !== null) {
    const cal = fit.byCategory.get(category);
    if (cal !== undefined) return { multiple: cal.used_multiple, comps_n: cal.comps_n };
  }
  return { multiple: round4(clamp(fit.global_median, model.multiple_floor, model.multiple_cap)), comps_n: 0 };
}

/** The implied value of one protocol and the breakdown that produced it. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  fit: MultipleFit,
  model: ModelConstants = MODEL,
): { implied: number; breakdown: ValueBreakdown; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, comps_n } = multipleFor(fit, protocol.category, model);
  const momentum =
    protocol.change_7d === null ? 1 : 1 + (clamp(finite(protocol.change_7d, 0), model.momentum_floor_pct, model.momentum_cap_pct) / 100) * model.momentum_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturity = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * momentum * maturity));
  return {
    implied,
    breakdown: {
      category_multiple: round4(multiple),
      comps_n,
      momentum_multiplier: round4(momentum),
      maturity_multiplier: round4(maturity),
    },
    age,
  };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is rankable: pre-token and not a versioned duplicate. CEX rows stay. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !VERSIONED.test(p.name);
}

/** The protocols the board ranks, strongest first, with ranks 1..n and every factor shown. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const fit = fitMultiples(snapshot, model);
  const watchlist = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter((p) => isRankable(p) && (watchlist.has(p.slug) || p.tvl_usd < snapshot.floor_usd))
    .map((p) => {
      const { implied, breakdown, age } = impliedValue(p, snapshot.as_of, fit, model);
      return { p, implied, breakdown, age };
    });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_days: s.age,
    token_status: 'pre-token',
    on_watchlist: watchlist.has(s.p.slug),
    implied_value_usd: s.implied,
    model: s.breakdown,
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** Every traded protocol in the snapshot, by market cap: the comparables the multiples were fitted from. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      multiple: p.tvl_usd > 0 ? round4(p.mcap_usd! / p.tvl_usd) : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const fit = fitMultiples(snapshot, model);
  const board = buildBoard(snapshot, model);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model,
    calibration: fit.calibration,
    counts: {
      protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
      board: board.length,
      pre_token_total: snapshot.protocols.filter(isPreToken).length,
      pre_token_above_floor: snapshot.protocols.filter(
        (p) => isRankable(p) && p.tvl_usd >= snapshot.floor_usd && !snapshot.watchlist.includes(p.slug),
      ).length,
    },
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      on_watchlist: r.on_watchlist,
      model: r.model,
      farm_steps: r.farm_steps,
    })),
    live: liveRows(snapshot),
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
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/**
 * Why a board is not one the gate will take, or null. The gate's board rules: 100 to 4,000 rows, every
 * slug one of the snapshot's protocols and named once, the watchlist covered whole, ranks exactly
 * 1..N, implied value never rising as rank ascends and never one shared value, every implied value a
 * positive whole number of at most 1e14, and every farm plan 3 to 12 steps of 20 to 600 characters.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows: the gate takes 100 to 4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of board) {
    if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
    if (seen.has(r.slug)) return `${r.slug} appears on the board twice`;
    seen.add(r.slug);
    if (typeof r.name !== 'string' || r.name.trim().length === 0) return `${r.slug} has no name`;
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) if (byRank[i]!.rank !== i + 1) return `rank ${i + 1} is ${byRank[i]!.rank}`;
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `${byRank[i]!.slug} outranks ${byRank[i - 1]!.slug} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `${r.slug} has a farm step of ${len} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

// ---------------------------------------------------------------------------
// Farm plans. Every plan is six steps written for the protocol's own category and personalised with
// its own facts: its name, its first chain and how many chains it lists, a capital tier from its TVL,
// the gas price of its chain's class, and a hold window from its age. No step is shared verbatim
// across categories: a lending loop, a bridge rotation and an exchange account are different work,
// and the plans say so.
// ---------------------------------------------------------------------------

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The facts of one protocol that its farm plan is written from. */
interface FarmContext {
  name: string;
  chain: string;
  chainCount: number;
  capital: number;
  gas: string;
  hold: number;
}

const LOW_GAS_CHAINS = new Set([
  'Arbitrum',
  'Base',
  'Optimism',
  'OP Mainnet',
  'zkSync Era',
  'zkSync',
  'Linea',
  'Scroll',
  'Mantle',
  'Polygon',
  'Avalanche',
  'BSC',
  'Binance',
]);

/** What one on-chain action costs on a chain: Ethereum is dear, the big L2s and BSC are cheap, Solana is dust. */
function gasFor(chain: string): string {
  if (chain === 'Ethereum') return '$4-8';
  if (chain === 'Solana') return 'about $0.05';
  if (LOW_GAS_CHAINS.has(chain)) return '$0.2-1';
  return 'about $1';
}

/** How much capital one farm position needs, from the protocol's own TVL: bigger protocols, bigger ticket. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function farmContext(p: SnapshotProtocol, age: number | null): FarmContext {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  return {
    name: p.name,
    chain,
    chainCount: p.chains.length,
    capital: capitalFor(p),
    gas: gasFor(chain),
    hold: holdDaysFor(age),
  };
}

function dexsPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it with ETH and USDC on ${c.chain}, and open ${c.name}'s busiest pool page to check its depth before depositing anything`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Open a concentrated-liquidity position of $${c.capital} in ${c.name}'s main pair on ${c.chain}, set a range wide enough to survive a normal week, and keep the position in the farming wallet`,
      cost: `$${c.capital} of capital plus about ${c.gas} of gas to mint the position`,
      time: '20 minutes',
    },
    {
      text: `Swap about $25 each way through ${c.name} every week, in both directions, so the wallet builds a genuine trading history next to its liquidity instead of one silent deposit`,
      cost: `about ${c.gas} of gas plus the pool's swap fee, weekly`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the liquidity position for at least ${c.hold} days, rebalancing the range only when price actually leaves it, so fees and activity span several weekly snapshots`,
      cost: `the $${c.capital} stays in the pool and carries impermanent-loss risk`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points or rewards page every fortnight and confirm the wallet's swaps and liquidity are being counted; claim only from a link the protocol itself publishes`,
      cost: 'free to check, and never pay a third party to claim for you',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log every swap, fee earned and range change in a farm log with dates, then withdraw the position back to the wallet before rotating the capital elsewhere`,
      cost: `about ${c.gas} of gas to close the position`,
      time: '15 minutes',
    },
  ];
}

function lendingPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it with USDC and the gas token on ${c.chain}, and read ${c.name}'s market page for the supply cap and borrow rate of the asset you plan to use`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Supply $${c.capital} of USDC to ${c.name} on ${c.chain}, then borrow against it at no more than 60% loan-to-value and note the health factor the interface shows after the first borrow`,
      cost: `$${c.capital} of capital plus about ${c.gas} of gas for the supply and borrow`,
      time: '20 minutes',
    },
    {
      text: `Repay part of the borrow and re-supply it each week, keeping the loop turning so the wallet records both supply and borrow activity without the health factor ever drifting toward liquidation`,
      cost: `about ${c.gas} of gas per weekly loop`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the supply-and-borrow loop open for at least ${c.hold} days, keeping at least a 25% buffer above the liquidation threshold through price swings`,
      cost: `the $${c.capital} stays supplied and the borrow stays open, with liquidation risk if the buffer is ignored`,
      time: `${c.hold} days`,
    },
    {
      text: `Open ${c.name}'s own points or rewards page every fortnight and check that supplied and borrowed balances are earning as the page describes; claim only from the protocol's own link`,
      cost: 'free to check, and never pay anyone to claim on your behalf',
      time: '10 minutes a fortnight',
    },
    {
      text: `Keep a farm log of supplied amounts, borrows, repayments and health-factor readings; to exit, repay the borrow in full first and only then withdraw the supply`,
      cost: `about ${c.gas} of gas for the repay and withdrawal`,
      time: '15 minutes',
    },
  ];
}

function derivativesPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it with USDC on ${c.chain}, and read ${c.name}'s margin and liquidation rules before depositing, because a derivatives account punishes surprises`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Deposit $${c.capital} of USDC as margin on ${c.name} and open one small long and one small short on two different markets, each sized so a bad day on either side cannot threaten the margin`,
      cost: `$${c.capital} of margin plus about ${c.gas} of gas and the opening fees`,
      time: '20 minutes',
    },
    {
      text: `Trade about $200 of notional a week in small two-sided clips, closing flat by the end of each session, so the account builds weekly volume without carrying a directional bet overnight`,
      cost: `trading fees on about $200 of weekly volume plus about ${c.gas} of gas`,
      time: '20 minutes a week',
    },
    {
      text: `Keep the margin parked on ${c.name} for at least ${c.hold} days of weekly trading, and never let a position sit unmonitored: a liquidation would erase the history the farm is building`,
      cost: `the $${c.capital} stays as margin for the whole window`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own rewards or volume-tier page every fortnight and confirm the account's volume is climbing the tiers it publishes; claim only inside the protocol's own interface`,
      cost: 'free to check, and never pay a claim link from social media',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log every trade, fee and funding payment in a farm log; to exit, close both sides flat first and only then withdraw the margin back to the wallet`,
      cost: `closing fees plus about ${c.gas} of gas to withdraw`,
      time: '15 minutes',
    },
  ];
}

function bridgePlan(c: FarmContext): FarmStep[] {
  const routes = c.chainCount > 1 ? `it lists ${c.chainCount} chains` : 'it serves more than one chain';
  return [
    {
      text: `Create a fresh wallet and fund it with USDC and gas on the chain you will bridge from, then open ${c.name}'s route page: ${routes}, and each route is a separate farm surface`,
      cost: 'one transfer in, about $1 of gas',
      time: '15 minutes',
    },
    {
      text: `Bridge $${c.capital} of USDC through ${c.name} to ${c.chain} and, once it arrives, make one real transaction with the bridged funds so the destination wallet is a user and not a dead end`,
      cost: `$${c.capital} of capital plus the bridge fee and about ${c.gas} of gas on arrival`,
      time: '20 minutes including the wait for arrival',
    },
    {
      text: `Bridge a small amount to a different chain ${c.name} serves each week, rotating destinations and amounts so the wallet shows genuine multi-chain use spread over weeks, not one burst`,
      cost: 'the bridge fee plus about $1 of gas per weekly route',
      time: '15 minutes a week',
    },
    {
      text: `Keep a working balance on at least two destination chains for ${c.hold} days and use each one occasionally, so the activity reads as a person living on several chains`,
      cost: `part of the $${c.capital} stays parked on each destination chain`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points or rewards page every fortnight and confirm the bridged volume and chain count are credited; claim only from the link the protocol itself publishes`,
      cost: 'free to check, and never pay a third party to claim for you',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log every route, amount, fee and arrival time in a farm log; bridges are the easiest activity to reconstruct later and the log is what proves the pattern was yours`,
      cost: 'nothing but the log',
      time: '5 minutes per route',
    },
  ];
}

function canonicalBridgePlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it with ETH and USDC on Ethereum, and open ${c.name}'s official deposit page from the chain's own site, never from a search ad or a social post`,
      cost: 'one transfer in, about $4-8 of gas on Ethereum',
      time: '15 minutes',
    },
    {
      text: `Deposit $${c.capital} through ${c.name} to ${c.chain} and wait for the deposit to finalise, then make one ordinary transaction on the destination chain so the new wallet has a life there`,
      cost: `$${c.capital} of capital plus about $4-8 of Ethereum gas for the deposit`,
      time: '30 minutes including finality',
    },
    {
      text: `Make one small deposit or withdrawal through ${c.name} each week and use the destination chain in between, so the wallet's bridge history grows steadily in both directions`,
      cost: 'about $4-8 of Ethereum gas per weekly movement',
      time: '15 minutes a week',
    },
    {
      text: `Keep funds working on ${c.chain} for at least ${c.hold} days; official-bridge withdrawals can take days to settle, so never bridge money you may need back this week`,
      cost: `the $${c.capital} stays on the destination chain for the window`,
      time: `${c.hold} days`,
    },
    {
      text: `Check the chain's own ecosystem or rewards page every fortnight for ${c.name} activity being counted toward quests or points, and claim only through the chain's official pages`,
      cost: 'free to check, and never pay anyone to claim for you',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log every deposit, withdrawal and waiting period in a farm log; to exit, start the official withdrawal early and budget the full challenge period before the funds land back on Ethereum`,
      cost: 'about $4-8 of Ethereum gas to start the withdrawal',
      time: '20 minutes, plus the withdrawal wait',
    },
  ];
}

function crossChainBridgePlan(c: FarmContext): FarmStep[] {
  const routes = c.chainCount > 1 ? `${c.chainCount} chains listed` : 'several chains';
  return [
    {
      text: `Create a fresh wallet, fund it with small gas balances on two or three of the chains ${c.name} connects (${routes}), and read its fee table for the route you will use most`,
      cost: 'small transfers in, about $1 of gas in total',
      time: '20 minutes',
    },
    {
      text: `Send $${c.capital} of USDC from ${c.chain} to a second chain through ${c.name}'s cross-chain route and complete one transaction with it on arrival, so both ends of the route show a real user`,
      cost: `$${c.capital} of capital plus the relayer fee and about ${c.gas} of gas`,
      time: '25 minutes including delivery',
    },
    {
      text: `Rotate the route each week: a different chain pair and a different amount through ${c.name}, so the wallet's history covers the network instead of hammering one corridor`,
      cost: 'the relayer fee plus about $1 of gas per weekly route',
      time: '15 minutes a week',
    },
    {
      text: `Keep balances alive on at least three connected chains for ${c.hold} days and transact on each occasionally, because cross-chain credit usually counts distinct chains and weeks`,
      cost: `part of the $${c.capital} stays spread across the connected chains`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points or rewards page every fortnight and confirm routes and volume are credited as its rules describe; claim only from the protocol's own link`,
      cost: 'free to check, and never pay a claim service',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log every message, route, fee and delivery time in a farm log; to exit, bridge balances back along the cheapest route and keep the log as the record of the whole campaign`,
      cost: 'the return relayer fee plus about $1 of gas',
      time: '20 minutes',
    },
  ];
}

function yieldPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it with USDC on ${c.chain}, and read ${c.name}'s vault page for its current yield source and withdrawal terms before depositing`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Deposit $${c.capital} into ${c.name}'s main yield vault on ${c.chain} and keep the vault shares in the farming wallet, untouched, so the deposit ages in one place`,
      cost: `$${c.capital} of capital plus about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Harvest the accrued yield each week and restake it into the same vault, or add a $10 top-up when there is nothing to harvest, so the position compounds and the wallet stays active`,
      cost: `about ${c.gas} of gas per weekly harvest`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the vault shares for at least ${c.hold} days so the yield compounds across several weekly snapshots instead of being measured on a single day`,
      cost: `the $${c.capital} stays in the vault, exposed to its strategy risk`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points or rewards page every fortnight and confirm the vault balance is earning what the page promises; claim only from the protocol's own interface`,
      cost: 'free to check, and never pay to claim',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log deposits, harvests and the vault's rate each week in a farm log; to exit, withdraw the shares in one transaction and note the final yield the position actually earned`,
      cost: `about ${c.gas} of gas to withdraw`,
      time: '15 minutes',
    },
  ];
}

function yieldAggregatorPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it with USDC on ${c.chain}, and compare ${c.name}'s vault list: pick the vault whose underlying strategy you can explain in one sentence`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '20 minutes',
    },
    {
      text: `Deposit $${c.capital} into that ${c.name} vault on ${c.chain} and keep the shares in the farming wallet; an aggregator position is only worth farming while its routing stays sensible`,
      cost: `$${c.capital} of capital plus about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Compare your vault's rate against ${c.name}'s other vaults each week and move only if another vault beats it clearly for two weeks running; churn for its own sake just burns gas`,
      cost: `about ${c.gas} of gas, and only in weeks you actually move`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${c.hold} days so the aggregator's auto-compounding has time to show in the share price across several snapshots`,
      cost: `the $${c.capital} stays in the vault, exposed to every strategy underneath it`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points or rewards page every fortnight and confirm the vault shares are counted; claim only from a link inside the protocol's own app`,
      cost: 'free to check, and never pay a third party to claim for you',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log the vault chosen, its rate each week and every move in a farm log; to exit, withdraw the shares and record what the aggregation actually earned over a direct deposit`,
      cost: `about ${c.gas} of gas to withdraw`,
      time: '15 minutes',
    },
  ];
}

function riskCuratorsPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it with USDC on ${c.chain}, and start on ${c.name}'s allocation page: read which markets the curator currently allocates to before choosing a vault`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '20 minutes',
    },
    {
      text: `Deposit $${c.capital} into ${c.name}'s flagship vault on ${c.chain}, the one holding the curator's own largest allocation, and keep the vault shares in the farming wallet`,
      cost: `$${c.capital} of capital plus about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Re-read the curator's allocation page each week for reallocations or risk warnings, and move your deposit only if the curator exits a market entirely; their moves are the signal, not the noise`,
      cost: `about ${c.gas} of gas, and only in weeks you actually move`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the vault shares for at least ${c.hold} days so the deposit is counted across several of the curator's rebalancing cycles, not just the day it landed`,
      cost: `the $${c.capital} stays in the vault, exposed to the curator's chosen markets`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points or rewards page every fortnight and confirm the vault balance is earning as described; claim only from the protocol's own link`,
      cost: 'free to check, and never pay anyone to claim on your behalf',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log the vault, the curator's allocation changes and your moves in a farm log; to exit, withdraw the shares and note which of the curator's calls your deposit lived through`,
      cost: `about ${c.gas} of gas to withdraw`,
      time: '15 minutes',
    },
  ];
}

function allocatorPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it with USDC on ${c.chain}, and read ${c.name}'s strategy page: an allocator is only worth farming if you can name where it puts the money`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '20 minutes',
    },
    {
      text: `Deposit $${c.capital} into ${c.name}'s main allocation strategy on ${c.chain} and keep the strategy shares in the farming wallet for the whole campaign`,
      cost: `$${c.capital} of capital plus about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Read ${c.name}'s strategy report or allocation update each week and add a $10 top-up in weeks where the allocation is unchanged and performing; skip top-ups in weeks it is mid-rotation`,
      cost: `about ${c.gas} of gas per weekly top-up`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the strategy shares for at least ${c.hold} days so the position spans several allocation reports instead of a single deposit day`,
      cost: `the $${c.capital} stays allocated, exposed to every venue the strategy uses`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points or rewards page every fortnight and confirm the strategy balance is counted; claim only from inside the protocol's own app`,
      cost: 'free to check, and never pay to claim',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log deposits, top-ups and the strategy's reported returns in a farm log; to exit, redeem the shares and record what the allocation earned against holding USDC idle`,
      cost: `about ${c.gas} of gas to redeem`,
      time: '15 minutes',
    },
  ];
}

function cdpPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it with the collateral asset and gas on ${c.chain}, and read ${c.name}'s liquidation rules: a CDP vault is safe only while you respect its ratio`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Deposit $${c.capital} of collateral into a ${c.name} vault on ${c.chain} and mint its stablecoin at no more than half the maximum the vault allows, leaving a wide buffer above liquidation`,
      cost: `$${c.capital} of collateral plus about ${c.gas} of gas to open and mint`,
      time: '20 minutes',
    },
    {
      text: `Top up collateral or repay a slice of the minted debt each week, whichever keeps the ratio healthiest, so the vault shows steady, careful management rather than one mint and silence`,
      cost: `about ${c.gas} of gas per weekly adjustment`,
      time: '10 minutes a week',
    },
    {
      text: `Keep the vault open with its debt outstanding for at least ${c.hold} days, checking the collateral ratio after any sharp market move before the week is out`,
      cost: `the $${c.capital} stays locked as collateral, with liquidation risk if the buffer is ignored`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points or rewards page every fortnight and confirm open vaults and minted balances are counted as its rules say; claim only from the protocol's own link`,
      cost: 'free to check, and never pay a third party to claim for you',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log collateral, minted amounts and the ratio each week in a farm log; to exit, repay the full minted amount first, then close the vault and withdraw the collateral`,
      cost: `about ${c.gas} of gas for the repay and close`,
      time: '15 minutes',
    },
  ];
}

function liquidStakingPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet holding the chain's native asset on ${c.chain}, and read ${c.name}'s staking page for its current rate, fees and unstaking queue before staking anything`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Stake $${c.capital} of the native asset through ${c.name} on ${c.chain} and keep the liquid staking receipt token in the farming wallet, unspent, so the stake ages in one address`,
      cost: `$${c.capital} of capital plus about ${c.gas} of gas to stake`,
      time: '15 minutes',
    },
    {
      text: `Put a small slice of the receipt token to work in one partner integration each week, a lend or a pool ${c.name} itself lists, while the core stake stays untouched`,
      cost: `about ${c.gas} of gas per weekly integration action`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the stake for at least ${c.hold} days so the receipt token's accrued rewards span several weekly snapshots, and never stake money you cannot leave through the unstaking queue`,
      cost: `the $${c.capital} stays staked for the whole window`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points or rewards page every fortnight and confirm the staked balance is counted; claim only from the protocol's own link, never from a search result`,
      cost: 'free to check, and never pay to claim',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log the stake, the receipt balance's growth and every integration action in a farm log; to exit, start the unstake through ${c.name}'s own queue and budget its full waiting period`,
      cost: `about ${c.gas} of gas to start the unstake`,
      time: '15 minutes, plus the queue wait',
    },
  ];
}

function liquidRestakingPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it with a liquid staking token or the native asset on ${c.chain}, and read ${c.name}'s page on which operators and services secure its restaked balance`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '20 minutes',
    },
    {
      text: `Restake $${c.capital} through ${c.name} on ${c.chain} and keep the liquid restaking receipt in the farming wallet; restaking adds slashing exposure, so size it as risk capital, not savings`,
      cost: `$${c.capital} of capital plus about ${c.gas} of gas to restake`,
      time: '15 minutes',
    },
    {
      text: `Add a small restake top-up each week and re-check ${c.name}'s operator allocations, moving only if it drops an operator or a service you are securing is wound down`,
      cost: `about ${c.gas} of gas per weekly top-up`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the restaked position for at least ${c.hold} days so it is counted across several reward periods, and keep enough unstaked funds aside to exit if the risk picture changes`,
      cost: `the $${c.capital} stays restaked, exposed to slashing as well as market moves`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points page every fortnight: restaking usually stacks two points systems, and both should credit the same wallet; claim only from the protocol's own links`,
      cost: 'free to check, and never pay a third party to claim for you',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log restakes, operator changes and both points balances in a farm log; to exit, withdraw through ${c.name}'s own queue and wait out its full unstaking period`,
      cost: `about ${c.gas} of gas to start the withdrawal`,
      time: '15 minutes, plus the withdrawal wait',
    },
  ];
}

function restakingPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it with the asset ${c.name} accepts on ${c.chain}, and read its operator and slashing terms before depositing: restaking risk is real and differs by operator`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '20 minutes',
    },
    {
      text: `Deposit $${c.capital} into ${c.name} on ${c.chain} and delegate it to the default or largest operator rather than an exotic one, keeping the deposit receipt in the farming wallet`,
      cost: `$${c.capital} of capital plus about ${c.gas} of gas to deposit and delegate`,
      time: '15 minutes',
    },
    {
      text: `Add a small deposit each week and confirm the delegation is still earning; if ${c.name} lets you split across operators, spread the new deposits instead of moving the old ones`,
      cost: `about ${c.gas} of gas per weekly deposit`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the restaked deposit for at least ${c.hold} days so it spans several reward periods, and never restake funds you cannot leave through a long unbonding queue`,
      cost: `the $${c.capital} stays restaked, exposed to operator slashing`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points or rewards page every fortnight and confirm the delegated balance is credited; claim only from the protocol's own link`,
      cost: 'free to check, and never pay to claim',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log deposits, delegations and reward readings in a farm log; to exit, undelegate through ${c.name}'s own flow and budget the full unbonding period before reusing the funds`,
      cost: `about ${c.gas} of gas to undelegate`,
      time: '15 minutes, plus the unbonding wait',
    },
  ];
}

function stakingPoolPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet holding the chain's native asset on ${c.chain}, and read ${c.name}'s pool page for its commission, payout schedule and unbonding period`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Delegate $${c.capital} of the native asset to ${c.name}'s staking pool on ${c.chain} and keep the delegation in the farming wallet, where its rewards can accrue undisturbed`,
      cost: `$${c.capital} of capital plus about ${c.gas} of gas to delegate`,
      time: '15 minutes',
    },
    {
      text: `Claim the pool's staking rewards each week and re-delegate them, so the position compounds and the wallet shows the steady rhythm of a long-term delegator`,
      cost: `about ${c.gas} of gas per weekly claim`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the delegation for at least ${c.hold} days so it spans several payout cycles and weekly snapshots, and never delegate money you may need inside the unbonding period`,
      cost: `the $${c.capital} stays delegated for the whole window`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own rewards page every fortnight and confirm the delegation is counted in any points or loyalty scheme it runs; claim only through its own interface`,
      cost: 'free to check, and never pay a third party to claim for you',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log delegations, claims and reward amounts in a farm log; to exit, undelegate through the pool's own flow and wait out the unbonding period before moving the funds`,
      cost: `about ${c.gas} of gas to undelegate`,
      time: '15 minutes, plus the unbonding wait',
    },
  ];
}

function rwaPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Register on ${c.name} and complete its KYC and eligibility checks before moving any money: real-world-asset products are often region-restricted, and a failed check after depositing is the expensive order`,
      cost: 'no fee, but identity documents and a short review wait',
      time: '30 minutes plus review time',
    },
    {
      text: `Once eligible, mint $${c.capital} of ${c.name}'s yield-bearing asset on ${c.chain} into the whitelisted wallet it was issued to, and keep it there: these assets usually cannot move to a fresh address`,
      cost: `$${c.capital} of capital plus about ${c.gas} of gas to mint`,
      time: '20 minutes',
    },
    {
      text: `Check the asset's NAV and attestation page each week and add a small top-up only in weeks when redemptions are open and the attestations are current`,
      cost: `about ${c.gas} of gas per weekly top-up`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the asset to at least the next redemption window, a minimum of ${c.hold} days, because RWA positions settle on the issuer's calendar, not the market's`,
      cost: `the $${c.capital} stays in the asset until a redemption window opens`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own dashboard every fortnight for distributions, points or holder programmes, and claim only inside the issuer's own portal`,
      cost: 'free to check, and never pay a claim link from social media',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log the KYC date, mints, NAV readings and distributions in a farm log; to exit, redeem through the official redemption window and keep the log as the tax and audit record`,
      cost: `about ${c.gas} of gas to redeem, plus any issuer redemption fee`,
      time: '20 minutes, plus settlement time',
    },
  ];
}

function cexPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Register an account on ${c.name}, complete KYC with your own documents, and turn on two-factor authentication before depositing anything; an unverified account earns nothing and risks a frozen withdrawal`,
      cost: 'no fee, but identity documents are required',
      time: '20 minutes',
    },
    {
      text: `Deposit $${c.capital} and place it in ${c.name}'s earn product or hold it as a spot balance; an exchange charges no chain gas, but keep the balance small enough that losing access would sting, not sink you`,
      cost: `$${c.capital} of capital and the deposit network's fee`,
      time: '15 minutes',
    },
    {
      text: `Make two or three small spot trades each week, about $25 each in the majors, so the account shows ordinary trading activity rather than a parked deposit waiting for a handout`,
      cost: 'spot trading fees on about $75 of weekly volume',
      time: '10 minutes a week',
    },
    {
      text: `Keep the account active for at least ${c.hold} days, and withdraw a small amount to your own wallet once in that window to prove the withdrawal path works before any larger sum depends on it`,
      cost: 'one small withdrawal fee',
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own rewards hub every fortnight for task or points campaigns and do only the ones inside the official app; never follow a claim link from social media or a search ad`,
      cost: 'free to check, and never pay to claim',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log deposits, trades and withdrawals with dates in a farm log; at the end, withdraw the balance to your own wallet, because farm capital should never live on any exchange longer than the farm`,
      cost: 'the standard withdrawal fee',
      time: '15 minutes',
    },
  ];
}

function basisTradingPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it on ${c.chain} for both legs of the trade, and read ${c.name}'s funding-rate history for the pair you will run: a basis farm lives or dies on that rate`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '20 minutes',
    },
    {
      text: `Open a delta-neutral basis position through ${c.name}: hold $${c.capital} of the spot asset and short the same notional on its perpetual market, so price moves cancel and only the funding is earned`,
      cost: `$${c.capital} of capital across both legs plus about ${c.gas} of gas and opening fees`,
      time: '25 minutes',
    },
    {
      text: `Check the funding rate and the two legs' drift each week, rebalancing whenever they move more than 5% apart, and closing the pair in any week funding turns durably negative`,
      cost: `about ${c.gas} of gas per weekly rebalance`,
      time: '15 minutes a week',
    },
    {
      text: `Hold the paired position for at least ${c.hold} days while funding stays positive, so the farm collects several funding periods instead of one lucky day`,
      cost: `the $${c.capital} stays committed across both legs, with margin risk on the short`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points or rewards page every fortnight and confirm both legs are counted; hedged volume is easy to under-credit, so verify rather than assume`,
      cost: 'free to check, and never pay to claim',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log both legs, funding received and rebalances in a farm log; to exit, close the short and sell the spot in the same session so the hedge never sits half-open`,
      cost: `closing fees plus about ${c.gas} of gas`,
      time: '20 minutes',
    },
  ];
}

function chainPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Add ${c.name}'s network to a fresh wallet and bridge in a small amount of its native gas token plus $${c.capital} of stablecoins through its official bridge, from the chain's own site`,
      cost: 'the bridge fee plus about $4-8 of gas on the source chain',
      time: '25 minutes',
    },
    {
      text: `Become a real user of the chain in the first session: swap once on its best-known native DEX and supply a small amount to its best-known lending market, keeping a gas balance behind`,
      cost: `about ${c.gas} of gas per transaction on the chain itself`,
      time: '20 minutes',
    },
    {
      text: `Make two or three ordinary transactions on ${c.name} each week, a swap, a transfer, a governance vote, so the wallet builds the steady history of a resident rather than a tourist`,
      cost: `about ${c.gas} of gas per transaction`,
      time: '10 minutes a week',
    },
    {
      text: `Keep the wallet active on the chain for at least ${c.hold} days, because ecosystem rewards almost always count distinct active weeks, not total volume in one burst`,
      cost: `the $${c.capital} stays working on the chain for the window`,
      time: `${c.hold} days`,
    },
    {
      text: `Check the chain's own ecosystem or quests page every fortnight for ${c.name} activity being counted, and claim only through the chain's official pages`,
      cost: 'free to check, and never pay a claim service',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log bridges, transactions and active weeks in a farm log; to exit, bridge the balance back through the official bridge and keep the log as the record of residency`,
      cost: 'the bridge fee plus gas on both chains',
      time: '20 minutes',
    },
  ];
}

function paymentsPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create an account in ${c.name}'s app, complete whatever verification it asks for, and link the fresh wallet you will pay from on ${c.chain}`,
      cost: 'no fee for setup',
      time: '15 minutes',
    },
    {
      text: `Route $${c.capital} of real payments through ${c.name}, starting with one payment to your own second wallet to learn its fees and settlement time before paying anyone else`,
      cost: `$${c.capital} of working balance plus ${c.name}'s per-payment fee`,
      time: '15 minutes',
    },
    {
      text: `Make one or two genuine payments each week, a transfer, a card top-up or a merchant payment, because payment farms credit regular use and discount one large artificial transaction`,
      cost: 'the per-payment fee on small amounts',
      time: '10 minutes a week',
    },
    {
      text: `Keep a small working balance in ${c.name} for at least ${c.hold} days of weekly payments, topping it up rather than letting it sit empty between uses`,
      cost: `part of the $${c.capital} stays as the working balance`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own rewards or cashback page every fortnight and confirm the payments are earning what it advertises; claim only inside the official app`,
      cost: 'free to check, and never pay to claim',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log every payment, fee and cashback credit in a farm log; to exit, spend or withdraw the working balance down to zero and close the campaign with the log intact`,
      cost: 'the final payment or withdrawal fee',
      time: '10 minutes',
    },
  ];
}

function insurancePlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it on ${c.chain}, and read ${c.name}'s cover wording for the risk you actually hold: insurance farmed on a position you do not have is just a premium burned`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '20 minutes',
    },
    {
      text: `Buy $${c.capital} of cover from ${c.name} on ${c.chain} against a real position elsewhere, a lend, a vault or a bridge balance, and keep the policy receipt in the farming wallet`,
      cost: `the premium on $${c.capital} of cover plus about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Review the cover each week: check the pool still has capacity for your market and renew or extend the policy before it lapses, because a gap week is an uncovered week`,
      cost: `about ${c.gas} of gas, plus premium only when you renew`,
      time: '10 minutes a week',
    },
    {
      text: `Keep cover in force for at least ${c.hold} days, the full policy term if it is longer, so the membership and premium history span several weekly snapshots`,
      cost: `the premium is spent whether or not a claim ever happens`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own membership or rewards page every fortnight and confirm the active policy is counted; claim rewards only through its own interface, and claim on the policy only for a real loss`,
      cost: 'free to check, and never pay to claim',
      time: '10 minutes a fortnight',
    },
    {
      text: `Log the policy, premium, covered position and renewal dates in a farm log; at the end, let the policy lapse naturally rather than cancelling early, and keep the log with the position it protected`,
      cost: 'nothing to let it lapse',
      time: '5 minutes',
    },
  ];
}

function defaultPlan(c: FarmContext): FarmStep[] {
  return [
    {
      text: `Create a fresh wallet, fund it with USDC and gas on ${c.chain}, and read ${c.name}'s main product page end to end: farm only what you can describe in one sentence`,
      cost: `one transfer in, about ${c.gas} of gas`,
      time: '15 minutes',
    },
    {
      text: `Make ${c.name}'s core action on ${c.chain} with $${c.capital}: the deposit, stake or trade its front page leads with, and keep the resulting position or receipt in the farming wallet`,
      cost: `$${c.capital} of capital plus about ${c.gas} of gas`,
      time: '20 minutes',
    },
    {
      text: `Repeat one small qualifying action in ${c.name} each week, a top-up, a claim-and-restake or a small trade, so the wallet's history grows by weeks rather than by one large day`,
      cost: `about ${c.gas} of gas per weekly action`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${c.hold} days so it is counted in several weekly snapshots, and resist moving it for a better-looking rate elsewhere mid-window`,
      cost: `the $${c.capital} stays in the position for the whole window`,
      time: `${c.hold} days`,
    },
    {
      text: `Check ${c.name}'s own points or rewards page every fortnight and confirm the position is being counted as its rules describe; claim only from the link the protocol itself publishes`,
      cost: 'free to check, and never pay a third party to claim for you',
      time: '10 minutes a fortnight',
    },
    {
      text: `Write the wallet, dates, amounts and transaction hashes in a farm log as you go; to exit, unwind the position in one session and record what the farm actually earned`,
      cost: `about ${c.gas} of gas to unwind`,
      time: '15 minutes',
    },
  ];
}

/** The tailored plan for a category, or the default plan for one the radar has no specialist for. */
function planFor(category: string | null, c: FarmContext): FarmStep[] {
  switch (category) {
    case 'Dexs':
      return dexsPlan(c);
    case 'Lending':
      return lendingPlan(c);
    case 'Derivatives':
      return derivativesPlan(c);
    case 'Bridge':
      return bridgePlan(c);
    case 'Canonical Bridge':
      return canonicalBridgePlan(c);
    case 'Cross Chain Bridge':
      return crossChainBridgePlan(c);
    case 'Yield':
      return yieldPlan(c);
    case 'Yield Aggregator':
      return yieldAggregatorPlan(c);
    case 'Risk Curators':
      return riskCuratorsPlan(c);
    case 'Onchain Capital Allocator':
      return allocatorPlan(c);
    case 'CDP':
      return cdpPlan(c);
    case 'Liquid Staking':
      return liquidStakingPlan(c);
    case 'Liquid Restaking':
      return liquidRestakingPlan(c);
    case 'Restaking':
      return restakingPlan(c);
    case 'Staking Pool':
      return stakingPoolPlan(c);
    case 'RWA':
      return rwaPlan(c);
    case 'CEX':
      return cexPlan(c);
    case 'Basis Trading':
      return basisTradingPlan(c);
    case 'Chain':
      return chainPlan(c);
    case 'Payments':
      return paymentsPlan(c);
    case 'Insurance':
      return insurancePlan(c);
    default:
      return defaultPlan(c);
  }
}

/**
 * A protocol's farm plan: six steps written for its category and its own facts (name, first chain,
 * chain count, a capital tier from its TVL, its chain's gas class, a hold window from its age).
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  return planFor(p.category, farmContext(p, age));
}
