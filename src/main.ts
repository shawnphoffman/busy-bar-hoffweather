import { device } from "@shared/device";
import { loadValues, str, num, bool } from "@shared/settings";
import { readSnapshot, saveSnapshot, ageOf } from "@shared/cache";
import manifest from "./appmeta/manifest.json";
import { measure, type DisplayDrawParams } from "@busy-app/busy-lib";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

type Element = NonNullable<DisplayDrawParams["elements"]>[number];

const SCREEN_W = 72;
const SCREEN_H = 16;
/** Longest request to a source; TLS on the bar alone can take several seconds. */
const FETCH_TIMEOUT_MS = 20000;

/** The launch snapshot: the last readings, painted at once while fresh ones are fetched. */
const CACHE_KEY = "wx";
/** Rewrite an unchanged snapshot this often, so its age stays honest. */
const CACHE_HEARTBEAT_MS = 10 * 60000;
/** Readings older than this are not shown at launch. */
const CACHE_MAX_AGE_MS = 60 * 60000;
/** Alpha for readings that could not be refreshed: still useful, visibly not current. */
const STALE_ALPHA = "70";

interface Settings {
  token: string;
  stationId: string;
  aqiUrl: string;
  purpleAirHost: string;
  purpleAirKey: string;
  purpleAirIndex: string;
  epaCorrection: boolean;
  showWind: boolean;
  showDetails: boolean;
  imperial: boolean;
  pollMinutes: number;
  pageSeconds: number;
  baseUrl: string;
  alerts: boolean;
  /** In the display units (miles or km); 0 turns the lightning alert off. */
  alertLightningDistance: number;
  alertRain: boolean;
  alertAqi: boolean;
  /** Quiet hours as minutes after midnight; equal values mean none. */
  quietStart: number;
  quietEnd: number;
}

/** The current observation, in metric as WeatherFlow reports it. */
interface Weather {
  tempC: number;
  feelsC: number;
  humidity: number;
  windAvgMs: number;
  windGustMs: number;
  windDir: number;
  uv: number;
  /** Lux at the station: tells day from night for the glance icon. */
  brightness: number;
  /** Rain in the last minute, mm: tells whether it is raining right now. */
  precipNowMm: number;
  rainDayMm: number;
  strikes3h: number;
  strikeKm: number;
  strikeEpoch: number;
  at: number;
}

interface Air {
  /** PM2.5 after the optional EPA correction, in ug/m3. */
  pm25: number;
  aqi: number;
  at: number;
}

/** glance: temperature and AQI side by side. The others are optional or automatic. */
type PageId = "glance" | "wind" | "details" | "lightning";

interface State {
  settings: Settings;
  weather: Weather | null;
  air: Air | null;
  weatherError: string | null;
  airError: string | null;
  /** Whether the last attempt at each source failed: with an old reading, that is what dims it. */
  weatherFailed: boolean;
  airFailed: boolean;
  /** A refresh is in flight; another request waits for it. */
  polling: boolean;
  /** LED colour to blink with the next draw, after an alert. */
  ledPending: string | null;
  page: PageId;
  shownAt: number;
  held: boolean;
  animating: boolean;
  stopped: boolean;
  drawing: boolean;
  redrawWanted: boolean;
}

/** The launch snapshot. Only the setting the first frame needs rides along; secrets stay in settings. */
interface Cached {
  weather: Weather;
  air: Air | null;
  imperial: boolean;
}

/* ---------- sources ---------- */

function numberOf(v: unknown, fallback = 0): number {
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

/** fetch with a time limit where the runtime supports aborting; otherwise a plain fetch. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  if (typeof AbortController !== "function") return fetch(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Latest observation for the station from the WeatherFlow REST API. */
async function fetchWeather(s: Settings): Promise<Weather> {
  const url = `${s.baseUrl}/rest/observations/station/${encodeURIComponent(s.stationId)}?token=${encodeURIComponent(s.token)}`;
  const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`WeatherFlow HTTP ${res.status}`);
  const body = (await res.json()) as { obs?: Record<string, unknown>[]; status?: { status_message?: string } };
  const o = body.obs?.[0];
  if (!o) throw new Error(body.status?.status_message || "No observation");
  return {
    tempC: numberOf(o.air_temperature),
    feelsC: numberOf(o.feels_like, numberOf(o.air_temperature)),
    humidity: numberOf(o.relative_humidity),
    windAvgMs: numberOf(o.wind_avg),
    windGustMs: numberOf(o.wind_gust),
    windDir: numberOf(o.wind_direction),
    uv: numberOf(o.uv),
    brightness: numberOf(o.brightness, 1000),
    precipNowMm: numberOf(o.precip),
    rainDayMm: numberOf(o.precip_accum_local_day),
    strikes3h: numberOf(o.lightning_strike_count_last_3hr),
    strikeKm: numberOf(o.lightning_strike_last_distance),
    strikeEpoch: numberOf(o.lightning_strike_last_epoch),
    at: Date.now(),
  };
}

