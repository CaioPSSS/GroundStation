#include <Arduino.h>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <AsyncWebSocket.h>
#include <LoRa.h>
#include <Bluepad32.h>
#include <LittleFS.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <ArduinoJson.h>

// =============================================================================
// PROTOCOL DEFINITIONS - AERONAUTICAL PRECISION
// =============================================================================

// Pacote recebido da Asa Voadora (Telemetria Otimizada - 22 Bytes)
typedef struct __attribute__((packed)) {
    uint8_t   sync_header;      // Sempre 0xAA
    uint8_t   fsm_state;        // 0=MANUAL, 1=ANGLE, 2=HOLD, 3=AUTO, 4=RTH
    int16_t   altitude_cm;      // Altitude em centímetros
    int16_t   roll_deg_10;      // Roll em décimos de grau (Ex: 455 = 45.5º)
    int16_t   pitch_deg_10;     // Pitch em décimos de grau (Ex: -150 = -15.0º)
    uint16_t  heading_deg_10;   // Bússola em décimos de grau
    int32_t   latitude_gps;     // Lat bruta * 10^7
    int32_t   longitude_gps;    // Lon bruta * 10^7
    uint16_t  battery_volt_mv;  // Bateria em milivolts
    int8_t    rssi_uplink;      // Sinal LoRa no VANT
    uint8_t   checksum_crc8;    // Validador
} PacketTelemetryLoRa_t;

// Pacote enviado para a Asa Voadora (Controle RC - 8 Bytes - Transmitido a 10Hz)
typedef struct __attribute__((packed)) {
    uint8_t sync_header;    // Sempre 0xBB
    int8_t  cmd_roll;       // -100 a 100
    int8_t  cmd_pitch;      // -100 a 100
    uint8_t cmd_throttle;   // 0 a 100
    uint8_t cmd_mode;       // Mesmos estados do fsm_state
    uint8_t arm_switch;     // 0=Desarmado, 1=Armado
    uint8_t checksum_crc8;  
} PacketUplinkLoRa_t;

// Pacote enviado para a Asa Voadora (Waypoints de Missão - 14 Bytes)
typedef struct __attribute__((packed)) {
    uint8_t  sync_header;   // Sempre 0xCC
    uint8_t  wp_index;      // 0 a 19
    int32_t  lat_e7;        
    int32_t  lon_e7;        
    int16_t  alt_m;         
    uint8_t  speed_ms;      
    uint8_t  checksum_crc8; 
} PacketWaypointLoRa_t;

// =============================================================================
// GLOBAL STATE MANAGEMENT - THREAD SAFE
// =============================================================================

struct GlobalState {
    // Telemetry data received from aircraft
    PacketTelemetryLoRa_t telemetry;
    
    // Gamepad control data
    int8_t gamepad_roll;
    int8_t gamepad_pitch;
    uint8_t gamepad_throttle;
    uint8_t gamepad_mode;
    uint8_t gamepad_arm_switch;
    uint8_t gamepad_battery;
    bool gamepad_connected;
    
    // System status
    uint32_t last_telemetry_ms;
    uint32_t last_gamepad_ms;
    int32_t wifi_rssi;
    int32_t lora_rssi;
    
    // Mission waypoints
    std::vector<PacketWaypointLoRa_t> waypoints;
    bool waypoints_dirty;
    
    // Thread safety
    SemaphoreHandle_t mutex;
} global_state;

// =============================================================================
// CRC8 CALCULATION - AVIONICS STANDARD
// =============================================================================

class CRC {
public:
    static uint8_t calculateCRC8(const uint8_t *data, size_t length) {
        uint8_t crc = 0x00;
        const uint8_t polynomial = 0x07;
        
        for (size_t i = 0; i < length; i++) {
            crc ^= data[i];
            for (uint8_t bit = 8; bit > 0; --bit) {
                if (crc & 0x80) {
                    crc = (crc << 1) ^ polynomial;
                } else {
                    crc = crc << 1;
                }
            }
        }
        return crc;
    }
};

// =============================================================================
// LORA COMMUNICATION CLASS - 433MHz/915MHz
// =============================================================================

