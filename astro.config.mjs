// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  // La sesión de usuario la lleva Better Auth (cookies + D1). Con `false` el adaptador no crea el
  // namespace KV `SESSION` que activa por defecto y que aquí no se usaría.
  session: false,
  // No se transforman imágenes: evita el binding `IMAGES` (y su costo).
  adapter: cloudflare({ imageService: 'passthrough' }),
});
