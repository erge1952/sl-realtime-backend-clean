// server.js

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import protobuf from "protobufjs";
import mysql from "mysql2/promise";


// =====================================================
// 🔌 MySQL
// =====================================================

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
// 🚀 EXPRESS
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
// 🔑 TRAFIKLAB API KEY
// =====================================================

const SL_API_KEY = process.env.SL_API_KEY?.trim();

if (!SL_API_KEY) {
  throw new Error("SL_API_KEY saknas!");
}

const GTFS_RT_URL =
  `https://opendata.samtrafiken.se/gtfs-rt/sl/VehiclePositions.pb?key=${SL_API_KEY}`;


// =====================================================
// 📦 GTFS-RT PROTO
// =====================================================

let FeedMessage;

{
  const root = await protobuf.load("gtfs-realtime.proto");

  FeedMessage =
    root.lookupType("transit_realtime.FeedMessage");

  console.log("✅ GTFS-RT proto loaded");
}


// =====================================================
// ⏱ GTFS-RT CACHE
// =====================================================

let cachedFeed = null;
let cachedAt = 0;

const CACHE_TTL = 1500;


// =====================================================
// 🔒 SKYDD MOT SAMTIDIGA FETCH-ANROP
// =====================================================
//
// Om frontend frågar efter flera linjer samtidigt kan flera
// requests annars hinna upptäcka att cachedFeed saknas och
// alla samtidigt hämta samma protobuf från Trafiklab.
//
// fetchPromise gör att bara EN hämtning pågår.
// Övriga requests väntar på samma hämtning.
//

let fetchPromise = null;


// =====================================================
// 🧠 CACHE PER LINJE
// =====================================================

const lineCache = new Map();

const LINE_CACHE_TTL =
  10 * 60 * 1000;


// =====================================================
// 🚍 HÄMTA GTFS-DATA FÖR LINJE
// =====================================================

