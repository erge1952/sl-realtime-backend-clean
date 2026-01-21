import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import protobuf from "protobufjs";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---- SL API ----
const SL_API_KEY = process.env.SL_API_KEY;
if (!SL_API_KEY) {
  console.warn("⚠️ SL_API_KEY saknas");
}

const GTFS_RT_URL =
  `https://opendata.samtrafiken.se/gtfs-rt/sl/VehiclePositions.pb?key=${SL_API_KEY}`;

// ---- Load proto ----
let FeedMessage;
(async () => {
  const root = await protobuf.load("gtfs-realtime.proto");
  FeedMessage = root.lookupType("transit_realtime.FeedMessage");
  console.log("✅ GTFS-RT proto laddad");
})();

// ---- Cache ----
let cachedFeed = null;
let cachedAt = 0;
const CACHE_TTL = 5000;

// ---- Vehicles per line ----
app.get("/api/vehicles/:line", async (req, res) => {
  try {
    const now = Date.now();

    if (!cachedFeed || now - cachedAt > CACHE_TTL) {
      const r = await fetch(GTFS_RT_URL, {
        headers: {
          Accept: "application/x-protobuf"
        }
      });
      const buffer = await r.arrayBuffer();
      cachedFeed = FeedMessage.decode(new Uint8Array(buffer));
      cachedAt = now;
    }

    const line = req.params.line;

    const vehicles = cachedFeed.entity
      .filter(e =>
        e.vehicle?.position &&
        e.vehicle.trip?.routeId === line
      )
      .map(e => ({
        id: e.vehicle.vehicle?.id || e.id,
        lat: e.vehicle.position.latitude,
        lon: e.vehicle.position.longitude,
        bearing: e.vehicle.position.bearing ?? 0
      }));

    res.json(vehicles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "GTFS-RT error" });
  }
});

// ---- Health check ----
app.get("/", (req, res) => {
  res.send("SL Realtime Backend OK 🚍");
});


// ----- TEST: fungerar GTFS-RT på Render? -----
app.get("/api/test/vehicles", async (req, res) => {
    try {
      const r = await fetch(GTFS_RT_URL, {
        headers: {
          Accept: "application/x-protobuf",
          "User-Agent": "SL-Test"
        }
      });
  
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

app.listen(PORT, () =>
  console.log(`🚍 Backend kör på port ${PORT}`)
);
