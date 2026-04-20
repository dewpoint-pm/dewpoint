'use strict';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').catch(function(err) {
      console.warn('SW error:', err);
    });
  });
}

var APP = {
  currentPage: 'home',
  currentUser: '',
  carrito: [],
  deferredPrompt: null,
  perfumes: [],
  clientes: [],
};

var PAGES = ['home','venta','perfumes','clientes','historial','insumos','costos','config'];
var NAV_PAGES = ['home','venta','perfumes','clientes'];

function navigate(key, navEl) {
  if (PAGES.indexOf(key) === -1) return;
  APP.currentPage = key;
  PAGES.forEach(function(p) {
    var el = document.getElementById('page-' + p);
    if (el) el.className = 'page';
  });
  var target = document.getElementById('page-' + key);
  if (target) {
    target.className = 'page active';
    var content = document.querySelector('.content');
    if (content) content.scrollTop = 0;
  }
  document.querySelectorAll('.ni').forEach(function(ni) {
    ni.classList.remove('active');
    ni.querySelectorAll('svg').forEach(function(svg) { svg.setAttribute('stroke', 'var(--t2)'); });
  });
  if (navEl) {
    navEl.classList.add('active');
    navEl.querySelectorAll('svg').forEach(function(svg) { svg.setAttribute('stroke', 'var(--p)'); });
  } else if (NAV_PAGES.indexOf(key) !== -1) {
    var ni = document.getElementById('ni-' + key);
    if (ni) {
      ni.classList.add('active');
      ni.querySelectorAll('svg').forEach(function(svg) { svg.setAttribute('stroke', 'var(--p)'); });
    }
  }
  closeMore();
  try { sessionStorage.setItem('dp_page', key); } catch(e) {}
  if (key === 'home')      loadDashboard();
  if (key === 'perfumes')  loadPerfumes();
  if (key === 'clientes')  loadClientes();
  if (key === 'historial') loadHistorial();
  if (key === 'insumos')   loadInsumos();
  if (key === 'costos')    loadCostos();
  if (key === 'venta')     loadPerfumesVenta();
}

function toggleMore() {
  var m = document.getElementById('more-menu');
  if (!m) return;
  m.style.display = m.style.display === 'block' ? 'none' : 'block';
}
function closeMore() {
  var m = document.getElementById('more-menu');
  if (m) m.style.display = 'none';
}
document.addEventListener('click', function(e) {
  if (!e.target.closest('#more-menu') && !e.target.closest('#ni-more')) closeMore();
});

function doLogin() {
  var u = document.getElementById('lu');
  var p = document.getElementById('lp');
  var er = document.getElementById('le');
  if (!u || !p) return;
  if (!u.value.trim() || !p.value.trim()) {
    if (er) { er.textContent = 'Completa todos los campos'; er.style.display = 'block'; }
    return;
  }
  if (er) er.style.display = 'none';
  var btnLogin = document.querySelector('#login-screen .btn');
  if (btnLogin) btnLogin.textContent = 'Conectando...';
  DB.login(u.value.trim(), p.value.trim(), function(ok, msg) {
    if (btnLogin) btnLogin.textContent = 'Iniciar sesión';
    if (ok) {
      APP.currentUser = u.value.trim();
      var ls = document.getElementById('login-screen');
      if (ls) ls.style.display = 'none';
      var tbu = document.getElementById('tbu');
      var tba = document.getElementById('tba');
      var cfgU = document.getElementById('cfg-user');
      if (tbu) tbu.textContent = APP.currentUser;
      if (tba) tba.textContent = APP.currentUser.charAt(0).toUpperCase();
      if (cfgU) cfgU.textContent = APP.currentUser;
      try {
        var last = sessionStorage.getItem('dp_page') || 'home';
        navigate(last);
      } catch(e) { navigate('home'); }
    } else {
      if (er) { er.textContent = msg || 'Usuario o contraseña incorrectos'; er.style.display = 'block'; }
    }
  });
}

