# Setup complete — October 4, 2026

All 13 full-profile stages are built. All 96 Gaia faint-sky responses are saved
and validated. The completed manifest contains 1010 products. The app runs at
http://localhost:5173 and Earth surfaces/clouds have been visually verified in Brave.

## Open and resume

Open the URL in Brave. `./open-workstation.sh` opens the existing Brave profile
with the required Linux WebGPU/Vulkan settings. Persistent Brave startup flags
are in `~/.var/app/com.brave.Browser/config/brave-flags.conf`.

After reboot, restore the app with:

```bash
pipeline/.venv/bin/python scripts/resume-workstation.py
```

The recovery script detects the complete manifest and product sizes, then
starts only the app. `./run-workstation.sh full` explicitly verifies/rebuilds
data when wanted. These user services survive terminal closure, not reboot.

## Verification and retained state

- All 557 app tests passed; production build passed with the completed sky data.
- Final sky formats, astronomy calculations, and persistent-job checks: 20 passed.
- Brave GPU startup and texture delivery problems are fixed. Vite refreshes
  after data builds so new binary files are served correctly.
- Raw downloads remain cached: 124 GiB under data, plus 6.1 GiB of public app data.
- Gaia XP: all 3386 files downloaded, MD5-verified, and reduced.
- Sky jobs: `data/cache/sky-async-jobs.json`; all finished answers are cached.
- AIP completed the remaining sums after the slower archive jobs were moved;
  mirror counts/nulls matched exactly and sums within 1.2e-14 relative.
- Network fallback still uses the workstation Mullvad SOCKS5h routes.
- Downloads/build workers are finished; the bandwidth monitor is stopped.
- The app and Brave remain running.
- Visual proof: `data/cache/brave-working.png`.

No Git commits or pushes were made. See WORKSTATION.md for the implementation
and scientific-source repairs.
