# Game runtime

`GameScene` owns the Three.js renderer, camera, pointer lock, procedural arena, Rapier world, movement, target practice, hitscan prototype, reload, and callout hint.

- `lockPointer()` captures the mouse after a user gesture.
- `dispose()` tears down listeners, renderer, world, and scene resources.
- Current physics: player capsule and fixed wall colliders. Test all wall/corner cases before using as a competitive controller.
- Current targets: client-side training dummies, not network players.
- TODO: server-authoritative weapon/hit logic, lag compensation, recoil patterns, proper crouch capsule resizing, collision-tested target movement, GLB assets and sound system.