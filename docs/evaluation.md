# Evaluation

Six detectors read the prompt and the response of a model call and write what they find
on the span as `evaluation.*` attributes and into `genai.evaluation.*` metrics. They are
ports of the reference implementation's rule-based detectors, checked result for result
against its vectors (`contract/eval_vectors.json`, 194 cases).

Everything is off by default.

| Detector | Switch | What it is |
|---|---|---|
| PII | `GENAI_ENABLE_PII_DETECTION`, `GENAI_PII_MODE` = `detect` \| `redact` \| `block` | 10 regular expressions: email, phone, card, US SSN, IP address, Aadhaar, PAN, UPI, Indian phone, IFSC. No names, no addresses |
| Prompt injection | `GENAI_ENABLE_PROMPT_INJECTION_DETECTION` | patterns in six groups |
| Bias | `GENAI_ENABLE_BIAS_DETECTION` | patterns and keywords in eight groups |
| Restricted topics | `GENAI_ENABLE_RESTRICTED_TOPICS` | patterns and keywords in nine topics |
| Hallucination | `GENAI_ENABLE_HALLUCINATION_DETECTION` | heuristics over the response: claims without citations, hedging, contradiction of the prompt |
| Toxicity | `GENAI_ENABLE_TOXICITY_DETECTION` | **no rules** - see below |

Thresholds and `*_BLOCK_ON_DETECTION` are in [configuration.md](configuration.md).

These are pattern detectors. They are cheap and run in-process with no model; they are
also crude, and their false positives are the reference's ("She is a doctor." is gender
bias; "harmless" contains `harm`). The platform's quality policies are the judge of
record. Treat these as a first signal on the span.

## What is read, and what is recorded

On a call made through an instrumented client the detectors read the **whole prompt**
(every message) and the response, whether or not content capture is on. The text is read
and not recorded: with content capture off, no prompt or response text is on the span.
Two attributes do carry text, as in the reference: `evaluation.pii.*.redacted` (the text
with the PII replaced, in `redact` mode) and the matched fragments in `*_patterns` and
`unsupported_claims`. Turn the detector off if that is not acceptable.

On a span made by other instrumentation the prompt and response are taken from its
attributes or events (`gen_ai.prompt`, `llm.input_messages`, `input.value`, ...). A span
with neither is left alone.

Streamed calls: the prompt is evaluated; the response is not, because the instrumentation
does not keep the streamed text.

## Blocking

`GENAI_PII_MODE=block` and the `*_BLOCK_ON_DETECTION` switches stop a request **before it
is sent**, on calls made through an instrumented client: the call throws
`PolicyViolationError`, the provider is never contacted, and the span has status ERROR
with `evaluation.blocked = true` and `evaluation.blocked_reasons`.

```js
import { PolicyViolationError } from '@traceverse/genai-otel-instrument-node';

try {
  await client.chat.completions.create({ model, messages });
} catch (error) {
  if (error instanceof PolicyViolationError) {
    // error.policy: the first policy that triggered; error.details.reasons: all of them
  }
}
```

The error is thrown synchronously by the client method, not as a rejected promise; `await`
handles both.

Only the prompt can be blocked. A response that trips a detector has already been
produced and returned; the span is annotated (`evaluation.<detector>.response.blocked`),
nothing is withheld from the application. On spans of other instrumentation blocking is
annotation only.

## Toxicity

The reference measures toxicity with a model (Detoxify) or a service (Perspective). It
has no rules for it, and none are invented here. **Until the application supplies a
scorer, enabling toxicity detection writes nothing** - no attribute and no metric. The
reference writes `detected = false` in that situation; a "false" that nothing measured is
not written here.

### An on-prem judge: `GENAI_TOXICITY_JUDGE_URL`

Set `GENAI_TOXICITY_JUDGE_URL` to an http(s) endpoint the operator runs, and toxicity is
scored there (contract/SDK_ADDITIONS.md section 12; the same protocol in every SDK). It is
posted

```json
{"text": "You are an idiot.", "categories": ["identity_attack", "insult", "profanity", "severe_toxicity", "threat", "toxicity"]}
```

