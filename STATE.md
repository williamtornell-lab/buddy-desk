# state.json

Buddy publishes one JSON file per desk at `d/{secret}/state.json`. The phone loads it from the `#d=` hash. A file that only has the original fields still renders.

## Performance

| Field | Type | Meaning |
| --- | --- | --- |
| `paper_start_stack` | number | Paper stack at the start of the night. Same number as `settings.paper_start_stack` when that exists. |
| `pnl_usd` | number | Night P&L in dollars: `balance - paper_start_stack`. |
| `pnl_pct` | number | `pnl_usd / paper_start_stack * 100`. `0` when the start stack is `0`. |
| `equity` | `{ts, balance}[]` | Stack over time. `ts` is unix seconds. Empty or missing: the chart draws a flat line at `balance`. |
| `trades` | trade[] | Coins bought and sold. Closed rows carry P&L. Open rows are optional. |

`snapshot_state_patch.py` builds these five fields from the SQLite `positions` table and an optional `equity` table `(ts REAL, balance REAL)`.

### Trade

```json
{
  "mint": "…",
  "name": "Night Owl",
  "symbol": "NIGHT",
  "side_or_status": "closed",
  "entry": 0.000021,
  "exit": 0.0000287,
  "size_usd": 50,
  "pnl_usd": 18.4,
  "pnl_pct": 36.8,
  "fees_usd": 0.35,
  "opened_at": 1793942000,
  "closed_at": 1793945206,
  "exit_reason": "trail",
  "link": "https://fomo.family/coins/solana/…?r=…"
}
```

`side_or_status` is the position status (`open`, `exiting`, `closed`, `sold`, …) or a side. Timestamps may be unix seconds or ISO strings. A missing P&L stays blank. The app does not invent a profit.

When `trades` is absent, rows are derived from `positions`. Names fall back to `coins[mint]`. An empty `trades` array means there are no fills.

## Fields the desk already used

- `mode`, `balance`, `open_usd`, `free`, `ts`
- `positions[]` — open book (`status`, `mint`, `name`, `symbol`, `size_usd`, `entry`, `stop_pct`, `link`)
- `activity[]` — tape (`title`, `detail`, `kind`, `ts`, `link`, `mint`)
- `agents` — `{name: {heartbeat, age_s, paused}}`
- `settings` — collapsed on the Agents tab. `settings.paper_start_stack` is the fallback when the top-level field is missing
- `signup_url`, `fomo_handle`, `coins`, `scans`, `waiting`

## Empty desk

Zero trades, an empty `equity` list, and no open positions are a normal night. The screen shows a flat stack and says there are no trades yet. It does not fill in sample fills.

`demo-state.json` is a design fixture, not a live desk. Open it with `#fixture=demo`. A `#d=` link always wins.
