import type { Texture } from 'three/webgpu';
import { texture, screenUV, wgslFn } from 'three/tsl';

// Manual filtering follows three-gpu-pathtracer's MIT RenderToScreenMaterial.
// WebGPU screenUV already has top-down rows, matching both raw and OIDN targets;
// applying the older FullScreenQuad's bottom-up UV flip here would invert r186.
// textureLoad avoids requiring the optional float32-filterable feature.
const sampleHDR = wgslFn(`
  fn harborSampleHDR(image: texture_2d<f32>, coordinate: vec2f) -> vec4f {
    let size=vec2f(textureDimensions(image,0));
    let p=coordinate*size-0.5;
    let base=vec2i(floor(p)); let f=fract(p); let maximum=vec2i(size)-1;
    let a=textureLoad(image,clamp(base,vec2i(0),maximum),0);
    let b=textureLoad(image,clamp(base+vec2i(1,0),vec2i(0),maximum),0);
    let c=textureLoad(image,clamp(base+vec2i(0,1),vec2i(0),maximum),0);
    let d=textureLoad(image,clamp(base+vec2i(1,1),vec2i(0),maximum),0);
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
  }
`);

/** Linear HDR source for one final RenderPipeline. Update textureNode.value after denoising. */
export function createPathTracingOutputNode(initialTexture: Texture) {
  const textureNode = texture(initialTexture);
  return { textureNode, colorNode: sampleHDR(textureNode, screenUV) };
}