function doLogout() {
  APP.currentUser = '';
  APP.carrito = [];
  APP.perfumes = [];
  APP.clientes = [];
  try { sessionStorage.removeItem('dp_page'); } catch(e) {}
  DB.logout();
  var ls = document.getElementById('login-screen');
  if (ls) ls.style.display = 'flex';
  var lu = document.getElementById('lu');
  var lp = document.getElementById('lp');
  var le = document.getElementById('le');
  if (lu) lu.value = '';
  if (lp) lp.value = '';
  if (le) le.style.display = 'none';
  navigate('home', document.getElementById('ni-home'));
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' || e.keyCode === 13) {
    var ls = document.getElementById('login-screen');
    if (ls && ls.style.display !== 'none') doLogin();
  }
});

function loadDashboard() {
  DB.getStats(function(data) {
    if (!data) return;
    var s = function(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };
    s('stat-ventas',   data.ventas_total != null ? '$' + Math.round(data.ventas_total).toLocaleString('es-CL') : '—');
    s('stat-ordenes',  data.ordenes      != null ? String(data.ordenes) : '—');
    s('stat-cobrar',   data.por_cobrar   != null ? '$' + Math.round(data.por_cobrar).toLocaleString('es-CL') : '—');
    s('stat-perfumes', data.perfumes     != null ? String(data.perfumes) : '—');
    var dEl = document.getElementById('stat-ventas-d');
    if (dEl && data.margen_pct != null) dEl.textContent = 'Margen ' + data.margen_pct.toFixed(1) + '%';
  });
  DB.getPerfumes('', function(perfumes) {
    var bajos = perfumes.filter(function(p) {
      var pct = p.ml_totales > 0 ? (p.ml_disponibles / p.ml_totales * 100) : 0;
      return pct < 20 || p.ml_disponibles <= 0;
    }).slice(0, 5);
    var cont = document.getElementById('alertas-stock');
    if (!cont || bajos.length === 0) { if(cont) cont.innerHTML = '<p style="color:var(--t2);padding:10px 0">Sin alertas de stock</p>'; return; }
    cont.innerHTML = bajos.map(function(p) {
      var agotado = p.ml_disponibles <= 0;
      var bg = agotado ? 'rgba(232,88,88,.15)' : 'rgba(240,160,64,.15)';
      var tc = agotado ? 'var(--red)' : 'var(--gold)';
      var chip = agotado ? '<span class="chip cr">Agotado</span>' : '<span class="chip ca">Bajo</span>';
      return '<div class="lr"><div class="lr-l"><div class="ri" style="background:' + bg + ';color:' + tc + '">!</div>' +
             '<div><div class="rname">' + p.nombre + '</div><div class="rsub">' + p.marca + ' · ' + Math.round(p.ml_disponibles) + ' ml</div></div></div>' + chip + '</div>';
    }).join('');
  });
}

