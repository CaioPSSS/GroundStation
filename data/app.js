/* =============================================================================
GROUND CONTROL STATION - AVIONICS GRADE JAVASCRIPT APPLICATION
============================================================================= */

class GroundControlStation {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.map = null;
        this.aircraftMarker = null;
        this.aircraftPath = [];
        this.pathPolyline = null;
        this.waypoints = [];
        this.homePosition = null;
        this.telemetryData = {};
        this.connectionStatus = {
            usb: false,
            gamepad: false,
            lora: false
        };
        
        // NEW: Industrial-grade features
        this.flightLog = []; // Telemetry Logger array
        this.lastFlightMode = null; // For speech detection
        this.heartbeatInterval = null; // Heartbeat timer
        this.batteryAlertTriggered = false; // Prevent duplicate battery alerts
        
        this.init();
    }

    // =============================================================================
    // INITIALIZATION
    // =============================================================================
    
    init() {
        this.initializeMap();
        this.initializeEventListeners();
        this.initializePFD();
        this.initializeControlLayout();
        this.initializeDataManagement(); // NEW: CSV Logger
        this.initializeSpeechSynthesis(); // NEW: Acoustic Situational Awareness
        this.startHeartbeat(); // NEW: GCS Failsafe
        this.startSystemClock();
        this.addAlert('System initialized - Click "CONNECT GCS (USB)" to connect', 'info');
    }

    // =============================================================================
    // WEB SERIAL API COMMUNICATION
    // =============================================================================
    
    async connectUSB() {
        try {
            // Request port from user
            this.port = await navigator.serial.requestPort();
            
            // Open port with high baud rate
            await this.port.open({ baudRate: 115200 });
            
            // Setup text decoder for line-by-line reading
            const textDecoder = new TextDecoderStream();
            const readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
            this.reader = textDecoder.readable.getReader();
            
            // Setup text encoder for writing
            const textEncoder = new TextEncoderStream();
            const writableStreamClosed = textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();
            
            // Update connection status
            this.connectionStatus.usb = true;
            this.updateConnectionStatus('usb-status', true);
            this.addAlert('USB connected successfully', 'success');
            
            // Start reading telemetry
            this.readTelemetry();
            
        } catch (error) {
            console.error('Failed to connect USB:', error);
            this.addAlert('Failed to connect USB: ' + error.message, 'danger');
        }
    }
    
    async disconnectUSB() {
        try {
            if (this.reader) {
                await this.reader.cancel();
                await this.reader.releaseLock();
            }
            if (this.writer) {
                await this.writer.releaseLock();
            }
            if (this.port) {
                await this.port.close();
            }
            
            this.port = null;
            this.reader = null;
            this.writer = null;
            
            this.connectionStatus.usb = false;
            this.updateConnectionStatus('usb-status', false);
            this.addAlert('USB disconnected', 'warning');
            
        } catch (error) {
            console.error('Error disconnecting USB:', error);
        }
    }
    
    async readTelemetry() {
        let buffer = '';
        
        try {
            while (true) {
                const { value, done } = await this.reader.read();
                if (done) break;
                
                buffer += value;
                
                // Process complete lines
                let lines = buffer.split('\n');
                buffer = lines.pop(); // Keep incomplete line in buffer
                
                for (const line of lines) {
                    if (line.trim()) {
                        this.handleTelemetryLine(line.trim());
                    }
                }
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === 'NetworkError') {
                this.addAlert('USB connection lost', 'danger');
                this.connectionStatus.usb = false;
                this.updateConnectionStatus('usb-status', false);
            } else {
                console.error('Error reading telemetry:', error);
            }
        }
    }
    
    handleTelemetryLine(line) {
        try {
            const data = JSON.parse(line);
            
            switch (data.type) {
                case 'telemetry':
                    this.updateTelemetry(data);
                    this.logTelemetry(data); // NEW: Log telemetry for CSV export
                    break;
                default:
                    console.log('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Failed to parse telemetry line:', error, line);
        }
    }
    
    async sendSerialCommand(data) {
        if (this.writer) {
            try {
                await this.writer.write(JSON.stringify(data) + '\n');
                return true;
            } catch (error) {
                console.error('Failed to send serial command:', error);
                this.addAlert('Failed to send command', 'danger');
            }
        }
        return false;
    }

    // =============================================================================
    // TELEMETRY PROCESSING
    // =============================================================================
    
    updateTelemetry(data) {
        this.telemetryData = data;
        
        // Update PFD
        this.updatePFD(data.roll_deg, data.pitch_deg, data.heading_deg);
        
        // Update HUD
        this.updateHUD(data);
        
        // Update flight status
        this.updateFlightStatus(data.fsm_state);

        if (data.hasOwnProperty('arm_status')) {
        const armBtn = document.getElementById('btn-arm'); // Certifique-se que o ID do botão é este
        if (armBtn) {
            if (data.arm_status) {
                armBtn.innerText = "MOTOR ARMADO";
                armBtn.classList.add('active'); // Adicione um estilo vermelho/alerta no CSS
                armBtn.style.backgroundColor = "#ff4444";
            } else {
                armBtn.innerText = "MOTOR DESARMADO";
                armBtn.classList.remove('active');
                armBtn.style.backgroundColor = "#444444";
            }
        }
    }
        
        // Update battery
        this.updateBattery(data.battery_v);
        
        // Update signal strength
        this.updateSignalStrength(data.system);
        
        // Update gamepad status
        this.updateGamepadStatus(data.gamepad);
        
        // Update aircraft position on map
        if (data.latitude && data.longitude) {
            this.updateAircraftPosition(data.latitude, data.longitude, data.heading_deg);
        }
        
        // Update ping
        this.updatePing();
    }

    // =============================================================================
    // MAP FUNCTIONALITY
    // =============================================================================
    
    initializeMap() {
        // Initialize map centered on default position
        this.map = L.map('mission-map').setView([38.7369, -9.1427], 13);
        
        // Add dark tile layer
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap contributors © CARTO',
            subdomains: 'abcd',
            maxZoom: 19
        }).addTo(this.map);
        
        // Set home position on first click
        this.map.on('click', (e) => {
            if (document.getElementById('waypoint-mode').checked) {
                this.addWaypoint(e.latlng.lat, e.latlng.lng);
            } else if (!this.homePosition) {
                this.setHomePosition(e.latlng.lat, e.latlng.lng);
            }
        });
        
        // Initialize aircraft marker
        this.aircraftMarker = L.divIcon({
            html: '<div style="transform: rotate(0deg);">✈️</div>',
            iconSize: [30, 30],
            className: 'aircraft-icon'
        });
    }

    setHomePosition(lat, lon) {
        this.homePosition = { lat, lon };
        
        L.marker([lat, lon], {
            icon: L.divIcon({
                html: '🏠',
                iconSize: [25, 25],
                className: 'home-icon'
            })
        }).addTo(this.map)
        .bindPopup('Home Position')
        .openPopup();
        
        this.addAlert('Home position set', 'success');
    }

    updateAircraftPosition(lat, lon, heading) {
        if (!this.aircraftMarker) {
            const marker = L.marker([lat, lon], {
                icon: L.divIcon({
                    html: '<div style="transform: rotate(0deg); font-size: 20px;">✈️</div>',
                    iconSize: [30, 30],
                    className: 'aircraft-icon'
                })
            }).addTo(this.map);
            
            this.aircraftMarker = marker;
        }
        
        // Update marker position and rotation
        this.aircraftMarker.setLatLng([lat, lon]);
        const iconElement = this.aircraftMarker.getElement();
        if (iconElement) {
            iconElement.querySelector('div').style.transform = `rotate(${heading}deg)`;
        }
        
        // Add to path
        this.aircraftPath.push([lat, lon]);
        
        // Update or create path polyline
        if (this.pathPolyline) {
            this.pathPolyline.setLatLngs(this.aircraftPath);
        } else {
            this.pathPolyline = L.polyline(this.aircraftPath, {
                color: '#00ff88',
                weight: 3,
                opacity: 0.8,
                dashArray: '10, 5'
            }).addTo(this.map);
        }
        
        // Update map view to follow aircraft
        if (this.aircraftPath.length > 0) {
            this.map.setView([lat, lon], this.map.getZoom());
        }
    }

    addWaypoint(lat, lon) {
        const waypointIndex = this.waypoints.length;
        const waypoint = {
            index: waypointIndex,
            lat: lat.toFixed(6),
            lon: lon.toFixed(6),
            alt: 100, // Default altitude
            speed: 10  // Default speed
        };
        
        this.waypoints.push(waypoint);
        
        // Add marker to map
        const marker = L.marker([lat, lon], {
            icon: L.divIcon({
                html: `<div style="background: #00ff88; color: #000; border-radius: 50%; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px;">${waypointIndex + 1}</div>`,
                iconSize: [20, 20],
                className: 'waypoint-icon'
            })
        }).addTo(this.map)
        .bindPopup(`Waypoint ${waypointIndex + 1}`);
        
        waypoint.marker = marker;
        
        this.updateWaypointList();
        this.addAlert(`Waypoint ${waypointIndex + 1} added`, 'info');
    }

    updateWaypointList() {
        const container = document.getElementById('waypoint-items');
        container.innerHTML = '';
        
        this.waypoints.forEach((wp, index) => {
            const item = document.createElement('div');
            item.className = 'waypoint-item';
            item.innerHTML = `
                <span>${wp.index + 1}</span>
                <span>${wp.lat}</span>
                <span>${wp.lon}</span>
                <input type="number" value="${wp.alt}" min="0" max="1000" step="10" data-index="${index}" data-field="alt">
                <input type="number" value="${wp.speed}" min="1" max="50" step="1" data-index="${index}" data-field="speed">
                <button class="btn btn-small btn-danger" onclick="gcs.removeWaypoint(${index})">DEL</button>
            `;
            container.appendChild(item);
        });
        
        // Add event listeners for inputs
        container.querySelectorAll('input').forEach(input => {
            input.addEventListener('change', (e) => {
                const index = parseInt(e.target.dataset.index);
                const field = e.target.dataset.field;
                const value = parseFloat(e.target.value);
                this.waypoints[index][field] = value;
            });
        });
    }

    removeWaypoint(index) {
        const waypoint = this.waypoints[index];
        if (waypoint.marker) {
            this.map.removeLayer(waypoint.marker);
        }
        
        this.waypoints.splice(index, 1);
        
        // Reindex remaining waypoints
        this.waypoints.forEach((wp, i) => {
            wp.index = i;
            if (wp.marker) {
                wp.marker.setPopupContent(`Waypoint ${i + 1}`);
                const iconElement = wp.marker.getElement();
                if (iconElement) {
                    iconElement.querySelector('div').textContent = i + 1;
                }
            }
        });
        
        this.updateWaypointList();
        this.addAlert(`Waypoint ${index + 1} removed`, 'info');
    }

    uploadMission() {
        if (this.waypoints.length === 0) {
            this.addAlert('No waypoints to upload', 'warning');
            return;
        }
        
        const missionData = {
            type: 'waypoints',
            waypoints: this.waypoints
        };
        
        if (this.sendSerialCommand(missionData)) {
            this.addAlert(`Mission uploaded: ${this.waypoints.length} waypoints`, 'success');
        } else {
            this.addAlert('Failed to upload mission - USB not connected', 'danger');
        }
    }

    clearMission() {
        // Remove all waypoint markers
        this.waypoints.forEach(wp => {
            if (wp.marker) {
                this.map.removeLayer(wp.marker);
            }
        });
        
        this.waypoints = [];
        this.updateWaypointList();
        this.addAlert('Mission cleared', 'info');
    }

    // =============================================================================
    // PRIMARY FLIGHT DISPLAY (PFD)
    // =============================================================================
    
    initializePFD() {
        this.canvas = document.getElementById('artificial-horizon');
        this.ctx = this.canvas.getContext('2d');
        this.pfdData = {
            roll: 0,
            pitch: 0,
            heading: 0
        };
        
        // Start PFD animation loop
        this.animatePFD();
    }

    updatePFD(roll, pitch, heading) {
        this.pfdData.roll = roll || 0;
        this.pfdData.pitch = pitch || 0;
        this.pfdData.heading = heading || 0;
        
        // Update heading display
        document.getElementById('heading-value').textContent = `${Math.round(heading)}°`;
    }

    animatePFD() {
        this.drawArtificialHorizon();
        requestAnimationFrame(() => this.animatePFD());
    }

    drawArtificialHorizon() {
        const canvas = this.canvas;
        const ctx = this.ctx;
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        
        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Save context
        ctx.save();
        
        // Apply roll rotation
        ctx.translate(centerX, centerY);
        ctx.rotate(this.pfdData.roll * Math.PI / 180);
        
        // Draw sky (blue)
        ctx.fillStyle = '#001a33';
        ctx.fillRect(-canvas.width, -canvas.height, canvas.width * 2, canvas.height * 2);
        
        // Draw ground (brown)
        const horizonY = this.pfdData.pitch * 2; // Scale pitch for visibility
        ctx.fillStyle = '#4a3c28';
        ctx.fillRect(-canvas.width, horizonY, canvas.width * 2, canvas.height * 2);
        
        // Draw horizon line
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-canvas.width, horizonY);
        ctx.lineTo(canvas.width, horizonY);
        ctx.stroke();
        
        // Draw pitch ladder
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 1;
        ctx.fillStyle = '#00ff88';
        ctx.font = '12px Orbitron';
        ctx.textAlign = 'center';
        
        for (let pitch = -30; pitch <= 30; pitch += 10) {
            if (pitch === 0) continue; // Skip horizon line
            
            const y = horizonY + (pitch * 2);
            
            // Draw pitch line
            ctx.beginPath();
            ctx.moveTo(-50, y);
            ctx.lineTo(50, y);
            ctx.stroke();
            
            // Draw pitch value
            if (pitch % 20 === 0) {
                ctx.fillText(`${Math.abs(pitch)}°`, 70, y + 4);
            }
        }
        
        // Restore context
        ctx.restore();
        
        // Draw aircraft reference symbol (fixed)
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(centerX - 30, centerY);
        ctx.lineTo(centerX + 30, centerY);
        ctx.moveTo(centerX, centerY - 20);
        ctx.lineTo(centerX, centerY + 20);
        ctx.stroke();
        
        // Draw roll indicator
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(centerX, centerY, 80, -Math.PI / 6, Math.PI / 6);
        ctx.stroke();
        
        // Draw roll pointer
        const rollPointerX = centerX + Math.sin(this.pfdData.roll * Math.PI / 180) * 80;
        const rollPointerY = centerY - Math.cos(this.pfdData.roll * Math.PI / 180) * 80;
        ctx.fillStyle = '#ff3366';
        ctx.beginPath();
        ctx.arc(rollPointerX, rollPointerY, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    // =============================================================================
    // HUD TELEMETRY DISPLAY
    // =============================================================================
    
    updateHUD(data) {
        // Calculate derived values from REAL telemetry data
        const altitude = data.altitude_m || 0;
        const speed = data.ground_speed_ms || 0; // DADO REAL do VANT
        const distance = this.calculateDistanceFromHome(data.latitude, data.longitude);
        const vspeed = this.calculateVerticalSpeed(data); // Mantém cálculo derivado
        
        // Update HUD displays
        document.getElementById('hud-altitude').textContent = `${altitude.toFixed(1)}m`;
        document.getElementById('hud-speed').textContent = `${speed.toFixed(1)}m/s`;
        document.getElementById('hud-distance').textContent = `${Math.round(distance)}m`;
        document.getElementById('hud-vspeed').textContent = `${vspeed.toFixed(1)}m/s`;
        document.getElementById('hud-latitude').textContent = (data.latitude || 0).toFixed(6);
        document.getElementById('hud-longitude').textContent = (data.longitude || 0).toFixed(6);
        
        // Update PFD overlay values
        document.getElementById('airspeed').textContent = speed.toFixed(1);
        document.getElementById('altitude').textContent = altitude.toFixed(1);
    }

    calculateGroundSpeed(data) {
        // REMOVIDO: Dados falsos com Math.random()
        // USA: ground_speed_ms real vindo do VANT via LoRa
        return data.ground_speed_ms || 0;
    }

    calculateDistanceFromHome(lat, lon) {
        if (!this.homePosition || !lat || !lon) return 0;
        
        const R = 6371000; // Earth's radius in meters
        const dLat = (lat - this.homePosition.lat) * Math.PI / 180;
        const dLon = (lon - this.homePosition.lon) * Math.PI / 180;
        
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(this.homePosition.lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }

    calculateVerticalSpeed(data) {
        // Placeholder for vertical speed calculation
        return (Math.random() - 0.5) * 4; // -2 to +2 m/s
    }

    // =============================================================================
    // FLIGHT STATUS
    // =============================================================================
    
    updateFlightStatus(fsmState) {
        const modeNames = ['MANUAL', 'ANGLE', 'HOLD', 'AUTO', 'RTH'];
        const modeElement = document.getElementById('flight-mode');
        const armElement = document.getElementById('arm-status');
        
        modeElement.textContent = modeNames[fsmState] || 'UNKNOWN';
        
        // Update arm status (this would come from telemetry in real implementation)
        const isArmed = this.telemetryData.gamepad && this.telemetryData.gamepad.arm_switch;
        
        if (isArmed) {
            armElement.classList.add('armed');
            armElement.querySelector('.arm-text').textContent = 'ARMED';
        } else {
            armElement.classList.remove('armed');
            armElement.querySelector('.arm-text').textContent = 'DISARMED';
        }
    }

    // =============================================================================
    // BATTERY SYSTEMS
    // =============================================================================
    
    updateBattery(voltage) {
        const aircraftBattery = document.getElementById('aircraft-battery-fill');
        const aircraftVoltage = document.getElementById('aircraft-voltage');
        
        const voltagePercent = this.calculateBatteryPercent(voltage);
        aircraftVoltage.textContent = `${voltage.toFixed(1)}V`;
        aircraftBattery.style.width = `${voltagePercent}%`;
        
        // Update battery color based on voltage
        aircraftBattery.classList.remove('warning', 'danger');
        if (voltage < 6.4) {
            aircraftBattery.classList.add('danger');
            this.addAlert('CRITICAL: Aircraft battery low!', 'danger');
        } else if (voltage < 7.0) {
            aircraftBattery.classList.add('warning');
            this.addAlert('WARNING: Aircraft battery low', 'warning');
        }
    }

    updateGamepadStatus(gamepadData) {
        if (!gamepadData) return;
        
        const gamepadBattery = document.getElementById('gamepad-battery-fill');
        const gamepadPercentage = document.getElementById('gamepad-percentage');
        
        gamepadPercentage.textContent = `${gamepadData.battery || 0}%`;
        gamepadBattery.style.width = `${gamepadData.battery || 0}%`;
        
        // Update connection status
        this.updateConnectionStatus('gamepad-status', gamepadData.connected);
        this.connectionStatus.gamepad = gamepadData.connected;
        
        if (gamepadData.connected && !this.connectionStatus.gamepad) {
            this.addAlert('Gamepad connected', 'success');
        } else if (!gamepadData.connected && this.connectionStatus.gamepad) {
            this.addAlert('Gamepad disconnected', 'warning');
        }
    }

    calculateBatteryPercent(voltage) {
        // LiPo battery voltage curve (6.0V empty, 8.4V full)
        const minVoltage = 6.0;
        const maxVoltage = 8.4;
        const percent = Math.max(0, Math.min(100, ((voltage - minVoltage) / (maxVoltage - minVoltage)) * 100));
        return percent;
    }

    // =============================================================================
    // SIGNAL STRENGTH
    // =============================================================================
    
    updateSignalStrength(systemData) {
        if (!systemData) return;
        
        // LoRa
        this.updateSignalBar('lora-signal', 'lora-rssi', systemData.lora_rssi || -100);
        
        // Uplink
        this.updateSignalBar('uplink-signal', 'uplink-rssi', this.telemetryData.rssi_uplink || -100);
        
        // Update LoRa connection status
        const loraConnected = (systemData.lora_rssi || -100) > -120;
        this.updateConnectionStatus('lora-status', loraConnected);
        this.connectionStatus.lora = loraConnected;
    }

    updateSignalBar(fillId, valueId, rssi) {
        const fillElement = document.getElementById(fillId);
        const valueElement = document.getElementById(valueId);
        
        valueElement.textContent = `${rssi}dBm`;
        
        // Convert RSSI to percentage (-50dBm = 100%, -120dBm = 0%)
        const percent = Math.max(0, Math.min(100, ((rssi + 120) / 70) * 100));
        fillElement.style.width = `${percent}%`;
        
        // Update color based on signal strength
        if (rssi > -70) {
            fillElement.style.background = 'linear-gradient(90deg, #00ff88, #00ff88)';
        } else if (rssi > -90) {
            fillElement.style.background = 'linear-gradient(90deg, #ffaa00, #ffaa00)';
        } else {
            fillElement.style.background = 'linear-gradient(90deg, #ff3366, #ff3366)';
        }
    }

    // =============================================================================
    // CONNECTION STATUS
    // =============================================================================
    
    updateConnectionStatus(elementId, connected) {
        const element = document.getElementById(elementId);
        element.classList.remove('online', 'offline', 'warning');
        
        if (connected) {
            element.classList.add('online');
        } else {
            element.classList.add('offline');
        }
    }

    // =============================================================================
    // ALERT SYSTEM
    // =============================================================================
    
    addAlert(message, type = 'info') {
        const alertPanel = document.getElementById('alert-panel');
        const alertItem = document.createElement('div');
        alertItem.className = `alert-item alert-${type}`;
        
        const icons = {
            info: 'ℹ',
            success: '✓',
            warning: '⚠',
            danger: '✕'
        };
        
        const timestamp = new Date().toLocaleTimeString();
        
        alertItem.innerHTML = `
            <span class="alert-icon">${icons[type] || icons.info}</span>
            <span class="alert-text">[${timestamp}] ${message}</span>
        `;
        
        // Remove placeholder if exists
        const placeholder = document.getElementById('alert-placeholder');
        if (placeholder) {
            placeholder.remove();
        }
        
        // Add new alert
        alertPanel.appendChild(alertItem);
        
        // Limit to 20 alerts
        const alerts = alertPanel.querySelectorAll('.alert-item');
        if (alerts.length > 20) {
            alerts[0].remove();
        }
        
        // Auto-scroll to bottom
        alertPanel.scrollTop = alertPanel.scrollHeight;
        
        // Play sound for danger alerts
        if (type === 'danger') {
            this.playAlertSound();
        }
    }

    playAlertSound() {
        const audio = document.getElementById('alert-sound');
        if (audio) {
            audio.play().catch(e => console.log('Could not play alert sound:', e));
        }
    }

    clearAlerts() {
        const alertPanel = document.getElementById('alert-panel');
        alertPanel.innerHTML = '<div class="alert-item alert-info" id="alert-placeholder"><span class="alert-icon">ℹ</span><span class="alert-text">System Ready</span></div>';
    }

    testAlerts() {
        this.addAlert('Test alert - INFO', 'info');
        setTimeout(() => this.addAlert('Test alert - SUCCESS', 'success'), 500);
        setTimeout(() => this.addAlert('Test alert - WARNING', 'warning'), 1000);
        setTimeout(() => this.addAlert('Test alert - DANGER', 'danger'), 1500);
    }

    // =============================================================================
    // SYSTEM UTILITIES
    // =============================================================================
    
    startSystemClock() {
        setInterval(() => {
            const now = new Date();
            const timeString = now.toLocaleTimeString('en-US', { 
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            document.getElementById('system-time').textContent = timeString;
        }, 1000);
    }

    updatePing() {
        // Simple ping calculation (would need proper implementation)
        const ping = Math.floor(Math.random() * 50 + 10); // 10-60ms
        document.getElementById('ping-ms').textContent = `${ping}ms`;
    }

    // =============================================================================
    // EVENT LISTENERS
    // =============================================================================
    
    initializeEventListeners() {
        // Mission controls
        document.getElementById('clear-mission').addEventListener('click', () => {
            this.clearMission();
        });
        
        document.getElementById('upload-mission').addEventListener('click', () => {
            this.uploadMission();
        });
        
        // Alert controls
        document.getElementById('clear-alerts').addEventListener('click', () => {
            this.clearAlerts();
        });
        
        document.getElementById('test-alerts').addEventListener('click', () => {
            this.testAlerts();
        });
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            switch(e.key) {
                case 'Escape':
                    document.getElementById('waypoint-mode').checked = false;
                    break;
                case 'Delete':
                    if (this.waypoints.length > 0) {
                        this.removeWaypoint(this.waypoints.length - 1);
                    }
                    break;
                case 'Enter':
                    if (e.ctrlKey) {
                        this.uploadMission();
                    }
                    break;
            }
        });
        
        // Window resize handler
        window.addEventListener('resize', () => {
            if (this.map) {
                this.map.invalidateSize();
            }
        });
    }
}

// =============================================================================
// TAB NAVIGATION SYSTEM - CORRIGIDO
// =============================================================================

function switchTab(tabId) {
    // Hide all tab contents with !important override
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
        tab.style.display = 'none';
    });
    
    // Remove active class from all tab buttons
    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.remove('active');
    });
    
    // Show selected tab with !important override
    const selectedTab = document.getElementById(`tab-${tabId}`);
    if (selectedTab) {
        selectedTab.classList.add('active');
        selectedTab.style.display = 'block';
    }
    
    // Add active class to selected button
    const selectedButton = document.querySelector(`[data-tab="${tabId}"]`);
    if (selectedButton) {
        selectedButton.classList.add('active');
    }
    
    console.log(`Switched to tab: ${tabId}`);
}

