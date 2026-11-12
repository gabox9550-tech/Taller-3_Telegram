'use strict';

const dns = require('node:dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');

const proc = require('./lib/procesos');
const { descargar } = require('./lib/archivos');

// --- 1. Configuracion -------------------------------------------------------

// Lee .env sin dependencias externas: una linea KEY=VALOR por variable.
function cargarEnv() {
  const ruta = path.join(__dirname, '.env');
  if (!fs.existsSync(ruta)) return;
  for (const linea of fs.readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
cargarEnv();

const TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(TOKEN || 'sin-token');

if (!TOKEN) {
  console.error('[AVISO] Falta BOT_TOKEN: copia .env.example a .env y pega el token.');
}

// Los errores de red de Telegraf incluyen la URL completa, token incluido.
// Todo lo que se imprime en consola pasa por aqui.
function sinToken(texto) {
  const s = String(texto);
  return TOKEN ? s.split(TOKEN).join('<token>') : s;
}

bot.use((ctx, next) => {
  // No registrar ctx completo ni el texto: pueden incluir datos privados y el token.
  const mensaje = ctx.message;
  const tipo = mensaje?.text ? 'texto'
    : mensaje?.photo ? 'foto'
    : mensaje?.document ? 'documento'
    : ctx.updateType;
  console.log(`[update] ${ctx.updateType}: ${tipo}`);
  return next();
});

// /id va ANTES del filtro de acceso: asi cualquiera puede averiguar su id.
bot.command('id', (ctx) => ctx.reply('Tu id de Telegram es: ' + ctx.from.id));

// Quien puede usar el bot. Con USUARIOS_PERMITIDOS vacio el bot es abierto
// (comodo en el taller); en cuanto lo llenas, solo esos ids pasan.
// Este filtro tambien protege los botones: un callback query es un update mas.
const PERMITIDOS = (process.env.USUARIOS_PERMITIDOS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

bot.use((ctx, next) => {
  if (PERMITIDOS.length === 0) return next();
  if (PERMITIDOS.includes(String(ctx.from?.id))) return next();
  console.log('[bloqueado] usuario no permitido');
});


// --- 2. Utilidades del bot --------------------------------------------------

const AYUDA =
  'Comandos del taller:\n\n' +
  '/sumar 2 3            suma usando Python\n' +
  '/multiplicar 4 2.5    multiplica usando Python\n' +
  '/fibonacci 10         calcula el n-ésimo número de Fibonacci\n' +
  '/graficar sin(x)      genera y envía una gráfica con Python y botones\n' +
  '/sistema              monitor de recursos del sistema en tiempo real\n' +
  '/exe sumar 7 5        invoca calculadora.exe directamente\n' +
  '/calcular 7 5         te muestra botones para elegir\n' +
  '/id                   muestra tu id de Telegram\n' +
  '/pdf                  envia el PDF de ejemplo\n' +
  '/imagen               muestra 3 botones para elegir una imagen\n' +
  '/video                muestra los videos disponibles para elegir\n\n' +
  'Tambien puedes enviarme un documento o una foto.';

/** Responde sin romper el bot si algo falla. */
async function responder(ctx, texto) {
  try {
    await ctx.reply(texto, { disable_web_page_preview: true });
  } catch (e) {
    console.error('No se pudo responder:', sinToken(e.message));
  }
}

/** Extrae dos numeros del texto; devuelve null si no son validos. */
function leerDosNumeros(texto) {
  const partes = String(texto || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length !== 2) return null;
  const nums = partes.map(Number);
  return nums.every(Number.isFinite) ? nums : null;
}

/** Formatea un error de proceso para el usuario. */
function textoError(e) {
  if (e.code === 'ENOENT' || e.code === 'EACCES') {
    return 'No se encontró el programa. Revisa que "python" esté en el PATH ' +
           'y que bin/calculadora.exe exista (solo funciona en Windows; ' +
           'si falta, ejecuta compilar-exe.bat).';
  }
  if (e.killed || e.signal) {
    return 'El proceso tardó demasiado y se canceló.';
  }
  return 'Error al ejecutar: ' + (e.detalle || e.message);
}

/**
 * Envia un documento a Telegram con reintentos usando axios.
 * Esto evita el error "socket hang up" nativo de Telegraf en Node moderno.
 */
async function enviarDocumentoResistente(ctx, buffer, nombreArchivo, caption = '') {
  const url = `https://api.telegram.org/bot${TOKEN}/sendDocument`;

  for (let intento = 1; intento <= 3; intento++) {
    try {
      const form = new FormData();
      form.append('chat_id', String(ctx.chat.id));
      if (caption) {
        form.append('caption', caption);
      }
      
      form.append('document', buffer, {
        filename: nombreArchivo,
        contentType: nombreArchivo.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      });

      await axios.post(url, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 180000, 
      });

      return true; 
    } catch (err) {
      const detalle = sinToken(err.response ? JSON.stringify(err.response.data) : err.message);
      console.error(`[AVISO] Error al enviar el archivo (intento ${intento}/3): ${detalle}`);
      if (intento < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await responder(ctx, '⚠️ No se pudo enviar el archivo después de varios intentos.');
  return false;
}

/**
 * Envia una imagen a Telegram usando axios para evitar cortes de red.
 */
async function enviarFotoResistente(ctx, buffer, nombreArchivo, caption = '') {
  const url = `https://api.telegram.org/bot${TOKEN}/sendPhoto`;

  for (let intento = 1; intento <= 3; intento++) {
    try {
      const form = new FormData();
      form.append('chat_id', String(ctx.chat.id));
      if (caption) {
        form.append('caption', caption);
      }
      
      form.append('photo', buffer, {
        filename: nombreArchivo,
        contentType: nombreArchivo.endsWith('.png') ? 'image/png' : 'image/jpeg', 
      });

      await axios.post(url, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 180000, 
      });

      return true; 
    } catch (err) {
      const detalle = sinToken(err.response ? JSON.stringify(err.response.data) : err.message);
      console.error(`[AVISO] Error al enviar la imagen (intento ${intento}/3): ${detalle}`);
      if (intento < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await responder(ctx, '⚠️ No se pudo enviar la imagen después de varios intentos.');
  return false;
}

const MIME_VIDEOS = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
};
const LIMITE_VIDEO_API_BYTES = 50 * 1024 * 1024; // 50 MB (límite de Telegram Bot API)
const INTERVALO_PROGRESO_TELEGRAM_MS = 2500;
const INTERVALO_PROGRESO_TERMINAL_MS = 250;

function barraProgreso(porcentaje, largo = 12) {
  const pct = Math.min(100, Math.max(0, Number(porcentaje) || 0));
  const llenos = Math.round((pct / 100) * largo);
  return '█'.repeat(llenos) + '░'.repeat(Math.max(0, largo - llenos));
}

function formatearVelocidad(bytesPorSeg) {
  if (!Number.isFinite(bytesPorSeg) || bytesPorSeg <= 0) return 'calculando...';
  const mbPorSeg = bytesPorSeg / (1024 * 1024);
  if (mbPorSeg >= 1) return `${mbPorSeg.toFixed(2)} MB/s`;
  const kbPorSeg = bytesPorSeg / 1024;
  return `${Math.max(1, Math.round(kbPorSeg))} KB/s`;
}

function formatearDuracion(segundos) {
  if (!Number.isFinite(segundos) || segundos < 0) return '--';
  const total = Math.round(segundos);
  if (total < 60) return `${total}s`;
  const min = Math.floor(total / 60);
  const seg = total % 60;
  return `${min}m ${String(seg).padStart(2, '0')}s`;
}

/**
 * Coordina las ediciones del mensaje de progreso en Telegram sin saturar la API
 * ni dejar ediciones en vuelo que pisen el mensaje final.
 */
function crearControladorEstadoTelegram(ctx, textoInicial = '') {
  let ultimoTexto = textoInicial;
  let ultimoEditMs = textoInicial ? Date.now() : 0;
  let enCurso = false;
  let textoPendiente = null;
  let promesaActual = Promise.resolve();

  function lanzarEdicion(texto) {
    if (!ctx || typeof ctx.editMessageText !== 'function') return;
    if (texto === ultimoTexto) return;

    if (enCurso) {
      textoPendiente = texto;
      return;
    }

    enCurso = true;
    ultimoTexto = texto;
    ultimoEditMs = Date.now();

    promesaActual = Promise.resolve(ctx.editMessageText(texto))
      .catch(() => {
        // Ignorar errores transitorios ("message is not modified", 429 o mensaje borrado).
      })
      .finally(() => {
        enCurso = false;
        if (textoPendiente && textoPendiente !== ultimoTexto) {
          const siguiente = textoPendiente;
          textoPendiente = null;
          lanzarEdicion(siguiente);
        } else {
          textoPendiente = null;
        }
      });
  }

  return {
    actualizar(texto, forzar = false) {
      if (!texto || texto === ultimoTexto) return;
      const ahora = Date.now();
      if (!forzar && ahora - ultimoEditMs < INTERVALO_PROGRESO_TELEGRAM_MS) return;
      lanzarEdicion(texto);
    },
    async esperarPendientes() {
      textoPendiente = null;
      await promesaActual;
    },
  };
}

/**
 * Envía un video en streaming usando axios mostrando progreso en vivo en terminal y Telegram.
 */
async function enviarVideoResistente(ctx, rutaVideo, nombreArchivo, caption = '', opciones = {}) {
  const { etiquetaLote = '', controlEstado = null } = opciones;
  const stats = fs.statSync(rutaVideo);
  if (stats.size > LIMITE_VIDEO_API_BYTES) {
    const mb = (stats.size / (1024 * 1024)).toFixed(1);
    await responder(
      ctx,
      `⚠️ El video "${nombreArchivo}" pesa ${mb} MB y supera el límite de 50 MB de la API estándar de Telegram Bots para envío directo.`
    );
    return false;
  }

  const url = `https://api.telegram.org/bot${TOKEN}/sendVideo`;
  const ext = path.extname(nombreArchivo).toLowerCase();
  const contentType = MIME_VIDEOS[ext] || 'video/mp4';
  const totalArchivoMb = (stats.size / (1024 * 1024)).toFixed(1);

  const enviarAccionSubida = () => {
    if (ctx && typeof ctx.sendChatAction === 'function') {
      Promise.resolve(ctx.sendChatAction('upload_video')).catch(() => {});
    }
  };
  enviarAccionSubida();
  const intervaloAccion = setInterval(enviarAccionSubida, 4500);

  try {
    for (let intento = 1; intento <= 3; intento++) {
      const inicioIntentoMs = Date.now();
      let ultimoPrintTerminalMs = 0;
      let ultimoPasoNoTTY = -1;
      let enLineaTTY = false;
      let avisoProcesandoImpreso = false;
      let avisoProcesandoTelegram = false;

      const cerrarLineaTTY = () => {
        if (enLineaTTY) {
          process.stdout.write('\n');
          enLineaTTY = false;
        }
      };

      console.log(
        `[video] Subiendo ${etiquetaLote}"${nombreArchivo}" (${totalArchivoMb} MB) [intento ${intento}/3]...`
      );
      if (controlEstado) {
        controlEstado.actualizar(
          `⏳ Enviando ${etiquetaLote}${nombreArchivo} (${totalArchivoMb} MB)\n` +
          `[${barraProgreso(0, 12)}] 0% • Iniciando subida (intento ${intento}/3)...`,
          intento > 1
        );
      }

      try {
        const form = new FormData();
        form.append('chat_id', String(ctx.chat.id));
        if (caption) {
          form.append('caption', caption);
        }
        form.append('supports_streaming', 'true');
        form.append('video', fs.createReadStream(rutaVideo), {
          filename: nombreArchivo,
          contentType,
        });

        await axios.post(url, form, {
          headers: form.getHeaders(),
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 300000,
          onUploadProgress: (ev) => {
            const totalBytes = ev.total || stats.size || 1;
            const loadedBytes = Math.min(ev.loaded || 0, totalBytes);
            const porcentaje = Math.min(100, Math.max(0, Math.round((loadedBytes / totalBytes) * 100)));
            const cargadoMb = (loadedBytes / (1024 * 1024)).toFixed(1);
            const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
            const transcurridoSeg = (Date.now() - inicioIntentoMs) / 1000;
            const velBps = ev.rate || (transcurridoSeg >= 0.5 ? loadedBytes / transcurridoSeg : 0);
            const etaSeg = Number.isFinite(ev.estimated)
              ? ev.estimated
              : (velBps > 0 ? Math.max(0, (totalBytes - loadedBytes) / velBps) : null);

            if (porcentaje >= 100) {
              if (!avisoProcesandoImpreso) {
                avisoProcesandoImpreso = true;
                const linea100 =
                  `[video] [${barraProgreso(100, 20)}] 100% | ${totalMb}/${totalMb} MB | ` +
                  `Subido en ${formatearDuracion(transcurridoSeg)}`;
                if (process.stdout.isTTY) {
                  process.stdout.write(`\r${linea100}      \n`);
                  enLineaTTY = false;
                } else {
                  console.log(linea100);
                }
                console.log(
                  `[video] Subida al 100% para "${nombreArchivo}". Esperando confirmación de Telegram...`
                );
              }
              if (controlEstado && !avisoProcesandoTelegram) {
                avisoProcesandoTelegram = true;
                controlEstado.actualizar(
                  `⏳ Procesando en Telegram ${etiquetaLote}${nombreArchivo} (${totalArchivoMb} MB)\n` +
                  `[${barraProgreso(100, 12)}] 100% • Subida completa, esperando confirmación...`,
                  true
                );
              }
              return;
            }

            const ahora = Date.now();
            const barraTerm = barraProgreso(porcentaje, 20);
            const resumenVel = `${formatearVelocidad(velBps)} | ETA ${formatearDuracion(etaSeg)}`;

            if (process.stdout.isTTY) {
              if (ahora - ultimoPrintTerminalMs >= INTERVALO_PROGRESO_TERMINAL_MS) {
                ultimoPrintTerminalMs = ahora;
                process.stdout.write(
                  `\r[video] [${barraTerm}] ${String(porcentaje).padStart(3)}% | ${cargadoMb}/${totalMb} MB | ${resumenVel}   `
                );
                enLineaTTY = true;
              }
            } else {
              const paso = Math.floor(porcentaje / 10) * 10;
              if (paso > ultimoPasoNoTTY) {
                ultimoPasoNoTTY = paso;
                console.log(
                  `[video] [${barraTerm}] ${String(porcentaje).padStart(3)}% | ${cargadoMb}/${totalMb} MB | ${resumenVel}`
                );
              }
            }

            if (controlEstado) {
              controlEstado.actualizar(
                `⏳ Enviando ${etiquetaLote}${nombreArchivo} (${totalArchivoMb} MB)\n` +
                `[${barraProgreso(porcentaje, 12)}] ${porcentaje}% • ${cargadoMb}/${totalMb} MB\n` +
                `🚀 ${formatearVelocidad(velBps)} • ⏱️ ETA ${formatearDuracion(etaSeg)} (intento ${intento}/3)`
              );
            }
          },
        });

        cerrarLineaTTY();
        const duracionTotalSeg = (Date.now() - inicioIntentoMs) / 1000;
        console.log(`[video] ✅ "${nombreArchivo}" enviado en ${formatearDuracion(duracionTotalSeg)}.`);
        if (controlEstado) await controlEstado.esperarPendientes();
        return true;
      } catch (err) {
        cerrarLineaTTY();
        const status = err.response?.status;
        const detalle = sinToken(err.response ? JSON.stringify(err.response.data) : err.message);
        console.error(`[AVISO] Error al enviar el video (intento ${intento}/3): ${detalle}`);
        if (status === 413) {
          if (controlEstado) await controlEstado.esperarPendientes();
          await responder(
            ctx,
            `⚠️ Telegram rechazó "${nombreArchivo}" por superar el límite máximo permitido (50 MB).`
          );
          return false;
        }
        if (intento < 3) {
          if (controlEstado) {
            controlEstado.actualizar(
              `⏳ Error temporal al enviar ${etiquetaLote}${nombreArchivo} (intento ${intento}/3). Reintentando en 2.5s...`,
              true
            );
          }
          await new Promise((r) => setTimeout(r, 2500));
        }
      }
    }

    if (controlEstado) await controlEstado.esperarPendientes();
    await responder(ctx, `⚠️ No se pudo enviar el video "${nombreArchivo}" después de varios intentos.`);
    return false;
  } finally {
    clearInterval(intervaloAccion);
  }
}

// --- 3. Comandos basicos ----------------------------------------------------

bot.start((ctx) => responder(ctx, 'Hola 👋 Soy el bot.\n\n' + AYUDA));
bot.help((ctx) => responder(ctx, AYUDA));

// /sumar y /multiplicar usan el script de Python.
for (const operacion of ['sumar', 'multiplicar']) {
  bot.command(operacion, async (ctx) => {
    const nums = leerDosNumeros(ctx.payload);
    if (!nums) {
      return responder(ctx, 'Uso: /' + operacion + ' <numero> <numero>\nEjemplo: /' + operacion + ' 2 3');
    }
    try {
      const { stdout } = await proc.ejecutarPython(operacion, nums[0], nums[1]);
      await responder(ctx, '🐍 ' + stdout);
    } catch (e) {
      await responder(ctx, textoError(e));
    }
  });
}

// /fibonacci calcula el n-ésimo número de Fibonacci mediante Python
bot.command('fibonacci', async (ctx) => {
  const arg = String(ctx.payload || '').trim();
  if (!arg) {
    return responder(ctx, 'Uso: /fibonacci <n>\nEjemplo: /fibonacci 10');
  }

  const n = Number(arg);
  if (!Number.isInteger(n) || n < 0) {
    return responder(ctx, 'El número n debe ser un entero no negativo (>= 0).\nEjemplo: /fibonacci 10');
  }

  if (n > 1000) {
    return responder(ctx, 'Por favor especifica un valor de n menor o igual a 1000.');
  }

  try {
    const { stdout } = await proc.ejecutarFibonacci(n);
    await responder(ctx, '🔢 ' + stdout);
  } catch (e) {
    await responder(ctx, textoError(e));
  }
});

// Función auxiliar para generar y despachar gráficas
async function procesarYEnviarGrafica(ctx, expresion, parametro) {
  try {
    const { stdout } = await proc.generarGrafica(expresion, parametro);
    if (!fs.existsSync(proc.RUTA_GRAFICA)) {
      return responder(ctx, '⚠️ No se pudo generar la imagen de la gráfica.');
    }

    const buffer = fs.readFileSync(proc.RUTA_GRAFICA);
    const caption = expresion.toLowerCase() === 'fibonacci'
      ? `📈 Gráfica de los primeros ${parametro || 15} términos de Fibonacci`
      : `📈 Gráfica de f(x) = ${expresion}`;

    await enviarFotoResistente(ctx, buffer, 'grafica.png', caption);
  } catch (e) {
    await responder(ctx, textoError(e));
  }
}

// Botones rápidos para funciones matemáticas
function tecladoGraficas() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📈 Parábola (x²)', 'graf:x^2'),
     Markup.button.callback('〰️ Seno: sin(x)', 'graf:sin(x)')],
    [Markup.button.callback('🌊 Coseno: cos(x)', 'graf:cos(x)'),
     Markup.button.callback('🌀 Fibonacci: 15', 'graf:fibonacci:15')],
    [Markup.button.callback('📉 Cúbica: x³ - 3x', 'graf:x^3 - 3*x')]
  ]);
}

// /graficar invoca Python + Matplotlib para generar gráficas
bot.command('graficar', async (ctx) => {
  const payload = String(ctx.payload || '').trim();

  if (!payload) {
    return ctx.reply(
      '📊 *Generador de Gráficas Matemáticas (Python + Matplotlib)*\n\n' +
      'Elige una función rápida con los botones o escribe tu propia función:\n' +
      '• `/graficar x^2`\n' +
      '• `/graficar sin(x)`\n' +
      '• `/graficar x^3 - 3*x`\n' +
      '• `/graficar fibonacci 20`',
      { parse_mode: 'Markdown', ...tecladoGraficas() }
    );
  }

  const partes = payload.split(/\s+/);
  if (partes[0].toLowerCase() === 'fibonacci') {
    const n = partes[1] ? Number(partes[1]) : 15;
    if (!Number.isInteger(n) || n < 2 || n > 50) {
      return responder(ctx, 'Para graficar Fibonacci, especifica un número n entre 2 y 50.\nEjemplo: /graficar fibonacci 20');
    }
    return procesarYEnviarGrafica(ctx, 'fibonacci', n);
  }

  return procesarYEnviarGrafica(ctx, payload);
});

// Atiende los clics de los botones de gráficas
bot.action(/^graf:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Generando gráfica...');
  const datos = ctx.match[1].split(':');
  const expr = datos[0];
  const param = datos[1] || null;
  return procesarYEnviarGrafica(ctx, expr, param);
});

// --- Monitor de Recursos del Sistema (psutil + callback queries) -------------

function tecladoSistema() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Actualizar en tiempo real', 'refrescar_sistema')]
  ]);
}

