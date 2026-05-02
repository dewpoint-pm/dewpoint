'use strict';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').catch(function(e){ console.warn('SW:',e); });
  });
}

var FORMATOS = ['2ml','3ml','5ml','10ml'];

/* Cache de timestamps por página — evita recargar si los datos son recientes */
var _lastLoad = {};
var CACHE_TTL = 60000; /* 60 segundos */

function _needsReload(key) {
  var last = _lastLoad[key];
  if (!last) return true;
  return (Date.now() - last) > CACHE_TTL;
}
function _markLoaded(key) { _lastLoad[key] = Date.now(); }

var APP = {
  user: '', carrito: [], perfumes: [], clientes: [],
  ventas: [], insumos: [],
  modo: 'decant',
  clienteSel: null,
  clienteAnonimo: false,
  _histEstado: 'Todos',
  _repCat: 'todos', _repDesde: null, _repHasta: null, _repAgrup: 'mes',
  _cosCat: 'todos',
  _perfFiltro: 'todos',
  deferredPrompt: null,
};

var PAGES = ['venta','clientes','perfumes','historial','reportes','insumos','costos','config'];

/* ══ ROUTER ══════════════════════════════════════════════════ */
function navigate(key, navEl) {
  if (PAGES.indexOf(key) === -1) return;
  PAGES.forEach(function(p){
    var el = document.getElementById('page-'+p);
    if (el) el.className = 'page';
  });
  var t = document.getElementById('page-'+key);
  if (t) { t.className = 'page active'; var c=document.querySelector('.content'); if(c)c.scrollTop=0; }
  document.querySelectorAll('.ni').forEach(function(ni){
    ni.classList.remove('active');
    ni.querySelectorAll('svg').forEach(function(s){ s.setAttribute('stroke','var(--t3)'); });
  });
  var activeNi = navEl || document.getElementById('ni-'+key);
  if (activeNi) {
    activeNi.classList.add('active');
    activeNi.querySelectorAll('svg').forEach(function(s){ s.setAttribute('stroke','var(--p)'); });
  }
  closeMore();
  try { sessionStorage.setItem('dp_page', key); } catch(e){}

  /* Solo recargar si la página no tiene datos recientes */
  if (key==='clientes')  { if(_needsReload('clientes'))  loadClientes();  else renderClientesCache(); }
  if (key==='perfumes')  { if(_needsReload('perfumes'))  loadPerfumes();  else renderPerfumesCache(); }
  if (key==='historial') { if(_needsReload('historial')) loadHistorial(); else renderHistorialCache(); }
  if (key==='reportes')  loadReportes();
  if (key==='insumos')   { if(_needsReload('insumos'))   loadInsumos();   else renderInsumosCache(); }
  if (key==='costos')    loadCostos();
}

function toggleMore(){ var m=document.getElementById('more-menu'); if(m) m.style.display=m.style.display==='block'?'none':'block'; }
function closeMore(){ var m=document.getElementById('more-menu'); if(m) m.style.display='none'; }
document.addEventListener('click', function(e){ if(!e.target.closest('#more-menu')&&!e.target.closest('#ni-more')) closeMore(); });

/* ══ LOGIN ═══════════════════════════════════════════════════ */
function doLogin(){
  var u=document.getElementById('lu'), p=document.getElementById('lp'), er=document.getElementById('le');
  if (!u.value.trim()||!p.value.trim()){ er.textContent='Completa usuario y contraseña'; er.style.display='block'; return; }
  er.style.display='none';
  var btn=document.getElementById('btn-login'); btn.textContent='Verificando...'; btn.disabled=true;
  DB.login(u.value.trim(), p.value.trim(), function(ok,msg){
    btn.textContent='Ingresar'; btn.disabled=false;
    if(ok){
      APP.user = u.value.trim();
      document.getElementById('login-screen').style.display='none';
      document.getElementById('tbu').textContent = APP.user;
      document.getElementById('tba').textContent = APP.user.charAt(0).toUpperCase();
      document.getElementById('cfg-user').textContent = APP.user;
      /* Aplicar tema guardado */
      _applyTheme();
      /* Precargar perfumes para la venta */
      loadPerfumesVenta();
      try { navigate(sessionStorage.getItem('dp_page')||'venta'); } catch(e){ navigate('venta'); }
    } else {
      er.textContent = '⚠ '+(msg||'Usuario o contraseña incorrectos.');
      er.style.display='block';
      document.getElementById('lp').value='';
    }
  });
}

function doLogout(){
  APP.user=''; APP.carrito=[]; APP.perfumes=[]; APP.clientes=[]; APP.clienteSel=null;
  APP.ventas=[]; APP.insumos=[];
  _lastLoad={};
  try{ sessionStorage.removeItem('dp_page'); }catch(e){}
  DB.logout();
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('lu').value='';
  document.getElementById('lp').value='';
  document.getElementById('le').style.display='none';
  navigate('venta', document.getElementById('ni-venta'));
}

document.addEventListener('keydown', function(e){
  var ls=document.getElementById('login-screen');
  if((e.key==='Enter'||e.keyCode===13)&&ls&&ls.style.display!=='none') doLogin();
});

/* ══ HELPER: mostrar spinner SOLO si contenedor vacío ════════ */
function _showSpinner(id){
  var cont=document.getElementById(id); if(!cont) return;
  /* Si ya tiene filas con datos reales, no poner spinner — evita parpadeo */
  if(cont.querySelector('.lr')||cont.querySelector('.rv')) return;
  cont.innerHTML='<div class="spinner"></div>';
}

/* ══ CLIENTE SEARCH ══════════════════════════════════════════ */
var _cliTimer=null;
document.addEventListener('DOMContentLoaded', function(){
  var eCli=document.getElementById('e-cli');
  if(eCli) eCli.addEventListener('input', function(){
    clearTimeout(_cliTimer);
    _cliTimer=setTimeout(function(){ buscarCliente(eCli.value); }, 300);
  });
  document.getElementById('login-screen').style.display='flex';
  var selP=document.getElementById('sel-perfume');
  var selF=document.getElementById('sel-formato');
  if(selP) selP.addEventListener('change', onPerfumeSel);
  if(selF) selF.addEventListener('change', onFormatoSel);
});

/* Cache temporal de clientes encontrados para selección segura */
var _cliCache = {};

function buscarCliente(q){
  if(!q||q.length<2){ ocultarCliRes(); return; }
  DB.getClientes(q, function(clientes){
    var res=document.getElementById('cli-res');
    if(!res) return;
    if(clientes.length===0){
      res.innerHTML='<div style="padding:8px;color:var(--t3);font-size:var(--fs-sm)">No encontrado</div>';
      res.style.display='block'; return;
    }
    /* Guardar clientes en cache por ID para selección segura */
    _cliCache = {};
    clientes.forEach(function(c){ _cliCache[c.id] = c; });
    res.innerHTML='';
    clientes.slice(0,5).forEach(function(c){
      var info = c.rut && c.rut.trim() && c.rut!=='0' ? c.rut : (c.telefono||c.instagram||'');
      var div = document.createElement('div');
      div.className = 'mm-item';
      div.innerHTML = '<b>'+escHtml(c.nombre)+'</b><span style="color:var(--t3);margin-left:8px">'+escHtml(info)+'</span>';
      div.addEventListener('click', function(){
        var cli = _cliCache[c.id];
        if(cli) selCliente(cli.id, cli.nombre);
      });
      res.appendChild(div);
    });
    res.style.display='block';
  });
}

function selCliente(id,nombre){
  APP.clienteSel={id:id,nombre:nombre};
  APP.clienteAnonimo=false;
  /* Ocultar estados previos */
  var emptyMsg=document.getElementById('empty-cli-msg');
  var anonBadge=document.getElementById('anon-badge');
  var lbl=document.getElementById('lbl-cliente');
  if(emptyMsg) emptyMsg.style.display='none';
  if(anonBadge) anonBadge.style.display='none';
  if(lbl){ lbl.textContent=nombre; lbl.style.color='var(--t)'; lbl.style.display='block'; }
  document.getElementById('e-cli').value='';
  ocultarCliRes();
  document.getElementById('btn-quitar-cli').style.display='inline-block';
}

function selClienteAnonimo(){
  APP.clienteSel=null;
  APP.clienteAnonimo=true;
  var emptyMsg=document.getElementById('empty-cli-msg');
  var anonBadge=document.getElementById('anon-badge');
  var lbl=document.getElementById('lbl-cliente');
  if(emptyMsg) emptyMsg.style.display='none';
  if(anonBadge) anonBadge.style.display='flex';
  if(lbl) lbl.style.display='none';
  document.getElementById('btn-quitar-cli').style.display='inline-block';
  ocultarCliRes();
}

function quitarCliente(){
  APP.clienteSel=null;
  APP.clienteAnonimo=false;
  var emptyMsg=document.getElementById('empty-cli-msg');
  var anonBadge=document.getElementById('anon-badge');
  var lbl=document.getElementById('lbl-cliente');
  if(emptyMsg) emptyMsg.style.display='block';
  if(anonBadge) anonBadge.style.display='none';
  if(lbl){ lbl.textContent=''; lbl.style.display='none'; }
  document.getElementById('btn-quitar-cli').style.display='none';
}

function resetCliente(){
  APP.clienteSel=null;
  APP.clienteAnonimo=false;
  var emptyMsg=document.getElementById('empty-cli-msg');
  var anonBadge=document.getElementById('anon-badge');
  var lbl=document.getElementById('lbl-cliente');
  var eCli=document.getElementById('e-cli');
  if(emptyMsg) emptyMsg.style.display='block';
  if(anonBadge) anonBadge.style.display='none';
  if(lbl){ lbl.textContent=''; lbl.style.display='none'; }
  if(eCli) eCli.value='';
  document.getElementById('btn-quitar-cli').style.display='none';
}

function ocultarCliRes(){ var r=document.getElementById('cli-res'); if(r) r.style.display='none'; }

