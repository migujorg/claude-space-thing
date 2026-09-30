# North Star

> **If I were magically placed anywhere in the solar system right now, this is exactly what I would see, and for every pixel I can ask "how do we know that?" and get a real answer.**

Status: draft v0.1, being workshopped. Last updated 2026-09-30.

---

## 1. What this is

A universe simulator, starting with the solar system, where nothing is made up. Every object, and every property of every object (where it is, how big it is, what color it is, how bright it is), comes from real measurements or from physics applied to real measurements.

Most space software (SpaceEngine, planetarium apps, films) fills gaps with things that look plausible: procedural terrain, artist-chosen colors, contrast-boosted imagery, crowded asteroid belts. This project takes the opposite position. Looking right is not the goal. Being right is the goal, and looking right follows from it.

## 2. Who it's for

One person on one machine: me, on a desktop with an RTX 5090.

- **Platform:** a Chromium browser with WebGPU. The browser gets us to a working product fastest.
- **GPU-heavy by design.** Assume a top-end GPU and use it hard. No mobile, no low-end hardware, no graceful degradation.
- **No UI polish for strangers.** Decisions serve my eyes and my curiosity, not a general audience.

## 3. Principles

### 3.1 Nothing is invented

If it isn't in a dataset, or computed from one by physics, it doesn't exist in the simulation. That rules out:

- hand-painted textures
- hand-picked colors
- constants tweaked until something "looks right"
- procedural detail that isn't constrained by data

### 3.2 Every value has a pedigree

Provenance is tracked for each attribute, not each object. A typical catalogued asteroid has a measured orbit, an estimated size and no measured color at all, so "is this object real?" isn't a yes-or-no question. Every value carries one of these labels:

| Label | Meaning | Example |
|---|---|---|
| **Measured** | Taken directly from an observational dataset | An asteroid's orbital elements; Mars's reflectance spectrum |
| **Derived** | Computed from measured values by established physics, with no assumed inputs | That asteroid's position today, from its orbit; Mars's color, from its spectrum and the Sun's |
| **Estimated** | Computed from measured values plus an assumed input: a population statistic or a modeling assumption | An asteroid's diameter, from its brightness plus the typical albedo for its region |
| **Synthetic** | A whole object that isn't individually known, sampled from a measured population model | A 200 m main-belt asteroid that statistically must exist but hasn't been discovered |
| **Unknown** | No data, and we don't pretend otherwise | The shape of most small asteroids |

Every value also records where it came from: the dataset, its version and the specific record. Anything on screen can be clicked to inspect all of this.

### 3.3 Missing data is not missing reality

A solar system built only from catalogs is wrong in a systematic way. Surveys find big, bright objects first, so the catalogs are nearly complete for large asteroids and very incomplete for small ones. Leaving out the undiscovered majority misrepresents reality as badly as inventing things does.

Once the observed layer is solid, a synthetic layer fills the gap. Its rules:

- **It's drawn from measured population models:** size distributions, orbit distributions and asteroid-family makeup, all corrected for survey bias and cited like any other dataset.
- **It only fills what surveys couldn't have seen.** How complete the surveys are is itself measured. If surveys would have caught a 5 km asteroid on a given orbit, the generator can't put one there.
- **It never contradicts an observation.**
- **It yields to discoveries.** When a new catalog release adds real objects, they replace the synthetic ones that stood in for them. They don't stack on top.
- **It's deterministic.** The same inputs and seed produce the same universe every time.

### 3.4 The camera is a human eye

The target is not a pretty picture or a NASA photo. It's what a human eye would perceive if you were standing there. That means the whole path of the light is physical:

