"""
async_helper.py  –  Gabo Decants POS
Utilidades para ejecutar operaciones de BD en hilos secundarios sin bloquear la UI.

USO:
    from async_helper import run_async

    # En cualquier página o método de Tkinter:
    def _cargar_datos(self):
        self._lbl_cargando.configure(text="Cargando...")
        run_async(
            fn       = lambda: db.get_clientes(self.e_search.get()),
            callback = lambda datos: self.after(0, lambda: self._render(datos)),
            on_error = lambda e:     self.after(0, lambda: self._mostrar_error(str(e))),
        )

NOTAS:
    · callback y on_error se llaman desde el hilo secundario.  Usa siempre
      widget.after(0, ...) para actualizar la UI desde ellos (obligatorio en Tkinter).
    · El pool de conexiones de database.py es ThreadedConnectionPool,
      así que los hilos pueden llamar a db.get_conn() con seguridad.
"""

import threading


def run_async(fn, callback=None, on_error=None):
    """
    Ejecuta `fn()` en un hilo daemon y llama a `callback(result)` al terminar.
    Si ocurre una excepción llama a `on_error(exception)`.

    Parámetros:
        fn        - callable sin argumentos que hace el trabajo pesado (BD, IO).
        callback  - callable(result) que recibe el valor de retorno de fn.
                    IMPORTANTE: actualiza la UI con  widget.after(0, lambda: ...)
        on_error  - callable(exception) para manejar errores (opcional).
    """
    def _worker():
        try:
            result = fn()
            if callback:
                callback(result)
        except Exception as exc:
            if on_error:
                on_error(exc)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    return t
