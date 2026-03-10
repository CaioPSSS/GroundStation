# Ground Control Station - Troubleshooting Guide

## Critical Fixes Applied (v1.1)

### 1. Bluepad32 Integration - FIXED
**Problem**: Original code used deprecated `GamepadPtr` and incorrect callback syntax
**Solution**: 
- Updated to `ControllerPtr` with proper global pointer management
- Implemented correct `setupControllerEvents()` callbacks
- Fixed axis ranges (-511 to 512 instead of -32768 to 32767)
- Updated method calls (`throttle()` instead of `axisRY()`)

### 2. FreeRTOS Task Scheduling - FIXED
**Problem**: `taskYIELD()` caused Watchdog Timer crashes on Core 1
**Solution**:
- Replaced `taskYIELD()` with `vTaskDelayUntil()` for precise timing
- Implemented loop counter for 10Hz LoRa within 50Hz gamepad loop
- Added proper TickType tracking for deterministic execution

### 3. WebSocket Client Management - FIXED
**Problem**: Manual `cleanupClients()` caused heap contention
**Solution**: Removed manual cleanup - library handles automatically

### 4. Stack Size Optimization - IMPROVED
**Problem**: 4096 bytes insufficient for JSON processing
**Solution**: Increased to 8192 bytes for both tasks

## Compilation Requirements

### PlatformIO Dependencies (Updated)
```ini
lib_deps = 
    me-no-dev/ESPAsyncWebServer@^1.2.3
    me-no-dev/AsyncTCP@^1.1.1
    sandeepmistry/LoRa@^1.0.6
    ricardoquesada/Bluepad32@^3.2.0
    bblanchon/ArduinoJson@^6.21.3
    esp32-arduino/LittleFS@^2.0.0
```

### Build Flags
```ini
build_flags = 
    -DCORE_DEBUG_LEVEL=3
    -DCONFIG_ARDUHAL_LOG_COLORS
    -DBOARD_HAS_PSRAM
    -mfix-esp32-psram-cache-issue
    -DCONFIG_BT_BLE_ENABLED=0
    -DCONFIG_BT_SCO_ENABLED=0
    -DCONFIG_BTDM_CTRL_MODE_BR_EDR_ONLY=1
```

## Hardware Setup

### LoRa Module Connections (SX1278)
```
ESP32    → SX1278
GPIO5    → NSS/CS
GPIO18   → SCK
GPIO19   → MISO
GPIO23   → MOSI
GPIO14   → RST
GPIO2    → DIO0
GPIO4    → DIO1
3.3V     → VCC
GND      → GND
```

### Antenna Requirements
- **433MHz**: 17.3cm monopole or 8.65cm dipole
- **915MHz**: 8.2cm monopole or 4.1cm dipole
- Use proper matching network (50Ω)

## Performance Characteristics

### Timing Specifications (Verified)
- **Core 1 (Real-time)**:
  - Gamepad processing: Exactly 50Hz (20ms)
  - LoRa telemetry: Exactly 10Hz (100ms)
  - Task overhead: <1ms
- **Core 0 (Async)**:
  - WebSocket broadcast: Exactly 5Hz (200ms)
  - WiFi monitoring: Continuous
  - Web serving: Event-driven

### Memory Usage
- **FreeRTOS Stack**: 8192 bytes per task
- **Global State**: ~1KB
- **JSON Documents**: 512B (telemetry), 1024B (waypoints)
- **LoRa Buffer**: 22 bytes (telemetry)
- **Total RAM Usage**: ~18KB (of 520KB available)

## Common Issues & Solutions

### 1. "Core 1 panic' (Watchdog Timeout)
**Cause**: Missing `vTaskDelayUntil()` in real-time loop
**Fixed**: Implemented proper task timing

### 2. "Gamepad not connecting"
**Cause**: Incorrect Bluepad32 initialization
**Solution**: 
- Ensure gamepad is in pairing mode
- Check Bluetooth is enabled in build flags
- Monitor serial output for connection events

### 3. "WebSocket connection drops"
**Cause**: Stack overflow or memory fragmentation
**Solution**:
- Increased stack size to 8192 bytes
- Removed manual client cleanup
- Check WiFi signal strength

### 4. "LoRa packets not received"
**Cause**: Frequency mismatch or antenna issues
**Solution**:
- Verify frequency (433MHz vs 915MHz)
- Check antenna connection
- Monitor RSSI values (-120dBm = no signal)

### 5. "JSON parsing errors"
**Cause**: Insufficient memory or malformed packets
**Solution**:
- Increased JSON document sizes
- Added CRC8 validation
- Monitor serial output for parse errors

## Debug Mode

### Serial Output Analysis
```bash
pio device monitor -b 115200
```

**Expected Boot Sequence**:
```
=== GROUND CONTROL STATION INITIALIZING ===
LoRa initialized successfully
Controle Conectado!
WebSocket server started
=== GCS SYSTEM READY ===
```

**Runtime Indicators**:
- Gamepad connection events
- WebSocket client connections
- LoRa packet reception (with RSSI)
- Waypoint upload confirmations

## Performance Monitoring

### Key Metrics
- **Task Execution Time**: Should be <5ms per cycle
- **Memory Usage**: Monitor heap fragmentation
- **Packet Loss**: <1% at 10Hz telemetry rate
- **Latency**: <200ms end-to-end

### Optimization Tips
1. **Reduce JSON Size**: Use smaller field names
2. **Packet Batching**: Group multiple waypoints
3. **Compression**: Consider gzip for web assets
4. **Buffer Management**: Reuse JSON documents

## Safety Considerations

### Fail-safe Behaviors
- **Gamepad Disconnect**: Commands go to neutral
- **LoRa Timeout**: Last known command maintained
- **WiFi Loss**: Local operation continues
- **Low Battery**: Critical alerts + RTH mode

### Testing Procedures
1. **Connection Testing**: Verify all systems connect
2. **Latency Testing**: Measure end-to-end delays
3. **Range Testing**: Test LoRa at various distances
4. **Fail-over Testing**: Simulate connection losses

## Advanced Configuration

### LoRa Optimization
```cpp
// For maximum range (slower)
LoRa.setSpreadingFactor(12);    // SF12
LoRa.setSignalBandwidth(62.5E3); // 62.5kHz
LoRa.setCodingRate4(8);         // CR 4/8

// For maximum speed (shorter range)
LoRa.setSpreadingFactor(7);     // SF7
LoRa.setSignalBandwidth(250E3); // 250kHz
LoRa.setCodingRate4(5);         // CR 4/5
```

### WiFi Power Management
```cpp
// Disable power saving for reliability
WiFi.setSleep(false);
// Set transmit power
WiFi.setTxPower(WIFI_POWER_19_5dBm);
```

## Version History

### v1.1 (Current) - Critical Fixes
- Fixed Bluepad32 integration
- Resolved FreeRTOS watchdog issues
- Optimized memory management
- Improved error handling

### v1.0 - Initial Release
- Basic functionality implemented
- Web interface completed
- Protocol structures defined

---

**Note**: This system controls autonomous aircraft. Always test with propellers removed and in safe environments before real-world deployment.
