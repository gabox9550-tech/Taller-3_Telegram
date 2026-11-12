#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Calcula el n-ésimo número de Fibonacci para el taller de Telegram.
Uso:
    python fibonacci.py <n>
"""
import sys


def generar_fibonacci(n):
    if n <= 0:
        return []
    if n == 1:
        return [0]

    secuencia = [0, 1]
    while len(secuencia) < n:
        secuencia.append(secuencia[-1] + secuencia[-2])
    return secuencia


def main():
    if len(sys.argv) < 2:
        print("Uso: python fibonacci.py <n>")
        return 2

    try:
        n = int(sys.argv[1])
    except ValueError:
        print("Error: El valor 'n' debe ser un número entero.")
        return 2

    if n < 1:
        print("Error: 'n' debe ser al menos 1.")
        return 2

    if n > 500:
        print("Error: Por seguridad el valor máximo de 'n' es 500.")
        return 2

    secuencia = generar_fibonacci(n)
    n_esimo = secuencia[-1]

    print(f"🌀 Cálculo del término n = {n} de Fibonacci:")
    if n <= 30:
        print(f"Secuencia: {', '.join(map(str, secuencia))}\n")
    else:
        print(f"Secuencia: {', '.join(map(str, secuencia[:5]))} ... {', '.join(map(str, secuencia[-3:]))}\n")

    print(f"🎯 El {n}-ésimo número de Fibonacci es: {n_esimo}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