class LoRaComm {
private:
    static const int LORA_SS = 5;
    static const int LORA_RST = 14;
    static const int LORA_DIO0 = 2;
    static const int LORA_DIO1 = 4;
    
public:
    bool initialize() {
        LoRa.setPins(LORA_SS, LORA_RST, LORA_DIO0);
        
        // Configure for 433MHz (adjust for 915MHz as needed)
        if (!LoRa.begin(433E6)) {
            Serial.println("LoRa initialization failed!");
            return false;
        }
        
        // LoRa configuration for maximum range and reliability
        LoRa.setSpreadingFactor(8);        // SF8 - good balance of range/speed
        LoRa.setSignalBandwidth(125E3);    // 125kHz
        LoRa.setCodingRate4(5);            // CR 4/5
        LoRa.setPreambleLength(8);
        LoRa.setSyncWord(0x34);            // Custom sync word
        LoRa.enableCrc();
        
        Serial.println("LoRa initialized successfully");
        return true;
    }
    
    bool sendUplinkCommand(const PacketUplinkLoRa_t &cmd) {
        LoRa.beginPacket();
        LoRa.write((uint8_t*)&cmd, sizeof(PacketUplinkLoRa_t));
        return LoRa.endPacket() == 1;
    }
    
    bool sendWaypoint(const PacketWaypointLoRa_t &wp) {
        LoRa.beginPacket();
        LoRa.write((uint8_t*)&wp, sizeof(PacketWaypointLoRa_t));
        return LoRa.endPacket() == 1;
    }
    
    bool receiveTelemetry(PacketTelemetryLoRa_t &telemetry) {
        int packetSize = LoRa.parsePacket();
        if (packetSize == sizeof(PacketTelemetryLoRa_t)) {
            LoRa.readBytes((uint8_t*)&telemetry, sizeof(PacketTelemetryLoRa_t));
            
            // Validate packet
            if (telemetry.sync_header == 0xAA) {
                uint8_t calculated_crc = CRC::calculateCRC8(
                    (uint8_t*)&telemetry, sizeof(PacketTelemetryLoRa_t) - 1);
                
                if (calculated_crc == telemetry.checksum_crc8) {
                    global_state.lora_rssi = LoRa.packetRssi();
                    return true;
                }
            }
        }
        return false;
    }
};

// =============================================================================
// WEBSOCKET SERVER CLASS - FRONTEND COMMUNICATION
// =============================================================================

class GCSWebSocketServer {
private:
    AsyncWebServer server;
    AsyncWebSocket ws;
    
public:
    GCSWebSocketServer() : server(80), ws("/ws") {}
    
    void initialize() {
        // Configure WebSocket
        ws.onEvent([this](AsyncWebSocket *server, AsyncWebSocketClient *client,
                         AwsEventType type, void *arg, uint8_t *data, size_t len) {
            this->onWebSocketEvent(server, client, type, arg, data, len);
        });
        
        server.addHandler(&ws);
        
        // Serve static files from LittleFS
        server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");
        
        server.begin();
        Serial.println("WebSocket server started");
    }
    
    void broadcastTelemetry() {
        if (!xSemaphoreTake(global_state.mutex, pdMS_TO_TICKS(10))) {
            return;
        }
        
        StaticJsonDocument<512> doc;
        doc["type"] = "telemetry";
        doc["fsm_state"] = global_state.telemetry.fsm_state;
        doc["altitude_m"] = global_state.telemetry.altitude_cm / 100.0f;
        doc["roll_deg"] = global_state.telemetry.roll_deg_10 / 10.0f;
        doc["pitch_deg"] = global_state.telemetry.pitch_deg_10 / 10.0f;
        doc["heading_deg"] = global_state.telemetry.heading_deg_10 / 10.0f;
        doc["latitude"] = global_state.telemetry.latitude_gps / 10000000.0;
        doc["longitude"] = global_state.telemetry.longitude_gps / 10000000.0;
        doc["battery_v"] = global_state.telemetry.battery_volt_mv / 1000.0f;
        doc["rssi_uplink"] = global_state.telemetry.rssi_uplink;
        
        // Gamepad status
        JsonObject gamepad = doc.createNestedObject("gamepad");
        gamepad["connected"] = global_state.gamepad_connected;
        gamepad["battery"] = global_state.gamepad_battery;
        
        // System status
        JsonObject system = doc.createNestedObject("system");
        system["wifi_rssi"] = global_state.wifi_rssi;
        system["lora_rssi"] = global_state.lora_rssi;
        
        xSemaphoreGive(global_state.mutex);
        
        String jsonString;
        serializeJson(doc, jsonString);
        ws.textAll(jsonString);
    }
    
private:
    void onWebSocketEvent(AsyncWebSocket *server, AsyncWebSocketClient *client,
                         AwsEventType type, void *arg, uint8_t *data, size_t len) {
        switch (type) {
            case WS_EVT_CONNECT:
                Serial.printf("WebSocket client #%u connected\n", client->id());
                break;
                
            case WS_EVT_DISCONNECT:
                Serial.printf("WebSocket client #%u disconnected\n", client->id());
                break;
                
            case WS_EVT_DATA:
                handleWebSocketMessage(client, data, len);
                break;
                
            default:
                break;
        }
    }
    