/* ══ MODO DECANT / BOTELLA ════════════════════════════════════ */
function setModo(modo){
  APP.modo=modo;
  document.getElementById('seg-decant').className='seg-btn'+(modo==='decant'?' on':'');
  document.getElementById('seg-botella').className='seg-btn'+(modo==='botella'?' on':'');
  document.getElementById('lbl-modo-titulo').textContent=modo==='decant'?'Agregar Decant':'Agregar Botella completa';
  document.getElementById('fila-formato').style.display=modo==='decant'?'block':'none';
  actualizarComboPerfumes();
}

/* ══ PERFUMES EN VENTA ════════════════════════════════════════ */
function loadPerfumesVenta(){
  DB.getPerfumes('', function(perfumes){
    if(perfumes&&perfumes.length>0){ APP.perfumes=perfumes; _markLoaded('perfumes'); }
    actualizarComboPerfumes();
    /* Precargar clientes en background */
    DB.getClientes('', function(c){ if(c&&c.length>0){ APP.clientes=c; _markLoaded('clientes'); } });
  });
}

function actualizarComboPerfumes(){
  var sel=document.getElementById('sel-perfume'); if(!sel) return;
  var permitidos=APP.modo==='botella'?['botella','parcial']:['decants','parcial'];
  var filtrados=APP.perfumes.filter(function(p){ return permitidos.indexOf(p.tipo_venta||'decants')!==-1; });
  sel.innerHTML='<option value="">Seleccionar perfume...</option>';
  filtrados.forEach(function(p){
    var opt=document.createElement('option');
    opt.value=p.id;
    opt.textContent=p.nombre+' — '+p.marca+(APP.modo==='botella'?' ('+Math.round(p.ml_totales)+'ml)':'');
    opt.dataset.precios=JSON.stringify(p.precios||{});
    opt.dataset.ml=p.ml_disponibles;
    opt.dataset.ml_totales=p.ml_totales||0;
    opt.dataset.costo=p.costo_por_ml||0;
    opt.dataset.costo_total=p.costo_total||0;
    opt.dataset.tipo=p.tipo_venta;
    opt.dataset.precio_botella=p.precio_botella||0;
    sel.appendChild(opt);
  });
  resetPrecioSug();
}

function onPerfumeSel(){
  var sel=document.getElementById('sel-perfume');
  var opt=sel&&sel.options[sel.selectedIndex];
  if(!opt||!opt.value){ resetPrecioSug(); return; }
  var stock=document.getElementById('lbl-stock');
  if(stock){
    var mlDisp=parseFloat(opt.dataset.ml||0);
    var formato=document.getElementById('sel-formato').value;
    var mlFmt=parseFloat((formato||'').replace('ml','')||0);
    var posibles=mlFmt>0?Math.floor(mlDisp/mlFmt):0;
    if(APP.modo==='botella'){
      stock.textContent='Stock: '+Math.round(mlDisp)+' ml';
    } else {
      stock.textContent='Stock: '+mlDisp.toFixed(1)+' ml ('+(posibles)+' posibles)';
    }
  }
  if(APP.modo==='botella'){
    var pb=parseInt(opt.dataset.precio_botella)||0;
    document.getElementById('lbl-precio-sug').textContent=pb?fmt(pb):'—';
    document.getElementById('lbl-precio-sug').style.color=pb?'var(--p)':'var(--t3)';
    var inp=document.getElementById('inp-precio'); if(inp&&pb) inp.value=pb;
  } else { onFormatoSel(); }
  calcMargen();
}

function onFormatoSel(){
  var sel=document.getElementById('sel-perfume');
  var opt=sel&&sel.options[sel.selectedIndex];
  if(!opt||!opt.value){ resetPrecioSug(); return; }
  var formato=document.getElementById('sel-formato').value;
  var precios={};
  try{ precios=JSON.parse(opt.dataset.precios||'{}'); }catch(e){}
  var precio=precios[formato]||0;
  document.getElementById('lbl-precio-sug').textContent=precio?fmt(precio):'—';
  document.getElementById('lbl-precio-sug').style.color=precio?'var(--p)':'var(--t3)';
  var inp=document.getElementById('inp-precio'); if(inp&&precio) inp.value=precio;
  /* Update stock posibles */
  var stock=document.getElementById('lbl-stock');
  if(stock&&opt){
    var mlDisp=parseFloat(opt.dataset.ml||0);
    var mlFmt=parseFloat((formato||'').replace('ml','')||0);
    var posibles=mlFmt>0?Math.floor(mlDisp/mlFmt):0;
    stock.textContent='Stock: '+mlDisp.toFixed(1)+' ml ('+posibles+' posibles)';
  }
  calcMargen();
}

function resetPrecioSug(){
  document.getElementById('lbl-precio-sug').textContent='—';
  document.getElementById('lbl-precio-sug').style.color='var(--t3)';
  var st=document.getElementById('lbl-stock'); if(st) st.textContent='';
  var m=document.getElementById('lbl-margen'); if(m) m.textContent='';
}

function _getCostoPorMl(opt){
  var costoPorMl=parseFloat(opt.dataset.costo)||0;
  if(!costoPorMl){
    var costoTotal=parseFloat(opt.dataset.costo_total)||0;
    var mlTotales=parseFloat(opt.dataset.ml_totales)||parseFloat(opt.dataset.ml)||1;
    costoPorMl = mlTotales>0 ? costoTotal/mlTotales : 0;
  }
  return costoPorMl;
}

function calcMargen(){
  var sel=document.getElementById('sel-perfume');
  var opt=sel&&sel.options[sel.selectedIndex];
  var inp=document.getElementById('inp-precio');
  var margenEl=document.getElementById('lbl-margen');
  if(!opt||!opt.value||!inp||!margenEl){ calcTotal(); return; }

  var precio=parseInt(String(inp.value).replace(/\./g,''))||0;
  if(!precio){ margenEl.textContent=''; calcTotal(); return; }

  var costoPorMl=_getCostoPorMl(opt);
  var mlVenta=0;
  if(APP.modo==='botella'){
    mlVenta=parseFloat(opt.dataset.ml_totales)||parseFloat(opt.dataset.ml)||0;
  } else {
    var formato=document.getElementById('sel-formato').value;
    mlVenta=parseFloat((formato||'').replace('ml',''))||0;
  }

  var costoUnit=Math.round(costoPorMl*mlVenta);
  var utilidad=precio-costoUnit;

  if(precio>0&&costoUnit>0){
    var margenPct=((utilidad/precio)*100).toFixed(1);
    margenEl.textContent='Margen: $'+Math.round(utilidad).toLocaleString('es-CL')+'  ('+margenPct+'%)';
    margenEl.style.color=utilidad>=0?'var(--grn)':'var(--red)';
  } else if(precio>0){
    margenEl.textContent='Sin datos de costo';
    margenEl.style.color='var(--t3)';
  } else {
    margenEl.textContent='';
  }
  calcTotal();
}

function calcTotal(){
  var subtotal=APP.carrito.reduce(function(s,i){return s+i.subtotal;},0);
  var descPct=Math.min(100,Math.max(0,parseFloat(document.getElementById('inp-descuento').value||0)||0));
  var env=parseInt(document.getElementById('inp-envio').value||0)||0;
  var descMonto=Math.round(subtotal*descPct/100);
  var final=Math.max(0,subtotal-descMonto+env);
  document.getElementById('total-venta').textContent=fmt(final);
  var cm=document.getElementById('chip-margen-total');
  if(!cm) return;
  /* Calcular margen total del carrito */
  var costoTotal=APP.carrito.reduce(function(s,i){
    var costoPorMl=parseFloat(i._costo_por_ml)||0;
    var ml=i.formato_ml?parseFloat(i.formato_ml.replace('ml','')||0):parseFloat(i._ml_totales)||1;
    if(!ml||isNaN(ml)) ml = parseFloat(i._ml_totales)||1;
    var costo=Math.round(costoPorMl*ml)*i.cantidad;
    return s+costo;
  },0);
  var utilidadTotal=subtotal-costoTotal-descMonto;
  var margenTotal=final>0&&costoTotal>0?((utilidadTotal/final)*100).toFixed(1):null;
  /* Mostrar utilidad estimada como en el original */
  if(margenTotal!==null){
    var uStr='$'+Math.abs(Math.round(utilidadTotal)).toLocaleString('es-CL')+'  ('+margenTotal+'%)';
    cm.textContent=(utilidadTotal>=0?'':'−')+uStr+(descPct>0?' · Desc. -'+fmt(descMonto):'');
    cm.style.color=utilidadTotal>=0?'var(--grn)':'var(--red)';
  } else if(descPct>0){
    cm.textContent='Desc. -'+fmt(descMonto);
    cm.style.color='var(--t3)';
  } else {
    cm.textContent='—';
    cm.style.color='var(--t3)';
  }
}

/* ══ CARRITO ═════════════════════════════════════════════════ */
function agregarAlCarrito(){
  var sel=document.getElementById('sel-perfume');
  var opt=sel&&sel.options[sel.selectedIndex];
  var precio=parseInt(document.getElementById('inp-precio').value||0)||0;
  var cantidad=parseInt(document.getElementById('inp-cantidad').value||1)||1;
  if(!opt||!opt.value){ showToast('Selecciona un perfume'); return; }
  if(!precio){ showToast('Ingresa el precio'); return; }
  var formato=APP.modo==='botella'?null:document.getElementById('sel-formato').value;
  var item={
    perfume_id:parseInt(opt.value),
    nombre:opt.textContent.split(' — ')[0],
    marca:opt.textContent.split(' — ')[1]||'',
    formato_ml:formato,
    cantidad:cantidad,
    precio_unit:precio,
    es_botella_completa:APP.modo==='botella'?1:0,
    subtotal:cantidad*precio,
    _costo_por_ml:parseFloat(opt.dataset.costo)||0,
    _ml_totales:parseFloat(opt.dataset.ml_totales)||parseFloat(opt.dataset.ml)||0,
    _costo_total:parseFloat(opt.dataset.costo_total)||0,
  };
  APP.carrito.push(item);
  renderCarrito();
  showToast('Agregado al carrito');
  document.getElementById('inp-cantidad').value='1';
  document.getElementById('inp-precio').value='';
  calcTotal();
}