and answers `{"scores": {"toxicity": 0.91, ...}}`, or the scores as a flat object as a
Detoxify server does - Detoxify's `obscene` is read as `profanity`. A judge that fails, times
out (the time a span waits for a score, 5 s unless set) or answers with no score measured
nothing: no toxicity attribute is written for that text, never a 0. The request is this
SDK's own and is never traced or counted as the application's traffic, even with
`GENAI_ENABLE_HTTP_INSTRUMENTATION` on. The endpoint is the operator's, so it stays allowed
with `GENAI_AIR_GAPPED`, which forbids downloading models and assets at run time. A scorer
given in code (below) wins over the URL.

### A local model: `GENAI_TOXICITY_ONNX_MODEL`

With the optional add-on `genai-otel-instrument-node-onnx` installed next to this
package, `GENAI_TOXICITY_ONNX_MODEL` names a directory holding a Detoxify-style ONNX
classifier (`model.onnx`, `vocab.txt`, optionally `config.json`), scored in-process by ONNX
Runtime. This package never depends on ONNX Runtime: the add-on is imported on the first
score, only when the variable is set. Not installed, or a model it cannot load: one warning,
and toxicity is not measured. A local file is not a download, so it works air-gapped. See
[onnx/README.md](../onnx/README.md). Node only.

Precedence: a scorer given in code, then `GENAI_TOXICITY_JUDGE_URL`, then
`GENAI_TOXICITY_ONNX_MODEL`.

### A scorer in code

A scorer is a function from text to a score between 0 and 1 per category
(`toxicity`, `severe_toxicity`, `identity_attack`, `insult`, `profanity`, `threat`). Give
it before `instrument()`:

```js
import { instrument, setToxicityScorer } from '@traceverse/genai-otel-instrument-node';

setToxicityScorer(async (text, categories) => {
  // An on-prem endpoint. The mapping from its categories to these is yours to state.
  const response = await fetch('http://litellm.internal:4000/v1/moderations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LITELLM_KEY}` },
    body: JSON.stringify({ model: 'moderation', input: text }),
  });
  const scores = (await response.json()).results[0].category_scores;
  return { toxicity: scores.harassment, threat: scores['harassment/threatening'], identity_attack: scores.hate };
}, { timeoutSeconds: 3 });

instrument();
```

Any other backend works the same way, inside the function.

| | |
|---|---|
| Scorer answers at once | Works on every span |
| Scorer answers with a promise | Works on calls made through an instrumented client: the span is held until the scorer answers or the timeout passes (5 s unless set), and still ends with the time the call ended. `flushTelemetry()` waits for such spans. On spans of other instrumentation nothing is written |
| Scorer throws, rejects or times out | No toxicity attribute for that text; the call and the span are unaffected |
| Blocking on toxicity before the call | Only with a scorer that answers at once. A request cannot be held for a promise without changing what the client method returns |

A scorer that calls outside the organisation is the application's decision and its
responsibility: this package makes no such call itself. `GENAI_TOXICITY_USE_PERSPECTIVE_API`
is read (and forced off when `GENAI_AIR_GAPPED` is set or `GENAI_ALLOW_EXTERNAL_EGRESS` is
not), but no Perspective client ships.

## Using the detectors directly

```js
import { PIIDetector, PromptInjectionDetector } from '@traceverse/genai-otel-instrument-node';

const pii = new PIIDetector({ enabled: true, mode: 'redact' });
pii.detect('Mail jane.doe@example.com').redactedText; // 'Mail ********************'
```

They are plain classes with no dependency on the tracing setup, and are exported from the
browser and React Native entries too. Offsets in PII results are Unicode code points, as
in the reference.

## Differences from the reference

- Toxicity without a scorer writes nothing (above).
- One code path: the span processor evaluates every span while it can still be written.
  The reference evaluates inside its instrumentors and again in a processor.
- A span with no prompt and no response is not marked `evaluation.completed`.
- The detectors' metrics are created on first use, so a detector that never fires leaves
  no empty series.
- Not evaluated in the browser and React Native entries' `instrument()`: the detectors are
  exported there, the automatic span evaluation is not wired.
