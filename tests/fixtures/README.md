# Fixtures

HTTP response bodies replayed by the mock provider server in the instrumentor tests.

**These were written by hand to the providers' documented wire formats. They were not
recorded from live API traffic** - no API key was used anywhere in this repository. They
carry the fields the instrumentors read (ids, models, finish reasons, tool calls, usage)
and the framing the SDKs parse (JSON bodies, server-sent events). The real `openai` and
`@anthropic-ai/sdk` clients parse them, so a fixture in the wrong shape fails the test
rather than passing it.

Token counts are chosen to make the assertions unambiguous, not to be realistic.

Never rewrite line endings in this directory: SSE framing depends on them
(`.gitattributes`).