// =============================================================================
// CONTROL LAYOUT FUNCTIONALITY - EXPANDIDO
// =============================================================================

// Add this method to GroundControlStation class
GroundControlStation.prototype.initializeControlLayout = function() {
    this.virtualJoystick = null;
    this.joystickActive = false;
    this.lastJoystickSend = 0;
    
    this.initializeTabNavigation();
    this.initializePowerControls();
    this.initializeFlightControls();
    this.initializeTargetControls();
    this.initializeVirtualJoystick();
};

GroundControlStation.prototype.initializeTabNavigation = function() {
    // Add click listeners to tab buttons
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', (e) => {
            const tabId = e.target.getAttribute('data-tab');
            switchTab(tabId);
        });
    });
};

GroundControlStation.prototype.initializePowerControls = function() {
    // ARM/DISARM Motor buttons
    document.getElementById('btn-arm').addEventListener('click', () => {
        this.sendCommand('ARM_MOTOR', true);
        this.addAlert('Motors ARMED', 'warning');
        this.speakAlert('Atenção: Motor Armado', true); // NEW: Priority speech
    });
    
    document.getElementById('btn-disarm').addEventListener('click', () => {
        this.sendCommand('ARM_MOTOR', false);
        this.addAlert('Motors DISARMED', 'info');
        this.speakAlert('Motor Desarmado', false); // NEW: Normal speech
    });
};

