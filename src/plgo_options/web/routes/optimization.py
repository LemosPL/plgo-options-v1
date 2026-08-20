"""Optimizer v2 endpoints."""

from __future__ import annotations

import json
import os
import traceback
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from plgo_options.web.routes.portfolio import portfolio_pnl
from plgo_options.optimization.optim_usecase import (
    OptimizerRunParams,
    OptimizerUseCase,
)
from plgo_options.data.database import get_db
from plgo_options.data.deal_grouping import compute_composite_ids

router = APIRouter()


def _resolve_snapshot_root() -> Path:
    """Pick where saved optimizer snapshots live.

    Resolution order:
      1. SNAPSHOT_DIR env var (explicit override — typically a GCS FUSE mount on Cloud Run).
      2. DB_DIR/optimization_snapshots — if DB_DIR is set, piggyback on the same persistent
         mount that backs the SQLite DB so snapshots survive container restarts for free.
      3. Local repo-relative ./data/optimization_snapshots (dev fallback; ephemeral on Cloud Run).
    """
    snap = os.environ.get("SNAPSHOT_DIR")
    if snap:
        return Path(snap)
    db_dir = os.environ.get("DB_DIR")
    if db_dir:
        return Path(db_dir) / "optimization_snapshots"
    return Path("data/optimization_snapshots")


# Resolved at import time — the same root is used by both the save path and the
# list/download endpoints, so anything written ends up listable.
SNAPSHOT_ROOT = _resolve_snapshot_root()


async def _fetch_collateral_by_cp() -> dict[str, dict[str, float]]:
    """Posted collateral per counterparty per asset, summed across books —
    same query/table the Collateral tab and reconciliation already use
    (counterparty_collateral). Always fetched; feeds the reported
    cp_worst_case_net diagnostic, and additionally constrains the LP's own
    trade choices when use_collateral_cap is set."""
    db = await get_db()
    result: dict[str, dict[str, float]] = {}
    try:
        cur = await db.execute(
            "SELECT counterparty, asset, SUM(qty) AS qty FROM counterparty_collateral GROUP BY counterparty, asset"
        )
        for row in await cur.fetchall():
            cp = str(row["counterparty"])
            asset = str(row["asset"]).upper()
            result.setdefault(cp, {})[asset] = float(row["qty"] or 0.0)
    except Exception:
        result = {}  # table may not exist yet — treat as no collateral data
    return result


