"""Performance fields for Buddy's Plan B ``state.json``.

Merge the dict from ``performance_fields`` into the snapshot the iPhone app
already loads. This file does not import Buddy internals and does not read
secrets.

On the live box::

    from snapshot_state_patch import performance_fields

    state = snapshot_state()
    state.update(performance_fields(
        conn,
        balance=state["balance"],
        paper_start_stack=(state.get("settings") or {}).get("paper_start_stack"),
        coins=state.get("coins"),
        link_for=links.coin_url,
    ))

Tables
------
``positions`` — existing book. Closed rows (status ``closed`` / ``sold`` /
``exited``, or a ``closed_at`` value) become trades. Open and exiting rows are
included too. Missing columns stay null. Recognized names:

    mint, name, symbol, status, side,
    entry | entry_price, exit | exit_price | avg_exit,
    size_usd | size, pnl_usd | realized_pnl | pnl, pnl_pct,
    fees_usd | fees, opened_at, closed_at, exit_reason, link

Stored ``pnl_usd`` / ``pnl_pct`` are kept. When a closed row has prices and
size but no stored P&L, ``pnl_usd`` is ``size * (exit / entry - 1) - fees``
and ``pnl_pct`` is that net P&L over size. Open rows are not given a guessed
P&L.

``equity`` — optional, created by Buddy::

    CREATE TABLE IF NOT EXISTS equity (
        ts REAL NOT NULL,
        balance REAL NOT NULL
    );

Insert a row on a timer and on each fill. When the table is missing or empty,
the helper builds a short curve from the paper start stack and closed-trade
P&L, then pins the right edge to the current balance. With no closes, that
curve is a flat line at the current balance.
"""

from __future__ import annotations

import sqlite3
import time
from typing import Any, Callable, Mapping

_CLOSED = {"closed", "sold", "exited", "exit", "filled_exit"}
_OPEN = {"open", "opening", "exiting", "live"}
_MAX_POINTS = 360


def performance_fields(
    conn: sqlite3.Connection,
    *,
    balance: float,
    paper_start_stack: float | None = None,
    now: float | None = None,
    coins: Mapping[str, Mapping[str, Any]] | None = None,
    link_for: Callable[[str | None], str | None] | None = None,
) -> dict[str, Any]:
    """Return ``paper_start_stack``, ``pnl_usd``, ``pnl_pct``, ``equity``, ``trades``."""
    bal = _f(balance)
    if bal is None:
        bal = 0.0
    start = _f(paper_start_stack)
    if start is None:
        start = bal
    clock = _f(now)
    if clock is None:
        clock = time.time()
    trades = _trades(conn, coins or {}, link_for)
    pnl = bal - start
    pct = (pnl / start * 100.0) if start else 0.0
    return {
        "paper_start_stack": _num(start),
        "pnl_usd": _num(pnl),
        "pnl_pct": _num(pct),
        "equity": _equity(conn, trades, bal, start, clock),
        "trades": trades,
    }


def _trades(
    conn: sqlite3.Connection,
    coins: Mapping[str, Mapping[str, Any]],
    link_for: Callable[[str | None], str | None] | None,
) -> list[dict[str, Any]]:
    cols = _columns(conn, "positions")
    if not cols:
        return []
    if "closed_at" in cols and "opened_at" in cols:
        order = "COALESCE(closed_at, opened_at) DESC"
    elif "opened_at" in cols:
        order = "opened_at DESC"
    else:
        order = "rowid DESC"
    try:
        rows = _rows(conn, f"SELECT * FROM positions ORDER BY {order}")
    except sqlite3.Error:
        return []
    closed = [row for row in rows if _is_closed(row)]
    opened = [row for row in rows if not _is_closed(row)]
    return [_trade(row, coins, link_for, closed=True) for row in closed] + [
        _trade(row, coins, link_for, closed=False) for row in opened
    ]


