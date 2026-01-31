import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import vercel from '@astrojs/vercel';

export default defineConfig({
  site: 'https://pulleads.com',
  output: 'static',
  adapter: vercel(),
  integrations: [react()],
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
