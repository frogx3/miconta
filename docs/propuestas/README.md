# Maquetas del rediseño

Propuestas visuales antes de programar. Se abren directo en el navegador (archivos autocontenidos, datos de ejemplo).

- `portada-dashboard.html` — portada tipo dashboard: «¿Me alcanza?» + escalera de mensualidades.
- `cuentas.html` — lista de cuentas (calendario de cortes y pagos) y detalle de una cuenta (botones arriba para cambiar).
- `planes.html` — lista de planes (cuándo se libera tu dinero, planes por tarjeta) y detalle de un plan (calendario de pagos, saldo del banco, historial).
- `agenda.html` — agenda del mes: veredicto, curva del saldo día a día con días en negativo, calendario, lo que sigue, movimientos del saldo y avisos.
- `gastos.html` — gastos del corte por cuenta: reparto por categoría, día por día, presupuesto, hormiga, tendencia de 6 cortes y pestaña de movimientos para clasificar.
- `metas.html` — metas con la mascota de la alcancía: frasco de ahorro, escalera con fecha meta, tope de hormiga por mes, liquidar un plan con abono extra, logradas y nueva meta.

Se editan los `*.src.html` y `base.css` (tokens y encabezado comunes) y se regeneran con:

```
python3 docs/propuestas/build.py
```

Mascota y hoja de marca originales en `docs/brand/mascota/`.
