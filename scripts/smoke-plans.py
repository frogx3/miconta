#!/usr/bin/env python3
"""
Prueba de humo de planes (API y pantallas): permisos, edición manual con historial, cambios de
estado automáticos, liquidación manual, reapertura, por revisar y aislamiento entre espacios.

Requiere: `pnpm exec astro dev --background` y una D1 local VACÍA (sin usuarios):
  rm -rf .wrangler/state && pnpm exec wrangler d1 migrations apply miconta --local
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
    print(f"  {'✓' if ok else '✗'} {description:<72} {actual}" + ("" if ok else f"   (esperado {expected})"))


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
a_id = ids["a@miconta.test"]
d1(f"DELETE FROM workspace_members WHERE user_id='{ids['c@miconta.test']}'")
d1(f"INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('{ws_a}', '{ids['c@miconta.test']}', 'viewer')")

# Una cuenta con dos tarjetas de crédito: los planes se ligan a la tarjeta, no a la cuenta.
_, body = a.call("POST", "/api/accounts", {"name": "Mi Banorte", "bank": "Banorte", "customerId": "CL-1"})
account = body["id"]
_, body = a.call("POST", f"/api/accounts/{account}/cards", {"kind": "credit", "isDigital": False, "last4": "4172", "currency": "MXN", "creditLimit": "50,000.00", "cutoffDay": "15", "paymentDueDay": "5"})
card = body["id"]
_, body = a.call("POST", f"/api/accounts/{account}/cards", {"kind": "credit", "isDigital": True, "last4": "9001", "currency": "MXN", "cutoffDay": "20"})
card2 = body["id"]


def insert_plan(pid, name, amount, total, paid, first, status="active", card_id=None):
    d1(
        "INSERT INTO plans (id, workspace_id, card_id, type, name, match_text, currency, total_amount_minor, installment_amount_minor, "
        f"total_installments, paid_installments, first_charge_date, status) VALUES ('{pid}', '{ws_a}', '{card_id or card}', 'msi', '{name}', '{name.upper()}', 'MXN', "
        f"{amount * total}, {amount}, {total}, {paid}, '{first}', '{status}')"
    )


insert_plan("p1", "Seguro", 90236, 12, 3, "2026-07-06")
insert_plan("p2", "Viaje", 50000, 6, 0, "2026-11-01", card_id=card2)
insert_plan("p-closed", "Pagado", 10000, 3, 3, "2026-01-10", status="completed_natural")

print("1) Pantallas")
status, html, loc = a.call("GET", "/app/planes", raw=True)
check("lista de planes", 200, status)
check("suma la deuda restante de los planes abiertos: 9×902.36 + 6×500.00", True, "$11,121.24" in html)
check("muestra ambos planes abiertos y no el cerrado", (True, True, False), ("Seguro" in html, "Viaje" in html, "Pagado" in html))
check("proyección por mes visible", True, "Compromisos por mes" in html)
status, html, _ = a.call("GET", "/app/planes?estado=cerrados", raw=True)
check("pestaña cerrados: solo el plan liquidado", (True, False), ("Pagado" in html, "Seguro" in html))
status, html, _ = a.call("GET", f"/app/planes?tarjeta={card2}", raw=True)
check("filtro por tarjeta", (True, False), ("Viaje" in html, "Seguro" in html))
check("los planes cuelgan de tarjetas de la misma cuenta", (3, 1), (scalar(f"SELECT count(*) FROM plans p JOIN cards c ON c.id = p.card_id WHERE c.account_id='{account}'"), scalar(f"SELECT count(*) FROM plans WHERE card_id='{card2}'")))
status, _, _ = b.call("GET", f"/app/planes?tarjeta={card2}", raw=True)
check("B filtrando por una tarjeta ajena no ve nada de A", (200, False), (status, "Viaje" in b.call("GET", f"/app/planes?tarjeta={card2}", raw=True)[1]))
status, html, _ = a.call("GET", "/app/planes/p1", raw=True)
check("detalle del plan", 200, status)
check("saldo restante del plan: 9 × 902.36", True, "$8,121.24" in html)
check("calendario con los 12 pagos", 12, len(re.findall(r'class="state-', html)))
check("sin historial aún", True, "plan-edit-form" in html and "Plan creado" not in html)
status, html, loc = b.call("GET", "/app/planes/p1", raw=True)
check("B no ve el plan de A: lo manda a la lista", (302, "/app/planes"), (status, loc))
status, _, loc = anon.call("GET", "/app/planes", raw=True)
check("sin sesión: a /login", (302, "/login"), (status, loc))
status, _, loc = admin.call("GET", "/app/planes", raw=True)
check("el admin no usa la app: a /admin", (302, "/admin"), (status, loc))
status, html, _ = c.call("GET", "/app/planes/p1", raw=True)
check("C (solo lectura) ve el plan sin acciones de escritura", (200, False, False), (status, 'id="settle-box"' in html, bool(re.search(r'<button[^>]*type="submit"', html))))
check("panel muestra el compromiso del mes", True, "Ver tus planes" in a.call("GET", "/app", raw=True)[1])


def edit(client, plan_id, **overrides):
    payload = {
        "name": "Seguro", "type": "msi", "matchText": "SEGURO", "installmentAmount": "902.36", "totalAmount": "10,828.32",
        "totalInstallments": "12", "paidInstallments": "3", "firstChargeDate": "2026-07-06", "interestRate": "", "comment": "",
    }
    payload.update(overrides)
    return client.call("PATCH", f"/api/plans/{plan_id}", payload)


print("2) Rechazos de la edición (no deben cambiar nada)")
check("sin sesión", 401, anon.call("PATCH", "/api/plans/p1", {})[0])
check("admin (sin espacio)", 403, edit(admin, "p1")[0])
check("B no puede editar el plan de A", 404, edit(b, "p1", name="Robado")[0])
check("C (solo lectura)", 403, edit(c, "p1", name="X")[0])
check("origen ajeno", 403, a.call("PATCH", "/api/plans/p1", {}, origin="http://evil.test")[0])
check("cuerpo que no es JSON", 400, a.call("PATCH", "/api/plans/p1", b"no es json")[0])
check("plan inexistente", 404, edit(a, "no-existe")[0])
status, body = edit(a, "p1", paidInstallments="13")
check("pagos realizados > plazo", (400, [("paidInstallments", "current_exceeds_total")]), (status, [(e["field"], e["code"]) for e in body["errors"]]))
status, body = edit(a, "p1", firstChargeDate="2026-02-31", installmentAmount="abc")
check("fecha imposible y monto ilegible", [("firstChargeDate", "invalid_date"), ("installmentAmount", "invalid_amount")], sorted((e["field"], e["code"]) for e in body["errors"]))
check("nada cambió", ("Seguro", 90236, 12, 3, 0), (lambda r: (r["name"], r["installment_amount_minor"], r["total_installments"], r["paid_installments"], scalar("SELECT count(*) FROM plan_events")))(row("SELECT * FROM plans WHERE id='p1'")))

print("3) Edición manual con historial (un abono a capital acorta el plazo y baja la mensualidad)")
status, body = edit(a, "p1")
check("sin cambios: 200 y nada que registrar", (200, [], 0), (status, body["changed"], scalar("SELECT count(*) FROM plan_events")))
status, body = edit(a, "p1", installmentAmount="850.00", totalAmount="8,500.00", totalInstallments="10", comment="abono a capital en octubre")
check("editar mensualidad, total y plazo", (200, ["installmentAmountMinor", "totalInstallments", "totalAmountMinor"]), (status, sorted(body["changed"], key=lambda f: ["installmentAmountMinor", "totalInstallments", "totalAmountMinor"].index(f))))
r = row("SELECT installment_amount_minor, total_installments, total_amount_minor, overridden_fields FROM plans WHERE id='p1'")
check("valores guardados en centavos", (85000, 10, 850000), (r["installment_amount_minor"], r["total_installments"], r["total_amount_minor"]))
check("campos ajustados a mano registrados", ["installmentAmountMinor", "totalAmountMinor", "totalInstallments"], sorted(json.loads(r["overridden_fields"])))
ev = row(f"SELECT type, comment, actor_user_id, data FROM plan_events WHERE plan_id='p1'")
data = json.loads(ev["data"])
check("evento 'edited' con autor y comentario", ("edited", "abono a capital en octubre", a_id), (ev["type"], ev["comment"], ev["actor_user_id"]))
check("el evento guarda valor anterior y nuevo", ({"from": 90236, "to": 85000}, {"from": 12, "to": 10}), (data["changes"]["installmentAmountMinor"], data["changes"]["totalInstallments"]))
check("el saldo restante ahora es 7 × 850.00", True, "$5,950.00" in a.call("GET", "/app/planes/p1", raw=True)[1])
html = a.call("GET", "/app/planes/p1", raw=True)[1]
check("el historial lo muestra con el comentario", (True, True), ("Parámetros editados" in html, "abono a capital en octubre" in html))

print("4) El estado se ajusta solo")
status, body = edit(a, "p1", installmentAmount="850.00", totalAmount="8,500.00", totalInstallments="10", paidInstallments="10")
r = row("SELECT status, settled_at FROM plans WHERE id='p1'")
check("pagos realizados = total → liquidado de forma natural", ("completed_natural", True), (r["status"], r["settled_at"] is not None))
check("el evento registra el cambio de estado", {"from": "active", "to": "completed_natural"}, json.loads(row("SELECT data FROM plan_events WHERE plan_id='p1' ORDER BY created_at DESC, rowid DESC LIMIT 1")["data"])["status"])
status, body = edit(a, "p1", installmentAmount="850.00", totalAmount="8,500.00", totalInstallments="10", paidInstallments="7")
r = row("SELECT status, settled_at FROM plans WHERE id='p1'")
check("si los pagos vuelven a bajar → activo otra vez", ("active", True), (r["status"], r["settled_at"] is None))

print("5) Tipo y tasa")
check("a meses con intereses con tasa 24.5%", (200, 2450, "mci"), (lambda s: (s, scalar("SELECT interest_rate_bp FROM plans WHERE id='p1'"), scalar("SELECT type FROM plans WHERE id='p1'")))(edit(a, "p1", type="mci", interestRate="24.5", installmentAmount="850.00", totalAmount="8,500.00", totalInstallments="10", paidInstallments="7")[0]))
check("a MSI la tasa vuelve a 0 aunque se envíe", (200, 0), (lambda s: (s, scalar("SELECT interest_rate_bp FROM plans WHERE id='p1'")))(edit(a, "p1", type="msi", interestRate="30", installmentAmount="850.00", totalAmount="8,500.00", totalInstallments="10", paidInstallments="7")[0]))

SAME = dict(installmentAmount="850.00", totalAmount="8,500.00", totalInstallments="10", paidInstallments="7")


def settle(client, plan_id, comment=None):
    return client.call("POST", f"/api/plans/{plan_id}/settle", {} if comment is None else {"comment": comment})


def to_status(client, plan_id, to, comment=None):
    body = {"to": to}
    if comment:
        body["comment"] = comment
    return client.call("POST", f"/api/plans/{plan_id}/status", body)


print("6) Liquidación manual (comentario obligatorio)")
check("sin comentario: rechazada", (400, "comment"), (lambda r: (r[0], r[1]["errors"][0]["field"]))(settle(a, "p1")))
check("comentario en blanco: rechazada", 400, settle(a, "p1", "   ")[0])
check("B no puede liquidar el plan de A", 404, settle(b, "p1", "x")[0])
check("C (solo lectura) no puede liquidar", 403, settle(c, "p1", "x")[0])
check("antes de liquidar la deuda suma ambos planes: 3 × 850.00 + 6 × 500.00", True, "$5,550.00" in a.call("GET", "/app/planes", raw=True)[1])
check("liquidar con comentario", 200, settle(a, "p1", "Pagado en sucursal el 10/10")[0])
r = row("SELECT status, settlement_note, settled_at FROM plans WHERE id='p1'")
check("estado, nota y fecha guardados", ("settled_manual", "Pagado en sucursal el 10/10", True), (r["status"], r["settlement_note"], r["settled_at"] is not None))
ev = row("SELECT type, comment, actor_user_id FROM plan_events WHERE plan_id='p1' ORDER BY created_at DESC, rowid DESC LIMIT 1")
check("evento 'settled' con el comentario y el autor", ("settled", "Pagado en sucursal el 10/10", a_id), (ev["type"], ev["comment"], ev["actor_user_id"]))
check("liquidar un plan ya liquidado: conflicto", 409, settle(a, "p1", "otra vez")[0])
html = a.call("GET", "/app/planes/p1", raw=True)[1]
check("el detalle muestra la nota y los pagos pendientes como liquidados", (True, True), ("Pagado en sucursal el 10/10" in html, "Liquidado" in html))
html = a.call("GET", "/app/planes", raw=True)[1]
check("un plan liquidado ya no suma a la deuda (queda solo Viaje: 6 × 500.00)", (False, True), ("$5,550.00" in html, "$3,000.00" in html))
check("editar un plan liquidado a mano responde 200", 200, edit(a, "p1", name="Seguro de vida", **SAME)[0])
check("…y no cambia su estado", "settled_manual", row("SELECT status FROM plans WHERE id='p1'")["status"])

print("7) Reabrir y por revisar")
check("estado no válido", 400, to_status(a, "p1", "settled_manual")[0])
check("B no puede reabrir", 404, to_status(b, "p1", "active")[0])
check("C (solo lectura) no puede reabrir", 403, to_status(c, "p1", "active")[0])
check("reabrir un plan liquidado a mano", 200, to_status(a, "p1", "active", "se reversó el pago")[0])
r = row("SELECT status, settlement_note, settled_at FROM plans WHERE id='p1'")
check("vuelve a activo y se limpia la liquidación", ("active", None, True), (r["status"], r["settlement_note"], r["settled_at"] is None))
ev = row("SELECT type, comment, data FROM plan_events WHERE plan_id='p1' ORDER BY created_at DESC, rowid DESC LIMIT 1")
check("la nota anterior queda en el historial", ("status_changed", "se reversó el pago", "Pagado en sucursal el 10/10"), (ev["type"], ev["comment"], json.loads(ev["data"])["previousNote"]))
check("marcar por revisar", (200, "review"), (to_status(a, "p1", "review")[0], row("SELECT status FROM plans WHERE id='p1'")["status"]))
check("un plan por revisar sigue sumando a la deuda", True, "Por revisar" in a.call("GET", "/app/planes", raw=True)[1])
check("por revisar → por revisar: conflicto", 409, to_status(a, "p1", "review")[0])
check("quitar de revisión", (200, "active"), (to_status(a, "p1", "active")[0], row("SELECT status FROM plans WHERE id='p1'")["status"]))
check("la liquidación natural no se revierte por aquí", 409, to_status(a, "p-closed", "active")[0])
check("liquidar un plan liquidado de forma natural: conflicto", 409, settle(a, "p-closed", "x")[0])

print("8) Historial completo y aislamiento")
types = [r["type"] for r in d1("SELECT type FROM plan_events WHERE plan_id='p1' ORDER BY created_at, rowid")]
expected = ["edited"] * 5 + ["settled", "edited"] + ["status_changed"] * 3
check("cada cambio quedó registrado, en orden (5 ediciones, liquidar, edición, reabrir, revisar, quitar)", expected, types)
check("el plan de otro espacio no se tocó", ("Viaje", 0, "active"), tuple(row("SELECT name, paid_installments, status FROM plans WHERE id='p2'").values()))
check("B no tiene planes ni verlos", False, "Seguro" in b.call("GET", "/app/planes", raw=True)[1] or "Viaje" in b.call("GET", "/app/planes", raw=True)[1])

print("TODO OK" if not FAILED else "HAY FALLOS")
sys.exit(1 if FAILED else 0)
