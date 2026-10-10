// V9: the bundled planner model, downloaded on first use into userData/models with a sha256 check (docs/16 §2.2.2).
// Qwen3 1.7B at Q4_K_M: the smallest quantisation that meets the planner gates (docs/16 §5). Pinned to one revision.
export const PLANNER_MODEL = {
  id: "planner",
  name: "Qwen3 1.7B planner (Q4_K_M)",
  license: "Apache-2.0",
  file: "Qwen3-1.7B-Q4_K_M.gguf",
  url: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_K_M.gguf",
  sha256: "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
  bytes: 1_107_409_472,
} as const;
