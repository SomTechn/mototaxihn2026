let map, marker, conductorId, currentTrip;
let isOnline = false;
let watchId;
let chatSubscription;
let routingControl; 
let myPosition = null; 
let previewMap = null; 
let miSaldo = 0; 
let ofertaTimer = null; // Variable para el timer

// === INICIO ===
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
        
        // Inicializar Sliders
        initSliders();
        
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
        if(isOnline && miSaldo < 20) { alert("⚠️ ALERTA: Saldo bajo."); toggleStatus(); }
    }).subscribe();
    window.supabaseClient.channel('carreras_pendientes').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'carreras', filter: 'estado=eq.buscando' }, p => { 
        if (isOnline && !currentTrip) { 
            sonarAlerta(); 
            mostrarOferta(p.new); 
        } 
    }).subscribe();
}

// === LÓGICA DE SLIDERS Y TIMER ===

function mostrarOferta(viaje) {
    currentTrip = viaje;
    document.getElementById('alertPrice').textContent = `L. ${viaje.precio}`;
    document.getElementById('modalStats').textContent = "Calculando...";
    document.getElementById('modalTrip').style.display = 'flex';
    
    // Resetear Sliders
    resetSlider('slideAccept', true); // True = izquierda a derecha
    resetSlider('slideReject', false); // False = derecha a izquierda

    // Iniciar Timer 30s
    iniciarTimerOferta();

    if (!previewMap) { 
        previewMap = L.map('previewMap', { zoomControl: false, attributionControl: false }); 
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(previewMap); 
    }
    
    setTimeout(() => {
        previewMap.invalidateSize(); 
        previewMap.eachLayer((l) => { if (!l._url) previewMap.removeLayer(l); });
        
        if (myPosition) {
            L.Routing.control({ 
                waypoints: [L.latLng(myPosition.lat, myPosition.lng), L.latLng(viaje.origen_lat, viaje.origen_lng)], 
                createMarker: function() { return null; }, 
                lineOptions: { styles: [{color: '#00e676', opacity: 0.8, weight: 5}] }, 
                addWaypoints: false, draggableWaypoints: false, fitSelectedRoutes: false, show: false 
            }).addTo(previewMap);
            
            const control = L.Routing.control({ 
                waypoints: [L.latLng(viaje.origen_lat, viaje.origen_lng), L.latLng(viaje.destino_lat, viaje.destino_lng)], 
                createMarker: function() { return null; }, 
                lineOptions: { styles: [{color: '#2979ff', opacity: 0.8, weight: 5}] }, 
                addWaypoints: false, draggableWaypoints: false, fitSelectedRoutes: true, show: false 
            }).addTo(previewMap);

            control.on('routesfound', function(e) {
                const summary = e.routes[0].summary;
                document.getElementById('modalStats').textContent = `${(summary.totalDistance/1000).toFixed(1)} km • ${Math.round(summary.totalTime/60)} min`;
            });
        } else { 
            L.marker([viaje.origen_lat, viaje.origen_lng]).addTo(previewMap); 
            previewMap.setView([viaje.origen_lat, viaje.origen_lng], 14); 
        }
    }, 200);
}

function iniciarTimerOferta() {
    clearInterval(ofertaTimer);
    let timeLeft = 30;
    const bar = document.getElementById('timerFill');
    const txt = document.getElementById('timerText');
    
    bar.style.width = "100%";
    bar.style.backgroundColor = "#00e676";
    txt.innerText = "30";

    ofertaTimer = setInterval(() => {
        timeLeft--;
        txt.innerText = timeLeft;
        bar.style.width = (timeLeft / 30 * 100) + "%";
        
        if (timeLeft <= 10) bar.style.backgroundColor = "#ef4444"; // Rojo si falta poco

        if (timeLeft <= 0) {
            rechazarOferta(); // Tiempo agotado
        }
    }, 1000);
}

