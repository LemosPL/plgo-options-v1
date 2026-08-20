from __future__ import annotations

import math
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import date, datetime

from matplotlib import figure
from scipy.ndimage import gaussian_filter1d

from .base_optimizer import BaseOptimizer, RiskMode, PERP_COUNTERPARTY
from .collateral_optimization import CollateralOptimization
from .delta_hedger import check_rehedge, perp_trade_cost
from .elastic_net import GeneralizedLasso
from .models import Position, Candidate
from .math_utils import bs_vec
from .option_smile import OptionSmile
from .pulp_solver import PulpSolver
from .snapshot import load_snapshot_dict
from .optimizer_utils import expiry_sort_key, safe_num, get_expiry_code
from .misc_utils import build_parametric_target_profile, load_target_profile_file

import matplotlib.pyplot as plt

from ..pricing import options
from ..web.routes.collateral import HAIRCUTS

# Transaction cost is modelled in VOL POINTS. Per execution (one leg),
#   cost = |qty| × |vega| × VOLpts
# where vega is USD per 1 vol-point per contract (math_utils.bs_greeks:
# S·φ(d1)·√T / 100) and VOLpts is the per-counterparty ONE-WAY (half-spread-
# from-mid) bid-ask width in implied-vol points. A round trip (open + close)
# is two executions, so it costs 2× naturally. VOLpts is entered manually per
# counterparty from the GUI; these per-asset values are the fallback default
# for a counterparty with no explicit entry. PLACEHOLDERS — tune to the desk's
# real spreads. (Replaces the earlier delta-scaled %-of-price model.)
DEFAULT_BID_ASK_VOL_PTS_BY_ASSET: dict[str, "dict[str, float] | float"] = {
    "ETH": 5.0,   # flat 5 vol pts for every ETH counterparty unless overridden
    "FIL": 40.0,  # flat 40 vol pts for every FIL counterparty unless overridden
}

# Fallback VOLpts for a counterparty absent from the resolved dict.
_VOL_PTS_FALLBACK = 0.75

# Real execution cost for a box neutralizer, in basis points of the box's
# notional (strike width × qty — with r=0 here, box_debit already equals
# K_high-K_low exactly, so box_debit IS the per-contract notional). This is
# SEPARATE from the vega-based structure cost above: a box's net vega is
# exactly zero by put-call parity (see _structure_leg_costs_usd), so that
# model can never price a box's real cost. A box is economically a synthetic
# cash loan (riskless payoff = K_high-K_low), so inter-dealer/market-maker
# desks price its bid-ask as bps of notional (an implied-rate spread), not a
# flat per-contract fee — a $10k box and a $1M box don't cost the same dollar
# amount to execute. Manually entered per counterparty from the GUI; these
# are the fallback defaults (0 = unpriced, matching legacy behavior) until
# tuned to what the desk is actually seeing quoted. Also fed into the LP
# itself (CollateralOptimization._cash_neutrality_rate) as the real $/$ cost
# of closing a counterparty's cash imbalance via a box, so the LP weighs it
# against profile fit now rather than only pricing it after the fact.
DEFAULT_BOX_FEE_BPS_BY_ASSET: dict[str, "dict[str, float] | float"] = {}

# Fallback box fee (bps of notional) for a counterparty absent from the resolved dict.
_BOX_FEE_BPS_FALLBACK = 0.0

# Fallback perp trading cost, in bps of notional (price × qty) — a perp has
# zero vega so the vol-points cost model above can't price it; matches the
# legacy OptimizerV2.compute_costs convention.
_PERP_COST_BPS_FALLBACK = 2.0


def _bid_ask_cost_usd(qty, vega, counterparty, bid_ask_vol_pts):
    """One execution's transaction cost (USD) for a trade leg, modelled in vol
    points: |qty| × |vega| × VOLpts. Mirrors CollateralOptimization's own
    trading_cost term so the cost shown on a trade matches what drove the LP.
    ``vega`` is USD per 1 vol-point per contract; ``bid_ask_vol_pts`` is a
    per-counterparty dict (or a flat scalar) of one-way vol-point half-spreads.
    """
    vp = CollateralOptimization._resolve(bid_ask_vol_pts, counterparty, default=_VOL_PTS_FALLBACK)
    return abs(float(qty)) * abs(float(vega or 0.0)) * float(vp)


def _structure_leg_costs_usd(legs, bid_ask_vol_pts, perp_cost_bps=None):
    """Allocate one structure's (naked/spread/straddle/box/...) transaction
    cost across its legs, based on the structure's NET vega exposure rather
    than summing each leg's own |vega| independently. A dealer prices a
    multi-leg structure as one package, off its net risk — same-signed legs
    (e.g. a straddle: long call + long put) add up with no reduction,
    opposite-signed legs at different strikes (e.g. a vertical spread)
    partially cancel, and a box's legs cancel exactly (proven zero, via
    put-call parity — same maturity/strike gives the call and put identical
    vega). A single-leg "structure" (a naked trade, or a roll-unwind) reduces
    to exactly the old per-leg |qty x vega| formula, so this generalizes
    _bid_ask_cost_usd without changing behavior for the single-leg case.

    ``legs`` is [(leg, leg_qty), ...] — all legs must share one counterparty
    (true for every structure built in this module: spreads/straddles/boxes
    are all grouped by counterparty before pairing). Returns one cost per
    leg, in the same order, proportional to |leg_qty x leg_vega| so no single
    leg arbitrarily "carries" the whole structure's cost.

    A perp leg (opt=="F") has zero vega, so it can't participate in that
    net-exposure netting at all — it's costed independently, as bps of its
    own notional (see _PERP_COST_BPS_FALLBACK), and excluded from the option
    legs' net-exposure calculation entirely.
    """
    if not legs:
        return []
    option_idx = [i for i, (lg, _lq) in enumerate(legs) if getattr(lg, "opt", "") != "F"]
    perp_idx = [i for i, (lg, _lq) in enumerate(legs) if getattr(lg, "opt", "") == "F"]
    costs = [0.0] * len(legs)

    if option_idx:
        option_legs = [legs[i] for i in option_idx]
        exposures = [float(lq) * float(getattr(lg, "vega", 0.0) or 0.0) for lg, lq in option_legs]
        net_exposure = sum(exposures)
        counterparty = option_legs[0][0].counterparty
        vp = CollateralOptimization._resolve(bid_ask_vol_pts, counterparty, default=_VOL_PTS_FALLBACK)
        structure_cost = abs(net_exposure) * float(vp)
        total_abs_exposure = sum(abs(x) for x in exposures)
        if total_abs_exposure <= 1e-12:
            per_leg = [structure_cost / len(option_legs)] * len(option_legs)
        else:
            per_leg = [structure_cost * abs(x) / total_abs_exposure for x in exposures]
        for i, cost in zip(option_idx, per_leg):
            costs[i] = cost

    for i in perp_idx:
        leg, leg_qty = legs[i]
        vp_perp = CollateralOptimization._resolve(perp_cost_bps, leg.counterparty, default=_PERP_COST_BPS_FALLBACK)
        costs[i] = abs(float(leg_qty)) * float(leg.bs_price_usd or 0.0) * float(vp_perp) / 10_000.0

    return costs