bot.command(['sistema', 'stats'], async (ctx) => {
  try {
    const { stdout } = await proc.obtenerSistema();
    await ctx.reply(stdout, { parse_mode: 'Markdown', ...tecladoSistema() });
  } catch (e) {
    await responder(ctx, textoError(e));
  }
});

// Atiende el clic en "Actualizar en tiempo real" editando el mensaje
bot.action('refrescar_sistema', async (ctx) => {
  try {
    const { stdout } = await proc.obtenerSistema();
    await ctx.answerCbQuery('Métricas actualizadas ⚡');
    await ctx.editMessageText(stdout, { parse_mode: 'Markdown', ...tecladoSistema() });
  } catch (e) {
    if (e.message && e.message.includes('message is not modified')) {
      await ctx.answerCbQuery('Sin cambios recientes');
    } else {
      await ctx.answerCbQuery('Error al actualizar');
      console.error('Error al refrescar sistema:', sinToken(e.message));
    }
  }
});

// /exe invoca el binario de consola directamente.
bot.command('exe', async (ctx) => {
  const partes = String(ctx.payload || '').trim().split(/\s+/).filter(Boolean);
  const operacion = (partes.shift() || '').toLowerCase();

  if (!proc.OPERACIONES.includes(operacion)) {
    return responder(ctx, 'Uso: /exe <sumar|multiplicar> <numero> <numero>\nEjemplo: /exe sumar 7 5');
  }

  const nums = leerDosNumeros(partes.join(' '));
  if (!nums) {
    return responder(ctx, 'Faltan los dos numeros. Ejemplo: /exe sumar 7 5');
  }

  try {
    const { stdout } = await proc.ejecutarExe(operacion, nums[0], nums[1]);
      await responder(ctx, '⚙️ calculadora.exe respondió:\n' + stdout);
  } catch (e) {
    await responder(ctx, textoError(e));
  }
});