def _trade(
    row: Mapping[str, Any],
    coins: Mapping[str, Mapping[str, Any]],
    link_for: Callable[[str | None], str | None] | None,
    *,
    closed: bool,
) -> dict[str, Any]:
    mint = _text(_first(row, ("mint", "token")))
    coin = coins.get(mint) if mint and isinstance(coins.get(mint), Mapping) else {}
    entry = _f(_first(row, ("entry", "entry_price", "avg_entry")))
    exit_px = _f(_first(row, ("exit", "exit_price", "avg_exit")))
    size = _f(_first(row, ("size_usd", "size", "notional_usd")))
    fees = _f(_first(row, ("fees_usd", "fees")))
    pnl = _f(_first(row, ("pnl_usd", "realized_pnl", "pnl")))
    pnl_pct = _f(_first(row, ("pnl_pct",)))
    if closed and pnl is None and entry not in (None, 0.0) and exit_px is not None and size is not None:
        pnl = size * (exit_px / entry - 1.0) - (fees or 0.0)
    if pnl_pct is None and pnl is not None and size:
        pnl_pct = pnl / size * 100.0
    elif pnl_pct is None and closed and entry not in (None, 0.0) and exit_px is not None:
        pnl_pct = (exit_px / entry - 1.0) * 100.0
    status = _first(row, ("status", "side"))
    if status is None:
        status = "closed" if closed else "open"
    link = _text(_first(row, ("link", "url")))
    if link is None and link_for is not None and mint:
        try:
            link = _text(link_for(mint))
        except Exception:
            link = None
    return {
        "mint": mint,
        "name": _text(_first(row, ("name",))) or _text(coin.get("name")),
        "symbol": _text(_first(row, ("symbol", "ticker"))) or _text(coin.get("symbol")),
        "side_or_status": str(status),
        "entry": _num(entry),
        "exit": _num(exit_px),
        "size_usd": _num(size),
        "pnl_usd": _num(pnl),
        "pnl_pct": _num(pnl_pct),
        "fees_usd": _num(fees),
        "opened_at": _first(row, ("opened_at", "opened", "ts_open")),
        "closed_at": _first(row, ("closed_at", "closed", "ts_close")),
        "exit_reason": _text(_first(row, ("exit_reason", "reason"))) if closed else None,
        "link": link,
    }


def _equity(
    conn: sqlite3.Connection,
    trades: list[dict[str, Any]],
    balance: float,
    start: float,
    now: float,
) -> list[dict[str, float]]:
    points = _equity_table(conn)
    if not points:
        points = _synthetic_equity(trades, balance, start, now)
    points = _pin_now(points, balance, now)
    points.sort(key=lambda p: p["ts"])
    return _downsample(points, _MAX_POINTS)


def _equity_table(conn: sqlite3.Connection) -> list[dict[str, float]]:
    if "ts" not in _columns(conn, "equity") or "balance" not in _columns(conn, "equity"):
        return []
    try:
        rows = _rows(conn, "SELECT ts, balance FROM equity ORDER BY ts ASC")
    except sqlite3.Error:
        return []
    points = []
    for row in rows:
        ts = _unix(row.get("ts"))
        bal = _f(row.get("balance"))
        if ts is None or bal is None:
            continue
        points.append({"ts": ts, "balance": bal})
    return points


def _synthetic_equity(
    trades: list[dict[str, Any]],
    balance: float,
    start: float,
    now: float,
) -> list[dict[str, float]]:
    closed = [t for t in trades if str(t.get("side_or_status") or "").lower() in _CLOSED or t.get("closed_at")]
    events = []
    for trade in closed:
        ts = _unix(trade.get("closed_at")) or _unix(trade.get("opened_at")) or now
        events.append((ts, _f(trade.get("pnl_usd"))))
    events.sort(key=lambda item: item[0])
    if not events:
        return [
            {"ts": now - 3600.0, "balance": balance},
            {"ts": now, "balance": balance},
        ]
    opened = [_unix(t.get("opened_at")) for t in closed]
    opened = [ts for ts in opened if ts is not None]
    anchor = min(opened) if opened else events[0][0]
    if anchor > events[0][0]:
        anchor = events[0][0]
    points = [{"ts": anchor, "balance": start}]
    running = start
    for ts, pnl in events:
        if pnl is not None:
            running += pnl
        points.append({"ts": ts, "balance": running})
    return points


