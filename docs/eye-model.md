# Human eye model v1

The renderer turns absolute light into what a human eye placed in the scene would perceive
(NORTH_STAR §3.4 step 4). This document explains each stage, where every number comes from, what we
chose where the literature offers alternatives, and where we deviate from a published model.

**Changes in v1 (M2):** rods follow Hunt's model instead of Pattanaik's abbreviation, which removes
v0's mesopic brightness dip (§4, §10); loss of colour at low light uses Pattanaik's own colour
exponent (Eq. 3) instead of a rod-share mix (§5); the Watson (2013) optical MTF now carries the square
root of the diffraction MTF, as in the published formula (§3); CIE 146, CIE 191 and Watson 2013
constants were cross-checked (§9). **Fixes after real-data review:** point sources are drawn as sharp
points whose *brightness* (not size) follows Ricco summation, with their own colour, and glare is painted
only for light the display cannot show (§3, §6.3); the adaptation statistic is the log-average (§2);
unlit hemispheres are black (and occlude the stars behind them) even where the reflectance or phase
curve is unknown: the "not measured" hatch marks only the sunlit part, whose brightness is what is
unknown (geometry alone says the night side receives no direct sunlight).

**Changes in v2 (M3): fixations.** A scene is perceived over many fixations, not from its geometric
centre (§2 "Fixations").
- The extended image adapts to where the eye looks: fixations are drawn over the whole frame in
  proportion to the light of the objects there, so a quarter Moon filling the view is seen adapted to its
  sunlit half, not to the night side under the view centre.
- Point sources are judged at their own fixation, adapted to their own background, which is Crumey's
  experimental condition. Faint stars therefore stay visible beside a bright planet the extended image is
  adapted to.

Code: `app/src/eye/` (pure TypeScript reference, unit-tested) and the per-pixel mirror in
`app/src/render/shaders.ts`. Constants live in `app/src/eye/constants.ts`, each next to its citation.
Observer and display *settings* (age, pigmentation, field factor, display peak) are in
`app/src/eye/settings.ts`.

```
HDR scene (X, Y, Z, S luminance, cd/m²)          points (stars, unresolved bodies) as luminance E/Ω
        │                                                  │
        ├──► intraocular scatter (CIE 146) ──► veil ◄──────┤   §3  (+ analytic veil: Sun, off-frame bodies)
        │                                                  │
        ├──► adaptation: fixations weighted by light ──────┼──► A_cone, A_rod (extended image), pupil (Watson & Yellott)   §2
        │                                                  │
        │    points at their own fixation: Crumey threshold, response, colour at the local background   §2 §6
        │                                                  │
        └──► perceived image: resolved bodies at their own luminance ─► rod + cone responses (Pattanaik 2000; rods: Hunt)
               ─► display response ─► display luminance ─► colour (mesopic, CAT02) ─► sRGB   §4 §5 §7
```

## 1. Inputs and units

The HDR buffers hold **luminance** in absolute photometric units (docs/architecture.md §4.1):
X, Y (photopic cd/m²), Z and S (scotopic cd/m², V′(λ), K′m = 1700 lm/W). Point sources arrive as
illuminance at the eye (lux) and are splatted energy-conservingly: a normalised footprint `g` (per
pixel²) gives pixel luminance `E·g/Ω_pixel`, with Ω_pixel the exact solid angle of the pixel under the
rectilinear projection, so Σ L·Ω = E. The scotopic channel is what makes rods, the Purkinje shift and
scotopic thresholds computable; it is never derived from XYZ.

## 2. Adaptation and pupil

**Fixations (v2).** A person does not look at the geometric centre of a view: a scene is perceived
over many fixations. Ward Larson, Rushmeier & Piatko (1997) treat every foveal field of the image as a
possible fixation, and their visibility-matching operator is built on the distribution of the
adaptation levels those fixations meet. We keep one adaptation state for the extended image (a global
operator: region brightness keeps its order, with no halos). It is the state the eye settles to while it
looks around the frame, and fixations are not uniform over the frame:

- **Where the eye looks.** Fixations go to the objects in the frame in proportion to their light, i.e.
  to the unscattered scene luminance. Dark background attracts nothing. The glare haze around a bright
  source is in the eye, not in the scene, so it attracts nothing either.
- **Only what can be seen draws the eye (M5).** The scene luminance L is an increment on the retinal image
  L_r there, and it is weighted by clamp(L/(L_r·C∞(L_r)) − 1, 0, 1): no weight below Crumey's (2014)
  large-target threshold contrast C∞, full weight from 2·C∞ (`eye/fixation.ts fixationWeight`). C∞ is at
  most 0.13 (at 10⁻⁵ cd/m²) and 0.002 in daylight, so anything brighter than its surroundings keeps its
  full weight. What it removes is light buried in a far brighter veil. With the M4 sky, the zodiacal light
  a degree from the Sun (10⁻⁴ of the veil there) drew every fixation next to the Sun: the sun-1au scene
  adapted to 1.8·10⁵ cd/m² and showed only the solar core. An observer cannot look at what cannot be
  seen there. The solar corona (docs/reports/sky.md §5) is the same case. Beside the bare Sun it is about
  10⁻⁴ of the veil and draws nothing: sun-1au adapts to 2266 cd/m² with or without it. In totality
  nothing veils it, so it sets the adaptation (203 cd/m² in eclipse-2027-totality).
- **What it adapts to there.** At each fixation the eye adapts to the retinal image: the object plus the
  veil falling there (Moon & Spencer 1945; "Statistic" below).

So A = exp(Σ w·Ω·ln(L_ret + L₀) / Σ w·Ω) over the frame, w the weight above (`eye/fixation.ts`; GPU:
`ADAPT_SHADER`). The resolved solar disk is never fixated: it cannot be looked at. Its veil still
counts wherever the eye looks.

That holds at every angular size since October 2026. Before, the shader decided "inside the disk" by
comparing a cosine in 32-bit floats, and one step of a 32-bit float below 1 is the cosine of 1.2′. A solar
disk a few arcminutes or less in radius could not be told from the sky around it, some of its pixels drew
fixations, and at 1.5·10⁹ cd/m² they took all of them. The Sun from 9.5 au at a 5° field adapted the frame
to 5·10⁸ cd/m² and was shown as a grey disk without glare; it now adapts it to 2500 cd/m² and is shown at
display white with its glare, as from 1 au. The test compares the chord between the two directions with
the chord of the disk's radius (`eye/fixation.ts inSkyDisc`). The Sun shield's occulting disc (§8b) used
the same cosine and let 500 to 1900 cd/m² of corona through inside a small disc; it uses the same chord
now.

Consequences of the fixation rule:

- A quarter Moon filling the view is seen adapted to its sunlit half, even when the view centre falls on
  the night side (the v1 rule saturated the lit half to white).
- A small bright body in a dark field (the Moon from Earth, a planet in a star field) sets the adaptation
  by its light rather than its area. A 1° log-average around it would be pulled down by the black sky
  that fills most of the field. The physiology allows this down to the scale of cones: the gain of the
  cone pathways is regulated within 13.5″ to 19″ and within about 20 ms (MacLeod, Williams & Makous 1992;
  He & MacLeod 1998), so the cones under the image of a disk the eye resolves adapt to that disk.
- A body drawn resolved is therefore shown at its own luminance at that adaptation, whatever its angular
  size: it carries no Ricco weight (§6.3 "Point or disk"). Until October 2026 a resolved body smaller
  than the Ricco area was dimmed by A_t/A_R while the adaptation was measured from its undimmed light, and
  a sunlit moon a few arcminutes across was drawn black.
