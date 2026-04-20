/* ═══════════════════════════════════════════════════════════════
   app.js  —  Dew Point POS
   Módulo principal: router, navegación, sesión, PWA install,
   estado offline. Compatible ES5 + con polyfills mínimos.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ── Registro del Service Worker ── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').then(function(reg) {
      reg.addEventListener('updatefound', function() {
        var newWorker = reg.installing;
        newWorker.addEventListener('statechange', function() {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('Actualización disponible. Recarga para aplicar.');
          }
        });
      });
    }).catch(function(err) {
      console.warn('SW error:', err);
    });
  });
}

/* ══ Estado de la aplicación ══════════════════════════════════ */
var APP = {
  currentPage: 'home',
  currentUser: '',
  carrito: [],
  deferredPrompt: null,
};

/* ══ Router ═══════════════════════════════════════════════════ */
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

  /* Actualizar barra de navegación */
  document.querySelectorAll('.ni').forEach(function(ni) {
    ni.classList.remove('active');
    ni.querySelectorAll('svg').forEach(function(svg) {
      svg.setAttribute('stroke', 'var(--t2)');
    });
  });
  if (navEl) {
    navEl.classList.add('active');
    navEl.querySelectorAll('svg').forEach(function(svg) {
      svg.setAttribute('stroke', 'var(--p)');
    });
  } else if (NAV_PAGES.indexOf(key) !== -1) {
    var ni = document.getElementById('ni-' + key);
    if (ni) {
      ni.classList.add('active');
      ni.querySelectorAll('svg').forEach(function(svg) {
        svg.setAttribute('stroke', 'var(--p)');
      });
    }
  }
  closeMore();

  /* Guardar última página en sessionStorage para mantener estado */
  try { sessionStorage.setItem('dp_page', key); } catch(e) {}
}

/* ══ Menú "Más" ═══════════════════════════════════════════════ */
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

