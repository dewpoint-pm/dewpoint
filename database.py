"""
database.py  –  Gabo Decants POS
Capa de acceso a datos con PostgreSQL y arquitectura multi-tenencia en la nube.

Estructura:
  MASTER DB  →  tabla `usuarios` (username, password, activo, conn_url)
  TENANT DB  →  base de datos exclusiva por emprendimiento

═══════════════════════════════════════════════════════════════════════════════
  OPTIMIZACIONES v2  (rendimiento en la nube)
═══════════════════════════════════════════════════════════════════════════════
  PROBLEMA RAÍZ: cada llamada a get_conn() creaba una conexión TCP+TLS nueva
  a Supabase (~200–400 ms solo de handshake). Una página con 2 consultas
  tardaba 600–800 ms incluso antes de ejecutar el SQL.

  SOLUCIÓN 1 – Pool de conexiones (ThreadedConnectionPool):
    Las conexiones se establecen UNA SOLA VEZ y luego se reutilizan.
    close() ya no cierra la conexión física; la devuelve al pool.
    Tiempo real por operación: < 2 ms (sin handshake TCP/TLS).

  SOLUCIÓN 2 – Consultas fusionadas:
    get_stats_rango():  4 round-trips → 1 consulta con CTE.
    crear_venta():      N SELECT de stock → 1 consulta con IN.
    editar_perfume():   get_perfume() doble → inline en la misma conexión.
    crear_cliente/perfume(): SELECT post-INSERT → inline con RETURNING.

  SOLUCIÓN 3 – close_all_pools():
    Cierra todas las conexiones al salir de la app (llama desde main.py).
═══════════════════════════════════════════════════════════════════════════════
"""

import psycopg2
import psycopg2.extras
import psycopg2.pool
import psycopg2.errorcodes
import psycopg2.errors
import threading
import time
import os
import hashlib
import bcrypt
from collections import defaultdict
from datetime import datetime, date, timedelta
from urllib.parse import urlparse, unquote, parse_qs

import sys as _sys_ssl
# Fix SSL para entornos frozen (.exe compilado con PyInstaller).
# En un .exe los certificados raíz no están disponibles por defecto.
# Este bloque los inyecta via variable de entorno SIN tocar los kwargs
# de psycopg2, por lo que no afecta la conexión en modo desarrollo normal.
if getattr(_sys_ssl, 'frozen', False):
    import certifi as _certifi
    os.environ.setdefault('SSL_CERT_FILE',      _certifi.where())
    os.environ.setdefault('REQUESTS_CA_BUNDLE', _certifi.where())
    os.environ.setdefault('PSYCOPG2_SSL_CERT',  _certifi.where())


# ── Configuración de conexión master ─────────────────────────────────────────
# La URL se carga desde config.dat (cifrado). Nunca se escribe en texto plano.
_CONFIG_LOAD_ERROR: str | None = None

def _load_master_url() -> str:
    global _CONFIG_LOAD_ERROR
    # Prioridad 1: variable de entorno (útil en CI/dev sin config.dat)
    env_url = os.environ.get("GABO_MASTER_URL", "")
    if env_url:
        return env_url
    # Prioridad 2: config.dat cifrado
    try:
        import config_manager as _cm
        return _cm.get_master_url()
    except Exception as _e:
        _CONFIG_LOAD_ERROR = str(_e)
        return ""

MASTER_DB_URL: str = _load_master_url()


def set_master_url(url: str) -> None:
    """
    Configura la URL de la master DB en tiempo de ejecución.
    Llama a esta función AL INICIO, ANTES de cualquier operación con la BD.
    IMPORTANTE: si ya existe un pool para MASTER_DB_URL anterior, lo descarta.
    """
    global MASTER_DB_URL
    old = MASTER_DB_URL
    MASTER_DB_URL = url
    # Si ya existía un pool con la URL anterior, descartarlo para que se
    # recree con la nueva URL la próxima vez que se necesite.
    with _pool_lock:
        if old in _pools:
            try:
                _pools[old].closeall()
            except Exception:
                pass
            del _pools[old]


FORMATOS = ["2ml", "3ml", "5ml", "10ml"]

# URL activa en la sesión (se asigna tras el login)
_active_conn_url: str | None = None


# ════════════════════════════════════════════════════════════════════════════
#  POOL DE CONEXIONES
#  Elimina el overhead TCP+TLS por operación.  Las conexiones se crean
#  una sola vez y se devuelven al pool tras cada uso (close() = putconn()).
# ════════════════════════════════════════════════════════════════════════════
_pools: dict[str, psycopg2.pool.ThreadedConnectionPool] = {}
_pool_lock = threading.Lock()

# ── Cierre automático por inactividad ────────────────────────────────────────
# Neon cobra CU-hrs mientras hay conexiones activas. Este mecanismo cierra
# el pool tras 3 minutos sin actividad, permitiendo que Neon suspenda el compute.
_INACTIVITY_TIMEOUT = 600   # 10 minutos (era 3 min — demasiado agresivo para un POS)
_INACTIVITY_CHECK   = 60    # revisar cada 60 segundos (era 30 s)
_last_activity: float = 0.0
_inactivity_thread_started = False
_inactivity_lock = threading.Lock()


def _inactivity_monitor() -> None:
    """
    Hilo daemon que revisa la inactividad y cierra pools si corresponde.
    Se ejecuta cada _INACTIVITY_CHECK segundos.
    """
    global _last_activity
    while True:
        try:
            time.sleep(_INACTIVITY_CHECK)
            with _inactivity_lock:
                idle_time = time.time() - _last_activity
            if idle_time >= _INACTIVITY_TIMEOUT:
                with _pool_lock:
                    if _pools:
                        for pool in _pools.values():
                            try:
                                pool.closeall()
                            except Exception:
                                pass
                        _pools.clear()
        except Exception:
            pass  # nunca crashear la app


def _start_inactivity_monitor() -> None:
    """Inicia el hilo de monitoreo de inactividad (una sola vez)."""
    global _inactivity_thread_started
    with _inactivity_lock:
        if _inactivity_thread_started:
            return
        _inactivity_thread_started = True
    t = threading.Thread(target=_inactivity_monitor, daemon=True)
    t.start()


def _touch_activity() -> None:
    """Actualiza el timestamp de última actividad."""
    global _last_activity
    with _inactivity_lock:
        _last_activity = time.time()


# Códigos de error de PostgreSQL / psycopg2 que indican una conexión muerta
# y que es seguro reintentar con una conexión nueva.
_STALE_CONN_ERRCODES = frozenset({
    "08000",  # connection_exception
    "08003",  # connection_does_not_exist
    "08006",  # connection_failure
    "57P01",  # admin_shutdown  (Neon pausa el proyecto)
    "57P02",  # crash_shutdown
    "57P03",  # cannot_connect_now
})
_STALE_CONN_MESSAGES = (
    "server closed the connection",
    "connection was closed",
    "ssl connection has been closed",
    "could not receive data from server",
    "no connection to the server",
    "terminating connection due to administrator command",
)


# ════════════════════════════════════════════════════════════════════════════
#  CACHÉ TTL  (Time-To-Live)
#  Evita round-trips a Supabase cuando los datos son recientes.
#  · Lecturas repetidas dentro de _CACHE_TTL segundos se sirven desde RAM.
#  · Toda mutación (crear/editar/eliminar) invalida las claves afectadas.
#  · warm_cache() pre-carga los datos más usados justo después del login.
# ════════════════════════════════════════════════════════════════════════════
_CACHE_TTL  = 300                                   # segundos (5 minutos)
_cache: dict[str, tuple[float, object]] = {}        # key → (timestamp, data)
_cache_lock = threading.Lock()


def _cache_get(key: str):
    """Retorna el valor cacheado si existe y no expiró; si no, retorna None."""
    with _cache_lock:
        entry = _cache.get(key)
        if entry and (time.monotonic() - entry[0]) < _CACHE_TTL:
            return entry[1]
    return None


def _cache_set(key: str, value):
    """Almacena un valor en caché con timestamp actual."""
    with _cache_lock:
        _cache[key] = (time.monotonic(), value)


def cache_invalidate(*prefixes: str):
    """
    API pública para invalidar el caché desde fuera del módulo (p.ej. main.py).
    Sin argumentos vacía todo el caché. Con prefijos elimina solo las entradas
    cuyos keys comiencen con alguno de ellos.
    Ejemplo: db.cache_invalidate("stats", "clientes:")
    """
    _cache_invalidate(*prefixes)


def _cache_invalidate(*prefixes: str):
    """
    Elimina entradas del caché cuyos keys comiencen con alguno de los prefijos.
    Sin argumentos: vacía todo el caché.
    Ejemplo: _cache_invalidate("clientes:", "stats")
    """
    with _cache_lock:
        if not prefixes:
            _cache.clear()
            return
        to_delete = [
            k for k in list(_cache.keys())
            if any(k.startswith(p) for p in prefixes)
        ]
        for k in to_delete:
            del _cache[k]


def warm_cache() -> None:
    """
    Pre-carga en hilos daemon los datos más frecuentes.
    Llama esta función justo después del login exitoso (desde main.py).
    El primer acceso a cada página será instantáneo porque los datos
    ya estarán en caché cuando el usuario haga clic.
    """
    def _load(fn, *args):
        try:
            fn(*args)
        except Exception:
            pass   # fallos silenciosos; la UI hará la carga normal

    targets = [
        (get_clientes,  ("",)),
        (get_perfumes,  ("", False)),
        (get_ventas,    ("", "Todos")),
        (get_stats,     ()),
        (get_insumos,   ("",)),
    ]
    # Escalonar los threads cada 50 ms: las conexiones ya están establecidas
    # (el pool las creó durante el login), así que el overhead TCP/TLS es 0.
    # 5 targets × 50 ms = 250 ms total. Pool maxconn=6 soporta 5 hilos sin contención.
    for i, (fn, args) in enumerate(targets):
        delay = i * 0.05
        t = threading.Timer(delay, _load, args=(fn, *args))
        t.daemon = True
        t.start()


def _parse_dsn_kwargs(dsn: str) -> dict:
    """Convierte una URL PostgreSQL en kwargs para psycopg2 / pool."""
    parsed   = urlparse(dsn)
    host     = parsed.hostname or "localhost"
    port     = parsed.port    or 5432
    dbname   = (parsed.path or "/postgres").lstrip("/") or "postgres"
    user     = unquote(parsed.username or "postgres")
    password = unquote(parsed.password or "")
    qp       = parse_qs(parsed.query)
    sslmode  = (qp.get("sslmode") or [None])[0]
    if sslmode is None:
        _CLOUD = (
            "supabase.co", "supabase.com",   # <-- agregado supabase.com (nuevo pooler)
            "neon.tech", "railway.app",
            "render.com", "amazonaws.com", "azure.com",
        )
        if any(h in host for h in _CLOUD):
            sslmode = "require"
    kwargs: dict = dict(
        host=host, port=port, dbname=dbname,
        user=user, password=password,
        cursor_factory=psycopg2.extras.RealDictCursor,
        client_encoding="utf8",
        connect_timeout=15,   # <-- evita que la app se congele indefinidamente
    )
    if sslmode:
        kwargs["sslmode"] = sslmode
        # TCP keepalives: el OS detecta conexiones muertas y las cierra antes
        # de que el pool las entregue como "disponibles".
        # keepalives_idle=60 → envía un probe a los 60s de inactividad.
        # keepalives_interval/count son ignorados silenciosamente en Windows
        # si libpq no los soporta, por lo que es seguro incluirlos siempre.
        kwargs.update(
            keepalives=1,
            keepalives_idle=60,
            keepalives_interval=10,
            keepalives_count=3,
        )
    return kwargs


