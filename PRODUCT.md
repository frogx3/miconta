# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Personas que se sienten ahogadas por deudas a plazos (MSI, meses con intereses, pagos fijos de tarjetas) y necesitan claridad sobre cuánto deben cada mes y cuándo quedan libres. Primero uso personal y familiar; después producto abierto. Se usa sobre todo en el celular, a una mano. Existe además un rol admin que gestiona el sistema (usuarios, no finanzas) y no usa la app de finanzas.

## Product Purpose
Don Bigo da seguimiento a deudas a plazos, no a gastos diarios. Importa el CSV del portal del banco (Banorte), deja que el usuario cree los planes a mano y sugiere (nunca aplica solo) qué cargo es la siguiente mensualidad. Éxito: el usuario ve su "escalera" de compromisos mes a mes y la fecha de libertad de pagos, y confía en que los datos son suyos y corregibles.

## Positioning
Sigue deudas a plazos, no gastos: los planes (MSI, intereses, fijos) son el objeto central; los movimientos del banco solo son la fuente. Todo parámetro es editable a mano con historial, los pagos nunca se borran y nada se aplica sin confirmación del usuario.

## Operating Context
Flujo: descargar el CSV del portal del banco hasta el último corte → importar en /app/importar (deduplicado en servidor) → crear planes a mano en la primera carga → confirmar mensualidades sugeridas en cargas siguientes. Los gastos diarios también se guardan; gastos hormiga y categorías son un módulo secundario. Sin lectura de PDF: solo CSV.

## Capabilities and Constraints
- Stack existente: Astro 7 SSR + Cloudflare Workers, D1 + Drizzle, R2, Better Auth. Workspaces multiusuario, roles (viewer solo lectura), panel admin, módulos activables.
- Idioma por defecto es-MX; i18n (es-MX/es/en) y moneda por tarjeta desde el inicio. Nunca se mezclan monedas en un resumen.
- Cuentas, tarjetas y planes se archivan o liquidan, no se borran (una tarjeta sin historial sí se puede quitar); deshacer solo la última carga de cada cuenta.
- Registro público cerrado; el admin da de alta usuarios.
- **Terminología (vinculante, también en i18n):** *Usuario* = quien inicia sesión. *Cuenta* = lo que el banco identifica con un ID de cliente (opcional, informativo); agrupa todas sus tarjetas y es a lo que se importa el CSV. *Tarjeta* = un solo plástico, físico o digital, de crédito o débito, identificado por sus últimos 4 dígitos; una cuenta puede tener varias (débito, débito digital, TC, TC digital, varias TC). Límite, corte, día de pago y moneda viven en cada tarjeta. *Plan* = MSI, meses con intereses o pago fijo; se liga a una tarjeta. Los movimientos se ligan a la cuenta y, por sus últimos 4 dígitos, a una tarjeta. Nunca se llama "plástico" ni "cuenta" a lo que es una tarjeta.
- Pendiente: plantilla CSV para alta masiva, etiquetas libres, metas, presupuestos por categoría, invitar miembros, panel admin completo, despliegue final.

## Brand Commitments
Compromisos vinculantes indicados por el usuario:
- Nombre: Don Bigo (antes MiConta; dominio donbigo.com). Los recursos de infraestructura conservan el nombre `miconta`. Logo existente; el usuario lo adjuntará cuando se le pida (aún no está en el repo).
- Tipografía: Montserrat.
- Colores: principal #1D3557, alternativo #C5A047, blanco #FFFFFF.
- Voz: cercana, español de México, sin jerga bancaria.

## Evidence on Hand
CSV real del portal de Banorte (columnas Fecha, Concepto, Abono, Cargo, Tarjeta) usado para pruebas de humo en scripts/. No hay testimonios, clientes ni métricas; no fabricarlos. Logo pendiente de entregar.

## Product Principles
1. Claridad ante todo: la fecha de libertad de pagos y la carga del mes son lo primero que se ve.
2. El usuario manda: la app sugiere, nunca aplica sola; todo es editable con historial.
3. Los datos financieros no se pierden: archivar, liquidar y deshacer en lugar de borrar.
4. Calma, no culpa: tono cercano y tranquilo para quien se siente abrumado por deudas.
5. Primero el celular: toda tarea clave se completa a una mano.

## Accessibility & Inclusion
Uso móvil a una mano (objetivos táctiles cómodos, acciones principales al alcance del pulgar). Regionalizable: formatos de fecha, número y moneda según locale.
