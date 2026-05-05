"""
api.py  —  Dew Point POS  |  Backend REST para la PWA
=======================================================
Expone database.py como una API REST que consume la PWA del celular.
Corre en paralelo a la app de escritorio (usa el mismo database.py).

INSTALACIÓN (una sola vez):
    pip install flask flask-cors

EJECUCIÓN:
    python api.py

    Por defecto escucha en http://0.0.0.0:5000
    El celular accede via http://192.168.X.X:5000  (misma red WiFi)
    Para HTTPS (instalación PWA) usa ngrok:  ngrok http 5000

SEGURIDAD:
    - Los tokens de sesión son UUID aleatorios guardados en memoria.
    - Cada request valida el token antes de tocar la BD.
    - En producción usa HTTPS siempre (ngrok, Vercel, etc.).
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import database as db
import threading
import uuid
import os
import json
from datetime import datetime, date

# ════════════════════════════════════════════════════════════════════════════
#  CONFIGURACIÓN
# ════════════════════════════════════════════════════════════════════════════
app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)  # Permite peticiones desde cualquier origen (el celular)

# Sesiones activas: { token: { "username": str, "tenant_url": str } }
_sesiones: dict = {}
_sesiones_lock = threading.Lock()


# ════════════════════════════════════════════════════════════════════════════
#  HELPERS
# ════════════════════════════════════════════════════════════════════════════
def _get_sesion():
    """Valida el token del header y retorna la sesión, o None si es inválido."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:]
    with _sesiones_lock:
        return _sesiones.get(token)


def _requerir_sesion():
    """Decorador alternativo: retorna (sesion, error_response)."""
    sesion = _get_sesion()
    if not sesion:
        return None, (jsonify({"ok": False, "error": "No autenticado"}), 401)
    # Actualizar tenant activo para este hilo
    db.set_active_conn_url(sesion["tenant_url"])
    return sesion, None


def _json_serial(obj):
    """Serializa tipos Python que json no sabe manejar (date, datetime)."""
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    raise TypeError(f"Tipo no serializable: {type(obj)}")


def ok(data=None, **kwargs):
    """Respuesta exitosa estandarizada."""
    payload = {"ok": True}
    if data is not None:
        payload.update(data if isinstance(data, dict) else {"data": data})
    payload.update(kwargs)
    return jsonify(json.loads(json.dumps(payload, default=_json_serial)))


def err(msg, status=400):
    """Respuesta de error estandarizada."""
    return jsonify({"ok": False, "error": msg}), status


