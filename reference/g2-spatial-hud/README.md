# G2 Spatial HUD Reference (2.5D triplane)

Adapted from `jonathanprocter/clinical-hud` (`hud/src/g2/`) for choosing-to-speak. See
`docs/conversate-and-clinical-hud-mining-2026-07-31.md` for the full mining report.

## Contents

- `format.mjs` — pure triplane state + 576×288 text formatting law, mapped to this repo's
  backend payloads (`/v1/coach`, `/v1/question_cues`) instead of clinical-hud middleware frames.
- `format.test.mjs` — `node --test` coverage of the mapping and priority rules.

## The on-lens container pattern (official Even Hub SDK)

```js
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';

const bridge = await waitForEvenAppBridge();
await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 1,
  textObject: [new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: 576, height: 288,
    borderWidth: 0, borderColor: 15, paddingLength: 8,
    containerID: 1, containerName: 'main',
    content: formatGlassesText(initialState()),
    isEventCapture: 1, // routes glasses tap events back into the WebView
  })],
}));

await bridge.textContainerUpgrade(new TextContainerUpgrade({
  containerID: 1, containerName: 'main', contentOffset: 0, contentLength: 0,
  content: formatGlassesText(state),
}));
```

## Integration options

1. **Rebuild the plugin HUD screen (preferred).** The compiled bundle already imports the same
   SDK symbols and manages its own containers. Porting `format.mjs` into the plugin source and
   rebuilding gives the triplane layout without container ownership conflicts.
2. **Page-level overlay (prototype only).** A page script could create its own container the way
   clinical-hud's `g2.html` does, but it would race the app bundle's `createStartUpPageContainer`.
   Only use this in a stripped test page, never alongside the live plugin screen.

## Priority law

NEAR (dynamics alert) overrides MID (cue/question); FAR (ratios + conversational state) is always
one compressed status line; total content hard-capped at 900 chars. NEAR auto-dismisses (clinical-hud
used 5 s browser / 8 s on-lens).
