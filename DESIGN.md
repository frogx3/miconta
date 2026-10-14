---
name: Don Bigo
description: Seguimiento sereno de deudas a plazos; una escalera hacia la libertad de pagos.
colors:
  navy: "#1D3557"
  navy-deep: "#0E1A2C"
  gold: "#C5A047"
  white: "#FFFFFF"
  paper: "#F6F4EE"
  ink: "#14202F"
  muted: "#5B6575"
  line: "#E3DED2"
  field-line: "#857F6F"
  danger: "#B3261E"
  danger-bg: "#FDECEA"
  danger-ink: "#2A0D0B"
  night: "#0C1626"
  night-surface: "#132238"
  night-line: "#24354D"
  night-text: "#E8EDF4"
typography:
  display:
    fontFamily: "Montserrat, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Montserrat, system-ui, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 600
    lineHeight: 1.3
  stat:
    fontFamily: "Montserrat, system-ui, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 700
    lineHeight: 1.2
    fontFeature: "tnum"
  body:
    fontFamily: "Montserrat, system-ui, sans-serif"
    fontSize: "0.9rem"
    fontWeight: 500
    lineHeight: 1.5
  caption:
    fontFamily: "Montserrat, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.4
  subtitle:
    fontFamily: "Montserrat, system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 600
    lineHeight: 1.4
  input:
    fontFamily: "Montserrat, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.4
  stat-lg:
    fontFamily: "Montserrat, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
    fontFeature: "tnum"
  wordmark:
    fontFamily: "Montserrat, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  label:
    fontFamily: "Montserrat, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  pill: "999px"
spacing:
  xs: "0.4rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.25rem"
  xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.white}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0.65rem 1rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.4rem 0.8rem"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.white}"
    rounded: "{rounded.md}"
    padding: "0.65rem 1rem"
  card:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "1.25rem"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.6rem 0.75rem"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.1rem 0.55rem"
  badge-freed:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.navy-deep}"
    rounded: "{rounded.pill}"
    padding: "0.1rem 0.5rem"
---

# Design System: Don Bigo

<!-- La marca ya está aplicada en src/styles/global.css (tokens navy/dorado, Montserrat variable autoalojada vía @fontsource-variable/montserrat). El icono del schnauzer ES el logo: public/brand/miconta-icon.png (navy, fondos claros) y miconta-icon-white.png (blanco, fondos oscuros; se elige con <picture> y prefers-color-scheme). El wordmark "Don Bigo" es texto vivo en Montserrat, con "Bigo" en dorado: es la única excepción a la regla de no usar dorado como texto, porque así es la marca. -->

## Overview

**Creative North Star: "La escalera hacia la libertad"**

Don Bigo existe para quien se siente ahogado por deudas a plazos, así que el sistema visual trabaja como una escalera: cada pago es un peldaño y el progreso se lee de un vistazo. Lo importante (la carga del mes y la fecha de libertad de pagos) es lo primero que se ve; todo lo demás se subordina. La voz visual es serena y de confianza, no bancaria ni culpabilizadora: cifras claras sobre fondo claro, navy como tinta, dorado como marca de lo que ya se liberó.

Es una interfaz de trabajo (Operate): densidad media, tablas y listas legibles, una sola columna principal de hasta 60rem. Se usa sobre todo en el celular a una mano, así que las acciones principales viven al alcance del pulgar y los objetivos táctiles son holgados. La profundidad es plana: líneas finas de 1px, sin sombras.

**Key Characteristics:**
- Plano con líneas finas; sin sombras ni degradados.
- Navy como tinta y acción; dorado escaso, solo para progreso y "liberado".
- Montserrat en todo, cifras con numerales tabulares.
- Claro por defecto; oscuro profundo (navy noche) cuando el sistema lo pide.
- Acciones y objetivos táctiles pensados para una mano.

## Colors

Paleta de marca de tres colores (navy, dorado, blanco) sobre un papel cálido que sostiene las cifras. **El navy enmarca** (encabezado, pie de página y la pantalla de acceso en tema claro), **el dorado marca el logro** (fecha de libertad, progreso, botón de menú y acción flotante) y el blanco de las tarjetas contrasta con el papel.

