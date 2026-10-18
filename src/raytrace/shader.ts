/** WGSL ray/triangle path tracing. No raster depth, screen-space buffer, or RT-core API. */
export const TRACE_SHADER = /* wgsl */ `
struct Params {
  cameraPosition: vec4f,
  cameraForward: vec4f,
  cameraRight: vec4f,
  cameraUp: vec4f,
  settings: vec4u,
  skyTop: vec4f,
  skyHorizon: vec4f,
  ground: vec4f,
  sunDirection: vec4f,
  sunColor: vec4f,
}
struct Triangle { a: vec4f, b: vec4f, c: vec4f, na: vec4f, nb: vec4f, nc: vec4f }
struct BVHNode { lo: vec4f, hi: vec4f, links: vec4u }
struct Material { color: vec4f, emission: vec4f, optics: vec4f }
struct Hit { distance: f32, triangle: u32, u: f32, v: f32 }
struct Surface { point: vec3f, normal: vec3f, geometric: vec3f, material: u32, frontFace: bool }
struct BSDF { value: vec3f, pdf: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(2) var<storage, read> nodes: array<BVHNode>;
@group(0) @binding(3) var<storage, read> materials: array<Material>;
@group(0) @binding(4) var<storage, read_write> accumulation: array<vec4f>;
const PI: f32 = 3.141592653589793;
const FAR: f32 = 1e20;
const NO_HIT: u32 = 0xffffffffu;

fn random(state: ptr<function, u32>) -> f32 {
  *state = *state * 747796405u + 2891336453u;
  var word = ((*state >> ((*state >> 28u) + 4u)) ^ *state) * 277803737u;
  word = (word >> 22u) ^ word;
  return f32(word >> 8u) * (1.0 / 16777216.0);
}
fn safeInverse(value: f32) -> f32 {
  if (abs(value) < 1e-9) { return select(-1e20, 1e20, value >= 0.0); }
  return 1.0 / value;
}
fn boxDistance(node: BVHNode, origin: vec3f, inverse: vec3f, maxDistance: f32) -> f32 {
  let a = (node.lo.xyz - origin) * inverse;
  let b = (node.hi.xyz - origin) * inverse;
  let lo = min(a, b); let hi = max(a, b);
  let near = max(max(lo.x, lo.y), max(lo.z, 0.0001));
  let far = min(min(hi.x, hi.y), min(hi.z, maxDistance));
  return select(FAR, near, far >= near);
}
fn triangleHit(triangle: Triangle, origin: vec3f, direction: vec3f) -> vec3f {
  let edge1 = triangle.b.xyz - triangle.a.xyz;
  let edge2 = triangle.c.xyz - triangle.a.xyz;
  let p = cross(direction, edge2);
  let det = dot(edge1, p);
  if (abs(det) < 1e-9) { return vec3f(FAR, 0.0, 0.0); }
  let invDet = 1.0 / det;
  let offset = origin - triangle.a.xyz;
  let u = dot(offset, p) * invDet;
  if (u < 0.0 || u > 1.0) { return vec3f(FAR, 0.0, 0.0); }
  let q = cross(offset, edge1);
  let v = dot(direction, q) * invDet;
  if (v < 0.0 || u + v > 1.0) { return vec3f(FAR, 0.0, 0.0); }
  let t = dot(edge2, q) * invDet;
  if (t < 0.0001) { return vec3f(FAR, 0.0, 0.0); }
  return vec3f(t, u, v);
}
fn intersect(origin: vec3f, direction: vec3f, maxDistance: f32, anyHit: bool) -> Hit {
  var hit = Hit(maxDistance, NO_HIT, 0.0, 0.0);
  if (params.settings.z == 0u) { return hit; }
  let inverse = vec3f(safeInverse(direction.x), safeInverse(direction.y), safeInverse(direction.z));
  var stack: array<u32, 64>;
  var count = 1u; stack[0] = 0u;
  loop {
    if (count == 0u) { break; }
    count -= 1u;
    let node = nodes[stack[count]];
    if (boxDistance(node, origin, inverse, hit.distance) == FAR) { continue; }
    if (node.links.w > 0u) {
      for (var i = 0u; i < node.links.w; i += 1u) {
        let index = node.links.z + i;
        let result = triangleHit(triangles[index], origin, direction);
        if (result.x < hit.distance) {
          hit = Hit(result.x, index, result.y, result.z);
          if (anyHit) { return hit; }
        }
      }
    } else {
      let left = node.links.x; let right = node.links.y;
      let dl = boxDistance(nodes[left], origin, inverse, hit.distance);
      let dr = boxDistance(nodes[right], origin, inverse, hit.distance);
      // Push the farther child first so the nearest one is visited first.
      if (dl < dr) {
        if (dr < FAR) { stack[count] = right; count += 1u; }
        if (dl < FAR) { stack[count] = left; count += 1u; }
      } else {
        if (dl < FAR) { stack[count] = left; count += 1u; }
        if (dr < FAR) { stack[count] = right; count += 1u; }
      }
    }
  }
  return hit;
}
fn surface(hit: Hit, origin: vec3f, direction: vec3f) -> Surface {
  let triangle = triangles[hit.triangle];
  var geometric = normalize(cross(triangle.b.xyz - triangle.a.xyz, triangle.c.xyz - triangle.a.xyz));
  let frontFace = dot(direction, geometric) < 0.0;
  var normal = normalize(triangle.na.xyz * (1.0 - hit.u - hit.v) + triangle.nb.xyz * hit.u + triangle.nc.xyz * hit.v);
  if (dot(normal, geometric) < 0.0) { normal = -normal; }
  if (dot(direction, geometric) > 0.0) { geometric = -geometric; normal = -normal; }
  // Extreme interpolated normals must not point behind the incoming ray.
  if (dot(normal, -direction) < 0.001) { normal = geometric; }
  return Surface(origin + direction * hit.distance, normal, geometric, u32(triangle.a.w), frontFace);
}
fn basis(normal: vec3f, local: vec3f) -> vec3f {
  let helper = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(normal.y) > 0.99);
  let tangent = normalize(cross(helper, normal));
  return normalize(tangent * local.x + cross(normal, tangent) * local.y + normal * local.z);
}
fn sky(direction: vec3f) -> vec3f {
  if (direction.y < 0.0) { return mix(params.skyHorizon.xyz, params.ground.xyz, min(1.0, -direction.y * 4.0)); }
  return mix(params.skyHorizon.xyz, params.skyTop.xyz, pow(direction.y, 0.65));
}
fn distribution(noH: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let d = noH * noH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-12);
}
fn smith(noV: f32, alpha: f32) -> f32 {
  return 2.0 * noV / max(noV + sqrt(alpha * alpha + (1.0 - alpha * alpha) * noV * noV), 1e-6);
}
fn evaluateBSDF(material: Material, normal: vec3f, view: vec3f, light: vec3f) -> BSDF {
  let noV = max(dot(normal, view), 0.0); let noL = max(dot(normal, light), 0.0);
  if (noV <= 0.0 || noL <= 0.0) { return BSDF(vec3f(0.0), 0.0); }
  let halfLength = length(view + light);
  if (halfLength < 1e-6) { return BSDF(vec3f(0.0), 0.0); }
  let halfway = (view + light) / halfLength;
  let noH = max(dot(normal, halfway), 0.0); let voH = max(dot(view, halfway), 1e-6);
  let alpha = max(material.emission.w * material.emission.w, 0.0025);
  let f0 = mix(vec3f(0.04), material.color.xyz, material.color.w);
  let fresnel = f0 + (vec3f(1.0) - f0) * pow(1.0 - voH, 5.0);
  let d = distribution(noH, alpha);
  let g = smith(noV, alpha) * smith(noL, alpha);
  let specular = fresnel * d * g / max(4.0 * noV * noL, 1e-6);
  let diffuse = (vec3f(1.0) - fresnel) * (1.0 - material.color.w) * material.color.xyz / PI;
  let specProbability = clamp(max(max(f0.x, f0.y), f0.z), 0.1, 0.9);
  let pdf = mix(noL / PI, d * noH / max(4.0 * voH, 1e-6), specProbability);
  return BSDF(diffuse + specular, pdf);
}
fn sampleBSDF(material: Material, normal: vec3f, view: vec3f, state: ptr<function, u32>) -> vec3f {
  let f0 = mix(vec3f(0.04), material.color.xyz, material.color.w);
  let specProbability = clamp(max(max(f0.x, f0.y), f0.z), 0.1, 0.9);
  let specular = random(state) < specProbability;
  let u = random(state); let phi = 2.0 * PI * random(state);
  if (specular) {
    let alpha = max(material.emission.w * material.emission.w, 0.0025);
    let cosine = sqrt((1.0 - u) / (1.0 + (alpha * alpha - 1.0) * u));
    let sine = sqrt(max(0.0, 1.0 - cosine * cosine));
    let halfVector = basis(normal, vec3f(sine * cos(phi), sine * sin(phi), cosine));
    return reflect(-view, halfVector);
  }
  let radius = sqrt(u);
  return basis(normal, vec3f(radius * cos(phi), radius * sin(phi), sqrt(1.0 - u)));
}
fn sampleSun(state: ptr<function, u32>) -> vec3f {
  let cosMax = cos(params.skyHorizon.w);
  let z = mix(cosMax, 1.0, random(state));
  let phi = 2.0 * PI * random(state); let radius = sqrt(max(0.0, 1.0 - z * z));
  return basis(params.sunDirection.xyz, vec3f(radius * cos(phi), radius * sin(phi), z));
}
fn dielectricFresnel(cosine: f32, etaI: f32, etaT: f32) -> f32 {
  let sinTransmitted2 = (etaI * etaI / (etaT * etaT)) * max(0.0, 1.0 - cosine * cosine);
  if (sinTransmitted2 >= 1.0) { return 1.0; }
  let transmitted = sqrt(1.0 - sinTransmitted2);
  let parallel = (etaT * cosine - etaI * transmitted) / max(etaT * cosine + etaI * transmitted, 1e-6);
  let perpendicular = (etaI * cosine - etaT * transmitted) / max(etaI * cosine + etaT * transmitted, 1e-6);
  return clamp(0.5 * (parallel * parallel + perpendicular * perpendicular), 0.0, 1.0);
}
fn trace(initialOrigin: vec3f, initialDirection: vec3f, state: ptr<function, u32>) -> vec3f {
  var origin = initialOrigin; var direction = initialDirection;
  var radiance = vec3f(0.0); var throughput = vec3f(1.0);
  for (var bounce = 0u; bounce < params.settings.w; bounce += 1u) {
    let hit = intersect(origin, direction, FAR, false);
    if (hit.triangle == NO_HIT) { radiance += throughput * sky(direction); break; }
    let s = surface(hit, origin, direction);
    let material = materials[s.material];
    radiance += throughput * material.emission.xyz;
    let offset = max(0.0005, length(s.point) * 0.00001);
    origin = s.point + s.geometric * offset;
    let transmission = material.optics.x * (1.0 - material.color.w);
    // Next-event estimation for a finite angular directional sun; actual BVH shadow rays.
    if (params.skyTop.w > 0.0) {
      let light = sampleSun(state);
      let noL = max(dot(s.normal, light), 0.0);
      if (noL > 0.0 && dot(s.geometric, light) > 0.0) {
        if (intersect(origin, light, FAR, true).triangle == NO_HIT) {
          let bsdf = evaluateBSDF(material, s.normal, -direction, light);
          radiance += throughput * bsdf.value * noL * params.sunColor.xyz * params.skyTop.w * (1.0 - transmission);
        }
      }
    }
    if (transmission > 0.0 && random(state) < transmission) {
      // A polished dielectric interface. Transmission/reflection probabilities are
      // the exact unpolarized Fresnel terms, including total internal reflection.
      let etaI = select(material.optics.y, 1.0, s.frontFace);
      let etaT = select(1.0, material.optics.y, s.frontFace);
      let eta = etaI / etaT;
      let cosine = clamp(dot(-direction, s.normal), 0.0, 1.0);
      let fresnel = dielectricFresnel(cosine, etaI, etaT);
      if (random(state) < fresnel) {
        direction = reflect(direction, s.normal);
      } else {
        direction = refract(direction, s.normal, eta);
        if (dot(direction, direction) < 1e-8) { break; }
        throughput *= eta * eta;
        // Color is a surface transmission tint, not volumetric Beer-Lambert absorption.
        if (s.frontFace) { throughput *= material.color.xyz; }
      }
      origin = s.point + s.geometric * select(-offset, offset, dot(direction, s.geometric) >= 0.0);
    } else {
      let incoming = sampleBSDF(material, s.normal, -direction, state);
      if (dot(incoming, s.geometric) <= 0.0) { break; }
      let bsdf = evaluateBSDF(material, s.normal, -direction, incoming);
      if (bsdf.pdf < 1e-8) { break; }
      throughput *= bsdf.value * max(dot(s.normal, incoming), 0.0) / bsdf.pdf;
      direction = incoming;
    }
    if (any(throughput != throughput) || any(throughput > vec3f(1e12))) { break; }
    if (bounce >= 2u) {
      let survival = clamp(max(max(throughput.x, throughput.y), throughput.z), 0.05, 0.95);
      if (random(state) > survival) { break; }
      throughput /= survival;
    }
  }
  if (any(radiance != radiance) || any(radiance > vec3f(1e15))) { return vec3f(0.0); }
  return max(radiance, vec3f(0.0));
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let width = u32(params.cameraRight.w); let height = u32(params.cameraUp.w);
  if (id.x >= width || id.y >= height) { return; }
  let index = id.y * width + id.x;
  var seed = index * 1973u + params.settings.x * 9277u + 89173u;
  let jitter = vec2f(random(&seed), random(&seed));
  let uv = (vec2f(id.xy) + jitter) / vec2f(f32(width), f32(height));
  let screen = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let direction = normalize(params.cameraForward.xyz
    + params.cameraRight.xyz * screen.x * params.cameraPosition.w * params.cameraForward.w
    + params.cameraUp.xyz * screen.y * params.cameraPosition.w);
  let sample = trace(params.cameraPosition.xyz, direction, &seed);
  var previous = vec3f(0.0);
  if (params.settings.x > 0u) { previous = accumulation[index].xyz; }
  let n = f32(params.settings.x);
  accumulation[index] = vec4f((previous * n + sample) / (n + 1.0), 1.0);
}
`;

export const PRESENT_SHADER = /* wgsl */ `
struct Params {
  cameraPosition: vec4f, cameraForward: vec4f, cameraRight: vec4f, cameraUp: vec4f,
  settings: vec4u, skyTop: vec4f, skyHorizon: vec4f, ground: vec4f, sunDirection: vec4f, sunColor: vec4f,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> accumulation: array<vec4f>;
@vertex fn vertexMain(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  let x = f32((vertex << 1u) & 2u); let y = f32(vertex & 2u);
  return vec4f(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}
fn aces(value: vec3f) -> vec3f {
  return clamp((value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn srgb(value: vec3f) -> vec3f {
  return select(1.055 * pow(value, vec3f(1.0 / 2.4)) - 0.055, 12.92 * value, value <= vec3f(0.0031308));
}
@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let index = u32(position.y) * u32(params.cameraRight.w) + u32(position.x);
  return vec4f(srgb(aces(accumulation[index].xyz * params.ground.w)), 1.0);
}
`;
