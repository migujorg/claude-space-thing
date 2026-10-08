# CFEPS L7 discovery characterization

Source publication: Petit et al. (2011), *AJ* 142, 131,
[DOI:10.1088/0004-6256/142/4/131](https://doi.org/10.1088/0004-6256/142/4/131),
[author manuscript v1](https://arxiv.org/pdf/1108.4836v1), sections 2–4 and Table 1.
The L7 realization is fitted to the CFEPS near-ecliptic survey (2003–2007,
follow-up through 2009), including the 2002 presurvey; it is not fitted to
OSSOS, HiLat or the Alexandersen survey. The latter characterizations are
supported by the simulator but are not inputs to this veto.

The unmodified text inputs under `pipeline/src/pipeline/syn_tables/cfeps/`
come from the public [OSSOS SurveySimulator CFEPS directory](https://github.com/OSSOS/SurveySimulator/tree/8e615762278566c2c524c2acc2e1526c172c3c82/F95/tests/Surveys/CFEPS),
pinned to commit `8e615762278566c2c524c2acc2e1526c172c3c82`.
Although packaged under the simulator's tests, these are the published survey
records (45 pointings, 22 efficiency definitions), not Space Thing fixtures.
The geometries, dates, depths and rates match the survey blocks of Table 1.
`cfeps.json` records every raw file's URL, byte size, SHA256 and retrieval
instant. SourceRecord SHA256 hashes the sorted-key JSON serialization of its
`files` list. The parser verifies individual raw bytes on every read.
The upstream repository licenses its distribution under EUPL.

Per pointing: rectangular width/height or polygon offsets, central RA/Dec,
Julian-day epoch, filling factor, observatory code (all 500, geocentre), and
an efficiency filename. Polygon x offsets are divided by cosine of each
vertex's declination, as in `F95/getsur.f95`, not by a single central cosine.
Per efficiency file: magnitude-error coefficients, photometric-measurement
fractions, tracking fraction parameters, filter, global rate/direction cuts,
rate interval, double-tanh coefficients and characterized magnitude limit.
This pinned release has one rate interval per efficiency file. Unsupported
formats fail rather than substituting parameters.

The formats and equations were read in pinned `docs/README.formats`,
`docs/Template.eff`, `F95/effut.f95`, `F95/surveysub.f95` and
`F95/getsur.f95`. Efficiency is
`A/4 * (1-tanh((m-m0)/s1)) * (1-tanh((m-m0)/s2))`.
The paper limits quantitative characterization to the bright side of its
approximately 40% detection-efficiency threshold. It does not establish
zero discovery probability beyond that domain.

Rule 2 is interpreted as a discovery residual, not a chosen high-probability
threshold. For every already catalogue-conditioned candidate, discovery
probability per pointing is `fill * efficiency` within the published
polygon, characterized magnitude limit and rate/direction cuts, otherwise
zero **veto contribution**. This zero is not a claim of physical
non-detectability. Miss probability is the product of `(1-P(discovery))`
over pointings. Independent filling/detection draws across pointings are an
assumption matching the released simulator's per-pointing random draws;
unknown cross-pointing correlations are not measured here. One independent
SHA256 uniform from the existing seed prefix and original L7 member row
keeps the candidate if `u >= P(any discovery)`. No replacement is drawn.
The previous cell deficits, seeds, candidate order and attribute draws are
preserved. The output's cell `nShown` is reduced; `deficit` remains the
pre-survey catalogue-conditioned deficit.

Discovery, rather than tracked/classified detection, is used: North Star
rule 2 says surveys "would have caught" the object. Losing it during
follow-up does not erase that discovery. Published tracking fractions are
archived and tested, but do not multiply this discovery probability.
Magnitude-error and photometric fractions describe simulated measurement
noise; no invented photometric measurement is added before evaluating the
measured efficiency at the candidate's physical model magnitude.

At each epoch, DE442s supplies the geocentre relative to the Sun. The source
JD is interpreted as UTC (documentation says JD without specifying scale),
converted with the cited NAIF LSK to TDB. Interpreting JD as TDB instead would
shift approximately one minute, about 0.1 arcsec at the largest rate cuts.
The source orbit is advanced with solar two-body motion, iterating light
time four times, and its direction derivative provides the instantaneous
sky rate and west-referenced motion angle. H-G photometry uses the stage's
conventional G=0.15 (Bowell et al. 1989) and the existing mean g-r=0.7 and
Jester g/V conversion. Presurvey Landolt R uses g-R=0.8, stated by Petit
section 4 (citing Hainaut & Delsanti 2002). These mean colours and phase law
are assumptions; individual colour/phase uncertainty is not propagated.

Two-body propagation cancels the stage's advance from the L7 epoch to the
current epoch, so survey positions use only the short interval from the
2004 L7 epoch to 2002–2007. Planetary forces are omitted, and there is no
certified error bound for every member or polygon boundary. A historical
sample of the first L7 member of each of ten components (450 state comparisons)
found up to 662,240.44 km position drift and 21.71665 arcsec Earth-direction
drift against Newtonian Sun-plus-planets integration. Tightening DOP853
rtol from 1e-10 to 1e-12 changed positions by at most 0.03024 km. This is
a sample, not a bound; candidates near polygon edges remain uncertain.
The sample and convergence check are recorded in the lane handoff; they test
this approximation and never choose or tune the model. The existing audit
C3 modern-window drift remains a different sample, not a historical bound.

No unrelated survey history, detectability fainter than characterized
limits, or omitted L7 population (for example q>100 au components) is
inferred. These remain unknown. All retained objects/attributes remain
`synthetic`, with the characterization SourceRecord in their population's
source list. Product/inspector text names both the veto and its limits.

Retrieval evidence: lane `cfeps-veto/retrievals.json`, 2026-10-07. Every raw
request was preceded by HEAD size inspection; when GitHub omitted the
length, the audit's pinned tree/file byte inventory supplied size evidence.
The publication HEAD reports 1,857,586 bytes. No input approached 100 MB.
