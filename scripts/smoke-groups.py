#!/usr/bin/env python3
"""
Prueba de humo de los pagos a meses con intereses agrupados por referencia (pago requerido + intereses + IVA +
abono de la compra original): vista previa, plan creado desde la carga, mensualidad siguiente emparejada por el
total, conversión posterior desde Movimientos y la pantalla de movimientos.

Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
  rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
Crea usuarios y datos de prueba (@miconta.test); no limpia al terminar.
"""
import http.cookiejar
import json
import os
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
    return "Fecha,Concepto,Abono,Cargo,Tarjeta\n" + "\n".join(rows) + "\n"


def line(date, desc, ref, credit, charge):
    return f"{date},{desc} Referencia {ref},{credit},{charge},Titular ***4172"


admin, a = Client(), Client()
print("0) Preparación: admin y A con una cuenta y una tarjeta de crédito")
admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})
admin.call("POST", "/api/auth/admin/create-user", {"name": "Usuario A", "email": "a@miconta.test", "password": PW, "role": "user", "data": {"locale": "es-MX"}})
time.sleep(4)
check("sign-in A", 200, a.call("POST", "/api/auth/sign-in/email", {"email": "a@miconta.test", "password": PW})[0])
_, body = a.call("POST", "/api/accounts", {"name": "Mi Banorte", "bank": "Banorte"})
account = body["id"]
a.call("POST", f"/api/accounts/{account}/cards", {"kind": "credit", "isDigital": False, "last4": "4172", "currency": "MXN", "cutoffDay": "15"})

JULIO = csv([
    line("03/07/2026", "INTERESES SUJETOS A IVA", "74555466184948250338022", 0, "80.98"),
    line("03/07/2026", "IVA SOBRE INTERESES DB", "74555466184948250338022", 0, "12.96"),
    line("03/07/2026", "AUTOZONE 9540 MERIDA", "74555466184948250338022", 0, "455.88"),
    line("03/07/2026", "AUTOZONE 9540 MERIDA", "74555466184948250338022", "4417.00", 0),
    line("04/07/2026", "OXXO CENTRO", "74555466184948250338999", 0, "50.00"),
])
AGOSTO = csv([
    line("03/08/2026", "INTERESES SUJETOS A IVA", "74555466184948250339111", 0, "72.00"),
    line("03/08/2026", "IVA SOBRE INTERESES DB", "74555466184948250339111", 0, "11.52"),
    line("03/08/2026", "AUTOZONE 9540 MERIDA", "74555466184948250339111", 0, "466.30"),
])

print("1) Vista previa: el pago agrupado se ve como uno")
status, body = a.call("POST", "/api/import/preview", {"accountId": account, "text": JULIO})
check("preview 200", 200, status)
p = body["preview"]
by_desc = lambda text, role=None: [m for m in p["movements"] if text in m["description"] and (role is None or (m["group"] or {}).get("role") == role)]
principal = by_desc("AUTOZONE", "principal")
check("un solo principal, con el total 549.82 y 3 renglones", (1, 54982, 3), (len(principal), principal[0]["group"]["totalMinor"], principal[0]["group"]["items"]))
check("los intereses y el IVA son miembros; la compra original, abono del grupo", (2, 1), (len([m for m in p["movements"] if (m["group"] or {}).get("role") == "member"]), len(by_desc("AUTOZONE", "credit"))))
check("el cargo suelto (OXXO) no se agrupa", None, by_desc("OXXO")[0]["group"])
check("el monto sugerido del plan es el total del pago", "549.82", principal[0]["group"]["totalInput"])
profile = p["profile"]
draft = {"movementKey": principal[0]["key"], "type": "mci", "name": "AutoZone", "matchText": "AUTOZONE", "installmentAmount": "549.82", "currentInstallment": "1", "totalInstallments": "10", "totalAmount": "", "interestRate": "36"}
member_key = by_desc("INTERESES", "member")[0]["key"]
check("no se puede crear un plan desde un renglón miembro: 400", 400, a.call("POST", "/api/import/apply", {"accountId": account, "text": JULIO, "fileName": "julio.csv", "profile": profile, "cutoffDate": "2026-07-15", "planDrafts": [dict(draft, movementKey=member_key)]})[0])

