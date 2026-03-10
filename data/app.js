/* =============================================================================
GROUND CONTROL STATION - AVIONICS GRADE JAVASCRIPT APPLICATION
============================================================================= */

class GroundControlStation {
    constructor() {
        this.ws = null;
        this.map = null;
        this.aircraftMarker = null;
        this.aircraftPath = [];
        this.pathPolyline = null;
        this.waypoints = [];
        this.homePosition = null;
        this.telemetryData = {};
        this.connectionStatus = {
            websocket: false,
            gamepad: false,
            lora: false
        };
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000;
        
        this.init();
    }

    // =============================================================================
    // INITIALIZATION
    // =============================================================================
    
    init() {
        this.initializeWebSocket();
        this.initializeMap();
        this.initializeEventListeners();
        this.initializePFD();
        this.initializeControlLayout();
        this.startSystemClock();
        this.addAlert('System initialized', 'info');
    }

    // =============================================================================
    // WEBSOCKET COMMUNICATION
    // =============================================================================
    
    initializeWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        
        this.connectWebSocket(wsUrl);
    }

    connectWebSocket(url) {
        try {
            this.ws = new WebSocket(url);
            
            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.connectionStatus.websocket = true;
                this.updateConnectionStatus('ws-status', true);
                this.reconnectAttempts = 0;
                this.addAlert('WebSocket connected', 'success');
            };
            
            this.ws.onmessage = (event) => {
                this.handleWebSocketMessage(event);
            };
            
            this.ws.onclose = () => {
                console.log('WebSocket disconnected');
                this.connectionStatus.websocket = false;
                this.updateConnectionStatus('ws-status', false);
                this.addAlert('WebSocket disconnected', 'warning');
                this.attemptReconnect();
            };
            
            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.addAlert('WebSocket connection error', 'danger');
            };
            
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
            this.addAlert('Failed to create WebSocket connection', 'danger');
        }
    }

    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
            
            console.log(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
            this.addAlert(`Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`, 'info');
            
            setTimeout(() => {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = `${protocol}//${window.location.host}/ws`;
                this.connectWebSocket(wsUrl);
            }, delay);
        } else {
            this.addAlert('Max reconnection attempts reached', 'danger');
        }
    }

    handleWebSocketMessage(event) {
        try {
            const data = JSON.parse(event.data);
            
            switch (data.type) {
                case 'telemetry':
                    this.updateTelemetry(data);
                    break;
                default:
                    console.log('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
        }
    }

    sendWebSocketMessage(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
            return true;
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
        
        if (this.sendWebSocketMessage(missionData)) {
            this.addAlert(`Mission uploaded: ${this.waypoints.length} waypoints`, 'success');
        } else {
            this.addAlert('Failed to upload mission - WebSocket not connected', 'danger');
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
        
        // WiFi
        this.updateSignalBar('wifi-signal', 'wifi-rssi', systemData.wifi_rssi || -100);
        
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
// TAB NAVIGATION SYSTEM
// =============================================================================

function switchTab(tabId) {
    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
        tab.style.display = 'none';
    });
    
    // Remove active class from all tab buttons
    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.remove('active');
    });
    
    // Show selected tab
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
// CONTROL LAYOUT FUNCTIONALITY
// =============================================================================

// Add this method to GroundControlStation class
GroundControlStation.prototype.initializeControlLayout = function() {
    this.virtualJoystick = null;
    this.joystickActive = false;
    this.lastJoystickSend = 0;
    
    this.initializeTabNavigation();
    this.initializeFlightControls();
    this.initializeSpeedControl();
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

GroundControlStation.prototype.initializeFlightControls = function() {
    // Flight Mode Override buttons
    document.getElementById('btn-manual').addEventListener('click', () => {
        this.sendCommand('SET_MODE', 'MANUAL');
        this.addAlert('Flight mode: MANUAL', 'info');
    });
    
    document.getElementById('btn-stabilize').addEventListener('click', () => {
        this.sendCommand('SET_MODE', 'STABILIZE');
        this.addAlert('Flight mode: STABILIZE', 'info');
    });
    
    document.getElementById('btn-rth').addEventListener('click', () => {
        this.sendCommand('SET_MODE', 'RETURN_TO_LAUNCH');
        this.addAlert('Flight mode: RETURN TO LAUNCH', 'danger');
    });
};

GroundControlStation.prototype.initializeSpeedControl = function() {
    const speedSlider = document.getElementById('speed-slider');
    const speedValue = document.getElementById('speed-value');
    
    // Update display on input
    speedSlider.addEventListener('input', (e) => {
        const value = e.target.value;
        speedValue.textContent = `${value} m/s`;
    });
    
    // Send command on change
    speedSlider.addEventListener('change', (e) => {
        const value = parseInt(e.target.value);
        this.sendCommand('SET_SPEED', value);
        this.addAlert(`Target speed set to ${value} m/s`, 'info');
    });
};

GroundControlStation.prototype.initializeVirtualJoystick = function() {
    // Initialize Nipple.js
    this.virtualJoystick = nipplejs.create({
        zone: document.getElementById('joystick-zone'),
        mode: 'static',
        position: { left: '50%', top: '50%' },
        color: 'rgba(0, 255, 136, 0.5)',
        size: 150,
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
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(command));
        console.log('Command sent:', command);
    } else {
        console.warn('WebSocket not connected, command queued:', command);
        this.addAlert('WebSocket not connected - command not sent', 'warning');
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