def _get_pool(dsn: str) -> psycopg2.pool.ThreadedConnectionPool:
    """Retorna (o crea) el ThreadedConnectionPool para el DSN dado. Thread-safe."""
    _touch_activity()
    _start_inactivity_monitor()
    with _pool_lock:
        if dsn not in _pools:
            try:
                _pools[dsn] = psycopg2.pool.ThreadedConnectionPool(
                    1, 6, **_parse_dsn_kwargs(dsn)
                )
            except psycopg2.OperationalError as e:
                msg = str(e)
                # Diagnóstico amigable según tipo de fallo de red
                if "could not translate host name" in msg or "Name or service not known" in msg:
                    raise psycopg2.OperationalError(
                        "Sin conexión a internet.\n"
                        "Verifica tu conexión e intenta de nuevo."
                    ) from e
                elif "Connection refused" in msg or "connect timeout" in msg.lower() or "timeout expired" in msg.lower():
                    raise psycopg2.OperationalError(
                        "No se pudo conectar al servidor.\n"
                        "Verifica tu conexión a internet e intenta de nuevo."
                    ) from e
                raise  # cualquier otro error de psycopg2, re-lanzar sin cambios
        return _pools[dsn]


def close_all_pools() -> None:
    """
    Cierra todas las conexiones de todos los pools y vacía el caché.
    Llama esta función al cerrar la aplicación (protocolo WM_DELETE_WINDOW).
    """
    with _pool_lock:
        for pool in _pools.values():
            try:
                pool.closeall()
            except Exception:
                pass
        _pools.clear()
    _cache_invalidate()   # limpiar caché al cerrar sesión


# ════════════════════════════════════════════════════════════════════════════
#  GESTIÓN DE SESIÓN
# ════════════════════════════════════════════════════════════════════════════
def set_active_conn_url(url: str) -> None:
    """Establece la URL de conexión del tenant que acaba de iniciar sesión."""
    global _active_conn_url
    _active_conn_url = url
    _cache_invalidate()   # nueva sesión → caché del tenant anterior no aplica

# Alias de retrocompatibilidad – muestra el host sin exponer contraseña
@property
def _db_path_compat():
    url = _active_conn_url or MASTER_DB_URL
    try:
        from urllib.parse import urlparse
        p = urlparse(url)
        return f"postgres://{p.hostname}:{p.port or 5432}/{(p.path or '/postgres').lstrip('/')}"
    except Exception:
        return url

# Atributo de módulo para mantener compatibilidad con main.py legacy
class _ModuleCompat:
    """Permite que `db.DB_PATH` funcione aunque database.py ya no use SQLite."""
    def __getattr__(self, name):
        if name == "DB_PATH":
            url = _active_conn_url or MASTER_DB_URL
            try:
                from urllib.parse import urlparse
                p = urlparse(url)
                return f"postgres://{p.hostname}:{p.port or 5432}/{(p.path or '/postgres').lstrip('/')}"
            except Exception:
                return url
        raise AttributeError(name)

import sys as _sys
_sys.modules[__name__].__class__ = type(
    "database", (_ModuleCompat, type(_sys.modules[__name__])), {}
)

# Alias de retrocompatibilidad
def set_active_db(url: str) -> None:
    set_active_conn_url(url)

def get_active_conn_url() -> str | None:
    return _active_conn_url


# ════════════════════════════════════════════════════════════════════════════
#  HASHING DE CONTRASEÑAS  (bcrypt con salt automático)
#  Reemplaza el SHA-256 sin salt anterior. La función verify_password
#  detecta y migra automáticamente hashes SHA-256 legacy a bcrypt.
# ════════════════════════════════════════════════════════════════════════════
def hash_password(password: str) -> str:
    """Genera hash bcrypt seguro. Lento por diseño (rounds=12 ≈ 250ms)."""
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt(rounds=12)).decode('utf-8')


def _verify_password(password: str, stored_hash: str) -> bool:
    """Verifica contraseña. Detecta bcrypt y SHA-256 legacy."""
    if stored_hash.startswith('$2b$') or stored_hash.startswith('$2a$'):
        return bcrypt.checkpw(password.encode('utf-8'), stored_hash.encode('utf-8'))
    # Hash SHA-256 legacy (sin salt) — solo para migración
    return hashlib.sha256(password.encode()).hexdigest() == stored_hash


# ════════════════════════════════════════════════════════════════════════════
#  WRAPPER  –  interfaz tipo sqlite3 sobre psycopg2, usando pool
# ════════════════════════════════════════════════════════════════════════════
class _PgConn:
    """
    Wrapper sobre psycopg2 que toma/devuelve conexiones de un ThreadedConnectionPool.
    API idéntica a la versión anterior: execute(), executemany(), commit(),
    rollback(), close(), cursor().

    Diferencia clave:
      · __init__  → toma una conexión del pool (sin TCP/TLS si ya existe)
      · close()   → DEVUELVE la conexión al pool (no la cierra físicamente)
      · __exit__  → en caso de error, descarta la conexión (close=True)
                    para evitar reutilizar un estado transaccional roto.
    """

    def __init__(self, dsn: str):
        self._dsn  = dsn
        self._pool = _get_pool(dsn)
        try:
            self._conn = self._pool.getconn()
        except psycopg2.pool.PoolError:
            # Pool exhausto: todas las conexiones están en uso (no necesariamente muertas).
            # Reintentar con backoff progresivo antes de recrear el pool.
            import time as _time
            _connected = False
            for _attempt in range(5):
                _time.sleep(0.15 * (_attempt + 1))
                try:
                    self._conn = self._pool.getconn()
                    _connected = True
                    break
                except psycopg2.pool.PoolError:
                    pass
            if not _connected:
                # Último recurso: recrear solo si este pool sigue siendo el activo.
                with _pool_lock:
                    if self._dsn in _pools and _pools[self._dsn] is self._pool:
                        try:
                            _pools[self._dsn].closeall()
                        except Exception:
                            pass
                        del _pools[self._dsn]
                self._pool = _get_pool(self._dsn)
                self._conn = self._pool.getconn()

    def _is_stale_error(self, exc: psycopg2.OperationalError) -> bool:
        """Retorna True si el error indica una conexión muerta (reconectable)."""
        pgcode = getattr(exc, "pgcode", None) or ""
        msg    = str(exc).lower()
        return pgcode in _STALE_CONN_ERRCODES or any(
            phrase in msg for phrase in _STALE_CONN_MESSAGES
        )

    def _discard_and_reconnect(self) -> None:
        """Descarta la conexión muerta del pool y obtiene una nueva."""
        try:
            self._pool.putconn(self._conn, close=True)
        except Exception:
            pass
        try:
            self._conn = self._pool.getconn()
        except psycopg2.pool.PoolError:
            # Pool exhausto tras descartar conexión muerta.
            # Recrear solo si este pool sigue siendo el activo.
            with _pool_lock:
                if self._dsn in _pools and _pools[self._dsn] is self._pool:
                    try:
                        _pools[self._dsn].closeall()
                    except Exception:
                        pass
                    del _pools[self._dsn]
            self._pool = _get_pool(self._dsn)
            self._conn = self._pool.getconn()

    def execute(self, sql: str, params=()):
        try:
            cur = self._conn.cursor()
            cur.execute(sql, params if params else None)
            return cur
        except psycopg2.OperationalError as e:
            if not self._is_stale_error(e):
                raise
            # Conexión muerta: reintentar UNA vez con una conexión nueva.
            self._discard_and_reconnect()
            cur = self._conn.cursor()
            cur.execute(sql, params if params else None)
            return cur

    def executemany(self, sql: str, seq_of_params):
        try:
            cur = self._conn.cursor()
            psycopg2.extras.execute_batch(cur, sql, seq_of_params)
            return cur
        except psycopg2.OperationalError as e:
            if not self._is_stale_error(e):
                raise
            self._discard_and_reconnect()
            cur = self._conn.cursor()
            psycopg2.extras.execute_batch(cur, sql, seq_of_params)
            return cur

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        """Devuelve la conexión al pool (sin cerrarla físicamente)."""
        try:
            self._pool.putconn(self._conn)
        except Exception:
            pass

    def cursor(self):
        return self._conn.cursor()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type:
            try:
                self.rollback()
            except Exception:
                pass
            # Descarta la conexión en error para no reutilizar estado roto
            try:
                self._pool.putconn(self._conn, close=True)
            except Exception:
                pass
        else:
            self.commit()
            try:
                self._pool.putconn(self._conn)
            except Exception:
                pass


# ════════════════════════════════════════════════════════════════════════════
#  CONEXIONES
# ════════════════════════════════════════════════════════════════════════════
def get_conn(url: str | None = None) -> _PgConn:
    """
    Retorna una conexión a la BD del tenant activo (desde el pool).
    Si se pasa `url` explícitamente se usa esa (útil en init_db).
    """
    target = url or _active_conn_url
    if not target:
        raise RuntimeError(
            "No hay base de datos activa. "
            "El usuario debe iniciar sesión antes de usar esta función."
        )
    return _PgConn(target)


def get_master_conn() -> _PgConn:
    """Retorna una conexión a la master DB (desde el pool)."""
    if not MASTER_DB_URL:
        raise RuntimeError(
            "No se encontró la configuración de la base de datos.\n\n"
            f"{_CONFIG_LOAD_ERROR or 'Ejecuta setup_config.py para generar config.dat.'}"
        )
    return _PgConn(MASTER_DB_URL)