/** Whether any air-quality source is configured. */
function hasAir(s: Settings): boolean {
  return s.aqiUrl !== "" || s.purpleAirKey !== "" || s.purpleAirHost !== "";
}

/**
 * EPA correction for PurpleAir PM2.5 (Barkjohn et al. 2022, as on the AirNow Fire and Smoke Map), from the cf=1
 * reading averaged across both channels and the sensor's relative humidity. Mirrors the tahome proxy in shawn-api.
 */
function correctPM(cf1: number, rh: number): number {
  const typical = 0.524 * cf1 - 0.0862 * rh + 5.75;
  const heavySmoke = 4.21e-4 * cf1 * cf1 + 0.392 * cf1 + 3.44;
  let pm = typical;
  if (cf1 >= 611) pm = heavySmoke;
  else if (cf1 >= 570) {
    const weight = 0.0244 * cf1 - 13.9;
    pm = weight * heavySmoke + (1 - weight) * typical;
  }
  return Math.max(0, pm);
}

/** EPA channel agreement: keep a reading only when the two lasers agree within 5 ug/m3 or 70%. */
function channelsAgree(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  const mean = (a + b) / 2;
  return diff <= 5 || (mean > 0 && diff / mean < 0.7);
}

/** The AQI: from the JSON proxy when set, else PurpleAir's cloud API, else the sensor's own web server on the LAN. */
async function fetchAir(s: Settings): Promise<Air> {
  const headers = { Accept: "application/json" };
  if (s.aqiUrl) {
    const res = await fetchWithTimeout(s.aqiUrl, { headers });
    if (!res.ok) throw new Error(`AQI HTTP ${res.status}`);
    const d = (await res.json()) as Record<string, unknown>;
    const aqi = numberOf(d.aqi, -1);
    if (aqi < 0) throw new Error("No aqi in response");
    return { pm25: numberOf(d.pm25, -1), aqi: Math.round(aqi), at: Date.now() };
  }
  let a: number;
  let b: number;
  let combined: number;
  let rh: number;
  if (s.purpleAirKey) {
    // The same fields the tahome proxy reads: cf=1 per channel plus humidity.
    const fields = "pm2.5_cf_1,pm2.5_cf_1_a,pm2.5_cf_1_b,humidity";
    const res = await fetchWithTimeout(`https://api.purpleair.com/v1/sensors/${encodeURIComponent(s.purpleAirIndex)}?fields=${fields}`, {
      headers: { ...headers, "X-API-Key": s.purpleAirKey },
    });
    if (!res.ok) throw new Error(`PurpleAir HTTP ${res.status}`);
    const d = ((await res.json()) as { sensor?: Record<string, unknown> }).sensor ?? {};
    a = numberOf(d["pm2.5_cf_1_a"], -1);
    b = numberOf(d["pm2.5_cf_1_b"], -1);
    combined = numberOf(d["pm2.5_cf_1"], -1);
    rh = numberOf(d.humidity, 50);
  } else {
    const host = s.purpleAirHost.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const res = await fetchWithTimeout(`http://${host}/json?live=false`, { headers });
    if (!res.ok) throw new Error(`PurpleAir HTTP ${res.status}`);
    const d = (await res.json()) as Record<string, unknown>;
    a = numberOf(d.pm2_5_cf_1, -1);
    b = numberOf(d.pm2_5_cf_1_b, -1);
    combined = a >= 0 && b >= 0 ? (a + b) / 2 : Math.max(a, b);
    rh = numberOf(d.current_humidity, 50);
  }
  // Prefer the two channels when they agree; otherwise PurpleAir's own combined value, which drops a bad channel.
  let cf1 = a >= 0 && b >= 0 && channelsAgree(a, b) ? (a + b) / 2 : combined;
  if (cf1 < 0) throw new Error("No PM2.5 in response");
  const pm = s.epaCorrection ? correctPM(cf1, rh) : cf1;
  return { pm25: pm, aqi: aqiFromPm25(pm), at: Date.now() };
}

