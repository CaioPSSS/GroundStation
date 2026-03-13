#include <Arduino.h>
#include <LoRa.h>
#include <Bluepad32.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <ArduinoJson.h>
#include <vector>

// =============================================================================
// BLUEPAD32 GLOBAL CONTROLLER POINTER
// =============================================================================

// Global controller pointer for callback compatibility
ControllerPtr myGamepad = nullptr;

// =============================================================================
// PROTOCOL DEFINITIONS - AERONAUTICAL PRECISION
// =============================================================================

// Pacote recebido da Asa Voadora (Telemetria Otimizada - 23 Bytes)
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
    uint8_t   ground_speed_ms;  // Ground Speed em m/s (NOVO)
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
    int32_t lora_rssi;
    
    // Mission waypoints
    std::vector<PacketWaypointLoRa_t> waypoints;
    bool waypoints_dirty;
    
    // Serial communication
    String serialInputBuffer;
    
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
        // CRÍTICO: Transmissão assíncrona para não bloquear o loop em tempo real
        return LoRa.endPacket(true); // true = async mode
    }
    
    bool sendWaypoint(const PacketWaypointLoRa_t &wp) {
        LoRa.beginPacket();
        LoRa.write((uint8_t*)&wp, sizeof(PacketWaypointLoRa_t));
        // Transmissão assíncrona para não bloquear o sistema
        return LoRa.endPacket(true); // true = async mode
    }
    
    bool receiveTelemetry(PacketTelemetryLoRa_t &telemetry) {
        int packetSize = LoRa.parsePacket();
        // Atualizado para 23 bytes com ground_speed_ms
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
// SERIAL COMMUNICATION CLASS - USB TELEMETRY
// =============================================================================

class SerialComm {
public:
    void initialize() {
        Serial.begin(115200);
        Serial.println("Serial communication initialized");
    }
    
    void broadcastTelemetry() {
        if (!xSemaphoreTake(global_state.mutex, pdMS_TO_TICKS(10))) {
            return;
        }
        
        DynamicJsonDocument doc(512);
        doc["type"] = "telemetry";
        doc["fsm_state"] = global_state.telemetry.fsm_state;
        doc["altitude_m"] = global_state.telemetry.altitude_cm / 100.0f;
        doc["roll_deg"] = global_state.telemetry.roll_deg_10 / 10.0f;
        doc["pitch_deg"] = global_state.telemetry.pitch_deg_10 / 10.0f;
        doc["heading_deg"] = global_state.telemetry.heading_deg_10 / 10.0f;
        doc["latitude"] = global_state.telemetry.latitude_gps / 10000000.0;
        doc["longitude"] = global_state.telemetry.longitude_gps / 10000000.0;
        doc["battery_v"] = global_state.telemetry.battery_volt_mv / 1000.0f;
        doc["ground_speed_ms"] = global_state.telemetry.ground_speed_ms;
        doc["rssi_uplink"] = global_state.telemetry.rssi_uplink;
        
        // Gamepad status
        JsonObject gamepad = doc.createNestedObject("gamepad");
        gamepad["connected"] = global_state.gamepad_connected;
        gamepad["battery"] = global_state.gamepad_battery;
        
        // System status
        JsonObject system = doc.createNestedObject("system");
        system["lora_rssi"] = global_state.lora_rssi;
        
        xSemaphoreGive(global_state.mutex);
        
        String jsonString;
        serializeJson(doc, jsonString);
        Serial.println(jsonString);
    }
    
    void processSerialCommands() {
        while (Serial.available()) {
            char c = Serial.read();
            if (c == '\n') {
                if (global_state.serialInputBuffer.length() > 0) {
                    processCommand(global_state.serialInputBuffer);
                    global_state.serialInputBuffer = "";
                }
            } else if (c >= 32 && c <= 126) { // Printable characters only
                global_state.serialInputBuffer += c;
                if (global_state.serialInputBuffer.length() > 512) {
                    global_state.serialInputBuffer = ""; // Prevent buffer overflow
                }
            }
        }
    }
    
private:
    void processCommand(const String& command) {
        DynamicJsonDocument doc(1024);
        DeserializationError error = deserializeJson(doc, command);
        
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
            packet.lat_e7 = wp["lat"].as<double>() * 10000000;
            packet.lon_e7 = wp["lon"].as<double>() * 10000000;
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
// GAMEPAD CONTROLLER CLASS - BLUEPAD32 INTEGRATION (CORRECTED)
// =============================================================================

class GamepadController {
public:
    void initialize() {
        BP32.setup(
            [](ControllerPtr ctl) { // Callback de conexão
                Serial.println("Controle Conectado!");
                if (myGamepad == nullptr) {
                    myGamepad = ctl;
                }
            },
            [](ControllerPtr ctl) { // Callback de desconexão
                Serial.println("Controle Desconectado!");
                if (myGamepad == ctl) {
                    myGamepad = nullptr;
                    global_state.gamepad_connected = false;
                }
            }
        );
    }
    
    void update() {
        // ESSENCIAL: O Bluepad32 precisa atualizar o estado interno primeiro
        bool dataUpdated = BP32.update();
        
        if (myGamepad && myGamepad->isConnected()) {
            global_state.gamepad_connected = true;

            // Lendo os eixos (-511 a 512 no padrão atual do Bluepad32)
            int32_t axis_x = myGamepad->axisX();
            int32_t axis_y = myGamepad->axisY();
            int32_t throttle_axis = myGamepad->throttle(); // Gatilho R2
            
            // Convertendo para o seu range -100 a 100
            global_state.gamepad_roll = constrain(map(axis_x, -511, 512, -100, 100), -100, 100);
            global_state.gamepad_pitch = constrain(map(axis_y, -511, 512, -100, 100), -100, 100);
            global_state.gamepad_throttle = constrain(map(throttle_axis, 0, 1023, 0, 100), 0, 100);
            
            // D-PAD
            uint8_t dpad = myGamepad->dpad();
            if (dpad == DPAD_UP) global_state.gamepad_mode = 0;
            else if (dpad == DPAD_RIGHT) global_state.gamepad_mode = 1;
            else if (dpad == DPAD_DOWN) global_state.gamepad_mode = 2;
            else if (dpad == DPAD_LEFT) global_state.gamepad_mode = 3;
            
            // Arm/disarm com Botão A
            static bool last_a_state = false;
            bool current_a_state = myGamepad->a();
            if (current_a_state && !last_a_state) {
                global_state.gamepad_arm_switch = !global_state.gamepad_arm_switch;
            }
            last_a_state = current_a_state;
            
            global_state.gamepad_battery = myGamepad->battery();
            global_state.last_gamepad_ms = millis();
        } else {
            global_state.gamepad_connected = false;
        }
    }
};

// =============================================================================
// FREERTOS TASKS - REAL-TIME EXECUTION
// =============================================================================

LoRaComm lora_comm;
SerialComm serial_comm;
GamepadController gamepad_ctrl;

// CORE 1: Real-time Bluetooth and LoRa communication (50Hz/10Hz)
void realTimeTask(void *parameter) {
    // Frequência base de 50Hz (20ms)
    const TickType_t xFrequency = pdMS_TO_TICKS(20);
    TickType_t xLastWakeTime = xTaskGetTickCount();
    
    uint8_t loop_counter = 0; // Para trigar coisas a 10Hz dentro do loop de 50Hz
    
    while (1) {
        // 1. Atualiza Gamepad (50Hz)
        gamepad_ctrl.update();
        
        // 2. Lida com LoRa (10Hz) - Acontece a cada 5 loops de 50Hz
        if (loop_counter >= 5) {
            loop_counter = 0;
            
            // Receive telemetry
            PacketTelemetryLoRa_t telemetry;
            if (lora_comm.receiveTelemetry(telemetry)) {
                if (xSemaphoreTake(global_state.mutex, pdMS_TO_TICKS(10))) {
                    global_state.telemetry = telemetry;
                    global_state.last_telemetry_ms = millis();
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
                
                // CRÍTICO: Copiar waypoints localmente e liberar Mutex ANTES dos delays
                std::vector<PacketWaypointLoRa_t> waypoints_to_send;
                if (global_state.waypoints_dirty) {
                    waypoints_to_send = global_state.waypoints; // Cópia em RAM
                    global_state.waypoints_dirty = false;
                }
                
                xSemaphoreGive(global_state.mutex); // LIBERA O MUTEX AQUI!
                
                // Transmite livremente sem travar o resto do sistema
                for (const auto& wp : waypoints_to_send) {
                    lora_comm.sendWaypoint(wp);
                    vTaskDelay(pdMS_TO_TICKS(50)); // Delay seguro fora do Mutex
                }
            }
        }
        loop_counter++;
        
        // Coloca a task para dormir estritamente até o próximo ciclo de 20ms
        vTaskDelayUntil(&xLastWakeTime, xFrequency);
    }
}

// CORE 0: Serial communication and telemetry broadcast (5Hz)
void serialTask(void *parameter) {
    const TickType_t xFrequency_5Hz = pdMS_TO_TICKS(200);
    TickType_t xLastWakeTime = xTaskGetTickCount();
    
    while (1) {
        // 5Hz: Serial telemetry broadcast
        serial_comm.broadcastTelemetry();
        
        // Process incoming serial commands (non-blocking)
        serial_comm.processSerialCommands();
        
        // Coloca a task para dormir estritamente até o próximo ciclo de 200ms
        vTaskDelayUntil(&xLastWakeTime, xFrequency_5Hz);
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
    
    // Initialize Serial communication
    serial_comm.initialize();
    
    // Initialize LoRa
    if (!lora_comm.initialize()) {
        Serial.println("LoRa initialization failed!");
        //ESP.restart();
    }
    
    // Initialize Gamepad
    gamepad_ctrl.initialize();
    
    // Create FreeRTOS tasks on specific cores
    xTaskCreatePinnedToCore(realTimeTask, "RealTime", 8192, NULL, 3, NULL, 1); // Core 1
    xTaskCreatePinnedToCore(serialTask, "Serial", 4096, NULL, 2, NULL, 0);    // Core 0
    
    Serial.println("=== GCS SYSTEM READY ===");
}

void loop() {
    // Main loop is empty - all work is done in FreeRTOS tasks
    vTaskDelay(pdMS_TO_TICKS(1000));
}