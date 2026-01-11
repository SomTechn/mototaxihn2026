let map, marker, conductorId, currentTrip;
let isOnline = false;
let watchId;
let chatSubscription;
let routingControl; 
let myPosition = null; 
let previewMap = null; 
let miSaldo = 0;
let countdownInterval = null; // Variable global para el temporizador

// === INICIO APP ===
window.addEventListener('load', async () => {
    try {
        await esperarSupabase();
        const { data: { session } } = await window.supabaseClient.auth.getSession();
        if (!session) return window.location.href = 'login.html';

        let { data: con } = await window.supabaseClient.from('conductores').select('id, saldo_actual, estado').eq('perfil_id', session.user.id).maybeSingle();
        if (!con) {
            const { data: nuevo } = await window.supabaseClient.from('conductores').insert({ perfil_id: session.user.id }).select().single();
            con = nuevo;
        }
        conductorId = con.id;
        miSaldo = con.saldo_actual || 0; 
        document.getElementById('balanceDisplay').textContent = `L ${miSaldo.toFixed(2)}`;
        
        initMap(); 
        initRealtime();
        checkViajePendiente();
        calcularResumenDiario();
    } catch (e) { console.error(e); }
});

async function esperarSupabase() { return new Promise(r => { const i = setInterval(() => { if (window.supabaseClient) { clearInterval(i); r(); } }, 100); }); }

function initMap() { 
    map = L.map('map', { zoomControl: false }).setView([15.5, -88], 16); 
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map); 
    setTimeout(() => map.invalidateSize(), 500); 
}

function initRealtime() {
    window.supabaseClient.channel('mi_saldo').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conductores', filter: `id=eq.${conductorId}` }, p => { 
        miSaldo = p.new.saldo_actual;
        document.getElementById('balanceDisplay').textContent = `L ${miSaldo.toFixed(2)}`;
        if(isOnline && miSaldo < 20) {
            alert("⚠️ ALERTA: Saldo bajo. Recarga para seguir recibiendo viajes.");
            toggleStatus(); 
        }
    }).subscribe();
    
    window.supabaseClient.channel('carreras_pendientes').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'carreras', filter: 'estado=eq.buscando' }, p => { 
        if (isOnline && !currentTrip) { 
            sonarAlerta(); 
            mostrarOferta(p.new); 
        } 
    }).subscribe();
}

// === OFERTA CON MAPA Y CUENTA REGRESIVA ===
function mostrarOferta(viaje) {
    currentTrip = viaje;
    document.getElementById('alertPrice').textContent = `L. ${viaje.precio}`;
    document.getElementById('modalStats').textContent = "Calculando ruta...";
    document.getElementById('modalTrip').style.display = 'flex';
    
    // Resetear sliders
    const btnAccept = document.querySelector('#slideAccept .slider-btn');
    const btnReject = document.querySelector('#slideReject .slider-btn');
    if (btnAccept) btnAccept.style.left = '4px';
    if (btnReject) btnReject.style.right = '4px';
    
    // INICIAR CUENTA REGRESIVA DE 30 SEGUNDOS
    iniciarCuentaRegresiva();
    
    if (!previewMap) { 
        previewMap = L.map('previewMap', { zoomControl: false, attributionControl: false }); 
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(previewMap); 
    }
    
    setTimeout(() => {
        previewMap.invalidateSize(); 
        previewMap.eachLayer((l) => { if (!l._url) previewMap.removeLayer(l); });
        
        if (myPosition) {
            // Ruta Verde (Yo -> Cliente)
            L.Routing.control({ 
                waypoints: [L.latLng(myPosition.lat, myPosition.lng), L.latLng(viaje.origen_lat, viaje.origen_lng)], 
                createMarker: function() { return null; }, 
                lineOptions: { styles: [{color: '#00e676', opacity: 0.8, weight: 5}] }, 
                addWaypoints: false, draggableWaypoints: false, fitSelectedRoutes: false, show: false 
            }).addTo(previewMap);
            
            // Ruta Azul (Cliente -> Destino) + CÁLCULO
            const control = L.Routing.control({ 
                waypoints: [L.latLng(viaje.origen_lat, viaje.origen_lng), L.latLng(viaje.destino_lat, viaje.destino_lng)], 
                createMarker: function() { return null; }, 
                lineOptions: { styles: [{color: '#2979ff', opacity: 0.8, weight: 5}] }, 
                addWaypoints: false, draggableWaypoints: false, fitSelectedRoutes: true, show: false 
            }).addTo(previewMap);

            control.on('routesfound', function(e) {
                const routes = e.routes;
                const summary = routes[0].summary;
                const km = (summary.totalDistance / 1000).toFixed(1);
                const min = Math.round(summary.totalTime / 60);
                document.getElementById('modalStats').textContent = `${km} km • ${min} min`;
            });

        } else { 
            L.marker([viaje.origen_lat, viaje.origen_lng]).addTo(previewMap); 
            previewMap.setView([viaje.origen_lat, viaje.origen_lng], 14); 
        }
    }, 200);
}