GroundControlStation.prototype.initializeFlightControls = function() {
    // Flight Mode buttons
    document.getElementById('btn-manual').addEventListener('click', () => {
        this.sendCommand('SET_MODE', 'MANUAL');
        this.addAlert('Flight mode: MANUAL', 'info');
    });
    
    document.getElementById('btn-stabilize').addEventListener('click', () => {
        this.sendCommand('SET_MODE', 'STABILIZE');
        this.addAlert('Flight mode: STABILIZE', 'info');
    });
    
    document.getElementById('btn-hold').addEventListener('click', () => {
        this.sendCommand('SET_MODE', 'HOLD');
        this.addAlert('Flight mode: HOLD', 'info');
    });
    
    document.getElementById('btn-auto').addEventListener('click', () => {
        this.sendCommand('SET_MODE', 'AUTO');
        this.addAlert('Flight mode: AUTO', 'info');
    });
    
    document.getElementById('btn-rtl').addEventListener('click', () => {
        this.sendCommand('SET_MODE', 'RTL');
        this.addAlert('Flight mode: RTL (Return to Launch)', 'danger');
    });
};

GroundControlStation.prototype.initializeTargetControls = function() {
    const speedSlider = document.getElementById('speed-slider');
    const speedNumber = document.getElementById('speed-number');
    const altitudeSlider = document.getElementById('altitude-slider');
    const altitudeNumber = document.getElementById('altitude-number');
    
    // Speed control bidirectional sync
    speedSlider.addEventListener('input', (e) => {
        speedNumber.value = e.target.value;
    });
    
    speedNumber.addEventListener('input', (e) => {
        const value = Math.max(10, Math.min(25, parseInt(e.target.value) || 15));
        speedSlider.value = value;
        e.target.value = value;
    });
    
    // Altitude control bidirectional sync
    altitudeSlider.addEventListener('input', (e) => {
        altitudeNumber.value = e.target.value;
    });
    
    altitudeNumber.addEventListener('input', (e) => {
        const value = Math.max(15, Math.min(150, parseInt(e.target.value) || 50));
        altitudeSlider.value = value;
        e.target.value = value;
    });
    
    // Send targets button
    document.getElementById('btn-send-targets').addEventListener('click', () => {
        const speed = parseInt(speedSlider.value);
        const altitude = parseInt(altitudeSlider.value);
        
        this.sendCommand('SET_TARGETS', { speed, altitude });
        this.addAlert(`Targets sent: Speed ${speed} m/s, Altitude ${altitude} m`, 'info');
    });
};