### Primary
- **Azul Tinta** (#1D3557): acción principal, enlaces, texto de énfasis, barra de progreso base y estado activo de navegación.

### Secondary
- **Dorado Peldaño** (#C5A047): marca del progreso y de lo liberado (relleno de barras de avance, insignia "liberado", punto de la línea de tiempo). Nunca para texto sobre blanco: no alcanza contraste; si lleva texto, este va en Azul Noche.

### Neutral
- **Blanco** (#FFFFFF): superficie de tarjetas y texto sobre navy.
- **Papel Cálido** (#F6F4EE, derivado): fondo de página y de campos.
- **Tinta** (#14202F, derivado): texto principal.
- **Gris Pizarra** (#5B6575, derivado): texto secundario y encabezados de tabla.
- **Línea Fina** (#E3DED2, derivado): bordes y divisores de 1px.
- **Azul Noche** (#0E1A2C, derivado): texto sobre dorado y base del modo oscuro.
- **Peligro** (#B3261E) sobre **Fondo Peligro** (#FDECEA): errores y acciones destructivas (existentes en el código).

Tema elegible por la persona: Claro, Oscuro o Auto (sigue al sistema; es la opción por defecto). Se cambia con el ícono de sol/luna del encabezado (o de la esquina de las pantallas de acceso) y con el selector de tres opciones del menú; se recuerda en el navegador. Los tokens oscuros viven bajo `:root[data-theme='dark']` y, en Auto, bajo la preferencia del sistema; el icono blanco de la marca se alterna por CSS. Modo oscuro: fondo #0C1626, superficie #132238, línea #24354D, texto #E8EDF4; el dorado asume el papel de acento activo y el navy deja de usarse como relleno.

### Named Rules
**The Frame-Not-Fill Rule.** El navy vive en las bandas que enmarcan la pantalla (encabezado y pie) y en la acción principal; el contenido va sobre papel y blanco. Cada tema se compone aparte: en oscuro las bandas son superficie, no navy.
**The Gold Is a Step Rule.** El dorado marca avance conseguido (pagos hechos, "liberado"). Si aparece en más del 10% de una pantalla o decora algo sin progreso, sobra.
**The Ink-Not-Gold Text Rule.** Ningún texto va en dorado sobre blanco; el dorado es relleno o borde, el texto es navy o tinta.

## Typography

**Display Font:** Montserrat (con system-ui, sans-serif)
**Body Font:** Montserrat (misma familia; jerarquía por peso y tamaño)

**Character:** una sola familia geométrica y firme; la jerarquía sale del peso (500/600/700) y no de mezclar tipografías. Las cifras siempre con numerales tabulares para que las columnas de dinero alineen.

### Hierarchy
- **Display** (700, 1.5rem, 1.2): título de página.
- **Headline** (600, 1.05rem, 1.3): título de tarjeta o bloque.
- **Stat** (700, 1.35rem, 1.2, tabulares): cifras clave (mensualidad del mes, total pendiente).
- **Body** (500, 0.9rem, 1.5): tablas, listas y texto corrido; líneas de 65–75ch.
- **Label** (600, 0.8125rem): etiquetas de campo, chips, insignias.

### Named Rules
**The Tabular Money Rule.** Toda cantidad de dinero o fecha en columnas usa numerales tabulares; nunca proporcionales.

## Layout

Contenido de hasta 1400px de ancho (87.5rem) con margen lateral fluido (1rem a 2rem); encabezado y pie del mismo ancho; los formularios de una sola tarea se limitan a 40rem. Cuadrículas auto-ajustables (`auto-fit/auto-fill`, mínimos de 10–17rem) para estadísticas, tarjetas y formularios; tablas con desplazamiento horizontal en pantallas estrechas. Ritmo de 0.4 / 0.75 / 1 / 1.25 / 2rem. En móvil, las filas de barras colapsan a dos columnas y la barra ocupa su propia línea. Objetivos táctiles de al menos 44px en acciones principales.

## Elevation & Depth

Plano por defecto: la jerarquía viene de bordes de 1px (Línea Fina), contraste de superficie (blanco sobre Papel Cálido) y espacio, no de sombras. Los estados se muestran cambiando borde o color (p. ej. borde navy al pasar sobre una tarjeta), nunca elevando.

### Named Rules
**The Flat-By-Default Rule.** No hay sombras. Si algo necesita separarse, usa borde, superficie o espacio.

## Shapes

Esquinas suaves y consistentes: 10px en tarjetas, 8px en botones, campos y paneles, 6px en código en línea; píldoras completas (999px) para chips, insignias y barras de progreso. Bordes siempre de 1px; el progreso se dibuja como barra redondeada, y la línea de tiempo como una columna con puntos circulares.

## Components

### Buttons
- **Shape:** esquinas de 8px.
- **Primary:** relleno Azul Tinta, texto blanco, 0.65rem × 1rem, peso 600. En modo oscuro el relleno es Dorado Peldaño con texto Azul Noche (excepción aceptada por el usuario a la regla del dorado). Hover mezcla 14% con la tinta; `:active` baja 1px; cargando muestra un spinner y `aria-busy`.
- **Hover / Focus:** foco visible con contorno de 2px navy a 2px de distancia (dorado en modo oscuro); estado deshabilitado a 60% de opacidad.
- **Ghost:** transparente con borde Línea Fina, texto tinta, más compacto.
- **Danger:** relleno Peligro, texto blanco (texto oscuro en modo oscuro).

### Chips and Badges
- **Chip:** píldora con borde Línea Fina, cifras tabulares; variantes "ok" (borde navy) y "mal" (borde peligro); chip-botón activo relleno navy.
- **Badge:** píldora de relleno translúcido; "liberado" en Dorado Peldaño con texto Azul Noche; "por registrar" en ámbar de advertencia; "apagado" en peligro.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** blanco sobre Papel Cálido.
- **Shadow Strategy:** ninguna; borde 1px.
- **Internal Padding:** 1.25rem.

### Inputs / Fields
- **Style:** fondo Papel Cálido, borde 1px Línea de Campo (#857F6F en claro, #5F7694 en oscuro; 3:1 contra la superficie), 8px de radio, 0.6rem × 0.75rem. Contraseñas con botón Mostrar/Ocultar de 44px dentro del campo.
- **Focus:** contorno de 2px navy.
- **Error:** borde Peligro y mensaje de 0.8125rem debajo, ligado con `aria-describedby`/`aria-invalid`; el aviso general antepone "Error:" en negrita y recibe el foco. El campo inválido nunca depende solo del color.

### Navigation
Encabezado fijo con marca a la izquierda y, a la derecha, acciones de solo ícono (Importar, Cerrar sesión) más el botón de menú. El menú es siempre hamburguesa y abre un panel lateral (`<dialog>`) con los destinos y un ícono por cada uno; la página actual lleva el ícono relleno en Dorado Peldaño. Íconos de trazo propios (24px, trazo 1.75, una sola familia en `src/lib/icons.ts`). El pie de página repite la navegación y lleva el aviso legal (Don Bigo no es un banco ni sustituye los estados de cuenta). En móvil, la acción principal de una lista (Nueva cuenta) se ofrece como botón flotante al alcance del pulgar. Cada pantalla de detalle abre con una miga de pan (`Cuentas › Mi Banorte`), y el primer elemento enfocable de la página es "Saltar al contenido". Las entidades se enlazan entre sí: una cuenta ofrece enlaces a sus planes, movimientos, gastos e importación (solo si hay datos), y las vistas filtradas por cuenta o tarjeta muestran una pastilla "Mostrando: …" con una X de 44px para quitar el filtro.

### Escalera de compromisos (signature)
Lista mes a mes de lo que se debe pagar, con la fecha de libertad de pagos al final. Cada mes es un peldaño: cuando un plan se libera, su peldaño se marca en dorado. Las barras de avance son píldoras de Línea Fina con relleno dorado; en tarjetas de plan, base navy con relleno dorado de lo pagado.

## Do's and Don'ts

### Do:
- **Do** poner la carga del mes y la fecha de libertad de pagos arriba de cada vista de planes.
- **Do** usar numerales tabulares para dinero y fechas.
- **Do** mostrar cada moneda por separado; nunca mezclarlas en un total.
- **Do** escribir en español de México, tuteando y sin jerga bancaria.
- **Do** mantener todo flujo clave usable a una mano en 375px de ancho.

### Don't:
- **Don't** usar dorado como color de texto sobre blanco.
- **Don't** añadir sombras, degradados ni efectos de vidrio.
- **Don't** usar rojo como tono general de la deuda; el rojo es solo para errores y acciones destructivas, para no culpar.
- **Don't** introducir una segunda tipografía; la jerarquía sale del peso.
- **Don't** usar estados que dependan solo del color: acompañar con texto o ícono.
