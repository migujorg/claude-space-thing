"""`light` stage: sunlight, CIE constants and planet photometry (docs/architecture.md §4).

Writes
  light.json       LightData: Sun (X, Y, Z, S) at 1 AU from TSIS-1 HSRS, IAU 2015 B3 radius, per-channel limb
                   darkening from Neckel & Labs (1994); the CIE constants used.
  photometry.json  PhotometryFile: NAIF id -> BodyPhotometry for Mercury..Pluto, the Moon and the major moons.
  rings.json       RingsFile: planet NAIF id -> RingSystem (radial optical-depth profiles from occultations).
  smallbody-class-colors.json  SmallBodyClassColorsFile: per Bus-DeMeo class, the colour per unit p_V and p_V
                   statistics, for small bodies without a measured spectrum (photometry/smallbody_colors.py).
  atmospheres.json AtmosphereFile: per body, extinction / single-scattering albedo / phase function of each
                   atmospheric component on an altitude grid at 360-830 nm, for sky and limb rendering
                   (photometry/atmospheres.py; docs/reports/atmospheres.md, regenerate with
                   `uv run python -m pipeline.photometry.atmo_report`).

All inputs are fetched through pipeline.download.fetch (sha256-recorded) or transcribed published tables under
pipeline/src/pipeline/photometry/tables/ (see docs/sources/). Diagnostics are printed and summarized in
docs/reports/planet-colors.md (regenerate with `uv run python -m pipeline.photometry.report`).
"""

from __future__ import annotations

import numpy as np

from ..photometry.albedo import pck_radii

from ..output import write_json
from ..photometry import atmospheres, bodies, phase, rings, smallbody_colors, solar
from ..schema import BuildContext, sourced, unknown, worst

DEPENDS: tuple[str, ...] = ()
# Optional cache/product inputs; no scheduling dependency (surfaces depends on light).
OPTIONAL_INPUTS = ("surfaces",)
# Pure numerical implementation shared with the renderer; fingerprint hook is in the handoff.
CODE_INPUTS = ("app/src/render/spatial.ts", "app/src/render/surface.ts")


# These dates and observer are from Karkoschka 1998 / PDS 1995LOW (source note).
KARKOSCHKA_EPOCH = "1995-07-06/1995-07-10"


def dated_views(naif: int, ctx: BuildContext | None = None) -> dict:
    """Integrate geometry over the source's observing-date interval, not the build window.

    The source does not associate a UTC exposure with each tabulated spectrum. The
    reference is the time mean of the stated five UTC dates; quadrature epochs below
    are numerical nodes, explicitly not claimed exposure timestamps.
    """
    import spiceypy as sp
    from .. import ephem_kernels as ek
    from ..validation.geometry import FRAMES, SUN_FROM
    with ek.pool(ek.lsk(ctx), ek.pck(ctx), ek.planetary(ctx)):
        start, end = sp.str2et("1995-07-06T00:00:00"), sp.str2et("1995-07-11T00:00:00")
        nodes, weights = np.polynomial.legendre.leggauss(5)
        views = []
        for node, weight in zip(nodes, weights):
            et = start + (node + 1) * (end - start) / 2
            pos, lt = sp.spkpos(SUN_FROM[naif], et, "J2000", "LT", "EARTH")
            M = np.asarray(sp.pxform(FRAMES[naif], "J2000", et - lt))
            sun, _ = sp.spkpos("SUN", et - lt, "J2000", "LT", SUN_FROM[naif])
            obs = M.T @ -np.asarray(pos); obs /= np.linalg.norm(obs)
            sun = M.T @ np.asarray(sun); sun /= np.linalg.norm(sun)
            ca = float(np.clip(obs @ sun, -1, 1)); phase = float(np.arccos(ca))
            tangent = (sun - ca * obs) / np.sin(phase)
            # Rotate around the pole to put the observer at longitude zero. Only
            # relative solar longitude matters to a zonal map; no invented W.
            lon = np.arctan2(obs[1], obs[0]); cl, sl = np.cos(lon), np.sin(lon)
            tangent = [cl*tangent[0]+sl*tangent[1], -sl*tangent[0]+cl*tangent[1], tangent[2]]
            views.append({"epoch": sp.et2utc(et, "ISOC", 3), "weight": float(weight/2),
                          "latitudeDeg": float(np.degrees(np.arcsin(obs[2]))),
                          "subSolarLatitudeDeg": float(np.degrees(np.arcsin(sun[2]))),
                          "phaseAngleDeg": float(np.degrees(phase)),
                          "solarTangent": [float(v) for v in tangent],
                          "earthCentreParallaxBoundDeg": float(np.degrees(np.arcsin(
                              max(sp.bodvrd("EARTH", "RADII", 3)[1]) / np.linalg.norm(pos))))})
    mean = {k: sum(v["weight"]*v[k] for v in views)
            for k in ("latitudeDeg", "subSolarLatitudeDeg", "phaseAngleDeg", "earthCentreParallaxBoundDeg")}
    return {"kind": "latitude", "epoch": KARKOSCHKA_EPOCH, **mean, "views": views}


