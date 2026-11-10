# Plan de actualización de Don Bigo

_Creado el 2026-11-10. Documento vivo: se ajusta conforme estudiemos cada opción._

Llevamos dos meses de pruebas personales afinando que los cálculos (planes, cortes, fechas de pago, escalera)
sean correctos. Este plan ordena lo que queremos agregar para pasar de "app personal" a "producto con planes de pago",
sin romper el principio central: **Don Bigo sugiere, el usuario confirma; nada se aplica solo.**

---

## 1. Resumen y orden propuesto

| Fase | Qué | Por qué en este orden | Depende de |
|---|---|---|---|
| 0 | Cimientos: catálogo de bancos, niveles de membresía (sin cobrar aún), comparador de estados de cuenta | Todo lo demás se apoya en esto | — |
| 1 | Lectura de PDF por banco (Banorte y Banamex primero) + pantalla de diferencias | Es lo que más facilita la vida hoy y no cuesta IA | 0 |
| 2 | API REST v1 (solo lectura) con llaves personales | Base común para MCP, integraciones y reportes | 0 |
| 3 | MCP solo lectura | Reutiliza la API; reportes con la IA del propio usuario | 2 |
| 4 | Membresías y cobro (PayPal) | Antes de abrir el registro y antes de dar funciones con costo (IA) | 0 |
| 5 | Premium con IA: PDF de cualquier banco, propuesta vía MCP, análisis | Tiene costo por uso: necesita cobro | 1, 3, 4 |
| 6 | Conectores de compras (OXXO, Amazon, Mercado Libre) vía facturas CFDI | Desglose por artículo; reutiliza la captura por correo | 0 |
| 7 | Integraciones: calendario, webhooks (IFTTT/Zapier/Make), Google Sheets/Drive | Valor extra; varias son baratas de hacer | 2 |

**Atajos baratos que se pueden meter en cualquier momento:** el calendario de la Agenda como enlace `.ics`
(Fase 7) y la conversión del campo "banco" a catálogo (Fase 0).

---

## 2. Niveles de membresía (propuesta)

| | **Estándar** (gratis) | **Profesional** | **Premium** |
|---|---|---|---|
| Cuentas, tarjetas, planes, escalera, agenda | Con límites (p. ej. 1 cuenta, 3 tarjetas) | Ilimitado | Ilimitado |
| Importar CSV y alta manual | Sí | Sí | Sí |
| Lectura de PDF de bancos del catálogo | Por definir | Sí | Sí |
| Avisos push, respaldos | Sí | Sí | Sí |
| API REST y MCP (solo lectura) | No | Sí | Sí |
| Conectores de compras (facturas CFDI) | No | Sí | Sí |
| IA de Don Bigo: PDF de **cualquier** banco, análisis y reportes en la app | No | No | Sí |
| MCP con herramienta "proponer estado de cuenta" | No | No | Sí |

Notas:
- Implementarlo como **permisos por espacio** (*entitlements*): cada función pregunta "¿este espacio tiene X?" y no
  "¿es Premium?". Así cambiar qué incluye cada nivel no requiere tocar código. Ya teníamos pendiente "módulos activables".
- Durante la beta todos los espacios quedan en **Profesional**; los primeros usuarios conservan un beneficio al
  arrancar el cobro (precio de fundador o meses gratis).
- La IA es el único costo variable: ~US$0.01 por estado de cuenta con Haiku 5.5, ~US$0.11 con Sonnet 5.5
  (estimado sin medir). Conviene un tope mensual de lecturas por espacio Premium.

---

## 3. Fases

### Fase 0 — Cimientos

**3.0.1 Catálogo de bancos.** Hoy `accounts.bank` es texto libre. Opinión: **sí, hay que cambiarlo a una lista**; sin
eso no sabemos qué lector de PDF usar ni podemos medir qué bancos tienen nuestros usuarios.
- Tabla `banks`: clave (`banorte`, `banamex`, `plata`…), nombre, país, logo, si tiene lector de PDF y su versión.
- `accounts.bank_id` con opción **"Otro"** que conserva un texto libre (y nos dice qué banco pedir después).
- Migración: mapear los textos actuales ("Banorte", "Mi Banorte"…) a su clave; lo que no cuadre queda en "Otro".
- En el alta de cuenta: buscador con logos, no un `<select>` interminable.

**3.0.2 Niveles y permisos.** Tabla de permisos por espacio, nivel actual y vigencia. Sin cobro todavía (Fase 4).