GroundControlStation.prototype.initializeVirtualJoystick = function() {
    // Initialize Nipple.js with enhanced configuration
    this.virtualJoystick = nipplejs.create({
        zone: document.getElementById('joystick-zone'),
        mode: 'static',
        position: { left: '50%', top: '50%' },
        color: 'rgba(0, 255, 136, 0.4)',
        size: 200, // Increased for 250px zone
        threshold: 0.1,
        fadeTime: 250,
        multitouch: false,
        maxNumberOfNipples: 1,
        dataOnly: false,
        restJoystick: true,
        restOpacity: 0.5,
        lockX: false,
        lockY: false,
        shape: 'circle'
    });
    
    // Joystick move event
    this.virtualJoystick.on('move', (evt, data) => {
        this.joystickActive = true;
        this.updateJoystickDisplay(data);
        this.sendJoystickCommand(data);
    });
    
    // Joystick end event (when released)
    this.virtualJoystick.on('end', (evt, data) => {
        this.joystickActive = false;
        this.updateJoystickDisplay({ force: 0, angle: 0 });
        this.sendJoystickCommand({ force: 0, angle: 0 });
    });
};

GroundControlStation.prototype.updateJoystickDisplay = function(data) {
    const rollValue = document.getElementById('roll-value');
    const pitchValue = document.getElementById('pitch-value');
    
    // Convert force/angle to X/Y values (-100 to 100)
    const x = Math.round(data.force * Math.cos(data.angle * Math.PI / 180) * 100);
    const y = Math.round(data.force * Math.sin(data.angle * Math.PI / 180) * 100);
    
    rollValue.textContent = x;
    pitchValue.textContent = y;
};

