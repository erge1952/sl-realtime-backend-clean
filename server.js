// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import protobuf from "protobufjs";
import mysql from "mysql2/promise";
import fs from "fs";

async function initDB() {
  return await mysql.createPool({
    host: "auth-db504.hstgr.io",
    user: "u160886294_erge08",
    password: "KuliJul2025!",
    database: "u160886294_sldata",
    waitForConnections: true,
    connectionLimit: 10
  });
}

const db = await initDB();

console.log("✅ MySQL pool skapad");

// =====================================================
// EXPRESS
// =====================================================

const app = express();

app.use(cors({
  origin: [
    "https://gerring.com",
    "https://www.gerring.com"
  ]
}));

app.use(express.json());

const PORT = process.env.PORT || 3001;

// =====================================================
// SL API
// =====================================================

const SL_API_KEY = process.env.SL_API_KEY?.trim();

if (!SL_API_KEY) {
  throw new Error("SL_API_KEY saknas!");
}

const GTFS_RT_URL =
  `https://opendata.samtrafiken.se/gtfs-rt/sl/VehiclePositions.pb?key=${SL_API_KEY}`;

// =====================================================
// GTFS-RT PROTO
// =====================================================

const root = await protobuf.load("gtfs-realtime.proto");

const FeedMessage =
  root.lookupType("transit_realtime.FeedMessage");

console.log("✅ GTFS-RT proto loaded");

// =====================================================
// CACHE
// =====================================================

let cachedFeed = null;
let cachedAt = 0;

const CACHE_TTL = 1500;

const lineCache = new Map();

const LINE_CACHE_TTL =
  10 * 60 * 1000;

// =====================================================
// LOAD GTFS FOR LINE
// =====================================================

