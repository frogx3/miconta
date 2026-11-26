# Plan: programar el rediseño y la beta pública

Base visual: las maquetas de `docs/propuestas/` (empieza por `index.html`). Cada fase es un PR propio, se prueba en local (claro, oscuro y celular) y se despliega antes de empezar la siguiente.

## Reglas para todas las fases

- Las maquetas son la referencia, no el código final: se rehacen como componentes de Astro con los tokens de `src/styles/global.css` y textos en `src/i18n/messages.ts` (es-MX, es, en).
- Nada de datos inventados: cada número de las maquetas sale de un cargador en `src/lib/` con su prueba en `tests/`.
- Lo que hoy funciona no se rompe: cada pantalla nueva reemplaza a la anterior en el mismo PR, con sus pruebas de humo (`pnpm smoke:*`).
- Migraciones de D1 con respaldo previo de producción, como hasta ahora.

## Fase 0 · Cimientos visuales (hecha)

1. **Tokens**: acompañantes de las maquetas (salvia, terracota, cielo, marfil, `--gold-soft`, `--bar-a`) en `global.css`. `data-theme` lleva siempre el tema efectivo, también cuando viene del sistema.
2. **Encabezado fijo** y **selector de corte**: elige el *mes del corte* (`?corte=AAAA-MM`) y cada tarjeta usa su corte de ese mes. Solo aparece en las páginas que lo pasan a `AppLayout` (`period`); hoy, `/app/gastos/corte`. En el celular muestra el mes corto y el botón de tema se queda en el menú.
3. **Tarjetas** (migración 0021): `tone` (`navy` | `sage` | `terra` | `gold` | `sky` | `graphite`; nulo = automático, un color por cuenta en orden de alta) y `network` (`visa` | `mastercard` | `amex` | `other`; nulo = no la eligió). Se eligen en el formulario de tarjeta.
4. **Mascota**: `public/brand/mascota/` en WebP (listo, lista, saluda, sobre, teléfono). Faltan alcancía y presentando sin fondo.
5. **Componentes base**: `Plastic` ya está en `/app/cuentas`. `StepChart`, `Donut`, `Meter`, `Segments` y `MascotCard` llegan con la primera pantalla que los use (Fases 2–4), para no tener código sin usar.

## Fase 1 · Beta pública: landing, entrar y pedir invitación

### Pantallas
- `/` pasa a ser la landing (hoy redirige). Quien ya tiene sesión entra directo a `/app`.
- `/login` y `/acceso` con el diseño nuevo (entrar, error y primer acceso con código).
- Formulario «Pide tu invitación» en la landing.

### Datos
Migración 0022: toda solicitud se guarda como usuario en `user`, para que aparezca en **Cuentas** del admin.
- `approval_status`: `approved` (por defecto; los usuarios actuales quedan así) | `pending` | `rejected`.
- `requested_at`, `reviewed_at`, `reviewed_by`, `review_note`.
- `signup_interest` (lo que eligió: tarjetas, pagos y cobros, gastos, ahorro).
- `beta_member` (verdadero para quien entra en la beta; es la marca para el beneficio premium futuro).
- `privacy_accepted_at` (consentimiento del formulario).

Un usuario `pending` no tiene espacio de trabajo, contraseña ni código, y el middleware no lo deja entrar.

### API pública
`POST /api/invitations`:
- Valida nombre, correo y consentimiento.
- Limita intentos con la tabla `rate_limit`.
- Usa un campo trampa contra bots; Cloudflare Turnstile queda como decisión pendiente.
- Si el correo ya existe, responde igual que si fuera nuevo, para no revelar quién está registrado.
- Opcional: correo «Recibimos tu solicitud».

### Admin: cuentas por aprobar
- En `/admin`, pestaña **Por aprobar** dentro de Cuentas (hoy «Usuarios»), con contador en el menú.
- Lista con nombre, correo, interés y fecha. Acciones:
  - **Aprobar**: crea el espacio, marca `approved` y `beta_member`, emite el código de acceso (`issueAccessCode`) y manda el correo de bienvenida.
  - **Rechazar**: nota opcional; sin correo o con uno cordial (decisión pendiente).
  - **Aprobar varias** a la vez.
