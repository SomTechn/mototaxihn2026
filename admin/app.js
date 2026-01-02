let map, drawnItems, currentLayer;
let driverMarkers = {};

window.addEventListener('load', async () => {
    try {
        await esperarSupabase();
        
        // Protección de ruta
        const { data: { session } } = await window.supabaseClient.auth.getSession();
        if (!session) { window.location.href = 'login.html'; return; }

        console.log("🚀 Admin Panel Iniciado");
        initMap();
        cargarZonas();
        initRealtimeFinanzas();
        initRealtimeConductores();
        initRealtimeSOS();
        calcularEstadisticas();
        
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
    if(id === 'zonas') setTimeout(() => map.invalidateSize(), 200);
}

// === MAPA Y ZONAS ===
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

function initRealtimeConductores() {
    window.supabaseClient.channel('admin_flota')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conductores' }, payload => {
            actualizarMarcadorConductor(payload.new);
            calcularEstadisticas();
        }).subscribe();
    cargarPosicionesIniciales();
}

async function cargarPosicionesIniciales() {
    const { data } = await window.supabaseClient.from('conductores').select('*');
    if(data) data.forEach(c => actualizarMarcadorConductor(c));
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

async function guardarZona() {
    const nombre = document.getElementById('zoneName').value;
    const inputPrecio = document.getElementById('zonePrice');
    const precio = inputPrecio ? inputPrecio.value : 20;

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
        document.getElementById('zoneName').value = ""; drawnItems.clearLayers(); currentLayer = null; cargarZonas(); calcularEstadisticas();
    } catch (e) { alert("Error: " + e.message); }
}

async function cargarZonas() {
    const { data } = await window.supabaseClient.from('puntos_view').select('*');
    const list = document.getElementById('zonesList'); list.innerHTML = "";
    map.eachLayer((layer) => { if (layer instanceof L.GeoJSON && !layer.options.icon) map.removeLayer(layer); });

    if (data) {
        data.forEach(zona => {
            list.innerHTML += `<div class="card" style="display:flex; justify-content:space-between; align-items:center; padding:15px;"><div><strong>${zona.nombre}</strong><br><small>Tarifa: L. ${zona.tarifa_base}</small></div><button class="btn btn-danger" onclick="borrarZona('${zona.id}')">🗑️</button></div>`;
            if (zona.area) L.geoJSON(zona.area, { style: { color: "#3b82f6", weight: 2, fillOpacity: 0.15 } }).addTo(map);
        });
    }
}

async function borrarZona(id) {
    if(!confirm("¿Eliminar zona?")) return;
    await window.supabaseClient.from('puntos').delete().eq('id', id);
    cargarZonas();
}

// === FINANZAS (APROBAR / RECHAZAR) ===
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
        const btnFoto = s.comprobante_url 
            ? `<a href="${s.comprobante_url}" target="_blank" style="text-decoration:none; background:#3b82f6; color:white; padding:5px 10px; border-radius:5px; font-size:0.8rem; margin-right:5px">📷 Ver Foto</a>` 
            : `<span style="color:red; font-size:0.8rem; margin-right:10px">Sin foto</span>`;

        list.innerHTML += `
            <div class="card finance-item">
                <div>
                    <h3 style="margin:0">${s.conductores?.perfiles?.nombre || 'Conductor'}</h3>
                    <small style="color:#64748b">Ref: ${s.referencia}</small><br>
                    ${btnFoto} <small>${new Date(s.created_at).toLocaleTimeString()}</small>
                </div>
                <div style="text-align:right">
                    <div class="amount">L. ${s.monto}</div>
                    <div style="margin-top:5px; display:flex; gap:5px">
                        <button class="btn btn-danger" onclick="rechazarRecarga('${s.id}')">rechazar</button>
                        <button class="btn btn-success" onclick="aprobarRecarga('${s.id}', ${s.monto}, '${s.conductor_id}')">Aprobar</button>
                    </div>
                </div>
            </div>`;
    });
}

async function aprobarRecarga(solID, monto, condID) {
    if(!confirm(`¿CONFIRMAR recarga de L. ${monto}?`)) return;
    
    // 1. Marcar aprobada
    await window.supabaseClient.from('solicitudes_recarga').update({ estado: 'aprobada' }).eq('id', solID);
    
    // 2. Sumar saldo
    const { data: c } = await window.supabaseClient.from('conductores').select('saldo_actual').eq('id', condID).single();
    await window.supabaseClient.from('conductores').update({ saldo_actual: (c.saldo_actual || 0) + parseFloat(monto) }).eq('id', condID);
    
    alert("✅ Aprobado y Saldo Acreditado");
    cargarFinanzas();
}