def _pin_now(points: list[dict[str, float]], balance: float, now: float) -> list[dict[str, float]]:
    if not points:
        return [{"ts": now, "balance": balance}]
    last = points[-1]
    same = abs(last["balance"] - balance) <= 0.01
    if abs(last["ts"] - now) <= 1 and same:
        return points
    if abs(last["ts"] - now) <= 1:
        points[-1] = {"ts": now, "balance": balance}
        return points
    points.append({"ts": now, "balance": balance})
    return points


def _downsample(points: list[dict[str, float]], limit: int) -> list[dict[str, float]]:
    cleaned = []
    for point in points:
        item = {"ts": _num(point["ts"]), "balance": _num(point["balance"])}
        if item["ts"] is None or item["balance"] is None:
            continue
        cleaned.append({"ts": float(item["ts"]), "balance": float(item["balance"])})
    if len(cleaned) <= limit:
        return cleaned
    step = (len(cleaned) - 1) / (limit - 1)
    out = []
    for i in range(limit):
        item = cleaned[round(i * step)]
        if not out or out[-1] is not item:
            out.append(item)
    if out[-1] is not cleaned[-1]:
        out.append(cleaned[-1])
    return out


def _is_closed(row: Mapping[str, Any]) -> bool:
    status = _first(row, ("status", "side"))
    text = str(status).strip().lower() if status is not None else ""
    if text in _CLOSED:
        return True
    if text in _OPEN:
        return False
    return _first(row, ("closed_at", "closed", "ts_close")) is not None


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error:
        return set()
    return {row[1] for row in rows}


def _rows(conn: sqlite3.Connection, sql: str) -> list[dict[str, Any]]:
    cur = conn.execute(sql)
    names = [col[0] for col in cur.description] if cur.description else []
    return [dict(zip(names, row)) for row in cur.fetchall()]


