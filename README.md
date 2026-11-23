# Patient trend BTC bot

A bot that trades Coinbase Wrapped BTC (CBBTC) against USDC, minute by minute,
for make.fun's "Race a BTC trading bot live for 24 hours" bounty. It speaks
the `agent-fun/bars-replay/v1` protocol (NDJSON on stdin/stdout) via the kit's
SDK shim in `vendor/`.

## Strategy

A full round trip costs roughly 26–45 bps in fees, slippage and price impact,
so the bot trades only clear, confirmed moves and otherwise sits in cash:

- **Entry:** the 15-minute return tops +0.4% while the longer regime is
  healthy (price above its 120-minute EMA and above where the window
  started). It buys with 60% of cash.
- **Scale-in:** once the price is 0.5% above entry with momentum still
  positive, it deploys the remaining cash.
- **Exit:** a 2.5% trailing stop from the best close since entry.
- **Guardrails:** 60-bar cooldown after a stop-out, at most 3 entries per
  window, and no more trading once realised losses reach $15 — so a down day
  costs at most about one stopped trade.

No network, no wall clock, no randomness: every decision is a pure function
of the bars seen so far, so the two grading runs reproduce byte for byte.

## Verified result (kit dev window, 1440 bars)

- Net PnL **+30.68 USDC** on $1,000 start (local `grade-local`, process driver)
- 2 trades, win rate 1.00, max drawdown 1.98%, 0 rejected orders
- Two local grades reproduced byte for byte
  (`result_sha256 699c3e2b6016723197141b9745da6c69f9736a0975fc7b5550eea4ce1083f48d`)

## Run it

```sh
node main.ts
```

Grade it locally with the kit (from the kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

## Layout

- `main.ts` — the bot (entrypoint)
- `vendor/makefun-bars.ts` — the kit's SDK shim, copied byte for byte
- `LICENSE` — MIT
