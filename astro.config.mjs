import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://leadflow.io',
  build: {
    inlineStylesheets: 'always'
  },
  vite: {
    build: {
      cssMinify: true
    },
    server: {
      allowedHosts: true
    }
  }
});
