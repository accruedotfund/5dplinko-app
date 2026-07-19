// core/gl/draco.js — thin adapter over the vendored pure-JS Draco decoder.
//
// Lazy-loaded by gltf.js ONLY when a primitive carries KHR_draco_mesh_compression,
// so the ~62KB decoder never enters the boot graph for non-Draco models. The heavy
// lifting (rANS entropy → EdgeBreaker traversal → prediction reversal → dequantization)
// lives in vendor/draco.js (pure JS, no WASM — see that file's header). This module just
// maps the decoded Draco Mesh into the plain typed-array shape gltf.js already consumes.
//
//   decodeDracoMesh(bytes, attrMap) → {
//     numPoints,
//     indices:  Uint32Array,                       // numFaces*3
//     attributes: { POSITION:Float32Array, NORMAL?:Float32Array, TEXCOORD_0?:Float32Array, … }
//   }
//
// `attrMap` is the extension's name→uniqueId map, e.g. { POSITION:0, NORMAL:1, TEXCOORD_0:2 }.
// Attributes are dequantized to Float32 on the CPU by the decoder (extractTo).

import { Decoder, DecoderBuffer } from '../../../vendor/draco.js';

export function decodeDracoMesh(bytes, attrMap) {
  const buffer = new DecoderBuffer();
  buffer.init(bytes, bytes.length);
  const decoder = new Decoder();
  const { mesh, ok, message } = decoder.decodeMeshFromBuffer(buffer);
  if (!ok) throw new Error('draco: decode failed — ' + message);

  const numPoints = mesh.numPoints();
  const numFaces = mesh.numFaces();
  const indices = new Uint32Array(numFaces * 3);
  indices.set(mesh.faces_.subarray(0, numFaces * 3));

  const attributes = {};
  for (const name in attrMap) {
    const att = mesh.getAttributeByUniqueId(attrMap[name]);
    if (!att) continue;
    attributes[name] = att.extractTo(Float32Array, numPoints);
  }
  return { numPoints, indices, attributes };
}
