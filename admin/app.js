let map, drawnItems, currentLayer;
let driverMarkers = {}; // Marcadores de conductores
let requestMarkers = {}; // Marcadores de clientes (SOLICITUDES)
let zoneLayers = {}; // Capas de zonas

window.addEventListener('load', async () => {
    try {
        await esperarSupabase();
        
        const { data: { session } } = await window.supabaseClient.auth.getSession();
        if (!session) { window.location.href = 'login.html'; return; }

        console.log("🚀 Admin Panel - Full Mode");
        initMap();
        
        // Cargar datos en orden
        await initRealtimeConductores(); 
        await initRealtimeSolicitudes(); 
        
        setTimeout(() => cargarZonas(), 1000); 

        initRealtimeFinanzas();
        initRealtimeSOS();
        calcularEstadisticas();
        
        setInterval(() => cargarZonas(), 10000); // Refrescar zonas cada 10s

    } catch (e) { console.error(e); }
});

async function esperarSupabase() { return new Promise(r => { const i = setInterval(() => { if (window.supabaseClient) { clearInterval(i); r(); } }, 100); }); }

async function salir() {
    if(!confirm("¿Cerrar sesión?")) return;
    await window.supabaseClient.auth.signOut();
    window.location.href = 'login.html';
}

function ver(id) {
    document.querySelectorAll('.main > div').forEach(div => div.style.display = 'none');
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('sec-' + id).style.display = 'block';
    if(event && event.currentTarget) event.currentTarget.classList.add('active');
    
    if(id === 'finanzas') cargarFinanzas();
    if(id === 'caja') cargarCaja();
    if(id === 'conductores') cargarConductores();
    if(id === 'clientes') cargarClientes(); // <--- NUEVA SECCIÓN
    if(id === 'zonas') { setTimeout(() => map.invalidateSize(), 200); cargarZonas(); }
}

// === MAPA BASE ===
function initMap() {
    map = L.map('mapAdmin').setView([15.50, -88.02], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);

    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    const drawControl = new L.Control.Draw({
        draw: { polygon: true, polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false },
        edit: { featureGroup: drawnItems }
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, function (e) {
        drawnItems.clearLayers();
        currentLayer = e.layer;
        drawnItems.addLayer(currentLayer);
    });
}

// === RADAR DE CONDUCTORES ===
function initRealtimeConductores() {
    window.supabaseClient.from('conductores').select('*').then(({ data }) => {
        if(data) data.forEach(c => actualizarMarcadorConductor(c));
    });

    window.supabaseClient.channel('admin_flota')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conductores' }, payload => {
            actualizarMarcadorConductor(payload.new);
            calcularEstadisticas();
        }).subscribe();
}

function actualizarMarcadorConductor(conductor) {
    if (!conductor.latitud || !conductor.longitud) return;
    const motoIcon = L.divIcon({ html: `<div style="font-size:20px;">🏍️</div>`, className: 'dummy', iconSize: [24, 24] });

    if (driverMarkers[conductor.id]) {
        driverMarkers[conductor.id].setLatLng([conductor.latitud, conductor.longitud]);
        driverMarkers[conductor.id].setPopupContent(`<b>${conductor.estado.toUpperCase()}</b><br>Saldo: L. ${conductor.saldo_actual}`);
    } else {
        const marker = L.marker([conductor.latitud, conductor.longitud], { icon: motoIcon })
            .bindPopup(`<b>${conductor.estado.toUpperCase()}</b><br>Saldo: L. ${conductor.saldo_actual}`).addTo(map);
        driverMarkers[conductor.id] = marker;
    }
}

// === RADAR DE CLIENTES (SOLICITUDES) ===
function initRealtimeSolicitudes() {
    window.supabaseClient.from('carreras').select('*').eq('estado', 'buscando')
        .then(({ data }) => { 
            if(data && data.length > 0) data.forEach(v => agregarMarcadorSolicitud(v)); 
        });

    window.supabaseClient.channel('admin_requests')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'carreras' }, payload => {
            const viaje = payload.new;
            if (viaje.estado === 'buscando') {
                agregarMarcadorSolicitud(viaje);
                if(payload.eventType === 'INSERT') alert("🔔 ¡Nuevo cliente esperando!");
            } else {
                eliminarMarcadorSolicitud(viaje.id);
            }
            calcularEstadisticas();
        })
        .subscribe();
}

