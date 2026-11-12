#!/usr/bin/env python3
# ===========================================================================
#  Generador de Gráficas Matemáticas con Matplotlib
#  ---------------------------------------------------------------------------
#  Invocado por Node.js de forma segura:
#      python graficador.py "x^2"
#      python graficador.py "sin(x)"
#      python graficador.py "fibonacci" 15
# ===========================================================================

import sys
import os
import ast
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ALLOWED_NODES = {
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Call, ast.Name, ast.Constant, ast.Load,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.USub, ast.UAdd
}
ALLOWED_FUNCS = {'sin', 'cos', 'tan', 'sqrt', 'exp', 'log', 'abs'}
ALLOWED_NAMES = {'x', 'pi', 'e'} | ALLOWED_FUNCS


def validar_expresion(expr_str):
    """Valida mediante AST que la expresión solo use operaciones matemáticas seguras."""
    expr_limpia = expr_str.replace('^', '**').strip()
    if len(expr_limpia) > 100:
        raise ValueError("La expresión es demasiado larga (máx 100 caracteres).")

    tree = ast.parse(expr_limpia, mode='eval')
    for node in ast.walk(tree):
        if type(node) not in ALLOWED_NODES:
            raise ValueError(f"Símbolo o estructura no permitida: {type(node).__name__}")
        if isinstance(node, ast.Name) and node.id not in ALLOWED_NAMES:
            raise ValueError(f"Variable no permitida: '{node.id}' (solo se permite 'x')")
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in ALLOWED_FUNCS:
                raise ValueError(f"Función no permitida: '{getattr(node.func, 'id', '?')}'")

    return expr_limpia


def graficar_funcion(expr_orig, ruta_salida):
    expr = validar_expresion(expr_orig)

    # Espacio de evaluación
    x = np.linspace(-10, 10, 600)
    contexto = {
        'x': x,
        'pi': np.pi,
        'e': np.e,
        'sin': np.sin,
        'cos': np.cos,
        'tan': np.tan,
        'sqrt': np.sqrt,
        'exp': np.exp,
        'log': np.log,
        'abs': np.abs,
        '__builtins__': None
    }

    try:
        y = eval(expr, contexto)
        if isinstance(y, (int, float)):
            y = np.full_like(x, y)
    except Exception as err:
        raise ValueError(f"Error evaluando la función: {err}")

    # Limitar valores extremos para que la gráfica no se rompa
    y = np.nan_to_num(y, nan=np.nan, posinf=np.nan, neginf=np.nan)

    plt.figure(figsize=(8, 4.8), dpi=150)
    plt.plot(x, y, color='#2563EB', linewidth=2.5, label=f"f(x) = {expr_orig}")
    plt.axhline(0, color='#64748B', linewidth=0.8, linestyle='--')
    plt.axvline(0, color='#64748B', linewidth=0.8, linestyle='--')
    plt.title(f"Gráfica de f(x) = {expr_orig}", fontsize=14, fontweight='bold', pad=12)
    plt.xlabel("x", fontsize=11)
    plt.ylabel("f(x)", fontsize=11)
    plt.grid(True, linestyle=':', alpha=0.6)
    plt.legend(loc='best', frameon=True)
    plt.tight_layout()

    plt.savefig(ruta_salida)
    plt.close()


def graficar_fibonacci(n, ruta_salida):
    if n < 2:
        n = 2
    if n > 35:
        n = 35  # Límite visual óptimo para gráficas

    secuencia = [0, 1]
    for _ in range(2, n + 1):
        secuencia.append(secuencia[-1] + secuencia[-2])

    indices = list(range(len(secuencia)))

    plt.figure(figsize=(8, 4.8), dpi=150)
    plt.plot(indices, secuencia, color='#7C3AED', marker='o', linewidth=2, markersize=5, label='Curva de crecimiento')
    plt.bar(indices, secuencia, color='#A78BFA', alpha=0.4, width=0.6, label='Valor F(n)')
    plt.title(f"Primeros {n} términos de Fibonacci", fontsize=14, fontweight='bold', pad=12)
    plt.xlabel("n (posición)", fontsize=11)
    plt.ylabel("F(n)", fontsize=11)
    plt.grid(True, linestyle=':', alpha=0.6)
    plt.legend(loc='upper left', frameon=True)
    plt.tight_layout()

    plt.savefig(ruta_salida)
    plt.close()


def main(argv):
    if len(argv) < 2:
        print("Uso: graficador.py <expresion|fibonacci> [parametro] [ruta_salida]")
        return 2

    comando = argv[1].strip()
    raiz = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    carpeta_generado = os.path.join(raiz, "datos", "generado")
    os.makedirs(carpeta_generado, exist_ok=True)
    ruta_salida = os.path.join(carpeta_generado, "grafica.png")

    try:
        if comando.lower() == "fibonacci":
            n = int(argv[2]) if len(argv) > 2 else 15
            if len(argv) > 3:
                ruta_salida = argv[3]
            graficar_fibonacci(n, ruta_salida)
            print(f"Gráfica de Fibonacci({n}) generada con éxito")
        else:
            if len(argv) > 2 and argv[2].endswith('.png'):
                ruta_salida = argv[2]
            graficar_funcion(comando, ruta_salida)
            print(f"Gráfica de {comando} generada con éxito")
        return 0
    except Exception as e:
        print(f"Error al graficar: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