# ════════════════════════════════════════════════════════════════════════════
#  SERVIR LA PWA (archivos estáticos)
# ════════════════════════════════════════════════════════════════════════════
@app.route("/")
def index():
    """Sirve la PWA directamente desde Flask."""
    return send_from_directory(".", "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    """Sirve CSS, JS, iconos, manifest, sw.js, etc."""
    return send_from_directory(".", filename)


# ════════════════════════════════════════════════════════════════════════════
#  AUTENTICACIÓN
#  database.verificar_login() → token UUID
# ════════════════════════════════════════════════════════════════════════════
@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()

    if not username or not password:
        return err("Completa usuario y contraseña")

    try:
        resultado = db.verificar_login(username, password)
    except RuntimeError as e:
        return err(str(e))
    except Exception as e:
        return err(f"Error de conexión: {e}", 503)

    if not resultado:
        return err("Usuario o contraseña incorrectos", 401)

    # Crear token de sesión
    token = str(uuid.uuid4())
    with _sesiones_lock:
        _sesiones[token] = {
            "username":   resultado["username"],
            "tenant_url": resultado["conn_url"],
        }

    return ok({"token": token, "username": resultado["username"]})


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
        with _sesiones_lock:
            _sesiones.pop(token, None)
    return ok()


# ════════════════════════════════════════════════════════════════════════════
#  DASHBOARD — Stats
#  database.get_stats_rango()
# ════════════════════════════════════════════════════════════════════════════
@app.route("/api/stats")
def stats():
    sesion, error = _requerir_sesion()
    if error:
        return error
    desde = request.args.get("desde")
    hasta = request.args.get("hasta")
    tipo  = request.args.get("tipo")
    try:
        data = db.get_stats_rango(
            fecha_desde=desde or None,
            fecha_hasta=hasta or None,
            tipo=tipo or None,
        )
        return ok(data)
    except Exception as e:
        return err(str(e), 503)


# ════════════════════════════════════════════════════════════════════════════
#  PERFUMES
#  database.get_perfumes / get_perfume / crear_perfume /
#           editar_perfume / eliminar_perfume / reponer_stock
# ════════════════════════════════════════════════════════════════════════════
@app.route("/api/perfumes")
def get_perfumes():
    sesion, error = _requerir_sesion()
    if error:
        return error
    q = request.args.get("q", "")
    solo_activos = request.args.get("activos", "true").lower() != "false"
    try:
        perfumes = db.get_perfumes(query=q, solo_activos=solo_activos)
        # Agregar costo_por_ml calculado para el frontend
        for p in perfumes:
            ml = float(p.get("ml_totales") or 1)
            costo = float(p.get("costo_total") or 0)
            p["costo_por_ml"] = round(costo / ml, 4) if ml > 0 else 0
        return ok({"perfumes": perfumes})
    except Exception as e:
        return err(str(e), 503)


@app.route("/api/perfumes/<int:perfume_id>")
def get_perfume(perfume_id):
    sesion, error = _requerir_sesion()
    if error:
        return error
    try:
        p = db.get_perfume(perfume_id)
        if not p:
            return err("Perfume no encontrado", 404)
        return ok(p)
    except Exception as e:
        return err(str(e), 503)


@app.route("/api/perfumes", methods=["POST"])
def crear_perfume():
    sesion, error = _requerir_sesion()
    if error:
        return error
    d = request.get_json(silent=True) or {}
    try:
        ml_totales = float(d.get("ml_totales", 0))
        tipo_venta = d.get("tipo_venta", "decants")
        unidades   = int(d.get("unidades", 1))
        # ml_disponibles_inicial = unidades × ml para botellas
        ml_disp_ini = None
        if tipo_venta in ("botella", "parcial") and unidades >= 1:
            ml_disp_ini = ml_totales * unidades

        resultado = db.crear_perfume(
            nombre       = d.get("nombre", ""),
            marca        = d.get("marca", ""),
            ml_totales   = ml_totales,
            costo_total  = int(d.get("costo_total", 0)),
            precios_dict = d.get("precios", {}),
            precio_botella = int(d.get("precio_botella", 0)),
            tipo_venta   = tipo_venta,
            unidades     = unidades,
            ml_disponibles_inicial = ml_disp_ini,
        )
        if not resultado:
            return err("Error al crear perfume")
        return ok({"perfume": resultado})
    except Exception as e:
        return err(str(e))


@app.route("/api/perfumes/<int:perfume_id>", methods=["PUT"])
def editar_perfume(perfume_id):
    sesion, error = _requerir_sesion()
    if error:
        return error
    d = request.get_json(silent=True) or {}
    try:
        # Calcular ml_disponibles según unidades si es botella
        ml_totales     = float(d.get("ml_totales", 0))
        tipo_venta     = d.get("tipo_venta", "decants")
        unidades       = int(d.get("unidades", 1))
        ml_disponibles = d.get("ml_disponibles")

        # Si es botella y vienen unidades, calcular ml_disponibles
        if tipo_venta in ("botella", "parcial") and unidades >= 1:
            ml_disponibles = ml_totales * unidades

        result = db.editar_perfume(
            perfume_id   = perfume_id,
            nombre       = d.get("nombre", ""),
            marca        = d.get("marca", ""),
            ml_totales   = ml_totales,
            costo_total  = int(d.get("costo_total", 0)),
            precios_dict = d.get("precios", {}),
            precio_botella = int(d.get("precio_botella", 0)),
            tipo_venta   = tipo_venta,
            ml_disponibles = ml_disponibles,
        )
        # editar_perfume retorna el perfume actualizado (dict) o None/False en error
        if result is None or result is False:
            return err("Error al editar perfume")
        return ok()
    except Exception as e:
        return err(str(e))


@app.route("/api/perfumes/<int:perfume_id>", methods=["DELETE"])
def eliminar_perfume(perfume_id):
    sesion, error = _requerir_sesion()
    if error:
        return error
    try:
        db.eliminar_perfume(perfume_id)
        return ok()
    except Exception as e:
        return err(str(e))


@app.route("/api/perfumes/<int:perfume_id>/reponer", methods=["POST"])
def reponer_stock(perfume_id):
    sesion, error = _requerir_sesion()
    if error:
        return error
    d = request.get_json(silent=True) or {}
    try:
        ok_result, msg, ml_disp = db.reponer_stock(
            perfume_id    = perfume_id,
            ml_nuevos     = float(d.get("ml_nuevos", 0)),
            costo_adicional = int(d.get("costo_adicional", 0)),
        )
        if not ok_result:
            return err(msg or "Error al reponer")
        return ok({"ml_disponibles": ml_disp})
    except Exception as e:
        return err(str(e))


# ════════════════════════════════════════════════════════════════════════════
#  CLIENTES
#  database.get_clientes / crear_cliente / editar_cliente / eliminar_cliente
# ════════════════════════════════════════════════════════════════════════════
@app.route("/api/clientes")
def get_clientes():
    sesion, error = _requerir_sesion()
    if error:
        return error
    q = request.args.get("q", "")
    try:
        clientes = db.get_clientes(query=q)
        # Calcular total_comprado sumando ventas reales por cliente
        try:
            from database import get_conn
            conn = get_conn()
            rows = conn.execute("""
                SELECT cliente_id,
                       COALESCE(SUM(total), 0)::float AS total_comprado,
                       COUNT(id)::int AS n_ventas,
                       COALESCE(SUM(CASE WHEN estado_pago IN ('Pendiente','Parcial') THEN total ELSE 0 END), 0)::float AS saldo_pendiente
                FROM ventas
                WHERE cliente_id IS NOT NULL
                GROUP BY cliente_id
            """).fetchall()
            conn.close()
            totales = {int(dict(r)["cliente_id"]): dict(r) for r in rows}
        except Exception as ex:
            totales = {}

        for c in clientes:
            c.setdefault("rut", "")
            c.setdefault("telefono", "")
            c.setdefault("instagram", "")
            c.setdefault("email", "")
            info = totales.get(int(c.get("id", 0)), {})
            c["total_comprado"] = float(info.get("total_comprado", 0))
            c["total_compras"]  = c["total_comprado"]
            c["n_ventas"]       = int(info.get("n_ventas", c.get("compras", 0)))
            c["compras"]        = c["n_ventas"]
            c["saldo_pendiente"]= float(info.get("saldo_pendiente", 0))
        return ok({"clientes": clientes})
    except Exception as e:
        return err(str(e), 503)


@app.route("/api/clientes/anonimo", methods=["POST"])
def get_or_create_anonimo():
    """Retorna el cliente anónimo fijo (o lo crea si no existe). Sincroniza con la app de PC."""
    sesion, error = _requerir_sesion()
    if error:
        return error
    try:
        cliente = db.get_or_create_anonimo()
        return ok({"cliente": cliente})
    except Exception as e:
        return err(str(e), 503)


@app.route("/api/clientes/<int:cliente_id>")
def get_cliente(cliente_id):
    sesion, error = _requerir_sesion()
    if error:
        return error
    try:
        c = db.get_cliente(cliente_id)
        if not c:
            return err("Cliente no encontrado", 404)
        return ok(c)
    except Exception as e:
        return err(str(e), 503)


@app.route("/api/clientes", methods=["POST"])
def crear_cliente():
    sesion, error = _requerir_sesion()
    if error:
        return error
    d = request.get_json(silent=True) or {}
    try:
        resultado = db.crear_cliente(
            nombre    = d.get("nombre", ""),
            rut       = d.get("rut", ""),
            telefono  = d.get("telefono", ""),
            instagram = d.get("instagram", ""),
            email     = d.get("email", ""),
            notas     = d.get("notas", ""),
        )
        if not resultado:
            return err("Error al crear cliente")
        return ok({"cliente": resultado})
    except Exception as e:
        return err(str(e))


@app.route("/api/clientes/<int:cliente_id>", methods=["PUT"])
def editar_cliente(cliente_id):
    sesion, error = _requerir_sesion()
    if error:
        return error
    d = request.get_json(silent=True) or {}
    try:
        # Obtener el RUT actual del cliente para evitar falso UniqueViolation
        # cuando el RUT no cambió
        try:
            from database import get_conn
            conn = get_conn()
            row = conn.execute("SELECT rut FROM clientes WHERE id=%s", (cliente_id,)).fetchone()
            conn.close()
            rut_actual = (dict(row)["rut"] if row else "") or ""
        except Exception:
            rut_actual = ""

        rut_nuevo = (d.get("rut") or "").strip()
        # Si el RUT no cambió, pasar el mismo valor (no genera UniqueViolation)
        # Si cambió a vacío, pasar vacío (permitido por el índice parcial WHERE rut <> '')
        rut_a_usar = rut_nuevo

        resultado = db.editar_cliente(
            cliente_id = cliente_id,
            nombre     = d.get("nombre", ""),
            rut        = rut_a_usar,
            telefono   = d.get("telefono", ""),
            instagram  = d.get("instagram", ""),
            email      = d.get("email", ""),
            notas      = d.get("notas", ""),
        )
        if resultado is None:
            return err("Error al editar cliente")
        return ok()
    except ValueError as e:
        return err(str(e))
    except Exception as e:
        return err(str(e))


@app.route("/api/clientes/<int:cliente_id>", methods=["DELETE"])
def eliminar_cliente(cliente_id):
    sesion, error = _requerir_sesion()
    if error:
        return error
    try:
        db.eliminar_cliente(cliente_id)
        return ok()
    except Exception as e:
        return err(str(e))


# ════════════════════════════════════════════════════════════════════════════
#  VENTAS
#  database.get_ventas / crear_venta / get_detalle_venta / marcar_pagado
# ════════════════════════════════════════════════════════════════════════════
@app.route("/api/ventas")
def get_ventas():
    sesion, error = _requerir_sesion()
    if error:
        return error
    q      = request.args.get("q", "")
    estado = request.args.get("estado", "Todos")
    try:
        ventas = db.get_ventas(query=q, filtro_estado=estado)
        return ok({"ventas": ventas})
    except Exception as e:
        return err(str(e), 503)


@app.route("/api/ventas", methods=["POST"])
def crear_venta():
    sesion, error = _requerir_sesion()
    if error:
        return error
    d = request.get_json(silent=True) or {}
    try:
        ok_result, msg, venta_id = db.crear_venta(
            cliente_id   = d.get("cliente_id"),
            items        = d.get("items", []),
            metodo_pago  = d.get("metodo_pago", "Efectivo"),
            tipo_entrega = d.get("tipo_entrega", "Retiro en tienda"),
            estado_pago  = d.get("estado_pago", "Pagado"),
            descuento    = int(d.get("descuento", 0)),
            costo_envio  = int(d.get("costo_envio", 0)),
            notas        = d.get("notas", ""),
        )
        if not ok_result:
            return err(msg or "Error al crear venta")
        return ok({"venta_id": venta_id})
    except Exception as e:
        return err(str(e))


@app.route("/api/ventas/<int:venta_id>/detalle")
def get_detalle_venta(venta_id):
    sesion, error = _requerir_sesion()
    if error:
        return error
    try:
        items = db.get_detalle_venta(venta_id)
        return ok({"items": items})
    except Exception as e:
        return err(str(e), 503)


@app.route("/api/ventas/<int:venta_id>/marcar-pagado", methods=["POST"])
def marcar_pagado(venta_id):
    sesion, error = _requerir_sesion()
    if error:
        return error
    try:
        db.marcar_pagado(venta_id)
        return ok()
    except Exception as e:
        return err(str(e))


# ════════════════════════════════════════════════════════════════════════════
#  INSUMOS
#  database.get_insumos / get_insumos_stats / crear_insumo /
#           editar_insumo / eliminar_insumo / reponer_insumo
# ════════════════════════════════════════════════════════════════════════════
@app.route("/api/insumos")
def get_insumos():
    sesion, error = _requerir_sesion()
    if error:
        return error
    q = request.args.get("q", "")
    try:
        insumos = db.get_insumos(query=q)
        return ok({"insumos": insumos})
    except Exception as e:
        return err(str(e), 503)


@app.route("/api/insumos/stats")
def get_insumos_stats():
    sesion, error = _requerir_sesion()
    if error:
        return error
    try:
        stats = db.get_insumos_stats()
        return ok(stats)
    except Exception as e:
        return err(str(e), 503)


@app.route("/api/insumos", methods=["POST"])
def crear_insumo():
    sesion, error = _requerir_sesion()
    if error:
        return error
    d = request.get_json(silent=True) or {}
    try:
        resultado = db.crear_insumo(
            nombre       = d.get("nombre", ""),
            categoria    = d.get("categoria", ""),
            stock_actual = float(d.get("stock_actual", 0)),
            costo_unit   = float(d.get("costo_unit", 0)),
            unidad       = d.get("unidad", "unidad"),
            notas        = d.get("notas", ""),
        )
        if not resultado:
            return err("Error al crear insumo")
        return ok({"insumo": resultado})
    except Exception as e:
        return err(str(e))


@app.route("/api/insumos/<int:insumo_id>", methods=["PUT"])
def editar_insumo(insumo_id):
    sesion, error = _requerir_sesion()
    if error:
        return error
    d = request.get_json(silent=True) or {}
    try:
        ok_result, msg = db.editar_insumo(
            insumo_id    = insumo_id,
            nombre       = d.get("nombre", ""),
            categoria    = d.get("categoria", ""),
            stock_actual = float(d.get("stock_actual", 0)),
            costo_unit   = float(d.get("costo_unit", 0)),
            unidad       = d.get("unidad", "unidad"),
            notas        = d.get("notas", ""),
        )
        if not ok_result:
            return err(msg or "Error al editar")
        return ok()
    except Exception as e:
        return err(str(e))


@app.route("/api/insumos/<int:insumo_id>", methods=["DELETE"])
def eliminar_insumo(insumo_id):
    sesion, error = _requerir_sesion()
    if error:
        return error
    try:
        ok_result, msg = db.eliminar_insumo(insumo_id)
        if not ok_result:
            return err(msg or "Error al eliminar")
        return ok()
    except Exception as e:
        return err(str(e))


@app.route("/api/insumos/<int:insumo_id>/reponer", methods=["POST"])
def reponer_insumo(insumo_id):
    sesion, error = _requerir_sesion()
    if error:
        return error
    d = request.get_json(silent=True) or {}
    try:
        db.reponer_insumo(
            insumo_id = insumo_id,
            cantidad  = float(d.get("cantidad", 0)),
            costo     = float(d.get("costo", 0)),
        )
        return ok()
    except Exception as e:
        return err(str(e))


# ════════════════════════════════════════════════════════════════════════════
#  REPORTES Y COSTOS
#  database.get_stats_rango / get_costos_por_periodo / get_ventas_por_periodo
#           get_top_perfumes / get_top_clientes
# ════════════════════════════════════════════════════════════════════════════
@app.route("/api/costos")
def get_costos():
    sesion, error = _requerir_sesion()
    if error:
        return error
    desde = request.args.get("desde")
    hasta = request.args.get("hasta")
    tipo  = request.args.get("tipo")
    try:
        # get_stats_rango devuelve ingresos, costos, margen, etc.
        data = db.get_stats_rango(
            fecha_desde = desde or None,
            fecha_hasta = hasta or None,
            tipo        = tipo  or None,
        )
        return ok(data)
    except Exception as e:
        return err(str(e), 503)


@app.route("/api/reportes/ventas-periodo")
def ventas_periodo():
    sesion, error = _requerir_sesion()
    if error:
        return error
    agrupacion = request.args.get("agrupacion", "dia")
    desde      = request.args.get("desde")
    hasta      = request.args.get("hasta")
    tipo       = request.args.get("tipo")
    try:
        periodos = db.get_ventas_por_periodo(
            agrupacion  = agrupacion,
            fecha_desde = desde or None,
            fecha_hasta = hasta or None,
            tipo        = tipo  or None,
        )
        return ok({"periodos": periodos})
    except Exception as e:
        return err(str(e), 503)


@app.route("/api/reportes/top-perfumes")
def top_perfumes():
    sesion, error = _requerir_sesion()
    if error:
        return error
    n     = int(request.args.get("n", 5))
    desde = request.args.get("desde")
    hasta = request.args.get("hasta")
    tipo  = request.args.get("tipo")
    try:
        top = db.get_top_perfumes(n=n, desde=desde or None, hasta=hasta or None, tipo=tipo or None)
        # get_top_perfumes devuelve: nombre, marca, total_vendido
        # Calcular ingresos aproximados usando get_ventas_por_perfume si existe,
        # o usar total_vendido como cantidad y agregar campo ingresos
        for p in top:
            p.setdefault("ingresos", 0)
            p.setdefault("cantidad_vendida", p.get("total_vendido", 0))
        return ok({"perfumes": top})
    except Exception as e:
        return err(str(e), 503)


@app.route("/api/reportes/top-clientes")
def top_clientes():
    sesion, error = _requerir_sesion()
    if error:
        return error
    limit = int(request.args.get("limit", 8))
    desde = request.args.get("desde")
    hasta = request.args.get("hasta")
    tipo  = request.args.get("tipo")
    try:
        top = db.get_top_clientes(limit=limit, desde=desde or None, hasta=hasta or None, tipo=tipo or None)
        # Normalizar campos: total_comprado -> total_compras, compras -> n_ventas
        for c in top:
            c.setdefault("total_compras", c.get("total_comprado", 0))
            c.setdefault("n_ventas", c.get("compras", 0))
        return ok({"clientes": top})
    except Exception as e:
        return err(str(e), 503)



@app.route("/api/reportes/costos-periodo")
def costos_periodo():
    sesion, error = _requerir_sesion()
    if error:
        return error
    agrupacion = request.args.get("agrupacion", "mes")
    desde      = request.args.get("desde")
    hasta      = request.args.get("hasta")
    tipo       = request.args.get("tipo")
    try:
        periodos = db.get_costos_por_periodo(
            agrupacion  = agrupacion,
            fecha_desde = desde or None,
            fecha_hasta = hasta or None,
            tipo        = tipo  or None,
        )
        return ok({"periodos": periodos})
    except Exception as e:
        return err(str(e), 503)


# ════════════════════════════════════════════════════════════════════════════
#  ARRANQUE
# ════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    print("=" * 60)
    print("  Dew Point POS  —  API + PWA")
    print("=" * 60)

    # Inicializar master DB (mismo paso que oficial_15.py)
    try:
        db.init_master_db()
        print("  ✓  Master DB conectada")
    except Exception as e:
        print(f"  ✗  Error conectando a master DB: {e}")
        print("     Verifica config.dat y tu conexión a internet.")
        raise SystemExit(1)

    # Obtener IP local para mostrarla en consola
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip_local = s.getsockname()[0]
        s.close()
    except Exception:
        ip_local = "localhost"

    print(f"\n  PWA disponible en:")
    print(f"    → Este PC:   http://localhost:5000")
    print(f"    → Celular:   http://{ip_local}:5000  (misma WiFi)")
    print(f"\n  Para HTTPS (instalar como app): ngrok http 5000")
    print("=" * 60)

    app.run(
        host  = "0.0.0.0",   # acepta conexiones de la red local
        port  = 5000,
        debug = False,        # False en producción
        threaded = True,      # maneja múltiples requests a la vez
    )