function renderCarrito(){
  var cont=document.getElementById('carrito-items');
  var ctEl=document.getElementById('ct-carrito');
  if(!cont) return;
  if(ctEl) ctEl.textContent='Carrito ('+APP.carrito.length+' items)';
  if(APP.carrito.length===0){
    cont.innerHTML='<p style="color:var(--t3);font-size:var(--fs-sm)">Carrito vacío</p>';
    document.getElementById('total-venta').textContent='$0';
    return;
  }
  cont.innerHTML=APP.carrito.map(function(item,i){
    var costoPorMl=parseFloat(item._costo_por_ml)||0;
    var mlFmt=item.formato_ml?parseFloat(String(item.formato_ml).replace('ml','')):parseFloat(item._ml_totales)||0;
    var costoUnit=Math.round(costoPorMl*mlFmt);
    var util=item.precio_unit-costoUnit;
    var utilPct=item.precio_unit>0&&costoUnit>0?((util/item.precio_unit)*100).toFixed(1):null;
    var utilStr=utilPct!==null?
      ' <span style="color:'+(util>=0?'var(--grn)':'var(--red)')+'">util. $'+Math.round(util).toLocaleString('es-CL')+' ('+utilPct+'%)</span>':'';
    return '<div class="ci">'+
      '<div style="flex:1;min-width:0">'+
        '<div class="cin">'+escHtml(item.nombre)+' '+(item.formato_ml||'botella')+'</div>'+
        '<div class="cid">'+fmt(item.precio_unit)+' c/u'+utilStr+'</div>'+
      '</div>'+
      '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">'+
      '<div class="qc"><button class="qb" onclick="cambiarQty('+i+',-1)">−</button>'+
      '<span class="qn">'+item.cantidad+'</span>'+
      '<button class="qb" onclick="cambiarQty('+i+',1)">+</button></div>'+
      '<span class="cip">'+fmt(item.subtotal)+'</span></div></div>';
  }).join('');
  calcTotal();
}

function cambiarQty(i,d){
  if(!APP.carrito[i]) return;
  APP.carrito[i].cantidad+=d;
  if(APP.carrito[i].cantidad<=0) APP.carrito.splice(i,1);
  else APP.carrito[i].subtotal=APP.carrito[i].cantidad*APP.carrito[i].precio_unit;
  renderCarrito();
}

function limpiarCarrito(){ APP.carrito=[]; renderCarrito(); showToast('Carrito limpiado'); }

function guardarVenta(){
  if(APP.carrito.length===0){ showToast('Agrega productos al carrito'); return; }
  if(!APP.clienteSel && !APP.clienteAnonimo){ showToast('Selecciona un cliente o usa Anónimo'); return; }
  var subtotal=APP.carrito.reduce(function(s,i){return s+i.subtotal;},0);
  var descPct=Math.min(100,Math.max(0,parseFloat(document.getElementById('inp-descuento').value||0)||0));
  var descMonto=Math.round(subtotal*descPct/100);
  var env=parseInt(document.getElementById('inp-envio').value||0)||0;
  var total=subtotal-descMonto+env;
  var confirm_save=DB.loadSetting('confirm_save',true);
  if(confirm_save&&!confirm('¿Confirmar venta por '+fmt(total)+'?')) return;
  var venta={
    cliente_id:APP.clienteSel?APP.clienteSel.id:(APP.clienteAnonimo?(function(){var a=APP.clientes.filter(function(x){return (x.nombre||'').toLowerCase().includes('an') && (x.nombre||'').toLowerCase().includes('nim');});return a.length?a[0].id:null;})():null),
    items:APP.carrito.map(function(it){ return {perfume_id:it.perfume_id,formato_ml:it.formato_ml,cantidad:it.cantidad,precio_unit:it.precio_unit,es_botella_completa:it.es_botella_completa}; }),
    metodo_pago:document.getElementById('sel-metodo').value,
    tipo_entrega:document.getElementById('sel-entrega').value,
    estado_pago:document.getElementById('sel-estado').value,
    descuento:descMonto,
    costo_envio:env,
    notas:document.getElementById('inp-notas').value,
  };
  DB.crearVenta(venta, function(ok,msg,ventaId){
    if(ok){
      showToast('Venta #'+ventaId+' guardada — '+fmt(total));
      if(DB.loadSetting('auto_clear',true)) limpiarCarrito();
      resetCliente();
      /* Invalidar caché de páginas afectadas */
      delete _lastLoad['perfumes'];
      delete _lastLoad['historial'];
      loadPerfumesVenta();
    } else showToast('Error: '+(msg||'No se pudo guardar'));
  });
}

/* ══ CLIENTES ════════════════════════════════════════════════ */
/* Botón icono reutilizable */
function _iconBtn(onclick, color, svgPath, title){
  return '<button onclick="'+onclick+'" title="'+title+'" style="background:rgba('+color+');border:1px solid rgba('+color+',0.4);border-radius:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;padding:0">'+
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="color:rgba('+color+',1.5)">'+svgPath+'</svg></button>';
}

function renderClientes(clientes){
  var cont=document.getElementById('lista-clientes'); if(!cont) return;
  var s=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};
  s('c-total',String(clientes.length));
  s('c-deuda',String(clientes.filter(function(c){return c.saldo_pendiente>0;}).length));
  if(clientes.length===0){ cont.innerHTML='<p style="color:var(--t3);padding:12px 0">No se encontraron clientes</p>'; return; }
  cont.innerHTML='';
  clientes.forEach(function(c){
    var ini=(c.nombre||'?').split(' ').map(function(w){return w[0];}).join('').substring(0,2).toUpperCase();
    var deuda=c.saldo_pendiente>0;
    var total=parseFloat(c.total_compras||c.total_comprado||0);
    var rutTel=c.rut&&c.rut.trim()&&c.rut!=='0'?c.rut:(c.telefono||'—');
    var ordenes=c.n_ventas||c.compras||0;
    var wrap=document.createElement('div');
    wrap.style.cssText='padding:10px 0;border-bottom:1px solid var(--bdr2)';
    /* Info row */
    var info=document.createElement('div');
    info.style.cssText='display:flex;align-items:center;gap:10px';
    /* Avatar */
    var av=document.createElement('div');
    av.className='av '+(deuda?'av-gold':'');
    av.style.cssText='width:38px;height:38px;font-size:var(--fs-sm);flex-shrink:0';
    av.textContent=ini;
    /* Text */
    var txt=document.createElement('div');
    txt.style.cssText='flex:1;min-width:0';
    txt.innerHTML='<div class="rname">'+escHtml(c.nombre)+'</div><div class="rsub">'+escHtml(rutTel)+'</div>';
    /* Total */
    var tot=document.createElement('div');
    tot.style.cssText='text-align:right;flex-shrink:0';
    tot.innerHTML='<div class="rv '+(deuda?'va':total>0?'vg':'vt')+'" style="font-family:Georgia,serif">'+fmt(total)+'</div>'+
      '<div class="rv2">'+(deuda?'<span style="color:var(--red)">Debe '+fmt(c.saldo_pendiente)+'</span>':ordenes+' órdenes')+'</div>';
    info.appendChild(av); info.appendChild(txt); info.appendChild(tot);
    /* Buttons row */
    var btns=document.createElement('div');
    btns.style.cssText='display:flex;gap:6px;margin-top:8px;justify-content:flex-end';
    var bStyle='border-radius:8px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;';
    var bVer=document.createElement('button');
    bVer.style.cssText=bStyle+'background:rgba(91,164,207,.1);border:1px solid rgba(91,164,207,.3);color:var(--p)';
    bVer.textContent='👁 Ver';
    bVer.addEventListener('click',function(){ verCliente(c.id); });
    var bEdit=document.createElement('button');
    bEdit.style.cssText=bStyle+'background:rgba(91,164,207,.1);border:1px solid rgba(91,164,207,.3);color:var(--p)';
    bEdit.textContent='✏ Editar';
    bEdit.addEventListener('click',function(){ abrirEditarCliente(c.id); });
    var bDel=document.createElement('button');
    bDel.style.cssText=bStyle+'background:rgba(232,68,90,.08);border:1px solid rgba(232,68,90,.3);color:var(--red)';
    bDel.textContent='🗑 Eliminar';
    bDel.addEventListener('click',function(){ confirmarEliminarCliente(c.id, c.nombre); });
    btns.appendChild(bVer); btns.appendChild(bEdit); btns.appendChild(bDel);
    wrap.appendChild(info); wrap.appendChild(btns);
    cont.appendChild(wrap);
  });
}


function verCliente(id){
  var c=APP.clientes.filter(function(x){return x.id===id;})[0];
  if(!c){ showToast('Cliente no encontrado'); return; }
  var cont=document.getElementById('detalle-venta-content');
  var overlay=document.getElementById('modal-detalle-venta');
  var title=overlay.querySelector('.modal-title');
  if(title) title.textContent='Datos del cliente';
  overlay.classList.add('open');
  var rut=c.rut&&c.rut!=='0'?c.rut:'—';
  var tel=c.telefono||'—';
  var ig=c.instagram||'—';
  var email=c.email||'—';
  var notas=c.notas||'—';
  cont.innerHTML=
    '<div class="sec-lbl">Información</div>'+
    '<div class="lr"><div>Nombre</div><div class="rv">'+escHtml(c.nombre)+'</div></div>'+
    '<div class="lr"><div>RUT</div><div class="rv">'+escHtml(rut)+'</div></div>'+
    '<div class="lr"><div>Teléfono</div><div class="rv">'+escHtml(tel)+'</div></div>'+
    '<div class="lr"><div>Instagram</div><div class="rv vp">'+escHtml(ig)+'</div></div>'+
    '<div class="lr"><div>Email</div><div class="rv">'+escHtml(email)+'</div></div>'+
    '<div class="divider"></div>'+
    '<div class="sec-lbl">Estadísticas</div>'+
    '<div class="lr"><div>Total comprado</div><div class="rv vg">'+fmt(c.total_compras||c.total_comprado||0)+'</div></div>'+
    '<div class="lr"><div>Órdenes</div><div class="rv vp">'+(c.n_ventas||c.compras||0)+'</div></div>'+
    (c.saldo_pendiente>0?'<div class="lr"><div>Saldo pendiente</div><div class="rv vr">'+fmt(c.saldo_pendiente)+'</div></div>':'')+
    '<div class="divider"></div>'+
    '<div class="sec-lbl">Notas</div>'+
    '<p style="font-size:var(--fs-sm);color:var(--t3);padding:8px 0">'+escHtml(notas)+'</p>';
}