// === FUNCIÓN DE CUENTA REGRESIVA ===
function iniciarCuentaRegresiva() {
    // Limpiar cualquier temporizador previo
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    
    let segundosRestantes = 30;
    const timerText = document.getElementById('timerText');
    const timerFill = document.getElementById('timerFill');
    
    // Actualizar UI inicial
    timerText.textContent = segundosRestantes;
    timerFill.style.width = '100%';
    
    countdownInterval = setInterval(() => {
        segundosRestantes--;
        
        // Actualizar texto
        timerText.textContent = segundosRestantes;
        
        // Actualizar barra de progreso
        const porcentaje = (segundosRestantes / 30) * 100;
        timerFill.style.width = porcentaje + '%';
        
        // Cambiar color cuando queden 10 segundos
        if (segundosRestantes <= 10) {
            timerFill.style.background = '#ef4444'; // Rojo
        }
        
        // Cuando llegue a 0, rechazar automáticamente
        if (segundosRestantes <= 0) {
            clearInterval(countdownInterval);
            countdownInterval = null;
            console.log("⏱️ Tiempo agotado, rechazando viaje automáticamente");
            rechazarViajeAutomatico();
        }
    }, 1000);
}

// === RECHAZAR VIAJE (MANUAL O AUTOMÁTICO) ===
function rechazarViajeAutomatico() {
    if (!currentTrip || !currentTrip.id) {
        cerrarModalOferta();
        return;
    }
    
    console.log("❌ Rechazando viaje automáticamente por timeout");
    
    // NO actualizar la carrera a "cancelada" - solo dejarla en "buscando"
    // para que otros conductores puedan tomarla
    
    // Simplemente cerrar el modal y limpiar
    cerrarModalOferta();
}

async function rechazarViaje() {
    if (!currentTrip || !currentTrip.id) {
        cerrarModalOferta();
        return;
    }
    
    console.log("❌ Conductor rechazó el viaje manualmente");
    
    try {
        // NO actualizar el estado de la carrera
        // Solo cerrar el modal para este conductor
        // La carrera sigue en "buscando" para otros conductores
        
        cerrarModalOferta();
        
    } catch (e) {
        console.error("Error al rechazar viaje:", e);
        cerrarModalOferta();
    }
}

function cerrarModalOferta() {
    // Limpiar temporizador
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    
    // Ocultar modal
    document.getElementById('modalTrip').style.display = 'none';
    
    // Limpiar previewMap
    if (previewMap) {
        try {
            previewMap.eachLayer((layer) => {
                if (!layer._url) { // No remover el tile layer
                    previewMap.removeLayer(layer);
                }
            });
        } catch (e) {
            console.error("Error limpiando mapa:", e);
        }
    }
    
    // Resetear sliders
    const btnAccept = document.querySelector('#slideAccept .slider-btn');
    const btnReject = document.querySelector('#slideReject .slider-btn');
    if (btnAccept) btnAccept.style.left = '4px';
    if (btnReject) btnReject.style.right = '4px';
    
    // Limpiar viaje actual
    currentTrip = null;
    
    console.log("✅ Modal de oferta cerrado correctamente");
}