function agregarMarcadorSolicitud(viaje) {
    const lat = parseFloat(viaje.origen_lat);
    const lng = parseFloat(viaje.origen_lng);

    if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) return;
    
    const clientIcon = L.divIcon({ html: `🙋‍♂️`, className: 'client-icon', iconSize: [30, 30], iconAnchor: [15, 15] });
    
    if (requestMarkers[viaje.id]) {
        requestMarkers[viaje.id].setLatLng([lat, lng]);
    } else {
        const marker = L.marker([lat, lng], { icon: clientIcon })
            .bindPopup(`<b style="color:blue">CLIENTE</b><br>Tarifa: L. ${viaje.precio}`)
            .addTo(map);
        requestMarkers[viaje.id] = marker;
    }
}

function eliminarMarcadorSolicitud(id) {
    if (requestMarkers[id]) {
        map.removeLayer(requestMarkers[id]);
        delete requestMarkers[id];
    }
}

// === ZONAS ===
async function guardarZona() {
    const nombre = document.getElementById('zoneName').value;
    const precio = document.getElementById('zonePrice').value || 20;

    if (!nombre || !currentLayer) return alert("⚠️ Dibuja y nombra la zona.");
    const geojson = currentLayer.toGeoJSON().geometry;
    const coords = geojson.coordinates[0];
    if (coords[0][0] !== coords[coords.length - 1][0]) geojson.coordinates[0].push(coords[0]);

    try {
        const { error } = await window.supabaseClient.rpc('crear_zona_rpc', {
            nombre_zona: nombre, comision: 10, base: parseFloat(precio), geometria: geojson
        });
        if (error) throw error;
        alert("✅ Zona guardada");
        document.getElementById('zoneName').value = ""; drawnItems.clearLayers(); currentLayer = null; 
        cargarZonas();
    } catch (e) { alert("Error: " + e.message); }
}

async function cargarZonas() {
    const { data } = await window.supabaseClient.from('puntos_view').select('*');
    const list = document.getElementById('zonesList'); list.innerHTML = "";
    Object.values(zoneLayers).forEach(layer => map.removeLayer(layer));
    zoneLayers = {};

    if (data) {
        data.forEach(zona => {
            if (zona.area) {
                const layer = L.geoJSON(zona.area, { style: { color: "#3b82f6", weight: 2, fillOpacity: 0.1 } }).addTo(map);
                zoneLayers[zona.id] = layer;

                const polyCoords = zona.area.coordinates[0];
                let motosCount = 0;
                let clientesCount = 0;

                Object.values(driverMarkers).forEach(m => { if (isMarkerInsidePolygon(m.getLatLng(), polyCoords)) motosCount++; });
                Object.values(requestMarkers).forEach(m => { if (isMarkerInsidePolygon(m.getLatLng(), polyCoords)) clientesCount++; });

                list.innerHTML += `
                    <div class="card" style="padding:15px; margin-bottom:10px; cursor:pointer; border-left: 5px solid #3b82f6;" onclick="focarZona('${zona.id}')">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <strong style="font-size:1.1rem">${zona.nombre}</strong>
                                <div style="font-size:0.9rem; color:#666; margin-top:5px;">
                                    🏍️ Libres: <b>${motosCount}</b> | 🙋‍♂️ Esperando: <b>${clientesCount}</b>
                                </div>
                                <small style="color:#aaa">Tarifa Base: L. ${zona.tarifa_base}</small>
                            </div>
                            <button class="btn btn-danger" onclick="event.stopPropagation(); borrarZona('${zona.id}')">🗑️</button>
                        </div>
                    </div>`;
            }
        });
    }
}

function focarZona(id) {
    const layer = zoneLayers[id];
    if (layer) map.fitBounds(layer.getBounds(), { padding: [50, 50] });
}