/** US AQI from PM2.5 (2024 breakpoints). */
function aqiFromPm25(pm: number): number {
  const bp: [number, number, number, number][] = [
    [0, 9.0, 0, 50],
    [9.1, 35.4, 51, 100],
    [35.5, 55.4, 101, 150],
    [55.5, 125.4, 151, 200],
    [125.5, 225.4, 201, 300],
    [225.5, 325.4, 301, 500],
  ];
  // EPA truncates PM2.5 to one decimal before picking the bucket.
  const c = Math.floor(pm * 10) / 10;
  for (const [cl, ch, il, ih] of bp) {
    if (c <= ch) return Math.round(((ih - il) / (ch - cl)) * (Math.max(c, cl) - cl) + il);
  }
  return 500;
}

/* ---------- alerts ---------- */

/** One alert sound at most per this long, whatever the kind. */
const ALERT_GAP_MS = 60000;
/** A storm throws many strikes: one lightning alert per this long. */
const LIGHTNING_COOLDOWN_MS = 15 * 60000;
/** A strike reported later than this after it happened is old news. */
const LIGHTNING_FRESH_S = 10 * 60;
/** Rain must follow this long without rain to count as starting. */
const RAIN_DRY_MS = 30 * 60000;
/** After an AQI alert, the same category (or a lower one) is not announced again for this long: no flapping at 100/101. */
const AQI_REPEAT_MS = 60 * 60000;
/** AQI categories from this one up are announced: 2 is Unhealthy for Sensitive Groups (101-150). */
const AQI_ALERT_CATEGORY = 2;

type AlertKind = "lightning" | "rain" | "aqi";

const ALERT_SOUND: Record<AlertKind, string> = {
  lightning: "sounds/lightning.snd",
  rain: "sounds/chime.snd",
  aqi: "sounds/chime.snd",
};

/** EPA category index for an AQI: 0 Good, 1 Moderate, 2 Unhealthy for Sensitive Groups, and on up to 5. */
function aqiCategory(aqi: number): number {
  const tops = [50, 100, 150, 200, 300];
  const i = tops.findIndex((t) => aqi <= t);
  return i < 0 ? tops.length : i;
}

/** "HH:MM" or "HH:MM:SS" as minutes after midnight, or the fallback when unreadable. */
function minutesOf(hm: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(hm);
  if (!m) return fallback;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  return h < 24 && min < 60 ? h * 60 + min : fallback;
}

/** Whether `now` falls in quiet hours, which may wrap past midnight. */
function inQuietHours(s: Settings, now: Date): boolean {
  if (s.quietStart === s.quietEnd) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return s.quietStart < s.quietEnd ? m >= s.quietStart && m < s.quietEnd : m >= s.quietStart || m < s.quietEnd;
}

/**
 * What the alert checks remember between refreshes. Each source's first fresh reading in a run only sets the
 * baseline, so opening the app never sounds an alert for conditions that were already there.
 */
interface AlertMemory {
  weatherSeen: boolean;
  airSeen: boolean;
  strikeEpoch: number;
  lightningAt: number;
  raining: boolean;
  wetAt: number;
  aqiCategory: number;
  aqiAlertCategory: number;
  aqiAlertAt: number;
  soundAt: number;
}

/* ---------- units and colours ---------- */

const fmt0 = (n: number) => String(Math.round(n));
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const fmt2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

function temp(s: Settings, c: number): string {
  return s.imperial ? fmt0(c * 1.8 + 32) : fmt0(c);
}
function speed(s: Settings, ms: number): string {
  return s.imperial ? fmt0(ms * 2.23694) : fmt0(ms * 3.6);
}
function speedUnit(s: Settings): string {
  return s.imperial ? "mph" : "km/h";
}
function rain(s: Settings, mm: number): string {
  return s.imperial ? `${fmt2(mm / 25.4)}in` : `${fmt1(mm)}mm`;
}
function distance(s: Settings, km: number): string {
  return s.imperial ? `${fmt0(km * 0.621371)}mi` : `${fmt0(km)}km`;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** A colour for a temperature in F, cold blue through warm red. */
function tempColour(f: number): string {
  const stops: [number, string][] = [
    [10, "#9AC4FF"],
    [32, "#4FA3FF"],
    [50, "#4FD1C5"],
    [65, "#7CFC9A"],
    [75, "#FFD84F"],
    [85, "#FF9A3C"],
    [100, "#FF4E4E"],
  ];
  if (f <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i]!;
    if (f <= t1) {
      const [t0, c0] = stops[i - 1]!;
      const k = (f - t0) / (t1 - t0);
      const a = hexToRgb(c0);
      const b = hexToRgb(c1);
      return rgbToHex(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
    }
  }
  return stops[stops.length - 1]![1];
}

/** EPA category colour for an AQI value. */
function aqiColour(aqi: number): string {
  if (aqi <= 50) return "#2ECC40";
  if (aqi <= 100) return "#FFDC00";
  if (aqi <= 150) return "#FF851B";
  if (aqi <= 200) return "#FF4136";
  if (aqi <= 300) return "#B10DC9";
  return "#85144B";
}

/* ---------- bitmaps ---------- */

/** "AQI" stacked vertically beside the AQI number: a 3x4 A, a 3x5 Q with a tail, a gap, then a 3x4 I. 15 rows. */
const AQI_STACK = [".#.", "#.#", "###", "#.#", "...", "###", "#.#", "#.#", "###", "..#", "...", "###", ".#.", ".#.", "###"];

/** 3x5 unit letters for the temperature, smaller than any device font. */
const UNIT_F = ["###", "#..", "##.", "#..", "#.."];
const UNIT_C = [".##", "#..", "#..", "#..", ".##"];

/** 8x8 glyphs for the glance page: day, night, and rain. */
const ICON_SUN = ["...##...", ".#.##.#.", "..####..", "########", "########", "..####..", ".#.##.#.", "...##..."];
const ICON_MOON = ["...###..", "..##....", ".##.....", ".##.....", ".##.....", ".##.....", "..##..#.", "...####."];
const ICON_RAIN = ["..####..", ".######.", "########", "########", "........", ".#..#..#", "#..#..#.", ".#..#..#"];

function compass(deg: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round((deg % 360) / 45) % 8]!;
}

