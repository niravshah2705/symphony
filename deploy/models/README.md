# Model registry manifest

`manifest.json` drives `.github/workflows/publish-models.yml` (which models to
download and publish) and documents what's expected to be live at each
`<engine>/<version>/` prefix in the models GCS bucket. See
`docs/GCP_DEPLOY.md` ("Inference demo") for the full picture — this is a
**standalone demo**, not wired into the fleet's agent runtime or egress proxy.

Two independent sections, one per engine, each with its own `version` (the
bucket prefix the matching Cloud Run service pins via `OLLAMA_MODEL_VERSION` /
`VLLM_MODEL_VERSION` — see `deploy/gcp/terraform/inference.tf`):

- **`ollama.models[]`** — `{ name, tag }`. `tag` is an Ollama registry pull
  string (e.g. `llama3.2:1b`) passed to `ollama pull` in the publish workflow.
  `name` is just a human label; Ollama's own content-addressed
  `blobs/`/`manifests/` layout is what actually gets published.
- **`vllm.models[]`** — `{ name, hfRepo, revision }`. `hfRepo` is a
  HuggingFace repo id; `revision` should be a pinned commit SHA for anything
  beyond a demo (a floating branch like `main` can change under you between a
  publish and a later re-publish). `name` becomes the bucket subdirectory
  (`vllm/<version>/<name>/`) and the value passed to `vllm serve` at runtime.

Bumping a model list here does **not** roll a live deployment — publishing a
new version only takes effect once you bump `var.ollama_model_version` /
`var.vllm_model_version` in Terraform and re-apply, same as the skills
registry's version-pin story.
