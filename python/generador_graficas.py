#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generador de gráficas con Matplotlib para el bot de Telegram.
Uso:
    python generador_graficas.py <ruta_salida_png> <ruta_json_datos>
"""
import sys
import json
import os

# Usar backend 'Agg' para entornos sin servidor gráfico (sin pantalla / headless)
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


PALETA_COLORES = [
    '#2563EB', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
    '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#64748B'
]


def generar_grafica(salida_png, datos):
    titulo = datos.get('titulo', 'Gráfico Estadístico')
    tipo = datos.get('tipo', 'barras').lower()
    etiquetas = datos.get('etiquetas', [])
    valores = datos.get('valores', [])
    eje_y = datos.get('eje_y', 'Valores')
    eje_x = datos.get('eje_x', '')

    if not etiquetas or not valores:
        raise ValueError("Se requieren 'etiquetas' y 'valores' para graficar.")

    # Convertir valores a float/int
    valores_num = [float(v) for v in valores]

    # Configuración de estilo moderno y limpio
    fig, ax = plt.subplots(figsize=(9, 5.5), dpi=160)
    fig.patch.set_facecolor('#0F172A') # Slate oscuro
    ax.set_facecolor('#1E293B')

    colores = PALETA_COLORES[:len(etiquetas)]
    if len(colores) < len(etiquetas):
        colores = colores * ((len(etiquetas) // len(colores)) + 1)
        colores = colores[:len(etiquetas)]

    if tipo in ('pastel', 'pie', 'torta'):
        wedges, texts, autotexts = ax.pie(
            valores_num,
            labels=etiquetas,
            autopct='%1.1f%%',
            startangle=140,
            colors=colores,
            textprops={'color': '#F8FAFC', 'fontsize': 10},
            wedgeprops={'edgecolor': '#0F172A', 'linewidth': 1.5}
        )
        for at in autotexts:
            at.set_color('#FFFFFF')
            at.set_weight('bold')
        ax.set_title(titulo, color='#F8FAFC', fontsize=14, weight='bold', pad=15)
    else:
        # Barras por defecto
        barras = ax.bar(etiquetas, valores_num, color=colores, width=0.55, edgecolor='#334155', linewidth=1)
        ax.set_title(titulo, color='#F8FAFC', fontsize=14, weight='bold', pad=15)
        if eje_y:
            ax.set_ylabel(eje_y, color='#94A3B8', fontsize=11)
        if eje_x:
            ax.set_xlabel(eje_x, color='#94A3B8', fontsize=11)

        ax.tick_params(colors='#CBD5E1', which='both', labelsize=10)
        plt.xticks(rotation=20, ha='right')

        # Cuadrícula sutil
        ax.grid(axis='y', linestyle='--', alpha=0.25, color='#94A3B8')
        ax.set_axisbelow(True)

        # Quitar bordes innecesarios
        for spine in ['top', 'right', 'left', 'bottom']:
            ax.spines[spine].set_color('#334155')

        # Etiquetas de valor sobre cada barra
        max_val = max(valores_num) if valores_num else 100
        for b in barras:
            h = b.get_height()
            ax.annotate(
                f'{h:g}%' if 'probab' in eje_y.lower() or '%' in eje_y else f'{h:g}',
                xy=(b.get_x() + b.get_width() / 2, h),
                xytext=(0, 4),
                textcoords="offset points",
                ha='center', va='bottom',
                fontsize=10, weight='bold', color='#F8FAFC'
            )
        ax.set_ylim(0, max_val * 1.18)

    plt.tight_layout()
    os.makedirs(os.path.dirname(os.path.abspath(salida_png)), exist_ok=True)
    plt.savefig(salida_png, facecolor=fig.get_facecolor(), edgecolor='none', bbox_inches='tight')
    plt.close()


def main():
    if len(sys.argv) < 3:
        print("Uso: python generador_graficas.py <ruta_salida_png> <ruta_json_datos>")
        return 2

    salida_png = sys.argv[1]
    ruta_json = sys.argv[2]

    if not os.path.exists(ruta_json):
        print(f"Error: No existe el archivo {ruta_json}")
        return 2

    with open(ruta_json, 'r', encoding='utf-8') as f:
        datos = json.load(f)

    generar_grafica(salida_png, datos)
    print(f"OK:{salida_png}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
