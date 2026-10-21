import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function browserLaunchOptions(env = process.env, platform = process.platform, exists = existsSync) {
  const mode = env.HARBOR_GPU_MODE || 'software';
  if (!['software', 'hardware'].includes(mode)) throw new Error('HARBOR_GPU_MODE must be software or hardware');
  const headless = env.HARBOR_HEADLESS ?? '1';
  if (!['0', '1'].includes(headless)) throw new Error('HARBOR_HEADLESS must be 0 or 1');
  const power = env.HARBOR_GPU_POWER || 'default';
  if (!['default', 'high-performance'].includes(power)) throw new Error('HARBOR_GPU_POWER must be default or high-performance');
  if (power === 'high-performance' && (platform !== 'win32' || mode !== 'hardware')) throw new Error('HARBOR_GPU_POWER=high-performance requires Windows hardware mode');
  // Remote process launchers may preserve mixed-case Windows environment names,
  // or omit them entirely. Common system locations remain existence-checked.
  const windowsEnv = name => env[name] ?? Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const programs = windowsEnv('PROGRAMFILES'), programsX86 = windowsEnv('PROGRAMFILES(X86)'), local = windowsEnv('LOCALAPPDATA');
  const candidates = platform === 'win32' ? [
    programs && join(programs, 'Microsoft/Edge/Application/msedge.exe'),
    programsX86 && join(programsX86, 'Microsoft/Edge/Application/msedge.exe'),
    programs && join(programs, 'Google/Chrome/Application/chrome.exe'),
    local && join(local, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ] : platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  const executablePath = env.CHROMIUM_PATH || candidates.find(path => path && exists(path));
  if (!executablePath || !exists(executablePath)) throw new Error('Set CHROMIUM_PATH to an installed Chromium, Chrome, or Edge executable');
  const args = ['--disable-background-networking', '--no-proxy-server'];
  if (power === 'high-performance') args.push('--force_high_performance_gpu');
  if (platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
  if (mode === 'software') args.push('--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader');
  return { executablePath, headless: headless === '1', args,
    env: Object.fromEntries(Object.entries(env).filter(([key]) => !/^https?_proxy$|^all_proxy$/i.test(key))),
  };
}

// Instrument actual adapters and contexts requested by the application, not an
// unrelated preflight adapter that could differ from the one used to render.
export async function observeGraphics(page) {
  await page.addInitScript(() => {
    const evidence = { webgpu: [], webgl: [] };
    Object.defineProperty(window, '__HARBOR_GPU_EVIDENCE__', { value: evidence });
    if (navigator.gpu) {
      const gpu = navigator.gpu, original = gpu.requestAdapter.bind(gpu);
      gpu.requestAdapter = async (...args) => {
        const adapter = await original(...args);
        if (adapter) {
          const info = adapter.info ?? await adapter.requestAdapterInfo?.() ?? {};
          evidence.webgpu.push({ vendor: info.vendor, architecture: info.architecture,
            device: info.device, description: info.description,
            isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter,
          });
        }
        return adapter;
      };
    }
    const original = HTMLCanvasElement.prototype.getContext;
    const seen = new WeakSet();
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      const context = original.call(this, type, ...args);
      if (context && ['webgl', 'webgl2', 'experimental-webgl'].includes(type) && !seen.has(context)) {
        seen.add(context);
        const extension = context.getExtension('WEBGL_debug_renderer_info');
        evidence.webgl.push({ vendor: context.getParameter(extension?.UNMASKED_VENDOR_WEBGL ?? context.VENDOR),
          description: context.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? context.RENDERER) });
      }
      return context;
    };
  });
}

export function validateGraphicsEvidence(evidence, mode = process.env.HARBOR_GPU_MODE || 'software', expected = process.env.HARBOR_GPU_EXPECT) {
  try {
    assert.ok(['software', 'hardware'].includes(mode), 'Unknown GPU mode');
    if (mode !== 'hardware') return evidence;
    const adapters = [...evidence.webgpu, ...evidence.webgl];
    assert.ok(adapters.length, 'Hardware validation requires evidence from an application graphics adapter');
    for (const adapter of adapters) {
      const identity = [adapter.vendor, adapter.architecture, adapter.device, adapter.description].filter(Boolean).join(' ');
      assert.ok(identity.trim(), 'Hardware adapter identity is unavailable: (empty)');
      assert.ok(identity.replace(/WebKit|WebGL\s*2?|OpenGL ES\s*[\d.]+|Chromium|ANGLE|Google Inc\.?|Mozilla|[\s(),]/gi, '').length, `Hardware adapter identity is redacted: ${identity}`);
      assert.notEqual(adapter.isFallbackAdapter, true, `Fallback adapter cannot pass hardware validation: ${identity}`);
      assert.doesNotMatch(identity, /swiftshader|llvmpipe|lavapipe|softpipe|software|\bwarp\b|microsoft basic render/i, `Software adapter cannot pass hardware validation: ${identity}`);
      if (expected) assert.ok(identity.toLowerCase().includes(expected.toLowerCase()), `Expected GPU ${expected}, received ${identity}`);
    }
    return evidence;
  } catch (error) {
    // Preserve the observed adapters when validation rejects them so failed
    // hardware runs can still write useful diagnostic artifacts.
    if (error instanceof Error) error.evidence = evidence;
    throw error;
  }
}

export async function graphicsEvidence(page) {
  return validateGraphicsEvidence(await page.evaluate(() => window.__HARBOR_GPU_EVIDENCE__));
}
