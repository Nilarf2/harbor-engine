import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { link, lstat, open, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { Logger, NodeIO, type Document, type GLTF } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const validator = createRequire(import.meta.url)('gltf-validator') as {
  version(): string;
  validateBytes(bytes: Uint8Array, options: Record<string, unknown>): Promise<ValidationReport>;
};
const EXTENSION = 'EXT_meshopt_compression';
const knownExtensions = new Set(ALL_EXTENSIONS.map(extension => extension.EXTENSION_NAME));
const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.SILENT))
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

interface ValidationReport {
  issues: { numErrors: number; numWarnings: number; numInfos: number; numHints: number; messages: unknown[] };
  [key: string]: unknown;
}
interface MeshoptView {
  buffer: number; byteOffset?: number; byteLength: number; byteStride: number;
  count: number; mode: string; filter?: string;
}
interface BinaryAsset { json: GLTF.IGLTF; binary: Uint8Array }

/** Reject dependencies before invoking a parser or validator. No fetch implementation is installed. */
async function readEmbedded(bytes: Uint8Array): Promise<BinaryAsset> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 ||
      view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) {
    throw new Error('Expected a complete self-contained glTF 2 binary (.glb)');
  }
  let offset = 12, chunks = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error('Truncated GLB chunk header');
    const size = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    if (size % 4 || offset + 8 + size > bytes.byteLength) throw new Error('Invalid GLB chunk size');
    if ((chunks === 0 && type !== 0x4e4f534a) || (chunks === 1 && type !== 0x004e4942) || chunks > 1) {
      throw new Error('Only standard JSON and optional BIN chunks are supported; unknown chunks will not be discarded');
    }
    chunks++; offset += 8 + size;
  }
  // Check original JSON before NodeIO can resolve data resources.
  const raw = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)))) as GLTF.IGLTF;
  for (const buffer of raw.buffers ?? []) {
    if (buffer.uri !== undefined) throw new Error('Pack every buffer into the GLB BIN chunk; external and data-URI buffers are unsupported');
  }
  for (const image of raw.images ?? []) {
    if (image.uri !== undefined && !image.uri.startsWith('data:')) {
      throw new Error('Pack external textures into the GLB before importing; this tool never fetches URLs or external files');
    }
  }
  const parsed = await io.binaryToJSON(bytes);
  return { json: raw, binary: parsed.resources['@glb.bin'] ?? new Uint8Array() };
}

function extensionNames(json: GLTF.IGLTF): string[] {
  const names = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'extras') continue; // Arbitrary application JSON is not a glTF extension declaration.
      if (key === 'extensions' && entry && typeof entry === 'object') Object.keys(entry).forEach(name => names.add(name));
      visit(entry);
    }
  }
  visit(json);
  return [...names].sort();
}

function summary(json: GLTF.IGLTF) {
  const primitives = (json.meshes ?? []).flatMap(mesh => mesh.primitives);
  let vertices = 0, triangles = 0;
  for (const primitive of primitives) {
    const count = json.accessors?.[primitive.attributes.POSITION]?.count ?? 0;
    vertices += count;
    const elements = primitive.indices === undefined ? count : json.accessors?.[primitive.indices]?.count ?? 0;
    if ((primitive.mode ?? 4) === 4) triangles += elements / 3;
    else if (primitive.mode === 5 || primitive.mode === 6) triangles += Math.max(0, elements - 2);
  }
  return {
    scenes: json.scenes?.length ?? 0, nodes: json.nodes?.length ?? 0,
    meshes: json.meshes?.length ?? 0, primitives: primitives.length,
    vertices, triangles, materials: json.materials?.length ?? 0,
    images: json.images?.length ?? 0, skins: json.skins?.length ?? 0,
    animations: json.animations?.map(animation => ({ name: animation.name ?? '', channels: animation.channels.length })) ?? [],
    extensions: extensionNames(json),
  };
}

