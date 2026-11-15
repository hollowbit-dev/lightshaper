# Lightshaper

A free, offline photo editor for Mac and Windows, by [Hollowbit Studio](https://hollowbit.dev/).

- Open a folder of photos: JPEG, PNG, WebP, HEIC (Mac) and camera RAW (CR2, CR3, NEF, ARW, RAF, DNG, ORF, RW2 and more, via LibRaw).
- Light, colour and effects sliders, colour mixer, colour grading, crop and straighten, and 14 hand-made looks, plus your own.
- Copy and paste edits, or apply a look to many photos at once. Export them all as JPEG, PNG or WebP.
- Your originals are never changed. No account, no tracking, no AI.

```
npm install
npm start          # run
npm test           # engine renders + UI walkthrough (needs sample photos in samples/)
npm run dist       # installers in dist/
```

MIT licence. RAW decoding by [LibRaw](https://www.libraw.org/) (LGPL/CDDL) through libraw-wasm.