print("2) Cargar con plan: los 3 cargos del grupo quedan en la mensualidad 1")
status, body = a.call("POST", "/api/import/apply", {"accountId": account, "text": JULIO, "fileName": "julio.csv", "profile": profile, "cutoffDate": "2026-07-15", "planDrafts": [draft]})
check("importa con un plan nuevo", (201, 1, 5), (status, body["counts"]["plansCreated"], body["counts"]["movements"]))
plan = scalar("SELECT id FROM plans WHERE name='AutoZone'")
rows = d1(f"SELECT description, plan_installment_no FROM movements WHERE plan_id='{plan}' ORDER BY charge_minor")
check("tres cargos vinculados (intereses, IVA, pago requerido), todos como pago 1", [("IVA SOBRE INTERESES DB", 1), ("INTERESES SUJETOS A IVA", 1), ("AUTOZONE 9540 MERIDA", 1)], [(r["description"], r["plan_installment_no"]) for r in rows])
check("el abono de la compra original no se vincula al plan", 0, scalar("SELECT count(*) FROM movements WHERE credit_minor>0 AND plan_id IS NOT NULL"))
check("plan: mensualidad 549.82, pago 1 de 10, meses con intereses", (54982, 1, 10, "mci"), tuple(d1(f"SELECT installment_amount_minor, paid_installments, total_installments, type FROM plans WHERE id='{plan}'")[0].values()))
check("una sola mensualidad registrada en el historial", 1, scalar(f"SELECT count(*) FROM plan_events WHERE plan_id='{plan}' AND type='installment_recorded'"))

print("3) Mes siguiente: el pago agrupado se empareja con la mensualidad por su total")
# Agosto: 466.30 + 72.00 + 11.52 = 549.82, la misma mensualidad aunque el principal cambie.
status, body = a.call("POST", "/api/import/preview", {"accountId": account, "text": AGOSTO, "profile": profile})
matches = body["preview"]["planMatches"]
check("se propone el pago 2 del plan con el cargo principal", (1, 2), (len(matches), matches[0]["installmentNo"] if matches else None))
status, body = a.call("POST", "/api/import/apply", {"accountId": account, "text": AGOSTO, "fileName": "agosto.csv", "profile": profile, "cutoffDate": "2026-08-15", "confirmedMatches": [{"planId": plan, "movementKey": matches[0]["movementKey"]}]})
check("se aplica la mensualidad", (201, 1), (status, body["counts"]["installmentsLinked"]))
check("los 3 cargos de agosto quedan como pago 2 y el plan avanza una sola vez", (3, 2), (scalar(f"SELECT count(*) FROM movements WHERE plan_id='{plan}' AND plan_installment_no=2"), scalar(f"SELECT paid_installments FROM plans WHERE id='{plan}'")))

print("4) Cargar SIN plan y convertir después desde Movimientos")
SEPT = csv([
    line("05/09/2026", "INTERESES SUJETOS A IVA", "74555466184948250340001", 0, "30.00"),
    line("05/09/2026", "IVA SOBRE INTERESES DB", "74555466184948250340001", 0, "4.80"),
    line("05/09/2026", "LIVERPOOL POLANCO", "74555466184948250340001", 0, "300.00"),
    line("05/09/2026", "LIVERPOOL POLANCO", "74555466184948250340001", "3000.00", 0),
])
status, body = a.call("POST", "/api/import/apply", {"accountId": account, "text": SEPT, "fileName": "sept.csv", "profile": profile, "cutoffDate": "2026-09-15"})
check("importa sin planes", (201, 4), (status, body["counts"]["movements"]))
html = a.call("GET", "/app/gastos/movimientos?lote=" + body["batchId"], raw=True)[1]
check("la pantalla muestra una sola fila con el total 334.80 y el desglose", (True, True, True), ("$334.80" in html, "Pago requerido" in html, "Compra original convertida a meses" in html))
check("solo una fila de movimiento (los demás van dentro del desglose) y un botón de convertir", (1, 1), (html.count('<tr data-id='), html.count('class="link-button convert-plan"')))
principal_id = scalar("SELECT id FROM movements WHERE description='LIVERPOOL POLANCO' AND charge_minor>0")
interest_id = scalar("SELECT id FROM movements WHERE description='INTERESES SUJETOS A IVA' AND reference LIKE '%0001'")
payload = {"type": "mci", "name": "Liverpool", "matchText": "LIVERPOOL", "installmentAmount": "334.80", "currentInstallment": "1", "totalInstallments": "6", "totalAmount": "", "interestRate": "30"}
check("desde un renglón de intereses no se convierte: 409", 409, a.call("POST", f"/api/movements/{interest_id}/plan", payload)[0])
status, body = a.call("POST", f"/api/movements/{principal_id}/plan", payload)
check("desde el pago requerido sí: 201", 201, status)
check("los 3 cargos del grupo quedaron en el plan y el abono no", (3, 0), (scalar(f"SELECT count(*) FROM movements WHERE plan_id='{body.get('planId')}'"), scalar("SELECT count(*) FROM movements WHERE description='LIVERPOOL POLANCO' AND credit_minor>0 AND plan_id IS NOT NULL")))
check("convertir otra vez: 409", 409, a.call("POST", f"/api/movements/{principal_id}/plan", payload)[0])
check("el detalle del plan carga", 200, a.call("GET", f"/app/planes/{body.get('planId')}", raw=True)[0])

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
