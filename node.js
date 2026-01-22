// create-mini-gtfs.js
import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

// ----- Konfiguration -----
const gtfsFolder = "./gtfs";      // original GTFS
const miniFolder = "./gtfs-mini"; // sparade mini-filer
const keepLines = ["1","117","118"]; // de linjer du vill behålla

// Skapa mappen om den inte finns
if (!fs.existsSync(miniFolder)) fs.mkdirSync(miniFolder, { recursive: true });

// ----- Funktioner -----
function readCSV(file, columns) {
  const content = fs.readFileSync(path.join(gtfsFolder, file), "utf8");
  return parse(content, { columns, skip_empty_lines: true, trim: true });
}

function writeCSV(file, data, columns) {
  const output = stringify(data, { header: true, columns });
  fs.writeFileSync(path.join(miniFolder, file), output, "utf8");
}

// ----- Läsa original -----
const routes = readCSV("routes.json", ['route_id','agency_id','route_short_name','route_long_name','route_type','route_desc']);
const trips = readCSV("trips.json", ['route_id','service_id','trip_id','trip_headsign','direction_id','shape_id']);
const shapes = readCSV("shapes.json", ['shape_id','shape_pt_lat','shape_pt_lon','shape_pt_sequence','shape_dist_traveled']);
const stops = readCSV("stops.json", ['stop_id','stop_name','stop_lat','stop_lon','location_type','parent_station','platform_code']);
const stopTimes = readCSV("stop_times.json", [
  'trip_id','arrival_time','departure_time','stop_id','stop_sequence','stop_headsign',
  'pickup_type','drop_off_type','shape_dist_traveled','timepoint',
  'pickup_booking_rule_id','drop_off_booking_rule_id'
]);

// ----- Filtrera routes -----
const keepRoutes = routes.filter(r => keepLines.includes(r.route_short_name));
const keepRouteIds = new Set(keepRoutes.map(r => r.route_id));

// ----- Filtrera trips -----
const keepTrips = trips.filter(t => keepRouteIds.has(t.route_id));
const keepTripIds = new Set(keepTrips.map(t => t.trip_id));

// ----- Filtrera stop_times -----
const keepStopTimes = stopTimes.filter(st => keepTripIds.has(st.trip_id));
const keepStopIds = new Set(keepStopTimes.map(st => st.stop_id));

// ----- Filtrera stops -----
const keepStops = stops.filter(s => keepStopIds.has(s.stop_id));

// ----- Filtrera shapes -----
const keepShapeIds = new Set(keepTrips.map(t => t.shape_id));
const keepShapes = shapes.filter(s => keepShapeIds.has(s.shape_id));

// ----- Skriv mini-filer -----
writeCSV("routes.json", keepRoutes, ['route_id','agency_id','route_short_name','route_long_name','route_type','route_desc']);
writeCSV("trips.json", keepTrips, ['route_id','service_id','trip_id','trip_headsign','direction_id','shape_id']);
writeCSV("stop_times.json", keepStopTimes, [
  'trip_id','arrival_time','departure_time','stop_id','stop_sequence','stop_headsign',
  'pickup_type','drop_off_type','shape_dist_traveled','timepoint',
  'pickup_booking_rule_id','drop_off_booking_rule_id'
]);
writeCSV("stops.json", keepStops, ['stop_id','stop_name','stop_lat','stop_lon','location_type','parent_station','platform_code']);
writeCSV("shapes.json", keepShapes, ['shape_id','shape_pt_lat','shape_pt_lon','shape_pt_sequence','shape_dist_traveled']);

console.log("✅ Mini-GTFS skapad i", miniFolder);
console.log("Routes:", keepRoutes.length, "Trips:", keepTrips.length, "Stops:", keepStops.length, "Shapes:", keepShapes.length);
