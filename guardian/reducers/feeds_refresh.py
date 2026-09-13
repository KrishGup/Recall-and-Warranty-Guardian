# Node feeds_refresh: pull new CPSC, NHTSA and openFDA records by date window and upsert them. No tokens.
from guardian.feeds.refresh import refresh
from guardian.store import Store


def reduce(input, args, ctx):
    store = Store.default()
    out = refresh(store, window_days=int(input.get("window_days") or 45))
    ctx.log(f"cpsc {out['cpsc']} · nhtsa {out['nhtsa']} · fda {out['fda']} -> {out['upserted']} new ({out['mode']})")
    return out
