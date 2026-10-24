# Third-party notices

Yardmaster ships a few visual effects adapted from third-party code. Each adapted file keeps the
upstream copyright notice in its header comment.

## React Bits

Source: [React Bits](https://reactbits.dev) by David Haz. License: **MIT + Commons Clause License
Condition v1.0**.

The license allows these components to be used, modified and distributed **as part of an
application, website or product** such as Yardmaster. The Commons Clause forbids selling,
sublicensing or redistributing **the components themselves**, alone, in a bundle or as a ported
version. Do not publish or package the files below on their own, outside Yardmaster.

| Component in Yardmaster | Adapted from | Used for |
|---|---|---|
| `apps/web/src/fx/DecryptedText.tsx` | TextAnimations/DecryptedText | Captions that resolve (Grid, Retro) |
| `apps/web/src/fx/GlitchText.tsx` | TextAnimations/GlitchText | Error titles (Grid) |
| `apps/web/src/fx/SplitFlapText.tsx` | TextAnimations/SplitFlapText | Status boards (Transit, Retro) |
| `apps/web/src/fx/FaultyTerminal.tsx` | Backgrounds/FaultyTerminal | Retro backdrop |
| `apps/web/src/fx/RippleGrid.tsx` | Backgrounds/RippleGrid | Grid 2D map floor |
| `apps/web/src/fx/LightTunnel.tsx` | Backgrounds/LightTunnel | Grid dive |
| `apps/web/src/fx/DarkVeil.tsx` | Backgrounds/DarkVeil | Ambient style "Veil" |
| `apps/web/src/fx/SoftAurora.tsx` | Backgrounds/SoftAurora | Ambient style "Aurora" |
| `apps/web/src/fx/SwipeRow.tsx` | Micro/SwipeRow | Swipe to Allow / Deny on phones |
| `apps/web/src/fx/HoldButton.tsx` | Micro/HoldButton | Hold to stop or interrupt on phones |

License text:

```
MIT + Commons Clause License Condition v1.0

Copyright (c) 2026 David Haz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, and distribute the Software as part of
an application, website, or product, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

Commons Clause Restriction

You may use this Software, including for any commercial purpose, so long as you
do not sell, sublicense, or redistribute the components themselves-whether
alone, in a bundle, or as a ported version.

No Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Geist

Source: [Geist](https://github.com/vercel/geist-font) by Vercel, via `@fontsource-variable/geist`.
License: **SIL Open Font License 1.1**. The README hero (`docs/brand/hero-*.svg`) embeds the
Latin subset of Geist so the wordmark renders on GitHub; the font is unmodified and not sold on its
own, which the license allows.