class OptimizationParams(BaseModel):
    asset: str = "ETH"
    lam_factor: float = 0.2
    mu_factor: float = 0.0
    target_expiry: str | None = None
    unwind_discount: float = 0.2
    new_position_penalty: float = 0.04
    roll_dte_threshold: int | None = None
    roll_itm_only: bool = False
    collateral_budget_pct: float | None = None
    save_usecase_snapshot: bool = False
    is_replay: bool = False
    # Run the whole optimization as if spot were this price instead of the
    # live mark — candidate strikes, greeks, the target profile anchor, and
    # the payoff ladder all re-center on it (see run_optimizer below; the
    # optimizer engine itself needs no changes, since spot_ladder is already
    # rebuilt fresh from whatever spot it's given on every run). None
    # (default) = live spot, unchanged from before this existed.
    custom_spot: float | None = None
    counterparties: list[str] | None = None
    collateral_tier_free_pct: float | dict[str, float] = 0.0
    collateral_tier_mu: float | dict[str, float] | None = None
    forced_roll_ids: list[int] | None = None
    cash_neutrality_factor: float | dict[str, float] = 0.0
    max_qty: float | None = None
    max_trades: int | None = None
    enable_box_neutralizer: bool = True
    # Post-LP delta cleanup: after the LP's own trades, if the resulting book's
    # net option delta (offset by the current perp holding) still sits outside
    # delta_band, propose one perp trade to flatten it back to zero. Orthogonal
    # to the LP's own shape fit, which rarely reaches for the perp itself. Off
    # by default — a new, opt-in feature until users have tried it.
    enable_delta_rehedge: bool = False
    # Band width in underlying units (e.g. ETH contracts). 75 is the value this
    # codebase's band-triggered control policy was calibrated against for ETH.
    delta_band: float = 75.0
    downside_factor: float = 1.0
    t90_weight: float = 0.0
    # Power-law tilt on the profile-fit spot_weights (gamma = exp(atm_concentration)):
    # 0 (default) is an exact no-op; >0 concentrates fit pressure at the money;
    # <0 flattens it toward a uniform spread. See optimizer_v3.run_lp.
    atm_concentration: float = 0.0
    # Per-counterparty hard loss cap: a counterparty's own (non-rolled book +
    # this run's trades for that CP) may never be worth more than this many
    # dollars less than it is today, at any spot on the ladder — the fleet-wide
    # profile fit above can hide a large single-CP loss if it's netted out by a
    # gain elsewhere in the book, which that counterparty can't see and
    # wouldn't accept. None (default) disables it. Unlike the soft weights
    # above, this is a hard constraint — too tight a cap can make a run
    # infeasible instead of just trading off against a worse fit.
    max_cp_loss_usd: float | dict[str, float] | None = None
    # Posted collateral (Collateral tab data — USD/USDC + this run's own asset
    # only) is always fetched and reported as cp_worst_case_net in the
    # response, regardless of this flag. Opt-in: when true, that
    # collateral-derived floor ALSO constrains the LP's own trade choices (not
    # just reported) — combined with max_cp_loss_usd by taking whichever is
    # tighter at each spot. Off (default) = informational only, unchanged
    # trade selection from before this existed.
    use_collateral_cap: bool = False
    # Optional allow-list of DB trade ids: when set, the optimizer's *input book*
    # is scoped to exactly these trades (the "current portfolio" it optimizes
    # against becomes only this subset), instead of the whole asset book. Sourced
    # from a selection of deals on the Deals / Risk screen. None/empty = full book.
    base_trade_ids: list[int] | None = None
    # Optional user-drawn target payoff the LP fits to, replacing the parametric
    # target. List of {"x": spot, "y": payoff} control points (>=2), interpolated
    # onto the optimizer's spot ladder. None = use the built-in parametric target.
    manual_target: list[dict] | None = None
    # DEPRECATED: the %-of-price bid-ask cost model was replaced by VOL points
    # (bid_ask_vol_pts below). Still accepted for back-compat but no longer drives
    # the optimizer's cost.
    bid_ask_atm_pct: float | dict[str, float] | None = None
    # Per-counterparty transaction cost in VOL POINTS (one-way half-spread). When
    # set, cost = |vega| × VOLpts per executed leg, replacing the %-of-price model.
    # {counterparty: vol_pts} dict (or a flat scalar). None = per-asset default.
    bid_ask_vol_pts: float | dict[str, float] | None = None
    # Real execution cost, in basis points of notional, for the box cash
    # neutralizer, per counterparty (or a flat scalar). A box's vega-based
    # cost is provably ~0 (put-call parity), so without this the neutralizer
    # looks free/unlimited despite being 4 real fills against a real
    # bid-ask. A box is economically a synthetic cash loan, priced by
    # dealers as bps of notional (an implied-rate spread), not a flat fee.
    # None = no fee (legacy behavior) until tuned per counterparty.
    box_fee_bps: float | dict[str, float] | None = None
    # Perp/future trading cost, in basis points of notional (price × qty), per
    # counterparty (or a flat scalar). A perp carries zero vega, so the
    # VOLpts model above prices it as free to trade without this. None = engine
    # default (2 bps).
    perp_cost_bps: float | dict[str, float] | None = None
    # Filename of a saved target-profile CSV (in data/) to fit to, e.g.
    # "ETH - target shifted v2.csv". Overridden by manual_target if that is set;
    # None = built-in parametric target.
    target_profile_file: str | None = None
    # When true (default), legs belonging to the same multi-leg "deal" with a
    # counterparty are forced to unwind together (proportionally) rather than
    # letting the LP cherry-pick individual legs, and priced off the deal's
    # net vega. See data.deal_grouping / base_optimizer.get_composite_groups.
    enable_composite_unwind: bool = True
    # Manual composite-grouping overrides from the Deals screen ({counterparty:
    # {leg_id: group_id}}), same shape /api/deals accepts — lets a trader's
    # manual re-grouping there also govern what the optimizer treats as one
    # deal. None/empty = pure auto-detection.
    composite_overrides: dict[str, dict[str, str]] | None = None

