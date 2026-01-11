let map, userCoords, destCoords, activeTripId, userMarker, destMarker;
let zonaActual = null; 
let currentRating = 0;
let chatSubscription; 
let driversLayer = L.layerGroup(); 
let driverMarkers = {};

window.addEventListener('load', async () => {
    try {
        await esperarSupabase();
        const { data: { session } } = await window.supabaseClient.auth.getSession();
        if (!session) return window.location.href = 'login.html';
        
        // Verificar/crear cliente de manera segura
        let { data: cli, error: cliError } = await window.supabaseClient
            .from('clientes')
            .select('id')
            .eq('perfil_id', session.user.id)
            .maybeSingle();
        
        if (!cli) {
            console.log("Creando registro de cliente...");
            const { data: nuevoCli, error: insertError } = await window.supabaseClient
                .from('clientes')
                .insert({ perfil_id: session.user.id })
                .select('id')
                .single();
            
            if (insertError) {
                console.error("Error al crear cliente:", insertError);
            }
        }
        
        initMap(); 
        checkViajeActivo(session.user.id);
    } catch (e) { 
        console.error("Error en inicialización:", e); 
    }
});

async function esperarSupabase() { 
    return new Promise(r => { 
        const i = setInterval(() => { 
            if (window.supabaseClient) { 
                clearInterval(i); 
                r(); 
            } 
        }, 100); 
    }); 
}

function initMap() {
    map = L.map('map', { zoomControl: false }).setView([15.5, -88.0], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    driversLayer.addTo(map);
    initRadar();

    setTimeout(() => map.invalidateSize(), 500);
    
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            map.setView([userCoords.lat, userCoords.lng], 16);
            const userIcon = L.divIcon({ className: 'marker-pin marker-user', iconSize: [30, 30], iconAnchor: [15, 30] });
            userMarker = L.marker(userCoords, { icon: userIcon }).addTo(map);
        }, (error) => {
            console.error("Error al obtener ubicación:", error);
            alert("⚠️ No se pudo obtener tu ubicación. Por favor habilita el GPS.");
        });
    }
    
    map.on('click', async (e) => {
        if (activeTripId) return;
        
        destCoords = { lat: e.latlng.lat, lng: e.latlng.lng };
        
        if (destMarker) map.removeLayer(destMarker);
        const destIcon = L.divIcon({ className: 'marker-pin marker-dest', iconSize: [30, 30], iconAnchor: [15, 30] });
        destMarker = L.marker(destCoords, { icon: destIcon }).addTo(map);
        
        if(userCoords) map.fitBounds([userCoords, destCoords], { padding: [50, 50] });

        document.getElementById('destInput').value = "Calculando...";
        
        try {
            const { data: zona, error: zonaError } = await window.supabaseClient.rpc('identificar_zona', { 
                lat: destCoords.lat, 
                lng: destCoords.lng 
            });
            
            if (zonaError) {
                console.error("Error al identificar zona:", zonaError);
            }
            
            document.getElementById('quotePanel').classList.remove('hidden');
            const btn = document.getElementById('btnPedir');
            const inputPrecio = document.getElementById('inputPrecio');
            const lblMinPrice = document.getElementById('zoneMinPrice');

            if (zona) { 
                zonaActual = zona; 
                document.getElementById('destInput').value = `📍 ${zona.nombre}`; 
                
                lblMinPrice.textContent = `L. ${zona.tarifa_base}`;
                inputPrecio.value = zona.tarifa_base; 
                inputPrecio.min = zona.tarifa_base;   

                btn.disabled = false; 
                btn.textContent = "CONFIRMAR MOTO"; 
            } else { 
                zonaActual = null; 
                document.getElementById('destInput').value = "❌ Fuera de cobertura"; 
                inputPrecio.value = ""; 
                lblMinPrice.textContent = "--";
                btn.disabled = true; 
                btn.textContent = "NO DISPONIBLE"; 
            }
        } catch (e) {
            console.error("Error procesando zona:", e);
            alert("Error al verificar la zona. Intenta de nuevo.");
        }
    });
}

