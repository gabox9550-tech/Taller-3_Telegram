#!/usr/bin/env python3
# ===========================================================================
#  Monitor de Recursos del Sistema (taller Telegram)
#  ---------------------------------------------------------------------------
#  Obtiene métricas de CPU, RAM, Disco y Uptime con psutil.
# ===========================================================================

import time
import platform
import datetime
import psutil


def barra_progreso(porcentaje, longitud=10):
    llenos = int(round((porcentaje / 100) * longitud))
    llenos = max(0, min(longitud, llenos))
    vacios = longitud - llenos
    return "■" * llenos + "□" * vacios


def obtener_info():
    # CPU
    cpu_pct = psutil.cpu_percent(interval=0.2)
    cpus_logicos = psutil.cpu_count(logical=True)
    cpus_fisicos = psutil.cpu_count(logical=False) or cpus_logicos

    # Memoria RAM
    ram = psutil.virtual_memory()
    ram_usada_gb = ram.used / (1024 ** 3)
    ram_total_gb = ram.total / (1024 ** 3)

    # Disco principal
    disco = psutil.disk_usage('/')
    disco_usado_gb = disco.used / (1024 ** 3)
    disco_total_gb = disco.total / (1024 ** 3)

    # Uptime
    uptime_seg = time.time() - psutil.boot_time()
    dias = int(uptime_seg // 86400)
    horas = int((uptime_seg % 86400) // 3600)
    minutos = int((uptime_seg % 3600) // 60)
    segundos = int(uptime_seg % 60)

    partes_uptime = []
    if dias > 0:
        partes_uptime.append(f"{dias}d")
    if horas > 0 or dias > 0:
        partes_uptime.append(f"{horas}h")
    partes_uptime.append(f"{minutos}m {segundos}s")
    uptime_str = " ".join(partes_uptime)

    # Hora actual
    hora_str = datetime.datetime.now().strftime("%H:%M:%S")

    # Sistema
    so = platform.system()
    so_rel = platform.release()

    lineas = [
        "🖥️ *MONITOR DEL SISTEMA*",
        "━━━━━━━━━━━━━━━━━━━━━━",
        f"💻 *SO:* `{so} ({so_rel})`",
        f"⏱️ *Uptime:* `{uptime_str}`",
        "",
        f"⚙️ *CPU:* `{cpu_pct}%` ({cpus_logicos} hilos)",
        f"`[{barra_progreso(cpu_pct)}]`",
        "",
        f"🧠 *RAM:* `{ram.percent}%`",
        f"`[{barra_progreso(ram.percent)}]` {ram_usada_gb:.2f} / {ram_total_gb:.2f} GB",
        "",
        f"💾 *Disco:* `{disco.percent}%`",
        f"`[{barra_progreso(disco.percent)}]` {disco_usado_gb:.1f} / {disco_total_gb:.1f} GB",
        "━━━━━━━━━━━━━━━━━━━━━━",
        f"🕒 _Actualizado:_ `{hora_str}`"
    ]

    return "\n".join(lineas)


if __name__ == "__main__":
    print(obtener_info())