function abrirEditarCliente(id){
  var c=APP.clientes.filter(function(x){return x.id===id;})[0];
  if(!c){ showToast('Cliente no encontrado'); return; }
  /* Reusar modal cliente en modo edición */
  document.getElementById('modal-cli-title').textContent='Editar cliente';
  /* Separar nombre y apellido si tiene espacio */
  var partes=(c.nombre||'').split(' ');
  var nombre=partes[0]||'';
  var apellido=partes.slice(1).join(' ')||'';
  document.getElementById('mc-nombre').value=nombre;
  var apEl=document.getElementById('mc-apellido');
  if(apEl) apEl.value=apellido; else document.getElementById('mc-nombre').value=c.nombre;
  document.getElementById('mc-rut').value=c.rut||'';
  document.getElementById('mc-tel').value=c.telefono||'';
  document.getElementById('mc-ig').value=c.instagram||'';
  document.getElementById('mc-email').value=c.email||'';
  document.getElementById('mc-notas').value=c.notas||'';
  /* Guardar id para la edición */
  APP._editClienteId=id;
  _clearRutFeedback();
  document.getElementById('modal-cliente').classList.add('open');
}

function confirmarEliminarCliente(id, nombre){
  if(!confirm('¿Eliminar cliente: '+nombre+'?')) return;
  DB.eliminarCliente(id, function(ok){
    if(ok){
      showToast('Cliente eliminado');
      delete _lastLoad['clientes'];
      loadClientes();
    } else showToast('No se pudo eliminar');
  });
}

function renderClientesCache(){ if(APP.clientes.length>0) renderClientes(APP.clientes); }

function loadClientes(q){
  q=q||'';
  /* Mostrar datos en caché mientras carga */
  if(APP.clientes.length>0) renderClientes(APP.clientes);
  else _showSpinner('lista-clientes');
  DB.getClientes(q, function(clientes){
    if(clientes&&clientes.length>0){ APP.clientes=clientes; _markLoaded('clientes'); }
    else if(clientes&&clientes.length===0&&q==='') { /* lista vacía real */ }
    renderClientes(clientes||APP.clientes);
  });
}

/* ══ PERFUMES ════════════════════════════════════════════════ */
var _perfFiltroActual='todos';
function filtrarPerfumes(tipo,el){
  _perfFiltroActual=tipo;
  document.querySelectorAll('#filtro-perfumes .chip').forEach(function(c){c.className='chip cn';});
  if(el) el.className='chip cp';
  renderPerfumesCache();
}

function renderPerfumes(perfumes){
  var cont=document.getElementById('lista-perfumes'); if(!cont) return;
  var filtrados=perfumes;
  if(_perfFiltroActual==='decants') filtrados=perfumes.filter(function(p){return p.tipo_venta!=='botella';});
  if(_perfFiltroActual==='botella') filtrados=perfumes.filter(function(p){return p.tipo_venta==='botella'||p.tipo_venta==='parcial';});
  var s=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};
  s('p-total',String(perfumes.length));
  var bajo=perfumes.filter(function(p){return p.ml_disponibles>0&&p.ml_totales>0&&p.ml_disponibles/p.ml_totales<0.2;}).length;
  var sin=perfumes.filter(function(p){return p.ml_disponibles<=0;}).length;
  var mlT=perfumes.reduce(function(a,p){return a+(p.ml_disponibles||0);},0);
  s('p-bajo',String(bajo)); s('p-sin',String(sin));
  s('p-ml',mlT>=1000?(mlT/1000).toFixed(1)+'K ml':Math.round(mlT)+' ml');
  var b=document.getElementById('badge-alertas');
  if(b){ if(bajo+sin>0){b.textContent=bajo+sin;b.style.display='inline';}else{b.style.display='none';} }
  if(filtrados.length===0){ cont.innerHTML='<p style="color:var(--t3);padding:12px 0">No se encontraron perfumes</p>'; return; }
  cont.innerHTML='';
  filtrados.forEach(function(p){
    var agotado=p.ml_disponibles<=0;
    var bajoP=!agotado&&p.ml_totales>0&&p.ml_disponibles/p.ml_totales<0.2;
    var icoBg=agotado?'rgba(232,68,90,.15)':bajoP?'rgba(240,192,96,.12)':'rgba(91,164,207,.12)';
    var icoC=agotado?'var(--red)':bajoP?'var(--gold)':'var(--p)';
    var valC=agotado?'vr':bajoP?'va':'vg';
    var precios=p.precios||{};
    var precioStr=Object.keys(precios).length>0?fmt(Object.values(precios)[0])+'/'+Object.keys(precios)[0]:p.precio_botella?fmt(p.precio_botella)+' bot.':'—';
    var wrap=document.createElement('div');
    wrap.style.cssText='padding:10px 0;border-bottom:1px solid var(--bdr2)';
    /* Info row */
    var info=document.createElement('div');
    info.style.cssText='display:flex;align-items:center;gap:10px';
    var ri=document.createElement('div');
    ri.className='ri';
    ri.style.cssText='background:'+icoBg+';color:'+icoC+';flex-shrink:0';
    ri.textContent=p.nombre.charAt(0).toUpperCase();
    var txt=document.createElement('div');
    txt.style.cssText='flex:1;min-width:0';
    txt.innerHTML='<div class="rname">'+escHtml(p.nombre)+'</div><div class="rsub">'+escHtml(p.marca)+' · '+(p.tipo_venta==='botella'?'Botella':'Decant')+'</div>';
    var tot=document.createElement('div');
    tot.style.cssText='text-align:right;flex-shrink:0';
    tot.innerHTML='<div class="rv '+valC+'">'+Math.round(p.ml_disponibles)+' ml</div><div class="rv2">'+precioStr+'</div>';
    info.appendChild(ri); info.appendChild(txt); info.appendChild(tot);
    /* Buttons */
    var btns=document.createElement('div');
    btns.style.cssText='display:flex;gap:6px;margin-top:8px;justify-content:flex-end';
    var bStyle='border-radius:8px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;';
    var bEdit=document.createElement('button');
    bEdit.style.cssText=bStyle+'background:rgba(91,164,207,.1);border:1px solid rgba(91,164,207,.3);color:var(--p)';
    bEdit.textContent='✏ Editar';
    bEdit.addEventListener('click',function(){ abrirEditarPerfume(p.id); });
    var bDel=document.createElement('button');
    bDel.style.cssText=bStyle+'background:rgba(232,68,90,.08);border:1px solid rgba(232,68,90,.3);color:var(--red)';
    bDel.textContent='🗑 Eliminar';
    bDel.addEventListener('click',function(){ confirmarEliminarPerfume(p.id, p.nombre); });
    btns.appendChild(bEdit); btns.appendChild(bDel);
    wrap.appendChild(info); wrap.appendChild(btns);
    cont.appendChild(wrap);
  });
}


function renderPerfumesCache(){ if(APP.perfumes.length>0) renderPerfumes(APP.perfumes); }

function loadPerfumes(q){
  q=q||'';
  if(APP.perfumes.length>0) renderPerfumes(APP.perfumes);
  else _showSpinner('lista-perfumes');
  DB.getPerfumes(q, function(perfumes){
    if(perfumes&&perfumes.length>0){ APP.perfumes=perfumes; _markLoaded('perfumes'); }
    renderPerfumes(perfumes||APP.perfumes);
  });
}

/* ══ ELIMINAR PERFUME ════════════════════════════════════════ */
function confirmarEliminarPerfume(id, nombre){
  if(!confirm('¿Eliminar perfume: '+nombre+'?')) return;
  DB.eliminarPerfume(id, function(ok){
    if(ok){
      showToast('Perfume eliminado');
      delete _lastLoad['perfumes'];
      loadPerfumes();
      loadPerfumesVenta();
    } else showToast('No se pudo eliminar');
  });
}

/* ══ HISTORIAL ════════════════════════════════════════════════ */
function filtrarHistorial(estado,el){
  APP._histEstado=estado;
  document.querySelectorAll('#page-historial .chips-row .chip').forEach(function(c){c.className='chip cn';});
  var clsMap={'Todos':'cp','Pagado':'cg','Pendiente':'cw','Parcial':'cr'};
  if(el) el.className='chip '+(clsMap[estado]||'cp');
  loadHistorial();
}

