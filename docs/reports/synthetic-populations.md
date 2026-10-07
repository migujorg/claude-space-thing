# Synthetic populations: the COMPLETE level (M6)

Status of milestone M6 (NORTH_STAR §3.3, docs/research/m6-populations.md). The pipeline stage `synthetic` adds 2 969 849 synthetic small bodies: objects no survey has found yet. They fill only what the catalogue is missing, cell by cell in (a, e, i, H). Sections 1–11 describe the asteroid and Kuiper-belt populations (2 948 454 objects); §12 adds the Centaurs and the irregular moons (21 395). The GPU field draws them at the Complete level only; Complete is now the default level. Every synthetic object carries the `synthetic` label on every attribute, with its population model, cell, deficit and seed as provenance.

Numbers here come from the 2026-09-30 build; `docs/reports/synthetic-populations.json` is written by the stage.

## 1. Populations

| population | region | model | completeness limit | faint limit (H_V) | catalogued in grid | synthetic |
|---|---|---|---|---|---:|---:|
| `neo` | q < 1.3 au | Granvik et al. (2018) realization, 802 000 NEOs with 17 < H < 25 | first H bin where the catalogue is 2σ below the model | 25.0 (the model's end) | 42 526 | 775 504 |
| `hungaria` | 1.78 ≤ a < 2.0 au, q ≥ 1.3 | the catalogue plus a debiased slope (Maeda et al. 2021) | Hendler & Malhotra (2020), C = 20.42 ± 0.05 | 20.0 (parameter) | 38 714 | 6 036 |
| `mainbelt` | 2.0 ≤ a < 3.7 au, q ≥ 1.3 | the catalogue plus a debiased slope (Maeda et al. 2021) | Hendler & Malhotra (2020), C = 21.357 ± 0.012 | 20.0 (parameter) | 1 452 459 | 1 987 513 |
| `hilda` | 3.7 ≤ a < 4.2 au, q ≥ 1.3 | the catalogue plus a debiased slope (Terai & Yoshida 2018) | Hendler & Malhotra (2020), C = 21.82 ± 0.13 | 18.25 (measured range) | 8 254 | 14 963 |
| `trojan` | 5.05 ≤ a < 5.35 au | the catalogue plus a debiased slope (Yoshida & Terai 2017) | Hendler & Malhotra (2020), C = 21.53 ± 0.07 | 17.65 (measured range) | 16 136 | 104 528 |
| `tno` | a ≥ 30 au | CFEPS L7 realization, 66 037 objects to H_g 8.5 | first H bin where the catalogue is 2σ below the model | 8.077 (= H_g 8.5) | 7 303 | 59 910 |

The table's last column sums to 2 948 454 objects in 52 969 cells; with the Centaurs and irregular moons of §12, 2 969 849 objects in 59 108 cells. `synthetic/objects.bin` is 142.6 MB (48 bytes per object) and `synthetic/cells.bin` is 4.5 MB. The stage runs in 30–80 s.

Not modelled here: the region between the Hildas and the Trojans, and comets. No debiased model of these was downloaded, so the synthetic layer has none of them. Centaurs and irregular moons: §12.

Sources: `granvik-2018-neo-model`, `cfeps-l7-synthetic-model`, `hendler-malhotra-2020`, `maeda-2021-hsc` (cross-checked by `heinze-2019-decam`), `yoshida-terai-2017-hsc`, `terai-yoshida-2018-hsc`, `petit-2011-cfeps`, `jester-2005-sdss`. Each has a note in docs/sources. The numbers taken from papers are transcribed in `pipeline/src/pipeline/syn_tables/populations.json` with section and table references. The PDFs are kept with their sha256.

## 2. Completeness: where the catalogue stops being complete

The main belt, Hungarias, Hildas and Trojans use the method of **Hendler & Malhotra (2020)**:

- in each 0.01-au bin with ≥ 50 objects, H_lim is the centre of the most populated 0.25-mag H bin;
- H_lim(a) = −5 log10(a (a − 1 au)) + C, with C fitted by weighted least squares (uncertainty (H_max − H_min)/√n per bin) over the paper's region.

C is **refitted to the current catalogue on every build**. For the main belt C = 21.357 today, against 20.28 for the paper's 2019 catalogue: the limit has moved one magnitude fainter (H_lim = 18.5 at 2.5 au, 17.5 at 3.0 au). This is how the layer yields to discoveries at the population level, as surveys deepen. The residual scatter of the per-bin limits about the curve is 0.15 mag (main belt) to 0.22 mag (Hungarias).

For the model-realization populations (NEOs, TNOs), no single survey limit applies. So the limit per a-bin is the lower edge of the first H bin, from bright to faint, in which the catalogue has significantly fewer objects than the model (known < model − 2√model, any e and i). Brighter bins are treated as complete: within Poisson noise, the catalogue already holds everything the model predicts. **No synthetic object is ever brighter than the limit of its a-bin.** The stage asserts this on its output, and both test suites check it on the products (0 violations).

## 3. The debiased model per cell

Cells: a-bins of 0.02 au (NEOs 0.25 au; TNOs 1 au to 50 au, then 5, 25 and 100 au), e bins of 0.05 (NEO, TNO 0.1), i bins of 2.5° (NEO 10°, TNO 5°), H bins of 0.5 mag aligned on multiples of 0.5. The grid is fixed and does not depend on the catalogue.

**Catalogue-extrapolated populations** (main belt, Hungarias, Hildas, Trojans):

- *Normalization:* the catalogue's own count in the complete reference bin [H_lim − 1, H_lim − 0.5) of each a-bin. This is one bin brighter than the limit, because the peak method marks where incompleteness already starts.
- *Fainter than H_lim:* a published debiased slope, dN/dH ∝ 10^(αH):
  - main belt and Hungarias: α = 0.23 ± 0.01 (Maeda et al. 2021, Subaru/HSC, H_V 16.94–20.55). The catalogue's own slope where it is complete at those magnitudes (a 2.12–2.3 au, H 17–18.5) is 0.25, and Heinze et al. (2019) find 0.218 ± 0.026 in apparent magnitude.
  - Hildas: α = 0.38 ± 0.02 (Terai & Yoshida 2018).
  - Trojans: α = 0.37 ± 0.01 (Yoshida & Terai 2017).
- *Bright of the break:* in the outer belt the reference bin lies brighter than Maeda's slope break (H_V 16.94). There the catalogue's own slope, measured over [H_lim − 2, H_lim − 0.5) and pooled over ±0.04 au, is used up to the break (80 of 85 a-bins fitted; 5 fall back to 0.23).
- *Orbit distribution:* f(e, i | a) is that of the complete (H < H_lim) catalogue in the same a-bin, so the cell model is f(e, i | a) × N(a, H). This assumes the (e, i) distribution does not depend on H within an a-bin (families differ).

**Model-realization populations** (NEOs, TNOs): the cell model is the number of realization members in the cell. For TNOs H_V = H_g − 0.423 (mean CFEPS g − r = 0.70; V = g − 0.59 (g − r) − 0.01, Jester et al. 2005). The L7 file's λN = 5.489 was read as radians (314.50°); Neptune's mean longitude at the L7 epoch from DE442s is 314.42°, a difference of 0.08°. Model members are moved two-body from the L7 epoch (2004-06-01) to the small-body epoch.

## 4. Conditioning: fill only what the surveys could not have detected

Per cell, over the conditioned H range [max(bin, H_lim), min(bin, floor)):

- **raw deficit** = max(0, model − catalogued);
- **deficit** = raw × G / Σ raw, where G = max(0, Σ model − Σ catalogued) over the cell's (a, H) group (all e and i).

Clipping cell by cell adds 0.4√N objects per nearly complete cell in expectation. The group scaling removes that bias, and deficit ≤ raw always. Summed over the main belt: raw deficit 2 004 980, deficit 1 987 565.

The cell table records, for every cell: the box, the completeness limit, the model and catalogued counts, the raw and scaled deficits, the rounding offset u0, how many objects it shows and where they start. The inspector reads these to say what a synthetic object stands for (§8).

## 5. Determinism and yield to discoveries

- **Streams.** Every cell has its own random stream: PCG64 seeded with the first 16 bytes of sha256('synthetic-v1|<seed>|<population model>|ia|ie|ii|ih'). The streams are independent of the catalogue.
  - Catalogue-extrapolated populations draw an ordered list of candidates, 10 uniforms each: a, e, i uniform in the cell box; H from the slope law inside the H bin; the angles; the albedo and rotation quantiles.
  - Model populations order their cell's model members by random keys.
- **Shown objects.** The cell shows the first floor(deficit + u0) candidates that pass its current limits (H ≥ H_lim, q ≥ 1.3 au). u0 comes from sha256(same string + '|round'), which makes the rounding unbiased.
- **When the catalogue grows,** the catalogued count rises, the deficit falls, and the list is truncated from its end. The remaining synthetic objects keep their places. If the limit itself moves fainter (C refitted), candidates brighter than the new limit drop out.
- **Determinism.** Rerunning the stage gives byte-identical products (checked: sha256 of objects.bin and cells.bin across rebuilds), and the pytest checks it too. A different seed gives different objects.

Yield test (scratch run on the real catalogue; the pytest runs the Trojan case). We removed N catalogued objects fainter than the limit + 0.6 mag, and compared the synthetic objects shown in the removed objects' (a, H) groups. First with the completeness limit pinned to the original fit (`completenessC`), which isolates the conditioning, then with C refitted:

| population | removed | + synthetic in their groups, C pinned | earlier objects kept | + synthetic, C refitted |
|---|---:|---:|---:|---:|
| Jupiter Trojans | 300 | +300 | all 104 528 | +399 (C moved by 0.001 mag; 191 earlier objects dropped) |
| main belt | 2000 | +1979 | all 1 987 513 | +1996 |
| Hildas | 100 | +90 | all 14 963 | +92 |

The differences from N come from two sources. In groups where the catalogue already exceeds the model, the group deficit stays at 0. And each changed cell rounds its deficit, which adds up to ±½ object per cell. In their own (a, e, i, H) cells the gain is slightly smaller (Trojans +280, main belt +1876): part of each group's gain goes to its other cells through the group scaling.

## 6. Physical attributes and labels

Every attribute of a synthetic object is labelled `synthetic`. The sources are:

- its population model, the completeness method and the catalogue snapshot (the core product's sha256 is in the header, and the app refuses a layer built for another catalogue);
- for each attribute, the measured sample it was drawn from:
  - **p_V and colour class:** a quantile draw from the measured albedos of real objects of the same population near the same a. The sample is NEOWISE / SBDB, widened to ≥ 200 objects; TNOs have only 12. The draw takes that object's colour class (`smallbody-class-colors`), whose mean colour lights the point.
  - **Diameter:** D = 1329 km / √p_V · 10^(−H/5).
  - **Rotation period:** a quantile draw from LCDB periods of quality U ≥ 2− among real objects of similar diameter (0.2-dex bins, ≥ 50 each).
  - **G** = 0.15, the conventional value the catalogue also uses where no G is fitted.

Quantile draws keep an object's attributes nearly stable when the template samples grow.

**Semantics.** `synthetic` means the whole object is a sample from a population model; `estimated` stays what it was, a population statistic or assumption applied to a *real* object, such as the class colour of an asteroid without a spectrum. This stage changes no real object.

**Selection biases of the templates** (not corrected):

- NEOWISE albedos at faint H are biased dark: at fixed H a dark object is larger and easier to detect in the thermal infrared. Main-belt median p_V is 0.16 at H 12–14 and 0.06 at H 16–18. The pool uses every H, so its median is 0.079.
- LCDB periods favour short periods and large amplitudes.

## 7. Faint limits and budgets

The faint limit (H floor) is a parameter per population: `SYNTHETIC_PARAMS='{"hFloor": {"mainbelt": 19.5}}'`. The defaults are:

- **NEO 25.0, Hildas 18.25, Trojans 17.65, TNO 8.077:** the faint end of the model or of the survey that measured the slope. The layer never extrapolates beyond a measured range.
- **Main belt and Hungarias 20.0:** a budget choice inside Maeda's measured range. The stage refuses floors beyond H_V 20.55. Main-belt synthetic counts by floor: H 19.0 → 0.62 M, 19.5 → 1.18 M, 20.0 → 1.99 M, 20.5 → 3.09 M.

The default gives catalogue + synthetic ≈ 4.5 M objects. On the GPU that is 32 bytes of elements per synthetic object and 32 bytes of point record per object: 189 MB for the layer, and a 145 MB records buffer. The records buffer is larger than the WebGPU default binding size of 128 MiB. The renderer requests the adapter's limits; where the device cannot bind it, the field draws no synthetic objects and says why (Data panel and a message). Tens of millions of objects would need the records split over several bindings. The design allows it, but it is not done.

For the eye, H 20 is far below anything visible (§9), so a fainter floor changes counts and diagnostic views only.

## 8. Rendering and the app

**GPU.** `SmallBodyField` puts the synthetic records after the catalogue's in the same point buffer (index = catalogue count + j), so the renderer hook, pick and record layout are unchanged. The kernel `syntheticShader`:

- moves each object on its fixed Kepler ellipse, with the mean motion and mean anomaly in double-single and the rest in float32;
- evaluates sin/cos with Cody-Waite reduction and the Cephes minimax polynomials. WGSL's built-in sin/cos only guarantee 2^−11 absolute accuracy; on SwiftShader that moved objects by ~1e-4 of their distance;
- applies the light time and H-G photometry with the class colours.

The records are zero below Complete: nothing is drawn or pickable, and one clearBuffer runs on the switch. Against float64 two-body positions of the same elements, for 20 000 objects over ±548 d (test page mode=synthetic, SwiftShader):

- direction p50 1.1e-7 rad, p99 8e-7 rad, max 8e-6 rad (1.7″; the largest errors are distant TNOs);
- photometry within 0.0007 mag for V < 30. The ~V 36 extreme TNOs differ by up to 3 mag, because the device's exp2 is coarse there; that is 10 magnitudes below anything visible.

Pick finds a synthetic object at Complete and returns nothing at Best. With the full catalogue + 2.95 M synthetic objects, a Complete frame's field work on SwiftShader takes 8.0 s against 4.9 s at Best. On a hardware GPU the layer is one pass over ~190 MB per frame, of the order of a millisecond (an estimate from the memory traffic; no hardware GPU was available to measure it). The layer's GPU memory is 189 MB, next to the 1 GiB checkpoint budget of the catalogue.

**App.**

- `data/smallbodies.ts` loads `synthetic/objects` and `cells` with the small-body tables, integrity-checked, and refuses a layer conditioned on another catalogue product (core sha256).
- `SmallBodies` treats rows count … count + 2 948 453 as synthetic. They have:
  - a name that says what they are (e.g. "Synthetic main-belt asteroid #12,346");
  - no flags;
  - position label `synthetic`, so the reality filter admits them, their ring and label included, at Complete only;
  - float64 two-body positions and a Kepler orbit track;
  - no resolved shape, and a navigation radius from D(H, p_V).
- The HUD reads "N catalogued + M synthetic small bodies drawn / K withheld at Complete". The Data panel lists the layer per population.
- **Complete is the default level** when the build has a synthetic layer and small bodies are enabled (reality.ts `defaultReality({ syntheticLayerAvailable })`, driven by the manifest; with `smallbodies=0` Best estimate stays the default). A level chosen by the user or the URL is kept.
- The **inspector** of a synthetic object opens with "What this is", for example: "Not a real object. It stands in for one of ~N undiscovered main-belt asteroids in its cell (a …, e …, i …, H …). The model (…) expects X objects there; the catalogue has Y, complete down to H_lim at this a, so D are missing and S synthetic objects are shown in this cell. When surveys find more, …". It then lists the rows "Stands in for", "Survey completeness limit here", "Seed and place in the cell" (the stream string and candidate number), orbit, H, G, p_V, diameter and rotation, each with the `synthetic` chip, its method and sources.

## 9. Verification

- **Catalogue + synthetic vs the debiased model**, per population and H bin (`img/synthetic-h-distributions.svg`, written by the stage; `wholePopulation` in the JSON). The cumulative N(<H) of catalogue + synthetic follows the model to:
  - 0.03 % (main belt, N(H < 20) 3 400 940 vs 3 400 726);
  - 0.1 % (Hungarias, Trojans) and 0.5 % (Hildas);
  - 3.5 % (NEOs) and 11 % (TNOs) at the bright end. There the catalogue is within 2σ of the model and no synthetic objects are added; by H ≥ 20 (NEO) and ≥ 6.5 (TNO) the difference is below 1 %.

  The pytest requires < 5 % per bin with > 2000 model objects, and < 3 % per population. Over the whole belt, the catalogue holds 94 % of the model at H 17–17.5 (216 167 of 229 831) and 6 % at H 19.5–20 (53 578 of 862 431).
- **Completeness guard:** no synthetic object brighter than its cell's limit (stage assertion; pytest and vitest on the products: 0).
- **Determinism:** same seed → byte-identical products; a new seed → different objects (pytest).
- **Yield:** §5.
- **GPU vs CPU:** §8.
- **Screenshots:**
  - `img/synthetic-inside-belt-eye.png`: inside the main belt at 2.7 au, at Complete, naked eye, looking away from the Sun. It is still nearly empty. All 4.5 M small bodies are drawn with their brightness, but none reaches the eye's limit of V 7.6: the brightest catalogued one is V 7.8, the brightest synthetic one V 14.1. The 4650 points are stars.
  - `img/synthetic-diagnostic-known-vs-synthetic.png`, written by the stage: a DIAGNOSTIC data plot, not a rendering. Catalogued objects are cyan and synthetic objects orange, in log density.
    - Left: positions at the epoch seen from ecliptic north. You can see the synthetic NEOs inside 2 au, the belt, the two Trojan swarms 60° ahead of and behind Jupiter, and the Hildas.
    - Right: the a–H plane with each a-bin's completeness limit in white. The synthetic objects lie only below the line (fainter), fill the belt down to the floor at H 20, and follow the Kirkwood gaps of the catalogue above them.
  - `img/synthetic-render-best-vs-complete.png`: the same diagnostic camera rendered twice. The camera is 3 au above the Sun, looking down at the belt beyond it, with an 8° field, the Sun and stars left out, and enhanced exposure of +24 stops (limiting V 25.7). Left, at Best, the catalogue alone draws 40 797 points; right, at Complete, catalogue + synthetic draw 62 125. The synthetic objects are fainter than the catalogue's by construction, so even this far beyond the eye they add a faint haze of points, not a new structure. The eye model renders such faint points scotopic (grey), so the test page's false-colour option (`syntint=1`) cannot separate them in a render. The data plot above does that.
  - `img/synthetic-app-inspector.png`: the app at its default level (Complete) with a synthetic main-belt asteroid selected, showing the inspector and the HUD counts.

## 10. Limitations

- Synthetic orbits are statistical samples on fixed two-body ellipses. They are not integrated with planetary perturbations: that would add nothing a synthetic object could claim. Positions on the GPU are good to ~1e-7 of the distance, so there are no close-ups of synthetic objects.
- Within a cell, a, e and i are uniform. Within an a-bin, (e, i) comes from the bright catalogue; families and their different size distributions are not modelled separately.
- The main-belt slope is one slope for the whole belt: Maeda's sample reaches R ≤ 3.0 au, and the outer belt and Hungarias use it by assumption. The slope's ±0.01 changes the synthetic main belt by −5.4 % / +5.6 % (1.88 M / 2.10 M at H 20).
- The layer is conditioned on the SBDB snapshot. Its known counts include single-opposition objects: they were detected.
- Template-based attributes carry the selection biases of their samples (§6). TNO albedos rest on 12 measured values.
- The NEO realization's angles are unconstrained samples.

## 11. Reproduce

```
cd pipeline && uv run python -m pipeline build --only synthetic      # needs smallbodies (and its inputs)
uv run pytest tests/test_synthetic.py
cd ../app && npx vitest run tests/smallbody-synthetic.test.ts
node scripts/sb-gpu.mjs --query "mode=synthetic" --json out/sb-synthetic.json
node scripts/sb-gpu.mjs --query "mode=render&scene=inside&level=complete" --out ../docs/reports/img/synthetic-inside-belt-eye.png
node scripts/sb-gpu.mjs --query "mode=render&scene=above-off&level=best&nosun=1&nostars=1&boost=24&fov=8" --out zoom-best.png
node scripts/sb-gpu.mjs --query "mode=render&scene=above-off&level=complete&nosun=1&nostars=1&boost=24&fov=8" --out zoom-complete.png   # side by side
```

The app screenshot is the default view, followed in the page by `__app.select(id)` and `__app.goTo(id, 3e6, true)`, with id = −(row + 1) and row = core count + main-belt `firstObject` + 12 345. Its state (counts, level, "why" line) is in `img/synthetic-app-inspector.json`.

## 12. Centaurs and irregular moons

Added 2026-10-01: 20 937 synthetic Centaurs and 458 synthetic irregular moons (435 of Jupiter, 23 of Saturn, none of Uranus or Neptune). The rules are those of §§2–6: each cell gets only its deficit below a completeness limit measured against the current catalogue, the streams are per cell, and every attribute is `synthetic`. The 2 948 454 objects of §§1–11 are unchanged, byte for byte: the new populations come after them in `objects.bin` and `cells.bin`. Code: `pipeline/syn_outer.py`; the numbers taken from papers are transcribed with section and table references in `syn_tables/populations.json` (`centaurs`, `irregularMoons`).

| population | model | conditioned on | limit (H_V) | faint limit (H_V) | known | synthetic |
|---|---|---|---|---|---:|---:|
| `centaur` (q > 5.2 au, 5.35 ≤ a < 30 au) | Kurlander et al. (2025): 21 400 (+3 400/−2 800) with H_r < 13.7; Nesvorný et al. (2019) orbits, Lawler et al. (2018) H law | SBDB (`smallbodies` core) | per a-bin, model comparison (§2) | 13.965 (= H_r 13.7) | 441 | 20 937 |
| `irregular-jupiter` (retrograde) | Ashton et al. (2020): 600 (within a factor of 2) with m_r < 25.7, 160 ± 60 with m_r < 24, α = 0.29 ± 0.15 | MPC natural-satellite elements | 17.63 | 19.33 (= m_r 25.7) | 92 | 435 |
| `irregular-saturn` | Ashton et al. (2021): 150 ± 30 with D > 2.8 km (m_w < 26.3), q = 4.9 (+0.7/−0.6) for D 3.8–2.8 km | MPC | 16.00 | 16.32 (= m_w 26.3) | 268 | 23 |
| `irregular-uranus` | none below the limit | MPC | complete to m_r ≈ 26.5, H_V ≈ 13.6 (Sheppard et al. 2024) | – | 10 | 0 |
| `irregular-neptune` | none below the limit | MPC | complete to m_r ≈ 27.0, H_V ≈ 12.3 (Sheppard et al. 2024) | – | 8 | 0 |

New sources (notes in docs/sources): `kurlander-2025-archive` and `kurlander-2025-centaurs`, `murtagh-2025-lsst-centaurs`, `nesvorny-2019-ossos-centaurs`, `mpc-natsats-{jupiter,saturn,uranus,neptune}`, `ashton-2020-jupiter`, `ashton-2021-saturn`, `ashton-2025-saturn`, `sheppard-2005-uranus`, `sheppard-2006-neptune`, `sheppard-2024-uranus-neptune`; and `grav-2015` (already used by the light stage) for albedos. All are open access. The publisher serves the Ashton et al. (2021) PDF to scripted clients behind a bot check, so the copy used was fetched with a browser user agent and its sha256 is pinned (the mechanism of the other bot-checked documents).

### 12.1 Centaurs

**The model.** The only published Centaur model with a debiased normalization that can be downloaded is the "literature population" of Kurlander et al. (2025). It combines the orbital distribution of the Nesvorný et al. (2019) dynamical model with H drawn from the Lawler et al. (2018) knee law (slope 0.9 → 0.4 at H_r 7.7, H_r < 13.7): 26 116 868 members, of which their Zenodo archive keeps the 856 822 with apparent magnitude 21 < m < 23.5. Their survey normalizes it to 21 400 Centaurs with H_r < 13.7 (Nesvorný et al. 2019 found 21 000 ± 8 000 from OSSOS). The archive's population is q > 5.2 au, a < 30 au (the MPC definition): the Gladman cuts (q > 7.35 au, T_J > 3.05) are not applied, so its Jupiter-crossing members are included.

**Undoing the archive's selection.** H was drawn independently of the orbit, so a member with distance modulus d = m − H was kept with probability P(d) = F(23.5 − d) − F(21 − d), with F the H law's cumulative fraction. Weighting each member by 1/P(d) recovers the whole model (a Horvitz–Thompson estimate). Two checks, both independent of the synthetic layer:

- **The H law is the one stated.** In slices of d, the members' H follow the law restricted to [21 − d, 23.5 − d]: χ² per bin 0.92 over 146 bins for the knee as a differential law (continuous dN/dH), against 61.8 for the other reading (cumulative law continuous at the knee). The first is used.
- **The weights add up to the model.** Σ 1/P = 25 845 299 against the archive's 26 116 868 (0.990). The 1 % missing are model states that could never have been selected (r ≲ 5.6 au: always brighter than m = 21). The effective sample size is 118 078.

**The realization.** 21 400 members (the normalization). Each takes (a, e, i) by systematic resampling of the archive's members with weights 1/P (21 125 distinct orbits), H_r from the knee law by inverse transform, and uniform angles, as Murtagh et al. (2025) do because the model's angles are uncorrelated. H_V = H_r + 0.265: V − r = 0.41 (g − r) − 0.01 (Jester et al. 2005), with g − r = 0.67 from the 3:1 mix of less-red (Bienor-like) and red (Pholus-like) colours of Murtagh et al. (2025). The realization is seeded from a fixed string in the tables. Like the NEO and Kuiper-belt realizations, it is a fixed input, independent of the catalogue and of the stage seed.

**Conditioning.** As for the NEOs and TNOs (§§2–5). Cells are 1 au in a (5.35–6 au, then 6–30 au), 0.1 in e, 5° in i (0–180°) and 0.5 mag in H. The limit per a-bin is the first H bin in which the 441 catalogued Centaurs number fewer than model − 2√model. Inside 10 au the model never exceeds the catalogue by that much (it has few Centaurs there), so no synthetic Centaur has a < 10.18 au. Farther out the limit falls from H_V 13.5 at 10–11 au to 7.5–8.5 at 26–30 au. The conditioned cells hold a model of 21 176, with 240 catalogued in their groups: deficit 20 936, shown 20 937. Per H bin, catalogued + synthetic = model within 1 % where the model has more than 2 000 (H 12.5–13: 3 244 vs 3 254; 13–13.5: 5 049 vs 5 061). The 44 catalogued comets in the region (29P and others) have no nuclear H and are not counted (`cataloguedCometsNotCounted`).

**No double counting.** The Centaur grid starts at a = 5.35 au, the Trojan grid's upper edge, so the 176 catalogued objects with q > 5.2 au and a < 5.35 au stay Trojans. It ends at 30.0 au, where the Kuiper-belt grid starts. The model has no members inside 5.37 au; 18 at a ≥ 30 au or q ≤ 5.2 au are dropped. The pytest checks that the grids do not overlap and that every synthetic Centaur has q > 5.2 au.

**Attributes.** p_V and colour class are quantile draws from the 34 measured Centaur albedos in the catalogue (NEOWISE/SBDB; p_V 0.041–0.215; 28 with the `population` colour class, three D, one each Ch, K and S). Rotation comes from LCDB by diameter (§6). Synthetic Centaurs have H_V 7.6–14.0 and D 4.6–168 km (median 11 km). The brightest could reach V ≈ 18.4 from the Earth at opposition, so none is visible to the eye.

### 12.2 Irregular moons

**The known moons** are the MPC's (`mpc-natsats-*`): planet-barycentric osculating elements in the ecliptic J2000 frame, and H_V. All are in the app's moon list (`bodies.json`, NAIF kernels) except Jupiter LXXIII and Saturn LXVII, which the MPC lists by number only. The app's provisionally designated S/2003 J 2, S/2025 J 1 and S/2004 S 7 are probably those same moons, and S/2009 S 2 (four Cassini images) is in no ground-based list. The stage prints this cross-match.

**The models** come from each planet's deepest *debiased* survey, which is not always its deepest discovery survey:

- **Jupiter** (Ashton et al. 2020; CFHT, 2010; characterisation limit m_r = 25.7): 160 ± 60 retrograde moons with m_r < 24 and 600 (within a factor of 2) with m_r < 25.7, differential slope α = 0.29 ± 0.15. The model is the 440 moons between m_r 24 and 25.7, with that slope. Prograde jovians are not in it (they were not debiased), so none are added.
- **Saturn** (Ashton et al. 2021; CFHT, 2019): 150 ± 30 moons with D > 2.8 km (m_w 26.3), and q = 4.9 for D 3.8–2.8 km, i.e. N(<m) ∝ 10^(0.78 m) over m_w 25.7–26.3 (99 moons in that range).
- **Uranus and Neptune** (Sheppard et al. 2005, 2006, 2024): the outer satellites are "nearly complete" to m_r ≈ 26.5 (D ≈ 8 km) and 27 (D ≈ 14 km). No population fainter than that is published (the only slope is measured above the limit). The layer does not extrapolate beyond a measured range, so it adds nothing there.

**Putting the models on the H_V scale.** The surveys give apparent magnitudes in their own bands. Their own photometry of known moons gives the offset to the MPC's H_V, and that offset absorbs the geometry, the phase angle and the colour:

- Jupiter: H_V = m_r − 6.37 ± 0.06 (median of 7 moons in Ashton et al. 2020 Table 1, robust σ 0.13; Jupiter LI is a 1.7-mag outlier that the median ignores).
- Saturn: H_V = m_w − 9.98 ± 0.05 (22 moons in Ashton et al. 2021 Tables 1–2, robust σ 0.17; 10 designations renumbered since 2021 are not matched).

**Completeness limit.** The model-comparison rule of §2 is applied over H bins, to all known moons of the class, giving one limit per planet:

| planet | H_V bin | model | known | 2σ short? |
|---|---|---:|---:|---|
| Jupiter (retrograde) | 17.63–18.0 | 58.4 | 1 | yes → limit 17.63 |
| | 18.0–18.5, 18.5–19.0, 19.0–19.33 | 105.7, 147.6, 128.2 | 0 | yes |
| Saturn | 15.72–16.0 | 33.4 | 26 | no |
| | 16.0–16.32 | 65.6 | 46 | yes → limit 16.0 |

The limits lie fainter than the surveys' own statements of completeness. Sheppard et al. (2024) give Jupiter as "complete to about 2 km" and Saturn "to about 3 km" (albedo 0.1), i.e. H_V ≈ 16.6 and 15.7, so no synthetic moon is brighter than what they report as complete. Saturn's catalogue now holds 115 moons brighter than the model's faint end, against the model's 150 ± 30: the 2023 discoveries (Ashton et al. 2025, RNAAS 9, 57) have nearly caught up with the 2021 estimate, and only the last 0.3 mag is still short.

**Orbits: an assumption about the unseen population.** The generator does not ingest a debiased orbit distribution for Jupiter's or Saturn's irregular moons. It uses bright known moons as templates: the MPC (a, e, i) of the modelled class with H_V brighter than the completeness limit and inside the grid (Jupiter: retrograde only; Saturn: all outer irregulars). The reported build has 91 jovian retrogrades in 42 cells and 69 saturnians in 60, in cells of 0.01 au × 0.1 × 5°. A cell's model is the luminosity model's count in the H bin times the cell's share of those bright templates (`syn_outer.template_cells`). Known moons are subtracted and the deficits conditioned before sampling. Within an occupied cell, a, e and i are uniform, and the node, argument of pericentre and mean anomaly are independently uniform over 0–360° (`syn_model.sample_extrapolated`, `synthetic.assign_angles`). The synthetic moons therefore occupy the bright known families' cells (see the diagnostic below); they are not copies of individual known orbits. The `synthetic/objects.json` header states the orbit assumption (`populations[].model.orbitDistribution`), and the inspector repeats it.

**Against NORTH_STAR §3.3 rule 1.** Carrying the bright templates' orbit distribution into the faint, unseen population assumes that its cell proportions remain the same. No survey selection correction is applied to the orbit templates. The cited debiased luminosity functions constrain the number and H distribution, but the generator's orbit distribution remains an assumption, rather than a debiased survey model. It therefore falls short of [the rule requiring size and orbit distributions corrected for survey bias](../../NORTH_STAR.md#33-missing-data-is-not-missing-reality). The `synthetic` labels and explicit method text disclose this limitation; they do not resolve it or relax the rule. See [the MPC source note](../sources/mpc-natsats.md#caveats).

**Attributes.**

- **p_V:** a quantile draw from the NEOWISE albedos of the planet's irregulars (Grav et al. 2015 Table 3): seven retrograde jovians, 0.029–0.052; for Saturn, Phoebe, Albiorix and Siarnaq, 0.050–0.10.
- **Colour:** grey (the solar colour), because no irregular-moon colours are transcribed. The app draws the real irregular moons grey for the same reason (`grav-2015` note). A synthetic moon has `colorClass` 255 (header `grey`).
- **Rotation:** unknown (NaN in the binary product); the inspector shows an `unknown` row. G = 0.15, as for every synthetic object.

Synthetic jovian moons have D 0.8–2.3 km (V ≥ 24.3 from the Earth), saturnian ones D 2.3–3.7 km (V ≥ 25.5).

**Motion.** The elements are about the planet-system barycentre (`populations[].center`: its NAIF id and the system GM from gm_de440). The moons move on fixed Kepler ellipses, with their angles at the small-body epoch, so a synthetic moon follows its planet. A synthetic moon's position is a statistical sample anyway, so these are neglected:

- the Sun's perturbation: precession of the node and pericentre by a few degrees over the ±18-month window, and short-period terms of a few per cent of a;
- the planet's oblateness;
- the other moons.

### 12.3 The app

- `core/smallbodySynthetic.ts`: `syntheticState(s, j, et, center)` adds the barycentre's heliocentric state, taken from the planetary ephemeris (`centerStateFrom`). `syntheticRelativeState` and `syntheticMu` give the orbit about the centre.
- GPU (`syntheticShader`): bits 8–15 of each object's colour word select its centre (0 = the Sun, up to 4 planets) and that centre's GM (df64). Each frame the CPU sends every centre's camera-relative position (the float64 difference, as float32) and SSB velocity. A moon's direction is then good to ~1e-7 of its distance from the planet, whatever the camera's distance from the Sun. Light time and phase angle work as before; the moon's SSB velocity is its own plus the barycentre's.
- The orbit track of a selected synthetic moon is drawn around the planet's current position. The inspector says which model, planet and calibration a moon stands for, and that its orbit distribution is an assumption. Names read "Synthetic Centaur #…" and "Synthetic irregular moon of Jupiter #…". As every synthetic object, they appear at Complete only.

### 12.4 Checks

- **Determinism and yield** (pytest `test_centaur_yield_to_discoveries`, `test_irregular_moons_yield_to_discoveries`):
  - Removing the catalogued Centaurs at least 0.5 mag fainter than their a-bin's limit raises the synthetic count in their (a, H) groups by as many, within rounding. Every earlier synthetic Centaur is kept (same cell, same place in its stream).
  - "Discovering" 30 synthetic jovian moons (adding them to the MPC list) removes about 30 synthetic ones, all of which were shown before, and leaves the limit unchanged.
  - The same inputs give identical objects. Rebuilding the stage leaves the 2 948 454 earlier records byte-identical (`cmp` on `objects.bin` and `cells.bin`).
- **Completeness guard:** no synthetic object is brighter than its cell's limit (stage assertion; pytest and vitest: 0).
- **Population totals:** for every population, the model equals catalogued (in the cells' groups) + synthetic within rounding (pytest).
- **The archive reconstruction** (pytest `test_centaur_archive_reconstruction`): the H-law check and Σw / model size above. A unit test also checks the knee law's inverse and the selection weights on a simulated sample.
- **GPU vs float64** (`node scripts/sb-gpu.mjs --query "mode=synthetic"`, SwiftShader, 20 000 random objects plus all 458 moons, ±548 d):
  - moons: direction error p50 4e-8 rad, max 1.3e-7 rad; photometry within 0.0007 mag;
  - the other populations as in §8 (p50 1.1e-7, max 7e-6 rad);
  - with the camera 0.2 au from Jupiter (`&syncam=5`): moons p50 1e-7, max 1.9e-6 rad (≤ 60 km at their distance), photometry within 0.0015 mag. The other objects' worst photometry there is one Kuiper-belt object at V 29.8, where the device's exp2 is coarse (§8).
- **Figures:**
  - `img/synthetic-h-distributions.svg` has five new panels (cumulative model, catalogue, and catalogue + synthetic).
  - `img/synthetic-diagnostic-centaurs-moons.png` is a DIAGNOSTIC data plot, not a rendering. Left: catalogued Centaurs (cyan) and synthetic ones (orange), seen from ecliptic north within 32 au. Middle and right: the (a, i) plane of Jupiter's retrograde and Saturn's irregular moons, known (cyan) and synthetic (orange); the synthetic moons sit in the cells of the known families.
  - `img/synthetic-moon-inspector.png`: the app at Complete (2026-10-15, orbits on) with a synthetic retrograde moon of Jupiter selected from 0.4 au. Its orbit (yellow) is drawn around Jupiter among the real irregular moons' orbits (grey, NAIF kernels), and the inspector says what it stands for. Taken like the main-belt screenshot of §9 (`__app.select(id)`, `__app.goTo(id, 6e7, true)`, id = −(row + 1), row = core count + `irregular-jupiter` `firstObject` + 12). State in `img/synthetic-moon-inspector.json`. The HUD counts 2 969 843 synthetic objects drawn at Complete.

### 12.5 Limitations

- The Centaur normalization is uncertain by +16/−13 % (Kurlander et al. 2025). Their survey also rejects the model's joint (a, e, i, H) distribution while accepting each marginal: it sees fewer Centaurs at a < 18 au, and more at 18–20.5 au, than the model. The synthetic Centaurs inherit the model's joint distribution.
- The Jupiter model is uncertain by a factor of 2. Its normalization rests on one field 1.5° west of Jupiter, scaled by the known moons' sky distribution (a multiplier of 11 ± 5).
- The Saturn deficit (22 moons) is smaller than the model's own ±30 uncertainty. It is shown because the rule is the same for every population.
- Irregular-moon orbits are the known moons' (an assumption). Prograde jovians, and Uranian and Neptunian moons fainter than the completeness limits, are absent for want of a published population.
- Centaurs with q > 5.2 au and a < 5.35 au are counted as Trojans. The Centaur-region comets are not counted in the conditioning.

### 12.6 Reproduce

```
cd pipeline && uv run python -m pipeline build --only synthetic      # needs smallbodies and bodies
uv run pytest tests/test_synthetic.py
cd ../app && npx vitest run tests/smallbody-synthetic.test.ts
node scripts/sb-gpu.mjs --query "mode=synthetic" --json out/sb-synthetic.json
node scripts/sb-gpu.mjs --query "mode=synthetic&syncam=5" --json out/sb-synthetic-jupiter.json
```
