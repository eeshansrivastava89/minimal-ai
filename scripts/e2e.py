#!/usr/bin/env python3
"""PTY-based end-to-end harness for minimal-ai interactive flows.

Drives the real CLI through a pseudo-terminal against a fully sandboxed
environment (MINIMAL_DIR + fake HOME + fake HF cache) and checks the full
model lifecycle: picker -> download -> glass-box setup -> live server run
-> status/stop -> delete -> uninstall cancel.

Hard-won lessons from the original (lost) /tmp harness:
  - A background reader thread is REQUIRED. Without one the child blocks
    on a full pty buffer and every wait_for() times out.
  - Escape-key flakiness was harness backpressure, not an app bug. Drain
    the pty continuously and it disappears.
  - Enter via `minimal-ai models`, never bare `minimal-ai` — the bare
    command runs update prompts before the picker and derails scripting.

Safety: never touches the real ~/.minimal-ai, ~/.cache/huggingface, or the
global npm install. The uninstall flow is only exercised to its Cancel
path (any other path runs `npm uninstall -g minimal-ai` for real).

Usage:
  python3 scripts/e2e.py                  # full suite (downloads a tiny model)
  python3 scripts/e2e.py --skip-network   # offline checks only
  python3 scripts/e2e.py --keep-sandbox   # keep the sandbox dir for debugging
  python3 scripts/e2e.py --model REPO     # override the download repo
"""

import argparse
import json
import os
import pty
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import fcntl

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO_ROOT, "bin", "minimal-ai.mjs")
NODE = shutil.which("node") or "node"

DEFAULT_MODEL_REPO = "unsloth/SmolLM2-135M-Instruct-GGUF"

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b[>=<]|\r")

DOWN = "\x1b[B"
ENTER = "\r"

# ---------------------------------------------------------------------------
# PTY session
# ---------------------------------------------------------------------------

