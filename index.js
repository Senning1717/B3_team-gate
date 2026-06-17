const axios = require('axios');
const express = require('express');
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mqtt = require('mqtt');

// =======================
// Environment variables
// =======================
const MQTT_HOST = process.env.MQTT_HOST;
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '8883', 10);
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

const INPUT_TOPIC = process.env.INPUT_TOPIC || 'smart-campus/raw/access/rfid-uid';
const OUTPUT_TOPIC = process.env.OUTPUT_TOPIC || 'smart-campus/events/access';
const SOURCE_SERVICE = process.env.SOURCE_SERVICE || 'team-gate';
const WHITELIST_FILE = process.env.WHITELIST_FILE || 'Acessgate_uid_whitelist.csv';

const HTTP_PORT = process.env.HTTP_PORT || 3000;

// Core Business
const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || '';
const CORE_ACCESS_CHECK_ENDPOINT = process.env.CORE_ACCESS_CHECK_ENDPOINT || '/access/check';
const CORE_AUTH_TOKEN = process.env.CORE_AUTH_TOKEN || 'lab-token';

// =======================
// Whitelist storage
// =======================
const whitelist = new Map();

function normalizeUid(uid) {
  if (!uid) return '';
  return uid.replace(/[:\s-]/g, '').toUpperCase();
}

function getLocalTimestamp() {
  const now = new Date();
  const tzOffsetMin = now.getTimezoneOffset();
  const tzOffsetMs = tzOffsetMin * 60000;

  const localTime = new Date(now.getTime() - tzOffsetMs);
  const localISO = localTime.toISOString();
  const formattedDateTime = localISO.slice(0, 19);

  const sign = tzOffsetMin > 0 ? '-' : '+';
  const absOffsetMin = Math.abs(tzOffsetMin);
  const hours = String(Math.floor(absOffsetMin / 60)).padStart(2, '0');
  const minutes = String(absOffsetMin % 60).padStart(2, '0');

  return `${formattedDateTime}${sign}${hours}:${minutes}`;
}

// =======================
// Load whitelist CSV
// =======================
function loadWhitelist() {
  const filePath = path.resolve(__dirname, WHITELIST_FILE);
  console.log(`[INIT] Loading whitelist from: ${filePath}`);

  try {
    if (!fs.existsSync(filePath)) {
      console.error(`[ERROR] Whitelist file not found at ${filePath}`);
      process.exit(1);
    }

    const data = fs.readFileSync(filePath, 'utf8');
    const lines = data.split(/\r?\n/);

    let count = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(',');

      if (parts.length >= 4) {
        const student_id = parts[0].trim();
        const full_name = parts[1].trim();
        const class_name = parts[2].trim();
        const uid = parts[3].trim();

        const normalized = normalizeUid(uid);

        whitelist.set(normalized, {
          student_id,
          full_name,
          class_name,
          uid
        });

        count++;
      }
    }

    console.log(`[INIT] Successfully loaded ${count} student records from whitelist.`);
  } catch (error) {
    console.error(`[ERROR] Failed to read or parse whitelist file:`, error.message);
    process.exit(1);
  }
}

loadWhitelist();

