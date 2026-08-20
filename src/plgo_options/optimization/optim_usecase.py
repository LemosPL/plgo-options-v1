from __future__ import annotations

import inspect
import json
import os
from dataclasses import asdict, dataclass, fields
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
import pandas as pd
import numpy as np

from plgo_options.optimization.optimizer import OptimizerV2
from plgo_options.optimization.optimizer_v3 import OptimizerV3
from plgo_options.optimization.snapshot import load_snapshot_dict


def _log_moneyness_ladder(spot: float, low: float, high: float, n_points: int) -> list[float]:
    """Spot ladder evenly spaced in log-moneyness ln(K / spot) — denser near the
    money, sparser in the wings — instead of the shared portfolio ladder's
    linear dollar steps. Snapped to round increments (finer near ATM) so the
    Optimizer v2 matrix/chart show clean values; the exact current spot is
    always included so the P&L-from-today anchor in build_payoffs lands on a
    real ladder point.

    Scoped to the optimizer's own input only — the shared SPOT_LADDER used by
    the Portfolio P&L and legacy "opt2" tabs is untouched.
    """
    if spot <= 0 or low <= 0 or high <= spot:
        return list(np.arange(low, high + (high - low) / n_points, (high - low) / n_points))

    lm_low = np.log(low / spot)
    lm_high = np.log(high / spot)
    lms = np.linspace(lm_low, lm_high, n_points)

    def _snap(price: float, abs_lm: float) -> float:
        # Step size scales with distance from ATM — mirrors the tick-spacing
        # heuristic already used for the payoff chart's x-axis labels.
        if abs_lm < 0.05:
            step = spot * 0.005
        elif abs_lm < 0.15:
            step = spot * 0.015
        elif abs_lm < 0.35:
            step = spot * 0.04
        elif abs_lm < 0.7:
            step = spot * 0.08
        else:
            step = spot * 0.15
        step = max(step, 1e-6)
        return round(price / step) * step

    points = {_snap(spot * np.exp(lm), abs(lm)) for lm in lms}
    points.add(round(spot, 2))
    return sorted(float(p) for p in points if p > 0)


def _json_default(obj: Any) -> Any:
    """Coerce numpy scalars/arrays (e.g. from scipy/bs_greeks) and bare
    datetime.date/datetime objects (several trade-dict builders in
    optimizer_v3.py put Candidate/Position.expiry_date — a date object,
    not a string — directly into "expiry" fields) into native JSON types.
    """
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


@dataclass
class OptimizerRunParams:
    asset: str = "ETH"
    lam_factor: float = 0.2
    mu_factor: float = 0.0
    target_expiry: str | None = "31JUL26"
    unwind_discount: float = 0.2
    new_position_penalty: float = 0.04
    roll_dte_threshold: int | None = None
    roll_itm_only: bool = False
    collateral_budget_pct: float | None = None
    is_replay: bool = False
    counterparties: list[str] | None = None
    collateral_tier_free_pct: float | dict[str, float] = 0.0
    collateral_tier_mu: float | dict[str, float] | None = None
    forced_roll_ids: list[int] | None = None
    cash_neutrality_factor: float | dict[str, float] = 0.0
    max_qty: float | None = None
    max_trades: int | None = None
    enable_box_neutralizer: bool = True
    # Post-LP delta cleanup: after the LP's own trades, check whether the
    # resulting book's net option delta (offset by the current perp holding)
    # still sits within delta_band — if not, propose one perp trade (on
    # base_optimizer.PERP_COUNTERPARTY) to flatten it back to zero. Orthogonal
    # to the LP's own (rarely perp-using) shape fit — see optimizer_v3
    # run_lp._build_delta_rehedge_trade. Off by default — a new, opt-in
    # feature until users have tried it.
    enable_delta_rehedge: bool = False
    # Band width in underlying units (e.g. ETH contracts) — mismatches within
    # the band are left alone. 75 is the value this codebase's band-triggered
    # control policy was calibrated against for ETH; tune per asset/book.
    delta_band: float = 75.0
    downside_factor: float = 1.0
    t90_weight: float = 0.0
    # Power-law tilt on the profile-fit spot_weights: gamma = exp(atm_concentration),
    # so 0 (default) is an exact no-op. >0 concentrates fit pressure at the money
    # (tails matter relatively less); <0 flattens toward a uniform spread across
    # the ladder. See optimizer_v3.run_lp for the actual application.
    atm_concentration: float = 0.0
    max_cp_loss_usd: float | dict[str, float] | None = None
    # Posted collateral per counterparty, per asset (e.g. {"Flowdesk": {"USDC": 6_717_467, "ETH": 2000}}),
    # sourced from the Collateral tab (always fetched by the route; only USD + this run's own asset are
    # used, see optimizer_v3.run_lp). Drives the cp_worst_case_net diagnostic regardless of
    # enforce_collateral_cap, and additionally constrains the LP's own trade choices when that's on.
    collateral_by_cp: dict[str, dict[str, float]] | None = None
    # Opt-in: when true, the collateral-derived floor above also constrains the LP's trade choices
    # (not just reported). Off (default) = informational only, matching pre-existing behavior.
    enforce_collateral_cap: bool = False
    manual_target: list[dict] | None = None
    bid_ask_atm_pct: float | dict[str, float] | None = None
    bid_ask_vol_pts: float | dict[str, float] | None = None
    box_fee_bps: float | dict[str, float] | None = None
    # Perp/future trading cost, in bps of notional (price × qty), per
    # counterparty (or a flat scalar). A perp carries zero vega so the
    # bid_ask_vol_pts model can't price it — see run_lp/CollateralOptimization.
    # None = engine default (2 bps).
    perp_cost_bps: float | dict[str, float] | None = None
    target_profile_file: str | None = None
    # When true (default), legs belonging to the same multi-leg "deal" (see
    # data.deal_grouping / base_optimizer.get_composite_groups) are forced to
    # unwind together, proportionally, and priced off the composite's net
    # vega rather than each leg's own — see collateral_optimization.optimize.
    # Off = every leg is an independent LP decision, the pre-existing behavior.
    enable_composite_unwind: bool = True