// === RADAR ===
function initRadar() {
    window.supabaseClient.from('conductores')
        .select('id, latitud, longitud, estado')
        .eq('estado', 'disponible')
        .then(({ data }) => { 
            if(data) data.forEach(c => actualizarMarcadorMoto(c)); 
        });
    
    window.supabaseClient.channel('radar_clientes')
        .on('postgres_changes', { 
            event: 'UPDATE', 
            schema: 'public', 
            table: 'conductores' 
        }, payload => {
            const c = payload.new;
            if (c.estado === 'disponible') {
                actualizarMarcadorMoto(c);
            } else {
                eliminarMarcadorMoto(c.id);
            }
        }).subscribe();
}

function actualizarMarcadorMoto(c) {
    if (!c.latitud || !c.longitud) return;
    const motoIcon = L.divIcon({ 
        html: `🏍️`, 
        className: 'moto-icon', 
        iconSize: [24, 24], 
        iconAnchor: [12, 12] 
    });
    
    if (driverMarkers[c.id]) {
        driverMarkers[c.id].setLatLng([c.latitud, c.longitud]);
    } else { 
        const m = L.marker([c.latitud, c.longitud], { icon: motoIcon }).addTo(driversLayer); 
        driverMarkers[c.id] = m; 
    }
}

function eliminarMarcadorMoto(id) { 
    if (driverMarkers[id]) { 
        driversLayer.removeLayer(driverMarkers[id]); 
        delete driverMarkers[id]; 
    } 
}

// === LOGICA VIAJE Y ETA ===
async function pedirViaje() {
    if (!zonaActual) {
        alert("⚠️ Por favor selecciona un destino válido dentro de la zona de cobertura.");
        return;
    }
    
    if (!userCoords || !destCoords) {
        alert("⚠️ No se pudo obtener tu ubicación o destino. Intenta de nuevo.");
        return;
    }
    
    // VALIDACIÓN DE PRECIO
    const oferta = parseFloat(document.getElementById('inputPrecio').value);
    const notas = document.getElementById('inputNotas').value || "";

    if (!oferta || oferta < zonaActual.tarifa_base) {
        return alert(`La tarifa mínima para esta zona es L. ${zonaActual.tarifa_base}`);
    }

    try {
        const { data: { session } } = await window.supabaseClient.auth.getSession();
        
        if (!session || !session.user) {
            alert("⚠️ Sesión no válida. Por favor inicia sesión nuevamente.");
            window.location.href = 'login.html';
            return;
        }

        // Verificar/crear cliente con maybeSingle
        let { data: cliente, error: clienteError } = await window.supabaseClient
            .from('clientes')
            .select('id')
            .eq('perfil_id', session.user.id)
            .maybeSingle();
        
        // Si no existe el cliente, crearlo
        if (!cliente) {
            console.log("Cliente no existe, creándolo...");
            const { data: nuevoCliente, error: insertError } = await window.supabaseClient
                .from('clientes')
                .insert({ perfil_id: session.user.id })
                .select('id')
                .single();
            
            if (insertError) {
                console.error("Error al crear cliente:", insertError);
                throw insertError;
            }
            
            cliente = nuevoCliente;
        }

        if (!cliente || !cliente.id) {
            throw new Error("No se pudo obtener o crear el registro de cliente");
        }
        
        document.getElementById('btnPedir').textContent = "Procesando...";
        document.getElementById('btnPedir').disabled = true;

        const { data, error } = await window.supabaseClient.from('carreras').insert({ 
            cliente_id: cliente.id, 
            origen_lat: parseFloat(userCoords.lat), 
            origen_lng: parseFloat(userCoords.lng), 
            destino_lat: parseFloat(destCoords.lat), 
            destino_lng: parseFloat(destCoords.lng), 
            precio: parseFloat(oferta), 
            notas: notas,
            estado: 'buscando' 
        }).select().single();

        if (error) {
            console.error("Error al insertar carrera:", error);
            throw error;
        }
        
        if (!data || !data.id) {
            throw new Error("No se recibió confirmación del viaje");
        }

        console.log("✅ Viaje creado exitosamente:", data);
        activeTripId = data.id;
        mostrarPantalla('step2');
        escucharViaje(activeTripId);
        initChat(activeTripId);

    } catch (e) {
        console.error("Error en pedirViaje:", e);
        alert("Error al solicitar viaje: " + (e.message || "Error desconocido"));
        document.getElementById('btnPedir').textContent = "CONFIRMAR MOTO";
        document.getElementById('btnPedir').disabled = false;
    }
}

