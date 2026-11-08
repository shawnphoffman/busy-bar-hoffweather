// A small client for the bar's local HTTP API, used in place of busy-lib's BusyBar class.
//
// On the bar, parsing the script is most of the launch time: an app with no libraries draws its first frame about
// 0.8 s after launch, while BusyBar's request stack (about 30 KB) kept the firmware's "Loading..." screen up for
// another two seconds. An app only needs a few endpoints, and the firmware documents calling them with plain
// fetch("http://localhost/api/..."). Types still come from busy-lib; type-only imports add nothing to the bundle.

import type {
  AppSettingsDocument,
  AppsSettingsGetParams,
  AudioPlayParams,
  BusySnapshot,
  DisplayClearParams,
  DisplayDrawParams,
  SuccessResponse,
} from "@busy-app/busy-lib";

const BASE = `http://${__BUSY_ADDR__}/api`;

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} /api${path.split("?")[0]}: HTTP ${res.status}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Shared device client, with the BusyBar method names the app already uses. */
export const device = {
  DisplayDraw: (params: DisplayDrawParams) => call<SuccessResponse>("POST", "/display/draw", { ...params, priority: params.priority ?? 50 }),
  DisplayClear: (params: DisplayClearParams = {}) => call<SuccessResponse>("DELETE", "/display/draw", params),
  AppsSettingsGet: (params: AppsSettingsGetParams) =>
    call<AppSettingsDocument>("GET", `/apps/settings?app_id=${encodeURIComponent(params.app_id)}`),
  AudioPlay: (params: AudioPlayParams) => call<SuccessResponse>("POST", "/audio/play", params),
  BusySnapshotGet: () => call<BusySnapshot>("GET", "/busy/snapshot"),
};
