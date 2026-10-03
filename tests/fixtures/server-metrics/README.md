# Engine `/metrics` fixtures

| File | Where it came from |
|---|---|
| `llamacpp-b9151.prom` | **Captured**: `GET /metrics` of a real `llama-server --metrics` (llama.cpp build b9151, Windows, CPU) after one chat completion, 2026-10-04. This build exports no `llamacpp:kv_cache_usage_ratio` and no prefix-cache counters. |
| `vllm-current.prom` | **Not captured** (no vLLM server was available). Written in Prometheus text format from the metric definitions in vLLM's `vllm/v1/metrics/loggers.py` on `main` (2026-10-04): labels `model_name` and `engine`, two engines (data parallel), and the `_created` samples `prometheus_client` adds to every counter. Includes `vllm:external_prefix_cache_*`, which is a different metric and must not be summed in. |
| `vllm-0.9.0.prom` | **Not captured**. Written from `vllm/v1/metrics/loggers.py` at tag `v0.9.0`: the older `vllm:gpu_cache_usage_perc` and `vllm:gpu_prefix_cache_queries` / `_hits` names. |
