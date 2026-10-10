#!/usr/bin/env python3
"""
Prueba de humo de gastos hormiga y categorías (API y pantallas). Los totales esperados se calculan
aparte, directamente del CSV, sin usar el código que se prueba.

Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
  rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
y el CSV de ejemplo en tests/fixtures/movements-sample.csv (está ignorado por git).
Crea usuarios y datos de prueba; vuelve a vaciar la base local al terminar.
"""
import csv
import http.cookiejar
import io
import json
import os
import re
import secrets
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = "http://localhost:4321"
CSV_TEXT = open(os.path.join(ROOT, "tests/fixtures/movements-sample.csv"), encoding="utf-8-sig").read()
PW = "Aa1-" + secrets.token_hex(10)
FAILED = False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    def __init__(self):
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)

    def call(self, method, path, body=None, origin=BASE, raw=False):
        data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        request = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request) as response:
                payload, status, location = response.read(), response.status, None
        except urllib.error.HTTPError as error:
            payload, status, location = error.read(), error.code, error.headers.get("Location")
        if raw:
            return status, payload.decode(errors="replace"), location
        try:
            return status, json.loads(payload)
        except ValueError:
            return status, {"raw": payload.decode(errors="replace")[:200]}


def check(description, expected, actual):
    global FAILED
    ok = expected == actual
    FAILED = FAILED or not ok
    print(f"  {'✓' if ok else '✗'} {description:<76} {actual}" + ("" if ok else f"   (esperado {expected})"))


def d1(sql):
    out = subprocess.run(["pnpm", "exec", "wrangler", "d1", "execute", "miconta", "--local", "--json", "--command", sql], cwd=ROOT, capture_output=True, text=True).stdout
    return json.loads(out)[0]["results"]


def scalar(sql):
    rows = d1(sql)
    return list(rows[0].values())[0] if rows else None


# ── Oráculo: lo que el CSV dice, calculado sin el código de la aplicación ────────────────────────
def norm(text):
    return re.sub(r"\s+", " ", "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))).upper().strip()


ROWS = []
for rec in csv.DictReader(io.StringIO(CSV_TEXT)):
    d, m, y = rec["Fecha"].split("/")
    concept = re.sub(r"\s*Referencia\s+\S+", "", rec["Concepto"])
    ROWS.append({"month": f"{y}-{m}", "desc": norm(concept), "charge": round(float(rec["Cargo"]) * 100), "credit": round(float(rec["Abono"]) * 100)})
CHARGES = [r for r in ROWS if r["charge"] > 0]
COPIES = 2  # el mismo CSV se importa en dos tarjetas (card1 y card2)


def money(minor):
    return f"${minor / 100:,.2f}"


def month_total(month, threshold=20000):
    spend = sum(r["charge"] for r in CHARGES if r["month"] == month)
    ant = sum(r["charge"] for r in CHARGES if r["month"] == month and r["charge"] <= threshold)
    ant_n = sum(1 for r in CHARGES if r["month"] == month and r["charge"] <= threshold)
    return spend, ant, ant_n


# ── Preparación ──────────────────────────────────────────────────────────────────────────────────
admin, a, b, c, anon = Client(), Client(), Client(), Client(), Client()
print("0) Preparación: admin y usuarios (A dueño, B ajeno, C solo lectura en el espacio de A)")
admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})
ids = {}
for name, email in (("Usuario A", "a@miconta.test"), ("Usuario B", "b@miconta.test"), ("Usuario C", "c@miconta.test")):
    _, body = admin.call("POST", "/api/auth/admin/create-user", {"name": name, "email": email, "password": PW, "role": "user", "data": {"locale": "es-MX"}})
    ids[email] = body["user"]["id"]
for client, email in ((a, "a@miconta.test"), (b, "b@miconta.test"), (c, "c@miconta.test")):
    check(f"sign-in {email}", 200, client.call("POST", "/api/auth/sign-in/email", {"email": email, "password": PW})[0])
    time.sleep(4)
