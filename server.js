import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import protobuf from "protobufjs";

// ---- Express ----
const app = express();
app.use(cors());
app.use(express.json());

// ---- PORT ----
const PORT = process.env.PORT || 3000;

// ---- SL API ----
const SL_API_KEY = process.env.SL_API_KEY;
if (!SL_API_KEY) console.warn("⚠️ SL_API_KEY saknas");

const GTFS_RT_URL = `https://opendata.samtrafiken.se/gtfs-rt/sl/VehiclePositions.pb?key=${SL_API_KEY}`;

// ---- Load proto ----
let FeedMessage = null;
async function loadProto() {
  const root = await protobuf.load("gtfs-realtime.proto");
  FeedMessage = root.lookupType("transit_realtime.FeedMessage");
  console.log("✅ GTFS-RT proto laddad");
}
await loadProto();

// ---- Cache ----
let cachedFeed = null;
let cachedAt = 0;
const CACHE_TTL = 5000;

// ---- Health check ----
app.get("/", (req, res) => {
  res.send("SL Realtime Backend OK 🚍");
});

// ---- Test route ----
app.get("/api/test", (req, res) => {
  res.json({ ok: true, msg: "Backend fungerar på Render!" });
});

// ---- Vehicles per line ----
app.get("/api/vehicles/:line", async (req, res) => {
  try {
    if (!FeedMessage) return res.status(503).json({ error: "Proto inte redo" });

    const now = Date.now();
    if (!cachedFeed || now - cachedAt > CACHE_TTL) {
      const r = await fetch(GTFS_RT_URL, {
        headers: { Accept: "application/x-protobuf" }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buffer = await r.arrayBuffer();
      cachedFeed = FeedMessage.decode(new Uint8Array(buffer));
      cachedAt = now;
    }

    const line = req.params.line;
    const vehicles = cachedFeed.entity
      .filter(e => e.vehicle?.position && e.vehicle.trip?.routeId === line)
      .map(e => ({
        id: e.vehicle.vehicle?.id || e.id,
        lat: e.vehicle.position.latitude,
        lon: e.vehicle.position.longitude,
        bearing: e.vehicle.position.bearing ?? 0
      }));

    res.json(vehicles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "GTFS-RT error", details: err.message });
  }
});

// ---- Test: GTFS-RT ----
app.get("/api/test/vehicles", async (req, res) => {
  try {
    if (!FeedMessage) return res.status(503).json({ error: "Proto inte redo" });

    const r = await fetch(GTFS_RT_URL, { headers: { Accept: "application/x-protobuf" } });
    const buffer = await r.arrayBuffer();
    const feed = FeedMessage.decode(new Uint8Array(buffer));

    const vehicles = feed.entity
      .filter(e => e.vehicle?.position)
      .slice(0, 10)
      .map(e => ({
        lat: e.vehicle.position.latitude,
        lon: e.vehicle.position.longitude,
        tripId: e.vehicle.trip?.tripId
      }));

    res.json(vehicles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Start server ----
app.listen(PORT, () => console.log(`🚍 Backend kör på port ${PORT}`));