function rechazarOferta() {
    clearInterval(ofertaTimer);
    document.getElementById('modalTrip').style.display = 'none';
    currentTrip = null;
    if(previewMap) { previewMap.remove(); previewMap = null; }
    // Opcional: Avisar al servidor que se rechazó (para métricas)
}

function initSliders() {
    setupSlider('slideAccept', true, () => aceptarViaje());
    setupSlider('slideReject', false, () => rechazarOferta());
}

function setupSlider(id, isLeftToRight, onComplete) {
    const container = document.getElementById(id);
    const btn = container.querySelector('.slider-btn');
    let isDragging = false;
    let startX;
    
    const startDrag = (e) => {
        isDragging = true;
        startX = (e.touches ? e.touches[0].clientX : e.clientX);
        btn.style.transition = 'none';
    };

    const doDrag = (e) => {
        if (!isDragging) return;
        const currentX = (e.touches ? e.touches[0].clientX : e.clientX);
        const diff = currentX - startX;
        const containerWidth = container.offsetWidth - btn.offsetWidth - 8; // Margen

        if (isLeftToRight) {
            // Deslizar Derecha (Aceptar)
            let newPos = Math.max(0, Math.min(diff, containerWidth));
            btn.style.left = (newPos + 4) + 'px'; // +4 offset inicial
            if (newPos > containerWidth * 0.9) { // 90% completado
                isDragging = false;
                onComplete();
            }
        } else {
            // Deslizar Izquierda (Rechazar)
            let newPos = Math.max(0, Math.min(-diff, containerWidth)); // Negativo porque vamos izq
            btn.style.right = (newPos + 4) + 'px'; 
            if (newPos > containerWidth * 0.9) {
                isDragging = false;
                onComplete();
            }
        }
    };

    const stopDrag = () => {
        if (!isDragging) return;
        isDragging = false;
        btn.style.transition = 'all 0.3s';
        if (isLeftToRight) btn.style.left = '4px';
        else btn.style.right = '4px';
    };

    btn.addEventListener('mousedown', startDrag);
    btn.addEventListener('touchstart', startDrag);
    
    document.addEventListener('mousemove', doDrag);
    document.addEventListener('touchmove', doDrag);
    
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchend', stopDrag);
}

function resetSlider(id, isLeftToRight) {
    const btn = document.querySelector(`#${id} .slider-btn`);
    btn.style.transition = 'none';
    if(isLeftToRight) btn.style.left = '4px';
    else btn.style.right = '4px';
}

// === FUNCIONES GLOBALES ===

async function toggleStatus() {
    const btn = document.getElementById('btnStatus');
    if (!isOnline) {
        if (miSaldo < 20) return alert(`🚫 SALDO INSUFICIENTE`);
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
            
            // Actualizar marcador del conductor
            if (!marker) marker = L.marker([latitude, longitude]).addTo(map); 
            else marker.setLatLng([latitude, longitude]);
            
            // --- CAMBIO AQUÍ: CALCULO DE CENTRO DESPLAZADO (20% ARRIBA) ---
            // 1. Convertimos la lat/lng del conductor a píxeles del mapa
            const zoomLevel = 16;
            const point = map.project([latitude, longitude], zoomLevel);
            
            // 2. Restamos píxeles a Y para que el centro del mapa esté "más al norte"
            // Esto hace que el conductor se vea "más abajo" en la pantalla.
            // Usamos el 25% de la altura de la ventana como desplazamiento.
            const offsetY = window.innerHeight * 0.25; 
            const targetPoint = point.subtract([0, offsetY]);
            
            // 3. Convertimos de nuevo a Lat/Lng y movemos el mapa suavemente
            const targetLatLng = map.unproject(targetPoint, zoomLevel);
            map.panTo(targetLatLng, { animate: true, duration: 1 });
            // -------------------------------------------------------------

            let estado = (!isOnline)?'inactivo':(currentTrip && currentTrip.estado!=='buscando'?'ocupado':'disponible');
            await window.supabaseClient.from('conductores').update({ latitud: latitude, longitud: longitude, estado: estado }).eq('id', conductorId);
        }, null, { enableHighAccuracy: true });
    }
}
function detenerGPS() { if (watchId) navigator.geolocation.clearWatch(watchId); }