function renderHistorial(ventas){
  var cont=document.getElementById('lista-historial'); if(!cont) return;
  var filtradas=ventas.filter(function(v){ return APP._histEstado==='Todos'||v.estado_pago===APP._histEstado; });
  if(filtradas.length===0){ cont.innerHTML='<p style="color:var(--t3);padding:12px 0">No se encontraron ventas</p>'; return; }
  var col={'Pagado':['rgba(76,175,130,.12)','var(--grn)','cg'],'Pendiente':['rgba(200,146,58,.12)','var(--warn)','cw'],'Parcial':['rgba(232,68,90,.12)','var(--red)','cr']};
  cont.innerHTML=filtradas.slice(0,50).map(function(v){
    var c=col[v.estado_pago]||['rgba(91,164,207,.12)','var(--p)','cp'];
    var fecha=v.fecha?v.fecha.substring(0,10):'—';
    var esPendiente = v.estado_pago==='Pendiente'||v.estado_pago==='Parcial';
    var btnPagar = esPendiente
      ? '<button onclick="event.stopPropagation();accionMarcarPagado('+v.id+')" style="margin-top:4px;border:none;background:var(--grn);color:#fff;font-size:var(--fs-sm);font-weight:700;padding:4px 10px;border-radius:8px;cursor:pointer;display:block">✓ Marcar pagado</button>'
      : '';
    return '<div class="lr" onclick="verDetalleVenta('+v.id+')" style="cursor:pointer;align-items:flex-start;padding:12px 0">'+
      '<div class="lr-l"><div class="ri" style="background:'+c[0]+';color:'+c[1]+';font-size:var(--fs-sm);margin-top:2px">#'+v.id+'</div>'+
      '<div><div class="rname">'+escHtml(v.cliente_nombre||'Sin cliente')+'</div>'+
      '<div class="rsub">'+fecha+' · '+escHtml(v.metodo_pago||'—')+'</div>'+
      btnPagar+'</div></div>'+
      '<div class="lr-r" style="margin-top:2px"><div class="rv vg">'+fmt(v.total||0)+'</div>'+
      '<span class="chip '+c[2]+'">'+v.estado_pago+'</span></div></div>';
  }).join('');
}

function accionMarcarPagado(ventaId){
  if(!confirm('¿Marcar venta #'+ventaId+' como Pagado?')) return;
  DB.marcarPagado(ventaId, function(ok){
    if(ok){
      showToast('Venta #'+ventaId+' marcada como Pagado');
      delete _lastLoad['historial'];
      loadHistorial();
    } else {
      showToast('Error al actualizar la venta');
    }
  });
}

function renderHistorialCache(){ if(APP.ventas.length>0) renderHistorial(APP.ventas); }

function loadHistorial(q){
  q=q||document.getElementById('buscar-historial').value||'';
  if(APP.ventas.length>0) renderHistorial(APP.ventas);
  else _showSpinner('lista-historial');
  DB.getVentas(q, 'Todos', function(ventas){
    if(ventas&&ventas.length>0){ APP.ventas=ventas; _markLoaded('historial'); }
    renderHistorial(ventas||APP.ventas);
  });
}

function verDetalleVenta(id){
  var overlay=document.getElementById('modal-detalle-venta');
  var cont=document.getElementById('detalle-venta-content');
  overlay.classList.add('open');
  cont.innerHTML='<div class="spinner"></div>';
  DB.getDetalleVenta(id, function(items){
    if(!items||items.length===0){ cont.innerHTML='<p style="color:var(--t3)">Sin detalle disponible</p>'; return; }
    var total=items.reduce(function(s,i){return s+(i.precio_unit||0)*(i.cantidad||1);},0);
    cont.innerHTML='<div class="ct">Venta #'+id+'</div>'+
      items.map(function(it){
        return '<div class="lr"><div class="lr-l"><div><div class="rname">'+escHtml(it.perfume_nombre||'—')+'</div>'+
          '<div class="rsub">'+(it.formato_ml||'botella')+' × '+it.cantidad+'</div></div></div>'+
          '<div class="rv vg">'+fmt((it.precio_unit||0)*it.cantidad)+'</div></div>';
      }).join('')+
      '<div class="divider"></div>'+
      '<div style="display:flex;justify-content:space-between;padding:8px 0"><b>Total</b><b class="vg">'+fmt(total)+'</b></div>';
  });
}

/* ══ REPORTES ════════════════════════════════════════════════ */
/* ══ REPORTES — Estado ══════════════════════════════════════ */
var _REP = {
  agrup: 'mes',
  serie: 'ambos',
  indCat: 'todos',
  grafCat: 'todos',
};

function _fmtLbl(desde, hasta) {
  if (!desde && !hasta) return 'Todo el tiempo';
  return (desde || 'inicio') + ' → ' + (hasta || 'hoy');
}

function setPreset(preset, el) {
  document.querySelectorAll('#preset-chips .chip').forEach(function(c){c.className='chip cn';});
  if(el) el.className='chip cp';
  var hoy=new Date();
  var d=document.getElementById('rep-desde'), h=document.getElementById('rep-hasta');
  var fmt2=function(dt){ return dt.toISOString().substring(0,10); };
  if(preset==='todo'){ d.value=''; h.value=''; }
  else if(preset==='hoy'){ d.value=fmt2(hoy); h.value=fmt2(hoy); }
  else if(preset==='mes'){ d.value=fmt2(new Date(hoy.getFullYear(),hoy.getMonth(),1)); h.value=fmt2(hoy); }
  else if(preset==='anio'){ d.value=fmt2(new Date(hoy.getFullYear(),0,1)); h.value=fmt2(hoy); }
  loadReportes();
}

function setCatRep(cat, el) {
  _REP.indCat = cat;
  document.querySelectorAll('#cat-ind-chips .chip').forEach(function(c){c.className='chip cn';});
  if(el) el.className='chip cp';
  loadReportes();
}

function setAgrup(agrup, el) {
  _REP.agrup = agrup;
  document.querySelectorAll('#agrup-chips .chip').forEach(function(c){c.className='chip cn';});
  if(el) el.className='chip cp';
  renderGrafico();
}

function setSerie(serie, el) {
  _REP.serie = serie;
  document.querySelectorAll('#serie-chips .chip').forEach(function(c){c.className='chip cn';});
  if(el) el.className='chip cp';
  var leg = document.getElementById('graf-legend');
  if(leg) leg.style.display = serie==='ambos' ? 'flex' : 'none';
  renderGrafico();
}

function setGrafCat(cat, el) {
  _REP.grafCat = cat;
  document.querySelectorAll('#cat-graf-chips .chip').forEach(function(c){c.className='chip cn';});
  if(el) el.className='chip cp';
  _refreshGrafLabel();
  renderGrafico();
}

function _refreshGrafLabel() {
  var desde = (document.getElementById('graf-desde')||{}).value || null;
  var hasta  = (document.getElementById('graf-hasta')||{}).value || null;
  var catLbl = {todos:'Todos', decants:'Decants', botella:'Botella completa'}[_REP.grafCat] || 'Todos';
  var lbl = document.getElementById('lbl-graf-periodo');
  if(lbl) lbl.textContent = '📈 Gráfico [' + catLbl + ']: ' + _fmtLbl(desde, hasta);
}

function _refreshIndLabel() {
  var desde = (document.getElementById('rep-desde')||{}).value || null;
  var hasta  = (document.getElementById('rep-hasta')||{}).value || null;
  var lbl = document.getElementById('lbl-ind-periodo');
  if(lbl) lbl.textContent = '📅 Indicadores: ' + _fmtLbl(desde, hasta);
}

function loadReportes(){
  if(!APP.user) return; /* No cargar si no hay sesión */
  var desde = (document.getElementById('rep-desde')||{}).value || null;
  var hasta  = (document.getElementById('rep-hasta')||{}).value || null;
  /* Limpiar strings vacíos */
  if(desde==='') desde=null;
  if(hasta==='') hasta=null;
  var tipo   = _REP.indCat !== 'todos' ? _REP.indCat : null;
  _refreshIndLabel();

  DB.getStats(desde, hasta, tipo, function(data){
    if(!data) return;
    var s=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};
    var ticket=data.ordenes>0?Math.round(data.ventas_total/data.ordenes):0;
    s('r-ventas',fmt(data.ventas_total||0));
    s('r-ordenes',String(data.ordenes||0));
    s('r-ticket',fmt(ticket));
    s('r-perfumes',String(data.perfumes||0));
    s('r-utilidad',fmt(data.utilidad_total||0));
    s('r-margen',(data.margen_pct||0).toFixed(1)+'%');
    s('r-costo-perf',fmt(data.costos_perfume||data.costos_total||0));
    s('r-costo-ins',fmt(data.costos_insumos||0));
    s('r-cobrar',fmt(data.por_cobrar||0));
  });
  DB.getInsumosStats(function(st){
    var s=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};
    s('r-inv-ins',fmt(st.valor_inventario||0));
    s('r-ins-bajo',String(st.n_bajo_stock||0));
    s('r-ins-total',String(st.n_insumos||0));
  });
  DB.getTopPerfumes(5,desde,hasta,tipo,function(top){
    var cont=document.getElementById('top-perfumes'); if(!cont) return;
    if(!top||top.length===0){ cont.innerHTML='<p style="color:var(--t3);font-size:var(--fs-sm)">Sin ventas aun</p>'; return; }
    cont.innerHTML=top.map(function(p,i){
      var bg = i%2===0 ? 'background:var(--bg-in);border-radius:8px;' : '';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 10px;'+bg+'">' +
        '<div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">' +
        '<span style="color:var(--p);font-weight:800;font-size:var(--fs-lg);min-width:28px;text-align:right;font-family:Georgia,serif">'+(i+1)+'</span>'+
        '<div style="min-width:0"><div style="font-size:var(--fs);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+escHtml(p.nombre||'—')+'</div>'+
        '<div style="font-size:var(--fs-sm);color:var(--t3)">'+escHtml(p.marca||'')+'</div></div></div>'+
        '<div style="font-size:var(--fs);font-weight:700;color:var(--grn);flex-shrink:0;margin-left:10px">'+(p.total_vendido||0)+' vendidos</div></div>';
    }).join('');
  });
  DB.getTopClientes(5,desde,hasta,tipo,function(top){
    var cont=document.getElementById('top-clientes'); if(!cont) return;
    if(!top||top.length===0){ cont.innerHTML='<p style="color:var(--t3);font-size:var(--fs-sm)">Sin clientes registrados aun</p>'; return; }
    cont.innerHTML=top.map(function(c,i){
      var bg = i%2===0 ? 'background:var(--bg-in);border-radius:8px;' : '';
      var tel = c.telefono || '';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 10px;'+bg+'">' +
        '<div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">' +
        '<span style="color:var(--p);font-weight:800;font-size:var(--fs-lg);min-width:28px;text-align:right;font-family:Georgia,serif">'+(i+1)+'</span>'+
        '<div style="min-width:0"><div style="font-size:var(--fs);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+escHtml(c.nombre||'—')+'</div>'+
        '<div style="font-size:var(--fs-sm);color:var(--t3)">'+escHtml(tel)+'  ·  '+(c.compras||0)+' compras</div></div></div>'+
        '<div style="font-size:var(--fs);font-weight:700;color:var(--gold);flex-shrink:0;margin-left:10px;font-family:Georgia,serif">'+fmt(c.total_comprado||0)+'</div></div>';
    }).join('');
  });
  renderGrafico();
}