def _first(row: Mapping[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in row and row[key] is not None and row[key] != "":
            return row[key]
    return None


def _f(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _num(value: Any) -> float | None:
    number = value if isinstance(value, float) else _f(value)
    if number is None:
        return None
    return float(f"{number:.10g}")


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _unix(value: Any) -> float | None:
    number = _f(value)
    if number is not None:
        return number / 1000.0 if number > 1e12 else number
    if isinstance(value, str):
        from datetime import datetime

        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def _self_check() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE positions (
            mint TEXT, name TEXT, symbol TEXT, status TEXT,
            entry REAL, exit_price REAL, size_usd REAL,
            pnl_usd REAL, pnl_pct REAL, fees_usd REAL,
            opened_at REAL, closed_at REAL, exit_reason TEXT, link TEXT
        )
        """
    )
    conn.execute(
        "CREATE TABLE equity (ts REAL NOT NULL, balance REAL NOT NULL)"
    )
    conn.executemany(
        "INSERT INTO equity (ts, balance) VALUES (?, ?)",
        [(100.0, 200.0), (500.0, 210.0)],
    )
    conn.execute(
        """
        INSERT INTO positions
        (mint, status, entry, exit_price, size_usd, pnl_usd, pnl_pct, fees_usd, opened_at, closed_at, exit_reason)
        VALUES ('MintWin', 'closed', 1, 2, 50, 18.4, 36.8, 0.35, 80, 400, 'trail')
        """
    )
    conn.execute(
        """
        INSERT INTO positions
        (mint, status, entry, exit_price, size_usd, fees_usd, opened_at, closed_at, exit_reason)
        VALUES ('MintLoss', 'sold', 2, 3, 10, 1, 200, 450, 'stop')
        """
    )
    conn.execute(
        """
        INSERT INTO positions (mint, status, entry, size_usd, opened_at, link)
        VALUES ('MintOpen', 'open', 0.5, 40, 480, 'https://fomo.family/coins/solana/MintOpen')
        """
    )
    conn.commit()
    fields = performance_fields(
        conn,
        balance=212.2,
        paper_start_stack=200,
        now=1000,
        coins={"MintWin": {"name": "Night Owl", "symbol": "NIGHT"}},
        link_for=lambda mint: f"https://fomo.family/coins/solana/{mint}",
    )
    assert fields["paper_start_stack"] == 200
    assert fields["pnl_usd"] == 12.2
    assert abs(fields["pnl_pct"] - 6.1) < 1e-9
    assert [p["balance"] for p in fields["equity"]][:2] == [200.0, 210.0]
    assert fields["equity"][-1] == {"ts": 1000.0, "balance": 212.2}
    by_mint = {t["mint"]: t for t in fields["trades"]}
    assert by_mint["MintWin"]["name"] == "Night Owl"
    assert by_mint["MintWin"]["symbol"] == "NIGHT"
    assert by_mint["MintWin"]["pnl_usd"] == 18.4
    assert by_mint["MintWin"]["link"].endswith("MintWin")
    # size 10 * (3/2 - 1) - fee 1 = 4, pct 40. Stored values are not double-charged.
    assert by_mint["MintLoss"]["pnl_usd"] == 4
    assert by_mint["MintLoss"]["pnl_pct"] == 40
    assert by_mint["MintLoss"]["exit"] == 3
    assert by_mint["MintOpen"]["pnl_usd"] is None
    assert by_mint["MintOpen"]["exit_reason"] is None
    assert fields["trades"][-1]["mint"] == "MintOpen"

    bare = sqlite3.connect(":memory:")
    bare.execute(
        """
        CREATE TABLE positions (
            mint TEXT, status TEXT, entry REAL, exit REAL, size_usd REAL,
            fees_usd REAL, opened_at REAL, closed_at REAL
        )
        """
    )
    bare.execute(
        "INSERT INTO positions VALUES ('A', 'closed', 2, 3, 10, 1, 700, 800)"
    )
    bare.execute(
        "INSERT INTO positions VALUES ('B', 'closed', 4, 2, 20, 0, 850, 900)"
    )
    bare.commit()
    built = performance_fields(bare, balance=212.2, paper_start_stack=200, now=1000)
    assert [(p["ts"], p["balance"]) for p in built["equity"]] == [
        (700.0, 200.0),
        (800.0, 204.0),
        (900.0, 194.0),
        (1000.0, 212.2),
    ]
    empty = sqlite3.connect(":memory:")
    flat = performance_fields(empty, balance=200, paper_start_stack=200, now=1000)
    assert flat["trades"] == []
    assert flat["pnl_usd"] == 0
    assert flat["equity"] == [
        {"ts": -2600.0, "balance": 200.0},
        {"ts": 1000.0, "balance": 200.0},
    ]
    wide = sqlite3.connect(":memory:")
    wide.execute("CREATE TABLE equity (ts REAL, balance REAL)")
    wide.executemany(
        "INSERT INTO equity VALUES (?, ?)",
        [(float(i), 100.0 + i) for i in range(500)],
    )
    wide.commit()
    curve = performance_fields(wide, balance=599, paper_start_stack=100, now=499)
    assert len(curve["equity"]) <= _MAX_POINTS + 1
    assert curve["equity"][0]["ts"] == 0
    assert curve["equity"][-1]["balance"] == 599


if __name__ == "__main__":
    _self_check()
    print("snapshot_state_patch ok")