function sizes(bytes: Uint8Array) {
  return { bytes: bytes.byteLength, gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(bytes).byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function validate(bytes: Uint8Array, file: string): Promise<ValidationReport> {
  return validator.validateBytes(bytes, {
    uri: basename(file), format: 'glb', writeTimestamp: false, maxIssues: 0,
    externalResourceFunction: async () => { throw new Error('External resources are disabled'); },
  });
}

function accessorFingerprint(document: Document): string {
  return JSON.stringify(document.getRoot().listAccessors().map(accessor => {
    const array = accessor.getArray();
    return { name: accessor.getName(), extras: accessor.getExtras(), type: accessor.getType(),
      componentType: accessor.getComponentType(), normalized: accessor.getNormalized(), count: accessor.getCount(),
      data: array ? createHash('sha256').update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).digest('hex') : null };
  }));
}

function pack(json: GLTF.IGLTF, binary: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = (text.length + 3) & ~3, binLength = (binary.length + 3) & ~3;
  const result = new Uint8Array(20 + jsonLength + (binLength ? 8 + binLength : 0));
  const view = new DataView(result.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, result.length, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  result.fill(0x20, 20, 20 + jsonLength); result.set(text, 20);
  if (binLength) {
    view.setUint32(20 + jsonLength, binLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
    result.set(binary, 28 + jsonLength);
  }
  return result;
}

/** Compression only. The original glTF object graph and every decoded bufferView byte are preserved. */
async function compress(asset: BinaryAsset): Promise<{ bytes: Uint8Array; compressedViews: number }> {
  const { json: input, binary } = asset;
  if ((input.buffers?.length ?? 0) > 1) throw new Error('Optimization requires an original GLB with one embedded buffer');
  const names = extensionNames(input);
  const unsupported = names.filter(name => !knownExtensions.has(name));
  if (unsupported.length) throw new Error(`Unsupported extensions must be handled explicitly to preserve their data: ${unsupported.join(', ')}`);
  if (names.includes(EXTENSION) || names.includes('KHR_meshopt_compression') || names.includes('KHR_draco_mesh_compression')) {
    throw new Error('Optimize the original uncompressed GLB; recompressing a compressed asset is not supported');
  }
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const json = structuredClone(input);
  const views = json.bufferViews ?? [], accessors = input.accessors ?? [];
  const accessorViews = new Map<number, { accessor: GLTF.IAccessor; index: number }[]>();
  accessors.forEach((accessor, index) => {
    if (accessor.bufferView === undefined) return;
    const refs = accessorViews.get(accessor.bufferView) ?? [];
    refs.push({ accessor, index }); accessorViews.set(accessor.bufferView, refs);
  });
  const indices = new Set((input.meshes ?? []).flatMap(mesh => mesh.primitives.map(p => p.indices).filter(i => i !== undefined)));
  const images = new Set((input.images ?? []).map(image => image.bufferView));
  const pieces: Uint8Array[] = []; let total = 0, compressedViews = 0;
  const append = (bytes: Uint8Array): number => {
    const offset = total, padding = (4 - bytes.length % 4) % 4;
    pieces.push(bytes); if (padding) pieces.push(new Uint8Array(padding));
    total += bytes.length + padding; return offset;
  };
  for (let i = 0; i < views.length; i++) {
    const view = views[i], source = input.bufferViews![i];
    if (source.buffer !== 0) throw new Error('Every source bufferView must reference the embedded buffer');
    const offset = source.byteOffset ?? 0;
    if (offset + source.byteLength > binary.length) throw new Error(`bufferView ${i} exceeds the BIN chunk`);
    const bytes = binary.subarray(offset, offset + source.byteLength);
    const refs = accessorViews.get(i) ?? [];
    let stride = source.byteStride ?? 4, mode = 'ATTRIBUTES';
    const indexOnly = refs.length > 0 && refs.every(({ index }) => indices.has(index));
    if (indexOnly) {
      const components = new Set(refs.map(({ accessor }) => accessor.componentType));
      stride = components.size === 1 && refs[0].accessor.componentType === 5123 ? 2 :
        components.size === 1 && refs[0].accessor.componentType === 5125 ? 4 : 0;
      mode = 'INDICES'; // Unlike TRIANGLES, this preserves the exact original index sequence.
    } else if (!source.byteStride && refs.length) {
      const components: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
      const elements: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
      const strides = new Set(refs.map(({ accessor }) => (components[accessor.componentType] ?? 0) * (elements[accessor.type] ?? 0)));
      const candidate = [...strides][0];
      if (strides.size === 1 && candidate > 0 && candidate <= 256 && candidate % 4 === 0 && bytes.length % candidate === 0) stride = candidate;
    }
    const eligible = refs.length > 0 && !images.has(i) && stride > 0 && bytes.length > 0 && bytes.length % stride === 0 &&
      (mode !== 'ATTRIBUTES' || (stride % 4 === 0 && stride <= 256));
    const encoded = eligible ? MeshoptEncoder.encodeGltfBuffer(bytes, bytes.length / stride, stride, mode, 0) : null;
    // Account for per-view JSON overhead. Final whole-file comparison still determines whether compression is retained.
    if (encoded && encoded.length + 160 < bytes.length) {
      const decoded = new Uint8Array(bytes.length);
      MeshoptDecoder.decodeGltfBuffer(decoded, bytes.length / stride, stride, encoded, mode);
      if (!Buffer.from(bytes).equals(decoded)) throw new Error(`Lossless verification failed for bufferView ${i}`);
      const extension: MeshoptView = { buffer: 0, byteOffset: append(encoded), byteLength: encoded.length,
        byteStride: stride, count: bytes.length / stride, mode };
      view.buffer = 1; // A required extension may use a URI-less fallback placeholder.
      view.extensions = { ...view.extensions, [EXTENSION]: extension };
      compressedViews++;
    } else {
      view.byteOffset = append(bytes);
    }
  }
  if (!compressedViews) return { bytes: pack(input, binary), compressedViews: 0 };
  json.buffers![0].byteLength = total;
  json.buffers!.push({ byteLength: input.buffers![0].byteLength, extensions: { [EXTENSION]: { fallback: true } } });
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), EXTENSION])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), EXTENSION])];
  const packed = new Uint8Array(total); let cursor = 0;
  for (const piece of pieces) { packed.set(piece, cursor); cursor += piece.length; }
  return { bytes: pack(json, packed), compressedViews };
}