/* ══ GRÁFICO CANVAS — fiel al original ══════════════════════ */
var _grafCache = { ventas: [], costos: [] };

/* ══ TEMA GRÁFICO ════════════════════════════════════════════ */
function _themeColors(){
  var light = document.body.classList.contains('light');
  return {
    light:    light,
    bgOuter:  light ? '#E8EBF0' : '#0E0E1A',
    bgInner:  light ? '#FFFFFF' : '#070710',
    grid:     light ? '#D0D5E0' : '#2A2A42',
    axis:     light ? '#A0A8C0' : '#3A3A5A',
    label:    light ? '#5A6078' : '#8888AA',
    tick:     light ? '#7080A0' : '#9999BB',
    valTxt:   light ? '#FFFFFF' : '#000000',
  };
}

function renderGrafico() {
  var desde = (document.getElementById('graf-desde')||{}).value || null;
  var hasta  = (document.getElementById('graf-hasta')||{}).value || null;
  var tipo   = _REP.grafCat !== 'todos' ? _REP.grafCat : null;
  _refreshGrafLabel();

  var canvas = document.getElementById('graf-canvas');
  if(!canvas) return;
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;

  /* Mostrar "cargando" */
  var wrap = document.getElementById('graf-canvas-wrap');
  var cssW = wrap ? wrap.clientWidth||320 : 320;
  var cssH = 340;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  ctx.scale(dpr, dpr);
  var _tc0=_themeColors();
  ctx.fillStyle=_tc0.bgOuter; ctx.fillRect(0,0,cssW,cssH);
  ctx.fillStyle=_tc0.label; ctx.font='13px sans-serif'; ctx.textAlign='center';
  ctx.fillText('Cargando gráfico...', cssW/2, cssH/2);

  function _draw(datosV, datosC) {
    var serie = _REP.serie;
    var agrup = _REP.agrup;

    /* Unir períodos */
    var allP = {};
    datosV.forEach(function(d){ allP[d.periodo]=true; });
    datosC.forEach(function(d){ allP[d.periodo]=true; });
    var periodos = Object.keys(allP).sort();
    if(!periodos.length){ 
      var _tcnd=_themeColors();
      ctx.fillStyle=_tcnd.bgOuter; ctx.fillRect(0,0,W,H);
      ctx.fillStyle=_tcnd.label; ctx.font='13px sans-serif'; ctx.textAlign='center';
      ctx.fillText('Sin datos para el período seleccionado', W/2, H/2);
      return;
    }

    var vMap={}, cMap={};
    datosV.forEach(function(d){ vMap[d.periodo]=parseFloat(d.total||0); });
    datosC.forEach(function(d){ cMap[d.periodo]=parseFloat(d.costo_total||d.total||0); });

    var valoresV = periodos.map(function(p){ return vMap[p]||0; });
    var valoresC = periodos.map(function(p){ return cMap[p]||0; });

    var allVals = [];
    if(serie!=='costos') allVals = allVals.concat(valoresV);
    if(serie!=='ventas') allVals = allVals.concat(valoresC);
    var maxVal = Math.max.apply(null, allVals.concat([1]));

    /* Dimensiones — usar CSS px (ya escalado por dpr arriba) */
    var W = wrap ? wrap.clientWidth||320 : 320;
    var H = 340;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(dpr, dpr);
    var PAD_L=80, PAD_R=24, PAD_T=40, PAD_B=60;
    var areaW = W-PAD_L-PAD_R;
    var areaH = H-PAD_T-PAD_B;
    var n = periodos.length;
    var nSeries = serie==='ambos' ? 2 : 1;
    var groupW = Math.min(100, Math.max(20, Math.floor(areaW/Math.max(n,1))-4));
    var barW   = Math.floor(groupW/nSeries)-2;
    var gap    = (areaW - groupW*n) / (n+1);

    /* Fondo — adaptativo al tema */
    var tc=_themeColors();
    ctx.fillStyle=tc.bgOuter; ctx.fillRect(0,0,W,H);
    ctx.fillStyle=tc.bgInner; ctx.fillRect(PAD_L,PAD_T,areaW,areaH);

    /* Grid */
    var LINEAS=5;
    for(var i=0;i<=LINEAS;i++){
      var y = PAD_T + areaH - (i/LINEAS)*areaH;
      ctx.strokeStyle = i===0?tc.axis:tc.grid;
      ctx.setLineDash(i===0?[]:[6,5]);
      ctx.beginPath(); ctx.moveTo(PAD_L,y); ctx.lineTo(PAD_L+areaW,y); ctx.stroke();
      ctx.setLineDash([]);
      var v = maxVal*i/LINEAS;
      var lbl = v>=1000000?'$'+(v/1000000).toFixed(1)+'M':v>=1000?'$'+Math.round(v/1000)+'k':'$'+Math.round(v);
      ctx.fillStyle=tc.label; ctx.font='11px -apple-system,sans-serif'; ctx.textAlign='right';
      ctx.fillText(lbl, PAD_L-6, y+3);
    }

    /* Barras */
    function drawBar(ix, offset, val, colorMid, colorTop, colorVal) {
      var gx = PAD_L + gap + ix*(groupW+gap);
      var bx = gx + offset;
      var altura = maxVal>0 ? Math.round((val/maxVal)*areaH) : 0;
      var byTop = PAD_T + areaH - altura;
      /* Sombra */
      ctx.fillStyle='rgba(0,0,0,0.25)';
      ctx.fillRect(bx+3, byTop+3, barW, altura);
      /* Barra con esquinas redondeadas arriba */
      /* Gradiente vertical */
      var grad=ctx.createLinearGradient(bx,byTop,bx,byTop+altura);
      grad.addColorStop(0,colorTop); grad.addColorStop(0.4,colorMid); grad.addColorStop(1,colorMid);
      ctx.fillStyle=grad;
      if(altura>6){
        ctx.beginPath();
        ctx.moveTo(bx+4,byTop); ctx.lineTo(bx+barW-4,byTop);
        ctx.quadraticCurveTo(bx+barW,byTop,bx+barW,byTop+4);
        ctx.lineTo(bx+barW,byTop+altura); ctx.lineTo(bx,byTop+altura);
        ctx.lineTo(bx,byTop+4);
        ctx.quadraticCurveTo(bx,byTop,bx+4,byTop);
        ctx.closePath(); ctx.fill();
      } else {
        ctx.fillRect(bx, byTop, barW, altura);
      }
      /* Tope brillante */
      if(altura>3){ ctx.fillStyle=colorTop; ctx.fillRect(bx,byTop,barW,3); }
      /* Valor — dentro de la barra si hay espacio, encima si es muy pequeña */
      if(val>0){
        var lv = val>=1000000?'$'+(val/1000000).toFixed(1)+'M':val>=1000?'$'+Math.round(val/1000)+'k':'$'+Math.round(val);
        ctx.font='bold 11px -apple-system,sans-serif'; ctx.textAlign='center';
        if(altura>22){
          ctx.fillStyle=tc.valTxt;
          ctx.fillText(lv, bx+barW/2, byTop+16);
        } else {
          ctx.fillStyle=tc.label;
          ctx.fillText(lv, bx+barW/2, byTop-5);
        }
      }
    }

    for(var i2=0;i2<periodos.length;i2++){
      if(serie==='ambos'||serie==='ventas')
        drawBar(i2, 0, valoresV[i2], '#2E8B57','#4CAF82','#ffffff');
      if(serie==='ambos'||serie==='costos')
        drawBar(i2, serie==='ambos'?barW+2:0, valoresC[i2], '#C0392B','#E85858','#ffffff');

      /* Label eje X */
      var gx2 = PAD_L + gap + i2*(groupW+gap);
      var cx  = gx2 + groupW/2;
      var p   = periodos[i2];
      var etq = p;
      if(agrup==='dia'&&p.length===10) etq=p.substring(8)+'-'+p.substring(5,7);
      else if(agrup==='mes'&&p.length===7){
        var meses={'01':'Ene','02':'Feb','03':'Mar','04':'Abr','05':'May','06':'Jun','07':'Jul','08':'Ago','09':'Sep','10':'Oct','11':'Nov','12':'Dic'};
        etq=meses[p.substring(5)]||p.substring(5);
      }
      ctx.fillStyle=tc.tick; ctx.font='11px -apple-system,sans-serif'; ctx.textAlign='center';
      ctx.fillText(etq, cx, H-PAD_B+14);
    }

    /* Ejes */
    ctx.strokeStyle=tc.axis; ctx.lineWidth=2; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(PAD_L,PAD_T); ctx.lineTo(PAD_L,PAD_T+areaH); ctx.lineTo(PAD_L+areaW,PAD_T+areaH); ctx.stroke();
    ctx.lineWidth=1;

    /* Leyenda debajo del canvas — actualizar DOM */
    var legEl = document.getElementById('graf-legend');
    if(legEl){
      if(serie==='ambos'){
        legEl.style.display='flex';
        legEl.innerHTML =
          '<span style="display:flex;align-items:center;gap:5px"><span style="width:14px;height:14px;background:#2E8B57;border-radius:3px;display:inline-block"></span>Ventas</span>'+
          '<span style="display:flex;align-items:center;gap:5px"><span style="width:14px;height:14px;background:#C0392B;border-radius:3px;display:inline-block"></span>Costos</span>';
      } else if(serie==='ventas'){
        legEl.style.display='flex';
        legEl.innerHTML='<span style="display:flex;align-items:center;gap:5px"><span style="width:14px;height:14px;background:#2E8B57;border-radius:3px;display:inline-block"></span>Ventas</span>';
      } else {
        legEl.style.display='flex';
        legEl.innerHTML='<span style="display:flex;align-items:center;gap:5px"><span style="width:14px;height:14px;background:#C0392B;border-radius:3px;display:inline-block"></span>Costos</span>';
      }
    }
  }

  /* Cargar datos ventas + costos */
  DB.getVentasPorPeriodo(_REP.agrup, desde, hasta, tipo, function(datosV){
    /* Intentar cargar costos por período */
    fetch('/api/reportes/costos-periodo?agrupacion='+_REP.agrup+(desde?'&desde='+desde:'')+(hasta?'&hasta='+hasta:'')+(tipo?'&tipo='+tipo:''), {
      headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('dp_tk')||'') }
    }).then(function(r){ return r.json(); })
      .then(function(d){ _draw(datosV||[], d.periodos||[]); })
      .catch(function(){ _draw(datosV||[], []); });
  });
}