ws_a = scalar("SELECT id FROM workspaces WHERE name='Usuario A'")
ws_b = scalar("SELECT id FROM workspaces WHERE name='Usuario B'")
d1(f"DELETE FROM workspace_members WHERE user_id='{ids['c@miconta.test']}'")
d1(f"INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('{ws_a}', '{ids['c@miconta.test']}', 'viewer')")


def make_card(name):
    """Crea una cuenta con una tarjeta de crédito (4172); devuelve el id de la cuenta."""
    account = a.call("POST", "/api/accounts", {"name": name, "bank": "Banorte"})[1]["id"]
    a.call("POST", f"/api/accounts/{account}/cards", {"kind": "credit", "isDigital": False, "last4": "4172", "currency": "MXN", "cutoffDay": "15"})
    return account


def import_csv(card):
    profile = a.call("POST", "/api/import/preview", {"accountId": card, "text": CSV_TEXT})[1]["preview"]["profile"]
    return a.call("POST", "/api/import/apply", {"accountId": card, "text": CSV_TEXT, "fileName": "x.csv", "profile": profile, "cutoffDate": "2026-09-15"})


card1 = make_card("Banorte Oro")
status, body = import_csv(card1)
check("importación inicial sin reglas", (201, 105, 0), (status, body["counts"]["movements"], body["counts"]["categorized"]))

print("1) Resumen del mes (sin categorías todavía), contra el CSV")
latest = max(r["month"] for r in ROWS)
html = a.call("GET", "/app/gastos", raw=True)[1]
spend, ant, ant_n = month_total(latest)
check(f"por defecto abre el último mes con datos ({latest})", True, "oct 2026" in html)
check(f"gasto del mes {latest}", True, money(spend) in html)
check(f"gasto hormiga del mes {latest} (cargos ≤ 200.00)", True, money(ant) in html)
check("equivalente anual a ese ritmo", True, money(ant * 12) in html)
html = a.call("GET", "/app/gastos?mes=2026-09", raw=True)[1]
spend, ant, ant_n = month_total("2026-09")
check("gasto de septiembre", True, money(spend) in html)
check("gasto hormiga de septiembre", True, money(ant) in html)
check("todo sin categoría: aparece el aviso", True, "Sin categoría" in html)
check("comercios hormiga agrupados: OXXO aparece", True, ">OXXO<" in html)
check("mes inventado cae en el último con datos", True, "oct 2026" in a.call("GET", "/app/gastos?mes=basura", raw=True)[1])
check("tendencia de 6 meses", True, "Últimos 6 meses" in html)

print("2) Categorías")
status, body = a.call("POST", "/api/categories", {"name": "Despensa", "color": "#2563eb"})
check("crear categoría", 201, status)
despensa = body["id"]
check("nombre duplicado (sin distinguir mayúsculas/acentos)", 409, a.call("POST", "/api/categories", {"name": "despensa"})[0])
check("color fuera de la paleta", 400, a.call("POST", "/api/categories", {"name": "Otra", "color": "#123456"})[0])
check("nombre vacío", 400, a.call("POST", "/api/categories", {"name": "  "})[0])
restaurantes = a.call("POST", "/api/categories", {"name": "Restaurantes", "color": "#d97706"})[1]["id"]
check("renombrar", 200, a.call("PATCH", f"/api/categories/{restaurantes}", {"name": "Restaurantes y café", "color": "#d97706"})[0])
check("renombrar a un nombre que ya existe", 409, a.call("PATCH", f"/api/categories/{restaurantes}", {"name": "Despensa"})[0])
check("B no puede editar la categoría de A", 404, b.call("PATCH", f"/api/categories/{despensa}", {"name": "Robada"})[0])
check("C (solo lectura) no puede crear", 403, c.call("POST", "/api/categories", {"name": "X"})[0])
check("sin sesión", 401, anon.call("POST", "/api/categories", {"name": "X"})[0])
check("origen ajeno", 403, a.call("POST", "/api/categories", {"name": "X"}, origin="http://evil.test")[0])
check("la categoría de A sigue intacta", "Despensa", scalar(f"SELECT name FROM categories WHERE id='{despensa}'"))