function isMarkerInsidePolygon(latlng, polyPoints) {
    const x = latlng.lng, y = latlng.lat;
    let inside = false;
    for (let i = 0, j = polyPoints.length - 1; i < polyPoints.length; j = i++) {
        const xi = polyPoints[i][0], yi = polyPoints[i][1];
        const xj = polyPoints[j][0], yj = polyPoints[j][1];
        const intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

async function borrarZona(id) {
    if(!confirm("¿Eliminar zona?")) return;
    await window.supabaseClient.from('puntos').delete().eq('id', id);
    cargarZonas();
}

// === FINANZAS ===
function initRealtimeFinanzas() {
    window.supabaseClient.channel('admin_alertas_finanzas')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'solicitudes_recarga' }, () => {
            alert("🔔 Nueva solicitud de saldo");
            if(document.getElementById('sec-finanzas').style.display === 'block') cargarFinanzas();
        }).subscribe();
}

async function cargarFinanzas() {
    const list = document.getElementById('finanzasList'); list.innerHTML = "Cargando...";
    const { data } = await window.supabaseClient.from('solicitudes_recarga').select('*, conductores(perfiles(nombre))').eq('estado', 'pendiente').order('created_at', { ascending: false });
    list.innerHTML = "";
    if (!data || !data.length) return list.innerHTML = "<div class='card'>No hay solicitudes pendientes.</div>";
    data.forEach(s => {
        const btnFoto = s.comprobante_url ? `<a href="${s.comprobante_url}" target="_blank" style="background:#3b82f6; color:white; padding:5px; border-radius:5px; text-decoration:none">📷 Foto</a>` : `<span style="color:red">Sin foto</span>`;
        list.innerHTML += `<div class="card finance-item"><div><h3>${s.conductores?.perfiles?.nombre || 'Conductor'}</h3><small>Ref: ${s.referencia}</small><br>${btnFoto}</div><div style="text-align:right"><div class="amount">L. ${s.monto}</div><div><button class="btn btn-danger" onclick="rechazarRecarga('${s.id}')">X</button> <button class="btn btn-success" onclick="aprobarRecarga('${s.id}', ${s.monto}, '${s.conductor_id}')">OK</button></div></div></div>`;
    });
}

async function aprobarRecarga(solID, monto, condID) {
    if(!confirm(`¿Aprobar L. ${monto}?`)) return;
    await window.supabaseClient.from('solicitudes_recarga').update({ estado: 'aprobada' }).eq('id', solID);
    const { data: c } = await window.supabaseClient.from('conductores').select('saldo_actual').eq('id', condID).single();
    await window.supabaseClient.from('conductores').update({ saldo_actual: (c.saldo_actual || 0) + parseFloat(monto) }).eq('id', condID);
    alert("✅ Aprobado"); cargarFinanzas();
}

async function rechazarRecarga(solID) {
    if(!confirm("¿Rechazar?")) return;
    await window.supabaseClient.from('solicitudes_recarga').update({ estado: 'rechazada' }).eq('id', solID);
    alert("❌ Rechazada"); cargarFinanzas();
}

async function cargarCaja() {
    const list = document.getElementById('cajaList'); list.innerHTML = "<tr><td colspan='5'>Cargando...</td></tr>";
    const { data } = await window.supabaseClient.from('solicitudes_recarga').select('*, conductores(perfiles(nombre))').neq('estado', 'pendiente').order('created_at', { ascending: false }).limit(50);
    list.innerHTML = ""; 
    data.forEach(m => {
        list.innerHTML += `<tr style="border-bottom:1px solid #eee"><td style="padding:10px">${new Date(m.created_at).toLocaleDateString()}</td><td style="padding:10px">${m.conductores?.perfiles?.nombre || '-'}</td><td style="padding:10px">${m.referencia}</td><td style="padding:10px; font-weight:bold">L. ${m.monto}</td><td style="padding:10px">${m.estado}</td></tr>`;
    });
}