/* ══ Login / Logout ═══════════════════════════════════════════ */
function doLogin() {
  var u = document.getElementById('lu');
  var p = document.getElementById('lp');
  var er = document.getElementById('le');
  if (!u || !p) return;
  if (!u.value.trim() || !p.value.trim()) {
    if (er) { er.textContent = 'Completa todos los campos'; er.style.display = 'block'; }
    return;
  }
  /* Aquí se conecta con db.js → DB.login(usuario, password) */
  DB.login(u.value.trim(), p.value.trim(), function(ok, msg) {
    if (ok) {
      er.style.display = 'none';
      APP.currentUser = u.value.trim();
      var ls = document.getElementById('login-screen');
      if (ls) ls.style.display = 'none';
      var tbu = document.getElementById('tbu');
      var tba = document.getElementById('tba');
      var cfgU = document.getElementById('cfg-user');
      if (tbu) tbu.textContent = APP.currentUser;
      if (tba) tba.textContent = APP.currentUser.charAt(0).toUpperCase();
      if (cfgU) cfgU.textContent = APP.currentUser;
      /* Restaurar última página */
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
  try { sessionStorage.removeItem('dp_page'); } catch(e) {}
  DB.logout();
  var ls = document.getElementById('login-screen');
  if (ls) { ls.style.display = '-webkit-flex'; ls.style.display = 'flex'; }
  var lu = document.getElementById('lu');
  var lp = document.getElementById('lp');
  var le = document.getElementById('le');
  if (lu) lu.value = '';
  if (lp) lp.value = '';
  if (le) le.style.display = 'none';
  navigate('home', document.getElementById('ni-home'));
}

/* Enter en login */
document.addEventListener('keydown', function(e) {
  if ((e.key === 'Enter' || e.keyCode === 13) &&
      document.getElementById('login-screen') &&
      document.getElementById('login-screen').style.display !== 'none') {
    doLogin();
  }
});

/* ══ Carrito ══════════════════════════════════════════════════ */
function agregarAlCarrito() {
  var perfume = document.getElementById('sel-perfume');
  var formato = document.getElementById('sel-formato');
  var cantidad = document.getElementById('inp-cantidad');
  var precio   = document.getElementById('inp-precio');
  if (!perfume || !formato || !cantidad || !precio) return;
  if (!perfume.value || perfume.value === '' || !precio.value) {
    showToast('Selecciona perfume y precio'); return;
  }
  var item = {
    nombre:   perfume.options[perfume.selectedIndex].text,
    formato:  formato.value,
    cantidad: parseInt(cantidad.value) || 1,
    precio:   parseInt(precio.value.replace(/\D/g,'')) || 0,
  };
  item.subtotal = item.cantidad * item.precio;
  APP.carrito.push(item);
  renderCarrito();
  showToast('Producto agregado al carrito');
}

function renderCarrito() {
  var container = document.getElementById('carrito-items');
  var totalEl   = document.getElementById('total-venta');
  if (!container) return;
  if (APP.carrito.length === 0) {
    container.innerHTML = '<p style="color:var(--t2);font-size:var(--fs-sm);padding:10px 0">Carrito vacío</p>';
    if (totalEl) totalEl.textContent = '$0';
    return;
  }
  var html = '';
  var total = 0;
  APP.carrito.forEach(function(item, i) {
    total += item.subtotal;
    html += '<div class="ci">' +
      '<div><div class="cin">' + item.nombre + ' — ' + item.formato + '</div>' +
      '<div class="cid">$' + item.precio.toLocaleString('es-CL') + ' × ' + item.cantidad + '</div></div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
      '<div class="qc">' +
      '<button class="qb" onclick="cambiarQty(' + i + ',-1)">-</button>' +
      '<span class="qn">' + item.cantidad + '</span>' +
      '<button class="qb" onclick="cambiarQty(' + i + ',1)">+</button>' +
      '</div>' +
      '<span class="cip">$' + item.subtotal.toLocaleString('es-CL') + '</span>' +
      '</div></div>';
  });
  container.innerHTML = html;
  if (totalEl) totalEl.textContent = '$' + total.toLocaleString('es-CL');
}

function cambiarQty(i, delta) {
  if (!APP.carrito[i]) return;
  APP.carrito[i].cantidad += delta;
  if (APP.carrito[i].cantidad <= 0) { APP.carrito.splice(i, 1); }
  else { APP.carrito[i].subtotal = APP.carrito[i].cantidad * APP.carrito[i].precio; }
  renderCarrito();
}

function limpiarCarrito() {
  APP.carrito = [];
  renderCarrito();
  showToast('Carrito limpiado');
}

function guardarVenta() {
  if (APP.carrito.length === 0) { showToast('Agrega productos al carrito'); return; }
  var descuento = parseInt((document.getElementById('inp-descuento')||{}).value||'0');
  var envio     = parseInt((document.getElementById('inp-envio')||{}).value||'0');
  var total = APP.carrito.reduce(function(s,i){return s+i.subtotal;},0) - descuento + envio;
  /* Conectar con DB.crearVenta() */
  showToast('Venta guardada por $' + total.toLocaleString('es-CL'));
  if (document.getElementById('sw-auto-clear') &&
      document.getElementById('sw-auto-clear').checked) {
    limpiarCarrito();
  }
}

/* ══ Toast ════════════════════════════════════════════════════ */
var _toastTimer = null;
function showToast(msg) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() { t.classList.remove('show'); }, 2600);
}

/* ══ Estado offline ═══════════════════════════════════════════ */
function updateOnlineStatus() {
  var banner = document.getElementById('offline-banner');
  if (!banner) return;
  if (!navigator.onLine) {
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}
window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

/* ══ Instalación PWA ══════════════════════════════════════════ */
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  APP.deferredPrompt = e;
  var btn = document.getElementById('install-btn');
  if (btn) btn.style.display = 'block';
});

function installPWA() {
  if (!APP.deferredPrompt) return;
  APP.deferredPrompt.prompt();
  APP.deferredPrompt.userChoice.then(function(choice) {
    if (choice.outcome === 'accepted') {
      showToast('App instalada correctamente');
    }
    APP.deferredPrompt = null;
    var btn = document.getElementById('install-btn');
    if (btn) btn.style.display = 'none';
  });
}

window.addEventListener('appinstalled', function() {
  showToast('Dew Point POS instalada');
  APP.deferredPrompt = null;
});

/* ══ Inicialización ═══════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function() {
  /* Mostrar login al inicio */
  var ls = document.getElementById('login-screen');
  if (ls) { ls.style.display = '-webkit-flex'; ls.style.display = 'flex'; }

  /* Cargar datos iniciales del dashboard si hay sesión */
  if (APP.currentUser) {
    loadDashboard();
  }
});

function loadDashboard() {
  DB.getStats(function(stats) {
    if (!stats) return;
    var fields = {
      'stat-ventas':   stats.ventas_total   ? '$' + Math.round(stats.ventas_total).toLocaleString('es-CL') : '—',
      'stat-ordenes':  stats.ordenes        ? String(stats.ordenes) : '—',
      'stat-cobrar':   stats.por_cobrar     ? '$' + Math.round(stats.por_cobrar).toLocaleString('es-CL') : '—',
      'stat-perfumes': stats.perfumes       ? String(stats.perfumes) : '—',
    };
    Object.keys(fields).forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.textContent = fields[id];
    });
  });
}