print("3) Categorías sugeridas (en el idioma del usuario)")
status, body = a.call("POST", "/api/categories/defaults", {})
check("crea las que faltan: 9 − 1 que ya existe (Despensa) = 8", (201, 8), (status, body["created"]))
check("segunda vez no duplica", 0, a.call("POST", "/api/categories/defaults", {})[1]["created"])
check("quedaron 10 categorías", 10, scalar(f"SELECT count(*) FROM categories WHERE workspace_id='{ws_a}'"))
transporte = scalar(f"SELECT id FROM categories WHERE workspace_id='{ws_a}' AND name='Transporte y gasolina'")
salud = scalar(f"SELECT id FROM categories WHERE workspace_id='{ws_a}' AND name='Salud'")
check("B recibe las suyas, aparte", True, b.call("POST", "/api/categories/defaults", {})[1]["created"] == 9 and scalar(f"SELECT count(*) FROM categories WHERE workspace_id='{ws_b}'") == 9)

print("4) Reglas (solo texto contenido; gana el más largo)")
oxxo_rows = [r for r in CHARGES if "OXXO" in r["desc"]]
status, body = a.call("POST", "/api/category-rules", {"pattern": " oxxo ", "categoryId": despensa, "applyNow": True})
check("crear regla OXXO y aplicarla a lo ya importado", (201, len(oxxo_rows)), (status, body["applied"]))
rule_oxxo = body["id"]
check("el patrón se guardó normalizado", "OXXO", scalar(f"SELECT pattern FROM category_rules WHERE id='{rule_oxxo}'"))
check("los cargos OXXO quedaron en Despensa", len(oxxo_rows), scalar(f"SELECT count(*) FROM movements WHERE category_id='{despensa}'"))
check("regla duplicada", 409, a.call("POST", "/api/category-rules", {"pattern": "OXXO", "categoryId": despensa})[0])
check("patrón demasiado corto", 400, a.call("POST", "/api/category-rules", {"pattern": "a", "categoryId": despensa})[0])
check("categoría inexistente", 404, a.call("POST", "/api/category-rules", {"pattern": "ZZZ", "categoryId": "no-existe"})[0])
check("B no puede usar la categoría de A", 404, b.call("POST", "/api/category-rules", {"pattern": "ZZZ", "categoryId": despensa})[0])
check("C (solo lectura) no puede crear reglas", 403, c.call("POST", "/api/category-rules", {"pattern": "ZZZ", "categoryId": despensa})[0])
check("un patrón con símbolos de regex es solo texto (no rompe)", 201, a.call("POST", "/api/category-rules", {"pattern": "(a+)+$", "categoryId": despensa})[0])
a.call("DELETE", f"/api/category-rules/{scalar(f'SELECT id FROM category_rules WHERE pattern=' + chr(39) + '(A+)+$' + chr(39))}")
a.call("POST", "/api/category-rules", {"pattern": "OXXOAMERICAS", "categoryId": restaurantes})

print("5) Las reglas se aplican al importar (el patrón más largo gana)")
card2 = make_card("Banorte Platinum")
status, body = import_csv(card2)
americas = [r for r in CHARGES if "OXXOAMERICAS" in r["desc"]]
check("importación con reglas: categoriza solo cargos con coincidencia", (201, len(oxxo_rows)), (status, body["counts"]["categorized"]))
check("OXXOAMERICAS → Restaurantes (regla más larga)", len(americas), scalar(f"SELECT count(*) FROM movements WHERE account_id='{card2}' AND category_id='{restaurantes}'"))
check("los demás OXXO → Despensa", len(oxxo_rows) - len(americas), scalar(f"SELECT count(*) FROM movements WHERE account_id='{card2}' AND category_id='{despensa}'"))
check("lo que no coincide queda sin categoría", len(CHARGES) - len(oxxo_rows), scalar(f"SELECT count(*) FROM movements WHERE account_id='{card2}' AND category_id IS NULL AND charge_minor > 0"))
check("los abonos nunca se categorizan", 0, scalar("SELECT count(*) FROM movements WHERE credit_minor > 0 AND category_id IS NOT NULL"))

