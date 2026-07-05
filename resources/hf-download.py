#!/usr/bin/env python3
"""
Download a HuggingFace model.

Usage:
  # GGUF — downloads to HF cache (offgrid-ai scanner finds it there)
  python3 hf-download.py --repo unsloth/gemma-4-E2B-it-GGUF --file gemma-4-E2B-it-Q4_K_S.gguf --cache-dir ~/.cache/huggingface/hub

  # MLX — downloads directly to a local directory (oMLX scans ~/.omlx/models)
  python3 hf-download.py --repo mlx-community/gemma-4-e2b-it-4bit --local-dir ~/.omlx/models/mlx-community/gemma-4-e2b-it-4bit

Progress bars are shown via tqdm on stderr (the huggingface_hub default).
Completion/error events are emitted as NDJSON on stdout.
"""
import argparse
import json
import os
import sys


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    parser = argparse.ArgumentParser(description="Download a HuggingFace model.")
    parser.add_argument("--repo", required=True, help="HuggingFace repo ID (e.g. mlx-community/gemma-4-e2b-it-4bit)")
    parser.add_argument("--file", help="Specific filename to download (for GGUF). Omit to download the full repo (MLX).")
    parser.add_argument("--cache-dir", help="HF hub cache directory (for GGUF). Defaults to $HF_HUB_CACHE or $HF_HOME/hub or ~/.cache/huggingface/hub.")
    parser.add_argument("--local-dir", help="Download directly to this directory (for MLX). Flat structure, no cache overhead.")
    args = parser.parse_args()

    try:
        from huggingface_hub import hf_hub_download, snapshot_download
    except ImportError as e:
        emit({"type": "error", "message": f"huggingface_hub is not installed: {e}"})
        sys.exit(1)

    try:
        if args.file:
            # GGUF: download single file to HF cache
            cache_dir = args.cache_dir or os.environ.get("HF_HUB_CACHE") or os.path.join(
                os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface"),
                "hub",
            )
            local_path = hf_hub_download(
                repo_id=args.repo,
                filename=args.file,
                cache_dir=cache_dir,
                resume_download=True,
            )
            emit({
                "type": "complete",
                "localDir": os.path.dirname(local_path),
                "localPath": local_path,
                "format": "gguf",
            })
        elif args.local_dir:
            # MLX: download full repo to a flat local directory
            local_dir = snapshot_download(
                repo_id=args.repo,
                local_dir=args.local_dir,
                resume_download=True,
                ignore_patterns=[".gitattributes", "*.md", "LICENSE"],
            )
            emit({
                "type": "complete",
                "localDir": local_dir,
                "format": "mlx",
            })
        else:
            # Fallback: full repo to HF cache
            cache_dir = args.cache_dir or os.environ.get("HF_HUB_CACHE") or os.path.join(
                os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface"),
                "hub",
            )
            local_dir = snapshot_download(
                repo_id=args.repo,
                cache_dir=cache_dir,
                resume_download=True,
                ignore_patterns=[".gitattributes", "*.md", "LICENSE"],
            )
            emit({
                "type": "complete",
                "localDir": local_dir,
                "format": "mlx",
            })
    except Exception as e:
        emit({"type": "error", "message": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()