# ════════════════════════════════════════════════════════════════════════════
#  INICIALIZACIÓN
# ════════════════════════════════════════════════════════════════════════════
def init_master_db() -> None:
    """
    Crea la tabla `usuarios` en la master DB si no existe.
    Aplica migraciones de columnas (safe: ADD COLUMN IF NOT EXISTS).
    Solo corre una vez por sesión de app (el flag _master_db_ready evita
    4 round-trips DDL a Neon en cada intento de login subsiguiente).
    """
    global _master_db_ready
    with _master_db_lock:
        if _master_db_ready:
            return
    conn = get_master_conn()
    cur  = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS usuarios (
            id                SERIAL      PRIMARY KEY,
            username          TEXT        NOT NULL UNIQUE,
            password          TEXT        NOT NULL,
            activo            SMALLINT    NOT NULL DEFAULT 1,
            conn_url          TEXT        NOT NULL DEFAULT '',
            intentos_fallidos INTEGER     NOT NULL DEFAULT 0,
            bloqueado_hasta   TIMESTAMP
        )
    """)
    # Migración segura: agrega columnas de brute-force si no existen aún
    for sql in [
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS intentos_fallidos INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_hasta TIMESTAMP",
    ]:
        cur.execute(sql)
    conn.commit()
    conn.close()
    with _master_db_lock:
        _master_db_ready = True


def init_db(url: str | None = None) -> None:
    """
    Crea (o migra) la BD exclusiva de un tenant.
    Si `url` es None usa _active_conn_url.
    """
    target = url or _active_conn_url
    if not target:
        raise RuntimeError("Proporciona url o establece la sesión primero.")

    conn = get_conn(target)
    cur  = conn.cursor()

    # ── Clientes ─────────────────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS clientes (
            id             SERIAL   PRIMARY KEY,
            nombre         TEXT     NOT NULL,
            rut            TEXT     NOT NULL DEFAULT '',
            telefono       TEXT     NOT NULL DEFAULT '',
            instagram      TEXT     DEFAULT '',
            email          TEXT     DEFAULT '',
            notas          TEXT     DEFAULT '',
            fecha_creacion DATE     DEFAULT CURRENT_DATE
        )
    """)

    # ── Perfumes ──────────────────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS perfumes (
            id              SERIAL   PRIMARY KEY,
            nombre          TEXT     NOT NULL,
            marca           TEXT     NOT NULL,
            ml_totales      REAL     NOT NULL,
            ml_disponibles  REAL     NOT NULL,
            costo_total     INTEGER  DEFAULT 0,
            precio_botella  INTEGER  DEFAULT 0,
            activo          SMALLINT DEFAULT 1
        )
    """)

    # ── Precios por formato ───────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS precios_decants (
            id          SERIAL  PRIMARY KEY,
            perfume_id  INTEGER NOT NULL REFERENCES perfumes(id) ON DELETE CASCADE,
            formato_ml  TEXT    NOT NULL CHECK(formato_ml IN ('2ml','3ml','5ml','10ml')),
            precio      INTEGER NOT NULL DEFAULT 0,
            UNIQUE(perfume_id, formato_ml)
        )
    """)

    # ── Ventas ────────────────────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ventas (
            id           SERIAL   PRIMARY KEY,
            cliente_id   INTEGER  REFERENCES clientes(id),
            fecha        DATE     NOT NULL DEFAULT CURRENT_DATE,
            metodo_pago  TEXT     NOT NULL DEFAULT 'Transferencia',
            tipo_entrega TEXT     NOT NULL DEFAULT 'Retiro',
            estado_pago  TEXT     NOT NULL DEFAULT 'Pagado'
                                  CHECK(estado_pago IN ('Pagado','Pendiente')),
            descuento    INTEGER  DEFAULT 0,
            costo_envio  INTEGER  DEFAULT 0,
            total        INTEGER  NOT NULL DEFAULT 0,
            notas        TEXT     DEFAULT ''
        )
    """)

    # ── Detalle de venta ──────────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS detalle_venta (
            id                  SERIAL   PRIMARY KEY,
            venta_id            INTEGER  NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
            perfume_id          INTEGER  NOT NULL REFERENCES perfumes(id),
            formato_ml          TEXT     NOT NULL,
            cantidad            INTEGER  NOT NULL DEFAULT 1,
            precio_unit         INTEGER  NOT NULL,
            subtotal            INTEGER  NOT NULL,
            costo_unitario      REAL     NOT NULL DEFAULT 0,
            es_botella_completa SMALLINT NOT NULL DEFAULT 0
        )
    """)

    # ── Insumos (frascos, bolsas, etiquetas, etc.) ────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS insumos (
            id              SERIAL   PRIMARY KEY,
            nombre          TEXT     NOT NULL,
            categoria       TEXT     NOT NULL DEFAULT '',
            formato_ml      TEXT     NOT NULL DEFAULT '',
            stock_actual    REAL     NOT NULL DEFAULT 0,
            costo_unitario  REAL     NOT NULL DEFAULT 0
        )
    """)

    # ── Recetas: qué insumos consume cada formato ──────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS insumos_por_formato (
            id          SERIAL  PRIMARY KEY,
            formato_ml  TEXT    NOT NULL,
            insumo_id   INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
            cantidad    REAL    NOT NULL DEFAULT 1,
            UNIQUE(formato_ml, insumo_id)
        )
    """)

    # ── Índices ───────────────────────────────────────────────────────────────
    for idx_sql in [
        "CREATE INDEX IF NOT EXISTS idx_clientes_nombre   ON clientes(nombre)",
        "CREATE INDEX IF NOT EXISTS idx_clientes_telefono ON clientes(telefono)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_rut_unique ON clientes(rut) WHERE rut <> ''",
        "CREATE INDEX IF NOT EXISTS idx_ventas_cliente    ON ventas(cliente_id)",
        "CREATE INDEX IF NOT EXISTS idx_ventas_estado     ON ventas(estado_pago)",
        "CREATE INDEX IF NOT EXISTS idx_ventas_fecha      ON ventas(fecha)",
        "CREATE INDEX IF NOT EXISTS idx_detalle_venta     ON detalle_venta(venta_id)",
        "CREATE INDEX IF NOT EXISTS idx_detalle_perfume   ON detalle_venta(perfume_id)",
        "CREATE INDEX IF NOT EXISTS idx_perfumes_activo   ON perfumes(activo)",
    ]:
        cur.execute(idx_sql)

    _migrate(cur)

    conn.commit()
    conn.close()


def _migrate(cur) -> None:
    """Aplica migraciones seguras (ADD COLUMN IF NOT EXISTS)."""
    for sql in [
        "ALTER TABLE clientes      ADD COLUMN IF NOT EXISTS rut TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE detalle_venta ADD COLUMN IF NOT EXISTS costo_unitario REAL NOT NULL DEFAULT 0",
        "ALTER TABLE detalle_venta ADD COLUMN IF NOT EXISTS es_botella_completa SMALLINT NOT NULL DEFAULT 0",
        "ALTER TABLE detalle_venta ADD COLUMN IF NOT EXISTS costo_insumos REAL NOT NULL DEFAULT 0",
        "ALTER TABLE perfumes      ADD COLUMN IF NOT EXISTS precio_botella INTEGER DEFAULT 0",
        "ALTER TABLE perfumes      ADD COLUMN IF NOT EXISTS tipo_venta TEXT NOT NULL DEFAULT 'decants'",
        "ALTER TABLE perfumes      ADD COLUMN IF NOT EXISTS eliminado BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE insumos       ADD COLUMN IF NOT EXISTS formato_ml TEXT NOT NULL DEFAULT ''",
        # Eliminar restricción UNIQUE de teléfono (puede repetirse entre clientes)
        "ALTER TABLE clientes DROP CONSTRAINT IF EXISTS clientes_telefono_key",
        # RUT es único (ignorando filas con RUT vacío para compatibilidad con datos anteriores)
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_rut_unique ON clientes(rut) WHERE rut <> ''",
        "CREATE TABLE IF NOT EXISTS restock_log (id SERIAL PRIMARY KEY, perfume_id INTEGER NOT NULL, fecha TIMESTAMP DEFAULT NOW(), ml_agregados REAL NOT NULL, costo_agregado INTEGER NOT NULL DEFAULT 0, costo_anterior INTEGER NOT NULL DEFAULT 0, ml_anterior REAL NOT NULL DEFAULT 0)",
    ]:
        cur.execute(sql)

    # ── Sincronización retroactiva: conectar insumos existentes con formato ──
    # Inserta en insumos_por_formato todos los insumos que tienen formato_ml
    # asignado pero aún no tienen su receta (ON CONFLICT evita duplicados).
    cur.execute("""
        INSERT INTO insumos_por_formato(formato_ml, insumo_id, cantidad)
        SELECT i.formato_ml, i.id, 1
        FROM insumos i
        WHERE i.formato_ml IN ('2ml','3ml','5ml','10ml')
          AND NOT EXISTS (
              SELECT 1 FROM insumos_por_formato ipf
              WHERE ipf.insumo_id = i.id AND ipf.formato_ml = i.formato_ml
          )
    """)


# ════════════════════════════════════════════════════════════════════════════
#  AUTENTICACIÓN
# ════════════════════════════════════════════════════════════════════════════
_BLOQUEO_MINUTOS   = 5    # tiempo de bloqueo tras demasiados intentos
_MAX_INTENTOS      = 5    # intentos fallidos antes de bloquear
_master_db_ready   = False  # evita re-ejecutar DDL en cada intento de login
_master_db_lock    = threading.Lock()


def verificar_login(username: str, password: str) -> dict | None:
    """
    Valida credenciales contra la master DB.
    - Usa bcrypt (migra SHA-256 legacy automáticamente al primer login).
    - Bloquea la cuenta por _BLOQUEO_MINUTOS tras _MAX_INTENTOS fallidos.
    Retorna dict {username, conn_url, db_path} o None si falla.
    Lanza RuntimeError si la cuenta está bloqueada (para mostrar mensaje).

    Usa UNA SOLA conexión para SELECT + UPDATE, evitando que un fallo
    en la segunda conexión se muestre erróneamente como "Error de conexión"
    cuando en realidad la contraseña es incorrecta.
    """
    if not username or not password:
        return None

    conn = get_master_conn()
    try:
        row = conn.execute(
            "SELECT username, password, activo, conn_url, "
            "intentos_fallidos, bloqueado_hasta "
            "FROM usuarios WHERE username=%s",
            (username,)
        ).fetchone()

        if not row or not row["activo"]:
            return None

        # ── Protección brute-force ───────────────────────────────────────────
        bloqueado_hasta = row["bloqueado_hasta"]
        if bloqueado_hasta and bloqueado_hasta > datetime.now():
            restante = int((bloqueado_hasta - datetime.now()).total_seconds() / 60) + 1
            raise RuntimeError(
                f"Cuenta bloqueada por demasiados intentos fallidos.\n"
                f"Intenta nuevamente en {restante} minuto(s)."
            )

        # ── Verificar contraseña ─────────────────────────────────────────────
        stored_hash = row["password"]
        valida = _verify_password(password, stored_hash)

        if not valida:
            # Registrar intento fallido reutilizando la misma conexión.
            # Si este UPDATE falla (p.ej. Neon pausado entre queries), se
            # ignora silenciosamente: lo importante es retornar None para
            # que la UI muestre "contraseña incorrecta" y no "error de red".
            try:
                conn.execute("""
                    UPDATE usuarios
                    SET intentos_fallidos = intentos_fallidos + 1,
                        bloqueado_hasta = CASE
                            WHEN intentos_fallidos + 1 >= %s
                            THEN NOW() + INTERVAL '5 minutes'
                            ELSE bloqueado_hasta
                        END
                    WHERE username = %s
                """, (_MAX_INTENTOS, username))
                conn.commit()
            except Exception:
                pass
            return None

        # Login correcto: resetear contador en la misma conexión
        try:
            conn.execute(
                "UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE username = %s",
                (username,)
            )
            conn.commit()
        except Exception:
            pass

        conn_url = row["conn_url"]
        if not conn_url:
            return None

        # Migración SHA-256 → bcrypt (edge-case, usa conexión aparte)
        if not (stored_hash.startswith('$2b$') or stored_hash.startswith('$2a$')):
            _actualizar_hash(username, hash_password(password))

        return {
            "username": row["username"],
            "conn_url": conn_url,
            "db_path":  conn_url,
        }
    finally:
        conn.close()


