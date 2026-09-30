// ============================================================================================
//  UI-DEV STAND-IN RENDERER — NOT THE REAL RENDERER, NOT PHYSICAL. Draws the SceneSnapshot on a
//  2D canvas with arbitrary grey shading so UI layout, picking and labels can be checked before
//  render/ lands. Implements RendererPort.
// ============================================================================================

import type { RendererPort } from '../app/ports';
import type { Mat3, RendererStats, SceneSnapshot, StarCatalog, Vec3 } from '../render/scene';

const TINT: Record<string, string> = { measured: '#3dbb8a', derived: '#5b9bf0', estimated: '#e3a53c', synthetic: '#b489f2', unknown: '#7a828d' };

export class StandInRenderer implements RendererPort {
  stats: RendererStats = { frameMs: 0, adaptationLuminance: NaN, starsDrawn: 0 };
  private ctx: CanvasRenderingContext2D;
  private stars: StarCatalog | null = null;
  private dpr = 1;
  private hatch: CanvasPattern | null = null;

  static async create(canvas: HTMLCanvasElement): Promise<StandInRenderer> {
    return new StandInRenderer(canvas);
  }

  private constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const p = document.createElement('canvas');
    p.width = p.height = 8;
    const c = p.getContext('2d')!;
    c.fillStyle = '#2a2d33';
    c.fillRect(0, 0, 8, 8);
    c.strokeStyle = '#6b707a';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(0, 8);
    c.lineTo(8, 0);
    c.stroke();
    this.hatch = this.ctx.createPattern(p, 'repeat');
  }

  setStars(c: StarCatalog): void {
    this.stars = c;
  }

  resize(w: number, h: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  async settled(): Promise<void> {}

  render(s: SceneSnapshot): void {
    const t0 = performance.now();
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const o = s.camera.orient;
    const tanH = Math.tan(s.camera.fovY / 2);
    const aspect = W / H;
    const proj = (v: Vec3, infinite = false) => {
      const c = mulMtV(o, v);
      const d = -c[2];
      if (!(d > 0)) return null;
      return { x: ((c[0] / d / (tanH * aspect) + 1) * W) / 2, y: ((1 - c[1] / d / tanH) * H) / 2, d: infinite ? Infinity : Math.hypot(v[0], v[1], v[2]) };
    };
    const pxPerRad = H / (2 * tanH);

    // stars (stand-in brightness mapping)
    let n = 0;
    if (this.stars) {
      const st = this.stars;
      for (let i = 0; i < st.count; i++) {
        const b = i * st.stride;
        const p = proj([st.data[b], st.data[b + 1], st.data[b + 2]], true);
        if (!p || p.x < 0 || p.y < 0 || p.x > W || p.y > H) continue;
        const Y = st.data[b + 4];
        const a = Math.max(0.08, Math.min(1, (Math.log10(Y) + 9.2) / 4));
        ctx.fillStyle = `rgba(220,225,235,${a})`;
        const r = (0.6 + a) * this.dpr;
        ctx.fillRect(p.x - r / 2, p.y - r / 2, r, r);
        n++;
      }
    }

    // orbits
    ctx.lineWidth = 1 * this.dpr;
    for (const ob of s.orbits) {
      ctx.strokeStyle = ob.selected ? 'rgba(127,178,255,0.7)' : 'rgba(127,178,255,0.28)';
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < ob.points.length; i += 3) {
        const p = proj([ob.points[i], ob.points[i + 1], ob.points[i + 2]]);
        if (!p) { pen = false; continue; }
        if (pen) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        pen = true;
      }
      ctx.stroke();
    }

    // bodies + sun, far to near
    type Item = { d: number; draw: () => void };
    const items: Item[] = [];
    if (s.sun) {
      const sun = s.sun;
      const p = proj(sun.pos);
      if (p) items.push({ d: p.d, draw: () => {
        const r = Math.max(2 * this.dpr, Math.tan(Math.asin(Math.min(1, sun.radius / p.d))) * pxPerRad);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4);
        g.addColorStop(0, 'rgba(255,250,235,0.9)');
        g.addColorStop(0.25, 'rgba(255,245,220,0.25)');
        g.addColorStop(1, 'rgba(255,245,220,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 4, 0, 7); ctx.fill();
        ctx.fillStyle = '#fffaf0';
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
      } });
    }
    for (const b of s.bodies) {
      const p = proj(b.pos);
      if (!p) continue;
      items.push({ d: p.d, draw: () => {
        const R = b.radii ? Math.max(b.radii[0], b.radii[1], b.radii[2]) : 0;
        const r = R ? Math.tan(Math.asin(Math.min(1, R / p.d))) * pxPerRad : 0;
        const tint = s.view.overlays.provenanceTint ? TINT[b.worstLabel] : null;
        if (r < 1.2 * this.dpr) {
          if (!b.albedoXYZS && !b.radii) return; // nothing photometric known: UI draws a hollow marker
          ctx.fillStyle = tint ?? (b.surfaceUnknown ? '#8a8f98' : '#d8d8d8');
          ctx.beginPath(); ctx.arc(p.x, p.y, 1.2 * this.dpr, 0, 7); ctx.fill();
          return;
        }
        if (b.surfaceUnknown || !b.albedoXYZS) {
          ctx.fillStyle = this.hatch ?? '#444';
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
          if (tint) { ctx.strokeStyle = tint; ctx.lineWidth = 2 * this.dpr; ctx.stroke(); }
          return;
        }
        // stand-in shading: gradient toward the projected Sun direction
        const sd = mulMtV(o, b.toSun);
        const l = Math.hypot(sd[0], sd[1]) || 1;
        const ux = sd[0] / l, uy = -sd[1] / l;
        const g = ctx.createLinearGradient(p.x - ux * r, p.y - uy * r, p.x + ux * r, p.y + uy * r);
        const lit = tint ?? '#e6e6e6';
        const facing = sd[2] / (Math.hypot(sd[0], sd[1], sd[2]) || 1); // >0: sun behind camera → full
        const edge = Math.max(0.02, Math.min(0.98, 0.5 - 0.5 * facing));
        g.addColorStop(0, '#050505');
        g.addColorStop(edge, '#111');
        g.addColorStop(Math.min(1, edge + 0.08), lit);
        g.addColorStop(1, lit);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
      } });
    }
    items.sort((a, b) => b.d - a.d).forEach((i) => i.draw());

    ctx.font = `${11 * this.dpr}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(255,200,120,0.55)';
    ctx.fillText('UI-DEV STAND-IN RENDERER · FIXTURE DATA · NOT PHYSICAL', 12 * this.dpr, H - 64 * this.dpr);
    this.stats = { frameMs: performance.now() - t0, adaptationLuminance: NaN, starsDrawn: n };
  }
}

function mulMtV(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
}