**3.0.3 Comparador de estados de cuenta.** El corazón de la Fase 1, la 5 y el MCP. Recibe un **estado de cuenta
extraído** (formato único, venga de donde venga) y lo compara contra lo que ya hay en Don Bigo:
- Formato: banco, cuenta, últimos 4 de cada tarjeta, periodo (inicio, corte, fecha límite), saldos (anterior, pago
  sin intereses, mínimo, saldo a meses), movimientos (fecha de operación, fecha de cargo, concepto, monto, tarjeta) y
  planes a meses (descripción, fecha de compra, pago N/M, mensualidad, saldo pendiente).
- Resultado: movimientos que **faltan** en Don Bigo, que **sobran**, que **difieren** (monto/fecha/tarjeta); planes
  con pago N/M o saldo distinto; corte o fecha límite distintos.
- Pantalla de diferencias: cada diferencia con su acción sugerida, marcada por el usuario y aplicada al pulsar
  "Aplicar" (igual que el importador CSV). Nada se aplica solo.
- Lo aprendido en las conciliaciones de octubre y noviembre entra aquí: el estado de cuenta es por **cuenta**
  (titular + adicionales), el banco asigna por **fecha de cargo**, el corte no es día fijo, intereses/IVA aparte.

### Fase 1 — Lectura de PDF por banco (sin IA)

Opinión sobre la "base de datos de PDF por banco": **sí, y además sin IA**. Con un PDF real de cada banco escribo un
lector específico (reglas fijas sobre el texto del PDF). Ventajas: costo cero, resultado exacto y repetible, y el
usuario solo elige el banco (o lo deducimos del catálogo de su cuenta).

- Extraer el texto del PDF en el Worker (librería tipo pdf.js para servidor; **por validar** CPU y tamaño en Workers).
  Alternativa: leerlo en el navegador, lo que además evita que el PDF salga del teléfono.
- Un lector por banco y por versión de formato (`banorte@2026-11`). Los bancos cambian el diseño: si el lector no
  reconoce el formato, **dice "no reconozco este estado de cuenta"**, nunca adivina.
- **Autocomprobación:** el PDF trae sus propios totales (cargos, abonos, pago sin intereses, saldo a meses). Si la
  suma de lo extraído no cuadra con esos totales, el lector se rechaza a sí mismo. Es la misma prueba que hicimos a
  mano en las conciliaciones.
- Pruebas con PDF reales **anonimizados** (sin nombre, dirección, RFC ni números completos) guardados como fixtures.
- Privacidad: el PDF trae nombre, domicilio y RFC. Propuesta: no guardar el PDF (o guardarlo en R2 con borrado a los
  N días) y quedarnos solo con los datos extraídos.
- Necesito: el PDF de noviembre de **Banorte** y de **Banamex** (después Plata y los que pidan los usuarios).
- Al terminar: actualizar `PRODUCT.md`, que hoy dice "Sin lectura de PDF: solo CSV".

### Fase 2 — API REST v1 (solo lectura)

- Rutas versionadas `/api/v1/...`: cuentas, tarjetas, planes (con calendario), movimientos (filtros por corte, tarjeta,
  categoría), cortes, agenda, resumen de compromisos.
- Llaves personales creadas en "Tu cuenta": se guardan con hash (ya hay `hashToken`), con permisos (lectura; más
  adelante "proponer"), fecha de último uso y botón para revocar.
- Límite de peticiones (ya existe el de D1), registro de uso y especificación OpenAPI publicada.
- La API reutiliza los mismos repositorios que las páginas: una sola fuente de verdad para los cálculos.

### Fase 3 — MCP solo lectura

- Servidor MCP remoto en el mismo Worker (`donbigo.com/mcp`), con herramientas que llaman a la API:
  `listar_cuentas`, `listar_planes`, `movimientos_del_corte`, `compromisos_por_mes`, `proximos_pagos`, `resumen_de_gastos`.
- Acceso con OAuth desde la cuenta de Don Bigo (es lo que piden los conectores de Claude y ChatGPT). **Por validar:**
  si Better Auth ya trae proveedor OAuth/MCP o si usamos el proveedor OAuth de Cloudflare para Workers.
- Guía para conectarlo en Claude y ChatGPT, con ejemplos de preguntas ("¿cuándo quedo libre de pagos?").

### Fase 4 — Membresías y cobro

