'use strict';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').catch(function(e){ console.warn('SW:',e); });
  });
}

var FORMATOS = ['2ml','3ml','5ml','10ml'];
var _lastLoad = {};
var CACHE_TTL = 60000;

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
  _editClienteId: null,
  _editPerfumeId: null,
  deferredPrompt: null,
};

var PAGES = ['venta','clientes','perfumes','historial','reportes','insumos','costos','config'];

function navigate(key, navEl) {
  if (PAGES.indexOf(key) === -1) return;
  PAGES.forEach(function(p){ var el=document.getElementById('page-'+p); if(el)el.className='page'; });
  var t=document.getElementById('page-'+key);
  if(t){ t.className='page active'; var c=document.querySelector('.content'); if(c)c.scrollTop=0; }
  document.querySelectorAll('.ni').forEach(function(ni){
    ni.classList.remove('active');
    ni.querySelectorAll('svg').forEach(function(s){ s.setAttribute('stroke','var(--t3)'); });
  });
  var activeNi=navEl||document.getElementById('ni-'+key);
  if(activeNi){
    activeNi.classList.add('active');
    activeNi.querySelectorAll('svg').forEach(function(s){ s.setAttribute('stroke','var(--p)'); });
  }
  closeMore();
  try{ sessionStorage.setItem('dp_page',key); }catch(e){}
  if(key==='clientes')  { if(_needsReload('clientes'))  loadClientes();  else renderClientesCache(); }
  if(key==='perfumes')  { if(_needsReload('perfumes'))  loadPerfumes();  else renderPerfumesCache(); }
  if(key==='historial') { if(_needsReload('historial')) loadHistorial(); else renderHistorialCache(); }
  if(key==='reportes')  loadReportes();
  if(key==='insumos')   { if(_needsReload('insumos'))   loadInsumos();   else renderInsumosCache(); }
  if(key==='costos')    loadCostos();
}

function toggleMore(){ var m=document.getElementById('more-menu'); if(m)m.style.display=m.style.display==='block'?'none':'block'; }
function closeMore(){ var m=document.getElementById('more-menu'); if(m)m.style.display='none'; }
document.addEventListener('click',function(e){ if(!e.target.closest('#more-menu')&&!e.target.closest('#ni-more'))closeMore(); });

/* ══ LOGIN ══════════════════════════════════════════════════ */
function doLogin(){
  var u=document.getElementById('lu'),p=document.getElementById('lp'),er=document.getElementById('le');
  if(!u.value.trim()||!p.value.trim()){ er.textContent='Completa usuario y contraseña'; er.style.display='block'; return; }
  er.style.display='none';
  var btn=document.getElementById('btn-login'); btn.textContent='Verificando...'; btn.disabled=true;
  DB.login(u.value.trim(),p.value.trim(),function(ok,msg){
    btn.textContent='Ingresar'; btn.disabled=false;
    if(ok){
      APP.user=u.value.trim();
      document.getElementById('login-screen').style.display='none';
      document.getElementById('tbu').textContent=APP.user;
      document.getElementById('tba').textContent=APP.user.charAt(0).toUpperCase();
      document.getElementById('cfg-user').textContent=APP.user;
      _applyTheme();
      loadPerfumesVenta();
      try{ navigate(sessionStorage.getItem('dp_page')||'venta'); }catch(e){ navigate('venta'); }
    } else {
      er.textContent='\u26a0 '+(msg||'Usuario o contraseña incorrectos.');
      er.style.display='block';
      document.getElementById('lp').value='';
    }
  });
}

function doLogout(){
  APP.user=''; APP.carrito=[]; APP.perfumes=[]; APP.clientes=[]; APP.clienteSel=null;
  APP.ventas=[]; APP.insumos=[]; _lastLoad={};
  try{ sessionStorage.removeItem('dp_page'); }catch(e){}
  DB.logout();
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('lu').value=''; document.getElementById('lp').value='';
  document.getElementById('le').style.display='none';
  navigate('venta',document.getElementById('ni-venta'));
}

document.addEventListener('keydown',function(e){
  var ls=document.getElementById('login-screen');
  if((e.key==='Enter'||e.keyCode===13)&&ls&&ls.style.display!=='none') doLogin();
});

function _showSpinner(id){
  var cont=document.getElementById(id); if(!cont) return;
  if(cont.querySelector('.lr')||cont.querySelector('.rv')) return;
  cont.innerHTML='<div class="spinner"></div>';
}

/* ══ CLIENTE SEARCH ══════════════════════════════════════════ */
var _cliTimer=null;
document.addEventListener('DOMContentLoaded',function(){
  var eCli=document.getElementById('e-cli');
  if(eCli) eCli.addEventListener('input',function(){ clearTimeout(_cliTimer); _cliTimer=setTimeout(function(){ buscarCliente(eCli.value); },300); });
  document.getElementById('login-screen').style.display='flex';
  var selP=document.getElementById('sel-perfume');
  var selF=document.getElementById('sel-formato');
  if(selP) selP.addEventListener('change',onPerfumeSel);
  if(selF) selF.addEventListener('change',onFormatoSel);
});

var _cliCache={};

function buscarCliente(q){
  if(!q||q.length<2){ ocultarCliRes(); return; }
  DB.getClientes(q,function(clientes){
    var res=document.getElementById('cli-res'); if(!res) return;
    if(clientes.length===0){ res.innerHTML='<div style="padding:8px;color:var(--t3);font-size:var(--fs-sm)">No encontrado</div>'; res.style.display='block'; return; }
    _cliCache={};
    clientes.forEach(function(c){ _cliCache[c.id]=c; });
    res.innerHTML='';
    clientes.slice(0,5).forEach(function(c){
      var info=c.rut&&c.rut.trim()&&c.rut!=='0'?c.rut:(c.telefono||c.instagram||'');
      var div=document.createElement('div');
      div.className='mm-item';
      div.innerHTML='<b>'+escHtml(c.nombre)+'</b><span style="color:var(--t3);margin-left:8px">'+escHtml(info)+'</span>';
      div.addEventListener('click',function(){ var cli=_cliCache[c.id]; if(cli) selCliente(cli.id,cli.nombre); });
      res.appendChild(div);
    });
    res.style.display='block';
  });
}

function selCliente(id,nombre){
  APP.clienteSel={id:id,nombre:nombre}; APP.clienteAnonimo=false;
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
  fetch('/api/clientes/anonimo',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.getItem('dp_tk')||'')}})
  .then(function(r){return r.json();})
  .then(function(d){
    if(!d.ok||!d.cliente){ showToast('Error al cargar cliente an\u00f3nimo'); return; }
    APP.clienteSel=d.cliente; APP.clienteAnonimo=true;
    var emptyMsg=document.getElementById('empty-cli-msg');
    var anonBadge=document.getElementById('anon-badge');
    var lbl=document.getElementById('lbl-cliente');
    if(emptyMsg) emptyMsg.style.display='none';
    if(anonBadge) anonBadge.style.display='flex';
    if(lbl) lbl.style.display='none';
    document.getElementById('btn-quitar-cli').style.display='inline-block';
    ocultarCliRes();
  })
  .catch(function(){ showToast('Error al cargar cliente an\u00f3nimo'); });
}

function quitarCliente(){
  APP.clienteSel=null; APP.clienteAnonimo=false;
  var emptyMsg=document.getElementById('empty-cli-msg');
  var anonBadge=document.getElementById('anon-badge');
  var lbl=document.getElementById('lbl-cliente');
  if(emptyMsg) emptyMsg.style.display='block';
  if(anonBadge) anonBadge.style.display='none';
  if(lbl){ lbl.textContent=''; lbl.style.display='none'; }
  document.getElementById('btn-quitar-cli').style.display='none';
}