// === ESTADO Y GPS ===
async function toggleStatus() {
    const btn = document.getElementById('btnStatus');
    if (!isOnline) {
        if (miSaldo < 20) return alert(`🚫 SALDO INSUFICIENTE\nMínimo L. 20 para trabajar.`);
        isOnline = true; btn.textContent = "EN LÍNEA 🟢"; btn.className = "btn-status online"; await window.supabaseClient.from('conductores').update({ estado: 'disponible' }).eq('id', conductorId); iniciarGPS(); 
    } else { 
        isOnline = false; btn.textContent = "DESCONECTADO 🔴"; btn.className = "btn-status offline"; detenerGPS(); await window.supabaseClient.from('conductores').update({ estado: 'inactivo' }).eq('id', conductorId); 
    }
}

function iniciarGPS() {
    if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(async (pos) => {
            const { latitude, longitude } = pos.coords;
            myPosition = { lat: latitude, lng: longitude };
            if (!marker) marker = L.marker([latitude, longitude]).addTo(map); else marker.setLatLng([latitude, longitude]);
            map.setView([latitude, longitude], 16); 
            let estado = (!isOnline)?'inactivo':(currentTrip && currentTrip.estado!=='buscando'?'ocupado':'disponible');
            await window.supabaseClient.from('conductores').update({ latitud: latitude, longitud: longitude, estado: estado }).eq('id', conductorId);
        }, null, { enableHighAccuracy: true });
    }
}
function detenerGPS() { if (watchId) navigator.geolocation.clearWatch(watchId); }

// === ACEPTAR VIAJE ===
async function aceptarViaje() {
    // Limpiar temporizador inmediatamente
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    
    // Ocultamos el modal visualmente primero
    document.getElementById('modalTrip').style.display = 'none';

    if (!currentTrip || !currentTrip.id) return;

    console.log("🚀 Intentando aceptar viaje:", currentTrip.id);

    // === EL CANDADO DE SEGURIDAD ===
    const { data, error } = await window.supabaseClient
        .from('carreras')
        .update({ 
            estado: 'aceptada', 
            conductor_id: conductorId 
        })
        .eq('id', currentTrip.id)
        .eq('estado', 'buscando') // Solo si sigue en "buscando"
        .select();

    if (error) {
        console.error("Error al aceptar:", error);
        alert("Error de conexión. Intenta de nuevo.");
        cerrarModalOferta();
        return;
    }

    // === VERIFICAR QUIÉN GANÓ ===
    if (!data || data.length === 0) {
        alert("⚠️ Lo sentimos, otro conductor ganó este viaje.");
        cerrarModalOferta();
        return;
    }

    // === SI LLEGAMOS AQUÍ, ES TUYO ===
    currentTrip = data[0]; 
    
    await window.supabaseClient
        .from('conductores')
        .update({ estado: 'ocupado' })
        .eq('id', conductorId);

    alert("✅ ¡Viaje asignado! Ve por el cliente.");
    
    configurarPanelViaje(); 
    initChat(currentTrip.id);
}

