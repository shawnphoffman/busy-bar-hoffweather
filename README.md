# HoffWeather

Weather station and PurpleAir readings from Home Assistant

A JavaScript app for the BUSY Bar, generated from the BUSY JS app template.

## Getting started

```sh
npm install
npm run build         # build the app into dist/app.shawnhoffman.hoffweather.tgz
npm run app:install   # install it on the BUSY Bar connected over USB
npm run app:run       # launch the installed app
```

The app's id is `app.shawnhoffman.hoffweather`, set in `src/appmeta/manifest.json`. An id is `<namespace>.<app>`, at most 32 characters, made of Latin letters, digits, underscores, dashes, and dots, and not starting with a dot. If yours still says `app.example`, change it to your own namespace before publishing.

## Layout

`src/` is the app — everything in it is yours to edit.

The entry point is `src/main.ts` (or `src/main.js`). The name is fixed: the build turns it into `scripts/main.js`, the file the BUSY Bar starts. Any imported modules are emitted as separate files alongside it in `scripts/`, unless `npm run build -- --bundle` inlines them.

`src/main.ts` is run from top to bottom, not imported: it starts the app by calling `main()` at the end and must not export anything. Imported modules can use standard exports.

```
my-app/
├── src/                          the app
│   ├── main.ts                   the entry point: function main(), called at the end
│   ├── appmeta/
│   │   ├── manifest.json         id, name, version, api_version
│   │   ├── settings.json         the settings screen — optional
│   │   ├── icon_front_8x8.png    front icon, 8×8 color — optional
│   │   └── icon_back_11x11.png   back icon, 11×11 grayscale — optional
│   ├── images/
│   ├── animations/
│   └── sounds/
├── shared/                       app-level helpers, imported as @shared/*
```

Both icons are optional; without them a default is used.

## Resources

Anything in `src/` that isn't a source file is copied into the package, sorted by what the BUSY Bar can read:

| Extension | Destination |
| --- | --- |
| `.png` `.image` | `images/` |
| `.anim` | `animations/` |
| `.snd` | `sounds/` |
| anything else | `resources/` |

A file in `src/images`, `src/animations` or `src/sounds` keeps its folder as long as the BUSY Bar reads its format.

`images/`, `animations/` and `sounds/` hold only those formats. An image, animation or sound in another format — `.jpg`, `.gif`, `.svg`, `.wav`, `.mp3` and the like — goes to `resources/`, and the build warns that the device cannot read it.

Everything the app draws goes through the layout helpers in `@busy-app/busy-lib`: build a tree out of `row` / `column` / `stack`, hand it to `render()`, and send the result with `device.DisplayDraw()`. The screen is 72×16 pixels.

## Input

`listen("input", handler)` delivers the device keys: `ok`, `start` and `back` with a `press` / `release` / `short` / `long` / `repeat` action, and `encoder` with a `delta` of `1` or `-1`. It returns an unbind function.

Use `short` as the default action for a button press: it fires once, after a normal press and release. `press` fires immediately on key down and is followed by `short`, so handling `press` as a tap can react twice. Use `long` and `repeat` for hold gestures.

## Commands

| Command | Description |
| --- | --- |
| `npm run build` | empties `dist/` and builds the package into `dist/app.shawnhoffman.hoffweather.tgz` |
| `npm run build -- --emit dir` | leaves the `app.shawnhoffman.hoffweather/` folder instead of the `.tgz` |
| `npm run build -- --emit both` | leaves the folder and the `.tgz` |
| `npm run build -- --out <path>` | builds into `<path>` instead, replacing only this app's package there |
| `npm run build -- --tgz-name <name>` | names the `.tgz`, e.g. `"{id}-{version}.tgz"` |
| `npm run build -- --no-minify` | readable output, for debugging |
| `npm run build -- --bundle` | inlines every module into one `main.js` |
| `npm run build -- --addr <host>` | sets the BUSY Bar address the app connects to, `localhost` by default |
| `npm run typecheck` | type-checks the app |
| `npm run app:install` | installs `dist/app.shawnhoffman.hoffweather.tgz` on the BUSY Bar; build it first with `npm run build` |
| `npm run app:uninstall` | removes the app from the BUSY Bar, keeping its settings |
| `npm run app:run` | launches the installed app |
| `npm run app:stop` | quits the running app |

The four `app:` commands talk to the BUSY Bar connected over USB. For a device connected over Wi-Fi, pass `--addr <host>` with its network IP address or hostname, and `--password <password>` if password protection is enabled:

```sh
npm run app:install -- --addr <host>
npm run app:install -- --addr <host> --password <password>
```

## Build output

The package folder is named after the app id:

```
dist/
└── app.shawnhoffman.hoffweather/
    ├── appmeta/manifest.json
    ├── scripts/main.js
    └── images/ animations/ sounds/ resources/
```

By default the build packs that folder into `dist/app.shawnhoffman.hoffweather.tgz`, with the folder itself at the root of the archive, and removes the folder; `--emit dir` keeps only the folder, `--emit both` keeps both. `--tgz-name` gives the archive another name; `{id}` and `{version}` in it are replaced with the manifest values.

## Releasing

Pushing a git tag matching the manifest `version` (e.g. `0.1.0`) builds the app and attaches `app.shawnhoffman.hoffweather-<version>.tgz` to a GitHub release. The release notes open with the app's name, id, version and API version. The release fails when the tag differs from the manifest `version`.

