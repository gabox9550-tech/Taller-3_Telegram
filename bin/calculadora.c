#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <libgen.h>

static void ayuda(void) {
    printf("Calculadora de consola - taller_compartir\n\n");
    printf("  calculadora sumar <a> <b>\n");
    printf("  calculadora multiplicar <a> <b>\n");
    printf("  calculadora generar <ruta.py>\n");
}

static const char *plantilla_python =
"# Script generado automaticamente por calculadora\n"
"# Uso: python calculadora_generada.py sumar 2 3\n"
"import sys\n\n"
"def sumar(a, b):\n"
"    return a + b\n\n"
"def multiplicar(a, b):\n"
"    return a * b\n\n"
"def main():\n"
"    if len(sys.argv) < 4:\n"
"        print(\"uso: calculadora_generada.py <sumar|multiplicar> <a> <b>\")\n"
"        return 2\n\n"
"    operacion = sys.argv[1].lower()\n"
"    try:\n"
"        a = float(sys.argv[2])\n"
"        b = float(sys.argv[3])\n"
"    except ValueError:\n"
"        print(\"los operandos deben ser numeros\")\n"
"        return 2\n\n"
"    if operacion == \"sumar\":\n"
"        print(\"%g + %g = %g\" % (a, b, sumar(a, b)))\n"
"    elif operacion == \"multiplicar\":\n"
"        print(\"%g x %g = %g\" % (a, b, multiplicar(a, b)))\n"
"    else:\n"
"        print(\"operacion no valida: \" + operacion)\n"
"        return 2\n"
"    return 0\n\n"
"if __name__ == \"__main__\":\n"
"    sys.exit(main())\n";

int main(int argc, char *argv[]) {
    if (argc < 2 || strcmp(argv[1], "ayuda") == 0 || strcmp(argv[1], "--help") == 0) {
        ayuda();
        return 0;
    }

    const char *operacion = argv[1];

    if (strcasecmp(operacion, "generar") == 0) {
        const char *destino = (argc > 2) ? argv[2] : "calculadora_generada.py";
        FILE *f = fopen(destino, "w");
        if (!f) {
            fprintf(stderr, "No se pudo abrir el archivo destino: %s\n", destino);
            return 2;
        }
        fputs(plantilla_python, f);
        fclose(f);
        printf("Script generado en: %s\n", destino);
        return 0;
    }

    if (strcasecmp(operacion, "sumar") == 0 || strcasecmp(operacion, "multiplicar") == 0) {
        if (argc < 4) {
            fprintf(stderr, "Faltan operandos. Ejemplo: calculadora %s 2 3\n", operacion);
            return 2;
        }
        char *end_a, *end_b;
        double a = strtod(argv[2], &end_a);
        double b = strtod(argv[3], &end_b);

        if (end_a == argv[2] || *end_a != '\0' || end_b == argv[3] || *end_b != '\0') {
            fprintf(stderr, "Los operandos deben ser numeros.\n");
            return 2;
        }

        double res = (strcasecmp(operacion, "sumar") == 0) ? (a + b) : (a * b);
        const char *signo = (strcasecmp(operacion, "sumar") == 0) ? " + " : " x ";
        printf("%g%s%g = %g\n", a, signo, b, res);
        return 0;
    }

    fprintf(stderr, "Operacion no reconocida: %s\n", operacion);
    return 2;
}
