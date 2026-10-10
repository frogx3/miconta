#!/usr/bin/env python3
"""
Prueba de humo de "deshacer una carga de importación" (API y pantalla): restauración exacta del estado,
reglas de bloqueo, permisos y reimportación posterior.

Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
  rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
y el CSV de ejemplo en tests/fixtures/movements-sample.csv (está ignorado por git).
Crea usuarios y datos de prueba; vuelve a vaciar la base local al terminar.
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
CSV = open(os.path.join(ROOT, "tests/fixtures/movements-sample.csv"), encoding="utf-8-sig").read()
PW = "Aa1-" + secrets.token_hex(10)
FAILED = False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect)

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
    print(f"  {'✓' if ok else '✗'} {description:<78} {actual}" + ("" if ok else f"   (esperado {expected})"))


def d1(sql):
    out = subprocess.run(["pnpm", "exec", "wrangler", "d1", "execute", "miconta", "--local", "--json", "--command", sql], cwd=ROOT, capture_output=True, text=True).stdout
    return json.loads(out)[0]["results"]


def scalar(sql):
    rows = d1(sql)
    return list(rows[0].values())[0] if rows else None


def row(sql):
    rows = d1(sql)
    return rows[0] if rows else None


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
d1(f"DELETE FROM workspace_members WHERE user_id='{ids['c@miconta.test']}'")
d1(f"INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('{ws_a}', '{ids['c@miconta.test']}', 'viewer')")


def make_account(name, client=None, last4="4172"):
    """Cuenta con una tarjeta de crédito; devuelve (id de la cuenta, id de la tarjeta)."""
    client = client or a
    account = client.call("POST", "/api/accounts", {"name": name, "bank": "Banorte"})[1]["id"]
    card = client.call("POST", f"/api/accounts/{account}/cards", {"kind": "credit", "isDigital": False, "last4": last4, "currency": "MXN", "cutoffDay": "15"})[1]["id"]
    return account, card


def make_card(name):
    return make_account(name)[0]


def plans_in(account):
    return f"SELECT count(*) FROM plans WHERE card_id IN (SELECT id FROM cards WHERE account_id='{account}')"


def preview(card, text):
    return a.call("POST", "/api/import/preview", {"accountId": card, "text": text})[1]["preview"]


def import_csv(card, text, drafts=None, matches=None, name="Consulta.csv"):
    p = preview(card, text)
    return a.call("POST", "/api/import/apply", {
        "accountId": card, "text": text, "fileName": name, "profile": p["profile"], "cutoffDate": "2026-09-15",
        "planDrafts": drafts or [], "confirmedMatches": matches or [],
    })


def keys(p, prefix):
    return [m["key"] for m in p["movements"] if m["description"].startswith(prefix) and m["status"] == "new"]


def draft(key, name, match, amount, current, total=12):
    return {"movementKey": key, "type": "msi", "name": name, "matchText": match, "installmentAmount": amount, "totalInstallments": str(total), "currentInstallment": str(current)}


def revert(client, batch_id, origin=BASE):
    return client.call("POST", f"/api/import/batches/{batch_id}/revert", {}, origin=origin)


# ── 1) Carga completa: planes creados + mensualidades de planes existentes ───────────────────────
print("1) Carga con planes nuevos y mensualidades confirmadas de planes existentes")
card, card_main = make_account("Banorte Platinum")
d1(f"INSERT INTO plans (id, workspace_id, card_id, type, name, match_text, currency, total_amount_minor, installment_amount_minor, total_installments, paid_installments, first_charge_date, status) VALUES ('plan-aguila', '{ws_a}', '{card_main}', 'msi', 'Seguro', 'EL AGUILA CIA SEG', 'MXN', {90236 * 12}, 90236, 12, 2, '2026-07-03', 'review')")
d1(f"INSERT INTO plans (id, workspace_id, card_id, type, name, match_text, currency, total_amount_minor, installment_amount_minor, total_installments, paid_installments, first_charge_date, status) VALUES ('plan-final', '{ws_a}', '{card_main}', 'msi', 'Mapfre', 'MAPFRE L COBRANZA', 'MXN', {112312 * 12}, 112312, 12, 11, '2025-10-08', 'active')")
cat = a.call("POST", "/api/categories", {"name": "Despensa", "color": "#2563eb"})[1]["id"]
a.call("POST", "/api/category-rules", {"pattern": "OXXO", "categoryId": cat})
events_before = scalar("SELECT count(*) FROM plan_events")

p = preview(card, CSV)
drafts = [draft(keys(p, "RUMAYA")[0], "Viaje", "RUMAYA TRAVEL", "571.71", 1)] + [draft(k, f"Impuesto {i}", "EDO YUCSAF", "252.25", 4) for i, k in enumerate(keys(p, "EDO YUCSAF"))]
found = {m["planId"]: m for m in p["planMatches"]}
matches = [{"planId": pid, "movementKey": found[pid]["movementKey"]} for pid in ("plan-aguila", "plan-final")]
status, body = import_csv(card, CSV, drafts, matches)
batch1 = body["batchId"]
check("importación aplicada", (201, 105, 3, 2), (status, body["counts"]["movements"], body["counts"]["plansCreated"], body["counts"]["installmentsLinked"]))
check("movimientos categorizados por la regla al importar", True, scalar(f"SELECT count(*) FROM movements WHERE batch_id='{batch1}' AND category_id IS NOT NULL") > 0)
check("el plan 'por revisar' avanzó a 3/12 y quedó activo", (3, "active"), tuple(row("SELECT paid_installments, status FROM plans WHERE id='plan-aguila'").values()))
check("el plan de la última mensualidad quedó liquidado (12/12)", (12, "completed_natural"), tuple(row("SELECT paid_installments, status FROM plans WHERE id='plan-final'").values()))
ev = json.loads(scalar("SELECT data FROM plan_events WHERE plan_id='plan-aguila' AND type='installment_recorded'"))
check("la mensualidad guardó el estado previo del plan", ("review", 2), (ev["previousStatus"], ev["previousPaid"]))
cards_n = scalar(f"SELECT count(*) FROM cards WHERE account_id='{card}'")
check("la carga creó la tarjeta 2455 de la cuenta y ligó cada movimiento a una tarjeta", (2, 0), (cards_n, scalar(f"SELECT count(*) FROM movements WHERE batch_id='{batch1}' AND card_id IS NULL")))
categories_before = scalar(f"SELECT count(*) FROM categories WHERE workspace_id='{ws_a}'")

print("2) Pantalla del historial")
status, html, _ = a.call("GET", "/app/importar/historial", raw=True)
check("la pantalla carga", 200, status)
check("la última carga ofrece deshacer", True, "data-toggle-revert" in html)
check("explica qué se va a deshacer (105 movimientos, 3 planes, 2 mensualidades)", True, "Se eliminarán 105 movimientos. Planes creados por esta carga que se eliminarán: 3. Mensualidades de planes existentes que se desharán: 2." in html)
check("muestra el botón de confirmar", True, "data-confirm-revert" in html)
html_c = c.call("GET", "/app/importar/historial", raw=True)[1]
check("C (solo lectura) ve el historial pero sin botones de deshacer", (True, False), ("Consulta.csv" in html_c, "data-toggle-revert" in html_c))
check("B no ve las cargas de A", False, "Consulta.csv" in b.call("GET", "/app/importar/historial", raw=True)[1])
status, _, loc = admin.call("GET", "/app/importar/historial", raw=True)
check("el admin no usa la app", (302, "/admin"), (status, loc))

print("3) Permisos y rechazos (no deben cambiar nada)")
check("sin sesión", 401, revert(anon, batch1)[0])
check("admin (sin espacio)", 403, revert(admin, batch1)[0])
check("C (solo lectura)", 403, revert(c, batch1)[0])
check("B no puede deshacer cargas de A", 404, revert(b, batch1)[0])
check("origen ajeno", 403, revert(a, batch1, origin="http://evil.test")[0])
check("carga inexistente", 404, revert(a, "no-existe")[0])
check("nada cambió", (105, 3 + 2), (scalar(f"SELECT count(*) FROM movements WHERE batch_id='{batch1}'"), scalar(plans_in(card))))

print("4) Deshacer la carga completa")
status, body = revert(a, batch1)
check("deshacer", (200, 105, 3, 2), (status, body.get("movementsDeleted"), body.get("plansDeleted"), body.get("installmentsUndone")))
check("los movimientos de la carga ya no existen", 0, scalar(f"SELECT count(*) FROM movements WHERE batch_id='{batch1}'"))
check("los planes creados por la carga se eliminaron", 2, scalar(plans_in(card)))
check("…y sus eventos también (solo quedan los de los dos planes que ya existían)", 0, scalar("SELECT count(*) FROM plan_events WHERE plan_id NOT IN ('plan-aguila', 'plan-final')"))
r = row("SELECT paid_installments, status, settled_at FROM plans WHERE id='plan-aguila'")
check("el plan avanzado vuelve a 2/12 y a 'por revisar' (su estado anterior)", (2, "review", None), (r["paid_installments"], r["status"], r["settled_at"]))
r = row("SELECT paid_installments, status, settled_at FROM plans WHERE id='plan-final'")
check("el plan que se había liquidado vuelve a 11/12 y activo", (11, "active", None), (r["paid_installments"], r["status"], r["settled_at"]))
check("el historial del plan conserva el pago y anota la reversión", (1, 1), (scalar("SELECT count(*) FROM plan_events WHERE plan_id='plan-aguila' AND type='installment_recorded'"), scalar("SELECT count(*) FROM plan_events WHERE plan_id='plan-aguila' AND type='reverted'")))
check("el evento del pago ya no apunta a un movimiento borrado", None, scalar("SELECT movement_id FROM plan_events WHERE plan_id='plan-aguila' AND type='installment_recorded'"))
rv = json.loads(scalar("SELECT data FROM plan_events WHERE plan_id='plan-aguila' AND type='reverted'"))
check("la anotación dice a qué estado se restauró", {"paid": 2, "status": "review"}, rv["restored"])
b_row = row(f"SELECT status, reverted_at, summary FROM import_batches WHERE id='{batch1}'")
check("la carga queda registrada como revertida, con quién", ("reverted", True, "Usuario A"), (b_row["status"], b_row["reverted_at"] is not None, json.loads(b_row["summary"])["revert"]["byName"]))
check("se conservan categorías, reglas, tarjetas (también la creada por el CSV) y perfil", (categories_before, 1, cards_n, 1), (scalar(f"SELECT count(*) FROM categories WHERE workspace_id='{ws_a}'"), scalar(f"SELECT count(*) FROM category_rules WHERE workspace_id='{ws_a}'"), scalar(f"SELECT count(*) FROM cards WHERE account_id='{card}'"), scalar(f"SELECT count(*) FROM import_profiles WHERE account_id='{card}'")))
key = scalar(f"SELECT file_key FROM import_batches WHERE id='{batch1}'")
r2 = subprocess.run(["pnpm", "exec", "wrangler", "r2", "object", "get", f"miconta-files/{key}", "--local", "--pipe"], cwd=ROOT, capture_output=True)
check("el archivo original sigue en R2", len(CSV.encode()), len(r2.stdout))
status, body = revert(a, batch1)
check("deshacer otra vez: ya estaba revertida", (409, "ALREADY_REVERTED"), (status, body.get("code")))
html = a.call("GET", "/app/importar/historial", raw=True)[1]
check("el historial la muestra como revertida y sin botón", (True, False), ("Revertida" in html, "data-toggle-revert" in html))

print("5) El archivo se puede volver a importar y todo queda igual que la primera vez")
p = preview(card, CSV)
check("la vista previa vuelve a ver los 105 como nuevos", (105, 0), (p["summary"]["fresh"], p["summary"]["duplicates"]))
check("y vuelve a proponer las mismas mensualidades", ["plan-aguila", "plan-final"], sorted(m["planId"] for m in p["planMatches"]))
found = {m["planId"]: m for m in p["planMatches"]}
matches = [{"planId": pid, "movementKey": found[pid]["movementKey"]} for pid in ("plan-aguila", "plan-final")]
status, body = import_csv(card, CSV, [], matches, name="Reimportado.csv")
check("reimportar funciona", (201, 105, 2), (status, body["counts"]["movements"], body["counts"]["installmentsLinked"]))
batch2 = body["batchId"]
check("el plan 'por revisar' vuelve a avanzar a 3/12", 3, scalar("SELECT paid_installments FROM plans WHERE id='plan-aguila'"))

print("6) Cargas antiguas (sin estado previo guardado): el plan vuelve a activo")
d1(f"UPDATE plan_events SET data = json_remove(data, '$.previousStatus', '$.previousPaid') WHERE batch_id='{batch2}' AND type='installment_recorded'")
status, body = revert(a, batch2)
check("deshacer una carga antigua", (200, 105, 0, 2), (status, body.get("movementsDeleted"), body.get("plansDeleted"), body.get("installmentsUndone")))
check("sin estado previo se asume 'activo'", (2, "active"), tuple(row("SELECT paid_installments, status FROM plans WHERE id='plan-aguila'").values()))

print("7) Solo se deshace la última carga de cada cuenta")
card3 = make_card("Tarjeta con dos cargas")
H = "Fecha,Concepto,Abono,Cargo,Tarjeta\n"
csv1 = H + "01/09/2026,TIENDA UNO Referencia R1,0,10.00,Titular ***1\n02/09/2026,TIENDA DOS Referencia R2,0,20.00,Titular ***1\n"
csv2 = H + "01/10/2026,TIENDA TRES Referencia R3,0,30.00,Titular ***1\n"
first = import_csv(card3, csv1, name="septiembre.csv")[1]["batchId"]
time.sleep(1.1)
second = import_csv(card3, csv2, name="octubre.csv")[1]["batchId"]
html = a.call("GET", "/app/importar/historial", raw=True)[1]
check("solo la última (octubre) ofrece deshacer", (True, True), (html.count("data-toggle-revert") == 1, "Solo se puede deshacer la última carga de cada cuenta" in html))
status, body = revert(a, first)
check("deshacer septiembre antes que octubre: rechazado", (409, "NOT_LATEST"), (status, body.get("code")))
check("no se tocó nada", 3, scalar(f"SELECT count(*) FROM movements WHERE account_id='{card3}'"))
check("deshacer octubre", (200, 1), (lambda r: (r[0], r[1].get("movementsDeleted")))(revert(a, second)))
check("ahora septiembre es la última y se puede deshacer", (200, 2), (lambda r: (r[0], r[1].get("movementsDeleted")))(revert(a, first)))
check("la tarjeta quedó sin movimientos", 0, scalar(f"SELECT count(*) FROM movements WHERE account_id='{card3}'"))
check("las cargas de otras tarjetas no influyen en cuál es la última", True, scalar(f"SELECT count(*) FROM import_batches WHERE account_id='{card}' AND status='reverted'") == 2)

print("8) No se pierde trabajo del usuario: si el plan cambió después, se bloquea")
card4 = make_card("Tarjeta con plan editado")
csv_plan = H + "08/09/2026,RUMAYA TRAVEL LP Referencia R9,0,571.71,Titular ***1\n"
p4 = preview(card4, csv_plan)
batch4 = import_csv(card4, csv_plan, [draft(p4["movements"][0]["key"], "Viaje", "RUMAYA TRAVEL", "571.71", 1)], name="viaje.csv")[1]["batchId"]
plan4 = scalar(f"SELECT id FROM plans WHERE card_id IN (SELECT id FROM cards WHERE account_id='{card4}')")
check("el usuario edita el plan después de la carga", 200, a.call("PATCH", f"/api/plans/{plan4}", {"name": "Viaje a Mérida", "type": "msi", "matchText": "RUMAYA TRAVEL", "installmentAmount": "571.71", "totalAmount": "6,860.52", "totalInstallments": "12", "paidInstallments": "1", "firstChargeDate": "2026-09-08", "interestRate": "", "comment": "ajuste"})[0])
html = a.call("GET", "/app/importar/historial", raw=True)[1]
check("la pantalla explica qué plan lo impide y no ofrece confirmar", (True, True, False), ("Viaje a Mérida" in html, "se editó, se liquidó o se registró otro pago" in html, 'data-confirm-revert' in html.split("viaje.csv")[1].split("</section>")[0]))
status, body = revert(a, batch4)
check("deshacer: bloqueado con el plan que lo impide", (409, "PLANS_CHANGED", [plan4]), (status, body.get("code"), [x["planId"] for x in body.get("blockers", [])]))
check("no se tocó nada (movimiento, plan y su historial siguen)", (1, 1, "Viaje a Mérida"), (scalar(f"SELECT count(*) FROM movements WHERE batch_id='{batch4}'"), scalar(f"SELECT count(*) FROM plans WHERE id='{plan4}'"), scalar(f"SELECT name FROM plans WHERE id='{plan4}'")))
check("la carga sigue como aplicada", "applied", scalar(f"SELECT status FROM import_batches WHERE id='{batch4}'"))

print("9) Un plan liquidado a mano después de la carga también bloquea")
card5 = make_card("Tarjeta con plan liquidado")
p5 = preview(card5, csv_plan.replace("R9", "R10"))
batch5 = import_csv(card5, csv_plan.replace("R9", "R10"), [draft(p5["movements"][0]["key"], "Otro viaje", "RUMAYA TRAVEL", "571.71", 1)], name="otro.csv")[1]["batchId"]
plan5 = scalar(f"SELECT id FROM plans WHERE card_id IN (SELECT id FROM cards WHERE account_id='{card5}')")
check("el usuario liquida el plan a mano", 200, a.call("POST", f"/api/plans/{plan5}/settle", {"comment": "pagado en sucursal"})[0])
status, body = revert(a, batch5)
check("deshacer: bloqueado", (409, "PLANS_CHANGED"), (status, body.get("code")))
check("el plan sigue liquidado", "settled_manual", scalar(f"SELECT status FROM plans WHERE id='{plan5}'"))

print("10) Atomicidad: si algo falla a mitad de la reversión, NO se toca nada")
card6 = make_card("Tarjeta para forzar un fallo")
csv6 = csv_plan.replace("R9", "R60")
p6 = preview(card6, csv6)
batch6 = import_csv(card6, csv6, [draft(p6["movements"][0]["key"], "Plan atómico", "RUMAYA TRAVEL", "571.71", 1)], name="atomico.csv")[1]["batchId"]
plan6 = scalar(f"SELECT id FROM plans WHERE card_id IN (SELECT id FROM cards WHERE account_id='{card6}')")
mov6 = scalar(f"SELECT id FROM movements WHERE batch_id='{batch6}'")
snapshot = lambda: (
    scalar(f"SELECT count(*) FROM movements WHERE batch_id='{batch6}'"),
    scalar(f"SELECT count(*) FROM plans WHERE id='{plan6}'"),
    scalar(f"SELECT count(*) FROM plan_events WHERE plan_id='{plan6}'"),
    scalar(f"SELECT status FROM import_batches WHERE id='{batch6}'"),
)
link_before = scalar(f"SELECT movement_id FROM plan_events WHERE plan_id='{plan6}' AND type='installment_recorded'")
before = snapshot()
# Un obstáculo que las reglas de negocio NO ven: un evento de OTRO espacio, sobre un plan de ese espacio, que apunta
# a un movimiento de la carga. Al borrar los movimientos chocará con la llave foránea, cuando la transacción ya
# anuló el vínculo de los eventos legítimos: si de verdad es atómica, ese vínculo debe seguir intacto.
ws_b = scalar("SELECT id FROM workspaces WHERE name='Usuario B'")
card_b = make_account("Cuenta de B", client=b, last4="5555")[1]
d1(f"INSERT INTO plans (id, workspace_id, card_id, type, name, match_text, currency, total_amount_minor, installment_amount_minor, total_installments, paid_installments, first_charge_date, status) VALUES ('plan-de-b', '{ws_b}', '{card_b}', 'msi', 'Plan de B', 'X', 'MXN', 1200, 100, 12, 0, '2026-01-01', 'active')")
d1(f"INSERT INTO plan_events (id, workspace_id, plan_id, type, actor_user_id, movement_id) VALUES ('evento-ajeno', '{ws_b}', 'plan-de-b', 'edited', '{ids['b@miconta.test']}', '{mov6}')")
status, body = revert(a, batch6)
check("la transacción falla con un error limpio", (500, "REVERT_FAILED"), (status, body.get("code")))
check("el movimiento, el plan y el estado de la carga siguen igual", before, snapshot())
check("y el vínculo del evento (que la transacción ya había anulado) se restauró", link_before, scalar(f"SELECT movement_id FROM plan_events WHERE plan_id='{plan6}' AND type='installment_recorded'"))
check("sin eventos 'reverted' a medias", 0, scalar(f"SELECT count(*) FROM plan_events WHERE plan_id='{plan6}' AND type='reverted'"))
d1("DELETE FROM plan_events WHERE id='evento-ajeno'")
check("quitado el obstáculo, se puede deshacer", (200, 1, 1), (lambda r: (r[0], r[1].get("movementsDeleted"), r[1].get("plansDeleted")))(revert(a, batch6)))

print("11) Sin datos huérfanos tras todo lo anterior")
check("sin movimientos que apunten a planes inexistentes", 0, scalar("SELECT count(*) FROM movements WHERE plan_id IS NOT NULL AND plan_id NOT IN (SELECT id FROM plans)"))
check("sin eventos de planes inexistentes", 0, scalar("SELECT count(*) FROM plan_events WHERE plan_id NOT IN (SELECT id FROM plans)"))
check("sin movimientos de cargas revertidas", 0, scalar("SELECT count(*) FROM movements WHERE batch_id IN (SELECT id FROM import_batches WHERE status='reverted')"))

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
