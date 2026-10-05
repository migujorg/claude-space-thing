"""Prefetch disjoint future Gaia query tiles while earlier tiles are still streaming."""
import concurrent.futures as cf
import workstation_pipeline as network
network.install()
from pipeline import download as d, stars_gaia as sg
from pipeline.stages import sky


def main():
    sg.set_tap_service("ari")
    # Eight is the project's local default, not a concurrency limit in the
    # provider's saved TAP capabilities. Probe twice that operating point;
    # HTTP retries and Retry-After remain enforced by the normal downloader.
    network.reserve_tap_prefetch()
    original = sg._in_order

    def tail(fn, items, workers, *args, **kwargs):
        first = 176 if len(items) == 192 else 24
        return original(fn, [item for item in items if item >= first], workers, *args, **kwargs)

    sg._in_order = tail
    with cf.ThreadPoolExecutor(max_workers=3) as pool:
        jobs = [pool.submit(sg.fetch_gaia_deep, 10.0, 14.0, workers=8),
                pool.submit(sg.fetch_faint_sums, sky.FAINT_G_MIN, sky.FAINT_ORDER, 8),
                pool.submit(sg.fetch_faint_colour_sums, sky.FAINT_G_MIN, sky.COLOUR_ORDER, 8)]
        for future in cf.as_completed(jobs):
            result = future.result()
            print("[tap-tail] future input group ready:", len(result), flush=True)


if __name__ == "__main__":
    main()
