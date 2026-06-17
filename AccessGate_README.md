# AccessGate Service - Nhận UID RFID từ HiveMQ và xử lý ra/vào

## 1. Mục tiêu

Nhóm **AccessGate** xây dựng service nhận dữ liệu quẹt thẻ RFID dạng **UID raw** từ HiveMQ, đối chiếu với bảng UID được giảng viên cung cấp, sau đó publish kết quả xử lý sang topic tiếp theo cho nhóm Core/Analytics/Notification.

Luồng tổng thể:

```text
Pi RFID Simulator
→ HiveMQ topic: smart-campus/raw/access/rfid-uid
→ AccessGate Service
→ Đối chiếu uid_whitelist.csv
→ HiveMQ topic: smart-campus/events/access
→ Nhóm Core / Analytics / Notification
```

---

## 2. Thông tin kết nối HiveMQ

```text
Broker Host:
f6f78e87db4a4c189dd3d706745a5e93.s1.eu.hivemq.cloud

MQTT Port:
8883

Protocol:
MQTTS / MQTT over TLS

Username:
DVKN2026

Password:
ThaiBao12A@

Input topic:
smart-campus/raw/access/rfid-uid

Output topic:
smart-campus/events/access
```

Nếu dùng MQTT qua WebSocket:

```text
WebSocket URL:
wss://f6f78e87db4a4c189dd3d706745a5e93.s1.eu.hivemq.cloud:8884/mqtt
```

> **Lưu ý bảo mật:** Credential trên dùng riêng cho nhóm AccessGate trong môi trường thực hành. Khi nộp bài, không commit mật khẩu thật vào Git công khai. Hãy dùng file `.env` và `.gitignore` đúng chuẩn.

---

## 3. Nguồn sinh data

Pi RFID Simulator do **giảng viên vận hành, chạy liên tục 24/7** và đẩy event mỗi 10 giây lên topic `smart-campus/raw/access/rfid-uid`.

```text
- Sinh viên KHÔNG cần tự build simulator.
- Sinh viên chỉ subscribe topic, xử lý event và publish kết quả.
- Nếu không nhận được data trong 1-2 phút, kiểm tra:
  1. Kết nối Internet và TLS cert.
  2. Username/password đã đúng chưa.
  3. Tên topic chính xác chưa.
  4. Nếu vẫn không nhận được data, liên hệ giảng viên kiểm tra simulator.
```

Simulator phát đủ các tình huống cần xử lý: UID nằm trong `uid_whitelist.csv`, UID lạ, UID có format khác thường. Tỷ lệ UID hợp lệ/lạ được giảng viên cấu hình để đảm bảo nhóm test được cả nhánh `granted` lẫn `denied`.

---

## 4. Dữ liệu đầu vào

AccessGate subscribe topic:

```text
smart-campus/raw/access/rfid-uid
```

Cứ khoảng **10 giây** sẽ có một sự kiện quẹt thẻ được gửi lên.

Payload mẫu:

```json
{
  "event_id": "raw-rfid-abc123",
  "event_type": "rfid.uid.scanned",
  "source_service": "pi-rfid-simulator",
  "device_id": "rfid-reader-gate-01",
  "timestamp": "2026-06-07T14:30:10+07:00",
  "uid": "04:A1:B2:C3:D4:03",
  "door_id": "gate-a",
  "location": "Main Gate A",
  "direction": "in"
}
```

Lưu ý quan trọng:

```text
- Payload raw chỉ có uid.
- Payload raw không có tên sinh viên.
- Payload raw không có access_result.
- AccessGate phải tự kiểm tra uid.
```

---

## 5. Bảng UID hợp lệ

Giảng viên cung cấp file:

```text
uid_whitelist.csv
```

Cấu trúc:

```csv
student_id,full_name,class_name,uid
SV001,Nguyen Van An,CNTT-K19,04:A1:B2:C3:D4:01
SV002,Tran Thi Binh,CNTT-K19,04:A1:B2:C3:D4:02
SV003,Le Minh Cuong,CNTT-K19,04:A1:B2:C3:D4:03
SV004,Pham Thu Dung,CNTT-K19,04:A1:B2:C3:D4:04
SV005,Hoang Van Hieu,CNTT-K19,04:A1:B2:C3:D4:05
SV006,Do Thi Lan,CNTT-K19,04:A1:B2:C3:D4:06
SV007,Bui Quang Minh,CNTT-K19,04:A1:B2:C3:D4:07
SV008,Vu Thanh Nam,CNTT-K19,04:A1:B2:C3:D4:08
SV009,Dang Phuong Thao,CNTT-K19,04:A1:B2:C3:D4:09
SV010,Nguyen Minh Quan,CNTT-K19,04:A1:B2:C3:D4:10
```