GroundControlStation.prototype.sendJoystickCommand = function(data) {
    // Rate limit to ~10Hz (100ms between sends)
    const now = Date.now();
    if (now - this.lastJoystickSend < 100) {
        return;
    }
    
    this.lastJoystickSend = now;
    
    // Convert force/angle to roll/pitch values (-100 to 100)
    const roll = Math.round(data.force * Math.cos(data.angle * Math.PI / 180) * 100);
    const pitch = Math.round(data.force * Math.sin(data.angle * Math.PI / 180) * 100);
    
    this.sendCommand('JOYSTICK', { roll, pitch });
};

GroundControlStation.prototype.sendCommand = function(action, value) {
    const command = {
        type: 'command',
        action: action,
        value: value
    };
    
    if (this.sendSerialCommand(command)) {
        console.log('Command sent:', command);
    } else {
        console.warn('USB not connected, command not sent:', command);
        this.addAlert('USB not connected - command not sent', 'warning');
    }
};

// =============================================================================
// NEW: INDUSTRIAL-GRADE FEATURES
// =============================================================================

// 1. INTELLIGENT TELEMETRY LOGGER (CSV EXPORT)
// =============================================================================

GroundControlStation.prototype.initializeDataManagement = function() {
    // Connect download button to CSV export function
    document.getElementById('btn-download-log').addEventListener('click', () => {
        this.exportLogToCSV();
    });
    
    // Update log count display
    this.updateLogDisplay();
};