@router.post("/run")
async def run_optimizer(params: OptimizationParams):
    """Gather optimizer inputs, persist a reproducible use case, and run it."""
    print("run_optimizer()")
    try:
        # Matches "Load Risk Profile"'s own /pnl fetch (include_expired defaults to
        # False there) — this used to be harmless since the optimizer discarded
        # whatever positions it was given in favor of a fresh xlsx re-read; now
        # that it uses these positions directly, True here would flood the book
        # with every historically-expired trade as if it were still live.
        pnl_data = await portfolio_pnl(asset=params.asset.upper(), include_expired=False)
    except HTTPException as e:
        raise HTTPException(
            status_code=e.status_code,
            detail=f"Failed to gather portfolio data for asset {params.asset.upper()}: {e.detail}",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to gather portfolio data: {e}")

    # Hypothetical spot: override before OptimizerUseCase.from_portfolio_payload
    # reads it. That's the ONE place spot enters the optimizer — it re-derives
    # spot_ladder fresh (still centered on whatever spot it's given, still
    # bounded by the same shared min/max) every call, and every downstream
    # candidate/greek/target-profile calculation reads spot from there, so no
    # other change is needed for the whole run to re-center on it. Existing
    # positions are still the real book — bs_value_for_position reprices them
    # sticky-strike (same as the payoff chart), not literally repriced at the
    # live spot, so this is a real "what would I trade if spot gapped to X"
    # scenario, not just a display trick.
    if params.custom_spot is not None and params.custom_spot > 0:
        pnl_data["spot"] = params.custom_spot
        pnl_data["eth_spot"] = params.custom_spot

    # Scope the input book to a caller-selected subset of trades, if requested.
    # Positions in the /pnl payload carry the DB trade id under "id" (same id the
    # forced_roll_ids / Deals-screen leg_ids use), so we filter by it here — the
    # LP engine then treats this subset as the entire current portfolio.
    if params.base_trade_ids:
        wanted = {int(i) for i in params.base_trade_ids}
        all_positions = pnl_data.get("positions", []) or []
        filtered = [p for p in all_positions if int(p.get("id", -1)) in wanted]
        if not filtered:
            raise HTTPException(
                status_code=400,
                detail=("None of the selected trades were found in the current "
                        f"{params.asset.upper()} book (they may be expired or from "
                        "a different asset)."),
            )
        pnl_data["positions"] = filtered
        print(f"base_trade_ids: scoped book to {len(filtered)}/{len(all_positions)} positions")

    # Tag each position with the multi-leg "deal"/composite it belongs to
    # (same grouping the Deals screen shows), so the LP can prefer unwinding
    # a whole composite over cherry-picking one of its legs. Cheap and always
    # computed — enable_composite_unwind (below) is what actually gates
    # whether the LP acts on it.
    positions = pnl_data.get("positions", []) or []
    composite_ids = compute_composite_ids(positions, params.composite_overrides)
    for p in positions:
        p["composite_id"] = composite_ids.get(p.get("id"))

    # Always fetched — drives the cp_worst_case_net diagnostic in the response
    # regardless of use_collateral_cap; that flag only controls whether it
    # additionally constrains the LP's own trade choices (see below).
    collateral_by_cp = await _fetch_collateral_by_cp()

    print(params)
    run_params = OptimizerRunParams(
        asset=params.asset.upper(),
        lam_factor=params.lam_factor,
        mu_factor=params.mu_factor,
        target_expiry=params.target_expiry,
        unwind_discount=params.unwind_discount,
        new_position_penalty=params.new_position_penalty,
        roll_dte_threshold=params.roll_dte_threshold,
        roll_itm_only=params.roll_itm_only,
        collateral_budget_pct=params.collateral_budget_pct,
        is_replay=False,
        counterparties=params.counterparties,
        collateral_tier_free_pct=params.collateral_tier_free_pct,
        collateral_tier_mu=params.collateral_tier_mu,
        forced_roll_ids=params.forced_roll_ids,
        cash_neutrality_factor=params.cash_neutrality_factor,
        max_qty=params.max_qty,
        max_trades=params.max_trades,
        enable_box_neutralizer=params.enable_box_neutralizer,
        enable_delta_rehedge=params.enable_delta_rehedge,
        delta_band=params.delta_band,
        downside_factor=params.downside_factor,
        t90_weight=params.t90_weight,
        atm_concentration=params.atm_concentration,
        max_cp_loss_usd=params.max_cp_loss_usd,
        collateral_by_cp=collateral_by_cp,
        enforce_collateral_cap=params.use_collateral_cap,
        manual_target=params.manual_target,
        bid_ask_atm_pct=params.bid_ask_atm_pct,
        bid_ask_vol_pts=params.bid_ask_vol_pts,
        box_fee_bps=params.box_fee_bps,
        perp_cost_bps=params.perp_cost_bps,
        target_profile_file=params.target_profile_file,
        enable_composite_unwind=params.enable_composite_unwind,
    )

    usecase = OptimizerUseCase.from_portfolio_payload(pnl_data, run_params)
    try:
        result = usecase.run()
        if params.save_usecase_snapshot:
            # Save AFTER run() so the snapshot captures the result, not just the
            # inputs. Written under the same persistent root the list/download
            # endpoints scan, so it's immediately visible in the snapshots browser.
            save_dir = SNAPSHOT_ROOT / "usecases"
            save_path = usecase.save_auto(save_dir)
            print(f"Saved usecase snapshot (with result) to {save_path}")
    except Exception as e:
        tb = traceback.format_exc()
        print(tb)
        raise HTTPException(
            status_code=500,
            detail=f"Optimization failed: {e}\n\n{tb}",
        )

    return result


@router.get("/target-profiles")
async def list_target_profiles_endpoint(asset: str = "ETH"):
    """List the saved target-profile CSVs (built-in + user-created) available for
    an asset, so the UI can offer them alongside the built-in parametric target."""
    from plgo_options.optimization.misc_utils import list_target_profiles
    return {"asset": asset.upper(), "profiles": list_target_profiles(asset.upper())}


class SaveTargetProfileRequest(BaseModel):
    asset: str = "ETH"
    name: str
    points: list[dict]  # [{x: spot, y: payoff}, ...]


@router.post("/target-profile/save")
async def save_target_profile_endpoint(req: SaveTargetProfileRequest):
    """Persist the user's current target curve as a named, selectable profile.
    Saving with the name of an existing user profile updates (overwrites) it."""
    from pathlib import Path
    from plgo_options.optimization.misc_utils import save_target_profile
    try:
        filename = save_target_profile(req.asset.upper(), req.name, req.points)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Failed to save target profile: {e}")
    return {"file": filename, "name": Path(filename).stem}


class DeleteTargetProfileRequest(BaseModel):
    asset: str = "ETH"
    file: str


@router.post("/target-profile/delete")
async def delete_target_profile_endpoint(req: DeleteTargetProfileRequest):
    """Delete a user-created target profile (built-in ones can't be deleted)."""
    from plgo_options.optimization.misc_utils import delete_target_profile
    try:
        delete_target_profile(req.asset.upper(), req.file)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"Failed to delete target profile: {e}")
    return {"deleted": req.file}