def _registrar_intento_fallido(username: str) -> None:
    """Incrementa el contador y bloquea la cuenta si se alcanza el límite."""
    conn = get_master_conn()
    conn.execute("""
        UPDATE usuarios
        SET intentos_fallidos = intentos_fallidos + 1,
            bloqueado_hasta = CASE
                WHEN intentos_fallidos + 1 >= %s
                THEN NOW() + INTERVAL '5 minutes'
                ELSE bloqueado_hasta
            END
        WHERE username = %s
    """, (_MAX_INTENTOS, username))
    conn.commit()
    conn.close()


def _resetear_intentos(username: str) -> None:
    """Limpia el contador de fallos tras un login exitoso."""
    conn = get_master_conn()
    conn.execute(
        "UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE username = %s",
        (username,)
    )
    conn.commit()
    conn.close()


def _actualizar_hash(username: str, new_hash: str) -> None:
    """Actualiza el hash de contraseña (migración SHA-256 → bcrypt)."""
    conn = get_master_conn()
    conn.execute(
        "UPDATE usuarios SET password = %s WHERE username = %s",
        (new_hash, username)
    )
    conn.commit()
    conn.close()


def _update_conn_url(username: str, conn_url: str) -> None:
    conn = get_master_conn()
    conn.execute(
        "UPDATE usuarios SET conn_url=%s WHERE username=%s",
        (conn_url, username)
    )
    conn.commit()
    conn.close()


# ════════════════════════════════════════════════════════════════════════════
#  CLIENTES
# ════════════════════════════════════════════════════════════════════════════
def get_clientes(query=""):
    cache_key = f"clientes:{query.lower()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    conn = get_conn()
    q = f"%{query.lower()}%"
    rows = conn.execute("""
        SELECT c.*,
               COUNT(v.id)  AS compras,
               MAX(v.fecha) AS ultima_compra
        FROM clientes c
        LEFT JOIN ventas v ON v.cliente_id = c.id
        WHERE lower(c.nombre)    LIKE %s
           OR lower(c.rut)       LIKE %s
           OR c.telefono         LIKE %s
           OR lower(c.instagram) LIKE %s
           OR lower(c.email)     LIKE %s
        GROUP BY c.id
        ORDER BY c.nombre
    """, (q, q, q, q, q)).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("ultima_compra"), date):
            d["ultima_compra"] = d["ultima_compra"].isoformat()
        result.append(d)
    _cache_set(cache_key, result)
    return result


def get_top_clientes(limit: int = 8, desde=None, hasta=None, tipo=None) -> list[dict]:
    """
    Retorna los mejores clientes ordenados por total $ comprado (descendente).
    Excluye clientes sin nombre real (sin cliente asignado).
    Campos: nombre, telefono, instagram, compras, total_comprado, ultima_compra
    """
    conn = get_conn()
    extra_parts = []
    params = []
    if desde:
        extra_parts.append("v.fecha >= %s")
        params.append(desde)
    if hasta:
        extra_parts.append("v.fecha <= %s")
        params.append(hasta)
    if tipo in ("decants", "botella"):
        tipo_val = 1 if tipo == "botella" else 0
        extra_parts.append(f"""v.id IN (
            SELECT DISTINCT dv.venta_id FROM detalle_venta dv WHERE dv.es_botella_completa = %s
        )""")
        params.append(tipo_val)
    base_where = (
        "lower(c.nombre) NOT IN ('cliente anónimo', 'cliente anonimo', 'anónimo', 'anonimo')"
        " AND c.nombre IS NOT NULL AND trim(c.nombre) <> ''"
    )
    extra_sql = (" AND " + " AND ".join(extra_parts)) if extra_parts else ""
    params.append(limit)
    rows = conn.execute(f"""
        SELECT c.nombre,
               c.telefono,
               c.instagram,
               COUNT(v.id)       AS compras,
               COALESCE(SUM(v.total), 0) AS total_comprado,
               MAX(v.fecha)      AS ultima_compra
        FROM clientes c
        JOIN ventas v ON v.cliente_id = c.id
        WHERE {base_where}{extra_sql}
        GROUP BY c.id, c.nombre, c.telefono, c.instagram
        ORDER BY total_comprado DESC
        LIMIT %s
    """, params).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("ultima_compra"), date):
            d["ultima_compra"] = d["ultima_compra"].isoformat()
        result.append(d)
    return result


def get_cliente(cliente_id):
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM clientes WHERE id=%s", (cliente_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def crear_cliente(nombre, rut, telefono, instagram="", email="", notas=""):
    """Crea un cliente y devuelve el dict completo usando la misma conexión."""
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO clientes(nombre,rut,telefono,instagram,email,notas) "
            "VALUES(%s,%s,%s,%s,%s,%s) RETURNING *",
            (nombre, rut, telefono or "", instagram, email, notas)
        )
        row = cur.fetchone()
        conn.commit()
    except psycopg2.errors.UniqueViolation:
        conn.rollback()
        conn.close()
        raise ValueError(f"Ya existe un cliente con el RUT {rut}")
    conn.close()
    _cache_invalidate("clientes:", "stats")
    return dict(row) if row else None


def get_or_create_anonimo() -> dict:
    """
    Retorna siempre el MISMO cliente anónimo (id fijo).
    Si no existe aún, lo crea una sola vez.
    Jamás crea duplicados de Cliente Anónimo.
    """
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM clientes WHERE nombre='Cliente Anónimo' ORDER BY id ASC LIMIT 1"
    ).fetchone()
    if row:
        conn.close()
        return dict(row)
    # Primera vez: crear el único cliente anónimo
    cur = conn.execute(
        "INSERT INTO clientes(nombre,rut,telefono,instagram,email,notas) "
        "VALUES('Cliente Anónimo','','','','','Cliente anónimo') RETURNING *"
    )
    row = cur.fetchone()
    conn.commit()
    conn.close()
    _cache_invalidate("clientes:", "stats")
    return dict(row)



def editar_cliente(cliente_id: int, nombre: str, rut: str, telefono: str,
                   instagram: str = "", email: str = "", notas: str = "") -> dict | None:
    """Edita un cliente y devuelve el dict actualizado usando la misma conexión."""
    conn = get_conn()
    try:
        conn.execute("""
            UPDATE clientes
            SET nombre=%s, rut=%s, telefono=%s, instagram=%s, email=%s, notas=%s
            WHERE id=%s
        """, (nombre, rut, telefono or "", instagram, email, notas, cliente_id))
        row = conn.execute(
            "SELECT * FROM clientes WHERE id=%s", (cliente_id,)
        ).fetchone()
        conn.commit()
    except psycopg2.errors.UniqueViolation:
        conn.rollback()
        conn.close()
        raise ValueError(f"Ya existe un cliente con el RUT {rut}")
    conn.close()
    _cache_invalidate("clientes:", "stats")
    return dict(row) if row else None


# ════════════════════════════════════════════════════════════════════════════
#  PERFUMES
# ════════════════════════════════════════════════════════════════════════════
def _parse_perfume_row(r: dict) -> dict:
    """Parsea precios_raw a dict {formato: precio}."""
    precios = {}
    if r.get("precios_raw"):
        for part in r["precios_raw"].split(","):
            try:
                fmt, precio = part.split(":")
                precios[fmt] = int(precio)
            except (ValueError, TypeError):
                continue
    r["precios"] = precios
    return r


def get_perfumes(query="", solo_activos=True):
    cache_key = f"perfumes:{query.lower()}:{solo_activos}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    conn = get_conn()
    q = f"%{query.lower()}%"
    filtro_activo = "AND p.activo=1" if solo_activos else ""
    rows = conn.execute(f"""
        SELECT p.*,
               STRING_AGG(pd.formato_ml || ':' || pd.precio::text, ',') AS precios_raw,
               COALESCE(rl.costo_agregado, 0) AS ultimo_restock_costo,
               COALESCE(rl.ml_agregados,   0) AS ultimo_restock_ml
        FROM perfumes p
        LEFT JOIN precios_decants pd ON pd.perfume_id = p.id
        LEFT JOIN LATERAL (
            SELECT costo_agregado, ml_agregados
            FROM restock_log
            WHERE perfume_id = p.id
            ORDER BY id DESC LIMIT 1
        ) rl ON TRUE
        WHERE (lower(p.nombre) LIKE %s OR lower(p.marca) LIKE %s)
          AND (p.eliminado IS NULL OR p.eliminado = FALSE)
          {filtro_activo}
        GROUP BY p.id, rl.costo_agregado, rl.ml_agregados
        ORDER BY p.marca, p.nombre
    """, (q, q)).fetchall()
    conn.close()
    result = [_parse_perfume_row(dict(r)) for r in rows]
    _cache_set(cache_key, result)
    return result


