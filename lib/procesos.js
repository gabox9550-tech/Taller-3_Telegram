'use strict';


const path = require('node:path');
const { execFile } = require('node:child_process');

const RAIZ = path.join(__dirname, '..');
const NOMBRE_EXE = process.platform === 'win32' ? 'calculadora.exe' : 'calculadora';
const EXE = path.join(RAIZ, 'bin', NOMBRE_EXE);
const SCRIPT_PY = path.join(RAIZ, 'python', 'calculadora.py');
const SCRIPT_FIBO = path.join(RAIZ, 'python', 'fibonacci.py');
const SCRIPT_DOCS = path.join(RAIZ, 'python', 'generador_documentos.py');
const SCRIPT_GRAFICAS = path.join(RAIZ, 'python', 'generador_graficas.py');

 
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

// Operaciones permitidas: lista blanca. Nada fuera de aqui se ejecuta.
const OPERACIONES = ['sumar', 'multiplicar'];

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

/** 3) Invocar el generador de Fibonacci en Python para el n-ésimo término. */
function ejecutarFibonacci(n) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1 || num > 500) {
    throw new Error('El parámetro n debe ser un número entero entre 1 y 500.');
  }
  return ejecutar(PYTHON, [SCRIPT_FIBO, String(num)]);
}

/** 4) Invocar el generador de documentos ricos (PDF, DOCX, PPTX, XLSX). */
function generarDocumentoRico(formato, rutaSalida, rutaJson) {
  const formatosValidos = ['pdf', 'docx', 'pptx', 'xlsx', 'excel'];
  if (!formatosValidos.includes(String(formato).toLowerCase())) {
    throw new Error('Formato de documento no soportado: ' + formato);
  }
  return ejecutar(PYTHON, [SCRIPT_DOCS, formato, rutaSalida, rutaJson]);
}

/** 5) Invocar el generador de gráficas estadísticas (PNG con matplotlib). */
function generarGrafica(rutaSalidaPng, rutaJson) {
  return ejecutar(PYTHON, [SCRIPT_GRAFICAS, rutaSalidaPng, rutaJson]);
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
  PYTHON,
  ejecutar,
  ejecutarExe,
  ejecutarPython,
  ejecutarFibonacci,
  generarDocumentoRico,
  generarGrafica,
  versionPython,
};