async function avanzarViaje() {
    if (!currentTrip) return alert("Error");
    const btn = document.getElementById('btnTripAction'); const txt = btn.textContent; btn.textContent="Procesando..."; btn.disabled=true;
    try {
        if (currentTrip.estado === 'aceptada') {
            const { error } = await window.supabaseClient.from('carreras').update({ estado: 'en_curso' }).eq('id', currentTrip.id);
            if(error) throw error;
            currentTrip.estado = 'en_curso'; 
            btn.textContent = "FINALIZAR"; btn.className = "btn-action btn-finish"; btn.disabled = false;
            configurarPanelViaje();
        } else {
            const cobro = parseFloat(currentTrip.precio);
            if(!confirm(`Cobrar L. ${cobro} al cliente.\n(Se descontará 10% de tu saldo)`)) { btn.textContent=txt; btn.disabled=false; return; }
            
            const { error } = await window.supabaseClient.rpc('finalizar_viaje_y_cobrar', { viaje_id: currentTrip.id, conductor_id: conductorId, monto_viaje: cobro });
            if(error) throw error;
            alert("💰 ¡Viaje finalizado!"); 
            
            if(routingControl) { try { map.removeControl(routingControl); } catch(e){} routingControl = null; }
            currentTrip = null; document.getElementById('activeTripPanel').style.display = 'none'; document.getElementById('connectionPanel').style.display = 'block';
            
            if (miSaldo - (cobro * 0.10) < 20) {
                isOnline = false; document.getElementById('btnStatus').textContent = "DESCONECTADO (Saldo Bajo) 🔴"; document.getElementById('btnStatus').className = "btn-status offline";
                await window.supabaseClient.from('conductores').update({ estado: 'inactivo' }).eq('id', conductorId); detenerGPS();
                alert("⚠️ Saldo insuficiente.");
            } else {
                isOnline = true; document.getElementById('btnStatus').textContent = "EN LÍNEA 🟢"; document.getElementById('btnStatus').className = "btn-status online";
                await window.supabaseClient.from('conductores').update({ estado: 'disponible' }).eq('id', conductorId);
            }
            
            calcularResumenDiario();
        }
    } catch(e) { console.error(e); alert("Error: " + e.message); btn.textContent=txt; btn.disabled=false; }
}

function trazarRuta(lat1, lng1, lat2, lng2) {
    if (routingControl) { try { map.removeControl(routingControl); } catch(e){} }
    
    routingControl = L.Routing.control({ 
        waypoints: [L.latLng(lat1, lng1), L.latLng(lat2, lng2)], 
        createMarker: function() { return null; }, 
        lineOptions: { styles: [{color: '#2979ff', opacity: 0.7, weight: 6}] }, 
        addWaypoints: false, draggableWaypoints: false, fitSelectedRoutes: true, show: false 
    }).addTo(map);

    routingControl.on('routesfound', function(e) {
        const summary = e.routes[0].summary;
        const km = (summary.totalDistance / 1000).toFixed(1);
        const min = Math.round(summary.totalTime / 60);
        document.getElementById('tripStats').textContent = `${km} km • ${min} min`;
    });
}

function configurarPanelViaje() {
    const p = document.getElementById('activeTripPanel'); document.getElementById('connectionPanel').style.display = 'none'; p.style.display = 'block';
    document.getElementById('tripPrice').textContent = `L. ${currentTrip.precio}`;
    document.getElementById('txtOrigen').textContent = currentTrip.origen_direccion || "Origen";
    document.getElementById('txtDestino').textContent = currentTrip.destino_direccion || "Destino";
    document.getElementById('tripStats').textContent = "Calculando...";
    
    const t = document.getElementById('tripStepTitle'); const b = document.getElementById('btnTripAction'); b.disabled = false;
    
    window.supabaseClient.from('clientes').select('perfiles(nombre, telefono)').eq('id', currentTrip.cliente_id).single()
        .then(({data}) => { if(data) { document.getElementById('lblClientName').textContent = data.perfiles?.nombre || "Cliente"; clientPhone = data.perfiles?.telefono; } });

    navigator.geolocation.getCurrentPosition(pos => {
        if(currentTrip.estado === 'aceptada') { 
            t.textContent = "1. Recoger"; b.textContent = "YA LLEGUÉ"; b.className = "btn-action btn-primary"; 
            trazarRuta(pos.coords.latitude, pos.coords.longitude, currentTrip.origen_lat, currentTrip.origen_lng); 
        } else { 
            t.textContent = "2. Llevar"; b.textContent = "FINALIZAR"; b.className = "btn-action btn-finish"; 
            trazarRuta(currentTrip.origen_lat, currentTrip.origen_lng, currentTrip.destino_lat, currentTrip.destino_lng); 
        }
    });
}

