'use strict';


const path = require('node:path');
const { execFile } = require('node:child_process');

const RAIZ = path.join(__dirname, '..');
const EXE = path.join(RAIZ, 'bin', 'calculadora.exe');
const SCRIPT_PY = path.join(RAIZ, 'python', 'calculadora.py');
const SCRIPT_GRAF = path.join(RAIZ, 'python', 'graficador.py');
const SCRIPT_SISTEMA = path.join(RAIZ, 'python', 'sistema.py');
const RUTA_GRAFICA = path.join(RAIZ, 'datos', 'generado', 'grafica.png');

 
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

// Operaciones permitidas: lista blanca. Nada fuera de aqui se ejecuta.
const OPERACIONES = ['sumar', 'multiplicar', 'fibonacci'];

/**
 * Ejecuta un programa y devuelve su salida.
 * @param {string} programa  ruta o nombre del ejecutable
 * @param {string[]} args    argumentos (array, NUNCA una cadena con espacios)
 * @param {object} opciones  cwd, timeout, etc.
 */
function ejecutar(programa, args, opciones = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      programa,
      args,
      {
        cwd: RAIZ,          // directorio de trabajo fijo y conocido
        timeout: 5000,      // si tarda mas, se mata el proceso
        maxBuffer: 100 * 1024, // limite de salida (evita llenar la RAM)
        windowsHide: true,  // no abrir ventana de consola
        encoding: 'utf8',
        ...opciones,
      },
      (error, stdout, stderr) => {
        if (error) {
          // Guardamos el detalle para que el bot pueda explicar el fallo.
          error.detalle = (stderr || error.message || '').trim();
          return reject(error);
        }
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    );
  });
}

/** Valida que la operacion sea conocida y que a/b sean numeros. */
function validar(operacion, a, b) {
  if (!OPERACIONES.includes(operacion)) {
    throw new Error('Operacion no permitida: ' + operacion);
  }
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('Los operandos deben ser numeros.');
  }
  return [x, y];
}

// --- Las tres formas que ve el taller -------------------------------------

/** 1) Invocar un .exe de consola (proceso nativo de Windows). */
function ejecutarExe(operacion, a, b) {
  const [x, y] = validar(operacion, a, b);
  return ejecutar(EXE, [operacion, String(x), String(y)]);
}

/** 2) Invocar un script de Python. */
function ejecutarPython(operacion, a, b) {
  const [x, y] = validar(operacion, a, b);
  return ejecutar(PYTHON, [SCRIPT_PY, operacion, String(x), String(y)]);
}

/** Valida el argumento n para el cálculo de Fibonacci. */
function validarFibonacci(n) {
  const x = Number(n);
  if (!Number.isInteger(x) || x < 0) {
    throw new Error('El valor de n debe ser un número entero mayor o igual a 0.');
  }
  if (x > 1000) {
    throw new Error('Por seguridad y límites de mensaje, n debe ser menor o igual a 1000.');
  }
  return x;
}

/** Invoca el script de Python para calcular el n-ésimo Fibonacci. */
function ejecutarFibonacci(n) {
  const x = validarFibonacci(n);
  return ejecutar(PYTHON, [SCRIPT_PY, 'fibonacci', String(x)]);
}

/** Invoca el script de Python para generar una gráfica. */
function generarGrafica(expresion, parametro) {
  const args = [SCRIPT_GRAF, expresion];
  if (parametro !== undefined && parametro !== null) {
    args.push(String(parametro));
  }
  return ejecutar(PYTHON, args, { timeout: 10000 });
}

/** Invoca el script de Python para obtener métricas del sistema. */
function obtenerSistema() {
  return ejecutar(PYTHON, [SCRIPT_SISTEMA], { timeout: 4000 });
}

async function versionPython() {
  try {
    const { stdout } = await ejecutar(PYTHON, ['--version'], { timeout: 3000 });
    return stdout || 'desconocida';
  } catch {
    return 'no disponible';
  }
}

module.exports = {
  OPERACIONES,
  RAIZ,
  EXE,
  SCRIPT_PY,
  SCRIPT_GRAF,
  SCRIPT_SISTEMA,
  RUTA_GRAFICA,
  PYTHON,
  ejecutar,
  ejecutarExe,
  ejecutarPython,
  ejecutarFibonacci,
  validarFibonacci,
  generarGrafica,
  obtenerSistema,
  versionPython,
};
