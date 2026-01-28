// === SLIDER FIX - DESLIZAMIENTO PARA ACEPTAR/RECHAZAR ===

(function() {
    'use strict';
    
    console.log("🎯 Slider-fix.js cargado");

    // Esperar a que el DOM esté listo
    window.addEventListener('load', function() {
        initSliders();
    });

    function initSliders() {
        // Slider Aceptar (Verde)
        const sliderAccept = document.getElementById('slideAccept');
        const btnAccept = sliderAccept?.querySelector('.slider-btn');
        
        // Slider Rechazar (Rojo)
        const sliderReject = document.getElementById('slideReject');
        const btnReject = sliderReject?.querySelector('.slider-btn');

        if (btnAccept) {
            setupSlider(btnAccept, sliderAccept, 'left', function() {
                console.log("✅ Viaje aceptado vía slider");
                if (typeof aceptarViaje === 'function') {
                    aceptarViaje();
                }
            });
        }

        if (btnReject) {
            setupSlider(btnReject, sliderReject, 'right', function() {
                console.log("❌ Viaje rechazado vía slider");
                if (typeof rechazarViaje === 'function') {
                    rechazarViaje();
                }
            });
        }
    }

    function setupSlider(btn, container, direction, callback) {
        let isDragging = false;
        let startX = 0;
        let currentX = 0;
        const containerWidth = container.offsetWidth;
        const btnWidth = btn.offsetWidth;
        const maxDistance = containerWidth - btnWidth - 8; // 8px = padding

        // Touch Start
        btn.addEventListener('touchstart', function(e) {
            isDragging = true;
            startX = e.touches[0].clientX;
            btn.style.transition = 'none';
        }, { passive: true });

        // Touch Move
        btn.addEventListener('touchmove', function(e) {
            if (!isDragging) return;
            
            currentX = e.touches[0].clientX - startX;
            
            if (direction === 'left') {
                // Slider Aceptar (deslizar hacia derecha)
                if (currentX < 0) currentX = 0;
                if (currentX > maxDistance) currentX = maxDistance;
                btn.style.left = currentX + 'px';
            } else {
                // Slider Rechazar (deslizar hacia izquierda)
                if (currentX > 0) currentX = 0;
                if (currentX < -maxDistance) currentX = -maxDistance;
                btn.style.right = (-currentX) + 'px';
            }
        }, { passive: true });

        // Touch End
        btn.addEventListener('touchend', function() {
            if (!isDragging) return;
            isDragging = false;
            btn.style.transition = 'all 0.3s ease';

            // Verificar si llegó al final
            const threshold = maxDistance * 0.8; // 80% del recorrido

            if (direction === 'left' && currentX >= threshold) {
                // Aceptar completado
                btn.style.left = maxDistance + 'px';
                setTimeout(callback, 200);
            } else if (direction === 'right' && -currentX >= threshold) {
                // Rechazar completado
                btn.style.right = maxDistance + 'px';
                setTimeout(callback, 200);
            } else {
                // Regresar a posición inicial
                if (direction === 'left') {
                    btn.style.left = '4px';
                } else {
                    btn.style.right = '4px';
                }
            }

            currentX = 0;
        }, { passive: true });

        // Mouse Events (para testing en desktop)
        btn.addEventListener('mousedown', function(e) {
            isDragging = true;
            startX = e.clientX;
            btn.style.transition = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', function(e) {
            if (!isDragging) return;
            
            currentX = e.clientX - startX;
            
            if (direction === 'left') {
                if (currentX < 0) currentX = 0;
                if (currentX > maxDistance) currentX = maxDistance;
                btn.style.left = currentX + 'px';
            } else {
                if (currentX > 0) currentX = 0;
                if (currentX < -maxDistance) currentX = -maxDistance;
                btn.style.right = (-currentX) + 'px';
            }
        });

        document.addEventListener('mouseup', function() {
            if (!isDragging) return;
            isDragging = false;
            btn.style.transition = 'all 0.3s ease';

            const threshold = maxDistance * 0.8;

            if (direction === 'left' && currentX >= threshold) {
                btn.style.left = maxDistance + 'px';
                setTimeout(callback, 200);
            } else if (direction === 'right' && -currentX >= threshold) {
                btn.style.right = maxDistance + 'px';
                setTimeout(callback, 200);
            } else {
                if (direction === 'left') {
                    btn.style.left = '4px';
                } else {
                    btn.style.right = '4px';
                }
            }

            currentX = 0;
        });
    }

    // Reiniciar sliders cuando se abre el modal
    const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            const modalTrip = document.getElementById('modalTrip');
            if (modalTrip && modalTrip.style.display === 'flex') {
                setTimeout(initSliders, 100);
            }
        });
    });

    // Observar cambios en el modal
    const modalTrip = document.getElementById('modalTrip');
    if (modalTrip) {
        observer.observe(modalTrip, {
            attributes: true,
            attributeFilter: ['style']
        });
    }

})();

console.log("✅ Slider-fix.js inicializado correctamente");