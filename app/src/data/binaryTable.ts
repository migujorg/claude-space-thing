// Generic reader for BinaryTableHeader + .bin pairs (schema.ts, docs/architecture.md §6).
// One record per object, `stride` bytes each; each field has a type, element count and byte offset
// within the record. All values are little-endian.

import type { BinaryField, BinaryTableHeader, Label } from './schema';

type Typed = Float32Array | Float64Array | Uint32Array | Uint16Array | Uint8Array | Int32Array;

const TYPE_INFO: Record<BinaryField['type'], { size: number; ctor: new (b: ArrayBuffer) => Typed; dv: (d: DataView, o: number) => number }> = {
  f32: { size: 4, ctor: Float32Array, dv: (d, o) => d.getFloat32(o, true) },
  f64: { size: 8, ctor: Float64Array, dv: (d, o) => d.getFloat64(o, true) },
  u32: { size: 4, ctor: Uint32Array, dv: (d, o) => d.getUint32(o, true) },
  i32: { size: 4, ctor: Int32Array, dv: (d, o) => d.getInt32(o, true) },
  u16: { size: 2, ctor: Uint16Array, dv: (d, o) => d.getUint16(o, true) },
  u8: { size: 1, ctor: Uint8Array, dv: (d, o) => d.getUint8(o) },
};

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Typed, strided view of one field. `get(i, k)` reads element k of record i. */
export class BinaryColumn {
  readonly field: BinaryField;
  private readonly arr: Typed | null;
  private readonly strideEl: number;
  private readonly offEl: number;
  private readonly dv: DataView;
  private readonly strideBytes: number;
  private readonly read: (d: DataView, o: number) => number;

  constructor(field: BinaryField, buffer: ArrayBuffer, strideBytes: number) {
    const info = TYPE_INFO[field.type];
    this.field = field;
    this.read = info.dv;
    this.strideBytes = strideBytes;
    this.dv = new DataView(buffer);
    // Fast path: a typed array over the whole buffer, indexed with element stride. Needs the
    // record stride and field offset to be multiples of the element size (and a little-endian host).
    const aligned = LITTLE_ENDIAN && strideBytes % info.size === 0 && field.offset % info.size === 0 && buffer.byteLength % info.size === 0;
    this.arr = aligned ? new info.ctor(buffer) : null;
    this.strideEl = strideBytes / info.size;
    this.offEl = field.offset / info.size;
  }

  get(i: number, k = 0): number {
    if (this.arr) return this.arr[i * this.strideEl + this.offEl + k];
    return this.read(this.dv, i * this.strideBytes + this.field.offset + k * TYPE_INFO[this.field.type].size);
  }
}

export class BinaryTable {
  readonly header: BinaryTableHeader;
  readonly count: number;
  readonly stride: number;
  readonly buffer: ArrayBuffer;
  private readonly cols = new Map<string, BinaryColumn>();

  constructor(header: BinaryTableHeader, buffer: ArrayBuffer) {
    validateHeader(header, buffer.byteLength);
    this.header = header;
    this.count = header.count;
    this.stride = header.stride;
    this.buffer = buffer;
    for (const f of header.fields) this.cols.set(f.name, new BinaryColumn(f, buffer, header.stride));
  }

  has(name: string): boolean {
    return this.cols.has(name);
  }

  column(name: string): BinaryColumn {
    const c = this.cols.get(name);
    if (!c) throw new Error(`binary table has no field "${name}" (fields: ${this.header.fields.map((f) => f.name).join(', ')})`);
    return c;
  }

  get(name: string, i: number, k = 0): number {
    return this.column(name).get(i, k);
  }

  /** Decode a u8 label field through header.labelEncoding. Out-of-range codes decode as 'unknown'. */
  label(name: string, i: number): Label {
    const enc = this.header.labelEncoding;
    if (!enc) throw new Error('binary table header has no labelEncoding');
    return enc[this.get(name, i)] ?? 'unknown';
  }

  /** Resolve a source-index field through header.sourceTable. */
  sourceId(name: string, i: number): string | undefined {
    return this.header.sourceTable?.[this.get(name, i)];
  }

  /** Fields that hold provenance labels: u8 fields whose name mentions "label" (when labelEncoding exists). */
  labelFields(): string[] {
    if (!this.header.labelEncoding) return [];
    return this.header.fields.filter((f) => f.type === 'u8' && /label/i.test(f.name)).map((f) => f.name);
  }
}

export function validateHeader(h: BinaryTableHeader, byteLength: number): void {
  if (!Number.isInteger(h.count) || h.count < 0) throw new Error(`bad record count ${h.count}`);
  if (!Number.isInteger(h.stride) || h.stride <= 0) throw new Error(`bad stride ${h.stride}`);
  if (!Array.isArray(h.fields) || h.fields.length === 0) throw new Error('header has no fields');
  for (const f of h.fields) {
    const info = TYPE_INFO[f.type];
    if (!info) throw new Error(`field "${f.name}": unsupported type "${f.type}"`);
    const count = f.count ?? 1;
    if (f.offset < 0 || f.offset + info.size * count > h.stride)
      throw new Error(`field "${f.name}" (${f.type}×${count} at +${f.offset}) does not fit in stride ${h.stride}`);
  }
  if (byteLength < h.count * h.stride)
    throw new Error(`binary is ${byteLength} bytes but header needs ${h.count} × ${h.stride} = ${h.count * h.stride}`);
}