function loadPerfumes(query) {
  query = query || '';
  var cont = document.getElementById('lista-perfumes');
  if (!cont) return;
  cont.innerHTML = '<div class="spinner"></div>';
  DB.getPerfumes(query, function(perfumes) {
    APP.perfumes = perfumes;
    var s = function(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };
    s('p-total', String(perfumes.length));
    var bajo = perfumes.filter(function(p) { return p.ml_disponibles > 0 && p.ml_totales > 0 && p.ml_disponibles / p.ml_totales < 0.2; }).length;
    var sin  = perfumes.filter(function(p) { return p.ml_disponibles <= 0; }).length;
    var mlT  = perfumes.reduce(function(a, p) { return a + (p.ml_disponibles || 0); }, 0);
    s('p-bajo', String(bajo));
    s('p-sin',  String(sin));
    s('p-ml',   mlT >= 1000 ? (mlT/1000).toFixed(1) + 'K' : Math.round(mlT) + ' ml');
    if (perfumes.length === 0) { cont.innerHTML = '<p style="color:var(--t2);padding:12px 0">No se encontraron perfumes</p>'; return; }
    cont.innerHTML = perfumes.map(function(p) {
      var agotado = p.ml_disponibles <= 0;
      var bajo2 = !agotado && p.ml_totales > 0 && p.ml_disponibles / p.ml_totales < 0.2;
      var icoBg = agotado ? 'rgba(232,88,88,.15)' : bajo2 ? 'rgba(240,160,64,.15)' : 'var(--pdim)';
      var icoC  = agotado ? 'var(--red)' : bajo2 ? 'var(--gold)' : 'var(--p)';
      var icoT  = agotado ? 'X' : bajo2 ? '!' : p.nombre.charAt(0).toUpperCase();
      var valC  = agotado ? 'v-r' : bajo2 ? 'v-a' : 'v-g';
      var precios = p.precios || {};
      var precioStr = Object.keys(precios).length > 0 ? '$' + Object.values(precios)[0].toLocaleString('es-CL') + '/' + Object.keys(precios)[0] :
                      p.precio_botella ? '$' + p.precio_botella.toLocaleString('es-CL') + ' bot.' : '—';
      return '<div class="lr"><div class="lr-l"><div class="ri" style="background:' + icoBg + ';color:' + icoC + '">' + icoT + '</div>' +
        '<div><div class="rname">' + p.nombre + '</div><div class="rsub">' + p.marca + ' · ' + (p.tipo_venta === 'botella' ? 'Botella' : 'Decant') + '</div></div></div>' +
        '<div class="lr-r"><div class="rv ' + valC + '">' + Math.round(p.ml_disponibles) + ' ml</div><div class="rv2">' + precioStr + '</div></div></div>';
    }).join('');
  });
}

function loadClientes(query) {
  query = query || '';
  var cont = document.getElementById('lista-clientes');
  if (!cont) return;
  cont.innerHTML = '<div class="spinner"></div>';
  DB.getClientes(query, function(clientes) {
    APP.clientes = clientes;
    var s = function(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };
    s('c-total', String(clientes.length));
    s('c-deuda', String(clientes.filter(function(c) { return c.saldo_pendiente > 0; }).length));
    if (clientes.length === 0) { cont.innerHTML = '<p style="color:var(--t2);padding:12px 0">No se encontraron clientes</p>'; return; }
    cont.innerHTML = clientes.map(function(c) {
      var ini = (c.nombre || '?').split(' ').map(function(w){return w[0];}).join('').substring(0,2).toUpperCase();
      var tieneDeuda = c.saldo_pendiente > 0;
      var avCls = tieneDeuda ? 'av-gold' : '';
      var valStr = c.total_compras ? '$' + Math.round(c.total_compras).toLocaleString('es-CL') : '—';
      var sub2 = tieneDeuda ? 'Debe $' + Math.round(c.saldo_pendiente).toLocaleString('es-CL') : (c.n_ventas || 0) + ' órdenes';
      return '<div class="lr"><div class="lr-l"><div class="avatar ' + avCls + '" style="width:36px;height:36px;font-size:var(--fs-sm)">' + ini + '</div>' +
        '<div><div class="rname">' + c.nombre + '</div><div class="rsub">' + (c.telefono || '—') + '</div></div></div>' +
        '<div class="lr-r"><div class="rv ' + (tieneDeuda?'v-a':'v-g') + '">' + valStr + '</div><div class="rv2">' + sub2 + '</div></div></div>';
    }).join('');
  });
}

var _historialEstado = 'Todos';
function filtrarHistorial(estado, el) {
  _historialEstado = estado;
  document.querySelectorAll('#page-historial .chips-row .chip').forEach(function(c){ c.className='chip cn'; });
  if (el) { var cls={'Pagado':'cg','Pendiente':'ca','Parcial':'cr','Todos':'cp'}; el.className='chip '+(cls[estado]||'cp'); }
  loadHistorial();
}