def earth_measurement_view() -> dict:
    """The actual CGMS observer/Sun geometry used to integrate the AHI albedo."""
    from datetime import datetime, timedelta, timezone
    from ..photometry.earth import himawari_disk
    hd=himawari_disk();sun=np.asarray(hd["sun_dir"])
    phase=float(np.arccos(np.clip(sun[0],-1,1)))
    utc=lambda mjd:(datetime(1858,11,17,tzinfo=timezone.utc)+timedelta(days=mjd)).isoformat()
    return {"kind":"latitude","latitudeDeg":0.0,
            "epoch":f"{utc(hd['mjd_start'])}/{utc(hd['mjd_end'])}",
            "subSolarLatitudeDeg":float(np.degrees(np.arcsin(sun[2]))),
            "phaseAngleDeg":float(np.degrees(phase)),
            "solarTangent":[0.0,float(sun[1]/np.sin(phase)),float(sun[2]/np.sin(phase))]}


def view_spread(naif: int, entry: dict, ctx: BuildContext | None = None) -> dict:
    """A rigorous all-phase/all-orientation envelope, not an extrema grid scan.

    Any nonnegative surface law weights the Gauss-map Jacobian times the zonal
    map positively. Its normalized integral therefore lies between the extrema
    of that weight. Divide by its orientation mean to bound a missing view's
    scale at every phase. The bound can be conservative; it never understates
    a view uncertainty or uses a validation case to choose a tolerance.
    """
    import hashlib
    import json
    from .. import ephem_kernels as ek
    from ..paths import OUT
    from ..photometry.albedo import pck_radii
    r = np.asarray(pck_radii()[naif]); d = (r / np.cbrt(np.prod(r)))**2
    jac_min, jac_max = float(np.prod(d)/max(d)**2), float(np.prod(d)/min(d)**2)
    z, w = np.polynomial.legendre.leggauss(128)
    phi = 2*np.pi*(np.arange(256)+.5)/256
    normals = np.stack(np.broadcast_arrays(np.sqrt(1-z[:,None]**2)*np.cos(phi),
                      np.sqrt(1-z[:,None]**2)*np.sin(phi), z[:,None]), axis=-1)
    jac = np.prod(d) / np.sum(normals**2*d, axis=-1)**2
    mean = float(np.sum(jac*w[:,None])/512)
    bare = max(abs(jac_min/mean-1), abs(jac_max/mean-1))
    out = {"maxRelativeXYZS": [bare]*4, "bareMaxRelative": bare,
           "mapMaxRelativeXYZS": None, "albedoSigmaRelative": None, "scaleLabel": "estimated"}
    sources = [ek.SRC_PCK, *entry["geometricAlbedoXYZS"]["sources"]]
    spread_label = "derived"
    # light can precede surfaces on a clean build. A map bound is certified only
    # for the exact retained level-0 bytes, whose hashes the shell compares.
    paths = [OUT / f"surfaces/{naif}/albedo/0/0/{i}.bin" for i in (0, 1)]
    header = OUT / f"surfaces/{naif}/albedo.json"
    if header.exists() and all(p.exists() for p in paths):
        tiles = [np.frombuffer(p.read_bytes(), dtype="<f2").reshape(256,256,4) for p in paths]
        texels = np.concatenate(tiles, axis=1).astype(np.float64)
        texels[np.all(texels == 0, axis=2)] = 1
        rows = np.mean(texels, axis=1)
        lat = np.arcsin(d[2]*normals[:,:,2] / np.linalg.norm(normals*d,axis=-1))
        xp = np.pi*(.5-(np.arange(256)+.5)/256)
        weighted_mean = np.array([np.sum(jac*np.interp(lat,xp[::-1],rows[::-1,c])*w[:,None])/512 for c in range(4)])
        spread = np.maximum(abs(jac_min*np.min(rows,axis=0)/weighted_mean-1),
                            abs(jac_max*np.max(rows,axis=0)/weighted_mean-1))
        out["mapMaxRelativeXYZS"] = spread.tolist()
        out["mapTileSha256"] = [hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
        h = json.loads(header.read_text())
        sources += h.get("sources", [])
        spread_label = worst("derived", h.get("provenance",{}).get("label","derived"),
                             h.get("color",{}).get("label","derived"))
    # Use numeric source-stated uncertainties; vague "a few percent" and a
    # rotational range are not a 1-sigma error and do not qualify the exception.
    if 601 <= naif <= 605:
        from ..photometry.moons import filacchione_rows
        t = filacchione_rows(naif)
        out["albedoSigmaRelative"] = float(np.median(t["a0_err"]/t["a0"]))
    elif naif == 609:
        from ..photometry.common import read_table_json
        h = read_table_json("grav_2015_irregulars.json")["satellites"]["609"]
        out["albedoSigmaRelative"] = float(.4*np.log(10)*h["H_err"])
    elif naif == 402:
        from ..photometry.common import read_table_json
        p = read_table_json("wargnier_2025_deimos.json")["src_panchromatic"]
        out["albedoSigmaRelative"] = p["A_p_err"]/p["A_p"]
    if out["albedoSigmaRelative"] is not None and bare < out["albedoSigmaRelative"]:
        out["scaleLabel"] = "derived"
    if out["mapMaxRelativeXYZS"] is not None:
        out["mapScaleLabel"] = ("derived" if out["albedoSigmaRelative"] is not None and
                                max(out["mapMaxRelativeXYZS"]) < out["albedoSigmaRelative"] else "estimated")
    return sourced(out, spread_label, list(dict.fromkeys(sources)),
                   method="All-phase bound: min/max of the Gauss-map area Jacobian times the exact level-0 zonal "
                          "map divided by its uniform-orientation mean. Bare and mapped bounds are separate; "
                          "a mapped bound applies only to the named tile SHA-256 values. This conservative "
                          "envelope bounds the reference integral over every orientation for any positive law.")


def reference_table(naif: int, entry: dict) -> dict | None:
    """Precompute the accepted exact-row integral; no calibration work belongs in a frame.

    The pure TypeScript physics implementation is also the app's reference. Node
    and esbuild are the existing app toolchain, not an observational input.
    """
    import hashlib
    import inspect
    import json
    import subprocess
    from pathlib import Path
    from ..paths import OUT, CACHE
    model = entry.get("spatialModel", {}).get("value")
    view = entry["albedoMeasurementView"]["value"]
    if naif not in (599,699,799,899) or not model or view["kind"] != "latitude":
        return None
    repo=Path(__file__).resolve().parents[4]
    code_files=[repo/p for p in CODE_INPUTS]
    source_hash=hashlib.sha256(b"".join(p.read_bytes() for p in code_files)).hexdigest()
    paths=[OUT/f"surfaces/{naif}/albedo/0/0/{i}.bin" for i in (0,1)]
    tiles=[str(p) if p.exists() else None for p in paths]
    request={"model":model,"view":view,"radii":list(pck_radii()[naif]),"tiles":tiles,
             "hasMap":any(p is not None for p in tiles)}
    cache_key=hashlib.sha256(json.dumps({"inputs":request,"source":source_hash,
        "algorithm":inspect.getsource(reference_table),
        "tiles":[hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None for p in paths]},sort_keys=True).encode()).hexdigest()
    cached=CACHE/"light-calibration"/f"{naif}-{cache_key}.json"
    if cached.exists():return json.loads(cached.read_text())
    cached.parent.mkdir(parents=True,exist_ok=True)
    request["bundle"]=str(cached.parent/f"integrator-{source_hash}.mjs")
    script=r"""
import fs from 'node:fs';import {createRequire} from 'node:module';
const p=JSON.parse(fs.readFileSync(0,'utf8'));
const {build}=createRequire(process.cwd()+'/package.json')('esbuild');
if(!fs.existsSync(p.bundle)) await build({stdin:{contents:"export * from './src/render/spatial.ts';export {zonalMeanOfLevel0} from './src/render/surface.ts';",resolveDir:process.cwd(),loader:'ts'},outfile:p.bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
const lib=await import(p.bundle),norm=new lib.EllipsoidNormalization();
const map=p.hasMap?lib.zonalMeanOfLevel0(p.tiles.map(path=>{if(!path)return null;const b=fs.readFileSync(path);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);})):undefined;
const end=Math.log(Math.PI/1e-8),cache=new Map();
function value(t){
 if(cache.has(t))return cache.get(t);
 const a=Math.PI*-Math.expm1(-t),r=lib.resolveLaw(p.model,a);if('error' in r)throw Error(r.error);
 const bare=lib.lawDiskIntegral(r.law,a)[0],b=norm.reference(r.law,a,p.radii,p.view),m=map?norm.reference(r.law,a,p.radii,p.view,map):null;
 const delta=Math.PI-a,factor=p.model.kind==='minnaert'?delta**(2*r.law.p+1):delta**(r.law.p+1)*Math.min(1,delta/1e-3);
 const v=[...b.map(x=>x/bare),...(m?m.map(x=>x/bare):[]),bare/factor];cache.set(t,v);return v;
}
const cells=[];
function visit(lo,hi,depth=0){
 const values=[0,1/3,2/3,1].map(u=>value(lo+u*(hi-lo)));
 const interp=u=>values[0].map((_,k)=>-4.5*(u-1/3)*(u-2/3)*(u-1)*values[0][k]+13.5*u*(u-2/3)*(u-1)*values[1][k]-13.5*u*(u-1/3)*(u-1)*values[2][k]+4.5*u*(u-1/3)*(u-2/3)*values[3][k]);
 let error=0;
 for(const u of [1/12,1/6,1/4,1/2,3/4,5/6,11/12]){const exact=value(lo+u*(hi-lo)),got=interp(u);error=Math.max(error,...got.map((v,k)=>Math.abs(v/exact[k]-1)));}
 if(error>1e-5){if(depth>=16)throw Error('Calibration interpolation did not converge');const mid=(lo+hi)/2;visit(lo,mid,depth+1);visit(mid,hi,depth+1);}
 else cells.push({lo,hi,sphere:values.map(v=>v.at(-1)),bare:values.map(v=>v.slice(0,4)),...(map?{mapped:values.map(v=>v.slice(4,8))}:{})});
}
let cuts=Array.from({length:17},(_,i)=>end*i/16);
if(p.model.kind==='barkstrom')cuts.push(Math.log(Math.PI/1e-3),...p.model.B.alphaDeg.filter(a=>a>0&&a<180).map(a=>-Math.log1p(-a/180)));
cuts=[...new Set(cuts)].sort((a,b)=>a-b);for(let i=1;i<cuts.length;i++)visit(cuts[i-1],cuts[i]);
console.log(JSON.stringify({model:p.model,view:p.view,radiiKm:p.radii,cells,endLogCrescent:end,sphereFloor:1e-3,sourceCodeSha256:p.sourceHash,quadrature:'exact-row converged TypeScript reference',...(map?{zonalRows:Array.from(map.mean),mapTileSha256:p.tiles.map(path=>path?createRequire(process.cwd()+'/package.json')('node:crypto').createHash('sha256').update(fs.readFileSync(path)).digest('hex'):null)}:{})}));
"""
    request["sourceHash"]=source_hash
    print(f"[light] {naif} dated reference: computing fixed calibration table",flush=True)
    result=subprocess.run(["node","--input-type=module","-e",script],input=json.dumps(request),
                          cwd=repo/"app",capture_output=True,text=True,check=True)
    table=json.loads(result.stdout)
    cached.write_text(json.dumps(table)+"\n")
    return table


def with_measurement_views(photometry: dict, ctx: BuildContext | None = None) -> dict:
    """Keep a dated calibration geometry separate from the measurement's label."""
    for key, entry in photometry.items():
        albedo = entry["geometricAlbedoXYZS"]
        if albedo["value"] is None:
            entry["albedoMeasurementView"] = unknown("No disk albedo is available to calibrate a measurement view.")
            continue
        naif = int(key)
        if naif in (599, 699, 799, 899, 606):
            from .. import ephem_kernels as ek
            entry["albedoMeasurementView"] = sourced(
                dated_views(naif, ctx), "derived",
                ["karkoschka-1998-pds", ek.SRC_PLANETARY, ek.SRC_PCK, ek.SRC_LSK],
                method="Karkoschka 1998/PDS 1995LOW, ESO La Silla, 1995 July 6–10. "
                       "Earth centre observing direction (telescope parallax bounded in degrees in the value), "
                       "DE442s system-barycentre directions with LT and IAU pck00011 at the light-emission epoch. "
                       "Five-node time quadrature over the five stated UTC dates; nodes are not exposure dates. "
                       "Sub-observer and sub-solar latitudes are planetocentric; the solar tangent retains the "
                       "observed relative solar direction as the law's phase changes. "
                       "Planet/satellite-centre offsets from the system barycentre are omitted; for Titan the "
                       "parent-system direction is an approximation, not a recovered Cassini or Titan ephemeris.")
        elif naif == 399 and any("himawari9-ahi" in x for x in albedo["sources"]):
            entry["albedoMeasurementView"] = sourced(earth_measurement_view(), "derived",
                [x for x in albedo["sources"] if "himawari9-ahi" in x],
                method="Himawari-9 AHI calibration geometry from the HSD/CGMS observer frame and "
                       "the solar direction computed by photometry.earth for the actual scan. "
                       "This is the very geometry used to integrate the albedo; sub-observer "
                       "latitude is zero in the CGMS equatorial projection. Absolute Earth "
                       "layers continue to use their independent calibration.")
        else:
            entry["albedoMeasurementView"] = sourced(
                {"kind": "orientation-mean", **({"epoch":"2000-10/2001-03"} if naif in (501,502,503,504) else
                 {"epoch":"2004/2017"} if 601<=naif<=605 else
                 {"epoch":"2004/2024"} if naif==402 else {})}, "estimated", albedo["sources"],
                method="The adopted albedo is a global fitted/compiled mean without one recoverable calibration "
                       "view in the retained inputs. Explicit fallback: uniform mean over orientations of the "
                       "ellipsoid Gauss-map area measure and zonal map. This is a normalization assumption; "
                       "albedoViewSpread bounds its effect separately from the measured albedo.")
        if naif in pck_radii():
            spread = view_spread(naif, entry, ctx)
            entry["albedoViewSpread"] = spread
            v = spread["value"]
            text = (f"Calibration orientation envelope: bare ≤{100*v['bareMaxRelative']:.6g}% relative; "
                    + (f"mapped XYZS ≤{[round(100*x,6) for x in v['mapMaxRelativeXYZS']]}% "
                       if v["mapMaxRelativeXYZS"] is not None else "mapped envelope not certified; ")
                    + "(all phases/orientations, conservative positive-weight bound). "
                    + (f"Source albedo formal 1-sigma error {100*v['albedoSigmaRelative']:.6g}%."
                       if v["albedoSigmaRelative"] is not None else "No numeric source-stated 1-sigma error used."))
            for field in ("geometricAlbedoXYZS", "geometricAlbedoV"):
                if field in entry:
                    entry[field]["uncertainty"] = entry[field].get("uncertainty", "") + "; " + text
    return photometry


def run(ctx: BuildContext) -> None:
    problems = phase.verify_against_code()
    if problems:
        raise ValueError("Mallama & Hilton transcription does not match Ap_Mag_V3.f90: " + "; ".join(problems))

    light, diag = solar.light_json(ctx)
    write_json(ctx, "light.json", light, "light")
    X, Y, Z, S = diag["xyzs"]
    print(f"[light] sun at 1 AU: X={X:.0f} Y={Y:.0f} lux Z={Z:.0f} S={S:.0f} scotopic lux; "
          f"xy=({diag['xy'][0]:.4f}, {diag['xy'][1]:.4f})")
    t = diag["tsi"]
    print(f"[light] HSRS integral {t['range_nm'][0]:.0f}-{t['range_nm'][1]:.0f} nm = {t['total_W_m2']:.2f} W/m2 "
          f"({100 * t['total_W_m2'] / 1361.0:.1f} % of the IAU nominal TSI 1361 W/m2); 360-830 nm = "
          f"{t['visible_360_830_W_m2']:.2f} W/m2")
    print(f"[light] limb darkening: refit residual {diag['limb']['fit_residual_max']:.1e}, F/I per channel "
          + ", ".join(f"{v:.4f}" for v in diag["limb"]["F_over_I"]))

    results = bodies.build_all(ctx)
    photometry = with_measurement_views(bodies.photometry_json(results), ctx)
    for key, entry in photometry.items():
        table = reference_table(int(key), entry)
        if table is not None:
            import json
            from ..paths import OUT
            header = OUT/f"surfaces/{key}/albedo.json"
            h = json.loads(header.read_text()) if header.exists() else {}
            sources = list(dict.fromkeys([*entry["albedoMeasurementView"]["sources"],
                                         *entry["spatialModel"]["sources"], *h.get("sources",[])]))
            entry["albedoReferenceNormalization"] = sourced(table,
                worst(entry["spatialModel"]["label"], h.get("color",{}).get("label","derived"),
                      h.get("provenance",{}).get("label","derived"), "derived"), sources,
                method="Fixed dated-view integral and its bare-sphere factor, precomputed with the pure TypeScript "
                       "normal-space quadrature. Binary16 map rows are evaluated exactly piecewise-linearly "
                       "at position latitude by the accepted exact-row, converged reference integral. Cubic interpolation in log crescent "
                       "width is checked at seven interlaced points to 1e-5; the numerical implementation hash "
                       "is recorded. Tables retain the law, radii, views and "
                       "exact zonal rows; mismatched frame inputs cannot reuse a table. "
                       "The law's crescent power is factored analytically; below delta=1e-8 the limiting "
                       "ratio is held (a numerical endpoint approximation).")
            print(f"[light] {key} dated reference: {len(table['cells'])} cells, exact-row reference", flush=True)
    write_json(ctx, "photometry.json", photometry, "light")
    for n, r in results.items():
        labels = (f"albedo:{r.entry['geometricAlbedoXYZS']['label']} phase:{r.entry['phaseFunction']['label']}")
        if r.xyzs is None:
            print(f"[light] {r.name:9s} albedo and colour unknown; {labels}")
            continue
        x, y = r.xyzs[0] / r.xyzs[:3].sum(), r.xyzs[1] / r.xyzs[:3].sum()
        pub = f"{r.v10_published:+.3f}" if r.v10_published is not None else "   n/a"
        print(f"[light] {r.name:9s} p_V={r.p_v:.4f} xy=({x:.4f}, {y:.4f}) V(1,0)={r.v10:+.3f} (published {pub}) "
              f"{labels}")

    rj, rdiag = rings.rings_json(ctx)
    write_json(ctx, "rings.json", rj, "light", indent=None)
    for n, prof in rdiag.items():
        if n.endswith("-components"):
            continue
        tau = prof.tau[np.isfinite(prof.tau)]
        print(f"[light] rings {n}: {prof.radius[0]:.0f}-{prof.radius[-1]:.0f} km, {prof.radius.size} bins, "
              f"max normal tau {tau.max():.2f}")
    for key in ("599", "799", "899"):
        comp = rj[key].get("components") or {}
        if comp.get("value"):
            m = comp["value"]
            print(f"[light] rings {key} components: {len(m['components'])} ({comp['label']}), phase functions "
                  f"{', '.join(m['phaseFunctions'])}")

    sbc = smallbody_colors.build(ctx)
    write_json(ctx, "smallbody-class-colors.json", sbc, "light")
    pop = sbc["population"]["pV"]["value"]
    print(f"[light] small-body class colours: {len(sbc['classes'])} Bus-DeMeo classes, population p_V median "
          f"{pop['median']} (n = {pop['n']})")

    atm, _ = atmospheres.build(ctx)
    write_json(ctx, "atmospheres.json", atm, "light", indent=None)
    for e in atm["bodies"].values():
        comps = ", ".join(f"{c['id']} τ(550)={c['columnOpticalDepth'][19]:.4g}" for c in e["components"])
        print(f"[light] atmosphere {e['name']:8s} {comps or 'scale height ' + str(e['scaleHeightKm']['value']) + ' km'}")