- Aviso al admin cuando llega una solicitud nueva (push o correo; decisión pendiente).
- Las cuentas creadas a mano por el admin siguen igual (ya aprobadas).

### Correo de bienvenida
Nueva plantilla junto a `src/lib/email/access-template.ts`, en HTML y texto plano:
- mascota del sobre (imagen pública en `public/brand/email/`);
- «Te damos la bienvenida a la beta de Don Bigo»;
- código de un solo uso de 48 horas y botón «Elegir mi contraseña» que lleva a `/acceso` con el correo ya escrito;
- tres primeros pasos (subir estado de cuenta, revisar pagos, activar avisos);
- mención del beneficio para quienes entran en la beta;
- contacto.

Se envía por el SMTP actual (`send-access.ts`). Reenviar desde el admin usa la misma plantilla.

### Pruebas
- Unitarias: validación del formulario, transición pending → approved/rejected y que un `pending` no pueda entrar.
- `pnpm smoke:invitations`: pedir invitación → aparece en Por aprobar → aprobar → llega el código → canjearlo → `/app/bienvenida`.

## Fase 2 · Portada tipo dashboard
Cargadores nuevos:
- cortes cerrados por tarjeta (lo que pagas del último corte, desglosado en mensualidades y compras);
- gasto por categoría del corte contra el promedio de 6 cortes;
- historial de 6 cortes;
- hormiga;
- uso de línea por tarjeta;
- próximos 14 días.

La respuesta «¿Me alcanza?» usa la misma lógica que Agenda (un cobro cuenta hasta marcarlo).

## Fase 3 · Cuentas y Planes
- **Cuentas:** calendario de cortes y pagos del mes, plásticos con red y tono, aviso de corte pendiente de cargar, detalle con historial de cortes.
- **Planes:** escalera con liberaciones, lista por tarjeta con avance por pago, detalle con calendario de pagos y comparación con el saldo del banco.

## Fase 4 · Agenda y Gastos
- **Agenda:** curva del saldo día a día con días en negativo, calendario mensual, «Lo que sigue» agrupado.
- **Gastos:** dona animada, gasto día por día, presupuesto con tope, hormiga y tendencia por categoría; movimientos con selección múltiple y «crear regla».

## Fase 5 · Metas, Importar y Tu cuenta
- **Metas:** una forma por tipo de meta (frasco, escalera con fecha, tope de hormiga, liquidar con abono extra).
- **Importar:** primero se elige CSV o PDF (como ya hace `/app/importar`). CSV: asistente en 4 pasos con el mosaico del archivo y la plantilla descargable. PDF (`/app/importar/pdf`): mismos 4 pasos visuales sobre el flujo que ya existe (tablas → revisar → diferencias → guardar lo marcado → listo con botón al historial); el mosaico muestra qué renglones coinciden, faltan o difieren. Las capas bajo modales, menú y avisos ya oscurecen y desenfocan lo de atrás; el rediseño las conserva.
- **Tu cuenta:** tarjeta de miembro (muestra «Beta» si `beta_member`), personas, avisos, respaldo y zona de peligro.

## Decisiones pendientes
1. Beneficio para quienes entren en la beta (precio especial, meses gratis, etc.).
2. Correo de contacto y WhatsApp reales. Las maquetas usan `hola@donbigo.com` y `55 7120 4433`, que son inventados; hoy se envía desde `contacto@donbigo.com`.
3. ¿Mandar correo de «Recibimos tu solicitud»? ¿Y de rechazo?
4. ¿Turnstile en el formulario desde el inicio?
5. ¿Cupo máximo de beta o aprobación libre?
6. Avisar al admin de solicitudes nuevas: push, correo o solo el contador.
7. Actualizar el aviso de privacidad para cubrir los datos de la invitación.
8. Pose de la alcancía sin fondo (hoy solo hay versión con fondo blanco).