class PtySession:
    """Spawn minimal-ai in a pty and continuously drain it in a reader thread."""

    def __init__(self, args, env, name=""):
        self.name = name or " ".join(args)
        self.env = env
        master, slave = pty.openpty()
        # Give the child a sane window so cards/pickers render predictably.
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
        self.proc = subprocess.Popen(
            [NODE, BIN, *args],
            stdin=slave, stdout=slave, stderr=slave,
            env=env, cwd=REPO_ROOT, close_fds=True, start_new_session=True,
        )
        os.close(slave)
        self.master = master
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.eof = threading.Event()
        # The reader thread is non-negotiable: without it the child blocks
        # on a full pty buffer mid-render and the harness hangs.
        self.reader = threading.Thread(target=self._drain, daemon=True)
        self.reader.start()

    def _drain(self):
        while True:
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                break
            if not chunk:
                break
            with self.lock:
                self.buf.extend(chunk)
        self.eof.set()

    def text(self):
        with self.lock:
            raw = bytes(self.buf)
        return ANSI_RE.sub("", raw.decode("utf-8", errors="replace"))

    def seen(self, pattern):
        return re.search(pattern, self.text()) is not None

    def wait_for(self, pattern, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.seen(pattern):
                return True
            if self.eof.is_set():
                # Process ended — one last check after output settles.
                time.sleep(0.2)
                return self.seen(pattern)
            time.sleep(0.1)
        return False

    def wait_idle(self, quiet=0.5, timeout=30):
        """Wait until output stops growing for `quiet` seconds."""
        deadline = time.time() + timeout
        last_len, last_change = -1, time.time()
        while time.time() < deadline:
            with self.lock:
                n = len(self.buf)
            if n != last_len:
                last_len, last_change = n, time.time()
            elif time.time() - last_change >= quiet:
                return True
            if self.eof.is_set():
                return True
            time.sleep(0.05)
        return False

    def accept_until(self, final_pattern, max_presses=30, timeout=180):
        """Press Enter on every prompt (accepting defaults) until final appears."""
        deadline = time.time() + timeout
        for _ in range(max_presses):
            if self.seen(final_pattern):
                return True
            if time.time() > deadline or self.eof.is_set():
                break
            self.wait_idle(quiet=0.6, timeout=max(1, deadline - time.time()))
            if self.seen(final_pattern):
                return True
            self.send(ENTER)
        return self.seen(final_pattern)

    def send(self, data, settle=0.3):
        os.write(self.master, data.encode())
        time.sleep(settle)

    def down(self, n=1):
        for _ in range(n):
            self.send(DOWN, settle=0.15)

    def option_lines(self):
        """Option lines (with Clack's filled/hollow circle markers) from the LAST rendered frame.

        The buffer accumulates every re-render, so earlier frames contain
        stale copies of the same options. The active frame starts after the
        last diamond prompt symbol in the buffer.
        """
        text = self.text()
        last = max(text.rfind("\u25c6"), text.rfind("\u25c7"))
        frame = text[last:] if last >= 0 else text
        return [ln for ln in frame.splitlines() if "\u25cf" in ln or "\u25cb" in ln]

    def select_option(self, pattern, timeout=20):
        """Move the highlight to the option whose label matches `pattern` and press Enter.

        Never assume a fixed item position: live oMLX/Ollama servers on the
        host can inject their models into the picker ahead of ours.
        """
        if not self.wait_for(pattern, timeout=timeout):
            return False
        time.sleep(0.4)  # let the frame finish rendering
        lines = self.option_lines()
        current = next((i for i, ln in enumerate(lines) if "\u25cf" in ln), 0)
        target = next((i for i, ln in enumerate(lines) if re.search(pattern, ln)), None)
        if target is None:
            return False
        delta = target - current
        key = DOWN if delta > 0 else "\x1b[A"
        for _ in range(abs(delta)):
            self.send(key, settle=0.15)
        self.send(ENTER)
        return True

    def finish(self, timeout=15):
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return self.proc.wait()

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        try:
            os.close(self.master)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Check runner
# ---------------------------------------------------------------------------

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"
results = []
_current_group = None


def group(name):
    global _current_group
    _current_group = name
    print(f"\n── {name} " + "─" * max(2, 60 - len(name)))


def check(label, ok, detail=""):
    status = PASS if ok else FAIL
    results.append((status, label, detail))
    mark = "✓" if ok else "✗"
    line = f"  {mark} {label}"
    if not ok and detail:
        line += f"\n      {detail}"
    print(line)
    return ok


def skip(label, why):
    results.append((SKIP, label, why))
    print(f"  - {label} (skipped: {why})")


# ---------------------------------------------------------------------------
# Sandbox
# ---------------------------------------------------------------------------

def make_sandbox():
    root = tempfile.mkdtemp(prefix="minimal-e2e-")
    env = dict(os.environ)
    env["HOME"] = os.path.join(root, "home")
    env["MINIMAL_DIR"] = os.path.join(root, "minimal-data")
    env["HF_HUB_CACHE"] = os.path.join(root, "hf-cache")
    env["MINIMAL_NO_UPDATE_CHECK"] = "1"
    env["TERM"] = "xterm-256color"
    env.pop("CI", None)
    env.pop("FORCE_COLOR", None)
    os.makedirs(env["HOME"], exist_ok=True)
    return root, env


def session(args, env, name=""):
    return PtySession(args, env, name=name)


def run_plain(args, env, timeout=60):
    """Non-interactive run (no pty): stdin is a pipe, output captured."""
    proc = subprocess.run([NODE, BIN, *args], env=env, cwd=REPO_ROOT,
                          capture_output=True, text=True, timeout=timeout,
                          stdin=subprocess.DEVNULL)
    return proc.returncode, ANSI_RE.sub("", proc.stdout + proc.stderr)


def profile_ids(env):
    """Profiles live at profiles/<id>/profile.json."""
    pdir = os.path.join(env["MINIMAL_DIR"], "profiles")
    if not os.path.isdir(pdir):
        return []
    return [d for d in os.listdir(pdir)
            if os.path.isfile(os.path.join(pdir, d, "profile.json"))]


# ---------------------------------------------------------------------------
# Check groups
# ---------------------------------------------------------------------------

def checks_cli_basics(env):
    group("CLI basics")

    s = session(["--help"], env)
    s.finish()
    out = s.text()
    check("--help exits 0", s.proc.returncode == 0)
    check("--help shows usage/commands", "USAGE" in out and "COMMANDS" in out)
    s.close()

    s = session(["version"], env)
    s.finish()
    pkg = json.load(open(os.path.join(REPO_ROOT, "package.json")))
    check("version prints current package version",
          f"v{pkg['version']}" in s.text(), s.text()[:200])
    s.close()

    s = session(["nope"], env)
    s.finish()
    check("unknown command errors", s.proc.returncode != 0 and "Unknown command" in s.text())
    s.close()

    s = session(["status"], env)
    s.finish()
    check("status runs in empty sandbox", s.proc.returncode == 0 and "Status" in s.text())
    s.close()

    s = session(["stop", "--all"], env)
    s.finish()
    check("stop --all with nothing running", s.proc.returncode == 0)
    s.close()

    s = session(["run", "does-not-exist"], env)
    s.finish()
    check("run with missing profile errors", s.proc.returncode != 0 and "not found" in s.text())
    s.close()


def checks_empty_picker(env):
    group("Empty-state picker")

    # Always enter via `models` — bare `minimal-ai` fronts update prompts.
    # NOTE: live oMLX/Ollama servers on the host may add their models to the
    # picker; the empty-state guidance only appears when nothing is found.
    s = session(["models"], env)
    ok = s.wait_for(r"Select a model", timeout=30)
    check("picker loads", ok, s.text()[-400:])
    if s.seen(r"No models found yet"):
        check("empty state shows guidance", True)
    else:
        skip("empty state shows guidance", "host managed servers contributed models")
    check("download options listed", s.seen(r"GGUF from HuggingFace"))
    check("manage options listed", s.seen(r"Runtime status"))

    ok = s.select_option(r"GGUF from HuggingFace.*llama")
    check("download flow prompts for repo", ok and s.wait_for(r"HuggingFace repo ID", timeout=15), s.text()[-300:])

    s.send("definitely-not/a-real-repo-zzz")
    s.send(ENTER)
    ok = s.wait_for(r"Could not fetch repo info", timeout=60)
    check("bad repo shows actionable error", ok, s.text()[-400:])
    s.finish()
    s.close()


def checks_download(env, model_repo):
    group("Download")

    s = session(["models"], env)
    if not check("picker loads", s.wait_for(r"Select a model", timeout=30), s.text()[-400:]):
        s.close()
        return None
    if not check("repo prompt", s.select_option(r"GGUF from HuggingFace.*llama") and s.wait_for(r"HuggingFace repo ID", timeout=15)):
        s.close()
        return None
    s.send(model_repo)
    s.send(ENTER)
    if not check("quant picker appears", s.wait_for(r"Select quantization", timeout=60), s.text()[-400:]):
        s.close()
        return None
    check("fit guidance shown", s.seen(r"fits|recommended|tight"))
    s.send(ENTER)  # accept recommended quant
    check("download starts", s.wait_for(r"Downloading", timeout=15))
    ok = s.wait_for(r"Download complete", timeout=600)
    check("download completes", ok, s.text()[-400:])
    s.finish(timeout=30)
    s.close()
    if not ok:
        return None

    cache = env["HF_HUB_CACHE"]
    ggufs = []
    for dirpath, _, files in os.walk(cache):
        ggufs += [os.path.join(dirpath, f) for f in files if f.endswith(".gguf")]
    # Beware huggingface_hub .no_exist negative-cache markers — they end in
    # .gguf too. A real model file is a blob > 10 MB (or a symlink to one).
    real = [g for g in ggufs if ".no_exist" not in g and os.path.getsize(g) > 10 * 1024 * 1024]
    check("GGUF landed in sandbox HF cache", len(real) > 0, str(ggufs))

    fragment = model_repo.split("/")[-1].split("-")[0].lower()
    code, out = run_plain(["models"], env)
    check("scanner lists downloaded model", code == 0 and fragment in out.lower(), out[:400])
    return real[0] if real else None


def checks_setup(env, model_repo):
    group("Glass-box setup")

    model_fragment = re.escape(model_repo.split("/")[-1].split("-")[0])

    s = session(["models"], env)
    # Count varies: live oMLX/Ollama models on the host also land in Needs setup.
    ok = s.wait_for(r"Needs setup \(\d+\)", timeout=30) and s.wait_for(model_fragment, timeout=5)
    if not check("model appears under Needs setup", ok, s.text()[-400:]):
        s.close()
        return False
    ok = s.select_option(model_fragment)
    check("action menu offers Set up", ok and s.wait_for(r"Set up", timeout=15), s.text()[-400:])
    ok = s.select_option(r"Set up")
    ok = ok and s.wait_for(r"Model overview", timeout=30)
    if not check("glass-box overview card", ok, s.text()[-400:]):
        s.close()
        return False

    # Accept every default (GPU layers, context, KV cache, sampling, flash
    # attention, jinja, save) by pressing Enter whenever the UI goes quiet.
    ok = s.accept_until(r"Profile:", max_presses=25, timeout=300)
    text = s.text()
    check("setup completes and saves profile", ok, text[-500:])
    for marker in ["GPU layers", "context window", "KV cache", "Temperature",
                   "Top-p", "flash attention", "Jinja", "Configuration summary"]:
        check(f"prompt shown: {marker}", marker.lower() in text.lower())
    s.finish(timeout=30)
    s.close()

    ids = profile_ids(env)
    if not check("profile JSON written", len(ids) == 1, str(ids)):
        return False
    profile = json.load(open(os.path.join(env["MINIMAL_DIR"], "profiles", ids[0], "profile.json")))
    check("profile backend is llama-cpp", profile.get("backend") == "llama-cpp", str(profile.get("backend")))
    check("profile has ctxSize flag", profile.get("flags", {}).get("ctxSize", 0) >= 1024)
    check("profile model file exists", os.path.exists(profile.get("modelPath", "")))
    return ids[0]


def checks_run(env, profile_id):
    group("Live server run")

    s = session(["run", profile_id, "--with", "server"], env)
    ok = s.wait_for(r"\[ready\]", timeout=180)
    check("server becomes ready", ok, s.text()[-500:])
    ok = s.wait_for(r"\[preflight\] Model loaded", timeout=120)
    check("preflight generates a token", ok, s.text()[-500:])
    check("server endpoint printed", s.wait_for(r"Server running at", timeout=15))
    s.finish(timeout=30)
    s.close()

    s = session(["status"], env)
    s.finish()
    check("status shows one running model", "1 model" in s.text() and "Running now" in s.text(), s.text()[-300:])
    s.close()

    s = session(["stop", "--all"], env)
    s.finish()
    check("stop --all stops the server", s.proc.returncode == 0 and "Stopped" in s.text(), s.text()[-300:])
    s.close()

    s = session(["status"], env)
    s.finish()
    check("status shows nothing running after stop", "none" in s.text(), s.text()[-300:])
    s.close()


def checks_delete(env, model_repo):
    group("Delete")

    model_fragment = re.escape(model_repo.split("/")[-1].split("-")[0])

    s = session(["models"], env)
    ok = s.wait_for(r"Select a model", timeout=30)
    if not check("picker shows configured profile", ok and s.seen(r"llama\.cpp"), s.text()[-400:]):
        s.close()
        return
    ok = s.select_option(model_fragment)
    check("action menu offers Delete model", ok and s.wait_for(r"Delete model", timeout=15), s.text()[-400:])
    ok = s.select_option(r"Delete model")
    ok = ok and s.wait_for(r"permanently delete", timeout=15)
    check("delete warns before acting", ok, s.text()[-400:])
    repo_wide = s.seen(r"Delete the entire repository")
    check("HF repo-wide deletion warning", repo_wide)
    s.send("y")  # confirm (initialValue is false, so explicit y required)
    ok = s.wait_for(r"Deleted .* from HuggingFace cache", timeout=120)
    check("model deleted from sandbox cache", ok, s.text()[-500:])
    s.finish(timeout=30)
    s.close()

    check("profile removed with model", len(profile_ids(env)) == 0, str(profile_ids(env)))

    s = session(["models"], env)
    s.wait_for(r"Select a model", timeout=30)
    time.sleep(0.5)
    check("deleted model gone from picker", not s.seen(model_fragment), s.text()[-400:])
    if s.seen(r"No models found yet"):
        check("picker back to empty state", True)
    else:
        skip("picker back to empty state", "host managed servers contributed models")
    s.close()


def checks_uninstall_cancel(env):
    group("Uninstall (cancel path only)")

    # Never select anything but Cancel here — other paths run
    # `npm uninstall -g minimal-ai` against the real global install.
    s = session(["uninstall"], env)
    ok = s.wait_for(r"Choose uninstall type", timeout=30)
    if not check("uninstall picker appears", ok, s.text()[-400:]):
        s.close()
        return
    ok = s.select_option(r"Cancel")
    ok = ok and s.wait_for(r"Cancelled", timeout=15)
    check("cancel exits cleanly", ok, s.text()[-300:])
    s.finish()
    s.close()
    check("sandbox data dir survives cancel", os.path.isdir(env["MINIMAL_DIR"]))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="minimal-ai pty E2E harness")
    parser.add_argument("--skip-network", action="store_true", help="offline checks only")
    parser.add_argument("--keep-sandbox", action="store_true", help="keep sandbox dir for debugging")
    parser.add_argument("--model", default=DEFAULT_MODEL_REPO, help="HF GGUF repo to download")
    args = parser.parse_args()

    sandbox, env = make_sandbox()
    print(f"minimal-ai E2E — sandbox: {sandbox}")

    started = time.time()
    try:
        checks_cli_basics(env)
        checks_empty_picker(env)
        if args.skip_network:
            for label in ["download", "setup", "live run", "delete"]:
                skip(label, "--skip-network")
        else:
            gguf = checks_download(env, args.model)
            if gguf:
                profile_id = checks_setup(env, args.model)
                if profile_id:
                    checks_run(env, profile_id)
                    checks_delete(env, args.model)
                else:
                    for label in ["live run", "delete"]:
                        skip(label, "setup failed")
            else:
                for label in ["setup", "live run", "delete"]:
                    skip(label, "download failed")
        checks_uninstall_cancel(env)
    finally:
        if args.keep_sandbox:
            print(f"\nSandbox kept at: {sandbox}")
        else:
            shutil.rmtree(sandbox, ignore_errors=True)

    passed = sum(1 for r in results if r[0] == PASS)
    failed = sum(1 for r in results if r[0] == FAIL)
    skipped = sum(1 for r in results if r[0] == SKIP)
    elapsed = time.time() - started
    print(f"\n{'─' * 64}")
    print(f"E2E: {passed} passed, {failed} failed, {skipped} skipped "
          f"({len(results)} checks, {elapsed:.0f}s)")
    if failed:
        print("\nFailed checks:")
        for status, label, detail in results:
            if status == FAIL:
                print(f"  ✗ {label}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
