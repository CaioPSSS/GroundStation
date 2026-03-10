# Ground Control Station (GCS) - ESP32 Aviation System

A professional-grade Ground Control Station for autonomous aircraft control, implementing real-time telemetry, mission planning, and flight control capabilities.

## System Architecture

### Hardware Configuration
- **ESP32 Dual-Core Microcontroller** 
  - Core 1: Real-time Bluetooth & LoRa communication (50Hz/10Hz)
  - Core 0: Async WiFi & WebSocket server (5Hz updates)
- **LoRa Module** (SX1278) - 433MHz/915MHz long-range communication
- **Bluetooth Gamepad** (GameSir compatible via Bluepad32)
- **WiFi Connection** - Station mode for internet connectivity

### Communication Protocol

#### Binary Packet Structures

**Telemetry Packet (22 bytes)**
```cpp
typedef struct __attribute__((packed)) {
    uint8_t   sync_header;      // 0xAA
    uint8_t   fsm_state;        // 0=MANUAL, 1=ANGLE, 2=HOLD, 3=AUTO, 4=RTH
    int16_t   altitude_cm;      // Altitude in centimeters
    int16_t   roll_deg_10;      // Roll in tenths of degrees
    int16_t   pitch_deg_10;     // Pitch in tenths of degrees
    uint16_t  heading_deg_10;   // Heading in tenths of degrees
    int32_t   latitude_gps;     // Latitude * 10^7
    int32_t   longitude_gps;    // Longitude * 10^7
    uint16_t  battery_volt_mv;  // Battery in millivolts
    int8_t    rssi_uplink;      // LoRa RSSI at aircraft
    uint8_t   checksum_crc8;    // CRC8 validation
} PacketTelemetryLoRa_t;
```

**Control Command Packet (8 bytes)**
```cpp
typedef struct __attribute__((packed)) {
    uint8_t sync_header;    // 0xBB
    int8_t  cmd_roll;       // -100 to 100
    int8_t  cmd_pitch;      // -100 to 100
    uint8_t cmd_throttle;   // 0 to 100
    uint8_t cmd_mode;       // Flight mode
    uint8_t arm_switch;     // 0=Disarmed, 1=Armed
    uint8_t checksum_crc8;  
} PacketUplinkLoRa_t;
```

**Waypoint Packet (14 bytes)**
```cpp
typedef struct __attribute__((packed)) {
    uint8_t  sync_header;   // 0xCC
    uint8_t  wp_index;      // 0 to 19
    int32_t  lat_e7;        // Latitude * 10^7
    int32_t  lon_e7;        // Longitude * 10^7
    int16_t  alt_m;         // Altitude in meters
    uint8_t  speed_ms;      // Speed in m/s
    uint8_t  checksum_crc8; 
} PacketWaypointLoRa_t;
```

## Features

### Real-time Flight Display
- **Primary Flight Display (PFD)** with artificial horizon
- **Heading indicator** with compass rose
- **Airspeed and altitude** indicators
- **Attitude visualization** with roll/pitch indicators

### Mission Planning
- **Interactive map** with Leaflet.js
- **Waypoint placement** with click-to-add functionality
- **Mission upload** via WebSocket
- **Route visualization** with aircraft tracking
- **Home position** setting

### Telemetry & Monitoring
- **Real-time telemetry** at 5Hz update rate
- **Battery monitoring** with voltage-based alerts
- **Signal strength** indicators (WiFi, LoRa, Uplink)
- **Connection status** for all systems
- **Alert system** with audio warnings

### Gamepad Control
- **Bluetooth gamepad** support via Bluepad32
- **Analog stick mapping** for roll/pitch control
- **Button mapping** for arm/disarm and mode switching
- **Battery level** monitoring

## Installation

### Prerequisites
- PlatformIO IDE or CLI
- ESP32 development board
- LoRa module (SX1278)
- GameSir Bluetooth controller
- WiFi access point

### Hardware Connections

