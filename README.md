# Lightshaper

A free, offline photo editor for Mac and Windows, by [Hollowbit Studio](https://hollowbit.dev/).

![Lightshaper editing a RAW photo of two ships at sea, with looks and sliders on the right](screenshots/editor.webp)

Download: [hollowbit.dev/lightshaper](https://hollowbit.dev/lightshaper/) · Homebrew: `brew install --cask hollowbit-dev/tap/lightshaper`

- Open single photos or whole folders: JPEG, PNG, WebP, AVIF, HEIC/HEIF, TIFF (8 and 16-bit), JPEG XL, PSD, BMP, GIF and camera RAW (CR2, CR3, NEF, ARW, RAF, DNG, ORF, RW2, PEF, GPR and more, via LibRaw).
- Export to JPEG, PNG, WebP or TIFF (8 or 16-bit).
- Light, colour and effects sliders, tone curve, colour mixer, colour grading, noise reduction, crop and straighten.
- Gradient and radial masks, white balance picker, clipping warning, star ratings.
- 14 hand-made looks, your own looks, and **Match a photo**: copy another photo's tones and colours into ordinary sliders.
- Opens Lightroom presets (.xmp and .lrtemplate). Not affiliated with Adobe.
- Copy and paste edits, or apply a look to many photos at once. Export them all as JPEG, PNG or WebP.
- Your originals are never changed. No account, no tracking, no AI.

```
npm install
npm start          # run
npm test           # engine renders + UI walkthrough (needs sample photos in samples/)
npm run dist       # installers in dist/
```

MIT licence. Decoders: [LibRaw](https://www.libraw.org/) (LGPL/CDDL) through libraw-wasm, [libheif](https://github.com/strukturag/libheif) (LGPL) through libheif-js, libjxl through [jSquash](https://github.com/jamsinclair/jSquash) (Apache-2.0), [UTIF.js](https://github.com/photopea/UTIF.js) (MIT) and [ag-psd](https://github.com/Agamnentzar/ag-psd) (MIT). `npm run vendor` rebuilds their bundles in src/renderer/vendor.