GroundControlStation.prototype.logTelemetry = function(data) {
    // Create log entry with timestamp and key parameters
    const logEntry = {
        timestamp: Date.now(),
        altitude: data.altitude_m || 0,
        speed: data.ground_speed_ms || 0,
        roll: data.roll_deg || 0,
        pitch: data.pitch_deg || 0,
        heading: data.heading_deg || 0,
        battery: data.battery_v || 0,
        flightMode: data.fsm_state || 0,
        rssi: data.rssi_uplink || 0,
        latitude: data.latitude || 0,
        longitude: data.longitude || 0
    };
    
    // Add to flight log (avoid deep clones for performance)
    this.flightLog.push(logEntry);
    
    // Update display
    this.updateLogDisplay();
    
    // Optional: Limit log size to prevent memory issues (keep last 10000 entries)
    if (this.flightLog.length > 10000) {
        this.flightLog = this.flightLog.slice(-5000); // Keep last 5000
        this.addAlert('Flight log trimmed to 5000 entries', 'warning');
    }
};

GroundControlStation.prototype.updateLogDisplay = function() {
    const logCount = document.getElementById('log-count');
    const logStatus = document.getElementById('log-status');
    
    if (logCount) {
        logCount.textContent = this.flightLog.length;
    }
    
    if (logStatus) {
        if (this.flightLog.length === 0) {
            logStatus.textContent = 'Ready';
            logStatus.className = 'log-status';
        } else if (this.flightLog.length < 100) {
            logStatus.textContent = 'Recording';
            logStatus.className = 'log-status';
        } else if (this.flightLog.length < 1000) {
            logStatus.textContent = 'Good';
            logStatus.className = 'log-status';
        } else {
            logStatus.textContent = 'Large';
            logStatus.className = 'log-status warning';
        }
    }
};