// --- Teclados en linea y callback queries ----------------------------------
//
//  Un teclado en linea son botones pegados al mensaje. Cada boton lleva un
//  callback_data (maximo 64 bytes). Al pulsarlo Telegram NO manda texto:
//  manda un "callback query" con ese callback_data, y Telegraf lo entrega
//  a bot.action(...).
//
//      /calcular 7 5  ->  [botones]  ->  clic  ->  bot.action  ->  .exe/Python
//
//  Aqui el callback_data lleva todo lo necesario ("calc:sumar:exe:7:5"),
//  asi que el bot no guarda nada en memoria entre el comando y el clic.

const MOTORES = { py: '🐍 Python', exe: '⚙️ .exe' };

bot.command('calcular', async (ctx) => {
  const nums = leerDosNumeros(ctx.payload);
  if (!nums) {
    return responder(ctx, 'Uso: /calcular <numero> <numero>\nEjemplo: /calcular 7 5');
  }
  const [a, b] = nums;

  // El dato mas largo posible debe caber en 64 bytes.
  if (Buffer.byteLength(`calc:multiplicar:exe:${a}:${b}`) > 64) {
    return responder(ctx, 'Esos numeros son demasiado largos para un boton.');
  }

  const boton = (texto, operacion, motor) =>
    Markup.button.callback(texto, `calc:${operacion}:${motor}:${a}:${b}`);

  const teclado = Markup.inlineKeyboard([
    [boton('➕ Sumar con Python', 'sumar', 'py'),
     boton('➕ Sumar con .exe', 'sumar', 'exe')],
    [boton('✖️ Multiplicar con Python', 'multiplicar', 'py'),
     boton('✖️ Multiplicar con .exe', 'multiplicar', 'exe')],
  ]);

  await ctx.reply(`¿Qué hago con ${a} y ${b}?`, teclado);
});

