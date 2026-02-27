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
// MySQL pool
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
// Proto loader
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

const lineCache = new Map();
const LINE_CACHE_TTL = 10 * 60 * 1000;

// =====================================================
// GTFS loader
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
    `SELECT trip_id, trip_headsign, shape_id
     FROM trips
     WHERE route_id = ?`,
    [route.route_id]
  );

  if (!trips.length) return null;

  const tripIds = trips.map(t => t.trip_id);

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
    stopTimesByTripId,
    tripIdSet: new Set(trips.map(t => t.trip_id)),
    shape: shapeRows.map(r => [
      Number(r.shape_pt_lat),
      Number(r.shape_pt_lon)
    ])
  };

  lineCache.set(line, { data, ts: Date.now() });

  return data;
}

// =====================================================
// Vehicles API
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

    const tripMap = new Map(
      data.trips.map(t => [t.trip_id, t])
    );

    const destinationMap = new Map();

    for (const [tripId, sts] of data.stopTimesByTripId) {
      if (sts?.length)
        destinationMap.set(tripId, sts[sts.length - 1].stop_name);
    }

    const tripIdSet = data.tripIdSet;

    const vehicles = (cachedFeed?.entity || [])
      .filter(e => {
        if (!e.vehicle?.position) return false;

        const tripId = e.vehicle.trip?.tripId;
        return tripId && tripIdSet.has(tripId);
      })
      .map(e => {
        const tripId = e.vehicle.trip?.tripId;

        const trip = tripId ? tripMap.get(tripId) : null;

        return {
          id: e.vehicle.vehicle?.id || e.id,
          lat: e.vehicle.position.latitude,
          lon: e.vehicle.position.longitude,
          bearing: e.vehicle.position.bearing ?? 0,
          directionId: e.vehicle.trip?.directionId ?? null,
          routeType: data.routeType,
          destination:
            trip?.trip_headsign ||
            destinationMap.get(tripId) ||
            "Okänd destination"
        };
      })
      .filter(v =>
        typeof v.lat === "number" &&
        typeof v.lon === "number"
      );

    res.json(vehicles);

  } catch (err) {
    console.error("VEHICLE ERROR:", err);
    res.status(500).json({ error: "Kunde inte hämta fordon" });
  }
});

// =====================================================
// Health check
// =====================================================

app.get("/api/test", (_, res) =>
  res.json({ ok: true })
);

// =====================================================
// Start server
// =====================================================

app.listen(PORT, () =>
  console.log(`🚍 Backend kör på port ${PORT}`)
);