function abrirWaze() { if(!currentTrip) return; const lat = currentTrip.estado==='aceptada' ? currentTrip.origen_lat : currentTrip.destino_lat; const lng = currentTrip.estado==='aceptada' ? currentTrip.origen_lng : currentTrip.destino_lng; window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank'); }

async function cancelarViaje() { 
    if(!confirm("¿Cancelar?")) return; 
    if(routingControl) { try{ map.removeControl(routingControl); }catch(e){} routingControl = null; } 
    await window.supabaseClient.from('carreras').update({ estado: 'cancelada' }).eq('id', currentTrip.id); 
    await window.supabaseClient.from('conductores').update({ estado: 'disponible' }).eq('id', conductorId); 
    location.reload(); 
}

async function checkViajePendiente() { 
    const { data } = await window.supabaseClient.from('carreras').select('*').eq('conductor_id', conductorId).in('estado', ['aceptada', 'en_curso']).maybeSingle(); 
    if (data) { currentTrip = data; isOnline = true; configurarPanelViaje(); iniciarGPS(); initChat(currentTrip.id); document.getElementById('btnStatus').textContent = "EN VIAJE 🟢"; document.getElementById('btnStatus').className = "btn-status online"; } 
}

let clientPhone = ""; 
function contactarCliente() { if(!clientPhone) return alert("Sin número"); window.open(`https://wa.me/504${clientPhone}`, '_blank'); }
function sonarAlerta() { const c = new (window.AudioContext||window.webkitAudioContext)(); const o = c.createOscillator(); o.connect(c.destination); o.start(); setTimeout(()=>o.stop(),800); }

// === NUEVA RECARGA ===
function abrirModalRecarga() { document.getElementById('modalRecarga').style.display='flex'; document.getElementById('recMonto').value=''; document.getElementById('recRef').value=''; document.getElementById('recFoto').value=''; document.getElementById('recStatus').innerText=''; document.getElementById('btnEnviarRecarga').disabled=false; document.getElementById('btnEnviarRecarga').innerText="ENVIAR COMPROBANTE"; }
function cerrarModalRecarga() { document.getElementById('modalRecarga').style.display='none'; }
async function enviarRecarga() {
    const m=document.getElementById('recMonto').value; const r=document.getElementById('recRef').value; const f=document.getElementById('recFoto').files[0]; const btn=document.getElementById('btnEnviarRecarga'); const st=document.getElementById('recStatus');
    if(!m || !r || !f) return alert("Llena todo y sube foto.");
    btn.disabled=true; btn.innerText="Subiendo...";
    try {
        const fname = `${conductorId}_${Date.now()}.${f.name.split('.').pop()}`;
        const { error: upErr } = await window.supabaseClient.storage.from('billetera').upload(fname, f); if(upErr) throw upErr;
        const { data: { publicUrl } } = window.supabaseClient.storage.from('billetera').getPublicUrl(fname);
        const { error: dbErr } = await window.supabaseClient.from('solicitudes_recarga').insert({ conductor_id: conductorId, monto: m, referencia: r, comprobante_url: publicUrl }); if(dbErr) throw dbErr;
        st.innerText="✅ Enviado."; setTimeout(()=>cerrarModalRecarga(),2000);
    } catch(e) { console.error(e); alert("Error: "+e.message); btn.disabled=false; btn.innerText="REINTENTAR"; }
}

// === CHAT ===
function initChat(carreraId) { 
    const chatBody = document.getElementById('chatBody'); 
    chatBody.innerHTML = '<div style="text-align:center; color:#888; margin-top:10px"><small>Chat con Cliente</small></div>'; 
    window.supabaseClient.from('mensajes').select('*').eq('carrera_id', carreraId).order('created_at', { ascending: true }).then(({ data }) => { if(data) data.forEach(m => pintarMensaje(m)); }); 
    if (chatSubscription) window.supabaseClient.removeChannel(chatSubscription); 
    chatSubscription = window.supabaseClient.channel('chat_' + carreraId).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensajes', filter: `carrera_id=eq.${carreraId}` }, p => { 
        pintarMensaje(p.new); 
        if (p.new.remitente_rol === 'cliente' && document.getElementById('chatModal').style.display === 'none') { 
            document.getElementById('badgeChat').style.display = 'block'; 
            sonarAlerta();
        } 
    }).subscribe(); 
}

