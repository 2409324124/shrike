# Loaded by Python at startup because Shrike puts this folder first on PYTHONPATH. Inert unless Shrike started this process.
import os
import sys

try:
    if sys.version_info >= (3, 12) and os.environ.get("SHRIKE_INGEST_URL") and os.environ.get("SHRIKE_PROJECT_ROOT"):
        import shrike_agent

        shrike_agent.start()
except Exception:
    pass


# Only the first sitecustomize on sys.path runs: run the one ours shadows (Homebrew's, a venv's, the user's own).
def _chain():
    import importlib.machinery
    import importlib.util

    here = os.path.dirname(os.path.abspath(__file__))
    rest = [p for p in sys.path if os.path.abspath(p or os.curdir) != here]
    spec = importlib.machinery.PathFinder.find_spec("sitecustomize", rest)
    if spec is None or spec.loader is None:
        return
    module = importlib.util.module_from_spec(spec)
    sys.modules["sitecustomize"] = module
    spec.loader.exec_module(module)


_chain()
