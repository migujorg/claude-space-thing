# Verbiscer et al. (2022) — Triton albedo, colour and phase coefficient (`verbiscer-2022`) — transcription

**Citation:** Verbiscer, A. J., Helfenstein, P., Porter, S. B., Benecchi, S. D., Kavelaars, J. J., Lauer, T. R., Peng, J., Protopapa, S., Spencer, J. R., Stern, S. A., Weaver, H. A., Buie, M. W., Buratti, B. J., Olkin, C. B., Parker, J., Singer, K. N. & Young, L. A. (2022). The diverse shapes of dwarf planet and large KBO phase curves observed from New Horizons. *The Planetary Science Journal* 3, 95. DOI [10.3847/PSJ/ac63a6](https://doi.org/10.3847/PSJ/ac63a6). The publisher answers scripted downloads with a bot-check page. The sha256 is that of the copy retrieved by hand on 2026-09-30, which a build accepts at `data/raw/papers/Verbiscer2022_PSJ3_95.pdf`.

**Transcribed** (`tables/verbiscer_2022.json`):
- Table 2 (p. 2), checked against a 200 dpi rendering:
  - Triton: D = 2706.8 km, p_V = 0.86 ± 0.004, B−V = 0.791 ± 0.002, V−R = 0.608 ± 0.002 (refs. Buratti et al. 2011, *Icarus* 212, 835; Cruikshank et al. 1993).
  - Charon: D = 1212 km, p_V = 0.41 ± 0.01, B−V = 0.7315 ± 0.0013, V−R = 0.4.
- Table 3 (p. 4), Triton: β_V = 0.025 ± 0.005 mag/deg over 0.0022–1.26° (2000–2004, Buratti et al. 2011).

**Use:**
- **Triton spectrum:** p linear in λ, fixed by the Bessell B and V band averages from p_V (rescaled to the pck00011 radius) and B−V with the solar B−V of Willmer (2018). Label **estimated**. V−R is not used because its photometric system is not stated.
- **Triton phase function:** poly-mag [0, 0.025], 0–1.26°. Label **measured**. Triton's very narrow coherent-backscatter spike below ~0.01° is not represented. The paper's Hapke model of the full phase curve (Voyager and New Horizons, to 94°) is not evaluated here.
- **Charon:** Table 2's p_V = 0.41 is only compared. The Charon entry is built from Buie et al. (2010), which implies p_V = 0.51 with its surge-inclusive Hapke extrapolation (see `buie-2010a.md` and the report).