function resetCliente(){
  APP.clienteSel=null; APP.clienteAnonimo=false;
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

function ocultarCliRes(){ var r=document.getElementById('cli-res'); if(r)r.style.display='none'; }

/* ══ MODO ════════════════════════════════════════════════════ */
function setModo(modo){
  APP.modo=modo;
  document.getElementById('seg-decant').className='seg-btn'+(modo==='decant'?' on':'');
  document.getElementById('seg-botella').className='seg-btn'+(modo==='botella'?' on':'');
  document.getElementById('lbl-modo-titulo').textContent=modo==='decant'?'Agregar Decant':'Agregar Botella completa';
  document.getElementById('fila-formato').style.display=modo==='decant'?'block':'none';
  actualizarComboPerfumes();
}

/* ══ PERFUMES VENTA ══════════════════════════════════════════ */
function loadPerfumesVenta(){
  DB.getPerfumes('',function(perfumes){
    if(perfumes&&perfumes.length>0){ APP.perfumes=perfumes; _markLoaded('perfumes'); }
    actualizarComboPerfumes();
    DB.getClientes('',function(c){ if(c&&c.length>0){ APP.clientes=c; _markLoaded('clientes'); } });
  });
}

function actualizarComboPerfumes(){
  var sel=document.getElementById('sel-perfume'); if(!sel) return;
  var permitidos=APP.modo==='botella'?['botella']:['decants'];
  var filtrados=APP.perfumes.filter(function(p){ return permitidos.indexOf(p.tipo_venta||'decants')!==-1; });
  sel.innerHTML='<option value="">Seleccionar perfume...</option>';
  filtrados.forEach(function(p){
    var opt=document.createElement('option');
    opt.value=p.id;
    opt.textContent=p.nombre+' \u2014 '+p.marca+(APP.modo==='botella'?' ('+Math.round(p.ml_totales)+'ml)':'');
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
    if(APP.modo==='botella') stock.textContent='Stock: '+Math.round(mlDisp)+' ml';
    else stock.textContent='Stock: '+mlDisp.toFixed(1)+' ml ('+posibles+' posibles)';
  }
  if(APP.modo==='botella'){
    var pb=parseInt(opt.dataset.precio_botella)||0;
    document.getElementById('lbl-precio-sug').textContent=pb?fmt(pb):'\u2014';
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
  document.getElementById('lbl-precio-sug').textContent=precio?fmt(precio):'\u2014';
  document.getElementById('lbl-precio-sug').style.color=precio?'var(--p)':'var(--t3)';
  var inp=document.getElementById('inp-precio'); if(inp&&precio) inp.value=precio;
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
  document.getElementById('lbl-precio-sug').textContent='\u2014';
  document.getElementById('lbl-precio-sug').style.color='var(--t3)';
  var st=document.getElementById('lbl-stock'); if(st)st.textContent='';
  var m=document.getElementById('lbl-margen'); if(m)m.textContent='';
}

function _getCostoPorMl(opt){
  var costoPorMl=parseFloat(opt.dataset.costo)||0;
  if(!costoPorMl){
    var costoTotal=parseFloat(opt.dataset.costo_total)||0;
    var mlTotales=parseFloat(opt.dataset.ml_totales)||parseFloat(opt.dataset.ml)||1;
    costoPorMl=mlTotales>0?costoTotal/mlTotales:0;
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
  if(APP.modo==='botella') mlVenta=parseFloat(opt.dataset.ml_totales)||parseFloat(opt.dataset.ml)||0;
  else { var formato=document.getElementById('sel-formato').value; mlVenta=parseFloat((formato||'').replace('ml',''))||0; }
  var costoUnit=Math.round(costoPorMl*mlVenta);
  var utilidad=precio-costoUnit;
  if(precio>0&&costoUnit>0){
    var margenPct=((utilidad/precio)*100).toFixed(1);
    margenEl.textContent='Margen: $'+Math.round(utilidad).toLocaleString('es-CL')+'  ('+margenPct+'%)';
    margenEl.style.color=utilidad>=0?'var(--grn)':'var(--red)';
  } else if(precio>0){ margenEl.textContent='Sin datos de costo'; margenEl.style.color='var(--t3)'; }
  else margenEl.textContent='';
  calcTotal();
}

function calcTotal(){
  var subtotal=APP.carrito.reduce(function(s,i){return s+i.subtotal;},0);
  var descPct=Math.min(100,Math.max(0,parseFloat(document.getElementById('inp-descuento').value||0)||0));
  var env=parseInt(document.getElementById('inp-envio').value||0)||0;
  var descMonto=Math.round(subtotal*descPct/100);
  var final=Math.max(0,subtotal-descMonto+env);
  document.getElementById('total-venta').textContent=fmt(final);
  var cm=document.getElementById('chip-margen-total'); if(!cm) return;
  var costoTotal=APP.carrito.reduce(function(s,i){
    var costoPorMl=parseFloat(i._costo_por_ml)||0;
    var ml=i.formato_ml?parseFloat(i.formato_ml.replace('ml','')||0):parseFloat(i._ml_totales)||1;
    if(!ml||isNaN(ml)) ml=parseFloat(i._ml_totales)||1;
    return s+Math.round(costoPorMl*ml)*i.cantidad;
  },0);
  var utilidadTotal=subtotal-costoTotal-descMonto;
  var margenTotal=final>0&&costoTotal>0?((utilidadTotal/final)*100).toFixed(1):null;
  if(margenTotal!==null){
    var uStr='$'+Math.abs(Math.round(utilidadTotal)).toLocaleString('es-CL')+'  ('+margenTotal+'%)';
    cm.textContent=(utilidadTotal>=0?'':'\u2212')+uStr+(descPct>0?' \u00b7 Desc. -'+fmt(descMonto):'');
    cm.style.color=utilidadTotal>=0?'var(--grn)':'var(--red)';
  } else if(descPct>0){ cm.textContent='Desc. -'+fmt(descMonto); cm.style.color='var(--t3)'; }
  else { cm.textContent='\u2014'; cm.style.color='var(--t3)'; }
}

/* ══ CARRITO ════════════════════════════════════════════════ */
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
    nombre:opt.textContent.split(' \u2014 ')[0],
    marca:opt.textContent.split(' \u2014 ')[1]||'',
    formato_ml:formato,cantidad:cantidad,precio_unit:precio,
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
    cont.innerHTML='<p style="color:var(--t3);font-size:var(--fs-sm)">Carrito vac\u00edo</p>';
    document.getElementById('total-venta').textContent='$0'; return;
  }
  cont.innerHTML=APP.carrito.map(function(item,i){
    var costoPorMl=parseFloat(item._costo_por_ml)||0;
    var mlFmt=item.formato_ml?parseFloat(String(item.formato_ml).replace('ml','')):parseFloat(item._ml_totales)||0;
    var costoUnit=Math.round(costoPorMl*mlFmt);
    var util=item.precio_unit-costoUnit;
    var utilPct=item.precio_unit>0&&costoUnit>0?((util/item.precio_unit)*100).toFixed(1):null;
    var utilStr=utilPct!==null?' <span style="color:'+(util>=0?'var(--grn)':'var(--red)')+'">util. $'+Math.round(util).toLocaleString('es-CL')+' ('+utilPct+'%)</span>':'';
    return '<div class="ci">'+
      '<div style="flex:1;min-width:0"><div class="cin">'+escHtml(item.nombre)+' '+(item.formato_ml||'botella')+'</div>'+
      '<div class="cid">'+fmt(item.precio_unit)+' c/u'+utilStr+'</div></div>'+
      '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">'+
      '<div class="qc"><button class="qb" onclick="cambiarQty('+i+',-1)">\u2212</button>'+
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
  if(!APP.clienteSel&&!APP.clienteAnonimo){ showToast('Selecciona un cliente o usa An\u00f3nimo'); return; }
  var subtotal=APP.carrito.reduce(function(s,i){return s+i.subtotal;},0);
  var descPct=Math.min(100,Math.max(0,parseFloat(document.getElementById('inp-descuento').value||0)||0));
  var descMonto=Math.round(subtotal*descPct/100);
  var env=parseInt(document.getElementById('inp-envio').value||0)||0;
  var total=subtotal-descMonto+env;
  var confirm_save=DB.loadSetting('confirm_save',true);
  if(confirm_save&&!confirm('\u00bfConfirmar venta por '+fmt(total)+'?')) return;
  var venta={
    cliente_id:APP.clienteSel?APP.clienteSel.id:null,
    items:APP.carrito.map(function(it){ return {perfume_id:it.perfume_id,formato_ml:it.formato_ml,cantidad:it.cantidad,precio_unit:it.precio_unit,es_botella_completa:it.es_botella_completa}; }),
    metodo_pago:document.getElementById('sel-metodo').value,
    tipo_entrega:document.getElementById('sel-entrega').value,
    estado_pago:document.getElementById('sel-estado').value,
    descuento:descMonto,costo_envio:env,
    notas:document.getElementById('inp-notas').value,
  };
  DB.crearVenta(venta,function(ok,msg,ventaId){
    if(ok){
      showToast('Venta #'+ventaId+' guardada \u2014 '+fmt(total));
      if(DB.loadSetting('auto_clear',true)) limpiarCarrito();
      resetCliente();
      delete _lastLoad['perfumes']; delete _lastLoad['historial'];
      loadPerfumesVenta();
    } else showToast('Error: '+(msg||'No se pudo guardar'));
  });
}

/* ══ CLIENTES ════════════════════════════════════════════════ */
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
    var rutTel=c.rut&&c.rut.trim()&&c.rut!=='0'?c.rut:(c.telefono||'\u2014');
    var ordenes=c.n_ventas||c.compras||0;
    var wrap=document.createElement('div');
    wrap.style.cssText='padding:10px 0;border-bottom:1px solid var(--bdr2)';
    var info=document.createElement('div');
    info.style.cssText='display:flex;align-items:center;gap:10px';
    var av=document.createElement('div');
    av.className='av '+(deuda?'av-gold':'');
    av.style.cssText='width:38px;height:38px;font-size:var(--fs-sm);flex-shrink:0';
    av.textContent=ini;
    var txt=document.createElement('div');
    txt.style.cssText='flex:1;min-width:0';
    txt.innerHTML='<div class="rname">'+escHtml(c.nombre)+'</div><div class="rsub">'+escHtml(rutTel)+'</div>';
    var tot=document.createElement('div');
    tot.style.cssText='text-align:right;flex-shrink:0';
    tot.innerHTML='<div class="rv '+(deuda?'va':total>0?'vg':'vt')+'" style="font-family:Georgia,serif">'+fmt(total)+'</div>'+
      '<div class="rv2">'+(deuda?'<span style="color:var(--red)">Debe '+fmt(c.saldo_pendiente)+'</span>':ordenes+' \u00f3rdenes')+'</div>';
    info.appendChild(av); info.appendChild(txt); info.appendChild(tot);
    var btns=document.createElement('div');
    btns.style.cssText='display:flex;gap:6px;margin-top:8px;justify-content:flex-end';
    var bStyle='border-radius:8px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;';
    var bVer=document.createElement('button');
    bVer.style.cssText=bStyle+'background:rgba(91,164,207,.1);border:1px solid rgba(91,164,207,.3);color:var(--p)';
    bVer.textContent='\ud83d\udc41 Ver';
    bVer.addEventListener('click',function(){ verCliente(c.id); });
    var bEdit=document.createElement('button');
    bEdit.style.cssText=bStyle+'background:rgba(91,164,207,.1);border:1px solid rgba(91,164,207,.3);color:var(--p)';
    bEdit.textContent='\u270f Editar';
    bEdit.addEventListener('click',function(){ abrirEditarCliente(c.id); });
    var bDel=document.createElement('button');
    bDel.style.cssText=bStyle+'background:rgba(232,68,90,.08);border:1px solid rgba(232,68,90,.3);color:var(--red)';
    bDel.textContent='\ud83d\uddd1 Eliminar';
    bDel.addEventListener('click',function(){ confirmarEliminarCliente(c.id,c.nombre); });
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
  var rut=c.rut&&c.rut!=='0'?c.rut:'\u2014';
  cont.innerHTML=
    '<div class="sec-lbl">Informaci\u00f3n</div>'+
    '<div class="lr"><div>Nombre</div><div class="rv">'+escHtml(c.nombre)+'</div></div>'+
    '<div class="lr"><div>RUT</div><div class="rv">'+escHtml(rut)+'</div></div>'+
    '<div class="lr"><div>Tel\u00e9fono</div><div class="rv">'+escHtml(c.telefono||'\u2014')+'</div></div>'+
    '<div class="lr"><div>Instagram</div><div class="rv vp">'+escHtml(c.instagram||'\u2014')+'</div></div>'+
    '<div class="lr"><div>Email</div><div class="rv">'+escHtml(c.email||'\u2014')+'</div></div>'+
    '<div class="divider"></div>'+
    '<div class="sec-lbl">Estad\u00edsticas</div>'+
    '<div class="lr"><div>Total comprado</div><div class="rv vg">'+fmt(c.total_compras||c.total_comprado||0)+'</div></div>'+
    '<div class="lr"><div>\u00d3rdenes</div><div class="rv vp">'+(c.n_ventas||c.compras||0)+'</div></div>'+
    (c.saldo_pendiente>0?'<div class="lr"><div>Saldo pendiente</div><div class="rv vr">'+fmt(c.saldo_pendiente)+'</div></div>':'')+
    '<div class="divider"></div>'+
    '<div class="sec-lbl">Notas</div>'+
    '<p style="font-size:var(--fs-sm);color:var(--t3);padding:8px 0">'+escHtml(c.notas||'\u2014')+'</p>';
}

function abrirEditarCliente(id){
  var c=APP.clientes.filter(function(x){return x.id===id;})[0];
  if(!c){ showToast('Cliente no encontrado'); return; }
  document.getElementById('modal-cli-title').textContent='Editar cliente';
  document.getElementById('mc-nombre').value=c.nombre||'';
  document.getElementById('mc-rut').value=c.rut||'';
  document.getElementById('mc-tel').value=c.telefono||'';
  document.getElementById('mc-ig').value=c.instagram||'';
  document.getElementById('mc-email').value=c.email||'';
  document.getElementById('mc-notas').value=c.notas||'';
  APP._editClienteId=id;
  _clearRutFeedback();
  document.getElementById('modal-cliente').classList.add('open');
}

function confirmarEliminarCliente(id,nombre){
  if(!confirm('\u00bfEliminar cliente: '+nombre+'?')) return;
  DB.eliminarCliente(id,function(ok){
    if(ok){ showToast('Cliente eliminado'); delete _lastLoad['clientes']; loadClientes(); }
    else showToast('No se pudo eliminar');
  });
}

function renderClientesCache(){ if(APP.clientes.length>0) renderClientes(APP.clientes); }

function loadClientes(q){
  q=q||'';
  if(APP.clientes.length>0) renderClientes(APP.clientes);
  else _showSpinner('lista-clientes');
  DB.getClientes(q,function(clientes){
    if(clientes&&clientes.length>0){ APP.clientes=clientes; _markLoaded('clientes'); }
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
  if(_perfFiltroActual==='botella') filtrados=perfumes.filter(function(p){return p.tipo_venta==='botella';});
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
    var precioStr=Object.keys(precios).length>0?fmt(Object.values(precios)[0])+'/'+Object.keys(precios)[0]:p.precio_botella?fmt(p.precio_botella)+' bot.':'\u2014';
    var wrap=document.createElement('div');
    wrap.style.cssText='padding:10px 0;border-bottom:1px solid var(--bdr2)';
    var info=document.createElement('div');
    info.style.cssText='display:flex;align-items:center;gap:10px';
    var ri=document.createElement('div');
    ri.className='ri'; ri.style.cssText='background:'+icoBg+';color:'+icoC+';flex-shrink:0';
    ri.textContent=p.nombre.charAt(0).toUpperCase();
    var txt=document.createElement('div');
    txt.style.cssText='flex:1;min-width:0';
    txt.innerHTML='<div class="rname">'+escHtml(p.nombre)+'</div><div class="rsub">'+escHtml(p.marca)+' \u00b7 '+(p.tipo_venta==='botella'?'Botella Completa':'Decant')+'</div>';
    var tot=document.createElement('div');
    tot.style.cssText='text-align:right;flex-shrink:0';
    tot.innerHTML='<div class="rv '+valC+'">'+Math.round(p.ml_disponibles)+' ml</div><div class="rv2">'+precioStr+'</div>';
    info.appendChild(ri); info.appendChild(txt); info.appendChild(tot);
    var btns=document.createElement('div');
    btns.style.cssText='display:flex;gap:6px;margin-top:8px;justify-content:flex-end';
    var bStyle='border-radius:8px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;';
    var bEdit=document.createElement('button');
    bEdit.style.cssText=bStyle+'background:rgba(91,164,207,.1);border:1px solid rgba(91,164,207,.3);color:var(--p)';
    bEdit.textContent='\u270f Editar';
    bEdit.addEventListener('click',function(){ abrirEditarPerfume(p.id); });
    var bDel=document.createElement('button');
    bDel.style.cssText=bStyle+'background:rgba(232,68,90,.08);border:1px solid rgba(232,68,90,.3);color:var(--red)';
    bDel.textContent='\ud83d\uddd1 Eliminar';
    bDel.addEventListener('click',function(){ confirmarEliminarPerfume(p.id,p.nombre); });
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
  DB.getPerfumes(q,function(perfumes){
    if(perfumes&&perfumes.length>0){ APP.perfumes=perfumes; _markLoaded('perfumes'); }
    renderPerfumes(perfumes||APP.perfumes);
  });
}

function abrirEditarPerfume(id){
  var p=APP.perfumes.filter(function(x){return x.id===id;})[0];
  if(!p){ showToast('Perfume no encontrado'); return; }
  var unidadesActuales=1;
  if(p.tipo_venta==='botella'&&p.ml_totales>0) unidadesActuales=Math.max(1,Math.round(p.ml_disponibles/p.ml_totales));
  var set=function(id,v){var e=document.getElementById(id);if(e)e.value=v;};
  set('ep-id',p.id); set('ep-nombre',p.nombre||''); set('ep-marca',p.marca||'');
  set('ep-ml',p.ml_totales||''); set('ep-costo',p.costo_total||'');
  set('ep-tipo',p.tipo_venta||'decants');
  var precios=p.precios||{};
  set('ep-p2',precios['2ml']||''); set('ep-p3',precios['3ml']||'');
  set('ep-p5',precios['5ml']||''); set('ep-p10',precios['10ml']||'');
  set('ep-pbotella',p.precio_botella||''); set('ep-unidades',unidadesActuales);
  onTipoPerfumeEditChange();
  document.getElementById('modal-editar-perfume').classList.add('open');
}

function onTipoPerfumeEditChange(){
  var tipo=(document.getElementById('ep-tipo')||{}).value||'decants';
  var decEl=document.getElementById('ep-precios-decant');
  var botEl=document.getElementById('ep-precio-botella');
  if(decEl) decEl.style.display=tipo==='botella'?'none':'block';
  if(botEl) botEl.style.display=tipo==='decants'?'none':'block';
}

function guardarEditarPerfume(){
  var id=parseInt((document.getElementById('ep-id')||{}).value||0);
  if(!id){ showToast('Error: ID no encontrado'); return; }
  var nombre=((document.getElementById('ep-nombre')||{}).value||'').trim();
  var marca=((document.getElementById('ep-marca')||{}).value||'').trim();
  var ml=parseFloat((document.getElementById('ep-ml')||{}).value)||0;
  if(!nombre||!marca||!ml){ showToast('Completa nombre, marca y ml'); return; }
  var tipo=(document.getElementById('ep-tipo')||{}).value||'decants';
  var precios={};
  if(tipo!=='botella'){
    [['2ml','ep-p2'],['3ml','ep-p3'],['5ml','ep-p5'],['10ml','ep-p10']].forEach(function(pair){
      var v=parseInt((document.getElementById(pair[1])||{}).value)||0;
      if(v) precios[pair[0]]=v;
    });
  }
  var unidades=1;
  if(tipo==='botella') unidades=Math.max(1,parseInt((document.getElementById('ep-unidades')||{}).value)||1);
  var mlDisp=tipo==='decants'?null:ml*unidades;
  DB.editarPerfume(id,{
    nombre:nombre,marca:marca,ml_totales:ml,
    costo_total:parseInt((document.getElementById('ep-costo')||{}).value)||0,
    precios:precios,
    precio_botella:tipo!=='decants'?parseInt((document.getElementById('ep-pbotella')||{}).value)||0:0,
    tipo_venta:tipo,unidades:unidades,ml_disponibles:mlDisp
  },function(ok,msg){
    if(ok){ showToast('Perfume actualizado'); cerrarModal('modal-editar-perfume'); delete _lastLoad['perfumes']; loadPerfumes(); loadPerfumesVenta(); }
    else showToast('Error: '+(msg||'No se pudo actualizar'));
  });
}

function confirmarEliminarPerfume(id,nombre){
  if(!confirm('\u00bfEliminar perfume: '+nombre+'?')) return;
  DB.eliminarPerfume(id,function(ok){
    if(ok){ showToast('Perfume eliminado'); delete _lastLoad['perfumes']; loadPerfumes(); loadPerfumesVenta(); }
    else showToast('No se pudo eliminar');
  });
}

/* ══ HISTORIAL ════════════════════════════════════════════════ */
function filtrarHistorial(estado,el){
  APP._histEstado=estado;
  document.querySelectorAll('#page-historial .chips-row .chip').forEach(function(c){c.className='chip cn';});
  var clsMap={'Todos':'cp','Pagado':'cg','Pendiente':'cw'};
  if(el) el.className='chip '+(clsMap[estado]||'cp');
  loadHistorial();
}

function renderHistorial(ventas){
  var cont=document.getElementById('lista-historial'); if(!cont) return;
  var filtradas=ventas.filter(function(v){ return APP._histEstado==='Todos'||v.estado_pago===APP._histEstado; });
  if(filtradas.length===0){ cont.innerHTML='<p style="color:var(--t3);padding:12px 0">No se encontraron ventas</p>'; return; }
  var col={'Pagado':['rgba(76,175,130,.12)','var(--grn)','cg'],'Pendiente':['rgba(200,146,58,.12)','var(--warn)','cw']};
  cont.innerHTML=filtradas.slice(0,50).map(function(v){
    var c=col[v.estado_pago]||['rgba(91,164,207,.12)','var(--p)','cp'];
    var fecha=v.fecha?v.fecha.substring(0,10):'\u2014';
    var esPendiente=v.estado_pago==='Pendiente';
    var btnPagar=esPendiente?'<button onclick="event.stopPropagation();accionMarcarPagado('+v.id+')" style="margin-top:4px;border:none;background:var(--grn);color:#fff;font-size:var(--fs-sm);font-weight:700;padding:4px 10px;border-radius:8px;cursor:pointer;display:block">\u2713 Marcar pagado</button>':'';
    return '<div class="lr" onclick="verDetalleVenta('+v.id+')" style="cursor:pointer;align-items:flex-start;padding:12px 0">'+
      '<div class="lr-l"><div class="ri" style="background:'+c[0]+';color:'+c[1]+';font-size:var(--fs-sm);margin-top:2px">#'+v.id+'</div>'+
      '<div><div class="rname">'+escHtml(v.cliente_nombre||'An\u00f3nimo')+'</div>'+
      '<div class="rsub">'+fecha+' \u00b7 '+escHtml(v.metodo_pago||'\u2014')+'</div>'+
      btnPagar+'</div></div>'+
      '<div class="lr-r" style="margin-top:2px"><div class="rv vg">'+fmt(v.total||0)+'</div>'+
      '<span class="chip '+c[2]+'">'+v.estado_pago+'</span></div></div>';
  }).join('');
}

function accionMarcarPagado(ventaId){
  if(!confirm('\u00bfMarcar venta #'+ventaId+' como Pagado?')) return;
  DB.marcarPagado(ventaId,function(ok){
    if(ok){ showToast('Venta #'+ventaId+' marcada como Pagado'); delete _lastLoad['historial']; loadHistorial(); }
    else showToast('Error al actualizar la venta');
  });
}

function renderHistorialCache(){ if(APP.ventas.length>0) renderHistorial(APP.ventas); }

function loadHistorial(q){
  q=q||document.getElementById('buscar-historial').value||'';
  if(APP.ventas.length>0) renderHistorial(APP.ventas);
  else _showSpinner('lista-historial');
  DB.getVentas(q,'Todos',function(ventas){
    if(ventas&&ventas.length>0){ APP.ventas=ventas; _markLoaded('historial'); }
    renderHistorial(ventas||APP.ventas);
  });
}

function verDetalleVenta(id){
  var overlay=document.getElementById('modal-detalle-venta');
  var cont=document.getElementById('detalle-venta-content');
  var title=overlay.querySelector('.modal-title');
  if(title) title.textContent='Detalle de venta';
  overlay.classList.add('open');
  cont.innerHTML='<div class="spinner"></div>';
  DB.getDetalleVenta(id,function(items){
    if(!items||items.length===0){ cont.innerHTML='<p style="color:var(--t3)">Sin detalle disponible</p>'; return; }
    var total=items.reduce(function(s,i){return s+(i.precio_unit||0)*(i.cantidad||1);},0);
    cont.innerHTML='<div class="ct">Venta #'+id+'</div>'+
      items.map(function(it){
        return '<div class="lr"><div class="lr-l"><div><div class="rname">'+escHtml(it.perfume_nombre||'\u2014')+'</div>'+
          '<div class="rsub">'+(it.formato_ml||'botella')+' \u00d7 '+it.cantidad+'</div></div></div>'+
          '<div class="rv vg">'+fmt((it.precio_unit||0)*it.cantidad)+'</div></div>';
      }).join('')+
      '<div class="divider"></div>'+
      '<div style="display:flex;justify-content:space-between;padding:8px 0"><b>Total</b><b class="vg">'+fmt(total)+'</b></div>';
  });
}

/* ══ REPORTES ════════════════════════════════════════════════ */
var _REP={ agrup:'mes', serie:'ambos', indCat:'todos', grafCat:'todos' };

function _fmtLbl(desde,hasta){ if(!desde&&!hasta) return 'Todo el tiempo'; return (desde||'inicio')+' \u2192 '+(hasta||'hoy'); }

function setPreset(preset,el){
  document.querySelectorAll('#preset-chips .chip').forEach(function(c){c.className='chip cn';});
  if(el) el.className='chip cp';
  var hoy=new Date();
  var d=document.getElementById('rep-desde'),h=document.getElementById('rep-hasta');
  var fmt2=function(dt){ return dt.toISOString().substring(0,10); };
  if(preset==='todo'){d.value='';h.value='';}
  else if(preset==='hoy'){d.value=fmt2(hoy);h.value=fmt2(hoy);}
  else if(preset==='mes'){d.value=fmt2(new Date(hoy.getFullYear(),hoy.getMonth(),1));h.value=fmt2(hoy);}
  else if(preset==='anio'){d.value=fmt2(new Date(hoy.getFullYear(),0,1));h.value=fmt2(hoy);}
  loadReportes();
}

function setCatRep(cat,el){ _REP.indCat=cat; document.querySelectorAll('#cat-ind-chips .chip').forEach(function(c){c.className='chip cn';}); if(el)el.className='chip cp'; loadReportes(); }
function setAgrup(agrup,el){ _REP.agrup=agrup; document.querySelectorAll('#agrup-chips .chip').forEach(function(c){c.className='chip cn';}); if(el)el.className='chip cp'; renderGrafico(); }
function setSerie(serie,el){ _REP.serie=serie; document.querySelectorAll('#serie-chips .chip').forEach(function(c){c.className='chip cn';}); if(el)el.className='chip cp'; renderGrafico(); }
function setGrafCat(cat,el){ _REP.grafCat=cat; document.querySelectorAll('#cat-graf-chips .chip').forEach(function(c){c.className='chip cn';}); if(el)el.className='chip cp'; _refreshGrafLabel(); renderGrafico(); }

function _refreshGrafLabel(){
  var desde=(document.getElementById('graf-desde')||{}).value||null;
  var hasta=(document.getElementById('graf-hasta')||{}).value||null;
  var catLbl={todos:'Todos',decants:'Decants',botella:'Botella completa'}[_REP.grafCat]||'Todos';
  var lbl=document.getElementById('lbl-graf-periodo');
  if(lbl) lbl.textContent='\ud83d\udcc8 Gr\u00e1fico ['+catLbl+']: '+_fmtLbl(desde,hasta);
}

function _refreshIndLabel(){
  var desde=(document.getElementById('rep-desde')||{}).value||null;
  var hasta=(document.getElementById('rep-hasta')||{}).value||null;
  var lbl=document.getElementById('lbl-ind-periodo');
  if(lbl) lbl.textContent='\ud83d\udcc5 Indicadores: '+_fmtLbl(desde,hasta);
}

function loadReportes(){
  if(!APP.user) return;
  var desde=(document.getElementById('rep-desde')||{}).value||null;
  var hasta=(document.getElementById('rep-hasta')||{}).value||null;
  if(desde==='') desde=null; if(hasta==='') hasta=null;
  var tipo=_REP.indCat!=='todos'?_REP.indCat:null;
  _refreshIndLabel();
  DB.getStats(desde,hasta,tipo,function(data){
    if(!data) return;
    var s=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};
    var ticket=data.ordenes>0?Math.round(data.ventas_total/data.ordenes):0;
    s('r-ventas',fmt(data.ventas_total||0)); s('r-ordenes',String(data.ordenes||0));
    s('r-ticket',fmt(ticket)); s('r-perfumes',String(data.perfumes||0));
    s('r-utilidad',fmt(data.utilidad_total||0)); s('r-margen',(data.margen_pct||0).toFixed(1)+'%');
    s('r-costo-perf',fmt(data.costos_perfume||data.costos_total||0));
    s('r-costo-ins',fmt(data.costos_insumos||0)); s('r-cobrar',fmt(data.por_cobrar||0));
  });
  DB.getInsumosStats(function(st){
    var s=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};
    s('r-inv-ins',fmt(st.valor_inventario||0)); s('r-ins-bajo',String(st.n_bajo_stock||0)); s('r-ins-total',String(st.n_insumos||0));
  });
  DB.getTopPerfumes(5,desde,hasta,tipo,function(top){
    var cont=document.getElementById('top-perfumes'); if(!cont) return;
    if(!top||top.length===0){ cont.innerHTML='<p style="color:var(--t3);font-size:var(--fs-sm)">Sin ventas aun</p>'; return; }
    cont.innerHTML=top.map(function(p,i){
      var bg=i%2===0?'background:var(--bg-in);border-radius:8px;':'';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 10px;'+bg+'">'+
        '<div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">'+
        '<span style="color:var(--p);font-weight:800;font-size:var(--fs-lg);min-width:28px;text-align:right;font-family:Georgia,serif">'+(i+1)+'</span>'+
        '<div style="min-width:0"><div style="font-size:var(--fs);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+escHtml(p.nombre||'\u2014')+'</div>'+
        '<div style="font-size:var(--fs-sm);color:var(--t3)">'+escHtml(p.marca||'')+'</div></div></div>'+
        '<div style="font-size:var(--fs);font-weight:700;color:var(--grn);flex-shrink:0;margin-left:10px">'+(p.total_vendido||0)+' vendidos</div></div>';
    }).join('');
  });
  DB.getTopClientes(5,desde,hasta,tipo,function(top){
    var cont=document.getElementById('top-clientes'); if(!cont) return;
    if(!top||top.length===0){ cont.innerHTML='<p style="color:var(--t3);font-size:var(--fs-sm)">Sin clientes aun</p>'; return; }
    cont.innerHTML=top.map(function(c,i){
      var bg=i%2===0?'background:var(--bg-in);border-radius:8px;':'';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 10px;'+bg+'">'+
        '<div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">'+
        '<span style="color:var(--p);font-weight:800;font-size:var(--fs-lg);min-width:28px;text-align:right;font-family:Georgia,serif">'+(i+1)+'</span>'+
        '<div style="min-width:0"><div style="font-size:var(--fs);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+escHtml(c.nombre||'\u2014')+'</div>'+
        '<div style="font-size:var(--fs-sm);color:var(--t3)">'+escHtml(c.telefono||'')+' \u00b7 '+(c.compras||0)+' compras</div></div></div>'+
        '<div style="font-size:var(--fs);font-weight:700;color:var(--gold);flex-shrink:0;margin-left:10px;font-family:Georgia,serif">'+fmt(c.total_comprado||0)+'</div></div>';
    }).join('');
  });
  renderGrafico();
}

function _themeColors(){
  var light=document.body.classList.contains('light');
  return { light:light, bgOuter:light?'#E8EBF0':'#0E0E1A', bgInner:light?'#FFFFFF':'#070710', grid:light?'#D0D5E0':'#2A2A42', axis:light?'#A0A8C0':'#3A3A5A', label:light?'#5A6078':'#8888AA', tick:light?'#7080A0':'#9999BB', valTxt:light?'#FFFFFF':'#000000' };
}

function renderGrafico(){
  var desde=(document.getElementById('graf-desde')||{}).value||null;
  var hasta=(document.getElementById('graf-hasta')||{}).value||null;
  var tipo=_REP.grafCat!=='todos'?_REP.grafCat:null;
  _refreshGrafLabel();
  var canvas=document.getElementById('graf-canvas'); if(!canvas) return;
  var ctx=canvas.getContext('2d');
  var dpr=window.devicePixelRatio||1;
  var wrap=document.getElementById('graf-canvas-wrap');
  var cssW=wrap?wrap.clientWidth||320:320, cssH=340;
  canvas.width=cssW*dpr; canvas.height=cssH*dpr;
  canvas.style.width=cssW+'px'; canvas.style.height=cssH+'px';
  ctx.scale(dpr,dpr);
  var tc0=_themeColors();
  ctx.fillStyle=tc0.bgOuter; ctx.fillRect(0,0,cssW,cssH);
  ctx.fillStyle=tc0.label; ctx.font='13px sans-serif'; ctx.textAlign='center';
  ctx.fillText('Cargando gr\u00e1fico...',cssW/2,cssH/2);
  function _draw(datosV,datosC){
    var serie=_REP.serie,agrup=_REP.agrup;
    var allP={};
    datosV.forEach(function(d){allP[d.periodo]=true;}); datosC.forEach(function(d){allP[d.periodo]=true;});
    var periodos=Object.keys(allP).sort();
    var tc=_themeColors();
    var W=wrap?wrap.clientWidth||320:320,H=340;
    canvas.width=W*dpr; canvas.height=H*dpr; canvas.style.width=W+'px'; canvas.style.height=H+'px';
    ctx.setTransform(1,0,0,1,0,0); ctx.scale(dpr,dpr);
    if(!periodos.length){ ctx.fillStyle=tc.bgOuter; ctx.fillRect(0,0,W,H); ctx.fillStyle=tc.label; ctx.font='13px sans-serif'; ctx.textAlign='center'; ctx.fillText('Sin datos',W/2,H/2); return; }
    var vMap={},cMap={};
    datosV.forEach(function(d){vMap[d.periodo]=parseFloat(d.total||0);}); datosC.forEach(function(d){cMap[d.periodo]=parseFloat(d.costo_total||d.total||0);});
    var valoresV=periodos.map(function(p){return vMap[p]||0;}); var valoresC=periodos.map(function(p){return cMap[p]||0;});
    var allVals=[]; if(serie!=='costos') allVals=allVals.concat(valoresV); if(serie!=='ventas') allVals=allVals.concat(valoresC);
    var maxVal=Math.max.apply(null,allVals.concat([1]));
    var PAD_L=80,PAD_R=24,PAD_T=40,PAD_B=60;
    var areaW=W-PAD_L-PAD_R,areaH=H-PAD_T-PAD_B,n=periodos.length,nSeries=serie==='ambos'?2:1;
    var groupW=Math.min(100,Math.max(20,Math.floor(areaW/Math.max(n,1))-4));
    var barW=Math.floor(groupW/nSeries)-2,gap=(areaW-groupW*n)/(n+1);
    ctx.fillStyle=tc.bgOuter; ctx.fillRect(0,0,W,H); ctx.fillStyle=tc.bgInner; ctx.fillRect(PAD_L,PAD_T,areaW,areaH);
    for(var i=0;i<=5;i++){
      var y=PAD_T+areaH-(i/5)*areaH;
      ctx.strokeStyle=i===0?tc.axis:tc.grid; ctx.setLineDash(i===0?[]:[6,5]);
      ctx.beginPath(); ctx.moveTo(PAD_L,y); ctx.lineTo(PAD_L+areaW,y); ctx.stroke(); ctx.setLineDash([]);
      var v=maxVal*i/5;
      var lbl=v>=1000000?'$'+(v/1000000).toFixed(1)+'M':v>=1000?'$'+Math.round(v/1000)+'k':'$'+Math.round(v);
      ctx.fillStyle=tc.label; ctx.font='11px -apple-system,sans-serif'; ctx.textAlign='right'; ctx.fillText(lbl,PAD_L-6,y+3);
    }
    function drawBar(ix,offset,val,colorMid,colorTop){
      var gx=PAD_L+gap+ix*(groupW+gap),bx=gx+offset;
      var altura=maxVal>0?Math.round((val/maxVal)*areaH):0,byTop=PAD_T+areaH-altura;
      ctx.fillStyle='rgba(0,0,0,0.25)'; ctx.fillRect(bx+3,byTop+3,barW,altura);
      var grad=ctx.createLinearGradient(bx,byTop,bx,byTop+altura);
      grad.addColorStop(0,colorTop); grad.addColorStop(0.4,colorMid); grad.addColorStop(1,colorMid);
      ctx.fillStyle=grad;
      if(altura>6){ ctx.beginPath(); ctx.moveTo(bx+4,byTop); ctx.lineTo(bx+barW-4,byTop); ctx.quadraticCurveTo(bx+barW,byTop,bx+barW,byTop+4); ctx.lineTo(bx+barW,byTop+altura); ctx.lineTo(bx,byTop+altura); ctx.lineTo(bx,byTop+4); ctx.quadraticCurveTo(bx,byTop,bx+4,byTop); ctx.closePath(); ctx.fill(); }
      else ctx.fillRect(bx,byTop,barW,altura);
      if(altura>3){ctx.fillStyle=colorTop;ctx.fillRect(bx,byTop,barW,3);}
      if(val>0&&altura>22){ var lv=val>=1000000?'$'+(val/1000000).toFixed(1)+'M':val>=1000?'$'+Math.round(val/1000)+'k':'$'+Math.round(val); ctx.fillStyle=tc.valTxt; ctx.font='bold 11px -apple-system,sans-serif'; ctx.textAlign='center'; ctx.fillText(lv,bx+barW/2,byTop+16); }
    }
    for(var i2=0;i2<periodos.length;i2++){
      if(serie==='ambos'||serie==='ventas') drawBar(i2,0,valoresV[i2],'#2E8B57','#4CAF82');
      if(serie==='ambos'||serie==='costos') drawBar(i2,serie==='ambos'?barW+2:0,valoresC[i2],'#C0392B','#E85858');
      var gx2=PAD_L+gap+i2*(groupW+gap),cx=gx2+groupW/2,p=periodos[i2],etq=p;
      if(agrup==='dia'&&p.length===10) etq=p.substring(8)+'-'+p.substring(5,7);
      else if(agrup==='mes'&&p.length===7){ var meses={'01':'Ene','02':'Feb','03':'Mar','04':'Abr','05':'May','06':'Jun','07':'Jul','08':'Ago','09':'Sep','10':'Oct','11':'Nov','12':'Dic'}; etq=meses[p.substring(5)]||p.substring(5); }
      ctx.fillStyle=tc.tick; ctx.font='11px -apple-system,sans-serif'; ctx.textAlign='center'; ctx.fillText(etq,cx,H-PAD_B+14);
    }
    ctx.strokeStyle=tc.axis; ctx.lineWidth=2; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(PAD_L,PAD_T); ctx.lineTo(PAD_L,PAD_T+areaH); ctx.lineTo(PAD_L+areaW,PAD_T+areaH); ctx.stroke(); ctx.lineWidth=1;
    var legEl=document.getElementById('graf-legend');
    if(legEl){ legEl.style.display='flex'; var legTxt=''; if(serie==='ambos'||serie==='ventas') legTxt+='<span style="display:flex;align-items:center;gap:5px"><span style="width:14px;height:14px;background:#2E8B57;border-radius:3px;display:inline-block"></span>Ventas</span>'; if(serie==='ambos'||serie==='costos') legTxt+='<span style="display:flex;align-items:center;gap:5px"><span style="width:14px;height:14px;background:#C0392B;border-radius:3px;display:inline-block"></span>Costos</span>'; legEl.innerHTML=legTxt; }
  }
  DB.getVentasPorPeriodo(_REP.agrup,desde,hasta,tipo,function(datosV){
    fetch('/api/reportes/costos-periodo?agrupacion='+_REP.agrup+(desde?'&desde='+desde:'')+(hasta?'&hasta='+hasta:'')+(tipo?'&tipo='+tipo:''),{headers:{'Authorization':'Bearer '+(localStorage.getItem('dp_tk')||'')}})
    .then(function(r){return r.json();}).then(function(d){_draw(datosV||[],d.periodos||[]);}).catch(function(){_draw(datosV||[],[]);});
  });
}

/* ══ INSUMOS ══════════════════════════════════════════════════ */
function renderInsumos(insumos){
  var cont=document.getElementById('lista-insumos'); if(!cont) return;
  if(insumos.length===0){ cont.innerHTML='<p style="color:var(--t3);padding:12px 0">No hay insumos registrados</p>'; return; }
  cont.innerHTML='';

  /* Agrupar por categoría */
  var cats={};
  insumos.forEach(function(ins){
    var cat=ins.categoria||'Otros';
    if(!cats[cat]) cats[cat]=[];
    cats[cat].push(ins);
  });

  Object.keys(cats).sort().forEach(function(cat){
    /* Header categoría */
    var hdr=document.createElement('div');
    hdr.style.cssText='display:flex;align-items:center;justify-content:space-between;padding:10px 0 6px;margin-top:4px';
    hdr.innerHTML='<div style="font-size:var(--fs-sm);font-weight:700;color:var(--p);text-transform:uppercase;letter-spacing:.6px">\ud83d\udce6 '+escHtml(cat)+'</div>'+
      '<div style="font-size:var(--fs-sm);color:var(--t3)">'+cats[cat].length+' insumos</div>';
    cont.appendChild(hdr);

    cats[cat].forEach(function(ins){
      var stock=parseFloat(ins.stock_actual||0);
      var costoUnit=parseFloat(ins.costo_unitario||0);
      var sin=stock<=0, bajo=!sin&&stock<20;
      var barColor=sin?'var(--red)':bajo?'var(--gold)':'var(--grn)';
      /* Barra de progreso: max referencia 100 u. */
      var maxRef=Math.max(stock,100);
      var pct=Math.min(100,(stock/maxRef)*100);
      var chipHtml=sin?'<span class="chip cr" style="font-size:10px">Sin stock</span>':bajo?'<span class="chip ca" style="font-size:10px">Bajo</span>':'';
      var fmtLabel=ins.formato_ml?escHtml(ins.formato_ml):'\u2014';

      var wrap=document.createElement('div');
      wrap.style.cssText='padding:10px 12px;background:var(--bg-in);border-radius:10px;margin-bottom:8px';

      /* Fila nombre + precio */
      var row1=document.createElement('div');
      row1.style.cssText='display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px';
      row1.innerHTML=
        '<div style="min-width:0;flex:1">'+
          '<div style="font-weight:700;font-size:var(--fs);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+escHtml(ins.nombre)+'</div>'+
          '<div style="font-size:var(--fs-sm);color:var(--t3);margin-top:2px">'+fmtLabel+'</div>'+
        '</div>'+
        '<div style="text-align:right;flex-shrink:0;margin-left:12px">'+
          '<div style="font-weight:700;color:var(--p);font-size:var(--fs)">'+fmt(costoUnit)+'/u.</div>'+
          (costoUnit&&stock>0?'<div style="font-size:var(--fs-sm);color:var(--t3)">Total: '+fmt(Math.round(costoUnit*stock))+'</div>':'')+
        '</div>';

      /* Barra de stock */
      var row2=document.createElement('div');
      row2.style.cssText='margin-bottom:8px';
      row2.innerHTML=
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">'+
          '<div style="font-size:var(--fs-sm);color:var(--t3)">Stock</div>'+
          '<div style="display:flex;align-items:center;gap:6px">'+
            '<span style="font-weight:700;font-size:var(--fs-sm);color:'+barColor+'">'+stock+' u.</span>'+
            chipHtml+
          '</div>'+
        '</div>'+
        '<div style="background:var(--bdr2);border-radius:4px;height:8px;overflow:hidden">'+
          '<div style="width:'+pct+'%;height:100%;background:'+barColor+';border-radius:4px;transition:width .4s"></div>'+
        '</div>';

      /* Botones */
      var row3=document.createElement('div');
      row3.style.cssText='display:flex;gap:6px';

      var bRestock=document.createElement('button');
      bRestock.style.cssText='flex:1;border-radius:8px;padding:7px 8px;font-size:12px;font-weight:700;cursor:pointer;background:var(--p);border:none;color:#fff;display:flex;align-items:center;justify-content:center;gap:4px';
      bRestock.innerHTML='\u2b06 + Stock';
      bRestock.addEventListener('click',function(){ abrirRestockInsumo(ins.id,ins.nombre,stock,costoUnit); });

      var bEdit=document.createElement('button');
      bEdit.style.cssText='width:34px;height:34px;border-radius:8px;padding:0;font-size:14px;cursor:pointer;background:rgba(91,164,207,.15);border:1px solid rgba(91,164,207,.3);color:var(--p);display:flex;align-items:center;justify-content:center';
      bEdit.textContent='\u270f';
      bEdit.addEventListener('click',function(){ abrirEditarInsumo(ins); });

      var bDel=document.createElement('button');
      bDel.style.cssText='width:34px;height:34px;border-radius:8px;padding:0;font-size:14px;cursor:pointer;background:rgba(232,68,90,.08);border:1px solid rgba(232,68,90,.3);color:var(--red);display:flex;align-items:center;justify-content:center';
      bDel.textContent='\ud83d\uddd1';
      bDel.addEventListener('click',function(){ confirmarEliminarInsumo(ins.id,ins.nombre); });

      row3.appendChild(bRestock); row3.appendChild(bEdit); row3.appendChild(bDel);
      wrap.appendChild(row1); wrap.appendChild(row2); wrap.appendChild(row3);
      cont.appendChild(wrap);
    });
  });
}

/* ══ RE-STOCK INSUMO ══════════════════════════════════════════ */
function abrirRestockInsumo(id, nombre, stockActual, costoUnit){
  var modal=document.getElementById('modal-restock-insumo');
  document.getElementById('rs-insumo-nombre').textContent='Reponer stock \u2014 '+nombre;
  document.getElementById('rs-stock-actual').textContent=stockActual+' unidades';
  document.getElementById('rs-costo-unit-actual').textContent=fmt(costoUnit);
  document.getElementById('rs-cantidad').value='';
  document.getElementById('rs-costo-nuevo').value='';
  document.getElementById('rs-preview').textContent='';
  modal.dataset.insumoId=id;
  modal.dataset.costoUnit=costoUnit||0;
  modal.classList.add('open');
}

function calcRestockPreview(){
  var cantidad=parseFloat(document.getElementById('rs-cantidad').value)||0;
  var costoNuevo=parseFloat((document.getElementById('rs-costo-nuevo').value||'').replace(/\./g,''))||0;
  var costoUnitActual=parseFloat(document.getElementById('modal-restock-insumo').dataset.costoUnit)||0;
  var prev=document.getElementById('rs-preview');
  if(cantidad>0){
    var costoUnitMostrar=costoNuevo>0?Math.round(costoNuevo/cantidad):costoUnitActual;
    prev.textContent='\u2192 +'+cantidad+' u. \u00b7 $'+costoUnitMostrar.toLocaleString('es-CL')+'/u.';
    prev.style.color='var(--grn)';
  } else {
    prev.textContent='';
  }
}

function guardarRestockInsumo(){
  var modal=document.getElementById('modal-restock-insumo');
  var id=parseInt(modal.dataset.insumoId||0);
  var cantidad=parseFloat(document.getElementById('rs-cantidad').value)||0;
  if(!id||cantidad<=0){ showToast('Ingresa una cantidad v\u00e1lida'); return; }
  var costoNuevo=parseFloat((document.getElementById('rs-costo-nuevo').value||'').replace(/\./g,''))||0;
  var costoUnit=costoNuevo>0?costoNuevo/cantidad:null;
  /* costoUnit = costo por unidad (calculado arriba) */
  DB.reponerInsumo(id, cantidad, costoUnit||null, function(ok,msg){
    if(ok){
      showToast('Stock actualizado (+'+cantidad+' u.)');
      cerrarModal('modal-restock-insumo');
      delete _lastLoad['insumos'];
      loadInsumos();
    } else showToast('Error: '+(msg||'No se pudo reponer'));
  });
}

function abrirEditarInsumo(ins){
  var modal=document.getElementById('modal-editar-insumo');
  if(!modal){ showToast('Modal no disponible'); return; }
  document.getElementById('ei-id').value=ins.id;
  document.getElementById('ei-nombre').value=ins.nombre||'';
  var catEl=document.getElementById('ei-cat'); if(catEl) catEl.value=ins.categoria||'Frascos';
  var fmtEl=document.getElementById('ei-formato');
  var fmtRow=document.getElementById('ei-formato-row');
  if(fmtEl) fmtEl.value=ins.formato_ml||'2ml';
  if(fmtRow) fmtRow.style.display=(ins.categoria==='Frascos')?'block':'none';
  document.getElementById('ei-stock').value=ins.stock_actual||0;
  /* costo total aproximado = costo_unit * stock */
  var costoUnit=parseFloat(ins.costo_unitario||0);
  var stock=parseFloat(ins.stock_actual||0);
  document.getElementById('ei-costo').value=costoUnit&&stock?Math.round(costoUnit*stock):'';
  document.getElementById('ei-preview').textContent=costoUnit?('\u2192 Costo unitario actual: '+fmt(costoUnit)):'';
  modal.classList.add('open');
}

function onCategoriaEditarInsumoChange(){
  var cat=(document.getElementById('ei-cat')||{}).value||'';
  var fmtRow=document.getElementById('ei-formato-row');
  if(fmtRow) fmtRow.style.display=(cat==='Frascos')?'block':'none';
}

function calcCostoUnitEditar(){
  var stock=parseFloat((document.getElementById('ei-stock')||{}).value)||0;
  var total=parseFloat((document.getElementById('ei-costo')||{}).value||'').replace(/\./g,'')||0;
  var prev=document.getElementById('ei-preview');
  if(prev){ if(stock>0&&total>0) prev.textContent='\u2192 Costo unitario: '+fmt(Math.round(total/stock)); else prev.textContent=''; }
}

function guardarEditarInsumo(){
  var id=parseInt((document.getElementById('ei-id')||{}).value||0);
  if(!id){ showToast('Error: ID no encontrado'); return; }
  var nombre=(document.getElementById('ei-nombre').value||'').trim();
  if(!nombre){ showToast('El nombre es obligatorio'); return; }
  var stock=parseFloat(document.getElementById('ei-stock').value)||0;
  var costoTotal=parseFloat((document.getElementById('ei-costo').value||'').replace(/\./g,''))||0;
  var costoUnit=stock>0&&costoTotal>0?costoTotal/stock:0;
  var categoria=document.getElementById('ei-cat').value;
  var fmtEl=document.getElementById('ei-formato');
  var formato=(categoria==='Frascos'&&fmtEl)?fmtEl.value:'';
  DB.editarInsumo(id,{nombre:nombre,categoria:categoria,stock_actual:stock,costo_unit:costoUnit,formato_ml:formato},function(ok,msg){
    if(ok){ showToast('Insumo actualizado'); cerrarModal('modal-editar-insumo'); delete _lastLoad['insumos']; loadInsumos(); }
    else showToast('Error: '+(msg||'No se pudo actualizar'));
  });
}

function confirmarEliminarInsumo(id,nombre){
  if(!confirm('\u00bfEliminar insumo: '+nombre+'?')) return;
  DB.eliminarInsumo(id,function(ok){
    if(ok){ showToast('Insumo eliminado'); delete _lastLoad['insumos']; loadInsumos(); }
    else showToast('No se pudo eliminar');
  });
}

function renderInsumosCache(){ if(APP.insumos.length>0) renderInsumos(APP.insumos); }

function loadInsumos(q){
  q=q||'';
  if(APP.insumos.length>0) renderInsumos(APP.insumos);
  else _showSpinner('lista-insumos');
  DB.getInsumos(q,function(insumos){
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
    s('cos-total-iva',fmt(data.costos_perfume||0)); s('cos-neto',fmt(neto));
    s('cos-iva',fmt(data.costos_perfume?data.costos_perfume-neto:0));
    s('cos-insumos',fmt(data.costos_insumos||0));
  });
  var perf=APP.perfumes.length>0?APP.perfumes:null;
  var _renderCostos=function(perfumes){
    var filtrados=perfumes;
    if(tipo==='decants') filtrados=perfumes.filter(function(p){return p.tipo_venta!=='botella';});
    if(tipo==='botella') filtrados=perfumes.filter(function(p){return p.tipo_venta==='botella';});
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
      return '<div class="lr"><div class="lr-l"><div><div class="rname">'+escHtml(p.nombre)+'</div>'+
        '<div class="rsub">'+escHtml(p.marca)+' \u00b7 '+fmt(Math.round(costoPorMl||0))+'/ml</div></div></div>'+
        '<div class="lr-r"><div class="rv '+(margen>=0?'vg':'vr')+'">'+(margen!==null?margen+'%':'\u2014')+'</div></div></div>';
    }).join('');
  };
  if(perf) _renderCostos(perf);
  else DB.getPerfumes('',function(perfumes){ if(perfumes&&perfumes.length>0) APP.perfumes=perfumes; _renderCostos(perfumes||[]); });
}

/* ══ MODALES CLIENTE ════════════════════════════════════════ */
function abrirModalCliente(){
  APP._editClienteId=null;
  document.getElementById('modal-cli-title').textContent='Nuevo cliente';
  ['mc-nombre','mc-rut','mc-tel','mc-ig','mc-email','mc-notas'].forEach(function(id){var e=document.getElementById(id);if(e)e.value='';});
  _clearRutFeedback();
  document.getElementById('modal-cliente').classList.add('open');
}

function validarRut(rutClean){
  rutClean=rutClean.toUpperCase().replace(/[^0-9K]/g,'');
  if(rutClean.length<2) return false;
  var body=rutClean.slice(0,-1),dv=rutClean.slice(-1),suma=0,mult=2;
  for(var i=body.length-1;i>=0;i--){ suma+=parseInt(body[i])*mult; mult=mult<7?mult+1:2; }
  var dvEsp=11-(suma%11);
  return dv===(dvEsp===11?'0':dvEsp===10?'K':String(dvEsp));
}

function formatRutInput(input){
  var raw=input.value.replace(/[^0-9kK]/g,'').toUpperCase();
  if(raw.length===0){input.value='';_clearRutFeedback();return;}
  var dv=raw.slice(-1),body=raw.slice(0,-1),f='';
  for(var i=body.length-1,j=0;i>=0;i--,j++){ if(j>0&&j%3===0)f='.'+f; f=body[i]+f; }
  input.value=body.length>0?f+'-'+dv:dv;
  var feedEl=document.getElementById('rut-valid'); if(!feedEl) return;
  if(raw.length>3){ var esValido=validarRut(raw); feedEl.textContent=esValido?'\u2713 RUT v\u00e1lido':'\u2717 RUT inv\u00e1lido'; feedEl.style.color=esValido?'var(--grn)':'var(--red)'; feedEl.style.display='block'; }
  else { feedEl.textContent=''; feedEl.style.display='none'; }
}

function _clearRutFeedback(){ var feedEl=document.getElementById('rut-valid'); if(feedEl){feedEl.textContent='';feedEl.style.display='none';} }

function guardarCliente(){
  var nombre=document.getElementById('mc-nombre').value.trim();
  if(!nombre){showToast('El nombre es obligatorio');return;}
  var rutVal=(document.getElementById('mc-rut').value||'').trim();
  if(rutVal&&rutVal.length>3){ var rutClean=rutVal.replace(/\./g,'').replace(/-/g,'').toUpperCase(); if(!validarRut(rutClean)){showToast('El RUT ingresado no es v\u00e1lido');return;} }
  var datos={nombre:nombre,rut:rutVal,telefono:document.getElementById('mc-tel').value,instagram:document.getElementById('mc-ig').value,email:document.getElementById('mc-email').value,notas:document.getElementById('mc-notas').value};
  if(APP._editClienteId){
    var editId=APP._editClienteId;
    DB.editarCliente(editId,datos,function(ok,msg){
      if(ok){showToast('Cliente actualizado');cerrarModal('modal-cliente');APP._editClienteId=null;delete _lastLoad['clientes'];loadClientes();}
      else showToast('Error: '+(msg||'No se pudo actualizar'));
    });
  } else {
    DB.crearCliente(datos,function(ok,msg){
      if(ok){showToast('Cliente creado');cerrarModal('modal-cliente');delete _lastLoad['clientes'];loadClientes();}
      else showToast('Error: '+(msg||'No se pudo crear'));
    });
  }
}

/* ══ MODALES PERFUME ════════════════════════════════════════ */
function abrirModalPerfume(){
  APP._editPerfumeId=null;
  document.getElementById('modal-perf-title').textContent='Nuevo perfume';
  ['mp-nombre','mp-marca','mp-ml','mp-ml-bot','mp-costo','mp-costo-bot','mp-p2','mp-p3','mp-p5','mp-p10','mp-pbotella'].forEach(function(id){var e=document.getElementById(id);if(e)e.value='';});
  var uEl=document.getElementById('mp-unidades'); if(uEl) uEl.value='1';
  document.getElementById('mp-tipo').value='decants';
  setTipoPerfume('decants',null);
  document.getElementById('modal-perfume').classList.add('open');
}

function setTipoPerfume(tipo,btn){
  var tipoEl=document.getElementById('mp-tipo'); if(tipoEl) tipoEl.value=tipo;
  var btnD=document.getElementById('mp-btn-decant');
  var btnB=document.getElementById('mp-btn-botella');
  var onStyle='background:var(--p);color:#fff;border-color:var(--p)';
  var offStyle='background:var(--bg-in);color:var(--t3);border-color:var(--bdr2)';
  if(btnD) btnD.setAttribute('style',btnD.getAttribute('style').replace(/background:[^;]+;color:[^;]+;border-color:[^;]+/,'')+(tipo==='decants'?onStyle:offStyle));
  if(btnB) btnB.setAttribute('style',btnB.getAttribute('style').replace(/background:[^;]+;color:[^;]+;border-color:[^;]+/,'')+(tipo==='botella'?onStyle:offStyle));
  var decEl=document.getElementById('mp-precios-decant');
  var botEl=document.getElementById('mp-precio-botella');
  if(decEl) decEl.style.display=tipo==='botella'?'none':'block';
  if(botEl) botEl.style.display=tipo==='decants'?'none':'block';
}

function onTipoPerfumeChange(){ var tipo=(document.getElementById('mp-tipo')||{}).value||'decants'; setTipoPerfume(tipo,null); }

function guardarPerfume(){
  var nombre=document.getElementById('mp-nombre').value.trim();
  var marca=document.getElementById('mp-marca').value.trim();
  var tipo=(document.getElementById('mp-tipo')||{}).value||'decants';
  var mlEl=tipo==='botella'?document.getElementById('mp-ml-bot'):document.getElementById('mp-ml');
  var ml=parseFloat((mlEl||{}).value)||parseFloat((document.getElementById('mp-ml')||{}).value)||0;
  if(!nombre||!marca||!ml){showToast('Completa nombre, marca y ml');return;}
  var precios={};
  if(tipo!=='botella'){ ['2ml','3ml','5ml','10ml'].forEach(function(f,i){ var ids=['mp-p2','mp-p3','mp-p5','mp-p10']; var v=parseInt(document.getElementById(ids[i]).value)||0; if(v) precios[f]=v; }); }
  var unidades=tipo==='botella'?Math.max(1,parseInt(document.getElementById('mp-unidades').value)||1):1;
  var datos={nombre:nombre,marca:marca,ml_totales:ml,costo_total:parseInt(document.getElementById('mp-costo').value)||0,precios:precios,precio_botella:tipo!=='decants'?parseInt(document.getElementById('mp-pbotella').value)||0:0,tipo_venta:tipo,unidades:unidades,ml_disponibles_inicial:tipo==='decants'?ml:ml*unidades};
  if(APP._editPerfumeId){
    var editId=APP._editPerfumeId;
    DB.editarPerfume(editId,datos,function(ok,msg){
      if(ok){showToast('Perfume actualizado');cerrarModal('modal-perfume');APP._editPerfumeId=null;delete _lastLoad['perfumes'];loadPerfumes();loadPerfumesVenta();}
      else showToast('Error: '+(msg||'No se pudo actualizar'));
    });
  } else {
    DB.crearPerfume(datos,function(ok,msg){
      if(ok){showToast('Perfume creado ('+unidades+' unidad'+(unidades>1?'es':'')+')');cerrarModal('modal-perfume');delete _lastLoad['perfumes'];loadPerfumes();loadPerfumesVenta();}
      else showToast('Error: '+(msg||'No se pudo crear'));
    });
  }
}

function abrirModalInsumo(){
  ['mi-nombre','mi-stock','mi-costo'].forEach(function(id){var e=document.getElementById(id);if(e)e.value='';});
  var catEl=document.getElementById('mi-cat'); if(catEl) catEl.value='Frascos';
  var prevEl=document.getElementById('mi-preview-costo'); if(prevEl) prevEl.textContent='';
  var fmtRow=document.getElementById('mi-formato-row'); if(fmtRow) fmtRow.style.display='block';
  document.getElementById('modal-insumo').classList.add('open');
}

function onCategoriaInsumoChange(){
  var cat=document.getElementById('mi-cat').value;
  var fmtRow=document.getElementById('mi-formato-row');
  if(fmtRow) fmtRow.style.display=(cat==='Frascos')?'block':'none';
}

function calcCostoUnitInsumo(){
  var stock=parseFloat(document.getElementById('mi-stock').value)||0;
  var total=parseFloat((document.getElementById('mi-costo').value||'').replace(/\./g,''))||0;
  var prev=document.getElementById('mi-preview-costo');
  if(prev){ if(stock>0&&total>0) prev.textContent='\u2192 Costo unitario: '+fmt(Math.round(total/stock))+' por unidad'; else prev.textContent=''; }
}

function guardarInsumo(){
  var nombre=document.getElementById('mi-nombre').value.trim();
  if(!nombre){showToast('El nombre es obligatorio');return;}
  var stock=parseFloat(document.getElementById('mi-stock').value)||0;
  var costoTotal=parseFloat((document.getElementById('mi-costo').value||'').replace(/\./g,''))||0;
  var costoUnit=stock>0?costoTotal/stock:0;
  var categoria=document.getElementById('mi-cat').value;
  var fmtEl=document.getElementById('mi-formato');
  var formato=(categoria==='Frascos'&&fmtEl)?fmtEl.value:'';
  DB.crearInsumo({nombre:nombre,categoria:categoria,stock_actual:stock,costo_unit:costoUnit,formato_ml:formato},function(ok,msg){
    if(ok){showToast('Insumo creado');cerrarModal('modal-insumo');delete _lastLoad['insumos'];loadInsumos();}
    else showToast('Error: '+(msg||'No se pudo crear'));
  });
}

function cerrarModal(id){ var el=document.getElementById(id); if(el)el.classList.remove('open'); }
document.addEventListener('click',function(e){ if(e.target.classList.contains('modal-overlay'))cerrarModal(e.target.id); });

/* ══ CONFIG ═════════════════════════════════════════════════ */
function _applyTheme(){
  var isDark=DB.loadSetting('dark_mode',true);
  if(isDark) document.body.classList.remove('light');
  else{ document.body.classList.add('light'); var mc=document.querySelector('meta[name="theme-color"]'); if(mc)mc.setAttribute('content','#3A82B5'); }
  var sw=document.getElementById('sw-dark'); if(sw) sw.checked=isDark;
}

function toggleDark(el){
  var isDark=el?el.checked:!document.body.classList.contains('light');
  var mc=document.querySelector('meta[name="theme-color"]');
  if(isDark){document.body.classList.remove('light');if(mc)mc.setAttribute('content','#5BA4CF');}
  else{document.body.classList.add('light');if(mc)mc.setAttribute('content','#3A82B5');}
  DB.saveSetting('dark_mode',isDark);
  var gc=document.getElementById('graf-canvas');
  if(gc&&document.getElementById('page-reportes').classList.contains('active')) renderGrafico();
}

function setUmbral(val,el){
  document.querySelectorAll('#umbral-chips .chip').forEach(function(c){c.className='chip cn';}); if(el)el.className='chip cp';
  DB.saveSetting('umbral',val); showToast('Umbral: '+val+'%');
}

/* ══ UTILS ══════════════════════════════════════════════════ */
function fmt(n){ return '$'+(Math.round(n)||0).toLocaleString('es-CL'); }
function escHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

var _toastT=null;
function showToast(msg){
  var t=document.getElementById('toast'); if(!t) return;
  if(_toastT){window.clearTimeout(_toastT);_toastT=null;}
  t.style.transition='none'; t.classList.remove('show'); t.textContent=msg;
  void t.offsetHeight; t.style.transition=''; t.classList.add('show');
  _toastT=window.setTimeout(function(){t.classList.remove('show');_toastT=null;},3000);
}

document.addEventListener('DOMContentLoaded',function(){
  var t=document.getElementById('toast');
  if(t) t.addEventListener('click',function(){t.classList.remove('show');if(_toastT){window.clearTimeout(_toastT);_toastT=null;}});
});

function updateOnline(){var b=document.getElementById('offline-banner');if(!b)return;if(!navigator.onLine)b.classList.add('show');else b.classList.remove('show');}
window.addEventListener('online',updateOnline); window.addEventListener('offline',updateOnline); updateOnline();

window.addEventListener('beforeinstallprompt',function(e){
  e.preventDefault(); APP.deferredPrompt=e;
  var card=document.getElementById('card-instalar'); if(card) card.style.display='block';
  var btn=document.getElementById('install-btn'); if(btn) btn.remove();
});
function installPWA(){ if(!APP.deferredPrompt) return; APP.deferredPrompt.prompt(); APP.deferredPrompt.userChoice.then(function(c){if(c.outcome==='accepted')showToast('App instalada');APP.deferredPrompt=null;}); }

document.addEventListener('DOMContentLoaded',function(){
  DB.onSessionExpired(function(){
    showToast('Sesi\u00f3n expirada. Por favor inicia sesi\u00f3n de nuevo.');
    setTimeout(function(){
      APP.user='';
      try{sessionStorage.removeItem('dp_page');}catch(e){}
      var ls=document.getElementById('login-screen'); if(ls)ls.style.display='flex';
      var lu=document.getElementById('lu'),lp=document.getElementById('lp'),le=document.getElementById('le');
      if(lu)lu.value=''; if(lp)lp.value='';
      if(le){le.textContent='Tu sesi\u00f3n expir\u00f3. Inicia sesi\u00f3n de nuevo.';le.style.display='block';}
    },1500);
  });
  var ls=document.getElementById('login-screen'); if(ls)ls.style.display='flex';
  var selP=document.getElementById('sel-perfume'),selF=document.getElementById('sel-formato');
  if(selP) selP.addEventListener('change',onPerfumeSel);
  if(selF) selF.addEventListener('change',onFormatoSel);
});
