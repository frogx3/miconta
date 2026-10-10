#!/usr/bin/env python3
"""
Prueba de humo del importador de CSV (API): vista previa, importación atómica con planes,
deduplicación, emparejamiento de mensualidades y rechazos.

Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
  rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
y el CSV de ejemplo en tests/fixtures/movements-sample.csv (está ignorado por git).
Crea usuarios y datos de prueba; vuelve a vaciar la base local al terminar.
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
CSV = open(os.path.join(ROOT, "tests/fixtures/movements-sample.csv"), encoding="utf-8").read()
PW = "Aa1-" + secrets.token_hex(10)
FAILED = False


class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None, origin=BASE):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        request = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request) as response:
                raw, status = response.read(), response.status
        except urllib.error.HTTPError as error:
            raw, status = error.read(), error.code
        try:
            return status, json.loads(raw)
        except ValueError:
            return status, {"raw": raw.decode(errors="replace")[:200]}


def check(description, expected, actual):
    global FAILED
    ok = expected == actual
    FAILED = FAILED or not ok
    print(f"  {'✓' if ok else '✗'} {description:<70} {actual}" + ("" if ok else f"   (esperado {expected})"))
    return ok


def d1(sql):
    out = subprocess.run(
        ["pnpm", "exec", "wrangler", "d1", "execute", "miconta", "--local", "--json", "--command", sql],
        cwd=ROOT, capture_output=True, text=True,
    ).stdout
    return json.loads(out)[0]["results"]


def scalar(sql):
    rows = d1(sql)
    return list(rows[0].values())[0] if rows else None


def row(sql):
    rows = d1(sql)
    return rows[0] if rows else None


def make_account(client, name, cards=(("credit", "4172", "MXN"),), customer_id=None):
    """Crea una cuenta con sus tarjetas; devuelve (id de la cuenta, {last4: id de la tarjeta})."""
    status, body = client.call("POST", "/api/accounts", {"name": name, "bank": "Banorte", "customerId": customer_id or ""})
    account = body["id"]
    ids = {}
    for kind, last4, currency in cards:
        credit = kind == "credit"
        _, created = client.call("POST", f"/api/accounts/{account}/cards", {
            "kind": kind, "isDigital": False, "last4": last4, "currency": currency,
            "creditLimit": "50,000.00" if credit else "", "cutoffDay": "15" if credit else "", "paymentDueDay": "5" if credit else "",
        })
        ids[last4] = created["id"]
    return account, ids


def draft(key, name, match, amount, current, total=12, type_="msi"):
    return {
        "movementKey": key, "type": type_, "name": name, "matchText": match,
        "installmentAmount": amount, "totalInstallments": str(total), "currentInstallment": str(current),
    }


admin, a, b, c = Client(), Client(), Client(), Client()

print("0) Preparación: admin y tres usuarios (A dueño, B ajeno, C solo lectura en el espacio de A)")
admin.call("POST", "/api/auth/sign-up/email", {"name": "Admin", "email": "admin@miconta.test", "password": PW})
ids = {}
for name, email in (("Usuario A", "a@miconta.test"), ("Usuario B", "b@miconta.test"), ("Usuario C", "c@miconta.test")):
    status, body = admin.call("POST", "/api/auth/admin/create-user", {"name": name, "email": email, "password": PW, "role": "user", "data": {"locale": "es-MX"}})
    ids[email] = body["user"]["id"]
for client, email in ((a, "a@miconta.test"), (b, "b@miconta.test"), (c, "c@miconta.test")):
    check(f"sign-in {email}", 200, client.call("POST", "/api/auth/sign-in/email", {"email": email, "password": PW})[0])
    time.sleep(4)
ws_a = scalar("SELECT id FROM workspaces WHERE name='Usuario A'")
d1(f"DELETE FROM workspace_members WHERE user_id='{ids['c@miconta.test']}'")
d1(f"INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('{ws_a}', '{ids['c@miconta.test']}', 'viewer')")

# Cuenta con un débito (0001) y un crédito (4172): las tarjetas nuevas del CSV heredan del crédito.
card, card_ids = make_account(a, "Banorte Oro", (("debit", "0001", "MXN"), ("credit", "4172", "MXN")), customer_id="CL-1")
check("la cuenta guardó su ID de cliente", "CL-1", scalar(f"SELECT customer_id FROM accounts WHERE id='{card}'"))
print("1) Vista previa (sin perfil guardado: se detecta)")
status, body = a.call("POST", "/api/import/preview", {"accountId": card, "text": CSV})
check("preview 200", 200, status)
p = body["preview"]
check("perfil detectado", "detected", p["profileSource"])
check("pide revisar el mapeo", True, p["needsMapping"])
check("105 filas, todas nuevas, sin errores", (105, 105, 0, 0), (p["summary"]["total"], p["summary"]["fresh"], p["summary"]["duplicates"], p["summary"]["errors"]))
check("encabezados leídos", ["Fecha", "Concepto", "Abono", "Cargo", "Tarjeta"], p["headers"])
check("tarjetas del archivo: la 4172 ya existe en la cuenta, la 2455 no", [("2455", "additional", False), ("4172", "primary", True)], sorted((x["last4"], x["kind"], x["exists"]) for x in p["cards"]))
check("moneda del archivo = la de las tarjetas, sin mezcla", ("MXN", False), (p["currency"], p["mixedCurrencies"]))
check("etiqueta de referencia detectada", "Referencia", p["profile"]["referenceLabel"])
check("sugiere el último corte (día 15)", True, bool(p["cutoffSuggestion"]) and p["cutoffSuggestion"].endswith("-15"))
check("hay pistas de posibles planes", True, any(m["hints"] for m in p["movements"]))
check("precarga el importe del cargo en formato local", "995.15", p["movements"][0]["chargeInput"])

by_desc = {}
for m in p["movements"]:
    by_desc.setdefault(m["description"], []).append(m["key"])
def keys(prefix):
    return [k for desc, ks in by_desc.items() if desc.startswith(prefix) for k in ks]

print("2) Rechazos de la vista previa")
check("perfil inválido", 400, a.call("POST", "/api/import/preview", {"accountId": card, "text": CSV, "profile": {"delimiter": "|"}})[0])
check("B no puede usar la cuenta de A", 404, b.call("POST", "/api/import/preview", {"accountId": card, "text": CSV})[0])
check("C (solo lectura) no puede", 403, c.call("POST", "/api/import/preview", {"accountId": card, "text": CSV})[0])
check("admin (sin espacio) no puede", 403, admin.call("POST", "/api/import/preview", {"accountId": card, "text": CSV})[0])
check("sin sesión", 401, Client().call("POST", "/api/import/preview", {"accountId": card, "text": CSV})[0])
check("origen ajeno", 403, a.call("POST", "/api/import/preview", {"accountId": card, "text": CSV}, origin="http://evil.test")[0])
check("archivo demasiado grande", 413, a.call("POST", "/api/import/preview", {"accountId": card, "text": "x" * 2_000_001})[0])

profile = p["profile"]
cutoff = "2026-09-15"
edo = keys("EDO YUCSAF")
drafts = [
    draft(keys("EL AGUILA")[0], "Seguro de vida", "EL AGUILA CIA SEG", "902.36", 3),
    draft(keys("RUMAYA")[0], "Viaje", "RUMAYA TRAVEL", "571.71", 1),
    draft(edo[0], "Impuesto vehicular 1", "EDO YUCSAF", "252.25", 4),
    draft(edo[1], "Impuesto vehicular 2", "EDO YUCSAF", "252.25", 4),
]
apply_base = {"accountId": card, "text": CSV, "fileName": "Consulta.csv", "profile": profile, "cutoffDate": cutoff}

print("3) Rechazos de la importación (no deben escribir nada)")
check("fecha de corte inválida", 400, a.call("POST", "/api/import/apply", {**apply_base, "cutoffDate": "hoy"})[0])
bad = dict(drafts[0], currentInstallment="13")
status, body = a.call("POST", "/api/import/apply", {**apply_base, "planDrafts": [bad]})
check("plan con pago actual > plazo", (400, "INVALID_PLAN"), (status, body.get("code")))
status, body = a.call("POST", "/api/import/apply", {**apply_base, "planDrafts": [dict(drafts[0], movementKey="inexistente#1")]})
check("plan sobre un movimiento que no está en el archivo", (400, "INVALID_PLAN"), (status, body.get("code")))
status, body = a.call("POST", "/api/import/apply", {**apply_base, "planDrafts": [drafts[0], dict(drafts[1], movementKey=drafts[0]["movementKey"])]})
check("dos planes sobre el mismo movimiento", (400, "INVALID_PLAN"), (status, body.get("code")))
status, body = a.call("POST", "/api/import/apply", {**apply_base, "confirmedMatches": [{"planId": "no-existe", "movementKey": drafts[0]["movementKey"]}]})
check("mensualidad confirmada que el servidor no propuso", (400, "INVALID_MATCH"), (status, body.get("code")))
bad_profile = json.loads(json.dumps(profile)); bad_profile["columns"]["charge"] = "Columna que no existe"
status, body = a.call("POST", "/api/import/apply", {**apply_base, "profile": bad_profile})
check("mapeo apunta a una columna inexistente", (400, "PARSE_PROBLEMS"), (status, body.get("code")))
check("C (solo lectura) no puede importar", 403, c.call("POST", "/api/import/apply", apply_base)[0])
check("B no puede importar en la cuenta de A", 404, b.call("POST", "/api/import/apply", apply_base)[0])
check("nada se escribió", (0, 0, 0, 2), (scalar("SELECT count(*) FROM movements"), scalar("SELECT count(*) FROM plans"), scalar("SELECT count(*) FROM import_batches"), scalar("SELECT count(*) FROM cards")))

print("4) Importación con 4 planes (atómica)")
status, body = a.call("POST", "/api/import/apply", {**apply_base, "planDrafts": drafts})
check("apply 201", 201, status)
batch = body.get("batchId")
check("conteos", {"movements": 105, "duplicatesSkipped": 0, "plansCreated": 4, "installmentsLinked": 0, "cardsCreated": 1, "rowErrorsIgnored": 0, "categorized": 0}, body.get("counts"))
check("105 movimientos guardados", 105, scalar("SELECT count(*) FROM movements"))
check("todos los movimientos tienen tarjeta (por sus últimos 4)", 0, scalar("SELECT count(*) FROM movements WHERE card_id IS NULL"))
check("movimientos 4172 y 2455 repartidos entre sus tarjetas", True, all(scalar(f"SELECT count(*) FROM movements WHERE card_id='{cid}'") > 0 for cid in (card_ids["4172"], scalar(f"SELECT id FROM cards WHERE account_id='{card}' AND last4='2455'"))))
check("ningún movimiento a la tarjeta de débito", 0, scalar(f"SELECT count(*) FROM movements WHERE card_id='{card_ids['0001']}'"))
check("la cuenta dueña de los movimientos es la importada", 105, scalar(f"SELECT count(*) FROM movements WHERE account_id='{card}'"))
check("cuenta con 3 tarjetas: débito, la existente y la creada", ["0001", "2455", "4172"], sorted(r["last4"] for r in d1(f"SELECT last4 FROM cards WHERE account_id='{card}'")))
new = row(f"SELECT kind, is_digital, currency, credit_limit_minor, cutoff_day, payment_due_day FROM cards WHERE account_id='{card}' AND last4='2455'")
check("la tarjeta creada hereda tipo, moneda, límite, corte y pago de la tarjeta de crédito (no del débito)", ("credit", 0, "MXN", 5000000, 15, 5), tuple(new.values()))
check("moneda de los movimientos = la de la cuenta", "MXN", scalar("SELECT DISTINCT currency FROM movements"))
check("4 planes, todos activos", (4, 4), (scalar("SELECT count(*) FROM plans"), scalar("SELECT count(*) FROM plans WHERE status='active'")))
aguila = d1("SELECT first_charge_date, paid_installments, total_installments, installment_amount_minor, total_amount_minor, interest_rate_bp FROM plans WHERE match_text='EL AGUILA CIA SEG'")[0]
check("EL AGUILA: primer cargo = 2 meses antes del cargo visto", ("2026-07-06", 3, 12, 90236, 90236 * 12, 0), tuple(aguila.values()))
check("RUMAYA: primer cargo = fecha del cargo, pagó 1", ("2026-09-08", 1), tuple(d1("SELECT first_charge_date, paid_installments FROM plans WHERE match_text='RUMAYA TRAVEL'")[0].values()))
check("EDO YUCSAF ×2: primer cargo 2026-06-30, pagó 4", [("2026-06-30", 4), ("2026-06-30", 4)], [tuple(r.values()) for r in d1("SELECT first_charge_date, paid_installments FROM plans WHERE match_text='EDO YUCSAF'")])
plan_cards = {r["match_text"]: r["last4"] for r in d1("SELECT DISTINCT p.match_text, c.last4 FROM plans p JOIN cards c ON c.id = p.card_id")}
mov_last4 = {r["d"]: r["last4"] for r in d1("SELECT substr(m.description, 1, 9) AS d, c.last4 FROM movements m JOIN cards c ON c.id = m.card_id WHERE m.plan_id IS NOT NULL")}
check("cada plan quedó en la tarjeta del movimiento del que nació", True, all(plan_cards[match] == last4 for match, last4 in (("EL AGUILA CIA SEG", mov_last4["EL AGUILA"]), ("RUMAYA TRAVEL", mov_last4["RUMAYA TR"]))))
check("4 movimientos vinculados a su plan con su número de pago", [3, 1, 4, 4], sorted([r["n"] for r in d1("SELECT plan_installment_no AS n FROM movements WHERE plan_id IS NOT NULL")], key=lambda x: {3: 0, 1: 1, 4: 2}[x]))
check("historial: creado + mensualidad por plan", (4, 4), (scalar("SELECT count(*) FROM plan_events WHERE type='created'"), scalar("SELECT count(*) FROM plan_events WHERE type='installment_recorded'")))
row = d1(f"SELECT file_name, cutoff_date, status, file_key FROM import_batches WHERE id='{batch}'")[0]
check("lote registrado con corte y archivo", ("Consulta.csv", cutoff, "applied", True), (row["file_name"], row["cutoff_date"], row["status"], bool(row["file_key"])))
check("perfil de columnas guardado para la cuenta", 1, scalar("SELECT count(*) FROM import_profiles"))
r2 = subprocess.run(["pnpm", "exec", "wrangler", "r2", "object", "get", f"miconta-files/{row['file_key']}", "--local", "--pipe"], cwd=ROOT, capture_output=True)
check("archivo original guardado en R2", len(CSV.encode()), len(r2.stdout))

print("5) Segunda carga del mismo archivo")
status, body = a.call("POST", "/api/import/preview", {"accountId": card, "text": CSV})
p2 = body["preview"]
check("perfil guardado, ya no pide mapeo", ("saved", False), (p2["profileSource"], p2["needsMapping"]))
check("105 duplicados, 0 nuevos", (0, 105), (p2["summary"]["fresh"], p2["summary"]["duplicates"]))
status, body = a.call("POST", "/api/import/apply", apply_base)
check("importar de nuevo: nada que importar", (409, "NOTHING_TO_IMPORT"), (status, body.get("code")))
check("sigue habiendo 105 movimientos", 105, scalar("SELECT count(*) FROM movements"))

print("6) Emparejar mensualidades de planes existentes (segunda cuenta, planes dados de alta antes)")
card2, card2_ids = make_account(a, "Banorte Platinum", (("credit", "7777", "MXN"),))
card2_card = card2_ids["7777"]
def insert_plan(pid, name, match, amount, paid, first):
    d1(f"INSERT INTO plans (id, workspace_id, card_id, type, name, match_text, currency, total_amount_minor, installment_amount_minor, total_installments, paid_installments, first_charge_date, status) VALUES ('{pid}', '{ws_a}', '{card2_card}', 'msi', '{name}', '{match}', 'MXN', {amount * 12}, {amount}, 12, {paid}, '{first}', 'active')")
insert_plan("plan-aguila", "Seguro", "EL AGUILA CIA SEG", 90236, 2, "2026-07-03")
insert_plan("plan-gym", "Gimnasio", "GIMNASIO", 50000, 1, "2026-08-15")
insert_plan("plan-final", "Último pago", "MAPFRE L COBRANZA", 112312, 11, "2025-10-08")
status, body = a.call("POST", "/api/import/preview", {"accountId": card2, "text": CSV})
p3 = body["preview"]
found = {m["planId"]: m for m in p3["planMatches"]}
check("propone EL AGUILA como mensualidad 3", (3, 3, False), (found["plan-aguila"]["installmentNo"], found["plan-aguila"]["daysOffset"], found["plan-aguila"]["isFinal"]))
check("propone MAPFRE como la última mensualidad (12/12)", (12, True), (found["plan-final"]["installmentNo"], found["plan-final"]["isFinal"]))
check("GIMNASIO no aparece en el archivo: se marca faltante", ["plan-gym"], [m["planId"] for m in p3["missingInstallments"]])
confirm = [{"planId": "plan-aguila", "movementKey": found["plan-aguila"]["movementKey"]}, {"planId": "plan-final", "movementKey": found["plan-final"]["movementKey"]}]
status, body = a.call("POST", "/api/import/apply", {**apply_base, "accountId": card2, "confirmedMatches": confirm})
check("apply con 2 mensualidades confirmadas", (201, 2), (status, (body.get("counts") or {}).get("installmentsLinked")))
check("las 2 tarjetas nuevas del CSV se crearon en la cuenta y heredaron de la 7777", (2, 1), (body["counts"]["cardsCreated"], scalar(f"SELECT count(*) FROM cards WHERE account_id='{card2}' AND last4 IN ('4172','2455') AND cutoff_day=15 AND credit_limit_minor=5000000")  // 2))
check("EL AGUILA avanzó a 3/12 y sigue activo", (3, "active"), tuple(d1("SELECT paid_installments, status FROM plans WHERE id='plan-aguila'")[0].values()))
check("MAPFRE llegó a 12/12: liquidado de forma natural", (12, "completed_natural", True), (lambda r: (r["paid_installments"], r["status"], r["settled_at"] is not None))(d1("SELECT paid_installments, status, settled_at FROM plans WHERE id='plan-final'")[0]))
check("GIMNASIO no se tocó (se confirma a mano, no solo)", (1, "active"), tuple(d1("SELECT paid_installments, status FROM plans WHERE id='plan-gym'")[0].values()))
check("los movimientos quedaron vinculados", 2, scalar(f"SELECT count(*) FROM movements WHERE account_id='{card2}' AND plan_id IN ('plan-aguila','plan-final')"))
check("historial de las mensualidades", 2, scalar("SELECT count(*) FROM plan_events WHERE plan_id IN ('plan-aguila','plan-final')"))

print("7) Filas con error")
bad_csv = "Fecha,Concepto,Abono,Cargo,Tarjeta\n01/10/2026,BUENA Referencia R1,0,10.00,Titular ***4172\n31/02/2026,MALA Referencia R2,0,10.00,Titular ***4172\n"
card3, card3_ids = make_account(a, "Tercera", (("credit", "1234", "MXN"),))
status, body = a.call("POST", "/api/import/preview", {"accountId": card3, "text": bad_csv})
check("la vista previa reporta la fila mala", (1, 1, 3), (body["preview"]["summary"]["errors"], body["preview"]["summary"]["fresh"], body["preview"]["errors"][0]["line"]))
prof3 = body["preview"]["profile"]
base3 = {"accountId": card3, "text": bad_csv, "fileName": "x.csv", "profile": prof3, "cutoffDate": cutoff}
status, body = a.call("POST", "/api/import/apply", base3)
check("con errores y sin confirmar: rechazado", (400, "ROW_ERRORS"), (status, body.get("code")))
status, body = a.call("POST", "/api/import/apply", {**base3, "ignoreErrors": True})
check("ignorando errores importa las filas válidas", (201, 1, 1), (status, body["counts"]["movements"], body["counts"]["rowErrorsIgnored"]))
check("la terminación 4172 (nueva en esta cuenta) se creó una sola vez, aunque exista en otras cuentas", 1, scalar(f"SELECT count(*) FROM cards WHERE account_id='{card3}' AND last4='4172'"))
check("el movimiento importado quedó en esa tarjeta", 1, scalar(f"SELECT count(*) FROM movements m JOIN cards c ON c.id=m.card_id WHERE m.account_id='{card3}' AND c.last4='4172'"))

print("8) Lo importado en una cuenta no se mezcla con otra")
check("movimientos de la cuenta 1", 105, scalar(f"SELECT count(*) FROM movements WHERE account_id='{card}'"))
check("movimientos de la cuenta 3", 1, scalar(f"SELECT count(*) FROM movements WHERE account_id='{card3}'"))

print("9) createMissingCards=false, plan sin tarjeta clara y monedas mezcladas")
one_csv = "Fecha,Concepto,Abono,Cargo,Tarjeta\n01/10/2026,TIENDA UNO Referencia Z1,0,50.00,Titular ***5555\n02/10/2026,TIENDA DOS Referencia Z2,0,60.00,\n"
acc4, acc4_ids = make_account(a, "Sin crear tarjetas", (("credit", "1111", "MXN"),))
p4 = a.call("POST", "/api/import/preview", {"accountId": acc4, "text": one_csv})[1]["preview"]
base4 = {"accountId": acc4, "text": one_csv, "fileName": "u.csv", "profile": p4["profile"], "cutoffDate": cutoff}
status, body = a.call("POST", "/api/import/apply", {**base4, "createMissingCards": False})
check("sin crear tarjetas: importa y no crea ninguna", (201, 0, 1), (status, body["counts"]["cardsCreated"], scalar(f"SELECT count(*) FROM cards WHERE account_id='{acc4}'")))
check("el movimiento con terminación desconocida queda sin tarjeta; el que no trae terminación también", 2, scalar(f"SELECT count(*) FROM movements WHERE account_id='{acc4}' AND card_id IS NULL"))

# Dos tarjetas de crédito y un cargo sin terminación: el plan no sabe a qué tarjeta ir.
acc5, acc5_ids = make_account(a, "Dos créditos", (("credit", "1111", "MXN"), ("credit", "2222", "MXN")))
p5 = a.call("POST", "/api/import/preview", {"accountId": acc5, "text": one_csv})[1]["preview"]
nokey = [m["key"] for m in p5["movements"] if m["cardLast4"] is None][0]
base5 = {"accountId": acc5, "text": one_csv, "fileName": "u.csv", "profile": p5["profile"], "cutoffDate": cutoff}
status, body = a.call("POST", "/api/import/apply", {**base5, "planDrafts": [draft(nokey, "Sin tarjeta", "TIENDA DOS", "60.00", 1)]})
check("plan sobre un cargo sin terminación y 2 tarjetas de crédito: rechazado", (400, "INVALID_PLAN", ["card_required"]), (status, body.get("code"), [d["errors"] for d in body.get("details", [])]))
check("no se escribió nada", (0, 2), (scalar(f"SELECT count(*) FROM movements WHERE account_id='{acc5}'"), scalar(f"SELECT count(*) FROM cards WHERE account_id='{acc5}'")))
withkey = [m["key"] for m in p5["movements"] if m["cardLast4"] == "5555"][0]
status, body = a.call("POST", "/api/import/apply", {**base5, "planDrafts": [draft(withkey, "Con terminación", "TIENDA UNO", "50.00", 1)]})
check("un cargo con terminación 5555: el plan va a esa tarjeta (creada por el CSV)", (201, scalar(f"SELECT id FROM cards WHERE account_id='{acc5}' AND last4='5555'")), (status, scalar("SELECT card_id FROM plans WHERE match_text='TIENDA UNO'")))
check("el movimiento y la tarjeta creada coinciden", 1, scalar(f"SELECT count(*) FROM movements m JOIN plans p ON p.id=m.plan_id JOIN cards c ON c.id=m.card_id WHERE c.last4='5555' AND p.card_id=m.card_id AND m.account_id='{acc5}'"))
# Con una sola tarjeta de crédito (y un débito) el plan va a la de crédito.
acc6, acc6_ids = make_account(a, "Crédito y débito", (("debit", "3333", "MXN"), ("credit", "4444", "MXN")))
p6 = a.call("POST", "/api/import/preview", {"accountId": acc6, "text": one_csv})[1]["preview"]
nokey6 = [m["key"] for m in p6["movements"] if m["cardLast4"] is None][0]
status, body = a.call("POST", "/api/import/apply", {"accountId": acc6, "text": one_csv, "fileName": "u.csv", "profile": p6["profile"], "cutoffDate": cutoff, "planDrafts": [draft(nokey6, "Sin terminación", "TIENDA DOS", "60.00", 1)]})
check("cargo sin terminación: el plan va a la única tarjeta de crédito", (201, acc6_ids["4444"]), (status, scalar(f"SELECT card_id FROM plans WHERE match_text='TIENDA DOS'")))

# Cuenta sin tarjetas: se usa la moneda del espacio y las tarjetas del CSV se crean con lo mínimo.
status, body = a.call("POST", "/api/accounts", {"name": "Sin tarjetas", "bank": "Banco"})
acc7 = body["id"]
p7 = a.call("POST", "/api/import/preview", {"accountId": acc7, "text": one_csv})[1]["preview"]
check("cuenta sin tarjetas: moneda del espacio (MXN) y sin mezcla", ("MXN", False), (p7["currency"], p7["mixedCurrencies"]))
status, body = a.call("POST", "/api/import/apply", {"accountId": acc7, "text": one_csv, "fileName": "u.csv", "profile": p7["profile"], "cutoffDate": cutoff})
check("importa y crea la tarjeta 5555 sin límite ni corte, en la moneda del espacio", (201, 1, ("credit", "MXN", None, None)), (status, body["counts"]["cardsCreated"], tuple(d1(f"SELECT kind, currency, credit_limit_minor, cutoff_day FROM cards WHERE account_id='{acc7}'")[0].values())))

# Monedas mezcladas: la cuenta tiene tarjetas activas en MXN y USD.
acc8, acc8_ids = make_account(a, "Mixta", (("credit", "5001", "MXN"), ("credit", "5002", "USD")))
p8 = a.call("POST", "/api/import/preview", {"accountId": acc8, "text": one_csv})[1]["preview"]
check("la vista previa avisa de monedas mezcladas", True, p8["mixedCurrencies"])
status, body = a.call("POST", "/api/import/apply", {"accountId": acc8, "text": one_csv, "fileName": "u.csv", "profile": p8["profile"], "cutoffDate": cutoff})
check("importar con monedas mezcladas: rechazado", (400, "MIXED_CURRENCIES"), (status, body.get("code")))
check("no se escribió nada", 0, scalar(f"SELECT count(*) FROM movements WHERE account_id='{acc8}'"))
a.call("PATCH", f"/api/accounts/{acc8}/cards/{acc8_ids['5002']}", {"archived": True})
p8 = a.call("POST", "/api/import/preview", {"accountId": acc8, "text": one_csv})[1]["preview"]
check("archivando la tarjeta en USD ya no hay mezcla", (False, "MXN"), (p8["mixedCurrencies"], p8["currency"]))
status, body = a.call("POST", "/api/import/apply", {"accountId": acc8, "text": one_csv, "fileName": "u.csv", "profile": p8["profile"], "cutoffDate": cutoff})
check("y entonces importa", 201, status)
a.call("PATCH", f"/api/accounts/{acc8}", {"archived": True})
check("una cuenta archivada no se puede importar", 404, a.call("POST", "/api/import/preview", {"accountId": acc8, "text": one_csv})[0])

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