print("6) Aplicar reglas a lo que sigue sin categoría")
gas_rows = [r for r in CHARGES if "GAS" in r["desc"] and "OXXO" not in r["desc"]]
status, body = a.call("POST", "/api/category-rules", {"pattern": "GAS", "categoryId": transporte})
rule_gas = body["id"]
status, body = a.call("POST", "/api/category-rules/apply", {})
check("aplica a las dos tarjetas (cada una trae su copia del CSV)", (200, 2 * len(gas_rows)), (status, body["applied"]))
check("aplicar otra vez no cambia nada", 0, a.call("POST", "/api/category-rules/apply", {})[1]["applied"])
check("quitar una regla no toca lo ya categorizado", (200, 2 * len(gas_rows)), (a.call("DELETE", f"/api/category-rules/{rule_gas}")[0], scalar(f"SELECT count(*) FROM movements WHERE category_id='{transporte}'")))
check("B no puede borrar reglas de A", 404, b.call("DELETE", f"/api/category-rules/{rule_oxxo}")[0])
check("C (solo lectura) no puede borrar reglas", 403, c.call("DELETE", f"/api/category-rules/{rule_oxxo}")[0])

print("7) Asignación manual y masiva")
pick = [r["id"] for r in d1(f"SELECT id FROM movements WHERE account_id='{card1}' AND category_id IS NULL AND charge_minor > 0 LIMIT 3")]
status, body = a.call("PATCH", "/api/movements", {"ids": pick[:2], "categoryId": salud})
check("asignar a dos movimientos", (200, 2), (status, body.get("updated")))
check("quedaron en Salud", 2, scalar(f"SELECT count(*) FROM movements WHERE category_id='{salud}'"))
check("B no puede tocar movimientos de A (no actualiza nada)", (200, 0), (lambda r: (r[0], r[1].get("updated")))(b.call("PATCH", "/api/movements", {"ids": pick[:2], "categoryId": None})))
check("…y siguen en Salud", 2, scalar(f"SELECT count(*) FROM movements WHERE category_id='{salud}'"))
check("categoría de otro espacio", 404, a.call("PATCH", "/api/movements", {"ids": pick, "categoryId": scalar(f"SELECT id FROM categories WHERE workspace_id='{ws_b}' LIMIT 1")})[0])
check("ids inválidos", 400, a.call("PATCH", "/api/movements", {"ids": [], "categoryId": salud})[0])
check("demasiados ids", 400, a.call("PATCH", "/api/movements", {"ids": [f"id{i}" for i in range(201)], "categoryId": salud})[0])
check("C (solo lectura) no puede asignar", 403, c.call("PATCH", "/api/movements", {"ids": pick, "categoryId": salud})[0])
check("quitar la categoría de uno", (200, 1), (lambda r: (r[0], scalar(f"SELECT count(*) FROM movements WHERE category_id='{salud}'")))(a.call("PATCH", "/api/movements", {"ids": pick[:1], "categoryId": None})))