function xpm(rows: string[], colour: string): string {
  const w = rows[0]!.length;
  const h = rows.length;
  return [`! XPM2`, `${w} ${h} 2 1`, `. c none`, `# c ${colour}`, ...rows].join("\n");
}

/* ---------- pages ---------- */

function textWidth(t: string, font: "tiny" | "small" | "normal" | "bold" | "large" | "extra_large" | "superscript"): number {
  try {
    return measure({ type: "text", id: "m", text: t, font }).width;
  } catch {
    return t.length * 6;
  }
}

function pageList(state: State): PageId[] {
  const pages: PageId[] = ["glance"];
  if (state.settings.showWind) pages.push("wind");
  if (state.settings.showDetails) pages.push("details");
  if (state.weather && state.weather.strikes3h > 0) pages.unshift("lightning");
  return pages;
}

function message(id: string, line: string, colour: string, dx: number): Element[] {
  return [{ id, type: "text", x: SCREEN_W / 2 + dx, y: SCREEN_H / 2, align: "center", text: line, font: "small", color: colour, width: SCREEN_W }];
}

/** How old a reading may get before a failed refresh dims it: a couple of missed polls, and never under ten minutes. */
function staleAfterMs(s: Settings): number {
  return Math.max(s.pollMinutes * 2 + 1, 10) * 60000;
}

/** A reading is stale when refreshing it failed and it is past its age; a refresh still running is not stale. */
function isStale(failed: boolean, at: number, s: Settings): boolean {
  return failed && ageOf(at) > staleAfterMs(s);
}

/** The glance layout with no readings yet: dim placeholders where the temperature and AQI will go. */
function skeletonElements(state: State, id: (name: string) => string, dx: number): Element[] {
  const placeholder = (name: string, x: number, align: "mid_left" | "mid_right"): Element => ({
    id: id(name),
    type: "text",
    x: x + dx,
    y: SCREEN_H / 2,
    align,
    text: "--",
    font: "small",
    color: "#FFFFFF50",
  });
  const elements = [placeholder("big", 12, "mid_left")];
  if (hasAir(state.settings)) elements.push(placeholder("aqi", SCREEN_W - 1, "mid_right"));
  return elements;
}