**LoRa Module (SX1278):**
- NSS/CS → GPIO5
- SCK → GPIO18
- MISO → GPIO19
- MOSI → GPIO23
- RST → GPIO14
- DIO0 → GPIO2
- DIO1 → GPIO4

**Power:**
- 3.3V power supply
- Common ground with ESP32

### Software Setup

1. **Clone or download** the project
2. **Open in PlatformIO**
3. **Update WiFi credentials** in `main.cpp`:
   ```cpp
   WiFi.begin("YOUR_WIFI_SSID", "YOUR_WIFI_PASSWORD");
   ```
4. **Build and upload** to ESP32
5. **Upload LittleFS data** (HTML/CSS/JS files):
   ```bash
   pio run --target uploadfs
   ```

## Web Interface

Access the GCS web interface by connecting to the ESP32's WiFi network or accessing its IP address if connected to your network.

### Dashboard Layout
- **Left Column**: PFD and HUD telemetry
- **Center Column**: Interactive mission map
- **Right Column**: Flight status, battery, signals, alerts

### Controls
- **Map Click**: Set home position or add waypoints
- **Waypoint Mode**: Toggle for mission planning
- **Upload Mission**: Send waypoints to aircraft
- **Clear Mission**: Remove all waypoints

## Performance Specifications

### Timing Requirements
- **Core 1 (Real-time)**: 
  - Gamepad processing: 50Hz (20ms)
  - LoRa communication: 10Hz (100ms)
- **Core 0 (Async)**:
  - WebSocket updates: 5Hz (200ms)
  - Web server: On-demand

### LoRa Configuration
- **Frequency**: 433MHz or 915MHz
- **Spreading Factor**: SF8
- **Bandwidth**: 125kHz
- **Coding Rate**: 4/5
- **Sync Word**: 0x34

### Data Rates
- **Telemetry**: 22 bytes @ 10Hz = 220 bytes/sec
- **Control**: 8 bytes @ 10Hz = 80 bytes/sec
- **Waypoints**: 14 bytes each (burst transmission)

## Safety Features

### Fail-safe Mechanisms
- **Connection monitoring** with automatic reconnection
- **Signal strength** monitoring with alerts
- **Battery voltage** monitoring with critical warnings
- **CRC8 validation** for all packets
- **Watchdog timer** protection

### Alert System
- **Visual alerts** with color-coded severity
- **Audio warnings** for critical conditions
- **System logging** with timestamps
- **Alert history** with auto-cleanup

## Troubleshooting

### Common Issues

**LoRa Not Working:**
- Check wiring connections
- Verify frequency configuration
- Ensure antenna is connected
- Monitor serial output for errors

**WebSocket Connection Failed:**
- Check WiFi credentials
- Verify ESP32 is connected to network
- Check firewall settings
- Monitor browser console for errors

**Gamepad Not Connecting:**
- Ensure gamepad is in pairing mode
- Check Bluetooth compatibility
- Restart ESP32 if needed
- Monitor gamepad battery level

### Debug Mode
Enable serial monitoring for detailed debug information:
```bash
pio device monitor -b 115200
```

## Development

### Project Structure
```
├── src/
│   └── main.cpp              # Main firmware
├── data/
│   ├── index.html            # Web interface
│   ├── style.css             # Styling
│   └── app.js                # JavaScript application
├── platformio.ini            # PlatformIO configuration
└── README.md                 # This file
```

### Adding Features
- **New telemetry fields**: Update packet structures
- **Additional controls**: Extend gamepad mapping
- **Web interface**: Modify HTML/CSS/JS files
- **Protocol changes**: Update CRC and packet handling

## License

This project is provided as-is for educational and research purposes. Use at your own risk and ensure compliance with local regulations for radio transmission and aircraft operation.

## Contributing

Contributions are welcome! Please ensure:
- Code follows existing style conventions
- Features are properly tested
- Documentation is updated
- Protocol changes maintain compatibility

---

**⚠️ WARNING**: This system controls autonomous aircraft. Ensure thorough testing and implement additional safety mechanisms before real-world deployment.
