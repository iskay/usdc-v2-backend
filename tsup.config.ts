import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/app.ts'],
  sourcemap: true,
  clean: true,
  format: ['esm'],
  target: 'node20',
  dts: true,
  minify: false,
  outDir: 'dist'
});

