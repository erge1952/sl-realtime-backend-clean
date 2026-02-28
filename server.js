// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import protobuf from "protobufjs";
import mysql from "mysql2/promise";

const app = express();

app.use(cors({
  origin: [
    "https://gerring.com",
    "https://www.gerring.com"
  ]
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;
const SL_API_KEY = process.env.SL_API_KEY;

if (!SL_API_KEY) console.warn("⚠️ SL_API_KEY är inte satt!");

const GTFS_RT_URL =
  `https://opendata.samtrafiken.se/gtfs-rt/sl/VehiclePositions.pb?key=${SL_API_KEY}`;

// =====================================================
// 🔌 MySQL
// =====================================================
const db = await mysql.createPool({
  host: "auth-db504.hstgr.io",
  user: "u160886294_erge08",
  password: "KuliJul2025!", // ⚠️ lägg i env i prod
  database: "u160886294_sldata",
  waitForConnections: true,
  connectionLimit: 10
});

console.log("✅ MySQL pool skapad");

// =====================================================
// 📦 GTFS-RT proto
// =====================================================
let FeedMessage;
{
  const root = await protobuf.load("gtfs-realtime.proto");
  FeedMessage = root.lookupType("transit_realtime.FeedMessage");
  console.log("✅ GTFS-RT proto loaded");
}

// =====================================================
// ⏱ Cache GTFS-RT
// =====================================================
let cachedFeed = null;
let cachedAt = 0;
const CACHE_TTL = 1500;

// =====================================================
// 🧠 Cache per linje
// =====================================================
const lineCache = new Map();
const LINE_CACHE_TTL = 10 * 60 * 1000;

// =====================================================
// 🚍 Hämta GTFS-data för linje (utan tider)
// =====================================================
async function loadGTFSforLine(line) {
  const cached = lineCache.get(line);
  if (cached && Date.now() - cached.ts < LINE_CACHE_TTL) return cached.data;

  // route
  const [[route]] = await db.query(
    "SELECT route_id, route_type FROM routes WHERE route_short_name = ?",
    [line]
  );
  if (!route) return null;

  // trips
  const [trips] = await db.query(
    "SELECT trip_id, trip_headsign, direction_id, shape_id FROM trips WHERE route_id = ?",
    [route.route_id]
  );
  if (!trips.length) return null;

  const tripIds = trips.map(t => t.trip_id);

  // stop_times + stops (ENDST minimal version)
  const [stopRows] = await db.query(
    `
    SELECT
      st.trip_id,
      st.stop_sequence,
      s.stop_id,
      s.stop_name,
      s.stop_lat,
      s.stop_lon
    FROM stop_times st
    JOIN stops s ON s.stop_id = st.stop_id
    WHERE st.trip_id IN (?)
    ORDER BY st.trip_id, st.stop_sequence
    `,
    [tripIds]
  );

  const stopTimesByTripId = new Map();
  for (const r of stopRows) {
    if (!stopTimesByTripId.has(r.trip_id)) {
      stopTimesByTripId.set(r.trip_id, []);
    }
    stopTimesByTripId.get(r.trip_id).push(r);
  }

  // shape
  const shapeId = trips[0].shape_id;
  const [shapeRows] = await db.query(
    `
    SELECT shape_pt_lat, shape_pt_lon
    FROM shapes
    WHERE shape_id = ?
    ORDER BY shape_pt_sequence
    `,
    [shapeId]
  );

  const data = {
    routeType: route.route_type,
    trips,
    stopTimesByTripId,
    shape: shapeRows.map(r => [
      Number(r.shape_pt_lat),
      Number(r.shape_pt_lon)
    ])
  };

  lineCache.set(line, { data, ts: Date.now() });
  return data;
}

// =====================================================
// 🗺 /api/line/:line
// =====================================================
app.get("/api/line/:line", async (req, res) => {
  try {
    const line = req.params.line.trim();
    const data = await loadGTFSforLine(line);
    if (!data) return res.status(404).json({ error: "Ingen linje" });

    const stopsOut = [];
    const seen = new Set();

    for (const sts of data.stopTimesByTripId.values()) {
      for (const s of sts) {
        if (seen.has(s.stop_id)) continue;
        seen.add(s.stop_id);
        stopsOut.push({
          lat: Number(s.stop_lat),
          lon: Number(s.stop_lon),
          name: s.stop_name
        });
      }
    }

    res.json({
      shape: data.shape,
      stops: stopsOut,
      routeType: data.routeType
    });

  } catch (e) {
    console.error("LINE ERROR:", e);
    res.status(500).json({ error: "Kunde inte hämta linje" });
  }
});

// =====================================================
// 🚐 /api/vehicles/:line
// =====================================================
app.get("/api/vehicles/:line", async (req, res) => {
  try {
    const line = req.params.line.trim();
    const data = await loadGTFSforLine(line);
    if (!data) return res.json([]);

    const tripIds = data.trips.map(t => t.trip_id);

    // destination per trip (sista hållplatsen)
    const lastStopNameByTripId = new Map();
    for (const [tripId, sts] of data.stopTimesByTripId) {
      const last = sts[sts.length - 1];
      lastStopNameByTripId.set(tripId, last.stop_name);
    }

    // GTFS-RT cache
    const now = Date.now();
    if (!cachedFeed || now - cachedAt > CACHE_TTL) {
      const r = await fetch(GTFS_RT_URL, {
        headers: { Accept: "application/x-protobuf" }
      });
      const buffer = await r.arrayBuffer();
      cachedFeed = FeedMessage.decode(new Uint8Array(buffer));
      cachedAt = now;
    }

    const vehicles = cachedFeed.entity
      .filter(e =>
        e.vehicle?.position &&
        tripIds.includes(e.vehicle.trip?.tripId)
      )
      .map(e => {
        const tripId = e.vehicle.trip.tripId;
        const trip = data.trips.find(t => t.trip_id === tripId);

        return {
          id: e.vehicle.vehicle?.id || e.id,
          lat: e.vehicle.position.latitude,
          lon: e.vehicle.position.longitude,
          bearing: e.vehicle.position.bearing ?? 0,
          directionId: e.vehicle.trip.directionId ?? null,
          routeType: data.routeType,
          destination:
            trip?.trip_headsign ||
            lastStopNameByTripId.get(tripId) ||
            "Okänd destination"
        };
      });

    res.json(vehicles);

  } catch (e) {
    console.error("VEHICLE ERROR:", e);
    res.status(500).json({ error: "Kunde inte hämta fordon" });
  }
});

// =====================================================
// 🔎 Test
// =====================================================
app.get("/api/test", (_, res) =>
  res.json({ ok: true, msg: "Backend fungerar  🎉" })
);

app.listen(PORT, () =>
  console.log(`🚍 Backend kör på port ${PORT}`)
);
