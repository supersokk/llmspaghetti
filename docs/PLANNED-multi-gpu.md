# PLANNED — Multi-GPU & model placement

**Status:** design only. Parts are testable on a single GPU today (see
[What we can build & test now](#what-we-can-build--test-now)); the multi-GPU core
is **deferred until 2-GPU hardware exists to test on** — same principle as the
BC-250 and Flux.2 deferrals: we don't ship device-scheduling we can't verify.

---

## The problem

On **one** GPU, chat models and the image model (ComfyUI) fight for the same
VRAM. Today the router does an eject→generate→reload dance: it unloads Ollama's
resident models, lets ComfyUI have the card, generates, then reloads chat (see
`_free_ollama_vram` / `_restore_ollama_vram` in `router/main.py`). It works, but
text and image can never run at the same time.

The whole point of a **second GPU** is to stop dancing: dedicate one card to
ComfyUI, keep chat models resident on the other, and run text + image
**concurrently** with zero ejection. Getting there needs real placement control.

## Four capabilities we want

1. **Per-GPU ejection** — when ComfyUI needs room, free **only the card it will
   run on**, never every GPU. (Today's eject is all-or-nothing → on 2 GPUs it
   would wrongly nuke both.)
2. **Per-model → per-GPU pinning** — "model A on GPU0, model B on GPU1."
3. **Preload/pin ComfyUI to a chosen GPU** — "run ComfyUI on GPU1; warm SDXL
   there."
4. **CPU / RAM placement** — "keep this model in system RAM, served from CPU"
   (zero VRAM). Good for small/embedding models (e.g. `nomic-embed`).

## The hard constraint (shapes everything)

**Ollama does not pin a model to a specific GPU through a single instance.** One
instance auto-schedules across every GPU it can see (and can split one model
across cards). There is no per-request "use GPU N" field.

So per-model GPU placement requires **one Ollama instance per GPU**:

| Instance      | `CUDA_VISIBLE_DEVICES` | Port  | Serves            |
|---------------|------------------------|-------|-------------------|
| `ollama-gpu0` | `0`                    | 11434 | models pinned GPU0|
| `ollama-gpu1` | `1`                    | 11435 | models pinned GPU1|
| (CPU)         | `num_gpu:0` on any instance | —  | RAM-resident, CPU |

The **router owns the model→backend map** and forwards each model to the right
instance. This one choice solves capabilities 1–3 at once: ComfyUI is pinned to
GPU1 (`--cuda-device 1`, a real ComfyUI flag), and ejection only ever touches the
`ollama-gpu1` instance — GPU0 chat is never disturbed.

### Pinning vs. pooling — you can't have both over the same cards

A single Ollama instance that sees **all** GPUs will **automatically split a model
too big for one card across both** (layer-wise; `OLLAMA_SCHED_SPREAD=1` forces
spreading even when it would fit). That's great for one huge LLM — but it's the
**opposite topology** from per-GPU pinning:

| Topology | Big-model auto-split | Per-model GPU pinning |
|---|---|---|
| **1 instance, sees all GPUs** (pool) | ✅ splits across cards | ❌ scheduler decides |
| **N instances, 1 GPU each** (pin) | ❌ boxed to one card | ✅ you choose per model |

You can't run both over the **same** pair of cards — overlapping
`CUDA_VISIBLE_DEVICES` double-books VRAM and OOMs. So it's an **either/or the user
picks per box**:

- **Pool mode** — one big model spanning both cards (e.g. a 70B). No pinning.
- **Pin mode** — several smaller models, each dedicated to a card (e.g. coder on
  GPU0, ComfyUI on GPU1, chat on GPU0). No single-model split.

Implication for the UI: this is a **box-level mode switch** ("Pool GPUs for one
big model" vs "Pin models to GPUs"), not a per-model toggle. Default to **pin
mode** (the concurrency win); expose pool mode for the single-huge-model case.

### CPU / RAM placement — what's real, what isn't

- ✅ **CPU-resident, served from RAM** — `options:{num_gpu:0}` loads all layers
  into system RAM, zero VRAM; `keep_alive:-1` keeps it there. Real, supported.
- ✅ **OS page-cache warmth** — free & automatic. A model's GGUF stays in RAM's
  page cache after first read, so reloading it into VRAM is a fast RAM copy, not a
  cold disk read (given free RAM). *This is why the post-image reload is already
  fast.*
- ❌ **"Staged in RAM, promote to VRAM instantly"** — **not a thing in Ollama.**
  Moving CPU→GPU is a full unload + reload. Don't design around it.

## UI — "Loaded & Placement" section (Models tab)

A residency section in the **Models tab**, distinct from the on-disk catalog:

- One row per **resident** model (from `/api/ps`), with a location badge
  (VRAM / RAM / split) and buttons: **Load ▸ [GPU0 / GPU1 / CPU] · Eject**.
- A first-class **ComfyUI** row: **Preload [→ GPUn] · Eject** — because "which
  model on which card" is one decision; don't split it across tabs.
- The GPU-target dropdown appears **only when >1 GPU is detected**; single-GPU
  boxes just see Load/CPU/Eject.
- The image-checkpoint **catalog** (download/activate) stays in the Image
  Generator tab; this row only loads/ejects the *active* one.
- The Dashboard "Loaded Models" panel stays as the read-only glance + Free VRAM.

## What we can build & test now (single GPU)

### ✅ Done — demote-to-RAM during image gen (instead of eject)

Shipped in `router/main.py`. Replaces the old eject-to-disk with a
**demote → generate → promote** cycle so chat stays alive during image gen on one
card:

- `_demote_ollama_to_cpu()` — reloads each resident model with `options:{num_gpu:0}`
  (+`keep_alive:-1`): VRAM frees for ComfyUI, the model stays **hot in RAM and
  answerable on CPU** while the image renders.
- `_promote_ollama_to_vram(demoted)` — background task on the image response: frees
  ComfyUI's checkpoint, then reloads each demoted model onto the GPU. Because they
  never left RAM, this is a warm move, not a cold disk read.
- **Space-aware skip** — `_comfy_free_vram_mb()` reads ComfyUI's own device from
  `/system_stats`; if it already has ≥ `COMFYUI_MIN_FREE_VRAM_MB` (default 4000)
  free, we **don't disturb chat at all**. So a box with room to spare (or a 2nd GPU
  where ComfyUI's card is free) keeps every model resident.

### ☐ Still to do here (deferred by choice)

- **"Loaded & Placement" UI** — Load-to-GPU / Load-to-CPU / Eject buttons + the
  ComfyUI preload/eject row. Deferred with the GPU-target dropdown to avoid
  building UI whose multi-GPU half we can't test.
- **ComfyUI preload / eject** — warm the active checkpoint via a **loader-only
  workflow** (a `CheckpointLoaderSimple` node, no sampler → loads without
  generating; verify ComfyUI keeps it cached), eject via `POST /free`.

## Deferred until 2-GPU hardware

- Multi-instance Ollama (systemd units per GPU, `CUDA_VISIBLE_DEVICES` + ports).
- Router **model→backend map** and per-GPU forwarding.
- Per-GPU ejection (free only ComfyUI's card).
- Persisted per-model placement preferences.
- ComfyUI `--cuda-device N` pinning wired to the UI target.

## Open questions

- ComfyUI: does a loader-only prompt keep the checkpoint resident, or does it get
  freed without a sampler in the graph? (Verify on box.)
- Demote-instead-of-eject: during image gen on **one** GPU, reload chat models to
  **CPU** (`num_gpu:0`) instead of unloading them — chat stays answerable (slowly)
  while the image generates, promote back after. Testable now; worth it only if
  the demote/promote reload cost beats just waiting for the image. Prototype and
  measure before committing.
- Where does persisted placement live — `config/model-placement.yaml`, read by the
  router at startup and when building the backend map?
