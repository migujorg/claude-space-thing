// Every constant of the human-eye model, each next to its published source.
// See docs/eye-model.md for how the stages fit together.
//
// Rule (NORTH_STAR 3.1, docs/architecture.md §1): nothing here is tuned to "look right". A value is
// either copied from the cited source, or derived from cited values (the derivation is written next
// to it). Observer/display *settings* (age, eye pigmentation, field factor, display peak) live in
// settings.ts with their defaults justified there.
//
// "Verified" means the value was checked against the source text itself while writing this module;
// "transcribed" means it was taken from a secondary reproduction of the source (flagged in
// docs/eye-model.md §9 for re-verification against the primary document).

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Crumey, A. (2014). Human contrast threshold and astronomical visibility. MNRAS 442, 2600–2619.
// doi:10.1093/mnras/stu992, arXiv:1405.4209. Verified against arXiv v1.
// Model fitted to Blackwell (1946, JOSA 36, 624) table 8 (50 % detection, 19–26 year-old observers,
// 2850 K sources) and Taylor (1960) large-target data.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const CRUMEY = {
  /** Point-source scotopic branch, Eq. 26: √R = r1·B^-1/4 + r2. */
  r1: 6.505e-4,
  r2: -8.461e-4,
  /** Point-source photopic branch, Eq. 27. */
  r3: 1.772e-4,
  r4: 7.167e-5,
  /** Split point between the two point-source branches, cd/m² (text after Eq. 27). */
  pointSplitB: 7.08e-2,
  /** Full-range point-source hyperbola, Eq. 28 (used with Eq. 25 / Eq. 34). */
  a1: 5.949e-8,
  a2: -2.389e-7,
  a3: 2.459e-7,
  a4: 4.12e-4,
  a5: -4.225e-4,
  /** Large-target threshold contrast C∞, scotopic branch Eq. 37 (with Eq. 35). */
  k1: 7.633e-3,
  k2: -7.174e-3,
  /** Photopic branch Eq. 38 (Weber: constant). */
  k3: 0,
  k4: 2.72e-3,
  /** Split point between the C∞ branches, cd/m² (text after Eq. 38). */
  largeSplitB: 3.54e-1,
  /** Full-range C∞ hyperbola, Eq. 40 (with Eq. 39). */
  b1: 9.606e-6,
  b2: -4.112e-5,
  b3: 5.019e-5,
  b4: 4.837e-3,
  b5: -4.884e-3,
  /**
   * Background luminance below which the eye treats the background as zero, cd/m²
   * (§2.1 "a background B ≲ 10⁻⁵ cd m⁻² is effectively zero for human vision, a finding also made by
   * Crawford (1937)"; §2.3 adopts a cut-off at this value). We also use it as the floor of the
   * adaptation luminance ("dark light").
   */
  zeroBackgroundB: 1e-5,
  /** S/P ratio of Blackwell's 2850 K sources (§1.3, from Planck + CIE V and V′). */
  spRatioBlackwell: 1.408,
  /** Notional typical overall field factor for actual observing (§3.1: "F = 2 (limit 6.18 mag)"). */
  typicalFieldFactor: 2,
  /** V-band zero point used by Crumey (§1.3, from Cox 1999, Allen's Astrophysical Quantities), lux. */
  zeroPointVLux: 2.54e-6,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Pattanaik, S. N., Tumblin, J., Yee, H., Greenberg, D. P. (2000). Time-dependent visual adaptation
