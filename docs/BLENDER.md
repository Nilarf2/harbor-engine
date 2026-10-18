# Blender assets in Harbor

Keep `.blend` files as editable source art and export self-contained `.glb` files for the game. Harbor loads GLB through its asset manager; it does not open `.blend` files. A GPU is not required for Harbor's model inspection, lossless optimization, simulation, or build commands. Blender authoring and texture baking are separate tools, not bundled engine services.

## Export a static prop or environment

1. Use mesh objects with UVs and a Principled BSDF material. Prefer image textures for base color, roughness/metallic, normals, and emission. The exporter recognizes particular node arrangements; an arbitrary Cycles/Eevee shader graph is not a portable glTF material. Bake procedural detail into suitable images when needed.
2. Connect a normal image through a **Normal Map** node to Principled BSDF. Use **Non-Color**, **Tangent Space**, and a +Y normal map. Metallic/roughness images also use Non-Color; glTF stores metallic in blue and roughness in green.
3. Export through **File → Export → glTF 2.0**, choosing **glTF Binary (.glb)**. This packages geometry and images together. Keep **Y Up** enabled and export UVs/normals. For a static asset whose modifiers define its final shape, **Apply Modifiers** exports the evaluated mesh. Quads and n-gons become triangles; curves need conversion to meshes. These settings follow the [official Blender glTF exporter's documentation](https://github.com/KhronosGroup/glTF-Blender-IO/blob/653063ebbf73d27a01e883665b5c042c25a36ece/docs/blender_docs/scene_gltf2.rst).

Use a consistent meter-based scale: glTF defines linear distances in meters. For Harbor, check a known-size test object against the player and collider dimensions after export. Keep object origins intentional and apply rotation/scale to a static source object when that makes authoring predictable; do not blindly apply transforms to an animated rig. Avoid manually rotating the exported root again to compensate for Blender's up axis. See [glTF coordinate-system conventions](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#coordinate-system-and-units).

Export an ordinary uncompressed GLB first. Harbor's current loader rejects external buffer/image URLs and does not configure Draco or KTX2 decoders. Keep the source asset and its license; optional Meshopt compression can be applied afterward without replacing the original:

```sh
npm run assets -- inspect path/to/prop.glb
npm run assets -- optimize path/to/prop.glb path/to/prop-meshopt.glb
```

These commands run from the engine checkout. Check the JSON report, including gzip/Brotli sizes: a smaller raw file is not necessarily a smaller download.

## Attach the asset and define gameplay separately

Place the chosen GLB in the game's `public/models/` directory and follow the [textured GLB/HDR ownership recipe](AI_GUIDE.md#load-a-textured-glb-into-the-quality-scene). It loads the model through `createAssetManager()`, adds its real Three scene to the quality renderer, and releases resources after renderer cleanup. Rigid object motion uses `updateTransforms()` plus accumulation reset; object additions/removals or changed geometry need scene invalidation.

An imported visual does not automatically create an entity, collider, navigation mesh, or AI behavior. Define collision bodies separately with stable IDs. For example, a static two-meter crate centered one meter above the ground can have this invisible collision entity in scene JSON:

```json
{
  "id": "prop-crate-collider",
  "position": [0, 1, 0],
  "body": { "type": "fixed", "shape": "box", "size": [2, 2, 2] }
}
```

Match the collider to the imported object's actual location and dimensions. Physics body scales remain `[1, 1, 1]`; use explicit body dimensions. This alpha does not automatically turn arbitrary Blender meshes into colliders or navigation data.

Start with static PBR assets. Exportable material extensions are broader than Harbor's validated examples, and Blender's final render is not an appearance guarantee in a different lighting/rendering system. Skeletal actors and clips are available in the asset runtime; continuous skinned/morph path tracing still requires explicit synchronization and separate validation. The compact tracer does not inherit the quality backend's textured-GLB support.
