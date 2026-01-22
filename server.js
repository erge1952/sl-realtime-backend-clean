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
if (!SL_API_KEY) console.warn("⚠️ SL_API_KEY är inte satt!");

const GTFS_RT_URL = `https://opendata.samtrafiken.se/gtfs-rt/sl/VehiclePositions.pb?key=${SL_API_KEY}`;
const GTFS_BASE = "https://gerring.com/gtfs/"; // ✅ Alla linjer

// ----- GTFS-RT proto -----
let FeedMessage;
await (async () => {
  const root = await protobuf.load("gtfs-realtime.proto");
  FeedMessage = root.lookupType("transit_realtime.FeedMessage");
  console.log("✅ GTFS-RT proto loaded");
})();

// ----- GTFS-RT cache -----
let cachedFeed = null;
let cachedAt = 0;
const CACHE_TTL = 5000;

// ----- Hjälpfunktioner -----
async function loadCSVfromURL(url, columns) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  const text = await r.text();
  return parse(text, { columns, skip_empty_lines: true, trim: true });
}

// ----- Ladda alla GTFS-data -----
let allGTFS = null;

async function loadAllGTFS() {
  if (allGTFS) return allGTFS; // cache

  const [routes, trips, shapes, stops, stopTimes] = await Promise.all([
    loadCSVfromURL(`${GTFS_BASE}routes.json`, ["route_id","agency_id","route_short_name","route_long_name","route_type","route_desc"]),
    loadCSVfromURL(`${GTFS_BASE}trips.json`, ["route_id","service_id","trip_id","trip_headsign","direction_id","shape_id"]),
    loadCSVfromURL(`${GTFS_BASE}shapes.json`, ["shape_id","shape_pt_lat","shape_pt_lon","shape_pt_sequence","shape_dist_traveled"]),
    loadCSVfromURL(`${GTFS_BASE}stops.json`, ["stop_id","stop_name","stop_lat","stop_lon","location_type","parent_station","platform_code"]),
    loadCSVfromURL(`${GTFS_BASE}stop_times.json`, [
      "trip_id","arrival_time","departure_time","stop_id","stop_sequence","stop_headsign",
      "pickup_type","drop_off_type","shape_dist_traveled","timepoint",
      "pickup_booking_rule_id","drop_off_booking_rule_id"
    ])
  ]);

  // Indexering
  const tripsByRouteId = new Map();
  const tripsById = new Map();
  const stopTimesByTripId = new Map();
  const stopsById = new Map();

  for (const s of stops) stopsById.set(s.stop_id, s);

  for (const t of trips) {
    tripsById.set(t.trip_id, t);
    if (!tripsByRouteId.has(t.route_id)) tripsByRouteId.set(t.route_id, []);
    tripsByRouteId.get(t.route_id).push(t);
  }

  for (const st of stopTimes) {
    if (!stopTimesByTripId.has(st.trip_id)) stopTimesByTripId.set(st.trip_id, []);
    stopTimesByTripId.get(st.trip_id).push(st);
  }

  // Slutstation per trip
  const lastStopNameByTripId = new Map();
  for (const [tripId, sts] of stopTimesByTripId) {
    const last = sts.reduce((a,b) => Number(a.stop_sequence) > Number(b.stop_sequence) ? a : b);
    const stop = stopsById.get(last.stop_id);
    if (stop) lastStopNameByTripId.set(tripId, stop.stop_name);
  }

  allGTFS = { routes, trips, shapes, stops, stopTimes, tripsByRouteId, tripsById, stopTimesByTripId, stopsById, lastStopNameByTripId };
  return allGTFS;
}

// ----- Route: linje + hållplatser -----
app.get("/api/line/:line", async (req,res) => {
  try {
    const line = req.params.line.trim();
    const { routes, tripsByRouteId, shapes, stopsById, stopTimesByTripId } = await loadAllGTFS();

    const route = routes.find(r => r.route_short_name === line);
    if (!route) return res.status(404).json({ error: "Ingen linje" });

    const tripsForLine = tripsByRouteId.get(route.route_id);
    if (!tripsForLine?.length) return res.status(404).json({ error: "Ingen trip för linjen" });

    const shapeId = tripsForLine[0].shape_id;
    const shape = shapes
      .filter(s => s.shape_id === shapeId)
      .sort((a,b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence))
      .map(s => [Number(s.shape_pt_lat), Number(s.shape_pt_lon)]);

    const stopsOut = [];
    const seenStops = new Set();
    for (const trip of tripsForLine) {
      for (const st of stopTimesByTripId.get(trip.trip_id) || []) {
        if (seenStops.has(st.stop_id)) continue;
        seenStops.add(st.stop_id);
        const stop = stopsById.get(st.stop_id);
        if (stop) stopsOut.push({ lat: Number(stop.stop_lat), lon: Number(stop.stop_lon), name: stop.stop_name });
      }
    }

    res.json({ shape, stops: stopsOut });

  } catch (err) {
    console.error("GTFS ERROR:", err);
    res.status(500).json({ error: "Kunde inte hämta rutt/hållplatser", details: err.message });
  }
});

// ----- Route: live bussar -----
app.get("/api/vehicles/:line", async (req,res) => {
  try {
    const line = req.params.line.trim();
    const { tripsByRouteId, tripsById, lastStopNameByTripId } = await loadAllGTFS();

    const routeTrips = tripsByRouteId.get(line) || [];
    const tripIdsForLine = routeTrips.map(t => t.trip_id);

    // GTFS-RT cache
    const now = Date.now();
    if (!cachedFeed || now - cachedAt > CACHE_TTL) {
      const r = await fetch(GTFS_RT_URL, { headers: { Accept: "application/x-protobuf" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buffer = await r.arrayBuffer();
      cachedFeed = FeedMessage.decode(new Uint8Array(buffer));
      cachedAt = now;
    }

    const vehicles = cachedFeed.entity
      .filter(e => e.vehicle?.position && tripIdsForLine.includes(e.vehicle.trip?.tripId))
      .map(e => {
        const tripId = e.vehicle.trip?.tripId;
        const trip = tripsById.get(tripId);

        return {
          id: e.vehicle.vehicle?.id || e.id,
          lat: e.vehicle.position.latitude,
          lon: e.vehicle.position.longitude,
          bearing: e.vehicle.position.bearing ?? 0,
          directionId: e.vehicle.trip?.directionId ?? null,
          destination: trip?.trip_headsign || lastStopNameByTripId.get(tripId) || "Okänd destination"
        };
      });

    res.json(vehicles);

  } catch (err) {
    console.error("GTFS-RT ERROR:", err);
    res.status(500).json({ error: "Kunde inte hämta live-bussar", details: err.message });
  }
});

// ----- Test -----
app.get("/api/test", (req,res) => res.json({ ok:true, msg:"Backend fungerar på Render!" }));

// ----- Start -----
app.listen(PORT, () => console.log(`🚍 Backend kör på port ${PORT}`));
