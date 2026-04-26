"""
통합 차트패턴 + 엘리어트 + 피보나치 + 백테스트 + 멀티TF + 알림 + 리스크관리 시스템

실행:
    python scripts/trading_system.py

필요 패키지:
    pip install pandas numpy scipy matplotlib yfinance pykrx requests

구조:
    1. CONFIG / DATA LAYER
    2. UTILITIES (ATR, swing, trend)
    3. PATTERN DETECTION (14종)
    4. PATTERN HISTORY SCANNER
    5. ELLIOTT WAVE (5파 시나리오)
    6. FIBONACCI LEVELS
    7. SCORING SYSTEM
    8. TRADING DECISION (TradeReport)
    9. BACKTEST ENGINE
    10. MULTI-TIMEFRAME
    11. ALERTS (Telegram / Email)
    12. KRX TICKER MAP
    13. RISK MANAGEMENT (position sizing, split entry/exit)
    14. VISUALIZATION
    15. INTEGRATED RUNNER
"""

from __future__ import annotations

import os
import pickle
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


def _ensure_ascii_ssl_cert() -> None:
    """Windows에서 사용자 경로에 한글이 섞이면 curl_cffi가 cacert.pem 경로를
    열지 못해 yfinance가 SSL 에러로 실패한다. ASCII 안전 경로로 복사 후
    SSL_CERT_FILE 계열 환경변수를 설정한다."""
    if sys.platform != "win32":
        return
    try:
        import certifi
    except ImportError:
        return
    src = certifi.where()
    if src.isascii():
        return
    dst = Path(r"C:\Users\Public\dw_cacert.pem")
    try:
        if not dst.exists() or dst.stat().st_size != Path(src).stat().st_size:
            shutil.copy2(src, dst)
    except OSError:
        return
    for var in ("SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE"):
        os.environ.setdefault(var, str(dst))


_ensure_ascii_ssl_cert()

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from scipy.signal import argrelextrema

try:
    import yfinance as yf
except ImportError:
    yf = None


# =====================================================================
# 1. CONFIG
# =====================================================================
FIB_RETRACE = [0.236, 0.382, 0.5, 0.618, 0.786]
FIB_EXTEND = [1.0, 1.272, 1.618, 2.0]

SCORE_WEIGHTS = {
    "trend": 0.20,
    "volume": 0.15,
    "pattern": 0.20,
    "wave": 0.15,
    "fib": 0.15,
    "risk_reward": 0.15,
}

# 기본 종목명 매핑 (KRX 전체가 필요하면 load_krx_tickers() 사용)
KR_TICKER_MAP = {
    "SK하이닉스": "000660.KS",
    "삼성전자": "005930.KS",
    "네이버": "035420.KS",
    "카카오": "035720.KS",
    "에이디테크놀로지": "200710.KQ",
    "티엘비": "356860.KQ",
    "이수페타시스": "007660.KS",
    "셀트리온": "068270.KS",
    "현대차": "005380.KS",
    "LG에너지솔루션": "373220.KS",
}


def ticker_from_name(name: str) -> Optional[str]:
    return KR_TICKER_MAP.get(name)


# =====================================================================
# 2. DATA LAYER
# =====================================================================
def get_data(ticker: str, period: str = "1y", interval: str = "1d") -> pd.DataFrame:
    """yfinance에서 OHLCV 로딩"""
    if yf is None:
        raise RuntimeError("yfinance 미설치: pip install yfinance")
    df = yf.download(ticker, period=period, interval=interval,
                     auto_adjust=False, progress=False)
    if df.empty:
        return df
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]
    df = df[["Open", "High", "Low", "Close", "Volume"]].dropna()
    return df


