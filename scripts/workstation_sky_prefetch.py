"""Start independent sky archive queries before the deep-star product is published."""
import concurrent.futures as cf
import workstation_pipeline as network
network.install()
from pipeline import stars_gaia as sg, sky_diffuse
from pipeline.stages import sky


def main():
    sg.set_tap_service("ari")
    network.reserve_tap_prefetch()
    with cf.ThreadPoolExecutor(max_workers=3) as pool:
        jobs = [pool.submit(sg.fetch_faint_sums, sky.FAINT_G_MIN, sky.FAINT_ORDER, 8),
                pool.submit(sg.fetch_faint_colour_sums, sky.FAINT_G_MIN, sky.COLOUR_ORDER, 8),
                pool.submit(sky_diffuse.fetch_pioneer)]
        for future in cf.as_completed(jobs):
            result = future.result()
            print("[sky-prefetch] input group ready:", len(result), flush=True)


if __name__ == "__main__":
    main()
