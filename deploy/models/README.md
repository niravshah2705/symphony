# Model registry manifest

`manifest.json` drives `.github/workflows/publish-models.yml` (which models to
download and publish) and documents what's expected to be live at each
`<engine>/<version>/` prefix in the models GCS bucket. See
`docs/GCP_DEPLOY.md` ("Hosted inference backends") for the full picture — these
weights back the `laya-inference` / `clm-inference` services through the
`INFERENCE_BASE_URL` + `INFERENCE_API_KEY` contract.

Two independent sections, one per engine, each with its own `version` (the
bucket prefix the matching Cloud Run service pins via `MODEL_VERSION` — see
`deploy/gcp/terraform/inference.tf`):

- **`ollama.models[]`** — `{ name, tag }`. `tag` is an Ollama registry pull
  string (e.g. `gemma3:1b`) passed to `ollama pull` in the publish workflow.
  `name` is just a human label; Ollama's own content-addressed
  `blobs/`/`manifests/` layout is what actually gets published. The Ollama
  container serves all models in the pinned bundle.
- **`vllm.models[]`** — `{ name, hfRepo, revision }`. `hfRepo` is a
  HuggingFace repo id; `revision` should be a pinned commit SHA for anything
  beyond a dev deployment (a floating branch like `main` can change under you
  between a publish and a later re-publish). `name` becomes the bucket
  subdirectory (`vllm/<version>/<name>/`) and the value passed to
  `vllm serve` at runtime. vLLM serves exactly one model per instance, so the
  chat model (`gemma-3-1b-it`) and embedding model (`embeddinggemma-300m`) run
  as two separate Cloud Run services.

Gemma HuggingFace repos are gated: accept the license on HuggingFace and set
the `HF_TOKEN` repository secret before publishing.

Bumping a model list here does **not** roll a live deployment — publishing a
new version only takes effect once you bump `var.ollama_model_version` /
`var.vllm_model_version` in Terraform and re-apply, same as the skills
registry's version-pin story.
