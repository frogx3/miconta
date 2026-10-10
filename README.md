# miconta

Seguimiento de pagos a plazos (meses sin intereses, meses con intereses y pagos fijos) a partir del CSV
que el banco deja descargar, más análisis de gastos hormiga y categorías. Pensada para uso personal y
familiar primero, con espacios (workspaces) y roles desde el inicio para poder abrirla después.

**Stack:** Astro 7 (SSR) en Cloudflare Workers · D1 (SQLite) con Drizzle · R2 para los CSV originales ·
Better Auth (correo y contraseña, plugin admin). Español por defecto, preparado para otros idiomas y
regiones.

## Importar y deshacer

Cada CSV importado queda registrado en **Importar → Historial de cargas**. Si una carga salió mal se puede
**deshacer la última de cada cuenta**: elimina sus movimientos y los planes que creó, y devuelve a su estado
anterior los planes que avanzó (anotándolo en su historial). Si un plan cambió después de la carga (se editó,
se liquidó, se registró otro pago) se bloquea y se explica cuál, para no borrar trabajo tuyo. Se conservan
categorías, reglas, formato de columnas, tarjetas y el archivo original; el archivo puede volver a importarse.

## Desarrollo local

```bash
pnpm install
cp .dev.vars.example .dev.vars        # y pon un BETTER_AUTH_SECRET propio
pnpm exec wrangler d1 migrations apply miconta --local
pnpm exec astro dev --background      # http://localhost:4321
```

El primer usuario que se registra queda como **administrador**. El administrador gestiona el sistema
(crea, edita, suspende y elimina usuarios) pero **no usa** la app de finanzas: para eso crea un usuario
aparte.

| Comando | Para qué |
|---|---|
| `pnpm test` | Pruebas unitarias |
| `pnpm typecheck` | Chequeo de tipos |
| `pnpm smoke:auth` · `smoke:accounts` · `smoke:import` · `smoke:plans` · `smoke:spending` · `smoke:revert` | Pruebas de humo contra el servidor local (cada una necesita la base local **vacía**; ver el encabezado de cada script) |
| `pnpm db:generate` | Genera una migración a partir de `src/db/schema.ts` |

Las pruebas de importación y gastos leen `tests/fixtures/movements-sample.csv`, que está ignorado por git
porque contiene datos reales.

## Despliegue en Cloudflare

Recursos que usa (todos con nombre propio del proyecto):

| Recurso | Nombre | Se crea con |
|---|---|---|
| Worker | `miconta` | `pnpm cf:deploy` |
| Base de datos D1 | `miconta` | `wrangler d1 create miconta` |
| Bucket R2 (CSV originales, privado) | `miconta-files` | `wrangler r2 bucket create miconta-files` |

El `database_id` de D1 está en `wrangler.jsonc`.

### Variables y secretos

| Nombre | Tipo | Para qué |
|---|---|---|
| `ALLOW_SIGNUP` | variable (`wrangler.jsonc`) | `false`: el registro público está cerrado; las cuentas las crea el administrador |
| `BETTER_AUTH_URL` | secreto | URL pública exacta de la app (con `https://`) |
| `BETTER_AUTH_SECRET` | secreto | Firma de sesiones. **No cambiarlo**: cerraría todas las sesiones |
| `SETUP_CODE` | secreto | Código que exige el **primer** registro (el que será administrador) |
| `TRUSTED_ORIGINS` | secreto, opcional | Orígenes extra permitidos, separados por coma (p. ej. un dominio propio) |

Los valores generados al desplegar están en `.secrets.production` (local, ignorado por git, permisos 600).
Respáldalo en un gestor de contraseñas. Para cambiar uno:

```bash
echo -n "nuevo-valor" | pnpm exec wrangler secret put SETUP_CODE
```

### Primer administrador

Con la app pública, quien registre primero se queda con el sistema. Por eso **en producción el primer
registro exige `SETUP_CODE`** y, si no está configurado, nadie puede registrarse (falla cerrado). Entra a
`/registro`, escribe tu nombre, correo, contraseña y el código. Después el registro público queda cerrado.

### Actualizar la aplicación

```bash
pnpm db:migrate:remote   # solo si hay migraciones nuevas
pnpm cf:deploy           # construye y publica (no usar `pnpm deploy`: es un comando propio de pnpm)
```

Revertir a la versión anterior del Worker: `pnpm exec wrangler rollback`.
Registros en vivo: `pnpm exec wrangler tail miconta` (y en el panel: Workers → miconta → Logs).

### Respaldos

Los datos viven en D1. Cloudflare ofrece restaurar a un punto anterior con D1 Time Travel
(`pnpm exec wrangler d1 time-travel info miconta`); la ventana de retención depende del plan. Para una
copia propia: `pnpm exec wrangler d1 export miconta --remote --output respaldo.sql`.

### Límite de CPU y contraseñas

El hash de contraseñas (scrypt) es una operación pesada. **Medido en este despliegue** (`wrangler tail`):
cada verificación de contraseña consume entre **~100 y ~150 ms de CPU**, frente a ~10 ms de una página
normal. El plan gratuito de Workers limita a **10 ms de CPU por petición**; con él, el registro y el inicio
de sesión fallarían con el error 1102 («Worker exceeded resource limits»). Aquí terminan bien, así que la
cuenta tiene **Workers Paid** (30 s de CPU por defecto). Si algún día se despliega en una cuenta gratuita,
habrá que pasar a Paid; no se recomienda bajar la fortaleza del hash para caber en el plan gratuito.

Para medirlo de nuevo sin crear cuentas: inicia `pnpm exec wrangler tail miconta --format json` y haz un
inicio de sesión con un correo que no exista (Better Auth calcula un hash de relleno para no revelar qué
cuentas existen); el evento muestra `cpuTime`.

### Dominio propio

1. Añade la ruta o dominio personalizado al Worker en el panel (o `routes` en `wrangler.jsonc`).
2. Actualiza el secreto `BETTER_AUTH_URL` a la nueva URL.
3. Si quieres que sigan funcionando ambas URLs, pon la otra en `TRUSTED_ORIGINS`.

### Seguridad ya aplicada

- Cabeceras: CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- Límite de intentos de inicio de sesión guardado en D1, usando la IP real de `cf-connecting-ip`.
- Cookies seguras (HTTPS), rutas de datos filtradas siempre por el espacio activo, rol de solo lectura.
- Sin expresiones regulares escritas por el usuario en el servidor (referencia y reglas de categorías
  usan texto plano).