class TargetProfileRequest(BaseModel):
    asset: str = "ETH"
    spot_ladder: list[float]
    current_spot: float
    # Optional saved-profile filename (from /target-profiles). None = parametric.
    profile: str | None = None


@router.post("/target-profile")
async def target_profile(req: TargetProfileRequest):
    """Return a target payoff aligned to the given spot ladder, so the UI can
    show/seed it before a run. With no ``profile`` this is the built-in parametric
    target (what run_lp fits to by default); with a ``profile`` filename it's that
    saved CSV — matching exactly what run_lp fits to when target_profile_file is set."""
    import numpy as np
    from plgo_options.optimization.misc_utils import (
        build_parametric_target_profile, load_target_profile_file,
    )

    asset = (req.asset or "ETH").upper()
    if not req.spot_ladder or req.current_spot <= 0:
        raise HTTPException(400, "spot_ladder and a positive current_spot are required.")
    try:
        if req.profile:
            df = load_target_profile_file(req.profile, asset)
        else:
            df = build_parametric_target_profile(
                asset, spot_ladder=req.spot_ladder, current_spot=req.current_spot,
            )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"Failed to build target profile: {e}")

    strikes = np.asarray(df.index, dtype=float)
    payoff = np.asarray(df["Payoff($)"], dtype=float)
    ladder = np.asarray(req.spot_ladder, dtype=float)
    # FIL's parametric profile uses its own strike grid; interpolate onto the
    # caller's ladder so the returned payoff is index-aligned to spot_ladder.
    aligned = np.interp(ladder, strikes, payoff)
    return {
        "asset": asset,
        "spot_ladder": [float(x) for x in ladder],
        "payoff": [float(v) for v in aligned],
    }


# Listing/download read from the same Cloud-Run-aware root the optimizer saves to
# (SNAPSHOT_ROOT/usecases), so snapshots persist on the GCS FUSE mount in prod.
SNAPSHOT_DIR = SNAPSHOT_ROOT / "usecases"


@router.get("/snapshots")
async def list_snapshots():
    """List saved usecase snapshot files."""
    if not SNAPSHOT_DIR.exists():
        return {"snapshots": []}
    files = sorted(SNAPSHOT_DIR.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
    snapshots = []
    for f in files[:50]:
        try:
            with f.open() as fh:
                data = json.load(fh)
            params = data.get("run_params", {})
            inp = data.get("optimizer_input", {})
            result = data.get("result", {})
            snapshots.append({
                "filename": f.name,
                "size_kb": round(f.stat().st_size / 1024, 1),
                "modified": f.stat().st_mtime,
                "asset": params.get("asset", inp.get("asset", "ETH")),
                "target_expiry": params.get("target_expiry", ""),
                "lam_factor": params.get("lam_factor", ""),
                "status": result.get("status", ""),
                "trades_count": len(result.get("replacement_trades", result.get("trades", []))),
            })
        except Exception:
            snapshots.append({"filename": f.name, "size_kb": round(f.stat().st_size / 1024, 1)})
    return {"snapshots": snapshots}


@router.get("/snapshots/{filename}")
async def download_snapshot(filename: str):
    """Download a saved usecase snapshot file."""
    path = SNAPSHOT_DIR / filename
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Snapshot not found")
    # Security: ensure the resolved path is inside SNAPSHOT_DIR
    if not path.resolve().is_relative_to(SNAPSHOT_DIR.resolve()):
        raise HTTPException(status_code=403, detail="Access denied")
    return FileResponse(path, media_type="application/json", filename=filename)
