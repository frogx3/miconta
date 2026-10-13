#!/usr/bin/env python3
"""
Prueba de humo de los cortes reales: el periodo se define al cargar el CSV (o en el historial de cargas), la cuenta lo
comparte entre su tarjeta física y la digital, y los filtros de Movimientos y la vista de Corte solo ofrecen cortes
que alguien capturó, nunca estimados con el día de corte.

Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
  rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
Crea usuarios y datos de prueba (@miconta.test); no limpia al terminar.
"""
import http.cookiejar
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = "http://localhost:4321"
PW = "Aa1-" + secrets.token_hex(10)
FAILED = False
TABLES = [
    "plan_events", "movements", "plan_tags", "goal_entries", "goals", "plans", "category_rules", "categories",
    "tags", "statement_cutoffs", "import_batches", "import_profiles", "cards", "accounts",
]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    def __init__(self):
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)

    def call(self, method, path, body=None, origin=BASE, raw=False):
        data = json.dumps(body).encode() if body is not None else None
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
    out = subprocess.run(
        ["pnpm", "exec", "wrangler", "d1", "execute", "miconta", "--local", "--json", "--command", sql],
        cwd=ROOT, capture_output=True, text=True,
    ).stdout
    return json.loads(out)[0]["results"]


def scalar(sql):
    rows = d1(sql)
    return list(rows[0].values())[0] if rows else None


def count(table, ws):
    if table == "plan_tags":
        return scalar(f"SELECT count(*) FROM plan_tags WHERE plan_id IN (SELECT id FROM plans WHERE workspace_id='{ws}')")
    return scalar(f"SELECT count(*) FROM {table} WHERE workspace_id='{ws}'")


def counts(ws):
    return {table: count(table, ws) for table in TABLES}



def csv(rows):
    return "Fecha,Concepto,Abono,Cargo,Tarjeta\n" + "\n".join(f"{d},{desc} Referencia 9{i:021d},0,{amount},Titular ***4172" for i, (d, desc, amount) in enumerate(rows)) + "\n"


admin, a, b = Client(), Client(), Client()
print("0) Preparación: A con una cuenta Banorte (tarjeta física 4172 y digital 2455, corte día 4) y otra cuenta sin cortes")
admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})
for name, email in (("Usuario A", "a@miconta.test"), ("Usuario B", "b@miconta.test")):
    admin.call("POST", "/api/auth/admin/create-user", {"name": name, "email": email, "password": PW, "role": "user", "data": {"locale": "es-MX"}})
for client, email in ((a, "a@miconta.test"), (b, "b@miconta.test")):
    check(f"sign-in {email}", 200, client.call("POST", "/api/auth/sign-in/email", {"email": email, "password": PW})[0])
    time.sleep(4)
_, acc = a.call("POST", "/api/accounts", {"name": "Mi Banorte", "bank": "Banorte"})
account = acc["id"]
_, card = a.call("POST", f"/api/accounts/{account}/cards", {"kind": "credit", "isDigital": False, "last4": "4172", "currency": "MXN", "cutoffDay": "4", "paymentDueDay": "24"})
_, digital = a.call("POST", f"/api/accounts/{account}/cards", {"kind": "credit", "isDigital": True, "last4": "2455", "currency": "MXN", "cutoffDay": "4", "paymentDueDay": "24"})
_, other = a.call("POST", "/api/accounts", {"name": "Mi Banamex", "bank": "Banamex"})
a.call("POST", f"/api/accounts/{other['id']}/cards", {"kind": "credit", "isDigital": False, "last4": "7777", "currency": "MXN", "cutoffDay": "7"})
cuts = lambda: [(r["cutoff_date"], r["start_date"]) for r in d1(f"SELECT cutoff_date, start_date FROM statement_cutoffs WHERE account_id='{account}' ORDER BY cutoff_date")]
page = lambda path: a.call("GET", path, raw=True)[1]
options = lambda html: re.findall(r'<option value="(corte:[^"]*)"', html)

AGOSTO = csv([("02/07/2026", "SUPER JULIO", "300.00"), ("20/07/2026", "GASOLINERA JULIO", "600.00"), ("03/08/2026", "OXXO AGOSTO", "50.00")])
SEPT = csv([("05/08/2026", "FARMACIA AGOSTO", "250.00"), ("02/09/2026", "CAFE SEPT", "90.00")])
OCT = csv([("03/09/2026", "SUPER SEPT", "700.00"), ("15/09/2026", "RESTAURANTE SEPT", "800.00")])