1. **Source:** the Sun's measured spectrum.
2. **Surfaces:** measured reflectance spectra, plus measured models of how a surface's brightness changes with the angles of lighting and viewing.
3. **Travel:** brightness falls off with distance; shadows, eclipses, ringshine and planetshine all happen naturally; and light travel time is included. You see objects where they were when the light left them. From Earth, for example, you see Jupiter as it was 35 to 50 minutes ago.
4. **Perception:** a model of the human eye (its color response, adaptation to the scene's brightness, glare and the faintest things it can see), then mapped to the display as faithfully as the display allows.

These consequences are features:

- **Neptune gets its real color.** It's a pale greenish-blue close to Uranus's (Irwin et al. 2024), not the deep blue from contrast-enhanced Voyager images.
- **Neptune isn't dark.** Sunlight there is about 1/900 as strong as at Earth, roughly the light of a dim living room. An adapted eye still sees it clearly and in color, while a camera at a fixed exposure would show it nearly black. The eye model gets this right.
- **The asteroid belt looks empty.** From inside it, other asteroids would at most be faint, star-like points, not a field of boulders.
- **Stars disappear when you're looking at something sunlit,** as astronauts report, because your eye is adapted to the bright scene.

### 3.5 Motion comes from the best source available

Each object's position comes from the most accurate source that exists for it:

- **Planets and major moons:** JPL's ephemerides. These are precomputed position tables that JPL fits to decades of radar, spacecraft tracking and telescope data. They're more accurate than any simulation we'd write, and they are data.
- **Everything else** (asteroids, comets, small moons): simulated forward from measured orbits, including the gravitational pull of the planets. This is the kind of massively parallel work the GPU is built for.
- **The error budget is perceptual.** Position errors should be smaller than anything you could notice from where you're standing. Where that isn't possible, the uncertainty is known and can be inspected.

### 3.6 Time is a first-class axis

Every dataset has a reference date and a window when it's valid, and every position has an uncertainty that grows the further you get from the data. The architecture assumes time can eventually run across eons:

- JPL's long ephemeris (DE441) covers roughly 13,000 BC to 17,000 AD.
- Past that we'd need our own simulation, and uncertainty grows fast. The solar system is chaotic, and precise planetary positions become unknowable after some tens of millions of years. Deep time will have to show ranges, not false precision.

**v1 scope: now, plus or minus about a year.** Everything beyond that is structure for later, not features.

### 3.7 Reality settings

There are two independent dials. Whenever either is off its default, the screen says so, so a screenshot never misleads.

**What exists** (which provenance labels are allowed):

| Level | Includes | What it's for |
|---|---|---|
| **Strict** | Measured + Derived | Only what is actually known. Unknowns are shown as unknown. |
| **Best estimate** | + Estimated | Fills in missing attributes of known objects from population statistics. |
| **Complete** | + Synthetic | The full population, including objects not yet discovered. The closest to reality. |

**How it's shown:**

| Mode | Behavior |
|---|---|
| **Naked eye** (default) | Section 3.4, unmodified. The truth. |
| **Enhanced** | The same scene with the eye's limits lifted: exposure boosted, faint objects brightened, points enlarged. |
| **Overlays** (toggles in either mode) | Labels, orbit lines, and provenance coloring, which tints every object or surface by its label. |

The default is **Best estimate + Naked eye** until the synthetic layer exists, then **Complete + Naked eye**.

### 3.8 Rebuildable from raw data

The whole universe is produced by a scripted pipeline that starts from raw downloads. There are no manual steps and no hand-edited files. When a new catalog release ships, rerunning the pipeline updates the simulation.

## 4. Build order

Each phase has to be trustworthy before the next one begins.

**Phase 1: The observed solar system.**
- The Sun, planets, moons, rings, and catalogued asteroids and comets, at their correct positions for now plus or minus a year.
- A star background from star catalogs, since the stars are part of what you'd see.
- Color from spectra, physically correct light and the eye model.
- The Strict and Best estimate levels, overlays and the inspector.

**Phase 2: The complete solar system.** Synthetic small bodies below what surveys can detect, interplanetary dust (the source of zodiacal light), and anything else population models can support. Complete becomes the default level.

**Phase 3: Deep time.** Extend from one year to the full range of JPL's ephemerides, then beyond it with honest uncertainty.

**Phase 4: Beyond the solar system.** Stars become places you can visit, then exoplanets, then eventually a statistical Milky Way built around the stars we've measured. It's the same measured-then-synthetic approach at galactic scale.

## 5. Non-goals

- **Other users.** No accounts, sharing, mobile, low-end hardware or non-Chromium browsers.
- **Artistic enhancement by default.** Beauty comes from accuracy and never substitutes for it.
- **Spaceflight.** Travel is magic: instant, at any speed, to anywhere. Only the view has to be real.
- **Hand-authored content** of any kind.

## 6. Candidate data sources

These are starting points. Each will be verified and pinned to a specific version during research.

| Need | Candidates |
|---|---|
| Planet and moon positions | JPL DE440/DE441 planetary ephemerides; JPL satellite ephemerides (SPICE kernels) |
| Asteroid and comet orbits | Minor Planet Center (MPCORB); JPL Small-Body Database |
| Asteroid sizes and albedos | NEOWISE / WISE thermal modeling |
| Asteroid rotation and shape | Asteroid Lightcurve Database (LCDB); DAMIT shape models; spacecraft shape models |
| Asteroid colors | Gaia DR3 reflectance spectra (about 60,000 asteroids); SDSS Moving Object Catalog; ground-based spectral surveys (SMASS, Bus–DeMeo) |
| Planet and moon colors | Published reflectance spectra; calibrated spacecraft data (e.g. Irwin et al. 2024 for Uranus and Neptune) |
| Surfaces and terrain | Global image mosaics and elevation models from NASA PDS and USGS Astrogeology |
| Sunlight | Measured reference spectra of the Sun's output |
| Stars | Gaia DR3 (positions, distances, and low-resolution spectra for about 220 million stars); Hipparcos and bright-star catalogs for the brightest stars, which Gaia misses or saturates on |
| Population models (Phase 2) | Debiased asteroid size and orbit distributions; near-Earth object population models; survey completeness studies |

## 7. Open questions

1. **Eye adaptation:** is it instant and perfect, or simulated over time? For example, after turning away from the Sun, it would take minutes before faint stars appear.
2. **Display:** is my monitor HDR? That changes how much of the real brightness range can be shown directly.
3. **Unknowns up close:** in Strict mode, what should an object with an unknown shape or surface look like when I fly right up to it?
4. **The Milky Way's glow:** which all-sky measurement do we use for the diffuse light between catalogued stars?
5. **Local data footprint:** the raw data runs from tens of gigabytes to several terabytes, depending on resolution (full Gaia and high-resolution planetary mosaics are huge). Is it all stored and served from my machine?
6. **The observer's frame:** when "hovering," am I at rest relative to the Sun or to whatever I'm near? This changes the view very slightly and is minor.

## Glossary

- **Albedo:** the fraction of light a surface reflects.
- **Ephemeris** (plural *ephemerides*): a precomputed table of where an object is at each moment.
- **Light travel time:** the delay between light leaving an object and reaching you. It means you always see things where they were, not where they are.
- **Population model:** a measured description of how many objects exist at each size and on each kind of orbit, corrected for what surveys miss.
- **Provenance:** where a value came from and how it was produced.
- **Reflectance spectrum:** how much light a surface reflects at each wavelength. It determines the surface's true color.
- **Survey completeness:** the fraction of real objects of a given size and orbit that surveys have found.
