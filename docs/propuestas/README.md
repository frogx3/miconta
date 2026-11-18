# Maquetas del rediseño

Propuestas visuales antes de programar. Empieza por `index.html`: muestra las ocho pantallas y las reglas del conjunto. Cada archivo es autocontenido y usa datos de ejemplo que cuadran entre pantallas.

Para ver las miniaturas del índice sírvelas por HTTP (con `file://` el navegador bloquea los iframes):

```
python3 -m http.server 4399 --directory docs/propuestas
```

- `landing.html` — página pública: beta que será premium, avisos, pagos y cobros, beneficios, invitación por correo y contacto.
- `login.html` — entrar y primer acceso con código (botones arriba para cambiar de estado).
- `portada-dashboard.html` — portada tipo dashboard: «¿Me alcanza?» + escalera de mensualidades.
- `cuentas.html` — lista de cuentas (calendario de cortes y pagos) y detalle de una cuenta (botones arriba para cambiar).
- `planes.html` — lista de planes (cuándo se libera tu dinero, planes por tarjeta) y detalle de un plan (calendario de pagos, saldo del banco, historial).
- `agenda.html` — agenda del mes: veredicto, curva del saldo día a día con días en negativo, calendario, lo que sigue, movimientos del saldo y avisos.
- `gastos.html` — gastos del corte por cuenta: reparto por categoría, día por día, presupuesto, hormiga, tendencia de 6 cortes y pestaña de movimientos para clasificar.
- `metas.html` — metas con la mascota de la alcancía: frasco de ahorro, escalera con fecha meta, tope de hormiga por mes, liquidar un plan con abono extra, logradas y nueva meta.
- `importar.html` — asistente en 4 pasos: archivo (cuenta, CSV y corte), columnas (solo la primera vez), revisar (mosaico del archivo, mensualidades, posibles planes, tarjeta nueva, errores) y listo.
- `cuenta.html` — Tu cuenta: tarjeta de miembro, estatus y totales, personas e invitaciones, avisos, respaldo y zona de peligro.

Se editan los `*.src.html` y `base.css` (tokens y encabezado comunes) y se regeneran con:

```
python3 docs/propuestas/build.py
```

Mascota y hoja de marca originales en `docs/brand/mascota/`.

Poses nuevas de la mascota (Gemini) en `docs/brand/mascota/donbigo-poses-gemini.jpg`, recortadas en `assets/mascota-{saluda,telefono,lista,sobre}.jpg`.