async function rechazarRecarga(solID) {
    if(!confirm("¿Rechazar esta solicitud? El conductor no recibirá saldo.")) return;
    
    await window.supabaseClient.from('solicitudes_recarga').update({ estado: 'rechazada' }).eq('id', solID);
    
    alert("❌ Solicitud Rechazada");
    cargarFinanzas();
}

// === HISTORIAL DE CAJA (NUEVO) ===
async function cargarCaja() {
    const list = document.getElementById('cajaList');
    list.innerHTML = "<tr><td colspan='5'>Cargando...</td></tr>";
    
    const { data } = await window.supabaseClient
        .from('solicitudes_recarga')
        .select('*, conductores(perfiles(nombre))')
        .neq('estado', 'pendiente') // Solo lo procesado
        .order('created_at', { ascending: false })
        .limit(50);

    list.innerHTML = "";
    if(!data || !data.length) return list.innerHTML = "<tr><td colspan='5'>Sin movimientos.</td></tr>";

    data.forEach(m => {
        const color = m.estado === 'aprobada' ? '#166534' : '#991b1b';
        const bg = m.estado === 'aprobada' ? '#dcfce7' : '#fee2e2';
        
        list.innerHTML += `
            <tr style="border-bottom:1px solid #eee">
                <td style="padding:10px">${new Date(m.created_at).toLocaleDateString()}</td>
                <td style="padding:10px">${m.conductores?.perfiles?.nombre || '---'}</td>
                <td style="padding:10px"><small>${m.referencia}</small></td>
                <td style="padding:10px; font-weight:bold">L. ${m.monto}</td>
                <td style="padding:10px"><span style="background:${bg}; color:${color}; padding:3px 8px; border-radius:4px; font-size:0.8rem">${m.estado.toUpperCase()}</span></td>
            </tr>`;
    });
}

// === CONDUCTORES ===
async function cargarConductores() {
    const list = document.getElementById('conductoresList'); list.innerHTML = "Cargando...";
    const { data } = await window.supabaseClient.from('conductores').select('*, perfiles(nombre, telefono, email)');
    
    list.innerHTML = "";
    if(!data) return;
    
    data.forEach(c => {
        const btnAction = c.estado === 'bloqueado' 
            ? `<button class="btn btn-success" onclick="cambiarEstadoConductor('${c.id}', 'inactivo')">Desbloquear</button>`
            : `<button class="btn btn-danger" onclick="cambiarEstadoConductor('${c.id}', 'bloqueado')">Bloquear</button>`;

        list.innerHTML += `<div class="card"><div style="display:flex; justify-content:space-between"><div><strong>${c.perfiles?.nombre || 'Sin Nombre'}</strong><br><small>Tel: ${c.perfiles?.telefono || '--'}</small></div><div style="text-align:right"><div>Saldo: <b>L. ${c.saldo_actual}</b></div>${btnAction}</div></div></div>`;
    });
}

async function cambiarEstadoConductor(id, nuevoEstado) {
    if(!confirm("¿Cambiar estado?")) return;
    await window.supabaseClient.from('conductores').update({ estado: nuevoEstado }).eq('id', id);
    cargarConductores();
}

// === SOS ===
function initRealtimeSOS() {
    window.supabaseClient.channel('admin_sos')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'carreras', filter: 'sos=eq.true' }, payload => {
            mostrarAlertaSOS(payload.new);
        }).subscribe();
}

async function mostrarAlertaSOS(viaje) {
    const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/995/995-preview.mp3');
    audio.loop = true; audio.play().catch(e=>{});

    const { data: c } = await window.supabaseClient.from('conductores').select('perfiles(nombre)').eq('id', viaje.conductor_id).single();
    
    const div = document.createElement('div');
    div.style = "position:fixed; top:0; left:0; right:0; bottom:0; background:red; z-index:9999; display:flex; justify-content:center; align-items:center; color:white; flex-direction:column";
    div.innerHTML = `<h1>🚨 SOS 🚨</h1><p>Conductor: ${c?.perfiles?.nombre}</p><button onclick="location.reload()" style="padding:20px; font-size:2rem">ATENDER</button>`;
    document.body.appendChild(div);
}

async function calcularEstadisticas() {
    const { count: conductores } = await window.supabaseClient.from('conductores').select('*', { count: 'exact', head: true }).eq('estado', 'disponible');
    document.getElementById('statDrivers').textContent = conductores || 0;

    const { count: zonas } = await window.supabaseClient.from('puntos').select('*', { count: 'exact', head: true });
    document.getElementById('statZones').textContent = zonas || 0;

    // Sumar ingresos aprobados del día (o total)
    const { data: recargas } = await window.supabaseClient.from('solicitudes_recarga').select('monto').eq('estado', 'aprobada');
    let total = 0;
    if(recargas) recargas.forEach(r => total += parseFloat(r.monto));
    document.getElementById('statEarnings').textContent = `L. ${total}`;
}