async function loadGTFSforLine(line) {

  const normalizedLine =
    String(line).trim();

  const cached =
    lineCache.get(normalizedLine);

  if (
    cached &&
    Date.now() - cached.ts < LINE_CACHE_TTL
  ) {
    return cached.data;
  }


  // ===================================================
  // ROUTE
  // ===================================================

  const [routes] = await db.query(
    `
    SELECT
      route_id,
      route_short_name,
      route_long_name,
      route_type
    FROM routes
    WHERE route_short_name = ?
    `,
    [normalizedLine]
  );


  console.log(
    "🔎 ROUTE SEARCH:",
    normalizedLine,
    "FOUND:",
    routes.length
  );


  if (!routes.length) {

    console.log(
      "❌ NO ROUTE FOUND:",
      normalizedLine
    );

    return null;
  }


  // Exakt route.
  // Om det trots allt finns flera poster med samma
  // route_short_name använder vi första.

  const route = routes[0];


  console.log(
    "✅ ROUTE:",
    normalizedLine,
    "route_id:",
    route.route_id,
    "route_type:",
    route.route_type
  );


  // ===================================================
  // TRIPS
  // ===================================================

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


  console.log(
    "🚍 STATIC TRIPS:",
    normalizedLine,
    trips.length
  );


  if (!trips.length) {

    console.log(
      "❌ NO TRIPS FOR ROUTE:",
      route.route_id
    );

    return null;
  }


  // ===================================================
  // TRIP MAP
  // ===================================================

  const tripMap =
    new Map(
      trips.map(t => [
        String(t.trip_id),
        t
      ])
    );


  // ===================================================
  // STOP IDS
  // ===================================================

  const tripIds =
    trips.map(t => t.trip_id);


  // ===================================================
  // STOP TIMES + STOPS
  // ===================================================

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
    WHERE st.trip_id IN (?)
    ORDER BY
      st.trip_id,
      st.stop_sequence
    `,
    [tripIds]
  );


  const stopTimesByTripId =
    new Map();


  for (const r of stopRows) {

    const tripId =
      String(r.trip_id);

    if (
      !stopTimesByTripId.has(tripId)
    ) {

      stopTimesByTripId.set(
        tripId,
        []
      );
    }

    stopTimesByTripId
      .get(tripId)
      .push(r);
  }


  console.log(
    "🛑 STOP ROWS:",
    normalizedLine,
    stopRows.length
  );


  // ===================================================
  // 🗺 SHAPE
  // ===================================================
  //
  // Vi använder den shape_id som förekommer flest gånger
  // bland tripparna. Detta var den variant som fungerade
  // bäst tidigare.
  //

  const shapeCounts =
    new Map();


  for (const t of trips) {

    const id =
      String(t.shape_id ?? "");


    if (
      !id ||
      id === "0" ||
      id === "1"
    ) {
      continue;
    }


    shapeCounts.set(
      id,
      (shapeCounts.get(id) || 0) + 1
    );
  }


  const bestShapeId =
    [...shapeCounts.entries()]
      .sort(
        (a, b) =>
          b[1] - a[1]
      )[0]?.[0];


  let shape = [];


  if (bestShapeId) {

    console.log(
      "🗺 USING SHAPE:",
      normalizedLine,
      bestShapeId
    );


    const [rows] =
      await db.query(
        `
        SELECT shape_json
        FROM shape_cache
        WHERE shape_id = ?
        LIMIT 1
        `,
        [bestShapeId]
      );


    if (rows.length) {

      try {

        shape =
          JSON.parse(
            rows[0].shape_json
          );


        console.log(
          "✅ SHAPE POINTS:",
          normalizedLine,
          shape.length
        );


      } catch (e) {

        console.error(
          "❌ SHAPE JSON ERROR:",
          bestShapeId,
          e
        );
      }

    } else {

      console.log(
        "⚠️ NO SHAPE IN CACHE:",
        bestShapeId
      );
    }

  } else {

    console.log(
      "⚠️ NO VALID SHAPE:",
      normalizedLine
    );
  }


  // ===================================================
  // RETURN DATA
  // ===================================================

  const data = {

    routeId:
      String(route.route_id),

    routeShortName:
      String(route.route_short_name),

    routeType:
      route.route_type,

    trips,

    stopTimesByTripId,

    shape,

    tripMap
  };


  lineCache.set(
    normalizedLine,
    {
      data,
      ts: Date.now()
    }
  );


  return data;
}


// =====================================================
// 🛰 HÄMTA GTFS-RT FEED
// =====================================================

async function getRealtimeFeed() {

  const now =
    Date.now();


  // Cache fortfarande giltig

  if (
    cachedFeed &&
    now - cachedAt < CACHE_TTL
  ) {

    return cachedFeed;
  }


  // En annan request håller redan på att hämta feeden

  if (fetchPromise) {

    console.log(
      "⏳ Väntar på pågående GTFS-RT-hämtning..."
    );

    return await fetchPromise;
  }


  // ===================================================
  // NY FETCH
  // ===================================================

  fetchPromise =
    (async () => {

      try {

        console.log(
          "🔄 Hämtar GTFS-RT från Samtrafiken..."
        );


        const r =
          await fetch(
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


        console.log(
          "📦 Buffer size:",
          buffer.byteLength
        );


        if (
          !buffer.byteLength
        ) {

          throw new Error(
            "GTFS-RT svarade med tom protobuf"
          );
        }


        // =================================================
        // DECODE
        // =================================================

        const feed =
          FeedMessage.decode(
            new Uint8Array(buffer)
          );


        console.log(
          "📡 GTFS-RT entities:",
          feed.entity.length
        );


        // =================================================
        // DEBUG STATISTIK
        // =================================================

        let withPosition = 0;
        let withTripId = 0;
        let withRouteId = 0;


        for (
          const entity of feed.entity
        ) {

          const vehicle =
            entity.vehicle;


          if (
            !vehicle?.position
          ) {
            continue;
          }


          withPosition++;


          if (
            vehicle.trip?.tripId
          ) {
            withTripId++;
          }


          if (
            vehicle.trip?.routeId
          ) {
            withRouteId++;
          }
        }


        console.log(
          "📊 RT VEHICLES WITH POSITION:",
          withPosition
        );

        console.log(
          "📊 RT VEHICLES WITH tripId:",
          withTripId
        );

        console.log(
          "📊 RT VEHICLES WITH routeId:",
          withRouteId
        );


        // =================================================
        // CACHE
        // =================================================

        cachedFeed =
          feed;

        cachedAt =
          Date.now();


        return feed;


      } finally {

        fetchPromise =
          null;
      }

    })();


  return await fetchPromise;
}


// =====================================================
// 🗺 /api/line/:line
// =====================================================

app.get(
  "/api/line/:line",
  async (req, res) => {

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
          error:
            "Ingen linje"
        });
      }


      // =================================================
      // UNIQUE STOPS
      // =================================================

      const stopsOut = [];

      const seen =
        new Set();


      for (
        const sts
        of data.stopTimesByTripId.values()
      ) {

        for (const s of sts) {

          if (
            seen.has(s.stop_id)
          ) {
            continue;
          }


          seen.add(
            s.stop_id
          );


          stopsOut.push({

            lat:
              Number(s.stop_lat),

            lon:
              Number(s.stop_lon),

            name:
              s.stop_name
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

        shape:
          data.shape || [],

        stops:
          stopsOut,

        routeType:
          data.routeType
      });


    } catch (e) {

      console.error(
        "❌ LINE ERROR:",
        e
      );


      res.status(500).json({
        error:
          "Kunde inte hämta linje"
      });
    }
  }
);


// =====================================================
// 🚐 /api/vehicles/:line
// =====================================================

app.get(
  "/api/vehicles/:line",
  async (req, res) => {

    try {

      const line =
        req.params.line.trim();


      console.log(
        "======================================"
      );

      console.log(
        "🚐 VEHICLE REQUEST:",
        line
      );


      // =================================================
      // STATIC GTFS
      // =================================================

      const data =
        await loadGTFSforLine(line);


      if (!data) {

        console.log(
          "❌ NO STATIC DATA:",
          line
        );

        return res.json([]);
      }


      // =================================================
      // STATIC TRIP LOOKUP
      // =================================================

      const tripIdSet =
        new Set(
          data.trips.map(
            t => String(t.trip_id)
          )
        );


      // =================================================
      // HEADSIGN PER DIRECTION
      // =================================================

      const headsignByDirection =
        new Map();


      for (
        const trip of data.trips
      ) {

        const direction =
          trip.direction_id == null
            ? null
            : String(trip.direction_id);


        if (
          direction !== null &&
          !headsignByDirection.has(direction)
        ) {

          if (trip.trip_headsign) {

            headsignByDirection.set(
              direction,
              trip.trip_headsign
            );
          }
        }
      }


      // =================================================
      // LAST STOP PER TRIP
      // =================================================

      const lastStopNameByTripId =
        new Map();


      for (
        const [tripId, sts]
        of data.stopTimesByTripId
      ) {

        if (!sts.length) {
          continue;
        }


        const last =
          sts[sts.length - 1];


        lastStopNameByTripId.set(
          String(tripId),
          last.stop_name
        );
      }


      // =================================================
      // GTFS-RT
      // =================================================

      const feed =
        await getRealtimeFeed();


      // =================================================
      // VEHICLES
      // =================================================

      const vehicles = [];


      let realtimeWithPosition = 0;

      let realtimeWithTripId = 0;

      let tripIdMatched = 0;

      let routeIdMatched = 0;

      let unmatchedForLine = 0;
	  
	  let unmatchedDebugCount = 0;
	  
	  let matchedDebugCount = 0;


      // =================================================
      // LOOP REALTIME
      // =================================================

      for (
        const entity
        of feed.entity
      ) {

        const vehicle =
          entity.vehicle;


        if (
          !vehicle?.position
        ) {
          continue;
        }


        realtimeWithPosition++;


        const rtTripId =
          vehicle.trip?.tripId
            ? String(
                vehicle.trip.tripId
              )
            : null;


        const rtRouteId =
          vehicle.trip?.routeId
            ? String(
                vehicle.trip.routeId
              )
            : null;


        const rtDirectionId =
          vehicle.trip?.directionId != null
            ? String(
                vehicle.trip.directionId
              )
            : null;


        if (rtTripId) {

          realtimeWithTripId++;
        }


        // =================================================
        // MATCH 1:
        // exakt trip_id
        // =================================================

        let matchedTrip =
          null;


        if (rtTripId && tripIdSet.has(rtTripId)) { matchedTrip = data.tripMap.get( rtTripId ); tripIdMatched++; if (matchedDebugCount < 10) { console.log( "✅ MATCHED TRIP:", { line, rtTripId, rtRouteId, rtDirectionId, vehicleId: vehicle.vehicle?.id, staticTrip: matchedTrip } ); matchedDebugCount++; } }


        // =================================================
        // MATCH 2:
        // route_id
        //
        // Om realtime-trip_id inte finns i vår statiska
        // GTFS använder vi routeId som fallback.
        //
        // Detta är viktigt eftersom VehiclePositions
        // kan innehålla trippar som inte exakt motsvarar
        // våra lokalt lagrade trip_id.
        // =================================================

        let routeMatched =
          false;


        if (
          !matchedTrip &&
          rtRouteId &&
          rtRouteId === data.routeId
        ) {

          routeMatched =
            true;

          routeIdMatched++;
        }


        // =================================================
        // Om varken trip eller route matchar linjen:
        // hoppa över fordonet.
        // =================================================

        ```js
if (
  !matchedTrip &&
  !routeMatched
) {

  unmatchedForLine++;

  if (unmatchedDebugCount < 20) {

    console.log(
      "❌ UNMATCHED RT VEHICLE:",
      {
        entityId: entity.id,

        vehicleId:
          vehicle.vehicle?.id,

        tripId:
          vehicle.trip?.tripId,

        routeId:
          vehicle.trip?.routeId,

        directionId:
          vehicle.trip?.directionId,

        latitude:
          vehicle.position.latitude,

        longitude:
          vehicle.position.longitude
      }
    );

    unmatchedDebugCount++;
  }

  continue;
}
```


        // =================================================
        // DESTINATION
        // =================================================

        let destination =
          null;


        // Bäst: destination från exakt matchad trip

        if (matchedTrip) {

          destination =
            matchedTrip.trip_headsign ||
            lastStopNameByTripId.get(
              rtTripId
            ) ||
            null;
        }


        // Fallback:
        // riktning från realtime mot statiskt headsign

        if (
          !destination &&
          rtDirectionId !== null
        ) {

          destination =
            headsignByDirection.get(
              rtDirectionId
            ) || null;
        }


        if (!destination) {

          destination =
            "Okänd destination";
        }


        // =================================================
        // VEHICLE
        // =================================================

        vehicles.push({

          id:
            vehicle.vehicle?.id ||
            entity.id,

          lat:
            Number(
              vehicle.position.latitude
            ),

          lon:
            Number(
              vehicle.position.longitude
            ),

          bearing:
            vehicle.position.bearing != null
              ? Number(
                  vehicle.position.bearing
                )
              : 0,

          directionId:
            vehicle.trip?.directionId != null
              ? Number(
                  vehicle.trip.directionId
                )
              : null,

          routeType:
            data.routeType,

          destination
        });
      }


      // =================================================
      // DEBUG
      // =================================================

      console.log(
        "📊 LINE:",
        line
      );

      console.log(
        "📊 STATIC route_id:",
        data.routeId
      );

      console.log(
        "📊 STATIC trips:",
        data.trips.length
      );

      console.log(
        "📊 RT vehicles with position:",
        realtimeWithPosition
      );

      console.log(
        "📊 RT vehicles with tripId:",
        realtimeWithTripId
      );

      console.log(
        "📊 MATCHED BY tripId:",
        tripIdMatched
      );

      console.log(
        "📊 MATCHED BY routeId:",
        routeIdMatched
      );

      console.log(
        "📊 UNMATCHED FOR THIS LINE:",
        unmatchedForLine
      );

      console.log(
        "🚍 VEHICLES RETURNED:",
        vehicles.length
      );

      console.log(
        "======================================"
      );


      res.json(
        vehicles
      );


    } catch (e) {

      console.error(
        "❌ VEHICLE ERROR:",
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
// 🔎 TEST
// =====================================================

app.get(
  "/api/test",
  (_, res) =>
    res.json({
      ok: true,
      msg:
        "Backend fungerar 🎉"
    })
);


// =====================================================
// 🚀 START
// =====================================================

app.listen(
  PORT,
  () => {

    console.log(
      `🚍 Backend kör på port ${PORT}`
    );


    // Värm upp MySQL connection

    db.query("SELECT 1")
      .catch(console.error);
  }
);