function loadHistorial(query) {
  query = query || (document.getElementById('buscar-historial') ? document.getElementById('buscar-historial').value : '');
  var cont = document.getElementById('lista-historial');
  if (!cont) return;
  cont.innerHTML = '<div class="spinner"></div>';
  DB.getVentas(query, _historialEstado, function(ventas) {
    if (ventas.length === 0) { cont.innerHTML = '<p style="color:var(--t2);padding:12px 0">No se encontraron ventas</p>'; return; }
    var col = {'Pagado':['rgba(80,200,120,.12)','var(--grn)','cg'],'Pendiente':['rgba(240,160,64,.12)','var(--gold)','ca'],'Parcial':['rgba(232,88,88,.12)','var(--red)','cr']};
    cont.innerHTML = ventas.slice(0,30).map(function(v) {
      var c = col[v.estado_pago] || ['var(--pdim)','var(--p)','cp'];
      var fecha = v.fecha ? v.fecha.substring(0,10) : '—';
      return '<div class="lr"><div class="lr-l"><div class="ri" style="background:'+c[0]+';color:'+c[1]+';font-size:var(--fs-sm)">#'+v.id+'</div>' +
        '<div><div class="rname">'+(v.cliente_nombre||'Sin cliente')+'</div><div class="rsub">'+fecha+' · '+(v.metodo_pago||'—')+'</div></div></div>' +
        '<div class="lr-r"><div class="rv v-g">$'+Math.round(v.total||0).toLocaleString('es-CL')+'</div><span class="chip '+c[2]+'" style="font-size:var(--fs-sm)">'+v.estado_pago+'</span></div></div>';
    }).join('');
  });
}

function loadInsumos() {
  var cont = document.getElementById('lista-insumos');
  if (!cont) return;
  cont.innerHTML = '<div class="spinner"></div>';
  DB.getInsumos('', function(insumos) {
    DB.getInsumosStats(function(stats) {
      var s = function(id,val){var el=document.getElementById(id);if(el)el.textContent=val;};
      s('i-total', String(stats.n_insumos || insumos.length));
      s('i-valor', stats.valor_inventario ? '$'+Math.round(stats.valor_inventario).toLocaleString('es-CL') : '—');
      s('i-bajo',  String(stats.n_bajo_stock || 0));
      s('i-sin',   String(stats.n_sin_stock  || 0));
    });
    if (insumos.length === 0) { cont.innerHTML = '<p style="color:var(--t2);padding:12px 0">No hay insumos registrados</p>'; return; }
    cont.innerHTML = insumos.map(function(ins) {
      var sin  = ins.stock_actual <= 0;
      var bajo = !sin && ins.stock_actual < 10;
      var bg = sin ? 'rgba(232,88,88,.15)' : bajo ? 'rgba(240,160,64,.15)' : 'var(--pdim)';
      var tc = sin ? 'var(--red)' : bajo ? 'var(--gold)' : 'var(--p)';
      var chip = sin ? '<div class="rv2 v-r">Sin stock</div>' : bajo ? '<div class="rv2 v-a">Bajo stock</div>' : '<div class="rv2">c/u</div>';
      return '<div class="lr"><div class="lr-l"><div class="ri" style="background:'+bg+';color:'+tc+'">I</div>' +
        '<div><div class="rname">'+ins.nombre+'</div><div class="rsub">'+(ins.categoria||'—')+' · Stock: '+ins.stock_actual+'</div></div></div>' +
        '<div class="lr-r"><div class="rv v-g">$'+(ins.costo_unit||0).toLocaleString('es-CL')+'</div>'+chip+'</div></div>';
    }).join('');
  });
}

function loadCostos() {
  DB.getCostos(function(data) {
    if (!data) return;
    var fmt = function(n){ return n!=null ? '$'+Math.round(n).toLocaleString('es-CL') : '—'; };
    var s = function(id,val){var el=document.getElementById(id);if(el)el.textContent=val;};
    s('r-ingresos', fmt(data.ingresos_total));
    s('r-costos',   fmt(data.costos_total));
    s('r-utilidad', fmt(data.utilidad_total));
    s('r-margen',   data.margen_pct != null ? data.margen_pct.toFixed(1)+'%' : '—');
    var neto = data.costos_perfume ? Math.round(data.costos_perfume/1.19) : null;
    s('r-costo-iva', fmt(data.costos_perfume));
    s('r-neto',     fmt(neto));
    s('r-iva',      fmt(data.costos_perfume && neto ? data.costos_perfume - neto : null));
    s('r-insumos',  fmt(data.costos_insumos));
  });
}

