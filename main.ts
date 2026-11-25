// Tiny Bot — confirmed EMA trend rider for agent-fun/bars-replay/v1.
//
// Idea (robust, not dev-tuned): ride a trend only once two hourly bars in a
// row agree it is up, sit in USDC the rest of the time, and cap every loss
// with a hard stop plus a trailing stop. Position size is capped at 15%
// of equity per symbol, so a single volatile name cannot dominate the
// book. No price or date from the dev window
// is baked in anywhere, so the same rule works in an up window, a down
// window, or a choppy one: in a down window it mostly holds cash, in an up
// window it holds the risers.
//
// Wire: the hello message opens the run, then one batch per bar arrives and
// this bot answers it with one reply carrying its orders for that bar.
// Orders decided on a bar fill at the next bar's open, so every decision
// here uses only closes that are already known.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

// Trend lengths (bars). Short enough to catch a multi-day move, long enough
// that hourly noise does not flip the signal every bar.
const FAST_LEN = 8;
const SLOW_LEN = 21;
// A signal must repeat this many bars in a row before the bot acts on it:
// one stray bar never opens or closes a position.
const CONFIRM_BARS = 2;
// Target weight of equity per symbol (cap is 25% from hello.caps).
// Kept at 15% rather than 20%: the v1 dev run lost most in two volatile
// memecoins, so no single symbol should be able to take a fifth of equity.
const TARGET_WEIGHT_BPS = 1500;
// Hard stop: exit when the close falls this far below the entry close.
const STOP_PCT = 0.96;
// Trailing stop: exit when the close falls this far below the best close
// seen since the entry.
const TRAIL_PCT = 0.94;

interface Track {
  barsSeen: number;
  emaFast: number;
  emaSlow: number;
  bullStreak: number;
  bearStreak: number;
  entryClose: number;
  peakClose: number;
}

const tracks = new Map<string, Track>();

function trackFor(symbol: string): Track {
  let t = tracks.get(symbol);
  if (t === undefined) {
    t = { barsSeen: 0, emaFast: 0, emaSlow: 0, bullStreak: 0, bearStreak: 0, entryClose: 0, peakClose: 0 };
    tracks.set(symbol, t);
  }
  return t;
}

function emaUpdate(prev: number, price: number, len: number): number {
  const k = 2 / (len + 1);
  return price * k + prev * (1 - k);
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Warm-up bars build history only; trading on them is rejected.
    if (state.warmingUp) return [];
    const orders: OrderInput[] = [];
    // Cash left to spend this batch; sells in this reply do not fund buys.
    let cashLeft = state.cash;
    for (const bar of batch.bars) {
      const symbol = bar.symbol;
      const close = Number(bar.c);
      if (!Number.isFinite(close) || close <= 0) continue;
      const t = trackFor(symbol);
      t.barsSeen += 1;
      if (t.barsSeen === 1) {
        t.emaFast = close;
        t.emaSlow = close;
        continue;
      }
      t.emaFast = emaUpdate(t.emaFast, close, FAST_LEN);
      t.emaSlow = emaUpdate(t.emaSlow, close, SLOW_LEN);
      // Need a full slow window before trusting the crossover.
      if (t.barsSeen <= SLOW_LEN) continue;
      const held = state.positions.get(symbol);
      const holding = held !== undefined && held.qty > 0n;
      const bullish = t.emaFast > t.emaSlow && close > t.emaSlow;
      const bearish = t.emaFast < t.emaSlow && close < t.emaSlow;
      t.bullStreak = bullish ? t.bullStreak + 1 : 0;
      t.bearStreak = bearish ? t.bearStreak + 1 : 0;
      if (holding) {
        if (close > t.peakClose) t.peakClose = close;
        const stopped = close <= t.entryClose * STOP_PCT || close <= t.peakClose * TRAIL_PCT;
        const trendGone = t.bearStreak >= CONFIRM_BARS;
        if (stopped || trendGone) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: 100 });
          t.entryClose = 0;
          t.peakClose = 0;
          t.bullStreak = 0;
        }
        continue;
      }
      if (t.bullStreak < CONFIRM_BARS) continue;
      // Target 15% of equity in this symbol, never over the weight cap and
      // never over the cash still free for this batch's orders.
      const target = (state.equity * BigInt(TARGET_WEIGHT_BPS)) / 10000n;
      const room = state.weightRoom(symbol);
      let spend = target < room ? target : room;
      if (spend > cashLeft) spend = cashLeft;
      const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
      if (spend <= minNotional) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: 100 });
      cashLeft -= spend;
      t.entryClose = close;
      t.peakClose = close;
      t.bullStreak = 0;
    }
    return orders;
  },
});