GroundControlStation.prototype.exportLogToCSV = function() {
    if (this.flightLog.length === 0) {
        this.addAlert('No flight data to export', 'warning');
        return;
    }
    
    // Create CSV headers
    const headers = [
        'Timestamp',
        'UTC Time',
        'Altitude (m)',
        'Speed (m/s)',
        'Roll (deg)',
        'Pitch (deg)',
        'Heading (deg)',
        'Battery (V)',
        'Flight Mode',
        'RSSI (dBm)',
        'Latitude',
        'Longitude'
    ];
    
    // Convert log entries to CSV rows
    const csvRows = [headers.join(',')];
    
    for (const entry of this.flightLog) {
        const row = [
            entry.timestamp,
            new Date(entry.timestamp).toISOString(),
            entry.altitude.toFixed(2),
            entry.speed.toFixed(2),
            entry.roll.toFixed(2),
            entry.pitch.toFixed(2),
            entry.heading.toFixed(2),
            entry.battery.toFixed(3),
            this.getFlightModeName(entry.flightMode),
            entry.rssi,
            entry.latitude.toFixed(6),
            entry.longitude.toFixed(6)
        ];
        csvRows.push(row.join(','));
    }
    
    // Create CSV string
    const csvString = csvRows.join('\n');
    
    // Create blob and download
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    
    // Generate filename with timestamp
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `flight_log_${timestamp}.csv`;
    
    // Create download link
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Cleanup
    URL.revokeObjectURL(url);
    
    this.addAlert(`Flight log exported: ${this.flightLog.length} entries`, 'info');
    console.log(`CSV exported with ${this.flightLog.length} entries`);
};