    void handleWebSocketMessage(AsyncWebSocketClient *client, uint8_t *data, size_t len) {
        StaticJsonDocument<1024> doc;
        DeserializationError error = deserializeJson(doc, data, len);
        
        if (error) {
            Serial.printf("JSON parse error: %s\n", error.c_str());
            return;
        }
        
        const char* type = doc["type"];
        if (strcmp(type, "waypoints") == 0) {
            handleWaypointsUpload(doc["waypoints"]);
        }
    }
    
    void handleWaypointsUpload(JsonArray waypoints) {
        if (!xSemaphoreTake(global_state.mutex, pdMS_TO_TICKS(100))) {
            return;
        }
        
        global_state.waypoints.clear();
        
        for (JsonObject wp : waypoints) {
            PacketWaypointLoRa_t packet;
            packet.sync_header = 0xCC;
            packet.wp_index = wp["index"];
            packet.lat_e7 = wp["lat"] * 10000000;
            packet.lon_e7 = wp["lon"] * 10000000;
            packet.alt_m = wp["alt"];
            packet.speed_ms = wp["speed"];
            packet.checksum_crc8 = CRC::calculateCRC8((uint8_t*)&packet, sizeof(PacketWaypointLoRa_t) - 1);
            
            global_state.waypoints.push_back(packet);
        }
        
        global_state.waypoints_dirty = true;
        xSemaphoreGive(global_state.mutex);
        
        Serial.printf("Received %zu waypoints\n", global_state.waypoints.size());
    }
};

// =============================================================================
// GAMEPAD CONTROLLER CLASS - BLUEPAD32 INTEGRATION
// =============================================================================

class GamepadController {
private:
    GamepadPtr myGamepad;
    
public:
    void initialize() {
        Bluepad32.begin();
        Bluepad32.setGamepadCallback([this](GamepadPtr gamepad) {
            this->onGamepadConnected(gamepad);
        });
    }
    
    void update() {
        if (myGamepad && myGamepad->isConnected()) {
            // Read analog sticks (-32768 to 32767)
            int32_t axis_x = myGamepad->axisX();
            int32_t axis_y = myGamepad->axisY();
            
            // Convert to -100 to 100 range
            global_state.gamepad_roll = constrain(map(axis_x, -32768, 32767, -100, 100), -100, 100);
            global_state.gamepad_pitch = constrain(map(axis_y, -32768, 32767, -100, 100), -100, 100);
            
            // Throttle (right trigger or Y axis)
            int32_t throttle = myGamepad->axisRY();
            global_state.gamepad_throttle = constrain(map(throttle, -32768, 32767, 0, 100), 0, 100);
            
            // Mode switching with D-PAD
            if (myGamepad->pressed(DPAD_UP)) {
                global_state.gamepad_mode = 0; // MANUAL
            } else if (myGamepad->pressed(DPAD_RIGHT)) {
                global_state.gamepad_mode = 1; // ANGLE
            } else if (myGamepad->pressed(DPAD_DOWN)) {
                global_state.gamepad_mode = 2; // HOLD
            } else if (myGamepad->pressed(DPAD_LEFT)) {
                global_state.gamepad_mode = 3; // AUTO
            }
            
            // Arm/disarm with A button
            static bool last_a_state = false;
            bool current_a_state = myGamepad->pressed(A);
            if (current_a_state && !last_a_state) {
                global_state.gamepad_arm_switch = !global_state.gamepad_arm_switch;
            }
            last_a_state = current_a_state;
            
            // Battery level (approximation)
            global_state.gamepad_battery = myGamepad->batteryLevel();
            global_state.gamepad_connected = true;
            global_state.last_gamepad_ms = millis();
        } else {
            global_state.gamepad_connected = false;
        }
        
        Bluepad32.update();
    }
    
private:
    void onGamepadConnected(GamepadPtr gamepad) {
        Serial.println("Gamepad connected!");
        myGamepad = gamepad;
    }
};

// =============================================================================
// FREERTOS TASKS - REAL-TIME EXECUTION
// =============================================================================

LoRaComm lora_comm;
GCSWebSocketServer ws_server;
GamepadController gamepad_ctrl;

