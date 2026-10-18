import { deflateSync } from 'node:zlib';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';
import { BoxGeometry } from 'three';

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(body.length + 8);
  result.writeUInt32BE(data.length, 0); body.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

/** Original MIT fixture: a Meshopt cube with a generated red/cyan 2x2 PNG inside its GLB. */
export async function createTexturedCubeGLB() {
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.from([0, 235, 30, 20, 255, 20, 180, 245, 255, 0, 20, 180, 245, 255, 235, 30, 20, 255]);
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
  const document = new Document(), buffer = document.createBuffer();
  document.getRoot().getAsset().copyright = 'Original Harbor fixture, MIT';
  const texture = document.createTexture('Original checker').setImage(image).setMimeType('image/png');
  const material = document.createMaterial('Textured cube').setBaseColorTexture(texture).setMetallicFactor(0).setRoughnessFactor(.55);
  const geometry = new BoxGeometry(2, 2, 2), primitive = document.createPrimitive().setMaterial(material);
  for (const [name, semantic, type] of [['position', 'POSITION', 'VEC3'], ['normal', 'NORMAL', 'VEC3'], ['uv', 'TEXCOORD_0', 'VEC2']]) {
    primitive.setAttribute(semantic, document.createAccessor(name).setType(type).setArray(geometry.getAttribute(name).array).setBuffer(buffer));
  }
  primitive.setIndices(document.createAccessor('indices').setType('SCALAR').setArray(geometry.index.array).setBuffer(buffer));
  const mesh = document.createMesh('Original textured cube').addPrimitive(primitive);
  document.createScene('Original fixture').addChild(document.createNode('checker-cube').setMesh(mesh));
  geometry.dispose();
  await MeshoptEncoder.ready;
  document.createExtension(EXTMeshoptCompression).setRequired(true);
  return new NodeIO().registerExtensions([EXTMeshoptCompression])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder }).writeBinary(document);
}