// for fast realistic image display. Proc. SIGGRAPH 2000, 47–54. doi:10.1145/344779.344810.
// Verified against the paper. Their adaptation model is an abbreviation of Hunt (1995), The
// Reproduction of Colour, 5th ed., pp. 712, 721; "use cd/m² units in Equations 4–7".
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const PATTANAIK = {
  /** Naka–Rushton exponent (Hunt's modification of Valeton & van Norren 1983), §4.1.1. */
  n: 0.73,
  /** σ_rod = 2.5874·A / (19000·j²·A + 0.2615·(1−j²)⁴·A^(1/6)), j = 1/(5·10⁵·A + 1)   (Eq. 4) */
  rodSigmaNum: 2.5874,
  rodSigmaJ2: 19000,
  rodSigmaPow: 0.2615,
  rodJScale: 5e5,
  /** σ_cone = 12.9223·A / (k⁴·A + 0.171·(1−k⁴)²·A^(1/3)), k = 1/(5·A + 1)   (Eq. 5) */
  coneSigmaNum: 12.9223,
  coneSigmaPow: 0.171,
  coneKScale: 5,
  /** Bleaching: B_cone = 2·10⁶/(2·10⁶ + A_cone), B_rod = 0.04/(0.04 + A_rod)   (Eq. 6) */
  coneBleachHalf: 2e6,
  rodBleachHalf: 0.04,
  /** Reference white = 5 × adaptation luminance (Hunt), reference black = white/32   (§4.2, Eq. 8) */
  refWhiteFactor: 5,
  refBlackDivisor: 32,
  /** Neural adaptation time constants, s (§4.1.2) — for the time-dependent model (M5). */
  t0Rod: 0.15,
  t0Cone: 0.08,
  /** Pigment regeneration time constants, s, and depletion scales (Eq. 7a/7b) — for M5. */
  tauRod: 400,
  tauCone: 110,
  rodDepletion: 16,
  coneDepletion: 2.2e8,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Photopigment bleaching and dark adaptation (eye/bleaching.ts, docs/eye-model.md §2 "Time").
// First-order pigment kinetics (Rushton; Hood & Finkelstein 1986, Handbook of Perception and Human
// Performance ch. 5, eqs. 10–17, the "published consensus" Pattanaik et al. 2000 §4.1.2 cite):
//   dB/dt = I·(1 − B)/Q − B/τ,   B = bleached fraction, I = retinal illuminance (td),
// so a steady light bleaches B∞ = I/(I + I₀) with I₀ = Q/τ.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const PIGMENT = {
  /**
   * Cone pigment regeneration time constant, s: τ_cone = 110 s, the consensus value Pattanaik et al.
   * (2000, §4.1.2) take from Hood & Finkelstein (1986). Verified against Pattanaik's text.
   */
  coneTauS: 110,
  /**
   * Cone pigment half-bleaching retinal illuminance, photopic trolands: 10^4.3 td (Rushton & Henry 1968,
   * Vision Res. 8; the Rushton–Henry model Hollins & Alpern 1973, J. Gen. Physiol. 62, 430, fit).
   * Cross-check: Mahroo & Lamb (2004, J. Physiol. 554) fit σ⁻¹ = 710 cd·m⁻²·min with dilated pupils,
   * i.e. Q ≈ 1.6–2.1·10⁶ td·s for 7–8 mm, against I₀·τ = 2.2·10⁶ td·s here. TRANSCRIBED (secondary).
   */
  coneHalfBleachTd: Math.pow(10, 4.3),
  /** Rhodopsin regeneration time constant, s: τ_rod = 400 s (Hood & Finkelstein 1986 via Pattanaik §4.1.2). */
  rodTauS: 400,
  /**
   * Rhodopsin photosensitivity (bleaching constant) Q, scotopic td·s: log Q = 6.8–7.0 (Rushton & Powell
   * 1972, Vision Res. 12; Alpern & Pugh 1974, J. Physiol.); 7.0 as adopted by Thomas &
   * Lamb (1999, J. Physiol. 518, 479). Half-bleaching steady illuminance I₀ = Q/τ = 2.5·10⁴ scot td.
   */
  rodBleachTdS: 1e7,
  /**
   * Dowling–Rushton relation for human rods, log₁₀(threshold/absolute threshold) = a·B: "the log threshold
   * is raised 1·2 units for each 10 % of rhodopsin in the bleached state" (Alpern, Rushton & Torii 1970,
   * "The attenuation of rod signals by bleachings", J. Physiol. 207(2)), a = 12. Reviews give a ≈ 12–20 for man.
   */
  rodDowlingRushton: 12,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Visual acuity against luminance: Ward Larson, G., Rushmeier, H., Piatko, C. (1997), A visibility
// matching tone reproduction operator for high dynamic range scenes, IEEE TVCG 3(4), 291–306, Eq. 15:
//   R(L_a) = 17.25·arctan(1.4·log10(L_a) + 0.35) + 25.72   cycles/degree, L_a in cd/m²,
// "a functional fit" to Shlaer (1937), J. Gen. Physiol. 21, 165 (foveal grating acuity, "about
// 50 cycles/degree" in daylight, "about two" near the limit of vision). Verified against the paper.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const WARD1997_ACUITY = {
  scale: 17.25,
  logSlope: 1.4,
  logOffset: 0.35,
  offset: 25.72,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Hunt's colour-vision model: Hunt, R. W. G. (2004), The Reproduction of Colour, 6th ed., as given
// in Fairchild, M. D. (2013), Color Appearance Models, 3rd ed., ch. 12 "The Hunt model".
// Checked against the open-source implementation colour.appearance.hunt (colour-science).
// Pattanaik et al. (2000) abbreviate this model. Their cone path is identical to Hunt's
// (σ_cone = 12.9223·A/F_L(A); 12.9223 = 5·2^(1/0.73)), but their rod equation (Eq. 4) drops Hunt's
// /2.26 scaling and has a numerator 5× smaller than Hunt's and than their own display table
// (σ_rod = 722 cd/m² at A = 25). That makes rods ~5× too sensitive, which caused v0's mesopic
// brightness dip. Eye model v1 therefore uses Hunt's rod path.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const HUNT = {
  /** f_n(x) = 40·x^0.73/(x^0.73 + 2): responses are half-maximal at x = 2^(1/0.73). */
  fnHalf: 2,
  /** Scotopic luminance-level adaptation factor:
   *  F_LS = 3800·j²·(5·L_AS/2.26) + 0.2·(1 − j²)⁴·(5·L_AS/2.26)^(1/6),  j = 1e-5/(5·L_AS/2.26 + 1e-5).
   *  (colour-science writes the (1 − j²) exponent as 0.4; Pattanaik's abbreviation and Fairchild use 4.) */
  flsJ2: 3800,
  flsPow: 0.2,
  flsJ: 1e-5,
  scotopicScale: 2.26,
  flsExpJ: 4,
  /** Rod saturation B_S = 0.5/(1 + 0.3·((5·L_AS/2.26)·S/S_w)^0.3) + 0.5/(1 + 5·(5·L_AS/2.26)). */
  bsA: 0.3,
  bsExp: 0.3,
  bsB: 5,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Hecht, S. (1947), JOSA 37, 59: two-branch point-source threshold ΔI = c·(1 + √(K·B))², in modern
// units as given by Crumey (2014) Eq. 20. Its photopic (cone) branch at B → 0 is the cone system's
// point threshold, the constant Schaefer (1990, PASP 102, 212) uses for the "day" branch. Used only to
// validate the onset of star colour (tests, docs/eye-model.md §6), not in rendering.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const HECHT1947 = {
  /** Cone (photopic) branch: c (lux), K (per cd/m²), valid for B ≥ 1.645e-2 cd/m². */
  coneC: 4.808e-8,
  coneK: 1.259e-1,
  /** Rod (scotopic) branch. */
  rodC: 1.706e-9,
  rodK: 1.259e3,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CIE 191:2010, Recommended System for Mesopic Photometry Based on Visual Performance.
// Verification (eye model v1): the standard itself was not obtainable. Cross-checked against the
// published reproduction of the CIE 191 system in Maksimainen, Kurkela, Bhusal, Hyyppä (2019),
// "Calculation of Mesopic Luminance Using per Pixel S/P Ratios Measured with Digital Imaging",
// LEUKOS 15(4):309–317, doi:10.1080/15502724.2018.1557526 (same a, b, range and iteration; it
// prints V′(λ0) as 683/1700, a 0.06% rounding difference), and against m(0.005)=0, m(5)=1 (tests).
// Status: SECONDARY-VERIFIED.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const CIE191 = {
  /** V′(λ0) at λ0 = 555 nm, written in the standard as 683/1699. */
  vPrimeLambda0: 683 / 1699,
  /** m = a + b·log10(L_mes), clamped to [0, 1]. */
  a: 0.767,
  b: 0.3334,
  /** Mesopic range of L_mes, cd/m². */
  lowerCdM2: 0.005,
  upperCdM2: 5,
  /** Starting value of the iteration. */
  m0: 0.5,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Watson, A. B., Yellott, J. I. (2012). A unified formula for light-adapted pupil size.
// J. Vision 12(10):12. doi:10.1167/12.10.12. Constants verified against the reference MATLAB
// implementation of the paper (Wheatley & Spitschan, WatsonYellott2012_PupilSize, wy_getPupilSize.m).
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const WATSON_YELLOTT = {
  /** Stanley & Davies (1995) core: D = 7.75 − 5.75·(F/846)^0.41 / ((F/846)^0.41 + 2), F in cd·m⁻²·deg². */
  dMax: 7.75,
  dRange: 5.75,
  fluxScale: 846,
  exponent: 0.41,
  denomOffset: 2,
  /** Monocular effect M(e): F is multiplied by 0.1 for one eye, 1 for two. */
  monocularFactor: 0.1,
  /** Reference age, years, and age slope S(D) = 0.021323 − 0.0095623·D (mm/year). */
  refAge: 28.58,
  ageSlopeA: 0.021323,
  ageSlopeB: 0.0095623,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CIE 146:2002 (Vos, J. J. et al.), CIE equations for disability glare. "General disability glare
// equation", valid 0.1° ≤ θ ≤ 100°:
//   L_veil / E_glare = 10/θ³ + (5/θ² + 0.1·p/θ)·(1 + (A/62.5)⁴) + 0.0025·p     [sr⁻¹, θ in degrees]
// Verification (eye model v1): the CIE document itself was not obtainable. All constants (10, 5,
// 0.1·p, 62.5, exponent 4, 0.0025·p, validity 0.1°–100°) cross-checked against the equation as
// reprinted in "Introduction to straylight", ch. 2 of an Erasmus MC Rotterdam thesis on the C-Quant
// straylight meter (hdl.handle.net/1765/102424). Status: SECONDARY-VERIFIED (docs/eye-model.md §9).
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const CIE146 = {
  c3: 10,
  c2: 5,
  c1: 0.1,
  c0: 0.0025,
  ageScale: 62.5,
  minDeg: 0.1,
  maxDeg: 100,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Watson, A. B. (2013). A formula for the mean human optical modulation transfer function as a
// function of pupil size. J. Vision 13(6):18. doi:10.1167/13.6.18.
//   M(u, d) = √D(u, d, λ) · (1 + (u/u1(d))²)^(−0.62),  u1(d) = 21.95 − 5.512·d + 0.3922·d²  (Eqs. 4–5)
// Verification (eye model v1): the journal page was not retrievable (bot wall); checked against an
// independent open implementation of Eqs. 4–5 (ISETBio / isetvalidate), which applies the SQUARE ROOT
// of the diffraction-limited MTF. v0 omitted the square root (it made the optical core too narrow);
// fixed in v1. Status: SECONDARY-VERIFIED (implementation), not against the paper's own text.
//   D = diffraction-limited MTF of a circular pupil, cutoff u0 = d·π·10⁶ / (λ·180) cycles/deg
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const WATSON2013 = {
  u1c0: 21.95,
  u1c1: -5.512,
  u1c2: 0.3922,
  exponent: -0.62,
  lambdaNm: 555,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// IEC 61966-2-1:1999 (sRGB). XYZ (D65, Y=1 at display white) → linear sRGB, and the transfer function.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const SRGB = {
  xyzToRgb: [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.204, 1.057] as const,
  /** Display white chromaticity (D65). */
  whiteX: 0.3127,
  whiteY: 0.329,
  encodeThreshold: 0.0031308,
  linearSlope: 12.92,
  gammaScale: 1.055,
  gammaOffset: 0.055,
  gamma: 2.4,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CIE 159:2004 (CIECAM02) chromatic adaptation transform CAT02 and degree of adaptation
//   D = F·[1 − (1/3.6)·exp((−L_A − 42)/92)],  F = 1.0 for an "average" surround.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const CAT02 = {
  m: [0.7328, 0.4296, -0.1624, -0.7036, 1.6975, 0.0061, 0.003, 0.0136, 0.9834] as const,
  surroundF: 1.0,
  dScale: 3.6,
  dOffset: 42,
  dWidth: 92,
} as const;