// Atrapa cualquier boton cuyo callback_data tenga la forma calc:op:motor:a:b
bot.action(/^calc:(sumar|multiplicar):(py|exe):([^:]+):([^:]+)$/, async (ctx) => {
  // ctx.match es el resultado de la expresion regular.
  const [, operacion, motor, a, b] = ctx.match;

  // 1) Siempre contestar el clic: apaga el relojito del boton.
  await ctx.answerCbQuery('Calculando...');

  // 2) Cambiar el mensaje. Al editar sin reply_markup, los botones
  //    desaparecen: asi no se pulsan dos veces.
  await ctx.editMessageText('⏳ Ejecutando con ' + MOTORES[motor] + '...');

  // 3) Ejecutar. El callback_data NO es de fiar: ejecutarExe y
  //    ejecutarPython vuelven a validar operacion y numeros.
  try {
    const ejecutar = motor === 'exe' ? proc.ejecutarExe : proc.ejecutarPython;
    const { stdout } = await ejecutar(operacion, a, b);
    await ctx.editMessageText(MOTORES[motor] + '\n' + stdout);
  } catch (e) {
    await ctx.editMessageText(textoError(e));
  }
});

// --- Enviar archivos locales ---

bot.command('pdf', async (ctx) => {
  const rutaPdfSub = path.join(__dirname, 'datos', 'paraEnviar', 'PDF', 'ejemplo.pdf');
  const rutaPdf = fs.existsSync(rutaPdfSub)
    ? rutaPdfSub
    : path.join(__dirname, 'datos', 'paraEnviar', 'ejemplo.pdf');

  if (!fs.existsSync(rutaPdf)) {
    return responder(ctx, '⚠️ El PDF no se encuentra en el servidor. Revisa la carpeta datos/paraEnviar/PDF/');
  }

  try {
    const archivoBuffer = fs.readFileSync(rutaPdf);
    
    await enviarDocumentoResistente(
      ctx,
      archivoBuffer,
      'ejemplo.pdf',
      '📄 Aquí tienes el PDF que solicitaste.'
    );
  } catch (e) {
    await responder(ctx, 'Error al enviar el PDF: ' + e.message);
  }
});