// === ESCUCHAR CAMBIOS EN EL VIAJE ===
function escucharViaje(id) {
    window.supabaseClient.channel('viaje_' + id)
        .on('postgres_changes', { 
            event: 'UPDATE', 
            schema: 'public', 
            table: 'carreras', 
            filter: `id=eq.${id}` 
        }, payload => {
            const viaje = payload.new;
            
            if (viaje.estado === 'aceptada' || viaje.estado === 'en_curso') {
                mostrarPantalla('step3');
                actualizarInfoViaje(viaje);
                if(viaje.conductor_id) mostrarDatosConductor(viaje.conductor_id);
            } 
            else if (viaje.estado === 'completada') {
                mostrarPantalla('step4');
            }
            else if (viaje.estado === 'cancelada') {
                alert("⚠️ El viaje ha sido cancelado.");
                location.reload();
            }
        }).subscribe();
}

function actualizarInfoViaje(viaje) {
    const titulo = document.getElementById('lblMainTitle');
    const badge = document.getElementById('badgeStatus');
    const etaLabel = document.getElementById('lblETA');

    if (viaje.estado === 'aceptada') {
        titulo.textContent = "Conductor en camino";
        badge.textContent = "● ESPERANDO";
        badge.style.background = "#fef3c7"; 
        badge.style.color = "#d97706";
        etaLabel.textContent = "El conductor va a recogerte";
    } 
    else if (viaje.estado === 'en_curso') {
        titulo.textContent = "Rumbo a tu destino";
        badge.textContent = "● EN VIAJE";
        badge.style.background = "#dcfce7"; 
        badge.style.color = "#166534";
        
        const distMetros = map.distance(
            [viaje.origen_lat, viaje.origen_lng], 
            [viaje.destino_lat, viaje.destino_lng]
        );
        const velocidadMotos = 400; 
        const minutosRestantes = Math.ceil(distMetros / velocidadMotos);
        const ahora = new Date();
        ahora.setMinutes(ahora.getMinutes() + minutosRestantes);
        const horaLlegada = ahora.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        etaLabel.textContent = `Llegada: ${horaLlegada} (${minutosRestantes} min)`;
    }
}

async function checkViajeActivo(userId) {
    try {
        const { data: cli } = await window.supabaseClient
            .from('clientes')
            .select('id')
            .eq('perfil_id', userId)
            .maybeSingle();
        
        if(!cli) return;
        
        const { data: viaje } = await window.supabaseClient
            .from('carreras')
            .select('*')
            .eq('cliente_id', cli.id)
            .in('estado', ['buscando', 'aceptada', 'en_curso'])
            .maybeSingle();
        
        if (viaje) {
            activeTripId = viaje.id;
            
            if(viaje.origen_lat && viaje.destino_lat) {
                userCoords = { lat: viaje.origen_lat, lng: viaje.origen_lng };
                destCoords = { lat: viaje.destino_lat, lng: viaje.destino_lng };
            }
            
            escucharViaje(viaje.id); 
            initChat(viaje.id);
            
            if(viaje.conductor_id) mostrarDatosConductor(viaje.conductor_id);
            
            mostrarPantalla(viaje.estado === 'buscando' ? 'step2' : 'step3');
            
            if(viaje.estado !== 'buscando') actualizarInfoViaje(viaje);
        }
    } catch (e) {
        console.error("Error verificando viaje activo:", e);
    }
}