function loadPerfumesVenta() {
  DB.getPerfumes('', function(perfumes) {
    APP.perfumes = perfumes;
    var sel = document.getElementById('sel-perfume');
    if (!sel) return;
    sel.innerHTML = '<option value="">Seleccionar...</option>';
    perfumes.filter(function(p){return p.ml_disponibles>0;}).forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.nombre + ' — ' + p.marca;
      opt.dataset.precios = JSON.stringify(p.precios || {});
      opt.dataset.ml = p.ml_disponibles;
      opt.dataset.tipo = p.tipo_venta;
      sel.appendChild(opt);
    });
  });
  DB.getClientes('', function(clientes){ APP.clientes = clientes; });
}

function actualizarPrecioSug() {
  var selP = document.getElementById('sel-perfume');
  var selF = document.getElementById('sel-formato');
  if (!selP || !selF) return;
  var opt = selP.options[selP.selectedIndex];
  if (!opt || !opt.value) return;
  var precios = {};
  try { precios = JSON.parse(opt.dataset.precios || '{}'); } catch(e) {}
  var precio = precios[selF.value] || 0;
  var pSug = document.getElementById('precio-sugerido');
  var pStock = document.getElementById('stock-disponible');
  if (pSug) pSug.textContent = precio ? 'Sug. $'+precio.toLocaleString('es-CL') : 'Sug. —';
  if (pStock) pStock.textContent = 'Stock: '+Math.round(parseFloat(opt.dataset.ml||0))+' ml';
  var inp = document.getElementById('inp-precio');
  if (inp && precio) inp.value = precio;
}

function agregarAlCarrito() {
  var selP = document.getElementById('sel-perfume');
  var selF = document.getElementById('sel-formato');
  var qty  = document.getElementById('inp-cantidad');
  var prc  = document.getElementById('inp-precio');
  if (!selP || !selF || !qty || !prc) return;
  if (!selP.value) { showToast('Selecciona un perfume'); return; }
  if (!prc.value)  { showToast('Ingresa el precio'); return; }
  var item = {
    perfume_id: parseInt(selP.value),
    nombre: selP.options[selP.selectedIndex].text,
    formato_ml: selF.value,
    cantidad: parseInt(qty.value) || 1,
    precio_unit: parseInt(prc.value) || 0,
    es_botella_completa: 0,
  };
  item.subtotal = item.cantidad * item.precio_unit;
  APP.carrito.push(item);
  renderCarrito();
  showToast('Agregado al carrito');
  selP.value = ''; qty.value = '1'; prc.value = '';
}

function renderCarrito() {
  var cont = document.getElementById('carrito-items');
  var totalEl = document.getElementById('total-venta');
  var ctEl = document.getElementById('ct-carrito');
  if (!cont) return;
  if (APP.carrito.length === 0) {
    cont.innerHTML = '<p style="color:var(--t2);font-size:var(--fs-sm);padding:10px 0">Carrito vacío</p>';
    if (totalEl) totalEl.textContent = '$0';
    if (ctEl) ctEl.textContent = 'Carrito (0 items)';
    return;
  }
  if (ctEl) ctEl.textContent = 'Carrito (' + APP.carrito.length + ' items)';
  var total = 0;
  cont.innerHTML = APP.carrito.map(function(item, i) {
    total += item.subtotal;
    return '<div class="ci"><div><div class="cin">'+item.nombre+' — '+item.formato_ml+'</div>' +
      '<div class="cid">$'+item.precio_unit.toLocaleString('es-CL')+' × '+item.cantidad+'</div></div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
      '<div class="qc"><button class="qb" onclick="cambiarQty('+i+',-1)">-</button><span class="qn">'+item.cantidad+'</span><button class="qb" onclick="cambiarQty('+i+',1)">+</button></div>' +
      '<span class="cip">$'+item.subtotal.toLocaleString('es-CL')+'</span></div></div>';
  }).join('');
  if (totalEl) totalEl.textContent = '$' + total.toLocaleString('es-CL');
}