const IMAGENES_PERMITIDAS = {
  img1: { archivo: 'ejemplo.jpg', etiqueta: '🖼️ Imagen 1 (ejemplo.jpg)' },
  img2: { archivo: 'Ejemplo 2.jpeg', etiqueta: '🖼️ Imagen 2 (Ejemplo 2.jpeg)' },
  img3: { archivo: 'Ejemplo 3.jpeg', etiqueta: '🖼️ Imagen 3 (Ejemplo 3.jpeg)' },
};

bot.command('imagen', async (ctx) => {
  const teclado = Markup.inlineKeyboard([
    [Markup.button.callback(IMAGENES_PERMITIDAS.img1.etiqueta, 'img:img1')],
    [Markup.button.callback(IMAGENES_PERMITIDAS.img2.etiqueta, 'img:img2')],
    [Markup.button.callback(IMAGENES_PERMITIDAS.img3.etiqueta, 'img:img3')],
  ]);

  await ctx.reply('Que imagen quieres solicitar🤔', teclado);
});

bot.action(/^img:(img1|img2|img3)$/, async (ctx) => {
  const clave = ctx.match[1];
  const seleccion = Object.prototype.hasOwnProperty.call(IMAGENES_PERMITIDAS, clave)
    ? IMAGENES_PERMITIDAS[clave]
    : null;

  if (!seleccion) {
    return ctx.answerCbQuery('Opción no válida.');
  }

  await ctx.answerCbQuery('Enviando imagen...');

  const rutaImgSub = path.join(__dirname, 'datos', 'paraEnviar', 'Imagenes', seleccion.archivo);
  const rutaImg = fs.existsSync(rutaImgSub)
    ? rutaImgSub
    : path.join(__dirname, 'datos', 'paraEnviar', seleccion.archivo);
  if (!fs.existsSync(rutaImg)) {
    await ctx.editMessageText('⚠️ La imagen no se encuentra en el servidor. Revisa la carpeta datos/paraEnviar/Imagenes/');
    return;
  }

  await ctx.editMessageText(`⏳ Enviando ${seleccion.archivo}...`);

  try {
    const archivoBuffer = fs.readFileSync(rutaImg);

    const enviado = await enviarFotoResistente(
      ctx,
      archivoBuffer,
      seleccion.archivo,
      `🖼️ Aquí tienes la imagen solicitada: ${seleccion.archivo}`
    );

    if (enviado) {
      await ctx.editMessageText(`✅ Imagen enviada: ${seleccion.archivo}`);
    }
  } catch (e) {
    await ctx.editMessageText('Error al enviar la imagen: ' + e.message);
  }
});