/** Publish a complete file without overwriting an existing path, including a concurrent creator. */
async function writeNewAtomic(file: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o644);
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    // Same-directory hard link is atomic and, unlike rename(), refuses an existing destination.
    await link(temporary, file);
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export async function runAssets(args: string[]): Promise<Record<string, unknown>> {
  const [action, inputName, outputName] = args;
  if (!inputName || !['inspect', 'optimize'].includes(action) ||
      (action === 'inspect' && args.length !== 2) || (action === 'optimize' && args.length !== 3)) {
    throw new Error('Usage: npm run assets -- inspect <input.glb> | optimize <input.glb> <new-output.glb>');
  }
  const input = resolve(inputName), output = outputName ? resolve(outputName) : undefined;
  if (extname(input).toLowerCase() !== '.glb' || (output && extname(output).toLowerCase() !== '.glb')) throw new Error('Only .glb files are supported');
  if (output === input) throw new Error('Output must be a new path; the source is never overwritten');
  if (output) {
    try { await lstat(output); throw new Error('Output already exists; choose a new path'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const bytes = await readFile(input), asset = await readEmbedded(bytes);
  const beforeValidation = await validate(bytes, input);
  const before = { ...sizes(bytes), ...summary(asset.json), validation: beforeValidation };
  if (action === 'inspect') return { ok: beforeValidation.issues.numErrors === 0, action, gpuRequired: false, input, validatorVersion: validator.version(), asset: before };
  if (beforeValidation.issues.numErrors) {
    const error = new Error(`Input has ${beforeValidation.issues.numErrors} glTF validation error(s); inspect it before optimizing`);
    Object.assign(error, { validation: beforeValidation }); throw error;
  }
  const compressed = await compress(asset);
  const candidate = compressed.bytes;
  const useCompression = compressed.compressedViews > 0 && candidate.length < bytes.length;
  const result = useCompression ? candidate : bytes;
  const afterValidation = await validate(result, output!);
  if (afterValidation.issues.numErrors) {
    const error = new Error('Generated asset failed glTF validation; no output was written');
    Object.assign(error, { validation: afterValidation }); throw error;
  }
  // The codec verifies raw views; a second parser verifies interpreted geometry/animation accessors.
  if (useCompression) {
    const beforeDocument = await io.readBinary(bytes), afterDocument = await io.readBinary(result);
    if (accessorFingerprint(beforeDocument) !== accessorFingerprint(afterDocument)) throw new Error('Decoded accessor data changed; no output was written');
  }
  const afterSizes = sizes(result);
  await writeNewAtomic(output!, result);
  return { ok: true, action, gpuRequired: false, networkUsed: false, input, output,
    method: 'lossless-meshopt', compressionApplied: useCompression,
    compressedBufferViews: useCompression ? compressed.compressedViews : 0,
    preservation: 'Original nodes, animations, materials, extras, image bytes and decoded bufferView bytes; no quantization, simplification, reordering or texture recompression',
    note: useCompression ? 'Delivery-size optimization; no frame-rate improvement is implied. Runtime Meshopt decoding is required.' :
      'The candidate did not reduce the raw GLB size. The new output is an exact copy of the input.',
    validatorVersion: validator.version(), before,
    after: { ...afterSizes, ...summary((await readEmbedded(result)).json), validation: afterValidation },
    savedBytes: bytes.length - result.length,
    savedGzipBytes: before.gzipBytes - afterSizes.gzipBytes,
    savedBrotliBytes: before.brotliBytes - afterSizes.brotliBytes,
    deliveryWarning: afterSizes.gzipBytes > before.gzipBytes || afterSizes.brotliBytes > before.brotliBytes ?
      'HTTP-compressed size increased. Choose the original asset when its actual delivery encoding is smaller.' : null,
    validationLimit: 'The Khronos validator may not decode every extension. Compressed views are separately decoded and compared byte-for-byte; glTF Transform also compares all accessors.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAssets(process.argv.slice(2)).then(report => {
    console.log(JSON.stringify(report, null, 2));
    if (report.ok === false) process.exitCode = 1;
  }).catch((error: Error & { validation?: ValidationReport }) => {
    console.error(JSON.stringify({ ok: false, error: error.message, ...(error.validation ? { validation: error.validation } : {}) }, null, 2));
    process.exitCode = 1;
  });
}
