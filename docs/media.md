# Multimodal content

Images, audio, video and documents in a request can be recorded on the span - by
reference, or uploaded to a store with the span pointing at them. Off by default.

| Variable | Default | |
|---|---|---|
| `GENAI_OTEL_MEDIA_CAPTURE_MODE` | `off` | `reference_only`: type, MIME type and size; nothing kept or uploaded. `full`: the bytes are redacted (if a redactor is registered), uploaded, and the span carries the URI |
| `GENAI_OTEL_MEDIA_STORE` | `none` | `filesystem`, `http`, `s3`, `minio` |
| `GENAI_OTEL_MEDIA_STORE_ENDPOINT` | | Directory (`filesystem`, default `./genai-otel-media`), gateway URL (`http`), or S3 endpoint (`s3` / `minio`; unset for AWS) |
| `GENAI_OTEL_MEDIA_STORE_BUCKET` | `genai-otel-media` | Bucket, or the subdirectory of the filesystem store |
| `GENAI_OTEL_MEDIA_STORE_PREFIX` | `traces/{date}/{trace_id}/` | Key prefix |
| `GENAI_OTEL_MEDIA_STORE_ACCESS_KEY`, `..._SECRET_KEY` | | S3 credentials; otherwise the AWS SDK's own chain |
| `GENAI_OTEL_MEDIA_MAX_BYTES` | 10 MiB | Larger parts are not uploaded (`stripped_reason = size_exceeded`); inline media over it is not even decoded |
| `GENAI_OTEL_MEDIA_ALLOWED_MODALITIES` | `image,audio,video,document` | Others are stripped (`modality_not_allowed`) |
| `GENAI_OTEL_MEDIA_REDACTOR` | | See below |

Providers: OpenAI (and every client the OpenAI instrumentor traces), Anthropic, Google
Gemini, Groq - as in the reference.

## On the span

Per message `n`: `gen_ai.prompt.{n}.role`. Per part `m`: `gen_ai.prompt.{n}.content.{m}.type`,
then for media `media_uri`, `media_mime_type`, `media_byte_size`, `media_source`
(`inline_offloaded`, `external_url`, `reference_only`), and `gen_ai.media.stripped_reason`
when the bytes were dropped.

**Text needs content capture as well.** A text part's `.text`, and the canonical
`gen_ai.input.messages` (written under the GenAI semconv opt-in), carry what was said, so
they are written only with `GENAI_ENABLE_CONTENT_CAPTURE` on too - unlike the reference,
which writes them whenever media capture is on (SDK_ADDITIONS.md section 5). Media
capture is its own switch: turning it on is the decision to keep the media.

An upload can take a while; the span waits for it and still ends with the time the call
ended. `flushTelemetry()` waits for spans still uploading.

## Redaction

The reference loads a redactor from a Python dotted path, with built-in ones that strip
EXIF data, blur faces and scan PDFs. Here a redactor is a function the application
registers:

```js
import { setMediaRedactor } from '@traceverse/genai-otel-instrument-node';

setMediaRedactor(async (modality, mimeType, bytes) => stripMetadata(bytes));
```

It receives the bytes and returns what to upload. If it throws, the bytes are dropped
(`redactor_error`). If `GENAI_OTEL_MEDIA_REDACTOR` names a redactor and none is
registered - a Python dotted path, say - the bytes are dropped (`redactor_not_allowed`):
media is never uploaded unredacted when redaction was asked for. The reference's built-in
redactors need imaging libraries and are not ported.

## Stores

| Store | Runtime | |
|---|---|---|
| `filesystem` | Node | Files are written `0600` under a `0700` directory; a key that would leave the store is refused. URI: `file://...` |
| `http` | all | `PUT <endpoint>/<key>`. Credentials in the endpoint URL are sent as Basic authorization and never appear in the URI on the span |
| `s3`, `minio` | Node | Needs `@aws-sdk/client-s3` installed by the application. Path-style addressing; the bucket is created if missing. URI: `<endpoint>/<bucket>/<key>`, or `s3://<bucket>/<key>` for AWS |

Under a strict profile, or with external egress off, the network stores refuse a plain
`http://` endpoint, as in the reference.

## What was run

The detector, the offload rules and the canonical form are checked against vectors made by
running the reference's `genai_otel.media` (`tests/fixtures/media/python-vectors.json`).
The span attributes are tested through the real OpenAI and Anthropic clients against the
mock provider, with the filesystem store. The HTTP and S3 stores are tested against a mock
server. Not run against a real MinIO or S3.
