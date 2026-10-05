#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec flatpak run \
  --env=__NV_PRIME_RENDER_OFFLOAD=1 \
  --env=__GLX_VENDOR_LIBRARY_NAME=nvidia \
  --env=VK_DRIVER_FILES=/usr/share/vulkan/icd.d/nvidia_icd.json \
  --env=VK_LOADER_LAYERS_DISABLE=VK_LAYER_LSFGVK_frame_generation \
  --env=DISABLE_LSFGVK=1 \
  com.brave.Browser \
  --ozone-platform=x11 \
  --enable-unsafe-webgpu \
  --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan \
  --restore-last-session \
  --new-window http://localhost:5173/
