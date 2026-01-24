// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import protobuf from "protobufjs";
import { parse } from "csv-parse/sync";

const app = express();
app.use(cors({ origin: "https://gerring.com" }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SL_API_KEY = process.env.SL_API_KEY;

const GTFS_RT_URL =
  `https://opendata.samtrafiken.se/gtfs-rt/sl/VehiclePositions.pb?key=${SL_API_KEY}`;
const GTFS_BASE = "https://gerring.com/gtfs-mini/";

// ===================
// GTFS-RT proto
// ===================
let FeedMessage;
const root = await protobuf.load("gtfs-realtime.proto");
FeedMessage = root.lookupType("transit_realtime.FeedMessage");

// ===================
// GTFS-RT cache
// ===================
let cachedFeed = null;
let cachedAt = 0;
const RT_CACHE_TTL = 5000;

// ===================
// GLOBAL static GTFS cache
// ===================
let ROUTES, TRIPS, SHAPES, STOPS, STOP_TIMES;
let staticLoaded = false;

async function loadStaticGTFS() {
  if (staticLoaded) return;

  const load = async (file, columns) => {
    const r = await fetch(`${GTFS_BASE}${file}`);
    const text = await r.text();
    return parse(text, { columns, skip_empty_lines: true, trim: true });
  };

  [ROUTES, TRIPS, SHAPES, STOPS, STOP_TIMES] = await Promise.all([
    load("routes.json", ["route_id", "agency_id", "route_short_name"]),
    load("trips.json", ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"]),
    load("shapes.json", ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"]),
    load("stops.json", ["stop_id", "stop_name", "stop_lat", "stop_lon"]),
    load("stop_times.json", ["trip_id", "stop_id", "stop_sequence"])
  ]);

  staticLoaded = true;
  console.log("Static GTFS loaded");
}

// ===================
// Per-linje cache
// ===================
const lineCache = new Map();
const LINE_TTL = 10 * 60 * 1000;

async function loadGTFSforLine(line) {
  await loadStaticGTFS();

  const cached = lineCache.get(line);
  if (cached && Date.now() - cached.ts < LINE_TTL) return cached.data;

  const route = ROUTES.find(r => r.route_short_name === line);
  if (!route) return null;

  const tripsForLine = TRIPS.filter(t => t.route_id === route.route_id);
  if (!tripsForLine.length) return null;

  // ---- indexering ----
  const tripIdSet = new Set(tripsForLine.map(t => t.trip_id));
  const tripsById = new Map(tripsForLine.map(t => [t.trip_id, t]));

  // ---- shapes per direction ----
  const shapesByDirection = {};
  for (const trip of tripsForLine) {
    if (shapesByDirection[trip.direction_id]) continue;

    const pts = SHAPES
      .filter(s => s.shape_id === trip.shape_id)
      .sort((a, b) => +a.shape_pt_sequence - +b.shape_pt_sequence)
      .map(s => [Number(s.shape_pt_lat), Number(s.shape_pt_lon)]);

    shapesByDirection[trip.direction_id] = pts;
  }

  // ---- stop_times per trip ----
  const stopTimesByTripId = new Map();
  for (const st of STOP_TIMES) {
    if (!tripIdSet.has(st.trip_id)) continue;
    if (!stopTimesByTripId.has(st.trip_id)) stopTimesByTripId.set(st.trip_id, []);
    stopTimesByTripId.get(st.trip_id).push(st);
  }

  // ---- destination cache ----
  const stopsById = new Map(STOPS.map(s => [s.stop_id, s]));
  const lastStopNameByTripId = new Map();

  for (const [tripId, sts] of stopTimesByTripId) {
    const last = sts.reduce((a, b) =>
      +a.stop_sequence > +b.stop_sequence ? a : b
    );
    const stop = stopsById.get(last.stop_id);
    if (stop) lastStopNameByTripId.set(tripId, stop.stop_name);
  }

  const data = {
    route,
    tripsForLine,
    tripIdSet,
    tripsById,
    shapesByDirection,
    stopsById,
    stopTimesByTripId,
    lastStopNameByTripId
  };

  lineCache.set(line, { data, ts: Date.now() });
  return data;
}

// ===================
// ROUTES
// ===================
app.get("/api/line/:line", async (req, res) => {
  const data = await loadGTFSforLine(req.params.line.trim());
  if (!data) return res.status(404).json({ error: "Ingen linje" });

  res.json({
    shapes: data.shapesByDirection
  });
});

app.get("/api/vehicles/:line", async (req, res) => {
  const data = await loadGTFSforLine(req.params.line.trim());
  if (!data) return res.json([]);

  const now = Date.now();
  if (!cachedFeed || now - cachedAt > RT_CACHE_TTL) {
    const r = await fetch(GTFS_RT_URL, {
      headers: { Accept: "application/x-protobuf" }
    });
    const buf = await r.arrayBuffer();
    cachedFeed = FeedMessage.decode(new Uint8Array(buf));
    cachedAt = now;
  }

  const vehicles = cachedFeed.entity
    .filter(e =>
      e.vehicle?.position &&
      data.tripIdSet.has(e.vehicle.trip?.tripId)
    )
    .map(e => {
      const tripId = e.vehicle.trip.tripId;
      const trip = data.tripsById.get(tripId);

      return {
        id: e.vehicle.vehicle?.id || e.id,
        lat: e.vehicle.position.latitude,
        lon: e.vehicle.position.longitude,
        bearing: e.vehicle.position.bearing ?? 0,
        directionId: trip?.direction_id ?? null,
        destination:
          trip?.trip_headsign ||
          data.lastStopNameByTripId.get(tripId) ||
          "Okänd destination"
      };
    });

  res.json(vehicles);
});

app.listen(PORT, () =>
  console.log(`Backend kör på port ${PORT}`)
);