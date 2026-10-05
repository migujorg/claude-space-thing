"""Fill the deep-star/sky spectrum cache from ESA's bulk files, preserving MD5/SHA256 checks."""
import os
from pathlib import Path
import workstation_pipeline as network
network.install()
from pipeline import stars_deep as sd, stars_gaia as sg, download

def main():
    # This pool performs decompression and numeric reduction as well as downloading.
    # Its size is derived from physical compute capacity; network leases are feedback-controlled separately.
    workers = max(1, len(os.sched_getaffinity(0)) // 2)
    W, cover = sd.xp_operator()
    print(f"[bulk] streaming {len(sg.xp_index())} archive files; {workers} CPU reduction workers", flush=True)
    with download._process_slot("bulk-reduction:" + sd.XP_TAG, 1):
        paths, ledger = sg.stream_xp_reduced(W, cover, sd.XP_TAG, workers=workers, log=print)
    print(f"[bulk] complete: {len(paths)} verified reductions", flush=True)

if __name__ == "__main__":
    main()