@dataclass
class OptimizerUseCase:
    today: datetime
    optimizer_input: dict[str, Any]
    run_params: OptimizerRunParams
    result: dict[str, Any] | None = None

    @classmethod
    def from_portfolio_payload(
        cls,
        portfolio_payload: dict[str, Any],
        run_params: OptimizerRunParams,
    ) -> "OptimizerUseCase":
        # print(portfolio_payload)
        spot = portfolio_payload.get("spot", portfolio_payload.get("eth_spot"))
        asset = portfolio_payload.get("asset", run_params.asset).upper()

        # Dense ladder for actual LP profile-fit resolution and chart
        # smoothness — matrix *display* row count is trimmed separately in
        # the frontend (optv2MatrixDisplayRows), not by starving this ladder.
        shared_ladder = portfolio_payload["spot_ladder"]
        spot_ladder = (
            _log_moneyness_ladder(spot, min(shared_ladder), max(shared_ladder), n_points=len(shared_ladder))
            if spot
            else shared_ladder
        )
        if asset == "ETH":
            spot_ladder = sorted({round(p) for p in spot_ladder})

        return_val = cls(
            today=datetime.today(),
            optimizer_input={
                "asset": asset,
                "spot": spot,
                "spot_ladder": spot_ladder,
                "matrix_horizons": portfolio_payload["matrix_horizons"],
                "chart_horizons": portfolio_payload["chart_horizons"],
                "vol_surface": portfolio_payload["vol_surface"],
                "positions": portfolio_payload["positions"],
                "totals": portfolio_payload["totals"],
                "snapshot_path": portfolio_payload.get("snapshot_path", ""),
            },
            run_params=run_params,
        )
        # print(return_val.optimizer_input)
        return return_val

    @classmethod
    def load(cls, path: str | Path) -> "OptimizerUseCase":
        path = Path(path)
        with path.open() as f:
            data = json.load(f)
        if "eth_spot" in data["optimizer_input"].keys():
            data["optimizer_input"]["spot"] = data["optimizer_input"]["eth_spot"]
            del data["optimizer_input"]["eth_spot"]

        today_str = path.name.split('_')[0]
        today = datetime.strptime(today_str, "%Y%m%d")
        valid_run_param_names = {field.name for field in fields(OptimizerRunParams)}
        run_params_data = {
            key: value
            for key, value in data["run_params"].items()
            if key in valid_run_param_names
        }

        return_val = cls(
            today=today,
            optimizer_input=data["optimizer_input"],
            run_params=OptimizerRunParams(**run_params_data),
            result=data.get("result"),
        )
        # print(return_val)
        return return_val

    def save(self, path: str | Path) -> Path:
        print(self.optimizer_input.keys())
        print(self.optimizer_input.get("spot"))

        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temp file and atomically replace the target so a serialization
        # error (e.g. a stray numpy type) can never leave a truncated/corrupt snapshot.
        tmp_path = path.with_suffix(path.suffix + ".tmp")
        try:
            with tmp_path.open("w") as f:
                json.dump(
                    {
                        "optimizer_input": self.optimizer_input,
                        "run_params": asdict(self.run_params),
                        "result": self.result,
                    },
                    f,
                    indent=2,
                    default=_json_default,
                )
            os.replace(tmp_path, path)
        finally:
            tmp_path.unlink(missing_ok=True)
        return path

    def save_auto(self, directory: str | Path) -> Path:
        directory = Path(directory)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        expiry = self.run_params.target_expiry or "ALL"
        filename = f"{ts}_{expiry}.json"
        return self.save(directory / filename)

    def build_optimizer(self, today=None) -> OptimizerV3:#OptimizerV2:
        if today is None:
            today = self.today
        return OptimizerV3.from_snapshot_dict(self.optimizer_input, today)
        return OptimizerV2.from_snapshot_dict(self.optimizer_input)

    def run(self, run_params=None) -> dict[str, Any]:
        print('run()')
        optimizer = self.build_optimizer(self.today)

        # LP-based engine (tiered collateral, bid-ask-based trading cost) — every
        # OptimizerRunParams field maps onto a run_lp() kwarg, unlike the older
        # optimizer.run(), which silently drops collateral_tier_free_pct/mu and
        # has no mu_factor/collateral_budget_pct/roll_itm_only equivalent at all.
        if run_params is not None:
            for k, v in run_params.items():
                setattr(self.run_params, k, v)
        self.result = optimizer.run_lp(**asdict(self.run_params))
        return self.result

    def run_test(self):
        print('run_test()')
        optimizer = self.build_optimizer(self.today)
        lam_factor = 0.2
        mu_factor = 2.3

        result = optimizer.run_lp(target_expiry="25SEP26", is_replay=True, roll_dte_threshold=25, roll_itm_only=True,
                                  lam_factor=lam_factor, mu_factor=mu_factor, counterparties=["Flowdesk", "KeyRock"],
                                  collateral_budget_pct=0.0)
        #result = optimizer.run(target_expiry="28AUG26", is_replay=True, roll_dte_threshold=5, lam_factor=lam_factor)#, counterparties=["Flowdesk"])

        print(f"roll_unwind_trades: {len(result.get('roll_unwind_trades', []))}")
        print(f"replacement_trades: {len(result.get('replacement_trades', []))}")
        return result