// === CONDUCTORES (FILTRADO POR ROL) ===
async function cargarConductores() {
    const list = document.getElementById('conductoresList'); list.innerHTML = "Cargando...";
    // Traemos el rol para filtrar
    const { data } = await window.supabaseClient.from('conductores').select('*, perfiles(nombre, telefono, rol)');
    list.innerHTML = "";
    if(data) data.forEach(c => {
        // FILTRO: Si no es 'conductor', no mostrar (evita admins y clientes)
        if (c.perfiles?.rol !== 'conductor') return;

        const btnAction = c.estado === 'bloqueado' ? `<button class="btn btn-success" onclick="cambiarEstadoConductor('${c.id}', 'inactivo')">Desbloquear</button>` : `<button class="btn btn-danger" onclick="cambiarEstadoConductor('${c.id}', 'bloqueado')">Bloquear</button>`;
        list.innerHTML += `<div class="card"><div style="display:flex; justify-content:space-between"><div><strong>${c.perfiles?.nombre || 'Sin Nombre'}</strong><br><small>${c.perfiles?.telefono || '--'}</small></div><div>Saldo: <b>L.${c.saldo_actual}</b><br>${btnAction}</div></div></div>`;
    });
}
async function cambiarEstadoConductor(id, st) { if(confirm("¿Cambiar?")) { await window.supabaseClient.from('conductores').update({ estado: st }).eq('id', id); cargarConductores(); } }

// === NUEVO: GESTIÓN DE CLIENTES ===
async function cargarClientes() {
    const list = document.getElementById('clientesList'); 
    list.innerHTML = "<tr><td colspan='5'>Cargando base de datos...</td></tr>";

    // Traemos clientes + perfiles + viajes asociados
    const { data } = await window.supabaseClient
        .from('clientes')
        .select('*, perfiles(nombre, telefono, created_at), carreras(estado)');

    list.innerHTML = "";
    if (!data || !data.length) return list.innerHTML = "<tr><td colspan='5'>No hay clientes registrados.</td></tr>";

    data.forEach(c => {
        // Estadísticas simples
        const completados = c.carreras ? c.carreras.filter(v => v.estado === 'completada').length : 0;
        const cancelados = c.carreras ? c.carreras.filter(v => v.estado === 'cancelada').length : 0;
        const fecha = c.perfiles?.created_at ? new Date(c.perfiles.created_at).toLocaleDateString() : '--';

        list.innerHTML += `
            <tr style="border-bottom:1px solid #eee">
                <td style="padding:10px"><strong>${c.perfiles?.nombre || 'Anónimo'}</strong></td>
                <td style="padding:10px">${c.perfiles?.telefono || '--'}</td>
                <td style="padding:10px; color:#64748b">${fecha}</td>
                <td style="padding:10px; text-align:center; color:#166534; font-weight:bold">${completados}</td>
                <td style="padding:10px; text-align:center; color:#991b1b">${cancelados}</td>
            </tr>`;
    });
}

// === SOS & AUX ===
function initRealtimeSOS() { window.supabaseClient.channel('admin_sos').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'carreras', filter: 'sos=eq.true' }, payload => { mostrarAlertaSOS(payload.new); }).subscribe(); }
async function mostrarAlertaSOS(viaje) {
    const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/995/995-preview.mp3'); audio.loop = true; audio.play().catch(e=>{});
    const { data: c } = await window.supabaseClient.from('conductores').select('perfiles(nombre)').eq('id', viaje.conductor_id).single();
    const div = document.createElement('div');
    div.style = "position:fixed; top:0; left:0; right:0; bottom:0; background:red; z-index:9999; display:flex; justify-content:center; align-items:center; color:white; flex-direction:column";
    div.innerHTML = `<h1>🚨 SOS 🚨</h1><p>Conductor: ${c?.perfiles?.nombre}</p><button onclick="location.reload()" style="padding:20px; font-size:2rem">ATENDER</button>`;
    document.body.appendChild(div);
}

async function calcularEstadisticas() {
    const { count: conductores } = await window.supabaseClient.from('conductores').select('*', { count: 'exact', head: true }).eq('estado', 'disponible');
    document.getElementById('statDrivers').textContent = conductores || 0;
    const { count: req } = await window.supabaseClient.from('carreras').select('*', { count: 'exact', head: true }).eq('estado', 'buscando');
    document.getElementById('statRequests').textContent = req || 0;
    const { data: recargas } = await window.supabaseClient.from('solicitudes_recarga').select('monto').eq('estado', 'aprobada');
    let total = 0; if(recargas) recargas.forEach(r => total += parseFloat(r.monto));
    document.getElementById('statEarnings').textContent = `L. ${total}`;
}