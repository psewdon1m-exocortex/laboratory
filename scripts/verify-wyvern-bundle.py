"""Verify the exact Wyvern runtime dependency against qualified Updater trust."""
import json
from pathlib import Path
import re
import subprocess
import sys

root, public = map(Path, sys.argv[1:])
scripts = Path(__file__).resolve().parent
subprocess.run([sys.executable, str(scripts/'verify-release-manifest.py'), str(root/'wyvern-release.json'), str(root/'wyvern-release.json.sig.json'), str(public)], check=True)
manifest = json.loads((root/'wyvern-release.json').read_bytes())
version = (scripts.parent/'.release/wyvern.version').read_text().strip()
if manifest.get('schema') != 'exocortex.wyvern.release.v1' or manifest.get('product') != 'wyvern' or manifest.get('version') != version or manifest.get('api_version') != 1 or manifest.get('config_schema') != 'exocortex.wyvern.config.v1':
    raise SystemExit('Wyvern identity or API mismatch')
if not re.fullmatch(r'ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+@sha256:[a-f0-9]{64}',manifest.get('image','')) or not {'text','structured_output','pdf'} <= set(manifest.get('capabilities',[])):
    raise SystemExit('Wyvern image or capabilities are incompatible')
