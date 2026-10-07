# Paused work has landed — October 7, 2026

The four paused slices are integrated on `rc`: irregular moons and Centaurs (`4b51dd5`), giant-planet rings (`460242c`, with Uranus estimates in `3e3ce4d` and Saturn profiles in `b34cebb`), Earth’s airglow and aurora (`0aa4539`), and Titan’s haze (`2005879`). Their products are in the shared manifest.

See [milestones](docs/milestones.md#resumed-work-landed-on-rc-by-2026-10-07) for the remaining model limits, [WORKSTATION.md](WORKSTATION.md) for the app and recovery commands, and [the scene suite](app/e2e/README.md) for rendering checks. The app is served on 5173; rendering scripts start their own server on `127.0.0.1` at a free port.
