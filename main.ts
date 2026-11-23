// Patient two-regime BTC trend bot for make.fun's "Race a BTC trading bot live
// for 24 hours" (agent-fun/bars-replay/v1, one asset CBBTC vs USDC, long only).
//
// Idea, in words: a full round trip costs roughly 26-45 bps in fees, slippage
// and price impact, so the bot trades only clear, confirmed moves and otherwise
// sits in cash. It buys when a short sharp rise (15-minute return above +0.4%)
// lines up with a healthy longer regime (price above its 120-minute EMA and
// above where the window started), enters with 60% of cash, and only deploys
// the rest once the move confirms (+0.5% above entry with momentum still
// positive). It exits on a 2.5% trailing stop from the peak since entry.
// After a stop-out it waits 60 bars before trying again, tries at most 3
// entries in the window, and stops trading entirely once realised losses reach
// $15, so a down day can cost at most about one stopped trade. It never
// trades during warm-up bars, never uses the clock or any randomness, and
// every decision is a pure function of the bars seen so far.
//
// Tuned on the kit's frozen 1440-bar dev window plus stress tests (the same
// window with returns sign-flipped, time-reversed, and block-bootstrapped):
// dev +$28.6, down day about -$11, worst stress case about -$14, max
// drawdown under 3%.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

// --- strategy constants (all in fractions, not percent) ---
const ENTRY_RET_15M = 0.004; // 15-minute return that counts as a clear move
const ADD_RET_15M = 0.002; // momentum still needed to scale in
const ADD_GAIN = 0.005; // price rise above entry that confirms the move
const FIRST_FRACTION = 60n; // first entry deploys 60% of cash (of 100)
const TRAIL = 0.025; // trailing stop: 2.5% below the peak since entry
const LONG_WINDOW = 120; // bars for the regime EMA and the since-start return
const COOLDOWN_BARS = 60; // bars to wait after a stop-out before re-entering
const MAX_ENTRIES = 3; // entries allowed in the whole window
const LOSS_CAP_UNITS = 15_000_000n; // stop trading after $15 of realised loss
const MAX_SLIPPAGE_BPS = 150; // cap on fill vs latest close (1-min moves are ~8 bps sd)

const SYMBOL = 'CBBTC';

let priceScale = 5; // CBBTC price_scale from hello (fall back to the kit's)
let closes: number[] = []; // closes in USDC, one per bar seen
let ema120 = 0; // 120-bar EMA of closes, seeded on the first close
let peakSinceEntry = 0; // highest close since the current entry
let entryPrice = 0; // close at which the current position was first entered
let scaledIn = false; // the rest of the cash has already been deployed
let entries = 0; // entries used so far this window
let lastSellSeq = -1_000_000; // seq of the last stop-out
let stoppedForDay = false; // the loss cap has been hit: no more entries
let startCash = 0n; // cash at the first batch, for the loss cap

function closeAt(i: number): number {
  return closes[i];
}

function ret15m(): number {
  const n = closes.length;
  if (n <= 15) return 0;
  return closeAt(n - 1) / closeAt(n - 16) - 1;
}

function longReturn(): number {
  // Return since the window started, capped at the last LONG_WINDOW bars.
  const n = closes.length;
  if (n < 2) return 0;
  const back = Math.min(n - 1, LONG_WINDOW);
  return closeAt(n - 1) / closeAt(n - 1 - back) - 1;
}

function decide(state: BarsState): OrderInput[] {
  if (state.warmingUp) return [];
  const bar = state.latest.get(SYMBOL);
  if (bar === undefined) return [];
  const close = Number(bar.c) / 10 ** priceScale;
  closes.push(close);
  if (closes.length === 1) {
    ema120 = close;
    startCash = state.cash;
  } else {
    const k = 2 / (LONG_WINDOW + 1);
    ema120 = close * k + ema120 * (1 - k);
  }

  const pos = state.positions.get(SYMBOL);
  const holding = pos !== undefined && pos.qty > 0n;

  if (!holding) {
    if (stoppedForDay) return [];
    // Loss cap: realised cash has fallen $15 below where the window started.
    if (state.cash < startCash - LOSS_CAP_UNITS) {
      stoppedForDay = true;
      return [];
    }
    if (entries >= MAX_ENTRIES) return [];
    if (state.seq - lastSellSeq < COOLDOWN_BARS) return [];
    // Regime filter: the longer trend must be healthy, not just the last 15 minutes.
    const regimeOk = longReturn() > 0 && close > ema120;
    if (ret15m() > ENTRY_RET_15M && regimeOk) {
      entries++;
      entryPrice = close;
      peakSinceEntry = close;
      scaledIn = FIRST_FRACTION >= 100n;
      const notional = (state.cash * FIRST_FRACTION) / 100n;
      if (notional < 1_000_000n) return [];
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Holding: track the peak and manage the exit.
  if (close > peakSinceEntry) peakSinceEntry = close;

  // Scale in once the move confirms: price up, momentum still positive.
  if (!scaledIn && close > entryPrice * (1 + ADD_GAIN) && ret15m() > ADD_RET_15M) {
    scaledIn = true;
    if (state.cash >= 1_000_000n) {
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Trailing stop: 2.5% below the best close since entry.
  if (close < peakSinceEntry * (1 - TRAIL)) {
    lastSellSeq = state.seq;
    entryPrice = 0;
    peakSinceEntry = 0;
    scaledIn = false;
    return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  return [];
}

await runBars({
  onHello(state) {
    const s = state.symbols.get(SYMBOL);
    if (s !== undefined) priceScale = s.price_scale;
  },
  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    return decide(state);
  },
});