// --- Selección dinámica y envío múltiple de videos -------------------------

const CARPETA_VIDEOS = path.join(__dirname, 'datos', 'paraEnviar', 'Videos');
const EXTENSIONES_VIDEO = new Set(Object.keys(MIME_VIDEOS));
const seleccionesVideo = new Map();

function idCortoVideo(nombreArchivo) {
  return crypto.createHash('sha256').update(nombreArchivo).digest('hex').slice(0, 12);
}

/** Lee dinámicamente todos los videos válidos dentro de datos/paraEnviar/Videos. */
function obtenerVideosDisponibles() {
  if (!fs.existsSync(CARPETA_VIDEOS)) return [];
  return fs
    .readdirSync(CARPETA_VIDEOS, { withFileTypes: true })
    .filter((ent) => ent.isFile() && EXTENSIONES_VIDEO.has(path.extname(ent.name).toLowerCase()))
    .map((ent) => {
      const ruta = path.join(CARPETA_VIDEOS, ent.name);
      const bytes = fs.statSync(ruta).size;
      return {
        id: idCortoVideo(ent.name),
        archivo: ent.name,
        ruta,
        mb: (bytes / (1024 * 1024)).toFixed(1),
      };
    })
    .sort((a, b) => a.archivo.localeCompare(b.archivo, 'es', { numeric: true }));
}