/* ══ INSUMOS ══════════════════════════════════════════════════ */
function renderInsumos(insumos){
  var cont=document.getElementById('lista-insumos'); if(!cont) return;
  if(insumos.length===0){ cont.innerHTML='<p style="color:var(--t3);padding:12px 0">No hay insumos registrados</p>'; return; }
  cont.innerHTML=insumos.map(function(ins){
    var sin=ins.stock_actual<=0;
    var bajo=!sin&&ins.stock_actual<10;
    var bg=sin?'rgba(232,68,90,.15)':bajo?'rgba(240,192,96,.12)':'rgba(91,164,207,.12)';
    var tc=sin?'var(--red)':bajo?'var(--gold)':'var(--p)';
    var chip=sin?'<span class="chip cr">Sin stock</span>':bajo?'<span class="chip ca">Bajo</span>':'';
    return '<div class="lr">'+
      '<div class="lr-l"><div class="ri" style="background:'+bg+';color:'+tc+'">'+ins.nombre.charAt(0).toUpperCase()+'</div>'+
      '<div><div class="rname">'+escHtml(ins.nombre)+'</div><div class="rsub">'+escHtml(ins.categoria||'—')+' · '+ins.stock_actual+' '+escHtml(ins.unidad||'')+'</div></div></div>'+
      '<div class="lr-r"><div class="rv vg">'+fmt(ins.costo_unit||0)+'</div>'+chip+'</div></div>';
  }).join('');
}

function renderInsumosCache(){ if(APP.insumos.length>0) renderInsumos(APP.insumos); }

function loadInsumos(q){
  q=q||'';
  if(APP.insumos.length>0) renderInsumos(APP.insumos);
  else _showSpinner('lista-insumos');
  DB.getInsumos(q, function(insumos){
    if(insumos&&insumos.length>0){ APP.insumos=insumos; _markLoaded('insumos'); }
    DB.getInsumosStats(function(stats){
      var s=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};
      s('i-total',String(stats.n_insumos||insumos.length));
      s('i-valor',fmt(stats.valor_inventario||0));
      s('i-bajo',String(stats.n_bajo_stock||0));
      s('i-sin',String(stats.n_sin_stock||0));
    });
    renderInsumos(insumos||APP.insumos);
  });
}

/* ══ COSTOS ═══════════════════════════════════════════════════ */
function setCatCostos(cat,el){
  APP._cosCat=cat;
  document.querySelectorAll('#page-costos .chips-row .chip').forEach(function(c){c.className='chip cn';});
  if(el) el.className='chip cp';
  loadCostos();
}

function loadCostos(){
  var tipo=APP._cosCat!=='todos'?APP._cosCat:null;
  DB.getCostos(function(data){
    if(!data) return;
    var s=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};
    var neto=data.costos_perfume?Math.round(data.costos_perfume/1.19):0;
    s('cos-total-iva',fmt(data.costos_perfume||0));
    s('cos-neto',fmt(neto));
    s('cos-iva',fmt(data.costos_perfume?data.costos_perfume-neto:0));
    s('cos-insumos',fmt(data.costos_insumos||0));
  });
  var perf=APP.perfumes.length>0?APP.perfumes:null;
  var _renderCostos=function(perfumes){
    var filtrados=perfumes;
    if(tipo==='decants') filtrados=perfumes.filter(function(p){return p.tipo_venta!=='botella';});
    if(tipo==='botella') filtrados=perfumes.filter(function(p){return p.tipo_venta==='botella'||p.tipo_venta==='parcial';});
    var cont=document.getElementById('lista-costos-perfumes'); if(!cont) return;
    if(filtrados.length===0){ cont.innerHTML='<p style="color:var(--t3)">Sin perfumes</p>'; return; }
    var totalMl=filtrados.reduce(function(s,p){return s+(p.ml_totales||0);},0);
    var totalCosto=filtrados.reduce(function(s,p){return s+(p.costo_total||0);},0);
    var costoProm=totalMl>0?totalCosto/totalMl:0;
    document.getElementById('cos-prom-ml').textContent=fmt(Math.round(costoProm))+'/ml';
    cont.innerHTML=filtrados.map(function(p){
      var costoPorMl=p.costo_por_ml||(p.ml_totales>0?Math.round((p.costo_total||0)/p.ml_totales):0);
      var precios=p.precios||{};
      var precioRef=Object.values(precios)[0]||p.precio_botella||0;
      var mlRef=parseInt(Object.keys(precios)[0])||p.ml_totales||1;
      var costoRef=costoPorMl*mlRef;
      var margen=precioRef>0&&costoRef>0?((precioRef-costoRef)/precioRef*100).toFixed(0):null;
      return '<div class="lr">'+
        '<div class="lr-l"><div><div class="rname">'+escHtml(p.nombre)+'</div>'+
        '<div class="rsub">'+escHtml(p.marca)+' · '+fmt(Math.round(costoPorMl||0))+'/ml</div></div></div>'+
        '<div class="lr-r"><div class="rv '+(margen>=0?'vg':'vr')+'">'+(margen!==null?margen+'%':'—')+'</div></div></div>';
    }).join('');
  };
  if(perf) _renderCostos(perf);
  else DB.getPerfumes('', function(perfumes){ if(perfumes&&perfumes.length>0) APP.perfumes=perfumes; _renderCostos(perfumes||[]); });
}

/* ══ MODALES ══════════════════════════════════════════════════ */
function abrirModalCliente(){
  APP._editClienteId=null;
  document.getElementById('modal-cli-title').textContent='Nuevo cliente';
  ['mc-nombre','mc-rut','mc-tel','mc-ig','mc-email','mc-notas'].forEach(function(id){var e=document.getElementById(id);if(e)e.value='';});
  document.getElementById('modal-cliente').classList.add('open');
}

/* ══ RUT HELPERS ══════════════════════════════════════════════ */
function validarRut(rutClean) {
  rutClean = rutClean.toUpperCase().replace(/[^0-9K]/g,'');
  if (rutClean.length < 2) return false;
  var body = rutClean.slice(0, -1);
  var dv   = rutClean.slice(-1);
  var suma = 0, mult = 2;
  for (var i = body.length - 1; i >= 0; i--) {
    suma += parseInt(body[i]) * mult;
    mult = mult < 7 ? mult + 1 : 2;
  }
  var dvEsp = 11 - (suma % 11);
  var dvStr = dvEsp === 11 ? '0' : dvEsp === 10 ? 'K' : String(dvEsp);
  return dv === dvStr;
}

function formatRutInput(input) {
  var raw = input.value.replace(/[^0-9kK]/g, '').toUpperCase();
  if (raw.length === 0) { input.value = ''; _clearRutFeedback(); return; }
  var dv   = raw.slice(-1);
  var body = raw.slice(0, -1);
  var fmt  = '';
  for (var i = body.length - 1, j = 0; i >= 0; i--, j++) {
    if (j > 0 && j % 3 === 0) fmt = '.' + fmt;
    fmt = body[i] + fmt;
  }
  input.value = body.length > 0 ? fmt + '-' + dv : dv;
  var feedEl = document.getElementById('rut-valid');
  if (!feedEl) return;
  if (raw.length > 3) {
    var esValido = validarRut(raw);
    feedEl.textContent = esValido ? '✓ RUT válido' : '✗ RUT inválido';
    feedEl.style.color  = esValido ? 'var(--grn)' : 'var(--red)';
    feedEl.style.display = 'block';
  } else {
    feedEl.textContent = '';
    feedEl.style.display = 'none';
  }
}

function _clearRutFeedback(){
  var feedEl = document.getElementById('rut-valid');
  if (feedEl) { feedEl.textContent=''; feedEl.style.display='none'; }
}

function guardarCliente(){
  var nombre=document.getElementById('mc-nombre').value.trim();
  if(!nombre){ showToast('El nombre es obligatorio'); return; }
  var rutVal = (document.getElementById('mc-rut').value||'').trim();
  if(rutVal && rutVal.length > 3){
    var rutClean = rutVal.replace(/\./g,'').replace(/-/g,'').toUpperCase();
    if(!validarRut(rutClean)){ showToast('El RUT ingresado no es válido'); return; }
  }
  var data={nombre:nombre,rut:rutVal,telefono:document.getElementById('mc-tel').value,instagram:document.getElementById('mc-ig').value,email:document.getElementById('mc-email').value,notas:document.getElementById('mc-notas').value};
  if(APP._editClienteId){
    var editId=APP._editClienteId;
    DB.editarCliente(editId, data, function(ok,msg){
      if(ok){ showToast('Cliente actualizado'); cerrarModal('modal-cliente'); APP._editClienteId=null; delete _lastLoad['clientes']; loadClientes(); }
      else showToast('Error: '+(msg||'No se pudo actualizar'));
    });
  } else {
    DB.crearCliente(data, function(ok,msg){
      if(ok){ showToast('Cliente creado'); cerrarModal('modal-cliente'); delete _lastLoad['clientes']; loadClientes(); }
      else showToast('Error: '+(msg||'No se pudo crear'));
    });
  }
}

