import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('APIs de datos de usuario', () => {
  it('toda carpeta de src/pages/api (salvo auth, admin y kapso) está en WORKSPACE_APIS del middleware', () => {
    // Si falta, `locals.workspace` llega nulo a la ruta y responde 403 NO_WORKSPACE aunque la sesión sea válida.
    const middleware = readFileSync(new URL('../src/middleware.ts', import.meta.url), 'utf8');
    const listed = /WORKSPACE_APIS = \[([^\]]*)\]/.exec(middleware)![1]!;
    const areas = readdirSync(new URL('../src/pages/api', import.meta.url), { withFileTypes: true })
      // kapso: webhook público sin sesión; se autentica con la firma HMAC, no con el espacio activo.
      .filter((entry) => entry.isDirectory() && !['auth', 'admin', 'kapso'].includes(entry.name))
      .map((entry) => entry.name);
    for (const area of areas) expect(listed, area).toContain(`'/api/${area}'`);
  });
});
