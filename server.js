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
// MySQL
// =====================================================

const db = await mysql.createPool({
  host: "auth-db504.hstgr.io",
  user: "u160886294_erge08",
  password: "KuliJul2025!",
  database: "u160886294_sldata",
  waitForConnections: true,
  connectionLimit: 10
});

console.log("✅ MySQL pool skapad");

// =====================================================
// GTFS-RT proto
// =====================================================

const root = await protobuf.load("gtfs-realtime.proto");
const FeedMessage = root.lookupType("transit_realtime.FeedMessage");

console.log("✅ GTFS-RT proto loaded");

// =====================================================
// Cache
// =====================================================

let cachedFeed = null;
let cachedAt = 0;

const CACHE_TTL = 1500;
const LINE_CACHE_TTL = 10 * 60 * 1000;

const lineCache = new Map();

// =====================================================
// Load GTFS for line
// =====================================================

async function loadGTFSforLine(line) {

  const cached = lineCache.get(line);
  if (cached && Date.now() - cached.ts < LINE_CACHE_TTL)
    return cached.data;

  const [[route]] = await db.query(
    "SELECT route_id, route_type FROM routes WHERE route_short_name = ?",
    [line]
  );

  if (!route) return null;

  const [trips] = await db.query(
    "SELECT trip_id, trip_headsign, shape_id FROM trips WHERE route_id = ?",
    [route.route_id]
  );

  if (!trips.length) return null;

  const tripMap = new Map();
  const tripIds = [];

  for (const t of trips) {
    tripMap.set(t.trip_id, t.trip_headsign);
    tripIds.push(t.trip_id);
  }

  const [stopRows] = await db.query(
    `
    SELECT st.trip_id,
           s.stop_id,
           s.stop_name,
           s.stop_lat,
           s.stop_lon
    FROM stop_times st
    JOIN stops s ON s.stop_id = st.stop_id
    WHERE st.trip_id IN (?)
    `,
    [tripIds]
  );

  const stopTimesByTripId = new Map();

  for (const r of stopRows) {
    if (!stopTimesByTripId.has(r.trip_id))
      stopTimesByTripId.set(r.trip_id, []);

    stopTimesByTripId.get(r.trip_id).push(r);
  }

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
    routeId: route.route_id,
    routeType: route.route_type,
    trips,
    tripMap,
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
// Line endpoint
// =====================================================

app.get("/api/line/:line", async (req, res) => {

  try {

    const line = req.params.line.trim();
    const data = await loadGTFSforLine(line);

    if (!data)
      return res.status(404).json({ error: "Ingen linje" });

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
    console.error(e);
    res.status(500).json({ error: "LINE ERROR" });
  }
});

// =====================================================
// Vehicles endpoint
// =====================================================

app.get("/api/vehicles/:line", async (req, res) => {

  try {

    const line = req.params.line.trim();
    const data = await loadGTFSforLine(line);

    if (!data) return res.json([]);

    const now = Date.now();

    if (!cachedFeed || now - cachedAt > CACHE_TTL) {

      const r = await fetch(GTFS_RT_URL, {
        headers: { Accept: "application/x-protobuf" }
      });

      const buffer = await r.arrayBuffer();

      cachedFeed = FeedMessage.decode(new Uint8Array(buffer));
      cachedAt = now;

      console.log("Realtime feed uppdaterad");
    }

    const tripIdSet = new Set(data.trips.map(t => t.trip_id));

    const vehicles = cachedFeed.entity
      .filter(e => e.vehicle?.position)
      .map(e => {

        const tripId = e.vehicle.trip?.tripId;

        if (!tripIdSet.has(tripId)) return null;

        return {
          id: e.vehicle.vehicle?.id || e.id,
          lat: e.vehicle.position.latitude,
          lon: e.vehicle.position.longitude,
          bearing: e.vehicle.position.bearing ?? 0,
          directionId: e.vehicle.trip?.directionId ?? null,
          routeType: data.routeType,
          destination:
            data.tripMap?.get(tripId) || "Okänd destination"
        };

      })
      .filter(Boolean)
      .filter(v => v.lat && v.lon);

    res.json(vehicles);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "VEHICLE ERROR" });
  }
});

// =====================================================
// Test
// =====================================================

app.get("/api/test", (_, res) =>
  res.json({ ok: true })
);

// =====================================================

app.listen(PORT, () =>
  console.log(`🚍 Backend kör på port ${PORT}`)
);