# =====================================================================
# 3. UTILITIES
# =====================================================================
def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    """Average True Range"""
    prev_close = df["Close"].shift(1)
    tr = pd.concat([
        df["High"] - df["Low"],
        (df["High"] - prev_close).abs(),
        (df["Low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.rolling(n).mean()


def find_swings(df: pd.DataFrame, order: int = 5) -> tuple[np.ndarray, np.ndarray]:
    """로컬 극값 기반 스윙 고점/저점"""
    highs = argrelextrema(df["High"].values, np.greater_equal, order=order)[0]
    lows = argrelextrema(df["Low"].values, np.less_equal, order=order)[0]
    return highs, lows


def trend_slope(df: pd.DataFrame, ma: int = 60, lookback: int = 20) -> float:
    m = df["Close"].rolling(ma).mean()
    if m.notna().sum() < lookback + 1:
        return 0.0
    return float((m.iloc[-1] - m.iloc[-lookback]) / m.iloc[-lookback])


def vol_spike(df: pd.DataFrame, i: int, lb: int = 20, mult: float = 1.5) -> bool:
    if i < lb:
        return False
    return df["Volume"].iloc[i] >= df["Volume"].iloc[i - lb:i].mean() * mult


def _result(det: bool, idx=None, conf: int = 0, meta: dict | None = None) -> dict:
    return {"detected": bool(det), "index": idx,
            "confidence": int(max(0, min(100, conf))),
            "meta": meta or {}}


# =====================================================================
# 4. PATTERN DETECTION
# =====================================================================
def detect_three_white_soldiers(df: pd.DataFrame) -> dict:
    if len(df) < 25:
        return _result(False)
    a = atr(df).iloc[-1]
    i = len(df) - 1
    c = df.iloc[i - 2:i + 1]
    body = c["Close"] - c["Open"]
    upper = c["High"] - c["Close"]
    if (body <= 0).any():
        return _result(False)
    if not (c["Close"].diff().iloc[1:] > 0).all():
        return _result(False)
    if (upper > body * 0.35).any():
        return _result(False)
    if (body < a * 0.8).any():
        return _result(False)
    prev = df.iloc[i - 8:i - 2]
    down_bars = ((prev["Close"] - prev["Open"]) < 0).sum()
    conf = 50 + (20 if vol_spike(df, i) else 0) + (15 if down_bars >= 3 else 0) \
           + (15 if body.iloc[-1] >= body.iloc[0] else 0)
    return _result(True, df.index[i], conf, {"type": "three_white_soldiers"})


def detect_three_black_crows(df: pd.DataFrame) -> dict:
    if len(df) < 25:
        return _result(False)
    a = atr(df).iloc[-1]
    i = len(df) - 1
    c = df.iloc[i - 2:i + 1]
    body = c["Open"] - c["Close"]
    lower = c["Close"] - c["Low"]
    if (body <= 0).any():
        return _result(False)
    if not (c["Close"].diff().iloc[1:] < 0).all():
        return _result(False)
    if (lower > body * 0.35).any():
        return _result(False)
    if (body < a * 0.8).any():
        return _result(False)
    prev = df.iloc[i - 8:i - 2]
    up_bars = ((prev["Close"] - prev["Open"]) > 0).sum()
    conf = 50 + (20 if vol_spike(df, i) else 0) + (15 if up_bars >= 3 else 0)
    return _result(True, df.index[i], conf, {"type": "three_black_crows"})


def detect_double_bottom(df: pd.DataFrame, tol: float = 0.03) -> dict:
    _, lows = find_swings(df, order=5)
    if len(lows) < 2:
        return _result(False)
    l1, l2 = lows[-2], lows[-1]
    p1, p2 = df["Low"].iloc[l1], df["Low"].iloc[l2]
    if abs(p1 - p2) / p1 > tol:
        return _result(False)
    mid_seg = df["High"].iloc[l1:l2]
    if mid_seg.empty:
        return _result(False)
    neckline = mid_seg.max()
    last_close = df["Close"].iloc[-1]
    if last_close <= neckline:
        return _result(False)
    conf = 55 + (20 if vol_spike(df, len(df) - 1) else 0) \
           + (15 if last_close > neckline * 1.01 else 0) \
           + (10 if p2 >= p1 else 0)
    return _result(True, df.index[-1], conf,
                   {"type": "double_bottom", "neckline": float(neckline),
                    "bottom": float(min(p1, p2))})


def detect_double_top(df: pd.DataFrame, tol: float = 0.03) -> dict:
    highs, _ = find_swings(df, order=5)
    if len(highs) < 2:
        return _result(False)
    h1, h2 = highs[-2], highs[-1]
    p1, p2 = df["High"].iloc[h1], df["High"].iloc[h2]
    if abs(p1 - p2) / p1 > tol:
        return _result(False)
    mid_seg = df["Low"].iloc[h1:h2]
    if mid_seg.empty:
        return _result(False)
    neckline = mid_seg.min()
    last_close = df["Close"].iloc[-1]
    if last_close >= neckline:
        return _result(False)
    conf = 55 + (20 if vol_spike(df, len(df) - 1) else 0) \
           + (15 if last_close < neckline * 0.99 else 0)
    return _result(True, df.index[-1], conf,
                   {"type": "double_top", "neckline": float(neckline),
                    "top": float(max(p1, p2))})


def detect_head_and_shoulders(df: pd.DataFrame) -> dict:
    highs, lows = find_swings(df, order=5)
    if len(highs) < 3 or len(lows) < 2:
        return _result(False)
    l, m, r = highs[-3], highs[-2], highs[-1]
    pl, pm, pr = [df["High"].iloc[x] for x in (l, m, r)]
    if not (pm > pl and pm > pr):
        return _result(False)
    if abs(pl - pr) / pl > 0.05:
        return _result(False)
    neck_lows = [x for x in lows if l < x < r]
    if len(neck_lows) < 2:
        return _result(False)
    neckline = df["Low"].iloc[neck_lows].mean()
    broken = df["Close"].iloc[-1] < neckline
    conf = 50 + (25 if broken else 0) + (15 if vol_spike(df, len(df) - 1) else 0) \
           + (10 if pm / pl > 1.03 else 0)
    return _result(broken, df.index[-1], conf,
                   {"type": "head_and_shoulders", "neckline": float(neckline),
                    "head": float(pm)})


def detect_inverse_head_and_shoulders(df: pd.DataFrame) -> dict:
    highs, lows = find_swings(df, order=5)
    if len(lows) < 3 or len(highs) < 2:
        return _result(False)
    l, m, r = lows[-3], lows[-2], lows[-1]
    pl, pm, pr = [df["Low"].iloc[x] for x in (l, m, r)]
    if not (pm < pl and pm < pr):
        return _result(False)
    if abs(pl - pr) / pl > 0.05:
        return _result(False)
    neck_highs = [x for x in highs if l < x < r]
    if len(neck_highs) < 2:
        return _result(False)
    neckline = df["High"].iloc[neck_highs].mean()
    broken = df["Close"].iloc[-1] > neckline
    conf = 50 + (25 if broken else 0) + (15 if vol_spike(df, len(df) - 1) else 0) \
           + (10 if pl / pm > 1.03 else 0)
    return _result(broken, df.index[-1], conf,
                   {"type": "inverse_head_and_shoulders",
                    "neckline": float(neckline), "head": float(pm)})


def detect_cup_and_handle(df: pd.DataFrame, min_len: int = 30) -> dict:
    if len(df) < min_len + 10:
        return _result(False)
    window = df.iloc[-(min_len + 10):]
    lhs_high = window["High"].iloc[:5].max()
    cup_low = window["Low"].iloc[5:-10].min()
    rhs_high = window["High"].iloc[-15:-5].max()
    if not (abs(lhs_high - rhs_high) / lhs_high < 0.05):
        return _result(False)
    depth = (lhs_high - cup_low) / lhs_high
    if not (0.12 <= depth <= 0.5):
        return _result(False)
    handle = window.iloc[-5:]
    handle_drop = (rhs_high - handle["Low"].min()) / rhs_high
    if handle_drop > depth * 0.5:
        return _result(False)
    breakout = df["Close"].iloc[-1] > rhs_high
    conf = 55 + (25 if breakout else 0) + (20 if vol_spike(df, len(df) - 1) else 0)
    return _result(breakout, df.index[-1], conf,
                   {"type": "cup_and_handle",
                    "cup_high": float(rhs_high), "cup_low": float(cup_low)})


def detect_triangle(df: pd.DataFrame, lookback: int = 40) -> dict:
    if len(df) < lookback:
        return _result(False)
    w = df.iloc[-lookback:]
    highs, lows = find_swings(w, order=3)
    if len(highs) < 2 or len(lows) < 2:
        return _result(False)
    hi_slope = np.polyfit(highs, w["High"].iloc[highs].values, 1)[0]
    lo_slope = np.polyfit(lows, w["Low"].iloc[lows].values, 1)[0]
    price = w["Close"].mean()
    hi_norm = hi_slope / price
    lo_norm = lo_slope / price
    ttype = None
    if abs(hi_norm) < 0.0005 and lo_norm > 0.0005:
        ttype = "ascending"
    elif hi_norm < -0.0005 and abs(lo_norm) < 0.0005:
        ttype = "descending"
    if ttype is None:
        return _result(False)
    conf = 50 + (20 if vol_spike(df, len(df) - 1) else 0) \
           + (15 if len(highs) >= 3 else 0) + (15 if len(lows) >= 3 else 0)
    return _result(True, df.index[-1], conf,
                   {"type": f"{ttype}_triangle",
                    "resistance": float(w["High"].iloc[highs].mean()),
                    "support": float(w["Low"].iloc[lows].mean())})


def detect_flag(df: pd.DataFrame) -> dict:
    if len(df) < 30:
        return _result(False)
    pole = df.iloc[-20:-10]
    flag = df.iloc[-10:]
    pole_ret = (pole["Close"].iloc[-1] - pole["Close"].iloc[0]) / pole["Close"].iloc[0]
    flag_ret = (flag["Close"].iloc[-1] - flag["Close"].iloc[0]) / flag["Close"].iloc[0]
    ftype = None
    if pole_ret > 0.08 and -0.05 < flag_ret < 0.01:
        ftype = "bull_flag"
    elif pole_ret < -0.08 and -0.01 < flag_ret < 0.05:
        ftype = "bear_flag"
    if ftype is None:
        return _result(False)
    pole_vol = pole["Volume"].mean()
    flag_vol = flag["Volume"].mean()
    vol_ok = flag_vol < pole_vol
    conf = 55 + (25 if vol_ok else 0) + (20 if abs(pole_ret) > 0.15 else 0)
    return _result(True, df.index[-1], conf,
                   {"type": ftype, "pole_return": float(pole_ret)})


def detect_wedge(df: pd.DataFrame, lookback: int = 40) -> dict:
    if len(df) < lookback:
        return _result(False)
    w = df.iloc[-lookback:]
    highs, lows = find_swings(w, order=3)
    if len(highs) < 2 or len(lows) < 2:
        return _result(False)
    hi_slope = np.polyfit(highs, w["High"].iloc[highs].values, 1)[0]
    lo_slope = np.polyfit(lows, w["Low"].iloc[lows].values, 1)[0]
    wtype = None
    if hi_slope > 0 and lo_slope > 0 and lo_slope > hi_slope * 1.2:
        wtype = "rising_wedge"
    elif hi_slope < 0 and lo_slope < 0 and hi_slope < lo_slope * 1.2:
        wtype = "falling_wedge"
    if wtype is None:
        return _result(False)
    return _result(True, df.index[-1], 60, {"type": wtype})


def detect_box_breakout(df: pd.DataFrame, lookback: int = 30) -> dict:
    if len(df) < lookback + 1:
        return _result(False)
    box = df.iloc[-(lookback + 1):-1]
    hi, lo = box["High"].max(), box["Low"].min()
    if (hi - lo) / lo > 0.15:
        return _result(False)
    last = df["Close"].iloc[-1]
    up = last > hi
    dn = last < lo
    if not (up or dn):
        return _result(False)
    direction = "up" if up else "down"
    conf = 55 + (25 if vol_spike(df, len(df) - 1, mult=2.0) else 0) \
           + (20 if abs(last - (hi if up else lo)) / last > 0.01 else 0)
    return _result(True, df.index[-1], conf,
                   {"type": f"box_breakout_{direction}",
                    "box_high": float(hi), "box_low": float(lo)})


def detect_gap(df: pd.DataFrame, min_gap: float = 0.02) -> dict:
    if len(df) < 2:
        return _result(False)
    prev_high = df["High"].iloc[-2]
    prev_low = df["Low"].iloc[-2]
    today_open = df["Open"].iloc[-1]
    if today_open > prev_high * (1 + min_gap):
        gap = (today_open - prev_high) / prev_high
        conf = 60 + min(int(gap * 500), 30) + (10 if vol_spike(df, len(df) - 1) else 0)
        return _result(True, df.index[-1], conf, {"type": "gap_up", "gap_pct": float(gap)})
    if today_open < prev_low * (1 - min_gap):
        gap = (prev_low - today_open) / prev_low
        conf = 60 + min(int(gap * 500), 30) + (10 if vol_spike(df, len(df) - 1) else 0)
        return _result(True, df.index[-1], conf, {"type": "gap_down", "gap_pct": float(gap)})
    return _result(False)


def detect_volume_spike(df: pd.DataFrame, mult: float = 2.5) -> dict:
    if len(df) < 25:
        return _result(False)
    i = len(df) - 1
    avg = df["Volume"].iloc[i - 20:i].mean()
    if df["Volume"].iloc[i] < avg * mult:
        return _result(False)
    ratio = df["Volume"].iloc[i] / avg
    direction = "accumulation" if df["Close"].iloc[i] > df["Open"].iloc[i] else "distribution"
    conf = 50 + min(int(ratio * 10), 40)
    return _result(True, df.index[i], conf,
                   {"type": f"volume_spike_{direction}", "ratio": float(ratio)})


def detect_ma_alignment(df: pd.DataFrame) -> dict:
    if len(df) < 130:
        return _result(False)
    ma5 = df["Close"].rolling(5).mean()
    ma20 = df["Close"].rolling(20).mean()
    ma60 = df["Close"].rolling(60).mean()
    ma120 = df["Close"].rolling(120).mean()
    cond_now = (ma5.iloc[-1] > ma20.iloc[-1] > ma60.iloc[-1] > ma120.iloc[-1])
    if not cond_now:
        return _result(False)
    cond_before = (ma5.iloc[-20] > ma20.iloc[-20] > ma60.iloc[-20] > ma120.iloc[-20])
    early = not cond_before
    conf = 55 + (25 if early else 0) \
           + (20 if df["Close"].iloc[-1] > ma5.iloc[-1] else 0)
    return _result(True, df.index[-1], conf,
                   {"type": "ma_alignment_bullish", "early": early})


PATTERN_FUNCS = [
    detect_three_white_soldiers, detect_three_black_crows,
    detect_double_bottom, detect_double_top,
    detect_head_and_shoulders, detect_inverse_head_and_shoulders,
    detect_cup_and_handle, detect_triangle, detect_flag, detect_wedge,
    detect_box_breakout, detect_gap, detect_volume_spike, detect_ma_alignment,
]


def detect_all_patterns(df: pd.DataFrame) -> list[dict]:
    out = []
    for fn in PATTERN_FUNCS:
        try:
            r = fn(df)
            if r["detected"]:
                r["name"] = fn.__name__.replace("detect_", "")
                out.append(r)
        except Exception:
            continue
    return out


# =====================================================================
# 5. PATTERN HISTORY SCANNER (전체 히스토리 탐지)
# =====================================================================
def scan_pattern_history(df: pd.DataFrame, detect_fn,
                         start: int = 130, min_gap: int = 5) -> list[dict]:
    signals = []
    last_pos = -min_gap
    for i in range(start, len(df)):
        sub = df.iloc[:i + 1]
        try:
            r = detect_fn(sub)
        except Exception:
            continue
        if r["detected"] and r["index"] == sub.index[-1]:
            if i - last_pos >= min_gap:
                r["signal_index"] = sub.index[-1]
                r["signal_pos"] = i
                signals.append(r)
                last_pos = i
    return signals


# =====================================================================
# 6. ELLIOTT WAVE
# =====================================================================
def elliott_wave(df: pd.DataFrame, order: int = 7) -> dict:
    highs, lows = find_swings(df, order=order)
    pivots = sorted(
        [(i, df["High"].iloc[i], "H") for i in highs] +
        [(i, df["Low"].iloc[i], "L") for i in lows],
        key=lambda x: x[0],
    )
    if len(pivots) < 6:
        return {"wave_labels": [], "scenario_confidence": 0,
                "note": "pivots insufficient", "current_position": "unclear"}

    p = pivots[-6:]
    labels = ["0", "1", "2", "3", "4", "5"]
    idxs, prices, kinds = zip(*p)

    expect_up = ["L", "H", "L", "H", "L", "H"]
    match_up = sum(k == e for k, e in zip(kinds, expect_up))
    bullish = match_up >= 5

    rules_ok = []
    if bullish:
        rules_ok.append(prices[2] > prices[0])
        w1 = prices[1] - prices[0]
        w3 = prices[3] - prices[2]
        w5 = prices[5] - prices[4]
        rules_ok.append(not (w3 < w1 and w3 < w5))
        rules_ok.append(prices[4] > prices[1] * 0.97)

    rule_score = int(sum(rules_ok) / max(len(rules_ok), 1) * 100) if rules_ok else 0
    shape_score = int(match_up / 6 * 100)
    confidence = int(rule_score * 0.6 + shape_score * 0.4)

    wave_labels = [
        {"wave": lab, "index": df.index[i], "price": float(pr)}
        for lab, i, pr in zip(labels, idxs, prices)
    ]

    last_price = df["Close"].iloc[-1]
    if bullish:
        if last_price < prices[1]:
            current_position = "wave_2_correction"
        elif prices[1] < last_price < prices[3]:
            current_position = "wave_3_or_4"
        elif last_price >= prices[3] * 0.98:
            current_position = "wave_5_possible_top"
        else:
            current_position = "wave_1_early"
    else:
        current_position = "unclear_bearish_or_sideways"

    return {
        "wave_labels": wave_labels,
        "scenario_confidence": confidence,
        "bullish_scenario": bool(bullish),
        "current_position": current_position,
        "rules_passed": rules_ok,
        "note": "Elliott wave는 해석이며 확정이 아닙니다.",
    }


# =====================================================================
# 7. FIBONACCI
# =====================================================================
def fibonacci_levels(df: pd.DataFrame, lookback: int = 120) -> dict:
    w = df.iloc[-lookback:] if len(df) > lookback else df
    hi_idx = w["High"].idxmax()
    lo_idx = w["Low"].idxmin()
    hi = float(w["High"].loc[hi_idx])
    lo = float(w["Low"].loc[lo_idx])
    rng = hi - lo
    if rng <= 0:
        return {}

    uptrend = lo_idx < hi_idx
    retrace = {f"{r:.3f}": hi - rng * r if uptrend else lo + rng * r
               for r in FIB_RETRACE}
    extend = {f"ext_{e:.3f}": hi + rng * (e - 1) if uptrend else lo - rng * (e - 1)
              for e in FIB_EXTEND}

    last = float(df["Close"].iloc[-1])
    zone = None
    sorted_levels = sorted(retrace.items(), key=lambda x: x[1], reverse=uptrend)
    for k, v in sorted_levels:
        if (uptrend and last >= v) or (not uptrend and last <= v):
            zone = k
            break

    return {
        "swing_high": hi, "swing_low": lo,
        "uptrend": bool(uptrend),
        "retracements": retrace,
        "extensions": extend,
        "current_zone": zone,
        "current_price": last,
    }


# =====================================================================
# 8. SCORING
# =====================================================================
def score_trend(df: pd.DataFrame) -> tuple[int, str]:
    slope = trend_slope(df, ma=60, lookback=20)
    ma20 = df["Close"].rolling(20).mean().iloc[-1]
    above = df["Close"].iloc[-1] > ma20
    s = 50 + int(slope * 1000)
    s += 15 if above else -15
    s = max(0, min(100, s))
    return s, f"slope={slope:.3f} above_ma20={above}"


def score_volume(df: pd.DataFrame) -> tuple[int, str]:
    if len(df) < 25:
        return 50, "insufficient"
    last = df["Volume"].iloc[-1]
    avg = df["Volume"].iloc[-21:-1].mean()
    ratio = last / avg if avg > 0 else 1
    s = int(min(100, 40 + ratio * 20))
    return s, f"vol_ratio={ratio:.2f}"


def score_patterns(patterns: list[dict]) -> tuple[int, str]:
    if not patterns:
        return 40, "none"
    bullish_names = {"three_white_soldiers", "double_bottom",
                     "inverse_head_and_shoulders", "cup_and_handle",
                     "flag", "wedge", "box_breakout", "gap",
                     "volume_spike", "ma_alignment", "triangle"}
    bearish_names = {"three_black_crows", "double_top", "head_and_shoulders"}
    best_bull = max((p["confidence"] for p in patterns
                     if p["name"] in bullish_names and
                     "bear" not in p["meta"].get("type", "") and
                     "down" not in p["meta"].get("type", "") and
                     "top" not in p["meta"].get("type", "") and
                     "distribution" not in p["meta"].get("type", "")),
                    default=0)
    best_bear = max((p["confidence"] for p in patterns
                     if p["name"] in bearish_names or
                     "bear" in p["meta"].get("type", "") or
                     "down" in p["meta"].get("type", "")),
                    default=0)
    s = 50 + (best_bull - best_bear) // 2
    s = max(0, min(100, s))
    names = [p["meta"].get("type", p["name"]) for p in patterns]
    return s, ",".join(names[:3])


def score_wave(wave: dict) -> tuple[int, str]:
    if not wave.get("wave_labels"):
        return 40, "no_wave"
    pos = wave["current_position"]
    conf = wave["scenario_confidence"]
    bonus = {"wave_1_early": 20, "wave_2_correction": 25,
             "wave_3_or_4": 15, "wave_5_possible_top": -20,
             "unclear_bearish_or_sideways": -10}.get(pos, 0)
    s = max(0, min(100, conf // 2 + 50 + bonus))
    return s, f"{pos}|conf={conf}"


def score_fib(fib: dict) -> tuple[int, str]:
    if not fib:
        return 40, "no_fib"
    zone = fib.get("current_zone")
    bonus_map = {"0.236": 10, "0.382": 25, "0.500": 20,
                 "0.618": 20, "0.786": 5}
    s = 50 + bonus_map.get(zone, 0)
    return min(100, s), f"zone={zone}"


def score_risk_reward(buy: float, stop: float, target: float) -> tuple[int, str]:
    if buy <= 0 or stop >= buy or target <= buy:
        return 30, "invalid_levels"
    rr = (target - buy) / (buy - stop)
    s = int(min(100, 40 + rr * 15))
    return s, f"RR={rr:.2f}"


# =====================================================================
# 9. TRADING DECISION
# =====================================================================
@dataclass
class TradeReport:
    ticker: str
    trend: str
    detected_patterns: list[str] = field(default_factory=list)
    elliott_scenario: str = ""
    fibonacci_zone: str = ""
    current_position: str = ""
    buy_zone_1: float = 0.0
    buy_zone_2: float = 0.0
    stop_loss: float = 0.0
    target_1: float = 0.0
    target_2: float = 0.0
    risk_reward: float = 0.0
    score: int = 0
    decision: str = "watch"
    breakdown: dict = field(default_factory=dict)


def generate_report(ticker: str, df: pd.DataFrame) -> TradeReport:
    if df.empty or len(df) < 60:
        return TradeReport(ticker=ticker, trend="insufficient_data", decision="avoid")

    patterns = detect_all_patterns(df)
    wave = elliott_wave(df)
    fib = fibonacci_levels(df)
    last = float(df["Close"].iloc[-1])
    a = float(atr(df).iloc[-1])

    slope = trend_slope(df)
    trend = "uptrend" if slope > 0.02 else "downtrend" if slope < -0.02 else "sideways"

    if fib:
        r = fib["retracements"]
        ext = fib["extensions"]
        buy1 = r.get("0.382", last * 0.97)
        buy2 = r.get("0.618", last * 0.93)
        stop = min(fib["swing_low"] * 0.99, last - a * 2.0)
        tgt1 = ext.get("ext_1.272", last * 1.08)
        tgt2 = ext.get("ext_1.618", last * 1.15)
    else:
        buy1, buy2 = last * 0.97, last * 0.93
        stop = last - a * 2.0
        tgt1, tgt2 = last * 1.08, last * 1.15

    s_trend, n_trend = score_trend(df)
    s_vol, n_vol = score_volume(df)
    s_pat, n_pat = score_patterns(patterns)
    s_wave, n_wave = score_wave(wave)
    s_fib, n_fib = score_fib(fib)
    s_rr, n_rr = score_risk_reward(buy1, stop, tgt1)

    total = int(
        s_trend * SCORE_WEIGHTS["trend"] + s_vol * SCORE_WEIGHTS["volume"] +
        s_pat * SCORE_WEIGHTS["pattern"] + s_wave * SCORE_WEIGHTS["wave"] +
        s_fib * SCORE_WEIGHTS["fib"] + s_rr * SCORE_WEIGHTS["risk_reward"]
    )

    if total >= 85:
        decision = "strong_buy"
    elif total >= 70:
        decision = "pullback_buy"
    elif total >= 55:
        decision = "watch"
    else:
        decision = "avoid"

    rr = (tgt1 - buy1) / (buy1 - stop) if buy1 > stop else 0.0

    return TradeReport(
        ticker=ticker, trend=trend,
        detected_patterns=[p["meta"].get("type", p["name"]) for p in patterns],
        elliott_scenario=f"{wave.get('current_position', '-')}"
                         f" (conf {wave.get('scenario_confidence', 0)})",
        fibonacci_zone=fib.get("current_zone", "-") or "-",
        current_position=wave.get("current_position", "-"),
        buy_zone_1=round(buy1, 2), buy_zone_2=round(buy2, 2),
        stop_loss=round(stop, 2),
        target_1=round(tgt1, 2), target_2=round(tgt2, 2),
        risk_reward=round(rr, 2), score=total, decision=decision,
        breakdown={
            "trend": (s_trend, n_trend), "volume": (s_vol, n_vol),
            "pattern": (s_pat, n_pat), "wave": (s_wave, n_wave),
            "fib": (s_fib, n_fib), "rr": (s_rr, n_rr),
        },
    )


# =====================================================================
# 10. BACKTEST
# =====================================================================
@dataclass
class BacktestStat:
    pattern: str
    n_trades: int
    win_rate: float
    avg_return: float
    median_return: float
    profit_factor: float
    max_drawdown: float
    sharpe: float
    avg_hold_days: float
    stop_ratio: float
    target_ratio: float
    timeout_ratio: float


def backtest_pattern(df: pd.DataFrame, detect_fn,
                     hold_days: int = 20,
                     stop_atr: float = 2.0,
                     target_atr: float = 4.0,
                     min_conf: int = 55) -> tuple[BacktestStat, list[dict]]:
    signals = scan_pattern_history(df, detect_fn)
    trades = []
    atr_series = atr(df)

    for sig in signals:
        if sig["confidence"] < min_conf:
            continue
        ei = sig["signal_pos"]
        if ei + hold_days >= len(df):
            continue
        entry = float(df["Close"].iloc[ei])
        a = float(atr_series.iloc[ei])
        if a <= 0 or np.isnan(a):
            continue
        stop = entry - stop_atr * a
        target = entry + target_atr * a

        exit_price, exit_day, reason = None, None, None
        for d in range(1, hold_days + 1):
            k = ei + d
            if k >= len(df):
                break
            low, high = df["Low"].iloc[k], df["High"].iloc[k]
            if low <= stop:
                exit_price, exit_day, reason = stop, d, "stop"
                break
            if high >= target:
                exit_price, exit_day, reason = target, d, "target"
                break
        if exit_price is None:
            exit_price = float(df["Close"].iloc[ei + hold_days])
            exit_day, reason = hold_days, "timeout"

        trades.append({
            "entry_date": sig["signal_index"],
            "entry": entry, "exit": exit_price,
            "days": exit_day, "reason": reason,
            "return": (exit_price - entry) / entry,
            "confidence": sig["confidence"],
        })

    name = detect_fn.__name__.replace("detect_", "")
    if not trades:
        return BacktestStat(name, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), []

    rets = np.array([t["return"] for t in trades])
    wins = rets[rets > 0]
    losses = rets[rets < 0]
    gross_win = wins.sum()
    gross_loss = -losses.sum()
    pf = gross_win / gross_loss if gross_loss > 0 else np.inf

    equity = np.cumprod(1 + rets)
    peak = np.maximum.accumulate(equity)
    mdd = float((equity / peak - 1).min())

    avg_days = np.mean([t["days"] for t in trades])
    sharpe = (rets.mean() / rets.std() * np.sqrt(252 / max(1, avg_days))) \
        if rets.std() > 0 else 0.0

    stat = BacktestStat(
        pattern=name, n_trades=len(trades),
        win_rate=float((rets > 0).mean()),
        avg_return=float(rets.mean()),
        median_return=float(np.median(rets)),
        profit_factor=float(pf),
        max_drawdown=mdd,
        sharpe=float(sharpe),
        avg_hold_days=float(avg_days),
        stop_ratio=float(np.mean([t["reason"] == "stop" for t in trades])),
        target_ratio=float(np.mean([t["reason"] == "target" for t in trades])),
        timeout_ratio=float(np.mean([t["reason"] == "timeout" for t in trades])),
    )
    return stat, trades


def backtest_all(df: pd.DataFrame, **kwargs) -> pd.DataFrame:
    rows = []
    for fn in PATTERN_FUNCS:
        stat, _ = backtest_pattern(df, fn, **kwargs)
        rows.append(stat.__dict__)
    return pd.DataFrame(rows).sort_values("profit_factor", ascending=False)


# =====================================================================
# 11. MULTI-TIMEFRAME
# =====================================================================
def multi_timeframe_report(ticker: str,
                           tf_config=(("1wk", "3y"), ("1d", "1y"))) -> dict:
    out = {}
    for interval, period in tf_config:
        try:
            df = get_data(ticker, period=period, interval=interval)
            if df.empty or len(df) < 60:
                continue
            rep = generate_report(ticker, df)
            out[interval] = {"df": df, "report": rep, "trend": trend_slope(df)}
        except Exception as e:
            print(f"  [{interval}] 에러: {e}")

    confluence = False
    final = "watch"
    note = ""
    if "1wk" in out and "1d" in out:
        w, d = out["1wk"], out["1d"]
        w_up = w["trend"] > 0.01
        d_buy = d["report"].decision in ("strong_buy", "pullback_buy")
        d_avoid = d["report"].decision == "avoid"
        if w_up and d_buy:
            confluence = True
            final = d["report"].decision
            note = "주봉 상승 + 일봉 매수 신호 = 유효"
        elif not w_up and d_buy:
            final = "watch"
            note = "일봉 매수 신호 있으나 주봉 추세 부정적 → 보류"
        elif w_up and d["report"].decision == "watch":
            final = "pullback_buy"
            note = "주봉 강세 + 일봉 조정 → 눌림목 매수 기회"
        elif d_avoid:
            final = "avoid"
            note = "일봉 회피 신호"
    out["confluence"] = confluence
    out["final_decision"] = final
    out["note"] = note
    return out


# =====================================================================
# 12. ALERTS
# =====================================================================
ALERT_CONFIG = {"trigger_decisions": ("strong_buy",)}


def _format_alert_message(report: TradeReport, extra: str = "") -> str:
    return (
        f"📈 *{report.ticker}*  [{report.decision.upper()}]\n"
        f"점수: {report.score} / RR: {report.risk_reward}\n"
        f"추세: {report.trend} | 파동: {report.current_position}\n"
        f"피보 구간: {report.fibonacci_zone}\n"
        f"패턴: {', '.join(report.detected_patterns) or '-'}\n"
        f"───────────────\n"
        f"매수1: {report.buy_zone_1}\n"
        f"매수2: {report.buy_zone_2}\n"
        f"손절:  {report.stop_loss}\n"
        f"목표1: {report.target_1}\n"
        f"목표2: {report.target_2}\n"
        f"{extra}"
    )


def send_telegram(message: str, token: str, chat_id: str) -> bool:
    try:
        import requests
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        r = requests.post(url, json={
            "chat_id": chat_id, "text": message, "parse_mode": "Markdown",
        }, timeout=10)
        return r.ok
    except Exception as e:
        print(f"[telegram] 실패: {e}")
        return False


def send_email(subject: str, body: str, cfg: dict) -> bool:
    try:
        import smtplib
        from email.mime.text import MIMEText
        msg = MIMEText(body, "plain", "utf-8")
        msg["Subject"] = subject
        msg["From"] = cfg["from"]
        msg["To"] = cfg["to"]
        with smtplib.SMTP_SSL(cfg["smtp"], cfg["port"]) as s:
            s.login(cfg["user"], cfg["password"])
            s.send_message(msg)
        return True
    except Exception as e:
        print(f"[email] 실패: {e}")
        return False


def dispatch_alert(report: TradeReport, config: dict = None) -> None:
    cfg = config or ALERT_CONFIG
    triggers = cfg.get("trigger_decisions", ("strong_buy",))
    if report.decision not in triggers:
        return
    msg = _format_alert_message(report)
    if cfg.get("telegram"):
        send_telegram(msg, **cfg["telegram"])
    if cfg.get("email"):
        send_email(f"[{report.decision.upper()}] {report.ticker}",
                   msg, cfg["email"])
    print(f"  🔔 알림 발송: {report.ticker}")


# =====================================================================
# 13. KRX TICKER MAP
# =====================================================================
KRX_CACHE_PATH = Path.home() / ".krx_ticker_cache.pkl"
KRX_CACHE_TTL_DAYS = 7


def load_krx_tickers(force_refresh: bool = False) -> pd.DataFrame:
    if not force_refresh and KRX_CACHE_PATH.exists():
        age_days = (pd.Timestamp.now() -
                    pd.Timestamp(os.path.getmtime(KRX_CACHE_PATH), unit="s")).days
        if age_days < KRX_CACHE_TTL_DAYS:
            with open(KRX_CACHE_PATH, "rb") as f:
                return pickle.load(f)

    try:
        from pykrx import stock
    except ImportError:
        print("pykrx 미설치: pip install pykrx")
        return pd.DataFrame(columns=["name", "ticker", "market"])

    rows = []
    today = pd.Timestamp.now().strftime("%Y%m%d")
    for mkt, suffix in [("KOSPI", ".KS"), ("KOSDAQ", ".KQ")]:
        codes = stock.get_market_ticker_list(date=today, market=mkt)
        for code in codes:
            try:
                nm = stock.get_market_ticker_name(code)
                rows.append({"name": nm, "ticker": f"{code}{suffix}",
                             "market": mkt, "code": code})
            except Exception:
                continue

    df = pd.DataFrame(rows)
    with open(KRX_CACHE_PATH, "wb") as f:
        pickle.dump(df, f)
    print(f"  KRX 종목 {len(df)}개 로드 및 캐시 저장")
    return df


_KRX_DF = None


def ticker_from_name_full(name: str) -> Optional[str]:
    global _KRX_DF
    if _KRX_DF is None:
        _KRX_DF = load_krx_tickers()
    if _KRX_DF.empty:
        return KR_TICKER_MAP.get(name)
    hit = _KRX_DF[_KRX_DF["name"] == name]
    if hit.empty:
        hit = _KRX_DF[_KRX_DF["name"].str.contains(name, na=False)]
        if hit.empty:
            return None
    return hit["ticker"].iloc[0]


# =====================================================================
# 14. RISK MANAGEMENT
# =====================================================================
@dataclass
class PositionPlan:
    ticker: str
    capital: float
    risk_per_trade: float
    max_risk_krw: float
    avg_entry: float
    total_shares: int
    total_invest_krw: float
    entries: list[dict]
    stop: float
    sells: list[dict]
    expected_profit_t1: float
    expected_loss_if_stop: float
    expected_rr: float


def position_sizing(capital: float, entry: float, stop: float,
                    risk_pct: float = 0.01, min_unit: int = 1) -> int:
    if entry <= stop or entry <= 0:
        return 0
    risk_amount = capital * risk_pct
    per_share_risk = entry - stop
    shares = int(risk_amount // per_share_risk)
    return (shares // min_unit) * min_unit


def build_position_plan(report: TradeReport,
                        capital: float,
                        risk_pct: float = 0.01,
                        split_ratio=(0.6, 0.4),
                        sell_portions=(0.5, 0.3, 0.2),
                        min_unit: int = 1) -> PositionPlan:
    b1, b2 = report.buy_zone_1, report.buy_zone_2
    stop = report.stop_loss
    t1, t2 = report.target_1, report.target_2
    w1, w2 = split_ratio

    avg_entry = b1 * w1 + b2 * w2
    total_shares = position_sizing(capital, avg_entry, stop, risk_pct, min_unit)

    shares_1 = int(total_shares * w1)
    shares_2 = total_shares - shares_1

    entries = [
        {"tier": 1, "price": b1, "weight": w1,
         "shares": shares_1, "invest": shares_1 * b1},
        {"tier": 2, "price": b2, "weight": w2,
         "shares": shares_2, "invest": shares_2 * b2},
    ]

    p1, p2, p3 = sell_portions
    sells = [
        {"tier": 1, "price": t1, "portion": p1,
         "shares": int(total_shares * p1), "note": "first_profit"},
        {"tier": 2, "price": t2, "portion": p2,
         "shares": int(total_shares * p2), "note": "second_profit"},
        {"tier": 3, "price": None, "portion": p3,
         "shares": total_shares - int(total_shares * p1) - int(total_shares * p2),
         "note": "trailing_stop (10MA 이탈 시 청산)"},
    ]

    total_invest = sum(e["invest"] for e in entries)
    loss_if_stop = (avg_entry - stop) * total_shares
    profit_t1 = (t1 - avg_entry) * total_shares
    rr = profit_t1 / loss_if_stop if loss_if_stop > 0 else 0

    return PositionPlan(
        ticker=report.ticker,
        capital=capital, risk_per_trade=risk_pct,
        max_risk_krw=capital * risk_pct,
        avg_entry=round(avg_entry, 2),
        total_shares=total_shares,
        total_invest_krw=round(total_invest, 0),
        entries=entries, stop=stop, sells=sells,
        expected_profit_t1=round(profit_t1, 0),
        expected_loss_if_stop=round(loss_if_stop, 0),
        expected_rr=round(rr, 2),
    )


def format_position_plan(plan: PositionPlan) -> str:
    lines = [
        f"═══ {plan.ticker} 포지션 플랜 ═══",
        f"자본 {plan.capital:,.0f}  리스크 {plan.risk_per_trade * 100:.1f}%  "
        f"허용손실 {plan.max_risk_krw:,.0f}",
        f"총 수량 {plan.total_shares}주  평균단가 {plan.avg_entry:,.2f}  "
        f"총투입 {plan.total_invest_krw:,.0f}",
        f"",
        f"[매수]",
    ]
    for e in plan.entries:
        lines.append(f"  {e['tier']}차 {e['weight'] * 100:.0f}%  "
                     f"@ {e['price']:,.2f}  x {e['shares']}주  "
                     f"= {e['invest']:,.0f}")
    lines.append(f"\n[손절] {plan.stop:,.2f}  "
                 f"(예상손실 {plan.expected_loss_if_stop:,.0f})")
    lines.append(f"\n[매도]")
    for s in plan.sells:
        price_str = f"{s['price']:,.2f}" if s['price'] else "trailing"
        lines.append(f"  {s['tier']}차 {s['portion'] * 100:.0f}%  "
                     f"@ {price_str}  x {s['shares']}주  ({s['note']})")
    lines.append(f"\nRR (T1 기준) = {plan.expected_rr}")
    return "\n".join(lines)


# =====================================================================
# 15. VISUALIZATION
# =====================================================================
def plot_chart(ticker: str, df: pd.DataFrame, report: TradeReport,
               save: bool = False):
    fig, (ax1, ax2) = plt.subplots(
        2, 1, figsize=(13, 8),
        gridspec_kw={"height_ratios": [3, 1]}, sharex=True,
    )

    ax1.plot(df.index, df["Close"], lw=1.3, color="#1f2937", label="Close")
    ax1.plot(df.index, df["Close"].rolling(20).mean(), lw=0.8, color="orange", label="MA20")
    ax1.plot(df.index, df["Close"].rolling(60).mean(), lw=0.8, color="steelblue", label="MA60")
    ax1.plot(df.index, df["Close"].rolling(120).mean(), lw=0.8, color="purple", label="MA120")

    fib = fibonacci_levels(df)
    if fib:
        for name, lvl in fib["retracements"].items():
            ax1.axhline(lvl, ls=":", lw=0.7, color="gray", alpha=0.7)
            ax1.text(df.index[-1], lvl, f" fib {name}", va="center", fontsize=8, color="gray")

    ax1.axhline(report.buy_zone_1, color="green", ls="--", lw=1.2, label="Buy1")
    ax1.axhline(report.buy_zone_2, color="green", ls=":", lw=1.0, label="Buy2")
    ax1.axhline(report.stop_loss, color="red", ls="--", lw=1.2, label="Stop")
    ax1.axhline(report.target_1, color="blue", ls="--", lw=1.2, label="T1")
    ax1.axhline(report.target_2, color="blue", ls=":", lw=1.0, label="T2")

    wave = elliott_wave(df)
    for w in wave.get("wave_labels", []):
        ax1.annotate(w["wave"], xy=(w["index"], w["price"]),
                     xytext=(0, 10), textcoords="offset points",
                     ha="center", fontsize=11, fontweight="bold",
                     color="darkred",
                     bbox=dict(boxstyle="circle,pad=0.2", fc="yellow", ec="darkred"))

    for p in detect_all_patterns(df):
        if p.get("index") in df.index:
            ax1.axvline(p["index"], color="crimson", alpha=0.25, lw=8)

    ax1.set_title(f"{ticker}   score={report.score}   decision={report.decision}   "
                  f"RR={report.risk_reward}", fontsize=12)
    ax1.legend(loc="upper left", fontsize=8, ncol=3)
    ax1.grid(alpha=0.3)

    colors = ["#ef4444" if c < o else "#10b981"
              for c, o in zip(df["Close"], df["Open"])]
    ax2.bar(df.index, df["Volume"], color=colors, width=1.0)
    ax2.plot(df.index, df["Volume"].rolling(20).mean(), color="black", lw=0.8, label="Vol MA20")
    ax2.set_ylabel("Volume")
    ax2.grid(alpha=0.3)
    ax2.xaxis.set_major_locator(mdates.AutoDateLocator())

    plt.tight_layout()
    if save:
        out = Path(__file__).parent / f"output_{ticker.replace('.', '_')}.png"
        plt.savefig(out, dpi=100)
        print(f"  차트 저장: {out}")
    else:
        plt.show()
    plt.close()


# =====================================================================
# 16. INTEGRATED RUNNER
# =====================================================================
def run_full(tickers: list[str],
             capital: float = 10_000_000,
             risk_pct: float = 0.01,
             use_multi_tf: bool = True,
             run_backtest: bool = False,
             send_alerts: bool = False,
             alert_config: dict | None = None,
             plot: bool = False,
             save_plot: bool = False) -> dict:
    table_rows = []
    plans = {}
    backtests = {}
    mtf_results = {}

    for raw in tickers:
        # 종목명 / 티커 자동 판단
        is_ticker = raw.endswith((".KS", ".KQ")) or (
            raw.isascii() and raw.isalpha() and raw.isupper()
        )
        if is_ticker:
            ticker = raw
        else:
            ticker = ticker_from_name(raw) or ticker_from_name_full(raw) or raw

        print(f"\n[{raw} → {ticker}] 분석 시작...")

        try:
            df = get_data(ticker, period="1y")
            if df.empty or len(df) < 60:
                print("  데이터 부족. 스킵.")
                continue

            report = generate_report(ticker, df)

            mtf_note = ""
            if use_multi_tf:
                mtf = multi_timeframe_report(ticker)
                mtf_results[ticker] = mtf
                mtf_note = mtf.get("note", "")
                if not mtf.get("confluence") and report.decision == "strong_buy":
                    report.decision = "pullback_buy"
                    mtf_note += " | 주봉 미확인으로 등급 하향"

            if report.decision in ("strong_buy", "pullback_buy"):
                plan = build_position_plan(report, capital, risk_pct)
                plans[ticker] = plan
                print(format_position_plan(plan))

            if run_backtest:
                bt = backtest_all(df)
                backtests[ticker] = bt
                top3 = bt.head(3)[["pattern", "n_trades", "win_rate",
                                   "avg_return", "profit_factor"]]
                print(f"\n  백테스트 TOP3:\n{top3.to_string(index=False)}")

            if send_alerts:
                dispatch_alert(report, alert_config)

            if plot or save_plot:
                plot_chart(ticker, df, report, save=save_plot)

            table_rows.append({
                "ticker": ticker,
                "decision": report.decision,
                "score": report.score,
                "trend": report.trend,
                "pattern": ",".join(report.detected_patterns[:2]) or "-",
                "wave": report.current_position,
                "fib": report.fibonacci_zone,
                "buy1": report.buy_zone_1,
                "stop": report.stop_loss,
                "t1": report.target_1,
                "RR": report.risk_reward,
                "mtf": mtf_note[:30] if mtf_note else "-",
            })
        except Exception as e:
            import traceback
            print(f"  에러: {e}")
            traceback.print_exc()

    table = pd.DataFrame(table_rows)
    return {
        "table": table,
        "plans": plans,
        "backtests": backtests,
        "mtf": mtf_results,
    }


# =====================================================================
# JSON MODE (웹 대시보드 연동용)
# =====================================================================
def _serialize_candles(df: pd.DataFrame, last_n: int = 250) -> list[dict]:
    tail = df.tail(last_n)
    return [
        {
            "d": idx.strftime("%Y-%m-%d"),
            "o": float(row["Open"]),
            "h": float(row["High"]),
            "l": float(row["Low"]),
            "c": float(row["Close"]),
            "v": float(row["Volume"]),
        }
        for idx, row in tail.iterrows()
    ]


def analyze_for_json(tickers: list[str],
                     capital: float = 10_000_000,
                     risk_pct: float = 0.01,
                     use_multi_tf: bool = True,
                     run_backtest: bool = False) -> dict:
    """웹 대시보드에서 소비할 구조화된 JSON 페이로드 생성."""
    from dataclasses import asdict
    results = []
    for raw in tickers:
        raw = raw.strip()
        if not raw:
            continue
        is_ticker = raw.endswith((".KS", ".KQ")) or (
            raw.isascii() and raw.isalpha() and raw.isupper()
        )
        ticker = raw if is_ticker else (
            ticker_from_name(raw) or ticker_from_name_full(raw) or raw
        )

        entry = {"input": raw, "ticker": ticker, "ok": False}
        try:
            df = get_data(ticker, period="1y")
            if df.empty or len(df) < 60:
                entry["error"] = f"데이터 부족 ({len(df)}봉, 최소 60봉 필요)"
                results.append(entry)
                continue
            if len(df) < 130:
                entry["short_history"] = f"단기 데이터 ({len(df)}봉) — MA120 및 장기 패턴 제한"

            report = generate_report(ticker, df)
            wave = elliott_wave(df)
            fib = fibonacci_levels(df)
            patterns_all = detect_all_patterns(df)

            mtf_info = None
            if use_multi_tf:
                try:
                    mtf_info = multi_timeframe_report(ticker)
                except Exception:
                    mtf_info = None
                if mtf_info and not mtf_info.get("confluence") and report.decision == "strong_buy":
                    report.decision = "pullback_buy"

            plan = None
            if report.decision in ("strong_buy", "pullback_buy"):
                try:
                    plan = build_position_plan(report, capital, risk_pct)
                except Exception:
                    plan = None

            bt_top = []
            if run_backtest:
                try:
                    bt = backtest_all(df)
                    top = bt.head(3)[["pattern", "n_trades", "win_rate",
                                      "avg_return", "profit_factor"]]
                    bt_top = top.replace([float("inf"), float("-inf")], None) \
                                .where(top.notna(), None) \
                                .to_dict(orient="records")
                except Exception:
                    bt_top = []

            entry.update({
                "ok": True,
                "report": asdict(report),
                "elliott": wave,
                "fibonacci": fib,
                "patterns": patterns_all,
                "mtf": mtf_info,
                "plan": plan,
                "backtest_top3": bt_top,
                "candles": _serialize_candles(df),
                "last_price": float(df["Close"].iloc[-1]),
            })
        except Exception as e:
            import traceback
            entry["error"] = f"{type(e).__name__}: {e}"
            entry["traceback"] = traceback.format_exc()

        results.append(entry)

    import datetime
    return {
        "results": results,
        "meta": {
            "capital": capital,
            "risk_pct": risk_pct,
            "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        },
    }


# =====================================================================
# ENTRY POINT
# =====================================================================
if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Trading system analyzer")
    parser.add_argument("--tickers", type=str, default="",
                        help="쉼표 구분 종목 리스트 (예: 005930,000660.KS,AAPL). "
                             "미지정 시 기본 샘플 사용.")
    parser.add_argument("--capital", type=float, default=10_000_000)
    parser.add_argument("--risk-pct", type=float, default=0.01)
    parser.add_argument("--no-mtf", action="store_true", help="멀티 타임프레임 스킵")
    parser.add_argument("--no-backtest", action="store_true", help="백테스트 스킵")
    parser.add_argument("--json", action="store_true",
                        help="JSON을 stdout으로 출력 (웹 연동 모드)")
    args = parser.parse_args()

    if args.tickers.strip():
        tickers = [t.strip() for t in args.tickers.split(",") if t.strip()]
    else:
        tickers = ["SK하이닉스", "000660.KS", "AAPL"]

    if args.json:
        # JSON 모드: 콘솔 출력 억제 (print → stderr)
        import builtins
        _orig_print = builtins.print

        def _silent_print(*a, **k):
            k.setdefault("file", sys.stderr)
            _orig_print(*a, **k)
        builtins.print = _silent_print

        payload = analyze_for_json(
            tickers=tickers,
            capital=args.capital,
            risk_pct=args.risk_pct,
            use_multi_tf=not args.no_mtf,
            run_backtest=not args.no_backtest,
        )
        builtins.print = _orig_print
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str))
        sys.stdout.flush()
    else:
        result = run_full(
            tickers=tickers,
            capital=args.capital,
            risk_pct=args.risk_pct,
            use_multi_tf=not args.no_mtf,
            run_backtest=not args.no_backtest,
            send_alerts=False,
            alert_config={"trigger_decisions": ("strong_buy",)},
            plot=False,
            save_plot=True,
        )

        print("\n" + "=" * 100)
        print("FINAL REPORT TABLE")
        print("=" * 100)
        print(result["table"].to_string(index=False))

        t = result["table"]
        if not t.empty:
            strong = t[t["decision"] == "strong_buy"]["ticker"].tolist()
            pull = t[t["decision"] == "pullback_buy"]["ticker"].tolist()
            avoid = t[t["decision"] == "avoid"]["ticker"].tolist()
            print(f"\n🟢 지금 관심: {strong or '없음'}")
            print(f"🟡 눌림 대기: {pull or '없음'}")
            print(f"🔴 회피:     {avoid or '없음'}")