function abrirModalPerfume(){
  APP._editPerfumeId=null;
  document.getElementById('modal-perf-title').textContent='Nuevo perfume';
  ['mp-nombre','mp-marca','mp-ml','mp-costo','mp-p2','mp-p3','mp-p5','mp-p10','mp-pbotella'].forEach(function(id){var e=document.getElementById(id);if(e)e.value='';});
  document.getElementById('mp-tipo').value='decants';
  onTipoPerfumeChange();
  document.getElementById('modal-perfume').classList.add('open');
}

function onTipoPerfumeChange(){
  var tipo=document.getElementById('mp-tipo').value;
  document.getElementById('mp-precios-decant').style.display=tipo==='botella'?'none':'block';
  document.getElementById('mp-precio-botella').style.display=tipo==='decants'?'none':'block';
}

function abrirEditarPerfume(id){
  var p=APP.perfumes.filter(function(x){return x.id===id;})[0];
  if(!p){ showToast('Perfume no encontrado'); return; }
  document.getElementById('modal-perf-title').textContent='Editar perfume';
  document.getElementById('mp-nombre').value=p.nombre||'';
  document.getElementById('mp-marca').value=p.marca||'';
  document.getElementById('mp-ml').value=p.ml_disponibles||p.ml_totales||'';
  document.getElementById('mp-costo').value=p.costo_total||'';
  document.getElementById('mp-tipo').value=p.tipo_venta||'decants';
  onTipoPerfumeChange();
  var precios=p.precios||{};
  var fmts=['2ml','3ml','5ml','10ml'];
  var fids=['mp-p2','mp-p3','mp-p5','mp-p10'];
  fmts.forEach(function(f,i){ var e=document.getElementById(fids[i]); if(e) e.value=precios[f]||''; });
  var pbEl=document.getElementById('mp-pbotella');
  if(pbEl) pbEl.value=p.precio_botella||'';
  APP._editPerfumeId=id;
  document.getElementById('modal-perfume').classList.add('open');
}

function guardarPerfume(){
  var nombre=document.getElementById('mp-nombre').value.trim();
  var marca=document.getElementById('mp-marca').value.trim();
  var ml=parseFloat(document.getElementById('mp-ml').value)||0;
  if(!nombre||!marca||!ml){ showToast('Completa nombre, marca y ml'); return; }
  var tipo=document.getElementById('mp-tipo').value;
  var precios={};
  if(tipo!=='botella'){
    ['2ml','3ml','5ml','10ml'].forEach(function(f,i){
      var ids=['mp-p2','mp-p3','mp-p5','mp-p10'];
      var v=parseInt(document.getElementById(ids[i]).value)||0;
      if(v) precios[f]=v;
    });
  }
  var data={nombre:nombre,marca:marca,ml_totales:ml,costo_total:parseInt(document.getElementById('mp-costo').value)||0,precios:precios,precio_botella:tipo!=='decants'?parseInt(document.getElementById('mp-pbotella').value)||0:0,tipo_venta:tipo};
  if(APP._editPerfumeId){
    var editId=APP._editPerfumeId;
    DB.editarPerfume(editId, data, function(ok,msg){
      if(ok){ showToast('Perfume actualizado'); cerrarModal('modal-perfume'); APP._editPerfumeId=null; delete _lastLoad['perfumes']; loadPerfumes(); loadPerfumesVenta(); }
      else showToast('Error: '+(msg||'No se pudo actualizar'));
    });
  } else {
    DB.crearPerfume(data, function(ok,msg){
      if(ok){ showToast('Perfume creado'); cerrarModal('modal-perfume'); delete _lastLoad['perfumes']; loadPerfumes(); loadPerfumesVenta(); }
      else showToast('Error: '+(msg||'No se pudo crear'));
    });
  }
}

function abrirModalInsumo(){
  ['mi-nombre','mi-stock','mi-costo','mi-notas'].forEach(function(id){var e=document.getElementById(id);if(e)e.value='';});
  document.getElementById('modal-insumo').classList.add('open');
}

function guardarInsumo(){
  var nombre=document.getElementById('mi-nombre').value.trim();
  if(!nombre){ showToast('El nombre es obligatorio'); return; }
  DB.crearInsumo({nombre:nombre,categoria:document.getElementById('mi-cat').value,stock_actual:parseFloat(document.getElementById('mi-stock').value)||0,costo_unit:parseFloat(document.getElementById('mi-costo').value)||0,unidad:document.getElementById('mi-unidad').value,notas:document.getElementById('mi-notas').value}, function(ok,msg){
    if(ok){ showToast('Insumo creado'); cerrarModal('modal-insumo'); delete _lastLoad['insumos']; loadInsumos(); }
    else showToast('Error: '+(msg||'No se pudo crear'));
  });
}

function cerrarModal(id){ var el=document.getElementById(id); if(el) el.classList.remove('open'); }
document.addEventListener('click', function(e){ if(e.target.classList.contains('modal-overlay')) cerrarModal(e.target.id); });

/* ══ CONFIG ══════════════════════════════════════════════════ */
function _applyTheme(){
  var isDark = DB.loadSetting('dark_mode', true);
  if(isDark){
    document.body.classList.remove('light');
  } else {
    document.body.classList.add('light');
    document.querySelector('meta[name="theme-color"]').setAttribute('content','#3A82B5');
  }
  /* Sincronizar switch */
  var sw = document.getElementById('sw-dark');
  if(sw) sw.checked = isDark;
}

function toggleDark(el){
  var isDark = el ? el.checked : !document.body.classList.contains('light');
  if(isDark){
    document.body.classList.remove('light');
    document.querySelector('meta[name="theme-color"]').setAttribute('content','#5BA4CF');
  } else {
    document.body.classList.add('light');
    document.querySelector('meta[name="theme-color"]').setAttribute('content','#3A82B5');
  }
  DB.saveSetting('dark_mode', isDark);
  var grafCanvas=document.getElementById('graf-canvas');
  if(grafCanvas&&document.getElementById('page-reportes').classList.contains('active')) renderGrafico();
}

function setUmbral(val,el){
  document.querySelectorAll('#umbral-chips .chip').forEach(function(c){c.className='chip cn';});
  if(el) el.className='chip cp';
  DB.saveSetting('umbral',val);
  showToast('Umbral: '+val+'%');
}

/* ══ UTILS ═══════════════════════════════════════════════════ */
function fmt(n){ return '$'+(Math.round(n)||0).toLocaleString('es-CL'); }
function escHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

var _toastT=null;
var _toastQueue=[];

function showToast(msg){
  var t=document.getElementById("toast"); if(!t) return;
  /* Cancelar timer anterior */
  if(_toastT){ window.clearTimeout(_toastT); _toastT=null; }
  /* Ocultar inmediatamente sin transición */
  t.style.transition='none';
  t.classList.remove("show");
  t.textContent=msg;
  /* Forzar reflow */
  void t.offsetHeight;
  /* Restaurar transición y mostrar */
  t.style.transition='';
  t.classList.add("show");
  /* Auto-ocultar en 3 segundos */
  _toastT = window.setTimeout(function(){
    t.classList.remove("show");
    _toastT=null;
  }, 3000);
}

/* Click en toast para cerrarlo */
document.addEventListener("DOMContentLoaded",function(){
  var t=document.getElementById("toast");
  if(t) t.addEventListener("click",function(){
    t.classList.remove("show");
    if(_toastT){ window.clearTimeout(_toastT); _toastT=null; }
  });
});

function updateOnline(){ var b=document.getElementById('offline-banner'); if(!b)return; if(!navigator.onLine)b.classList.add('show'); else b.classList.remove('show'); }
window.addEventListener('online',updateOnline);
window.addEventListener('offline',updateOnline);
updateOnline();

window.addEventListener('beforeinstallprompt', function(e){
  e.preventDefault();
  APP.deferredPrompt=e;
  /* Solo mostrar opción en Configuración */
  var card=document.getElementById('card-instalar');
  if(card) card.style.display='block';
  /* Nunca mostrar botón flotante */
  var btn=document.getElementById('install-btn');
  if(btn) btn.remove();
});
function installPWA(){
  if(!APP.deferredPrompt) return;
  APP.deferredPrompt.prompt();
  APP.deferredPrompt.userChoice.then(function(c){
    if(c.outcome==='accepted') showToast('App instalada');
    APP.deferredPrompt=null;
  });
}

/* ══ SESIÓN EXPIRADA — mostrar login automáticamente ════════ */
document.addEventListener('DOMContentLoaded', function(){
  /* Cuando Render se duerme y reinicia, el token se invalida.
     db.js detecta el 401 y llama este callback. */
  DB.onSessionExpired(function(){
    showToast('Sesión expirada. Por favor inicia sesión de nuevo.');
    /* Pequeño delay para que el toast sea visible */
    setTimeout(function(){
      APP.user = '';
      try { sessionStorage.removeItem('dp_page'); } catch(e) {}
      var ls = document.getElementById('login-screen');
      if (ls) ls.style.display = 'flex';
      var lu = document.getElementById('lu');
      var lp = document.getElementById('lp');
      var le = document.getElementById('le');
      if (lu) lu.value = '';
      if (lp) lp.value = '';
      if (le) { le.textContent = 'Tu sesión expiró. Inicia sesión de nuevo.'; le.style.display = 'block'; }
    }, 1500);
  });

  var ls = document.getElementById('login-screen');
  if (ls) ls.style.display = 'flex';
  var selP = document.getElementById('sel-perfume');
  var selF = document.getElementById('sel-formato');
  if (selP) selP.addEventListener('change', onPerfumeSel);
  if (selF) selF.addEventListener('change', onFormatoSel);
});
