import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships the dynamic launcher and a fixed Web runtime entry. The
 * root tsdown builds only `lib/types/index.js`, so this override points at the
 * two executable source entries; their reachable mode modules bundle with them.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/web-bundle.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