- **PayPal Subscriptions** (planes mensual/anual en MXN) con webhooks que actualizan el nivel del espacio. El webhook
  se verifica con la firma de PayPal; nunca confiamos en el navegador para cambiar de nivel.
- Opinión: en México mucha gente paga con tarjeta de débito u OXXO y no tiene PayPal. Vale la pena comparar
  **Mercado Pago** (suscripciones) y **Stripe** (tarjeta y OXXO) antes de decidir; la integración se diseña para
  poder sumar otro procesador sin rehacer los niveles.
- Fiscal y legal (consultar con contador): emitir **CFDI** por cada cobro (vía un PAC), IVA, términos y condiciones,
  aviso de privacidad, cancelación y reembolsos.
- Qué pasa al bajar de nivel: los datos nunca se borran; solo se limitan las funciones (solo lectura de lo que exceda).

### Fase 5 — Premium con IA

- Lectura de PDF de **cualquier** banco (y en inglés) con la API de Claude cuando no haya lector en el catálogo. El
  resultado pasa por el mismo comparador y la misma autocomprobación de totales.
- Herramienta MCP `proponer_estado_de_cuenta`: el agente del usuario lee el PDF y deja una **propuesta** que se revisa en
  la pantalla de diferencias. Nunca escribe directo (protege contra instrucciones ocultas en PDF o correos).
- Análisis en la app: "¿qué plan conviene adelantar?", explicación del corte, alertas de gasto.
- Tope de lecturas por mes y registro del costo por espacio.

### Fase 6 — Conectores de compras (gastos por artículo)

Hallazgo importante: **OXXO, Amazon y Mercado Libre no ofrecen una API pública con tu historial de compras**
(Mercado Libre tiene API con OAuth; **por validar** si deja leer compras como comprador). Lo que sí tienen todos es la
**factura CFDI**, y el XML del SAT trae cada artículo con su descripción, cantidad, precio y una clave oficial de
producto o servicio (`ClaveProdServ`) que nos da el **tipo de artículo** sin adivinar.

- Conector "Facturas": el usuario reenvía sus facturas (XML) a su dirección `@in.donbigo.com`. Reutiliza la captura
  por correo que ya está hecha y apagada. También se pueden subir a mano.
- Cada factura se liga al cargo del banco por fecha, monto y comercio (sugerencia, el usuario confirma) y desglosa ese
  cargo en artículos con categoría.
- OXXO: el ticket se factura en su portal; para quien no factura, foto del ticket leída con IA (Premium).
- Mercado Libre: conector por su API si permite leer compras; si no, por facturas.
- Amazon: facturas, o el archivo de "Solicitar mis datos" (**por validar** formato y si incluye artículos).
- No pedir nunca usuario y contraseña de esas tiendas (riesgo y violación de sus términos).

### Fase 7 — Integraciones

- **Calendario:** enlace `.ics` privado con fechas de pago y cortes; Google Calendar, Apple y Outlook se suscriben sin
  OAuth. Es lo más barato de esta lista.
- **Webhooks salientes** ("se registró un cargo", "pago mañana", "plan liquidado"): con eso IFTTT, Zapier y Make se
  conectan sin que tengamos que publicar una app en cada uno.
- **Google Sheets / Drive:** exportar a una hoja o guardar respaldos en Drive (OAuth de Google; requiere verificación
  de la app por Google si pedimos permisos amplios).

---

## 4. Decisiones pendientes

1. Límites exactos del nivel Estándar y si incluye lectura de PDF del catálogo.
2. Precios de Profesional y Premium (mensual y anual) y beneficio para los primeros usuarios.
3. Procesador de pago: PayPal solo, o PayPal + Mercado Pago/Stripe.
4. Guardar o no el PDF original, y por cuánto tiempo.
5. Modelo de IA para Premium (Haiku 5.5 vs Sonnet 5.5), tras medir con PDF reales.
6. Cuándo abrir el registro público (hoy cerrado): lo natural es después de la Fase 4.

## 5. Riesgos

- **Formatos de PDF que cambian:** lectores versionados, fixtures y autocomprobación de totales.
- **Datos sensibles** (PDF, facturas con RFC, llaves de API, acceso de IA): permisos mínimos, revocables y registrados.
- **Escrituras desde agentes externos:** solo propuestas que el usuario confirma.
- **Obligaciones fiscales y legales** al cobrar: revisar con contador antes de la Fase 4.
- **Costo de IA:** tope por espacio y medición real antes de fijar precios.
