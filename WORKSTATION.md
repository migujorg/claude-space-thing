This checkout runs on a Ryzen 9 9950X3D (16 cores / 32 threads), 91 GiB RAM,
an RTX 5090 (32 GB VRAM), and a drive with approximately 7 TB free at setup.
The connection is gigabit. Upstream's timing estimates came from a constrained
Claude cloud workspace (4 vCPU, 20–40 MB/s); use actual local measurements.
Remote archive query speed and request limits can still determine build time.

Run `./run-workstation.sh` to resume the full-resolution build and then serve
the app at http://localhost:5173. `SKIP_BUILD=1 ./run-workstation.sh` serves
existing data immediately. Rendering scripts start their own Vite server on
`127.0.0.1` at a free port and never use 5173 unless given the app’s address
with `--base` ([why](app/e2e/README.md#the-scripts-own-server)). Eight Gaia XP
workers are used within the existing archive host limits. The original run.sh remains available.
The workstation runner schedules four independent stage processes concurrently,
starting every ready stage as its dependencies finish. Each worker has its own
SPICE state and build context; one coordinator merges successful results and
publishes the manifest. Global POSIX host leases enforce archive limits across
all worker/prefetch processes, and destination leases prevent duplicate or
overlapping downloads of the same raw file. The download ledger already uses
cross-process locking.

The separate `scripts/workstation_prefetch.py` helper uses 24 workers to download
independent Moon, Mars, Pluto/Charon, and shape inputs while stages compute. Its status is in
data/cache/prefetch-status.json; stage status is in data/cache/parallel-status.json.
Stage logs are under data/cache/parallel/<run timestamp>/.

The minimum utilization target is 75 MB/s over a rolling 60-second window.
The workstation build/stage entry points, `workstation_prefetch*.py`, and
`workstation_bulk_prefetch.py` set
`PIPELINE_NETWORK_METRICS=1`, opting into a daemon that publishes receive and
demand counters once a second to `data/cache/network-metrics/<pid>.json`.
Ordinary pipeline builds keep summary counters in memory without a metrics
thread or metrics files. This environment switch controls process telemetry,
not data products, and is inherited by child workers.
data/cache/network-control.json reports measured project receive rate, ready
download demand, and feedback-controlled per-host concurrency. The controller
raises concurrency below target with waiting work; it does not throttle for
exceeding the target. Published API limits remain enforced.

The deep-star/sky spectra use ESA's supported bulk route (bit-identical
reductions). A bulk file measured 26.4 MB/s here. Compressed-file downloads are
queued separately from CPU decompression/reduction, keeping the link supplied
with work even while numerical processing runs. The full bulk archive is about
114 GB; compressed files are retained on this drive with ESA MD5 checks and the
SHA256 ledger, and reductions are cached. The completed bright-star catalogue
retains its targeted spectra. A cache-owner lease prevents two bulk reducers
from writing the same cache simultaneously.

Gaia catalogue queries use ARI Heidelberg's partner archive (`gaia.tapService=ari`)
because ESA's endpoint was taking minutes per verification query and returning
HTTP 500 errors. ARI returned the identical 62,723-row bright-band count in 1.9
seconds. A 20-source sample matched every numerical/string field; boolean
columns use 0/1 instead of ESA's true/false and are normalized to actual booleans.
The required catalogue, cross-match tables, and HEALPix function are available.
Cached ESA results are retained; their original query URLs remain in the ledger
and per-file provenance. This option is fingerprinted for stars/deepstars/sky.
Use `--set gaia.tapService=esa` to select the original provider.
The independent bright-catalogue magnitude queries use the existing two TAP
workers, preserve file order, and share the provider's host limits with count
verification queries.
Queries explicitly request the advertised 10-million-row cap, keeping their
existing magnitude/HEALPix partitions. This avoids ARI's 100,000-row default
silently truncating dense FITS tiles; CSV count checks remain enabled.
The bright-star Tycho proper-motion lookup uses the exact two-parameter,
G<10 source IDs from the already-verified Gaia catalogue, avoiding a slow join
against the full source table. Long ADQL queries use POST; their query sidecars
and POST hashes remain recorded. The deep-stage generic lookup is preserved.

The project-local Python runner adds SOCKS support to Requests for this process
only. Normal routes are tried first. Failed connections, HTTP 403 responses,
or gateway errors (502/503/504)
fall back to Mullvad's 10.64.0.1:1080 proxy and the Equibop launcher's remembered
relay. If both fail, it discovers additional relay locations from Equibop's
cached Mullvad catalogue via tunnel DNS. HTML bot pages returned for PDF/data
requests also trigger a different route. Successful proxy routes are remembered per host in
data/cache/workstation-proxies.json. SOCKS5h delegates DNS to the proxy.
Interrupted response streams put their route on a short cooldown, so the
pipeline's next resumable-download attempt uses another route.
Additional candidates can be supplied via SPACE_THING_PROXIES (space-separated
socks5h:// addresses). HTTP 429 stays with the pipeline's existing backoff.
VPN settings and the Equibop launcher are unchanged.

For a connectivity check:
`pipeline/.venv/bin/python scripts/workstation_pipeline.py doctor --profile full`

Upstream's resumable downloads, checksums, provenance, and stage completion
records continue to apply. Build logs are in data/cache/logs/.

During initial setup the user services space-thing-build and space-thing-app
keep the build and server alive independently of the terminal. Check them with
`systemctl --user status space-thing-build space-thing-app` and follow the setup
log with `tail -f data/cache/logs/workstation-setup.log`.

After a reboot, restore the app and resumable workers from their checkpoints with
`pipeline/.venv/bin/python scripts/resume-workstation.py`. This also restores
the independent bulk download queue, spectrum reduction, and bandwidth controller.
The services survive terminal closure but are transient and must be restored
after a reboot. The script leaves services that are already active running.
Its completed-build shortcut still requires exactly 13 stages; the pipeline now has 15, so the
current full manifest does not select its app-only recovery path.

The DAMIT export is pinned to the official October 4 snapshot; the prior
September 30 URL is no longer published and returned HTTP 404.

The workstation launcher retains transient raw surface and shape inputs with
`PIPELINE_KEEP_RAW=1`, avoiding repeat downloads after an interrupted stage.
Phobos uses the official NAIF Mars Express mirror; its file comments differ
from the ESA ROSETTA copy, and the ledger records the actual retrieved bytes.
Slow fixed-version inputs can be prefetched through verified parallel HTTP
ranges with `scripts/workstation_ranges.py`; metadata and checksums are checked
before ordered assembly. DAMIT additionally passes gzip CRC validation.

Workstation sky queries use FITS binary tables for unverified inputs; existing
CSV results with verified row counts are reused. This avoids the separate
COUNT query and preserves masked colour bins. FITS byte-size validation rejects
incomplete transfers, and results at the explicit MAXREC boundary are rejected
as potentially clipped. The numerical aggregation queries are unchanged.
The normal pipeline retains its CSV default; the workstation launcher passes
`--set gaia.sumsFormat=fits` (environment alias: `PIPELINE_GAIA_SUMS_FORMAT=fits`). Each actual query URL, format, and checksum remains
in the download ledger.

Deep-tier Tycho proper motions are looked up only for the catalogue's known
two-parameter solutions, in batches of at most 5000 indexed source IDs.
This avoids the full Gaia-table join while preserving the same matches used
by the propagator. The source record combines per-response checksums and keeps
the original query sidecars and download provenance. Sky prefetch uses shared
archive slots 8–15, leaving slots 0–7 available to the foreground build.

The remaining faint-sky sums can run through `scripts/workstation_sky_async.py`.
It reuses verified CSV, full-table FITS, and lite-table FITS responses, submits
only missing queries as persistent archive jobs, and saves each job URL before
polling. Interrupted polling resumes the same remote job. Completed FITS files
are checked for truncation and the row limit, downloaded through the normal
ledger, and retain their actual query sidecars and result URLs. The service
automatically runs the final build when the inputs are ready. Recovery selects
this helper when its saved job state exists, avoiding duplicate synchronous work.

If the app reports "No WebGPU adapter" on Linux, launch it with
`./open-workstation.sh`. This uses the existing Flatpak Brave profile with Linux
Vulkan and experimental WebGPU enabled, explicitly selects its NVIDIA Vulkan
driver, uses X11 because Chromium's Wayland mode rejects this Vulkan configuration,
and disables the broken LSFG Vulkan layer for this process. Persistent startup
flags are installed with `scripts/configure-brave-gpu.py` using Cobalt's supported
`~/.var/app/com.brave.Browser/config/brave-flags.conf`. Existing flags are preserved
and an existing file is backed up before changes. GPU settings take effect after
restarting Brave. The app server must already be running at http://localhost:5173.
Chrome documents Linux GPU requirements at
https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips.

After stages create new public-data directories, the workstation launcher refreshes
the running Vite server's file list. Otherwise Vite can return index.html for a
new binary URL, which the surface cache rejects as malformed and displays as a
striped unknown surface. This was confirmed with an existing 524288-byte cloud
tile returning HTML before restart and the correct binary response after restart.
Earth's maps and the earlier clouds were visually verified in Brave during setup; that observation does not verify the later SatCORPS mosaic.

Sky sums also use GAVO (`https://dc.g-vo.org/tap`, `gaia.dr3lite`) and AIP
(`https://gaia.aip.de/tap`, `gaiadr3.gaia_source_lite`) when requested by the helper's
`--share-gavo`, `--share-aip`, or `--prefer-aip` options. These move waiting jobs;
running calculations keep their saved handles. The explicit
`--move-stragglers-to-aip` option also cancels slow unfinished mirror jobs before
resubmitting them to AIP; it was used after AIP finished seven regions in about
two minutes while the original jobs had been outstanding for over half an hour.
PostgreSQL bigint division by
2^(35+2*(12-order)) extracts the exact HEALPix source-ID bits. Full comparison
regions matched ARI's 16384 flux pixels and 46255 colour bins with identical IDs,
counts, and nulls; floating sums differed by at most 1.2e-14 relative. Cache names
retain their logical pipeline query identities, while sidecars, job state, and
the download ledger retain the actual mirror queries and result URLs. ARI jobs
aborted at its execution limit are retried at AIP. No scientific tolerances changed.

Rebuilding the small-body catalogue, or changing its window, does not require
regenerating any test fixture. The `smallbodies` stage writes a build record
(`verification/smallbodies.json`) with its products, and the tests that compare
the app with the pipeline on the built catalogue read it; the committed
references keep their own epoch (README, "Tests and references"). The event
test takes its CNEOS approaches from the same record: the ones JPL computed for
this window from the orbit solutions the catalogue holds. Numerical tolerances
are unchanged.

NMSU's two PDS archive hosts reset connections both directly and through eight
tested Mullvad relay countries. Three download declarations were repaired:
the Karkoschka 1995 table uses a pinned Starfield redistribution (the PDS label
matches the required V2.0 product, 1875 records of 54 bytes); Huygens HASI uses
ESA's official archive (both product labels explicitly identify V1.1 despite
the directory being named V1.0). The Karkoschka 1994 paper is unavailable at
NMSU and ADS; its already-transcribed Titan radius retains the original citation,
and its source record explicitly states that the document was not retrieved,
with no invented retrieval date or checksum. Source notes identify alternate
retrieval locations and the original URLs.
No scientific calculations or transcribed values were changed.

The upstream precise-orientation test fixture was generated with the September
29 Earth kernel. This build downloaded the October 3 revision. The exported
orientation agrees with SPICE using the current inputs within 3.6e-13; the old
fixture differs by up to 1.9e-9, because NAIF reissues that kernel as
measurements arrive. The 1e-12 bound of the test is a rounding bound against
SPICE on the same kernel file, so the `bodies` stage now writes SPICE's values
for the files it copied (`verification/orientation.json`) and the app test
compares with that. The committed reference now holds the Moon only (its
kernels are fixed files), names the kernel files of each case, and is compared
only where the built product was copied from the same files. Nothing needs
refreshing after a body-data rebuild. A minimal-profile build has no small-body catalogue: the NEO
event test then reports itself as not compared.

The 7 October cloud product is a SatCORPS 2026-09-28 mosaic of local early afternoons,
with `clouds`, `cloudTau` and `cloudTauEstimated` layers. There is no partly-cloudy
statistic substituted for missing thickness. Full builds also run `nightglow` and
`albedo_reference`; the latter needs Node and the app's esbuild before the pipeline
starts. The launcher prepares the app packages first.

For current renderer checks, use `cd app && npm run e2e -- --gpu hardware`
(36 scenes), and the validation sampling sweep documented in
[app/e2e/README.md](app/e2e/README.md#validation-against-calibrated-images).
The older timing and visual measurements above describe their recorded setup runs.
