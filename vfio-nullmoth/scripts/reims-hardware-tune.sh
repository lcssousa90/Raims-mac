#!/bin/bash
# 1. Expand udmabuf for zero-copy Metal-to-Vulkan DMA (up to 1 GB)
if [ -d /sys/module/udmabuf/parameters ]; then
    echo 1024 > /sys/module/udmabuf/parameters/size_limit_mb 2>/dev/null || true
    echo 32768 > /sys/module/udmabuf/parameters/list_limit 2>/dev/null || true
fi

# 2. Enable CPU Turbo Boost & performance governor when supported
[ -w /sys/devices/system/cpu/cpufreq/boost ] && echo 1 > /sys/devices/system/cpu/cpufreq/boost 2>/dev/null || true
for f in /sys/devices/system/cpu/cpu*/cpufreq/boost; do
    [ -w "$f" ] && echo 1 > "$f" 2>/dev/null || true
done
for g in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    [ -w "$g" ] && echo performance > "$g" 2>/dev/null || true
done
for epp in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
    [ -w "$epp" ] && echo performance > "$epp" 2>/dev/null || true
done

# 3. Lock RTX 3070 clocks to peak performance range only when NVIDIA host driver owns 07:00.0
if command -v nvidia-smi >/dev/null 2>&1 && [ -e /sys/bus/pci/drivers/nvidia/0000:07:00.0 ]; then
    nvidia-smi -pm 1
    nvidia-smi -lgc 1800,2100
    nvidia-smi -lmc 7001,7001
fi

# 4. Disable CPU autogroup throttling
sysctl -w kernel.sched_autogroup_enabled=0

exit 0