/** The elements for a page, with every id prefixed by `slot` and shifted by `dx` for slides. */
function pageElements(state: State, page: PageId, slot: string, dx: number): Element[] {
  const s = state.settings;
  // A reading that has failed to refresh for an hour is no longer worth showing, dimmed or not.
  const w = state.weather && !(state.weatherFailed && ageOf(state.weather.at) > CACHE_MAX_AGE_MS) ? state.weather : null;
  const id = (name: string) => `${slot}_${name}`;
  if (!w) return state.weatherError ? message(id("msg"), state.weatherError, "#FFFFFF90", dx) : skeletonElements(state, id, dx);

  const tempF = w.tempC * 1.8 + 32;
  const colour = tempColour(tempF);
  const wStale = isStale(state.weatherFailed, w.at, s);
  const wAlpha = wStale ? STALE_ALPHA : "FF";

  if (page === "glance") {
    // Left: a day, night or rain glyph in the temperature colour, then the temperature. Right: the AQI in its category colour.
    const icon = w.precipNowMm > 0 || (w.rainDayMm > 0 && w.humidity >= 90) ? ICON_RAIN : w.brightness < 50 ? ICON_MOON : ICON_SUN;
    const big = temp(s, w.tempC);
    const bigW = textWidth(big, "extra_large");
    const elements: Element[] = [
      // XPM colours must be plain #RRGGBB; the element's opacity does the dimming.
      { id: id("icon"), type: "xpmbitmap", x: 1 + dx, y: 4, align: "top_left", data: xpm(icon, colour), opacity: wStale ? 35 : 75 },
      { id: id("big"), type: "text", x: 12 + dx, y: 1, align: "top_left", text: big, font: "extra_large", color: colour + wAlpha },
      { id: id("unit"), type: "xpmbitmap", x: 12 + bigW + 2 + dx, y: 2, align: "top_left", data: xpm(s.imperial ? UNIT_F : UNIT_C, colour), opacity: wStale ? 30 : 65 },
    ];
    if (hasAir(s)) {
      const a = state.air && !(state.airFailed && ageOf(state.air.at) > CACHE_MAX_AGE_MS) ? state.air : null;
      if (a) {
        const ac = aqiColour(a.aqi);
        const aStale = isStale(state.airFailed, a.at, s);
        const aqiW = textWidth(String(a.aqi), "extra_large");
        elements.push(
          { id: id("aqi"), type: "text", x: SCREEN_W - 1 + dx, y: 1, align: "top_right", text: String(a.aqi), font: "extra_large", color: ac + (aStale ? STALE_ALPHA : "FF") },
          { id: id("aqibar"), type: "rectangle", x: SCREEN_W - 1 - aqiW + dx, y: SCREEN_H - 1, align: "top_left", width: aqiW, height: 1, fill: "solid", fill_colors: [ac + (aStale ? "40" : "A0")], border_width: 0 },
          { id: id("aqilabel"), type: "xpmbitmap", x: SCREEN_W - 1 - aqiW - 5 + dx, y: 0, align: "top_left", data: xpm(AQI_STACK, ac), opacity: aStale ? 30 : 60 },
        );
      } else {
        elements.push({ id: id("aqi"), type: "text", x: SCREEN_W - 1 + dx, y: SCREEN_H / 2, align: "mid_right", text: "--", font: "small", color: "#FFFFFF50" });
      }
    }
    return elements;
  }

  if (page === "wind") {
    // Arrow and compass letters on the left, the speed big in the middle, unit and gust stacked on the right.
    const calm = w.windAvgMs < 0.3;
    const dir = calm ? "--" : compass(w.windDir);
    const avg = speed(s, w.windAvgMs);
    const bigX = 2 + textWidth("NW", "bold") + 5;
    const colX = bigX + textWidth(avg, "extra_large") + 4;
    return [
      { id: id("dir"), type: "text", x: 2 + dx, y: 4, align: "top_left", text: dir, font: "bold", color: "#7FD4FFE0" },
      { id: id("big"), type: "text", x: bigX + dx, y: 1, align: "top_left", text: avg, font: "extra_large", color: "#FFFFFF" + wAlpha },
      { id: id("unit"), type: "text", x: colX + dx, y: 0, align: "top_left", text: speedUnit(s), font: "small", color: "#FFFFFF90" },
      { id: id("gust"), type: "text", x: colX + dx, y: 8, align: "top_left", text: `GUST ${speed(s, w.windGustMs)}`, font: "small", color: "#7FD4FFE0" },
    ];
  }

  if (page === "lightning") {
    const ago = w.strikeEpoch > 0 ? Math.max(0, Math.round((Date.now() / 1000 - w.strikeEpoch) / 60)) : -1;
    return [
      { id: id("bolt"), type: "text", x: 2 + dx, y: 1, align: "top_left", text: "LIGHTNING", font: "bold", color: "#FFE81FFF" },
      { id: id("detail"), type: "text", x: 2 + dx, y: 10, align: "top_left", text: `${fmt0(w.strikes3h)} in 3h  ${distance(s, w.strikeKm)}${ago >= 0 ? `  ${ago}m ago` : ""}`, font: "tiny", color: "#FFFFFFC0", width: SCREEN_W - 2 },
    ];
  }

  // details: feels-like and humidity, rain today and UV
  const feelsText = `FEELS ${temp(s, w.feelsC)}`;
  const rainText = `RAIN ${rain(s, w.rainDayMm)}`;
  const col2 = 2 + Math.max(textWidth(feelsText, "tiny"), textWidth(rainText, "tiny")) + 6;
  return [
    { id: id("feels"), type: "text", x: 2 + dx, y: 1, align: "top_left", text: feelsText, font: "tiny", color: colour + "E0" },
    { id: id("rh"), type: "text", x: col2 + dx, y: 1, align: "top_left", text: `RH ${fmt0(w.humidity)}%`, font: "tiny", color: "#FFFFFFB0" },
    { id: id("rain"), type: "text", x: 2 + dx, y: 9, align: "top_left", text: rainText, font: "tiny", color: w.rainDayMm > 0 ? "#7FD4FFFF" : "#FFFFFFB0" },
    { id: id("uv"), type: "text", x: col2 + dx, y: 9, align: "top_left", text: `UV ${fmt1(w.uv)}`, font: "tiny", color: w.uv >= 6 ? "#FF9A3CFF" : "#FFFFFFB0" },
  ];
}

