# llama-server Configuration Template

Recommended configuration for running llama-server with IdleHands, optimized for hybrid Mamba-Transformer models (like Qwen3-Coder) with large context windows.

## Basic Command

```bash
llama-server \
  -m /path/to/model.gguf \
  --port 8082 \
  --host 0.0.0.0 \
  -ngl 99 \
  -fa \
  -np 4 \
  -c 800000 \
  -cb \
  -ctk q4_0 \
  -ctv q4_0 \
  --ctx-checkpoints 0 \
  --cache-reuse 64 \
  --no-warmup \
  --slots
```

## Flag Reference

### Model & Server

| Flag      | Value                 | Description                             |
| --------- | --------------------- | --------------------------------------- |
| `-m`      | `/path/to/model.gguf` | Path to GGUF model file                 |
| `--port`  | `8082`                | Port for HTTP API                       |
| `--host`  | `0.0.0.0`             | Listen on all interfaces                |
| `--slots` | —                     | Enable `/slots` endpoint for monitoring |

### GPU Offloading

| Flag   | Value | Description                                |
| ------ | ----- | ------------------------------------------ |
| `-ngl` | `99`  | Offload all layers to GPU                  |
| `-fa`  | —     | Enable Flash Attention (faster, less VRAM) |

### Context & Slots

| Flag  | Value    | Description                                                    |
| ----- | -------- | -------------------------------------------------------------- |
| `-np` | `4`      | Number of parallel slots (users)                               |
| `-c`  | `800000` | Total context size across all slots (800k ÷ 4 = 200k per slot) |
| `-cb` | —        | Enable continuous batching                                     |

### KV Cache Quantization

| Flag   | Value  | Description                                 |
| ------ | ------ | ------------------------------------------- |
| `-ctk` | `q4_0` | Quantize KV cache keys to Q4_0 (saves VRAM) |
| `-ctv` | `q4_0` | Quantize KV cache values to Q4_0            |

### Hybrid Model Optimizations

| Flag                | Value | Description                                                    |
| ------------------- | ----- | -------------------------------------------------------------- |
| `--ctx-checkpoints` | `0`   | Disable checkpoints (useless after compaction changes content) |
| `--cache-reuse`     | `64`  | Minimum tokens to attempt cache reuse                          |
| `--no-warmup`       | —     | Skip warmup (faster startup)                                   |

### Optional: Custom Chat Template

| Flag                   | Value                     | Description                               |
| ---------------------- | ------------------------- | ----------------------------------------- |
| `--chat-template-file` | `/path/to/template.jinja` | Custom Jinja template for chat formatting |
| `--jinja`              | —                         | Enable Jinja template processing          |

## Systemd Service Example

```ini
[Unit]
Description=llama-server for IdleHands
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER
ExecStart=/path/to/llama-server \
  -m /path/to/model.gguf \
  --port 8082 \
  --host 127.0.0.1 \
  -ngl 99 \
  -fa \
  -np 4 \
  -c 800000 \
  -cb \
  -ctk q4_0 \
  -ctv q4_0 \
  --ctx-checkpoints 0 \
  --cache-reuse 64 \
  --no-warmup \
  --slots
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

## Memory Requirements

For a 200k context per slot with 4 slots:

- **Model**: ~24GB for Q6_K 32B model
- **KV Cache (Q4_0)**: ~20GB for 800k total context
- **Total**: ~48-64GB unified/VRAM recommended

## Slot Affinity

IdleHands supports slot affinity to keep sessions pinned to specific slots, maximizing cache hits. Enable in your IdleHands config:

```json
{
  "models": {
    "providers": {
      "local": {
        "slotAffinity": {
          "enabled": true,
          "numSlots": 4
        }
      }
    }
  }
}
```

## Performance Tips

1. **Disable tool result truncation** - Set `toolResultTruncation: "off"` in IdleHands to prevent cache invalidation
2. **Use quantized KV cache** - `-ctk q4_0 -ctv q4_0` significantly reduces VRAM with minimal quality loss
3. **Match slot count** - Ensure `-np` matches your `slotAffinity.numSlots`
4. **Monitor with /slots** - Check slot usage and cache status via the `/slots` endpoint
