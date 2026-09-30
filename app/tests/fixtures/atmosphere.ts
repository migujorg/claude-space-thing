// TEST FIXTURE — not data. An Earth-like pure-Rayleigh atmosphere with an exponential profile, used only by
// the renderer's unit tests and the render-test page to exercise the atmosphere tables before the
// pipeline's atmospheres.json exists. The numbers are round test values, not a description of the Earth.

import type { AtmosphereModel } from '../../src/render/atmosphere';

/** Rayleigh-like fixture: β(λ) = β550·(550/λ)⁴ at the bottom, scale height `scaleKm`, no absorption. */
export function fixtureRayleighAtmosphere(opts: { beta550?: number; scaleKm?: number; bottomKm?: number; topKm?: number; albedo?: number; ozone?: boolean } = {}): AtmosphereModel {
  const beta550 = opts.beta550 ?? 0.0116; // km⁻¹ (test value)
  const Hs = opts.scaleKm ?? 8;
  const bottom = opts.bottomKm ?? 6371;
  const top = opts.topKm ?? bottom + 100;
  const wl = [400, 440, 480, 520, 560, 600, 640, 680];
  const alts = Array.from({ length: 51 }, (_, i) => (i * (top - bottom)) / 50);
  const scattering = alts.map((h) => wl.map((l) => beta550 * (550 / l) ** 4 * Math.exp(-h / Hs)));
  const zero = alts.map(() => wl.map(() => 0));
  // Flat test weights: each channel averages all bins equally.
  const weights = [0, 1, 2, 3].map(() => wl.map(() => 1 / wl.length));
  const species: AtmosphereModel['species'] = [{ name: 'fixture rayleigh', scattering, absorption: zero, phase: { kind: 'rayleigh', depolarization: wl.map(() => 0) } }];
  if (opts.ozone) {
    // Test absorber: a layer at 20–30 km absorbing only in the 560–640 nm bins.
    species.push({ name: 'fixture absorber', scattering: zero, absorption: alts.map((h) => wl.map((l) => (h >= 20 && h <= 30 && l >= 560 && l <= 640 ? 0.002 : 0))), phase: { kind: 'none' } });
  }
  return { bottomKm: bottom, topKm: top, altitudesKm: alts, wavelengthsNm: wl, weights, species, groundAlbedo: wl.map(() => opts.albedo ?? 0) };
}