function etiquetaVideo(video, prefijo = '🎬') {
  const nombre = video.archivo.length > 34 ? `${video.archivo.slice(0, 31)}...` : video.archivo;
  return `${prefijo} ${nombre} (${video.mb} MB)`;
}

function construirTecladoVideos(videos, seleccionados = null) {
  const filas = videos.map((v) => {
    if (seleccionados) {
      const marcado = seleccionados.has(v.id);
      return [Markup.button.callback(etiquetaVideo(v, marcado ? '✅' : '⬜'), `vid:tog:${v.id}`)];
    }
    return [Markup.button.callback(etiquetaVideo(v, '🎬'), `vid:one:${v.id}`)];
  });

  if (seleccionados) {
    filas.push([
      Markup.button.callback(`📤 Enviar seleccionados (${seleccionados.size})`, 'vid:send'),
      Markup.button.callback('❌ Cancelar', 'vid:cancel'),
    ]);
  } else if (videos.length > 1) {
    filas.push([
      Markup.button.callback('☑️ Seleccionar varios', 'vid:multi'),
      Markup.button.callback(`📦 Enviar todos (${videos.length})`, 'vid:all'),
    ]);
  }

  return Markup.inlineKeyboard(filas);
}

async function enviarLoteVideos(ctx, listaVideos, controlEstado = null) {
  let enviados = 0;
  const total = listaVideos.length;
  for (let i = 0; i < total; i++) {
    const video = listaVideos[i];
    const etiquetaLote = total > 1 ? `(${i + 1}/${total}) ` : '';
    if (!fs.existsSync(video.ruta)) {
      await responder(ctx, `⚠️ El video "${video.archivo}" ya no se encuentra en datos/paraEnviar/Videos/.`);
      continue;
    }
    const ok = await enviarVideoResistente(
      ctx,
      video.ruta,
      video.archivo,
      `🎬 Video solicitado: ${video.archivo} (${video.mb} MB)`,
      { etiquetaLote, controlEstado }
    );
    if (ok) enviados += 1;
  }
  return enviados;
}

bot.command(['video', 'videos'], async (ctx) => {
  const videos = obtenerVideosDisponibles();
  if (videos.length === 0) {
    return responder(
      ctx,
      '⚠️ No hay videos en datos/paraEnviar/Videos/. Agrega archivos .mp4, .mov, .mkv, .avi o .webm y vuelve a intentar.'
    );
  }

  await ctx.reply(
    `🎬 ¿Qué video quieres solicitar? (${videos.length} disponible${videos.length === 1 ? '' : 's'})`,
    construirTecladoVideos(videos, null)
  );
});

bot.action(/^vid:(one|tog):([0-9a-f]{12})$/, async (ctx) => {
  const [, modo, idVideo] = ctx.match;
  const videos = obtenerVideosDisponibles();
  const video = videos.find((v) => v.id === idVideo);

  if (!video) {
    await ctx.answerCbQuery('Video no encontrado.');
    return ctx.editMessageText('⚠️ El video seleccionado ya no está disponible en datos/paraEnviar/Videos/.');
  }

  if (modo === 'one') {
    await ctx.answerCbQuery('Enviando video...');
    const textoInicio =
      `⏳ Enviando ${video.archivo} (${video.mb} MB)\n` +
      `[${barraProgreso(0, 12)}] 0% • Iniciando subida (intento 1/3)...`;
    await ctx.editMessageText(textoInicio);
    const controlEstado = crearControladorEstadoTelegram(ctx, textoInicio);
    const ok = await enviarLoteVideos(ctx, [video], controlEstado);
    if (ok > 0) {
      await ctx.editMessageText(`✅ Video enviado: ${video.archivo}`);
    } else {
      await ctx.editMessageText(`⚠️ No se pudo completar el envío de ${video.archivo}.`);
    }
    return;
  }

  // Modo selección múltiple (vid:tog:<id>)
  const llave = `${ctx.chat.id}:${ctx.callbackQuery.message.message_id}`;
  const setActual = seleccionesVideo.get(llave) || new Set();
  if (setActual.has(idVideo)) {
    setActual.delete(idVideo);
  } else {
    setActual.add(idVideo);
  }
  seleccionesVideo.set(llave, setActual);

  await ctx.answerCbQuery(`${setActual.size} seleccionado(s)`);
  await ctx.editMessageReplyMarkup(construirTecladoVideos(videos, setActual).reply_markup);
});