function pintarMensaje(msg) { 
    const div = document.createElement('div'); div.className = `bubble ${msg.remitente_rol === 'conductor' ? 'bubble-me' : 'bubble-other'}`; div.textContent = msg.texto; 
    document.getElementById('chatBody').appendChild(div); document.getElementById('chatBody').scrollTop = document.getElementById('chatBody').scrollHeight; 
}
async function enviarMensaje() { const i = document.getElementById('chatInput'); const t = i.value.trim(); if (!t || !currentTrip) return; i.value = ""; await window.supabaseClient.from('mensajes').insert({ carrera_id: currentTrip.id, remitente_rol: 'conductor', texto: t }); }
function abrirChat() { document.getElementById('chatModal').style.display = 'flex'; document.getElementById('badgeChat').style.display = 'none'; document.getElementById('chatBody').scrollTop = document.getElementById('chatBody').scrollHeight; } 
function cerrarChat() { document.getElementById('chatModal').style.display = 'none'; }

// === AUXILIARES ===
async function abrirHistorial() { document.getElementById('historyPanel').style.display = 'flex'; document.getElementById('historyList').innerHTML = "Cargando..."; const { data } = await window.supabaseClient.from('carreras').select('*').eq('conductor_id', conductorId).eq('estado', 'completada').order('fecha_solicitud', { ascending: false }).limit(50); const list = document.getElementById('historyList'); list.innerHTML = ""; if(!data || !data.length) { document.getElementById('totalEarnings').textContent="L. 0"; return list.innerHTML = "<p>Sin viajes.</p>"; } let total = 0; data.forEach(v => { total += parseFloat(v.precio); list.innerHTML += `<div class="history-card"><div class="history-header"><span style="color:#888; font-size:0.9rem">${new Date(v.fecha_solicitud).toLocaleDateString()}</span><span class="history-price">L. ${v.precio}</span></div></div>`; }); document.getElementById('totalEarnings').textContent = `L. ${total.toFixed(2)}`; }
async function abrirPerfil() { document.getElementById('profilePanel').style.display='flex'; const {data:{session}} = await window.supabaseClient.auth.getSession(); const {data:p} = await window.supabaseClient.from('perfiles').select('*').eq('id', session.user.id).single(); const {data:c} = await window.supabaseClient.from('conductores').select('*').eq('id', conductorId).single(); document.getElementById('pName').value=p.nombre; document.getElementById('pPhone').value=p.telefono; document.getElementById('pMoto').value=c.modelo_moto; document.getElementById('pPlate').value=c.placa; document.getElementById('pEmail').value=p.email; }
async function guardarPerfil() { const n=document.getElementById('pName').value; const ph=document.getElementById('pPhone').value; const m=document.getElementById('pMoto').value; const pl=document.getElementById('pPlate').value; const {data:{session}} = await window.supabaseClient.auth.getSession(); await window.supabaseClient.from('perfiles').update({nombre:n, telefono:ph}).eq('id', session.user.id); await window.supabaseClient.from('conductores').update({modelo_moto:m, placa:pl}).eq('id', conductorId); alert("✅ Guardado"); document.getElementById('profilePanel').style.display='none'; }
async function cerrarSesion() { if(confirm("¿Salir?")) { await window.supabaseClient.auth.signOut(); window.location.href='login.html'; } }

async function calcularResumenDiario() {
    if(!window.supabaseClient || !conductorId) return;
    const hoy = new Date().toISOString().split('T')[0];
    const { data } = await window.supabaseClient.from('carreras').select('precio').eq('conductor_id', conductorId).eq('estado', 'completada').gte('fecha_solicitud', hoy + 'T00:00:00').lte('fecha_solicitud', hoy + 'T23:59:59');
    let totalHoy = 0; let viajesHoy = 0;
    if(data) { viajesHoy = data.length; data.forEach(c => totalHoy += parseFloat(c.precio)); }
    document.getElementById('todayTrips').innerText = `Viajes: ${viajesHoy}`;
    document.getElementById('todayEarnings').innerText = `Ganado: L. ${totalHoy.toFixed(2)}`;
}