class OptimizerV3(BaseOptimizer):
    """Holds all data needed for portfolio optimization."""

    def __init__(
        self,
        spot: float,
        spot_ladder: list[float],
        matrix_horizons: list[int],
        chart_horizons: list[int],
        vol_surface: list[dict],
        positions: list[Position],
        totals: dict,
        snapshot_path: Path,
        today: date,
        asset: str = "ETH"
    ):
        super().__init__(spot, spot_ladder, matrix_horizons, chart_horizons, vol_surface, positions, totals,
                         snapshot_path, today, asset=asset)
        self.cost = None
        self.risk_reduction = None

    def _estimate_trade_cash_outlay(
        self,
        qty: float,
        price: float,
        held_qty: float = 0.0,
        unwind_discount: float = 0.2,
        new_position_penalty: float = 0.04,
        is_held: bool = False,
    ) -> float:
        """
        Estimate cash outlay for a single leg — roughly the premium paid/received,
        scaled by unwind_discount (for closing held positions) or new_position_penalty
        (for opening new ones). This is NOT a transaction-cost/bid-ask estimate — for
        new positions it's close to 100% of notional by construction. The LP's own
        `trading_cost` term (bid-ask-based) is the right figure for execution cost.
        """
        abs_qty = abs(float(qty))
        price = max(float(price), 0.0)

        opposite = (qty * held_qty) < 0
        unwind_abs = min(abs(float(held_qty)), abs_qty) if opposite else 0.0
        new_abs = abs_qty - unwind_abs

        unwind_cost = unwind_abs * price * unwind_discount
        new_cost = new_abs * price * (1.0 + (0.0 if is_held else new_position_penalty))

        return unwind_cost + new_cost

    # Current portfolio payoff from held positions, at expiry
    def terminal_payoff_for_position(self, spot_arr, p: Position) -> np.ndarray:
        # net_qty is already signed (negative=Short, positive=Long) — no side flip needed.
        signed_qty = float(getattr(p, "net_qty", 0.0) or 0.0)

        strike = float(getattr(p, "strike", 0.0) or 0.0)
        opt = str(getattr(p, "opt", "") or "")
        if opt == "C":
            return signed_qty * np.maximum(spot_arr - strike, 0.0)
        if opt == "P":
            return signed_qty * np.maximum(strike - spot_arr, 0.0)
        if opt == "F":
            return signed_qty * (spot_arr - strike)
        return np.zeros_like(spot_arr)

    def _get_roll_positions(
        self,
        roll_dte_threshold: int | None,
        roll_itm_only: bool = False,
        counterparties: list[str] | None = None,
        forced_roll_ids: list[int] | None = None,
    ) -> list[Position]:
        if roll_dte_threshold == -1:
            # Manual mode: force-roll exactly the checked Trade Management
            # rows, bypassing DTE/ITM/counterparty filters entirely — an
            # explicit selection always wins over the automatic ones.
            wanted_ids = {int(i) for i in (forced_roll_ids or [])}
            return [p for p in self.positions if getattr(p, "id", None) in wanted_ids]

        if roll_dte_threshold is None:
            return []

        selected_counterparties = {
            c.strip()
            for c in (counterparties or [])
            if c and c.strip() and c.strip().upper() != "ALL"
        }

        roll_positions = []
        for p in self.positions:
            opt = str(getattr(p, "opt", "") or "")
            if opt not in ("C", "P", "F"):
                continue
            if selected_counterparties and getattr(p, "counterparty", "") not in selected_counterparties:
                continue
            try:
                expiry_dt = datetime.combine(p.expiry_date, datetime.min.time())
                dte = (expiry_dt - self.today).days
            except Exception:
                dte = int(getattr(p, "days_remaining", 0) or 0)
            if dte > roll_dte_threshold:
                continue
            if roll_itm_only and opt in ("C", "P"):
                strike = float(getattr(p, "strike", 0.0) or 0.0)
                is_itm = (opt == "C" and strike < self.spot) or (opt == "P" and strike > self.spot)
                if not is_itm:
                    continue
            roll_positions.append(p)

        return roll_positions

    def _build_roll_unwind_trades(
            self, token, roll_positions: list[Position],
            bid_ask_atm_pct: "dict[str, float] | float | None" = None,
            bid_ask_min_delta: float = 0.05,
            bid_ask_vol_pts: "dict[str, float] | float | None" = None,
            box_fee_bps: "dict[str, float] | float | None" = None,
    ) -> list[dict]:
        trades = []

        for p in roll_positions:
            # net_qty is already signed (negative=Short, positive=Long) — closing
            # the position is simply the opposite sign, no extra side-based flip.
            qty = float(getattr(p, "net_qty", 0.0) or 0.0)
            if qty == 0:
                continue

            unwind_qty = -int(round(qty))
            if unwind_qty == 0:
                continue

            opt = str(getattr(p, "opt", "") or "")
            strike = float(getattr(p, "strike", 0.0) or 0.0)
            expiry_code = get_expiry_code(getattr(p, "expiry_date", getattr(p, "expiry", "")))
            counterparty = getattr(p, "counterparty", "")
            mark_price = float(getattr(p, "mark_price_usd", 0.0) or 0.0)

            if token == "ETH":
                instrument_name = (
                    "ETH-PERPETUAL" if opt == "F"
                    else f"ETH-{expiry_code}-{int(strike)}-{opt}"
                )
            elif token == "FIL":
                instrument_name = (
                    "FIL-PERPETUAL" if opt == "F"
                    else f"FIL-{expiry_code}-{strike}-{opt}"
                )
            else:
                raise ValueError(f"Unsupported token: {token}")

            notional = abs(float(unwind_qty)) * mark_price
            vega_cost = _bid_ask_cost_usd(
                unwind_qty, getattr(p, "vega", 0.0), counterparty, bid_ask_vol_pts,
            )
            # DTE-triggered rolls are, by construction, near expiry — vega (and
            # so the cost above) collapses toward zero even when the position
            # is deep ITM with real intrinsic value left to unwind, the same
            # blind spot a box's ~0 net vega has for its own real execution
            # cost (see _build_box_cash_neutralizer_trades). These positions
            # are typically ITM, so reuse box_fee_bps as a notional-based fee
            # on top of the vega cost: closing a large ITM position is
            # economically similar to unwinding a box — real dollar bid-ask
            # proportional to notional, not to vol risk that's already gone.
            roll_fee_bp = CollateralOptimization._resolve(box_fee_bps, counterparty, default=_BOX_FEE_BPS_FALLBACK)
            notional_cost = notional * float(roll_fee_bp or 0.0) / 10_000.0

            trades.append({
                "counterparty": counterparty,
                "instrument": instrument_name,
                "strategy": "ROLL_UNWIND",
                "strategy_instrument": instrument_name,
                "expiry": getattr(p, "expiry_date", getattr(p, "expiry", "")),
                "dte": int(getattr(p, "days_remaining", 0) or 0),
                "strike": strike,
                "opt": opt,
                "qty": unwind_qty,
                "side": "Buy" if unwind_qty > 0 else "Sell",
                "iv_pct": round(float(getattr(p, "iv_pct", 0.0) or 0.0), 1),
                "bs_price_usd": round(mark_price, 2),
                "vega": round(float(getattr(p, "vega", 0.0) or 0.0), 4),
                "notional": round(notional, 2),
                "is_unwind": True,
                "unwind_qty": abs(int(unwind_qty)),
                "new_qty": 0,
                "estimated_cash_outlay": 0.0,
                "normalized_benefit": 0.0,
                "net_benefit": 0.0,
                "delta_contribution": round(float(unwind_qty * (getattr(p, "delta", 0.0) or 0.0)), 4),
                "gamma_contribution": round(float(unwind_qty * (getattr(p, "gamma", 0.0) or 0.0)), 6),
                "vega_contribution": round(float(unwind_qty * (getattr(p, "vega", 0.0) or 0.0)), 4),
                "cost_usd": round(vega_cost + notional_cost, 2),
            })

        return trades

    def _build_roll_replacement_trades(
        self,
        roll_positions: list[Position],
        option_legs: list[Candidate],
        target_expiry: str | None,
        min_abs_delta: float = 0.05,
    ) -> list[dict]:
        if target_expiry is None:
            return []

        trades = []

        for p in roll_positions:
            old_delta = float(getattr(p, "delta", 0.0) or 0.0)
            old_opt = str(getattr(p, "opt", "") or "")
            old_strike = float(getattr(p, "strike", 0.0) or 0.0)
            raw_side = str(getattr(p, "side_raw", getattr(p, "side", ""))).lower()
            old_qty = abs(float(getattr(p, "net_qty", 0.0) or 0.0))
            if raw_side in ("sell", "short"):
                old_qty = -old_qty
            if old_qty == 0.0 or old_opt not in ("C", "P"):
                continue

            # Only force replacement for currently ITM rolled positions.
            if old_opt == "C" and old_strike >= self.spot:
                continue
            if old_opt == "P" and old_strike <= self.spot:
                continue

            desired_delta_exposure = old_qty * old_delta
            if abs(desired_delta_exposure) <= 0.0:
                continue

            same_opt_candidates = [
                c for c in option_legs
                if c.expiry_code == target_expiry
                and c.opt == old_opt
                and abs(float(c.delta or 0.0)) >= min_abs_delta
            ]

            # Require target replacement to also be ITM.
            if old_opt == "C":
                same_opt_candidates = [
                    c for c in same_opt_candidates
                    if float(c.strike or 0.0) < self.spot
                ]
            else:
                same_opt_candidates = [
                    c for c in same_opt_candidates
                    if float(c.strike or 0.0) > self.spot
                ]

            if not same_opt_candidates:
                continue

            replacement = min(
                same_opt_candidates,
                key=lambda c: abs(abs(float(c.delta or 0.0)) - abs(old_delta)),
            )

            replacement_delta = float(replacement.delta or 0.0)
            if abs(replacement_delta) < min_abs_delta:
                continue

            old_price = float(getattr(p, "mark_price_usd", 0.0) or 0.0)
            new_price = max(float(replacement.bs_price_usd or 0.0), 1e-9)

            old_premium_abs = abs(old_qty * old_price)
            replacement_abs_qty = int(round(old_premium_abs / new_price))

            replacement_qty = int(math.copysign(replacement_abs_qty, old_qty))

            instrument_name = f"{self.asset}-{replacement.expiry_code}-{np.round(replacement.strike, self.asset_precision)}-{replacement.opt}"

            trades.append({
                "counterparty": replacement.counterparty,
                "instrument": instrument_name,
                "strategy": "ROLL_REPLACEMENT",
                "strategy_instrument": instrument_name,
                "expiry": replacement.expiry_date,
                "dte": replacement.dte,
                "strike": replacement.strike,
                "opt": replacement.opt,
                "qty": replacement_qty,
                "side": "Buy" if replacement_qty > 0 else "Sell",
                "iv_pct": round(float(replacement.iv_pct or 0.0), 1),
                "bs_price_usd": round(float(replacement.bs_price_usd or 0.0), 2),
                "vega": round(float(replacement.vega or 0.0), 4),
                "estimated_cash_outlay": 0.0,
                "normalized_benefit": 0.0,
                "net_benefit": 0.0,
                "delta_contribution": round(float(replacement_qty * replacement_delta), 4),
                "gamma_contribution": round(float(replacement_qty * (replacement.gamma or 0.0)), 6),
                "vega_contribution": round(float(replacement_qty * (replacement.vega or 0.0)), 4),
                "rolled_from": getattr(p, "instrument", ""),
            })

        return trades

    def _build_roll_summary(
        self,
        roll_positions: list[Position],
        roll_unwind_trades: list[dict],
        roll_replacement_trades: list[dict],
    ) -> dict:
        current_mtm = float(
            sum(float(getattr(p, "current_mtm", 0.0) or 0.0) for p in roll_positions)
        )

        close_value = float(
            sum(
                float(t.get("qty", 0.0) or 0.0)
                * float(t.get("bs_price_usd", 0.0) or 0.0)
                for t in roll_unwind_trades
            )
        )

        open_value = float(
            sum(
                float(t.get("qty", 0.0) or 0.0)
                * float(t.get("bs_price_usd", 0.0) or 0.0)
                for t in roll_replacement_trades
            )
        )

        return {
            "rolled_positions_count": len(roll_positions),
            "current_mtm_before_roll": round(current_mtm, 2),
            "close_value": round(close_value, 2),
            "open_value": round(open_value, 2),
            "net_roll_cash": round(close_value - open_value, 2),
        }

    def _build_option_smile(self) -> OptionSmile | None:
        smile_slices = [
            {
                "expiry_code": smile["expiry_code"],
                "expiry_date": smile["expiry_date"],
                "strikes": smile["strikes"],
                "ivs": [iv / 100.0 for iv in smile["ivs"]],
            }
            for smile in self.vol_surface
            if smile.get("dte", 0) > 0
        ]

        if not smile_slices:
            return None

        return OptionSmile(smile_slices, today=self.today)

    def _trade_value_curve(
        self,
        trade: dict,
        spot_arr: np.ndarray,
    ) -> np.ndarray:
        qty = float(trade.get("qty", 0.0) or 0.0)
        strike = float(trade.get("strike", 0.0) or 0.0)
        opt = str(trade.get("opt", "") or "")
        dte = int(trade.get("dte", 0) or 0)
        iv_pct = float(trade.get("iv_pct", 0.0) or 0.0)

        if opt == "F":
            return qty * (spot_arr - strike)

        if opt not in ("C", "P"):
            return np.zeros_like(spot_arr, dtype=float)

        T = max(dte, 0) / 365.25
        sigma = iv_pct / 100.0
        price_curve = bs_vec(spot_arr, strike, T, 0.0, sigma, opt)
        entry_price = float(trade.get("bs_price_usd", 0.0) or 0.0)

        return qty * (price_curve - entry_price)

    def _trade_premium_summary(self, trades: list[dict]) -> dict:
        option_trades = [
            trade for trade in trades
            if trade.get("opt") in ("C", "P")
        ]

        gross_premium_bought = sum(
            float(trade.get("qty", 0.0) or 0.0) * float(trade.get("bs_price_usd", 0.0) or 0.0)
            for trade in option_trades
            if float(trade.get("qty", 0.0) or 0.0) > 0
        )

        gross_premium_sold = sum(
            abs(float(trade.get("qty", 0.0) or 0.0)) * float(trade.get("bs_price_usd", 0.0) or 0.0)
            for trade in option_trades
            if float(trade.get("qty", 0.0) or 0.0) < 0
        )

        net_premium_generated = gross_premium_sold - gross_premium_bought

        return {
            "gross_premium_sold": round(float(gross_premium_sold), 2),
            "gross_premium_bought": round(float(gross_premium_bought), 2),
            "net_premium_generated": round(float(net_premium_generated), 2),
        }

    def _trade_premium_summary(self, trades: list[dict]) -> dict:
        option_trades = [
            trade for trade in trades
            if trade.get("opt") in ("C", "P")
        ]

        gross_premium_bought = sum(
            float(trade.get("qty", 0.0) or 0.0) * float(trade.get("bs_price_usd", 0.0) or 0.0)
            for trade in option_trades
            if float(trade.get("qty", 0.0) or 0.0) > 0
        )

        gross_premium_sold = sum(
            abs(float(trade.get("qty", 0.0) or 0.0)) * float(trade.get("bs_price_usd", 0.0) or 0.0)
            for trade in option_trades
            if float(trade.get("qty", 0.0) or 0.0) < 0
        )

        net_premium_generated = gross_premium_sold - gross_premium_bought

        return {
            "gross_premium_sold": round(float(gross_premium_sold), 2),
            "gross_premium_bought": round(float(gross_premium_bought), 2),
            "net_premium_generated": round(float(net_premium_generated), 2),
        }

    def _build_box_premium_neutralizer_trades(
            self,
            token,
            trades: list[dict],
            option_legs: list[Candidate],
            target_expiry: str | None,
            min_abs_premium: float = 10_000.0,
    ) -> list[dict]:
        if target_expiry is None:
            return []

        net_premium_generated = float(self._trade_premium_summary(trades)["net_premium_generated"])
        if abs(net_premium_generated) < min_abs_premium:
            return []

        expiry_legs = [
            c for c in option_legs
            if c.expiry_code == target_expiry
               and c.opt in ("C", "P")
               and float(c.bs_price_usd or 0.0) > 0.0
        ]

        calls_by_strike = {float(c.strike): c for c in expiry_legs if c.opt == "C"}
        puts_by_strike = {float(c.strike): c for c in expiry_legs if c.opt == "P"}
        common_strikes = sorted(set(calls_by_strike) & set(puts_by_strike))

        if len(common_strikes) < 2:
            return []

        best_box = None
        for low_strike in common_strikes:
            for high_strike in common_strikes:
                if high_strike <= low_strike:
                    continue

                low_call = calls_by_strike[low_strike]
                low_put = puts_by_strike[low_strike]
                high_call = calls_by_strike[high_strike]
                high_put = puts_by_strike[high_strike]

                # Long box: +C_low -P_low -C_high +P_high.
                box_debit = (
                        float(low_call.bs_price_usd or 0.0)
                        - float(low_put.bs_price_usd or 0.0)
                        - float(high_call.bs_price_usd or 0.0)
                        + float(high_put.bs_price_usd or 0.0)
                )

                if box_debit <= 0.0:
                    continue

                target_width = max(self.spot * 0.5, 1.0)
                width = high_strike - low_strike
                score = abs(width - target_width) + abs((low_strike + high_strike) / 2.0 - self.spot) * 0.25

                if best_box is None or score < best_box[0]:
                    best_box = (score, box_debit, low_call, low_put, high_call, high_put)

        if best_box is None:
            return []

        _score, box_debit, low_call, low_put, high_call, high_put = best_box
        box_qty = int(round(abs(net_premium_generated) / box_debit))
        if box_qty == 0:
            return []

        # Net credit already generated => buy long box to spend it.
        # Net debit generated => sell box to fund it.
        direction = 1 if net_premium_generated > 0.0 else -1

        legs = [
            (low_call, direction * box_qty),
            (low_put, -direction * box_qty),
            (high_call, -direction * box_qty),
            (high_put, direction * box_qty),
        ]

        if token == "ETH":
            strategy_instrument = (
                f"BOX_NEUTRALIZER: "
                f"ETH-{target_expiry}-{int(low_call.strike)} / "
                f"ETH-{target_expiry}-{int(high_call.strike)}"
            )
        elif token == "FIL":
            strategy_instrument = (
                f"BOX_NEUTRALIZER: "
                f"FIL-{target_expiry}-{int(low_call.strike)} / "
                f"FIL-{target_expiry}-{int(high_call.strike)}"
            )
        else:
            raise ValueError(f"Unsupported token: {token}")

        box_trades = []
        for leg, leg_qty in legs:
            strike = int(leg.strike) if token == "ETH" else np.round(leg.strike, 2)

            instrument_name = f"{token}-{leg.expiry_code}-{strike}-{leg.opt}"
            box_trades.append({
                "counterparty": leg.counterparty,
                "instrument": instrument_name,
                "strategy": "BOX_NEUTRALIZER",
                "strategy_instrument": strategy_instrument,
                "expiry": leg.expiry_date,
                "dte": leg.dte,
                "strike": leg.strike,
                "opt": leg.opt,
                "qty": leg_qty,
                "side": "Buy" if leg_qty > 0 else "Sell",
                "iv_pct": round(float(leg.iv_pct or 0.0), 1),
                "bs_price_usd": round(float(leg.bs_price_usd or 0.0), 2),
                "vega": round(float(leg.vega or 0.0), 4),
                "notional": round(abs(float(leg_qty)) * float(leg.bs_price_usd or 0.0), 2),
                "is_unwind": False,
                "unwind_qty": 0,
                "new_qty": abs(int(leg_qty)),
                "estimated_cash_outlay": 0.0,
                "normalized_benefit": 0.0,
                "net_benefit": 0.0,
                "delta_contribution": round(float(leg_qty * (leg.delta or 0.0)), 4),
                "gamma_contribution": round(float(leg_qty * (leg.gamma or 0.0)), 6),
                "vega_contribution": round(float(leg_qty * (leg.vega or 0.0)), 4),
            })

        return box_trades

    def _build_box_cash_neutralizer_trades(
            self,
            token,
            counterparty: str,
            net_cash_imbalance: float,
            option_legs: list[Candidate],
            target_expiry: str | None,
            min_abs_imbalance: float = 10_000.0,
            bid_ask_atm_pct: "dict[str, float] | float | None" = None,
            bid_ask_min_delta: float = 0.05,
            bid_ask_vol_pts: "dict[str, float] | float | None" = None,
            box_fee_bps: "dict[str, float] | float | None" = None,
    ) -> list[dict]:
        """Box spread (long call + short put at one strike, short call + long
        put at another, same expiry, single counterparty) sized to neutralize
        one counterparty's own net cash imbalance (outlay − collection).

        Put-call parity makes a box's value flat with respect to spot at any
        horizon (r=0, as elsewhere in this module: (C_low−P_low)−(C_high−P_high)
        = K_high−K_low regardless of spot or vol) — it moves cash without
        touching the profile fit at all. Its wide strike width (~50% of spot)
        also gives it a large net premium per contract, unlike a narrow
        vertical spread's tiny net price — the reason those need such large
        quantities to move the same amount of cash.
        """
        if target_expiry is None or abs(net_cash_imbalance) < min_abs_imbalance:
            return []

        expiry_legs = [
            c for c in option_legs
            if c.expiry_code == target_expiry
               and c.counterparty == counterparty
               and c.opt in ("C", "P")
               and float(c.bs_price_usd or 0.0) > 0.0
        ]

        calls_by_strike = {float(c.strike): c for c in expiry_legs if c.opt == "C"}
        puts_by_strike = {float(c.strike): c for c in expiry_legs if c.opt == "P"}
        common_strikes = sorted(set(calls_by_strike) & set(puts_by_strike))

        if len(common_strikes) < 2:
            return []

        best_box = None
        for low_strike in common_strikes:
            for high_strike in common_strikes:
                if high_strike <= low_strike:
                    continue

                low_call = calls_by_strike[low_strike]
                low_put = puts_by_strike[low_strike]
                high_call = calls_by_strike[high_strike]
                high_put = puts_by_strike[high_strike]

                # Long box: +C_low -P_low -C_high +P_high.
                box_debit = (
                        float(low_call.bs_price_usd or 0.0)
                        - float(low_put.bs_price_usd or 0.0)
                        - float(high_call.bs_price_usd or 0.0)
                        + float(high_put.bs_price_usd or 0.0)
                )

                if box_debit <= 0.0:
                    continue

                target_width = max(self.spot * 0.5, 1.0)
                width = high_strike - low_strike
                score = abs(width - target_width) + abs((low_strike + high_strike) / 2.0 - self.spot) * 0.25

                if best_box is None or score < best_box[0]:
                    best_box = (score, box_debit, low_call, low_put, high_call, high_put)

        if best_box is None:
            return []

        _score, box_debit, low_call, low_put, high_call, high_put = best_box
        # Deliberately not capped by max_qty: a box plays a distinct role from
        # naked/spread candidates (pure cash neutralization, flat w.r.t. spot
        # by construction) and should stay fully effective at closing the
        # imbalance regardless of the size limit applied elsewhere.
        box_qty = int(round(abs(net_cash_imbalance) / box_debit))
        if box_qty == 0:
            return []

        # net_cash_imbalance > 0 (outlay > collection, desk needs to raise
        # cash) => sell the box (receive box_debit per unit). < 0 (desk needs
        # to spend cash) => buy the box.
        direction = -1 if net_cash_imbalance > 0.0 else 1

        legs = [
            (low_call, direction * box_qty),
            (low_put, -direction * box_qty),
            (high_call, -direction * box_qty),
            (high_put, direction * box_qty),
        ]

        if token == "ETH":
            strategy_instrument = (
                f"BOX_NEUTRALIZER: "
                f"ETH-{target_expiry}-{int(low_call.strike)} / "
                f"ETH-{target_expiry}-{int(high_call.strike)}"
            )
        elif token == "FIL":
            strategy_instrument = (
                f"BOX_NEUTRALIZER: "
                f"FIL-{target_expiry}-{int(low_call.strike)} / "
                f"FIL-{target_expiry}-{int(high_call.strike)}"
            )
        else:
            raise ValueError(f"Unsupported token: {token}")

        # Box legs' net vega is exactly zero by construction (put-call parity
        # gives the call/put at a given strike identical vega, cancelling
        # across the +C/-P pairing at each strike) — _structure_leg_costs_usd
        # derives that generically from net exposure, same mechanism used for
        # every other structure, rather than a box-specific hardcoded 0.
        leg_costs = _structure_leg_costs_usd(legs, bid_ask_vol_pts)

        # The vega-based cost above is provably ~0 for a box, but executing one
        # is still 4 real fills against the counterparty's real bid-ask. A box
        # is economically a synthetic cash loan (riskless payoff = box_debit,
        # which equals K_high-K_low exactly since r=0 here), so its bid-ask is
        # priced as bps of that notional — same convention as an implied-rate
        # spread on an inter-dealer box — not a flat per-contract fee. Split
        # evenly across the legs so no single leg "carries" the whole cost.
        box_fee_bp = CollateralOptimization._resolve(box_fee_bps, counterparty, default=_BOX_FEE_BPS_FALLBACK)
        box_fee_total = abs(box_qty) * box_debit * float(box_fee_bp or 0.0) / 10_000.0
        if box_fee_total:
            per_leg_fee = box_fee_total / len(legs)
            leg_costs = [lc + per_leg_fee for lc in leg_costs]

        box_trades = []
        for (leg, leg_qty), leg_cost in zip(legs, leg_costs):
            strike = int(leg.strike) if token == "ETH" else np.round(leg.strike, 2)
            instrument_name = f"{token}-{leg.expiry_code}-{strike}-{leg.opt}"
            box_trades.append({
                "counterparty": leg.counterparty,
                "instrument": instrument_name,
                "strategy": "BOX_NEUTRALIZER",
                "strategy_instrument": strategy_instrument,
                "expiry": leg.expiry_date,
                "dte": leg.dte,
                "strike": leg.strike,
                "opt": leg.opt,
                "qty": leg_qty,
                "side": "Buy" if leg_qty > 0 else "Sell",
                "iv_pct": round(float(leg.iv_pct or 0.0), 1),
                "bs_price_usd": round(float(leg.bs_price_usd or 0.0), 2),
                "vega": round(float(leg.vega or 0.0), 4),
                "notional": round(abs(float(leg_qty)) * float(leg.bs_price_usd or 0.0), 2),
                "is_unwind": False,
                "unwind_qty": 0,
                "new_qty": abs(int(leg_qty)),
                "estimated_cash_outlay": 0.0,
                "normalized_benefit": 0.0,
                "net_benefit": 0.0,
                "delta_contribution": round(float(leg_qty * (leg.delta or 0.0)), 4),
                "gamma_contribution": round(float(leg_qty * (leg.gamma or 0.0)), 6),
                "vega_contribution": round(float(leg_qty * (leg.vega or 0.0)), 4),
                "cost_usd": round(leg_cost, 2),
            })

        return box_trades

    def _build_delta_rehedge_trade(
            self,
            trades: list[dict],
            roll_position_ids: set,
            delta_band: float,
            perp_cost_bps: "dict[str, float] | float | None",
            unwind_discount: float,
            new_position_penalty: float,
    ) -> dict | None:
        """Delta-band cleanup via delta_hedger.check_rehedge, run on the book
        this LP call just produced (existing positions minus whatever's being
        rolled off, plus every option trade just proposed) rather than on a
        live/intraday snapshot. ``trades`` already includes roll-unwind and
        box-neutralizer legs by the time this runs; only C/P legs count toward
        the option-delta mismatch (a "F" leg the LP itself proposed already
        carries delta 1:1 and is folded into ``perp_position`` instead, so it
        isn't double-counted).

        Returns None if the band isn't breached, or if it rounds to a zero
        trade — otherwise one perp trade dict on PERP_COUNTERPARTY, sized to
        flatten the mismatch back to zero (delta_hedger's policy, not just to
        the edge of the band).
        """
        live_positions = [p for p in self.positions if id(p) not in roll_position_ids]

        trade_option_delta = sum(
            float(t.get("delta_contribution", 0.0) or 0.0)
            for t in trades if t.get("opt") in ("C", "P")
        )
        existing_perp_qty = sum(
            float(getattr(p, "net_qty", 0.0) or 0.0)
            for p in live_positions if str(getattr(p, "opt", "") or "") == "F"
        )
        lp_perp_qty = sum(
            float(t.get("qty", 0.0) or 0.0)
            for t in trades if t.get("opt") == "F"
        )

        decision = check_rehedge(
            positions=live_positions,
            spot=self.spot,
            perp_position=existing_perp_qty + lp_perp_qty,
            band=delta_band,
            extra_option_delta=trade_option_delta,
        )
        print(f"  delta rehedge: option_delta={decision.net_option_delta:,.1f} "
              f"perp_position={decision.perp_position:,.1f} mismatch={decision.mismatch:,.1f} "
              f"band={decision.band:,.1f} breached={decision.breached}")
        if not decision.breached:
            return None

        trade_qty = int(round(decision.trade_qty))
        if trade_qty == 0:
            return None

        cost_bps = CollateralOptimization._resolve(
            perp_cost_bps, PERP_COUNTERPARTY, default=_PERP_COST_BPS_FALLBACK,
        )
        cost = perp_trade_cost(trade_qty, self.spot, cost_bps)
        est_cash_outlay = self._estimate_trade_cash_outlay(
            qty=trade_qty, price=self.spot, held_qty=0.0,
            unwind_discount=unwind_discount, new_position_penalty=new_position_penalty,
            is_held=False,
        )
        instrument_name = f"{self.asset}-PERPETUAL"
        return {
            "counterparty": PERP_COUNTERPARTY,
            "instrument": instrument_name,
            "strategy": "DELTA_REHEDGE",
            "strategy_instrument": instrument_name,
            "expiry": "",
            "dte": 0,
            "strike": round(self.spot, 2),
            "opt": "F",
            "qty": trade_qty,
            "side": "Buy" if trade_qty > 0 else "Sell",
            "iv_pct": 0.0,
            "bs_price_usd": round(self.spot, 2),
            "vega": 0.0,
            "notional": round(abs(trade_qty) * self.spot, 2),
            "is_unwind": False,
            "unwind_qty": 0,
            "new_qty": abs(trade_qty),
            "estimated_cash_outlay": round(est_cash_outlay, 2),
            "normalized_benefit": 0.0,
            "net_benefit": 0.0,
            "delta_contribution": round(float(trade_qty), 4),
            "gamma_contribution": 0.0,
            "vega_contribution": 0.0,
            "cost_usd": round(cost, 2),
        }

    def _risk_neutral_spot_weights(
            self,
            spot_arr: np.ndarray,
            option_smile: OptionSmile,
            target_expiry: str,
    ) -> np.ndarray:
        """
        Infer risk-neutral terminal spot weights from the target-expiry smile.

        Uses Breeden-Litzenberger:
            q(K) = exp(rT) * d²C(K,T) / dK²

        With r = 0 here, q(K) is approximated by the numerical second
        derivative of call prices across the strike/state grid.
        """
        matching_slice = next(
            (
                smile_slice
                for smile_slice in option_smile.slices
                if smile_slice.expiry_code == target_expiry
            ),
            None,
        )

        if matching_slice is None:
            return np.ones_like(spot_arr, dtype=float)

        strikes = np.asarray(spot_arr, dtype=float)
        if strikes.size < 3:
            return np.ones_like(strikes, dtype=float)

        maturity = matching_slice.maturity
        T = option_smile._year_fraction(maturity)
        r = 0.0

        call_prices = np.array(
            [
                options.bs_price(
                    self.spot,
                    strike,
                    T,
                    r,
                    option_smile.compute_vol(maturity, strike=strike),
                    "C",
                )
                for strike in strikes
            ],
            dtype=float,
        )

        raw_density = np.gradient(np.gradient(call_prices, strikes), strikes)
        density = gaussian_filter1d(raw_density, sigma=1.5, mode="nearest")
        density = np.clip(density, 0.0, None)

        if not np.any(np.isfinite(density)) or float(np.sum(density)) <= 0.0:
            return np.ones_like(strikes, dtype=float)

        weights = density / np.mean(density[density > 0.0])
        return np.clip(weights, 1e-1, None)

    def bs_value_for_position(
            self,
            spot_arr,
            p: Position,
            option_smile: OptionSmile | None = None,
            horizon_days: int = 0,
    ) -> np.ndarray:
        """
        Reprice an existing position across the spot ladder using Black-Scholes.

        Uses sticky-strike volatility:
            sigma = smile_vol(position_expiry, position_strike)

        That sigma is then held fixed while evaluating BS over different spots.
        """
        # net_qty is already signed (negative=Short, positive=Long) — no side flip needed.
        signed_qty = float(getattr(p, "net_qty", 0.0) or 0.0)

        strike = float(getattr(p, "strike", 0.0) or 0.0)
        opt = str(getattr(p, "opt", "") or "")
        if opt == "F":
            return signed_qty * (spot_arr - strike)
        if opt not in ("C", "P"):
            return np.zeros_like(spot_arr, dtype=float)

        if option_smile is not None:
            maturity = datetime.combine(p.expiry_date, datetime.min.time())
            # _year_fraction is time-to-maturity from today, with no horizon
            # concept — subtract it here so horizon_days actually does
            # something (previously accepted but silently ignored).
            T = max(option_smile._year_fraction(maturity) - horizon_days / 365.25, 0.0)
            sigma = option_smile.compute_vol(maturity, strike=strike)
        else:
            T = float('nan')
            sigma = float(getattr(p, "iv_pct", 0.0) or 0.0) / 100.0

        r = 0.0
        return signed_qty * bs_vec(spot_arr, strike, T, r, sigma, opt)

    @staticmethod
    def nice_spot_ticks(spot: float) -> np.ndarray:
        tick_multipliers = np.array([0.4, 0.6, 0.8, 1.0, 1.2, 1.8, 2.8], dtype=float)
        raw_ticks = spot * tick_multipliers

        if spot >= 1000:
            step = 100.0
        elif spot >= 100:
            step = 10.0
        elif spot >= 10:
            step = 1.0
        elif spot >= 1:
            step = 0.1
        else:
            step = 0.01

        return np.round(raw_ticks / step) * step

    def run_lp(self,
                 lam_factor: float = 0.5,
                 mu_factor: float = 0.0,
                 bid_ask_atm_pct: "dict[str, float] | float | None" = None,
                 bid_ask_min_delta: float = 0.05,
                 bid_ask_vol_pts: "dict[str, float] | float | None" = None,
                 box_fee_bps: "dict[str, float] | float | None" = None,
                 perp_cost_bps: "dict[str, float] | float | None" = None,
                 min_trade_delta: float = 0.10,
                 target_expiry: str | None = None,
                 unwind_discount: float = 0.2,
                 new_position_penalty: float = 0.04,
                 is_replay: bool = False,
                 roll_dte_threshold: int | None = 7,
                 roll_itm_only: bool = False,
                 collateral_budget_pct: float | None = None,
                 counterparties: list[str] | None = None,
                 asset: str | None = None,
                 max_exposure_by_counterparty: dict | None = None,
                 collateral_tier_free_pct: "dict[str, float] | float" = 0.0,
                 collateral_tier_mu: "dict[str, float] | float | None" = None,
                 forced_roll_ids: list[int] | None = None,
                 cash_neutrality_factor: "dict[str, float] | float" = 0.0,
                 max_qty: float | None = None,
                 max_trades: int | None = None,
                 enable_box_neutralizer: bool = True,
                 enable_delta_rehedge: bool = False,
                 delta_band: float = 75.0,
                 downside_factor: float = 1.0,
                 t90_weight: float = 0.0,
                 manual_target: list[dict] | None = None,
                 target_profile_file: str | None = None,
                 max_cp_loss_usd: "dict[str, float] | float | None" = None,
                 collateral_by_cp: "dict[str, dict[str, float]] | None" = None,
                 enforce_collateral_cap: bool = False,
                 enable_composite_unwind: bool = True,
                 atm_concentration: float = 0.0,
            ):
        if asset is not None:
            self.asset = asset.upper()
            if self.asset == "ETH":
                self.asset_precision = 0
            elif self.asset == "FIL":
                self.asset_precision = 2
            else:
                raise ValueError(f"Unsupported asset: {self.asset}")
        print(f"asset: {self.asset}")

        # Transaction cost is now driven by VOLpts (|vega| × VOLpts); fall back to
        # this asset's default vol-point spreads when no explicit override is given.
        # (bid_ask_atm_pct is retained as an accepted param for back-compat but no
        # longer drives cost, so it needs no default here.)
        if bid_ask_vol_pts is None:
            bid_ask_vol_pts = DEFAULT_BID_ASK_VOL_PTS_BY_ASSET.get(self.asset, {})
        if box_fee_bps is None:
            box_fee_bps = DEFAULT_BOX_FEE_BPS_BY_ASSET.get(self.asset, {})

        target_profile = build_parametric_target_profile(self.asset, spot_ladder=self.spot_ladder,
                                                         current_spot=self.spot)

        held_positions = self.get_held_positions()
        roll_positions = self._get_roll_positions(
            roll_dte_threshold, roll_itm_only=roll_itm_only, counterparties=counterparties,
            forced_roll_ids=forced_roll_ids,
        )
        roll_position_ids = {id(p) for p in roll_positions}

        option_legs = self._build_candidates(target_expiry=target_expiry, include_itm=False, counterparties=counterparties)
        # Spreads are built from target_expiry vanilla legs only (before unwind injection),
        # so they're always new positions (existing_qty=0, unwind_only=False via getattr defaults).
        # SpreadCandidate is frozen so we concatenate after the existing_qty stamp loop below.
        spread_candidates = self._build_spread_candidates(option_legs, target_expiry=target_expiry)

        option_smile = self._build_option_smile()
        if option_smile is None:
            return {"status": "no_smile", "message": "No valid vol surface slices available."}

        # Inject candidates for held positions at off-target expiries (option_legs
        # only covers target_expiry) so they're eligible for voluntary unwind too.
        # Scoped to the selected counterparties — a position from a counterparty
        # NOT in that list is left alone entirely now, matching the same scoping
        # already applied to new candidates and forced rolls (previously this was
        # a deliberate exception/"safety valve" letting the LP touch an
        # off-scope counterparty's book; reversed on request).
        selected_counterparties_inject = {
            c.strip() for c in (counterparties or []) if c and c.strip() and c.strip().upper() != "ALL"
        }
        option_leg_keys = {(c.expiry_code, c.strike, c.opt, c.counterparty) for c in option_legs}
        held_expiries = set()
        for p in self.positions:
            if id(p) in roll_position_ids:
                continue
            exp_code = getattr(p, "expiry_code", "") or ""
            if not exp_code:
                parts = p.instrument.split("-")
                exp_code = parts[1] if len(parts) >= 4 else ""
            if not exp_code:
                continue
            held_expiries.add(exp_code)
            cp = getattr(p, "counterparty", "")
            if selected_counterparties_inject and cp not in selected_counterparties_inject:
                continue
            strike = float(getattr(p, "strike", 0.0) or 0.0)
            opt = str(getattr(p, "opt", "") or "")
            if opt not in ("C", "P") or (exp_code, strike, opt, cp) in option_leg_keys:
                continue
            try:
                expiry_dt = datetime.combine(p.expiry_date, datetime.min.time())
                dte = (expiry_dt - self.today).days
                if dte < 0:
                    continue
                sigma = option_smile.compute_vol(expiry_dt, strike)
                expiry_date_str = p.expiry_date.strftime("%Y-%m-%d")
                c = self.create_candidate(self.spot, strike, 0., sigma, opt, exp_code, expiry_date_str, dte, cp)
                c.unwind_only = True
                option_legs.append(c)
                option_leg_keys.add((exp_code, strike, opt, cp))
            except Exception as e:
                print(f"  [inject candidate error] {exp_code} {strike} {opt} {cp}: {e}")
                continue


        for c in option_legs:
            c.existing_qty = held_positions.get((c.expiry_code, c.strike, c.opt, c.counterparty), 0.0)
        candidates = option_legs + spread_candidates

        n_with_existing = sum(1 for c in candidates if getattr(c, "existing_qty", 0.0) != 0.0)
        n_unwind_only = sum(1 for c in candidates if getattr(c, "unwind_only", False))
        print(f"candidates: {len(candidates)} total, {n_with_existing} with existing_qty≠0, {n_unwind_only} unwind_only")

        # Held multi-leg deals ("composites") that can be safely unwound as one
        # unit — see base_optimizer.get_composite_groups for what "safely"
        # means. Only vanilla (single-leg) Candidates correspond 1:1 to a real
        # leg, so composite membership is resolved against option_legs only,
        # never the synthetic spread/straddle/condor candidates built above.
        composite_leg_groups: dict[str, list[int]] = {}
        if enable_composite_unwind:
            candidate_index_by_key = {
                (c.expiry_code, c.strike, c.opt, c.counterparty): j
                for j, c in enumerate(option_legs)
            }
            n_skipped = 0
            for cid, leg_qtys in self.get_composite_groups().items():
                indices = [candidate_index_by_key.get(key) for key, _qty in leg_qtys]
                if len(indices) >= 2 and all(j is not None for j in indices):
                    composite_leg_groups[cid] = indices
                else:
                    n_skipped += 1
            if composite_leg_groups or n_skipped:
                print(f"  composite unwind: {len(composite_leg_groups)} composites linked, "
                      f"{n_skipped} skipped (a leg fell outside this run's candidate universe)")

        # Manual target (user-drawn on the Optimizer v3 screen) overrides the
        # parametric one when supplied — the LP fits the book to these control
        # points instead. Needs >=2 points; np.interp fills between them, and the
        # LP's cash_shift free variable absorbs any constant vertical offset, so
        # only the *shape* of the supplied curve matters.
        _manual_xs, _manual_ys = [], []
        if manual_target and len(manual_target) >= 2:
            # Sanitize: drop non-numeric/non-finite points and enforce strictly
            # increasing strikes (np.interp requires monotonic xp) — a bad point
            # from the editable grid must never crash the whole run.
            _valid = []
            for p in manual_target:
                try:
                    x = float(p.get("x")); y = float(p.get("y"))
                except (TypeError, ValueError):
                    continue
                if np.isfinite(x) and np.isfinite(y):
                    _valid.append((x, y))
            _valid.sort(key=lambda t: t[0])
            for x, y in _valid:
                if _manual_xs and x <= _manual_xs[-1]:
                    continue
                _manual_xs.append(x); _manual_ys.append(y)

        if len(_manual_xs) >= 2:
            target_strikes = np.array(_manual_xs, dtype=float)
            target_payoff_arr = np.array(_manual_ys, dtype=float)
            print(f"manual_target: fitting to {len(_manual_xs)} user control points")
        elif target_profile_file:
            # A saved target-profile CSV selected in the GUI — load and fit to it.
            _tp = load_target_profile_file(target_profile_file, self.asset)
            target_strikes = np.asarray(_tp.index, dtype=float)
            target_payoff_arr = np.asarray(_tp["Payoff($)"], dtype=float)
            print(f"target_profile_file: fitting to '{target_profile_file}'")
        else:
            target_strikes = np.asarray(target_profile.index, dtype=float)
            target_payoff_arr = np.asarray(target_profile["Payoff($)"], dtype=float)

        spot_arr = np.array(self.spot_ladder, dtype=float)
        target_interp = np.interp(spot_arr, target_strikes, target_payoff_arr)

        if target_expiry is not None:
            spot_weights = self._risk_neutral_spot_weights(
                spot_arr=spot_arr,
                option_smile=option_smile,
                target_expiry=target_expiry,
            )
        else:
            spot_weights = np.ones_like(spot_arr, dtype=float)
        spot_weights /= np.sum(spot_weights)

        # ATM concentration knob: power-law tilt on the (already risk-neutral-
        # density-weighted) spot_weights, à la temperature-scaled "sharpening"
        # (p^(1/T) / sum(p^(1/T))). atm_concentration=0 -> gamma=1 -> exact
        # no-op, so the default reproduces today's behavior bit-for-bit.
        # Positive values concentrate more weight at the money (gamma>1,
        # shrinks the tails' relative share, including the density floor's
        # flat tail below); negative values flatten toward a uniform spread
        # (gamma->0 as atm_concentration->-inf, the well-defined uniform
        # limit of p^gamma). Applied once here so both the T0 and T+90
        # profile-fit terms below see the same tilted weights.
        atm_gamma = float(np.exp(atm_concentration))
        spot_weights = np.power(spot_weights, atm_gamma)
        spot_weights /= np.sum(spot_weights)

        base_payoff = np.zeros_like(spot_arr)
        base_payoff_by_cp: dict[str, np.ndarray] = {}
        for p in self.positions:
            if id(p) in roll_position_ids:
                continue
            bs_value = self.bs_value_for_position(spot_arr, p, option_smile=option_smile)
            if np.isnan(bs_value.sum()):
                continue
            base_payoff += bs_value
            cp = getattr(p, "counterparty", "")
            base_payoff_by_cp[cp] = base_payoff_by_cp.get(cp, np.zeros_like(spot_arr)) + bs_value

        # Per-counterparty "P&L from today" baseline for the max_cp_loss_usd cap
        # below (and the cp_worst_case_stress reported diagnostic): each
        # counterparty's own (non-rolled) held book, repriced across the ladder,
        # anchored to its value at today's spot — so a negative value there
        # means "this CP is worse off than today," independent of whatever else
        # the rest of the fleet is doing.
        spot_idx0 = int(np.argmin(np.abs(spot_arr - self.spot)))
        base_stress_by_cp = {
            cp: arr - arr[spot_idx0] for cp, arr in base_payoff_by_cp.items()
        }

        # Posted-collateral floor per counterparty, marked to the SAME stress
        # ladder: USD/USDC collateral is currency-stable, but native-asset
        # collateral (ETH for an ETH book, FIL for a FIL book) is worth less
        # exactly where the loss is worst — this is what actually captures the
        # wrong-way risk of a counterparty posting collateral in the same
        # asset it's trading, instead of a flat $ guess. Deliberately scoped to
        # USD + this run's own asset only — collateral posted in an unrelated
        # asset (e.g. ETH collateral backing a FIL book) would need a
        # cross-asset correlation assumption this model doesn't make, so it's
        # left out rather than guessed at. Haircut with the SAME per-token
        # discounts already used on the Collateral tab (ETH 10%, FIL/WAVE 50%,
        # BTC 15%, USDC 0%) — full face value overstates how much cushion is
        # actually there to absorb a loss.
        collateral_floor_by_cp: dict[str, np.ndarray] = {}
        if collateral_by_cp:
            usd_haircut = HAIRCUTS.get("USDC", 0.0)
            native_haircut = HAIRCUTS.get(self.asset, 0.0)
            for cp, by_asset in collateral_by_cp.items():
                usd_qty = float(by_asset.get("USDC", 0.0) or 0.0) + float(by_asset.get("USD", 0.0) or 0.0)
                native_qty = float(by_asset.get(self.asset, 0.0) or 0.0)
                if usd_qty == 0.0 and native_qty == 0.0:
                    continue
                collateral_floor_by_cp[cp] = (
                    usd_qty * (1.0 - usd_haircut) + native_qty * (1.0 - native_haircut) * spot_arr
                )

        raw_residual = target_interp - base_payoff
        cash_shift = float(np.sum(spot_weights * raw_residual) / np.sum(spot_weights))
        adjusted_base_payoff = base_payoff + cash_shift
        residual = target_interp - adjusted_base_payoff

        c_payoffs = [self._candidate_curve(c=c, spot_arr=spot_arr, option_smile=option_smile) for c in candidates]

        # T+90 equivalent of the block above — same target, same spot_weights,
        # but every position/candidate repriced 90 days forward (own cash_shift
        # since the existing book's value moves to a different absolute scale
        # once time value bleeds off). Mixed with the T0 term via t90_weight
        # in the LP so the fit can care about "still roughly on-target in 90
        # days," not just "on-target today" — a book can nail the latter and
        # still drift badly by the former purely from theta decay.
        base_payoff_90 = np.zeros_like(spot_arr)
        for p in self.positions:
            if id(p) in roll_position_ids:
                continue
            bs_value_90 = self.bs_value_for_position(spot_arr, p, option_smile=option_smile, horizon_days=90)
            if np.isnan(bs_value_90.sum()):
                continue
            base_payoff_90 += bs_value_90

        raw_residual_90 = target_interp - base_payoff_90
        cash_shift_90 = float(np.sum(spot_weights * raw_residual_90) / np.sum(spot_weights))
        adjusted_base_payoff_90 = base_payoff_90 + cash_shift_90
        residual_90 = target_interp - adjusted_base_payoff_90

        c_payoffs_90 = [
            self._candidate_curve(c=c, spot_arr=spot_arr, option_smile=option_smile, horizon_days=90)
            for c in candidates
        ]

        # Gross collateral cap: sum(|final_qty| × price) per counterparty ≤ current × (1 + budget).
        # budget=0.0 → no increase allowed; budget=-0.1 → must shrink by 10%.
        max_gross_exposure_by_counterparty: dict | None = None
        if collateral_budget_pct is not None:
            cand_gross: dict[str, float] = {}
            for c in candidates:
                cp = getattr(c, "counterparty", "")
                price = float(c.bs_price_usd or 0.0)
                eq = float(getattr(c, "existing_qty", 0.0) or 0.0)
                cand_gross[cp] = cand_gross.get(cp, 0.0) + abs(eq) * price
            # Forced/DTE roll positions never get a matching candidate (the target
            # expiry usually differs, and injection explicitly skips them — see
            # roll_position_ids below), so their gross exposure is otherwise
            # invisible here. Add it back in: the cap's base should be the
            # counterparty's TRUE current gross exposure (including what's about
            # to be rolled away), so closing those positions is credited as freed
            # collateral room the LP can actually reuse — not silently discarded.
            for p in roll_positions:
                cp = getattr(p, "counterparty", "")
                price = float(getattr(p, "mark_price_usd", 0.0) or 0.0)
                qty = float(getattr(p, "net_qty", 0.0) or 0.0)
                cand_gross[cp] = cand_gross.get(cp, 0.0) + abs(qty) * price
            max_gross_exposure_by_counterparty = {
                cp: gross * (1.0 + collateral_budget_pct)
                for cp, gross in cand_gross.items() if gross > 0
            }
            print(f"  gross collateral caps: { {cp: f'{v:,.0f}' for cp, v in max_gross_exposure_by_counterparty.items()} }")

        # Forced/DTE roll unwinds are fixed before the LP runs — roll_positions is
        # already known — so build them now and fold their cash impact into the
        # LP's cash-neutrality objective as a per-counterparty constant. Otherwise
        # the LP only ever sees its own candidates' cash flow and has no way to
        # counterbalance a forced roll's outlay/collection, even though that cash
        # hits the same counterparty ledger.
        roll_unwind_trades = self._build_roll_unwind_trades(
            self.asset, roll_positions,
            bid_ask_atm_pct=bid_ask_atm_pct, bid_ask_min_delta=bid_ask_min_delta,
            bid_ask_vol_pts=bid_ask_vol_pts, box_fee_bps=box_fee_bps,
        )
        forced_cash_by_counterparty: dict[str, float] = {}
        for t in roll_unwind_trades:
            if t.get("opt") not in ("C", "P"):
                continue
            cp = t.get("counterparty", "")
            forced_cash_by_counterparty[cp] = (
                forced_cash_by_counterparty.get(cp, 0.0)
                + float(t.get("qty", 0.0) or 0.0) * float(t.get("bs_price_usd", 0.0) or 0.0)
            )

        # max_qty needs to cap the *aggregated* per-leg-instrument quantity that
        # ends up in the trades table, not each raw candidate — a naked leg and
        # several spreads can all share the same strike as one leg, and each
        # capped individually at max_qty still sums to a multiple of it once
        # _aggregate_trade_legs merges them by (counterparty, instrument, ...).
        # Group candidate indices by the leg(s) they actually expand to (mirrors
        # _candidate_trade_legs) so the LP itself can constrain that sum.
        leg_groups: dict[tuple, list[tuple[int, float]]] = {}
        if max_qty is not None:
            for j, c in enumerate(candidates):
                if self._is_spread_candidate(c):
                    legs = [(c.long_leg, 1.0), (c.short_leg, -1.0)]
                elif self._is_straddle_candidate(c):
                    legs = [(c.call_leg, 1.0), (c.put_leg, 1.0)]
                elif self._is_iron_condor_candidate(c):
                    legs = [(c.put_low_leg, 1.0), (c.put_high_leg, -1.0),
                            (c.call_low_leg, -1.0), (c.call_high_leg, 1.0)]
                else:
                    legs = [(c, 1.0)]
                for leg, sign in legs:
                    key = (getattr(leg, "expiry_code", ""), getattr(leg, "strike", 0.0),
                           getattr(leg, "opt", ""), getattr(leg, "counterparty", ""))
                    leg_groups.setdefault(key, []).append((j, sign))

        lp = CollateralOptimization(self.asset, counterparties)
        lp_result = lp.optimize(
            spot_arr, spot_weights, residual, candidates, c_payoffs,
            lam_factor=lam_factor,
            mu_factor=mu_factor,
            bid_ask_atm_pct=bid_ask_atm_pct,
            bid_ask_min_delta=bid_ask_min_delta,
            bid_ask_vol_pts=bid_ask_vol_pts,
            perp_cost_bps=perp_cost_bps,
            min_trade_delta=min_trade_delta,
            max_exposure_by_counterparty=max_exposure_by_counterparty,
            max_gross_exposure_by_counterparty=max_gross_exposure_by_counterparty,
            collateral_tier_free_pct=collateral_tier_free_pct,
            collateral_tier_mu=collateral_tier_mu,
            cash_neutrality_factor=cash_neutrality_factor,
            box_fee_bps=box_fee_bps,
            forced_cash_by_counterparty=forced_cash_by_counterparty,
            max_qty=max_qty,
            leg_groups=leg_groups,
            composite_groups=composite_leg_groups,
            downside_factor=downside_factor,
            residual_payoff_90=residual_90,
            c_payoffs_90=c_payoffs_90,
            t90_weight=t90_weight,
            max_cp_loss_usd=max_cp_loss_usd,
            base_stress_by_cp=base_stress_by_cp,
            collateral_floor_by_cp=collateral_floor_by_cp,
            enforce_collateral_floor=enforce_collateral_cap,
        )

        if lp_result is None:
            return {"status": "lp_failed", "message": "LP solver did not find an optimal solution."}

        net_qty = lp_result["net_qty"]

        # "Before" = full portfolio from held_positions (all expiries, all counterparties).
        # Prices come from candidates where available, fall back to 0.
        price_by_key: dict[tuple, float] = {
            (c.expiry_code, c.strike, c.opt, c.counterparty): float(c.bs_price_usd or 0.0)
            for c in candidates
        }
        before_coll: dict[str, float] = {}
        for (exp_code, strike, opt, cp), qty in held_positions.items():
            price = price_by_key.get((exp_code, strike, opt, cp), 0.0)
            before_coll[cp] = before_coll.get(cp, 0.0) + abs(qty) * price

        # "After" = existing positions adjusted by LP net_qty, plus any new positions opened.
        existing_qty_arr = np.array([float(getattr(c, "existing_qty", 0.0) or 0.0) for c in candidates])
        after_coll: dict[str, float] = {}
        for c, eq, nq in zip(candidates, existing_qty_arr, net_qty):
            cp = getattr(c, "counterparty", "")
            price = float(c.bs_price_usd or 0.0)
            after_coll[cp] = after_coll.get(cp, 0.0) + abs(eq + nq) * price

        all_cps = sorted(set(before_coll) | set(after_coll))
        print("=== Collateral by counterparty ===")
        for cp in all_cps:
            b = before_coll.get(cp, 0.0)
            a = after_coll.get(cp, 0.0)
            print(f"  {cp:20s}  before={b:>12,.0f}  after={a:>12,.0f}  change={a - b:>+12,.0f}")

        trades = list(roll_unwind_trades)
        fitted_payoff = adjusted_base_payoff.copy()
        # Accumulated once per candidate, before est_cost gets stamped onto every leg
        # below — summing "estimated_cash_outlay" off the leg rows after the fact
        # double-counts spreads/condors that share a leg with another candidate
        # (_aggregate_trade_legs merges those shared legs additively).
        total_cash_outlay = 0.0

        traded_candidates = [
            (j, int(np.round(qty)), c)
            for j, (qty, c) in enumerate(zip(net_qty, candidates))
            if int(np.round(qty)) != 0
        ]
        leg_group_costs = self._leg_group_costs(traded_candidates, bid_ask_vol_pts, perp_cost_bps)

        for j, rounded_qty, c in traded_candidates:
            est_cost = self._estimate_candidate_cash_outlay(
                c=c,
                qty=rounded_qty,
                held_positions=held_positions,
                unwind_discount=unwind_discount,
                new_position_penalty=new_position_penalty,
            )
            total_cash_outlay += est_cost
            instrument_name = self._candidate_instrument_name(c)
            fitted_payoff += rounded_qty * np.array(c_payoffs[j])

            # Cost is priced off the combined net vega exposure of every
            # candidate sharing a given real leg (see _leg_group_costs), split
            # back across each contributing candidate's own share of that leg's
            # quantity — a candidate that doesn't share any leg with another
            # forms its own singleton group, reducing to exactly the old
            # per-candidate net-exposure formula (_structure_leg_costs_usd).
            candidate_legs = self._candidate_trade_legs(c, rounded_qty)
            for leg, leg_qty, strategy in candidate_legs:
                group_key = (leg.counterparty, leg.expiry_code, leg.strike, leg.opt)
                merged_qty, merged_cost = leg_group_costs.get(group_key, (leg_qty, 0.0))
                leg_cost = merged_cost * (leg_qty / merged_qty) if merged_qty else 0.0
                leg_instrument_name = (
                    f"{self.asset}-PERPETUAL" if leg.opt == "F"
                    else f"{self.asset}-{leg.expiry_code}-{np.round(leg.strike, self.asset_precision)}-{leg.opt}"
                )
                existing_qty_c = float(getattr(c, "existing_qty", 0.0) or 0.0)
                is_unwind_leg = bool(rounded_qty * existing_qty_c < 0)
                if is_unwind_leg:
                    # Reducing/closing an existing held position — relabel so it
                    # isn't mistaken for a brand-new naked/spread trade in the UI.
                    strategy = "CLOSE" if abs(leg_qty) >= abs(existing_qty_c) - 1e-6 else "REDUCE"
                trades.append({
                    "counterparty": leg.counterparty,
                    "instrument": leg_instrument_name,
                    "strategy": strategy,
                    "strategy_instrument": instrument_name,
                    "expiry": leg.expiry_date,
                    "dte": leg.dte,
                    "strike": leg.strike,
                    "opt": leg.opt,
                    "qty": leg_qty,
                    "side": "Buy" if leg_qty > 0 else "Sell",
                    "iv_pct": round(float(leg.iv_pct or 0.0), 1),
                    "bs_price_usd": round(float(leg.bs_price_usd or 0.0), 2),
                    "vega": round(float(leg.vega or 0.0), 4),
                    "notional": round(abs(float(leg_qty)) * float(leg.bs_price_usd or 0.0), 2),
                    "is_unwind": is_unwind_leg,
                    "unwind_qty": abs(int(leg_qty)) if is_unwind_leg else 0,
                    "new_qty": 0 if is_unwind_leg else abs(int(leg_qty)),
                    "estimated_cash_outlay": round(float(est_cost), 2),
                    "normalized_benefit": 0.0,
                    "net_benefit": 0.0,
                    "delta_contribution": round(float(leg_qty * (leg.delta or 0.0)), 4),
                    "gamma_contribution": round(float(leg_qty * (leg.gamma or 0.0)), 6),
                    "vega_contribution": round(float(leg_qty * (leg.vega or 0.0)), 4),
                    "cost_usd": round(leg_cost, 2),
                })

        trades = self._aggregate_trade_legs(trades)

        # Keep at most max_trades "replacement" line items — ROLL_UNWIND trades
        # are a separate table entirely and always kept; BOX_NEUTRALIZER legs
        # (added below) are exempt too, since they exist specifically to clean
        # up whatever cash imbalance this truncation itself reopens. Ranked by
        # notional value (the same "Value ($)" the table shows) — a heuristic
        # top-N rather than a true cardinality-constrained re-solve of the LP,
        # simpler and fast at the cost of not being provably the best N trades.
        if max_trades is not None:
            roll_trades = [t for t in trades if t.get("strategy") == "ROLL_UNWIND"]
            other_trades = [t for t in trades if t.get("strategy") != "ROLL_UNWIND"]
            other_trades.sort(
                key=lambda t: abs(float(t.get("qty", 0) or 0)) * float(t.get("bs_price_usd", 0) or 0),
                reverse=True,
            )
            trades = roll_trades + other_trades[:int(max_trades)]

        lp_trades = [t for t in trades if t.get("strategy") != "ROLL_UNWIND"]
        total_notional = sum(abs(t.get("qty", 0)) * float(t.get("bs_price_usd", 0) or 0) for t in lp_trades)
        # NOTE: this is cash outlay (≈ premium ± penalty), NOT a transaction-cost
        # estimate — for new positions it's naturally close to 100% of notional.
        # The LP's own `trading_cost` printed above (bid-ask-based) is the right
        # figure for execution/transaction cost.
        print(f"=== Cash outlay estimate ===")
        print(f"  notional traded      : {total_notional:>14,.0f}")
        print(f"  estimated cash outlay: {total_cash_outlay:>14,.0f}  ({100*total_cash_outlay/max(total_notional,1):.2f}% of notional)")

        def _cash_by_counterparty(trade_list):
            by_cp: dict[str, dict] = {}
            for t in trade_list:
                if t.get("opt") not in ("C", "P"):
                    continue
                cp = t.get("counterparty", "")
                qty = float(t.get("qty", 0.0) or 0.0)
                price = float(t.get("bs_price_usd", 0.0) or 0.0)
                entry = by_cp.setdefault(cp, {"outlay": 0.0, "collection": 0.0})
                if qty > 0:
                    entry["outlay"] += qty * price
                elif qty < 0:
                    entry["collection"] += -qty * price
            return by_cp

        # Cash flow by counterparty — premium paid (buys) vs. collected (sells)
        # across every trade proposed so far, including forced/DTE rolls. Any
        # counterparty left with a large net imbalance gets a box spread sized
        # to neutralize it — box spreads are flat w.r.t. spot (put-call parity),
        # so this cleans up cash without touching the profile fit, unlike
        # raising cash_neutrality_factor (which competes with lam_factor/max_qty).
        # Needs its own ITM-inclusive candidate set: option_legs is OTM-only
        # (calls above spot, puts below), so calls/puts never share a strike
        # there and a box — which needs both at two different strikes — can
        # never form from it.
        if enable_box_neutralizer:
            box_candidate_legs = self._build_candidates(
                target_expiry=target_expiry, include_itm=True, counterparties=counterparties,
            )
            for cp, v in _cash_by_counterparty(trades).items():
                box_legs = self._build_box_cash_neutralizer_trades(
                    self.asset, cp, v["outlay"] - v["collection"], box_candidate_legs, target_expiry,
                    bid_ask_atm_pct=bid_ask_atm_pct, bid_ask_min_delta=bid_ask_min_delta,
                    bid_ask_vol_pts=bid_ask_vol_pts, box_fee_bps=box_fee_bps,
                )
                trades.extend(box_legs)
            trades = self._aggregate_trade_legs(trades)

        # Post-LP delta cleanup: the LP fits the WHOLE payoff curve shape, so it
        # only reaches for the perp itself when options can't do that job more
        # cheaply — a naked perp is a straight line across the ENTIRE spot
        # ladder (tail risk far beyond the money), so the LP avoids it even when
        # it's nearly free, as long as options can cover the same local
        # correction (see run_lp's own candidate universe — options are almost
        # always preferred). This step is orthogonal to that: independent of
        # what the LP just picked, check whether the resulting book's net
        # option delta (existing positions plus every option trade just
        # proposed) still sits within a band once offset by the current perp
        # holding, and if not, propose ONE additional perp trade — a cheap,
        # bounded, delta-only cleanup — to flatten it back to zero.
        if enable_delta_rehedge:
            rehedge_trade = self._build_delta_rehedge_trade(
                trades, roll_position_ids, delta_band=delta_band,
                perp_cost_bps=perp_cost_bps,
                unwind_discount=unwind_discount, new_position_penalty=new_position_penalty,
            )
            if rehedge_trade is not None:
                trades.append(rehedge_trade)
                trades = self._aggregate_trade_legs(trades)

        # This is the "does the desk need to wire cash, or does it self-fund"
        # figure to monitor; it should track the LP's own (continuous,
        # pre-rounding) cash_neutrality accounting closely, modulo any box
        # trades added above.
        cash_by_counterparty = _cash_by_counterparty(trades)

        # cost_usd is summed across ALL trades (not just C/P, unlike outlay/
        # collection above) so this breakdown always adds up to the same
        # total_cost_usd shown in the Summary tile — a future/perp leg has
        # zero vega so it naturally contributes zero cost anyway.
        cost_by_cp: dict[str, float] = {}
        for t in trades:
            cp = t.get("counterparty", "")
            cost_by_cp[cp] = cost_by_cp.get(cp, 0.0) + float(t.get("cost_usd", 0.0) or 0.0)

        print("=== Cash flow by counterparty ===")
        for cp, v in sorted(cash_by_counterparty.items()):
            net = v["outlay"] - v["collection"]
            print(f"  {cp:20s}  outlay={v['outlay']:>12,.0f}  collection={v['collection']:>12,.0f}  net={net:>+12,.0f}  cost={cost_by_cp.get(cp, 0.0):>12,.0f}")
        cash_by_counterparty = {
            cp: {"outlay": round(v["outlay"], 2), "collection": round(v["collection"], 2),
                 "net": round(v["outlay"] - v["collection"], 2),
                 "cost": round(cost_by_cp.get(cp, 0.0), 2)}
            for cp, v in cash_by_counterparty.items()
        }
        # A counterparty could have cost but no C/P outlay/collection — e.g. a
        # perp-only leg: real (bps-of-notional) cost, but _cash_by_counterparty
        # only tracks C/P premium, so keep this robust rather than silently
        # dropping such a counterparty's cost from the table.
        for cp, cost in cost_by_cp.items():
            if cp not in cash_by_counterparty:
                cash_by_counterparty[cp] = {"outlay": 0.0, "collection": 0.0, "net": 0.0, "cost": round(cost, 2)}

        premium_summary = self._trade_premium_summary(trades)
        roll_unwind_output = [t for t in trades if t.get("strategy") == "ROLL_UNWIND"]
        replacement_output = [t for t in trades if t.get("strategy") != "ROLL_UNWIND"]

        # Absolute (not relative-to-now) cost accounting for the final trade
        # list — see the "after_book_mtm" result field below for why this is
        # kept separate from the Before/After payoff curves.
        total_cost_usd = sum(float(t.get("cost_usd", 0.0) or 0.0) for t in trades)
        # Value of each new trade AT ENTRY (mirrors build_payoffs' own pnl_today):
        # for an option that's qty x bs_price_usd (the premium IS its value at
        # entry); for a perp (opt=="F") bs_price_usd is spot itself, not a
        # premium, and a perp is a zero-cost contract at entry — its real value
        # there is qty x (spot - entry strike), ~0 since entry IS today's spot.
        # Using bs_price_usd for a perp here would add its full notional
        # instead, wrongly inflating/deflating after_book_mtm below.
        pnl_today_final = sum(
            float(t.get("qty", 0.0) or 0.0) * (self.spot - float(t.get("strike", 0.0) or 0.0))
            if t.get("opt") == "F"
            else float(t.get("bs_price_usd", 0.0) or 0.0) * float(t.get("qty", 0.0) or 0.0)
            for t in trades
        )

        horizons = sorted(set(self.chart_horizons + [0, 90]))
        before_payoff_by_horizon, after_payoff_by_horizon, current_book_mtm = self.build_payoffs(
            horizons, spot_arr, trades,
        )

        # Anchor to the value AT the current spot, not a weighted average across
        # the whole ladder — a single global shift can't fix the wings without
        # reintroducing a mismatch at the money, which is the most heavily
        # weighted (and usually already best-fit) point.
        spot_idx0 = int(np.argmin(np.abs(spot_arr - self.spot)))
        fitted_payoff_cash_shift = float(adjusted_base_payoff[spot_idx0] - fitted_payoff[spot_idx0])
        fitted_payoff_comparable = fitted_payoff + fitted_payoff_cash_shift

        sum_weights = np.sum(spot_weights)
        weighted_fit_error_before = float(
            np.sum(spot_weights * (adjusted_base_payoff - target_interp) ** 2) / sum_weights
        )
        weighted_fit_error_after = float(
            np.sum(spot_weights * (fitted_payoff_comparable - target_interp) ** 2) / sum_weights
        )
        print(f"fit error ratio: {weighted_fit_error_after / max(weighted_fit_error_before, 1e-12):.3f}")

        if is_replay:
            spot = self.spot
            x = np.log(spot_arr / spot)

            spot_ticks = self.nice_spot_ticks(spot)
            spot_ticks = spot_ticks[(spot_ticks >= spot_arr.min()) & (spot_ticks <= spot_arr.max())]
            tick_positions = np.log(spot_ticks / spot)

            if spot >= 100:
                spot_tick_labels = [f"{s:,.0f}" for s in spot_ticks]
            elif spot >= 10:
                spot_tick_labels = [f"{s:,.1f}" for s in spot_ticks]
            elif spot >= 1:
                spot_tick_labels = [f"{s:,.2f}" for s in spot_ticks]
            else:
                spot_tick_labels = [f"{s:,.3f}" for s in spot_ticks]

            fig, axes = plt.subplots(3, 1, sharex=True)
            axes[0].plot(x, adjusted_base_payoff, label="Adjusted Base Payoff")
            axes[0].plot(x, target_interp, label="Target Payoff")
            axes[0].plot(x, fitted_payoff_comparable, label="Fitted Payoff, cash-adjusted")
            axes[0].axvline(0, color="gray", linestyle="--", linewidth=1)
            axes[0].legend()

            axes[1].plot(x, fitted_payoff_comparable - adjusted_base_payoff, label="Fitted - Adjusted Base")
            axes[1].axvline(0, color="gray", linestyle="--", linewidth=1)
            axes[1].legend()
            axes[1].set_xticks(tick_positions)
            axes[1].set_xticklabels(spot_tick_labels)

            axes[2].plot(x, spot_weights, label="Weights")
            axes[2].legend()
            # plt.show()

        # max_cp_loss_usd is a hard constraint, so the LP always reports a
        # number at or inside the cap — but "feasible" isn't the same as
        # "sensible": if the only way to hold that cap is pinning trades at
        # max_qty, the cap is effectively unenforceable at a realistic trade
        # size (raising max_qty would just let it keep "working" the same
        # degenerate way). Surface that rather than let a technically-ok
        # result look clean.
        cp_loss_cap_warnings = lp_result.get("cp_loss_cap_warnings", [])
        message = None
        if cp_loss_cap_warnings:
            message = (
                f"Max CP Loss cap is only being met by pinning trades at Max Qty for: "
                f"{', '.join(cp_loss_cap_warnings)}. The cap may be unrealistically tight for the "
                f"current Max Qty — consider raising Max Qty, loosening the cap, or treating this "
                f"result as non-executable at its stated size."
            )

        return {
            "status": "ok",
            "message": message,
            "asset": self.asset,
            "target_expiry": target_expiry,
            "optimizer_converged": True,
            "spot": round(float(self.spot), 2),
            "cash_shift": round(float(cash_shift), 2),
            "fitted_payoff_cash_shift": round(float(fitted_payoff_cash_shift), 2),
            "premium_summary": premium_summary,
            "net_premium_generated": premium_summary["net_premium_generated"],
            "cash_by_counterparty": cash_by_counterparty,
            # Worst-case P&L-from-today each counterparty is left with after
            # this run's trades, across the spot ladder — see max_cp_loss_usd.
            "cp_worst_case_stress": lp_result.get("cp_worst_case_stress", {}),
            # Worst NET position (P&L + posted collateral value, both at the
            # SAME stress spot) per counterparty — can peak at a different spot
            # than cp_worst_case_stress above, since native-asset collateral
            # moves with the same stress. Only populated for counterparties
            # with collateral data (see collateral_by_cp); always computed
            # when available, independent of enforce_collateral_cap.
            "cp_worst_case_net": lp_result.get("cp_worst_case_net", {}),
            "fit_error_before": round(weighted_fit_error_before, 2),
            "fit_error_after": round(weighted_fit_error_after, 2),
            "spot_ladder": spot_arr.tolist(),
            "chart_horizons": horizons,
            "target_payoff": np.round(target_interp, 2).tolist(),
            "before_payoff": np.round(adjusted_base_payoff, 2).tolist(),
            "after_payoff": np.round(fitted_payoff_comparable, 2).tolist(),
            "raw_after_payoff": np.round(fitted_payoff, 2).tolist(),
            "raw_before_payoff": np.round(base_payoff, 2).tolist(),
            "before": {"payoff_by_horizon": before_payoff_by_horizon},
            "after": {"payoff_by_horizon": after_payoff_by_horizon},
            "roll_unwind_trades": roll_unwind_output,
            "replacement_trades": replacement_output,
            "trades": trades,
            "candidates_evaluated": len(candidates),
            # Reference point the before/after P&L matrices are anchored to —
            # today's actual mark of the existing book, at the current spot.
            "current_book_mtm": round(float(current_book_mtm), 2),
            # Total assumed bid-ask transaction cost across every trade in
            # `trades` (also broken out per-row as "cost_usd"). Deliberately
            # NOT netted into the Before/After payoff curves — those are a
            # "P&L relative to right now" comparison, and a one-time cost
            # applied identically at every horizon cancels out of any such
            # relative curve by construction (verified). It belongs instead
            # in the absolute figure below.
            "total_cost_usd": round(total_cost_usd, 2),
            # Book's absolute MTM immediately after executing `trades`, net of
            # the assumed transaction cost — the real, cost-inclusive
            # counterpart to "current_book_mtm" (which is BEFORE any trades,
            # so cost doesn't apply there). = before + raw trade P&L − cost.
            "after_book_mtm": round(float(current_book_mtm) + pnl_today_final - total_cost_usd, 2),
        }


    def run(self,
                 lam_factor: float = 0.5,
                 target_expiry: str | None = None,
                 unwind_discount: float = 0.2,
                 new_position_penalty: float = 0.04,
                 is_replay: bool = False,
                 roll_dte_threshold: int | None = 7,
                 roll_itm_only: bool = False,
                 counterparties: list[str] | None = None,
                 asset: str | None = None,
                 forced_roll_ids: list[int] | None = None,
                 **_ignored,  # tolerate LP-only params (collateral tiering) from asdict(run_params)
            ):
        lam_factor *= self.spot/1000.0
        print(self.spot)
        if asset is not None:
            self.asset = asset.upper()
            if self.asset == "ETH":
                self.asset_precision = 0
            elif self.asset == "FIL":
                self.asset_precision = 2
            else:
                raise ValueError(f"Unsupported asset: {self.asset}")
        print(f"asset: {self.asset}")

        selected_counterparties = {
            c.strip()
            for c in (counterparties or [])
            if c and c.strip() and c.strip().upper() != "ALL"
        }
        if selected_counterparties:
            self.positions = [
                p for p in self.positions
                if getattr(p, "counterparty", "") in selected_counterparties
            ]

        print(lam_factor)
        print(target_expiry)
        print(unwind_discount)
        print(new_position_penalty)
        print(is_replay)
        print(f"roll_dte_threshold: {roll_dte_threshold}")
        print(self.spot)
        print(self.spot_ladder)
        # is_replay = (target_expiry is not None)#False
        # target_profile = shift_target_profile(load_target_profile(), self.spot)
        target_profile = build_parametric_target_profile(self.asset, spot_ladder=self.spot_ladder, current_spot=self.spot)

        held_positions = self.get_held_positions()
        roll_positions = self._get_roll_positions(
            roll_dte_threshold, roll_itm_only=roll_itm_only, counterparties=counterparties,
            forced_roll_ids=forced_roll_ids,
        )
        roll_position_ids = {id(p) for p in roll_positions}
        is_roll_mode = len(roll_positions) > 0
        
        print(f"roll positions: {len(roll_positions)}")
        roll_unwind_trades = self._build_roll_unwind_trades(self.asset, roll_positions)
        print(f"roll unwind trades: {len(roll_unwind_trades)}")

        option_legs = self._build_candidates(target_expiry=target_expiry, include_itm=is_roll_mode)
        spread_candidates = self._build_spread_candidates(option_legs, target_expiry=target_expiry)
        straddle_candidates = self._build_straddle_candidates(option_legs, target_expiry=target_expiry)
        iron_condor_candidates = self._build_iron_condor_candidates(option_legs, target_expiry=target_expiry)
        candidates = option_legs + spread_candidates + straddle_candidates# + iron_condor_candidates

        '''
        roll_replacement_trades = self._build_roll_replacement_trades(
            roll_positions=roll_positions,
            option_legs=option_legs,
            target_expiry=target_expiry,
        )

        roll_summary = self._build_roll_summary(
            roll_positions=roll_positions,
            roll_unwind_trades=roll_unwind_trades,
            roll_replacement_trades=roll_replacement_trades,
        )
        print(f"roll summary: {roll_summary}")
        print(f"roll replacement trades: {len(roll_replacement_trades)}")
        '''

        target_strikes = np.asarray(target_profile.index, dtype=float)
        target_payoff = np.asarray(target_profile["Payoff($)"], dtype=float)  # - 2000000

        spot_arr = np.array(self.spot_ladder, dtype=float)
        target_interp = np.interp(spot_arr, target_strikes, target_payoff)

        option_smile = self._build_option_smile()
        if target_expiry is not None and option_smile is not None:
            spot_weights = self._risk_neutral_spot_weights(
                spot_arr=spot_arr,
                option_smile=option_smile,
                target_expiry=target_expiry,
            )
        else:
            spot_weights = np.ones_like(spot_arr, dtype=float)

        base_payoff = np.zeros_like(spot_arr)
        cash_roll = 0.
        for p in self.positions:
            if id(p) in roll_position_ids:
                cash_roll += p.current_mtm
                continue

            bs_value = self.bs_value_for_position(spot_arr, p, option_smile=option_smile)
            if np.isnan(bs_value.sum()):
                continue
            base_payoff += bs_value

        #for trade in roll_replacement_trades:
        #    base_payoff += self._trade_value_curve(trade, spot_arr)
        raw_residual = target_interp - base_payoff
        cash_shift = float(np.sum(spot_weights * raw_residual) / np.sum(spot_weights))
        adjusted_base_payoff = base_payoff + cash_shift
        residual = target_interp - adjusted_base_payoff

        # Normalize improvement to something comparable to dollars, keeps huge target curves from drowning the cost signal.
        payoff_scale = max(float(np.mean(np.abs(target_interp))), 1.0)

        c_vega = np.array([abs(self._candidate_vega(c)) for c in candidates], dtype=float)
        if np.all(c_vega == 0.0):
            vega_weight = np.ones_like(c_vega)
        else:
            vega_weight = c_vega / np.max(c_vega)

        min_weight = 0.2
        strike_weights = np.maximum(vega_weight, min_weight)
        lams = 0.01 * np.ones(len(candidates))
        base_lam = lam_factor
        print(f"base_lam: {base_lam}")

        A_cols = []
        meta = []

        max_vega = max(float(c_vega.max()), 1e-12)

        # Filter smiles
        matching_smiles = []
        for smile in self.vol_surface:
            if smile["dte"] <= 0:
                continue
            if target_expiry:
                if smile["expiry_code"] == target_expiry:
                    matching_smiles.append(smile)
            else:
                # ALL-expiries mode: only include expiries where we currently hold positions
                if True:  # smile["expiry_code"] in held_expiry_codes:
                    matching_smiles.append(smile)

        option_smile = OptionSmile(
                [
                    {
                        "expiry_code": smile["expiry_code"],
                        "expiry_date": smile["expiry_date"],
                        "strikes": smile["strikes"],
                        "ivs": [iv / 100.0 for iv in smile["ivs"]],
                    }
                    for smile in matching_smiles
                ],
                today=self.today,
            )

        curves = []
        for i, c in enumerate(candidates):
            if not self._is_structured_candidate(c) and c.opt not in ("C", "P", "F"):
                lams[i] = 1.E10
                continue

            candidate_vega = max(abs(self._candidate_vega(c)), 1e-12)
            lams[i] = base_lam * np.pow(max_vega / candidate_vega, 2)
            if self._is_spread_candidate(c):
                lams[i] *= 1.
            elif self._is_straddle_candidate(c):
                lams[i] *= 1.5
            elif self._is_iron_condor_candidate(c):
                lams[i] *= 2.0
            else:
                strike = float(getattr(c, "strike", 0.0) or 0.0)
                opt = str(getattr(c, "opt", "") or "")
                is_itm = (opt == "C" and strike < self.spot) or (opt == "P" and strike > self.spot)
                if is_itm:
                    lams[i] *= 2.0

            curve = self._candidate_curve(c=c, spot_arr=spot_arr, option_smile=option_smile)
            curves.append(curve)
            weighted_curve = strike_weights[i] * curve
            A_cols.append(curve)#weighted_curve)
            meta.append(c)

        if not A_cols:
            return {"status": "no_fit_candidates", "message": "No candidates available for payoff fitting."}

        A = np.column_stack(A_cols)
        lasso = GeneralizedLasso()
        lasso.fit(A, residual*1.E-6, lams, w=spot_weights)
        betas_lasso = lasso.betas * 1.E6
        err_fit_lasso = lasso.err_fit

        x = betas_lasso
        #fitted_payoff = adjusted_base_payoff + A @ x

        sum_weights = np.sum(spot_weights)
        base_rmse = float(np.sqrt(np.sum(spot_weights*np.pow(adjusted_base_payoff - target_interp, 2))/sum_weights))
        scored_trades = []

        i = -1
        for qty, c, w in zip(x, meta, strike_weights[: len(meta)]):
            i += 1
            rounded_qty = int(np.round(qty))
            if rounded_qty == 0:
                continue

            est_cost = self._estimate_candidate_cash_outlay(
                c=c,
                qty=rounded_qty,
                held_positions=held_positions,
                unwind_discount=unwind_discount,
                new_position_penalty=new_position_penalty,
            )

            instrument_name = self._candidate_instrument_name(c)

            curve = rounded_qty * curves[i]
            new_payoff = adjusted_base_payoff + curve
            new_rmse = float(np.sqrt(np.sum(spot_weights*np.pow(new_payoff - target_interp, 2)/sum_weights)))

            rmse_improvement = base_rmse - new_rmse
            normalized_benefit = rmse_improvement * payoff_scale * abs(rounded_qty)

            net_benefit = normalized_benefit - est_cost
            base_rmse = new_rmse
            scored_trades.append((net_benefit, normalized_benefit, est_cost, rounded_qty, c, w, curve, instrument_name))

        scored_trades.sort(key=lambda t: t[0], reverse=True)

        trades = list(roll_unwind_trades) #+ list(roll_replacement_trades)
        roll_unwind_output = [t for t in trades if t.get("strategy") == "ROLL_UNWIND"]
        replacement_output = [t for t in trades if t.get("strategy") != "ROLL_UNWIND"]
        fitted_payoff = adjusted_base_payoff.copy()

        horizons = sorted(set(self.chart_horizons + [0, 90]))

        if not scored_trades:
            box_neutralizer_trades = self._build_box_premium_neutralizer_trades(
                token=self.asset,
                trades=trades,
                option_legs=option_legs,
                target_expiry=target_expiry,
            )
            trades.extend(box_neutralizer_trades)

            adjusted_after_payoff = adjusted_base_payoff.copy()
            for trade in box_neutralizer_trades:
                adjusted_after_payoff += self._trade_value_curve(trade, spot_arr)

            trades = self._aggregate_trade_legs(trades)
            premium_summary = self._trade_premium_summary(trades)
            before_payoff_by_horizon, after_payoff_by_horizon, _ = self.build_payoffs(
                horizons,
                spot_arr,
                trades,
            )

            return {
                "status": "ok",
                "asset": self.asset,
                "target_expiry": target_expiry,
                "optimizer_converged": True,
                "spot": round(float(self.spot), 2),
                "cash_shift": round(float(cash_shift), 2),
                "premium_summary": premium_summary,
                "net_premium_generated": premium_summary["net_premium_generated"],
                "spot_ladder": spot_arr.tolist(),
                "chart_horizons": horizons,
                "target_payoff": np.round(target_interp, 2).tolist(),
                "before_payoff": np.round(adjusted_base_payoff, 2).tolist(),
                "after_payoff": np.round(adjusted_base_payoff, 2).tolist(),
                "raw_before_payoff": np.round(base_payoff, 2).tolist(),
                "before": {
                    "payoff_by_horizon": before_payoff_by_horizon,
                },
                "after": {
                    "payoff_by_horizon": after_payoff_by_horizon,
                },
                "roll_unwind_trades": roll_unwind_output,
                "replacement_trades": replacement_output,
                "trades": trades,
                "candidates_evaluated": len(meta),
            }

        total_cost = sum(est_cost for _, _, est_cost, _, _, _, _, _ in scored_trades)
        for net_benefit, normalized_benefit, est_cost, rounded_qty, c, w, curve, instrument_name in scored_trades:
            fitted_payoff += curve

            for leg, leg_qty, strategy in self._candidate_trade_legs(c, rounded_qty):
                leg_instrument_name = (
                    f"{self.asset}-PERPETUAL" if leg.opt == "F"
                    else f"{self.asset}-{leg.expiry_code}-{np.round(leg.strike, self.asset_precision)}-{leg.opt}"
                )

                trades.append({
                    "counterparty": leg.counterparty,
                    "instrument": leg_instrument_name,
                    "strategy": strategy,
                    "strategy_instrument": instrument_name,
                    "expiry": leg.expiry_date,
                    "dte": leg.dte,
                    "strike": leg.strike,
                    "opt": leg.opt,
                    "qty": leg_qty,
                    "side": "Buy" if leg_qty > 0 else "Sell",
                    "iv_pct": round(float(leg.iv_pct or 0.0), 1),
                    "bs_price_usd": round(float(leg.bs_price_usd or 0.0), 2),
                    "vega": round(float(leg.vega or 0.0), 4),
                    "notional": round(abs(float(leg_qty)) * float(leg.bs_price_usd or 0.0), 2),
                    "is_unwind": False,
                    "unwind_qty": 0,
                    "new_qty": abs(int(leg_qty)),
                    "strike_weight": round(float(w), 4),
                    "estimated_cash_outlay": round(float(est_cost), 2),
                    "normalized_benefit": round(float(normalized_benefit), 2),
                    "net_benefit": round(float(net_benefit), 2),
                    "delta_contribution": round(float(leg_qty * (leg.delta or 0.0)), 4),
                    "gamma_contribution": round(float(leg_qty * (leg.gamma or 0.0)), 6),
                    "vega_contribution": round(float(leg_qty * (leg.vega or 0.0)), 4),
                })

        box_neutralizer_trades = self._build_box_premium_neutralizer_trades(
            token=self.asset,
            trades=trades,
            option_legs=option_legs,
            target_expiry=target_expiry,
        )
        trades.extend(box_neutralizer_trades)
        for trade in box_neutralizer_trades:
            fitted_payoff += self._trade_value_curve(trade, spot_arr)

        # Anchor to the value AT the current spot, not a weighted average across
        # the whole ladder — a single global shift can't fix the wings without
        # reintroducing a mismatch at the money, which is the most heavily
        # weighted (and usually already best-fit) point.
        spot_idx0 = int(np.argmin(np.abs(spot_arr - self.spot)))
        fitted_payoff_cash_shift = float(adjusted_base_payoff[spot_idx0] - fitted_payoff[spot_idx0])
        fitted_payoff_comparable = fitted_payoff + fitted_payoff_cash_shift

        print("is_replay:" + str(is_replay))
        if is_replay:
            spot = self.spot  # or your reference spot S0
            x = np.log(spot_arr / spot)

            spot_ticks = self.nice_spot_ticks(spot)
            spot_ticks = spot_ticks[(spot_ticks >= spot_arr.min()) & (spot_ticks <= spot_arr.max())]
            tick_positions = np.log(spot_ticks / spot)

            if spot >= 100:
                spot_tick_labels = [f"{s:,.0f}" for s in spot_ticks]
            elif spot >= 10:
                spot_tick_labels = [f"{s:,.1f}" for s in spot_ticks]
            elif spot >= 1:
                spot_tick_labels = [f"{s:,.2f}" for s in spot_ticks]
            else:
                spot_tick_labels = [f"{s:,.3f}" for s in spot_ticks]

            fig, axes = plt.subplots(3, 1, sharex=True)

            # axes[0].plot(x, base_payoff, label="
            axes[0].plot(x, adjusted_base_payoff, label="Adjusted Base Payoff")
            axes[0].plot(x, target_interp, label="Target Payoff")
            axes[0].plot(x, fitted_payoff_comparable, label="Fitted Payoff, cash-adjusted")
            axes[0].axvline(0, color="gray", linestyle="--", linewidth=1)
            axes[0].legend()

            axes[1].plot(
                x,
                fitted_payoff_comparable - adjusted_base_payoff,
                label="Fitted - Adjusted Base, cash-adjusted",
            )
            axes[1].axvline(0, color="gray", linestyle="--", linewidth=1)
            axes[1].set_xlabel("Spot")
            # axes[1].set_ylim(210000, 215000)
            axes[1].legend()
            axes[1].set_xticks(tick_positions)
            axes[1].set_xticklabels(spot_tick_labels)

            axes[2].plot(x, spot_weights, label="Weights")
            axes[2].legend()
            plt.show()

        trades = self._aggregate_trade_legs(trades)
        premium_summary = self._trade_premium_summary(trades)
        roll_unwind_output = [
            trade for trade in trades
            if trade.get("strategy") == "ROLL_UNWIND"
        ]
        replacement_output = [
            trade for trade in trades
            if trade.get("strategy") != "ROLL_UNWIND"
        ]

        before_payoff_by_horizon, after_payoff_by_horizon, _ = self.build_payoffs(
            horizons,
            spot_arr,
            trades,
        )

        print(f"selected structures: {len(scored_trades)}")
        print(f"trade legs emitted: {len(trades)}")

        for trade in trades:
            print(
                trade.get("strategy", "NA"),
                trade.get("strategy_instrument", ""),
                trade["instrument"],
                trade["qty"],
            )

        weighted_fit_error_before = float(
            np.sum(spot_weights * (adjusted_base_payoff - target_interp) ** 2) / np.sum(spot_weights)
        )
        weighted_fit_error_after = float(
            np.sum(spot_weights * (fitted_payoff_comparable - target_interp) ** 2) / np.sum(spot_weights)
        )

        print("ratio: " + str(weighted_fit_error_after/weighted_fit_error_before))

        return {
            "status": "ok",
            "asset": self.asset,
            "target_expiry": target_expiry,
            "optimizer_converged": True,
            "spot": round(float(self.spot), 2),
            "cash_shift": round(float(cash_shift), 2),
            "fitted_payoff_cash_shift": round(float(fitted_payoff_cash_shift), 2),
            "premium_summary": premium_summary,
            "net_premium_generated": premium_summary["net_premium_generated"],
            "fit_error_after": round(weighted_fit_error_after, 2),
            "fit_error_before": round(float(np.mean((adjusted_base_payoff - target_interp) ** 2)), 2),
            "spot_ladder": spot_arr.tolist(),
            "chart_horizons": horizons,
            "target_payoff": np.round(target_interp, 2).tolist(),
            "before_payoff": np.round(adjusted_base_payoff, 2).tolist(),
            "after_payoff": np.round(fitted_payoff_comparable, 2).tolist(),
            "raw_after_payoff": np.round(fitted_payoff, 2).tolist(),
            "raw_before_payoff": np.round(base_payoff, 2).tolist(),
            "before": {
                "payoff_by_horizon": before_payoff_by_horizon,
            },
            "after": {
                "payoff_by_horizon": after_payoff_by_horizon,
            },
            "roll_unwind_trades": roll_unwind_output,
            "replacement_trades": replacement_output,
            "trades": trades,
            "candidates_evaluated": len(meta),
        }

    def run_previous(self,
                     risk_aversion: float = 1.0,
                     brokerage_txn_cost_pct: float = 5.0,
                     deribit_txn_cost_pct: float = 0.1,
                     max_collateral: float = 4_000_000.0,
                     target_expiry: str | None = None,
                     lambda_delta: float = 1.0,
                     lambda_gamma: float = 1.0,
                     lambda_vega: float = 1.0,
                     unwind_discount: float = 0.2,
                     new_position_penalty: float = 0.04,
                     vega_cross_expiry_corr: float = 0.0, ):

        # Liquidate all existing positions (outside of the target expiry range?)
        held_positions = self.get_held_positions()
        candidates = self._build_candidates(target_expiry=None)

        # Build a quick lookup for candidate quotes by (expiry_code, strike, opt, counterparty)
        candidate_by_key = {(c.expiry_code, c.strike, c.opt, c.counterparty): c for c in candidates}
        trades = []
        unwind_discount = 1.

        x = np.array([0.0] * len(candidates))
        i = -1
        for c in candidates:  # (exp_code, strike_i, opt_i, counterparty_i), held_qty in held_positions.items():
            i += 1
            held_qty = held_positions.get((c.expiry_code, c.strike, c.opt, c.counterparty), 0)
            if held_qty == 0:
                continue
            # candidate = candidate_by_key.get((exp_code, strike_i, opt_i, counterparty_i))  # matching candidate quote if exists
            # Fallbacks if the instrument is not in candidates
            price_i = float(c.bs_price_usd) if c and c.bs_price_usd is not None else 0.0
            dte_i = int(c.dte) if c and c.dte is not None else 0
            cost_rate = float(self.compute_costs(
                self.spot, [c] if c else [], perp_cost_bps=2.0, brokerage_txn_cost_pct=0.5,
                deribit_txn_cost_pct=0.1,
            )[0]) if c else 0.0

            if dte_i > 10:
                continue
            instrument_name = ("ETH-PERPETUAL" if c.opt == "F" else f"ETH-{c.expiry_code}-{int(c.strike)}-{c.opt}")

            # Close the full held quantity: long position  -> sell to unwind, short position -> buy to unwind
            unwind_signed = -int(round(held_qty))
            unwind_qty = abs(unwind_signed)
            unwind_notional = unwind_qty * price_i
            cost_unwind_part = cost_rate * unwind_discount * unwind_notional
            x[i] = unwind_signed

            trades.append({
                "counterparty": c.counterparty, "instrument": instrument_name, "expiry": c.expiry_date if c else "",
                "dte": c.dte if c else 0, "strike": c.strike if c else 0.0, "opt": c.opt, "qty": unwind_signed,
                "side": "Buy" if unwind_signed > 0 else "Sell", "iv_pct": round(c.iv_pct, 1),
                "bs_price_usd": round(c.bs_price_usd, 2), "notional": round(unwind_notional, 2),
                "cost_bps": round(cost_rate * 10_000, 1), "trade_cost": round(cost_unwind_part, 2),
                "delta_contribution": round(unwind_signed * float(c.delta), 4),
                "gamma_contribution": round(unwind_signed * float(c.gamma), 6),
                "vega_contribution": round(unwind_signed * c.vega, 4),
                "is_unwind": True, "unwind_qty": unwind_qty, "new_qty": 0,
            })

        port_delta, port_gamma, port_theta, port_vega = self._portfolio_greeks()
        port_vega_by_expiry = self._portfolio_vega_by_expiry()

        perp_candidate = candidates[-1]  # candidate_by_key[('PERP', 2210, 'F', 'Deribit')]
        print(lambda_delta)
        print(lambda_gamma)
        perp_trade = self.add_perp_hedge(perp_candidate, lambda_delta)
        perp_trade['notional'] = perp_trade['qty'] * perp_candidate.strike
        x[-1] += perp_trade['qty']
        trades.append(perp_trade)

        qty = 1000. * lambda_gamma
        call_to_put_ratio = lambda_vega
        condor_trades, x = self.solve_condor(qty, candidate_by_key, x, call_to_put_ratio)
        for trade in condor_trades:
            trades.append(trade)
            expiry_code = get_expiry_code(trade['expiry'])
            trade_key = (expiry_code, trade['strike'], trade['opt'], trade['counterparty'])
            i = list(candidate_by_key.keys()).index(trade_key)
            x[i] += trade['qty']
        # trades = []

        new_delta, new_gamma, new_theta, new_vega, new_vega_by_expiry = (
            self.compute_greeks(x, candidates, port_delta, port_gamma, port_theta, port_vega, port_vega_by_expiry))

        print(port_delta)
        print(new_delta)
        print(port_gamma)
        print(new_gamma)

        spot = self.spot
        # Market parameters
        # ATM IV for daily spot vol
        atm_ivs = []
        for smile in self.vol_surface:
            if smile["dte"] <= 0:
                continue
            strikes = smile["strikes"]
            ivs = smile["ivs"]
            best_idx = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
            atm_ivs.append(ivs[best_idx])
        atm_iv = float(np.mean(atm_ivs)) / 100.0 if atm_ivs else 0.80
        sigma_daily = atm_iv / math.sqrt(252)
        vov_daily = self._estimate_vol_of_vol_daily()  # Vol-of-vol

        # Current portfolio risk (before optimization)
        expiry_codes = sorted({c.expiry_code for c in candidates if c.expiry_code != "PERP"})
        c_vega_by_expiry = {
            exp_code: np.array([c.vega if c.expiry_code == exp_code else 0.0 for c in candidates])
            for exp_code in expiry_codes
        }

        new_port_vega_by_expiry = {exp_code: port_vega_by_expiry.get(exp_code, 0.0) for exp_code in expiry_codes}

        risk_before = self._compute_risk(port_delta, port_gamma, port_theta, port_vega, sigma_daily, vov_daily,
                                         lambda_delta, lambda_gamma, lambda_vega,
                                         port_vega_by_expiry=new_port_vega_by_expiry,
                                         vega_cross_expiry_corr=vega_cross_expiry_corr, risk_mode=RiskMode.GAMMA_VEGA)

        risk_after = self._compute_risk(
            new_delta, new_gamma, new_theta, new_vega,
            sigma_daily, vov_daily, lambda_delta, lambda_gamma, lambda_vega,
            port_vega_by_expiry=new_vega_by_expiry,
            vega_cross_expiry_corr=vega_cross_expiry_corr, risk_mode=RiskMode.GAMMA_VEGA,
        )

        total_cost = sum(t["trade_cost"] for t in trades)

        # ------------------------------------------------------------------
        # Compute before/after payoff curves and P&L matrix
        # ------------------------------------------------------------------
        spot_arr = np.array(self.spot_ladder, dtype=float)
        horizons = sorted(set(self.chart_horizons + [0]))
        before_payoff, after_payoff, _ = self.build_payoffs(horizons, spot_arr, trades)

        return {
            "status": "ok",
            "snapshot_path": str(self.snapshot_path),
            "spot": spot,
            "spot_ladder": self.spot_ladder,
            "chart_horizons": horizons,
            "params": {
                "risk_aversion": risk_aversion,
                "brokerage_txn_cost_pct": brokerage_txn_cost_pct,
                "deribit_txn_cost_pct": deribit_txn_cost_pct,
                "max_collateral": max_collateral,
                "atm_iv_pct": round(atm_iv * 100, 1),
                "sigma_daily": round(sigma_daily, 4),
                "vov_daily": round(vov_daily, 2),
                "vega_cross_expiry_corr": round(vega_cross_expiry_corr, 2),
                "lambda_delta": lambda_delta,
                "lambda_gamma": lambda_gamma,
                "lambda_vega": lambda_vega,
            },
            "before": {
                "delta": round(port_delta, 2),
                "gamma": round(port_gamma, 4),
                "theta": round(port_theta, 2),
                "vega": round(port_vega, 2),
                "daily_risk": round(risk_before, 2),
                "payoff_by_horizon": before_payoff,
            },
            "after": {
                "delta": round(new_delta, 2),
                "gamma": round(new_gamma, 4),
                "theta": round(new_theta, 2),
                "vega": round(new_vega, 2),
                "daily_risk": round(risk_after, 2),
                "payoff_by_horizon": after_payoff,
            },
            "trades": trades,
            "total_trade_cost": round(total_cost, 2),
            "utility_improvement": round(risk_before - risk_after - total_cost, 2),
            "candidates_evaluated": len(candidates),
            "optimizer_converged": True,
        }

    @staticmethod
    def compute_greeks(x, candidates, port_delta, port_gamma, port_theta, port_vega, port_vega_by_expiry):
        new_delta = port_delta + np.dot(x, np.array([c.delta for c in candidates]))
        new_gamma = port_gamma + np.dot(x, np.array([c.gamma for c in candidates]))
        new_theta = port_theta + np.dot(x, np.array([c.theta for c in candidates]))
        new_vega = port_vega + np.dot(x, np.array([c.vega for c in candidates]))

        expiry_codes = sorted({c.expiry_code for c in candidates if c.expiry_code != "PERP"})
        c_vega_by_expiry = {
            exp_code: np.array([c.vega if c.expiry_code == exp_code else 0.0 for c in candidates])
            for exp_code in expiry_codes
        }

        for exp_code in c_vega_by_expiry.keys():
            # c_vega_by_expiry[exp_code] = np.sum(c_vega_by_expiry[exp_code], axis=0)
            diff = np.sum(np.dot(x, c_vega_by_expiry[exp_code]))
            k = 1

        new_vega_by_expiry = {
            exp_code: port_vega_by_expiry.get(exp_code, 0.0) + np.dot(x, c_vega_by_expiry[exp_code])
            for exp_code in c_vega_by_expiry.keys()
        }

        return new_delta, new_gamma, new_theta, new_vega, new_vega_by_expiry

    def extract_trades(self, x, candidates, c_dte, c_strike, c_iv_pct, c_price, c_delta, c_gamma, c_theta, c_vega,
                       c_held_qty, unwind_discount, new_position_penalty, strike_weight, c_cost_rate):
        trades = []
        for i, qty in enumerate(x):  # Extract proposed trades (filter out tiny quantities)
            if abs(qty) < 0.5:
                continue
            c = candidates[i]
            rounded_qty = round(qty)
            if rounded_qty == 0:
                continue
            cost_rate = float(c_cost_rate[i])

            # Determine if this is an unwind or new position, and cap unwind qty to the actual held position size
            held_qty = c_held_qty[i]
            is_unwind = bool((rounded_qty * held_qty) < 0)
            unwind_qty = min(abs(rounded_qty), abs(held_qty)) if is_unwind else 0
            new_qty = abs(rounded_qty) - unwind_qty

            # Compute cost split: unwind portion at discounted rate, remainder at full rate
            price_i = float(c_price[i])
            iv_pct_i = float(c_iv_pct[i])
            strike_i = float(c_strike[i])
            dte_i = int(c_dte[i])
            delta_i = float(c_delta[i] / strike_weight[i]) if strike_weight[i] != 0 else 0.0
            gamma_i = float(c_gamma[i] / strike_weight[i]) if strike_weight[i] != 0 else 0.0
            vega_i = float(c_vega[i] / strike_weight[i]) if strike_weight[i] != 0 else 0.0

            unwind_notional = unwind_qty * price_i
            new_notional = new_qty * price_i
            is_new_instrument = abs(held_qty) == 0
            cost_unwind_part = cost_rate * unwind_discount * unwind_notional
            cost_new_part = (cost_rate + (new_position_penalty if is_new_instrument else 0.0)) * new_notional

            instrument_name = ("ETH-PERPETUAL" if c.opt == "F" else f"ETH-{c.expiry_code}-{int(strike_i)}-{c.opt}")

            if unwind_qty >= 1:  # Emit separate rows for unwind vs new-position portions
                unwind_signed = int(unwind_qty) * (1 if rounded_qty > 0 else -1)
                trades.append({"counterparty": c.counterparty, "instrument": instrument_name, "expiry": c.expiry_date,
                               "dte": dte_i, "strike": strike_i, "opt": c.opt, "qty": unwind_signed,
                               "side": "Buy" if unwind_signed > 0 else "Sell", "iv_pct": round(iv_pct_i, 1),
                               "bs_price_usd": round(price_i, 2), "notional": round(unwind_notional, 2),
                               "cost_bps": round(cost_rate * 10_000, 1), "trade_cost": round(cost_unwind_part, 2),
                               "delta_contribution": round(unwind_signed * delta_i, 4),
                               "gamma_contribution": round(unwind_signed * gamma_i, 6),
                               "vega_contribution": round(unwind_signed * vega_i, 4),
                               "is_unwind": True, "unwind_qty": int(unwind_qty), "new_qty": 0})

            if new_qty >= 1:
                new_signed = int(new_qty) * (1 if rounded_qty > 0 else -1)
                trades.append({"counterparty": c.counterparty, "instrument": instrument_name, "expiry": c.expiry_date,
                               "dte": dte_i, "strike": strike_i, "opt": c.opt, "qty": new_signed,
                               "side": "Buy" if new_signed > 0 else "Sell", "iv_pct": round(iv_pct_i, 1),
                               "bs_price_usd": round(price_i, 2), "notional": round(new_notional, 2),
                               "cost_bps": round(cost_rate * 10_000, 1), "trade_cost": round(cost_new_part, 2),
                               "delta_contribution": round(new_signed * delta_i, 4),
                               "gamma_contribution": round(new_signed * gamma_i, 6),
                               "vega_contribution": round(new_signed * vega_i, 4),
                               "is_unwind": False, "unwind_qty": 0, "new_qty": int(new_qty)})
        return trades

    def build_payoffs(self, horizons, spot_arr, trades):
        # Always compute horizon 0 internally (even if the caller didn't ask
        # for it) — it's the reference point both curves get anchored to below.
        all_horizons = sorted(set(horizons) | {0})

        # Populate per-position payoff curves first
        for p in self.positions:
            p.payoff_by_horizon = {}

            # You can infer these from your position object / instrument string
            # Adjust the field names here if your Position model differs.
            strike = float(getattr(p, "strike", 0.0) or 0.0)
            opt = str(getattr(p, "opt", "") or "")
            iv_pct = float(getattr(p, "iv_pct", 0.0) or 0.0)
            dte = int(getattr(p, "days_remaining", 0) or 0)

            # net_qty is already signed (negative=Short, positive=Long) — no side flip needed.
            signed_qty = float(getattr(p, "net_qty", 0.0) or 0.0)

            for h in all_horizons:
                h_key = str(h)

                if opt == "F":
                    # Perpetual / future: linear mark-to-market
                    curve = signed_qty * (spot_arr - strike)
                else:
                    # Option curve at horizon h
                    dte_at_h = max(dte - h, 0)
                    T_h = dte_at_h / 365.25
                    sigma = iv_pct / 100.0
                    curve = signed_qty * bs_vec(spot_arr, strike, T_h, 0.0, sigma, opt)

                p.payoff_by_horizon[h_key] = np.round(curve, 2).tolist()

        # Before payoff: aggregate from existing positions (raw value at T+h)
        before_payoff = {}
        for h in all_horizons:
            h_key = str(h)
            total = np.zeros(len(spot_arr))
            for p in self.positions:
                curve = p.payoff_by_horizon.get(h_key)
                if curve:
                    total += np.array(curve)
            before_payoff[h_key] = np.round(total, 2).tolist()

        # Trade payoff contribution: for each proposed trade, compute BS value
        # across the spot ladder at each horizon. Raw value (no premium netted
        # out here) — netting is applied uniformly below via the "today" anchor
        # instead, so both curves get the same treatment.
        trade_payoff_delta = {}
        for h in all_horizons:
            h_key = str(h)
            total = np.zeros(len(spot_arr))
            for trade in trades:
                if trade["opt"] == "F":
                    # Perpetual future: value = qty * (spot - entry)
                    vals = spot_arr - trade["strike"]
                else:
                    dte_at_h = max(trade["dte"] - h, 0)
                    T_h = dte_at_h / 365.25
                    sigma = trade["iv_pct"] / 100.0
                    vals = bs_vec(spot_arr, trade["strike"], T_h, 0.0, sigma, trade["opt"])
                total += trade["qty"] * vals
            trade_payoff_delta[h_key] = np.round(total, 2).tolist()

        # Anchor both curves to today's actual mark, converting "raw value at
        # T+h" into "P&L from today to T+h" — the fair comparison we can make
        # without each position's historical entry premium (which we don't
        # have): "before" nets out today's mark of the existing book; "after"
        # additionally nets out the (known) premium paid/received for the
        # proposed trades today, so both curves read 0 at (h=0, current spot).
        # Interpolated rather than snapped to the nearest ladder point — ETH's
        # ladder is rounded to whole dollars for display, so the live spot is
        # essentially never exactly on it; interpolation error shrinks with the
        # square of the gap, vs. linearly for nearest-point snapping.
        today_value_before = float(np.interp(self.spot, spot_arr, before_payoff["0"]))
        # bs_price_usd IS the raw curve's value at today's spot for an option
        # (same S/K/T/sigma used to price it), so netting qty x bs_price_usd
        # cancels the trade curve's own contribution there — but for a perp
        # (opt=="F"), bs_price_usd is spot itself (see BaseOptimizer's
        # create_candidate / PERP_COUNTERPARTY handling), not a premium; its
        # raw curve value at today's spot is qty x (spot - entry), which is
        # ~0 since entry IS today's spot. Using bs_price_usd there instead
        # would net out qty x spot — an extra, spurious shift of the entire
        # "after" curve by the trade's full notional.
        pnl_today = sum(
            trade["qty"] * (self.spot - trade["strike"]) if trade["opt"] == "F"
            else trade["qty"] * trade["bs_price_usd"]
            for trade in trades
        )
        # NOTE: deliberately NOT netting transaction cost into this anchor.
        # cost_usd is a one-time, permanent hit applied identically at every
        # horizon (paid once at execution, never repeated) — so it cancels
        # out of a "P&L relative to right now" curve by construction: shifting
        # both the h=0 reference point and every future point by the same
        # constant leaves their difference unchanged. Verified: after[0](spot)
        # must stay exactly 0 (the curve's own defining invariant); folding
        # cost in here previously broke that into a spurious +cost bump
        # instead. Cost belongs in an ABSOLUTE figure instead — see
        # "after_book_mtm" in run_lp's result, computed from this same
        # pnl_today alongside total_cost_usd.
        today_value_after = today_value_before + pnl_today

        after_payoff_raw = {
            h_key: (np.array(before_payoff[h_key]) + np.array(trade_payoff_delta[h_key])).tolist()
            for h_key in before_payoff
        }

        before_payoff = {
            h_key: np.round(np.array(curve) - today_value_before, 2).tolist()
            for h_key, curve in before_payoff.items()
            if int(h_key) in horizons
        }
        after_payoff = {
            h_key: np.round(np.array(curve) - today_value_after, 2).tolist()
            for h_key, curve in after_payoff_raw.items()
            if int(h_key) in horizons
        }
        return before_payoff, after_payoff, today_value_before

    def add_perp_hedge(self, perp_candidate, qty):
        c = perp_candidate
        instrument_name = ("ETH-PERPETUAL" if c.opt == "F" else f"ETH-{c.expiry_code}-{int(c.strike)}-{c.opt}")
        cost_rate = 5. / 10000.

        # Close the full held quantity: long position  -> sell to unwind, short position -> buy to unwind
        unwind_signed = qty  # * condor_mults[k]  # -int(round(held_qty))
        unwind_qty = abs(unwind_signed)
        unwind_notional = unwind_qty * 0
        cost_unwind_part = cost_rate * 0 * unwind_notional

        trade = {
            "counterparty": c.counterparty, "instrument": instrument_name, "expiry": c.expiry_date if c else "",
            "dte": c.dte if c else 0, "strike": c.strike if c else 0.0, "opt": c.opt, "qty": unwind_signed,
            "side": "Buy" if unwind_signed > 0 else "Sell", "iv_pct": round(c.iv_pct, 1),
            "bs_price_usd": round(c.bs_price_usd, 2), "notional": round(unwind_notional, 2),
            "cost_bps": round(cost_rate * 10_000, 1), "trade_cost": round(cost_unwind_part, 2),
            "delta_contribution": round(unwind_signed * float(c.delta), 4),
            "gamma_contribution": round(unwind_signed * float(c.gamma), 6),
            "vega_contribution": round(unwind_signed * c.vega, 4),
            "is_unwind": True, "unwind_qty": unwind_qty, "new_qty": 0,
        }
        return trade

    def _is_spread_candidate(self, c) -> bool:
        return hasattr(c, "long_leg") and hasattr(c, "short_leg")

    def _is_straddle_candidate(self, c) -> bool:
        return hasattr(c, "call_leg") and hasattr(c, "put_leg")

    def _is_iron_condor_candidate(self, c) -> bool:
        return (
            hasattr(c, "put_low_leg")
            and hasattr(c, "put_high_leg")
            and hasattr(c, "call_low_leg")
            and hasattr(c, "call_high_leg")
        )

    def _is_structured_candidate(self, c) -> bool:
        return self._is_spread_candidate(c) or self._is_straddle_candidate(c) or self._is_iron_condor_candidate(c)

    def _candidate_vega(self, c) -> float:
        if self._is_spread_candidate(c):
            return float(c.vega or 0.0)
        return float(getattr(c, "vega", 0.0) or 0.0)

    def _candidate_delta(self, c) -> float:
        if self._is_spread_candidate(c):
            return float(c.delta or 0.0)
        return float(getattr(c, "delta", 0.0) or 0.0)

    def _candidate_gamma(self, c) -> float:
        if self._is_spread_candidate(c):
            return float(c.gamma or 0.0)
        return float(getattr(c, "gamma", 0.0) or 0.0)

    def _candidate_iv_pct(self, c) -> float:
        if self._is_spread_candidate(c):
            return float(c.iv_pct or 0.0)
        return float(getattr(c, "iv_pct", 0.0) or 0.0)

    def _candidate_price(self, c) -> float:
        if self._is_spread_candidate(c):
            return float(c.bs_price_usd or 0.0)
        return float(getattr(c, "bs_price_usd", 0.0) or 0.0)

    def _candidate_dte(self, c) -> int:
        if self._is_spread_candidate(c):
            return int(c.dte)
        return int(getattr(c, "dte", 0) or 0)

    def _candidate_curve(
            self,
            c,
            spot_arr: np.ndarray,
            option_smile: OptionSmile,
            horizon_days: int = 0,
    ) -> np.ndarray:
        """
        Return one optimizer-unit curve: current value (at horizon_days from
        now, default 0 = today) across the spot ladder, minus the entry price
        (always today's price — the cost basis doesn't move, only how much
        time has passed since paying it).

        Naked option:
            option value across spot ladder minus entry price.

        Spread:
            long leg value minus short leg value minus net entry price.
        """
        matching_slice = next(
            (
                smile_slice
                for smile_slice in option_smile.slices
                if smile_slice.expiry_code == c.expiry_code
            ),
            None,
        )
        maturity = matching_slice.maturity if matching_slice is not None else option_smile.slices[0].maturity

        if self._is_spread_candidate(c):
            long_leg = c.long_leg
            short_leg = c.short_leg

            T = max(float(c.dte) - horizon_days, 0.0) / 365.25
            r = 0.0

            long_strike = float(long_leg.strike or 0.0)
            short_strike = float(short_leg.strike or 0.0)

            long_entry = float(long_leg.bs_price_usd or 0.0)
            short_entry = float(short_leg.bs_price_usd or 0.0)
            spread_entry = long_entry - short_entry

            curve_list = []
            for spot in spot_arr:
                long_vol = option_smile.compute_vol(
                    maturity,
                    strike=long_strike,
                )
                short_vol = option_smile.compute_vol(
                    maturity,
                    strike=short_strike,
                )

                long_price = options.bs_price(
                    spot,
                    long_strike,
                    T,
                    r,
                    long_vol,
                    long_leg.opt,
                )
                short_price = options.bs_price(
                    spot,
                    short_strike,
                    T,
                    r,
                    short_vol,
                    short_leg.opt,
                )

                curve_list.append((long_price - short_price) - spread_entry)

            return np.array(curve_list, dtype=float)
        elif self._is_straddle_candidate(c):
            call_leg = c.call_leg
            put_leg = c.put_leg

            T = max(float(c.dte) - horizon_days, 0.0) / 365.25
            r = 0.0
            strike = float(c.strike or 0.0)
            entry_price = float(c.bs_price_usd or 0.0)

            curve_list = []
            for spot in spot_arr:
                call_vol = option_smile.compute_vol(
                    maturity,
                    strike=float(call_leg.strike or 0.0),
                )
                put_vol = option_smile.compute_vol(
                    maturity,
                    strike=float(put_leg.strike or 0.0),
                )

                call_price = options.bs_price(
                    spot,
                    float(call_leg.strike or 0.0),
                    T,
                    r,
                    call_vol,
                    "C",
                )
                put_price = options.bs_price(
                    spot,
                    float(put_leg.strike or 0.0),
                    T,
                    r,
                    put_vol,
                    "P",
                )

                curve_list.append((call_price + put_price) - entry_price)

            return np.array(curve_list, dtype=float)
        elif self._is_iron_condor_candidate(c):
            T = max(float(c.dte) - horizon_days, 0.0) / 365.25
            r = 0.0
            entry_price = float(c.bs_price_usd or 0.0)

            legs = [
                (c.put_low_leg, 1.0),
                (c.put_high_leg, -1.0),
                (c.call_low_leg, -1.0),
                (c.call_high_leg, 1.0),
            ]

            curve_list = []
            for spot in spot_arr:
                value = 0.0
                for leg, leg_sign in legs:
                    strike = float(leg.strike or 0.0)
                    vol = option_smile.compute_vol(
                        maturity,
                        strike=strike,
                    )
                    value += leg_sign * options.bs_price(
                        spot,
                        strike,
                        T,
                        r,
                        vol,
                        leg.opt,
                    )

                curve_list.append(value - entry_price)

            return np.array(curve_list, dtype=float)
        if c.opt == "F":
            # Linear payoff, no vol/maturity dependence — matches
            # bs_value_for_position's own opt=="F" handling. c.strike holds
            # the entry spot (see BaseOptimizer._build_candidates), horizon-
            # independent since a perp has no time value to bleed off.
            return spot_arr - float(c.strike or 0.0)
        if c.opt not in ("C", "P", "F"):
            return np.zeros_like(spot_arr, dtype=float)

        strike = float(c.strike or 0.0)
        bs_price = float(c.bs_price_usd or 0.0)
        T = max(float(c.dte) - horizon_days, 0.0) / 365.25
        r = 0.0

        curve_list = []
        for spot in spot_arr:
            vol = option_smile.compute_vol(
                maturity,
                strike=strike,
            )
            price = options.bs_price(spot, strike, T, r, vol, c.opt)
            curve_list.append(price - bs_price)

        return np.array(curve_list, dtype=float)

    def _candidate_trade_legs(self, c, qty: int) -> list[tuple[Candidate, int, str]]:
        """
            Expand optimizer quantity into executable option legs.
            Naked candidate:
                qty of that candidate.
            Spread candidate:
                qty of long leg and -qty of short leg.
            Straddle candidate:
                qty of call leg and qty of put leg.
            """
        if self._is_spread_candidate(c):
            return [(c.long_leg, qty, c.kind), (c.short_leg, -qty, c.kind),]
        elif self._is_straddle_candidate(c):
            return [(c.call_leg, qty, c.kind), (c.put_leg, qty, c.kind)]
        elif self._is_iron_condor_candidate(c):
            return [(c.put_low_leg, qty, c.kind), (c.put_high_leg, -qty, c.kind),
                    (c.call_low_leg, -qty, c.kind), (c.call_high_leg, qty, c.kind)]
        else:
            return [(c, qty, "NAKED")]

    def _leg_group_costs(
            self,
            traded_candidates: list[tuple[int, int, object]],
            bid_ask_vol_pts: "dict[str, float] | float | None",
            perp_cost_bps: "dict[str, float] | float | None" = None,
    ) -> dict[tuple, tuple[float, float]]:
        """Price each real (counterparty, expiry, strike, opt) leg off the TRUE
        combined net exposure of every candidate that trades it, not the sum of
        each candidate's cost computed in isolation.

        Without this, two LP-selected candidates that happen to land on the same
        real leg (e.g. a naked put and a put spread sharing a strike) each get
        costed off their OWN, smaller net exposure and their costs are simply
        summed when _aggregate_trade_legs merges the leg — so the same final net
        quantity at that leg reports a different total cost depending on which
        redundant combination of structures the LP happened to pick to reach it.
        Grouping by shared real legs (union-find: candidates are connected if
        they share a leg) and re-pricing off the group's combined net exposure
        makes the reported cost a function of the final position only, matching
        _structure_leg_costs_usd's own "a dealer prices a package off net risk"
        principle at whatever granularity the LP's picks actually overlap —
        candidates that don't share a leg with anything form a singleton group
        and get exactly today's per-candidate cost, unchanged.

        Returns {(counterparty, expiry_code, strike, opt): (merged_qty, cost)}.
        """
        parent: dict[int, int] = {j: j for j, _, _ in traded_candidates}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

        legs_by_idx: dict[int, list[tuple]] = {}
        owner_by_key: dict[tuple, int] = {}
        for j, rounded_qty, c in traded_candidates:
            legs = self._candidate_trade_legs(c, rounded_qty)
            legs_by_idx[j] = legs
            for leg, _leg_qty, _strategy in legs:
                key = (leg.counterparty, leg.expiry_code, leg.strike, leg.opt)
                if key in owner_by_key:
                    union(j, owner_by_key[key])
                else:
                    owner_by_key[key] = j

        components: dict[int, list[int]] = {}
        for j, _, _ in traded_candidates:
            components.setdefault(find(j), []).append(j)

        result: dict[tuple, tuple[float, float]] = {}
        for member_idxs in components.values():
            merged: dict[tuple, dict] = {}
            for j in member_idxs:
                for leg, leg_qty, _strategy in legs_by_idx[j]:
                    key = (leg.counterparty, leg.expiry_code, leg.strike, leg.opt)
                    m = merged.setdefault(key, {"leg": leg, "qty": 0})
                    m["qty"] += leg_qty

            keys = [k for k, m in merged.items() if m["qty"] != 0]
            leg_costs = _structure_leg_costs_usd(
                [(merged[k]["leg"], merged[k]["qty"]) for k in keys], bid_ask_vol_pts, perp_cost_bps,
            )
            for k, cost in zip(keys, leg_costs):
                result[k] = (merged[k]["qty"], cost)

        return result

    def _aggregate_trade_legs(self, trades: list[dict]) -> list[dict]:
        aggregated: dict[tuple, dict] = {}

        for trade in trades:
            key = (
                trade.get("counterparty"),
                trade.get("instrument"),
                trade.get("expiry"),
                trade.get("strike"),
                trade.get("opt"),
            )

            qty = int(trade.get("qty", 0) or 0)
            if qty == 0:
                continue

            if key not in aggregated:
                aggregated[key] = trade.copy()
                aggregated[key]["qty"] = qty
                aggregated[key]["estimated_cash_outlay"] = float(trade.get("estimated_cash_outlay", 0.0) or 0.0)
                aggregated[key]["normalized_benefit"] = float(trade.get("normalized_benefit", 0.0) or 0.0)
                aggregated[key]["net_benefit"] = float(trade.get("net_benefit", 0.0) or 0.0)
                aggregated[key]["delta_contribution"] = float(trade.get("delta_contribution", 0.0) or 0.0)
                aggregated[key]["gamma_contribution"] = float(trade.get("gamma_contribution", 0.0) or 0.0)
                aggregated[key]["vega_contribution"] = float(trade.get("vega_contribution", 0.0) or 0.0)
                aggregated[key]["cost_usd"] = float(trade.get("cost_usd", 0.0) or 0.0)
                aggregated[key]["strategy"] = trade.get("strategy", "MIXED")
                aggregated[key]["strategy_instrument"] = trade.get("strategy_instrument", "")
                continue

            existing = aggregated[key]
            existing["qty"] += qty
            existing["estimated_cash_outlay"] += float(trade.get("estimated_cash_outlay", 0.0) or 0.0)
            existing["normalized_benefit"] += float(trade.get("normalized_benefit", 0.0) or 0.0)
            existing["net_benefit"] += float(trade.get("net_benefit", 0.0) or 0.0)
            existing["delta_contribution"] += float(trade.get("delta_contribution", 0.0) or 0.0)
            existing["gamma_contribution"] += float(trade.get("gamma_contribution", 0.0) or 0.0)
            existing["vega_contribution"] += float(trade.get("vega_contribution", 0.0) or 0.0)
            existing["cost_usd"] = existing.get("cost_usd", 0.0) + float(trade.get("cost_usd", 0.0) or 0.0)

            if existing.get("strategy_instrument") != trade.get("strategy_instrument"):
                existing["strategy"] = "MIXED"
                existing["strategy_instrument"] = "Aggregated"

        result = []
        for trade in aggregated.values():
            if trade["qty"] == 0:
                continue

            trade["side"] = "Buy" if trade["qty"] > 0 else "Sell"
            trade["estimated_cash_outlay"] = round(float(trade.get("estimated_cash_outlay", 0.0)), 2)
            trade["normalized_benefit"] = round(float(trade.get("normalized_benefit", 0.0)), 2)
            trade["net_benefit"] = round(float(trade.get("net_benefit", 0.0)), 2)
            trade["delta_contribution"] = round(float(trade.get("delta_contribution", 0.0)), 4)
            trade["gamma_contribution"] = round(float(trade.get("gamma_contribution", 0.0)), 6)
            trade["vega_contribution"] = round(float(trade.get("vega_contribution", 0.0)), 4)
            trade["cost_usd"] = round(float(trade.get("cost_usd", 0.0)), 2)
            result.append(trade)

        result.sort(key=lambda t: (str(t.get("expiry")), float(t.get("strike") or 0.0), str(t.get("opt"))))
        return result

    def _candidate_instrument_name(self, c) -> str:
        if self._is_spread_candidate(c):
            return (
                f"{c.kind}: "
                f"{self.asset}-{c.expiry_code}-{int(c.long_leg.strike)}-{c.long_leg.opt} / "
                f"{self.asset}-{c.expiry_code}-{int(c.short_leg.strike)}-{c.short_leg.opt}"
            )
        if self._is_straddle_candidate(c):
            return (
                f"{c.kind}: "
                f"{self.asset}-{c.expiry_code}-{int(c.strike)}-C / "
                f"{self.asset}-{c.expiry_code}-{int(c.strike)}-P"
            )
        if self._is_iron_condor_candidate(c):
            return (
                f"{c.kind}: "
                f"{self.asset}-{c.expiry_code}-{int(c.put_low_leg.strike)}-P / "
                f"{self.asset}-{c.expiry_code}-{int(c.put_high_leg.strike)}-P / "
                f"{self.asset}-{c.expiry_code}-{int(c.call_low_leg.strike)}-C / "
                f"{self.asset}-{c.expiry_code}-{int(c.call_high_leg.strike)}-C"
            )
        return (
            f"{self.asset}-PERPETUAL" if c.opt == "F"
            else f"{self.asset}-{c.expiry_code}-{int(c.strike)}-{c.opt}"
        )

    def _estimate_candidate_cash_outlay(
            self,
            c,
            qty: int,
            held_positions: dict,
            unwind_discount: float,
            new_position_penalty: float,
    ) -> float:
        """Sum _estimate_trade_cash_outlay() across all legs of a candidate.

        For spreads/straddles/condors this returns the SAME combined total on
        every leg (see call sites) — not a per-leg cost, so don't sum this
        field across leg rows without deduping by the parent candidate first.
        """
        est_cost = 0.0

        for leg, leg_qty, _strategy in self._candidate_trade_legs(c, qty):
            held_qty = float(
                held_positions.get(
                    (leg.expiry_code, leg.strike, leg.opt, leg.counterparty),
                    0.0,
                )
            )

            est_cost += self._estimate_trade_cash_outlay(
                qty=leg_qty,
                price=float(leg.bs_price_usd or 0.0),
                held_qty=held_qty,
                unwind_discount=unwind_discount,
                new_position_penalty=new_position_penalty,
                is_held=abs(held_qty) > 0,
            )

        return est_cost

    def _pick_two_monthly_expiries(self, expiry_codes: list[str], min_dte: int = 29) -> list[tuple[str, int]]:
        today = date.today()
        valid: list[tuple[int, str]] = []

        for code in expiry_codes:
            try:
                exp_date = datetime.strptime(code, "%d%b%y").date()
            except ValueError:
                continue

            dte = (exp_date - today).days
            if dte >= min_dte:
                valid.append((dte, code))

        valid.sort(key=lambda x: (x[0], expiry_sort_key(x[1])))
        return [(code, dte) for dte, code in valid[:2]]

    def _pick_iron_condor_legs(
            self,
            candidates: list[Candidate],
            target_expiry: str,
            wing_target: float = 10.0,
            body_target: float = 50.0,
    ) -> list[Candidate]:
        expiry_candidates = [c for c in candidates if c.expiry_code == target_expiry and c.opt in ("C", "P")]
        if not expiry_candidates:
            raise ValueError(f"No option candidates found for expiry {target_expiry}")

        puts = [c for c in expiry_candidates if c.opt == "P"]
        calls = [c for c in expiry_candidates if c.opt == "C"]

        if not puts or not calls:
            raise ValueError(f"Need both puts and calls to build iron condor for {target_expiry}")

        def score(c: Candidate, target: float) -> float:
            # Use iv_pct as the "percentage" signal if that's how your surface is encoded.
            # If you prefer delta-based selection, replace this with abs(abs(c.delta) - target/100).
            return abs(abs(float(c.delta or 0.0)) * 100.0 - target)

        put_wing = min(puts, key=lambda c: score(c, wing_target))
        put_body = min(puts, key=lambda c: score(c, body_target))
        call_body = min(calls, key=lambda c: score(c, body_target))
        call_wing = min(calls, key=lambda c: score(c, wing_target))

        # Deduplicate if the surface is sparse and the same strike is chosen twice
        chosen = []
        seen = set()
        for leg in (put_wing, put_body, call_body, call_wing):
            key = (leg.expiry_code, leg.strike, leg.opt, leg.counterparty)
            if key not in seen:
                chosen.append(leg)
                seen.add(key)

        return chosen

    def _condor_price(self, legs: list[Candidate]) -> float:
        # Net premium of the structure:
        # long legs paid, short legs received
        total = 0.0
        for leg in legs:
            qty_sign = 1.0
            if leg.opt in ("C", "P"):
                # use candidate side implied by the current trade setup:
                # if you later attach explicit long/short intent, replace this
                qty_sign = 1.0
            total += qty_sign * leg.bs_price_usd
        return total

    def solve_condor(self, qty, candidate_by_key, x, call_to_put_ratio=1.):
        # Build candidates for the target expiry range: 10% / ATM / 10% iron condors, and ETH-PERPETUAL
        expiry_codes = sorted(
            {s["expiry_code"] for s in self.vol_surface if s.get("dte", 0) > 0},
            key=expiry_sort_key,
        )

        picked = self._pick_two_monthly_expiries(expiry_codes)
        if len(picked) < 2:
            raise ValueError("Need at least 2 monthly expiries with DTE > 28 days")

        front_expiry, front_dte = picked[0]
        back_expiry, back_dte = picked[1]
        print(f"Selected expiries: {front_expiry} ({front_dte}d), {back_expiry} ({back_dte}d)")

        # Build candidates for the target expiry range: front expiry structure + back expiry structure
        front_candidates = self._build_candidates(target_expiry=front_expiry)
        back_candidates = self._build_candidates(target_expiry=back_expiry)

        if not front_candidates or not back_candidates:
            raise ValueError("Could not build candidates for one or both selected expiries")

        # front_condor = self._pick_iron_condor_legs(front_candidates, front_expiry)
        back_condor = self._pick_iron_condor_legs(back_candidates, back_expiry)

        selected_candidates = back_condor

        price_by_expiry = {
            # front_expiry: self._condor_price(front_condor),
            back_expiry: self._condor_price(back_condor),
        }
        # Now the LP works only on those 8-ish legs
        candidates = selected_candidates
        # Solve the LP: maximize x*front_ic_qty + (1-x)*back_ic_qty under collateral constraints
        collateral_by_counterparty = {"FlowDesk": 8750000, "KeyRock": 0}  # 7926168
        cost_by_counterparty = {"FlowDesk": 0.01, "KeyRock": 0.05}
        solver = PulpSolver()
        solution = solver.solve(price_by_expiry, cost_by_counterparty, collateral_by_counterparty)

        # Build trades
        condor_qty = qty
        condor_mults = [1., -1., -call_to_put_ratio, call_to_put_ratio]
        condor_trades = []
        for k in range(4):
            c = candidates[k] if k < len(candidates) else None
            instrument_name = (f"{self.asset}-PERPETUAL" if c.opt == "F" else f"{self.asset}-{c.expiry_code}-{int(c.strike)}-{c.opt}")

            cost_rate = float(self.compute_costs(
                self.spot, [c] if c else [], perp_cost_bps=2.0, brokerage_txn_cost_pct=0.5,
                deribit_txn_cost_pct=0.1,
            )[0]) if c else 0.0

            # Close the full held quantity: long position  -> sell to unwind, short position -> buy to unwind
            unwind_signed = condor_qty * condor_mults[k]  # -int(round(held_qty))
            unwind_qty = abs(unwind_signed)
            unwind_notional = unwind_qty * c.bs_price_usd
            cost_unwind_part = cost_rate * 0 * unwind_notional
            # x[i] = unwind_signed

            condor_trades.append({
                "counterparty": c.counterparty, "instrument": instrument_name, "expiry": c.expiry_date if c else "",
                "dte": c.dte if c else 0, "strike": c.strike if c else 0.0, "opt": c.opt, "qty": unwind_signed,
                "side": "Buy" if unwind_signed > 0 else "Sell", "iv_pct": round(c.iv_pct, 1),
                "bs_price_usd": round(c.bs_price_usd, 2), "notional": round(unwind_notional, 2),
                "cost_bps": round(cost_rate * 10_000, 1), "trade_cost": round(cost_unwind_part, 2),
                "delta_contribution": round(unwind_signed * float(c.delta), 4),
                "gamma_contribution": round(unwind_signed * float(c.gamma), 6),
                "vega_contribution": round(unwind_signed * c.vega, 4),
                "is_unwind": True, "unwind_qty": unwind_qty, "new_qty": 0,
            })

        return condor_trades, x