## Manifest

`src/appmeta/manifest.json` carries the app's identity and a couple of knobs (see the [apps documentation](https://github.com/busy-app/busybar-firmware/blob/dev/documentation/JavaScript%20Applications.dox.md)):

| Field | Description |
| --- | --- |
| `format_version` | manifest format, `1` — required |
| `id` | up to 32 characters — required |
| `name` | display name — required |
| `version` | semver, e.g. `1.0.0` — required |
| `api_version` | minimum BUSY Bar HTTP API version the app needs, e.g. `27.12.0` — required |
| `description`, `author` | free form, default `""` |
| `heap_size_kib` | memory for the app heap, 1–512, default 128 |
| `debug` | when true, shown only in developer mode, default false |

Raise `heap_size_kib` if the app runs out of memory.

## Node version

The app builds on Node 24 — the version in `.nvmrc` and the range `engines` allows. Node 26 breaks the build and is excluded. With `fnm` or `nvm` installed, `fnm use` / `nvm use` picks the right one up from `.nvmrc`.

## Settings

To give the app a settings screen, add `src/appmeta/settings.json` describing the fields, then read the stored values:

```ts
import { loadValues } from "@shared/settings";

const values = await loadValues();
```

`loadValues()` returns `null` when nothing is stored yet — use the defaults.

## Setup

The app reads the two sources directly, no Home Assistant in the path.

1. **WeatherFlow**: the Tempest hub only broadcasts UDP on the LAN, which the bar cannot listen to, so the app uses the WeatherFlow REST API. Create a personal access token at tempestwx.com (Settings, Data Authorizations, Create Token) and note your station ID (the number in the station URL on tempestwx.com).
2. **Air quality**: by default the app reads the tahome proxy at `https://api.shawn.party/api/tahome/purple` (the same source as tahome-ui), which already averages the last ten minutes of sensor 151596, applies the EPA correction and returns `aqi`. It is an internet host, so it works from any Wi-Fi. Clear the **AQI JSON URL** field to use PurpleAir's cloud API directly with a READ **API key** from the API Keys tab at develop.purpleair.com (a long UUID; the 16-character sensor read key is a different thing), or set only the **PurpleAir local address** to read the sensor over the LAN. The direct paths use the same EPA math as the proxy on a single reading.
3. On the bar (device web UI at http://10.0.4.20 over USB, Apps, HoffWeather, or the BUSY mobile app) set **WeatherFlow token**, **WeatherFlow station ID** and **PurpleAir sensor address**. **Wind page** and **Details page** toggle the optional pages. Leave the PurpleAir address empty to skip the air page. **US EPA correction** applies the EPA formula to PM2.5 like the PurpleAir map does.
4. Units, refresh interval and seconds per page are settings too; 0 seconds per page keeps the page you chose.

Pages: the glance page is always on, with a day, night or rain glyph and the temperature in a cold-to-hot colour on the left and the AQI number on the right in its EPA category colour ("--" until the sensor answers). The wind page (compass direction, speed, gust) and the details page (feels-like, humidity, rain today, UV) are toggles in settings, both off by default except wind. A lightning page appears on its own when the station reports strikes in the last three hours.

Launching: the app keeps the last readings on the bar (in `localStorage`, rewritten only when the glance page would change, or every ten minutes otherwise) and paints them the moment it starts. Readings younger than the refresh interval are used as they are; older ones are refreshed in the background, with weather and AQI fetched in parallel. Readings over an hour old are not shown at launch; on the very first launch dim `--` placeholders hold the glance layout until the sources answer. If a refresh fails, the last reading stays and dims once it is more than ten minutes old (or two refresh intervals, if longer), and it is dropped after an hour without an answer.

Alerts: with **Alert sounds** on, the app chimes and blinks the status LED when lightning strikes within **Lightning alert within** (miles, or km with metric units; 0 turns it off), when rain starts after at least 30 dry minutes, or when the AQI rises into Unhealthy for Sensitive Groups (over 100) or worse. Lightning has its own falling three-note sound and jumps to the lightning page; rain and AQI share a rising two-note chime and show the glance page. The rules that keep it quiet:

- It only runs while HoffWeather is the open app; the bar runs one app at a time.
- The first reading after launch only sets a baseline, so opening the app never chimes for conditions that were already there.
- One sound per minute at most; one lightning alert per 15 minutes in a storm; an AQI category is not announced again within an hour (no flapping at 100/101).
- Silent during **Quiet hours** (22:00 to 07:00 by default; equal start and end turns them off) and while a BUSY work session is running.
- Volume is the bar's own volume setting.

The sounds are original bell tones synthesized by `tools/gensounds.py` into `src/sounds/*.snd` (headerless signed 16-bit mono PCM at 44.1 kHz, the BUSY Bar `.snd` format). Run `python3 tools/gensounds.py --wav <dir>` to regenerate them and write `.wav` copies for listening.

Controls: turn the wheel to change pages, press it to hold a page, Start to refresh now, Back to quit.

## Network note

If the bar joins an isolated or IoT Wi-Fi network, that network usually reaches the internet but not the main LAN, so a firewall rule is needed from the bar's address to each LAN source it reads: the PurpleAir sensor on port 80 for HoffWeather's local mode, and the Tautulli host on port 8181 for Now Playing. Give the bar a DHCP reservation first so the rule's source stays valid. Internet sources such as WeatherFlow and the AQI proxy need no rule.