Yêu cầu:

```text
- Đọc danh sách UID hợp lệ từ uid_whitelist.csv.
- Không hard-code toàn bộ danh sách UID trong logic xử lý chính.
- Có thể load file khi service khởi động.
```

---

## 6. Logic xử lý bắt buộc

AccessGate cần thực hiện:

```text
1. Kết nối HiveMQ bằng MQTT over TLS.
2. Subscribe topic smart-campus/raw/access/rfid-uid.
3. Nhận payload JSON.
4. Validate các field bắt buộc:
   - event_id
   - event_type
   - timestamp
   - uid
   - door_id
   - direction
5. Đối chiếu uid với uid_whitelist.csv.
6. Nếu UID tồn tại:
   - access_result = granted
   - reason = uid_matched
   - gắn student_id, full_name, class_name
7. Nếu UID không tồn tại:
   - access_result = denied
   - reason = uid_not_found
   - student_id = null
   - full_name = null
   - class_name = null
8. Publish kết quả sang smart-campus/events/access.
9. Ghi log ra console hoặc database.
```

---

## 7. Dữ liệu đầu ra

AccessGate publish topic:

```text
smart-campus/events/access
```

### 7.1. Payload khi UID hợp lệ

```json
{
  "event_id": "access-event-001",
  "event_type": "access.swipe.processed",
  "source_service": "team-gate",
  "timestamp": "2026-06-07T14:30:11+07:00",
  "raw_event_id": "raw-rfid-abc123",
  "uid": "04:A1:B2:C3:D4:03",
  "student_id": "SV003",
  "full_name": "Le Minh Cuong",
  "class_name": "CNTT-K19",
  "door_id": "gate-a",
  "location": "Main Gate A",
  "direction": "in",
  "access_result": "granted",
  "reason": "uid_matched"
}
```

### 7.2. Payload khi UID lạ

```json
{
  "event_id": "access-event-002",
  "event_type": "access.swipe.processed",
  "source_service": "team-gate",
  "timestamp": "2026-06-07T14:30:11+07:00",
  "raw_event_id": "raw-rfid-xyz789",
  "uid": "7A:9B:11:22:33:04",
  "student_id": null,
  "full_name": null,
  "class_name": null,
  "door_id": "gate-a",
  "location": "Main Gate A",
  "direction": "in",
  "access_result": "denied",
  "reason": "uid_not_found"
}
```

---

## 8. Test nhận dữ liệu bằng Python

Cài thư viện:

```bash
pip install paho-mqtt
```

Code subscribe tối thiểu:

```python
import ssl
from paho.mqtt import client as mqtt

MQTT_HOST = "f6f78e87db4a4c189dd3d706745a5e93.s1.eu.hivemq.cloud"
MQTT_PORT = 8883
MQTT_USERNAME = "DVKN2026"
MQTT_PASSWORD = "ThaiBao12A@"

TOPIC = "smart-campus/raw/access/rfid-uid"


def on_connect(client, userdata, flags, reason_code, properties=None):
    print("Connected:", reason_code)
    client.subscribe(TOPIC, qos=1)


def on_message(client, userdata, message):
    print("Topic:", message.topic)
    print("Payload:", message.payload.decode())


client = mqtt.Client(protocol=mqtt.MQTTv5)
client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
client.tls_set(tls_version=ssl.PROTOCOL_TLS_CLIENT)

client.on_connect = on_connect
client.on_message = on_message

client.connect(MQTT_HOST, MQTT_PORT)
client.loop_forever()
```

Khi triển khai thực tế, nên đẩy credential vào `.env`:

```bash
# .env
MQTT_HOST=f6f78e87db4a4c189dd3d706745a5e93.s1.eu.hivemq.cloud
MQTT_PORT=8883
MQTT_USERNAME=DVKN2026
MQTT_PASSWORD=ThaiBao12A@
```
