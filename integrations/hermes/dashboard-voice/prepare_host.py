"""Apply the reviewed generic plugin seam to an isolated native checkout."""
import argparse
from pathlib import Path
import shutil
import subprocess

BASE = "1744a19e0df568c647e4f3ff9c37f2a284a282fb"

def prepare(checkout):
    root = Path(checkout).resolve()
    source = Path(__file__).resolve().parent
    head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if head != BASE:
        raise RuntimeError("Native revision differs from the reviewed patch base; review compatibility first")
    if subprocess.check_output(["git", "-C", str(root), "status", "--porcelain"], text=True).strip():
        raise RuntimeError("The native checkout has existing changes")
    patch = source/"host.patch"
    subprocess.run(["git", "-C", str(root), "apply", "--check", str(patch)], check=True)
    subprocess.run(["git", "-C", str(root), "apply", str(patch)], check=True)
    for src, dst in [("chat-plugin-context.ts", "web/src/lib/chat-plugin-context.ts"),
                     ("profile_alias.py", "hermes_cli/profile_alias.py"),
                     ("slot-context.test.tsx", "web/src/plugins/slot-context.test.tsx")]:
        shutil.copy2(source/"host"/src, root/dst)
    print("Generic slot context and explicit profile alias support prepared; no running service changed")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout")
    prepare(parser.parse_args().checkout)