def get_perfume(perfume_id):
    conn = get_conn()
    row = conn.execute("""
        SELECT p.*,
               STRING_AGG(pd.formato_ml || ':' || pd.precio::text, ',') AS precios_raw,
               COALESCE(rl.costo_agregado, 0) AS ultimo_restock_costo,
               COALESCE(rl.ml_agregados,   0) AS ultimo_restock_ml
        FROM perfumes p
        LEFT JOIN precios_decants pd ON pd.perfume_id = p.id
        LEFT JOIN LATERAL (
            SELECT costo_agregado, ml_agregados
            FROM restock_log
            WHERE perfume_id = p.id
            ORDER BY id DESC LIMIT 1
        ) rl ON TRUE
        WHERE p.id = %s
        GROUP BY p.id, rl.costo_agregado, rl.ml_agregados
    """, (perfume_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return _parse_perfume_row(dict(row))


def _fetch_perfume_in_conn(conn, perfume_id: int) -> dict | None:
    """Obtiene datos de un perfume reutilizando una conexión ya abierta."""
    row = conn.execute("""
        SELECT p.*,
               STRING_AGG(pd.formato_ml || ':' || pd.precio::text, ',') AS precios_raw,
               COALESCE(rl.costo_agregado, 0) AS ultimo_restock_costo,
               COALESCE(rl.ml_agregados,   0) AS ultimo_restock_ml
        FROM perfumes p
        LEFT JOIN precios_decants pd ON pd.perfume_id = p.id
        LEFT JOIN LATERAL (
            SELECT costo_agregado, ml_agregados
            FROM restock_log
            WHERE perfume_id = p.id
            ORDER BY id DESC LIMIT 1
        ) rl ON TRUE
        WHERE p.id = %s
        GROUP BY p.id, rl.costo_agregado, rl.ml_agregados
    """, (perfume_id,)).fetchone()
    if not row:
        return None
    return _parse_perfume_row(dict(row))


def get_precio_decant(perfume_id, formato_ml):
    conn = get_conn()
    row = conn.execute(
        "SELECT precio FROM precios_decants WHERE perfume_id=%s AND formato_ml=%s",
        (perfume_id, formato_ml)
    ).fetchone()
    conn.close()
    return row["precio"] if row else 0


def crear_perfume(nombre, marca, ml_totales, costo_total, precios_dict, precio_botella=0, tipo_venta="decants", unidades=1, ml_disponibles_inicial=None):
    """
    Crea un perfume y devuelve su dict completo dentro de la misma conexión.
    Para tipo_venta='botella', `unidades` establece el stock inicial:
      ml_disponibles = unidades * ml_totales
    Para decants, ml_disponibles = ml_totales (una sola botella),
      salvo que se indique ml_disponibles_inicial (botella parcialmente usada).
    """
    conn = get_conn()
    # Botellas completas: stock = N botellas × ml por botella
    if tipo_venta in ("botella", "parcial") and unidades > 1:
        ml_disp_inicial = float(ml_totales) * int(unidades)
        costo_total_real = costo_total * int(unidades)
    else:
        # Si se indica stock inicial explícito (botella usada), respetar ese valor
        if ml_disponibles_inicial is not None and tipo_venta == "decants":
            ml_disp_inicial = float(ml_disponibles_inicial)
        else:
            ml_disp_inicial = float(ml_totales)
        costo_total_real = costo_total
    cur = conn.execute(
        "INSERT INTO perfumes(nombre,marca,ml_totales,ml_disponibles,costo_total,precio_botella,tipo_venta) "
        "VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING id",
        (nombre, marca, float(ml_totales), ml_disp_inicial, costo_total_real, precio_botella, tipo_venta)
    )
    _row = cur.fetchone()
    if _row is None:
        conn.rollback()
        conn.close()
        return None
    pid = _row["id"]
    for fmt, precio in precios_dict.items():
        if precio > 0:
            conn.execute(
                "INSERT INTO precios_decants(perfume_id,formato_ml,precio) VALUES(%s,%s,%s)",
                (pid, fmt, precio)
            )
    result = _fetch_perfume_in_conn(conn, pid)
    conn.commit()
    conn.close()
    _cache_invalidate("perfumes:", "stats")
    return result


def editar_perfume(perfume_id, nombre, marca, ml_totales, costo_total, precios_dict, precio_botella=0, tipo_venta="decants", ml_disponibles=None):
    """
    Edita un perfume. Reutiliza UNA SOLA conexión para todo:
    leer ratio, actualizar, actualizar precios y devolver datos frescos.
    (Antes abría 3 conexiones separadas: 2× get_perfume() + 1 UPDATE)
    Si ml_disponibles no es None, se usa ese valor directamente; de lo contrario
    se preserva el ratio actual respecto a ml_totales.
    """
    conn = get_conn()
    # 1. Leer ratio de ml dentro de la misma conexión
    p_row = conn.execute(
        "SELECT ml_disponibles, ml_totales FROM perfumes WHERE id=%s", (perfume_id,)
    ).fetchone()
    if not p_row:
        conn.close()
        return None

    if ml_disponibles is not None:
        nuevos_ml = round(float(ml_disponibles), 1)
    else:
        ratio     = p_row["ml_disponibles"] / p_row["ml_totales"] if p_row["ml_totales"] > 0 else 1
        nuevos_ml = round(float(ml_totales) * ratio, 1)

    # 2. Actualizar perfume
    conn.execute("""
        UPDATE perfumes
        SET nombre=%s, marca=%s, ml_totales=%s, ml_disponibles=%s,
            costo_total=%s, precio_botella=%s, tipo_venta=%s
        WHERE id=%s
    """, (nombre, marca, float(ml_totales), nuevos_ml,
          costo_total, precio_botella, tipo_venta, perfume_id))

    # 3. Actualizar precios (UPSERT)
    for fmt, precio in precios_dict.items():
        conn.execute("""
            INSERT INTO precios_decants(perfume_id, formato_ml, precio)
            VALUES(%s, %s, %s)
            ON CONFLICT(perfume_id, formato_ml) DO UPDATE SET precio=EXCLUDED.precio
        """, (perfume_id, fmt, precio))

    # 4. Leer datos frescos en la misma conexión
    result = _fetch_perfume_in_conn(conn, perfume_id)
    conn.commit()
    conn.close()
    _cache_invalidate("perfumes:", "stats")
    return result


def ajustar_stock_ml(perfume_id, delta_ml):
    """
    Suma o resta ml al stock disponible.
    delta_ml negativo = restar (venta). positivo = reponer.
    """
    conn = get_conn()
    row = conn.execute(
        "SELECT ml_disponibles, nombre FROM perfumes WHERE id=%s", (perfume_id,)
    ).fetchone()
    if not row:
        conn.close()
        return False, "Perfume no encontrado", 0

    nuevos_ml = row["ml_disponibles"] + delta_ml
    if nuevos_ml < 0:
        conn.close()
        return False, (
            f"Stock insuficiente para '{row['nombre']}'.\n"
            f"Disponible: {row['ml_disponibles']:.1f} ml  |  "
            f"Solicitado: {abs(delta_ml):.1f} ml"
        ), row["ml_disponibles"]

    conn.execute(
        "UPDATE perfumes SET ml_disponibles=%s WHERE id=%s", (nuevos_ml, perfume_id)
    )
    conn.commit()
    conn.close()
    _cache_invalidate("perfumes:", "stats")
    return True, "OK", nuevos_ml


def reponer_stock(perfume_id, ml_nuevos, costo_adicional=0):
    """
    Suma ml_nuevos a ml_disponibles del perfume.
    Para decants, también suma a ml_totales (stock acumulado).
    Para botellas/parcial, ml_totales es el tamaño fijo de UNA unidad y NO se toca.

    Lógica de costo:
    - Si el perfume es tipo botella/parcial Y su stock está en 0 (o negativo),
      se interpreta como un nuevo lote: costo_total se REEMPLAZA por costo_adicional
      (no se acumula sobre el anterior). El costo anterior se guarda en restock_log.
    - En cualquier otro caso (decants, o botella con stock parcial remanente),
      se sigue acumulando como antes.
    - Siempre se inserta una fila en restock_log para trazabilidad.
    """
    conn = get_conn()
    row = conn.execute(
        "SELECT nombre, ml_disponibles, ml_totales, costo_total, tipo_venta FROM perfumes WHERE id=%s",
        (perfume_id,)
    ).fetchone()
    if not row:
        conn.close()
        return False, "Perfume no encontrado", 0

    costo_anterior  = row["costo_total"] or 0
    ml_anterior     = row["ml_disponibles"]
    es_botella      = row.get("tipo_venta", "decants") in ("botella", "parcial")
    stock_vacio     = (ml_anterior <= 0)
    costo_adicional = max(0, int(costo_adicional))

    if es_botella and stock_vacio:
        nuevo_costo = costo_adicional
    else:
        nuevo_costo = costo_anterior + costo_adicional

    nuevos_ml_disp = ml_anterior + ml_nuevos

    conn.execute(
        """INSERT INTO restock_log(perfume_id, ml_agregados, costo_agregado, costo_anterior, ml_anterior)
           VALUES (%s, %s, %s, %s, %s)""",
        (perfume_id, ml_nuevos, costo_adicional, costo_anterior, ml_anterior)
    )

    if es_botella:
        conn.execute(
            "UPDATE perfumes SET ml_disponibles=%s, costo_total=%s, activo=1 WHERE id=%s",
            (nuevos_ml_disp, nuevo_costo, perfume_id)
        )
    else:
        nuevos_ml_tot = row["ml_totales"] + ml_nuevos
        conn.execute(
            "UPDATE perfumes SET ml_disponibles=%s, ml_totales=%s, costo_total=%s, activo=1 WHERE id=%s",
            (nuevos_ml_disp, nuevos_ml_tot, nuevo_costo, perfume_id)
        )

    conn.commit()
    conn.close()
    _cache_invalidate("perfumes:", "stats")
    return True, "OK", nuevos_ml_disp


# ════════════════════════════════════════════════════════════════════════════
#  VENTAS
# ════════════════════════════════════════════════════════════════════════════
def get_ventas(query="", filtro_estado="Todos"):
    cache_key = f"ventas:{query.lower()}:{filtro_estado}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    conn = get_conn()

    if query:
        q           = f"%{query.lower()}%"
        nombre_cond = "lower(c.nombre) LIKE %s"
        base_params = [q]
    else:
        nombre_cond = "TRUE"
        base_params = []

    rows = conn.execute(f"""
        SELECT v.*,
               c.nombre    AS cliente_nombre,
               c.telefono  AS cliente_tel
        FROM ventas v
        LEFT JOIN clientes c ON c.id = v.cliente_id
        WHERE {nombre_cond}
        ORDER BY v.id DESC
    """, base_params).fetchall()

    if not rows:
        conn.close()
        return []

    ventas    = [dict(r) for r in rows]
    venta_ids = [v["id"] for v in ventas]

    # Cuando no hay query de búsqueda no necesitamos los ítems para filtrar:
    # se dejan en None para que ModalDetalleVenta los cargue bajo demanda.
    # Cuando SÍ hay query, los ítems se necesitan para buscar por nombre de producto.
    if query:
        detalle_rows = conn.execute("""
            SELECT dv.*, p.nombre AS perfume_nombre, p.marca
            FROM detalle_venta dv
            JOIN perfumes p ON p.id = dv.perfume_id
            WHERE dv.venta_id IN %s
        """, (tuple(venta_ids),)).fetchall()
        detalles_por_venta: dict = {}
        for dr in detalle_rows:
            d = dict(dr)
            detalles_por_venta.setdefault(d["venta_id"], []).append(d)
    else:
        detalles_por_venta = {}

    conn.close()

    result = []
    for d in ventas:
        if isinstance(d.get("fecha"), date):
            d["fecha"] = d["fecha"].isoformat()
        # None = ítems no cargados (carga diferida); [] = venta sin ítems
        d["items"] = detalles_por_venta.get(d["id"]) if query else None
        if filtro_estado != "Todos" and d["estado_pago"] != filtro_estado:
            continue
        if query and query.lower() not in (d.get("cliente_nombre") or "").lower():
            nombres_prod = " ".join(i["perfume_nombre"] for i in (d["items"] or []))
            if query.lower() not in nombres_prod.lower():
                continue
        result.append(d)
    _cache_set(cache_key, result)
    return result


def get_detalle_venta(venta_id):
    conn = get_conn()
    rows = conn.execute("""
        SELECT dv.*, p.nombre AS perfume_nombre, p.marca
        FROM detalle_venta dv
        JOIN perfumes p ON p.id = dv.perfume_id
        WHERE dv.venta_id = %s
    """, (venta_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _costo_por_ml(perfume_row) -> float:
    ml_totales = perfume_row["ml_totales"] or 1
    return round((perfume_row["costo_total"] or 0) / ml_totales, 4)


def crear_venta(cliente_id, items, metodo_pago, tipo_entrega, estado_pago,
                descuento=0, costo_envio=0, notas=""):
    """
    Crea una venta y sus detalles.

    OPTIMIZACIÓN: verificación de stock con UN SOLO SELECT ... IN
    en lugar de N SELECT individuales (uno por ítem).
    Todo dentro de UNA SOLA conexión.
    """
    conn = get_conn()

    # 1. Verificar stock con una sola consulta IN
    perfume_ids = [item["perfume_id"] for item in items]
    stock_rows  = conn.execute(
        "SELECT id, nombre, activo, ml_disponibles, ml_totales, costo_total "
        "FROM perfumes WHERE id IN %s",
        (tuple(perfume_ids),)
    ).fetchall()
    stock_map = {r["id"]: dict(r) for r in stock_rows}

    for item in items:
        pid = item["perfume_id"]
        if pid not in stock_map:
            conn.rollback(); conn.close()
            return False, f"Perfume id={pid} no encontrado", None
        p   = stock_map[pid]
        if p["activo"] == 0:
            conn.rollback(); conn.close()
            return False, f"'{p['nombre']}' está inactivo / agotado.", None
        es_completa = bool(item.get("es_botella_completa", 0))
        if es_completa:
            ml_por_bot = p["ml_totales"] or 1
            unidades_disp = int(p["ml_disponibles"] / ml_por_bot)
            if item["cantidad"] > unidades_disp:
                conn.rollback(); conn.close()
                return False, (
                    f"Stock insuficiente para '{p['nombre']}' (botella completa).\n"
                    f"Disponible: {unidades_disp} unidad(es)  |  "
                    f"Solicitado: {item['cantidad']}"
                ), None
        else:
            fmt_num       = float(item["formato_ml"].replace("ml", ""))
            ml_necesarios = fmt_num * item["cantidad"]
            if p["ml_disponibles"] < ml_necesarios:
                conn.rollback(); conn.close()
                return False, (
                    f"Stock insuficiente para '{p['nombre']}' ({item['formato_ml']}).\n"
                    f"Disponible: {p['ml_disponibles']:.1f} ml  |  "
                    f"Necesario: {ml_necesarios:.1f} ml"
                ), None

    # 2. Calcular total
    subtotales = [i["precio_unit"] * i["cantidad"] for i in items]
    total      = sum(subtotales) - descuento + costo_envio

    # 3. Insertar venta
    cur = conn.execute("""
        INSERT INTO ventas(cliente_id, fecha, metodo_pago, tipo_entrega, estado_pago,
                           descuento, costo_envio, total, notas)
        VALUES(%s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
    """, (cliente_id, date.today(), metodo_pago, tipo_entrega, estado_pago,
          descuento, costo_envio, total, notas))
    _vrow = cur.fetchone()
    if _vrow is None:
        conn.rollback()
        conn.close()
        return False, "Error interno al crear la venta", None
    venta_id = _vrow["id"]

    # Obtener IDs de insumos de bolsas (se descuentan 1 por pedido, no por ítem)
    bolsa_rows = conn.execute(
        "SELECT id FROM insumos WHERE categoria = 'Bolsas de packaging'"
    ).fetchall()
    bolsa_ids = {r["id"] for r in bolsa_rows}
    bolsas_descontadas = set()  # control para no descontar la misma bolsa más de una vez

    # ── Pre-cargar recetas de todos los formatos en UNA sola query ────────────
    fmt_keys_needed = set()
    for item in items:
        fmt_keys_needed.add("botella" if item.get("es_botella_completa") else item["formato_ml"])
    if fmt_keys_needed:
        all_recipe_rows = conn.execute("""
            SELECT ipf.formato_ml, ipf.insumo_id, ipf.cantidad, i.costo_unitario
            FROM insumos_por_formato ipf
            JOIN insumos i ON i.id = ipf.insumo_id
            WHERE ipf.formato_ml IN %s
        """, (tuple(fmt_keys_needed),)).fetchall()
    else:
        all_recipe_rows = []
    _recipes_by_fmt = defaultdict(list)
    for _r in all_recipe_rows:
        _recipes_by_fmt[_r["formato_ml"]].append(_r)

    # 4. Insertar detalle y descontar stock (usando stock_map ya cargado)
    for item, sub in zip(items, subtotales):
        es_completa  = bool(item.get("es_botella_completa", 0))
        p_row        = stock_map[item["perfume_id"]]
        costo_por_ml = _costo_por_ml(p_row)
        fmt_key      = "botella" if es_completa else item["formato_ml"]

        # ── Calcular costo de insumos para este ítem ──────────────────────
        receta_rows = _recipes_by_fmt[fmt_key]
        costo_insumos_unit = sum(
            float(r["cantidad"]) * float(r["costo_unitario"])
            for r in receta_rows
        )
        costo_insumos_total = round(costo_insumos_unit * item["cantidad"], 2)

        if es_completa:
            ml_por_bot     = p_row["ml_totales"] or 1
            ml_vendidos    = ml_por_bot * item["cantidad"]
            costo_unitario = round(costo_por_ml * ml_por_bot, 2)
            conn.execute("""
                INSERT INTO detalle_venta
                    (venta_id, perfume_id, formato_ml, cantidad, precio_unit, subtotal,
                     costo_unitario, es_botella_completa, costo_insumos)
                VALUES(%s, %s, 'botella', %s, %s, %s, %s, 1, %s)
            """, (venta_id, item["perfume_id"], item["cantidad"],
                  item["precio_unit"], sub,
                  costo_unitario, costo_insumos_total))
            nuevo_ml = p_row["ml_disponibles"] - ml_vendidos
            conn.execute(
                "UPDATE perfumes SET ml_disponibles=%s, activo = CASE WHEN %s <= 0 THEN 0 ELSE activo END WHERE id=%s",
                (max(0, nuevo_ml), nuevo_ml, item["perfume_id"])
            )
        else:
            fmt_num        = float(item["formato_ml"].replace("ml", ""))
            ml_vendidos    = fmt_num * item["cantidad"]
            costo_unitario = round(costo_por_ml * fmt_num, 2)
            conn.execute("""
                INSERT INTO detalle_venta
                    (venta_id, perfume_id, formato_ml, cantidad, precio_unit, subtotal,
                     costo_unitario, es_botella_completa, costo_insumos)
                VALUES(%s, %s, %s, %s, %s, %s, %s, 0, %s)
            """, (venta_id, item["perfume_id"], item["formato_ml"],
                  item["cantidad"], item["precio_unit"], sub,
                  costo_unitario, costo_insumos_total))
            conn.execute(
                "UPDATE perfumes SET ml_disponibles = ml_disponibles - %s WHERE id=%s",
                (ml_vendidos, item["perfume_id"])
            )

        # ── Descontar stock de cada insumo en la receta ───────────────────
        for r in receta_rows:
            insumo_id = r["insumo_id"]
            if insumo_id in bolsa_ids:
                # Bolsas: 1 por pedido. Si ya se descontó esta bolsa, saltar.
                if insumo_id not in bolsas_descontadas:
                    conn.execute(
                        "UPDATE insumos SET stock_actual = GREATEST(0, stock_actual - 1) WHERE id=%s",
                        (insumo_id,)
                    )
                    bolsas_descontadas.add(insumo_id)
            else:
                consumo = float(r["cantidad"]) * item["cantidad"]
                conn.execute(
                    "UPDATE insumos SET stock_actual = GREATEST(0, stock_actual - %s) WHERE id=%s",
                    (consumo, insumo_id)
                )

    # ── Descontar bolsas 1 vez por pedido (no están en recetas) ───────────
    for bolsa_id in bolsa_ids:
        if bolsa_id not in bolsas_descontadas:
            conn.execute(
                "UPDATE insumos SET stock_actual = GREATEST(0, stock_actual - 1) WHERE id=%s",
                (bolsa_id,)
            )

    conn.commit()
    conn.close()
    _cache_invalidate("ventas:", "perfumes:", "clientes:", "insumos:", "recetas:", "stats")
    return True, "OK", venta_id


def eliminar_cliente(cliente_id):
    conn = get_conn()
    try:
        conn.execute("UPDATE ventas SET cliente_id=NULL WHERE cliente_id=%s", (cliente_id,))
        conn.execute("DELETE FROM clientes WHERE id=%s", (cliente_id,))
        conn.commit()
        _cache_invalidate("clientes:", "ventas:", "stats")
        return True, "OK"
    except Exception as e:
        conn.rollback()
        return False, str(e)
    finally:
        conn.close()


def eliminar_perfume(perfume_id):
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE perfumes SET eliminado = TRUE WHERE id = %s",
            (perfume_id,)
        )
        conn.commit()
        _cache_invalidate("perfumes:", "ventas:", "stats")
        return True, "OK"
    except Exception as e:
        conn.rollback()
        return False, str(e)
    finally:
        conn.close()


def marcar_pagado(venta_id):
    conn = get_conn()
    conn.execute("UPDATE ventas SET estado_pago='Pagado' WHERE id=%s", (venta_id,))
    conn.commit()
    conn.close()
    _cache_invalidate("ventas:", "stats", "clientes:")


# ════════════════════════════════════════════════════════════════════════════
#  REPORTES / STATS
# ════════════════════════════════════════════════════════════════════════════
def get_stats():
    """Retorna stats globales en una sola consulta."""
    cached = _cache_get("stats")
    if cached is not None:
        return cached
    conn = get_conn()
    row = conn.execute("""
        SELECT
            (SELECT COALESCE(SUM(total),0) FROM ventas)                                AS ventas_total,
            (SELECT COUNT(*)               FROM ventas)                                AS ordenes,
            (SELECT COALESCE(SUM(total),0) FROM ventas WHERE estado_pago='Pendiente') AS por_cobrar,
            (SELECT COUNT(*)               FROM perfumes WHERE activo=1 AND (eliminado IS NULL OR eliminado = FALSE)) AS perfumes,
            (SELECT COUNT(*)               FROM clientes)                              AS clientes
    """).fetchone()
    conn.close()
    result = dict(row)
    _cache_set("stats", result)
    return result


def get_profit_stats():
    conn = get_conn()
    row = conn.execute("""
        SELECT
            COALESCE(SUM(dv.subtotal), 0)                      AS ingresos_total,
            COALESCE(SUM(dv.costo_unitario * dv.cantidad), 0)  AS costos_total
        FROM detalle_venta dv
    """).fetchone()
    conn.close()
    ingresos = float(row["ingresos_total"])
    costos   = float(row["costos_total"])
    utilidad = ingresos - costos
    margen   = round(utilidad / ingresos * 100, 1) if ingresos > 0 else 0.0
    return {
        "ingresos_total": ingresos,
        "costos_total":   costos,
        "utilidad_total": utilidad,
        "margen_pct":     margen,
    }


def get_top_perfumes(n=5, desde=None, hasta=None, tipo=None):
    conn = get_conn()
    where_parts = []
    params = []
    if desde:
        where_parts.append("v.fecha >= %s")
        params.append(desde)
    if hasta:
        where_parts.append("v.fecha <= %s")
        params.append(hasta)
    if tipo in ("decants", "botella"):
        tipo_val = 1 if tipo == "botella" else 0
        where_parts.append("dv.es_botella_completa = %s")
        params.append(tipo_val)
    where = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""
    params.append(n)
    rows = conn.execute(f"""
        SELECT p.nombre, p.marca, SUM(dv.cantidad) AS total_vendido
        FROM detalle_venta dv
        JOIN perfumes p ON p.id = dv.perfume_id
        JOIN ventas v ON v.id = dv.venta_id
        {where}
        GROUP BY dv.perfume_id, p.nombre, p.marca
        ORDER BY total_vendido DESC
        LIMIT %s
    """, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_stats_rango(fecha_desde=None, fecha_hasta=None, tipo=None):
    """
    Stats filtradas por rango de fechas y tipo de venta.

    tipo: None | "todos" → sin filtro de tipo
          "decants"      → solo ítems es_botella_completa=0
          "botella"      → solo ítems es_botella_completa=1

    OPTIMIZACIÓN: 1 sola consulta con CTE → 1 round-trip.
    """
    conn = get_conn()

    where_parts: list[str] = []
    params: list = []
    if fecha_desde:
        where_parts.append("v.fecha >= %s")
        params.append(fecha_desde)
    if fecha_hasta:
        where_parts.append("v.fecha <= %s")
        params.append(fecha_hasta)
    where = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""

    if tipo in ("decants", "botella"):
        tipo_val = 1 if tipo == "botella" else 0
        params_q = params + [tipo_val]
        row = conn.execute(f"""
            WITH ventas_rango AS (
                SELECT v.id, v.total, v.estado_pago
                FROM ventas v {where}
            ),
            filtered_items AS (
                SELECT dv.venta_id,
                       dv.subtotal,
                       dv.costo_unitario * dv.cantidad AS costo_perf,
                       dv.costo_insumos,
                       vr.estado_pago
                FROM detalle_venta dv
                JOIN ventas_rango vr ON vr.id = dv.venta_id
                WHERE dv.es_botella_completa = %s
            ),
            profit AS (
                SELECT
                    COALESCE(SUM(fi.subtotal), 0)      AS ingresos_total,
                    COALESCE(SUM(fi.costo_perf), 0)    AS costos_perfume,
                    COALESCE(SUM(fi.costo_insumos), 0) AS costos_insumos,
                    COUNT(DISTINCT fi.venta_id)         AS ordenes_count
                FROM filtered_items fi
            )
            SELECT
                p.ingresos_total                                                                                     AS ventas_total,
                p.ordenes_count                                                                                      AS ordenes,
                (SELECT COALESCE(SUM(fi2.subtotal), 0) FROM filtered_items fi2 WHERE fi2.estado_pago = 'Pendiente') AS por_cobrar,
                (SELECT COUNT(*) FROM perfumes WHERE activo=1)                                                       AS perfumes,
                (SELECT COUNT(*) FROM clientes)                                                                      AS clientes,
                p.ingresos_total,
                p.costos_perfume,
                p.costos_insumos,
                (p.costos_perfume + p.costos_insumos) AS costos_total
            FROM profit p
        """, params_q).fetchone()
    else:
        # Sin filtro de tipo: consulta original
        row = conn.execute(f"""
            WITH ventas_rango AS (
                SELECT v.id, v.total, v.estado_pago
                FROM ventas v {where}
            ),
            profit AS (
                SELECT
                    COALESCE(SUM(dv.subtotal), 0)                                           AS ingresos_total,
                    COALESCE(SUM(dv.costo_unitario * dv.cantidad), 0)                       AS costos_perfume,
                    COALESCE(SUM(dv.costo_insumos), 0)                                      AS costos_insumos
                FROM detalle_venta dv
                JOIN ventas_rango vr ON vr.id = dv.venta_id
            )
            SELECT
                (SELECT COALESCE(SUM(total), 0)                                             FROM ventas_rango)            AS ventas_total,
                (SELECT COUNT(*)                                                             FROM ventas_rango)            AS ordenes,
                (SELECT COALESCE(SUM(CASE WHEN estado_pago='Pendiente' THEN total END), 0)  FROM ventas_rango)            AS por_cobrar,
                (SELECT COUNT(*)                                                             FROM perfumes WHERE activo=1) AS perfumes,
                (SELECT COUNT(*)                                                             FROM clientes)                AS clientes,
                p.ingresos_total,
                p.costos_perfume,
                p.costos_insumos,
                (p.costos_perfume + p.costos_insumos) AS costos_total
            FROM profit p
        """, params).fetchone()

    conn.close()

    ingresos = float(row["ingresos_total"])
    costos   = float(row["costos_total"])
    utilidad = ingresos - costos
    margen   = round(utilidad / ingresos * 100, 1) if ingresos > 0 else 0.0

    return {
        "ventas_total":    float(row["ventas_total"]),
        "ordenes":         row["ordenes"],
        "por_cobrar":      float(row["por_cobrar"]),
        "perfumes":        row["perfumes"],
        "clientes":        row["clientes"],
        "ingresos_total":  ingresos,
        "costos_total":    costos,
        "costos_perfume":  float(row["costos_perfume"]),
        "costos_insumos":  float(row["costos_insumos"]),
        "utilidad_total":  utilidad,
        "margen_pct":      margen,
    }


def get_ventas_por_periodo(agrupacion="dia", fecha_desde=None, fecha_hasta=None, tipo=None):
    """
    Retorna lista de {periodo, total, ordenes} agrupado por día, mes o año.
    agrupacion: "dia" | "mes" | "anio"
    tipo: None | "todos" → sin filtro; "decants" | "botella" → filtra por es_botella_completa
    """
    conn = get_conn()
    params: list = []

    if agrupacion == "mes":
        fmt_expr = "TO_CHAR(v.fecha, 'YYYY-MM')"
    elif agrupacion == "anio":
        fmt_expr = "TO_CHAR(v.fecha, 'YYYY')"
    else:
        fmt_expr = "TO_CHAR(v.fecha, 'YYYY-MM-DD')"

    if tipo in ("decants", "botella"):
        tipo_val = 1 if tipo == "botella" else 0
        condiciones: list[str] = []
        if fecha_desde:
            condiciones.append("v.fecha >= %s")
            params.append(fecha_desde)
        if fecha_hasta:
            condiciones.append("v.fecha <= %s")
            params.append(fecha_hasta)
        condiciones.append("dv.es_botella_completa = %s")
        params.append(tipo_val)
        where = "WHERE " + " AND ".join(condiciones)
        rows = conn.execute(f"""
            SELECT {fmt_expr}             AS periodo,
                   SUM(dv.subtotal)       AS total,
                   COUNT(DISTINCT v.id)   AS ordenes
            FROM ventas v
            JOIN detalle_venta dv ON dv.venta_id = v.id
            {where}
            GROUP BY periodo
            ORDER BY periodo
        """, params).fetchall()
    else:
        condiciones = []
        if fecha_desde:
            condiciones.append("fecha >= %s")
            params.append(fecha_desde)
        if fecha_hasta:
            condiciones.append("fecha <= %s")
            params.append(fecha_hasta)
        where = ("WHERE " + " AND ".join(condiciones)) if condiciones else ""
        fmt_expr_plain = fmt_expr.replace("v.fecha", "fecha")
        rows = conn.execute(f"""
            SELECT {fmt_expr_plain}  AS periodo,
                   SUM(total)        AS total,
                   COUNT(*)          AS ordenes
            FROM ventas
            {where}
            GROUP BY periodo
            ORDER BY periodo
        """, params).fetchall()

    conn.close()
    return [dict(r) for r in rows]


def get_costos_por_periodo(agrupacion="dia", fecha_desde=None, fecha_hasta=None, tipo=None):
    """
    Retorna lista de {periodo, costo_total} agrupado por día, mes o año.
    tipo: None | "todos" → sin filtro; "decants" | "botella" → filtra por es_botella_completa
    """
    conn = get_conn()
    condiciones: list[str] = []
    params: list = []
    if fecha_desde:
        condiciones.append("v.fecha >= %s")
        params.append(fecha_desde)
    if fecha_hasta:
        condiciones.append("v.fecha <= %s")
        params.append(fecha_hasta)
    if tipo in ("decants", "botella"):
        condiciones.append("dv.es_botella_completa = %s")
        params.append(1 if tipo == "botella" else 0)
    where = ("WHERE " + " AND ".join(condiciones)) if condiciones else ""

    if agrupacion == "mes":
        fmt_expr = "TO_CHAR(v.fecha, 'YYYY-MM')"
    elif agrupacion == "anio":
        fmt_expr = "TO_CHAR(v.fecha, 'YYYY')"
    else:
        fmt_expr = "TO_CHAR(v.fecha, 'YYYY-MM-DD')"

    rows = conn.execute(f"""
        SELECT {fmt_expr}                                          AS periodo,
               COALESCE(SUM(dv.costo_unitario * dv.cantidad), 0)  AS costo_total
        FROM ventas v
        JOIN detalle_venta dv ON dv.venta_id = v.id
        {where}
        GROUP BY periodo
        ORDER BY periodo
    """, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ════════════════════════════════════════════════════════════════════════════
#  INSUMOS  (frascos, bolsas, etiquetas, packaging)
# ════════════════════════════════════════════════════════════════════════════

def get_insumos(query: str = "") -> list[dict]:
    """Lista todos los insumos, opcionalmente filtrados por nombre o categoría."""
    cache_key = f"insumos:{query.lower()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    conn = get_conn()
    q    = f"%{query.lower()}%"
    rows = conn.execute("""
        SELECT * FROM insumos
        WHERE lower(nombre) LIKE %s OR lower(categoria) LIKE %s
        ORDER BY
            CASE formato_ml
                WHEN '2ml'     THEN 1
                WHEN '3ml'     THEN 2
                WHEN '5ml'     THEN 3
                WHEN '10ml'    THEN 4
                WHEN 'botella' THEN 5
                ELSE 6
            END,
            categoria, nombre
    """, (q, q)).fetchall()

    # Obtener formatos vinculados para cada insumo
    insumo_ids = [r["id"] for r in rows]
    vinculados = {}
    if insumo_ids:
        links = conn.execute(
            "SELECT insumo_id, formato_ml FROM insumos_por_formato WHERE insumo_id = ANY(%s)",
            (insumo_ids,)
        ).fetchall()
        for lnk in links:
            vinculados.setdefault(lnk["insumo_id"], []).append(lnk["formato_ml"])

    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["formatos_vinculados"] = vinculados.get(d["id"], [])
        result.append(d)
    _cache_set(cache_key, result)
    return result


def get_insumo(insumo_id: int) -> dict | None:
    conn = get_conn()
    row  = conn.execute("SELECT * FROM insumos WHERE id=%s", (insumo_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_stock_frascos_formato(formato_ml: str) -> float:
    """Retorna el stock total de insumos (frascos) registrados para el formato indicado.
    Suma stock_actual de todos los insumos con ese formato_ml.
    Retorna 0.0 si no hay ningún insumo para ese formato."""
    cache_key = f"insumos:stock_frascos:{formato_ml}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    conn = get_conn()
    row = conn.execute(
        "SELECT COALESCE(SUM(stock_actual), 0) AS total FROM insumos WHERE formato_ml = %s",
        (formato_ml,)
    ).fetchone()
    conn.close()
    result = float(row["total"]) if row else 0.0
    _cache_set(cache_key, result)
    return result


def crear_insumo(nombre: str, categoria: str, stock_actual: float,
                 costo_unitario: float, formato_ml: str = "",
                 formatos_vinculados: list[str] | None = None) -> dict:
    """Crea un insumo y lo enlaza automáticamente a la receta de su formato."""
    conn = get_conn()
    fmt  = (formato_ml or "").strip()
    cur  = conn.execute(
        "INSERT INTO insumos(nombre, categoria, formato_ml, stock_actual, costo_unitario) "
        "VALUES(%s, %s, %s, %s, %s) RETURNING *",
        (nombre.strip(), categoria.strip(), fmt,
         float(stock_actual), float(costo_unitario))
    )
    row = cur.fetchone()
    if row is None:
        conn.rollback()
        conn.close()
        return None
    insumo_id = row["id"]
    # ── Auto-enlazar a receta ────────────────────────────────────────────
    if formatos_vinculados is not None:
        # Vinculación explícita (insumos sin formato propio: bolsas, etc.)
        for f in formatos_vinculados:
            conn.execute("""
                INSERT INTO insumos_por_formato(formato_ml, insumo_id, cantidad)
                VALUES(%s, %s, 1)
                ON CONFLICT(formato_ml, insumo_id) DO NOTHING
            """, (f, insumo_id))
    elif fmt in ("2ml", "3ml", "5ml", "10ml"):
        # Vinculación automática para Frascos/Jeringas
        conn.execute("""
            INSERT INTO insumos_por_formato(formato_ml, insumo_id, cantidad)
            VALUES(%s, %s, 1)
            ON CONFLICT(formato_ml, insumo_id) DO NOTHING
        """, (fmt, insumo_id))
    conn.commit()
    conn.close()
    _cache_invalidate("insumos:", "recetas:", "stats")
    return dict(row)


def editar_insumo(insumo_id: int, nombre: str, categoria: str,
                  stock_actual: float, costo_unitario: float,
                  formato_ml: str = "",
                  formatos_vinculados: list[str] | None = None) -> dict | None:
    """Actualiza un insumo y sincroniza su entrada en insumos_por_formato."""
    conn = get_conn()
    fmt_nuevo = (formato_ml or "").strip()

    # Leer formato anterior ANTES del UPDATE
    old = conn.execute(
        "SELECT formato_ml FROM insumos WHERE id=%s", (insumo_id,)
    ).fetchone()
    fmt_viejo = (old["formato_ml"] or "").strip() if old else ""

    conn.execute("""
        UPDATE insumos
        SET nombre=%s, categoria=%s, formato_ml=%s, stock_actual=%s, costo_unitario=%s
        WHERE id=%s
    """, (nombre.strip(), categoria.strip(), fmt_nuevo,
          float(stock_actual), float(costo_unitario), insumo_id))

    # ── Sincronizar insumos_por_formato ──────────────────────────────────
    if formatos_vinculados is not None:
        # Vinculación explícita: limpiar todo y reinsertar
        conn.execute(
            "DELETE FROM insumos_por_formato WHERE insumo_id=%s", (insumo_id,)
        )
        for f in formatos_vinculados:
            conn.execute("""
                INSERT INTO insumos_por_formato(formato_ml, insumo_id, cantidad)
                VALUES(%s, %s, 1)
                ON CONFLICT(formato_ml, insumo_id) DO NOTHING
            """, (f, insumo_id))
    else:
        # Frascos/Jeringas: sincronizar formato único
        if fmt_viejo != fmt_nuevo:
            if fmt_viejo in ("2ml", "3ml", "5ml", "10ml"):
                conn.execute(
                    "DELETE FROM insumos_por_formato WHERE formato_ml=%s AND insumo_id=%s",
                    (fmt_viejo, insumo_id)
                )
        if fmt_nuevo in ("2ml", "3ml", "5ml", "10ml"):
            conn.execute("""
                INSERT INTO insumos_por_formato(formato_ml, insumo_id, cantidad)
                VALUES(%s, %s, 1)
                ON CONFLICT(formato_ml, insumo_id) DO NOTHING
            """, (fmt_nuevo, insumo_id))

    row = conn.execute("SELECT * FROM insumos WHERE id=%s", (insumo_id,)).fetchone()
    conn.commit()
    conn.close()
    _cache_invalidate("insumos:", "recetas:", "stats")
    return dict(row) if row else None


def eliminar_insumo(insumo_id: int) -> tuple[bool, str]:
    """Elimina un insumo. Las recetas que lo usan se borran en cascada."""
    conn = get_conn()
    try:
        conn.execute("DELETE FROM insumos WHERE id=%s", (insumo_id,))
        conn.commit()
        _cache_invalidate("insumos:", "recetas:", "stats")
        return True, "OK"
    except Exception as e:
        conn.rollback()
        return False, str(e)
    finally:
        conn.close()


def reponer_insumo(insumo_id: int, cantidad: float,
                   costo_nuevo: float | None = None) -> dict | None:
    """
    Suma `cantidad` al stock.
    Si se pasa `costo_nuevo`, actualiza el costo unitario con promedio ponderado:
        nuevo_costo = (stock_actual * costo_actual + cantidad * costo_nuevo)
                      / (stock_actual + cantidad)
    """
    conn = get_conn()
    row  = conn.execute(
        "SELECT stock_actual, costo_unitario FROM insumos WHERE id=%s", (insumo_id,)
    ).fetchone()
    if not row:
        conn.close()
        return None

    nuevo_stock = float(row["stock_actual"]) + float(cantidad)
    if costo_nuevo is not None and float(costo_nuevo) > 0:
        # Costo promedio ponderado
        nuevo_costo = (
            float(row["stock_actual"]) * float(row["costo_unitario"])
            + float(cantidad) * float(costo_nuevo)
        ) / max(nuevo_stock, 0.0001)
        nuevo_costo = round(nuevo_costo, 4)
    else:
        nuevo_costo = float(row["costo_unitario"])

    conn.execute(
        "UPDATE insumos SET stock_actual=%s, costo_unitario=%s WHERE id=%s",
        (nuevo_stock, nuevo_costo, insumo_id)
    )
    result = conn.execute("SELECT * FROM insumos WHERE id=%s", (insumo_id,)).fetchone()
    conn.commit()
    conn.close()
    _cache_invalidate("insumos:", "stats")
    return dict(result) if result else None


# ════════════════════════════════════════════════════════════════════════════
#  RECETAS  (qué insumos consume cada formato de decant)
# ════════════════════════════════════════════════════════════════════════════

def get_receta(formato_ml: str) -> list[dict]:
    """
    Retorna la lista de insumos que consume un formato dado.
    Cada elemento: {insumo_id, nombre, categoria, cantidad, costo_unitario}
    """
    cache_key = f"recetas:{formato_ml}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    conn = get_conn()
    rows = conn.execute("""
        SELECT ipf.insumo_id, ipf.cantidad,
               i.nombre, i.categoria, i.costo_unitario
        FROM insumos_por_formato ipf
        JOIN insumos i ON i.id = ipf.insumo_id
        WHERE ipf.formato_ml = %s
        ORDER BY i.categoria, i.nombre
    """, (formato_ml,)).fetchall()
    conn.close()
    result = [dict(r) for r in rows]
    _cache_set(cache_key, result)
    return result


def get_todas_recetas() -> dict[str, list[dict]]:
    """Retorna todas las recetas agrupadas por formato, incluyendo stock_actual.
    No usa caché porque el stock cambia frecuentemente."""
    conn = get_conn()
    rows = conn.execute("""
        SELECT ipf.formato_ml, ipf.insumo_id, ipf.cantidad,
               i.nombre, i.categoria, i.costo_unitario, i.stock_actual
        FROM insumos_por_formato ipf
        JOIN insumos i ON i.id = ipf.insumo_id
        ORDER BY ipf.formato_ml, i.categoria, i.nombre
    """).fetchall()
    conn.close()

    result: dict[str, list[dict]] = {}
    for r in rows:
        d = dict(r)
        result.setdefault(d["formato_ml"], []).append(d)
    return result


def set_receta(formato_ml: str, items: list[dict]) -> None:
    """
    Reemplaza completamente la receta de un formato.
    `items` = lista de {insumo_id: int, cantidad: float}
    """
    conn = get_conn()
    # Borrar receta existente para este formato
    conn.execute(
        "DELETE FROM insumos_por_formato WHERE formato_ml=%s", (formato_ml,)
    )
    # Insertar nuevas entradas
    for it in items:
        if float(it.get("cantidad", 0)) > 0:
            conn.execute(
                "INSERT INTO insumos_por_formato(formato_ml, insumo_id, cantidad) "
                "VALUES(%s, %s, %s) "
                "ON CONFLICT(formato_ml, insumo_id) DO UPDATE SET cantidad=EXCLUDED.cantidad",
                (formato_ml, int(it["insumo_id"]), float(it["cantidad"]))
            )
    conn.commit()
    conn.close()
    _cache_invalidate("recetas:")


# ════════════════════════════════════════════════════════════════════════════
#  STATS INSUMOS
# ════════════════════════════════════════════════════════════════════════════

def get_insumos_stats() -> dict:
    """
    Retorna un resumen del inventario de insumos:
      · n_insumos          – total de tipos de insumos registrados
      · valor_inventario   – Σ (stock_actual × costo_unitario)
      · n_bajo_stock       – insumos con stock_actual < 15
      · n_sin_stock        – insumos con stock_actual = 0
    """
    cache_key = "insumos:stats"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    conn = get_conn()
    row  = conn.execute("""
        SELECT
            COUNT(*)                                              AS n_insumos,
            COALESCE(SUM(stock_actual * costo_unitario), 0)      AS valor_inventario,
            COUNT(*) FILTER (WHERE stock_actual < 20)             AS n_bajo_stock,
            COUNT(*) FILTER (WHERE stock_actual = 0)             AS n_sin_stock
        FROM insumos
    """).fetchone()
    conn.close()
    result = {
        "n_insumos":        int(row["n_insumos"]),
        "valor_inventario": float(row["valor_inventario"]),
        "n_bajo_stock":     int(row["n_bajo_stock"]),
        "n_sin_stock":      int(row["n_sin_stock"]),
    }
    _cache_set(cache_key, result)
    return result