// CORE 1: Real-time Bluetooth and LoRa communication (50Hz/10Hz)
void realTimeTask(void *parameter) {
    const TickType_t xFrequency_10Hz = pdMS_TO_TICKS(100);
    const TickType_t xFrequency_50Hz = pdMS_TO_TICKS(20);
    
    uint32_t last_10hz = 0;
    uint32_t last_50hz = 0;
    
    while (1) {
        uint32_t now = xTaskGetTickCount() * portTICK_PERIOD_MS;
        
        // 50Hz: Gamepad processing
        if (now - last_50hz >= 20) {
            gamepad_ctrl.update();
            last_50hz = now;
        }
        
        // 10Hz: LoRa communication
        if (now - last_10hz >= 100) {
            // Receive telemetry
            PacketTelemetryLoRa_t telemetry;
            if (lora_comm.receiveTelemetry(telemetry)) {
                if (xSemaphoreTake(global_state.mutex, pdMS_TO_TICKS(10))) {
                    global_state.telemetry = telemetry;
                    global_state.last_telemetry_ms = now;
                    xSemaphoreGive(global_state.mutex);
                }
            }
            
            // Send uplink command
            if (xSemaphoreTake(global_state.mutex, pdMS_TO_TICKS(10))) {
                PacketUplinkLoRa_t cmd;
                cmd.sync_header = 0xBB;
                cmd.cmd_roll = global_state.gamepad_roll;
                cmd.cmd_pitch = global_state.gamepad_pitch;
                cmd.cmd_throttle = global_state.gamepad_throttle;
                cmd.cmd_mode = global_state.gamepad_mode;
                cmd.arm_switch = global_state.gamepad_arm_switch;
                cmd.checksum_crc8 = CRC::calculateCRC8((uint8_t*)&cmd, sizeof(PacketUplinkLoRa_t) - 1);
                
                lora_comm.sendUplinkCommand(cmd);
                
                // Send waypoints if dirty
                if (global_state.waypoints_dirty) {
                    for (const auto& wp : global_state.waypoints) {
                        lora_comm.sendWaypoint(wp);
                        vTaskDelay(pdMS_TO_TICKS(50)); // Small delay between waypoints
                    }
                    global_state.waypoints_dirty = false;
                }
                
                xSemaphoreGive(global_state.mutex);
            }
            
            last_10hz = now;
        }
        
        taskYIELD();
    }
}

// CORE 0: Async WiFi and WebSocket communication (5Hz)
void asyncTask(void *parameter) {
    const TickType_t xFrequency_5Hz = pdMS_TO_TICKS(200);
    uint32_t last_broadcast = 0;
    
    while (1) {
        uint32_t now = xTaskGetTickCount() * portTICK_PERIOD_MS;
        
        // 5Hz: WebSocket telemetry broadcast
        if (now - last_broadcast >= 200) {
            ws_server.broadcastTelemetry();
            
            // Update WiFi RSSI
            global_state.wifi_rssi = WiFi.RSSI();
            
            last_broadcast = now;
        }
        
        // Clean up disconnected WebSocket clients
        ws_server.cleanupClients();
        
        vTaskDelay(pdMS_TO_TICKS(50)); // 20Hz loop for responsiveness
    }
}

// =============================================================================
// MAIN SETUP AND LOOP
// =============================================================================

void setup() {
    Serial.begin(115200);
    Serial.println("=== GROUND CONTROL STATION INITIALIZING ===");
    
    // Initialize global state mutex
    global_state.mutex = xSemaphoreCreateMutex();
    if (!global_state.mutex) {
        Serial.println("Failed to create mutex!");
        ESP.restart();
    }
    
    // Initialize LittleFS
    if (!LittleFS.begin(true)) {
        Serial.println("LittleFS initialization failed!");
        ESP.restart();
    }
    
    // Initialize WiFi (Station mode - connect to mobile hotspot)
    WiFi.begin("GCS_Hotspot", "password123"); // Replace with your credentials
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nWiFi connected!");
    Serial.printf("IP address: %s\n", WiFi.localIP().toString().c_str());
    
    // Initialize LoRa
    if (!lora_comm.initialize()) {
        Serial.println("LoRa initialization failed!");
        ESP.restart();
    }
    
    // Initialize Gamepad
    gamepad_ctrl.initialize();
    
    // Initialize WebSocket server
    ws_server.initialize();
    
    // Create FreeRTOS tasks on specific cores
    xTaskCreatePinnedToCore(realTimeTask, "RealTime", 4096, NULL, 3, NULL, 1); // Core 1
    xTaskCreatePinnedToCore(asyncTask, "Async", 4096, NULL, 2, NULL, 0);      // Core 0
    
    Serial.println("=== GCS SYSTEM READY ===");
}

void loop() {
    // Main loop is empty - all work is done in FreeRTOS tasks
    vTaskDelay(pdMS_TO_TICKS(1000));
}