async function aceptarViaje() {
    clearInterval(ofertaTimer); // Detener contador
    document.getElementById('modalTrip').style.display = 'none';

    if (!currentTrip || !currentTrip.id) return;

    // CANDADO DE SEGURIDAD
    const { data, error } = await window.supabaseClient.from('carreras').update({ estado: 'aceptada', conductor_id: conductorId }).eq('id', currentTrip.id).eq('estado', 'buscando').select();

    if (error) { console.error(error); return alert("Error de conexión."); }

    if (!data || data.length === 0) {
        alert("⚠️ Otro conductor ganó este viaje.");
        currentTrip = null;
        if(previewMap) { previewMap.remove(); previewMap = null; }
        return;
    }

    // ÉXITO
    currentTrip = data[0]; 
    await window.supabaseClient.from('conductores').update({ estado: 'ocupado' }).eq('id', conductorId); 
    alert("✅ ¡Viaje asignado!");
    configurarPanelViaje(); 
    initChat(currentTrip.id);
}

async function avanzarViaje() {
    if (!currentTrip) return alert("Error");
    const btn = document.getElementById('btnTripAction'); const txt = btn.textContent; btn.textContent="Procesando..."; btn.disabled=true;
    try {
        if (currentTrip.estado === 'aceptada') {
            await window.supabaseClient.from('carreras').update({ estado: 'en_curso' }).eq('id', currentTrip.id);
            currentTrip.estado = 'en_curso'; 
            btn.textContent = "FINALIZAR"; btn.className = "btn-action btn-finish"; btn.disabled = false;
            configurarPanelViaje();
        } else {
            const cobro = parseFloat(currentTrip.precio);
            if(!confirm(`Cobrar L. ${cobro} al cliente.\n(Se descontará 10% de tu saldo)`)) { btn.textContent=txt; btn.disabled=false; return; }
            
            const { error } = await window.supabaseClient.rpc('finalizar_viaje_y_cobrar', { viaje_id: currentTrip.id, conductor_id: conductorId, monto_viaje: cobro });
            if(error) throw error;
            alert("💰 ¡Viaje finalizado!"); 
            
            if(routingControl) { try{ map.removeControl(routingControl); }catch(e){} routingControl = null; }
            
            currentTrip = null; document.getElementById('activeTripPanel').style.display = 'none'; document.getElementById('connectionPanel').style.display = 'block';
            
            if (miSaldo - (cobro * 0.10) < 20) {
                isOnline = false; document.getElementById('btnStatus').textContent = "DESCONECTADO (Saldo Bajo) 🔴"; document.getElementById('btnStatus').className = "btn-status offline";
                await window.supabaseClient.from('conductores').update({ estado: 'inactivo' }).eq('id', conductorId); detenerGPS();
                alert("⚠️ Saldo insuficiente.");
            } else {
                isOnline = true; document.getElementById('btnStatus').textContent = "EN LÍNEA 🟢"; document.getElementById('btnStatus').className = "btn-status online";
                await window.supabaseClient.from('conductores').update({ estado: 'disponible' }).eq('id', conductorId);
            }
        }
    } catch(e) { console.error(e); alert("Error: " + e.message); btn.textContent=txt; btn.disabled=false; }
}

