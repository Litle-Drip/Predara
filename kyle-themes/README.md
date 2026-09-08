# Kyle theme artwork

Kyle's three illustrated themes each look for one background image here. Drop the
files in with these exact names and they light up — no code change needed:

| File        | Theme      | Picker swatch     |
| ----------- | ---------- | ----------------- |
| `mars.jpg`  | Mars Safaris | orange / dark red |
| `seas.jpg`  | Other Seas, Other Suns | teal / blue |
| `astro.jpg` | Astro Mountain | cream / gold    |

The fourth theme (Gemini, blue and white) is the default and uses no image.

## What the page does with them

Each image is painted into a fixed layer behind the page (`.k-backdrop` in
`kyle.html`), under a scrim gradient in that theme's colour. The scrim is what
keeps a support agent able to read a dense brief on top of a busy illustration —
do not remove it.

Until a file exists, that theme paints a gradient sampled from the artwork
instead, so the theme is usable with the image missing and the page never waits
on a large download to become readable. A missing file costs one 404 for the
decorative layer and nothing else.

## Sizing

- **Widest useful size is about 2000px.** The layer is `background-size: cover`
  on a fixed viewport, so anything larger is downscaled on every paint.
- **Export as JPEG, quality ~80, and keep it under ~400KB.** This loads on every
  Kyle page view for agents who picked that theme.
- **Compose for the top of the frame.** The layer is anchored `center top` and
  the scrim is lightest there, so that band is the part anyone actually sees;
  the bottom is progressively covered as the brief scrolls over it.
