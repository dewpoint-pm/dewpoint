/* ═══════════════════════════════════════════════════════════════
   db.js  —  Dew Point POS
   Capa de datos del frontend.
   Se comunica con un servidor backend Python (Flask/FastAPI)
   que expone los mismos métodos de database.py como endpoints REST.

   Si prefieres conectar directo a Neon/Supabase desde el navegador,
   reemplaza las URLs de fetch por tu endpoint de Supabase REST API.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ── URL base del backend. Cambia esto a tu servidor. ── */
var API_BASE = window.location.origin + '/api';

var DB = (function() {

  var _token = null;  /* JWT o session token tras login */
  var _tenantUrl = null;

  /* ── Helper fetch con manejo de errores ── */
  function apiFetch(path, opts, cb) {
    var headers = { 'Content-Type': 'application/json' };
    if (_token) headers['Authorization'] = 'Bearer ' + _token;
    var options = {
      method: opts.method || 'GET',
      headers: headers,
    };
    if (opts.body) options.body = JSON.stringify(opts.body);

    fetch(API_BASE + path, options)
      .then(function(res) { return res.json(); })
      .then(function(data) { cb(null, data); })
      .catch(function(err) { cb(err, null); });
  }

  /* ════════════════════════════════════════════════════════
     AUTENTICACIÓN
     Corresponde a: database.verificar_login()
     ════════════════════════════════════════════════════════ */
  function login(username, password, cb) {
    apiFetch('/auth/login', {
      method: 'POST',
      body: { username: username, password: password }
    }, function(err, data) {
      if (err || !data) {
        cb(false, 'Error de conexión. Verifica tu internet.');
        return;
      }
      if (data.ok) {
        _token = data.token;
        _tenantUrl = data.tenant_url;
        try { localStorage.setItem('dp_token', _token); } catch(e) {}
        cb(true, null);
      } else {
        cb(false, data.error || 'Credenciales incorrectas');
      }
    });
  }

  function logout() {
    _token = null;
    _tenantUrl = null;
    try { localStorage.removeItem('dp_token'); } catch(e) {}
  }

  /* ════════════════════════════════════════════════════════
     DASHBOARD — get_stats_rango()
     ════════════════════════════════════════════════════════ */
  function getStats(cb) {
    apiFetch('/stats', {}, function(err, data) {
      if (err) { cb(null); return; }
      cb(data);
    });
  }

  /* ════════════════════════════════════════════════════════
     PERFUMES — get_perfumes(), get_perfume(), crear_perfume(),
                editar_perfume(), eliminar_perfume(), reponer_stock()
     ════════════════════════════════════════════════════════ */
  function getPerfumes(query, cb) {
    apiFetch('/perfumes?q=' + encodeURIComponent(query || ''), {}, function(err, data) {
      cb(err ? [] : (data.perfumes || data));
    });
  }

  function getPerfume(id, cb) {
    apiFetch('/perfumes/' + id, {}, function(err, data) {
      cb(err ? null : data);
    });
  }

  function crearPerfume(perfume, cb) {
    apiFetch('/perfumes', { method: 'POST', body: perfume }, function(err, data) {
      cb(!err && data && data.ok, data ? data.error : 'Error');
    });
  }

  function editarPerfume(id, perfume, cb) {
    apiFetch('/perfumes/' + id, { method: 'PUT', body: perfume }, function(err, data) {
      cb(!err && data && data.ok, data ? data.error : 'Error');
    });
  }

  function eliminarPerfume(id, cb) {
    apiFetch('/perfumes/' + id, { method: 'DELETE' }, function(err, data) {
      cb(!err && data && data.ok);
    });
  }

  function reponerStock(id, mlNuevos, costo, cb) {
    apiFetch('/perfumes/' + id + '/reponer', {
      method: 'POST',
      body: { ml_nuevos: mlNuevos, costo_adicional: costo }
    }, function(err, data) {
      cb(!err && data && data.ok, data ? data.ml_disponibles : 0);
    });
  }

  /* ════════════════════════════════════════════════════════
     CLIENTES — get_clientes(), get_cliente(), crear_cliente(),
                editar_cliente(), eliminar_cliente()
     ════════════════════════════════════════════════════════ */
  function getClientes(query, cb) {
    apiFetch('/clientes?q=' + encodeURIComponent(query || ''), {}, function(err, data) {
      cb(err ? [] : (data.clientes || data));
    });
  }

  function crearCliente(cliente, cb) {
    apiFetch('/clientes', { method: 'POST', body: cliente }, function(err, data) {
      cb(!err && data && data.ok, data ? data.error : 'Error');
    });
  }

  function editarCliente(id, cliente, cb) {
    apiFetch('/clientes/' + id, { method: 'PUT', body: cliente }, function(err, data) {
      cb(!err && data && data.ok, data ? data.error : 'Error');
    });
  }

  function eliminarCliente(id, cb) {
    apiFetch('/clientes/' + id, { method: 'DELETE' }, function(err, data) {
      cb(!err && data && data.ok);
    });
  }

  /* ════════════════════════════════════════════════════════
     VENTAS — get_ventas(), crear_venta(), get_detalle_venta()
     ════════════════════════════════════════════════════════ */
  function getVentas(query, filtroEstado, cb) {
    var qs = '?q=' + encodeURIComponent(query || '') +
             '&estado=' + encodeURIComponent(filtroEstado || 'Todos');
    apiFetch('/ventas' + qs, {}, function(err, data) {
      cb(err ? [] : (data.ventas || data));
    });
  }

  function crearVenta(venta, cb) {
    /* venta = { cliente_id, items, metodo_pago, tipo_entrega,
                 estado_pago, descuento, costo_envio, notas } */
    apiFetch('/ventas', { method: 'POST', body: venta }, function(err, data) {
      if (err || !data) { cb(false, 'Error de red', null); return; }
      cb(data.ok, data.error, data.venta_id);
    });
  }

  function getDetalleVenta(ventaId, cb) {
    apiFetch('/ventas/' + ventaId + '/detalle', {}, function(err, data) {
      cb(err ? [] : (data.items || data));
    });
  }

  /* ════════════════════════════════════════════════════════
     INSUMOS — get_insumos(), get_insumos_stats(),
               crear_insumo(), editar_insumo(), eliminar_insumo()
     ════════════════════════════════════════════════════════ */
  function getInsumos(query, cb) {
    apiFetch('/insumos?q=' + encodeURIComponent(query || ''), {}, function(err, data) {
      cb(err ? [] : (data.insumos || data));
    });
  }

  function getInsumosStats(cb) {
    apiFetch('/insumos/stats', {}, function(err, data) {
      cb(err ? {} : data);
    });
  }

  function crearInsumo(insumo, cb) {
    apiFetch('/insumos', { method: 'POST', body: insumo }, function(err, data) {
      cb(!err && data && data.ok, data ? data.error : 'Error');
    });
  }

  function editarInsumo(id, insumo, cb) {
    apiFetch('/insumos/' + id, { method: 'PUT', body: insumo }, function(err, data) {
      cb(!err && data && data.ok, data ? data.error : 'Error');
    });
  }

  function eliminarInsumo(id, cb) {
    apiFetch('/insumos/' + id, { method: 'DELETE' }, function(err, data) {
      cb(!err && data && data.ok);
    });
  }

  /* ════════════════════════════════════════════════════════
     REPORTES / COSTOS — get_costos_perfumes()
     ════════════════════════════════════════════════════════ */
  function getCostos(cb) {
    apiFetch('/costos', {}, function(err, data) {
      cb(err ? null : data);
    });
  }

  function getVentasPorPeriodo(agrupacion, desde, hasta, cb) {
    var qs = '?agrupacion=' + (agrupacion||'dia') +
             '&desde=' + (desde||'') + '&hasta=' + (hasta||'');
    apiFetch('/reportes/ventas-periodo' + qs, {}, function(err, data) {
      cb(err ? [] : (data.periodos || data));
    });
  }

  /* ════════════════════════════════════════════════════════
     PREFERENCIAS — load_user_setting(), save_user_setting()
     ════════════════════════════════════════════════════════ */
  function loadSetting(key, defaultVal) {
    try {
      var v = localStorage.getItem('dp_setting_' + key);
      return v !== null ? JSON.parse(v) : defaultVal;
    } catch(e) { return defaultVal; }
  }

  function saveSetting(key, value) {
    try { localStorage.setItem('dp_setting_' + key, JSON.stringify(value)); } catch(e) {}
  }

  /* ── API pública ── */
  return {
    login: login,
    logout: logout,
    getStats: getStats,
    getPerfumes: getPerfumes,
    getPerfume: getPerfume,
    crearPerfume: crearPerfume,
    editarPerfume: editarPerfume,
    eliminarPerfume: eliminarPerfume,
    reponerStock: reponerStock,
    getClientes: getClientes,
    crearCliente: crearCliente,
    editarCliente: editarCliente,
    eliminarCliente: eliminarCliente,
    getVentas: getVentas,
    crearVenta: crearVenta,
    getDetalleVenta: getDetalleVenta,
    getInsumos: getInsumos,
    getInsumosStats: getInsumosStats,
    crearInsumo: crearInsumo,
    editarInsumo: editarInsumo,
    eliminarInsumo: eliminarInsumo,
    getCostos: getCostos,
    getVentasPorPeriodo: getVentasPorPeriodo,
    loadSetting: loadSetting,
    saveSetting: saveSetting,
  };

})();
