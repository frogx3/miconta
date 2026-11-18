# Maquetas del rediseño

Propuestas visuales antes de programar. Se abren directo en el navegador (archivos autocontenidos, datos de ejemplo).

- `portada-dashboard.html` — portada tipo dashboard: «¿Me alcanza?» + escalera de mensualidades.
- `cuentas.html` — lista de cuentas (calendario de cortes y pagos) y detalle de una cuenta (botones arriba para cambiar).

Se editan los `*.src.html` y `base.css` (tokens y encabezado comunes) y se regeneran con:

```
python3 docs/propuestas/build.py
```

Mascota y hoja de marca originales en `docs/brand/mascota/`.