function trazarRuta(lat1, lng1, lat2, lng2) {
    if (routingControl) { try{ map.removeControl(routingControl); }catch(e){} }
    
    routingControl = L.Routing.control({ 
        waypoints: [L.latLng(lat1, lng1), L.latLng(lat2, lng2)], 
        createMarker: function() { return null; }, 
        lineOptions: { styles: [{color: '#2979ff', opacity: 0.7, weight: 6}] }, 
        addWaypoints: false, 
        draggableWaypoints: false, 
        fitSelectedRoutes: false, // <--- IMPORTANTE: Lo ponemos en false para controlarlo manualmente
        show: false 
    }).addTo(map);

    routingControl.on('routesfound', function(e) {
        const routes = e.routes;
        const summary = routes[0].summary;
        document.getElementById('tripStats').textContent = `${(summary.totalDistance/1000).toFixed(1)} km • ${Math.round(summary.totalTime/60)} min`;

        // --- CAMBIO AQUÍ: AJUSTE DE VISTA CON PADDING ---
        // Ajustamos el mapa a la ruta, pero le decimos que deje 300px libres abajo
        // para que el panel del viaje no tape la línea azul.
        const bounds = L.latLngBounds([lat1, lng1], [lat2, lng2]);
        map.fitBounds(bounds, { 
            paddingBottomRight: [0, 300], // 300px de espacio abajo
            paddingTopLeft: [0, 50],      // 50px de espacio arriba
            animate: true 
        });
        // -----------------------------------------------
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
    if (data) { 
        currentTrip = data; 
        isOnline = true; 
        configurarPanelViaje(); 
        iniciarGPS(); 
        initChat(currentTrip.id); 
        document.getElementById('btnStatus').textContent = "EN VIAJE 🟢"; 
        document.getElementById('btnStatus').className = "btn-status online"; 
    } 
}

let clientPhone = ""; function contactarCliente() { if(!clientPhone) return alert("Sin número"); window.open(`https://wa.me/504${clientPhone}`, '_blank'); }
function sonarAlerta() { const c = new (window.AudioContext||window.webkitAudioContext)(); const o = c.createOscillator(); o.connect(c.destination); o.start(); setTimeout(()=>o.stop(),800); }

// === RECARGA Y CHAT ===
function abrirModalRecarga() { document.getElementById('modalRecarga').style.display='flex'; document.getElementById('recMonto').value=''; document.getElementById('recRef').value=''; document.getElementById('recFoto').value=''; document.getElementById('recStatus').innerText=''; document.getElementById('btnEnviarRecarga').disabled=false; document.getElementById('btnEnviarRecarga').innerText="ENVIAR COMPROBANTE"; }
function cerrarModalRecarga() { document.getElementById('modalRecarga').style.display='none'; }
async function enviarRecarga() {
    const m=document.getElementById('recMonto').value; const r=document.getElementById('recRef').value; const f=document.getElementById('recFoto').files[0]; const btn=document.getElementById('btnEnviarRecarga'); const st=document.getElementById('recStatus');
    if(!m || !r || !f) return alert("Llena todo.");
    btn.disabled=true; btn.innerText="Subiendo...";
    try {
        const fname = `${conductorId}_${Date.now()}.${f.name.split('.').pop()}`;
        const { error: upErr } = await window.supabaseClient.storage.from('comprobantes').upload(fname, f); if(upErr) throw upErr;
        const { data: { publicUrl } } = window.supabaseClient.storage.from('comprobantes').getPublicUrl(fname);
        const { error: dbErr } = await window.supabaseClient.from('solicitudes_recarga').insert({ conductor_id: conductorId, monto: m, referencia: r, comprobante_url: publicUrl }); if(dbErr) throw dbErr;
        st.innerText="✅ Enviado."; setTimeout(()=>cerrarModalRecarga(),2000);
    } catch(e) { console.error(e); alert("Error: "+e.message); btn.disabled=false; btn.innerText="REINTENTAR"; }
}

function initChat(carreraId) { 
    const chatBody = document.getElementById('chatBody'); chatBody.innerHTML = '<div style="text-align:center; color:#888; margin-top:10px"><small>Chat con Cliente</small></div>'; 
    window.supabaseClient.from('mensajes').select('*').eq('carrera_id', carreraId).order('created_at', { ascending: true }).then(({ data }) => { if(data) data.forEach(m => pintarMensaje(m)); }); 
    if (chatSubscription) window.supabaseClient.removeChannel(chatSubscription); 
    chatSubscription = window.supabaseClient.channel('chat_' + carreraId).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensajes', filter: `carrera_id=eq.${carreraId}` }, p => { 
        pintarMensaje(p.new); 
        if (p.new.remitente_rol === 'cliente' && document.getElementById('chatModal').style.display === 'none') { document.getElementById('badgeChat').style.display = 'block'; sonarAlerta(); } 
    }).subscribe(); 
}
function pintarMensaje(msg) { const div = document.createElement('div'); div.className = `bubble ${msg.remitente_rol === 'conductor' ? 'bubble-me' : 'bubble-other'}`; div.textContent = msg.texto; document.getElementById('chatBody').appendChild(div); document.getElementById('chatBody').scrollTop = document.getElementById('chatBody').scrollHeight; }
async function enviarMensaje() { const i = document.getElementById('chatInput'); const t = i.value.trim(); if (!t || !currentTrip) return; i.value = ""; await window.supabaseClient.from('mensajes').insert({ carrera_id: currentTrip.id, remitente_rol: 'conductor', texto: t }); }
function abrirChat() { document.getElementById('chatModal').style.display = 'flex'; document.getElementById('badgeChat').style.display = 'none'; document.getElementById('chatBody').scrollTop = document.getElementById('chatBody').scrollHeight; } 
function cerrarChat() { document.getElementById('chatModal').style.display = 'none'; }

