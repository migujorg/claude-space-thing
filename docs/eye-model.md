# Human eye model v0

The renderer turns absolute light into what a human eye placed in the scene would perceive
(NORTH_STAR §3.4 step 4). This document explains each stage, where every number comes from, what we
chose where the literature offers alternatives, and where v0 deviates from a published model.

Code: `app/src/eye/` (pure TypeScript reference, unit-tested) and the per-pixel mirror in
`app/src/render/shaders.ts`. Constants live in `app/src/eye/constants.ts`, each next to its citation.
Observer and display *settings* (age, pigmentation, field factor, display peak) are in
`app/src/eye/settings.ts`.

```
HDR scene (X, Y, Z, S luminance, cd/m²)          points (stars, unresolved bodies) as luminance E/Ω
        │                                                  │
        ├──► intraocular scatter (CIE 146) ──► veil ◄──────┤   §3  (+ analytic veil: Sun, off-frame bodies)
        │                                                  │
        ├──► adaptation: 1° foveal mean of retinal image ──┼──► A_cone, A_rod, pupil (Watson & Yellott)   §2
        │                                                  │
        │    visibility: Crumey threshold at max(A, local background) culls points   §6
        │                                                  │
        └──► perceived image: Ricco summation of small sources ─► rod + cone responses (Pattanaik 2000)
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

**Field.** The eye is assumed to fixate the centre of the view (the shell centres what the user looks
at). The adaptation field is a 1°-diameter foveal disk around the fixation point, following the
"1-degree foveal weighting" of Ward Larson, Rushmeier & Piatko (1997), which Pattanaik et al. (2000,
§4.1.2) use as their adaptation goal finder. Setting: `adaptationFieldDeg`.

**Statistic.** The solid-angle-weighted arithmetic mean of the *retinal image* over that field: the
unscattered scene plus the intraocular veil from every glare source (§3). Including the veil follows
Moon & Spencer (1945): the adaptation state in a non-uniform field is that of the fixated luminance plus
the equivalent veiling luminance of the surround. The cores of point sources are excluded (a star's
image covers a few receptors, not the adaptation pool); their scattered light is included. Photopic
(A_cone, from Y) and scotopic (A_rod, from S) means are measured separately.

**Floor.** Both are floored at the luminance below which vision treats the background as zero:
10⁻⁵ cd/m² (Crumey 2014 §2.1 and §2.3, after Crawford 1937), ×1.408 for the scotopic channel
(the S/P ratio of Blackwell's light, §6).

**Measurement.** A compute pass reduces the field on the GPU; the result is read back asynchronously
(one frame of latency). `Renderer.settled()` drives frames until the adaptation used to render a
frame agrees with the one measured from it (|Δ ln A| < 10⁻³ and a stable corneal flux) twice in a row.

**Time.** v0 adapts instantly. `AdaptationState` already has Pattanaik's structure: neural
adaptation as first-order exponential filters (t₀ = 80 ms cones, 150 ms rods) and pigment kinetics
(τ = 110 s cones, 400 s rods). Switching `timeDependent` on is M5 work.

**Pupil.** Watson & Yellott (2012) unified formula: D = D_SD(F) + (y − y₀)(0.021323 − 0.0095623·D_SD),
D_SD(F) = 7.75 − 5.75·(F/846)^0.41/((F/846)^0.41 + 2), y₀ = 28.58, F = L·a·M(e) with M = 1 binocular
and 0.1 monocular. For a non-uniform scene we use F = ∫ L dΩ over the rendered field (cd·m⁻²·deg²),
the "effective corneal flux density" the formula is built on. The pupil sets the optical PSF core (§3)
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
composite keeps 1 − Σw of the light unscattered, so energy is conserved exactly. Light scattered
beyond the frame edge is lost (the scene outside the frame is not rendered).

The Sun, and bodies whose centre is outside the frame, are veiled analytically per pixel
(E·f_CIE(θ)), because their glare reaches far beyond the frame and the Sun's disk is too bright for a
pyramid. The Sun's E is reduced by the fraction of its disk covered by bodies in front of it. A source
contributes only if it lies within 100° of the fixation direction (the CIE validity range, and
roughly the extent of the visual field); within the frame θ is clamped to that range.

**Optical core.** Watson (2013) mean optical MTF of the best-corrected eye as a function of pupil
diameter d: M(u, d) = D(u, d, 555 nm)·(1 + (u/u₁(d))²)^−0.62, u₁ = 21.95 − 5.512·d + 0.3922·d², D the
diffraction-limited MTF. The equivalent Gaussian of the PSF (same peak: σ² = 1/(2π·2π∫M u du)) is the
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

**Forward model** (per pixel, Eq. 2, 4, 5, 6): R = B·Lⁿ/(Lⁿ + σⁿ), n = 0.73, for cones on L = Y
and for rods on L = S, with

σ_cone(A) = 12.9223·A / (k⁴A + 0.171(1 − k⁴)²A^(1/3)), k = 1/(5A + 1)
σ_rod(A) = 2.5874·A / (19000·j²A + 0.2615(1 − j²)⁴A^(1/6)), j = 1/(5·10⁵A + 1)
B_rod = 0.04/(0.04 + A_rod)  (rod saturation), B_cone = 2·10⁶/(2·10⁶ + A_cone).

R_lum = R_rod + R_cone. Reference white/black = responses at 5A and 5A/32 (Eq. 8).

**Inverse model.** The display observer is steadily adapted to peak/5 (Hunt's "reference white = 5 ×
adaptation"; the paper's CRT: peak 125, A = 25); its reference white is the display peak (setting,
default 200 cd/m²) and its reference black the display black level (setting, default 0). The paper's
four rules (§4.3) map scene responses to display responses (direct reproduction; compress span;
offset down; offset up), and the inverse of Eq. 2 gives display luminance. The display observer's rods
(B_rod = 0.0016 in the paper) are neglected in the inverse (< 0.2 % of the response).
Checks: our Eq. 5 gives the paper's σ_cone = 646 cd/m² at A = 25 and B_rod = 0.0016, and the display
slope between 4 and 125 cd/m² is the paper's S_d = 0.1383 per decade (tests). The paper's table lists
σ_rod = 722 cd/m²; Eq. 4 gives 145 cd/m² at A = 25 (the table appears to be 5× Eq. 4). We compute all
display constants from the equations, and σ_rod of the display is unused.

**Deviations in v0** (both documented in code):

1. *Cone bleaching off* (`coneBleaching: false`). Hunt's steady-state B_cone only departs from 1
   above ~10⁵ cd/m², i.e. when fixating the solar disk (B_cone ≈ 10⁻³ there). Pattanaik's appearance
   rules then map the tiny bleached response to near black: the Sun would render darker than a dim
   room, contradicting the universal report of a blinding white Sun. We keep B_cone = 1 until the
   time-dependent model (M5) can represent bleaching as a transient, with afterimages. Rod saturation
   (B_rod) is kept, since without it rods would respond in daylight.
2. *Dark-light pedestal.* The Naka–Rushton response gives any luminance, however small, a response
   that the appearance model shows as grey. Vision cannot distinguish luminances below its intrinsic
   noise ("dark light", Barlow 1957; the flat threshold for B → 0 in Crumey 2014 §2.1, B ≲ 10⁻⁵ cd/m²).
   We use R(L + L₀) − R(L₀) with L₀ = 10⁻⁵ cd/m² (×1.408 scotopic). Darkness stays black, and a
   faint veil below dark light stays near black, as it would look.

## 5. Mesopic and scotopic vision

- **Purkinje shift** follows directly from driving the rod response with the true scotopic luminance
  S. Bluish surfaces have higher S/Y and so gain relative brightness as rods take over.
- **Rod intrusion** into brightness is R_lum = R_rod + R_cone. Rods saturate (B_rod → 0) above a few
  cd/m², so daylight scenes are pure cone vision.
- **Loss of colour.** Rods have no chromatic channel. The displayed chromaticity is mixed toward the
  display white by the rod share of the response: chroma = white + (R_cone/R_lum)·(chroma − white).
  This is our construction on top of Pattanaik's model, whose colour term (Eq. 3) is a saturation
  exponent that does not model the rod share and would distort measured colours. Tested: the cone
  share is > 95 % for surfaces adapted at ≥ 5 cd/m² and < 5 % at 10⁻⁴ cd/m².
- **CIE 191:2010** mesopic photometry (m = 0.767 + 0.3334·log10 L_mes, iterated from m = 0.5,
  V′(λ0) = 683/1699) sets how photopic and scotopic quantities combine for *visual performance*, i.e.
  the visibility thresholds (§6).
- **Not in v0:** the rod-induced hue shift toward blue at mesopic levels (Cao, Pokorny, Smith &
  Zele 2008; used for tone mapping by Kirk & O'Brien 2011). Kirk & O'Brien's formulation needs rod and
  cone signals on an absolute scale that the paper leaves as a user exposure parameter. Implementing
  it properly needs Cao et al.'s troland-based gains, and is the next step for colour at low light.

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

**Background.** B = max(adaptation, local background). The eye's sensitivity is set by its adaptation
(looking at a sunlit planet hides the stars even against black sky) unless the local background is
brighter. The local background is the Ricco-weighted veil (§4) at the star plus the analytic veil. It
comes from the previous frame, and excludes each star's own near-core scatter, which would otherwise
mask the star itself.

**Test of the whole chain.** Under a dark sky of 21.5–22 mag/arcsec² (sky S/P 1.38, Crumey §1.3), the
model gives naked-eye limits between V ≈ 6.0 and 7.0 for star colours B−V = 0 … 1.5 (S/P from
Crumey Eq. 13), and 6.18 for a 2850 K-coloured star at 21.83 (tests). In space with no sky
background (v0 has no zodiacal light or diffuse Galactic light yet), the zero-background cut-off gives
V ≈ 7.6 with F = 2.

**Culling.** On the GPU, each star whose Blackwell-equivalent illuminance is below F·ΔI(B) (÷ the
enhanced boost) is not drawn. Unresolved bodies use the same test on the CPU.

**Perceived brightness of small sources: Ricco summation.** A point's image is far smaller than the
area over which the eye sums light at low luminance, so its pixel luminance says little about how
bright it looks. Crumey's Ricco area A_R(B) = ΔI/ΔB∞ (Eq. 22/59, with C∞ from Eq. 39/40) is defined so
that a point of illuminance E is exactly as detectable as a patch of area A_R and luminance E/A_R.
The perceived image therefore uses the point's equivalent luminance E/A_R (weight A_footprint/A_R on
the point layer). A resolved body of angular area A_t < A_R gets weight A_t/A_R, which makes the
point-to-disk transition continuous. Scattered light at scales below A_R gets weight A_k/A_R per
pyramid level. At threshold this displays a star as a large-field threshold increment, i.e. just
visible; brighter stars scale with the same response curve. Physical buffers, adaptation and glare
are unaffected: this weighting applies only to what the tone reproduction sees.

## 7. Display encoding

1. **Chromatic adaptation.** CAT02 (CIE 159:2004, CIECAM02) from the adapted white, sunlight (the
   Sun's XYZ from data), to the display white (D65). The degree of adaptation is
   D = F[1 − (1/3.6)e^((−L_A−42)/92)], with F = 1 (average surround) and L_A = the adaptation
   luminance. A spectrally flat surface in sunlight shows as display white, as for an observer
   adapted to sunlight.
2. **XYZ → linear sRGB** with the IEC 61966-2-1 matrix, relative to the display peak.
3. **Gamut mapping.** Out-of-gamut colours (negative components) and colours too bright for the
   display in their hue (a component > 1) move toward the achromatic colour of the same luminance
   (g·(1,1,1)) just far enough to fit, which preserves luminance and dominant hue. Luminance above
   the display peak becomes display white.
4. **sRGB transfer function** (IEC 61966-2-1).
5. **Dither.** Triangular-PDF noise of ±1 LSB before 8-bit quantisation, against banding in dark
   gradients such as glare falloff.

## 8. Enhanced mode

`view.mode = 'enhanced'` multiplies the perceived scene luminance by 2^exposureBoostStops before the
response model. Adaptation still comes from the physical scene. The visibility threshold is divided
by the same factor: +3 stops raises the limiting magnitude by 2.5·log₁₀ 8 = 2.26 mag (tested). The shell
shows the badge.

## 9. Constants and their verification status

| Source | Values | Status |
|---|---|---|
| Crumey 2014 | r₁…r₄, a₁…a₅, k₁…k₄, b₁…b₅, split points, 10⁻⁵ cd/m², ρ₂₈₅₀, F = 2, Z_V | verified against arXiv:1405.4209v1 |
| Pattanaik et al. 2000 | n, σ/B formulas, ref. white/black, time constants | verified against the paper |
| Kirk & O'Brien 2011 | (not used in v0) | read |
| Watson & Yellott 2012 | 7.75, 5.75, 846, 0.41, 2, 28.58, 0.021323, 0.0095623, 0.1 | verified against the reference MATLAB implementation (Wheatley & Spitschan) |
| CIE 146:2002 | 10, 5, 0.1, 62.5, 0.0025, 0.1°–100° | transcribed from secondary reproductions; **verify against the report** |
| Watson 2013 | 21.95, −5.512, 0.3922, −0.62, 555 nm | transcribed; **verify against the paper** (fitted for 2–6 mm pupils) |
| CIE 191:2010 | a = 0.767, b = 0.3334, 683/1699, 0.005–5 cd/m² | transcribed; a, b reproduce the range endpoints (tested) |
| IEC 61966-2-1 | XYZ→sRGB matrix, transfer function | standard values; round-trip tested |
| CIE 159:2004 | CAT02 matrix, D formula | standard values |
| IAU 2012 B2 | 1 au = 149 597 870.7 km | exact (in `render/constants.ts`; move to core/constants.ts when it exists) |

## 10. Known limitations and next steps

- **Instant adaptation.** No dark adaptation over minutes, bleaching or afterimages (M5).
- **Foveal fixation is the view centre.** No eye tracking. Glare is evaluated as if each pixel were
  fixated, the standard approximation (the CIE equations are foveal).
- **Veil from off-screen sources** is included only for the Sun and bodies (analytically). Starlight
  and planet disks outside the frame do not scatter into it, so the veil darkens slightly within the
  pyramid's reach of the frame edges (visible only in dense star fields with enhanced mode). A guard
  band would fix it.
- **No sky background yet** (zodiacal light, diffuse Galactic light, Milky Way; M4). In space this
  makes the dark-adapted limit V ≈ 7.6 instead of ~7.
- **Rod hue shift** (Cao et al. 2008 / Kirk & O'Brien 2011) not implemented; mesopic scenes lose colour
  toward white rather than shifting toward blue.
- **Watson (2013)** is extrapolated beyond its 6 mm fit range for dark-adapted pupils (≈7.9 mm); the
  resulting core (~0.8′) is sub-pixel at normal fields of view.
- **Acuity loss at low luminance** (Ferwerda et al. 1996; Shaler 1937) is not modelled; spatial detail
  is not blurred in the dark.
- **Ricco summation for supra-threshold brightness** is our extension of a threshold result. It is
  exact at threshold by construction; above threshold it assumes brightness pools like detection.
- **Cone bleaching** is off (see §4).
- **Brightness dips in the mesopic range.** A fully adapted surface (S/P 2.3), 200 cd/m² display:

  | adaptation (cd/m²) | 10⁻⁵ | 10⁻⁴ | 10⁻³ | 10⁻² | 0.1 | 1 | 10 | 10² | 10³ | 10⁴ | 10⁵ |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | display luminance (cd/m²) | 9 | 19 | 29 | 27 | 12 | 13 | 25 | 31 | 37 | 46 | 58 |
  | cone share of response | 0.00 | 0.00 | 0.01 | 0.07 | 0.52 | 0.93 | 1.00 | 1 | 1 | 1 | 1 |

  The rise through the photopic range is the intended "adapted scenes look similar, brighter scenes a
  little brighter" (Neptune vs Earth distance). The dip between 10⁻³ and 1 cd/m², where a scotopic
  scene displays brighter than a mesopic one, comes from Pattanaik's simplification
  R_lum = R_rod + R_cone of Hunt's model, which weights rod and cone responses equally. Hunt's full
  achromatic signal weights the rod signal separately. Adopting it, or Kirk & O'Brien's (2011) mesopic
  range reduction once its parameters can be tied to data, is the fix for eye model v1.
  (`app/render-test.html?scene=neptune&dau=300` vs `dau=3000` shows it.)

## References

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
- Hunt, R. W. G. (1995). The Reproduction of Colour, 5th ed. Fountain Press.
- IEC 61966-2-1:1999. Multimedia systems and equipment: colour measurement and management, Part 2-1:
  default RGB colour space (sRGB).
- Irawan, P., Ferwerda, J. A., Marschner, S. R. (2005). Perceptually based tone mapping of high
  dynamic range image streams. EGSR 2005.
- Kirk, A. G., O'Brien, J. F. (2011). Perceptually based tone mapping for low-light conditions.
  ACM TOG 30(4), 42 (SIGGRAPH 2011).
- Mantiuk, R., Daly, S., Kerofsky, L. (2008). Display adaptive tone mapping. ACM TOG 27(3), 68.
- Moon, P., Spencer, D. E. (1945). The visual effect of non-uniform surrounds. JOSA 35, 233–248.
- Okabe, M., Ito, K. (2008). Color Universal Design (CUD): how to make figures and presentations that
  are friendly to colorblind people. (Palette used for the provenance tint.)
- Pattanaik, S. N., Tumblin, J., Yee, H., Greenberg, D. P. (2000). Time-dependent visual adaptation
  for fast realistic image display. SIGGRAPH 2000, 47–54.
- Reinhard, E., Devlin, K. (2005). Dynamic range reduction inspired by photoreceptor physiology.
  IEEE TVCG 11(1), 13–24.
- Spencer, G., Shirley, P., Zimmerman, K., Greenberg, D. P. (1995). Physically-based glare effects
  for digital images. SIGGRAPH 95, 325–334.
- Ward, G. (1994). A contrast-based scalefactor for luminance display. Graphics Gems IV, 415–421.
- Ward Larson, G., Rushmeier, H., Piatko, C. (1997). A visibility matching tone reproduction operator
  for high dynamic range scenes. IEEE TVCG 3(4), 291–306.
- Watson, A. B. (2013). A formula for the mean human optical modulation transfer function as a
  function of pupil size. J. Vision 13(6):18. doi:10.1167/13.6.18.
- Watson, A. B., Yellott, J. I. (2012). A unified formula for light-adapted pupil size. J. Vision
  12(10):12. doi:10.1167/12.10.12.