// =======================
// Mapping + call Core Business API
// =======================
async function callCoreAccessCheck(payload) {
  if (!CORE_SERVICE_URL) {
    console.warn('[CORE] CORE_SERVICE_URL is not configured. Skipping Core integration.');
    return null;
  }

  // Mapping dữ liệu từ Access Gate sang contract của Core Business
  const corePayload = {
    cardId: payload.uid,
    gateId: payload.door_id,
    direction: String(payload.direction || '').toUpperCase(),
    timestamp: payload.timestamp
  };

  try {
    console.log(`[CORE] POST ${CORE_SERVICE_URL}${CORE_ACCESS_CHECK_ENDPOINT}`);
    console.log('[CORE] Request payload:', JSON.stringify(corePayload, null, 2));

    const response = await axios.post(
      `${CORE_SERVICE_URL}${CORE_ACCESS_CHECK_ENDPOINT}`,
      corePayload,
      {
        timeout: 3000,
        headers: {
          Authorization: `Bearer ${CORE_AUTH_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('[CORE] Response:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.error('[CORE] Access check failed:', error.message);

    return {
      decision: 'UNKNOWN',
      decisionId: null,
      policyId: null,
      reasonCode: 'CORE_UNAVAILABLE',
      reasonDetail: error.message
    };
  }
}

// =======================
// MQTT connection
// =======================
console.log(`[MQTT] Connecting to HiveMQ Broker: mqtts://${MQTT_HOST}:${MQTT_PORT}...`);

const client = mqtt.connect({
  host: MQTT_HOST,
  port: MQTT_PORT,
  protocol: 'mqtts',
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  rejectUnauthorized: true,
  reconnectPeriod: 5000,
  connectTimeout: 10000
});

client.on('connect', () => {
  console.log('[MQTT] Successfully connected to HiveMQ Broker.');

  client.subscribe(INPUT_TOPIC, { qos: 1 }, (err) => {
    if (err) {
      console.error(`[MQTT] Failed to subscribe to topic "${INPUT_TOPIC}":`, err.message);
    } else {
      console.log(`[MQTT] Subscribed to input topic: "${INPUT_TOPIC}"`);
    }
  });
});

client.on('reconnect', () => {
  console.log('[MQTT] Attempting to reconnect...');
});

client.on('offline', () => {
  console.warn('[MQTT] Client went offline.');
});

client.on('error', (err) => {
  console.error('[MQTT] Connection error:', err.message);
});

// =======================
// Process incoming MQTT messages
// =======================
client.on('message', async (topic, message) => {
  if (topic !== INPUT_TOPIC) return;

  const rawMessage = message.toString();

  console.log(`\n--- [INCOMING] New message received at ${new Date().toLocaleTimeString()} ---`);
  console.log(`Topic: ${topic}`);
  console.log(`Payload: ${rawMessage}`);

  let payload;

  try {
    payload = JSON.parse(rawMessage);
  } catch (err) {
    console.error('[ERROR] Failed to parse message payload as JSON:', err.message);
    return;
  }

  const requiredFields = [
    'event_id',
    'event_type',
    'timestamp',
    'uid',
    'door_id',
    'direction'
  ];

  const missingFields = requiredFields.filter((field) => !payload[field]);

  if (missingFields.length > 0) {
    console.error(`[VALIDATION ERROR] Missing mandatory field(s): ${missingFields.join(', ')}. Message ignored.`);
    return;
  }

  const inputUid = payload.uid;
  const normalizedUid = normalizeUid(inputUid);
  const student = whitelist.get(normalizedUid);

  let access_result;
  let reason;
  let student_id;
  let full_name;
  let class_name;

  if (student) {
    access_result = 'granted';
    reason = 'uid_matched';
    student_id = student.student_id;
    full_name = student.full_name;
    class_name = student.class_name;

    console.log(`[MATCH] UID: ${inputUid} -> MATCHED: ${full_name} (${student_id}, ${class_name})`);
  } else {
    access_result = 'denied';
    reason = 'uid_not_found';
    student_id = null;
    full_name = null;
    class_name = null;

    console.log(`[NO MATCH] UID: ${inputUid} -> NOT FOUND in whitelist.`);
  }

  // Gọi Core Business sau khi Access Gate xử lý whitelist
  const coreDecision = await callCoreAccessCheck(payload);
  if (coreDecision?.decision === 'DENY') 
  {
    access_result = 'denied';
    reason = coreDecision.reasonCode || 'core_denied';
  }

  if (coreDecision?.decision === 'ALLOW' && student) {
    access_result = 'granted';
    reason = coreDecision.reasonCode || 'core_allowed';
  }

  const responseEvent = {
    event_id: `access-event-${crypto.randomUUID()}`,
    event_type: 'access.swipe.processed',
    source_service: SOURCE_SERVICE,
    timestamp: getLocalTimestamp(),
    raw_event_id: payload.event_id,

    uid: inputUid,
    student_id,
    full_name,
    class_name,

    door_id: payload.door_id,
    location: payload.location || null,
    direction: payload.direction,

    access_result,
    reason,

    core_decision: coreDecision?.decision || null,
    core_decision_id: coreDecision?.decisionId || null,
    core_policy_id: coreDecision?.policyId || null,
    core_reason_code: coreDecision?.reasonCode || null,
    core_reason_detail: coreDecision?.reasonDetail || null
  };

  client.publish(OUTPUT_TOPIC, JSON.stringify(responseEvent), { qos: 1 }, (err) => {
    if (err) {
      console.error('[MQTT] Failed to publish result:', err.message);
    } else {
      console.log(`[OUTGOING] Published response to topic "${OUTPUT_TOPIC}":`);
      console.log(JSON.stringify(responseEvent, null, 2));
    }
  });
});

// =======================
// HTTP health endpoint
// =======================
const app = express();

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'access-gate',
    mqtt_connected: client.connected,
    whitelist_records: whitelist.size,
    input_topic: INPUT_TOPIC,
    output_topic: OUTPUT_TOPIC,
    core_service_url: CORE_SERVICE_URL || null,
    core_endpoint: CORE_ACCESS_CHECK_ENDPOINT,
    timestamp: getLocalTimestamp()
  });
});

app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Health endpoint running at http://localhost:${HTTP_PORT}/health`);
});