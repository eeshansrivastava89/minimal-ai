#!/usr/bin/env python3
"""
mlx-vlm server wrapper with strict=False model loading + APC merge fix.

Two monkey-patches are applied before the server starts:

1. strict=False model loading — needed for architectures with shared-KV weight
   schemes (e.g. Gemma 4). Most models (Qwen, Llama, Mistral, Phi) load fine
   with strict=True — strict=False is a no-op for them.

2. BatchRotatingKVCache.merge() shape-mismatch fix — upstream mlx-lm bug
   (ml-explore/mlx-lm PR #1116, Blaizzy/mlx-vlm Issue #923). The merge() method
   crashes with `ValueError: [broadcast_shapes] Shapes (1,1,28,256) and
   (1,1,512,256) cannot be broadcast` when APC merges exact-cache entries with
   different fill levels. This affects all sliding-window attention models
   (Gemma 4, Mistral, Mixtral). The fix uses explicit slicing instead of
   negative indexing to guarantee exactly `l` elements are extracted.

   This patch can be removed once mlx-lm fixes merge() upstream (not fixed in
   0.31.2 or 0.31.3 — the merge() method is identical in both).

Benchmark finding: mlx-vlm clears Metal cache after every request (GitHub Issue
#999) unless APC_ENABLED=1 is set. The env var is set by the Electron app at
spawn time, not in this wrapper.

Usage:
  python3 mlxvlm-server-wrapper.py --model <path> --host 127.0.0.1 --port <port>
"""
import sys

# ── Patch 1: strict=False model loading ──────────────────────────────────────

import mlx_vlm.utils as _utils
_orig_load_model = _utils.load_model

def _patched_load_model(model_path, lazy=False, strict=True, **kwargs):
    return _orig_load_model(model_path, lazy=lazy, strict=False, **kwargs)

_utils.load_model = _patched_load_model

# ── Patch 2: BatchRotatingKVCache.merge() shape-mismatch fix ──────────────────
#
# Upstream bug: _temporal_order() can return a buffer whose seq dimension differs
# from c.size(). The negative slice [..., -l:, :] then produces a mismatched shape,
# crashing with ValueError: [broadcast_shapes].
#
# Fix: use explicit slicing to extract exactly `l` elements, right-aligning within
# the target slice when the buffer is shorter than `l` (left-padded by zeros from
# the pre-allocated target tensor).

import mlx.core as mx
from mlx_lm.models import cache as _lm_cache

_orig_merge = _lm_cache.BatchRotatingKVCache.merge

@classmethod
def _patched_merge(cls, caches):
    if not all(c.max_size == caches[0].max_size for c in caches):
        raise ValueError(
            "BatchRotatingKVCache can only merge caches with the same maximum size"
        )

    offsets = [c.offset for c in caches]
    lengths = [c.size() for c in caches]
    max_length = max(lengths)

    if max_length == 0:
        return cls(caches[0].max_size, [0] * len(caches))

    padding = [max_length - l for l in lengths]
    B = len(caches)
    H = max(c.keys.shape[1] for c in caches if c.keys is not None)
    Dk = max(c.keys.shape[3] for c in caches if c.keys is not None)
    Dv = max(c.values.shape[3] for c in caches if c.values is not None)
    dt = next(iter(c.keys.dtype for c in caches if c.keys is not None))

    keys = mx.zeros((B, H, max_length, Dk), dtype=dt)
    values = mx.zeros((B, H, max_length, Dv), dtype=dt)
    for i, (p, l, c) in enumerate(zip(padding, lengths, caches)):
        if c.keys is None:
            continue
        ordered_k = c._temporal_order(c.keys)
        ordered_v = c._temporal_order(c.values)
        seq_len = ordered_k.shape[2]
        if seq_len >= l:
            # Normal case: extract the last `l` tokens.
            start = seq_len - l
            keys[i : i + 1, :, p : p + l] = ordered_k[..., start : start + l, :]
            values[i : i + 1, :, p : p + l] = ordered_v[..., start : start + l, :]
        else:
            # Buffer shorter than l: right-align within the slice (left-padded
            # by zeros from the pre-allocated target tensor).
            gap = l - seq_len
            keys[i : i + 1, :, p + gap : p + l] = ordered_k
            values[i : i + 1, :, p + gap : p + l] = ordered_v

    cache = cls(caches[0].max_size, padding)
    cache.keys = keys
    cache.values = values
    cache.offset = mx.array(offsets)
    cache._idx = keys.shape[2]
    cache._offset = keys.shape[2]

    return cache

_lm_cache.BatchRotatingKVCache.merge = _patched_merge

# ── Run the server ────────────────────────────────────────────────────────────
# main() parses sys.argv for --model, --host, --port, etc.
from mlx_vlm.server import main
main()