print("1) Definir el periodo al cargar: queda como corte real de la cuenta")
status, body = a.call("POST", "/api/import/preview", {"accountId": account, "text": AGOSTO})
check("sin cortes previos no hay primer día sugerido", None, body["preview"]["startSuggestion"])
profile = body["preview"]["profile"]
apply = lambda text, name, cutoff, start=None: a.call("POST", "/api/import/apply", {"accountId": account, "text": text, "fileName": name, "profile": profile, "cutoffDate": cutoff, "startDate": start})
check("primer día posterior al corte: 400", 400, apply(AGOSTO, "x.csv", "2026-08-04", "2026-08-10")[0])
check("primer día inválido: 400", 400, apply(AGOSTO, "x.csv", "2026-08-04", "mañana")[0])
status, first = apply(AGOSTO, "agosto.csv", "2026-08-04", "2026-07-02")
check("importa con corte 4-ago y primer día 2-jul", (201, [("2026-08-04", "2026-07-02")]), (status, cuts()))
status, body = a.call("POST", "/api/import/preview", {"accountId": account, "text": SEPT, "profile": profile})
check("ahora se sugiere empezar el día siguiente al último corte (5-ago)", "2026-08-05", body["preview"]["startSuggestion"])
status, second = apply(SEPT, "septiembre.csv", "2026-09-02")
check("el segundo corte (2-sep, el banco cortó antes del 4) queda sin primer día propio", (201, [("2026-08-04", "2026-07-02"), ("2026-09-02", None)]), (status, cuts()))

print("2) Movimientos: los cortes dependen de la cuenta o tarjeta elegida y son solo los capturados")
html = page("/app/gastos/movimientos")
check("sin cuenta elegida no hay opciones de corte y se avisa", ([], True), (options(html), "Elige una cuenta o tarjeta" in html))
check("sin cuenta elegida el periodo es todo el historial (5 movimientos)", True, "5 movimientos" in html)
html = page(f"/app/gastos/movimientos?filtro=a:{account}&mes=todo")
check("con la cuenta: 'desde el último corte' y los 2 cortes reales; ninguno inventado (no hay julio ni octubre)", ["corte:actual", "corte:2026-09", "corte:2026-08"], options(html))
check("el corte de septiembre va del 5 de agosto al 2 de septiembre; el de agosto desde el 2 de julio", (True, True), ("5 ago 2026 – 2 sep 2026" in html, "2 jul 2026 – 4 ago 2026" in html))
html = page(f"/app/gastos/movimientos?filtro=c:{digital['id']}&mes=todo")
check("la tarjeta digital hereda los cortes de la cuenta", ["corte:actual", "corte:2026-09", "corte:2026-08"], options(html))
html = page(f"/app/gastos/movimientos?filtro=a:{account}&mes=corte:2026-09")
check("Corte Septiembre: solo 5-ago a 2-sep (2 movimientos)", (True, True, False, False), ("FARMACIA AGOSTO" in html, "CAFE SEPT" in html, "OXXO AGOSTO" in html, "SUPER JULIO" in html))
html = page(f"/app/gastos/movimientos?filtro=a:{account}&mes=corte:2026-08")
check("Corte Agosto: del 2-jul al 4-ago (3 movimientos)", (True, True, True, False), ("SUPER JULIO" in html, "GASOLINERA JULIO" in html, "OXXO AGOSTO" in html, "FARMACIA AGOSTO" in html))
html = page(f"/app/gastos/movimientos?filtro=a:{account}&mes=corte:2026-07")
check("un corte que nadie capturó (julio) no existe: cae a todo el historial", True, "5 movimientos" in html)
html = page(f"/app/gastos/movimientos?filtro=a:{account}")
check("con la cuenta y sin periodo, abre en 'desde el último corte' (sin movimientos nuevos aún)", True, "Desde el último corte" in html and "SUPER JULIO" not in html)
status, third = apply(OCT, "octubre.csv", "2026-10-02")
html = page(f"/app/gastos/movimientos?filtro=a:{account}")
check("tras cargar el periodo que cierra el 2-oct, 'desde el último corte' empieza el 3-oct y no repite lo anterior", (True, False, False), ("desde el 3 oct 2026" in html, "RESTAURANTE SEPT" in html, "CAFE SEPT" in html))
html = page(f"/app/gastos/movimientos?filtro=a:{other['id']}&mes=todo")
check("la otra cuenta no tiene cortes: ninguna opción y se avisa", ([], True), (options(html), "aún no tiene cortes definidos" in html))
html = page(f"/app/gastos/movimientos?filtro=a:{account}&mes=corte&corte=2026-09")
check("el enlace antiguo (mes=corte&corte=) sigue funcionando", True, "CAFE SEPT" in html and "SUPER JULIO" not in html)

print("3) Vista de Corte: solo cortes reales")
html = page(f"/app/gastos/corte?cuenta={account}")
check("abre en el último corte real y lo nombra", True, "Corte Octubre 2026" in html and "Real" not in html.replace("Fechas", ""))
check("no hay badge 'Estimado'", False, ">Estimado<" in html)
html = page(f"/app/gastos/corte?cuenta={account}&corte=2026-08")
check("navega al corte de agosto (2 jul – 4 ago)", True, "Corte Agosto 2026" in html and "2 jul 2026" in html)
html = page(f"/app/gastos/corte?cuenta={account}&corte=2026-07")
check("un mes sin corte capturado no existe: muestra el último", True, "Corte Octubre 2026" in html)
html = page(f"/app/gastos/corte?cuenta={account}&corte=actual")
check("el periodo en curso (desde el último corte) también se ve", True, "Desde el último corte" in html)

