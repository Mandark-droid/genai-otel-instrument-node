# React Native example: on-device chat with cactus, traced

`App.tsx` and `telemetry.ts`: a chat screen that runs a small language model on the
phone with `cactus-react-native` and exports one span per model download, model load and
completion. Modelled on how the LiquidChat app uses cactus (`new CactusLM({ model })`,
`download()`, `init()`, `complete({ messages, onToken })`); LiquidChat itself is not
touched.

Spans: `cactus.download`, `cactus.init`, `cactus.complete` (and `cactus.embed`,
`cactus.stt.transcribe` if the app calls them). `cactus.complete` carries the engine's
own numbers: prompt and output tokens, time to first token, decode tokens per second,
memory in MB, tool calls, and whether the completion was handed off to the cloud.

## Status

| | |
|---|---|
| Instrumentor tested | Yes: `tests/web/on-device.test.ts`, against a stand-in shaped like `CactusLM` 1.13 (constructor, `download`, `init`, `complete`, `embed`, `getModelName`, and the native result fields) |
| This app type-checked | **No.** `react-native` and `cactus-react-native` are not dependencies of this repository |
| Built for Android | **No.** No React Native toolchain where this was written |
| Run on a device or emulator | **No.** |

So what is proven is the instrumentor against the documented shape of the library, not
this app on a phone. The first real run should check, in this order: the app builds; the
SDK's `react-native` entry loads under Hermes; a `cactus.complete` span reaches the
collector with tokens.

## What it needs

A React Native 0.81 project (the version LiquidChat uses) and, on the build machine:

| Android SDK package | Why |
|---|---|
| `platform-tools` | `adb` |
| `platforms;android-36` | compile SDK of React Native 0.81 |
| `build-tools;36.0.0` | build tools of React Native 0.81 |
| `ndk;27.1.12297006` | native code: Hermes, cactus, nitro modules |
| `cmake;3.22.1` | native build of cactus and nitro modules |
| JDK 17 | Gradle |

The emulator image must be `x86_64` or `arm64-v8a`; cactus ships native libraries for
`arm64-v8a`, so on an `x86_64` emulator it runs through ARM translation and is slow. The
model is downloaded by the app on first launch (about 230 MB for `lfm2-350m`), so the
emulator needs outbound network for that once.

## Set it up

```bash
# 1. The SDK as a package (Metro does not follow links out of the project).
cd <this repository> && npm ci && npm run build && npm pack    # -> traceverse-genai-otel-instrument-<version>.tgz

# 2. A fresh app.
npx @react-native-community/cli@latest init GenAiSdkE2E --version 0.81.1
cd GenAiSdkE2E
npm install cactus-react-native react-native-nitro-modules
npm install <path to>/traceverse-genai-otel-instrument-<version>.tgz

# 3. This example.
cp <this repository>/examples/react-native-cactus/App.tsx <this repository>/examples/react-native-cactus/telemetry.ts .

# 4. Point it at the collector: edit COLLECTOR_ENDPOINT in telemetry.ts.
#    From the emulator the host is 10.0.2.2. Plain http needs cleartext allowed:
#    android:usesCleartextTraffic="true" on <application> in android/app/src/main/AndroidManifest.xml.

# 5. Run.
npx react-native run-android
```

The package resolves through its `react-native` export condition, which React Native
0.79 and later honour without configuration.

## What leaves the phone

Only what is listed in [docs/runtimes.md](../../docs/runtimes.md): span names and
timings, model name, token counts, speeds, memory, the session id. Prompt and reply text
are not sent unless content capture is switched on. Nothing is sent anywhere until
`COLLECTOR_ENDPOINT` names a collector.
