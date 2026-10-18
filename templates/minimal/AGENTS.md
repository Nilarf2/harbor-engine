# Build this game with Harbor

This is an independent game application. Use the installed `@harbor/engine` exports. Keep game content in `src/scene.json` and game rules/input/UI in this application; do not edit installed engine files to implement ordinary gameplay.

Read `node_modules/@harbor/engine/docs/AI_GUIDE.md` and the public TypeScript declarations when an API is unfamiliar. Keep stable entity IDs and game data inside entity `data`. Use lifecycle methods and physics commands, and register plugin cleanup with `scope.add()`.

Run `npm run validate`, `npm run simulate`, and `npm run build` after relevant changes. Simulation requires no GPU. Visual and performance claims need real browser checks; software rendering is not a target-GPU benchmark. Path tracing is experimental and its live mode resets accumulation for movement.

Preserve `vendor/engine.tgz`, `public/licenses/`, and the dependency lockfile so the game remains portable. Keep English documentation, preserve existing user changes, and report checks actually run.