GroundControlStation.prototype.getFlightModeName = function(mode) {
    const modeNames = {
        0: 'MANUAL',
        1: 'STABILIZE',
        2: 'HOLD',
        3: 'AUTO',
        4: 'RTL'
    };
    return modeNames[mode] || `UNKNOWN(${mode})`;
};

// 2. ACOUSTIC SITUATIONAL AWARENESS (Web Speech API)
// =============================================================================

GroundControlStation.prototype.initializeSpeechSynthesis = function() {
    // Check if speech synthesis is available
    if (!('speechSynthesis' in window)) {
        console.warn('Speech synthesis not supported in this browser');
        this.addAlert('Speech synthesis not available', 'warning');
        return;
    }
    
    console.log('Speech synthesis initialized');
    this.speechEnabled = true;
};

GroundControlStation.prototype.speakAlert = function(message, priority = false) {
    if (!this.speechEnabled || !window.speechSynthesis) {
        return;
    }
    
    // Cancel previous speech if this is priority
    if (priority) {
        window.speechSynthesis.cancel();
    }
    
    // Create utterance
    const utterance = new SpeechSynthesisUtterance(message);
    
    // Configure for Brazilian Portuguese
    utterance.lang = 'pt-BR';
    utterance.rate = 0.9; // Slightly slower for clarity
    utterance.pitch = 1.0;
    utterance.volume = 0.8;
    
    // Find Brazilian voice if available
    const voices = window.speechSynthesis.getVoices();
    const ptVoice = voices.find(voice => voice.lang.startsWith('pt'));
    if (ptVoice) {
        utterance.voice = ptVoice;
    }
    
    // Speak
    window.speechSynthesis.speak(utterance);
    
    console.log(`Speech: "${message}" (priority: ${priority})`);
};

// Enhanced telemetry update with speech integration
GroundControlStation.prototype.updateTelemetry = function(data) {
    // Store telemetry data
    this.telemetryData = data;
    
    // Update all displays
    this.updateHUD(data);
    this.updatePFD(data);
    this.updateMap(data);
    this.updateSystemStatus(data);
    
    // NEW: Check for flight mode changes
    if (data.fsm_state !== this.lastFlightMode && this.lastFlightMode !== null) {
        const modeName = this.getFlightModeName(data.fsm_state);
        this.speakAlert(`Modo de voo alterado para ${modeName}`, false);
        console.log(`Flight mode changed: ${this.lastFlightMode} -> ${data.fsm_state}`);
    }
    this.lastFlightMode = data.fsm_state;
    
    // NEW: Check for critical battery voltage
    const batteryVoltage = data.battery_v || 0;
    if (batteryVoltage < 6.8 && !this.batteryAlertTriggered) {
        this.speakAlert('Alerta: Tensão da bateria crítica', true);
        this.batteryAlertTriggered = true;
        this.addAlert('CRITICAL: Battery voltage below 6.8V', 'danger');
    } else if (batteryVoltage >= 7.0) {
        // Reset battery alert when voltage recovers
        this.batteryAlertTriggered = false;
    }
};

// 3. GCS FAILSAFE (HEARTBEAT)
// =============================================================================

GroundControlStation.prototype.startHeartbeat = function() {
    // Clear any existing interval
    if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
    }
    
    // Start heartbeat interval (1 Hz)
    this.heartbeatInterval = setInterval(() => {
        this.sendHeartbeat();
    }, 1000);
    
    console.log('GCS Heartbeat started (1 Hz)');
};

GroundControlStation.prototype.sendHeartbeat = function() {
    // Only send if USB is connected
    if (this.connectionStatus.usb) {
        const heartbeat = {
            type: 'command',
            action: 'HEARTBEAT',
            timestamp: Date.now()
        };
        
        this.sendSerialCommand(heartbeat);
    }
};

GroundControlStation.prototype.stopHeartbeat = function() {
    if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
        console.log('GCS Heartbeat stopped');
    }
};

// =============================================================================
// GLOBAL INITIALIZATION
// =============================================================================

let gcs;

document.addEventListener('DOMContentLoaded', () => {
    gcs = new GroundControlStation();
    console.log('Ground Control Station initialized');
});

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

// Haversine formula for distance calculation
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Format coordinate display
function formatCoordinate(value, type) {
    const abs = Math.abs(value);
    const degrees = Math.floor(abs);
    const minutes = Math.floor((abs - degrees) * 60);
    const seconds = ((abs - degrees) * 60 - minutes) * 60;
    
    const direction = type === 'lat' 
        ? (value >= 0 ? 'N' : 'S')
        : (value >= 0 ? 'E' : 'W');
    
    return `${degrees}°${minutes}'${seconds.toFixed(1)}"${direction}`;
}

// Convert bearing to compass direction
function bearingToCompass(bearing) {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(((bearing + 360) % 360) / 22.5) % 16;
    return directions[index];
}
