# 🤖 Twilio ↔ OpenAI Realtime Voice Assistant

Twilio telefon aramaları üzerinden OpenAI Realtime API (gpt-realtime) ile gerçek zamanlı sesli asistan.

## 🏗️ Mimari

```
Kullanıcı (Telefon)
     │
     ▼
  Twilio
     │ WebSocket (μ-law 8kHz)
     ▼
  Server (Express + WS)
     │ WebSocket (μ-law 8kHz)
     ▼
  OpenAI Realtime API
  (gpt-realtime)
```

## 📦 Kurulum

```bash
npm install
```

## ⚙️ Yapılandırma

`.env` dosyasını düzenleyin:

```env
OPENAI_API_KEY=sk-proj-...
PORT=3000
SYSTEM_PROMPT=Sen yardımsever bir sesli asistansın...
```

## 🚀 Çalıştırma

### 1. Sunucuyu başlat
```bash
npm start
```

### 2. ngrok ile dışarı aç
```bash
ngrok http 3000
```

### 3. Twilio'yu yapılandır
1. [Twilio Console](https://console.twilio.com/) → Phone Numbers → Manage → Active Numbers
2. Telefon numaranızı seçin
3. **Voice & Fax** → **A Call Comes In** bölümünde:
   - **Webhook** seçin
   - URL: `https://<ngrok-url>/incoming-call`
   - Method: **HTTP POST**
4. Kaydedin

### 4. Arayın! 📞
Twilio numaranızı arayın ve AI asistanla konuşun.

## 📁 Dosya Yapısı

```
call/
├── .env          # Ortam değişkenleri
├── server.js     # Ana sunucu (Express + WebSocket)
├── package.json  # Bağımlılıklar
└── README.md     # Bu dosya
```

## 🔑 Nasıl Çalışır?

1. **Twilio Webhook**: Arama geldiğinde `/incoming-call` endpoint'ine POST yapılır
2. **TwiML Response**: Twilio'ya `<Connect><Stream>` TwiML ile cevap verilir
3. **WebSocket Bağlantısı**: Twilio Media Streams, `/media-stream` path'inde WebSocket bağlantısı kurar
4. **OpenAI Bridge**: Sunucu, OpenAI Realtime API'ye (`wss://api.openai.com/v1/realtime`) ayrı bir WebSocket bağlantısı açar
5. **Audio Streaming**: 
   - Twilio → Server → OpenAI (kullanıcının sesi, μ-law base64)
   - OpenAI → Server → Twilio (AI yanıtı, μ-law base64)
6. **VAD**: OpenAI'nin `semantic_vad` özelliği ile kullanıcı konuşmasını otomatik algılar
7. **Interrupt**: Kullanıcı konuşmaya başladığında AI'ın oynatılan sesi temizlenir

## 🎙️ Ses Formatı

- **Codec**: G.711 μ-law (mulaw)
- **Sample Rate**: 8000 Hz
- **Channels**: Mono
- **Encoding**: Base64

Twilio ve OpenAI Realtime API her ikisi de G.711 μ-law formatını desteklediğinden, ek format dönüşümü gerekmez.

## 🔧 Özelleştirme

### Ses Değiştirme
`server.js` dosyasında `voice` alanını değiştirin:
- `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, `shimmer`, `verse`

### Dil Değiştirme  
`.env` dosyasındaki `SYSTEM_PROMPT`'u değiştirin.

### Turn Detection
`semantic_vad` yerine `server_vad` kullanabilirsiniz:
```json
"turn_detection": {
  "type": "server_vad",
  "threshold": 0.5,
  "prefix_padding_ms": 300,
  "silence_duration_ms": 500
}
```
