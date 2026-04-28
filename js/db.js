'use strict';

var API_BASE = '';

var DB = (function(){
  var _token = null;
  var _onExpired = null;

  try {
    var saved = localStorage.getItem('dp_tk');
    if (saved) _token = saved;
  } catch(e) {}

  function _fetch(path, opts, cb) {
    var headers = { 'Content-Type': 'application/json' };
    if (_token) headers['Authorization'] = 'Bearer ' + _token;
    var options = { method: opts.method || 'GET', headers: headers };
    if (opts.body) options.body = JSON.stringify(opts.body);

    fetch(API_BASE + path, options)
      .then(function(r) {
        if (r.status === 401) {
          _handleExpired();
          cb({ expired: true }, null);
          return;
        }
        return r.json();
      })
      .then(function(d) { if (d) cb(null, d); })
      .catch(function(e) { cb(e, null); });
  }

  function _handleExpired() {
    _token = null;
    try { localStorage.removeItem('dp_tk'); } catch(e) {}
    if (typeof _onExpired === 'function') _onExpired();
  }

  /* ── AUTH ── */
  function login(u, p, cb) {
    _fetch('/api/auth/login', { method: 'POST', body: { username: u, password: p } }, function(err, d) {
      if (err && err.expired) { cb(false, 'Sesión expirada, intenta de nuevo'); return; }
      if (err || !d) { cb(false, 'Error de conexión. Render puede estar despertando, espera 30 segundos e intenta de nuevo.'); return; }
      if (d.ok) {
        _token = d.token;
        try { localStorage.setItem('dp_tk', _token); } catch(e) {}
        cb(true, null);
      } else {
        cb(false, d.error || 'Credenciales incorrectas');
      }
    });
  }

  function logout() {
    _token = null;
    try { localStorage.removeItem('dp_tk'); } catch(e) {}
  }

  function onSessionExpired(fn) { _onExpired = fn; }

  /* ── STATS — Fixed: acepta (desde, hasta, tipo, cb) con backward-compat ── */
  function getStats(desde, hasta, tipo, cb) {
    if (typeof desde === 'function') {
      cb = desde; desde = null; hasta = null; tipo = null;
    }
    var qs = '';
    if (desde) qs += '&desde=' + encodeURIComponent(desde);
    if (hasta) qs += '&hasta=' + encodeURIComponent(hasta);
    if (tipo)  qs += '&tipo='  + encodeURIComponent(tipo);
    qs = qs ? '?' + qs.substring(1) : '';
    _fetch('/api/stats' + qs, {}, function(err, d) {
      if (err) { cb(null); return; }
      cb(d);
    });
  }

  /* ── PERFUMES ── */
  function getPerfumes(q, cb) {
    _fetch('/api/perfumes?q=' + encodeURIComponent(q || ''), {}, function(err, d) {
      cb(err ? [] : (d.perfumes || d || []));
    });
  }
  function crearPerfume(p, cb) {
    _fetch('/api/perfumes', { method: 'POST', body: p }, function(err, d) {
      cb(!err && d && d.ok, d ? d.error : 'Error');
    });
  }
  function editarPerfume(id, p, cb) {
    _fetch('/api/perfumes/' + id, { method: 'PUT', body: p }, function(err, d) {
      cb(!err && d && d.ok, d ? d.error : 'Error');
    });
  }
  function eliminarPerfume(id, cb) {
    _fetch('/api/perfumes/' + id, { method: 'DELETE' }, function(err, d) { cb(!err && d && d.ok); });
  }
  function reponerStock(id, ml, costo, cb) {
    _fetch('/api/perfumes/' + id + '/reponer', { method: 'POST', body: { ml_nuevos: ml, costo_adicional: costo } }, function(err, d) {
      cb(!err && d && d.ok, d ? d.error : 'Error', d ? d.ml_disponibles : 0);
    });
  }

  /* ── CLIENTES ── */
  function getClientes(q, cb) {
    _fetch('/api/clientes?q=' + encodeURIComponent(q || ''), {}, function(err, d) {
      cb(err ? [] : (d.clientes || d || []));
    });
  }
  function crearCliente(c, cb) {
    _fetch('/api/clientes', { method: 'POST', body: c }, function(err, d) {
      cb(!err && d && d.ok, d ? d.error : 'Error');
    });
  }
  function editarCliente(id, c, cb) {
    _fetch('/api/clientes/' + id, { method: 'PUT', body: c }, function(err, d) {
      cb(!err && d && d.ok, d ? d.error : 'Error');
    });
  }
  function eliminarCliente(id, cb) {
    _fetch('/api/clientes/' + id, { method: 'DELETE' }, function(err, d) { cb(!err && d && d.ok); });
  }

  /* ── VENTAS ── */
  function getVentas(q, estado, cb) {
    var qs = '?q=' + encodeURIComponent(q || '') + '&estado=' + encodeURIComponent(estado || 'Todos');
    _fetch('/api/ventas' + qs, {}, function(err, d) { cb(err ? [] : (d.ventas || d || [])); });
  }
  function crearVenta(v, cb) {
    _fetch('/api/ventas', { method: 'POST', body: v }, function(err, d) {
      if (err || !d) { cb(false, 'Error de red', null); return; }
      cb(d.ok, d.error, d.venta_id);
    });
  }
  function getDetalleVenta(id, cb) {
    _fetch('/api/ventas/' + id + '/detalle', {}, function(err, d) { cb(err ? [] : (d.items || d || [])); });
  }
  function marcarPagado(id, cb) {
    _fetch('/api/ventas/' + id + '/marcar-pagado', { method: 'POST' }, function(err, d) { if (cb) cb(!err && d && d.ok); });
  }

  /* ── INSUMOS ── */
  function getInsumos(q, cb) {
    _fetch('/api/insumos?q=' + encodeURIComponent(q || ''), {}, function(err, d) { cb(err ? [] : (d.insumos || d || [])); });
  }
  function getInsumosStats(cb) {
    _fetch('/api/insumos/stats', {}, function(err, d) { cb(err ? {} : d); });
  }
  function crearInsumo(ins, cb) {
    _fetch('/api/insumos', { method: 'POST', body: ins }, function(err, d) { cb(!err && d && d.ok, d ? d.error : 'Error'); });
  }
  function editarInsumo(id, ins, cb) {
    _fetch('/api/insumos/' + id, { method: 'PUT', body: ins }, function(err, d) { cb(!err && d && d.ok, d ? d.error : 'Error'); });
  }
  function eliminarInsumo(id, cb) {
    _fetch('/api/insumos/' + id, { method: 'DELETE' }, function(err, d) { cb(!err && d && d.ok); });
  }
  function reponerInsumo(id, cant, costo, cb) {
    _fetch('/api/insumos/' + id + '/reponer', { method: 'POST', body: { cantidad: cant, costo: costo } }, function(err, d) { if (cb) cb(!err && d && d.ok); });
  }

  /* ── REPORTES ── */
  function getCostos(cb) {
    _fetch('/api/costos', {}, function(err, d) { cb(err ? null : d); });
  }
  function getTopPerfumes(n, desde, hasta, tipo, cb) {
    var qs = '?n=' + (n || 5) + (desde ? '&desde=' + desde : '') + (hasta ? '&hasta=' + hasta : '') + (tipo ? '&tipo=' + tipo : '');
    _fetch('/api/reportes/top-perfumes' + qs, {}, function(err, d) { cb(err ? [] : (d.perfumes || d || [])); });
  }
  function getTopClientes(n, desde, hasta, tipo, cb) {
    var qs = '?limit=' + (n || 5) + (desde ? '&desde=' + desde : '') + (hasta ? '&hasta=' + hasta : '') + (tipo ? '&tipo=' + tipo : '');
    _fetch('/api/reportes/top-clientes' + qs, {}, function(err, d) { cb(err ? [] : (d.clientes || d || [])); });
  }
  function getVentasPorPeriodo(agrup, desde, hasta, tipo, cb) {
    var qs = '?agrupacion=' + (agrup || 'mes') + (desde ? '&desde=' + desde : '') + (hasta ? '&hasta=' + hasta : '') + (tipo ? '&tipo=' + tipo : '');
    _fetch('/api/reportes/ventas-periodo' + qs, {}, function(err, d) { cb(err ? [] : (d.periodos || d || [])); });
  }

  /* ── SETTINGS ── */
  function loadSetting(key, def) {
    try { var v = localStorage.getItem('dp_set_' + key); return v !== null ? JSON.parse(v) : def; } catch(e) { return def; }
  }
  function saveSetting(key, val) {
    try { localStorage.setItem('dp_set_' + key, JSON.stringify(val)); } catch(e) {}
  }

  return {
    login, logout, onSessionExpired, getStats,
    getPerfumes, crearPerfume, editarPerfume, eliminarPerfume, reponerStock,
    getClientes, crearCliente, editarCliente, eliminarCliente,
    getVentas, crearVenta, getDetalleVenta, marcarPagado,
    getInsumos, getInsumosStats, crearInsumo, editarInsumo, eliminarInsumo, reponerInsumo,
    getCostos, getTopPerfumes, getTopClientes, getVentasPorPeriodo,
    loadSetting, saveSetting,
  };
})();