print("4) Historial de cargas: definir o corregir el periodo después")
batch = third["batchId"]
html = page("/app/importar/historial")
check("cada carga ofrece 'Periodo del corte'", True, html.count("Periodo del corte") >= 3)
patch = lambda client, bid, body: client.call("PATCH", f"/api/import/batches/{bid}/period", body)
check("fecha de corte inválida: 400", 400, patch(a, batch, {"cutoffDate": "nunca", "startDate": ""})[0])
check("primer día posterior al corte: 400", 400, patch(a, batch, {"cutoffDate": "2026-10-02", "startDate": "2026-11-01"})[0])
check("B no puede tocar cargas de A: 404", 404, patch(b, batch, {"cutoffDate": "2026-10-02", "startDate": ""})[0])
check("sin sesión: 401", 401, patch(Client(), batch, {"cutoffDate": "2026-10-02", "startDate": ""})[0])
check("define primer día 3-sep y mueve el corte a 3-oct", (200, ("2026-10-03", "2026-09-03")), (patch(a, batch, {"cutoffDate": "2026-10-03", "startDate": "2026-09-03"})[0], cuts()[-1]))
check("el corte anterior (2-oct) se quitó: no queda huérfano", 3, len(cuts()))
d1(f"UPDATE statement_cutoffs SET official_pay_minor = 12345 WHERE account_id='{account}' AND cutoff_date='2026-10-03'")
patch(a, batch, {"cutoffDate": "2026-10-05", "startDate": "2026-09-03"})
check("mover la fecha dentro del mismo mes actualiza ese corte (no crea otro) y conserva su monto oficial", (3, ("2026-10-05", 12345)), (len(cuts()), tuple(d1(f"SELECT cutoff_date, official_pay_minor FROM statement_cutoffs WHERE account_id='{account}' ORDER BY cutoff_date DESC LIMIT 1")[0].values())))

print("5) Guardar el corte real desde la vista de Corte: editar la fecha actualiza el mismo corte")
record = scalar(f"SELECT id FROM statement_cutoffs WHERE account_id='{account}' AND cutoff_date='2026-08-04'")
save = lambda body: a.call("POST", "/api/statement-cutoffs", {"accountId": account, **body})
check("cambiar la fecha de corte del 4 al 5 de agosto (con id) actualiza el corte", (200, [("2026-08-05", "2026-07-02")]), (save({"id": record, "cutoffDate": "2026-08-05", "startDate": "2026-07-02", "officialPay": "100.00"})[0], [(r["cutoff_date"], r["start_date"]) for r in d1(f"SELECT cutoff_date, start_date FROM statement_cutoffs WHERE account_id='{account}' AND cutoff_date LIKE '2026-08%'")]))
check("sin id, otra fecha del mismo mes también actualiza ese corte en vez de crear un segundo", (200, 1), (save({"cutoffDate": "2026-08-06", "startDate": "", "officialPay": "100.00"})[0], scalar(f"SELECT count(*) FROM statement_cutoffs WHERE account_id='{account}' AND cutoff_date LIKE '2026-08%'")))
html = page(f"/app/gastos/corte?cuenta={account}&corte=2026-08")
check("la vista de Corte muestra la fecha nueva (6 ago) y el pago oficial guardado", (True, True), ("Corte Agosto 2026" in html and "6 ago 2026" in html, "$100.00" in html))
status, body = save({"id": record, "cutoffDate": "2026-09-02", "startDate": "", "officialPay": ""})
check("mover un corte a un mes que ya tiene otro: 400 month_taken", (400, "month_taken"), (status, body["errors"][0]["code"]))
# Cortes repetidos del mismo mes (quedaron de cuando guardar otra fecha creaba un segundo corte): guardar uno limpia los demás.
d1(f"INSERT INTO statement_cutoffs (id, workspace_id, account_id, cutoff_date, start_date) VALUES ('dup1', (SELECT workspace_id FROM statement_cutoffs WHERE account_id='{account}' LIMIT 1), '{account}', '2026-09-03', NULL), ('dup2', (SELECT workspace_id FROM statement_cutoffs WHERE account_id='{account}' LIMIT 1), '{account}', '2026-09-05', '2026-08-03')")
check("preparación: septiembre tiene 3 cortes (2-sep y dos repetidos)", 3, scalar(f"SELECT count(*) FROM statement_cutoffs WHERE account_id='{account}' AND cutoff_date LIKE '2026-09%'"))
status, body = save({"id": "dup1", "cutoffDate": "2026-09-04", "startDate": "2026-08-05", "officialPay": "28,405.54"})
check("guardar el del 3-sep con fecha 4-sep (el caso de producción) no falla y deja un solo corte", (200, [("2026-09-04", "2026-08-05", 2840554)]), (status, [(r["cutoff_date"], r["start_date"], r["official_pay_minor"]) for r in d1(f"SELECT cutoff_date, start_date, official_pay_minor FROM statement_cutoffs WHERE account_id='{account}' AND cutoff_date LIKE '2026-09%'")]))
check("editar un corte que no es de la cuenta: 404", 404, save({"id": "no-existe", "cutoffDate": "2026-08-06", "startDate": "", "officialPay": ""})[0])

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