async function loadGTFSforLine(line) {

  const cached = lineCache.get(line);

  if (
    cached &&
    Date.now() - cached.ts < LINE_CACHE_TTL
  ) {
    return cached.data;
  }

  // =====================================================
  // ROUTE
  // =====================================================

  const [routesFound] = await db.query(
    `
    SELECT
      route_id,
      route_short_name,
      route_long_name,
      route_type
    FROM routes
    WHERE TRIM(route_short_name) = TRIM(?)
    LIMIT 1
    `,
    [line]
  );

  console.log("DEBUG ROUTES:", routesFound);

  const route = routesFound[0];

  if (!route) {

    console.log("❌ NO ROUTE:", line);

    return null;
  }

  // =====================================================
  // TRIPS
  // =====================================================

  const [trips] = await db.query(
    `
    SELECT
      trip_id,
      trip_headsign,
      direction_id,
      shape_id
    FROM trips
    WHERE route_id = ?
    `,
    [route.route_id]
  );

  if (!trips.length) {

    console.log("❌ NO TRIPS:", route.route_id);

    return null;
  }

  const tripMap = new Map(
    trips.map(t => [t.trip_id, t])
  );

  const tripIds =
    trips.map(t => t.trip_id);

  // =====================================================
  // STOPS
  // =====================================================

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
    JOIN stops s
      ON s.stop_id = st.stop_id
    WHERE st.trip_id IN (${tripIds.map(() => "?").join(",")})
    ORDER BY st.trip_id, st.stop_sequence
    `,
    tripIds
  );

  const stopTimesByTripId =
    new Map();

  for (const r of stopRows) {

    if (!stopTimesByTripId.has(r.trip_id)) {

      stopTimesByTripId.set(
        r.trip_id,
        []
      );
    }

    stopTimesByTripId
      .get(r.trip_id)
      .push(r);
  }

  // =====================================================
// SHAPE
// =====================================================

let shape = [];

for (const t of trips) {

  if (!t.shape_id) {
    continue;
  }

  const shapeId = String(t.shape_id).trim();

  console.log("🔍 TESTING SHAPE:", shapeId);

  const [rows] = await db.query(
    `
    SELECT shape_json
    FROM shape_cache
    WHERE TRIM(shape_id) = ?
    LIMIT 1
    `,
    [shapeId]
  );

  if (!rows.length) {
    continue;
  }

  try {

    const parsed = JSON.parse(rows[0].shape_json);

    if (Array.isArray(parsed) && parsed.length > 2) {

      shape = parsed;

      console.log(
        "✅ SHAPE FOUND:",
        shapeId,
        "POINTS:",
        shape.length
      );

      break;
    }

  } catch (e) {

    console.error(
      "❌ SHAPE JSON ERROR:",
      shapeId,
      e
    );
  }
}

console.log(
  "🗺 FINAL SHAPE LENGTH:",
  shape.length
);
  // =====================================================
  // RETURN DATA
  // =====================================================

  const data = {
    routeType: route.route_type,
    trips,
    stopTimesByTripId,
    shape,
    tripMap
  };

  lineCache.set(line, {
    data,
    ts: Date.now()
  });

  return data;
}

// =====================================================
// API LINE
// =====================================================

app.get("/api/line/:line", async (req, res) => {

  try {

    const line =
      req.params.line.trim();

    console.log(
      "📍 LINE REQUEST:",
      line
    );

    const data =
      await loadGTFSforLine(line);

    if (!data) {

      return res.status(404).json({
        error: "Ingen linje"
      });
    }

    const stopsOut = [];
    const seen = new Set();

    for (
      const sts of
      data.stopTimesByTripId.values()
    ) {

      for (const s of sts) {

        if (seen.has(s.stop_id)) {
          continue;
        }

        seen.add(s.stop_id);

        stopsOut.push({
          lat: Number(s.stop_lat),
          lon: Number(s.stop_lon),
          name: s.stop_name
        });
      }
    }

    console.log(
      "✅ API LINE:",
      line,
      "SHAPE:",
      data.shape.length,
      "STOPS:",
      stopsOut.length
    );

    res.json({
      shape: Array.isArray(data.shape)
      ? data.shape
      : [],
      stops: stopsOut,
      routeType: data.routeType
    });

  } catch (e) {

    console.error(
      "LINE ERROR:",
      e
    );

    res.status(500).json({
      error:
        "Kunde inte hämta linje"
    });
  }
});

// =====================================================
// API VEHICLES
// =====================================================

app.get(
  "/api/vehicles/:line",
  async (req, res) => {

    try {

      const line =
        req.params.line.trim();

      const data =
        await loadGTFSforLine(line);

      if (!data) {
        return res.json([]);
      }

      const lastStopNameByTripId =
        new Map();

      for (
        const [tripId, sts]
        of data.stopTimesByTripId
      ) {

        const last =
          sts[sts.length - 1];

        lastStopNameByTripId.set(
          tripId,
          last.stop_name
        );
      }

      // =====================================================
      // GTFS RT CACHE
      // =====================================================

      const now = Date.now();

      if (
        !cachedFeed ||
        now - cachedAt > CACHE_TTL
      ) {

        console.log(
          "🔄 FETCHING GTFS-RT..."
        );

        const r = await fetch(
          GTFS_RT_URL,
          {
            headers: {
              Accept:
                "application/x-protobuf",
              "Accept-Encoding":
                "gzip"
            }
          }
        );

        if (!r.ok) {

          const text =
            await r.text();

          console.error(
            "❌ GTFS FETCH FAILED:",
            r.status,
            text
          );

          throw new Error(
            `GTFS error ${r.status}`
          );
        }

        const buffer =
          await r.arrayBuffer();

        // save protobuf
        try {

          const pbPath =
            "/tmp/latest.pb";

          fs.writeFileSync(
            pbPath,
            Buffer.from(buffer)
          );

        } catch (e) {

          console.error(
            "PB SAVE ERROR:",
            e
          );
        }

        cachedFeed =
          FeedMessage.decode(
            new Uint8Array(buffer)
          );

        cachedAt = now;

        console.log(
          "✅ GTFS-RT UPDATED"
        );
      }

      // =====================================================
      // FILTER VEHICLES
      // =====================================================

      const tripIdSet = new Set(
        data.trips.map(
          t => t.trip_id
        )
      );

      const vehicles = [];

      for (
        const entity of cachedFeed.entity
      ) {

        const vehicle =
          entity.vehicle;

        if (!vehicle?.position) {
          continue;
        }

        const tripId =
          vehicle.trip?.tripId;

        if (!tripIdSet.has(tripId)) {
          continue;
        }

        const trip =
          data.tripMap.get(tripId);

        vehicles.push({

          id:
            vehicle.vehicle?.id ||
            entity.id,

          lat:
            vehicle.position.latitude,

          lon:
            vehicle.position.longitude,

          bearing:
            vehicle.position.bearing ?? 0,

          directionId:
            vehicle.trip?.directionId ??
            null,

          routeType:
            data.routeType,

          destination:
            trip?.trip_headsign ||
            lastStopNameByTripId.get(
              tripId
            ) ||
            "Okänd destination"
        });
      }

      console.log(
        "✅ VEHICLES:",
        line,
        vehicles.length
      );

      res.json(vehicles);

    } catch (e) {

      console.error(
        "VEHICLE ERROR:",
        e
      );

      res.status(500).json({
        error:
          "Kunde inte hämta fordon"
      });
    }
  }
);

// =====================================================
// TEST
// =====================================================

app.get("/api/test", (_, res) => {

  res.json({
    ok: true,
    msg: "Backend fungerar 🎉"
  });
});

// =====================================================
// DEBUG FETCH PB
// =====================================================

app.get(
  "/api/debug/fetchpb",
  async (_, res) => {

    try {

      console.log(
        "🔄 Hämtar protobuf direkt..."
      );

      const r = await fetch(
        GTFS_RT_URL,
        {
          headers: {
            Accept:
              "application/x-protobuf",
            "Accept-Encoding":
              "gzip"
          }
        }
      );

      if (!r.ok) {

        const text =
          await r.text();

        return res
          .status(500)
          .send(text);
      }

      const buffer =
        await r.arrayBuffer();

      const pbPath =
        "/tmp/latest.pb";

      fs.writeFileSync(
        pbPath,
        Buffer.from(buffer)
      );

      res.download(pbPath);

    } catch (e) {

      console.error(
        "FETCH PB ERROR:",
        e
      );

      res
        .status(500)
        .send(e.message);
    }
  }
);

// =====================================================
// DEBUG PB
// =====================================================

app.get("/api/debug/pb", (_, res) => {

  try {

    const tmpDir = "/tmp";

    if (!fs.existsSync(tmpDir)) {

      return res
        .status(404)
        .send("tmp finns inte");
    }

    const files =
      fs.readdirSync(tmpDir)
        .filter(f => f.endsWith(".pb"))
        .sort()
        .reverse();

    if (!files.length) {

      return res
        .status(404)
        .send(
          "Ingen protobuf-fil hittades"
        );
    }

    const latest =
      `${tmpDir}/${files[0]}`;

    res.download(latest);

  } catch (e) {

    console.error(
      "PB DOWNLOAD ERROR:",
      e
    );

    res
      .status(500)
      .send(e.message);
  }
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, () => {

  console.log(
    `🚍 Backend kör på port ${PORT}`
  );

  db.query("SELECT 1")
    .catch(console.error);
});