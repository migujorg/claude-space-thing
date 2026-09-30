// Decoding one level of detail of a shape model (render/scene.ts SceneShapeLod) into GPU-ready arrays.
//
//   'shape'  ShapeModelHeader LOD (pipeline shape_mesh.pack_lod): float32 xyz positions (km), int16 snorm xyz
//            normals (÷ 32767), uint16/uint32 triangle indices, parts at offsets relative to the LOD start.
//   'damit'  DAMIT polyhedron (shape_damit.py): int16 xyz × quantScale/32767 (model units), padded to 4 bytes,
//            then uint16 triangle indices; normals are computed here (area-weighted vertex normals).
//
// Normals are returned as int16 snorm with four components (x, y, z, 0): WebGPU has no snorm16x3 vertex format.

import type { SceneShapeLod } from '../scene';

export interface DecodedLod {
  positions: Float32Array;
  /** snorm16 × 4 per vertex. */
  normals: Int16Array;
  indices: Uint16Array | Uint32Array;
  vertices: number;
  triangles: number;
  /** Largest vertex distance from the origin (model units). */
  boundRadius: number;
  /** Total surface area (model units²). */
  area: number;
}

export function decodeLod(buf: ArrayBuffer, lod: SceneShapeLod): DecodedLod {
  if (buf.byteLength < lod.bytes) throw new Error(`shape LOD: ${buf.byteLength} bytes, expected ${lod.bytes}`);
  const nv = lod.vertices, nf = lod.triangles;
  let positions: Float32Array;
  let normals: Int16Array;
  let indices: Uint16Array | Uint32Array;
  if (lod.format === 'shape') {
    const p = lod.parts;
    if (!p) throw new Error('shape LOD: missing part layout');
    positions = new Float32Array(buf.slice(p.positions.offset, p.positions.offset + nv * 12));
    const n3 = new Int16Array(buf.slice(p.normals.offset, p.normals.offset + nv * 6));
    normals = new Int16Array(nv * 4);
    for (let i = 0; i < nv; i++) {
      normals[4 * i] = n3[3 * i];
      normals[4 * i + 1] = n3[3 * i + 1];
      normals[4 * i + 2] = n3[3 * i + 2];
    }
    const ib = p.indices.type === 'u16' ? 2 : 4;
    const raw = buf.slice(p.indices.offset, p.indices.offset + roundUp4(nf * 3 * ib));
    indices = p.indices.type === 'u16' ? new Uint16Array(raw) : new Uint32Array(raw);
  } else {
    const q = new Int16Array(buf.slice(0, nv * 6));
    const k = (lod.quantScale ?? 1) / 32767;
    positions = new Float32Array(nv * 3);
    for (let i = 0; i < nv * 3; i++) positions[i] = q[i] * k;
    const off = roundUp4(nv * 6);
    indices = new Uint16Array(buf.slice(off, off + roundUp4(nf * 6)));
    normals = vertexNormals(positions, indices, nf);
  }
  let boundRadius = 0;
  for (let i = 0; i < nv; i++) {
    const r = Math.hypot(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
    if (r > boundRadius) boundRadius = r;
  }
  return { positions, normals, indices, vertices: nv, triangles: nf, boundRadius, area: surfaceArea(positions, indices, nf) };
}

function roundUp4(n: number): number {
  return (n + 3) & ~3;
}

/** Area-weighted unit vertex normals as snorm16 × 4. */
export function vertexNormals(pos: Float32Array, idx: ArrayLike<number>, nf: number): Int16Array {
  const nv = pos.length / 3;
  const acc = new Float64Array(nv * 3);
  for (let f = 0; f < nf; f++) {
    const a = idx[3 * f], b = idx[3 * f + 1], c = idx[3 * f + 2];
    const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
    const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      acc[3 * v] += nx;
      acc[3 * v + 1] += ny;
      acc[3 * v + 2] += nz;
    }
  }
  const out = new Int16Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    const l = Math.hypot(acc[3 * i], acc[3 * i + 1], acc[3 * i + 2]) || 1;
    for (let k = 0; k < 3; k++) out[4 * i + k] = Math.round((acc[3 * i + k] / l) * 32767);
  }
  return out;
}

export function surfaceArea(pos: Float32Array, idx: ArrayLike<number>, nf: number): number {
  let s = 0;
  for (let f = 0; f < nf; f++) {
    const a = idx[3 * f], b = idx[3 * f + 1], c = idx[3 * f + 2];
    const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
    const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2];
    s += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return s;
}
