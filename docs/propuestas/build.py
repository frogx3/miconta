"""Genera las maquetas autocontenidas: python3 docs/propuestas/build.py  (cada X.src.html -> X.html)."""
import base64, pathlib, re
d = pathlib.Path(__file__).parent
b64 = lambda p, t: f'data:{t};base64,' + base64.b64encode((d / p).read_bytes()).decode()
base = (d / 'base.css').read_text()
# Como en la app: el tema efectivo queda en data-theme, también cuando viene del sistema.
THEME_JS = "<script>if(!document.documentElement.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.dataset.theme='dark'</script>"
for src in d.glob('*.src.html'):
    html = src.read_text().replace('{{BASE_CSS}}', base)
    html = html.replace('{{MASCOT}}', b64('assets/mascota-420.jpg', 'image/jpeg')).replace('{{MASCOT_PIGGY}}', b64('assets/mascota-alcancia.jpg', 'image/jpeg')).replace('{{LOGO}}', b64('assets/miconta-icon-white-120.png', 'image/png'))
    html = re.sub(r'\{\{IMG:([\w.-]+)\}\}', lambda m: b64('assets/' + m.group(1), 'image/jpeg' if m.group(1).endswith('.jpg') else 'image/png'), html)
    html = html.replace('</head>', THEME_JS + '</head>', 1)
    src.with_name(src.name.replace('.src', '')).write_text(html)
    print('ok', src.name)
