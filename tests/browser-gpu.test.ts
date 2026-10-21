import test from 'node:test';
import assert from 'node:assert/strict';
// The runner helper is JavaScript so native Node browser scripts can import it.
// @ts-expect-error The helper is not part of the published TypeScript API.
import { browserLaunchOptions, validateGraphicsEvidence } from './browser-gpu.mjs';

test('hardware browser launch preserves native adapter selection and finds Windows Edge', () => {
  const options = browserLaunchOptions({ HARBOR_GPU_MODE: 'hardware', HARBOR_HEADLESS: '0', PROGRAMFILES: 'C:/Programs', HTTPS_PROXY: 'http://invalid' }, 'win32', (path: string) => path.endsWith('msedge.exe'));
  assert.match(options.executablePath, /msedge.exe$/);
  assert.equal(options.headless, false);
  assert.equal(options.env.HTTPS_PROXY, undefined);
  assert.ok(options.args.every((arg: string) => !/swiftshader|unsafe|use-angle|use-vulkan|no-sandbox/.test(arg)));
  const software = browserLaunchOptions({ CHROMIUM_PATH: '/test/chromium' }, 'linux', () => true);
  assert.ok(software.args.includes('--use-angle=swiftshader'));
  assert.ok(software.args.includes('--no-sandbox'));
  assert.ok(browserLaunchOptions({ CHROMIUM_PATH: '/test/edge', HARBOR_GPU_MODE: 'hardware', HARBOR_GPU_POWER: 'high-performance' }, 'win32', () => true).args.includes('--force_high_performance_gpu'));
  assert.throws(() => browserLaunchOptions({ HARBOR_GPU_POWER: 'high-performance' }, 'linux'), /requires Windows/);
  assert.throws(() => browserLaunchOptions({ HARBOR_GPU_MODE: 'gpu' }), /HARBOR_GPU_MODE/);
  assert.throws(() => browserLaunchOptions({ HARBOR_HEADLESS: 'yes' }), /HARBOR_HEADLESS/);
  assert.throws(() => browserLaunchOptions({}, 'linux', () => false), /CHROMIUM_PATH/);
});

test('Windows browser discovery handles mixed-case or missing installation environment', () => {
  const located = 'D:/Apps/Microsoft/Edge/Application/msedge.exe';
  const mixed = browserLaunchOptions({ HARBOR_GPU_MODE: 'hardware', ProgramFiles: 'D:/Apps' }, 'win32', (path: string) => path.replaceAll('\\', '/') === located);
  assert.equal(mixed.executablePath.replaceAll('\\', '/'), located);
  const fixed = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  assert.equal(browserLaunchOptions({ HARBOR_GPU_MODE: 'hardware' }, 'win32', (path: string) => path === fixed).executablePath, fixed);
  assert.throws(() => browserLaunchOptions({ HARBOR_GPU_MODE: 'hardware' }, 'win32', () => false), /CHROMIUM_PATH/);
  const explicit = 'Z:/Portable/edge.exe';
  assert.equal(browserLaunchOptions({ CHROMIUM_PATH: explicit }, 'win32', () => true).executablePath, explicit);
});

test('hardware evidence rejects software, missing identity and the wrong target GPU', () => {
  const evidence = (description: string, isFallbackAdapter = false) => ({ webgpu: [{ description, isFallbackAdapter }], webgl: [] });
  validateGraphicsEvidence(evidence('NVIDIA GeForce GTX 1070'), 'hardware', 'GTX 1070');
  for (const name of ['SwiftShader Device', 'llvmpipe', 'lavapipe', 'softpipe', 'WARP', 'Microsoft Basic Render Driver', 'software renderer']) {
    assert.throws(() => validateGraphicsEvidence(evidence(name), 'hardware', ''), /Software adapter/);
  }
  assert.throws(() => validateGraphicsEvidence(evidence('NVIDIA', true), 'hardware', ''), /Fallback adapter/);
  assert.throws(() => validateGraphicsEvidence(evidence(''), 'hardware', ''), /identity/);
  assert.throws(() => validateGraphicsEvidence({ webgpu: [], webgl: [{ vendor: 'WebKit', description: 'WebKit WebGL' }] }, 'hardware', ''), /redacted/);
  assert.throws(() => validateGraphicsEvidence({ webgpu: [], webgl: [] }, 'hardware', ''), /requires evidence/);
  assert.throws(() => validateGraphicsEvidence(evidence('Intel UHD 630'), 'hardware', 'GTX 1070'), /Expected GPU/);
  assert.throws(() => validateGraphicsEvidence({ ...evidence('NVIDIA'), webgl: [{ description: 'SwiftShader' }] }, 'hardware', ''), /Software adapter/);
  validateGraphicsEvidence(evidence('SwiftShader'), 'software', '');
});

test('rejected hardware evidence preserves adapter identity and the raw observation', () => {
  const evidence = { webgpu: [{ vendor: 'Google', description: 'SwiftShader Device' }], webgl: [] };
  assert.throws(() => validateGraphicsEvidence(evidence, 'hardware', ''), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Software adapter.*Google SwiftShader Device/);
    assert.equal((error as Error & { evidence: unknown }).evidence, evidence);
    return true;
  });
});