/* ---------- app ---------- */

function report(err: unknown): void {
  console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);
}

function main(): void {
  const state: State = {
    settings: { token: "", stationId: "", aqiUrl: "https://api.shawn.party/api/tahome/purple", purpleAirHost: "", purpleAirKey: "", purpleAirIndex: "151596", epaCorrection: true, showWind: true, showDetails: false, imperial: true, pollMinutes: 2, pageSeconds: 8, baseUrl: "https://swd.weatherflow.com/swd", alerts: false, alertLightningDistance: 10, alertRain: true, alertAqi: true, quietStart: 22 * 60, quietEnd: 7 * 60 },
    weather: null,
    air: null,
    weatherError: null,
    airError: null,
    weatherFailed: false,
    airFailed: false,
    polling: false,
    ledPending: null,
    page: "glance",
    shownAt: Date.now(),
    held: false,
    animating: false,
    stopped: false,
    drawing: false,
    redrawWanted: false,
  };

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let slot = "a";
  /** The elements on screen, so a page with different ids can expire exactly these. */
  let shownElements: Element[] = [];

  /**
   * Draws a page. The firmware shows its "Loading..." screen whenever the app has nothing on screen, even for a
   * moment, so the old page is never cleared first: the same draw re-sends its elements with a past `display_until`
   * (a string, as the firmware reads it) and the firmware removes them in that one update. They keep their types,
   * since an update that changes an element's type is rejected.
   */
  async function show(elements: Element[]): Promise<void> {
    const ids = new Set(elements.map((e) => e.id));
    const gone = shownElements.filter((e) => !ids.has(e.id)).map((e): Element => ({ ...e, display_until: "1" }));
    const led = state.ledPending;
    state.ledPending = null;
    await device.DisplayDraw({ application_name: APP, priority: 50, elements: elements.concat(gone), ...(led ? { led_notification_color: led } : {}) });
    shownElements = elements;
  }

  async function draw(): Promise<void> {
    if (state.stopped || state.animating) return;
    if (state.drawing) {
      state.redrawWanted = true;
      return;
    }
    state.drawing = true;
    try {
      await show(pageElements(state, state.page, slot, 0));
    } finally {
      state.drawing = false;
      if (state.redrawWanted && !state.stopped) {
        state.redrawWanted = false;
        void draw().catch(report);
      }
    }
  }

  /** Switches to `next` with a clean cut: one clear of the old page's elements, one draw of the new ones. */
  async function goTo(next: PageId, _dir: 1 | -1): Promise<void> {
    if (state.stopped || state.animating || next === state.page) return;
    state.animating = true;
    const other = slot === "a" ? "b" : "a";
    try {
      slot = other;
      state.page = next;
      state.shownAt = Date.now();
      await show(pageElements(state, next, slot, 0));
    } finally {
      state.animating = false;
    }
  }

  const memory: AlertMemory = {
    weatherSeen: false,
    airSeen: false,
    strikeEpoch: 0,
    lightningAt: 0,
    raining: false,
    wetAt: 0,
    aqiCategory: -1,
    aqiAlertCategory: -1,
    aqiAlertAt: 0,
    soundAt: 0,
  };

  /** Whether a BUSY work session is running; the alert stays silent then. Unknown counts as not busy. */
  async function busySession(): Promise<boolean> {
    try {
      const snap = (await device.BusySnapshotGet()).snapshot as { type?: string; is_paused?: boolean };
      return snap.type !== undefined && snap.type !== "NOT_STARTED" && snap.is_paused !== true;
    } catch {
      return false;
    }
  }

  /** Sounds an alert, blinks the LED and shows the page it is about, unless alerts are off or it is not the time. */
  async function alert(kind: AlertKind, colour: string): Promise<void> {
    const s = state.settings;
    const now = Date.now();
    if (state.stopped || !s.alerts || now - memory.soundAt < ALERT_GAP_MS) return;
    if (inQuietHours(s, new Date(now)) || (await busySession())) return;
    memory.soundAt = now;
    console.log(`${APP}: alert ${kind}`);
    await device.AudioPlay({ application_name: APP, path: ALERT_SOUND[kind] });
    state.ledPending = colour;
    const page: PageId = kind === "lightning" && pageList(state).includes("lightning") ? "lightning" : "glance";
    state.held = false;
    if (page !== state.page) await goTo(page, 1);
    else await draw();
    state.shownAt = Date.now();
  }

  /** Checks a fresh observation for nearby lightning and rain starting. */
  function checkWeather(w: Weather): void {
    const s = state.settings;
    const now = Date.now();
    const first = !memory.weatherSeen;
    memory.weatherSeen = true;

    const newStrike = w.strikeEpoch > memory.strikeEpoch;
    memory.strikeEpoch = Math.max(memory.strikeEpoch, w.strikeEpoch);
    const limitKm = s.imperial ? s.alertLightningDistance * 1.609344 : s.alertLightningDistance;
    const near = s.alertLightningDistance > 0 && w.strikeKm <= limitKm;
    const fresh = now / 1000 - w.strikeEpoch < LIGHTNING_FRESH_S;
    if (!first && newStrike && near && fresh && now - memory.lightningAt >= LIGHTNING_COOLDOWN_MS) {
      memory.lightningAt = now;
      // The rain check below still runs to keep its memory current; the gap between sounds keeps it from doubling up.
      void alert("lightning", "#FFE81FFF").catch(report);
    }

    const raining = w.precipNowMm > 0;
    const started = raining && !memory.raining && now - memory.wetAt >= RAIN_DRY_MS;
    memory.raining = raining;
    if (raining) memory.wetAt = now;
    if (!first && started && s.alertRain) void alert("rain", "#4FA3FFFF").catch(report);
  }

  /** Checks a fresh AQI for a rise into an unhealthy category. */
  function checkAir(a: Air): void {
    const now = Date.now();
    const first = !memory.airSeen;
    memory.airSeen = true;
    const cat = aqiCategory(a.aqi);
    const rose = cat > memory.aqiCategory;
    memory.aqiCategory = cat;
    if (first || !rose || cat < AQI_ALERT_CATEGORY || !state.settings.alertAqi) return;
    if (cat <= memory.aqiAlertCategory && now - memory.aqiAlertAt < AQI_REPEAT_MS) return;
    memory.aqiAlertCategory = cat;
    memory.aqiAlertAt = now;
    void alert("aqi", aqiColour(a.aqi) + "FF").catch(report);
  }

  /** What the glance page shows, to skip snapshot writes that would change nothing visible. */
  function glanceContent(): string {
    const w = state.weather;
    const t = w ? temp(state.settings, w.tempC) : "";
    const day = w ? `${w.precipNowMm > 0}${w.brightness < 50}` : "";
    return `${t}|${state.air?.aqi ?? ""}|${day}|${state.settings.imperial}`;
  }

  /**
   * Refreshes both sources at once and redraws as each lands. A failed source keeps its last reading (dimmed once
   * old) instead of blanking the page.
   */
  async function poll(): Promise<void> {
    if (state.stopped || state.polling) return;
    state.polling = true;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    const s = state.settings;
    const refreshWeather = async (): Promise<void> => {
      if (!s.token || !s.stationId) {
        state.weatherError = !s.token ? "Set WeatherFlow token" : "Set station ID";
        state.weatherFailed = true;
        await draw();
        return;
      }
      try {
        state.weather = await fetchWeather(s);
        state.weatherError = null;
        state.weatherFailed = false;
        checkWeather(state.weather);
      } catch (err) {
        state.weatherError = err instanceof Error ? err.message : String(err);
        state.weatherFailed = true;
        report(err);
      }
      if (!pageList(state).includes(state.page)) state.page = "glance";
      await draw();
    };
    const refreshAir = async (): Promise<void> => {
      if (!hasAir(s)) return;
      try {
        state.air = await fetchAir(s);
        state.airError = null;
        state.airFailed = false;
        checkAir(state.air);
      } catch (err) {
        state.airError = err instanceof Error ? err.message : String(err);
        state.airFailed = true;
        report(err);
      }
      await draw();
    };
    try {
      await Promise.all([refreshWeather(), refreshAir()]);
      if (state.weather) {
        saveSnapshot<Cached>(CACHE_KEY, { weather: state.weather, air: state.air, imperial: s.imperial }, glanceContent(), CACHE_HEARTBEAT_MS);
      }
    } finally {
      state.polling = false;
    }
    schedulePoll(s.pollMinutes * 60000);
  }

  function schedulePoll(delayMs: number): void {
    if (state.stopped) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void poll().catch(report), delayMs);
  }

  function tick(): void {
    if (state.stopped || state.animating) return;
    const seconds = state.settings.pageSeconds;
    const pages = pageList(state);
    if (seconds > 0 && !state.held && pages.length > 1 && Date.now() - state.shownAt >= seconds * 1000) {
      const i = pages.indexOf(state.page);
      void goTo(pages[(i + 1) % pages.length]!, 1).catch(report);
    }
  }

  function stop(unbind: () => void): void {
    state.stopped = true;
    if (pollTimer !== null) clearTimeout(pollTimer);
    if (tickTimer !== null) clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
    setTimeout(unbind, 0);
  }

  const unbind = listen("input", (event) => {
    if (state.stopped) return;
    if (event.key === "back" && event.action === "short") {
      stop(unbind);
      return;
    }
    if (event.key === "encoder") {
      const pages = pageList(state);
      const i = pages.indexOf(state.page);
      const n = pages.length;
      void goTo(pages[(i + event.delta + n) % n]!, event.delta > 0 ? 1 : -1).catch(report);
      return;
    }
    if (event.key === "ok" && event.action === "short") {
      state.held = !state.held;
      state.shownAt = Date.now();
      return;
    }
    if (event.key === "start" && event.action === "short") {
      void poll().catch(report);
    }
  });

  // Paint the last readings at once, so the firmware's loading screen gives way immediately; fresh ones follow.
  const snap = readSnapshot<Cached>(CACHE_KEY);
  if (snap && snap.data.weather && ageOf(snap.savedAt) < CACHE_MAX_AGE_MS) {
    state.weather = snap.data.weather;
    state.air = snap.data.air && ageOf(snap.data.air.at) < CACHE_MAX_AGE_MS ? snap.data.air : null;
    state.settings.imperial = snap.data.imperial !== false;
  }
  void draw().catch(report);

  void loadValues(APP)
    .then((values) => {
      const s = state.settings;
      s.token = str(values, "wf_token", s.token).trim();
      s.stationId = str(values, "wf_station_id", s.stationId).trim();
      s.aqiUrl = str(values, "aqi_url", s.aqiUrl).trim();
      s.purpleAirHost = str(values, "purpleair_host", s.purpleAirHost).trim();
      s.purpleAirKey = str(values, "purpleair_api_key", s.purpleAirKey).trim();
      s.purpleAirIndex = str(values, "purpleair_sensor_index", s.purpleAirIndex).trim() || s.purpleAirIndex;
      s.epaCorrection = bool(values, "epa_correction", s.epaCorrection);
      s.showWind = bool(values, "show_wind", s.showWind);
      s.showDetails = bool(values, "show_details", s.showDetails);
      s.imperial = str(values, "units", "imperial") !== "metric";
      s.pollMinutes = Math.max(1, num(values, "poll_minutes", s.pollMinutes));
      s.pageSeconds = Math.max(0, num(values, "page_seconds", s.pageSeconds));
      s.baseUrl = str(values, "wf_base_url", s.baseUrl).replace(/\/+$/, "") || s.baseUrl;
      s.alerts = bool(values, "alerts", s.alerts);
      s.alertLightningDistance = Math.max(0, num(values, "alert_lightning_distance", s.alertLightningDistance));
      s.alertRain = bool(values, "alert_rain", s.alertRain);
      s.alertAqi = bool(values, "alert_aqi", s.alertAqi);
      s.quietStart = minutesOf(str(values, "quiet_start", ""), s.quietStart);
      s.quietEnd = minutesOf(str(values, "quiet_end", ""), s.quietEnd);
    })
    .catch(report)
    .then(() => {
      tickTimer = setInterval(tick, 1000);
      // Readings younger than one poll interval are as good as a fetch: wait out the rest of the interval.
      const s = state.settings;
      const oldest = Math.min(state.weather ? state.weather.at : 0, hasAir(s) ? (state.air ? state.air.at : 0) : Date.now());
      const wait = s.pollMinutes * 60000 - ageOf(oldest);
      if (wait > 0) schedulePoll(wait);
      else void poll().catch(report);
      // Settings may change what the snapshot drew (units, pages, the AQI column).
      if (!pageList(state).includes(state.page)) state.page = "glance";
      void draw().catch(report);
    });
}

main();
