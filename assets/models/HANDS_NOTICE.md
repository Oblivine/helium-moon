# First-person hand models

`hand_left.bin` and `hand_right.bin` are the "generic-hand" glTF binaries (`left.glb`, `right.glb`)
from the W3C Immersive Web Working Group's WebXR Input Profiles project, renamed only so the game's
asset pipeline serves them:

- Source: https://github.com/immersive-web/webxr-input-profiles (`packages/assets/profiles/generic-hand/`)
- Also published as the npm package `@webxr-input-profiles/assets`.
- Supplied by the project owner on Nov 10 2026. The project is published under the MIT License;
  see the LICENSE file in that repository for the full text and copyright notice.

The files are unmodified. `client/game/arms.js` reads them directly (a minimal GLB reader) and poses
the 25 joints itself.