function cambiarQty(i, delta) {
  if (!APP.carrito[i]) return;
  APP.carrito[i].cantidad += delta;
  if (APP.carrito[i].cantidad <= 0) { APP.carrito.splice(i, 1); }
  else { APP.carrito[i].subtotal = APP.carrito[i].cantidad * APP.carrito[i].precio_unit; }
  renderCarrito();
}

function limpiarCarrito() { APP.carrito = []; renderCarrito(); showToast('Carrito limpiado'); }

function guardarVenta() {
  if (APP.carrito.length === 0) { showToast('Agrega productos al carrito'); return; }
  var venta = {
    cliente_id:   null,
    items:        APP.carrito.map(function(item){ return { perfume_id: item.perfume_id, formato_ml: item.formato_ml, cantidad: item.cantidad, precio_unit: item.precio_unit, es_botella_completa: 0 }; }),
    metodo_pago:  (document.getElementById('sel-metodo')  ||{}).value || 'Efectivo',
    tipo_entrega: (document.getElementById('sel-entrega') ||{}).value || 'Retiro en tienda',
    estado_pago:  (document.getElementById('sel-estado')  ||{}).value || 'Pagado',
    descuento:    parseInt((document.getElementById('inp-descuento')||{}).value||'0')||0,
    costo_envio:  parseInt((document.getElementById('inp-envio')    ||{}).value||'0')||0,
    notas: '',
  };
  DB.crearVenta(venta, function(ok, msg, ventaId) {
    if (ok) {
      var total = APP.carrito.reduce(function(s,i){return s+i.subtotal;},0) - venta.descuento + venta.costo_envio;
      showToast('Venta #'+ventaId+' guardada — $'+total.toLocaleString('es-CL'));
      limpiarCarrito();
    } else { showToast('Error: '+(msg||'No se pudo guardar')); }
  });
}

var _toastTimer = null;
function showToast(msg) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function(){ t.classList.remove('show'); }, 2800);
}

function filtrarPerfumes(tipo, el) {
  document.querySelectorAll('#page-perfumes .chips-row .chip').forEach(function(c){c.className='chip cn';});
  if (el) el.className='chip cp';
}
function setUmbral(val, el) {
  document.querySelectorAll('#umbral-chips .chip').forEach(function(c){c.className='chip cn';});
  if (el) el.className='chip cp';
  DB.saveSetting('umbral', val);
  showToast('Umbral: '+val+'%');
}
function toggleDark(el) { DB.saveSetting('dark_mode', el.checked); }

function updateOnlineStatus() {
  var banner = document.getElementById('offline-banner');
  if (!banner) return;
  if (!navigator.onLine) banner.classList.add('show');
  else banner.classList.remove('show');
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault(); APP.deferredPrompt = e;
  var btn = document.getElementById('install-btn');
  if (btn) btn.style.display = 'block';
  var card = document.getElementById('card-instalar');
  if (card) card.style.display = 'block';
});

function installPWA() {
  if (!APP.deferredPrompt) return;
  APP.deferredPrompt.prompt();
  APP.deferredPrompt.userChoice.then(function(choice) {
    if (choice.outcome === 'accepted') showToast('App instalada');
    APP.deferredPrompt = null;
    var btn = document.getElementById('install-btn');
    if (btn) btn.style.display = 'none';
  });
}

document.addEventListener('DOMContentLoaded', function() {
  var ls = document.getElementById('login-screen');
  if (ls) ls.style.display = 'flex';
  var selP = document.getElementById('sel-perfume');
  var selF = document.getElementById('sel-formato');
  if (selP) selP.addEventListener('change', actualizarPrecioSug);
  if (selF) selF.addEventListener('change', actualizarPrecioSug);
  var bP = document.getElementById('buscar-perfume');
  if (bP) bP.addEventListener('input', function(){ loadPerfumes(this.value); });
  var bC = document.getElementById('buscar-cliente2');
  if (bC) bC.addEventListener('input', function(){ loadClientes(this.value); });
  var bH = document.getElementById('buscar-historial');
  if (bH) bH.addEventListener('input', function(){ loadHistorial(this.value); });
});
