#!/usr/bin/env python3
"""
Prueba de humo de contabilizar movimientos en otro corte (el banco arma el estado de cuenta por fecha de cargo y el CSV
solo trae la de operación): sugerencia automática con el pago oficial, mover a mano (un pago agrupado se mueve completo),
cuentas de Corte y de Movimientos, validaciones y orden de la tabla de movimientos.

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




def row(date, desc, amount, ref):
    return f"{date},{desc} Referencia {ref},0,{amount},Titular ***4172"


def csv(rows):
    return "Fecha,Concepto,Abono,Cargo,Tarjeta\n" + "\n".join(rows) + "\n"


admin, a, b = Client(), Client(), Client()
print("0) Preparación: A con una cuenta Banorte (corte día 4) y B ajeno")
admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})
for name, email in (("Usuario A", "a@miconta.test"), ("Usuario B", "b@miconta.test")):
    admin.call("POST", "/api/auth/admin/create-user", {"name": name, "email": email, "password": PW, "role": "user", "data": {"locale": "es-MX"}})
for client, email in ((a, "a@miconta.test"), (b, "b@miconta.test")):
    check(f"sign-in {email}", 200, client.call("POST", "/api/auth/sign-in/email", {"email": email, "password": PW})[0])
    time.sleep(4)
_, acc = a.call("POST", "/api/accounts", {"name": "Mi Banorte", "bank": "Banorte"})
account = acc["id"]
a.call("POST", f"/api/accounts/{account}/cards", {"kind": "credit", "isDigital": False, "last4": "4172", "currency": "MXN", "cutoffDay": "4", "paymentDueDay": "24"})
page = lambda path: a.call("GET", path, raw=True)[1]

# Agosto (2-jul a 4-ago): el banco cobró en septiembre el pago de AutoZone (operado el 3-ago) y el de BPK (4-ago).
AGOSTO = csv([
    row("20/07/2026", "OXXO CENTRO", "100.00", "1"),
    row("03/08/2026", "BK MID NORTE FS 16200", "179.00", "2"),
    row("03/08/2026", "INTERESES SUJETOS A IVA", "69.94", "9999"),
    row("03/08/2026", "INTERESES NO SUJETOS A IVA", "2.69", "9999"),
    row("03/08/2026", "IVA SOBRE INTERESES DB", "11.19", "9999"),
    row("03/08/2026", "AUTOZONE 9540 MERIDA", "464.23", "9999"),
    row("04/08/2026", "BPK*MISCTDA ABARROTES", "132.00", "3"),
])
# El pago del corte anterior (279.00) está en el CSV de septiembre, como en el real.
PAGO = "10/08/2026,PAGO BANCA DIGITAL / SUCURSAL  GRACIAS. Referencia 6,279.00,0,Titular ***4172"
SEPT = csv([row("05/08/2026", "FARMACIA AGOSTO", "250.00", "4"), PAGO, row("02/09/2026", "CAFE SEPT", "90.00", "5")])
st, body = a.call("POST", "/api/import/preview", {"accountId": account, "text": AGOSTO})
profile = body["preview"]["profile"]
imp = lambda text, name, cutoff, start: a.call("POST", "/api/import/apply", {"accountId": account, "text": text, "fileName": name, "profile": profile, "cutoffDate": cutoff, "startDate": start})
check("importa agosto", 201, imp(AGOSTO, "agosto.csv", "2026-08-04", "2026-07-02")[0])
check("importa septiembre", 201, imp(SEPT, "septiembre.csv", "2026-09-04", "2026-08-05")[0])
official = lambda date, amount: a.call("POST", "/api/statement-cutoffs", {"accountId": account, "cutoffDate": date, "startDate": "", "officialPay": amount})
# Los estados de cuenta reales: agosto 279.00 (sin AutoZone ni BPK); septiembre 250 + 90 + 680.05.
check("captura el pago oficial de agosto y deja su primer día", 200, a.call("POST", "/api/statement-cutoffs", {"accountId": account, "cutoffDate": "2026-08-04", "startDate": "2026-07-02", "officialPay": "279.00"})[0])
check("captura el pago oficial de septiembre", 200, a.call("POST", "/api/statement-cutoffs", {"accountId": account, "cutoffDate": "2026-09-04", "startDate": "2026-08-05", "officialPay": "1,020.05"})[0])

print("1) Por fecha, las dos cuentas no cuadran (la diferencia es 680.05 en sentidos opuestos)")
aug = page(f"/app/gastos/corte?cuenta={account}&corte=2026-08")
check("Corte Agosto calcula 959.05 (279.00 + 680.05 de más)", True, "$959.05" in aug)
sep = page(f"/app/gastos/corte?cuenta={account}&corte=2026-09")
check("Corte Septiembre calcula 340.00 (680.05 de menos)", True, "$340.00" in sep)
check("ambas vistas avisan que las cifras pueden no coincidir con el estado de cuenta", (True, True), ("pueden no coincidir con tu estado de cuenta" in aug, "pueden no coincidir con tu estado de cuenta" in sep))

print("2) Sugerencia automática: los cargos que suman justo la diferencia")
check("Agosto sugiere contar AutoZone y BPK en el corte siguiente (680.05)", (True, True, True, True), ('id="suggestion"' in aug, "AUTOZONE 9540 MERIDA" in aug, "BPK*MISCTDA ABARROTES" in aug, "BK MID NORTE" not in aug.split('id="suggestion"')[1].split("</section>")[0]))
check("Septiembre sugiere traerlos del corte anterior", (True, True), ('id="suggestion"' in sep, "Contarlos en este corte" in sep.split('id="suggestion"')[1]))
attr = lambda name: re.search(rf"data-{name}=(?:'([^']*)'|\"([^\"]*)\")", sep)
ids_attr = attr("move-ids")
ids = json.loads((ids_attr.group(1) or ids_attr.group(2)).replace("&quot;", '"'))
month = (lambda m: m.group(1) if m.group(1) is not None else m.group(2))(attr("move-month"))
check("la sugerencia trae 5 movimientos (el pago de AutoZone completo y BPK) hacia el corte 2026-09", (5, "2026-09"), (len(ids), month))

print("3) Aplicar el ajuste: los dos cortes cuadran con sus PDF")
status, body = a.call("PATCH", "/api/movements/statement", {"ids": ids, "month": month})
check("mover a septiembre", (200, 5), (status, body.get("updated")))
aug = page(f"/app/gastos/corte?cuenta={account}&corte=2026-08")
sep = page(f"/app/gastos/corte?cuenta={account}&corte=2026-09")
check("Agosto ahora da 279.00 y coincide con el estado de cuenta", (True, True), ("$279.00" in aug, "Coincide con lo calculado" in aug))
check("Septiembre ahora da 1,020.05 y coincide con el estado de cuenta", (True, True), ("$1,020.05" in sep, "Coincide con lo calculado" in sep))
check("ya no se sugiere nada", False, 'id="suggestion"' in aug or 'id="suggestion"' in sep)
check("Septiembre lista los 5 ajustes manuales que cuentan aquí (+680.05)", (True, True), ("Ajustes manuales en este corte" in sep, "5 movimientos de otro corte cuentan aquí: +$680.05" in sep))
check("Agosto lista los 5 que por fecha serían suyos pero cuentan en otro corte (−680.05)", True, "5 movimientos de este periodo cuentan en otro corte: −$680.05" in aug)

print("4) Movimientos por corte usa la asignación manual")
html = page(f"/app/gastos/movimientos?filtro=a:{account}&mes=corte:2026-09")
check("Corte Septiembre incluye AutoZone y BPK (fecha de agosto) con la etiqueta manual", (True, True, True), ("BPK*MISCTDA ABARROTES" in html, "AUTOZONE 9540 MERIDA" in html, "(manual)" in html))
html = page(f"/app/gastos/movimientos?filtro=a:{account}&mes=corte:2026-08")
check("Corte Agosto ya no los incluye, pero sí BK MID NORTE", (False, False, True), ("BPK*MISCTDA ABARROTES" in html, "AUTOZONE 9540 MERIDA" in html, "BK MID NORTE" in html))
html = page(f"/app/gastos/movimientos?filtro=a:{account}&mes=todo")
check("en 'todo el historial' siguen todos (7 filas; el pago de AutoZone se muestra agrupado)", True, html.count("<tr data-id=") == 7)
check("cada fila ofrece 'Corte según su fecha' y los cortes disponibles", (True, True), ("Corte Septiembre 2026" in html, "Corte según su fecha" in html))

print("5) Volver a su fecha y mover un pago agrupado desde un solo renglón")
principal = scalar("SELECT id FROM movements WHERE description='AUTOZONE 9540 MERIDA'")
status, body = a.call("PATCH", "/api/movements/statement", {"ids": [principal], "month": None})
check("devolver el pago a su fecha arrastra a los 4 renglones del grupo", (200, 4), (status, body.get("updated")))
check("quedan sin asignación manual (BPK sigue en septiembre)", (None, "2026-09"), (scalar("SELECT statement_month FROM movements WHERE description='AUTOZONE 9540 MERIDA'"), scalar("SELECT statement_month FROM movements WHERE description LIKE 'BPK%'")))
status, body = a.call("PATCH", "/api/movements/statement", {"ids": [principal], "month": "2026-09"})
check("mover solo el renglón principal mueve el grupo completo", (200, 4, 4), (status, body.get("updated"), scalar("SELECT count(*) FROM movements WHERE reference='9999' AND statement_month='2026-09'") or scalar("SELECT count(*) FROM movements WHERE statement_month='2026-09' AND description LIKE '%INTERESES%'") + 2))

print("6) Validaciones")
bpk = scalar("SELECT id FROM movements WHERE description LIKE 'BPK%'")
check("un mes sin corte capturado: 409", 409, a.call("PATCH", "/api/movements/statement", {"ids": [bpk], "month": "2026-10"})[0])
check("mes con formato inválido: 400", 400, a.call("PATCH", "/api/movements/statement", {"ids": [bpk], "month": "septiembre"})[0])
check("sin ids: 400", 400, a.call("PATCH", "/api/movements/statement", {"ids": [], "month": None})[0])
check("B no puede mover movimientos de A: 404", 404, b.call("PATCH", "/api/movements/statement", {"ids": [bpk], "month": "2026-09"})[0])
check("sin sesión: 401", 401, Client().call("PATCH", "/api/movements/statement", {"ids": [bpk], "month": None})[0])
check("origen ajeno: 403", 403, a.call("PATCH", "/api/movements/statement", {"ids": [bpk], "month": None}, origin="http://evil.test")[0])

print("7) Si se quita el corte, las asignaciones vuelven a su fecha")
record = scalar("SELECT id FROM statement_cutoffs WHERE cutoff_date='2026-09-04'")
check("quita el corte de septiembre", 200, a.call("DELETE", "/api/statement-cutoffs", {"id": record})[0])
check("ningún movimiento queda asignado a un corte que ya no existe", 0, scalar("SELECT count(*) FROM movements WHERE statement_month IS NOT NULL"))

print("8) Orden de la tabla de movimientos")
order = lambda qs: re.findall(r'data-name="([^"]*)"', page(f"/app/gastos/movimientos?mes=todo&{qs}"))
dates = lambda qs: [d for d in re.findall(r'<td class="nowrap col-date"[^>]*>([^<]*)</td>', page(f"/app/gastos/movimientos?mes=todo&{qs}"))]
by_date_default = dates("")
check("por defecto, la fecha más reciente primero", True, by_date_default[0].startswith("2 sep") and by_date_default[-1].startswith("20 jul"))
check("fecha ascendente", True, dates("orden=fecha&dir=asc")[0].startswith("20 jul"))
amounts = lambda qs: [float(x.replace(",", "")) for x in re.findall(r'<td class="num nowrap"[^>]*>\$([\d,\.]+)</td>', page(f"/app/gastos/movimientos?mes=todo&{qs}"))]
asc, desc = amounts("orden=monto&dir=asc"), amounts("orden=monto&dir=desc")
check("monto ascendente y descendente", (True, True), (asc == sorted(asc), desc == sorted(desc, reverse=True)))
names = lambda qs: [n.upper() for n in order(qs)]
check("descripción ascendente y descendente", (True, True), (names("orden=descripcion&dir=asc") == sorted(names("orden=descripcion&dir=asc")), names("orden=descripcion&dir=desc") == sorted(names("orden=descripcion&dir=desc"), reverse=True)))
html = page("/app/gastos/movimientos?mes=todo&orden=monto&dir=desc")
check("el encabezado marca la columna y el sentido (aria-sort) y alterna al hacer clic", (True, True), ('aria-sort="descending"' in html, "orden=monto&amp;dir=asc" in html))
check("un orden inválido cae al predeterminado", True, dates("orden=nada&dir=raro")[0].startswith("2 sep"))

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
