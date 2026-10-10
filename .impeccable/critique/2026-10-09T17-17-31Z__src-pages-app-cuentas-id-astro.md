---
target: cuentas y tarjetas (móvil)
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/jorgealdana/Web/Personal/miconta/src/pages/app/cuentas/[id].astro"
target_fingerprint: "sha256:f8ecc63257a7b1f595bd63d1ec14a25c5718feb8a263c66f0836ccda813ba559"
target_path: /Users/jorgealdana/Web/Personal/miconta/src/pages/app/cuentas/[id].astro
timestamp: 2026-10-09T17-17-31Z
slug: src-pages-app-cuentas-id-astro
closed: true
---
Method: dual-agent (A: design review in the user's Chrome · B: detector + measurements). Target: cuentas (list, detail, new) on mobile. Score 23/40.
P1 Quitar junto a Guardar sin confirmación ni deshacer. P1 Checkbox "Es digital" 13px y duplica la etiqueta (Física/Digital). P1 El detalle de cuenta abre con el formulario de datos en vez de las tarjetas. P2 Lista y resumen de tarjeta sin día de pago visible/estable. P2 "Agregar tarjeta" no parece desplegable; falta estado vacío. P3 location.reload() tras cada cambio; formato de límite distinto al hint. Menores: badge Archivada en rojo, selects de 34px, borde, topbar en 2 filas.