async function abrirHistorial() { document.getElementById('historyPanel').style.display = 'flex'; document.getElementById('historyList').innerHTML = "Cargando..."; const { data } = await window.supabaseClient.from('carreras').select('*').eq('conductor_id', conductorId).eq('estado', 'completada').order('fecha_solicitud', { ascending: false }).limit(50); const list = document.getElementById('historyList'); list.innerHTML = ""; if(!data || !data.length) { document.getElementById('totalEarnings').textContent="L. 0"; return list.innerHTML = "<p>Sin viajes.</p>"; } let total = 0; data.forEach(v => { total += parseFloat(v.precio); list.innerHTML += `<div class="history-card"><div class="history-header"><span style="color:#888; font-size:0.9rem">${new Date(v.fecha_solicitud).toLocaleDateString()}</span><span class="history-price">L. ${v.precio}</span></div></div>`; }); document.getElementById('totalEarnings').textContent = `L. ${total.toFixed(2)}`; }
async function abrirPerfil() { document.getElementById('profilePanel').style.display='flex'; const {data:{session}} = await window.supabaseClient.auth.getSession(); const {data:p} = await window.supabaseClient.from('perfiles').select('*').eq('id', session.user.id).single(); const {data:c} = await window.supabaseClient.from('conductores').select('*').eq('id', conductorId).single(); document.getElementById('pName').value=p.nombre; document.getElementById('pPhone').value=p.telefono; document.getElementById('pMoto').value=c.modelo_moto; document.getElementById('pPlate').value=c.placa; document.getElementById('pEmail').value=p.email; }
async function guardarPerfil() { const n=document.getElementById('pName').value; const ph=document.getElementById('pPhone').value; const m=document.getElementById('pMoto').value; const pl=document.getElementById('pPlate').value; const {data:{session}} = await window.supabaseClient.auth.getSession(); await window.supabaseClient.from('perfiles').update({nombre:n, telefono:ph}).eq('id', session.user.id); await window.supabaseClient.from('conductores').update({modelo_moto:m, placa:pl}).eq('id', conductorId); alert("✅ Guardado"); document.getElementById('profilePanel').style.display='none'; }
async function cerrarSesion() { if(confirm("¿Salir?")) { await window.supabaseClient.auth.signOut(); window.location.href='login.html'; } }