print("8) Pantallas: movimientos y categorías")
count = lambda html: re.search(r"(\d+) movimientos", html).group(0)
html = a.call("GET", "/app/gastos/movimientos?mes=2026-09&q=oxxo", raw=True)[1]
sept_oxxo = sum(1 for r in CHARGES if r["month"] == "2026-09" and "OXXO" in r["desc"])
check("la búsqueda 'oxxo' en septiembre cuenta lo mismo que el CSV (×2 tarjetas)", f"{COPIES * sept_oxxo} movimientos", count(html))
html = a.call("GET", "/app/gastos/movimientos?mes=2026-09&tipo=hormiga", raw=True)[1]
check("el filtro 'solo hormiga' de septiembre (×2 tarjetas)", f"{COPIES * month_total('2026-09')[2]} movimientos", count(html))
html = a.call("GET", f"/app/gastos/movimientos?mes=2026-09&categoria={despensa}", raw=True)[1]
card1_despensa = sum(1 for r in CHARGES if r["month"] == "2026-09" and "OXXO" in r["desc"])
card2_despensa = sum(1 for r in CHARGES if r["month"] == "2026-09" and "OXXO" in r["desc"] and "OXXOAMERICAS" not in r["desc"])
check("el filtro por categoría (tarjeta 1: todos los OXXO; tarjeta 2: sin OXXOAMERICAS)", f"{card1_despensa + card2_despensa} movimientos", count(html))
check("la lista permite asignar categoría", True, 'class="row-category"' in html)
num = lambda html: int(re.search(r"(\d+) movimientos", html).group(1))
html_all = a.call("GET", "/app/gastos/movimientos?mes=2026-09&tipo=gastos", raw=True)[1]
html_acc = a.call("GET", f"/app/gastos/movimientos?mes=2026-09&filtro=a:{card1}&tipo=gastos", raw=True)[1]
check("el filtro por cuenta (a:<id>) muestra la mitad de los movimientos (una copia del CSV)", (True, True), (num(html_all) == 2 * num(html_acc), num(html_acc) > 0))
card_ids = [r["id"] for r in d1(f"SELECT id FROM cards WHERE account_id='{card1}'")]
per_card = [num(a.call("GET", f"/app/gastos/movimientos?mes=2026-09&filtro=c:{cid}&tipo=gastos", raw=True)[1]) for cid in card_ids]
check("las tarjetas de la cuenta (4172 y la 2455 creada por el CSV) reparten los movimientos de la cuenta", (2, num(html_acc)), (len(card_ids), sum(per_card)))
check("un filtro con la cuenta de A no muestra nada a B", False, 'class="row-category"' in b.call("GET", f"/app/gastos/movimientos?mes=2026-09&filtro=a:{card1}", raw=True)[1])
html = a.call("GET", "/app/gastos/categorias", raw=True)[1]
check("categorías visibles", True, "Despensa" in html)
check("la regla OXXO → Despensa se lista", True, bool(re.search(r"<code[^>]*>OXXO</code>", html)))
check("la regla más larga también", True, bool(re.search(r"<code[^>]*>OXXOAMERICAS</code>", html)))
check("comercios sin categoría agrupados, con botón para crear la regla", (True, True), ("Sin categoría, por comercio" in html, "data-rule-for" in html))
check("quien escribe (A) ve los formularios de alta", (True, True), ('id="category-add"' in html, 'id="rule-add"' in html))
html = a.call("GET", f"/app/gastos/categorias?patron=OXXO&categoria={despensa}", raw=True)[1]
check("el enlace de regla sugerida precarga patrón y categoría", True, bool(re.search(r"initialPattern(&#34;|&quot;|\")\s*:\s*(&#34;|&quot;|\")OXXO", html)) and despensa in html)
html = c.call("GET", "/app/gastos/categorias", raw=True)[1]
check("C (solo lectura) ve las categorías…", True, "Despensa" in html)
check("…pero no los formularios de edición", (False, False), ('id="category-add"' in html, 'id="rule-add"' in html))
html = a.call("GET", "/app/gastos/movimientos?mes=2026-09", raw=True)[1]
check("quien escribe (A) ve casillas y selector de categoría", (True, True), ('class="pick"' in html, 'class="row-category"' in html))
html = c.call("GET", "/app/gastos/movimientos?mes=2026-09", raw=True)[1]
check("C (solo lectura) ve movimientos pero sin casillas ni selector", (True, False, False), ("movimientos" in html, 'class="pick"' in html, 'class="row-category"' in html))
check("B no ve datos de A", True, "Aún no hay movimientos" in b.call("GET", "/app/gastos", raw=True)[1])
status, _, loc = admin.call("GET", "/app/gastos", raw=True)
check("el admin no usa la app", (302, "/admin"), (status, loc))
status, _, loc = anon.call("GET", "/app/gastos", raw=True)
check("sin sesión: a /login", (302, "/login"), (status, loc))