bot.action('vid:multi', async (ctx) => {
  const videos = obtenerVideosDisponibles();
  if (videos.length === 0) {
    return ctx.answerCbQuery('No hay videos disponibles.');
  }
  const llave = `${ctx.chat.id}:${ctx.callbackQuery.message.message_id}`;
  const setActual = new Set();
  seleccionesVideo.set(llave, setActual);

  await ctx.answerCbQuery('Modo selección múltiple activado');
  await ctx.editMessageText(
    '☑️ Toca los videos que quieras incluir y luego pulsa "Enviar seleccionados":',
    construirTecladoVideos(videos, setActual)
  );
});

bot.action('vid:send', async (ctx) => {
  const llave = `${ctx.chat.id}:${ctx.callbackQuery.message.message_id}`;
  const setActual = seleccionesVideo.get(llave);
  if (!setActual || setActual.size === 0) {
    return ctx.answerCbQuery('Selecciona al menos un video primero.');
  }

  const videos = obtenerVideosDisponibles();
  const elegidos = videos.filter((v) => setActual.has(v.id));
  seleccionesVideo.delete(llave);

  if (elegidos.length === 0) {
    await ctx.answerCbQuery('Videos no disponibles.');
    return ctx.editMessageText('⚠️ Ninguno de los videos seleccionados está disponible en el servidor.');
  }

  await ctx.answerCbQuery(`Enviando ${elegidos.length} video(s)...`);
  const textoInicio = `⏳ Preparando envío de ${elegidos.length} video(s) seleccionado(s)...`;
  await ctx.editMessageText(textoInicio);
  const controlEstado = crearControladorEstadoTelegram(ctx, textoInicio);
  const enviados = await enviarLoteVideos(ctx, elegidos, controlEstado);
  await ctx.editMessageText(`✅ Envío finalizado: ${enviados} de ${elegidos.length} video(s) enviado(s).`);
});

bot.action('vid:all', async (ctx) => {
  const videos = obtenerVideosDisponibles();
  if (videos.length === 0) {
    return ctx.answerCbQuery('No hay videos disponibles.');
  }

  await ctx.answerCbQuery(`Enviando ${videos.length} video(s)...`);
  const textoInicio = `⏳ Preparando envío de todos los videos (${videos.length})...`;
  await ctx.editMessageText(textoInicio);
  const controlEstado = crearControladorEstadoTelegram(ctx, textoInicio);
  const enviados = await enviarLoteVideos(ctx, videos, controlEstado);
  await ctx.editMessageText(`✅ Envío finalizado: ${enviados} de ${videos.length} video(s) enviado(s).`);
});

bot.action('vid:cancel', async (ctx) => {
  const llave = `${ctx.chat.id}:${ctx.callbackQuery.message.message_id}`;
  seleccionesVideo.delete(llave);
  await ctx.answerCbQuery('Cancelado');
  await ctx.editMessageText('❌ Selección de videos cancelada.');
});

// --- 5. Documentos e imagenes ----------------------------------------------

bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  try {
      const info = await descargar(ctx, doc.file_id, doc.file_name, doc.file_size);
    await responder(
      ctx,
      '📄 Documento guardado\n' +
      'Nombre: ' + (doc.file_name || 'sin nombre') + '\n' +
      'Tipo: ' + (doc.mime_type || 'desconocido') + '\n' +
      'Tamaño: ' + info.bytes + ' bytes\n' +
      'Archivo local: ' + path.basename(info.ruta) + '\n' +
      'SHA-256: ' + info.sha256.slice(0, 20) + '...'
    );
  } catch (e) {
    await responder(ctx, 'No pude descargar el documento: ' + e.message);
  }
});

bot.on('photo', async (ctx) => {
  // Telegram manda varias resoluciones; la última es la más grande.
  const foto = ctx.message.photo[ctx.message.photo.length - 1];
  try {
    const nombre = 'foto_' + foto.width + 'x' + foto.height + '.jpg';
    const info = await descargar(ctx, foto.file_id, nombre, foto.file_size);
    await responder(
      ctx,
      '🖼️ Imagen guardada\n' +
      'Resolucion: ' + foto.width + ' x ' + foto.height + '\n' +
      'Tamano: ' + info.bytes + ' bytes\n' +
      'Archivo local: ' + path.basename(info.ruta)
    );
  } catch (e) {
    await responder(ctx, 'No pude descargar la imagen: ' + e.message);
  }
});

// --- 6. Fallback y arranque -------------------------------------------------

// Se registra al final: cualquier texto que no sea comando cae aqui.
bot.on('text', (ctx) => responder(ctx, 'No reconozco ese mensaje.\n\n' + AYUDA));

bot.catch((err, ctx) => {
  console.error('Error en', ctx.updateType, ':', sinToken(err.message));
});

// Permite importar el bot desde pruebas sin arrancar el polling.
module.exports = bot;

// --- Arranque ---------------------------------------------------------------
if (require.main === module) {
  if (!TOKEN) {
    console.error('No se puede arrancar sin BOT_TOKEN.');
    process.exit(1);
  }

  bot.launch().then(() => {
    console.log('Bot del taller listo. Abre Telegram y envia /start.');
    console.log('Python:', proc.PYTHON, '| Exe:', proc.EXE);
  }).catch((e) => {
    console.error('No se pudo iniciar el bot:', sinToken(e.message));
    process.exit(1);
  });

  // Apagado limpio con Ctrl+C.
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