- Of two bodies in view, the brighter and larger dominates. The crescent Earth beside the Moon is seen
  adapted mostly to the Earth, so the Moon (albedo 0.12 against the Earth's 0.3) looks darker, as in the
  well-known spacecraft images.

**Point sources at their own fixation.** Point sources are judged at their own fixation. This covers
the visibility threshold, the Ricco area, the tone response, the colour exponent and the mesopic state.
The eye looking at a star is adapted to the star's own background: the sky plus the veil at the star, its
own light removed. That is exactly the condition of Crumey's (2014) thresholds, which are functions of
the background luminance at the source. So a faint star in dark sky looks the same whether the extended
image is adapted to a bright planet or to darkness, and near the planet its veil hides it. v1 floored the
star's background at the global adaptation. That removed every faint star from a frame containing a
bright extended body.

What this does not do:

- **Faint extended features beside a far brighter one** (earthshine next to the sunlit crescent) are
  shown as seen while looking at the bright part. A person who looks at the earthshine sees it.
- **A fully local (per-pixel) adaptation** would show both, at the cost of flattening region brightness
  and of halos at edges (Ashikhmin 2002; Ledda, Santos & Chalmers 2004; Reinhard & Devlin 2005 blend
  local and global with a free parameter). It is a possible next step (§10).
- **The old rule** is kept as `fixation: 'centre'`: one fixation at the view centre with a
  `adaptationFieldDeg` (1°) foveal field. It is useful when the user deliberately looks at a dark
  feature.

**Field ('centre' mode).** The adaptation field is a 1°-diameter foveal disk around the fixation point,
following the "1-degree foveal weighting" of Ward Larson, Rushmeier & Piatko (1997), which Pattanaik et
al. (2000, §4.1.2) use as their adaptation goal finder. Setting: `adaptationFieldDeg`.

**Statistic.** The *log-average* (geometric mean) of the *retinal image*: in 'centre' mode solid-angle
weighted over that field, in 'brightness' mode weighted by the fixations over the frame (above).
It is exp⟨ln(L + L₀)⟩ − L₀ with L₀ the dark light (below). The retinal image is: the unscattered scene plus the intraocular
veil from every glare source (§3), in frame (the pyramid) and off frame (the analytic veil of the Sun
and bodies within 100° of fixation). Including the veil follows Moon & Spencer (1945): the adaptation
state in a non-uniform field is that of the fixated luminance plus the equivalent veiling luminance
of the surround (their surround term is a 1/θ² veil, which CIE 146 supersedes). We know that formula
through Ward Larson et al. (1997, Eq. 8: L_a = 0.913·L_f + L_v, with L_f the average luminance of a 1°
foveal field); Moon & Spencer's own paper was not read.

The logarithm is where we follow Ward Larson et al. and where we do not. They average the luminance
over each 1° foveal field arithmetically and then take logarithms across the fields, one per possible
fixation (their §4.2). In 'brightness' mode our log-average runs across fixations too, each fixation
adapted to the retinal image at the point it looks at. In 'centre' mode the geometric mean inside the
one 1° field is our own choice, not theirs: v0 used the arithmetic mean there, which let a small bright
region (a fixated star's own near-core glare) dominate the field.

The cores of point sources are excluded (a star's image covers a few receptors, not the adaptation
pool); their scattered light is included. Photopic (A_cone, from Y) and scotopic (A_rod, from S)
averages are measured separately.

*Checked against the "grey veil" report:* in the night-side view of Earth from 400 000 km the veil
filling the frame is the Moon's glare (60° off axis, i.e. off frame, analytic veil). It is included in
the adaptation measurement (5.7·10⁻⁵ cd/m² there, 5.7× the dark light), and a uniform field at the
adaptation level is displayed as a dim grey by Pattanaik's appearance rules (§4, §10 table: ~3 cd/m²).
So the veil and the adaptation state are consistent; the grey is the model's rendering of a sky
brightened by moonlight glare. (v1 added that fixating a bright star light-adapts the whole frame by the
star's own glare. Since v2 stars do not draw the extended image's fixations, and each point is judged at
its own background; see "Fixations" above.)

**Floor.** Both are floored at the luminance below which vision treats the background as zero:
10⁻⁵ cd/m² (Crumey 2014 §2.1 and §2.3, after Crawford 1937), ×1.408 for the scotopic channel
(the S/P ratio of Blackwell's light, §6).

**Measurement.** A compute pass reduces the field on the GPU; the result is read back asynchronously
(one frame of latency). `Renderer.settled()` drives frames until the adaptation used to render a
frame agrees with the one measured from it (|Δ ln A| < 10⁻³ and a stable corneal flux) twice in a row.

**Time (M5).** `ViewSettings.adaptation.mode = 'realtime'` (the shell's default, from the north star:
what one would really see) makes the eye adapt over real elapsed time. `'instant'` keeps it always fully
adapted (the shell's "instant adaptation" option, badged). There are two processes.

*Neural adaptation* (light adaptation, seconds). The adaptation luminances follow the goal through
Pattanaik et al.'s (2000, §4.1.2) first-order filters, t₀ = 80 ms (cones) and 150 ms (rods). They fitted
these to the early dark-adaptation data of their ref. [3] "after discounting regeneration effects".

*Photopigment bleaching and regeneration* (dark adaptation, minutes; `eye/bleaching.ts`). Each class of
photoreceptor has a bleached pigment fraction B, with first-order kinetics:

dB/dt = I·(1 − B)/Q − B/τ,  so in steady light B∞ = I/(I + I₀), I₀ = Q/τ.

This is the Rushton model (Hood & Finkelstein 1986, eqs. 10–17), the "published consensus" Pattanaik
et al. use. I is the retinal illuminance of the adaptation goal through the Watson–Yellott pupil,
photopic trolands for cones and scotopic trolands for rods. The Stiles–Crawford effect is not included.

| | τ | I₀ / Q | source |
|---|---|---|---|
| cones | 110 s | I₀ = 10^4.3 td | τ: Hood & Finkelstein via Pattanaik; I₀: Rushton & Henry (1968), the model Hollins & Alpern (1973) fit; Mahroo & Lamb (2004) give σ⁻¹ = 710 cd·m⁻²·min with dilated pupils, Q ≈ 1.6–2.1·10⁶ td·s, against I₀τ = 2.2·10⁶ |
| rods | 400 s | Q = 10^7.0 scot td·s | τ: as above; Q: log Q = 6.8–7.0 (Rushton & Powell 1972; Alpern & Pugh 1974), 7.0 as in Thomas & Lamb (1999) |

What the bleach does to vision. Only the bleach in excess of the steady state for the current light
counts: the steady state is already part of the measured thresholds and of Hunt's response model.

- **Rods: the Dowling–Rushton relation.** log₁₀(threshold/absolute threshold) = a·ΔB with a = 12:
  "the log threshold is raised 1·2 units for each 10 % of rhodopsin in the bleached state" (Alpern,
  Rushton & Torii 1970). Reviews give 12–20 for man. This is turned into an *equivalent background*
  (Crawford 1947): with Weber's law above the dark light L₀, the eye adapted to A with threshold raised
  E-fold behaves as one adapted to E·(A + L₀) − L₀. The rod response (tone model, §4) and the
  point-source observer use that rod adaptation, so after daylight a dark scene looks darker and
  faint stars are invisible.
- **Cones: loss of photon catch only**, (1 − B)/(1 − B∞). The psychophysical cone threshold after a
  bleach rises more than that (Hollins & Alpern 1973 fit the Dowling–Rushton relation to cones), but
  their constant could not be verified here, so it is not used (§10).
- **Detection by the more sensitive system.** A point-source threshold is raised by
  max(1, min(T_rod·E, T_cone/catch)/min(T_rod, T_cone)). T_rod and T_cone are Crumey's (2014) scotopic
  and photopic branches (Eqs. 32/33) at the local background. The rod branch is taken as Weber beyond
  its range; the cone branch is not taken below its range (0.0708 cd/m², where the two branches meet).
  When adapted, the factor is exactly 1 and Crumey's full-range threshold is unchanged.

The dark-adaptation curve this gives after 10 min of a 10⁴ cd/m² daylight field, for a point source on a
dark background (`eye-bleaching.test.ts`):

| minutes in the dark | 0 | 1 | 2 | 5 | 10 | 15 | 18 | 20 | 25 | 30 | 40 | adapted |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| limiting V | 3.7 | 4.5 | 4.7 | 5.0 | 5.0 | 5.0 | 5.9 | 6.4 | 7.0 | 7.3 | 7.5 | 7.6 |

The classic features come out without fitting:

- a **cone plateau** reached in ~5 min, 1.0 log unit (2.6 mag) above the rods' absolute threshold for a
  point source;
- the **rod–cone break**, here at ~16 min for a 75 % rod bleach, and ~9 min after a full bleach for
  large test fields, where the plateau is ~3 log units up;
- an **S2 slope** of 0.27 log units/min from 3 to 1 log unit above absolute after a full bleach (Lamb
  1981: 0.24; Patryas et al. 2013 young observers: 0.23 ± 0.03), flattening into an S3-like tail;
- **full dark adaptation** (within 0.1 log unit) after 32 min, within the classic 30–40 min.

The rate-limited regeneration of Lamb & Pugh (2004) and Mahroo & Lamb (2004) (dB/dt = −v·B/(K_m + B))
describes the pigment time course better. The Dowling–Rushton constants were measured against
exponential kinetics, so that is the pair used; the alternative is noted.

*Real time and tests.* The renderer integrates the kinetics exactly over each frame's real elapsed time,
at most 2 s per step, since a longer gap is a hidden tab and not a stare. A bleach from a very bright
exposure (the Sun's veil, a sunlit planet filling the view) therefore delays dark adaptation for tens of
minutes. `Renderer.settled()` (screenshots, tests) holds the pigments in steady state unless the view
gives `adaptation.history` = {luminance, exposure, elapsed}: a uniform field seen for `exposure` s, then
`elapsed` s of the current view. The history is re-applied until the adaptation to the view settles. URL:
`adapt=instant|realtime`, `adaptfrom=<cd/m²>,<s>,<s>`.

*HUD.* `stats.darkAdaptation` gives the share of the excess rhodopsin bleach regenerated, the minutes
until the rod threshold is within 0.1 log unit of adapted (if the light stays), and a line such as
"dark adaptation 43 % — 29 min to full". The 0.1 log unit criterion is a reporting choice.

**Pupil.** Watson & Yellott (2012) unified formula: D = D_SD(F) + (y − y₀)(0.021323 − 0.0095623·D_SD),
D_SD(F) = 7.75 − 5.75·(F/846)^0.41/((F/846)^0.41 + 2), y₀ = 28.58, F = L·a·M(e) with M = 1 binocular
and 0.1 monocular. For a non-uniform scene we use F = ∫ L dΩ over the rendered field (cd·m⁻²·deg²),
the "effective corneal flux density" the formula is built on. Since v1, glare sources outside the frame
but within 100° of fixation (the Sun, bright bodies) add their illuminance (E in lux is their ∫L dΩ)
to F, so looking 45° away from the Sun gives a ~2 mm pupil rather than a dark-adapted one. The
formula has no eccentricity weighting, so off-axis sources count fully (a limitation shared with
the in-frame measurement). The pupil sets the optical PSF core (§3)
and is reported in `stats.pupilDiameterMm`. Alternatives: Stanley & Davies (1995) alone, De Groot &
Gebhard (1952), Moon & Spencer (1944); Watson & Yellott unify these and add age and monocular effects.

## 3. Point spread of the eye: optical core and glare

**Scatter (glare).** CIE 146:2002 general disability glare equation (valid 0.1° ≤ θ ≤ 100°):

L_veil/E_glare = 10/θ³ + (5/θ² + 0.1·p/θ)·(1 + (A/62.5)⁴) + 0.0025·p  [sr⁻¹, θ in degrees]

with observer age A and eye pigmentation p (0 very dark … 1.2 very light blue). Alternatives: the
age-adjusted Stiles–Holladay and small-angle equations of the same report (narrower validity), and
Spencer et al. (1995). The CIE equation is pupil-independent: straylight measured this way scales with
the light entering the pupil, so the pupil enters through the core below and through retinal
illuminance, not through the veil.

Implementation: the veil of everything in the frame is a convolution of the HDR image with this
kernel. An image pyramid (2× box downsample, σ = 1 texel separable Gaussian at each level, bilinear
upsample-and-add) realises a sum of Gaussians whose effective widths are known in closed form
(`pyramidSigma`); non-negative least squares (`fitScatterKernel`) finds the level weights that
reproduce the CIE profile, matching it to < 10 % at every radius and its energy to < 3 % (tested). The
composite keeps 1 − Σw of the light unscattered, so energy is conserved exactly. The fit starts at half a
pixel; inside 0.1° (below the CIE validity range) the kernel is held at its 0.1° value. v0 fitted only
from 0.1° outward, which left the narrowest Gaussians unconstrained at fine pixel scales: at 1440p and 4K
the fitted "scattered" energy could exceed 100 % and the unscattered fraction turned negative (stars and
bodies vanished at 4K). The bounded continuation keeps the scattered fraction within 20 % across
resolutions from 720p to 4K (tested; ≈ 0.39–0.40 at a 50° field).

Outward, the fit runs over the whole support of every Gaussian (to 4σ of the widest level), with the
kernel's own zero beyond 100° as the target there. v1 stopped at the frame diagonal or at 100°,
whichever came first. In a wide field, where 100° lies inside the frame, the widest levels were then free
to carry energy beyond 100°: the weights summed to 0.73 at fovY 110° and 1.20 at 130° (1080p). The
unscattered fraction 1 − Σw went negative and the whole frame rendered black, stars included. Now the
scattered fraction stays physical at every field from 5° to 150° (tested at 720p, 1080p and 4K): ≈ 0.36–0.40
up to 90°, falling to 0.14–0.27 at 150°. It falls because a wide-field pixel spans more of the kernel's
steep core, and that light stays in its pixel. Light scattered beyond the frame edge is lost (the scene
outside the frame is not rendered).

The Sun, and bodies whose centre is outside the frame, are veiled analytically per pixel
(E·f_CIE(θ)), because their glare reaches far beyond the frame and the Sun's disk is too bright for a
pyramid. The Sun's E is reduced by the fraction of its disk covered by bodies in front of it. A source
contributes only if it lies within 100° of the fixation direction (the CIE validity range, and
roughly the extent of the visual field); within the frame θ is clamped to that range.

**Which glare is painted.** The physical veil above (the scene observer's retina) drives adaptation
and visibility thresholds, but it is *not* what the display shows. The viewer's own eye scatters
whatever the display shows, so painting the physical veil of displayable light double-counts it (and
turned every faint star into a soft blob in v0). Glare is painted to convey luminance the display cannot
reach (Spencer et al. 1995; Yoshida et al. 2008; Ritschel et al. 2009). Quantitatively:

- The *intended display luminance* of a pixel or point is the display luminance that would evoke the
  scene observer's response in the display observer (Pattanaik's appearance map and inverse display
  model, §4) *without* clamping at the display peak. It is bounded by Hunt's cone-bleaching luminance
  (Pattanaik Eq. 6, 2·10⁶ cd/m²), beyond which the display observer's model is undefined.
- The *overflow* is the part above what the display shows: intended luminance minus the peak for
  extended sources, and the display flux a point's splat cannot hold (§6.3).
- The painted glare is the viewer's veil of the overflow: the same CIE 146 kernel (the pyramid run a
  second time, on the overflow image, in display units), with levels finer than the viewer's Ricco area
  (at the display adaptation, ~5′) weighted by A_k/A_R,disp, and added to the display image.
- The Sun and off-frame bodies (the analytic veil) are never displayable, so their glare is shown as the
  scene observer's veil, through the tone reproduction.

A star the display can show therefore has no painted halo; Sirius at dark adaptation has a small one;
Venus a bright glow; the full Moon a large one.

**Optical core.** Watson (2013) mean optical MTF of the best-corrected eye as a function of pupil
diameter d: M(u, d) = √D(u, d, 555 nm)·(1 + (u/u₁(d))²)^−0.62, u₁ = 21.95 − 5.512·d + 0.3922·d², D the
diffraction-limited MTF (Watson's Eqs. 4–5 use its square root; v0 omitted the root, which made the
core too narrow). With the root the equivalent core σ is 0.54′–0.74′ for 2–8 mm pupils. The equivalent Gaussian of the PSF (same peak: σ² = 1/(2π·2π∫M u du)) is the
footprint of point-source splats, never narrower than σ = 0.6 px (a reconstruction-filter choice at
which the discrete Gaussian sums to its integral within 2·10⁻³ for any sub-pixel position). At
ordinary fields of view the core (~0.7′) is sub-pixel; it matters when zoomed in. Watson fitted
pupils of 2–6 mm; larger dark-adapted pupils extrapolate the formula (see §9).

## 4. Tone reproduction: Pattanaik et al. (2000)

**Choice.** We need a published model that maps *absolute* scene luminance and an adaptation state to
display values across ~14 decades, with separate rod and cone systems, and that can later become
time-dependent. Pattanaik, Tumblin, Yee & Greenberg (2000) meets all four: forward and inverse models
of rod and cone responses built from Hunt's colour-vision model (Hunt 1995), an appearance model with
reference white/black, and explicit time constants. Alternatives considered:
Ward (1994) contrast-based scale factor (photopic only, linear, threshold-based); Ferwerda et al.
(1996) (adds rods but maps scotopic scenes to grey and is threshold-based rather than supra-threshold);
Reinhard & Devlin (2005) (photoreceptor-inspired but with free user parameters, not absolute);
Mantiuk et al. (2008) display-adaptive (optimisation, heavy, photopic contrast); Irawan et al. (2005)
(combines Pattanaik's time course with histogram adjustment).

**Forward model** (per pixel): R = B·Lⁿ/(Lⁿ + σⁿ), n = 0.73, for cones on L = Y and for rods on
L = S. Cones follow Pattanaik's Eq. 5, which is exactly Hunt's cone path (σ_cone = 5·2^(1/n)·A/F_L,
tested):

σ_cone(A) = 12.9223·A / (k⁴A + 0.171(1 − k⁴)²A^(1/3)), k = 1/(5A + 1),  B_cone = 2·10⁶/(2·10⁶ + A_cone).

**Rods (v1): Hunt's scotopic path**, taken from Hunt (2004) as presented by Fairchild (2013, ch. 12)
and cross-checked against the colour-science implementation (`colour.appearance.hunt`). With
x = 5·A_rod/2.26 (the scotopic adapting field of a 5×-brighter reference white, in Hunt's
scotopic units):

F_LS = 3800·j²·x + 0.2·(1 − j²)⁴·x^(1/6),  j = 10⁻⁵/(x + 10⁻⁵)
σ_rod = 5·2^(1/n)·A_rod / F_LS  (the same half-saturation construction as the cone path)
B_S = 0.5/(1 + 0.3·(S/2.26)^0.3) + 0.5/(1 + 5·x)  (rod saturation by the stimulus and by adaptation)

R_lum = R_rod + R_cone. Reference white/black = responses at 5A and 5A/32 (Eq. 8).

*Why the change.* Pattanaik's rod Eq. 4 (σ_rod = 2.5874·A/(19000·j²A + 0.2615(1−j²)⁴A^(1/6))) drops
Hunt's /2.26 scaling and has a numerator 5× smaller than Hunt's; the paper's own display table
(σ_rod = 722 cd/m² at A = 25) is 5× Eq. 4. The result is rods ~5× too sensitive, which produced v0's
mesopic brightness dip (§10). Using Hunt's rod path as published is the remedy. (colour-science writes
the (1 − j²) exponent of F_LS as 0.4; Fairchild and Pattanaik write 4, which we use.) Hunt's B_S keeps
a small daylight rod response instead of Pattanaik's B_rod = 0.04/(0.04 + A); at A = 10⁴ cd/m² it is
< 10⁻⁴ of full scale.

**Inverse model.** The display observer is steadily adapted to peak/5 (Hunt's "reference white = 5 ×
adaptation"; the paper's CRT: peak 125, A = 25); its reference white is the display peak (setting,
default 200 cd/m²) and its reference black the display black level (setting, default 0). The paper's
four rules (§4.3) map scene responses to display responses (direct reproduction; compress span;
offset down; offset up), and the inverse of Eq. 2 gives display luminance. The display observer's rods
are neglected in the inverse (< 0.2 % of the response).
Checks: our Eq. 5 gives the paper's σ_cone = 646 cd/m² at A = 25, and the display slope between 4 and
125 cd/m² is the paper's S_d = 0.1383 per decade (tests). We compute all display constants from the
equations; σ_rod of the display is unused.

**Deviations from the published model** (both documented in code):

1. *Cone bleaching off* (`coneBleaching: false`). Hunt's steady-state B_cone only departs from 1
   above ~10⁵ cd/m², i.e. when fixating the solar disk (B_cone ≈ 10⁻³ there). Pattanaik's appearance
   rules then map the tiny bleached response to near black: the Sun would render darker than a dim
   room, contradicting the universal report of a blinding white Sun. We keep B_cone = 1. Since M5,
   bleaching is represented as a transient by the pigment kinetics (§2 "Time"), in trolands, rather
   than by Hunt's steady-state term. Rod saturation
   (Hunt's B_S) is kept, since without it rods would respond in daylight.
2. *Dark-light pedestal.* The Naka–Rushton response gives any luminance, however small, a response
   that the appearance model shows as grey. Vision cannot distinguish luminances below its intrinsic
   noise ("dark light", Barlow 1957; the flat threshold for B → 0 in Crumey 2014 §2.1, B ≲ 10⁻⁵ cd/m²).
   We use R(L + L₀) − R(L₀) with L₀ = 10⁻⁵ cd/m² (×1.408 scotopic). Darkness stays black, and a
   faint veil below dark light stays near black, as it would look.

## 5. Mesopic and scotopic vision

- **Purkinje shift** follows directly from driving the rod response with the true scotopic luminance
  S. Bluish surfaces have higher S/Y and so gain relative brightness as rods take over.
- **Rod intrusion** into brightness is R_lum = R_rod + R_cone. Rods saturate (B_S → small) above a few
  cd/m², so daylight scenes are essentially cone vision.
- **Loss of colour (v1).** Pattanaik's Eq. 3: colour ratios are raised to the exponent
  k = s_scene/s_display, where s = dR_cone/d(log L) is the slope of the cone response at the pixel (the
  scene observer's cone response at the scene luminance, the display observer's at the displayed
  luminance), capped at 1. We apply the exponent to the ratios of Hunt–Pointer–Estévez LMS to the
  display white's LMS (the space in which Pattanaik's model takes colour), which maps white to white
  and k = 0 to grey. As the scene observer's cones leave their operating range (low light), k → 0 and
  colour fades; with the display at 200 cd/m² k = 1 for surfaces adapted at ≥ 10² cd/m². v0's
  rod-share mix is gone because Hunt rods keep a small response in daylight, which a rod-share mix
  would read as desaturation. Tested: k(10⁴) = 1, 0.2 < k(0.1) < 0.9, k(10⁻³) < 0.1. The cap at 1 means
  the Hunt effect (colourfulness rising above the display's level) is not reproduced.
- **CIE 191:2010** mesopic photometry (m = 0.767 + 0.3334·log10 L_mes, iterated from m = 0.5,
  V′(λ0) = 683/1699) sets how photopic and scotopic quantities combine for *visual performance*, i.e.
  the visibility thresholds (§6).
- **Not implemented (reviewed again in M5):** the rod-induced hue shift toward blue at mesopic levels
  (Cao, Pokorny, Smith & Zele 2008; used for tone mapping by Kirk & O'Brien 2011). Kirk & O'Brien add a
  rod term to each opponent channel (their Eqs. 5.3–5.6, in the thesis version, UCB/EECS-2011-91):
  - sensitivity regulation g = 1/(1 + 0.33(q + κ·q_rod))^0.5, with κ₁ = 0.25 and κ₂ = 0.4 for full
    scotopic adaptation (from Cao et al.);
  - opponent weights ρ and α fitted to Cao et al.'s data.

  Two things in it are not measurements. The receptor signals q are normalised to the image, with
  exposure left to the user ("too sensitive to exposure"), so the 0.33 has no absolute scale here. The
  channel gains x = y = 15 and z = 5 are the values the authors chose for their figures. Using it would
  mean inventing the scale of q in cd/m² or trolands. A principled version needs Cao et al.'s gains on
  an absolute (troland) scale. This is the next step for colour at low light.

## 6. Visibility of point sources

**Model.** Crumey (2014), MNRAS 442, 2600, fitted to Blackwell's (1946) threshold data. The
full-range point-source threshold (Eq. 34 with Eq. 28) is

ΔI(B) = (√(a₁B^½ + a₂B^¾ + a₃B) + a₄B^¼ + a₅B^½)²  lux,

with the zero-background cut-off (B < 10⁻⁵ cd/m² treated as 10⁻⁵, §2.3). It is multiplied by the field
factor F (default 2, Crumey's "notional typical" value for actual observing, §3.1). Worked values
reproduced in tests: m₀ = 6.93 − 2.5 log F at 21.83 mag/arcsec² (Eq. 53); the linear forms Eq. 54 and
Eq. 55; Table 1 penalties; ζ = 1.150·10⁻⁹ lx; A_R = 8.94·10⁻⁴ sr at zero background; Ricco radius
37.6′ at 21.83 mag/arcsec².

**Colour and mesopic state.** Crumey's luminances are those of Blackwell's 2850 K lamps. We convert any
(photopic, scotopic) quantity to "Blackwell units" at the CIE 191 state m of the adaptation:

Q_bw = [m·q_p + (1 − m)·V′(λ0)·q_s] / [m + (1 − m)·V′(λ0)·ρ₂₈₅₀],  ρ₂₈₅₀ = 1.408 (Crumey §1.3).

At m = 0 this is Crumey's own scotopic colour correction; at m = 1 it is the photopic value. Stars
(E_p, E_s) and backgrounds are converted the same way.

**Background.** B = the local background, and the eye judging the point is adapted to it: its own
fixation (§2). Crumey's thresholds are measured this way. The local background is:
- the physical veil at scales at or above the Ricco area (the pyramid level whose Gaussian first reaches
  A_R, sampled bilinearly), from the previous frame;
- plus the analytic veil;
- plus, in the point shader, the extended image at the point.

The source's own light in it (Σ_{k≥k_R} w_k/(2πσ_k²) per unit illuminance) is subtracted, so a source
never masks itself.

The mesopic state m, the Ricco area, the cone summation area and the tone response (Pattanaik's
observer with Hunt's rods, reference white and black, appearance rules) are all evaluated at that
background, per point. They are ported to WGSL: `obsAt`, `mesopicM`, `crumeyRiccoArea`.

v1 used B = max(global adaptation, local background): "looking at a sunlit planet hides the stars even
against black sky". That holds for one fixation, but it is not how a scene is looked at.

**Test of the whole chain.** Under a dark sky of 21.5–22 mag/arcsec² (sky S/P 1.38, Crumey §1.3), the
model gives naked-eye limits between V ≈ 6.0 and 7.0 for star colours B−V = 0 … 1.5 (S/P from
Crumey Eq. 13), and 6.18 for a 2850 K-coloured star at 21.83 (tests). In space with no sky
background, the zero-background cut-off gives V ≈ 7.6 with F = 2. With the M4 sky (zodiacal light,
Galactic light, unresolved stars) the regression suite's star field beyond Pluto has a background of
6·10⁻⁵ cd/m² and a limit of V ≈ 6.5.

**Culling.** On the GPU, each star whose Blackwell-equivalent illuminance is below F·ΔI(B) (÷ the
enhanced boost) at its own background is not drawn. Unresolved bodies are tested in the point shader.
The renderer also reports `pointLimitingMagnitude`: the limit for the eye looking at the darkest
background in the frame (the minimum retinal luminance, reduced on the GPU with the adaptation
measurement), with the current pigment state. It bounds which catalogue stars can be drawn at all, and
the app's sky (app/sky.ts) cuts points from background light there (M5). Cutting at the global limit
hid every star as soon as a bright planet was in view: Jupiter's frame adapts to 650 cd/m² (limit
V ≈ −1.9), while the dark sky around it shows stars to V ≈ 6.5 (regression suite).

### 6.3 How point sources are shown (`eye/points.ts`)

**Brightness, not size.** A point's image is far smaller than the area over which the eye sums light at
low luminance, so its pixel luminance says little about how bright it looks. Crumey's Ricco area
A_R(B) = ΔI/ΔB∞ (Eq. 22/59, with C∞ from Eq. 39/40) is the intersection of the two asymptotes of his
threshold curve. So a point of illuminance E is exactly as detectable as a large patch whose luminance
exceeds the background by E/A_R. (A patch of area A_R itself needs 2^(1/q) times more, 1.9 to 3.2, by
the full curve, Eq. 41.) The law is about detection on a background the eye is adapted to; using it for
the brightness of a point is our extension (§10). Summation sets how bright a point looks, not how large:
dark-adapted A_R is ~50′ in radius, yet stars look like points. So:

1. the scene observer's response to the local background B plus E·u/A_R (u = unscattered fraction) is
   mapped to an intended display luminance increment ΔL_d over the background's (§3);
2. the viewer, adapted to the display, sums a small displayed dot over *their* Ricco area A_R,disp
   (Crumey's A_R at the display observer's adaptation, peak/5: 5.0′ radius at 200 cd/m²), so the dot
   carries the display flux ΔL_d·A_R,disp and looks as bright as the Ricco patch would;
3. the dot is a sharp splat of the eye's optical core (Watson 2013, never narrower than the 0.6 px
   reconstruction minimum), drawn in display space after tone reproduction; what it cannot hold
   without exceeding the display peak is the overflow, painted as the viewer's glare (§3).

Where the dot and a painted halo overlap beyond the display range, the dot is drawn over the halo
with a hue-preserving fit into the gamut, so a bright star keeps its colour instead of clipping to
white.

**Point or disk** (`render/frame.ts`). A body is a point to the eye while its disk is smaller than the
eye's point spread, and the splat is that point spread as drawn: σ = max(σ_c, 0.6 px), σ_c the optical
core of §3. The switch is made on the disk's diameter d in units of the splat:

s = 0.6·d/σ,  resolved share f = smoothstep(1, 2, s),  point share 1 − f.

- Where the splat is the reconstruction minimum (σ = 0.6 px), s is the diameter in pixels and the switch
  runs from 1 to 2 px. That is every field wider than 11° to 13° on 720 lines, depending on the pupil,
  and wider than 32° to 39° on 2160 lines.
- Where the screen resolves the eye's core, the switch runs from d = 1.67 σ_c to 3.33 σ_c at every field:
  1.1′ to 2.2′ at a 6 mm pupil, 0.9′ to 1.8′ at 3 mm. A narrower field then magnifies the picture and
  changes nothing in it. This is the reading of §3 and §5b, where the optical core and the acuity cell are
  also fixed in scene angle: a narrow field is a magnified picture of what the unaided eye sees.
- The Sun follows the same rule.
- In the switch the body's point is drawn at the depth of the body's nearest point, so that its own disk
  does not hide the core of its splat.
- **The validation runs with another observer.** It compares the HDR buffer, before the eye model, with a
  spacecraft camera's image (docs/reports/validation.md). Its observer is an imager at the frame's own
  sampling, not an eye, and a body must be in that buffer whenever the frame resolves it. So the
  validation runner sets `EyeSettings.opticalCore` to false: the splat is then the reconstruction minimum
  and the switch is 1 to 2 px at every field. The setting changes nothing else in the model. With the eye
  as observer, the Earth and the Moon of the EPOXI case (0.9′ and 0.24′ across in a view 3.5′ wide) are
  points, and its three rows read zero. The app and the scene suite always run with the eye.

The two numbers 1 and 2 are the original pixel rule; no constant was added. The published summation
diameters for photopic foveal vision fall on the range this gives (2.4′ to 2.95′ for detection at
8 cd/m², Tuten et al. 2018), but the rule is not fitted to them (§10).

**A resolved body carries no Ricco weight.** Its pixels go through the tone reproduction (§4) at their
own retinal luminance, u·L plus the analytic veil, at the frame's adaptation (`eye/extended.ts`). The
reasons:

- Crumey's model is "concerned with threshold rather than brightness perception" (2014, p. 2602), and
  its B is the luminance "immediately surrounding the target", to which the observer is adapted. A sunlit
  disk on a dark sky is a million times above threshold, and the frame's adaptation is the disk's own
  luminance, not its surround's.
- Where brightness was measured against size above threshold, it is not diluted by area. Diamond (1962)
  found an effect of area only at threshold for foveal fields 5.4′ to 54′ across at up to 1156 cd/m².
  Hanes (1951) and Higgins & Rinalducci (1975) found brightness falling with size at high levels.
- The eye that looks at a disk it resolves is adapted to that disk (§2).

So the screen's answer to "why is it this bright" is the same sentence for a small disk and a large one:
the eye is adapted to A cd/m², the light of what it looks at in this view, and this surface is L cd/m².

**The step at the switch stays.** A point is judged by an eye adapted to the sky behind it; a disk by an
eye adapted to the disk. Those are the two limits of this model, and the switch is where one gives way
to the other. For Jupiter alone at the default field, between 1 and 2 px across (4.5′ and 8.9′), the
adaptation goes from 6·10⁻⁵ to 173 cd/m², and the light shown in a 301 px window falls by a factor of 70:
from glare filling the window to a small grey disk. Both sides are what the model says. A blend, a floor
or a wider ramp would hide the step without making either side more true. Removing it means changing one
of the limits: either a point's own light enters its adaptation, or a disk does not adapt the eye until
it fills some published field. The one published expression of that kind is Ward Larson et al.'s Eq. 8
(§2), and it changes both: a 30′ body would be shown at 4.4 times its adaptation, and Ganymede at 3.6′
would adapt the eye to 0.9 cd/m² instead of 262.

**Colour of point sources.** Only cones carry colour, and a point concentrates its light on few cones,
so a star's colour depends on its own retinal illuminance, not on the global mesopic state or on the
pixel's mean luminance. The colour exponent of Pattanaik's Eq. 3 (§5) is evaluated at the star's cone
signal B + E·u/A_c, where A_c is the cone system's summation area: Crumey's A_R at a photopic background
(≥ 5 cd/m², the upper end of the CIE 191 mesopic range, where his full-range model is cone-only; 6.2′
radius), held at that value at lower adaptation, where cones are at absolute sensitivity. Checks
(tests, dark adaptation): at the cone point threshold of Hecht (1947, photopic branch; in modern units
Crumey 2014 Eq. 20, c = 4.808·10⁻⁸ lx, V = 4.31), the one Schaefer (1990) uses for his day branch, the
exponent is within 0.05 of the background's (no colour); it rises through V ≈ 2 (weak tint; Protte &
Hoffmann 2020 give ~2.3 mag as the observational onset of star colour) to 0.25 at V = 0 and 0.58 at
V = −1.5. Crumey (2014, §1.2) reports, after Schaefer (1996), that stars more than about one magnitude
above threshold are seen with cone participation in telescopic viewing; our onset is consistent with
that. Rigel/Vega stay near white, Antares and Betelgeuse show a warm tint.

## 5b. Low-light acuity

Spatial resolution falls with luminance. We use Ward Larson, Rushmeier & Piatko's (1997, Eq. 15) fit to
Shlaer's (1937) foveal grating acuity:

R(L_a) = 17.25·arctan(1.4·log₁₀ L_a + 0.35) + 25.72  cycles/degree.

The paper's text gives about 45 c/deg at 25 cd/m², about 9 at 0.05 cd/m², about 50 in daylight and
about 2 near the limit of vision; all are tested. L_a is floored at the dark light (10⁻⁵ cd/m², R = 1.2).
It is applied the way Ward Larson et al. do, as a variable-resolution filter.

- L_a is the luminance of the ~1° foveal field around each pixel, plus the veil (theirs is the foveal
  adaptation with the veil). Taking the fovea's local luminance matters: bright regions stay sharp and
  dark ones blur. A global blur (Ferwerda et al. 1996) would blur both.
- The extended image is read from the level of an image pyramid (mip chain of EXT) whose texel is half
  a cycle at R: level log₂(1/(2·R·pixel angle)), linear between levels.
- Point sources are not blurred: their image is the eye's point spread (§3), and their visibility has
  its own model (§6).
- On in eye mode only: enhanced mode lifts eye limits.

At a 50° field on 1080 lines (0.046°/px, Nyquist 10.8 c/deg) the blur starts below ~0.08 cd/m² (the
moonlit range) and reaches ~5 px at the dark light. With a narrower field it starts earlier. The
alternative is the Barten (1999) CSF model with the ratio of scene and display sensitivities per
frequency. It is photopic, while Shlaer's data reach scotopic levels, so it was not used. The temporal
flicker of low-light acuity that Jacobs et al. (2015) observed is not modelled.

## 7. Display encoding

1. **Chromatic adaptation.** CAT02 (CIE 159:2004, CIECAM02) from the adapted white, sunlight (the
   Sun's XYZ from data), to the display white (D65). The degree of adaptation is
   D = F[1 − (1/3.6)e^((−L_A−42)/92)], with F = 1 (average surround) and L_A = the adaptation
   luminance. A spectrally flat surface in sunlight shows as display white, as for an observer
   adapted to sunlight.
2. **XYZ → linear RGB of the output colour space**, relative to display white. The colour space is
   sRGB (IEC 61966-2-1 matrix), or Display P3 when the screen covers it (`(color-gamut: p3)`). The P3
   matrix is built from its primaries (SMPTE EG 432-1) and D65; it matches CSS Color 4's to 10⁻³, and
   the sRGB matrix built the same way matches the IEC matrix (tests).
3. **Gamut mapping.** Out-of-gamut colours (negative components) and colours too bright for the
   display in their hue (a component above the ceiling) move toward the achromatic colour of the same
   luminance (g·(1,1,1)) just far enough to fit, which preserves luminance and dominant hue. Luminance
   above the ceiling becomes the brightest white. The ceiling is 1 on SDR, and HDR peak / white on HDR.
4. **Transfer function**: the sRGB curve (both colour spaces use it), extended above 1 on HDR.
5. **Dither** (SDR only). Triangular-PDF noise of ±1 LSB before 8-bit quantisation, against banding in
   dark gradients such as glare falloff.

**HDR output (M5).** When the screen reports `(dynamic-range: high)` and the browser accepts an
rgba16float canvas with `toneMapping: { mode: 'extended' }` (WebGPU §21.5; read back with
`getConfiguration()`), the composite writes extended-range values: 1.0 is the display's SDR white and
larger values are brighter. WebGPU canvases take *encoded* values (the colour space's transfer function,
extended). The spec's own example, (2.5, −0.15, −0.15) on an 'srgb' canvas shown as (2.3, 0.545, 0.386)
in Display P3, is reproduced in the tests. The eye model then reaches up to the display's peak:

- The display observer (Pattanaik's inverse model, §4) is unchanged. It is adapted to white/5 with
  reference white at display white (`displayPeakCdM2`, default 200 cd/m², near ITU-R BT.2408's
  203 cd/m² HDR reference white).
- Responses above reference white are shown up to the HDR peak (`hdrPeakCdM2`, default 1000 cd/m², the
  common HDR10 mastering and VESA DisplayHDR 1000 peak) instead of being cut at white. Highlights (the
  sunlit limb, bright stars, the Sun's glare core) are brighter on the screen, not compressed.
- The painted glare (§3) takes only what exceeds the HDR peak. Point sources can hold up to the peak.
- Browsers do not report the display's peak luminance or the absolute SDR white, so both are settings.
  A display that cannot reach the peak clips.

On SDR displays nothing changes. `Renderer.create({ display: 'auto' | 'sdr' | 'hdr', colorSpace })`
chooses; `renderer.displayInfo` reports the result.

## 8. Enhanced mode

`view.mode = 'enhanced'` multiplies the perceived scene luminance by 2^exposureBoostStops before the
response model. Adaptation still comes from the physical scene. The visibility threshold is divided
by the same factor: +3 stops raises the limiting magnitude by 2.5·log₁₀ 8 = 2.26 mag (tested). The shell
shows the badge.

## 8b. Sun shield (a viewing aid)

With `view.sunShield = true`, an occulting disc sits between the eye and the Sun. It works like a
coronagraph's occulter or a hand held up against the Sun. The option is off by default and works in
both view modes. The shell sets it from `RealityState.sunShield` (URL `shield=1`) and always shows the
badge "SUN SHIELDED: occulting disc (viewing aid)". It changes what reaches the eye, not the scene:

- **The disc.** It is centred on the Sun and follows it. Its angular radius is the Sun's plus one pixel,
  so it hides as little sky as possible. It is ideal: it neither emits nor reflects light, and its edge
  does not diffract. Real external occulters scatter and diffract light around their edge (the reason
  coronagraphs add a Lyot stop), but that light depends on the instrument, so none is invented. A
  larger disc, such as a hand at arm's length (≈ 10°), would hide more sky and is not offered. When the
  disc is in front of the camera, its rim is drawn as a thin grey display overlay, like the orbit lines.
- **What changes.** The Sun's light never enters the eye. There is no solar disk or point and no CIE 146
  veil from the Sun (§3, analytic glare). No solar light reaches the adaptation measurement or the pupil
  (§2, off-frame flux). Adaptation, thresholds and the painted glare therefore come from everything
  else. With the Sun in frame, the disc is excluded from fixations like the resolved solar disk (§2).
- **What stays physical.** Everything else is unchanged: sunlight on the bodies, planetshine and
  shadows, other sources' glare, and stars. Whatever lies behind the disc is hidden: bodies, rings,
  stars, extra point sources such as small bodies, and unresolved bodies whose centre is behind it.

The Sun's veil is light scattered inside the observer's eye, so blocking it before the eye is the
physical way to remove it. Lowering the veil after the fact would not be. The shield exists for
enhanced mode near the Sun. There, the exposure boost also multiplies the Sun's veil, which can hide
the asteroid belt within ~48° of the Sun as seen from a few AU above the ecliptic. For example, 4 AU
from the Sun at +6 stops, the unshielded frame is pure white, while the shielded frame shows the stars
and the small bodies (`/?target=10&dist=6e8&el=80&fov=100&view=enhanced&boost=6&shield=1`;
`render-test.html?scene=offscreen-sun&off=30&mode=enhanced&boost=6&shield=1`). `render-frame.test.ts`
checks that the Sun's light on the bodies is unaffected.

## 9. Constants and their verification status

| Source | Values | Status |
|---|---|---|
| Crumey 2014 | r₁…r₄, a₁…a₅, k₁…k₄, b₁…b₅, split points, 10⁻⁵ cd/m², ρ₂₈₅₀, F = 2, Z_V | verified against arXiv:1405.4209v1 |
| Pattanaik et al. 2000 | n, cone σ/B formulas, ref. white/black, Eq. 3 colour exponent, time constants | verified against the paper (rod Eq. 4 no longer used, see §4) |
| Hunt (2004) via Fairchild (2013) | F_LS (3800, 0.2, 10⁻⁵, 2.26, exponent 4), B_S (0.3, 0.3, 5), f_n half-point 2, HPE matrix | cross-checked against colour-science `colour.appearance.hunt` (which writes the F_LS exponent as 0.4; we follow Fairchild's 4) and against Pattanaik's cone path (tested equal) |
| Kirk & O'Brien 2011 | (not used: §5) | read (thesis version UCB/EECS-2011-91, Eqs. 5.3–5.9) |
| Watson & Yellott 2012 | 7.75, 5.75, 846, 0.41, 2, 28.58, 0.021323, 0.0095623, 0.1 | verified against the reference MATLAB implementation (Wheatley & Spitschan) |
| CIE 146:2002 | 10, 5, 0.1, 62.5, exponent 4, 0.0025, 0.1°–100° | **secondary-verified**: every constant matches the equation as reprinted in ch. 2 ("Introduction to straylight") of an Erasmus MC Rotterdam thesis (hdl.handle.net/1765/102424). The CIE report itself was not obtainable. |
| Watson 2013 | 21.95, −5.512, 0.3922, −0.62, 555 nm, √D | **secondary-verified** against an independent open implementation of Eqs. 4–5 (ISETBio/isetvalidate); the journal page was not retrievable. v1 fixed the missing square root. Fitted for 2–6 mm pupils. |
| CIE 191:2010 | a = 0.767, b = 0.3334, 683/1699, 0.005–5 cd/m² | **secondary-verified** against Maksimainen et al. (2019), LEUKOS 15(4):309, which prints the same system (with 683/1700, a 0.06 % rounding difference); a, b reproduce the range endpoints (tested). The standard itself was not obtainable. |
| IEC 61966-2-1 | XYZ→sRGB matrix, transfer function | standard values; round-trip tested |
| CIE 159:2004 | CAT02 matrix, D formula | standard values |
| IAU 2012 B2 | 1 au = 149 597 870.7 km | exact (in `render/constants.ts`; move to core/constants.ts when it exists) |
| Pigment kinetics (§2 "Time") | τ_cone 110 s, τ_rod 400 s | verified against Pattanaik et al. 2000 §4.1.2 (their consensus source: Hood & Finkelstein 1986, not read) |
| | cone I₀ = 10^4.3 td | **transcribed** (Rushton & Henry 1968 via secondary sources); consistent with Mahroo & Lamb 2004's σ⁻¹ = 710 cd·m⁻²·min (read in their paper) |
| | rod Q = 10^7.0 scot td·s | read in Thomas & Lamb 1999 (log 6.8–7.0 from Rushton & Powell 1972, Alpern & Pugh 1974; 7.0 adopted) |
| Alpern, Rushton & Torii 1970 | Dowling–Rushton a = 12 (1.2 log units per 10 % bleached) | read in the paper's summary (PMC1348717) |
| Ward Larson et al. 1997 | acuity fit 17.25, 1.4, 0.35, 25.72 | verified against the paper (Eq. 15 and the values in its text) |
| CSS Color 4 / SMPTE EG 432-1 | Display P3 primaries | matrix derived and checked against CSS Color 4's (tests) |

## 10. Known limitations and next steps

- **Time-dependent adaptation (M5)** is global: no afterimages of bleached regions (§2 "Time").
- **Foveal fixation is the view centre.** No eye tracking. Glare is evaluated as if each pixel were
  fixated, the standard approximation (the CIE equations are foveal).
- **Veil from off-screen sources** is included for the Sun and for every body whose centre is outside
  the frame (analytic CIE 146 veil, within 100° of fixation; `render-test.html?scene=offscreen-sun`
  shows the Sun's veil from just outside the frame). Starlight outside the frame does not scatter
  into it, so the veil darkens slightly within the pyramid's reach of the frame edges (visible only in
  dense star fields with enhanced mode). A guard band would fix it.
- **Rod hue shift** (Cao et al. 2008 / Kirk & O'Brien 2011) not implemented; mesopic scenes lose colour
  toward white rather than shifting toward blue.
- **Cone desensitisation after a bleach** is only the loss of photon catch (§2 "Time"). The cone
  Dowling–Rushton constant (Hollins & Alpern 1973) was not accessible, so cones recover faster and
  higher than real in the first minutes after a strong bleach.
- **Pupil dynamics**: the pupil follows the scene instantly. Real pupils constrict in ~1 s and dilate
  over seconds to minutes.
- **Afterimages** of bleached regions are not drawn: the pigment state is global, not per retinal
  location.
- **Watson (2013)** is extrapolated beyond its 6 mm fit range for dark-adapted pupils (≈7.9 mm); the
  resulting core (~0.8′) is sub-pixel at normal fields of view.
- **Acuity loss at low luminance** (§5b) uses the physical local luminance. A rod bleach does not
  lower acuity further.
- **Ricco summation for the brightness of a point** is our extension of a threshold result. It is
  exact at threshold by construction; above threshold it assumes brightness pools like detection. Since
  October 2026 only point sources use it; a resolved body carries no weight (§6.3).
  - Irikura, Taniguchi & Aoki (1993) measured the question directly for small lights. Four observers,
    adapted to a background of 0 to 10 cd/m², looked in turn at a 0.4′ reference light of 3·10⁻⁶ to
    3·10⁻⁴ lux and at a disk 1′, 3′, 9′, 27′ or 81′ across, and the disk's intensity was set to equal
    brightness. The intensity needed was 1.2, 1.6, 3.6, 13 and 73 times the reference's at 1 cd/m²
    (their Table 2). Without summation it would be the ratio of areas: 6, 56, 506 and more. Their
    conclusion: summation "is complete regardless of the background luminance for an area of less than
    10 min²", a disk 3.6′ across, and partial above.
  - Below the switch the rule agrees with them: a disk under 1.1′ to 2.2′ is a point of its total light.
  - **Between 2.2′ and about 3.6′ it does not.** There the rule draws a surface the eye is adapted to,
    at the same display luminance whatever its light; their observers still saw a light as bright as a
    point of 0.63 of its intensity. The conditions differ: their eye was adapted to the background and
    glanced at each light, ours is adapted to the disk it looks at. Their sizes step from 3′ to 9′, so
    the end of complete summation lies somewhere between, 1.4 to 4 times the diameter at which our switch
    ends. Diamond (1962) found no effect of area from 5.4′. The switch is not moved to fit one study: it
    belongs to the eye's point spread.
- **The step at the switch** from point to disk is a property of the two limits, not an error to be
  smoothed (§6.3).
- **A darker body beside a brighter one that sets the adaptation is shown too dark, down to black.**
  Callisto (147 cd/m²) in a frame adapted to Jupiter (A = 620 cd/m²) reaches the tone reproduction at
  u·L = 89 cd/m², 0.14 A. Pattanaik's reference black is 5A/32 = 0.156 A, and rule 2 maps it to the
  display's black, which is 0 cd/m² here (`displayBlackCdM2`). So Callisto is drawn at or near 0 at
  every resolved size, also at 9′ and 13′ across (mean level 0.3 and 3.8 of 255 on the GPU). Two things combine: one adaptation state for the extended
  image, and a display black of zero. On the display of Pattanaik et al.'s own paper (white 125, black
  4 cd/m²) the same surface is at 3.6 cd/m². On ours a surface at 0.2 A is at 1.0 cd/m², at 0.38 A
  (Ganymede beside Jupiter) at 7.9, against 36 at A. As a point Callisto is bright, because points are
  judged at their own fixation.
- **The acuity filter spreads dim small disks** (§5b). It takes the acuity of the average luminance of
  the 1° field around a pixel. For a small body in a dark field that average is dark, while the frame is
  adapted to the body by its light. Pluto 3′ across at a 1° field is shown at mean level 78 of 255 with
  its light over 7724 px; with the filter off, at 113 over 1144 px. Charon: 63 against 112. Triton: 84
  against 109. At 6′ Pluto is at 105 against 108. The filter's foveal luminance should follow the same
  rule as the frame's adaptation (the average over the 1° field weighted by light); not done.
  - The same filter, with the old weight stored per pixel of the sharp silhouette, drew a grey arc
    outside the sunlit limb of a dimmed disk. The arc went with the weight.
- **A disk 2 to 3 px across beside a brighter body is darkened** because pixel coverage is averaged
  before the tone reproduction (Ganymede beside Jupiter: mean level 15 at 2 px, 64 at 3 px).
- **A displayed disk smaller than the viewer's own Ricco area** (5′ radius, taken in scene angle) is
  summed by the viewer's eye; a point's display flux allows for that (§6.3 step 2), a disk's does not.
- **Rings and comae keep older criteria.** Rings become part of their planet's point by screen pixels,
  and a coma becomes a point below the Ricco area (`comets/layer.ts`). Neither was re-examined with the
  switch.
- **Cone bleaching** is off (see §4).
- **One adaptation state for the extended image (v2: fixation-weighted, §2).**
  - Two v1 failures are gone. A bright body filling half of a dark frame (the quarter Moon from
    6 000 km, or at a 0.8° field) no longer saturates. Fixating a bright star (Antares, V = 1) no longer
    costs the whole frame ~1.5 mag, because stars are judged at their own fixation.
  - Still global: a faint extended feature next to a far brighter one (earthshine beside the sunlit
    crescent) is shown as seen while looking at the bright part.
  - Rods: real faint-star vision uses parafoveal rods (the central ~1.25° is rod-free; Curcio et al.
    1990). The point observer uses the local background, which is foveal and parafoveal alike.
  - A fully local adaptation (Ledda et al. 2004; Ashikhmin 2002) is the next step if the flattening it
    brings is acceptable.
- **Adapted brightness across the range (v1).** A fully adapted surface (S/P 2.3), 200 cd/m² display:

  | adaptation (cd/m²) | 10⁻⁵ | 10⁻⁴ | 10⁻³ | 10⁻² | 0.1 | 1 | 10 | 10² | 10³ | 10⁴ | 10⁵ |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | display luminance (cd/m²) | 1.7 | 3.4 | 5.6 | 8.5 | 13.9 | 21.9 | 38.3 | 31.9 | 37.4 | 46.0 | 58.5 |
  | colour exponent k | 0.006 | 0.012 | 0.042 | 0.16 | 0.49 | 0.66 | 0.77 | 1 | 1 | 1 | 1 |

  v0's dip (display luminance 29 → 12 cd/m² between 10⁻³ and 0.1 cd/m², i.e. a starlit scene shown
  brighter than a moonlit one) is gone: it came from Pattanaik's rod Eq. 4 (§4), and brightness now
  rises monotonically from starlight to indoor levels (tested). A mild step remains between 10 and
  10² cd/m², where Pattanaik's appearance mapping switches from rule 1 (direct reproduction) to rule 2
  (compress the scene's white–black span into the display's); the scene observer's reference white
  crosses the display's there. That step is a property of the published rules and is kept.
  (`app/render-test.html?scene=neptune&dau=300` vs `dau=3000` compares mesopic and scotopic.)
- **Hunt effect** (colours look more colourful at higher luminance than the display can show) is not
  reproduced: the colour exponent is capped at 1.

## References

- Alpern, M., Pugh, E. N. (1974). The density and photosensitivity of human rhodopsin in the living
  retina. J. Physiol.
- Alpern, M., Rushton, W. A. H., Torii, S. (1970). The attenuation of rod signals by bleachings.
  J. Physiol. 207(2).
- Crawford, B. H. (1947). Visual adaptation in relation to brief conditioning stimuli. Proc. R. Soc. B
  134, 283–302. (Equivalent background.)
- Hollins, M., Alpern, M. (1973). Dark adaptation and visual pigment regeneration in human cones.
  J. Gen. Physiol. 62, 430–447.
- Hood, D. C., Finkelstein, M. A. (1986). Sensitivity to light. In Handbook of Perception and Human
  Performance, vol. 1, ch. 5. Wiley.
- Jacobs, D. E., Gallo, O., Cooper, E. A., Pulli, K., Levoy, M. (2015). Simulating the visual experience
  of very bright and very dark scenes. ACM TOG 34(3).
- Lamb, T. D. (1981). The involvement of rod photoreceptors in dark adaptation. Vision Res. 21,
  1773–1782.
- Lamb, T. D., Pugh, E. N. (2004). Dark adaptation and the retinoid cycle of vision. Prog. Retin. Eye
  Res. 23, 307–380.
- Mahroo, O. A. R., Lamb, T. D. (2004). Recovery of the human photopic electroretinogram after bleaching
  exposures: estimation of pigment regeneration kinetics. J. Physiol. 554.
- Patryas, L., Parry, N. R. A., Carden, D., Baker, D. H., Kelly, J. M. F., Aslam, T., Murray, I. J.
  (2013). Assessment of age changes and repeatability for computer-based rod dark adaptation.
  PMC3682089.
- Rushton, W. A. H., Henry, G. H. (1968). Bleaching and regeneration of cone pigments in man. Vision
  Res. 8.
- Rushton, W. A. H., Powell, D. S. (1972). The rhodopsin content and the visual threshold of human
  rods. Vision Res. 12.
- Shlaer, S. (1937). The relation between visual acuity and illumination. J. Gen. Physiol. 21, 165–188.
- Thomas, M. M., Lamb, T. D. (1999). Light adaptation and dark adaptation of human rod photoreceptors
  measured from the a-wave of the electroretinogram. J. Physiol. 518, 479.
- ITU-R BT.2408. Guidance for operational practices in HDR television production (203 cd/m² reference
  white).
- SMPTE EG 432-1:2010. Digital source processing: color processing for D-Cinema (P3 primaries).
- W3C, CSS Color Module Level 4 ('display-p3'); W3C, WebGPU (§21.4 canvas colour space, §21.5
  GPUCanvasToneMappingMode).

- Ashikhmin, M. (2002). A tone mapping algorithm for high contrast images. Proc. 13th Eurographics
  Workshop on Rendering, 145–156.
- Barlow, H. B. (1957). Increment thresholds at low intensities considered as signal/noise
  discriminations. J. Physiol. 136, 469–488.
- Blackwell, H. R. (1946). Contrast thresholds of the human eye. JOSA 36, 624–643.
- Cao, D., Pokorny, J., Smith, V. C., Zele, A. J. (2008). Rod contributions to color perception:
  linear with rod contrast. Vision Research 48, 2586–2592.
- CIE 146:2002 (Vos, J. J. et al.). CIE equations for disability glare. Commission Internationale de
  l'Éclairage.
- CIE 159:2004. A colour appearance model for colour management systems: CIECAM02.
- CIE 191:2010. Recommended system for mesopic photometry based on visual performance.
- Crawford, B. H. (1937). The change of visual sensitivity with time. Proc. R. Soc. B 123, 69–89.
- Crumey, A. (2014). Human contrast threshold and astronomical visibility. MNRAS 442, 2600–2619.
  doi:10.1093/mnras/stu992, arXiv:1405.4209.
- Ferwerda, J. A., Pattanaik, S. N., Shirley, P., Greenberg, D. P. (1996). A model of visual
  adaptation for realistic image synthesis. SIGGRAPH 96, 249–258.
- Fairchild, M. D. (2013). Color Appearance Models, 3rd ed. Wiley. (Ch. 12: the Hunt model.)
- Curcio, C. A., Sloan, K. R., Kalina, R. E., Hendrickson, A. E. (1990). Human photoreceptor
  topography. J. Comp. Neurol. 292, 497–523.
- Diamond, A. L. (1962). Brightness of a field as a function of its area. JOSA 52, 700–706. (Abstract and
  tables read, by the lane `ricco-research`; cited also by Irikura et al. 1993.)
- Hanes, R. M. (1951). Suprathreshold area brightness relationships. JOSA 41, 28–31. (Abstract only.)
- He, S., MacLeod, D. I. A. (1998). Contrast-modulation flicker: dynamics and spatial resolution of the
  light adaptation process. Vision Res. 38, 985–1000.
- Hecht, S. (1947). Visual thresholds of steady point sources in the eye. JOSA 37, 59.
- Higgins, K. E., Rinalducci, E. J. (1975). Suprathreshold intensity-area relationships: a spatial
  Broca-Sulzer effect. Vision Res. 15, 129–143. (Author abstract only.)
- Irikura, T., Taniguchi, T., Aoki, Y. (1993). Effect of spatial summation on brightness perception of a
  light at suprathreshold level. J. Illum. Engng. Inst. Jpn. 77(2), 90–94. doi:10.2150/jieij1980.77.2_90.
  (Read in full.)
- Hunt, R. W. G. (1995). The Reproduction of Colour, 5th ed. Fountain Press.
- Hunt, R. W. G. (2004). The Reproduction of Colour, 6th ed. Wiley.
- Ledda, P., Santos, L. P., Chalmers, A. (2004). A local model of eye adaptation for high dynamic
  range images. AFRIGRAPH 2004, 151–160.
- Maksimainen, M., Kurkela, M., Bhusal, P., Hyyppä, H. (2019). Calculation of mesopic luminance using
  per pixel S/P ratios measured with digital imaging. LEUKOS 15(4), 309–317.
  doi:10.1080/15502724.2018.1557526.
- IEC 61966-2-1:1999. Multimedia systems and equipment: colour measurement and management, Part 2-1:
  default RGB colour space (sRGB).
- Irawan, P., Ferwerda, J. A., Marschner, S. R. (2005). Perceptually based tone mapping of high
  dynamic range image streams. EGSR 2005.
- Kirk, A. G., O'Brien, J. F. (2011). Perceptually based tone mapping for low-light conditions.
  ACM TOG 30(4), 42 (SIGGRAPH 2011).
- Mantiuk, R., Daly, S., Kerofsky, L. (2008). Display adaptive tone mapping. ACM TOG 27(3), 68.
- MacLeod, D. I. A., Williams, D. R., Makous, W. (1992). A visual nonlinearity fed by single cones. Vision
  Res. 32, 347–363.
- Moon, P., Spencer, D. E. (1945). The visual effect of non-uniform surrounds. JOSA 35, 233–248. (Not
  read; known through Ward Larson et al. 1997, Eq. 8.)
- Protte, P., Hoffmann, S. M. (2020). Accuracy of magnitudes in pre-telescopic star catalogues.
  Astron. Nachr. 341; arXiv:2008.04967.
- Okabe, M., Ito, K. (2008). Color Universal Design (CUD): how to make figures and presentations that
  are friendly to colorblind people. (Palette used for the provenance tint.)
- Pattanaik, S. N., Tumblin, J., Yee, H., Greenberg, D. P. (2000). Time-dependent visual adaptation
  for fast realistic image display. SIGGRAPH 2000, 47–54.
- Ritschel, T., Ihrke, M., Frisvad, J. R., Coppens, J., Myszkowski, K., Seidel, H.-P. (2009).
  Temporal glare: real-time dynamic simulation of the scattering in the human eye. CGF 28(2), 183–192.
- Reinhard, E., Devlin, K. (2005). Dynamic range reduction inspired by photoreceptor physiology.
  IEEE TVCG 11(1), 13–24.
- Spencer, G., Shirley, P., Zimmerman, K., Greenberg, D. P. (1995). Physically-based glare effects
  for digital images. SIGGRAPH 95, 325–334.
- Schaefer, B. E. (1990). Telescopic limiting magnitudes. PASP 102, 212–229.
- Tuten, W. S., Cooper, R. F., Tiruveedhula, P., Dubra, A., Roorda, A., Cottaris, N. P., Brainard, D. H.,
  Morgan, J. I. W. (2018). Spatial summation in the human fovea: do normal optical aberrations and fixational
  eye movements have an effect? J. Vision 18(8):6. doi:10.1167/18.8.6.
- Schaefer, B. E. (1996), survey of experienced observers, as cited by Crumey (2014) §1.2 (not read).
- Ward, G. (1994). A contrast-based scalefactor for luminance display. Graphics Gems IV, 415–421.
- Ward Larson, G., Rushmeier, H., Piatko, C. (1997). A visibility matching tone reproduction operator
  for high dynamic range scenes. IEEE TVCG 3(4), 291–306.
- Watson, A. B. (2013). A formula for the mean human optical modulation transfer function as a
  function of pupil size. J. Vision 13(6):18. doi:10.1167/13.6.18.
- Yoshida, A., Ihrke, M., Mantiuk, R., Seidel, H.-P. (2008). Brightness of the glare illusion. APGV 2008,
  83–90.
- Watson, A. B., Yellott, J. I. (2012). A unified formula for light-adapted pupil size. J. Vision
  12(10):12. doi:10.1167/12.10.12.