print("9) Umbral de gasto hormiga")
check("C (solo lectura) no puede cambiarlo", 403, c.call("PATCH", "/api/workspace", {"antThreshold": "100"})[0])
check("umbral 0 inválido", 400, a.call("PATCH", "/api/workspace", {"antThreshold": "0"})[0])
check("umbral ilegible", 400, a.call("PATCH", "/api/workspace", {"antThreshold": "mucho"})[0])
check("sin umbral", 400, a.call("PATCH", "/api/workspace", {})[0])
check("el dueño lo cambia a 150.50", (200, 15050), (lambda r: (r[0], r[1].get("antThresholdMinor")))(a.call("PATCH", "/api/workspace", {"antThreshold": "150.50"})))
check("guardado en centavos", 15050, scalar(f"SELECT ant_threshold_minor FROM workspaces WHERE id='{ws_a}'"))
html = a.call("GET", "/app/gastos?mes=2026-09", raw=True)[1]
spend, ant, ant_n = month_total("2026-09", 15050)
check("el resumen usa el nuevo umbral (hormiga de septiembre con 150.50, ×2 tarjetas)", True, money(COPIES * ant) in html)
check("…el umbral anterior ya no aparece como hormiga", False, money(COPIES * month_total("2026-09")[1]) in html)
check("…y el gasto total no cambia (×2 tarjetas)", True, money(COPIES * month_total("2026-09")[0]) in html)
check("el espacio de B no se tocó (nulo = valor por defecto)", None, scalar(f"SELECT ant_threshold_minor FROM workspaces WHERE id='{ws_b}'"))
check("el dueño de otro espacio puede cambiar el suyo", 200, b.call("PATCH", "/api/workspace", {"antThreshold": "300"})[0])
check("…y cada espacio conserva el suyo", (15050, 30000), (scalar(f"SELECT ant_threshold_minor FROM workspaces WHERE id='{ws_a}'"), scalar(f"SELECT ant_threshold_minor FROM workspaces WHERE id='{ws_b}'")))

print("10) Eliminar una categoría deja sus movimientos sin categoría")
before = scalar(f"SELECT count(*) FROM movements WHERE category_id='{despensa}'")
check("hay movimientos en Despensa", True, before > 0)
check("B no puede eliminar la categoría de A", 404, b.call("DELETE", f"/api/categories/{despensa}")[0])
check("C (solo lectura) no puede eliminarla", 403, c.call("DELETE", f"/api/categories/{despensa}")[0])
check("eliminar Despensa", 200, a.call("DELETE", f"/api/categories/{despensa}")[0])
check("la categoría y su regla ya no existen", (0, 0), (scalar(f"SELECT count(*) FROM categories WHERE id='{despensa}'"), scalar(f"SELECT count(*) FROM category_rules WHERE category_id='{despensa}'")))
check("sus movimientos siguen ahí, sin categoría", (0, True), (scalar(f"SELECT count(*) FROM movements WHERE category_id='{despensa}'"), scalar("SELECT count(*) FROM movements") == 210))
check("la regla de otra categoría sigue viva", 1, scalar(f"SELECT count(*) FROM category_rules WHERE category_id='{restaurantes}'"))
check("eliminar una categoría inexistente", 404, a.call("DELETE", "/api/categories/no-existe")[0])

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
