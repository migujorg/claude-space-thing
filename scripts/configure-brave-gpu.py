"""Enable Linux WebGPU using Brave Flatpak's supported startup-flags file."""
import datetime
from pathlib import Path
import shutil

path = Path.home() / ".var/app/com.brave.Browser/config/brave-flags.conf"
begin, end = "# Space Thing WebGPU begin", "# Space Thing WebGPU end"
original = path.read_text() if path.exists() else ""
if begin in original:
    first, rest = original.split(begin, 1)
    _, last = rest.split(end, 1)
    original = first + last.lstrip("\n")
block = "\n".join([begin, "--ozone-platform=x11", "--enable-unsafe-webgpu",
                  "features+=Vulkan", "features+=VulkanFromANGLE", "features+=DefaultANGLEVulkan", end]) + "\n"
if path.exists():
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = path.with_name(path.name + ".before-space-thing-" + stamp)
    shutil.copy2(path, backup)
    print("Backup:", backup)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(original.rstrip() + "\n" + block if original.strip() else block)
print("Brave WebGPU startup settings written:", path)
