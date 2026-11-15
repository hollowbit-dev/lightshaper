// Bundles the image decoders into src/renderer/vendor/ as ES modules the window can load: npm run vendor
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
const out = 'src/renderer/vendor';
mkdirSync(out, { recursive: true });
const common = { bundle: true, format: 'esm', platform: 'browser', target: 'chrome128', minify: true, legalComments: 'external', logLevel: 'warning' };
const entry = (contents) => ({ stdin: { contents, resolveDir: process.cwd(), loader: 'js' } });
await build({ ...common, ...entry("export { default } from 'utif2';"), outfile: `${out}/utif.js` });
await build({ ...common, ...entry("export { default } from 'libheif-js/libheif-wasm/libheif-bundle.mjs';"), outfile: `${out}/heif.js` });
await build({ ...common, ...entry("export { default } from '@jsquash/jxl/decode.js';"), outfile: `${out}/jxl.js` });
copyFileSync('node_modules/@jsquash/jxl/codec/dec/jxl_dec.wasm', `${out}/jxl_dec.wasm`);
await build({ ...common, ...entry("export { readPsd, initializeCanvas } from 'ag-psd';"), outfile: `${out}/psd.js` });
console.log('vendor bundles written to', out);