async function mostrarDatosConductor(id) {
    try {
        const { data: c } = await window.supabaseClient
            .from('conductores')
            .select('modelo_moto, placa, perfiles(nombre)')
            .eq('id', id)
            .single();
        
        if(c) {
            document.getElementById('lblDriverName').textContent = c.perfiles?.nombre || "Conductor";
            document.getElementById('lblDriverMoto').textContent = c.modelo_moto || "Moto";
            document.getElementById('lblDriverPlate').textContent = c.placa || "---";
        }
    } catch (e) {
        console.error("Error obteniendo datos del conductor:", e);
    }
}

function mostrarPantalla(stepId) { 
    ['step1', 'step2', 'step3', 'step4'].forEach(id => 
        document.getElementById(id).classList.add('hidden')
    ); 
    document.getElementById(stepId).classList.remove('hidden'); 
}

async function cancelar() { 
    if(!confirm("¿Cancelar?")) return; 
    
    try {
        await window.supabaseClient
            .from('carreras')
            .update({ estado: 'cancelada' })
            .eq('id', activeTripId); 
        
        location.reload(); 
    } catch (e) {
        console.error("Error al cancelar:", e);
        alert("Error al cancelar el viaje");
    }
}

function rate(n) { 
    currentRating = n; 
    document.querySelectorAll('.stars span').forEach((s, i) => 
        s.classList.toggle('active', i < n)
    ); 
}

async function enviarCalificacion() { 
    if(!currentRating) return alert("Elige estrellas"); 
    
    try {
        await window.supabaseClient
            .from('carreras')
            .update({ calificacion_conductor: currentRating })
            .eq('id', activeTripId); 
        
        alert("¡Gracias!"); 
        location.reload(); 
    } catch (e) {
        console.error("Error al enviar calificación:", e);
        alert("Error al enviar calificación");
    }
}

async function activarSOS() { 
    if(!confirm("⚠️ ¿EMERGENCIA?")) return; 
    
    try {
        await window.supabaseClient
            .from('carreras')
            .update({ sos: true })
            .eq('id', activeTripId); 
        
        alert("🚨 ALERTA ENVIADA 🚨"); 
    } catch (e) {
        console.error("Error al activar SOS:", e);
        alert("Error al activar SOS");
    }
}

// === CHAT ===
function initChat(carreraId) {
    const chatBody = document.getElementById('chatBody'); 
    chatBody.innerHTML = '<div style="text-align:center; color:#94a3b8; font-size:0.8rem; margin-top:10px">Chat seguro</div>';
    
    window.supabaseClient
        .from('mensajes')
        .select('*')
        .eq('carrera_id', carreraId)
        .order('created_at', { ascending: true })
        .then(({ data }) => { 
            if(data) data.forEach(m => pintarMensaje(m)); 
        });
    
    if (chatSubscription) window.supabaseClient.removeChannel(chatSubscription);
    
    chatSubscription = window.supabaseClient.channel('chat_' + carreraId)
        .on('postgres_changes', { 
            event: 'INSERT', 
            schema: 'public', 
            table: 'mensajes', 
            filter: `carrera_id=eq.${carreraId}` 
        }, payload => {
            pintarMensaje(payload.new);
            
            if (payload.new.remitente_rol === 'conductor' && 
                document.getElementById('chatModal').style.display === 'none') { 
                document.getElementById('badgeChat').style.display = 'inline-block'; 
            }
        }).subscribe();
}

function pintarMensaje(msg) { 
    const div = document.createElement('div'); 
    const esMio = msg.remitente_rol === 'cliente'; 
    div.className = `bubble ${esMio ? 'bubble-me' : 'bubble-other'}`; 
    div.textContent = msg.texto; 
    document.getElementById('chatBody').appendChild(div); 
    document.getElementById('chatBody').scrollTop = 9999; 
}

