---
target: login y registro
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/jorgealdana/Web/Personal/miconta/src/pages/login.astro"
target_fingerprint: "sha256:241b348c905d9095db8788f524aee76668b1af3f22a984db55d51e76033aba1d"
target_path: /Users/jorgealdana/Web/Personal/miconta/src/pages/login.astro
timestamp: 2026-10-09T15-01-25Z
slug: src-pages-login-astro
closed: true
---
Method: dual-agent (A: design review · B: detector + browser evidence). Target: login + registro. Score 23/40 (Acceptable).

Priority issues
- [P1] Sin salida tras un login fallido (no hay "¿Olvidaste tu contraseña?" ni ayuda). Fix: enlace bajo la contraseña + copy calmado. /impeccable clarify
- [P1] Contraseña sin mostrar/ocultar; faltan inputmode/autocapitalize/enterkeyhint en móvil. /impeccable harden
- [P1] Errores poco accesibles/recuperables: sin foco al error, sin aria-invalid/aria-describedby, novalidate sin validación propia, error solo por color. /impeccable harden
- [P2] Registro cerrado se muestra como alerta roja y es callejón sin salida; login ofrece "Crear cuenta" aunque el registro esté cerrado. /impeccable clarify
- [P2] Marca delgada: el wordmark "MiConta" no aparece en AuthLayout.astro:16 (solo icono, alt vacío), h1 genérico, sin frase de tono. /impeccable bolder|delight
- [P2] Borde de campos ~1.3:1 contra blanco (WCAG 1.4.11 pide 3:1). /impeccable polish
- [P3] Jerga SETUP_CODE/"desplegar" en registro del primer usuario. /impeccable clarify