async function enviarMensaje() { 
    const i = document.getElementById('chatInput'); 
    const t = i.value.trim(); 
    
    if (!t || !activeTripId) return; 
    
    i.value = ""; 
    
    try {
        await window.supabaseClient
            .from('mensajes')
            .insert({ 
                carrera_id: activeTripId, 
                remitente_rol: 'cliente', 
                texto: t 
            }); 
    } catch (e) {
        console.error("Error al enviar mensaje:", e);
    }
}

function abrirChat() { 
    document.getElementById('chatModal').style.display = 'flex'; 
    document.getElementById('badgeChat').style.display = 'none'; 
} 

function cerrarChat() { 
    document.getElementById('chatModal').style.display = 'none'; 
}

// === OTROS MODALES ===
async function abrirHistorial() { 
    document.getElementById('historyPanel').style.display = 'flex'; 
    document.getElementById('historyList').innerHTML = "Cargando..."; 
    
    try {
        const { data: { session } } = await window.supabaseClient.auth.getSession(); 
        const { data: cli } = await window.supabaseClient
            .from('clientes')
            .select('id')
            .eq('perfil_id', session.user.id)
            .single(); 
        
        const { data } = await window.supabaseClient
            .from('carreras')
            .select('*, conductores(perfiles(nombre))')
            .eq('cliente_id', cli.id)
            .neq('estado', 'buscando')
            .order('fecha_solicitud', { ascending: false })
            .limit(20); 
        
        const list = document.getElementById('historyList'); 
        list.innerHTML = ""; 
        
        if (!data || !data.length) {
            return list.innerHTML = "<p>Sin viajes.</p>";
        }
        
        data.forEach(v => { 
            const badge = v.estado==='completada'?'badge-done':'badge-cancel'; 
            list.innerHTML += `<div class="history-card">
                <div style="display:flex; justify-content:space-between">
                    <small>${new Date(v.fecha_solicitud).toLocaleDateString()}</small> 
                    <span style="color:#2563eb; font-weight:bold">L. ${v.precio}</span>
                </div>
                <div>Cond: ${v.conductores?.perfiles?.nombre || '--'}</div>
                <span class="badge ${badge}">${v.estado}</span>
            </div>`; 
        });
    } catch (e) {
        console.error("Error cargando historial:", e);
        document.getElementById('historyList').innerHTML = "<p>Error al cargar historial</p>";
    }
}

async function abrirPerfil() { 
    document.getElementById('profilePanel').style.display = 'flex'; 
    
    try {
        const { data: { session } } = await window.supabaseClient.auth.getSession(); 
        const { data: p } = await window.supabaseClient
            .from('perfiles')
            .select('*')
            .eq('id', session.user.id)
            .single(); 
        
        document.getElementById('pName').value = p.nombre; 
        document.getElementById('pPhone').value = p.telefono; 
        document.getElementById('pEmail').value = p.email; 
    } catch (e) {
        console.error("Error cargando perfil:", e);
    }
}

async function guardarPerfil() { 
    const n = document.getElementById('pName').value; 
    const ph = document.getElementById('pPhone').value; 
    
    try {
        const { data: { session } } = await window.supabaseClient.auth.getSession(); 
        await window.supabaseClient
            .from('perfiles')
            .update({ nombre: n, telefono: ph })
            .eq('id', session.user.id); 
        
        alert("Perfil Actualizado"); 
        document.getElementById('profilePanel').style.display='none'; 
    } catch (e) {
        console.error("Error guardando perfil:", e);
        alert("Error al guardar perfil");
    }
}

async function cerrarSesion() { 
    if(confirm("¿Cerrar Sesión?")) { 
        await window.supabaseClient.auth.signOut(); 
        window.location.href = 'login.html'; 
    } 
}

// Estilos para calificación
document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `
        .stars span { cursor: pointer; color: #e2e8f0; }
        .stars span.active { color: #fbbf24; }
    `;
    document.head.appendChild(style);
});